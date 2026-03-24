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
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";

// ── Configuration ──────────────────────────────────────────

const PORT = Number(process.env["PORT"]) || 8901;
const SECRETS_DIR = process.env["SECRETS_DIR"] || "/secrets";

// ── Secret Loading ─────────────────────────────────────────

function loadSecret(name: string): string | null {
  try {
    const val = readFileSync(resolve(SECRETS_DIR, name), "utf-8").trim();
    return val.length > 0 ? val : null;
  } catch {
    return null;
  }
}

const FINNHUB_KEY = loadSecret("finnhub-key");
const FMP_KEY = loadSecret("fmp-key");
const ALPHA_VANTAGE_KEY = loadSecret("alpha-vantage-key");
const FRED_KEY = loadSecret("fred-key");

// ── In-Memory Cache ────────────────────────────────────────

const MAX_CACHE_SIZE = 5_000;
const cache = new Map<string, { data: unknown; expires: number }>();

function getCached<T>(key: string): T | null {
  const entry = cache.get(key);
  if (!entry || Date.now() > entry.expires) {
    cache.delete(key);
    return null;
  }
  return entry.data as T;
}

function setCache(key: string, data: unknown, ttlMs: number): void {
  // LRU eviction: drop oldest 20% when at capacity
  if (cache.size >= MAX_CACHE_SIZE) {
    const toDelete = Math.floor(MAX_CACHE_SIZE * 0.2);
    const iter = cache.keys();
    for (let i = 0; i < toDelete; i++) {
      const k = iter.next().value;
      if (k) cache.delete(k);
    }
  }
  cache.set(key, { data, expires: Date.now() + ttlMs });
}

const CACHE_QUOTE = 5 * 60_000;
const CACHE_FUNDAMENTALS = 24 * 3600_000;
const CACHE_ECONOMIC = 24 * 3600_000;
const CACHE_FILINGS = 7 * 24 * 3600_000;

// ── Rate Limiting ──────────────────────────────────────────

interface ApiLimit {
  type: "minute" | "daily" | "second";
  limit: number;
}

const API_LIMITS: Record<string, ApiLimit> = {
  yahoo: { type: "minute", limit: 60 },
  finnhub: { type: "minute", limit: 60 },
  fmp: { type: "daily", limit: 250 },
  alphaVantage: { type: "daily", limit: 25 },
  fred: { type: "minute", limit: 120 },
  secEdgar: { type: "second", limit: 10 },
};

const windowCalls = new Map<string, number[]>();
const dailyCalls = new Map<string, { date: string; count: number }>();

function checkRate(api: string): boolean {
  const limit = API_LIMITS[api];
  if (!limit) return true;
  const now = Date.now();

  if (limit.type === "daily") {
    const today = new Date().toISOString().slice(0, 10);
    const entry = dailyCalls.get(api);
    if (!entry || entry.date !== today) {
      dailyCalls.set(api, { date: today, count: 0 });
      return true;
    }
    return entry.count < limit.limit;
  }

  const windowMs = limit.type === "minute" ? 60_000 : 1_000;
  const timestamps = windowCalls.get(api) || [];
  const recent = timestamps.filter((t) => now - t < windowMs);
  windowCalls.set(api, recent);
  return recent.length < limit.limit;
}

function recordCall(api: string): void {
  const limit = API_LIMITS[api];
  if (!limit) return;

  if (limit.type === "daily") {
    const today = new Date().toISOString().slice(0, 10);
    const entry = dailyCalls.get(api) || { date: today, count: 0 };
    if (entry.date !== today) {
      entry.date = today;
      entry.count = 0;
    }
    entry.count++;
    dailyCalls.set(api, entry);
    return;
  }

  const timestamps = windowCalls.get(api) || [];
  timestamps.push(Date.now());
  windowCalls.set(api, timestamps);
}

