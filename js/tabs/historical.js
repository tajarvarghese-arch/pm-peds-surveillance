// Historical: season heatmap, YoY peak comparison, cross-pathogen correlation.
// Honest about depth -- NSSP starts 2022-09, NAAT positivity starts 2019-07.

import { panel, num, empty } from '../ui.js';
import { heatColor } from '../charts.js';
import { PATHOGENS, MARKETS, PROVENANCE_GAPS } from '../config.js';
import { isoWeek, seasonOf, correlate, pressureIndex } from '../derive.js';
import { noteGap } from '../ui.js';

export default function historical(root, ctx) {
  const edAge = ctx.db.ed_age?.data || [];
  const naat = ctx.db.naat_multi?.data || [];
  const posNat = ctx.db.pos_national?.data || [];

  const ppi = pressureIndex(edAge, 'Combined', ctx.mix);
  const depthGap = PROVENANCE_GAPS.find((g) => g.wanted === '10-year history');

  root.innerHTML = `
    ${panel('Depth of record', 'what history actually exists',
      `<div class="grid g3">
        ${depthTile('NSSP ED visits', '7xva-uux8 / vjzj-u7u8', '2022-09-25', ppi.length)}
        ${depthTile('NAAT positivity', 'rgnm-fkqb', '2019-07-06', naat.length)}
        ${depthTile('Big-three positivity', 'seuz-s2cv', '2022-10-01', posNat.length)}
      </div>
      ${noteGap(depthGap)}`)}

    <div style="height:10px"></div>

    ${panel('Season × week heatmap — pediatric pressure index',
      `${new Set(ppi.map((p) => seasonOf(p.t))).size} seasons`,
      heatmap(ppi))}

    <div style="height:10px"></div>

    <div class="grid g2">
      ${panel('Season peaks', 'max weekly value per season', peaks(ppi))}
      ${panel('Cross-pathogen correlation', 'Pearson r over overlapping weeks',
        corrMatrix(naat, posNat, ctx.region))}
    </div>
  `;
}

function depthTile(name, ds, start, n) {
  const yrs = ((Date.now() - new Date(start + 'T00:00:00Z')) / (365.25 * 86400000));
  return `<div class="tile">
    <div class="label">${name}</div>
    <div class="value" style="font-size:20px">${yrs.toFixed(1)}<small> yrs</small></div>
    <div class="foot">${ds} · from ${start} · ${n} rows</div>
  </div>`;
}

function heatmap(points) {
  if (!points.length) return empty('no index data');
  const bySeason = new Map();
  for (const p of points) {
    const s = seasonOf(p.t);
    if (!bySeason.has(s)) bySeason.set(s, new Map());
    bySeason.get(s).set(isoWeek(p.t), p.v);
  }
  const seasons = [...bySeason.keys()].sort();
  const axis = [...Array(26).keys()].map((i) => i + 27)
    .concat([...Array(26).keys()].map((i) => i + 1));
  const all = points.map((p) => p.v);
  const max = Math.max(...all);
  const min = Math.min(...all);

  // minmax(0, 1fr) not 1fr -- a bare 1fr keeps an automatic min-content floor,
  // so the track refuses to shrink and the grid overflows its panel.
  const cols = 'grid-template-columns:repeat(52,minmax(0,1fr));gap:1px';
  const rows = seasons.map((s) => {
    const m = bySeason.get(s);
    const cells = axis.map((w) => {
      const v = m.get(w);
      const t = v == null ? null : (v - min) / (max - min || 1);
      const title = v == null ? `${s} w${w}: no data` : `${s} w${w}: ${v.toFixed(2)}%`;
      return `<div class="heat-cell" style="background:${heatColor(t)}" title="${title}"></div>`;
    }).join('');
    return `<div class="heat-row-label">${s}</div>
            <div style="display:grid;${cols}">${cells}</div>`;
  }).join('');

  const monthTicks = ['Jul', 'Sep', 'Nov', 'Jan', 'Mar', 'May'];
  return `<div class="scroll-x">
      <div>
        <div style="display:grid;grid-template-columns:52px minmax(0,1fr);gap:1px 0;align-items:center">${rows}</div>
        <div style="display:grid;grid-template-columns:52px minmax(0,1fr);margin-top:4px">
          <div></div>
          <div style="display:flex;justify-content:space-between;font-size:9px;color:#4b5a6b">
            ${monthTicks.map((m) => `<span>${m}</span>`).join('')}
          </div>
        </div>
      </div>
    </div>
    <div class="note">Scale ${min.toFixed(2)}% → ${max.toFixed(2)}%. Week-of-season axis runs w27→w26.
    Only ${seasons.length} seasons exist; a "typical year" cannot be inferred from this yet.</div>`;
}

