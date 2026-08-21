// PM Pediatrics visit volumes — private, browser-only, and now the deep dive.
//
// Structure of this tab, top to bottom:
//   1. privacy bar + headline tiles
//   2. BUSINESS DEEP DIVE — the loaded data on its own terms: YoY, the
//      seasonal-vs-structural split, momentum by service line, seasonality
//      concentration, volatility vs the staffing engine's assumptions
//   3. INTEGRATION — the loaded data against the public surveillance layers:
//      expected-vs-actual regression, environment-adjusted YoY, service line
//      vs pathogen matrix, acuity file cross-checks
//
// Everything is computed in this browser from localStorage. The repository
// carries the machinery, never the numbers.

import { panel, tile, num, delta, empty, levelBadge } from '../ui.js';
import { line, bar, hexA } from '../charts.js';
import {
  parseWorkbook, save, load, clear, saveAcuity, loadAcuity, clearAcuity,
  saveChannel, loadChannel, clearChannel, toWeekly as volWeekly,
  looksLikeLocations, asLocationRows, saveLocations, loadLocations, clearLocations,
  parseWeeklyMetrics, saveChannelWeekly, loadChannelWeekly, clearChannelWeekly,
  parseMasterWorkbook, saveMaster, clearMaster, loadDerived,
} from '../volumes.js';
import {
  trimPartialWeek, yoySameWeeks, windowYoY, seriesStats, concentration,
  linfit, levelCorr, looksLikeICD, isoWeekOf,
} from '../analysis.js';
import {
  pressureIndex, crossCorrelate, logChange, smooth, correlate,
} from '../derive.js';
import { rerender } from '../app.js';

const PALETTE = ['#22d3ee', '#fbbf24', '#4ade80', '#f97316', '#a78bfa',
                 '#f472b6', '#94a3b8', '#ef4444', '#64748b', '#2dd4bf'];
const CAT_COLORS = { Seasonal: '#22d3ee', 'Non-seasonal': '#4ade80',
                     Injury: '#fbbf24', Uncategorized: '#64748b' };