function getUsage(api: string): string {
  const limit = API_LIMITS[api];
  if (!limit) return "unknown";

  if (limit.type === "daily") {
    const today = new Date().toISOString().slice(0, 10);
    const entry = dailyCalls.get(api);
    const count = entry && entry.date === today ? entry.count : 0;
    return `${count}/${limit.limit} today`;
  }

  const windowMs = limit.type === "minute" ? 60_000 : 1_000;
  const timestamps = windowCalls.get(api) || [];
  const now = Date.now();
  const recent = timestamps.filter((t) => now - t < windowMs);
  const unit = limit.type === "minute" ? "min" : "sec";
  return `${recent.length}/${limit.limit} per ${unit}`;
}

// ── Fetch Helper ───────────────────────────────────────────

async function apiFetch(
  url: string,
  headers: Record<string, string> = {},
): Promise<unknown> {
  const res = await fetch(url, {
    headers: { Accept: "application/json", ...headers },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
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
  source: string;
}

// ── API: Yahoo Finance (no key) ────────────────────────────

async function fetchYahoo(ticker: string): Promise<QuoteData> {
  if (!checkRate("yahoo")) throw new Error("rate limited");

  const data = (await apiFetch(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=1d`,
    { "User-Agent": "Mozilla/5.0 (compatible; PAI/1.0)" },
  )) as any;
  recordCall("yahoo");

  const meta = data?.chart?.result?.[0]?.meta;
  if (!meta?.regularMarketPrice) throw new Error("no data");

  const prev = meta.previousClose || meta.chartPreviousClose || 0;
  return {
    symbol: ticker,
    name: meta.shortName || meta.longName || ticker,
    price: meta.regularMarketPrice,
    change: prev ? meta.regularMarketPrice - prev : 0,
    changePercent: prev
      ? ((meta.regularMarketPrice - prev) / prev) * 100
      : 0,
    volume: meta.regularMarketVolume || 0,
    dayHigh: meta.regularMarketDayHigh || 0,
    dayLow: meta.regularMarketDayLow || 0,
    yearHigh: meta.fiftyTwoWeekHigh || 0,
    yearLow: meta.fiftyTwoWeekLow || 0,
    marketCap: null,
    pe: null,
    source: "yahoo",
  };
}

// ── API: Finnhub ───────────────────────────────────────────

async function fetchFinnhub(ticker: string): Promise<QuoteData> {
  if (!FINNHUB_KEY) throw new Error("no key");
  if (!checkRate("finnhub")) throw new Error("rate limited");

  const quote = (await apiFetch(
    `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(ticker)}`,
    { "X-Finnhub-Token": FINNHUB_KEY },
  )) as any;
  recordCall("finnhub");

  if (!quote?.c || quote.c === 0) throw new Error("no data");

  let name = ticker;
  let marketCap: number | null = null;
  try {
    if (checkRate("finnhub")) {
      const profile = (await apiFetch(
        `https://finnhub.io/api/v1/stock/profile2?symbol=${encodeURIComponent(ticker)}`,
        { "X-Finnhub-Token": FINNHUB_KEY },
      )) as any;
      recordCall("finnhub");
      if (profile?.name) name = profile.name;
      if (profile?.marketCapitalization)
        marketCap = profile.marketCapitalization * 1_000_000;
    }
  } catch {
    /* profile is optional */
  }

  return {
    symbol: ticker,
    name,
    price: quote.c,
    change: quote.d || 0,
    changePercent: quote.dp || 0,
    volume: 0,
    dayHigh: quote.h || 0,
    dayLow: quote.l || 0,
    yearHigh: 0,
    yearLow: 0,
    marketCap,
    pe: null,
    source: "finnhub",
  };
}

// ── API: FMP ───────────────────────────────────────────────

