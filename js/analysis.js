// Deep quantitative analysis over browser-loaded visit data.
//
// Every function here is pure computation over rows already held in
// localStorage. Nothing in this file contains, or may ever contain, an actual
// figure from that data: the repository is public and the numbers are not.
// The analysis runs where the data lives -- in the reader's browser.

/**
 * Trailing-week guard.
 *
 * A Power BI export sliced "to date" ends with a partial week, and that one
 * stub poisons everything downstream: it fakes a collapse in momentum, sets a
 * false trough for the peak-to-trough swing, and produces a huge negative
 * residual against expectation. Detect it (final week far below the trailing
 * median) and cut it, loudly.
 */
export function trimPartialWeek(weekly, { frac = 0.4, lookback = 8 } = {}) {
  if (weekly.length < lookback + 2) return { weekly, trimmed: null };
  const tail = weekly.slice(-(lookback + 1), -1).map((p) => p.v).sort((a, b) => a - b);
  const median = tail[Math.floor(tail.length / 2)];
  const last = weekly.at(-1);
  if (last.v < frac * median) {
    return { weekly: weekly.slice(0, -1), trimmed: { ...last, median } };
  }
  return { weekly, trimmed: null };
}

/** ISO week number (needed to align years on the calendar). */
export function isoWeekOf(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (t.getUTCDay() + 6) % 7;
  t.setUTCDate(t.getUTCDate() - dayNum + 3);
  const first = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  const fd = (first.getUTCDay() + 6) % 7;
  first.setUTCDate(first.getUTCDate() - fd + 3);
  return 1 + Math.round((t - first) / (7 * 86400000));
}

/**
 * Same-period YoY: compare a span of weeks against the SAME calendar weeks one
 * year earlier (52-week shift). Raw momentum (last 8 wks vs prior 8) is
 * useless on seasonal data -- May-to-July always collapses -- so every
 * momentum figure here is seasonally adjusted by construction.
 */
export function yoySameWeeks(weekly, span = 8) {
  if (weekly.length < span + 52) return null;
  const nowW = weekly.slice(-span);
  const map = new Map(weekly.map((p) => [p.t, p.v]));
  let now = 0, then = 0, matched = 0;
  for (const p of nowW) {
    const d = new Date(p.t + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() - 364);
    const ly = map.get(d.toISOString().slice(0, 10));
    if (ly !== undefined) { now += p.v; then += ly; matched++; }
  }
  if (matched < Math.min(4, span)) return null;
  return { now, then, pct: then > 0 ? ((now / then) - 1) * 100 : null, weeks: matched };
}

/** Calendar-window YoY: e.g. Jan 1 – latest date, both years. */
export function windowYoY(weekly, latestISO) {
  const y = +latestISO.slice(0, 4);
  const mmdd = latestISO.slice(5);
  const inWin = (p, yr) => p.t.slice(0, 4) === String(yr) && p.t.slice(5) <= mmdd;
  const cur = weekly.filter((p) => inWin(p, y)).reduce((a, p) => a + p.v, 0);
  const prv = weekly.filter((p) => inWin(p, y - 1)).reduce((a, p) => a + p.v, 0);
  return { cur, prv, pct: prv > 0 ? ((cur / prv) - 1) * 100 : null, year: y };
}

/** Mean / CV / peak / trough for one series. */
export function seriesStats(weekly) {
  const vs = weekly.map((p) => p.v);
  if (!vs.length) return null;
  const mean = vs.reduce((a, b) => a + b, 0) / vs.length;
  const sd = Math.sqrt(vs.reduce((a, b) => a + (b - mean) ** 2, 0) / vs.length);
  const max = Math.max(...vs), min = Math.min(...vs);
  const peakAt = weekly[vs.indexOf(max)].t, troughAt = weekly[vs.indexOf(min)].t;
  return { mean, sd, cv: mean > 0 ? sd / mean : null, max, min,
           swing: min > 0 ? max / min : null, peakAt, troughAt };
}

/** Share of total volume held by the busiest N weeks, plus ISO-week profile. */
export function concentration(weekly, topN = [10, 20]) {
  const total = weekly.reduce((a, p) => a + p.v, 0);
  const sorted = [...weekly].sort((a, b) => b.v - a.v);
  const top = Object.fromEntries(topN.map((n) => [n,
    total > 0 ? sorted.slice(0, n).reduce((a, p) => a + p.v, 0) / total : null]));
  const prof = new Map();
  for (const p of weekly) {
    const w = isoWeekOf(p.t);
    if (!prof.has(w)) prof.set(w, []);
    prof.get(w).push(p.v);
  }
  const profile = [...prof.entries()]
    .map(([w, vs]) => ({ w, mean: vs.reduce((a, b) => a + b, 0) / vs.length, n: vs.length }))
    .sort((a, b) => a.w - b.w);
  return { total, top, profile };
}

/** Ordinary least squares of y on x over matching dates. */
export function linfit(xSeries, ySeries) {
  const ym = new Map(ySeries.map((p) => [p.t, p.v]));
  const pts = xSeries.filter((p) => ym.has(p.t))
    .map((p) => ({ t: p.t, x: p.v, y: ym.get(p.t) }));
  const n = pts.length;
  if (n < 10) return null;
  const mx = pts.reduce((a, p) => a + p.x, 0) / n;
  const my = pts.reduce((a, p) => a + p.y, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (const p of pts) { sxy += (p.x - mx) * (p.y - my); sxx += (p.x - mx) ** 2; syy += (p.y - my) ** 2; }
  if (sxx === 0) return null;
  const slope = sxy / sxx, intercept = my - slope * mx;
  const resid = pts.map((p) => ({ t: p.t, actual: p.y, fitted: intercept + slope * p.x,
                                  resid: p.y - (intercept + slope * p.x) }));
  const sse = resid.reduce((a, r) => a + r.resid ** 2, 0);
  const r2 = syy > 0 ? 1 - sse / syy : null;
  const residSd = Math.sqrt(sse / n);
  return { slope, intercept, r2, n, resid, residSd };
}

/** Pearson r over matching dates of two {t,v} series. */
export function levelCorr(a, b) {
  const bm = new Map(b.map((p) => [p.t, p.v]));
  const xs = [], ys = [];
  for (const p of a) if (bm.has(p.t)) { xs.push(p.v); ys.push(bm.get(p.t)); }
  const n = xs.length;
  if (n < 10) return { r: null, n };
  const mx = xs.reduce((s, v) => s + v, 0) / n, my = ys.reduce((s, v) => s + v, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (ys[i] - my); dx += (xs[i] - mx) ** 2; dy += (ys[i] - my) ** 2; }
  const den = Math.sqrt(dx * dy);
  return { r: den > 0 ? num / den : null, n };
}

/** Looks like an ICD-10 code list rather than plain-language visit types? */
export function looksLikeICD(types) {
  if (!types.length) return false;
  const hits = types.filter((t) => /^[A-Z]\d{2}(\.\d+)?$/.test(String(t).trim()));
  return hits.length / types.length > 0.6;
}
