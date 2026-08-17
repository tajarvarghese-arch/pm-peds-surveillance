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

/**
 * Exact paired-week YoY: every week of the latest year up to `latestISO` is
 * matched to the week exactly 364 days earlier, and only matched pairs count.
 * windowYoY's Jan-1-to-date windows can hold UNEQUAL week counts (an extra
 * week lands in one year or the other), which quietly biases the comparison
 * by a whole summer week; this version cannot.
 */
export function pairedYoY(weekly, latestISO) {
  const y = +latestISO.slice(0, 4);
  const map = new Map(weekly.map((p) => [p.t, p.v]));
  let cur = 0, prv = 0, n = 0;
  for (const p of weekly) {
    if (p.t.slice(0, 4) !== String(y) || p.t > latestISO) continue;
    const d = new Date(p.t + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() - 364);
    const k = d.toISOString().slice(0, 10);
    if (map.has(k)) { cur += p.v; prv += map.get(k); n++; }
  }
  return n ? { cur, prv, pct: prv > 0 ? ((cur / prv) - 1) * 100 : null, weeks: n, year: y } : null;
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

/* ======================================================================== */
/* Report-tab computations. Same contract as everything above: pure         */
/* functions over browser-held rows; no figure from the data may live here. */
/* ======================================================================== */

/** Roll rows up to calendar months: [{t:'YYYY-MM', v}]. */
export function toMonthly(rows, filterFn = () => true) {
  const b = new Map();
  for (const r of rows) {
    if (!filterFn(r)) continue;
    const k = r.date.slice(0, 7);
    b.set(k, (b.get(k) || 0) + r.visits);
  }
  return [...b.entries()].map(([t, v]) => ({ t, v })).sort((a, b2) => (a.t < b2.t ? -1 : 1));
}

/**
 * Monthly cousin of the trailing-week guard: an export sliced mid-month ends on
 * a stub that reads as a collapse. Cut it and say so.
 */
export function trimPartialMonth(monthly, { frac = 0.75, lookback = 6 } = {}) {
  if (monthly.length < lookback + 2) return { monthly, trimmed: null };
  const tail = monthly.slice(-(lookback + 1), -1).map((p) => p.v).sort((a, b) => a - b);
  const median = tail[Math.floor(tail.length / 2)];
  const last = monthly.at(-1);
  if (last.v < frac * median) {
    return { monthly: monthly.slice(0, -1), trimmed: { ...last, median } };
  }
  return { monthly, trimmed: null };
}

/**
 * Seasonal phase of one series: which ISO week of the year it peaks in, on a
 * circularly smoothed week-of-year profile, so both observed winters vote on
 * one answer instead of scattering across calendar years.
 */
export function phaseOf(weekly) {
  if (weekly.length < 20) return null;
  const prof = new Map();
  for (const p of weekly) {
    const w = isoWeekOf(p.t);
    if (!prof.has(w)) prof.set(w, []);
    prof.get(w).push(p.v);
  }
  const woys = [...prof.keys()].sort((a, b) => a - b);
  const mean = woys.map((w) => {
    const vs = prof.get(w);
    return vs.reduce((a, b) => a + b, 0) / vs.length;
  });
  const n = mean.length;
  const sm = mean.map((_, i) => {
    let s = 0;
    for (let k = -2; k <= 2; k++) s += mean[(i + k + n) % n];
    return s / 5;
  });
  const iMax = sm.indexOf(Math.max(...sm));
  const iMin = sm.indexOf(Math.min(...sm));
  return {
    peakWoy: woys[iMax],
    troughWoy: woys[iMin],
    amp: sm[iMin] > 0 ? sm[iMax] / sm[iMin] : null,
    // Phase key rotated so early October = 0: winter-peaked series sort first,
    // summer-peaked last, and the two winters land together.
    phase: (woys[iMax] - 40 + 53) % 53,
  };
}

/**
 * Week-to-week volatility with the seasonal shape removed: each week measured
 * against its own centered moving average, so a big January is not "volatile",
 * but missing the January you usually get is.
 */
export function residVolatility(weekly, win = 5) {
  if (weekly.length < win + 4) return null;
  const half = Math.floor(win / 2);
  const rel = [];
  for (let i = 0; i < weekly.length; i++) {
    const lo = Math.max(0, i - half), hi = Math.min(weekly.length - 1, i + half);
    let s = 0, n = 0;
    for (let k = lo; k <= hi; k++) { s += weekly[k].v; n++; }
    const ma = s / n;
    if (ma > 0) rel.push((weekly[i].v - ma) / ma);
  }
  const m = rel.reduce((a, b) => a + b, 0) / rel.length;
  return Math.sqrt(rel.reduce((a, b) => a + (b - m) ** 2, 0) / rel.length) * 100;
}

/** July–June season key: '2025–26' for any date from Jul 2025 to Jun 2026. */
export function seasonOf(dateStr) {
  const y = +dateStr.slice(0, 4);
  const m = +dateStr.slice(5, 7);
  const start = m >= 7 ? y : y - 1;
  return `${start}–${String(start + 1).slice(2)}`;
}

/** Peak week of each observed season (Jul–Jun), for series with a winter wave. */
export function seasonPeaks(weekly) {
  const by = new Map();
  for (const p of weekly) {
    const s = seasonOf(p.t);
    if (!by.has(s)) by.set(s, []);
    by.get(s).push(p);
  }
  return [...by.entries()].map(([season, pts]) => {
    const peak = pts.reduce((a, p) => (p.v > a.v ? p : a));
    return { season, t: peak.t, v: peak.v, weeks: pts.length };
  }).sort((a, b) => (a.season < b.season ? -1 : 1));
}

/**
 * Wave-aligned season comparison: sum each season over [its own peak week,
 * peak + span]. A wave that arrives six weeks early devastates a calendar
 * comparison while the wave itself is barely changed — this is the correction.
 * Returns null unless both seasons have the full span after their peaks.
 */
export function waveAligned(weekly, span = 10) {
  const peaks = seasonPeaks(weekly).filter((p) => p.weeks >= 16);
  if (peaks.length < 2) return null;
  const [a, b] = peaks.slice(-2);
  const idx = new Map(weekly.map((p, i) => [p.t, i]));
  const sumFrom = (t) => {
    const i0 = idx.get(t);
    if (i0 === undefined || i0 + span >= weekly.length) return null;
    let s = 0;
    for (let i = i0; i <= i0 + span; i++) s += weekly[i].v;
    return s;
  };
  const sa = sumFrom(a.t), sb = sumFrom(b.t);
  if (sa === null || sb === null) return null;
  const shiftWeeks = Math.round(
    ((new Date(b.t) - new Date(a.t)) / (7 * 86400000) - 52));
  return {
    prev: { ...a, sum: sa }, cur: { ...b, sum: sb },
    pct: sa > 0 ? ((sb / sa) - 1) * 100 : null,
    peakPct: a.v > 0 ? ((b.v / a.v) - 1) * 100 : null,
    shiftWeeks, span,
  };
}

/**
 * Footprint split over monthly per-location rows.
 *
 * Pairs the Jan..M window of the latest year against the same months a year
 * earlier. A site is same-store when it has volume in every month of both
 * windows; everything else lands in exited (present in the earlier window's
 * months beyond the later one) or entered. The three deltas sum exactly to the
 * all-network change, because every site is in exactly one bucket.
 */
export function footprint(locRows) {
  const months = [...new Set(locRows.map((r) => r.date.slice(0, 7)))].sort();
  if (months.length < 14) return null;
  const last = months.at(-1);
  const curYear = +last.slice(0, 4);
  const mm = +last.slice(5, 7);
  const win = (y) => Array.from({ length: mm }, (_, i) =>
    `${y}-${String(i + 1).padStart(2, '0')}`);
  const curWin = win(curYear), prvWin = win(curYear - 1);
  if (!prvWin.every((m) => months.includes(m))) return null;

  const by = new Map(); // loc -> Map(month -> v)
  for (const r of locRows) {
    if (!by.has(r.location)) by.set(r.location, new Map());
    const m = by.get(r.location);
    const k = r.date.slice(0, 7);
    m.set(k, (m.get(k) || 0) + r.visits);
  }

  const sites = [...by.entries()].map(([loc, m]) => {
    const cur = curWin.reduce((a, k) => a + (m.get(k) || 0), 0);
    const prv = prvWin.reduce((a, k) => a + (m.get(k) || 0), 0);
    const fullCur = curWin.every((k) => m.get(k));
    const fullPrv = prvWin.every((k) => m.get(k));
    const total = [...m.values()].reduce((a, b) => a + b, 0);
    return { loc, cur, prv, fullCur, fullPrv, total, months: m };
  });

  const ss = sites.filter((s) => s.fullCur && s.fullPrv);
  const exited = sites.filter((s) => s.fullPrv && !s.fullCur);
  const entered = sites.filter((s) => !s.fullPrv && s.fullCur);
  const churned = sites.filter((s) => !s.fullPrv && !s.fullCur);
  const sum = (xs, f) => xs.reduce((a, s) => a + f(s), 0);

  const allCur = sum(sites, (s) => s.cur), allPrv = sum(sites, (s) => s.prv);
  const ssCur = sum(ss, (s) => s.cur), ssPrv = sum(ss, (s) => s.prv);

  // Same-store month-by-month YoY next to all-network — the cleanest view of
  // whether a bad January was the season or the business.
  const monthly = curWin.map((k, i) => ({
    m: k,
    all: (() => { const c = sum(sites, (s) => s.months.get(k) || 0);
                  const p = sum(sites, (s) => s.months.get(prvWin[i]) || 0);
                  return p > 0 ? ((c / p) - 1) * 100 : null; })(),
    ss: (() => { const c = sum(ss, (s) => s.months.get(k) || 0);
                 const p = sum(ss, (s) => s.months.get(prvWin[i]) || 0);
                 return p > 0 ? ((c / p) - 1) * 100 : null; })(),
  }));

  // Winter amplitude per site: December against that year's Jun–Aug mean.
  const decs = months.filter((m) => m.endsWith('-12'));
  const ampOf = (m) => {
    for (const d of decs.slice().reverse()) {
      const y = d.slice(0, 4);
      const summer = ['06', '07', '08'].map((x) => m.get(`${y}-${x}`)).filter(Boolean);
      if (m.get(d) && summer.length === 3) {
        return m.get(d) / (summer.reduce((a, b) => a + b, 0) / 3);
      }
    }
    return null;
  };
  for (const s of ss) s.amp = ampOf(s.months);

  const ranked = [...sites].sort((a, b) => b.total - a.total);
  const grand = sum(sites, (s) => s.total);
  let acc = 0;
  const cumShare = ranked.map((s) => { acc += s.total; return acc / grand; });

  return {
    window: { months: mm, curYear, label: `Jan–${last.slice(5)}` },
    all: { cur: allCur, prv: allPrv, pct: allPrv > 0 ? ((allCur / allPrv) - 1) * 100 : null },
    sameStore: { cur: ssCur, prv: ssPrv, n: ss.length,
                 pct: ssPrv > 0 ? ((ssCur / ssPrv) - 1) * 100 : null },
    bridge: {
      start: allPrv, ss: ssCur - ssPrv,
      exited: sum(exited, (s) => s.cur - s.prv) + sum(churned, (s) => s.cur - s.prv),
      entered: sum(entered, (s) => s.cur - s.prv),
      end: allCur,
    },
    nSites: sites.length,
    exited: exited.concat(churned).map((s) => s.loc),
    entered: entered.map((s) => s.loc),
    monthly, ss, ranked, cumShare, grand,
  };
}