export default function volumes(root, ctx) {
  const store = load();
  const acStore = loadAcuity();
  const chStore = loadChannel();

  if (!store && !acStore && !chStore) { root.innerHTML = uploadPrompt(); wireUpload(root, ctx); return; }
  if (!store) {
    root.innerHTML = `${privacyBar(null, acStore, chStore)}
      <div style="height:10px"></div>
      ${panel('Acuity file loaded — main visit file missing', '',
        `<div class="note">The ICD-coded export is loaded, but the visit-type file is what drives
         the analysis. Load it with “replace file”.</div>`)}`;
    wireUpload(root, ctx);
    return;
  }

  const rows = store.data || [];
  const types = [...new Set(rows.map((r) => r.type))].filter((t) => t !== '(all)');
  const cats = [...new Set(rows.map((r) => r.category))].filter((c) => c !== '(all)');
  const locs = [...new Set(rows.map((r) => r.location))].filter((l) => l !== '(all)');

  // ---- weekly series with the partial-week guard applied everywhere -------
  const rawWeekly = volWeekly(rows);
  const { weekly: weeklyAll, trimmed } = trimPartialWeek(rawWeekly);
  const wkOf = (f) => {
    const w = volWeekly(rows, f);
    return trimmed ? w.filter((p) => p.t !== trimmed.t) : w;
  };
  const total = weeklyAll.reduce((a, p) => a + p.v, 0);
  const lastFull = weeklyAll.at(-1)?.t;

  // ---- surveillance series ------------------------------------------------
  const ppi = pressureIndex(ctx.db.ed_age?.data || [], 'Combined', ctx.mix);
  const ppiWeekly = alignToMonday(ppi);
  const xcLevel = crossCorrelate(ppiWeekly, weeklyAll, { from: -4, to: 8 });
  const xcGrowth = crossCorrelate(logChange(smooth(ppiWeekly, 3)), logChange(weeklyAll), { from: -4, to: 8 });
  const overlap = correlate(ppiWeekly, weeklyAll).n;

  const controls = cats.map((c) => {
    const w = wkOf((r) => r.category === c);
    if (w.length < 12) return null;
    const L = crossCorrelate(ppiWeekly, w, { from: -4, to: 8 }).peak;
    const G = crossCorrelate(logChange(smooth(ppiWeekly, 3)), logChange(w), { from: -4, to: 8 }).peak;
    return { name: c, n: w.reduce((a, p) => a + p.v, 0), L, G,
             respiratory: /season/i.test(c) && !/non/i.test(c) };
  }).filter(Boolean).sort((a, b) => (b.L?.r ?? -9) - (a.L?.r ?? -9));

  // ---- business computations ---------------------------------------------
  const yoyTotal = lastFull ? windowYoY(weeklyAll, lastFull) : null;
  const catYoY = cats.map((c) => ({ c, ...windowYoY(wkOf((r) => r.category === c), lastFull) }))
    .sort((a, b) => (b.cur || 0) - (a.cur || 0));
  const catStats = cats.map((c) => {
    const w = wkOf((r) => r.category === c);
    return { c, share: total > 0 ? w.reduce((a, p) => a + p.v, 0) / total : 0, ...seriesStats(w) };
  }).sort((a, b) => b.share - a.share);
  const statTotal = seriesStats(weeklyAll);
  const floorW = wkOf((r) => r.category === 'Non-seasonal' || r.category === 'Injury');
  const floorStat = seriesStats(floorW);
  const peakWeekFloor = (() => {
    if (!statTotal || !floorW.length) return null;
    const f = floorW.find((p) => p.t === statTotal.peakAt);
    return f ? f.v / statTotal.max : null;
  })();

  const topTypes = types
    .map((t) => ({ t, n: rows.filter((r) => r.type === t).reduce((a, r) => a + r.visits, 0) }))
    .sort((a, b) => b.n - a.n);
  const momentum = topTypes.slice(0, 10).map(({ t }) => {
    const w = wkOf((r) => r.type === t);
    return { t, m: yoySameWeeks(w, 8), size: w.reduce((a, p) => a + p.v, 0) };
  }).filter((x) => x.m);
  const momTotal = yoySameWeeks(weeklyAll, 8);

  const conc = concentration(weeklyAll);

  // ---- integration computations ------------------------------------------
  const fit = linfit(ppiWeekly, weeklyAll);
  const envYoY = lastFull ? windowYoY(ppiWeekly, lastFull) : null;
  let residStreak = 0;
  if (fit) for (let i = fit.resid.length - 1; i >= 0; i--) {
    if (fit.resid[i].resid < 0) residStreak++; else break;
  }

  const pathSeries = buildPathogenSeries(ctx);
  const matrix = topTypes.slice(0, 8).map(({ t }) => {
    const w = wkOf((r) => r.type === t);
    const cells = pathSeries.map((s) => ({ name: s.name, ...levelCorr(w, s.series) }));
    const best = cells.filter((c) => c.r !== null)
      .sort((a, b) => Math.abs(b.r) - Math.abs(a.r))[0] || null;
    return { t, cells, best };
  });

  // acuity join
  let acuity = null;
  if (acStore?.data?.length) {
    const acWeeklyRaw = volWeekly(acStore.data);
    const acW = trimmed ? acWeeklyRaw.filter((p) => p.t !== trimmed.t) : acWeeklyRaw;
    const totMap = new Map(weeklyAll.map((p) => [p.t, p.v]));
    const share = acW.filter((p) => totMap.has(p.t) && totMap.get(p.t) > 0)
      .map((p) => ({ t: p.t, v: (p.v / totMap.get(p.t)) * 100 }));
    const corr = levelCorr(share, weeklyAll);
    const acTypes = [...new Set(acStore.data.map((r) => r.type))];
    // croup vs parainfluenza — the site's PIV story, tested on their book
    let croup = null;
    if (acTypes.some((t) => /^J05/.test(t))) {
      const cw = volWeekly(acStore.data, (r) => /^J05/.test(r.type));
      const cwT = trimmed ? cw.filter((p) => p.t !== trimmed.t) : cw;
      const piv = pathSeries.find((s) => s.name === 'PIV (R2)');
      croup = { yoy: yoySameWeeks(cwT, 8),
                corr: piv ? levelCorr(cwT, piv.series) : { r: null, n: 0 } };
    }
    acuity = { acW, share, corr, codes: acTypes.length, croup,
               total: acW.reduce((a, p) => a + p.v, 0) };
  }

  // ---- render -------------------------------------------------------------
  root.innerHTML = `
    ${privacyBar(store, acStore, chStore)}

    ${trimmed ? `<div class="note gap" style="margin-top:10px">
      <strong>Partial trailing week excluded from every figure below.</strong>
      The export's final week (starting ${trimmed.t}) holds a fraction of a normal week and would
      otherwise fake a volume collapse — a false trough, a false momentum crash, and a huge false
      miss against expectation. Re-export after the week closes to include it.</div>` : ''}

    <div style="height:10px"></div>

    <div class="grid g5" style="margin-bottom:10px">
      ${tile('Visits (full weeks)', total.toLocaleString(),
        `${weeklyAll.length} weeks · thru ${lastFull || '--'}`)}
      ${tile('YTD vs last year', yoyTotal?.pct === null || !yoyTotal ? '--'
          : `<span class="${yoyTotal.pct < 0 ? 's-watch' : 's-ok'}">${yoyTotal.pct > 0 ? '+' : ''}${yoyTotal.pct.toFixed(1)}%</span>`,
        yoyTotal ? `Jan 1–${lastFull.slice(5)} both years` : '')}
      ${tile('vs same 8 wks LY', !momTotal || momTotal.pct === null ? '--'
          : `<span class="${momTotal.pct < 0 ? 's-watch' : 's-ok'}">${momTotal.pct > 0 ? '+' : ''}${momTotal.pct.toFixed(1)}%</span>`,
        'seasonally aligned momentum')}
      ${tile('Peak-to-floor swing', statTotal?.swing ? `${statTotal.swing.toFixed(2)}×` : '--',
        statTotal ? `peak wk ${statTotal.peakAt.slice(5)} · floor wk ${statTotal.troughAt.slice(5)}` : '')}
      ${tile('Busiest 20 weeks hold', conc.top[20] !== null ? `${(conc.top[20] * 100).toFixed(0)}%` : '--',
        'of all visits in the period')}
    </div>

    ${chStore ? channelPanel(chStore, total, lastFull) : ''}

    ${businessSection(catYoY, catStats, statTotal, floorStat, peakWeekFloor, momentum, momTotal, conc, ctx)}

    <div style="height:10px"></div>

    ${validationPanel(xcLevel, xcGrowth, overlap, controls)}

    <div style="height:10px"></div>

    ${integrationSection(fit, envYoY, yoyTotal, residStreak, matrix, pathSeries, acuity)}

    <div style="height:10px"></div>

    ${panel('Visits by type over time', 'weekly totals · full weeks',
      `<div class="chart-wrap tall"><canvas id="v-types"></canvas></div>`)}

    <div style="height:10px"></div>

    <div class="grid g2">
      ${panel('Type mix', 'share of all visits in the loaded period', mixTable(topTypes, total))}
      ${locs.length
        ? panel('By location', 'total visits', `<div class="chart-wrap"><canvas id="v-locs"></canvas></div>`)
        : panel('By location', 'unavailable', empty('this export has no location column'))}
    </div>
  `;

  wireUpload(root, ctx);
  mountCharts({ rows, weeklyAll, wkOf, cats, topTypes, conc, fit, ppiWeekly, acuity, trimmed, locs, chStore });
}

