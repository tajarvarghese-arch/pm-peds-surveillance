// Forecast & derivatives: 8-week horizon, d1/d2 plots and table.

import { panel, num, delta, empty, labelsFrom, tile } from '../ui.js';
import { line, hexA } from '../charts.js';
import { PATHOGENS } from '../config.js';
import { pressureIndex, forecast, d1, d2, seasonalBands, isoWeek, indexQuantum }
  from '../derive.js';
import { rerender } from '../app.js';
import { fmtDate } from '../data.js';

export default function forecastTab(root, ctx) {
  const edAge = ctx.db.ed_age?.data || [];
  const posNat = ctx.db.pos_national?.data || [];

  const targets = {
    'Pediatric pressure index': pressureIndex(edAge, 'Combined', ctx.mix),
    'COVID ED share <1yr': edAge.map((r) => ({ t: r.week, v: r['COVID-19|<1 year'] })).filter((p) => p.v != null),
    'Flu ED share 5-17': edAge.map((r) => ({ t: r.week, v: r['Influenza|5-17 years'] })).filter((p) => p.v != null),
    'RSV ED share <1yr': edAge.map((r) => ({ t: r.week, v: r['RSV|<1 year'] })).filter((p) => p.v != null),
  };
  const key = ctx.fcTarget && targets[ctx.fcTarget] ? ctx.fcTarget : 'Pediatric pressure index';
  const points = targets[key];

  if (points.length < 12) { root.innerHTML = empty('insufficient history to forecast'); return; }

  // The weighted index inherits a smaller quantum than the raw 0.1pp series.
  const quantum = key === 'Pediatric pressure index' ? indexQuantum(ctx.mix) : 0.1;
  const fc = forecast(points, 8);
  const first = d1(points, quantum);
  const second = d2(first);
  const bands = seasonalBands(points);
  const nAt = (t) => bands.get(isoWeek(t))?.n ?? 0;

  root.innerHTML = `
    <div class="controls">
      <label>Series
        <select id="sel-target">
          ${Object.keys(targets).map((k) => `<option ${k === key ? 'selected' : ''}>${k}</option>`).join('')}
        </select>
      </label>
      <span style="margin-left:auto;color:#4b5a6b;font-size:10.5px">
        seasonal-naive + damped momentum · horizon 8wk
      </span>
    </div>

    <div class="grid g4" style="margin-bottom:10px">
      ${tile('Current', num(points.at(-1).v, 2, '%'), `wk ending ${fmtDate(points.at(-1).t)}`)}
      ${tile('8wk ahead', num(fc.at(-1)?.v, 2, '%'), `wk ending ${fmtDate(fc.at(-1)?.t)}`)}
      ${tile('Implied change', delta(points.at(-1).v > 0.05
        ? ((fc.at(-1).v - points.at(-1).v) / points.at(-1).v) * 100 : null), 'over the horizon')}
      ${tile('Seasons behind band', `${Math.min(...fc.map((f) => f.n))}–${Math.max(...fc.map((f) => f.n))}`,
        'observations per forecast week', 's-watch')}
    </div>

    ${panel(`Forecast — ${key}`, 'shaded = observed p25–p75 for that week of year, NOT a fitted CI',
      `<div class="chart-wrap tall"><canvas id="c-fc"></canvas></div>
       <div class="note warn">This is a <strong>planning heuristic, not a calibrated model</strong>.
       With ~${Math.max(...fc.map((f) => f.n))} seasons of NSSP history the seasonal term rests on a
       handful of observations per week. The interval is the historical spread of that calendar week,
       so it does not widen with horizon the way a real predictive interval would. Treat the direction
       as the signal and the level as an estimate.</div>`)}

    <div style="height:10px"></div>

    <div class="grid g2">
      ${panel('d1 — week-over-week % change', 'rate',
        `<div class="chart-wrap"><canvas id="c-d1"></canvas></div>`)}
      ${panel('d2 — acceleration', 'change in d1, percentage points',
        `<div class="chart-wrap"><canvas id="c-d2"></canvas></div>`)}
    </div>

    <div style="height:10px"></div>

    ${panel('Derivative table', 'last 16 weeks', derivTable(points, first, second), { tight: true })}

    <div style="height:10px"></div>

    ${panel('Forecast table', '8-week horizon', fcTable(fc), { tight: true })}
  `;

  document.getElementById('sel-target').onchange = (e) => {
    ctx.fcTarget = e.target.value;
    rerender();
  };

  // forecast chart -- history tail + projection
  const tail = points.slice(-40);
  const labels = [...tail.map((p) => p.t), ...fc.map((f) => f.t)];
  const pad = new Array(tail.length - 1).fill(null);
  line(document.getElementById('c-fc'), {
    labels: labels.map((t) => {
      const d = new Date(t + 'T00:00:00Z');
      return d.toLocaleDateString('en-US', { month: 'short', day: '2-digit', timeZone: 'UTC' });
    }),
    datasets: [
      { label: 'p25 band', data: [...new Array(tail.length).fill(null), ...fc.map((f) => f.lo)],
        borderColor: 'transparent', backgroundColor: 'transparent', pointRadius: 0, fill: false },
      { label: 'historical p25–p75', data: [...new Array(tail.length).fill(null), ...fc.map((f) => f.hi)],
        borderColor: 'transparent', backgroundColor: hexA('#fbbf24', 0.12), pointRadius: 0, fill: '-1' },
      { label: 'observed', data: [...tail.map((p) => +p.v.toFixed(3)), ...new Array(fc.length).fill(null)],
        borderColor: '#22d3ee', borderWidth: 2, backgroundColor: 'transparent' },
      { label: 'forecast', data: [...pad, +tail.at(-1).v.toFixed(3), ...fc.map((f) => +f.v.toFixed(3))],
        borderColor: '#fbbf24', borderDash: [5, 3], borderWidth: 2, backgroundColor: 'transparent' },
    ],
  });

  const dLabels = (arr) => arr.map((p) => {
    const d = new Date(p.t + 'T00:00:00Z');
    return d.toLocaleDateString('en-US', { month: 'short', day: '2-digit', timeZone: 'UTC' });
  });

  const f40 = first.slice(-40);
  line(document.getElementById('c-d1'), {
    labels: dLabels(f40),
    datasets: [{
      label: 'd1 %', data: f40.map((p) => (p.v === null ? null : +p.v.toFixed(2))),
      borderColor: '#a78bfa', backgroundColor: hexA('#a78bfa', 0.08), fill: true,
    }],
    options: { plugins: { legend: { display: false } } },
  });

  const s40 = second.slice(-40);
  line(document.getElementById('c-d2'), {
    labels: dLabels(s40),
    datasets: [{
      label: 'd2 pp', data: s40.map((p) => (p.v === null ? null : +p.v.toFixed(2))),
      borderColor: '#f97316', backgroundColor: hexA('#f97316', 0.08), fill: true,
    }],
    options: { plugins: { legend: { display: false } } },
  });
}

