import { describe, test, expect } from "bun:test";

import {
  fmtMoney,
  fmtVol,
  fmtPct,
  parseTickers,
  parseSeries,
  TICKER_RE,
  SERIES_RE,
  MAX_TICKERS,
  MAX_SERIES,
  padCik,
  buildTickerMap,
  sanitizeAccession,
  sanitizeDoc,
  buildFilingUrl,
  API_LIMITS,
  newRateState,
  checkRate,
  recordCall,
  getUsage,
  isRateLimited,
  REQUEST_RATE_LIMIT,
  REQUEST_RATE_WINDOW_MS,
  getCached,
  setCache,
  type CacheEntry,
} from "../src/domain.js";

// All expected values below are derived BY HAND from the literal thresholds,
// rates and limits in src/domain.ts (e.g. the 1e9/1e6 cutoffs in fmtMoney,
// the 60/120/250/25/10 entries in API_LIMITS) — never by echoing whatever the
// function happens to return — so a regression in a constant or branch is
// actually caught instead of mirrored.

// ── fmtMoney ───────────────────────────────────────────────
describe("fmtMoney — magnitude-scaled with abs() thresholds", () => {
  // below $1M → plain dollars, 2 decimals
  test("plain dollars under $1M", () => {
    expect(fmtMoney(0)).toBe("$0.00");
    expect(fmtMoney(12.5)).toBe("$12.50");
    expect(fmtMoney(999_999.99)).toBe("$999999.99");
  });

  // >= 1e6 → /1e6, toFixed(1), suffix M.  2_500_000/1e6 = 2.5
  test("millions at and above $1M (1 decimal)", () => {
    expect(fmtMoney(1_000_000)).toBe("$1.0M");
    expect(fmtMoney(2_500_000)).toBe("$2.5M");
    // 999_999_999 / 1e6 = 999.999999 → toFixed(1) = 1000.0
    expect(fmtMoney(999_999_999)).toBe("$1000.0M");
  });

  // >= 1e9 → /1e9, toFixed(2), suffix B.  3_140_000_000/1e9 = 3.14
  test("billions (2 decimals)", () => {
    expect(fmtMoney(1_000_000_000)).toBe("$1.00B");
    expect(fmtMoney(3_140_000_000)).toBe("$3.14B");
  });

  // >= 1e12 → /1e12, toFixed(2), suffix T.  2_000_000_000_000/1e12 = 2.00
  test("trillions (2 decimals)", () => {
    expect(fmtMoney(2_000_000_000_000)).toBe("$2.00T");
    // 2.5e12 / 1e12 = 2.5 → "2.50"
    expect(fmtMoney(2_500_000_000_000)).toBe("$2.50T");
  });

  // thresholds use Math.abs, but the dividend keeps its sign
  test("negative magnitudes scale by abs but print signed", () => {
    expect(fmtMoney(-5_000_000)).toBe("$-5.0M"); // |−5e6| ≥ 1e6 → -5e6/1e6 = -5.0
    expect(fmtMoney(-250.5)).toBe("$-250.50"); // |−250.5| < 1e6 → toFixed(2)
  });
});

// ── fmtVol ─────────────────────────────────────────────────
describe("fmtVol — volume scaling (no abs, 1 decimal)", () => {
  test("plain integers under 1,000", () => {
    expect(fmtVol(0)).toBe("0");
    expect(fmtVol(999)).toBe("999");
  });

  test("thousands suffix K", () => {
    expect(fmtVol(1_000)).toBe("1.0K");
    expect(fmtVol(12_500)).toBe("12.5K"); // 12500/1e3
    expect(fmtVol(999_999)).toBe("1000.0K"); // 999.999 → 1000.0
  });

  test("millions suffix M", () => {
    expect(fmtVol(1_000_000)).toBe("1.0M");
    expect(fmtVol(2_300_000)).toBe("2.3M"); // 2.3e6/1e6
  });

  test("billions suffix B", () => {
    expect(fmtVol(1_000_000_000)).toBe("1.0B");
    expect(fmtVol(4_560_000_000)).toBe("4.6B"); // 4.56 → toFixed(1) = 4.6
  });
});

// ── fmtPct ─────────────────────────────────────────────────
describe("fmtPct — null/undefined become N/A", () => {
  test("formats a number to 2 decimals with %", () => {
    expect(fmtPct(1.5)).toBe("1.50%");
    expect(fmtPct(-2.345)).toBe("-2.35%"); // toFixed(2) rounds -2.345 → -2.35 or -2.34? banker? JS: "-2.35"
    expect(fmtPct(0)).toBe("0.00%");
  });

  test("N/A for null / undefined", () => {
    expect(fmtPct(null)).toBe("N/A");
    expect(fmtPct(undefined as unknown as number)).toBe("N/A");
  });
});