/* ======================= channel mix ===================================== */

/**
 * A totals snapshot has no weeks, so honesty here means two things: identify
 * the denominator instead of double-counting it, and refuse to reconcile
 * against the weekly file as if the two covered the same window.
 */
function channelPanel(chStore, mainTotal, lastFull) {
  const all = chStore.pairs || [];
  if (all.length < 2) return '';
  // Ratio columns ("% Pre-Booked", "% New Patients") are rates, not visit
  // counts — mixing them into the shares would corrupt the math.
  const rates = all.filter((p) => /^%/.test(p.label) || p.value <= 1.5);
  const pairs = all.filter((p) => !rates.includes(p));
  if (pairs.length < 2) return '';
  // If one label equals the sum of the others (within 2%), it is the
  // denominator, not a channel.
  const sum = pairs.reduce((a, p) => a + p.value, 0);
  let denom = null;
  for (const p of pairs) {
    const others = sum - p.value;
    if (others > 0 && Math.abs(p.value - others) / p.value < 0.02) { denom = p; break; }
  }
  const channels = pairs.filter((p) => p !== denom).sort((a, b) => b.value - a.value);
  const base = denom ? denom.value : channels.reduce((a, p) => a + p.value, 0);

  return `<section class="panel" style="margin-bottom:10px">
    <h2>How demand arrives — channel mix
      <span class="sub">${chStore.fileName || 'totals snapshot'} · no time dimension</span></h2>
    <div class="panel-body">
      <div class="grid g2">
        <div><div class="chart-wrap short"><canvas id="v-channel"></canvas></div></div>
        <div>
          <table class="dt">
            <thead><tr><th>Channel</th><th>Visits</th><th>Share</th></tr></thead>
            <tbody>${channels.map((c, i) => `<tr>
              <td><span style="color:${PALETTE[i % PALETTE.length]}">■</span> ${c.label}</td>
              <td class="num">${c.value.toLocaleString()}</td>
              <td class="num">${base > 0 ? ((c.value / base) * 100).toFixed(1) : '--'}%</td>
            </tr>`).join('')}
            ${denom ? `<tr style="border-top:1px solid var(--line-hot)">
              <td><strong>${denom.label}</strong></td>
              <td class="num"><strong>${denom.value.toLocaleString()}</strong></td>
              <td class="num">100%</td></tr>` : ''}
            ${rates.map((r) => `<tr>
              <td style="color:#7f8ea0">${r.label}</td>
              <td class="num" colspan="2">${r.value <= 1.5 ? (r.value * 100).toFixed(1) + '%' : r.value.toLocaleString()}</td>
            </tr>`).join('')}</tbody>
          </table>
          ${channels.length >= 2 && base > 0 && channels[0].value / base > 0.5 ? `<div class="note">
            <strong>Majority of demand arrives through “${channels[0].label}”.</strong> The larger that
            share, the more volume is funnel-shaped — bookable, forecastable, and smoothable — and the
            less of the week is at the mercy of the walk-in surge.</div>` : ''}
          ${chStore.filterText ? `<div class="note" style="color:#4b5a6b">Export window per its own
            filters: ${chStore.filterText.replace(/^applied filters:?\s*/i, '')}</div>` : ''}
          ${mainTotal ? `<div class="note gap">Not reconciled against the weekly file: the two exports
            carry different date windows (this one per its filters above; the weekly file through
            ${lastFull || '--'}), so their totals are not comparable one-to-one. A <em>weekly</em>
            by-channel export would unlock the real question — whether walk-in share expands in surge
            weeks — which a single snapshot cannot answer.</div>` : ''}
        </div>
      </div>
    </div>
  </section>`;
}

/* ======================= business section ================================ */

