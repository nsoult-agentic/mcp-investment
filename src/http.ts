/**
 * MCP server for Investment data — multi-source financial data tools.
 * Deployed via GitHub Actions → ghcr.io → Portainer CE GitOps polling.
 *
 * Tools:
 *   investment-fetch-quote     — Stock quotes with Yahoo → Finnhub → FMP fallback
 *   investment-fetch-economic  — FRED macro economic indicators
 *   investment-fetch-filings   — SEC EDGAR company filings
 *   investment-api-usage       — API rate limit status
 *
 * SECURITY: API keys read from /secrets/ directory (mounted from /srv/).
 * Keys never appear in tool output. Generic error messages only.
 *
 * Usage: PORT=8901 SECRETS_DIR=/secrets bun run src/http.ts
 */
import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import {
  fmtMoney,
  fmtVol,
  fmtPct,
  parseTickers,
  parseSeries,
  buildTickerMap,
  buildFilingUrl,
  API_LIMITS,
  newRateState,
  checkRate as checkRatePure,
  recordCall as recordCallPure,
  getUsage as getUsagePure,
  isRateLimited as isRateLimitedPure,
  getCached as getCachedPure,
  setCache as setCachePure,
  type CacheEntry,
} from "./domain.js";

// ── Configuration ──────────────────────────────────────────

const PORT = Number(process.env["PORT"]) || 8901;
const SECRETS_DIR = process.env["SECRETS_DIR"] || "/secrets";

// ── Rate Limiter ──────────────────────────────────────────

const requestTimestamps: number[] = [];

function isRateLimited(): boolean {
  return isRateLimitedPure(requestTimestamps, Date.now());
}

// ── Secret Loading ─────────────────────────────────────────

interface SecretDiag {
  name: string;
  loaded: boolean;
  chars: number;
  error: string | null;
}

const secretDiags: SecretDiag[] = [];

function loadSecret(name: string): string | null {
  const path = resolve(SECRETS_DIR, name);
  const diag: SecretDiag = { name, loaded: false, chars: 0, error: null };

  try {
    if (!existsSync(path)) {
      diag.error = "file not found";
      console.warn(`[secrets] ${name}: file not found at ${path}`);
      secretDiags.push(diag);
      return null;
    }
    const stat = statSync(path);
    if (!stat.isFile()) {
      diag.error = "not a file (directory?)";
      console.warn(`[secrets] ${name}: exists but is not a file`);
      secretDiags.push(diag);
      return null;
    }
    if (stat.size === 0) {
      diag.error = "file is empty (0 bytes)";
      console.warn(`[secrets] ${name}: file is empty (0 bytes)`);
      secretDiags.push(diag);
      return null;
    }
    const val = readFileSync(path, "utf-8").trim();
    if (val.length === 0) {
      diag.error = "content trims to empty (whitespace only)";
      console.warn(`[secrets] ${name}: content trims to empty`);
      secretDiags.push(diag);
      return null;
    }
    diag.loaded = true;
    diag.chars = val.length;
    console.log(`[secrets] ${name}: loaded (${val.length} chars)`);
    secretDiags.push(diag);
    return val;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    diag.error = msg;
    console.warn(`[secrets] ${name}: load failed — ${msg}`);
    secretDiags.push(diag);
    return null;
  }
}

// Log secrets directory contents at startup (file names only, never values)
try {
  const files = readdirSync(SECRETS_DIR);
  console.log(
    `[secrets] SECRETS_DIR=${SECRETS_DIR} contains: ${files.length > 0 ? files.join(", ") : "(empty directory)"}`,
  );
} catch (err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  console.warn(`[secrets] Cannot read SECRETS_DIR=${SECRETS_DIR}: ${msg}`);
}

const FINNHUB_KEY = loadSecret("finnhub");
const FMP_KEY = loadSecret("fmp");
const ALPHA_VANTAGE_KEY = loadSecret("alpha-vantage");
const FRED_KEY = loadSecret("fred");

// ── In-Memory Cache ────────────────────────────────────────

const cache = new Map<string, CacheEntry>();

function getCached<T>(key: string): T | null {
  return getCachedPure<T>(cache, key, Date.now());
}

function setCache(key: string, data: unknown, ttlMs: number): void {
  setCachePure(cache, key, data, ttlMs, Date.now());
}

const CACHE_QUOTE = 5 * 60_000;
const CACHE_FUNDAMENTALS = 24 * 3600_000;
const CACHE_ECONOMIC = 24 * 3600_000;
const CACHE_FILINGS = 7 * 24 * 3600_000;

