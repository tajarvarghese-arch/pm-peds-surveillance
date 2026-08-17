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
  load, loadAcuity, loadChannel, loadLocations, toWeekly as volWeekly,
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
const icdGroup = (code) => (ICD_GROUPS.find(([re]) => re.test(code)) || [null, 'Other'])[1];

const fmtN = (v) => Math.round(v).toLocaleString();
const fmtPct = (v, dp = 1) => (v === null || v === undefined || Number.isNaN(v))
  ? '--' : `${v > 0 ? '+' : ''}${v.toFixed(dp)}%`;
const cls = (v, flipAt = 0) => (v === null ? '' : v < flipAt ? 's-watch' : 's-ok');
const wkLabel = (t) => new Date(t + 'T00:00:00Z')
  .toLocaleDateString('en-US', { month: 'short', day: '2-digit', timeZone: 'UTC' });

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
        <br>· the channel-mix totals export — demand-arrival context</div>
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
          <div class="note">The numerator counts coded diagnoses (any position); the denominator counts
          visits by primary type. The two files carry different filters, so trend it, don't quote it as
          a rate.${acuity.rateAvg ? ` Window averages: ${acuity.rateAvg.prv.toFixed(0)} →
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

    ${chStore?.pairs?.length ? panel('Layer 6 · How demand arrives', 'period totals — no time dimension', `
      <div class="grid g4">${chStore.pairs.slice(0, 8).map((p) => tile(p.label,
        p.value <= 1.5 ? `${(p.value * 100).toFixed(1)}%` : fmtN(p.value), '')).join('')}</div>
      <div class="note">A totals snapshot cannot be joined to weeks. The question that matters —
      does walk-in share expand in surge weeks? — needs a weekly by-channel export.</div>`) : ''}

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

  mountCharts({ weeklyAll, catW, cats, phased, typeYoY, calYoY, acuity, fp });
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

function mountCharts({ weeklyAll, catW, cats, phased, typeYoY, calYoY, acuity, fp }) {
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
      line(rateC, {
        labels: acuity.rate.map((p) => wkLabel(p.t)),
        datasets: [{ label: 'high-acuity per 1,000 visits',
          data: acuity.rate.map((p) => +p.v.toFixed(1)),
          borderColor: AMBER, backgroundColor: hexA(AMBER, 0.10), fill: true }],
        options: { plugins: { legend: { display: false } } },
      });
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
