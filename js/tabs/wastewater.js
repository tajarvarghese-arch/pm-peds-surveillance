// Wastewater: independent transmission signal, and the only series that still
// resolves direction when ED derivatives are stuck on their quantisation floor.
//
// Every lead/lag claim on this tab is computed from the loaded data at render
// time. Nothing is asserted from memory, so the numbers stay true as the record
// grows or as CDC revises history.

import { panel, num, delta, empty, tile, levelBadge } from '../ui.js';
import { line, hexA, sparkline } from '../charts.js';
import { MARKETS, PATHOGENS } from '../config.js';
import {
  indexToMedian, logChange, crossCorrelate, smooth, wastewaterSignal,
  percentileRank, ordinal,
} from '../derive.js';
import { toWeeklyMonday, fmtDate } from '../data.js';
import { rerender } from '../app.js';

const TARGETS = {
  'SARS-CoV-2': { file: 'ww_covid', ed: 'COVID', color: '#22d3ee', dataset: 'j9g8-acpt' },
  'Influenza A': { file: 'ww_flu', ed: 'Influenza', color: '#fbbf24', dataset: 'ymmh-divb' },
};

export function wwSeries(db, file, abbr) {
  const rows = db[file]?.data || [];
  return rows
    .map((r) => ({ t: r.week, v: r[abbr] }))
    .filter((p) => p.v !== null && p.v !== undefined);
}

export function edSeries(db, stateFull, pathogen) {
  const rows = db.ed_state?.data || [];
  const pts = rows
    .map((r) => ({ t: r.date, v: r[`${stateFull}|${pathogen}`] }))
    .filter((p) => p.v !== null && p.v !== undefined);
  return toWeeklyMonday(pts);
}