// ── Rate Limiting ──────────────────────────────────────────

const rateState = newRateState();

function checkRate(api: string): boolean {
  return checkRatePure(rateState, api, Date.now());
}

function recordCall(api: string): void {
  recordCallPure(rateState, api, Date.now());
}

function getUsage(api: string): string {
  return getUsagePure(rateState, api, Date.now());
}

// ── Fetch Helper ───────────────────────────────────────────

async function apiFetch(url: string, headers: Record<string, string> = {}): Promise<unknown> {
  const res = await fetch(url, {
    headers: { Accept: "application/json", ...headers },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * Safe wrapper for API calls that embed keys in URLs (FMP, Alpha Vantage, FRED).
 * Catches ALL errors and re-throws with a generic message, preventing runtime
 * errors from leaking the full URL (which contains the API key) into tool output
 * or logs that reach external systems.
 */
async function safeFetch(url: string, headers: Record<string, string> = {}): Promise<unknown> {
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json", ...headers },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      // Log status + domain for debugging, NEVER the full URL (contains API keys)
      const domain = new URL(url).hostname;
      console.error(`[safeFetch] ${domain} HTTP ${res.status}`);
      throw new Error(`HTTP ${res.status}`);
    }
    return res.json();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.startsWith("HTTP ")) {
      // Network/DNS/timeout error — safe to log fully
      console.error(`[safeFetch] network error: ${msg}`);
    }
    throw new Error("API request failed");
  }
}

// ── Data Types ─────────────────────────────────────────────

interface QuoteData {
  symbol: string;
  name: string;
  price: number;
  change: number;
  changePercent: number;
  volume: number;
  dayHigh: number;
  dayLow: number;
  yearHigh: number;
  yearLow: number;
  marketCap: number | null;
  pe: number | null;
  sector: string | null;
  industry: string | null;
  source: string;
}

interface FundamentalsData {
  pe: number | null;
  eps: number | null;
  bookValue: number | null;
  dividendYield: number | null;
  profitMargin: number | null;
  operatingMargin: number | null;
  roe: number | null;
  roa: number | null;
  beta: number | null;
  analystTarget: number | null;
  sector: string | null;
  industry: string | null;
  source: string;
}

// ── External API response shapes ───────────────────────────
// Minimal, defensive views over untyped third-party JSON: every field is
// optional because the upstream payloads are not under our control. Only the
// fields actually read are declared; values are validated/coerced at use.

interface YahooMeta {
  regularMarketPrice?: number;
  previousClose?: number;
  chartPreviousClose?: number;
  shortName?: string;
  longName?: string;
  regularMarketVolume?: number;
  regularMarketDayHigh?: number;
  regularMarketDayLow?: number;
  fiftyTwoWeekHigh?: number;
  fiftyTwoWeekLow?: number;
}

interface YahooResponse {
  chart?: { result?: Array<{ meta?: YahooMeta }> };
}

interface FinnhubQuote {
  c?: number;
  d?: number;
  dp?: number;
  h?: number;
  l?: number;
}

interface FinnhubProfile {
  name?: string;
  marketCapitalization?: number;
  finnhubIndustry?: string;
}

interface FinnhubMetricResponse {
  metric?: Record<string, number | undefined>;
}

interface FmpQuote {
  name?: string;
  price?: number;
  change?: number;
  changesPercentage?: number;
  volume?: number;
  dayHigh?: number;
  dayLow?: number;
  yearHigh?: number;
  yearLow?: number;
  marketCap?: number;
  pe?: number;
}

type AlphaVantageOverview = Record<string, string | undefined>;

interface FredObservation {
  date?: string;
  value?: string;
}

interface FredObservationsResponse {
  observations?: FredObservation[];
}

interface FredSeriesResponse {
  seriess?: Array<{ title?: string }>;
}

interface EdgarRecentFilings {
  form?: string[];
  accessionNumber?: string[];
  filingDate?: string[];
  reportDate?: string[];
  primaryDocument?: string[];
}

interface EdgarSubmissions {
  name?: string;
  cik?: string | number;
  sic?: string;
  sicDescription?: string;
  stateOfIncorporation?: string;
  filings?: { recent?: EdgarRecentFilings };
}

// ── API: Yahoo Finance (no key) ────────────────────────────

