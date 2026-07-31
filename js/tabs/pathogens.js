// Per-pathogen deep dive: positivity, ED share, hospitalisation severity.

import { panel, num, delta, empty, labelsFrom, valuesFrom } from '../ui.js';
import { line, hexA } from '../charts.js';
import { PATHOGENS, MARKETS } from '../config.js';
import { d1, d2, percentileRank } from '../derive.js';
import { rerender } from '../app.js';
import { fmtDate } from '../data.js';

export default function pathogens(root, ctx) {
  const naat = ctx.db.naat_multi?.data || [];
  const posNat = ctx.db.pos_national?.data || [];
  const respnet = ctx.db.respnet?.data || [];
  const igas = ctx.db.igas?.data || [];

  root.innerHTML = `
    <div class="controls">
      <label>HHS region
        <select id="sel-region">
          ${MARKETS.regions.map((r) => `<option ${r === ctx.region ? 'selected' : ''}>${r}</option>`).join('')}
        </select>
      </label>
      <span style="color:#4b5a6b;font-size:10.5px">${MARKETS.regionNote[ctx.region] || ''}</span>
      <span style="margin-left:auto;color:#4b5a6b;font-size:10.5px">
        positivity = NAAT % positive · ED share = % of pediatric ED visits
      </span>
    </div>

    <div class="grid g2" style="margin-bottom:10px">
      ${panel('Big three — national positivity', 'seuz-s2cv · only live flu source',
        `<div class="chart-wrap tall"><canvas id="c-big3"></canvas></div>`)}
      ${panel(`Secondary viruses — ${ctx.region}`, 'rgnm-fkqb · NAAT % positive',
        `<div class="chart-wrap tall"><canvas id="c-sec"></canvas></div>
         <div class="note">This feed carries <strong>no influenza</strong>. There is no HHS-region flu
         positivity dataset published; regional flu must be read off ED visit share instead.</div>`)}
    </div>

    <div class="grid g2" style="margin-bottom:10px">
      ${panel('Pediatric hospitalisation rate', 'RESP-NET kvib-3txy · per 100k · weekly',
        `<div class="chart-wrap"><canvas id="c-hosp"></canvas></div>
         <div class="note">Severity denominator: what share of community spread actually converts to
         admission. Rising ED share with flat hospitalisation = volume without acuity.</div>`)}
      ${panel('iGAS / Group A Strep burden', 'ABCs 9y49-tura · ANNUAL',
        igasPanel(igas))}
    </div>

    ${panel('Pathogen scorecard', `${ctx.region} · latest week`,
      scorecard(naat, posNat, ctx.region), { tight: true })}
  `;

  document.getElementById('sel-region').onchange = (e) => {
    ctx.region = e.target.value;
    rerender();
  };

  // big three
  const recent = posNat.slice(-104);
  line(document.getElementById('c-big3'), {
    labels: labelsFrom(recent.map((r) => ({ t: r.week })), 'year'),
    datasets: ['COVID-19', 'Influenza', 'RSV'].map((k) => ({
      label: PATHOGENS[k].label,
      data: recent.map((r) => r[k] ?? null),
      borderColor: PATHOGENS[k].color,
      backgroundColor: hexA(PATHOGENS[k].color, 0.06),
      fill: true,
    })),
  });

  // secondary
  const rec2 = naat.slice(-104);
  const secKeys = ['PIV', 'HMPV', 'Adenovirus', 'RV/EV', 'HCOV'];
  line(document.getElementById('c-sec'), {
    labels: labelsFrom(rec2.map((r) => ({ t: r.week })), 'year'),
    datasets: secKeys.map((k) => ({
      label: PATHOGENS[k].label,
      data: rec2.map((r) => r[`${ctx.region}|${k}`] ?? null),
      borderColor: PATHOGENS[k].color,
      backgroundColor: 'transparent',
    })),
  });

  // hospitalisation
  const rec3 = respnet.slice(-104);
  const hospKeys = [
    ['Combined|0-<1 yr', '#ef4444', '<1 yr all'],
    ['Combined|1-4 yr', '#f97316', '1-4 yr all'],
    ['Combined|5-17 yr', '#22d3ee', '5-17 yr all'],
    ['RSV-NET|0-<1 yr', '#4ade80', '<1 yr RSV'],
    ['COVID-NET|0-<1 yr', '#a78bfa', '<1 yr COVID'],
  ];
  line(document.getElementById('c-hosp'), {
    labels: labelsFrom(rec3.map((r) => ({ t: r.date })), 'year'),
    datasets: hospKeys.map(([k, c, lab]) => ({
      label: lab,
      data: rec3.map((r) => r[k] ?? null),
      borderColor: c,
      backgroundColor: 'transparent',
      borderDash: k.startsWith('Combined') ? [] : [3, 3],
    })),
  });
}

