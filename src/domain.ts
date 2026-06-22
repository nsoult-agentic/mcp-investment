/**
 * Pure, deterministic domain logic — extracted from http.ts so it can be unit
 * tested without booting the Bun HTTP server or reading secrets from disk
 * (http.ts performs both at import time).
 *
 * Everything here is side-effect free: no I/O, no module-level singletons that
 * are mutated implicitly, and any time dependency is passed in as an explicit
 * `now` argument. http.ts re-imports these and supplies its own clock/state, so
 * runtime behavior is unchanged.
 */

// ── Formatting ─────────────────────────────────────────────

export function fmtMoney(n: number): string {
  if (Math.abs(n) >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (Math.abs(n) >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  return `$${n.toFixed(2)}`;
}

export function fmtVol(v: number): string {
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return String(v);
}

export function fmtPct(p: number | null): string {
  return p !== null && p !== undefined ? `${p.toFixed(2)}%` : "N/A";
}

// ── Input validation / parsing ─────────────────────────────

export const TICKER_RE = /^[A-Z][A-Z0-9.-]{0,9}$/;
export const SERIES_RE = /^[A-Z0-9_]{1,30}$/;

export const MAX_TICKERS = 10;
export const MAX_SERIES = 10;

export type ParseResult = { ok: true; items: string[] } | { ok: false; error: string };

/**
 * Parse a comma-separated tickers string exactly as fetchQuote() does:
 * split, trim, uppercase, drop empties, bound the count, validate each token.
 */
export function parseTickers(raw: string): ParseResult {
  const items = raw
    .split(",")
    .map((t) => t.trim().toUpperCase())
    .filter(Boolean);

  if (items.length === 0) return { ok: false, error: "No valid tickers provided." };
  if (items.length > MAX_TICKERS) return { ok: false, error: "Maximum 10 tickers per request." };

  for (const t of items) {
    if (!TICKER_RE.test(t))
      return {
        ok: false,
        error: `Invalid ticker: "${t}". Use uppercase, digits, dots, hyphens.`,
      };
  }
  return { ok: true, items };
}

/**
 * Parse a comma-separated FRED series string exactly as fetchEconomic() does.
 */
export function parseSeries(raw: string): ParseResult {
  const items = raw
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);

  if (items.length === 0) return { ok: false, error: "No valid series IDs provided." };
  if (items.length > MAX_SERIES) return { ok: false, error: "Maximum 10 series per request." };

  for (const s of items) {
    if (!SERIES_RE.test(s))
      return {
        ok: false,
        error: `Invalid series ID: "${s}". Use uppercase letters, digits, underscores.`,
      };
  }
  return { ok: true, items };
}

// ── SEC EDGAR helpers ──────────────────────────────────────

/** Zero-pad a numeric CIK to the 10-digit form SEC EDGAR uses. */
export function padCik(cik: number | string): string {
  return String(cik).padStart(10, "0");
}

/** Build the ticker→CIK map from SEC's company_tickers.json payload shape. */
export function buildTickerMap(
  raw: Record<string, { cik_str: number; ticker: string; title: string }>,
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const entry of Object.values(raw)) {
    map[entry.ticker] = padCik(entry.cik_str);
  }
  return map;
}

/** Strip an accession number to alphanumerics (used as a URL path segment). */
export function sanitizeAccession(acc: string): string {
  return acc.replace(/-/g, "").replace(/[^a-zA-Z0-9]/g, "");
}

/** Strip a primary-document name to a safe filename charset. */
export function sanitizeDoc(doc: string): string {
  return doc.replace(/[^a-zA-Z0-9._-]/g, "");
}

/** Build the canonical SEC Archives URL for a filing document. */
export function buildFilingUrl(cikDigits: string, accession: string, doc: string): string {
  return `https://www.sec.gov/Archives/edgar/data/${cikDigits}/${sanitizeAccession(accession)}/${sanitizeDoc(doc)}`;
}

// ── Rate limiting (pure core) ──────────────────────────────

export interface ApiLimit {
  type: "minute" | "daily" | "second";
  limit: number;
}

export const API_LIMITS: Record<string, ApiLimit> = {
  yahoo: { type: "minute", limit: 60 },
  finnhub: { type: "minute", limit: 60 },
  fmp: { type: "daily", limit: 250 },
  alphaVantage: { type: "daily", limit: 25 },
  fred: { type: "minute", limit: 120 },
  secEdgar: { type: "second", limit: 10 },
};

interface DailyEntry {
  date: string;
  count: number;
}