async function fetchYahoo(ticker: string): Promise<QuoteData> {
  if (!checkRate("yahoo")) throw new Error("rate limited");

  const data = (await apiFetch(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=1d`,
    { "User-Agent": "Mozilla/5.0 (compatible; PAI/1.0)" },
  )) as YahooResponse;
  recordCall("yahoo");

  const meta = data?.chart?.result?.[0]?.meta;
  if (!meta?.regularMarketPrice) throw new Error("no data");
  const price = meta.regularMarketPrice;

  const prev = meta.previousClose || meta.chartPreviousClose || 0;
  return {
    symbol: ticker,
    name: meta.shortName || meta.longName || ticker,
    price,
    change: prev ? price - prev : 0,
    changePercent: prev ? ((price - prev) / prev) * 100 : 0,
    volume: meta.regularMarketVolume || 0,
    dayHigh: meta.regularMarketDayHigh || 0,
    dayLow: meta.regularMarketDayLow || 0,
    yearHigh: meta.fiftyTwoWeekHigh || 0,
    yearLow: meta.fiftyTwoWeekLow || 0,
    marketCap: null,
    pe: null,
    sector: null,
    industry: null,
    source: "yahoo",
  };
}

// ── API: Finnhub ───────────────────────────────────────────

/**
 * Best-effort fetch of a Finnhub company profile (sector/industry/market cap).
 * Rate-gated and failure-tolerant: returns null if rate limited or on any error,
 * since the profile is always optional enrichment. Records the call on success.
 */
async function fetchFinnhubProfile(ticker: string, key: string): Promise<FinnhubProfile | null> {
  if (!checkRate("finnhub")) return null;
  try {
    const profile = (await apiFetch(
      `https://finnhub.io/api/v1/stock/profile2?symbol=${encodeURIComponent(ticker)}`,
      { "X-Finnhub-Token": key },
    )) as FinnhubProfile;
    recordCall("finnhub");
    return profile;
  } catch {
    return null;
  }
}

async function fetchFinnhub(ticker: string): Promise<QuoteData> {
  if (!FINNHUB_KEY) throw new Error("no key");
  if (!checkRate("finnhub")) throw new Error("rate limited");

  const quote = (await apiFetch(
    `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(ticker)}`,
    { "X-Finnhub-Token": FINNHUB_KEY },
  )) as FinnhubQuote;
  recordCall("finnhub");

  if (!quote?.c || quote.c === 0) throw new Error("no data");
  const price = quote.c;

  let name = ticker;
  let marketCap: number | null = null;
  let industry: string | null = null;
  const profile = await fetchFinnhubProfile(ticker, FINNHUB_KEY);
  if (profile?.name) name = profile.name;
  if (profile?.marketCapitalization) marketCap = profile.marketCapitalization * 1_000_000;
  if (profile?.finnhubIndustry) industry = profile.finnhubIndustry;

  return {
    symbol: ticker,
    name,
    price,
    change: quote.d || 0,
    changePercent: quote.dp || 0,
    volume: 0,
    dayHigh: quote.h || 0,
    dayLow: quote.l || 0,
    yearHigh: 0,
    yearLow: 0,
    marketCap,
    pe: null,
    sector: null,
    industry,
    source: "finnhub",
  };
}

// ── API: FMP ───────────────────────────────────────────────

async function fetchFMP(ticker: string): Promise<QuoteData> {
  if (!FMP_KEY) throw new Error("no key");
  if (!checkRate("fmp")) throw new Error("rate limited");

  const data = (await safeFetch(
    `https://financialmodelingprep.com/api/v3/quote/${encodeURIComponent(ticker)}?apikey=${FMP_KEY}`,
  )) as FmpQuote | FmpQuote[];
  recordCall("fmp");

  const q: FmpQuote | undefined = Array.isArray(data) ? data[0] : data;
  if (!q?.price) throw new Error("no data");
  const price = q.price;

  return {
    symbol: ticker,
    name: q.name || ticker,
    price,
    change: q.change || 0,
    changePercent: q.changesPercentage || 0,
    volume: q.volume || 0,
    dayHigh: q.dayHigh || 0,
    dayLow: q.dayLow || 0,
    yearHigh: q.yearHigh || 0,
    yearLow: q.yearLow || 0,
    marketCap: q.marketCap || null,
    pe: q.pe || null,
    sector: null,
    industry: null,
    source: "fmp",
  };
}

// ── API: Finnhub Fundamentals ──────────────────────────────

