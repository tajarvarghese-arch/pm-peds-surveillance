// THE SEASONAL ENGINE — an executive report over the browser-loaded book.
//
// Where the Volumes tab is an instrument panel, this tab is the written
// analysis: what structurally drives volume, what the year-over-year number
// actually decomposes into (season timing, footprint, same-store), where the
// counter-seasonal book stands, whether case mix is drifting, and which
// service lines are worth growing.
//
// The contract is the same as everywhere else in this repository: the code is
// public, the numbers are not. Every figure below is computed at render time
// from files held in this browser's localStorage. If a sentence needs a
// number, the number is interpolated from the data — never written here.

import { panel, tile, empty } from '../ui.js';
import { line, bar, scatter, hexA, heatColor } from '../charts.js';
import {
  load, loadAcuity, loadChannel, loadLocations, loadChannelWeekly,
  loadFunnel, loadNewPatients, loadBhTele, loadSiteMaster, loadDerived, loadSiteWeekly,
  toWeekly as volWeekly,
} from '../volumes.js';
import {
  trimPartialWeek, trimPartialMonth, toMonthly, pairedYoY, seriesStats,
  phaseOf, residVolatility, waveAligned, footprint, isoWeekOf, seasonOf,
} from '../analysis.js';

const CAT_COLORS = { Seasonal: '#22d3ee', 'Non-seasonal': '#4ade80',
                     Injury: '#fbbf24', Uncategorized: '#64748b' };
const ACCENT = '#22d3ee';
const AMBER = '#fbbf24';
const RED = '#ef4444';
const GREEN = '#4ade80';
const DIM = '#7f8ea0';
const PALETTE = ['#22d3ee', '#fbbf24', '#4ade80', '#a78bfa', '#f472b6', '#f97316'];

// ICD-10 prefix → clinical grouping, for the acuity file. Clinical knowledge,
// not data: which codes were exported stays private.
const ICD_GROUPS = [
  [/^H6[56]/, 'Otitis media'],
  [/^J0[23]/, 'Pharyngitis / strep'],
  [/^J05/, 'Croup'],
  [/^J(09|1[01])/, 'Influenza'],
  [/^J1[2-8]/, 'Pneumonia'],
  [/^J4[456]/, 'Asthma'],
  [/^N39/, 'UTI'],
];
// Infection-driven service lines. This is a clinical reading of the export's own
// category names, not a coded field — the split is what separates an
// epidemiological explanation from a demand one, so it is stated openly.
const INFECTIOUS = [
  'Pharyngitis & Strep pharyngitis', 'Otitis media', 'Bacterial infections',
  'Other middle & inner ear conditions', 'Respiratory conditions', 'Viral infections',
  'Fever', 'COVID-19 diagnoses or exposure',
];
const isInfectious = (cat) => INFECTIOUS.includes(cat);

const icdGroup = (code) => (ICD_GROUPS.find(([re]) => re.test(code)) || [null, 'Other'])[1];

const fmtN = (v) => Math.round(v).toLocaleString();
const fmtPct = (v, dp = 1) => (v === null || v === undefined || Number.isNaN(v))
  ? '--' : `${v > 0 ? '+' : ''}${v.toFixed(dp)}%`;
const cls = (v, flipAt = 0) => (v === null ? '' : v < flipAt ? 's-watch' : 's-ok');
const wkLabel = (t) => new Date(t + 'T00:00:00Z')
  .toLocaleDateString('en-US', { month: 'short', day: '2-digit', timeZone: 'UTC' });

/**
 * Same-week YoY datasets: a {t,v} series split by year and aligned on ISO
 * week, prior years dashed and muted. The vertical gap between a solid line
 * and its dashed twin IS the year-over-year change.
 */
function yoyDatasets(ser, color, name, dp = 1) {
  const by = new Map();
  for (const q of ser) {
    const y = q.t.slice(0, 4);
    if (!by.has(y)) by.set(y, new Map());
    by.get(y).set(isoWeekOf(q.t), +q.v.toFixed(dp));
  }
  const wks = Array.from({ length: 52 }, (_, i) => i + 1);
  const years = [...by.keys()].sort().slice(-2);
  return {
    labels: wks.map((w) => `w${w}`),
    datasets: years.map((y, yi) => {
      const m = by.get(y);
      const prior = yi < years.length - 1;
      return { label: `${name} ${y}`, data: wks.map((w) => m.get(w) ?? null),
               borderColor: prior ? hexA(color, 0.55) : color,
               borderDash: prior ? [4, 3] : undefined,
               borderWidth: prior ? 1.4 : 2.2, backgroundColor: 'transparent' };
    }),
  };
}

