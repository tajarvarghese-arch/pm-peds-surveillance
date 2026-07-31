// Analytics core: derivatives, percentile bands, forecast, staffing engine.
// Pure functions over {t, v} point arrays. No DOM, no fetch.

import { TIERS, ACCEL, VISIT_MIX, PED_AGES } from './config.js';

/**
 * Smallest non-zero step the index can take.
 *
 * CDC publishes ED %visits to ONE decimal place (0.6, 0.7, 0.9...). The
 * weighted index therefore moves in discrete jumps of 0.1 x (smallest weight).
 * At a summer floor near 0.66% a single 0.1pp tick in the <1yr band is a "+2.3%
 * week-over-week move" -- which is quantisation, not epidemiology. Anything at
 * or below ~2 quanta gets flagged so the UI can refuse to dress it up as trend.
 */
export function indexQuantum(mix, reported = 0.1) {
  const weights = Object.values(mix).filter((w) => w > 0);
  if (!weights.length) return reported;
  const total = weights.reduce((a, b) => a + b, 0);
  return (reported * Math.min(...weights)) / total;
}

/** First derivative: week-over-week % change. */
export function d1(points, quantum = 0) {
  const out = [];
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1].v;
    const cur = points[i].v;
    const abs = cur - prev;
    // Guard the near-zero denominator: at summer floors (0.02%) a WoW ratio
    // explodes into meaningless four-digit percentages.
    const pct = prev > 0.05 ? (abs / prev) * 100 : null;
    out.push({
      t: points[i].t,
      v: pct,
      abs,
      noisy: quantum > 0 && Math.abs(abs) <= quantum * 2 + 1e-9,
    });
  }
  return out;
}

/** Second derivative: change in the rate of change (percentage points of d1). */
export function d2(firstDeriv) {
  const out = [];
  for (let i = 1; i < firstDeriv.length; i++) {
    const a = firstDeriv[i - 1].v;
    const b = firstDeriv[i].v;
    out.push({ t: firstDeriv[i].t, v: a === null || b === null ? null : b - a });
  }
  return out;
}

export function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** Percentile rank of `value` within `points`. Returns 0-100. */
export function percentileRank(points, value) {
  const vals = points.map((p) => p.v).filter((v) => v !== null && !Number.isNaN(v));
  if (!vals.length) return null;
  const below = vals.filter((v) => v < value).length;
  return (below / vals.length) * 100;
}

/**
 * Week-of-year percentile bands across all available seasons.
 * Returns per-week-of-year {p10,p25,p50,p75,p90,n}. `n` is carried through to
 * the UI because with ~4 NSSP seasons these bands are thin and saying so
 * matters more than the band itself.
 */
export function seasonalBands(points) {
  const byWeek = new Map();
  for (const p of points) {
    const w = isoWeek(p.t);
    if (!byWeek.has(w)) byWeek.set(w, []);
    byWeek.get(w).push(p.v);
  }
  const bands = new Map();
  for (const [w, vs] of byWeek) {
    const s = [...vs].sort((a, b) => a - b);
    bands.set(w, {
      p10: quantile(s, 0.1), p25: quantile(s, 0.25), p50: quantile(s, 0.5),
      p75: quantile(s, 0.75), p90: quantile(s, 0.9), n: s.length,
    });
  }
  return bands;
}

export function isoWeek(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (target.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const fdDay = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - fdDay + 3);
  return 1 + Math.round((target - firstThursday) / (7 * 86400000));
}

export function seasonOf(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const y = d.getUTCFullYear();
  // Respiratory season runs week 27 -> week 26 of the following year.
  return isoWeek(dateStr) >= 27 ? `${y}-${String((y + 1) % 100).padStart(2, '0')}`
                                : `${y - 1}-${String(y % 100).padStart(2, '0')}`;
}

/**
 * 8-week forecast: seasonal-naive anchored on week-of-year medians, blended
 * with recent momentum, damped so the trend term decays instead of running
 * away over the horizon.
 *
 * With only ~4 seasons of NSSP history this is a planning heuristic, not a
 * calibrated model. Interval is the observed p25-p75 spread for that week of
 * year, not a fitted confidence interval -- labelled as such in the UI.
 */
export function forecast(points, horizon = 8) {
  if (points.length < 8) return [];
  const bands = seasonalBands(points);
  const last = points[points.length - 1];
  const recent = points.slice(-4);
  // average absolute weekly step over the last month
  let momentum = 0;
  for (let i = 1; i < recent.length; i++) momentum += recent[i].v - recent[i - 1].v;
  momentum /= Math.max(1, recent.length - 1);

  const out = [];
  let cursor = new Date(last.t + 'T00:00:00Z');
  let level = last.v;
  for (let h = 1; h <= horizon; h++) {
    cursor = new Date(cursor.getTime() + 7 * 86400000);
    const t = cursor.toISOString().slice(0, 10);
    const w = isoWeek(t);
    const band = bands.get(w);
    const damp = Math.pow(0.65, h - 1); // momentum decays fast
    const trendPart = level + momentum * damp * h;
    // Seasonal shape: how this week-of-year typically moves off the last
    // observed week-of-year median.
    const curBand = bands.get(isoWeek(last.t));
    let seasonPart = trendPart;
    if (band && curBand && curBand.p50 > 0) {
      seasonPart = last.v * (band.p50 / curBand.p50);
    }
    const wSeason = Math.min(0.8, 0.25 + 0.08 * h); // hand over to seasonality
    const v = Math.max(0, trendPart * (1 - wSeason) + seasonPart * wSeason);
    out.push({
      t, v,
      lo: band ? Math.max(0, Math.min(v, band.p25)) : null,
      hi: band ? Math.max(v, band.p75) : null,
      n: band ? band.n : 0,
    });
    level = v;
  }
  return out;
}