async function fetchFinnhubFundamentals(ticker: string): Promise<FundamentalsData> {
  if (!FINNHUB_KEY) throw new Error("no key");
  if (!checkRate("finnhub")) throw new Error("rate limited");

  const metrics = (await apiFetch(
    `https://finnhub.io/api/v1/stock/metric?symbol=${encodeURIComponent(ticker)}&metric=all`,
    { "X-Finnhub-Token": FINNHUB_KEY },
  )) as FinnhubMetricResponse;
  recordCall("finnhub");

  const m = metrics?.metric;
  if (!m) throw new Error("no data");

  // Also fetch profile for sector/industry data
  let industry: string | null = null;
  const profile = await fetchFinnhubProfile(ticker, FINNHUB_KEY);
  if (profile?.finnhubIndustry) industry = profile.finnhubIndustry;

  return {
    pe: m["peNormalizedAnnual"] || m["peTTM"] || null,
    eps: m["epsNormalizedAnnual"] || m["epsTTM"] || null,
    bookValue: m["bookValuePerShareAnnual"] || null,
    dividendYield: m["dividendYieldIndicatedAnnual"] || null,
    profitMargin: m["netProfitMarginTTM"] || null,
    operatingMargin: m["operatingMarginTTM"] || null,
    roe: m["roeTTM"] || null,
    roa: m["roaTTM"] || null,
    beta: m["beta"] || null,
    analystTarget: m["targetMedianPrice"] || null,
    sector: null,
    industry,
    source: "finnhub",
  };
}

// ── API: Alpha Vantage Fundamentals ────────────────────────

async function fetchAlphaVantageFundamentals(ticker: string): Promise<FundamentalsData> {
  if (!ALPHA_VANTAGE_KEY) throw new Error("no key");
  if (!checkRate("alphaVantage")) throw new Error("rate limited");

  const data = (await safeFetch(
    `https://www.alphavantage.co/query?function=OVERVIEW&symbol=${encodeURIComponent(ticker)}&apikey=${ALPHA_VANTAGE_KEY}`,
  )) as AlphaVantageOverview;
  recordCall("alphaVantage");

  if (!data?.["Symbol"]) throw new Error("no data");

  const num = (v: string | undefined): number | null =>
    v && v !== "None" && v !== "-" ? Number(v) : null;
  // Convert a FRED/AlphaVantage fractional ratio (e.g. 0.21) to a percentage.
  const pct = (v: string | undefined): number | null => {
    const n = num(v);
    return n !== null ? n * 100 : null;
  };

  const sectorRaw = data["Sector"];
  const industryRaw = data["Industry"];
  return {
    pe: num(data["PERatio"]),
    eps: num(data["EPS"]),
    bookValue: num(data["BookValue"]),
    dividendYield: pct(data["DividendYield"]),
    profitMargin: pct(data["ProfitMargin"]),
    operatingMargin: pct(data["OperatingMarginTTM"]),
    roe: pct(data["ReturnOnEquityTTM"]),
    roa: pct(data["ReturnOnAssetsTTM"]),
    beta: num(data["Beta"]),
    analystTarget: num(data["AnalystTargetPrice"]),
    sector: sectorRaw && sectorRaw !== "None" ? sectorRaw : null,
    industry: industryRaw && industryRaw !== "None" ? industryRaw : null,
    source: "alpha-vantage",
  };
}

// ── Tool: investment-fetch-quote ───────────────────────────

const FetchQuoteInput = {
  tickers: z
    .string()
    .min(1)
    .max(100)
    .describe("Comma-separated ticker symbols (e.g., 'NVDA' or 'NVDA,AAPL,MSFT'). Max 10."),
  mode: z
    .enum(["quick", "full"])
    .default("quick")
    .describe("'quick' = price only, 'full' = price + fundamentals"),
};

const REQUEST_TIMEOUT_MS = 60_000; // 60s global timeout per tool call

/** Resolve a quote for one ticker via the cache then Yahoo → Finnhub → FMP. */
async function resolveQuote(ticker: string): Promise<QuoteData | null> {
  const cacheKey = `quote:${ticker}`;
  const cached = getCached<QuoteData>(cacheKey);
  if (cached) return cached;

  for (const fetcher of [fetchYahoo, fetchFinnhub, fetchFMP]) {
    try {
      const quote = await fetcher(ticker);
      setCache(cacheKey, quote, CACHE_QUOTE);
      return quote;
    } catch {
      /* try next source */
    }
  }
  return null;
}

/** Resolve fundamentals for one ticker via the cache then Finnhub → AlphaVantage. */
async function resolveFundamentals(ticker: string): Promise<FundamentalsData | null> {
  const fundKey = `fund:${ticker}`;
  const cached = getCached<FundamentalsData>(fundKey);
  if (cached) return cached;

  for (const fetcher of [fetchFinnhubFundamentals, fetchAlphaVantageFundamentals]) {
    try {
      const fund = await fetcher(ticker);
      setCache(fundKey, fund, CACHE_FUNDAMENTALS);
      return fund;
    } catch {
      /* try next */
    }
  }
  return null;
}