function businessSection(catYoY, catStats, statTotal, floorStat, peakWeekFloor, momentum, momTotal, conc, ctx) {
  const floorShare = statTotal && floorStat ? floorStat.mean / statTotal.mean : null;
  const capNote = statTotal?.swing && statTotal.swing > 1.6;

  return `<section class="panel" style="border-color:#22d3ee">
    <h2 style="color:#22d3ee">Business deep dive — the loaded book on its own terms
      <span class="sub">every figure computed in this browser</span></h2>
    <div class="panel-body">

      <div class="grid g2" style="margin-bottom:10px">
        <div>
          <div class="chart-wrap"><canvas id="v-yoy"></canvas></div>
          <div class="note">This calendar year against last, aligned by ISO week. The vertical gap
          <em>is</em> the year-over-year story, week by week.</div>
        </div>
        <div>
          <table class="dt">
            <thead><tr><th>Category</th><th>YTD</th><th>Same window LY</th><th>YoY</th></tr></thead>
            <tbody>${catYoY.map((c) => `<tr>
              <td><span style="color:${CAT_COLORS[c.c] || '#94a3b8'}">■</span> ${c.c}</td>
              <td class="num">${c.cur ? c.cur.toLocaleString() : '--'}</td>
              <td class="num" style="color:#7f8ea0">${c.prv ? c.prv.toLocaleString() : '--'}</td>
              <td class="num ${c.pct === null ? '' : c.pct < 0 ? 's-watch' : 's-ok'}">
                ${c.pct === null ? '--' : `${c.pct > 0 ? '+' : ''}${c.pct.toFixed(1)}%`}</td>
            </tr>`).join('')}</tbody>
          </table>
          <div class="note"><strong>The split that matters.</strong> Seasonal illness is the
          weather-exposed book; injury and non-seasonal lines are the structural book. When they move
          in opposite directions, the YoY total is telling you about the <em>season</em>, not the
          <em>business</em>.</div>
        </div>
      </div>

      <div class="grid g2" style="margin-bottom:10px">
        <div>
          <table class="dt">
            <thead><tr><th>Category</th><th>Share</th><th>CV</th><th>Peak/trough</th></tr></thead>
            <tbody>${catStats.map((s) => `<tr>
              <td><span style="color:${CAT_COLORS[s.c] || '#94a3b8'}">■</span> ${s.c}</td>
              <td class="num">${(s.share * 100).toFixed(1)}%</td>
              <td class="num">${s.cv !== null ? s.cv.toFixed(2) : '--'}</td>
              <td class="num">${s.swing ? s.swing.toFixed(1) + '×' : '--'}</td>
            </tr>`).join('')}</tbody>
          </table>
          <div class="note">Structural floor ≈ ${floorShare !== null ? (floorShare * 100).toFixed(0) : '--'}%
          of an average week${peakWeekFloor !== null ? `, but only ${(peakWeekFloor * 100).toFixed(0)}% of the
          peak week` : ''} — the seasonal book is what the peak is made of.</div>
          ${capNote ? `<div class="note warn"><strong>Staffing-table check.</strong> The observed
          peak-to-floor swing is ${statTotal.swing.toFixed(2)}×, which exceeds the staffing engine's
          1.6× top multiplier. If staffing tracked that table literally, peak weeks would be
          under-covered; the table's multipliers cap out below the demand swing this book actually
          exhibits.</div>` : ''}
        </div>
        <div>
          <table class="dt">
            <thead><tr><th>Service line</th><th>Last 8 wks</th><th>Same wks LY</th><th>YoY</th></tr></thead>
            <tbody>${momentum.map((x) => `<tr>
              <td>${x.t.length > 30 ? x.t.slice(0, 29) + '…' : x.t}</td>
              <td class="num">${x.m.now.toLocaleString()}</td>
              <td class="num" style="color:#7f8ea0">${x.m.then.toLocaleString()}</td>
              <td class="num ${x.m.pct === null ? '' : x.m.pct < -5 ? 's-watch' : x.m.pct > 5 ? 's-ok' : ''}">
                ${x.m.pct === null ? '--' : `${x.m.pct > 0 ? '+' : ''}${x.m.pct.toFixed(1)}%`}</td>
            </tr>`).join('')}
            ${momTotal ? `<tr style="border-top:1px solid var(--line-hot)">
              <td><strong>TOTAL</strong></td>
              <td class="num"><strong>${momTotal.now.toLocaleString()}</strong></td>
              <td class="num" style="color:#7f8ea0">${momTotal.then.toLocaleString()}</td>
              <td class="num"><strong>${momTotal.pct > 0 ? '+' : ''}${momTotal.pct.toFixed(1)}%</strong></td>
            </tr>` : ''}</tbody>
          </table>
          <div class="note">Momentum is measured against the <em>same calendar weeks last year</em>,
          never against the prior 8 weeks — on a seasonal book, raw momentum only ever reports the
          calendar.</div>
        </div>
      </div>

      <div class="chart-wrap short"><canvas id="v-profile"></canvas></div>
      <div class="note">Average weekly volume by ISO week — the shape of the operating year. The
      busiest 10 weeks hold ${conc.top[10] !== null ? (conc.top[10] * 100).toFixed(0) : '--'}% of all
      visits, the busiest 20 hold ${conc.top[20] !== null ? (conc.top[20] * 100).toFixed(0) : '--'}% —
      the margin of the year is earned in about a quarter of it.</div>
    </div>
  </section>`;
}

/* ======================= integration section ============================= */

function buildPathogenSeries(ctx) {
  const out = [];
  const ppi = pressureIndex(ctx.db.ed_age?.data || [], 'Combined', ctx.mix);
  if (ppi.length) out.push({ name: 'Index', series: alignToMonday(ppi) });
  const pos = ctx.db.pos_national?.data || [];
  for (const k of ['Influenza', 'RSV', 'COVID-19']) {
    const s = pos.map((r) => ({ t: r.week, v: r[k] })).filter((p) => p.v != null);
    if (s.length) out.push({ name: k === 'COVID-19' ? 'COVID' : k, series: alignToMonday(s) });
  }
  const naat = ctx.db.naat_multi?.data || [];
  const piv = naat.map((r) => ({ t: r.week, v: r['Region 2|PIV'] })).filter((p) => p.v != null);
  if (piv.length) out.push({ name: 'PIV (R2)', series: alignToMonday(piv) });
  return out;
}