async function fetchFMP(ticker: string): Promise<QuoteData> {
  if (!FMP_KEY) throw new Error("no key");
  if (!checkRate("fmp")) throw new Error("rate limited");

  const data = (await apiFetch(
    `https://financialmodelingprep.com/api/v3/quote/${encodeURIComponent(ticker)}?apikey=${FMP_KEY}`,
  )) as any;
  recordCall("fmp");

  const q = Array.isArray(data) ? data[0] : data;
  if (!q?.price) throw new Error("no data");

  return {
    symbol: ticker,
    name: q.name || ticker,
    price: q.price,
    change: q.change || 0,
    changePercent: q.changesPercentage || 0,
    volume: q.volume || 0,
    dayHigh: q.dayHigh || 0,
    dayLow: q.dayLow || 0,
    yearHigh: q.yearHigh || 0,
    yearLow: q.yearLow || 0,
    marketCap: q.marketCap || null,
    pe: q.pe || null,
    source: "fmp",
  };
}

// ── API: Finnhub Fundamentals ──────────────────────────────

async function fetchFinnhubFundamentals(
  ticker: string,
): Promise<FundamentalsData> {
  if (!FINNHUB_KEY) throw new Error("no key");
  if (!checkRate("finnhub")) throw new Error("rate limited");

  const metrics = (await apiFetch(
    `https://finnhub.io/api/v1/stock/metric?symbol=${encodeURIComponent(ticker)}&metric=all`,
    { "X-Finnhub-Token": FINNHUB_KEY },
  )) as any;
  recordCall("finnhub");

  const m = metrics?.metric;
  if (!m) throw new Error("no data");

  return {
    pe: m.peNormalizedAnnual || m.peTTM || null,
    eps: m.epsNormalizedAnnual || m.epsTTM || null,
    bookValue: m.bookValuePerShareAnnual || null,
    dividendYield: m.dividendYieldIndicatedAnnual || null,
    profitMargin: m.netProfitMarginTTM || null,
    operatingMargin: m.operatingMarginTTM || null,
    roe: m.roeTTM || null,
    roa: m.roaTTM || null,
    beta: m.beta || null,
    analystTarget: m.targetMedianPrice || null,
    source: "finnhub",
  };
}

// ── API: Alpha Vantage Fundamentals ────────────────────────

async function fetchAlphaVantageFundamentals(
  ticker: string,
): Promise<FundamentalsData> {
  if (!ALPHA_VANTAGE_KEY) throw new Error("no key");
  if (!checkRate("alphaVantage")) throw new Error("rate limited");

  const data = (await apiFetch(
    `https://www.alphavantage.co/query?function=OVERVIEW&symbol=${encodeURIComponent(ticker)}&apikey=${ALPHA_VANTAGE_KEY}`,
  )) as any;
  recordCall("alphaVantage");

  if (!data?.Symbol) throw new Error("no data");

  const num = (v: string | undefined) =>
    v && v !== "None" && v !== "-" ? Number(v) : null;

  return {
    pe: num(data.PERatio),
    eps: num(data.EPS),
    bookValue: num(data.BookValue),
    dividendYield:
      num(data.DividendYield) !== null ? num(data.DividendYield)! * 100 : null,
    profitMargin:
      num(data.ProfitMargin) !== null ? num(data.ProfitMargin)! * 100 : null,
    operatingMargin:
      num(data.OperatingMarginTTM) !== null
        ? num(data.OperatingMarginTTM)! * 100
        : null,
    roe:
      num(data.ReturnOnEquityTTM) !== null
        ? num(data.ReturnOnEquityTTM)! * 100
        : null,
    roa:
      num(data.ReturnOnAssetsTTM) !== null
        ? num(data.ReturnOnAssetsTTM)! * 100
        : null,
    beta: num(data.Beta),
    analystTarget: num(data.AnalystTargetPrice),
    source: "alpha-vantage",
  };
}

// ── Formatting ─────────────────────────────────────────────