/** Format the primary quote block (price + optional day/year/cap/sector). */
function formatQuote(quote: QuoteData): string[] {
  const sign = quote.change >= 0 ? "+" : "";
  const lines = [
    `## ${quote.symbol} — ${quote.name}`,
    `Price: $${quote.price.toFixed(2)} (${sign}$${quote.change.toFixed(2)}, ${sign}${quote.changePercent.toFixed(2)}%)`,
  ];

  if (quote.volume > 0) lines.push(`Volume: ${fmtVol(quote.volume)}`);
  if (quote.dayHigh > 0)
    lines.push(`Day Range: $${quote.dayLow.toFixed(2)} — $${quote.dayHigh.toFixed(2)}`);
  if (quote.yearHigh > 0)
    lines.push(`52-Week: $${quote.yearLow.toFixed(2)} — $${quote.yearHigh.toFixed(2)}`);
  if (quote.marketCap) lines.push(`Market Cap: ${fmtMoney(quote.marketCap)}`);
  if (quote.pe) lines.push(`P/E: ${quote.pe.toFixed(1)}`);
  if (quote.sector || quote.industry) {
    const parts = [quote.sector, quote.industry].filter(Boolean);
    lines.push(`Sector: ${parts.join(" / ")}`);
  }
  lines.push(`Source: ${quote.source}`);
  return lines;
}

/** Format the fundamentals block appended in `full` mode. */
function formatFundamentals(fund: FundamentalsData): string[] {
  const lines: string[] = ["", "### Fundamentals"];
  if (fund.pe !== null) lines.push(`P/E Ratio: ${fund.pe.toFixed(1)}`);
  if (fund.eps !== null) lines.push(`EPS: $${fund.eps.toFixed(2)}`);
  if (fund.bookValue !== null) lines.push(`Book Value: $${fund.bookValue.toFixed(2)}`);
  if (fund.profitMargin !== null) lines.push(`Profit Margin: ${fmtPct(fund.profitMargin)}`);
  if (fund.operatingMargin !== null)
    lines.push(`Operating Margin: ${fmtPct(fund.operatingMargin)}`);
  if (fund.roe !== null) lines.push(`Return on Equity: ${fmtPct(fund.roe)}`);
  if (fund.roa !== null) lines.push(`Return on Assets: ${fmtPct(fund.roa)}`);
  if (fund.beta !== null) lines.push(`Beta: ${fund.beta.toFixed(2)}`);
  if (fund.dividendYield !== null) lines.push(`Dividend Yield: ${fmtPct(fund.dividendYield)}`);
  if (fund.analystTarget !== null) lines.push(`Analyst Target: $${fund.analystTarget.toFixed(2)}`);
  if (fund.sector || fund.industry) {
    const parts = [fund.sector, fund.industry].filter(Boolean);
    lines.push(`Sector: ${parts.join(" / ")}`);
  }
  lines.push(`Source: ${fund.source}`);
  return lines;
}

/** Build the full per-ticker section (quote + optional fundamentals). */
async function buildTickerSection(ticker: string, mode: string): Promise<string> {
  const quote = await resolveQuote(ticker);
  if (!quote) {
    return `## ${ticker}\nUnable to fetch quote — all sources failed or rate limited.`;
  }

  const lines = formatQuote(quote);

  if (mode === "full") {
    const fund = await resolveFundamentals(ticker);
    if (fund) {
      lines.push(...formatFundamentals(fund));
    } else {
      lines.push("", "### Fundamentals", "Unavailable — sources failed or rate limited.");
    }
  }

  return lines.join("\n");
}

async function fetchQuote(params: { tickers: string; mode: string }): Promise<string> {
  const deadline = Date.now() + REQUEST_TIMEOUT_MS;
  const parsed = parseTickers(params.tickers);
  if (!parsed.ok) return parsed.error;

  const results: string[] = [];
  for (const ticker of parsed.items) {
    if (Date.now() > deadline) {
      results.push(
        `## ${ticker}\nSkipped — request timeout reached (${REQUEST_TIMEOUT_MS / 1000}s).`,
      );
      continue;
    }
    results.push(await buildTickerSection(ticker, params.mode));
  }

  return results.join("\n\n");
}

// ── Tool: investment-fetch-economic ────────────────────────