export default function report(root) {
  const store = load();
  if (!store?.data?.length) {
    root.innerHTML = panel('The Seasonal Engine', 'no visit data in this browser',
      `<div style="font-size:12px;line-height:1.8">
        This report is computed entirely in your browser from the exports loaded on the
        <a href="#volumes"><strong>Volumes ▪</strong></a> tab. Nothing is uploaded anywhere.
        <div class="note" style="margin-top:8px">Load, in any order — each unlocks more of the report:
        <br>· the visits-by-type export (weekly matrix) — required
        <br>· the ICD-coded high-acuity export — acuity &amp; influenza layers
        <br>· the by-location monthly export — footprint &amp; same-store layers
        <br>· the weekly channel/metrics export (walk-in, pre-booked, new patients by week) — demand-arrival layer
        <br>· the channel-mix totals export — period context</div>
      </div>`);
    return;
  }

  /* ---- core series ------------------------------------------------------ */
  const rows = store.data;
  const { weekly: weeklyAll, trimmed } = trimPartialWeek(volWeekly(rows));
  const wkOf = (f) => {
    const w = volWeekly(rows, f);
    return trimmed ? w.filter((p) => p.t !== trimmed.t) : w;
  };
  const cats = [...new Set(rows.map((r) => r.category))].filter((c) => c !== '(all)');
  const types = [...new Set(rows.map((r) => r.type))].filter((t) => t !== '(all)');
  const lastFull = weeklyAll.at(-1)?.t;
  const stat = seriesStats(weeklyAll);
  const total = weeklyAll.reduce((a, p) => a + p.v, 0);

  const catW = new Map(cats.map((c) => [c, wkOf((r) => r.category === c)]));
  const seasonalW = catW.get('Seasonal') || [];
  const baseW = wkOf((r) => r.category === 'Non-seasonal' || r.category === 'Injury');
  const baseTotal = baseW.reduce((a, p) => a + p.v, 0);

  /* ---- growth: calendar vs wave-aligned --------------------------------- */
  const calYoY = lastFull ? pairedYoY(weeklyAll, lastFull) : null;
  const wave = waveAligned(weeklyAll, 10);
  const typeYoY = types.map((t) => {
    const w = wkOf((r) => r.type === t);
    return { t, w, size: w.reduce((a, p) => a + p.v, 0),
             ...((lastFull && pairedYoY(w, lastFull)) || {}) };
  }).filter((x) => x.prv > 0);

  /* ---- phase & volatility ----------------------------------------------- */
  const phased = types.map((t) => {
    const w = wkOf((r) => r.type === t);
    const ph = phaseOf(w);
    const vol = residVolatility(w);
    const yoy = typeYoY.find((x) => x.t === t);
    const cat = rows.find((r) => r.type === t)?.category || '(all)';
    return ph ? { t, cat, ph, vol, size: w.reduce((a, p) => a + p.v, 0),
                  yoyPct: yoy?.pct ?? null, w } : null;
  }).filter(Boolean).sort((a, b) => a.ph.phase - b.ph.phase);
  const counterSeasonal = phased.filter((x) =>
    x.ph.phase >= 30 && x.ph.phase <= 48 && x.ph.amp !== null && x.ph.amp > 1.3);

  /* ---- acuity ----------------------------------------------------------- */
  const acStore = loadAcuity();
  let acuity = null;
  if (acStore?.data?.length && weeklyAll.length) {
    const acW0 = volWeekly(acStore.data);
    const acW = trimmed ? acW0.filter((p) => p.t !== trimmed.t) : acW0;
    const totM = new Map(weeklyAll.map((p) => [p.t, p.v]));
    const rate = acW.filter((p) => totM.get(p.t) > 0)
      .map((p) => ({ t: p.t, v: (p.v / totM.get(p.t)) * 1000 }));
    // Paired weeks, then convert the summed weekly rates to window averages —
    // pairing guarantees both windows hold the same number of weeks.
    const rateYoY = lastFull && rate.length ? pairedYoY(rate, lastFull) : null;
    const rateAvg = rateYoY?.weeks
      ? { cur: rateYoY.cur / rateYoY.weeks, prv: rateYoY.prv / rateYoY.weeks } : null;
    const groups = new Map();
    for (const r of acStore.data) {
      const g = icdGroup(r.type);
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(r);
    }
    const grouped = [...groups.entries()].map(([g, rs]) => {
      const w0 = volWeekly(rs);
      const w = trimmed ? w0.filter((p) => p.t !== trimmed.t) : w0;
      return { g, w, total: w.reduce((a, p) => a + p.v, 0),
               vol: residVolatility(w), stat: seriesStats(w) };
    }).sort((a, b) => b.total - a.total);
    const flu = grouped.find((x) => x.g === 'Influenza');
    let fluSeasons = null;
    if (flu && flu.w.length > 30) {
      const by = new Map();
      for (const p of flu.w) {
        const s = seasonOf(p.t);
        const jul1 = new Date(`${s.slice(0, 4)}-07-01T00:00:00Z`);
        const wk = Math.floor((new Date(p.t + 'T00:00:00Z') - jul1) / (7 * 86400000));
        if (!by.has(s)) by.set(s, new Array(53).fill(null));
        if (wk >= 0 && wk < 53) by.get(s)[wk] = p.v;
      }
      const seasons = [...by.entries()].filter(([, arr]) => arr.some((v) => v !== null));
      if (seasons.length >= 2) {
        const peaks = seasons.map(([s, arr]) => {
          const vmax = Math.max(...arr.filter((v) => v !== null));
          return { s, arr, peakWk: arr.indexOf(vmax), peak: vmax };
        });
        fluSeasons = peaks.slice(-2);
      }
    }
    acuity = { rate, rateAvg, grouped, fluSeasons,
               total: acW.reduce((a, p) => a + p.v, 0) };
  }

  /* ---- footprint -------------------------------------------------------- */
  const locStore = loadLocations();
  let fp = null, fpTrimNote = null;
  if (locStore?.data?.length) {
    const netMonthly = toMonthly(locStore.data);
    const { monthly: goodMonths, trimmed: mTrim } = trimPartialMonth(netMonthly);
    const lastGood = goodMonths.at(-1)?.t;
    if (mTrim) fpTrimNote = mTrim.t;
    fp = footprint(locStore.data.filter((r) => r.date.slice(0, 7) <= lastGood));
  }

  const chStore = loadChannel();

  /* ---- weekly channel mix ----------------------------------------------- */
  // Roles are matched from the export's own column names, so the section works
  // whatever the portal calls them; metrics with no matching role are ignored.
  const cwStore = loadChannelWeekly();
  let ch = null;
  if (cwStore?.data?.length >= 12) {
    const metrics = cwStore.metrics || [];
    const roleOf = (re) => metrics.find((m) => re.test(m)) || null;
    const roles = {
      walk: roleOf(/walk/i), book: roleOf(/book|sched/i),
      newp: roleOf(/new/i), pphr: roleOf(/hour/i),
    };
    const S = (name) => name
      ? cwStore.data.filter((r) => r[name] !== undefined)
          .map((r) => ({ t: r.date, v: r[name] })) : null;
    const walk = S(roles.walk), book = S(roles.book);
    if (walk && book) {
      const bm = new Map(book.map((p) => [p.t, p.v]));
      const totW = walk.filter((p) => bm.has(p.t))
        .map((p) => ({ t: p.t, v: p.v + bm.get(p.t) }));
      const { weekly: totT, trimmed: chTrim } = trimPartialWeek(totW);
      const keep = new Set(totT.map((p) => p.t));
      // A partial LEADING week is the same stub problem at the other end.
      const head = totT.slice(0, 8).map((p) => p.v).sort((a, b) => a - b);
      const headMed = head[Math.floor(head.length / 2)];
      if (totT.length && totT[0].v < 0.6 * headMed) keep.delete(totT[0].t);
      const cut = (ser) => ser ? ser.filter((p) => keep.has(p.t)) : null;
      const w2 = cut(walk), b2 = cut(book), n2 = cut(S(roles.newp)), h2 = cut(S(roles.pphr));
      const t2 = cut(totW);
      const lastCh = t2.at(-1)?.t;
      const wShare = w2.map((p, i) => ({ t: p.t, v: p.v / t2[i].v * 100 }));
      const yo = (ser) => ser && lastCh ? pairedYoY(ser, lastCh) : null;
      const corrShareVol = (() => {
        const n = wShare.length;
        if (n < 20) return null;
        const xs = wShare.map((p) => p.v), ys = t2.map((p) => p.v);
        const mx = xs.reduce((a, b) => a + b) / n, my = ys.reduce((a, b) => a + b) / n;
        let s1 = 0, s2 = 0, s3 = 0;
        for (let i = 0; i < n; i++) {
          s1 += (xs[i] - mx) * (ys[i] - my); s2 += (xs[i] - mx) ** 2; s3 += (ys[i] - my) ** 2;
        }
        return s2 && s3 ? s1 / Math.sqrt(s2 * s3) : null;
      })();
      let hours = null;
      if (h2?.length === t2.length) {
        const hs = t2.map((p, i) => ({ t: p.t, v: h2[i].v > 0 ? p.v / h2[i].v : null }))
          .filter((p) => p.v !== null);
        const vals = hs.map((p) => p.v);
        hours = { swing: Math.max(...vals) / Math.min(...vals),
                  volSwing: Math.max(...t2.map((p) => p.v)) / Math.min(...t2.map((p) => p.v)),
                  yoy: yo(hs) };
      }
      ch = { roles, w2, b2, n2, h2, t2, wShare, chTrim,
             yoWalk: yo(w2), yoBook: yo(b2), yoNew: yo(n2), corrShareVol, hours,
             firstShare: wShare.slice(0, 8).reduce((a, p) => a + p.v, 0) / Math.min(8, wShare.length),
             lastShare: wShare.slice(-8).reduce((a, p) => a + p.v, 0) / Math.min(8, wShare.length) };
    }
  }

  /* ---- the control test: infection-driven lines vs everything else ------- */
  // An epidemiological cause predicts the first group falls and the second does
  // not. A demand or acquisition cause predicts both fall, because a family who
  // cannot find PM cannot bring a broken arm either.
  let epi = null;
  if (lastFull) {
    const cats = types.map((t) => {
      const w = wkOf((r) => r.type === t);
      const y = pairedYoY(w, lastFull);
      return y && y.prv > 400
        ? { cat: t, inf: isInfectious(t), pct: y.pct, v25: y.prv, v26: y.cur, chg: y.cur - y.prv }
        : null;
    }).filter(Boolean).sort((a, b) => a.pct - b.pct);
    const infW = wkOf((r) => isInfectious(r.type));
    const nonW = wkOf((r) => !isInfectious(r.type));
    const yi = pairedYoY(infW, lastFull), yn = pairedYoY(nonW, lastFull);
    if (yi && yn && cats.length) {
      epi = { cats, inf: yi, non: yn, infW, nonW,
              split: ['Jan–Feb', 'Mar–Jul'].map((label, i) => {
                const months = i === 0 ? [1, 2] : [3, 4, 5, 6, 7];
                const sub = (ser) => ser.filter((q) => months.includes(+q.t.slice(5, 7)));
                const t = pairedYoY(sub(weeklyAll), lastFull);
                const a = pairedYoY(sub(infW), lastFull);
                const b = pairedYoY(sub(nonW), lastFull);
                return t && a && b ? { label, tot: t.pct, inf: a.pct, non: b.pct } : null;
              }).filter(Boolean) };
    }
  }

  /* ---- multi-year, recovery and cohort gradient (needs site-week data) --- */
  const siteWkStore = loadSiteWeekly();
  let multi = null;
  if (siteWkStore?.data?.some((r) => /prior|after/i.test(r.cohort || ''))) {
    // Open urgent care only. The export also carries closed sites and the
    // behavioural-health / telemedicine lines; mixing them in makes a
    // same-store trend look like a decline that is really a footprint change.
    const rows = siteWkStore.data.filter((r) => /prior|after/i.test(r.cohort || ''));
    const netW = new Map();
    for (const r of rows) netW.set(r.date, (netW.get(r.date) || 0) + (r.visits || 0));
    const net = [...netW.entries()].map(([t, v]) => ({ t, v })).sort((a, b) => (a.t < b.t ? -1 : 1));
    // Trailing period is partial in this export; drop it before any comparison.
    const trimmed = net.length > 2 ? net.slice(0, -1) : net;

    // Compare identical ISO weeks in every year. Bucketing by calendar month
    // would shift the window boundary year to year (a week starting 28 July
    // spans into August), which is exactly the unequal-window bias the rest of
    // this report avoids by pairing weeks.
    const W_FROM = 2, W_TO = 29;                    // 28 weeks, the paired-week span
    const jj = new Map(), wkCount = new Map();
    for (const p2 of trimmed) {
      const w = isoWeekOf(p2.t);
      if (w < W_FROM || w > W_TO) continue;
      const y = +p2.t.slice(0, 4);
      jj.set(y, (jj.get(y) || 0) + p2.v);
      wkCount.set(y, (wkCount.get(y) || 0) + 1);
    }
    // Drop any year that does not carry the full span, so no partial year is
    // compared against a complete one.
    const full = W_TO - W_FROM + 1;
    for (const [y, n] of wkCount) if (n < full) jj.delete(y);
    const years = [...jj.keys()].sort();
    multi = { years, weeks: full, totals: years.map((y) => jj.get(y)),
      yoy: years.map((y, i) => (i ? (jj.get(y) / jj.get(years[i - 1]) - 1) * 100 : null)) };
    const yN = years.at(-1), y2 = years[years.length - 3];
    if (y2) multi.cagr2 = (Math.pow(jj.get(yN) / jj.get(y2), 0.5) - 1) * 100;

    // Rolling four-week volume against the same weeks a year earlier.
    const idx = new Map(trimmed.map((p2) => [p2.t, p2.v]));
    const roll = [];
    for (let i = 3; i < trimmed.length; i++) {
      const win = trimmed.slice(i - 3, i + 1);
      const cur = win.reduce((a, q) => a + q.v, 0);
      let prev = 0, ok = true;
      for (const q of win) {
        const d = new Date(q.t + 'T00:00:00Z');
        d.setUTCDate(d.getUTCDate() - 364);
        const v = idx.get(d.toISOString().slice(0, 10));
        if (v === undefined) { ok = false; break; }
        prev += v;
      }
      if (ok && prev > 0 && +trimmed[i].t.slice(0, 4) === yN) {
        roll.push({ t: trimmed[i].t, v: (cur / prev - 1) * 100 });
      }
    }
    multi.recovery = roll;

    // Cohort gradient — the site-maturity test for the saturation hypothesis.
    const byCo = new Map();
    for (const r of rows) {
      if (!r.cohort) continue;
      if (+r.date.slice(5, 7) > 7) continue;
      const k = r.cohort, y = +r.date.slice(0, 4);
      if (!byCo.has(k)) byCo.set(k, new Map());
      byCo.get(k).set(y, (byCo.get(k).get(y) || 0) + (r.visits || 0));
    }
    multi.cohorts = [...byCo.entries()].map(([cohort, m]) => ({
      cohort, yoy: years.map((y, i) => (i && m.get(y) && m.get(years[i - 1])
        ? (m.get(y) / m.get(years[i - 1]) - 1) * 100 : null)),
      sites: new Set(rows.filter((r) => r.cohort === cohort).map((r) => r.site)).size,
    })).sort((a, b) => a.cohort.localeCompare(b.cohort));
  }

  /* ---- operating leverage ------------------------------------------------ */
  let lev = null;
  if (ch?.h2?.length === ch?.t2?.length && ch?.t2?.length > 20) {
    const pts = ch.t2.map((p2, i) => ({ t: p2.t, v: p2.v, h: ch.h2[i].v > 0 ? p2.v / ch.h2[i].v : null }))
      .filter((q) => q.h);
    const pk = pts.reduce((a, q) => (q.v > a.v ? q : a));
    const tr = pts.reduce((a, q) => (q.v < a.v ? q : a));
    lev = { pts, peak: pk, trough: tr,
      marginal: (pk.v - tr.v) / (pk.h - tr.h),
      avg: pts.reduce((a, q) => a + q.v, 0) / pts.reduce((a, q) => a + q.h, 0) };
  }

  /* ---- headline findings (computed, then phrased) ----------------------- */
  const findings = [];
  if (wave && calYoY?.pct !== null) {
    const shift = wave.shiftWeeks;
    if (Math.abs(shift) >= 3) {
      findings.push(`<strong>The respiratory wave moved ${Math.abs(shift)} weeks
        ${shift < 0 ? 'earlier' : 'later'}</strong> (peak ${wave.prev.t.slice(5)} → ${wave.cur.t.slice(5)}),
        so calendar comparisons are distorted: the calendar window says ${fmtPct(calYoY.pct)},
        but aligned wave-to-wave the season is ${fmtPct(wave.pct)}. Plan against wave onset, not dates.`);
    } else {
      findings.push(`Season timing held (peak shift ${shift >= 0 ? '+' : ''}${shift}w), so the calendar
        YoY of <strong>${fmtPct(calYoY.pct)}</strong> is a fair read; wave-aligned it is ${fmtPct(wave.pct)}.`);
    }
  }
  if (fp?.sameStore?.pct !== null && fp?.all?.pct !== null && fp) {
    const gap = fp.all.pct - fp.sameStore.pct;
    findings.push(`<strong>Same-store ${fmtPct(fp.sameStore.pct)} vs ${fmtPct(fp.all.pct)} all-network</strong>
      (${fp.window.label}, ${fp.sameStore.n} of ${fp.nSites} sites comparable): footprint change
      ${Math.abs(gap) >= 0.5 ? `accounts for ${Math.abs(gap).toFixed(1)}pp of the headline` : 'is not material'}.
      ${fp.exited.length} site(s) exited or wound down; ${fp.entered.length} entered.`);
  }
  if (stat?.swing) {
    const baseShare = total > 0 ? baseTotal / total : null;
    findings.push(`Peak week runs <strong>${stat.swing.toFixed(2)}×</strong> the trough
      (peak ${stat.peakAt.slice(5)}, trough ${stat.troughAt.slice(5)}); the structural book
      (injury + non-seasonal) is ${baseShare !== null ? (baseShare * 100).toFixed(0) : '--'}% of volume —
      the swing is entirely the seasonal book's.`);
  }
  if (counterSeasonal.length) {
    findings.push(`A genuine counter-seasonal block exists — ${counterSeasonal.length} line(s) peaking in
      summer (${counterSeasonal.slice(0, 3).map((x) => x.t).join(', ')}${counterSeasonal.length > 3 ? '…' : ''}) —
      but check its size against the trough before treating it as a hedge.`);
  }
  if (epi) {
    findings.unshift(`<strong>The decline is epidemiological, and the control proves it.</strong>
      Infection-driven visits ${fmtPct(epi.inf.pct)} while non-infectious lines — injury, skin, allergy —
      ${epi.non.pct > 0 ? 'grew' : 'moved'} ${fmtPct(epi.non.pct)}. If families had stopped choosing PM the
      non-illness book would have fallen too.`);
  }
  if (multi?.cagr2 != null) {
    findings.push(`<strong>Measured against two years ago the business is
      ${fmtPct(multi.cagr2)} a year</strong> — ${multi.years.at(-2)} was an exceptional season, so the latest
      year reads as a return toward trend rather than a break in it.`);
  }
  if (multi?.recovery?.length) {
    const lo = multi.recovery.reduce((a, r) => (r.v < a.v ? r : a));
    const last = multi.recovery.at(-1);
    findings.push(`<strong>It has already recovered:</strong> rolling four-week volume moved from
      ${fmtPct(lo.v)} at its trough to ${fmtPct(last.v)} by ${last.t}. There is no compounding spiral.`);
  }
  if (lev) {
    findings.push(`<strong>Fixed capacity is the profit engine.</strong> Doubling volume from trough to peak
      takes only ${fmtPct((lev.peak.h / lev.trough.h - 1) * 100)} more labour hours —
      <strong>${Math.round(lev.marginal)} incremental visits per incremental hour</strong> against a
      ${lev.avg.toFixed(2)} average. The winter surge is served almost free at the margin.`);
  }
  if (ch?.yoWalk && ch?.yoBook) {
    findings.push(`<strong>The channel split of the change:</strong> walk-in ${fmtPct(ch.yoWalk.pct)} vs
      pre-booked ${fmtPct(ch.yoBook.pct)} on paired weeks${ch.yoNew ? `, new patients ${fmtPct(ch.yoNew.pct)}` : ''};
      walk-in share moved ${ch.firstShare.toFixed(1)}% → ${ch.lastShare.toFixed(1)}% over the record.
      ${ch.corrShareVol !== null ? `Walk-in share correlates ${ch.corrShareVol > 0 ? 'positively' : 'negatively'}
      (r=${ch.corrShareVol.toFixed(2)}) with volume — surge weeks skew
      ${ch.corrShareVol > 0 ? 'walk-in' : 'pre-booked'}.` : ''}`);
  }
  if (acuity?.rateAvg) {
    const drift = acuity.rateAvg.prv > 0
      ? ((acuity.rateAvg.cur / acuity.rateAvg.prv) - 1) * 100 : null;
    if (drift !== null) {
      findings.push(`High-acuity intensity is ${Math.abs(drift) < 3 ? '<strong>stable</strong>' :
        drift > 0 ? '<strong>rising</strong>' : '<strong>falling</strong>'} year over year
        (${acuity.rateAvg.prv.toFixed(0)} → ${acuity.rateAvg.cur.toFixed(0)} per 1,000 visits,
        ${fmtPct(drift)}). ${drift < -3 ? 'A falling rate while visits hold is a revenue-per-visit warning.'
        : 'Case mix is not thinning.'}`);
    }
  }

  /* ---- master-workbook datasets ----------------------------------------- */
  // Each is optional: the master workbook supplies them, single-file loads do
  // not, and every section below renders a locked state rather than throwing.
  const funnelStore = loadFunnel();
  const newPatStore = loadNewPatients();
  const bhStore     = loadBhTele();
  const siteStore   = loadSiteMaster();

  let funnel = null;
  if (funnelStore?.data?.length) {
    const rows = funnelStore.data;
    const byWeek = new Map();
    for (const r of rows) {
      if (!byWeek.has(r.date)) byWeek.set(r.date, []);
      byWeek.get(r.date).push(r);
    }
    // Weight the rate columns by pre-booked volume: a small region must not
    // swing the network average as hard as a large one.
    const wavg = (arr, k) => {
      let n = 0, d = 0;
      for (const r of arr) { if (r[k] != null && r.prebooked) { n += r[k] * r.prebooked; d += r.prebooked; } }
      return d ? (n / d) * 100 : null;
    };
    const weeks = [...byWeek.keys()].sort();
    funnel = {
      rate:   weeks.map((t) => ({ t, v: wavg(byWeek.get(t), 'bookingRate') })).filter((p) => p.v != null),
      cancel: weeks.map((t) => ({ t, v: wavg(byWeek.get(t), 'cancelled') })).filter((p) => p.v != null),
      noShow: weeks.map((t) => ({ t, v: wavg(byWeek.get(t), 'noShow') })).filter((p) => p.v != null),
      regions: [],
    };
    const last = weeks.at(-1);
    const byRegion = new Map();
    for (const r of rows) {
      if (!byRegion.has(r.region)) byRegion.set(r.region, []);
      byRegion.get(r.region).push(r);
    }
    for (const [region, rs] of byRegion) {
      const ser = rs.map((r) => ({ t: r.date, v: r.prebooked || 0 }))
        .sort((a, b) => (a.t < b.t ? -1 : 1));
      const yo = last ? pairedYoY(ser, last) : null;
      if (yo) funnel.regions.push({ region, ...yo,
        rate: wavg(rs.filter((r) => r.date.slice(0, 4) === String(yo.year)), 'bookingRate') });
    }
    funnel.regions.sort((a, b) => (a.pct ?? 0) - (b.pct ?? 0));
  }

  let bh = null;
  if (bhStore?.data?.length) {
    const rows = bhStore.data;
    const wk = (key) => {
      const b = new Map();
      for (const r of rows) {
        if (r[key] == null) continue;
        const d = new Date(r.date + 'T00:00:00Z');
        d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
        const k = d.toISOString().slice(0, 10);
        b.set(k, (b.get(k) || 0) + r[key]);
      }
      return [...b.entries()].map(([t, v]) => ({ t, v })).sort((a, b2) => (a.t < b2.t ? -1 : 1));
    };
    const trimTail = (ser) => (ser.length > 2 ? ser.slice(0, -1) : ser);   // final week is partial
    bh = { bh: trimTail(wk('bh')), tele: trimTail(wk('tele')), uc: trimTail(wk('uc')) };
    const monthIndex = (ser) => {
      const m = new Map();
      for (const p of ser) {
        const k = +p.t.slice(5, 7);
        if (!m.has(k)) m.set(k, []);
        m.get(k).push(p.v);
      }
      const avg = [...m.entries()].map(([k, vs]) => [k, vs.reduce((a, b2) => a + b2, 0) / vs.length])
        .sort((a, b2) => a[0] - b2[0]);
      const mean = avg.reduce((a, x) => a + x[1], 0) / (avg.length || 1);
      return avg.map(([k, v]) => ({ m: k, idx: mean ? Math.round(v / mean * 100) : null }));
    };
    bh.season = { bh: monthIndex(bh.bh), tele: monthIndex(bh.tele), uc: monthIndex(bh.uc) };
  }

  let acq = null;
  if (newPatStore?.data?.length && weeklyAll.length) {
    const byMonth = new Map();
    for (const p of weeklyAll) {
      const k = p.t.slice(0, 7);
      byMonth.set(k, (byMonth.get(k) || 0) + p.v);
    }
    acq = newPatStore.data.map((r) => {
      const k = r.date.slice(0, 7);
      const tot = byMonth.get(k);
      const prevK = `${+k.slice(0, 4) - 1}-${k.slice(5, 7)}`;
      const prevTot = byMonth.get(prevK);
      if (!tot || !prevTot || !r.priorYear) return null;
      const est = tot - r.newPatients, estPrev = prevTot - r.priorYear;
      return { m: k, newPct: (r.newPatients / r.priorYear - 1) * 100,
               estPct: estPrev ? (est / estPrev - 1) * 100 : null,
               share: r.newPatients / tot * 100 };
    }).filter((x) => x && x.estPct != null);
  }

  let sites = null;
  if (siteStore?.data?.length) {
    const rows = siteStore.data.filter((r) => r.lat != null && r.lon != null);
    const byMarket = new Map();
    for (const r of rows) {
      const k = r.market || 'other';
      if (!byMarket.has(k)) byMarket.set(k, []);
      byMarket.get(k).push(r);
    }
    sites = [...byMarket.entries()].map(([market, rs]) => ({
      market, n: rs.length, grew: rs.filter((r) => r.grew).length,
      med: rs.map((r) => r.yoy).sort((a, b) => a - b)[Math.floor(rs.length / 2)],
      rows: rs,
    })).sort((a, b) => b.n - a.n);
  }

  /* ---- render ----------------------------------------------------------- */
  root.innerHTML = `
    <section class="panel" style="border-color:${ACCENT}">
      <h2 style="color:${ACCENT}">THE SEASONAL ENGINE — executive report on the loaded book
        <span class="sub">computed in this browser · ${weeklyAll.length} full weeks thru ${lastFull || '--'}</span></h2>
      <div class="panel-body">
        ${trimmed ? `<div class="note gap"><strong>Partial trailing week (${trimmed.t}) excluded
          from every figure.</strong></div>` : ''}
        ${findings.length ? `<ol style="margin:4px 0 0 18px;font-size:12px;line-height:1.8">
          ${findings.map((f) => `<li style="margin-bottom:6px">${f}</li>`).join('')}</ol>`
        : '<div class="note">Not enough history yet for headline findings — load a longer export.</div>'}
      </div>
    </section>

    <div style="height:10px"></div>

    ${epi ? panel('The diagnosis — every infection-driven line fell; every other line grew',
      `${epi.cats.length} service lines, ${epi.inf.weeks} paired weeks`, `
      <div class="chart-wrap tall"><canvas id="r-control"></canvas></div>
      <div class="note"><strong>The control test.</strong> Infection-driven lines total
      ${fmtPct(epi.inf.pct)} (${fmtN(epi.inf.cur - epi.inf.prv)} visits); everything else totals
      ${fmtPct(epi.non.pct)} (${fmtN(epi.non.cur - epi.non.prv)}). A demand or acquisition cause would take
      both down together — a family who cannot find PM cannot bring a broken arm either. This separation is
      what makes the cause epidemiological rather than commercial.</div>
      <div class="grid g2" style="margin-top:10px">
        <div>
          <div class="chart-wrap"><canvas id="r-infyoy"></canvas></div>
          <div class="note">Infection-driven volume, same weeks year over year.</div>
        </div>
        <div>
          <div class="chart-wrap"><canvas id="r-noninf"></canvas></div>
          <div class="note">The non-infectious book over the same weeks — the control group.</div>
        </div>
      </div>
      ${epi.split.length ? `<table class="dt" style="margin-top:8px">
        <thead><tr><th>Period</th><th>Total</th><th>Infection-driven</th><th>Non-infectious</th></tr></thead>
        <tbody>${epi.split.map((r) => `<tr><td>${r.label}</td>
          <td class="num ${cls(r.tot)}">${fmtPct(r.tot)}</td>
          <td class="num ${cls(r.inf)}">${fmtPct(r.inf)}</td>
          <td class="num ${cls(r.non)}">${fmtPct(r.non)}</td></tr>`).join('')}</tbody></table>
        <div class="note">The wave months carry the damage; the non-infectious book holds in both halves.</div>` : ''}`)
    : ''}

    <div style="height:10px"></div>

    ${multi ? panel('Context — this year against the last four',
      `${multi.years[0]}–${multi.years.at(-1)} · identical ${multi.weeks}-week window each year`, `
      <div class="grid g2">
        <div>
          <div class="chart-wrap"><canvas id="r-multi"></canvas></div>
          <div class="note">Year-over-year growth is volatile around a trend, not the smooth deceleration a
          saturating market produces.${multi.cagr2 != null ? ` Against two years ago:
          <strong>${fmtPct(multi.cagr2)} a year</strong>.` : ''}</div>
        </div>
        <div>
          <div class="chart-wrap"><canvas id="r-recovery"></canvas></div>
          <div class="note">Rolling four-week volume against the same weeks a year earlier. A decline that
          closes through the year is a passing season; one that widens is a business problem.</div>
        </div>
      </div>`) : ''}

    <div style="height:10px"></div>

    ${multi?.cohorts?.length ? panel('Alternatives tested — is the market saturating?',
      'site-maturity gradient, PM\'s own cohort classification', `
      <div class="chart-wrap"><canvas id="r-cohort"></canvas></div>
      <div class="note"><strong>Saturation predicts the oldest markets falling hardest</strong>, because those
      are where PM has already met most families. A flat gradient across cohorts refutes it: newer sites are
      still ramping into unpenetrated markets and should grow regardless of conditions. Read alongside the
      control test above — saturation also has no mechanism that would spare injury and skin visits while
      removing strep and pneumonia.</div>`) : ''}

    <div style="height:10px"></div>

    ${lev ? panel('The engine — fixed capacity is why the peak is profitable',
      `${lev.pts.length} weeks · implied hours = visits ÷ patients-per-hour`, `
      <div class="chart-wrap tall"><canvas id="r-leverage"></canvas></div>
      <div class="note">Going from the trough week to the peak — <strong>${fmtN(lev.peak.v - lev.trough.v)}
      more visits</strong> — took only <strong>${fmtN(lev.peak.h - lev.trough.h)} more hours</strong>:
      <strong>${Math.round(lev.marginal)} incremental visits per incremental hour</strong> against a network
      average of ${lev.avg.toFixed(2)}. A cost base that scaled with demand would trace a rising diagonal;
      this is a horizontal band. Incremental surge visits carry almost no labour cost, which is where the
      margin of the year is made — and why holding hours through a soft season is defensible rather than
      wasteful.</div>`) : ''}

    <div style="height:10px"></div>

    ${panel('Layer 1 · The seasonal engine',
      'weekly volume by seasonality group — the establishing shot', `
      <div class="chart-wrap tall"><canvas id="r-stack"></canvas></div>
      <div class="grid g4" style="margin-top:10px">
        ${tile('Peak week', stat ? fmtN(stat.max) : '--', stat ? `wk of ${stat.peakAt}` : '')}
        ${tile('Trough week', stat ? fmtN(stat.min) : '--', stat ? `wk of ${stat.troughAt}` : '')}
        ${tile('Amplitude', stat?.swing ? `${stat.swing.toFixed(2)}×` : '--',
          'staffed-to-peak ⇒ idle capacity at the trough')}
        ${tile('Structural base', total > 0 ? `${((baseTotal / total) * 100).toFixed(0)}%` : '--',
          'injury + non-seasonal share of all visits')}
      </div>`)}

    <div style="height:10px"></div>

    ${panel('Layer 2 · Every line has a season',
      'week-of-year profile per service line, each row normalized to its own peak, sorted by phase', `
      <div class="scroll-x">${phaseHeatmap(phased)}</div>
      <div class="note">Rows at the top peak in winter; rows at the bottom are the summer book.
        ${counterSeasonal.length ? `Counter-seasonal block: <strong>${counterSeasonal
          .map((x) => `${x.t} (${x.ph.amp ? x.ph.amp.toFixed(1) : '--'}×)`).join(' · ')}</strong>.`
        : 'No strongly counter-seasonal line detected.'}
        Note: a line's <em>label</em> ("Seasonal" vs "Non-seasonal") is the export's taxonomy;
        the row's actual phase is what this chart measures.</div>`)}

    <div style="height:10px"></div>

    ${panel('Layer 3 · Growth, decomposed',
      'calendar YoY vs wave-aligned YoY — and which lines the change came from', `
      <div class="grid g3" style="margin-bottom:10px">
        ${tile('Calendar window', calYoY ? fmtPct(calYoY.pct) : '--',
          calYoY ? `${calYoY.weeks} paired weeks, ${calYoY.year} vs ${calYoY.year - 1}` : '',
          calYoY ? cls(calYoY.pct) : '')}
        ${tile('Wave-aligned', wave ? fmtPct(wave.pct) : '--',
          wave ? `each season summed peak→peak+${wave.span}w` : 'needs 2 full waves', wave ? cls(wave.pct) : '')}
        ${tile('Peak shift', wave ? `${wave.shiftWeeks > 0 ? '+' : ''}${wave.shiftWeeks}w` : '--',
          wave ? `peak height ${fmtPct(wave.peakPct)}` : '')}
      </div>
      <div class="chart-wrap tall"><canvas id="r-wf"></canvas></div>
      <div class="note">Waterfall of the calendar-window change by service line (smallest movers folded).
      When the declines concentrate in respiratory-adjacent lines and the wave shifted, much of the red
      is timing, not demand. The wave-aligned tile above is the correction.</div>`)}

    <div style="height:10px"></div>

    ${acuity ? panel('Layer 4 · Acuity',
      'high-acuity diagnoses per 1,000 visits — a directional index, not a prevalence rate', `
      <div class="grid g2">
        <div>
          <div class="chart-wrap"><canvas id="r-rate"></canvas></div>
          <div class="note">Aligned by ISO week, one line per year — the gap between solid and dashed
          is the YoY change. The numerator counts coded diagnoses (any position); the denominator counts
          visits by primary type, so trend it, don't quote it as a rate.${acuity.rateAvg ? ` Window averages: ${acuity.rateAvg.prv.toFixed(0)} →
          ${acuity.rateAvg.cur.toFixed(0)} per 1,000.` : ''}</div>
        </div>
        <div>
          ${acuity.fluSeasons ? `<div class="chart-wrap"><canvas id="r-flu"></canvas></div>
          <div class="note">Influenza codes by season-week (Jul→Jun). Peak
          ${acuity.fluSeasons[0].s}: wk ${acuity.fluSeasons[0].peakWk} ·
          ${acuity.fluSeasons[1].s}: wk ${acuity.fluSeasons[1].peakWk} —
          a ${Math.abs(acuity.fluSeasons[1].peakWk - acuity.fluSeasons[0].peakWk)}-week
          ${acuity.fluSeasons[1].peakWk < acuity.fluSeasons[0].peakWk ? 'earlier' : 'later'} wave,
          peaks ${fmtN(acuity.fluSeasons[0].peak)} vs ${fmtN(acuity.fluSeasons[1].peak)}.</div>`
          : empty('influenza codes (J09–J11) not found in the acuity file')}
        </div>
      </div>
      <div class="scroll-y" style="margin-top:8px">${acuityTable(acuity)}</div>`)
    : panel('Layer 4 · Acuity', 'locked',
        empty('load the ICD-coded high-acuity export on the Volumes tab to unlock'))}

    <div style="height:10px"></div>

    ${panel('Layer 5 · Growth vs volatility',
      'YoY change vs deseasonalized week-to-week volatility · bubble = volume', `
      <div class="chart-wrap tall"><canvas id="r-quad"></canvas></div>
      <div class="note">Top-left is the business to grow: large, growing, forecastable. Bottom-right
      breaks staffing models. Volatility is measured against each line's own 5-week centered average,
      so seasonality itself does not count. Seasonal lines' YoY inherits any wave-timing distortion
      from Layer 3.</div>`)}

    <div style="height:10px"></div>

    ${fp ? panel('Layer 7 · The footprint',
      `same-store vs network, ${fp.window.label} both years · ${fp.nSites} sites`, `
      ${fpTrimNote ? `<div class="note gap"><strong>Partial trailing month (${fpTrimNote})
        excluded.</strong></div>` : ''}
      <div class="grid g4" style="margin-bottom:10px">
        ${tile('All-network', fmtPct(fp.all.pct), `${fmtN(fp.all.prv)} → ${fmtN(fp.all.cur)}`, cls(fp.all.pct))}
        ${tile('Same-store', fmtPct(fp.sameStore.pct), `${fp.sameStore.n} comparable sites`, cls(fp.sameStore.pct))}
        ${tile('Exited / wound down', String(fp.exited.length),
          fp.exited.slice(0, 3).join(', ') + (fp.exited.length > 3 ? '…' : ''))}
        ${tile('Entered', String(fp.entered.length), fp.entered.join(', ') || '—')}
      </div>
      <div class="grid g2" style="margin-bottom:10px">
        <div>
          <div class="chart-wrap"><canvas id="r-fpmo"></canvas></div>
          <div class="note">Month-by-month YoY, all-network vs same-store. Months where same-store
          runs above all-network are months the footprint, not the demand, drove the gap.</div>
        </div>
        <div>
          <div class="chart-wrap"><canvas id="r-bridge"></canvas></div>
          <div class="note">The bridge reconciles exactly: same-store change + exited + entered =
          the all-network change.</div>
        </div>
      </div>
      <div class="grid g2">
        <div>
          <div class="chart-wrap"><canvas id="r-sites"></canvas></div>
          <div class="note">Each dot is a comparable site: last year's window volume vs YoY.
          A broad shallow decline reads very differently from a few collapsing sites — and a new
          site opening next to a "declining" one is transfer, not lost demand.</div>
        </div>
        <div>
          <div class="chart-wrap"><canvas id="r-pareto"></canvas></div>
          <div class="note">All sites ranked by volume. Top 10 hold
          <strong>${fp.cumShare[9] ? (fp.cumShare[9] * 100).toFixed(0) : '--'}%</strong>, top 25 hold
          <strong>${fp.cumShare[24] ? (fp.cumShare[24] * 100).toFixed(0) : '--'}%</strong> — the flatter
          this curve, the less any single site matters.
          ${(() => { const amps = fp.ss.map((s) => s.amp).filter((a) => a);
            if (amps.length < 8) return '';
            const so = [...amps].sort((a, b) => a - b);
            const q = (f) => so[Math.floor(f * (so.length - 1))].toFixed(2);
            return `Winter amplitude (Dec ÷ summer avg) spans ${q(0.1)}×–${q(0.9)}× across sites
            (median ${q(0.5)}×): surge staffing is a per-site tier, not one policy.`; })()}</div>
        </div>
      </div>`)
    : panel('Layer 7 · The footprint', 'locked',
        empty('load the by-location monthly export on the Volumes tab to unlock same-store analysis'))}

    <div style="height:10px"></div>

    ${ch ? panel('Layer 6 · How demand arrives, week by week',
      `${ch.t2.length} weeks · roles matched from the export's own column names`, `
      ${ch.chTrim ? `<div class="note gap"><strong>Partial trailing week (${ch.chTrim.t})
        excluded.</strong></div>` : ''}
      <div class="grid g4" style="margin-bottom:10px">
        ${tile('Walk-in YoY', ch.yoWalk ? fmtPct(ch.yoWalk.pct) : '--',
          ch.yoWalk ? `${ch.yoWalk.weeks} paired weeks` : '', ch.yoWalk ? cls(ch.yoWalk.pct) : '')}
        ${tile('Pre-booked YoY', ch.yoBook ? fmtPct(ch.yoBook.pct) : '--',
          ch.yoBook ? `${ch.yoBook.weeks} paired weeks` : '', ch.yoBook ? cls(ch.yoBook.pct) : '')}
        ${tile('Walk-in share drift', `${ch.firstShare.toFixed(1)}% → ${ch.lastShare.toFixed(1)}%`,
          'first 8 weeks vs last 8')}
        ${ch.hours ? tile('Hours flex vs volume', `${ch.hours.swing.toFixed(2)}× / ${ch.hours.volSwing.toFixed(2)}×`,
          'implied operating hours vs visit swing') : tile('New patients YoY',
          ch.yoNew ? fmtPct(ch.yoNew.pct) : '--', '', ch.yoNew ? cls(ch.yoNew.pct) : '')}
      </div>
      ${ch.h2?.length ? `<div class="chart-wrap short" style="margin-bottom:6px"><canvas id="r-chpphr"></canvas></div>
      <div class="note" style="margin-bottom:10px">${ch.roles.pphr}, aligned by ISO week — solid vs
      dashed is the year-over-year productivity gap${ch.hours ? `; implied hours flex only
      ${ch.hours.swing.toFixed(2)}× against the volume swing` : ''}.</div>` : ''}
      <div class="grid g2">
        <div>
          <div class="chart-wrap"><canvas id="r-chmix"></canvas></div>
          <div class="note">Weekly volume by booking channel. Where the decline concentrates —
          walk-in door or scheduled book — is a different problem with a different owner.</div>
        </div>
        <div>
          <div class="chart-wrap"><canvas id="r-chshare"></canvas></div>
          <div class="note">Shares aligned by ISO week, one line per year — the vertical gap between a
          solid line and its dashed prior-year twin IS the year-over-year change.
          ${ch.corrShareVol !== null ? `Walk-in share vs volume: r = ${ch.corrShareVol.toFixed(2)} —
          surge weeks skew ${ch.corrShareVol > 0 ? 'walk-in, so peak load is unschedulable' :
          'pre-booked: winter demand books ahead, and scheduling amplifies rather than absorbs the peak'}.` : ''}
          ${ch.hours ? ` Implied hours swing ${ch.hours.swing.toFixed(2)}× against a
          ${ch.hours.volSwing.toFixed(2)}× volume swing${ch.hours.yoy?.pct != null ?
          `; hours ${fmtPct(ch.hours.yoy.pct)} YoY` : ''} — throughput, not capacity, does the flexing.` : ''}</div>
        </div>
      </div>`)
    : chStore?.pairs?.length ? panel('Layer 6 · How demand arrives', 'period totals — no time dimension', `
      <div class="grid g4">${chStore.pairs.slice(0, 8).map((p) => tile(p.label,
        p.value <= 1.5 ? `${(p.value * 100).toFixed(1)}%` : fmtN(p.value), '')).join('')}</div>
      <div class="note">A totals snapshot cannot be joined to weeks. Re-export the same visual with the
      week dimension on rows and load it on the Volumes tab — the weekly channel analysis unlocks
      automatically.</div>`) : ''}

    ${funnel ? panel('Booking funnel by region',
      `${funnel.rate.length} weeks · rates weighted by pre-booked volume`, `
      <div class="grid g2">
        <div>
          <div class="chart-wrap"><canvas id="r-funnel"></canvas></div>
          <div class="note">Booking rate, cancellations and no-shows as same-week year-over-year overlays
          (solid = current year, dashed = prior). If the booking rate falls while the keep-rates hold or
          improve, the loss is upstream of the booking — not a scheduling-operations problem.</div>
        </div>
        <div>
          <div class="scroll-y"><table class="dt">
            <thead><tr><th>Region</th><th>Pre-booked YoY</th><th>Booking rate</th></tr></thead>
            <tbody>${funnel.regions.map((r) => `<tr>
              <td>${r.region.length > 26 ? r.region.slice(0, 25) + '…' : r.region}</td>
              <td class="num ${r.pct < 0 ? 's-watch' : 's-ok'}">${fmtPct(r.pct)}</td>
              <td class="num" style="color:#7f8ea0">${r.rate != null ? r.rate.toFixed(1) + '%' : '--'}</td>
            </tr>`).join('')}</tbody>
          </table></div>
          <div class="note">Ranked worst to best on paired weeks. A decline that is universal across regions
          points at demand or seasonality; one concentrated in a few markets points at something local.</div>
        </div>
      </div>`) : ''}

    <div style="height:10px"></div>

    ${bh ? panel('Behavioral health & telehealth', 'the two service lines outside urgent care', `
      <div class="grid g2">
        <div>
          <div class="chart-wrap"><canvas id="r-bhtele"></canvas></div>
          <div class="note">Weekly visits. These lines move for different reasons than urgent care and are
          worth watching separately.</div>
        </div>
        <div>
          <div class="chart-wrap"><canvas id="r-bhseason"></canvas></div>
          <div class="note">Each line indexed to its own average month (100 = its own mean). Telehealth
          typically runs <em>more</em> seasonal than urgent care — a respiratory triage channel, so it
          amplifies the winter swing rather than diversifying it. Behavioral health follows its own ramp,
          which with a short record cannot yet be separated from seasonality.</div>
        </div>
      </div>`) : ''}

    <div style="height:10px"></div>

    ${acq?.length ? panel('Acquisition: new vs established', 'monthly YoY, new patients against the returning book', `
      <div class="chart-wrap"><canvas id="r-acq"></canvas></div>
      <div class="note">Established = total visits minus new patients. Urgent care acquires families at the
      moment of acute illness, so in a soft infectious season new-patient counts fall faster than repeat
      visits — a gap between these two bars is expected, and only a <em>persistent</em> one after illness
      normalises indicates an acquisition problem.</div>`) : ''}

    <div style="height:10px"></div>

    ${sites ? panel('Sites by market', `${sites.reduce((a, m) => a + m.n, 0)} same-store sites`, `
      <div class="chart-wrap tall"><canvas id="r-sitemap"></canvas></div>
      <div class="note">Each point is a site at its own coordinates; filled = grew year over year, hollow =
      declined, size ∝ 2025 volume. Markets:
      ${sites.map((m) => `<strong>${m.market}</strong> ${m.grew}/${m.n} grew (median ${fmtPct(m.med)})`).join(' · ')}.
      Coordinates are city-level approximations for orientation, not address data.</div>`) : ''}

    <div style="height:10px"></div>

    ${panel('What this data cannot tell you', 'read before quoting numbers upstream', `
      <ul style="margin:0 0 0 18px;font-size:11.5px;line-height:1.9;color:${DIM}">
        <li>The acuity numerator and the visit denominator count different things under different
          filters — the per-1,000 figure is an index, not a rate.</li>
        <li>Site geography and market groupings are not in the data; any regional reading is inference
          from site names.</li>
        <li>No revenue, cost or payer mix: "idle capacity" and "acuity" are volume statements only.</li>
        <li>Channel mix exists only as a period total; weekly channel behaviour is unobservable here.</li>
        <li>A first season truncated by the export window cannot be compared whole — wave alignment is
          the best available correction, not a full fix.</li>
      </ul>`)}
  `;

  mountCharts({ weeklyAll, catW, cats, phased, typeYoY, calYoY, acuity, fp, ch, funnel, bh, acq, sites, epi, multi, lev });
}

/* ======================= sub-renderers =================================== */

function phaseHeatmap(phased) {
  if (!phased.length) return empty('not enough history per line for a phase profile');
  const cols = 53;
  const rowsHtml = phased.map((x) => {
    const prof = new Array(cols).fill(null);
    const acc = new Map();
    for (const p of x.w) {
      const w = isoWeekOf(p.t) - 1;
      if (!acc.has(w)) acc.set(w, []);
      acc.get(w).push(p.v);
    }
    let max = 0;
    for (const [w, vs] of acc) {
      prof[w] = vs.reduce((a, b) => a + b, 0) / vs.length;
      if (prof[w] > max) max = prof[w];
    }
    const cells = prof.map((v, i) => `<div class="heat-cell"
      style="background:${v === null ? '#0b0f14' : heatColor(v / max)}"
      title="${x.t} · wk ${i + 1}${v === null ? '' : ` · ${Math.round((v / max) * 100)}% of own peak`}"></div>`).join('');
    const name = x.t.length > 26 ? x.t.slice(0, 25) + '…' : x.t;
    return `<div class="heat-row-label"><span style="color:${CAT_COLORS[x.cat] || DIM}">■</span>&nbsp;${name}</div>
      <div class="heat" style="grid-template-columns:repeat(${cols},1fr)">${cells}</div>`;
  }).join('');
  return `<div style="display:grid;grid-template-columns:190px 1fr;gap:2px 0;min-width:640px">
    ${rowsHtml}
    <div></div>
    <div style="display:flex;justify-content:space-between;font-size:9px;color:${DIM};padding-top:2px">
      <span>Jan</span><span>Apr</span><span>Jul</span><span>Oct</span><span>Dec</span></div>
  </div>`;
}

function acuityTable(acuity) {
  return `<table class="dt">
    <thead><tr><th>Clinical grouping</th><th>Diagnoses</th><th>Share</th><th>Volatility</th><th>Peak wk</th></tr></thead>
    <tbody>${acuity.grouped.map((g) => `<tr>
      <td>${g.g}</td>
      <td class="num">${fmtN(g.total)}</td>
      <td class="num">${acuity.total > 0 ? ((g.total / acuity.total) * 100).toFixed(1) : '--'}%</td>
      <td class="num ${g.vol !== null && g.vol > 40 ? 's-elevated' : ''}">${g.vol !== null ? g.vol.toFixed(0) + '%' : '--'}</td>
      <td class="num" style="color:${DIM}">${g.stat ? g.stat.peakAt.slice(5) : '--'}</td>
    </tr>`).join('')}</tbody>
  </table>
  <div class="note">High volatility marks the epidemic lines (influenza); low marks the structural
  constants (otitis, UTI) that arrive on schedule every year.</div>`;
}

/* ======================= charts ========================================== */

function mountCharts({ weeklyAll, catW, cats, phased, typeYoY, calYoY, acuity, fp, ch, funnel, bh, acq, sites, epi, multi, lev }) {
  const weeks = weeklyAll.map((p) => p.t);
  const labels = weeks.map(wkLabel);

  // L1: stacked area by category
  const stackC = document.getElementById('r-stack');
  if (stackC && cats.length) {
    const order = ['Seasonal', 'Injury', 'Non-seasonal', 'Uncategorized']
      .filter((c) => cats.includes(c))
      .concat(cats.filter((c) => !CAT_COLORS[c]));
    line(stackC, {
      labels,
      datasets: order.map((c) => {
        const m = new Map((catW.get(c) || []).map((p) => [p.t, p.v]));
        const col = CAT_COLORS[c] || DIM;
        return { label: c, data: weeks.map((w) => m.get(w) ?? 0),
                 borderColor: col, backgroundColor: hexA(col, 0.35),
                 fill: true, stack: 's', pointRadius: 0, borderWidth: 1.2 };
      }),
      options: { scales: { y: { stacked: true }, x: { stacked: true } } },
    });
  }

  // L3: waterfall by service line (floating bars)
  const wfC = document.getElementById('r-wf');
  if (wfC && calYoY && typeYoY.length) {
    const movers = typeYoY.map((x) => ({ t: x.t, d: (x.cur || 0) - (x.prv || 0) }));
    const big = movers.filter((m) => Math.abs(m.d) >= Math.max(200, calYoY.prv * 0.001));
    const foldSum = movers.filter((m) => !big.includes(m)).reduce((a, m) => a + m.d, 0);
    big.sort((a, b) => a.d - b.d);
    const steps = [...big];
    if (movers.length > big.length) steps.push({ t: `${movers.length - big.length} smaller lines`, d: foldSum });
    const rows = [{ t: `${calYoY.year - 1} window`, lo: 0, hi: calYoY.prv, total: true }];
    let cum = calYoY.prv;
    for (const s of steps) {
      rows.push({ t: s.t, lo: Math.min(cum, cum + s.d), hi: Math.max(cum, cum + s.d), neg: s.d < 0 });
      cum += s.d;
    }
    rows.push({ t: `${calYoY.year} window`, lo: 0, hi: calYoY.cur, total: true });
    const lows = rows.filter((r) => !r.total).map((r) => r.lo);
    const floor = Math.max(0, Math.min(...lows, calYoY.cur, calYoY.prv) * 0.97);
    bar(wfC, {
      labels: rows.map((r) => (r.t.length > 26 ? r.t.slice(0, 25) + '…' : r.t)),
      datasets: [{
        label: 'visits',
        data: rows.map((r) => [Math.max(r.lo, r.total ? floor : r.lo), r.hi]),
        backgroundColor: rows.map((r) => r.total ? hexA(DIM, 0.5) : r.neg ? hexA(RED, 0.8) : hexA(ACCENT, 0.8)),
      }],
      options: { indexAxis: 'y', plugins: { legend: { display: false } },
        scales: { x: { min: floor } } },
    });
  }

  // L4: acuity rate + flu overlay
  if (acuity) {
    const rateC = document.getElementById('r-rate');
    if (rateC && acuity.rate.length) {
      line(rateC, yoyDatasets(acuity.rate, AMBER, 'per 1,000'));
    }
    const fluC = document.getElementById('r-flu');
    if (fluC && acuity.fluSeasons) {
      const [a, b] = acuity.fluSeasons;
      line(fluC, {
        labels: Array.from({ length: 53 }, (_, i) => `w${i + 1}`),
        datasets: [
          { label: a.s, data: a.arr, borderColor: DIM, borderDash: [4, 3], backgroundColor: 'transparent' },
          { label: b.s, data: b.arr, borderColor: ACCENT, backgroundColor: hexA(ACCENT, 0.08), fill: true },
        ],
        options: { scales: { x: { ticks: { callback: (v, i) =>
          [0, 9, 18, 26, 35, 44].includes(i) ? ['Jul', 'Sep', 'Nov', 'Jan', 'Mar', 'May'][[0, 9, 18, 26, 35, 44].indexOf(i)] : '' } } } },
      });
    }
  }

  // L5: quadrant
  const quadC = document.getElementById('r-quad');
  if (quadC && phased.length) {
    const groups = [...new Set(phased.map((x) => x.cat))];
    const maxSize = Math.max(...phased.map((x) => x.size));
    scatter(quadC, {
      datasets: groups.map((g) => ({
        label: g,
        data: phased.filter((x) => x.cat === g && x.vol !== null && x.yoyPct !== null)
          .map((x) => ({ x: +x.vol.toFixed(1), y: +Math.max(-60, Math.min(60, x.yoyPct)).toFixed(1), _t: x.t, _n: x.size })),
        backgroundColor: hexA(CAT_COLORS[g] || DIM, 0.75),
        pointRadius: (ctx2) => 4 + 14 * Math.sqrt((ctx2.raw?._n || 0) / maxSize),
        pointHoverRadius: (ctx2) => 5 + 14 * Math.sqrt((ctx2.raw?._n || 0) / maxSize),
      })),
      options: { plugins: { tooltip: { callbacks: {
        title: (items) => items[0]?.raw?._t || '',
        label: (item) => ` YoY ${fmtPct(item.raw.y)} · volatility ${item.raw.x}% · ${fmtN(item.raw._n)} visits`,
      } } },
      scales: { x: { title: { display: true, text: 'weekly volatility (deseasonalized) %',
                              color: DIM, font: { family: 'monospace', size: 10 } } },
                y: { title: { display: true, text: 'YoY %',
                              color: DIM, font: { family: 'monospace', size: 10 } } } } },
    });
  }

  // L6: weekly channel mix
  if (ch) {
    const mixC = document.getElementById('r-chmix');
    if (mixC) {
      line(mixC, {
        labels: ch.t2.map((p) => wkLabel(p.t)),
        datasets: [
          { label: ch.roles.book, data: ch.b2.map((p) => p.v), borderColor: ACCENT,
            backgroundColor: hexA(ACCENT, 0.35), fill: true, stack: 's', pointRadius: 0, borderWidth: 1.2 },
          { label: ch.roles.walk, data: ch.w2.map((p) => p.v), borderColor: AMBER,
            backgroundColor: hexA(AMBER, 0.35), fill: true, stack: 's', pointRadius: 0, borderWidth: 1.2 },
        ],
        options: { scales: { y: { stacked: true }, x: { stacked: true } } },
      });
    }
    const ppC = document.getElementById('r-chpphr');
    if (ppC && ch.h2?.length) {
      line(ppC, yoyDatasets(ch.h2, '#a78bfa', 'patients/hr', 2));
    }
    const shC = document.getElementById('r-chshare');
    if (shC) {
      // Same-week YoY overlay: x is ISO week-of-year, one dataset per metric
      // per year, prior year dashed. The vertical gap is the YoY change.
      const share = (num2) => num2.map((p, i) => ({ t: p.t, v: p.v / ch.t2[i].v * 100 }));
      const seriesByYear = (ser) => {
        const by = new Map();
        for (const p of ser) {
          const y = p.t.slice(0, 4);
          if (!by.has(y)) by.set(y, new Map());
          by.get(y).set(isoWeekOf(p.t), +p.v.toFixed(1));
        }
        return by;
      };
      const metrics = [['walk-in', share(ch.w2), AMBER]];
      if (ch.n2?.length === ch.t2.length) metrics.push(['new-patient', share(ch.n2), GREEN]);
      const wks = Array.from({ length: 52 }, (_, i) => i + 1);
      const years = [...new Set(ch.t2.map((p) => p.t.slice(0, 4)))].sort().slice(-2);
      const ds = [];
      for (const [name, ser, col] of metrics) {
        const by = seriesByYear(ser);
        years.forEach((y, yi) => {
          const m = by.get(y);
          if (!m) return;
          const prior = yi < years.length - 1;
          ds.push({ label: `${name} ${y}`, data: wks.map((w) => m.get(w) ?? null),
                    borderColor: prior ? hexA(col, 0.55) : col,
                    borderDash: prior ? [4, 3] : undefined,
                    borderWidth: prior ? 1.4 : 2.2, backgroundColor: 'transparent' });
        });
      }
      line(shC, { labels: wks.map((w) => `w${w}`), datasets: ds });
    }
  }

  // The diagnosis: control test + the two YoY panels
  if (epi) {
    const c = document.getElementById('r-control');
    if (c) {
      bar(c, {
        labels: epi.cats.map((r) => (r.cat.length > 28 ? r.cat.slice(0, 27) + '…' : r.cat)),
        datasets: [{ label: 'YoY %', data: epi.cats.map((r) => +r.pct.toFixed(1)),
          backgroundColor: epi.cats.map((r) => hexA(r.inf ? RED : GREEN, 0.85)) }],
        options: { indexAxis: 'y', plugins: { legend: { display: false }, tooltip: { callbacks: {
          label: (it) => {
            const r = epi.cats[it.dataIndex];
            return ` ${r.inf ? 'infection-driven' : 'non-infectious'} · ${fmtPct(r.pct)} · ${fmtN(r.chg)} visits`;
          } } } } },
      });
    }
    const a = document.getElementById('r-infyoy');
    if (a) line(a, yoyDatasets(epi.infW, RED, 'infection-driven'));
    const b = document.getElementById('r-noninf');
    if (b) line(b, yoyDatasets(epi.nonW, GREEN, 'non-infectious'));
  }

  if (multi) {
    const c = document.getElementById('r-multi');
    if (c) {
      bar(c, { labels: multi.years.map(String), datasets: [{ label: `visits, weeks ${2}–${29}`,
        data: multi.totals,
        backgroundColor: multi.years.map((y, i) => hexA(i === multi.years.length - 1 ? ACCENT : DIM,
          i === multi.years.length - 1 ? 0.9 : 0.45)) }],
        options: { plugins: { legend: { display: false }, tooltip: { callbacks: {
          afterLabel: (it) => (multi.yoy[it.dataIndex] != null
            ? `YoY ${fmtPct(multi.yoy[it.dataIndex])}` : '') } } } } });
    }
    const r = document.getElementById('r-recovery');
    if (r && multi.recovery.length) {
      line(r, { labels: multi.recovery.map((q) => wkLabel(q.t)),
        datasets: [{ label: 'rolling 4-week YoY %', data: multi.recovery.map((q) => +q.v.toFixed(1)),
          borderColor: ACCENT, backgroundColor: hexA(ACCENT, 0.10), fill: true }],
        options: { plugins: { legend: { display: false } } } });
    }
    const co = document.getElementById('r-cohort');
    if (co && multi.cohorts?.length) {
      const yrs = multi.years.slice(1);
      bar(co, { labels: yrs.map(String),
        datasets: multi.cohorts.map((c2, i) => ({ label: `${c2.cohort} (${c2.sites})`,
          data: yrs.map((y) => { const k = multi.years.indexOf(y); return c2.yoy[k] != null ? +c2.yoy[k].toFixed(1) : null; }),
          backgroundColor: hexA(PALETTE[i % PALETTE.length], 0.85) })) });
    }
  }

  if (lev) {
    const c = document.getElementById('r-leverage');
    if (c) {
      scatter(c, { datasets: [{ label: 'week',
        data: lev.pts.map((q) => ({ x: q.v, y: q.h, _t: q.t })),
        backgroundColor: hexA(ACCENT, 0.65), pointRadius: 4, pointHoverRadius: 6 }],
        options: { plugins: { legend: { display: false }, tooltip: { callbacks: {
          title: (it) => 'Week of ' + (it[0]?.raw?._t || ''),
          label: (it) => ` ${fmtN(it.raw.x)} visits · ${fmtN(it.raw.y)} hours · ${(it.raw.x / it.raw.y).toFixed(2)}/hr`,
        } } },
        scales: { x: { title: { display: true, text: 'weekly visits →', color: DIM,
                                font: { family: 'monospace', size: 10 } } },
                  y: { title: { display: true, text: 'implied operating hours', color: DIM,
                                font: { family: 'monospace', size: 10 } } } } } });
    }
  }

  // Master-workbook sections
  if (funnel) {
    const c = document.getElementById('r-funnel');
    if (c) {
      line(c, {
        ...yoyDatasets(funnel.rate, ACCENT, 'booking rate'),
        datasets: [...yoyDatasets(funnel.rate, ACCENT, 'booking rate').datasets,
                   ...yoyDatasets(funnel.cancel, RED, 'cancelled').datasets,
                   ...yoyDatasets(funnel.noShow, AMBER, 'no-show').datasets],
      });
    }
  }
  if (bh) {
    const c = document.getElementById('r-bhtele');
    if (c) {
      const weeks = bh.bh.map((p) => p.t);
      const m = (ser) => { const x = new Map(ser.map((p) => [p.t, p.v])); return weeks.map((w) => x.get(w) ?? null); };
      line(c, { labels: weeks.map(wkLabel), datasets: [
        { label: 'behavioral health', data: m(bh.bh), borderColor: GREEN, backgroundColor: 'transparent' },
        { label: 'telehealth', data: m(bh.tele), borderColor: AMBER, backgroundColor: 'transparent' },
      ] });
    }
    const c2 = document.getElementById('r-bhseason');
    if (c2) {
      const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      const months = [...new Set([...bh.season.uc, ...bh.season.bh, ...bh.season.tele].map((x) => x.m))]
        .sort((a, b) => a - b);
      const pick = (ser) => { const x = new Map(ser.map((p) => [p.m, p.idx])); return months.map((k) => x.get(k) ?? null); };
      line(c2, { labels: months.map((k) => MON[k - 1]), datasets: [
        { label: 'urgent care', data: pick(bh.season.uc), borderColor: ACCENT,
          borderDash: [5, 3], borderWidth: 1.6, backgroundColor: 'transparent' },
        { label: 'telehealth', data: pick(bh.season.tele), borderColor: AMBER, backgroundColor: 'transparent' },
        { label: 'behavioral health', data: pick(bh.season.bh), borderColor: GREEN, backgroundColor: 'transparent' },
      ] });
    }
  }
  if (acq?.length) {
    const c = document.getElementById('r-acq');
    if (c) {
      bar(c, { labels: acq.map((r) => r.m.slice(5) + '/' + r.m.slice(2, 4)), datasets: [
        { label: 'new patients', data: acq.map((r) => +r.newPct.toFixed(1)), backgroundColor: hexA(AMBER, 0.85) },
        { label: 'established visits', data: acq.map((r) => +r.estPct.toFixed(1)), backgroundColor: hexA(ACCENT, 0.85) },
      ] });
    }
  }
  if (sites) {
    const c = document.getElementById('r-sitemap');
    if (c) {
      const maxV = Math.max(...sites.flatMap((m) => m.rows.map((r) => r.v25 || 0)), 1);
      scatter(c, {
        datasets: sites.map((m, i) => ({
          label: `${m.market} (${m.grew}/${m.n})`,
          data: m.rows.map((r) => ({ x: r.lon, y: r.lat, _s: r.site, _y: r.yoy, _t: r.tenure, _v: r.v25, _g: r.grew })),
          backgroundColor: (x) => (x.raw?._g ? hexA(PALETTE[i % PALETTE.length], 0.85) : 'transparent'),
          borderColor: PALETTE[i % PALETTE.length],
          borderWidth: 1.5,
          pointRadius: (x) => 3 + 7 * Math.sqrt((x.raw?._v || 0) / maxV),
          pointHoverRadius: (x) => 5 + 7 * Math.sqrt((x.raw?._v || 0) / maxV),
        })),
        options: { plugins: { tooltip: { callbacks: {
          title: (it) => it[0]?.raw?._s || '',
          label: (it) => ` YoY ${fmtPct(it.raw._y)} · ${it.raw._t != null ? it.raw._t + 'y old · ' : ''}${fmtN(it.raw._v)} visits`,
        } } },
        scales: { x: { title: { display: true, text: 'longitude →', color: DIM,
                                font: { family: 'monospace', size: 10 } } },
                  y: { title: { display: true, text: 'latitude', color: DIM,
                                font: { family: 'monospace', size: 10 } } } } },
      });
    }
  }

  // L7: footprint charts
  if (fp) {
    const moC = document.getElementById('r-fpmo');
    if (moC) {
      const mLab = fp.monthly.map((m) => m.m.slice(5));
      bar(moC, {
        labels: mLab,
        datasets: [
          { label: 'all network', data: fp.monthly.map((m) => m.all === null ? null : +m.all.toFixed(1)),
            backgroundColor: hexA(ACCENT, 0.8) },
          { label: 'same-store', data: fp.monthly.map((m) => m.ss === null ? null : +m.ss.toFixed(1)),
            backgroundColor: hexA(GREEN, 0.8) },
        ],
      });
    }
    const brC = document.getElementById('r-bridge');
    if (brC) {
      const b = fp.bridge;
      const rows = [
        { t: `${fp.window.curYear - 1} ${fp.window.label}`, lo: 0, hi: b.start, total: true },
        { t: `same-store (${fp.sameStore.n})`, d: b.ss },
        { t: `exited (${fp.exited.length})`, d: b.exited },
        { t: `entered (${fp.entered.length})`, d: b.entered },
        { t: `${fp.window.curYear} ${fp.window.label}`, lo: 0, hi: b.end, total: true },
      ];
      let cum = b.start;
      for (const r of rows) {
        if (r.total) continue;
        r.lo = Math.min(cum, cum + r.d); r.hi = Math.max(cum, cum + r.d); r.neg = r.d < 0;
        cum += r.d;
      }
      const floor = Math.min(b.start, b.end,
        ...rows.filter((r) => !r.total).map((r) => r.lo)) * 0.97;
      bar(brC, {
        labels: rows.map((r) => r.t),
        datasets: [{ label: 'visits',
          data: rows.map((r) => [Math.max(r.lo, r.total ? floor : r.lo), r.hi]),
          backgroundColor: rows.map((r) => r.total ? hexA(DIM, 0.5) : r.neg ? hexA(RED, 0.8) : hexA(ACCENT, 0.8)) }],
        options: { indexAxis: 'y', plugins: { legend: { display: false } },
          scales: { x: { min: Math.max(0, floor) } } },
      });
    }
    const siteC = document.getElementById('r-sites');
    if (siteC && fp.ss.length) {
      scatter(siteC, {
        datasets: [{ label: 'site',
          data: fp.ss.filter((s) => s.prv > 0).map((s) => ({
            x: s.prv, y: +Math.max(-40, Math.min(40, ((s.cur / s.prv) - 1) * 100)).toFixed(1), _t: s.loc })),
          backgroundColor: hexA(ACCENT, 0.65), pointRadius: 4, pointHoverRadius: 6 }],
        options: { plugins: { legend: { display: false }, tooltip: { callbacks: {
          title: (items) => items[0]?.raw?._t || '',
          label: (item) => ` ${fmtN(item.raw.x)} last year · YoY ${fmtPct(item.raw.y)}`,
        } } },
        scales: { x: { title: { display: true, text: 'window volume, prior year',
                                color: DIM, font: { family: 'monospace', size: 10 } } },
                  y: { title: { display: true, text: 'YoY %',
                                color: DIM, font: { family: 'monospace', size: 10 } } } } },
      });
    }
    const parC = document.getElementById('r-pareto');
    if (parC && fp.ranked.length) {
      bar(parC, {
        labels: fp.ranked.map((s) => s.loc),
        datasets: [{ label: 'total visits', data: fp.ranked.map((s) => s.total),
          backgroundColor: hexA(ACCENT, 0.75) }],
        options: { plugins: { legend: { display: false } },
          scales: { x: { ticks: { display: false } } } },
      });
    }
  }
}