function peaks(points) {
  if (!points.length) return empty('no index data');
  const bySeason = new Map();
  for (const p of points) {
    const s = seasonOf(p.t);
    if (!bySeason.has(s)) bySeason.set(s, []);
    bySeason.get(s).push(p);
  }
  const rows = [...bySeason.entries()].sort().map(([s, pts]) => {
    const peak = pts.reduce((a, b) => (b.v > a.v ? b : a));
    return { s, peak: peak.v, when: peak.t, week: isoWeek(peak.t), n: pts.length };
  });
  const max = Math.max(...rows.map((r) => r.peak));
  const complete = 52;
  return `<table class="dt">
    <thead><tr><th>Season</th><th>Peak</th><th>Peak wk</th><th>Date</th><th style="text-align:left">vs max</th></tr></thead>
    <tbody>${rows.map((r) => `<tr>
      <td>${r.s}${r.n < complete ? ' <span style="color:#fbbf24">*</span>' : ''}</td>
      <td class="num">${num(r.peak, 2, '%')}</td>
      <td class="num">w${r.week}</td>
      <td class="num" style="color:#7f8ea0">${r.when}</td>
      <td style="text-align:left"><div style="height:8px;width:${((r.peak / max) * 100).toFixed(0)}%;background:#22d3ee"></div></td>
    </tr>`).join('')}</tbody></table>
    <div class="note"><span class="s-watch">*</span> partial season — fewer than 52 weeks observed,
    so the peak may not have happened yet (or the record starts mid-season).</div>`;
}

function corrMatrix(naat, posNat, region) {
  const series = {};
  for (const k of ['COVID-19', 'Influenza', 'RSV']) {
    series[k] = posNat.map((r) => ({ t: r.week, v: r[k] })).filter((p) => p.v != null);
  }
  for (const k of ['PIV', 'HMPV', 'Adenovirus', 'RV/EV']) {
    series[k] = naat.map((r) => ({ t: r.week, v: r[`${region}|${k}`] })).filter((p) => p.v != null);
  }
  const keys = Object.keys(series).filter((k) => series[k].length > 8);
  if (keys.length < 2) return empty('insufficient overlap');

  const head = keys.map((k) => `<th>${PATHOGENS[k]?.label || k}</th>`).join('');
  const rows = keys.map((a) => {
    const cells = keys.map((b) => {
      if (a === b) return `<td class="num" style="color:#4b5a6b">1.00</td>`;
      const { r, n } = correlate(series[a], series[b]);
      if (r === null) return `<td class="num" style="color:#4b5a6b">--</td>`;
      const mag = Math.abs(r);
      const col = r > 0 ? `rgba(239,68,68,${(mag * 0.55).toFixed(2)})`
                        : `rgba(74,222,128,${(mag * 0.55).toFixed(2)})`;
      return `<td class="num" style="background:${col}" title="n=${n} weeks">${r.toFixed(2)}</td>`;
    }).join('');
    return `<tr><td>${PATHOGENS[a]?.label || a}</td>${cells}</tr>`;
  }).join('');

  return `<table class="dt"><thead><tr><th></th>${head}</tr></thead><tbody>${rows}</tbody></table>
    <div class="note">Red = co-move, green = anti-correlate. Computed only on weeks where both series
    exist. Big-three rows are national; secondary rows are ${region} — mixed geography, so read these
    as loose co-seasonality, not a causal signal.</div>`;
}