function scorecard(naat, posNat, region) {
  const build = (name, points) => {
    if (!points.length) return null;
    const f = d1(points), s = d2(f);
    const cur = points.at(-1);
    return {
      name,
      value: cur.v,
      d1: f.at(-1)?.v ?? null,
      d2: s.at(-1)?.v ?? null,
      pct: percentileRank(points, cur.v),
      n: points.length,
      t: cur.t,
    };
  };

  const rows = [];
  for (const k of ['COVID-19', 'Influenza', 'RSV']) {
    const pts = posNat.map((r) => ({ t: r.week, v: r[k] })).filter((p) => p.v != null);
    const r = build(k, pts);
    if (r) rows.push({ ...r, src: 'national' });
  }
  for (const k of ['PIV', 'HMPV', 'Adenovirus', 'RV/EV', 'HCOV']) {
    const pts = naat.map((r) => ({ t: r.week, v: r[`${region}|${k}`] })).filter((p) => p.v != null);
    const r = build(k, pts);
    if (r) rows.push({ ...r, src: region });
  }

  if (!rows.length) return empty('no pathogen data');

  return `<table class="dt">
    <thead><tr>
      <th>Pathogen</th><th>% positive</th><th>d1 WoW</th><th>d2 accel</th>
      <th>Pctile</th><th>n wks</th><th style="text-align:left">Scope</th>
    </tr></thead>
    <tbody>${rows.map((r) => {
      const p = PATHOGENS[r.name];
      const hot = r.pct >= 90 ? 's-critical' : r.pct >= 75 ? 's-elevated' : r.pct >= 50 ? 's-watch' : 's-ok';
      return `<tr>
        <td><span style="color:${p?.color}">■</span> ${p?.label || r.name}</td>
        <td class="num">${num(r.value, 2, '%')}</td>
        <td class="num">${delta(r.d1)}</td>
        <td class="num">${delta(r.d2, { suffix: 'pp' })}</td>
        <td class="num ${hot}">${num(r.pct, 0)}</td>
        <td class="num" style="color:#4b5a6b">${r.n}</td>
        <td style="text-align:left;color:#4b5a6b;font-size:10px">${r.src}</td>
      </tr>`;
    }).join('')}</tbody></table>
    <div class="note">Percentile is rank against that series' own available history — not a
    10-year norm. Column <em>n wks</em> is the sample it was computed from.</div>`;
}

function igasPanel(igas) {
  if (!igas.length) return empty('no ABCs data');
  const cases = igas
    .filter((r) => r.topic?.includes('Number of cases') && r.by === 'ALL')
    .reduce((m, r) => {
      m[r.year] = (m[r.year] || 0) + r.value;
      return m;
    }, {});
  const years = Object.keys(cases).map(Number).sort((a, b) => a - b);
  if (!years.length) return empty('no case counts');
  const last = years.at(-1);
  const vals = years.map((y) => cases[y]);
  const peak = Math.max(...vals);
  const rows = years.slice(-12).map((y) => {
    const v = cases[y];
    const w = (v / peak) * 100;
    return `<tr>
      <td>${y}</td>
      <td class="num">${v.toLocaleString()}</td>
      <td style="text-align:left"><div style="height:8px;width:${w.toFixed(0)}%;background:#f97316"></div></td>
    </tr>`;
  }).join('');
  return `<div class="scroll-y" style="max-height:200px"><table class="dt">
    <thead><tr><th>Year</th><th>Est. cases</th><th style="text-align:left">vs peak</th></tr></thead>
    <tbody>${rows}</tbody></table></div>
    <div class="note gap">Latest ABCs year is <strong>${last}</strong>. This is an annual burden series,
    published quarterly-ish with long lag. It is deliberately <strong>not</strong> wired into the staffing
    engine — a yearly count cannot drive a weekly rota.</div>`;
}