function derivTable(points, first, second) {
  const d1map = new Map(first.map((p) => [p.t, p.v]));
  const d2map = new Map(second.map((p) => [p.t, p.v]));
  const noisyMap = new Map(first.map((p) => [p.t, p.noisy]));
  const rows = points.slice(-16).reverse().map((p) => {
    const a = d1map.get(p.t) ?? null;
    const b = d2map.get(p.t) ?? null;
    const noisy = noisyMap.get(p.t) === true;
    const state = a === null ? '--'
      : noisy ? '<span style="color:#4b5a6b">below resolution</span>'
      : a > 0 && b > 0 ? '<span class="s-critical">accelerating</span>'
      : a > 0 && b <= 0 ? '<span class="s-watch">rising, flattening</span>'
      : a <= 0 && b > 0 ? '<span class="s-watch">falling, decelerating</span>'
      : '<span class="s-ok">falling</span>';
    return `<tr>
      <td>${p.t}</td>
      <td class="num">${num(p.v, 3, '%')}</td>
      <td class="num">${delta(a, { noisy })}</td>
      <td class="num">${delta(b, { suffix: 'pp', noisy })}</td>
      <td style="text-align:left">${state}</td>
    </tr>`;
  }).join('');
  return `<table class="dt">
    <thead><tr><th>Week</th><th>Value</th><th>d1</th><th>d2</th><th style="text-align:left">Regime</th></tr></thead>
    <tbody>${rows}</tbody></table>
    <div class="note">d1 is suppressed when the prior week sits below 0.05% — at summer floors a
    week-over-week ratio produces meaningless four-digit percentages.</div>`;
}

function fcTable(fc) {
  return `<table class="dt">
    <thead><tr><th>Week ending</th><th>Point</th><th>Hist p25</th><th>Hist p75</th><th>n seasons</th></tr></thead>
    <tbody>${fc.map((f) => `<tr>
      <td>${f.t}</td>
      <td class="num">${num(f.v, 3, '%')}</td>
      <td class="num" style="color:#7f8ea0">${num(f.lo, 3, '%')}</td>
      <td class="num" style="color:#7f8ea0">${num(f.hi, 3, '%')}</td>
      <td class="num ${f.n < 3 ? 's-critical' : f.n < 4 ? 's-watch' : ''}">${f.n}</td>
    </tr>`).join('')}</tbody></table>`;
}