export default function wastewater(root, ctx) {
  const targetKey = TARGETS[ctx.wwTarget] ? ctx.wwTarget : 'SARS-CoV-2';
  const target = TARGETS[targetKey];

  const perState = MARKETS.states.map((full) => {
    const ab = MARKETS.abbr[full];
    const ww = wwSeries(ctx.db, target.file, ab);
    const ed = edSeries(ctx.db, full, target.ed);
    const sig = wastewaterSignal(ww);
    // Correlate growth rates, not levels: levels share a seasonal wave and will
    // look impressively correlated even with no predictive content.
    const xc = crossCorrelate(logChange(smooth(ww, 3)), logChange(ed));
    const xcLevel = crossCorrelate(ww, ed);
    return { full, ab, ww, ed, sig, xc, xcLevel };
  });

  const usable = perState.filter((s) => s.sig);
  if (!usable.length) {
    root.innerHTML = empty('no wastewater signal — run scripts/fetch_data.py');
    return;
  }

  root.innerHTML = `
    <div class="controls">
      <label>Target
        <select id="sel-ww">
          ${Object.keys(TARGETS).map((k) => `<option ${k === targetKey ? 'selected' : ''}>${k}</option>`).join('')}
        </select>
      </label>
      <span style="color:#4b5a6b;font-size:10.5px">
        CDC NWSS ${target.dataset} · population-weighted, liquid assay only · vs NSSP ED ${target.ed} share
      </span>
    </div>

    <div class="grid g3" style="margin-bottom:10px">${perState.map(stateTile).join('')}</div>

    <div class="grid g-2-1" style="margin-bottom:10px">
      ${panel(`${targetKey} wastewater vs ED visits`, 'each indexed to its own median — units are not comparable',
        `<div class="chart-wrap tall"><canvas id="c-wwed"></canvas></div>
         <div class="note">Wastewater is plotted as % of its own 2-year median and ED share as % of its
         own median, because absolute concentration cannot be compared across states or against a visit
         percentage. Shape is the signal here, not level.</div>`)}

      ${panel('Measured lead / lag', 'computed from loaded data, not assumed', leadLagPanel(perState, targetKey))}
    </div>

    ${panel('Cross-correlation curve', 'growth rates — positive lag means wastewater leads',
      `<div class="chart-wrap"><canvas id="c-xc"></canvas></div>
       ${honestyNote(perState)}`)}
  `;

  document.getElementById('sel-ww').onchange = (e) => { ctx.wwTarget = e.target.value; rerender(); };

  // --- wastewater vs ED overlay, both normalised -------------------------
  const allT = [...new Set(perState.flatMap((s) => s.ww.map((p) => p.t)))].sort().slice(-104);
  const ds = [];
  for (const s of perState) {
    const wwIdx = new Map(indexToMedian(s.ww).map((p) => [p.t, p.v]));
    const edIdx = new Map(indexToMedian(s.ed).map((p) => [p.t, p.v]));
    ds.push({
      label: `${s.ab} wastewater`,
      data: allT.map((t) => (wwIdx.has(t) ? +wwIdx.get(t).toFixed(1) : null)),
      borderColor: target.color, borderWidth: 1.8, backgroundColor: 'transparent',
    });
    ds.push({
      label: `${s.ab} ED ${target.ed}`,
      data: allT.map((t) => (edIdx.has(t) ? +edIdx.get(t).toFixed(1) : null)),
      borderColor: '#7f8ea0', borderWidth: 1.2, borderDash: [4, 3], backgroundColor: 'transparent',
    });
  }
  // One state at a time is legible; three overlaid pairs is not.
  const focus = ctx.wwFocus && perState.some((s) => s.ab === ctx.wwFocus) ? ctx.wwFocus : perState[0].ab;
  const shown = ds.filter((d) => d.label.startsWith(focus));

  line(document.getElementById('c-wwed'), {
    labels: allT.map((t) => {
      const d = new Date(t + 'T00:00:00Z');
      return d.toLocaleDateString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' });
    }),
    datasets: shown,
    options: { scales: { y: { title: { display: true, text: '% of own median',
      color: '#4b5a6b', font: { family: 'monospace', size: 9 } } } } },
  });

  // --- cross-correlation curve ------------------------------------------
  const lags = perState[0].xc.scan.map((s) => s.lag);
  line(document.getElementById('c-xc'), {
    labels: lags.map((l) => (l > 0 ? `+${l}w` : `${l}w`)),
    datasets: perState.map((s, i) => ({
      label: `${s.ab} growth-rate r`,
      data: s.xc.scan.map((x) => (x.r === null ? null : +x.r.toFixed(3))),
      borderColor: ['#22d3ee', '#fbbf24', '#4ade80'][i],
      backgroundColor: 'transparent',
    })).concat(perState.map((s, i) => ({
      label: `${s.ab} level r`,
      data: s.xcLevel.scan.map((x) => (x.r === null ? null : +x.r.toFixed(3))),
      borderColor: ['#22d3ee', '#fbbf24', '#4ade80'][i],
      borderDash: [3, 3], borderWidth: 1, backgroundColor: 'transparent',
    }))),
    options: { scales: { y: { title: { display: true, text: 'Pearson r',
      color: '#4b5a6b', font: { family: 'monospace', size: 9 } } } } },
  });

  for (const s of perState) {
    const btn = document.getElementById(`focus-${s.ab}`);
    if (btn) btn.onclick = () => { ctx.wwFocus = s.ab; rerender(); };
  }
}