const COMMON_SERIES: Record<string, string> = {
  GDP: "Real Gross Domestic Product",
  CPIAUCSL: "Consumer Price Index (All Urban)",
  FEDFUNDS: "Federal Funds Effective Rate",
  UNRATE: "Unemployment Rate",
  DGS10: "10-Year Treasury Yield",
  DGS2: "2-Year Treasury Yield",
  T10Y2Y: "10Y-2Y Treasury Spread",
  VIXCLS: "CBOE Volatility Index (VIX)",
  DCOILWTICO: "Crude Oil (WTI)",
  GOLDAMGBD228NLBM: "Gold Price (London Fix)",
  M2SL: "M2 Money Supply",
  MORTGAGE30US: "30-Year Fixed Mortgage Rate",
  UMCSENT: "Consumer Sentiment (UMich)",
  PAYEMS: "Total Nonfarm Payrolls",
  HOUST: "Housing Starts",
  RSAFS: "Retail Sales",
};

const FetchEconomicInput = {
  series: z
    .string()
    .min(1)
    .max(200)
    .describe(
      "Comma-separated FRED series IDs. Common: GDP, CPIAUCSL, FEDFUNDS, UNRATE, DGS10, DGS2, T10Y2Y, VIXCLS, MORTGAGE30US. Max 10.",
    ),
  observations: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(6)
    .describe("Data points per series (default: 6)"),
};

interface EconSeries {
  title: string;
  observations: Array<{ date: string; value: string }>;
}

/** Look up a human-readable title for a FRED series (optional best-effort). */
async function fetchSeriesTitle(seriesId: string, fredKey: string): Promise<string> {
  let title = COMMON_SERIES[seriesId] || seriesId;
  try {
    if (checkRate("fred")) {
      const info = (await safeFetch(
        `https://api.stlouisfed.org/fred/series?series_id=${seriesId}&api_key=${fredKey}&file_type=json`,
      )) as FredSeriesResponse;
      recordCall("fred");
      const infoTitle = info?.seriess?.[0]?.title;
      if (infoTitle) title = infoTitle;
    }
  } catch {
    /* title lookup is optional */
  }
  return title;
}

/** Fetch + cache one FRED series' observations. Returns null on fetch failure. */
async function fetchEconSeries(
  seriesId: string,
  observations: number,
  fredKey: string,
): Promise<EconSeries | null> {
  const cacheKey = `econ:${seriesId}:${observations}`;
  const cached = getCached<EconSeries>(cacheKey);
  if (cached) return cached;

  try {
    const obsData = (await safeFetch(
      `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}&api_key=${fredKey}&file_type=json&sort_order=desc&limit=${observations}`,
    )) as FredObservationsResponse;
    recordCall("fred");

    const title = await fetchSeriesTitle(seriesId, fredKey);
    const obs = (obsData?.observations || [])
      .filter(
        (o: FredObservation): o is { date: string; value: string } =>
          typeof o.value === "string" && typeof o.date === "string" && o.value !== ".",
      )
      .map((o) => ({ date: o.date, value: o.value }));

    const result: EconSeries = { title, observations: obs };
    setCache(cacheKey, result, CACHE_ECONOMIC);
    return result;
  } catch {
    return null;
  }
}

/** Render one resolved FRED series to markdown. */
function formatEconSeries(seriesId: string, series: EconSeries): string {
  const lines = [`## ${seriesId} — ${series.title}`];
  if (series.observations.length === 0) {
    lines.push("No observations available.");
  } else {
    for (const obs of series.observations) {
      lines.push(`  ${obs.date}: ${obs.value}`);
    }
  }
  return lines.join("\n");
}

async function fetchEconomic(params: { series: string; observations: number }): Promise<string> {
  if (!FRED_KEY) return "FRED API key not configured. Economic data unavailable.";

  const parsed = parseSeries(params.series);
  if (!parsed.ok) return parsed.error;

  const results: string[] = [];
  for (const seriesId of parsed.items) {
    const cacheKey = `econ:${seriesId}:${params.observations}`;
    const isCached = getCached<EconSeries>(cacheKey) !== null;
    if (!isCached && !checkRate("fred")) {
      results.push(`## ${seriesId}\nRate limited — try again in a minute.`);
      continue;
    }

    const series = await fetchEconSeries(seriesId, params.observations, FRED_KEY);
    if (!series) {
      results.push(`## ${seriesId}\nFailed to fetch data from FRED.`);
      continue;
    }
    results.push(formatEconSeries(seriesId, series));
  }

  return results.join("\n\n");
}

// ── Tool: investment-fetch-filings ─────────────────────────

const CACHE_CIK = 24 * 3600_000; // 24 hours
let tickerMapCache: { data: Record<string, string>; expires: number } | null = null;