// ── parseTickers ───────────────────────────────────────────
describe("parseTickers — split/trim/upper/validate, max 10", () => {
  test("trims, uppercases, drops empties", () => {
    const r = parseTickers(" aapl , msft ,, googl ");
    expect(r).toEqual({ ok: true, items: ["AAPL", "MSFT", "GOOGL"] });
  });

  test("empty input is rejected", () => {
    expect(parseTickers("")).toEqual({ ok: false, error: "No valid tickers provided." });
    expect(parseTickers("  , , ")).toEqual({ ok: false, error: "No valid tickers provided." });
  });

  test("exactly MAX_TICKERS (10) is allowed, 11 is rejected", () => {
    const ten = Array.from({ length: MAX_TICKERS }, (_, i) => `T${i}`).join(",");
    const ok = parseTickers(ten);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.items.length).toBe(10);

    const eleven = Array.from({ length: MAX_TICKERS + 1 }, (_, i) => `T${i}`).join(",");
    expect(parseTickers(eleven)).toEqual({
      ok: false,
      error: "Maximum 10 tickers per request.",
    });
  });

  test("accepts dots and hyphens, rejects illegal chars", () => {
    expect(parseTickers("BRK.B").ok).toBe(true);
    expect(parseTickers("RDS-A").ok).toBe(true);
    const bad = parseTickers("AA$PL");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain('Invalid ticker: "AA$PL"');
  });

  test("first char must be a letter (TICKER_RE)", () => {
    // regex: ^[A-Z][A-Z0-9.-]{0,9}$ — leading digit is illegal
    expect(TICKER_RE.test("1AAPL")).toBe(false);
    expect(parseTickers("1AAPL").ok).toBe(false);
    // 10 chars max after first → 11-char ticker fails
    expect(TICKER_RE.test("ABCDEFGHIJK")).toBe(false); // 11 chars
    expect(TICKER_RE.test("ABCDEFGHIJ")).toBe(true); // 10 chars
  });
});

// ── parseSeries ────────────────────────────────────────────
describe("parseSeries — FRED series ids, max 10", () => {
  test("uppercases and accepts underscores/digits", () => {
    const r = parseSeries("gdp, unrate, dgs10 ");
    expect(r).toEqual({ ok: true, items: ["GDP", "UNRATE", "DGS10"] });
  });

  test("empty rejected", () => {
    expect(parseSeries(" , ")).toEqual({
      ok: false,
      error: "No valid series IDs provided.",
    });
  });

  test("over MAX_SERIES (10) rejected", () => {
    const eleven = Array.from({ length: MAX_SERIES + 1 }, (_, i) => `S${i}`).join(",");
    expect(parseSeries(eleven)).toEqual({
      ok: false,
      error: "Maximum 10 series per request.",
    });
  });

  test("dots/hyphens are illegal for series (unlike tickers)", () => {
    // SERIES_RE = ^[A-Z0-9_]{1,30}$ — a dot is not allowed
    expect(SERIES_RE.test("DGS10")).toBe(true);
    expect(SERIES_RE.test("DGS.10")).toBe(false);
    const bad = parseSeries("DGS.10");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain('Invalid series ID: "DGS.10"');
  });

  test("30-char id allowed, 31 rejected", () => {
    expect(SERIES_RE.test("A".repeat(30))).toBe(true);
    expect(SERIES_RE.test("A".repeat(31))).toBe(false);
  });
});

// ── SEC EDGAR helpers ──────────────────────────────────────
describe("padCik — left-pad to 10 digits", () => {
  test("pads numbers and strings", () => {
    expect(padCik(320193)).toBe("0000320193"); // Apple's CIK
    expect(padCik("789019")).toBe("0000789019");
    expect(padCik(1)).toBe("0000000001");
  });

  test("does not truncate an already-10-digit value", () => {
    expect(padCik(1234567890)).toBe("1234567890");
  });
});

describe("buildTickerMap — ticker → padded CIK", () => {
  test("maps each entry's ticker to its zero-padded cik_str", () => {
    const raw = {
      "0": { cik_str: 320193, ticker: "AAPL", title: "Apple Inc." },
      "1": { cik_str: 789019, ticker: "MSFT", title: "Microsoft" },
    };
    expect(buildTickerMap(raw)).toEqual({
      AAPL: "0000320193",
      MSFT: "0000789019",
    });
  });

  test("later entry wins on duplicate ticker (last write)", () => {
    const raw = {
      "0": { cik_str: 1, ticker: "DUP", title: "first" },
      "1": { cik_str: 2, ticker: "DUP", title: "second" },
    };
    expect(buildTickerMap(raw)).toEqual({ DUP: "0000000002" });
  });
});