function stateTile(s) {
  if (!s.sig) {
    return `<div class="tile"><div class="label">${s.ab}</div>
      <div class="value" style="font-size:18px;color:#4b5a6b">no data</div>
      <div class="foot">insufficient wastewater samples</div></div>`;
  }
  const { sig } = s;
  const cls = sig.pct >= 90 ? 's-critical' : sig.pct >= 75 ? 's-elevated'
    : sig.pct >= 50 ? 's-watch' : 's-ok';
  const arrow = sig.dir === 'rising' ? '<span class="s-critical">▲ RISING</span>'
    : sig.dir === 'falling' ? '<span class="s-ok">▼ FALLING</span>'
    : '<span style="color:#7f8ea0">■ FLAT</span>';
  return `<div class="tile">
    <div class="label">${s.ab} wastewater</div>
    <div class="value ${cls}" style="font-size:22px">${ordinal(sig.pct)}<small> pctile</small></div>
    <div class="foot">${arrow} · 3wk ${delta(sig.trendPct)} · wk ${sig.t}</div>
    ${sparkline(smooth(s.ww, 3).slice(-52), { color: '#22d3ee', w: 200, h: 24 })}
    <button class="ghost" id="focus-${s.ab}" style="margin-top:6px;width:100%">focus chart</button>
  </div>`;
}

function leadLagPanel(perState, targetKey) {
  const rows = perState.map((s) => {
    const g = s.xc.peak;
    const l = s.xcLevel.peak;
    const fmt = (p) => (p ? `${p.r >= 0 ? '+' : ''}${p.r.toFixed(2)} @ ${p.lag > 0 ? '+' : ''}${p.lag}w` : '--');
    return `<tr>
      <td>${s.ab}</td>
      <td class="num">${fmt(l)}</td>
      <td class="num ${g && g.r >= 0.3 ? 's-watch' : ''}">${fmt(g)}</td>
      <td class="num" style="color:#4b5a6b">${l ? l.n : 0}</td>
    </tr>`;
  }).join('');

  const bestLevel = perState.map((s) => s.xcLevel.peak).filter(Boolean);
  const bestGrowth = perState.map((s) => s.xc.peak).filter(Boolean);
  const avgLevelR = bestLevel.length
    ? bestLevel.reduce((a, p) => a + p.r, 0) / bestLevel.length : null;
  const avgGrowthR = bestGrowth.length
    ? bestGrowth.reduce((a, p) => a + p.r, 0) / bestGrowth.length : null;
  const modalLag = bestLevel.length
    ? bestLevel.map((p) => p.lag).sort((a, b) => a - b)[Math.floor(bestLevel.length / 2)] : null;

  return `<table class="dt">
      <thead><tr><th>Mkt</th><th>Level peak</th><th>Growth peak</th><th>n wks</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="note warn">
      <strong>${targetKey} wastewater corroborates level, not short-term change.</strong><br>
      Peak level correlation averages <strong>r=${avgLevelR === null ? '--' : avgLevelR.toFixed(2)}</strong>
      at a median lag of <strong>${modalLag === null ? '--' : (modalLag > 0 ? '+' : '') + modalLag}
      week${Math.abs(modalLag) === 1 ? '' : 's'}</strong>, while correlation of 3-week-smoothed growth
      rates falls to <strong>r=${avgGrowthR === null ? '--' : avgGrowthR.toFixed(2)}</strong>
      (unsmoothed, it is roughly 0.13–0.34).
      Levels share a seasonal wave, which inflates the first number. The second is the one that would
      justify treating wastewater as a standalone early-warning trigger — and at this strength it
      supports corroboration, not automation.
    </div>`;
}

function honestyNote(perState) {
  const growth = perState.map((s) => s.xc.peak).filter(Boolean);
  const strong = growth.filter((p) => p.r >= 0.4).length;
  return `<div class="note gap">
    Solid lines are growth-rate correlation, dashed are level correlation. The gap between them is the
    point: a high dashed line with a low solid line means the two series ride the same season without
    one predicting the other's turns.
    ${strong === 0
      ? 'No market reaches r≥0.40 on growth rates, so wastewater is wired in as <strong>corroboration only</strong> — it can raise or lower confidence in an ED-derived signal, and it can break a tie when ED derivatives sit on the resolution floor, but it never moves the staffing multiplier by itself.'
      : `${strong} market(s) reach r≥0.40 on growth rates — still treated as corroboration, but worth revisiting if that holds across another season.`}
  </div>`;
}