function integrationSection(fit, envYoY, yoyTotal, residStreak, matrix, pathSeries, acuity) {
  const outperf = (envYoY?.pct != null && yoyTotal?.pct != null)
    ? yoyTotal.pct - envYoY.pct : null;
  const lastResid = fit?.resid?.at(-1) || null;

  return `<section class="panel" style="border-color:#a78bfa">
    <h2 style="color:#a78bfa">Integration — the book against the surveillance layers
      <span class="sub">expected vs actual, environment-adjusted</span></h2>
    <div class="panel-body">

      ${fit ? `
      <div class="grid g4" style="margin-bottom:10px">
        ${tile('Model fit (levels)', `R²=${fit.r2 !== null ? fit.r2.toFixed(2) : '--'}`,
          `${fit.n} overlapping weeks · heuristic, not a forecast`)}
        ${tile('Visits per index point', Math.round(fit.slope).toLocaleString(),
          'weekly visits gained per +1pp of the CDC index')}
        ${tile('Structural base', Math.round(fit.intercept).toLocaleString(),
          'implied weekly volume at a zero index — the non-epidemic book')}
        ${tile('vs environment YTD', outperf === null ? '--'
            : `<span class="${outperf > 0 ? 's-ok' : 's-critical'}">${outperf > 0 ? '+' : ''}${outperf.toFixed(1)}pp</span>`,
          envYoY?.pct != null ? `index ${envYoY.pct > 0 ? '+' : ''}${envYoY.pct.toFixed(1)}% YoY vs volume ${yoyTotal.pct > 0 ? '+' : ''}${yoyTotal.pct.toFixed(1)}%` : '')}
      </div>

      <div class="grid g2" style="margin-bottom:10px">
        <div>
          <div class="chart-wrap"><canvas id="v-eva"></canvas></div>
          <div class="note">Actual weekly visits vs the level implied by the CDC index. The gap is
          performance the environment cannot explain.</div>
        </div>
        <div>
          <div class="chart-wrap"><canvas id="v-resid"></canvas></div>
          <div class="note ${residStreak >= 3 ? 'warn' : ''}">
            Residuals — actual minus environment-expected.
            ${residStreak >= 3 && lastResid ? `<strong>${residStreak} consecutive weeks below
            expectation</strong>, most recently ${(100 * lastResid.resid / lastResid.fitted).toFixed(1)}%
            under. The public index does not explain this gap; something internal or local does —
            worth asking management about before it compounds.` : 'No sustained gap at present.'}
          </div>
        </div>
      </div>` : `<div class="note">Not enough overlapping weeks for the expected-vs-actual model.</div>`}

      <table class="dt">
        <thead><tr><th>Service line</th>${pathSeries.map((s) => `<th>${s.name}</th>`).join('')}<th style="text-align:left">Reads as</th></tr></thead>
        <tbody>${matrix.map((m) => `<tr>
          <td>${m.t.length > 28 ? m.t.slice(0, 27) + '…' : m.t}</td>
          ${m.cells.map((c) => `<td class="num ${c.r !== null && Math.abs(c.r) >= 0.7 ? (c.r > 0 ? 's-elevated' : 's-ok') : ''}">
            ${c.r === null ? '·' : c.r.toFixed(2)}</td>`).join('')}
          <td style="text-align:left;color:#7f8ea0;font-size:10px">
            ${m.best && Math.abs(m.best.r) >= 0.5
              ? `${m.best.r > 0 ? 'tracks' : 'inverse to'} ${m.best.name}`
              : 'no strong pathogen link'}</td>
        </tr>`).join('')}</tbody>
      </table>
      <div class="note">Level correlations over the overlap — driver identification, not causation.
      A service line that tracks influenza is a flu-season book and will inherit flu-season risk; a
      line that runs <em>inverse</em> to the index is counter-cyclical ballast. Shared seasonality
      inflates all of these — the category control table above is the antidote.</div>

      ${acuity ? `
      <div style="height:10px"></div>
      <div class="grid g2">
        <div>
          <div class="chart-wrap short"><canvas id="v-acuity"></canvas></div>
          <div class="note">The ICD-coded list as a share of total visits, weekly
          (${acuity.codes} codes loaded). Correlation of that share with total volume:
          <strong>${acuity.corr.r !== null ? (acuity.corr.r > 0 ? '+' : '') + acuity.corr.r.toFixed(2) : '--'}</strong>.
          ${acuity.corr.r !== null && acuity.corr.r > 0.4
            ? 'Positive: the coded conditions concentrate in the busy season — surge weeks are also the clinically heavier weeks, which compounds the staffing problem.'
            : acuity.corr.r !== null && acuity.corr.r < -0.4
            ? 'Negative: quieter weeks carry a clinically heavier mix.'
            : 'No strong relationship between mix and volume.'}</div>
        </div>
        <div>
          ${acuity.croup ? `<table class="dt">
            <thead><tr><th colspan="2">Croup (J05.x) — tested against the site's parainfluenza signal</th></tr></thead>
            <tbody>
              <tr><td>Correlation with Region 2 PIV positivity</td>
                <td class="num">${acuity.croup.corr.r !== null ? acuity.croup.corr.r.toFixed(2) : '--'} (n=${acuity.croup.corr.n})</td></tr>
              <tr><td>Croup, last 8 wks vs same wks LY</td>
                <td class="num ${acuity.croup.yoy?.pct < 0 ? 's-ok' : 's-watch'}">
                  ${acuity.croup.yoy?.pct != null ? (acuity.croup.yoy.pct > 0 ? '+' : '') + acuity.croup.yoy.pct.toFixed(0) + '%' : '--'}</td></tr>
            </tbody>
          </table>
          <div class="note ${acuity.croup.corr.r !== null && Math.abs(acuity.croup.corr.r) < 0.2 ? 'gap' : ''}">
            ${acuity.croup.corr.r !== null && Math.abs(acuity.croup.corr.r) < 0.2
              ? `<strong>A surveillance signal that does not cash.</strong> The site flags parainfluenza
                 as elevated in Region 2, but croup volume in this book shows essentially no
                 relationship to PIV positivity over the overlap. Lab positivity among tested patients
                 is evidently not a proxy for croup demand at urgent care — do not staff against the
                 PIV signal.`
              : 'Croup volume and regional PIV positivity move together over this record.'}</div>` : ''}
        </div>
      </div>` : `
      <div class="note">Load the ICD-coded acuity export as well (choose it with “replace file” — it
      is detected automatically and stored alongside) to unlock the acuity-mix and croup-vs-PIV
      analyses.</div>`}
    </div>
  </section>`;
}