describe("sanitizeAccession / sanitizeDoc / buildFilingUrl", () => {
  test("sanitizeAccession strips hyphens and non-alphanumerics", () => {
    expect(sanitizeAccession("0000320193-23-000106")).toBe("000032019323000106");
    expect(sanitizeAccession("abc/../def")).toBe("abcdef");
  });

  test("sanitizeDoc keeps . _ - but drops path separators", () => {
    expect(sanitizeDoc("aapl-20230930.htm")).toBe("aapl-20230930.htm");
    expect(sanitizeDoc("../../etc/passwd")).toBe("....etcpasswd"); // / dropped, dots kept
  });

  test("buildFilingUrl assembles a sanitized SEC Archives URL", () => {
    expect(buildFilingUrl("0000320193", "0000320193-23-000106", "aapl-20230930.htm")).toBe(
      "https://www.sec.gov/Archives/edgar/data/0000320193/000032019323000106/aapl-20230930.htm",
    );
  });
});

// ── API_LIMITS shape ───────────────────────────────────────
describe("API_LIMITS — configured limits", () => {
  test("the six known APIs with their types and limits", () => {
    expect(API_LIMITS["yahoo"]).toEqual({ type: "minute", limit: 60 });
    expect(API_LIMITS["finnhub"]).toEqual({ type: "minute", limit: 60 });
    expect(API_LIMITS["fmp"]).toEqual({ type: "daily", limit: 250 });
    expect(API_LIMITS["alphaVantage"]).toEqual({ type: "daily", limit: 25 });
    expect(API_LIMITS["fred"]).toEqual({ type: "minute", limit: 120 });
    expect(API_LIMITS["secEdgar"]).toEqual({ type: "second", limit: 10 });
  });
});

// ── checkRate / recordCall / getUsage (minute window) ──────
describe("rate limiter — yahoo (minute window, limit 60)", () => {
  const T0 = 1_700_000_000_000; // fixed epoch ms

  test("allows up to the limit, then blocks", () => {
    const s = newRateState();
    // record 59 calls within the same instant → 60th is still allowed
    for (let i = 0; i < 59; i++) recordCall(s, "yahoo", T0);
    expect(checkRate(s, "yahoo", T0)).toBe(true); // 59 < 60
    recordCall(s, "yahoo", T0); // now 60 recorded
    expect(checkRate(s, "yahoo", T0)).toBe(false); // 60 is not < 60
  });

  test("usage string reflects recent count within the 60s window", () => {
    const s = newRateState();
    recordCall(s, "yahoo", T0);
    recordCall(s, "yahoo", T0 + 1_000);
    recordCall(s, "yahoo", T0 + 2_000);
    expect(getUsage(s, "yahoo", T0 + 2_000)).toBe("3/60 per min");
  });

  test("calls older than 60s fall out of the window", () => {
    const s = newRateState();
    recordCall(s, "yahoo", T0); // will age out
    recordCall(s, "yahoo", T0 + 30_000);
    // at T0 + 60_001: first call (age 60_001ms) is >= window → evicted, one remains
    expect(getUsage(s, "yahoo", T0 + 60_001)).toBe("1/60 per min");
    expect(checkRate(s, "yahoo", T0 + 60_001)).toBe(true);
  });
});

describe("rate limiter — secEdgar (second window, limit 10)", () => {
  const T0 = 1_700_000_000_000;

  test("usage uses 'per sec' and the 1s window", () => {
    const s = newRateState();
    recordCall(s, "secEdgar", T0);
    recordCall(s, "secEdgar", T0 + 500); // within 1s
    expect(getUsage(s, "secEdgar", T0 + 500)).toBe("2/10 per sec");
    // a call 1s+ later: the first (age 1001ms) ages out
    expect(getUsage(s, "secEdgar", T0 + 1_001)).toBe("1/10 per sec");
  });
});