async function getTickerMap(ua: Record<string, string>): Promise<Record<string, string>> {
  if (tickerMapCache && Date.now() < tickerMapCache.expires) {
    return tickerMapCache.data;
  }

  if (!checkRate("secEdgar")) throw new Error("rate limited");

  const raw = (await apiFetch("https://www.sec.gov/files/company_tickers.json", ua)) as Record<
    string,
    { cik_str: number; ticker: string; title: string }
  >;
  recordCall("secEdgar");

  const map = buildTickerMap(raw);

  tickerMapCache = { data: map, expires: Date.now() + CACHE_CIK };
  return map;
}

const FetchFilingsInput = {
  ticker: z
    .string()
    .min(1)
    .max(10)
    .regex(/^[A-Z0-9.]{1,10}$/, "Ticker: uppercase letters, digits, dots only")
    .describe("Stock ticker (e.g., 'NVDA')"),
  form_type: z
    .enum(["10-K", "10-Q", "8-K", "ALL"])
    .default("10-K")
    .describe("SEC form type (default: 10-K annual report)"),
  count: z
    .number()
    .int()
    .min(1)
    .max(10)
    .default(3)
    .describe("Number of filings (default: 3, max: 10)"),
};

/** Resolve a ticker to its zero-padded CIK, or undefined if not listed. */
async function resolveCik(ticker: string, ua: Record<string, string>): Promise<string | undefined> {
  const map = await getTickerMap(ua);
  return map[ticker];
}

/** Render a single filing entry (index `i` into the parallel `recent.*` arrays). */
function formatFilingEntry(
  recent: EdgarRecentFilings,
  i: number,
  form: string,
  cikDigits: string,
): string[] {
  const accDash = recent.accessionNumber?.[i] ?? "";
  const filed = recent.filingDate?.[i] || "N/A";
  const report = recent.reportDate?.[i] || "N/A";
  const url = buildFilingUrl(cikDigits, accDash, recent.primaryDocument?.[i] || "");
  return [
    `### ${form} — Filed ${filed}`,
    `  Report Date: ${report}`,
    `  Accession: ${accDash}`,
    `  URL: ${url}`,
    "",
  ];
}

/**
 * Render the filings section for an EDGAR submissions payload. Pure formatting:
 * iterates the parallel `recent.*` arrays, filters by form type, and emits up to
 * `count` entries. Indexed access is guarded (noUncheckedIndexedAccess).
 */
function formatFilings(
  ticker: string,
  data: EdgarSubmissions,
  recent: EdgarRecentFilings,
  formType: string,
  count: number,
): string {
  const forms = recent.form ?? [];
  const cikDigits = String(data.cik ?? "").replace(/[^0-9]/g, "");
  const lines = [
    `## ${ticker} — ${data.name || ticker}`,
    `CIK: ${data.cik} | SIC: ${data.sic || "N/A"} (${data.sicDescription || "N/A"}) | State: ${data.stateOfIncorporation || "N/A"}`,
    "",
  ];

  let found = 0;
  for (let i = 0; i < forms.length && found < count; i++) {
    const form = forms[i];
    if (form === undefined) continue;
    if (formType !== "ALL" && form !== formType) continue;

    lines.push(...formatFilingEntry(recent, i, form, cikDigits));
    found++;
  }

  if (found === 0) lines.push(`No ${formType} filings found.`);
  return lines.join("\n");
}

async function fetchFilings(params: {
  ticker: string;
  form_type: string;
  count: number;
}): Promise<string> {
  const ticker = params.ticker.toUpperCase();
  const cacheKey = `filings:${ticker}:${params.form_type}:${params.count}`;
  const cached = getCached<string>(cacheKey);
  if (cached) return cached;

  const UA = { "User-Agent": "PAI pai@stabpablo.eu" };

  // Step 1: ticker → CIK (cached map, refreshed every 24h)
  let cik: string | undefined;
  try {
    cik = await resolveCik(ticker, UA);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[edgar] CIK lookup failed: ${msg}`);
    return `Failed to look up CIK for ${ticker}.`;
  }

  if (!cik) return `Ticker "${ticker}" not found in SEC EDGAR.`;

  // Step 2: fetch filings
  if (!checkRate("secEdgar")) return "SEC EDGAR rate limited — try again shortly.";

  try {
    const data = (await apiFetch(
      `https://data.sec.gov/submissions/CIK${cik}.json`,
      UA,
    )) as EdgarSubmissions;
    recordCall("secEdgar");

    const recent = data?.filings?.recent;
    if (!recent?.form) return `No filings found for ${ticker}.`;

    const result = formatFilings(ticker, data, recent, params.form_type, params.count);
    setCache(cacheKey, result, CACHE_FILINGS);
    return result;
  } catch {
    return `Failed to fetch filings for ${ticker}.`;
  }
}