/**
 * Pediatric Pressure Index: visit-mix-weighted blend of pediatric ED %visits.
 * `rows` is the wide ed_age series; `pathogen` is e.g. 'Combined'.
 */
export function pressureIndex(rows, pathogen = 'Combined', mix = VISIT_MIX) {
  const total = Object.values(mix).reduce((a, b) => a + b, 0) || 1;
  const out = [];
  for (const r of rows) {
    let acc = 0;
    let got = 0;
    for (const age of PED_AGES) {
      const v = r[`${pathogen}|${age}`];
      if (v === undefined || v === null) continue;
      acc += +v * (mix[age] ?? 0);
      got++;
    }
    if (got === PED_AGES.length) out.push({ t: r.week, v: acc / total });
  }
  return out;
}

/**
 * Staffing recommendation.
 * Percentile tier against the series' own history, promoted one step when the
 * index is both climbing fast (d1) and accelerating (d2).
 */
export function staffing(points, quantum = 0) {
  if (points.length < 12) {
    return { tier: TIERS[0], pct: null, d1: null, d2: null, promoted: false,
             n: points.length, noisy: false, reason: 'insufficient history' };
  }
  const cur = points[points.length - 1];
  const pct = percentileRank(points, cur.v);
  const first = d1(points, quantum);
  const second = d2(first);
  const lastD1 = first[first.length - 1];
  const cd1 = lastD1?.v ?? null;
  const cd2 = second.length ? second[second.length - 1].v : null;
  const noisy = !!lastD1?.noisy;

  let idx = 0;
  for (let i = TIERS.length - 1; i >= 0; i--) {
    if (pct !== null && pct >= TIERS[i].pct) { idx = i; break; }
  }
  // Never promote on a move that is inside the reporting resolution -- that is
  // how you end up staffing 1.3x off a rounding artefact in July.
  let promoted = false;
  if (ACCEL.bumpOnAccel && !noisy && cd1 !== null && cd2 !== null
      && cd1 > ACCEL.d1Surge && cd2 > 0 && idx < TIERS.length - 1) {
    idx++;
    promoted = true;
  }
  const reason = [];
  if (pct !== null) reason.push(`${ordinal(pct)} pctile of ${points.length}wk history`);
  if (noisy) {
    reason.push('d1/d2 within reporting resolution — treated as flat');
  } else {
    if (cd1 !== null) reason.push(`d1 ${cd1 >= 0 ? '+' : ''}${cd1.toFixed(1)}%`);
    if (cd2 !== null) reason.push(`d2 ${cd2 >= 0 ? '+' : ''}${cd2.toFixed(1)}pp`);
  }
  if (promoted) reason.push('promoted on acceleration');

  return { tier: TIERS[idx], pct, d1: cd1, d2: cd2, promoted, noisy, quantum,
           n: points.length, value: cur.v, t: cur.t, reason: reason.join(' | ') };
}

export function ordinal(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '--';
  const v = Math.round(n);
  const s = ['th', 'st', 'nd', 'rd'];
  const m = v % 100;
  return v + (s[(m - 20) % 10] || s[m] || s[0]);
}

/** Pearson correlation over the overlapping dates of two point series. */
export function correlate(a, b) {
  const mapB = new Map(b.map((p) => [p.t, p.v]));
  const xs = [], ys = [];
  for (const p of a) {
    if (mapB.has(p.t)) { xs.push(p.v); ys.push(mapB.get(p.t)); }
  }
  const n = xs.length;
  if (n < 6) return { r: null, n };
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    const a1 = xs[i] - mx, b1 = ys[i] - my;
    num += a1 * b1; dx += a1 * a1; dy += b1 * b1;
  }
  const den = Math.sqrt(dx * dy);
  return { r: den === 0 ? null : num / den, n };
}

/** Index a series to its own trailing median -- makes cross-site wastewater
 *  comparable when absolute concentrations differ by lab method. */
export function indexToMedian(points) {
  const vals = points.map((p) => p.v).filter((v) => v > 0).sort((a, b) => a - b);
  const med = quantile(vals, 0.5);
  if (!med) return points.map((p) => ({ ...p, v: null }));
  return points.map((p) => ({ t: p.t, v: (p.v / med) * 100 }));
}

export function lastN(points, n) {
  return points.slice(-n);
}