/* ======================= charts ========================================== */

function mountCharts({ rows, weeklyAll, wkOf, cats, topTypes, conc, fit, ppiWeekly, acuity, trimmed, locs, chStore }) {
  const fmt = (t) => {
    const d = new Date(t + 'T00:00:00Z');
    return d.toLocaleDateString('en-US', { month: 'short', day: '2-digit', timeZone: 'UTC' });
  };

  // YoY overlay: current calendar year vs prior, by ISO week
  const yoyC = document.getElementById('v-yoy');
  if (yoyC && weeklyAll.length) {
    const curYear = +weeklyAll.at(-1).t.slice(0, 4);
    const byYW = new Map(weeklyAll.map((p) => [`${p.t.slice(0, 4)}-${isoWeekOf(p.t)}`, p.v]));
    const wksInYear = [...new Set(weeklyAll.filter((p) => +p.t.slice(0, 4) === curYear)
      .map((p) => isoWeekOf(p.t)))].sort((a, b) => a - b);
    line(yoyC, {
      labels: wksInYear.map((w) => `w${w}`),
      datasets: [
        { label: String(curYear - 1), data: wksInYear.map((w) => byYW.get(`${curYear - 1}-${w}`) ?? null),
          borderColor: '#7f8ea0', borderDash: [4, 3], borderWidth: 1.4, backgroundColor: 'transparent' },
        { label: String(curYear), data: wksInYear.map((w) => byYW.get(`${curYear}-${w}`) ?? null),
          borderColor: '#22d3ee', borderWidth: 2.2, backgroundColor: hexA('#22d3ee', 0.10), fill: true },
      ],
    });
  }

  // seasonality profile
  const prof = document.getElementById('v-profile');
  if (prof && conc.profile.length) {
    bar(prof, {
      labels: conc.profile.map((p) => `w${p.w}`),
      datasets: [{ label: 'avg weekly visits',
        data: conc.profile.map((p) => Math.round(p.mean)),
        backgroundColor: conc.profile.map((p) => (p.n < 2 ? 'rgba(127,142,160,0.4)' : hexA('#22d3ee', 0.75))) }],
      options: { plugins: { legend: { display: false } } },
    });
  }

  // expected vs actual + residuals
  if (fit) {
    const eva = document.getElementById('v-eva');
    if (eva) {
      line(eva, {
        labels: fit.resid.map((r) => fmt(r.t)),
        datasets: [
          { label: 'actual', data: fit.resid.map((r) => Math.round(r.actual)),
            borderColor: '#22d3ee', borderWidth: 2, backgroundColor: 'transparent' },
          { label: 'expected from index', data: fit.resid.map((r) => Math.round(r.fitted)),
            borderColor: '#a78bfa', borderDash: [5, 3], borderWidth: 1.6, backgroundColor: 'transparent' },
        ],
      });
    }
    const res = document.getElementById('v-resid');
    if (res) {
      const tail = fit.resid.slice(-26);
      bar(res, {
        labels: tail.map((r) => fmt(r.t)),
        datasets: [{ label: 'residual',
          data: tail.map((r) => Math.round(r.resid)),
          backgroundColor: tail.map((r) => (r.resid < 0 ? 'rgba(239,68,68,0.75)' : 'rgba(74,222,128,0.75)')) }],
        options: { plugins: { legend: { display: false } } },
      });
    }
  }

  // acuity share
  if (acuity) {
    const acC = document.getElementById('v-acuity');
    if (acC && acuity.share.length) {
      line(acC, {
        labels: acuity.share.map((p) => fmt(p.t)),
        datasets: [{ label: 'coded share of visits (%)',
          data: acuity.share.map((p) => +p.v.toFixed(1)),
          borderColor: '#f97316', borderWidth: 1.8, backgroundColor: hexA('#f97316', 0.10), fill: true }],
        options: { plugins: { legend: { display: false } } },
      });
    }
  }

  // channel mix bar
  const chC = document.getElementById('v-channel');
  if (chC && chStore?.pairs?.length) {
    const counts = chStore.pairs.filter((p) => !/^%/.test(p.label) && p.value > 1.5);
    const sum = counts.reduce((a, p) => a + p.value, 0);
    const ch = counts
      .filter((p) => !(sum - p.value > 0 && Math.abs(p.value - (sum - p.value)) / p.value < 0.02))
      .sort((a, b) => b.value - a.value);
    bar(chC, {
      labels: ch.map((c) => c.label),
      datasets: [{ label: 'visits', data: ch.map((c) => c.value),
        backgroundColor: ch.map((_, i) => hexA(PALETTE[i % PALETTE.length], 0.8)) }],
      options: { indexAxis: 'y', plugins: { legend: { display: false } } },
    });
  }

  // by-type over time (existing behaviour, trimmed)
  const typesC = document.getElementById('v-types');
  if (typesC) {
    const weeks = weeklyAll.map((p) => p.t);
    const top8 = topTypes.slice(0, 8).map((x) => x.t);
    line(typesC, {
      labels: weeks.map(fmt),
      datasets: (top8.length ? top8 : ['(all)']).map((t, i) => {
        const s = new Map(wkOf((r) => (top8.length ? r.type === t : true)).map((p) => [p.t, p.v]));
        return { label: t, data: weeks.map((w) => s.get(w) ?? null),
                 borderColor: PALETTE[i % PALETTE.length], backgroundColor: 'transparent' };
      }),
    });
  }

  if (locs.length) {
    const locC = document.getElementById('v-locs');
    if (locC) {
      const byLoc = locs.map((l) => ({
        l, n: rows.filter((r) => r.location === l).reduce((a, r) => a + r.visits, 0),
      })).sort((a, b) => b.n - a.n).slice(0, 15);
      bar(locC, {
        labels: byLoc.map((x) => x.l),
        datasets: [{ label: 'visits', data: byLoc.map((x) => x.n), backgroundColor: hexA('#22d3ee', 0.75) }],
        options: { indexAxis: 'y', plugins: { legend: { display: false } } },
      });
    }
  }
}