// ── Tool: investment-api-usage ─────────────────────────────

async function apiUsage(): Promise<string> {
  const lines = ["## API Usage Status", "", "| API | Usage | Key |", "|-----|-------|-----|"];

  const keyStatus: Record<string, string> = {
    yahoo: "N/A (no key needed)",
    finnhub: FINNHUB_KEY ? "configured" : "NOT CONFIGURED",
    fmp: FMP_KEY ? "configured" : "NOT CONFIGURED",
    alphaVantage: ALPHA_VANTAGE_KEY ? "configured" : "NOT CONFIGURED",
    fred: FRED_KEY ? "configured" : "NOT CONFIGURED",
    secEdgar: "N/A (no key needed)",
  };

  for (const api of Object.keys(API_LIMITS)) {
    lines.push(`| ${api} | ${getUsage(api)} | ${keyStatus[api] || "unknown"} |`);
  }

  lines.push("");
  lines.push("**Quote chain:** Yahoo (free) → Finnhub → FMP");
  lines.push("**Fundamentals:** Finnhub → Alpha Vantage");
  lines.push("**Economic:** FRED (key required)");
  lines.push("**Filings:** SEC EDGAR (no key)");

  return lines.join("\n");
}

// ── MCP Server ─────────────────────────────────────────────

function createServer(): McpServer {
  const server = new McpServer({
    name: "mcp-investment",
    version: "0.1.0",
  });

  server.tool(
    "investment-fetch-quote",
    "Fetch stock quotes with optional fundamentals. Fallback chain: Yahoo → Finnhub → FMP. Quick mode: price/volume. Full mode: adds P/E, EPS, margins, analyst targets.",
    FetchQuoteInput,
    async (params) => ({
      content: [{ type: "text" as const, text: await fetchQuote(params) }],
    }),
  );

  server.tool(
    "investment-fetch-economic",
    "Fetch US economic indicators from FRED. Common: GDP, CPIAUCSL, FEDFUNDS, UNRATE, DGS10, DGS2, T10Y2Y, VIXCLS, MORTGAGE30US, PAYEMS.",
    FetchEconomicInput,
    async (params) => ({
      content: [{ type: "text" as const, text: await fetchEconomic(params) }],
    }),
  );

  server.tool(
    "investment-fetch-filings",
    "Fetch SEC EDGAR filings (10-K, 10-Q, 8-K). Returns filing dates, report dates, and direct URLs. No API key needed.",
    FetchFilingsInput,
    async (params) => ({
      content: [{ type: "text" as const, text: await fetchFilings(params) }],
    }),
  );

  server.tool(
    "investment-api-usage",
    "Show API usage across all financial data sources — rate limits, key status.",
    {},
    async () => ({
      content: [{ type: "text" as const, text: await apiUsage() }],
    }),
  );

  return server;
}

// ── HTTP Server (stateless mode) ───────────────────────────

// Per the MCP SDK stateless pattern, a new server instance is created per
// request so that .connect() is only called once per McpServer lifetime.
const httpServer = Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/health") {
      const keys: Record<string, boolean> = {};
      for (const d of secretDiags) {
        keys[d.name] = d.loaded;
      }
      return new Response(JSON.stringify({ status: "ok", service: "mcp-investment", keys }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.pathname === "/mcp") {
      if (isRateLimited()) {
        return new Response("Rate limit exceeded", { status: 429 });
      }
      const server = createServer();
      // Stateless mode: omitting sessionIdGenerator (read as undefined by the SDK)
      // disables session management — a fresh transport is used per request.
      const transport = new WebStandardStreamableHTTPServerTransport({});
      await server.connect(transport);
      return transport.handleRequest(req);
    }

    return new Response("Not Found", { status: 404 });
  },
});

const keyCount = [FINNHUB_KEY, FMP_KEY, ALPHA_VANTAGE_KEY, FRED_KEY].filter(Boolean).length;
console.log(`mcp-investment listening on http://0.0.0.0:${PORT}/mcp`);
console.log(`Tools: 4 | Keys: ${keyCount}/4 configured`);

process.on("SIGTERM", () => {
  httpServer.stop();
  process.exit(0);
});

process.on("SIGINT", () => {
  httpServer.stop();
  process.exit(0);
});