function fmtMoney(n: number): string {
  if (Math.abs(n) >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (Math.abs(n) >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  return `$${n.toFixed(2)}`;
}

function fmtVol(v: number): string {
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return String(v);
}

function fmtPct(p: number | null): string {
  return p !== null && p !== undefined ? `${p.toFixed(2)}%` : "N/A";
}

// ── Tool: investment-fetch-quote ───────────────────────────

const TICKER_RE = /^[A-Z][A-Z0-9.-]{0,9}$/;

const FetchQuoteInput = {
  tickers: z
    .string()
    .min(1)
    .max(100)
    .describe(
      "Comma-separated ticker symbols (e.g., 'NVDA' or 'NVDA,AAPL,MSFT'). Max 10.",
    ),
  mode: z
    .enum(["quick", "full"])
    .default("quick")
    .describe("'quick' = price only, 'full' = price + fundamentals"),
};

async function fetchQuote(params: {
  tickers: string;
  mode: string;
}): Promise<string> {
  const tickers = params.tickers
    .split(",")
    .map((t) => t.trim().toUpperCase())
    .filter(Boolean);

  if (tickers.length === 0) return "No valid tickers provided.";
  if (tickers.length > 10) return "Maximum 10 tickers per request.";

  for (const t of tickers) {
    if (!TICKER_RE.test(t))
      return `Invalid ticker: "${t}". Use uppercase, digits, dots, hyphens.`;
  }

  const results: string[] = [];

  for (const ticker of tickers) {
    const cacheKey = `quote:${ticker}`;
    let quote = getCached<QuoteData>(cacheKey);

    if (!quote) {
      for (const fetcher of [fetchYahoo, fetchFinnhub, fetchFMP]) {
        try {
          quote = await fetcher(ticker);
          setCache(cacheKey, quote, CACHE_QUOTE);
          break;
        } catch {
          /* try next source */
        }
      }
    }

    if (!quote) {
      results.push(
        `## ${ticker}\nUnable to fetch quote — all sources failed or rate limited.`,
      );
      continue;
    }

    const sign = quote.change >= 0 ? "+" : "";
    const lines = [
      `## ${quote.symbol} — ${quote.name}`,
      `Price: $${quote.price.toFixed(2)} (${sign}$${quote.change.toFixed(2)}, ${sign}${quote.changePercent.toFixed(2)}%)`,
    ];

    if (quote.volume > 0) lines.push(`Volume: ${fmtVol(quote.volume)}`);
    if (quote.dayHigh > 0)
      lines.push(
        `Day Range: $${quote.dayLow.toFixed(2)} — $${quote.dayHigh.toFixed(2)}`,
      );
    if (quote.yearHigh > 0)
      lines.push(
        `52-Week: $${quote.yearLow.toFixed(2)} — $${quote.yearHigh.toFixed(2)}`,
      );
    if (quote.marketCap) lines.push(`Market Cap: ${fmtMoney(quote.marketCap)}`);
    if (quote.pe) lines.push(`P/E: ${quote.pe.toFixed(1)}`);
    lines.push(`Source: ${quote.source}`);

    if (params.mode === "full") {
      const fundKey = `fund:${ticker}`;
      let fund = getCached<FundamentalsData>(fundKey);

      if (!fund) {
        for (const fetcher of [
          fetchFinnhubFundamentals,
          fetchAlphaVantageFundamentals,
        ]) {
          try {
            fund = await fetcher(ticker);
            setCache(fundKey, fund, CACHE_FUNDAMENTALS);
            break;
          } catch {
            /* try next */
          }
        }
      }

      if (fund) {
        lines.push("", "### Fundamentals");
        if (fund.pe !== null) lines.push(`P/E Ratio: ${fund.pe.toFixed(1)}`);
        if (fund.eps !== null) lines.push(`EPS: $${fund.eps.toFixed(2)}`);
        if (fund.bookValue !== null)
          lines.push(`Book Value: $${fund.bookValue.toFixed(2)}`);
        if (fund.profitMargin !== null)
          lines.push(`Profit Margin: ${fmtPct(fund.profitMargin)}`);
        if (fund.operatingMargin !== null)
          lines.push(`Operating Margin: ${fmtPct(fund.operatingMargin)}`);
        if (fund.roe !== null)
          lines.push(`Return on Equity: ${fmtPct(fund.roe)}`);
        if (fund.roa !== null)
          lines.push(`Return on Assets: ${fmtPct(fund.roa)}`);
        if (fund.beta !== null) lines.push(`Beta: ${fund.beta.toFixed(2)}`);
        if (fund.dividendYield !== null)
          lines.push(`Dividend Yield: ${fmtPct(fund.dividendYield)}`);
        if (fund.analystTarget !== null)
          lines.push(`Analyst Target: $${fund.analystTarget.toFixed(2)}`);
        lines.push(`Source: ${fund.source}`);
      } else {
        lines.push(
          "",
          "### Fundamentals",
          "Unavailable — sources failed or rate limited.",
        );
      }
    }

    results.push(lines.join("\n"));
  }

  return results.join("\n\n");
}

// ── Tool: investment-fetch-economic ────────────────────────

const SERIES_RE = /^[A-Z0-9_]{1,30}$/;

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

async function fetchEconomic(params: {
  series: string;
  observations: number;
}): Promise<string> {
  if (!FRED_KEY) return "FRED API key not configured. Economic data unavailable.";

  const ids = params.series
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);

  if (ids.length === 0) return "No valid series IDs provided.";
  if (ids.length > 10) return "Maximum 10 series per request.";

  for (const s of ids) {
    if (!SERIES_RE.test(s))
      return `Invalid series ID: "${s}". Use uppercase letters, digits, underscores.`;
  }

  const results: string[] = [];

  for (const seriesId of ids) {
    const cacheKey = `econ:${seriesId}:${params.observations}`;
    let cached = getCached<{
      title: string;
      observations: Array<{ date: string; value: string }>;
    }>(cacheKey);

    if (!cached) {
      if (!checkRate("fred")) {
        results.push(`## ${seriesId}\nRate limited — try again in a minute.`);
        continue;
      }

      try {
        const obsData = (await apiFetch(
          `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}&api_key=${FRED_KEY}&file_type=json&sort_order=desc&limit=${params.observations}`,
        )) as any;
        recordCall("fred");

        let title = COMMON_SERIES[seriesId] || seriesId;
        try {
          if (checkRate("fred")) {
            const info = (await apiFetch(
              `https://api.stlouisfed.org/fred/series?series_id=${seriesId}&api_key=${FRED_KEY}&file_type=json`,
            )) as any;
            recordCall("fred");
            if (info?.seriess?.[0]?.title) title = info.seriess[0].title;
          }
        } catch {
          /* title lookup is optional */
        }

        const observations = (obsData?.observations || [])
          .filter((o: any) => o.value !== ".")
          .map((o: any) => ({ date: o.date as string, value: o.value as string }));

        cached = { title, observations };
        setCache(cacheKey, cached, CACHE_ECONOMIC);
      } catch {
        results.push(`## ${seriesId}\nFailed to fetch data from FRED.`);
        continue;
      }
    }

    const lines = [`## ${seriesId} — ${cached.title}`];
    if (cached.observations.length === 0) {
      lines.push("No observations available.");
    } else {
      for (const obs of cached.observations) {
        lines.push(`  ${obs.date}: ${obs.value}`);
      }
    }
    results.push(lines.join("\n"));
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

  const raw = (await apiFetch(
    "https://www.sec.gov/files/company_tickers.json",
    ua,
  )) as Record<string, { cik_str: number; ticker: string; title: string }>;
  recordCall("secEdgar");

  const map: Record<string, string> = {};
  for (const entry of Object.values(raw)) {
    map[entry.ticker] = String(entry.cik_str).padStart(10, "0");
  }

  tickerMapCache = { data: map, expires: Date.now() + CACHE_CIK };
  return map;
}

const FetchFilingsInput = {
  ticker: z
    .string()
    .min(1)
    .max(10)
    .regex(
      /^[A-Z0-9.]{1,10}$/,
      "Ticker: uppercase letters, digits, dots only",
    )
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

async function fetchFilings(params: {
  ticker: string;
  form_type: string;
  count: number;
}): Promise<string> {
  const ticker = params.ticker.toUpperCase();
  const cacheKey = `filings:${ticker}:${params.form_type}:${params.count}`;
  const cached = getCached<string>(cacheKey);
  if (cached) return cached;

  const UA = { "User-Agent": "PAI InvestmentAgent research@pai.local" };

  // Step 1: ticker → CIK (cached map, refreshed every 24h)
  let cik: string | undefined;
  try {
    const map = await getTickerMap(UA);
    cik = map[ticker];
  } catch {
    return `Failed to look up CIK for ${ticker}.`;
  }

  if (!cik) return `Ticker "${ticker}" not found in SEC EDGAR.`;

  // Step 2: fetch filings
  if (!checkRate("secEdgar"))
    return "SEC EDGAR rate limited — try again shortly.";

  try {
    const data = (await apiFetch(
      `https://data.sec.gov/submissions/CIK${cik}.json`,
      UA,
    )) as any;
    recordCall("secEdgar");

    const recent = data?.filings?.recent;
    if (!recent?.form) return `No filings found for ${ticker}.`;

    const lines = [
      `## ${ticker} — ${data.name || ticker}`,
      `CIK: ${data.cik} | SIC: ${data.sic || "N/A"} (${data.sicDescription || "N/A"}) | State: ${data.stateOfIncorporation || "N/A"}`,
      "",
    ];

    let found = 0;
    for (let i = 0; i < recent.form.length && found < params.count; i++) {
      const form = recent.form[i];
      if (params.form_type !== "ALL" && form !== params.form_type) continue;

      const accNum = recent.accessionNumber[i]?.replace(/-/g, "");
      const accDash = recent.accessionNumber[i];
      const doc = recent.primaryDocument[i];
      const filed = recent.filingDate[i];
      const report = recent.reportDate?.[i] || "N/A";
      const url = `https://www.sec.gov/Archives/edgar/data/${data.cik}/${accNum}/${doc}`;

      lines.push(`### ${form} — Filed ${filed}`);
      lines.push(`  Report Date: ${report}`);
      lines.push(`  Accession: ${accDash}`);
      lines.push(`  URL: ${url}`);
      lines.push("");
      found++;
    }

    if (found === 0) lines.push(`No ${params.form_type} filings found.`);

    const result = lines.join("\n");
    setCache(cacheKey, result, CACHE_FILINGS);
    return result;
  } catch {
    return `Failed to fetch filings for ${ticker}.`;
  }
}

// ── Tool: investment-api-usage ─────────────────────────────

async function apiUsage(): Promise<string> {
  const lines = [
    "## API Usage Status",
    "",
    "| API | Usage | Key |",
    "|-----|-------|-----|",
  ];

  const keyStatus: Record<string, string> = {
    yahoo: "N/A (no key)",
    finnhub: FINNHUB_KEY ? "configured" : "MISSING",
    fmp: FMP_KEY ? "configured" : "MISSING",
    alphaVantage: ALPHA_VANTAGE_KEY ? "configured" : "MISSING",
    fred: FRED_KEY ? "configured" : "MISSING",
    secEdgar: "N/A (no key)",
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
      return new Response(
        JSON.stringify({ status: "ok", service: "mcp-investment" }),
        { headers: { "Content-Type": "application/json" } },
      );
    }

    if (url.pathname === "/mcp") {
      const server = createServer();
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
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