/* ======================= plumbing (upload, privacy, tables) ============== */

function alignToMonday(points) {
  return points.map((p) => {
    const d = new Date(p.t + 'T00:00:00Z');
    const dow = (d.getUTCDay() + 6) % 7;
    d.setUTCDate(d.getUTCDate() - dow);
    return { t: d.toISOString().slice(0, 10), v: p.v };
  });
}

function privacyBar(store, acStore, chStore) {
  const locStore = loadLocations();
  const files = [store && `${store.fileName || 'visit file'}`,
                 acStore && `${acStore.fileName || 'acuity file'} (ICD)`,
                 chStore && `${chStore.fileName || 'channel file'} (totals)`,
                 locStore && `${locStore.fileName || 'location file'} (sites)`,
                 loadChannelWeekly() && `${loadChannelWeekly().fileName || 'weekly metrics'} (channels/wk)`,
                 loadDerived() && 'master workbook (all sheets)']
    .filter(Boolean).join(' + ');
  return `<section class="panel" style="border-color:#4ade80">
    <h2 style="color:#4ade80">Private — these files never left your browser
      <span class="sub">${files}</span></h2>
    <div class="panel-body">
      <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:center">
        <div style="flex:1;min-width:260px;font-size:11.5px;line-height:1.6;color:#7f8ea0">
          This site is static — no server, no upload endpoint. Workbooks are read in the page and kept
          in this browser's local storage only. An ICD-coded export is detected automatically and
          stored alongside the visit-type file, so both analyses run together.
        </div>
        <div style="display:flex;gap:6px">
          <button class="ghost" id="v-replace">add / replace file</button>
          <button class="ghost" id="v-clear">erase all from this browser</button>
        </div>
      </div>
      <input type="file" id="v-file" accept=".xlsx,.xlsm,.xls,.csv" style="display:none">
      <div id="v-status" class="note" style="display:none"></div>
    </div>
  </section>`;
}

function uploadPrompt() {
  return `<section class="panel">
    <h2>Load PM Pediatrics visit data <span class="sub">stays in this browser</span></h2>
    <div class="panel-body">
      <div style="font-size:12px;line-height:1.7;margin-bottom:12px">
        Pick the visits-by-type spreadsheet (and, optionally, the ICD-coded acuity export — it is
        recognised automatically). <strong>Nothing is uploaded.</strong> This site is static; there is
        no server to receive a file. Workbooks are parsed in the page and stored in this browser only.
      </div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <button class="ghost" id="v-replace" style="border-color:#22d3ee;color:#22d3ee">choose spreadsheet…</button>
        <span style="color:#4b5a6b;font-size:10.5px">.xlsx, .xls or .csv · matrix crosstabs and long exports both work</span>
      </div>
      <input type="file" id="v-file" accept=".xlsx,.xlsm,.xls,.csv" style="display:none">
      <div id="v-status" class="note" style="display:none"></div>
      <div class="note gap">If this came from the board portal it is confidential — the browser is the
      safe place for it. Do not commit it to the repository, which is public.</div>
    </div>
  </section>`;
}