describe("rate limiter — fmp (daily window, limit 250)", () => {
  // 2023-11-14 in UTC for T0=1_700_000_000_000 (verified: that ms is 2023-11-14T22:13:20Z)
  const DAY1 = Date.parse("2023-11-14T10:00:00Z");
  const DAY2 = Date.parse("2023-11-15T10:00:00Z");

  test("counts per UTC day and resets the next day", () => {
    const s = newRateState();
    for (let i = 0; i < 5; i++) recordCall(s, "fmp", DAY1);
    expect(getUsage(s, "fmp", DAY1)).toBe("5/250 today");
    expect(checkRate(s, "fmp", DAY1)).toBe(true);
    // new day → counter resets
    expect(getUsage(s, "fmp", DAY2)).toBe("0/250 today");
    expect(checkRate(s, "fmp", DAY2)).toBe(true);
  });

  test("blocks once the daily limit is reached", () => {
    const s = newRateState();
    for (let i = 0; i < 250; i++) recordCall(s, "fmp", DAY1);
    expect(getUsage(s, "fmp", DAY1)).toBe("250/250 today");
    expect(checkRate(s, "fmp", DAY1)).toBe(false); // 250 is not < 250
  });
});

describe("rate limiter — unknown API is unlimited", () => {
  const T0 = 1_700_000_000_000;
  test("checkRate true, getUsage 'unknown', recordCall is a no-op", () => {
    const s = newRateState();
    expect(checkRate(s, "nope", T0)).toBe(true);
    expect(getUsage(s, "nope", T0)).toBe("unknown");
    recordCall(s, "nope", T0); // must not throw / must not record
    expect(checkRate(s, "nope", T0)).toBe(true);
  });
});

// ── isRateLimited (global sliding window) ──────────────────
describe("isRateLimited — global sliding window (30 / 60s)", () => {
  const T0 = 1_700_000_000_000;

  test("defaults match the exported constants", () => {
    expect(REQUEST_RATE_LIMIT).toBe(30);
    expect(REQUEST_RATE_WINDOW_MS).toBe(60_000);
  });

  test("first 30 calls pass, 31st is limited", () => {
    const ts: number[] = [];
    for (let i = 0; i < 30; i++) {
      expect(isRateLimited(ts, T0)).toBe(false); // records as it allows
    }
    expect(ts.length).toBe(30);
    expect(isRateLimited(ts, T0)).toBe(true); // at capacity → blocked, not recorded
    expect(ts.length).toBe(30);
  });

  test("entries older than the window are evicted, freeing capacity", () => {
    const ts: number[] = [];
    // small custom limit/window to make the math obvious
    expect(isRateLimited(ts, T0, 2, 1_000)).toBe(false); // ts=[T0]
    expect(isRateLimited(ts, T0, 2, 1_000)).toBe(false); // ts=[T0,T0]
    expect(isRateLimited(ts, T0, 2, 1_000)).toBe(true); // full
    // advance past the window: both T0 entries (< now-1000) evicted
    expect(isRateLimited(ts, T0 + 1_001, 2, 1_000)).toBe(false);
    expect(ts).toEqual([T0 + 1_001]);
  });
});

// ── getCached / setCache ───────────────────────────────────
describe("getCached / setCache — TTL + LRU eviction", () => {
  const T0 = 1_700_000_000_000;

  test("returns stored value before expiry", () => {
    const cache = new Map<string, CacheEntry>();
    setCache(cache, "k", { v: 1 }, 10_000, T0);
    expect(getCached(cache, "k", T0 + 9_999)).toEqual({ v: 1 });
  });

  test("expired entry returns null and is deleted", () => {
    const cache = new Map<string, CacheEntry>();
    setCache(cache, "k", 42, 10_000, T0); // expires at T0+10_000
    // now > expires → null. T0+10_000 is NOT > expires, so use +10_001.
    expect(getCached(cache, "k", T0 + 10_001)).toBeNull();
    expect(cache.has("k")).toBe(false);
    // boundary: exactly at expires is still valid (now > expires is false)
    setCache(cache, "k2", 7, 10_000, T0);
    expect(getCached(cache, "k2", T0 + 10_000)).toBe(7);
  });

  test("missing key returns null", () => {
    const cache = new Map<string, CacheEntry>();
    expect(getCached(cache, "absent", T0)).toBeNull();
  });

  test("evicts oldest 20% when at capacity before inserting", () => {
    // maxSize = 10 → at capacity it deletes floor(10*0.2)=2 oldest, then inserts.
    const cache = new Map<string, CacheEntry>();
    const MAX = 10;
    for (let i = 0; i < MAX; i++) setCache(cache, `k${i}`, i, 100_000, T0, MAX);
    expect(cache.size).toBe(MAX); // exactly full

    setCache(cache, "knew", 999, 100_000, T0, MAX); // triggers eviction of 2 oldest
    // k0 and k1 (insertion order) evicted; size = 10 - 2 + 1 = 9
    expect(cache.size).toBe(9);
    expect(cache.has("k0")).toBe(false);
    expect(cache.has("k1")).toBe(false);
    expect(cache.has("k2")).toBe(true);
    expect(getCached(cache, "knew", T0)).toBe(999);
  });
});
