// Geography: NY/NJ/CT ED share, HHS region ranking, wastewater leading signal.

import { panel, num, delta, empty, tile } from '../ui.js';
import { line, hexA, sparkline } from '../charts.js';
import { PATHOGENS, MARKETS } from '../config.js';
import { d1, d2, indexToMedian, percentileRank, ordinal } from '../derive.js';
import { toWeekly } from '../data.js';
import { rerender } from '../app.js';

const ED_PATHOGENS = ['ARI', 'COVID', 'Influenza', 'RSV'];

export default function geo(root, ctx) {
  const edState = ctx.db.ed_state?.data || [];
  const naat = ctx.db.naat_multi?.data || [];
  const wwC = ctx.db.ww_covid?.data || [];
  const wwF = ctx.db.ww_flu?.data || [];

  if (!edState.length) { root.innerHTML = empty('ed_state snapshot missing'); return; }

  const path = ED_PATHOGENS.includes(ctx.geoPathogen) ? ctx.geoPathogen : 'ARI';
  const geos = [...MARKETS.states, 'United States'];

  root.innerHTML = `
    <div class="controls">
      <label>Signal
        <select id="sel-path">
          ${ED_PATHOGENS.map((p) => `<option ${p === path ? 'selected' : ''}>${p}</option>`).join('')}
        </select>
      </label>
      <span style="color:#4b5a6b;font-size:10.5px">
        NSSP ED visit share · daily · all ages (no pediatric breakout exists at state level)
      </span>
    </div>

    <div class="grid g4" style="margin-bottom:10px">${marketTiles(edState, path)}</div>

    ${panel(`${path} ED visit share — market vs national`, 'daily, 12-month window',
      `<div class="chart-wrap tall"><canvas id="c-geo"></canvas></div>`)}

    <div style="height:10px"></div>

    <div class="grid g2">
      ${panel('HHS region ranking', 'NAAT positivity · latest week', regionRank(naat))}
      ${panel('Wastewater — indexed to own baseline', 'CDC NWSS · replaces Biobot',
        `<div class="chart-wrap"><canvas id="c-ww"></canvas></div>
         <div class="note">Plotted as % of each state's own 2-year median, not raw copies/L.
         Absolute concentrations are not comparable across states — different labs, extraction
         methods and site mixes. Indexing each state to itself is the only honest cross-read.</div>`)}
    </div>
  `;

  document.getElementById('sel-path').onchange = (e) => {
    ctx.geoPathogen = e.target.value;
    rerender();
  };

  const recent = edState.slice(-365);
  line(document.getElementById('c-geo'), {
    labels: recent.map((r) => {
      const d = new Date(r.date + 'T00:00:00Z');
      return d.toLocaleDateString('en-US', { month: 'short', day: '2-digit', timeZone: 'UTC' });
    }),
    datasets: geos.map((g, i) => ({
      label: MARKETS.abbr[g] || 'US',
      data: recent.map((r) => r[`${g}|${path}`] ?? null),
      borderColor: ['#22d3ee', '#fbbf24', '#4ade80', '#64748b'][i],
      borderWidth: g === 'United States' ? 1.2 : 1.8,
      borderDash: g === 'United States' ? [4, 3] : [],
      backgroundColor: 'transparent',
    })),
  });

  // wastewater, indexed
  const wwSeries = [];
  for (const [ds, label, dash] of [[wwC, 'COVID', []], [wwF, 'FLU A', [4, 3]]]) {
    for (const [st, color] of [['NY', '#22d3ee'], ['NJ', '#fbbf24'], ['CT', '#4ade80']]) {
      const pts = ds.map((r) => ({ t: r.week, v: r[st] })).filter((p) => p.v != null);
      if (pts.length < 8) continue;
      wwSeries.push({ label: `${st} ${label}`, pts: indexToMedian(pts), color, dash });
    }
  }
  if (wwSeries.length) {
    const allT = [...new Set(wwSeries.flatMap((s) => s.pts.map((p) => p.t)))].sort();
    line(document.getElementById('c-ww'), {
      labels: allT.map((t) => {
        const d = new Date(t + 'T00:00:00Z');
        return d.toLocaleDateString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' });
      }),
      datasets: wwSeries.map((s) => {
        const m = new Map(s.pts.map((p) => [p.t, p.v]));
        return {
          label: s.label,
          data: allT.map((t) => (m.has(t) ? +m.get(t).toFixed(1) : null)),
          borderColor: s.color, borderDash: s.dash, backgroundColor: 'transparent',
        };
      }),
      options: { scales: { y: { title: { display: true, text: '% of own median',
        color: '#4b5a6b', font: { family: 'monospace', size: 9 } } } } },
    });
  }
}

function marketTiles(edState, path) {
  return [...MARKETS.states, 'United States'].map((g) => {
    const pts = edState.map((r) => ({ t: r.date, v: r[`${g}|${path}`] })).filter((p) => p.v != null);
    if (!pts.length) return tile(MARKETS.abbr[g] || 'US', '--', 'no data');
    const wk = toWeekly(pts);
    const f = d1(wk);
    const cur = pts.at(-1);
    const pct = percentileRank(wk, wk.at(-1).v);
    const cls = pct >= 90 ? 's-critical' : pct >= 75 ? 's-elevated' : pct >= 50 ? 's-watch' : 's-ok';
    return `<div class="tile">
      <div class="label">${MARKETS.abbr[g] || 'US'} · ${path}</div>
      <div class="value ${cls}" style="font-size:22px">${num(cur.v, 2)}<small>%</small></div>
      <div class="foot">${delta(f.at(-1)?.v)} WoW · ${ordinal(pct)} pctile</div>
      ${sparkline(pts.slice(-90), { color: '#22d3ee', w: 200, h: 22 })}
    </div>`;
  }).join('');
}

function regionRank(naat) {
  const last = naat.at(-1);
  const prev = naat.at(-2);
  if (!last) return empty('no NAAT data');
  const keys = ['SARS-COV-2', 'RSV', 'PIV', 'HMPV', 'Adenovirus', 'RV/EV'];
  const rows = MARKETS.regions.map((reg) => {
    const cells = keys.map((k) => {
      const v = last[`${reg}|${k}`];
      const p = prev?.[`${reg}|${k}`];
      const chg = p != null && p > 0.05 ? ((v - p) / p) * 100 : null;
      return `<td class="num" title="${chg != null ? chg.toFixed(1) + '% WoW' : 'no prior'}">
        ${num(v, 2)}${chg != null && Math.abs(chg) > 15
          ? `<span style="color:${chg > 0 ? '#ef4444' : '#4ade80'}">${chg > 0 ? '▲' : '▼'}</span>` : ''}
      </td>`;
    }).join('');
    return `<tr><td>${reg}<br><span style="font-size:9px;color:#4b5a6b">${MARKETS.regionNote[reg]}</span></td>${cells}</tr>`;
  }).join('');
  return `<table class="dt">
    <thead><tr><th>Region</th>${keys.map((k) => `<th>${PATHOGENS[k === 'SARS-COV-2' ? 'COVID-19' : k]?.label || k}</th>`).join('')}</tr></thead>
    <tbody>${rows}</tbody></table>
    <div class="note">Region 1 = ${MARKETS.regionNote['Region 1']}; Region 2 = ${MARKETS.regionNote['Region 2']}.
    Arrows mark &gt;15% week-over-week moves. Influenza is absent — this feed does not carry it.</div>`;
}