function wireUpload(root, ctx) {
  const input = root.querySelector('#v-file');
  const pick = root.querySelector('#v-replace');
  const wipe = root.querySelector('#v-clear');
  const status = root.querySelector('#v-status');
  if (pick && input) pick.onclick = () => input.click();
  if (wipe) wipe.onclick = () => {
    if (confirm('Erase all loaded visit data from this browser?')) {
      clear(); clearAcuity(); clearChannel(); clearLocations(); rerender();
    }
  };
  if (!input) return;

  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    status.style.display = '';
    status.innerHTML = `reading ${file.name}…`;
    try {
      const buf = await file.arrayBuffer();
      // The aggregated master workbook carries every dataset as its own sheet,
      // so it is tried before any single-sheet reader can claim one of them.
      const master = parseMasterWorkbook(buf);
      if (master) {
        const degraded = saveMaster(master, file.name);
        status.innerHTML = `<strong class="s-ok">loaded the master workbook.</strong> ${master.note}`
          + (degraded.length ? `<br><span class="s-watch">${degraded.join('; ')}</span>` : '');
        setTimeout(rerender, 1200);
        return;
      }
      // The weekly multi-metric shape (several numeric columns per week) must be
      // tried first: the generic reader would keep one column and drop the rest.
      const wm = parseWeeklyMetrics(buf);
      if (wm) {
        saveChannelWeekly({ ...wm, fileName: file.name,
          loadedAt: new Date().toISOString().slice(0, 16).replace('T', ' ') });
        status.innerHTML = `<strong class="s-ok">loaded as the weekly channel/metrics file.</strong> ${wm.note}`;
        setTimeout(rerender, 900);
        return;
      }
      const parsed = parseWorkbook(buf);
      const payload = { ...parsed, fileName: file.name,
        loadedAt: new Date().toISOString().slice(0, 16).replace('T', ' ') };
      let slot = 'visit-type file';
      if (parsed.layout === 'totals') { saveChannel(payload); slot = 'channel/totals snapshot'; }
      else if (looksLikeLocations(parsed)) {
        saveLocations({ ...asLocationRows(parsed), fileName: file.name, loadedAt: payload.loadedAt });
        slot = 'by-location file';
      } else {
        const types = [...new Set(parsed.data.map((r) => r.type))];
        if (looksLikeICD(types)) { saveAcuity(payload); slot = 'ICD/acuity file'; }
        else save(payload);
      }
      status.innerHTML = `<strong class="s-ok">loaded as the ${slot}.</strong>
        ${parsed.layout === 'totals' ? `${parsed.pairs.length} totals` : `${parsed.rawRows.toLocaleString()} rows`}
        from "${parsed.sheetName}"${parsed.note ? ` · ${parsed.note}` : ''}`;
      setTimeout(rerender, 900);
    } catch (e) {
      status.innerHTML = `<strong class="s-critical">could not read that file.</strong> ${e.message}`;
    }
  };
}

function validationPanel(xcLevel, xcGrowth, overlap, controls) {
  if (overlap < 8) {
    return panel('Does the index predict your volume?', `only ${overlap} overlapping weeks`,
      empty('need at least 8 overlapping weeks'));
  }
  const L = xcLevel.peak, G = xcGrowth.peak;
  const verdict = !G ? { t: 'INCONCLUSIVE', c: 'ok' }
    : G.r >= 0.6 ? { t: 'STRONG', c: 'elevated' }
    : G.r >= 0.35 ? { t: 'MODERATE', c: 'watch' }
    : { t: 'WEAK', c: 'ok' };
  return `<section class="panel" style="border-color:#22d3ee">
    <h2 style="color:#22d3ee">Does the index predict your volume?
      <span class="sub">${overlap} overlapping weeks · ground truth check</span></h2>
    <div class="panel-body">
      <div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap;margin-bottom:8px">
        ${levelBadge(verdict.t, verdict.c)}
        <div style="font-size:11px;color:#7f8ea0">
          growth-rate peak <strong>${G ? `r=${G.r.toFixed(2)} @ ${G.lag > 0 ? '+' : ''}${G.lag}w` : '--'}</strong>
          · level peak <strong>${L ? `r=${L.r.toFixed(2)} @ ${L.lag > 0 ? '+' : ''}${L.lag}w` : '--'}</strong>
        </div>
      </div>
      ${controls.length > 1 ? `<table class="dt">
        <thead><tr><th>Category</th><th>Visits</th><th>Level r</th><th>Lag</th><th>Growth r</th></tr></thead>
        <tbody>${controls.map((c) => `<tr>
          <td>${c.respiratory ? `<strong class="s-ok">${c.name}</strong>` : c.name}
            ${!c.respiratory && Math.abs(c.L?.r ?? 0) < 0.3 ? ' <span class="badge" style="color:#7f8ea0">control</span>' : ''}</td>
          <td class="num">${c.n.toLocaleString()}</td>
          <td class="num ${(c.L?.r ?? 0) > 0.6 ? 's-elevated' : ''}">${c.L ? c.L.r.toFixed(2) : '--'}</td>
          <td class="num" style="color:#7f8ea0">${c.L ? `${c.L.lag > 0 ? '+' : ''}${c.L.lag}w` : '--'}</td>
          <td class="num">${c.G ? c.G.r.toFixed(2) : '--'}</td>
        </tr>`).join('')}</tbody>
      </table>
      <div class="note gap"><strong>This table is the actual evidence.</strong> If the index only
      looked predictive because both series rise every winter, a non-respiratory category would
      correlate just as well. A strong respiratory correlation next to a near-zero one for the
      controls means the signal is real, not shared seasonality.</div>` : ''}
      <div class="note warn">Judge on the growth-rate number: levels share the seasonal wave. Level
      correlation validates <em>seasonal level-setting</em>; only growth correlation would validate
      <em>week-to-week triggers</em>, and its absence means the site's acceleration rules should not
      drive staffing decisions on their own.</div>
    </div>
  </section>`;
}

function mixTable(topTypes, total) {
  if (!topTypes.length) return empty('this export has no visit-type column');
  const max = topTypes[0].n;
  return `<div class="scroll-y"><table class="dt">
    <thead><tr><th>Visit type</th><th>Visits</th><th>Share</th><th style="text-align:left">·</th></tr></thead>
    <tbody>${topTypes.map(({ t, n }, i) => `<tr>
      <td><span style="color:${PALETTE[i % PALETTE.length]}">■</span> ${t}</td>
      <td class="num">${n.toLocaleString()}</td>
      <td class="num">${((n / total) * 100).toFixed(1)}%</td>
      <td style="text-align:left"><div style="height:8px;width:${((n / max) * 100).toFixed(0)}%;background:${PALETTE[i % PALETTE.length]}"></div></td>
    </tr>`).join('')}</tbody></table></div>`;
}