export interface RateState {
  windowCalls: Map<string, number[]>;
  dailyCalls: Map<string, DailyEntry>;
}

export function newRateState(): RateState {
  return { windowCalls: new Map(), dailyCalls: new Map() };
}

function isoDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/**
 * Whether a call to `api` is currently allowed (does NOT record it).
 * Returns true for unknown APIs (no configured limit).
 */
export function checkRate(state: RateState, api: string, now: number): boolean {
  const limit = API_LIMITS[api];
  if (!limit) return true;

  if (limit.type === "daily") {
    const today = isoDay(now);
    const entry = state.dailyCalls.get(api);
    if (!entry || entry.date !== today) {
      state.dailyCalls.set(api, { date: today, count: 0 });
      return true;
    }
    return entry.count < limit.limit;
  }

  const windowMs = limit.type === "minute" ? 60_000 : 1_000;
  const timestamps = state.windowCalls.get(api) || [];
  const recent = timestamps.filter((t) => now - t < windowMs);
  state.windowCalls.set(api, recent);
  return recent.length < limit.limit;
}

/** Record one call against `api`'s limit. No-op for unknown APIs. */
export function recordCall(state: RateState, api: string, now: number): void {
  const limit = API_LIMITS[api];
  if (!limit) return;

  if (limit.type === "daily") {
    const today = isoDay(now);
    const entry = state.dailyCalls.get(api) || { date: today, count: 0 };
    if (entry.date !== today) {
      entry.date = today;
      entry.count = 0;
    }
    entry.count++;
    state.dailyCalls.set(api, entry);
    return;
  }

  const timestamps = state.windowCalls.get(api) || [];
  timestamps.push(now);
  state.windowCalls.set(api, timestamps);
}

/** Human-readable usage string, e.g. "3/60 per min" or "5/250 today". */
export function getUsage(state: RateState, api: string, now: number): string {
  const limit = API_LIMITS[api];
  if (!limit) return "unknown";

  if (limit.type === "daily") {
    const today = isoDay(now);
    const entry = state.dailyCalls.get(api);
    const count = entry && entry.date === today ? entry.count : 0;
    return `${count}/${limit.limit} today`;
  }

  const windowMs = limit.type === "minute" ? 60_000 : 1_000;
  const timestamps = state.windowCalls.get(api) || [];
  const recent = timestamps.filter((t) => now - t < windowMs);
  const unit = limit.type === "minute" ? "min" : "sec";
  return `${recent.length}/${limit.limit} per ${unit}`;
}

// ── Global request rate limiter (sliding window) ───────────

export const REQUEST_RATE_LIMIT = 30;
export const REQUEST_RATE_WINDOW_MS = 60_000;

/**
 * Sliding-window limiter over a mutable timestamps array. Evicts entries older
 * than the window, then either rejects (true) when at capacity or records the
 * call and allows it (false). Mirrors http.ts isRateLimited().
 */
export function isRateLimited(
  timestamps: number[],
  now: number,
  limit = REQUEST_RATE_LIMIT,
  windowMs = REQUEST_RATE_WINDOW_MS,
): boolean {
  while (timestamps.length > 0) {
    const oldest = timestamps[0];
    if (oldest === undefined || oldest >= now - windowMs) break;
    timestamps.shift();
  }
  if (timestamps.length >= limit) return true;
  timestamps.push(now);
  return false;
}

// ── In-memory cache (pure core) ────────────────────────────

export interface CacheEntry {
  data: unknown;
  expires: number;
}

const MAX_CACHE_SIZE = 5_000;

/** Read a cache entry, deleting and returning null if missing or expired. */
export function getCached<T>(cache: Map<string, CacheEntry>, key: string, now: number): T | null {
  const entry = cache.get(key);
  if (!entry || now > entry.expires) {
    cache.delete(key);
    return null;
  }
  return entry.data as T;
}

/**
 * Insert into cache. When at capacity, evicts the oldest 20% (insertion order)
 * before inserting, matching http.ts setCache LRU behavior.
 */
export function setCache(
  cache: Map<string, CacheEntry>,
  key: string,
  data: unknown,
  ttlMs: number,
  now: number,
  maxSize = MAX_CACHE_SIZE,
): void {
  if (cache.size >= maxSize) {
    const toDelete = Math.floor(maxSize * 0.2);
    const iter = cache.keys();
    for (let i = 0; i < toDelete; i++) {
      const k = iter.next().value;
      if (k) cache.delete(k);
    }
  }
  cache.set(key, { data, expires: now + ttlMs });
}
