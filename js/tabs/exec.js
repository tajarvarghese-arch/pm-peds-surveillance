// Executive summary: one screen that answers "do I need more staff soon?"

import { panel, tile, num, delta, levelBadge, labelsFrom, valuesFrom, empty } from '../ui.js';
import { line, hexA, sparkline } from '../charts.js';
import { PATHOGENS, PED_AGES, MARKETS } from '../config.js';
import { pressureIndex, staffing, d1, d2, seasonalBands, isoWeek, seasonOf, percentileRank,
  indexQuantum, wastewaterSignal, corroborate } from '../derive.js';
import { wwSeries } from './wastewater.js';
import { series, toWeekly, fmtDate } from '../data.js';

export default function exec(root, ctx) {
  const edAge = ctx.db.ed_age?.data || [];
  const edState = ctx.db.ed_state?.data || [];
  const posNat = ctx.db.pos_national?.data || [];
  const naat = ctx.db.naat_multi?.data || [];
  const ari = ctx.db.ari_level?.data || [];

  if (!edAge.length) { root.innerHTML = empty('ed_age snapshot missing — run scripts/fetch_data.py'); return; }

  const quantum = indexQuantum(ctx.mix);
  const ppi = pressureIndex(edAge, 'Combined', ctx.mix);
  const alert = staffing(ppi, quantum);
  const first = d1(ppi, quantum);
  const second = d2(first);
  const cur = ppi.at(-1);

  const wwSignals = Object.fromEntries(MARKETS.states.map((full) => {
    const ab = MARKETS.abbr[full];
    return [ab, wastewaterSignal(wwSeries(ctx.db, 'ww_covid', ab))];
  }));
  const corr = corroborate(alert, wwSignals);

  // --- headline tiles -----------------------------------------------------
  const tiles = [
    tile(
      'Pediatric Pressure Index <span class="assumption">assumption</span>',
      `${num(cur?.v, 2)}<small>% ED visits</small>`,
      `visit-mix weighted &lt;1/1-4/5-17 · wk ending ${fmtDate(cur?.t)}`,
      `s-${alert.tier.class}`
    ),
    tile(
      'Staffing signal',
      `${levelBadge(alert.tier.name, alert.tier.class)} <span style="font-size:20px">${alert.tier.mult.toFixed(1)}×</span>`,
      alert.reason,
      ''
    ),
    tile('d1 · week over week', delta(alert.d1, { noisy: alert.noisy }),
         alert.noisy
           ? `move ≤ 1 reporting tick (${quantum.toFixed(3)}pp) — not a trend`
           : 'rate of change in the index', ''),
    tile('d2 · acceleration', delta(alert.d2, { suffix: 'pp', noisy: alert.noisy }),
         alert.noisy ? 'suppressed at resolution floor'
           : alert.d2 > 0 ? 'curve bending upward' : 'curve flattening or bending down', ''),
    tile('Wastewater check', levelBadge(corr.verdict, corr.cls),
         'independent signal · advisory only', ''),
  ];

  // --- season overlay -----------------------------------------------------
  const bands = seasonalBands(ppi);
  const bySeason = new Map();
  for (const p of ppi) {
    const s = seasonOf(p.t);
    if (!bySeason.has(s)) bySeason.set(s, []);
    bySeason.get(s).push({ w: isoWeek(p.t), v: p.v, t: p.t });
  }
  const seasons = [...bySeason.keys()].sort();
  const curSeason = seasons.at(-1);
  const prevSeason = seasons.at(-2);

  // Plot on a week-of-season axis (27..52,1..26)
  const axis = [...Array(26).keys()].map((i) => i + 27).concat([...Array(26).keys()].map((i) => i + 1));
  const pick = (s) => {
    const m = new Map((bySeason.get(s) || []).map((p) => [p.w, p.v]));
    return axis.map((w) => (m.has(w) ? +m.get(w).toFixed(3) : null));
  };
  const bandLo = axis.map((w) => (bands.get(w) ? +bands.get(w).p25.toFixed(3) : null));
  const bandHi = axis.map((w) => (bands.get(w) ? +bands.get(w).p75.toFixed(3) : null));
  const nMin = Math.min(...[...bands.values()].map((b) => b.n));
  const nMax = Math.max(...[...bands.values()].map((b) => b.n));

  // --- pathogen status strip ---------------------------------------------
  const statusRows = pathogenStatus(posNat, naat, edAge, ctx.region);

  root.innerHTML = `
    <div class="grid g5" style="margin-bottom:10px">${tiles.join('')}</div>
    <div class="note" style="margin:-4px 0 10px">${corr.detail}</div>

    <div class="grid g-2-1" style="margin-bottom:10px">
      ${panel('Season overlay — pediatric pressure index',
        `p25–p75 band from ${seasons.length} seasons (n=${nMin}–${nMax}/wk)`,
        `<div class="chart-wrap tall"><canvas id="c-overlay"></canvas></div>
         <div class="note warn">Bands are computed over <strong>${seasons.length} seasons</strong>, not ten.
         NSSP ED surveillance begins 2022-09-25. A p75 built on ${nMin}–${nMax} observations per week
         is a rough envelope, not a stable percentile.</div>`)}

      ${panel('Market activity level', 'CDC ARI activity · current week only',
        marketLevels(ari, edState))}
    </div>

    <div class="grid g2">
      ${panel('Pathogen status', `positivity + ED share · ${ctx.region}`,
        `<div class="scroll-y">${statusRows}</div>`, { tight: true })}

      ${panel('Pediatric age bands', 'national ED %visits · combined respiratory',
        `<div class="chart-wrap"><canvas id="c-ages"></canvas></div>
         <div class="note">Age bands are published <strong>nationally only</strong>. State feeds carry no age
         breakout, so these are never blended with the NY/NJ/CT lines on the Geography tab.</div>`)}
    </div>
  `;

  // overlay chart
  const ds = [
    { label: 'p25–p75', data: bandLo, borderColor: 'transparent', backgroundColor: 'transparent',
      pointRadius: 0, fill: false },
    { label: `${seasons.length}-season p25–p75`, data: bandHi, borderColor: 'transparent',
      backgroundColor: hexA('#22d3ee', 0.10), pointRadius: 0, fill: '-1' },
  ];
  if (prevSeason) {
    ds.push({ label: prevSeason, data: pick(prevSeason), borderColor: '#7f8ea0',
              borderDash: [4, 3], backgroundColor: 'transparent' });
  }
  ds.push({ label: `${curSeason} (current)`, data: pick(curSeason), borderColor: '#22d3ee',
            borderWidth: 2.2, backgroundColor: 'transparent' });

  line(document.getElementById('c-overlay'), {
    labels: axis.map((w) => `w${w}`),
    datasets: ds,
    options: { scales: { y: { title: { display: true, text: '% ED visits',
      color: '#4b5a6b', font: { family: 'monospace', size: 9 } } } } },
  });

  // age band chart
  const recent = edAge.slice(-78);
  line(document.getElementById('c-ages'), {
    labels: labelsFrom(recent.map((r) => ({ t: r.week })), 'year'),
    datasets: PED_AGES.map((age, i) => ({
      label: age,
      data: recent.map((r) => r[`Combined|${age}`] ?? null),
      borderColor: ['#ef4444', '#f97316', '#22d3ee'][i],
      backgroundColor: 'transparent',
    })),
  });
}

function marketLevels(ari, edState) {
  const row = ari.at(-1);
  const latest = edState.at(-1);
  if (!row) return empty('no activity level snapshot');
  const map = { 'Very Low': 'ok', Low: 'ok', Moderate: 'watch', High: 'elevated', 'Very High': 'critical' };
  const cells = MARKETS.states.map((s) => {
    const lvl = row[s] || '--';
    const cls = map[lvl] || 'ok';
    const ariPct = latest?.[`${s}|ARI`];
    // 28-day ARI sparkline for that state
    const hist = edState.slice(-28).map((r) => ({ t: r.date, v: r[`${s}|ARI`] })).filter((p) => p.v != null);
    return `<div style="padding:8px 0;border-bottom:1px solid #1e2936">
      <div style="display:flex;align-items:center;gap:8px">
        <strong>${MARKETS.abbr[s]}</strong>
        ${levelBadge(lvl, cls)}
        <span style="margin-left:auto;font-variant-numeric:tabular-nums">${num(ariPct, 2, '%')} ARI</span>
      </div>
      ${sparkline(hist, { color: '#22d3ee', w: 200, h: 24 })}
    </div>`;
  }).join('');
  return `${cells}<div class="note">Activity level is a CDC <em>snapshot</em> dataset (f3zz-zga5) —
    it is overwritten weekly and carries no history. Sparklines are 28-day all-ages ARI ED share.</div>`;
}

function pathogenStatus(posNat, naat, edAge, region) {
  const rows = [];
  const push = (name, val, prev, src, extra = '') => {
    const p = PATHOGENS[name];
    const chg = prev != null && prev > 0.05 ? ((val - prev) / prev) * 100 : null;
    rows.push(`<tr>
      <td><span style="color:${p?.color || '#94a3b8'}">■</span> ${p?.label || name}</td>
      <td class="num">${num(val, 2, '%')}</td>
      <td class="num">${delta(chg)}</td>
      <td style="text-align:left;color:#4b5a6b;font-size:10px">${src}${extra}</td>
    </tr>`);
  };

  const nLast = posNat.at(-1), nPrev = posNat.at(-2);
  if (nLast) {
    for (const k of ['COVID-19', 'Influenza', 'RSV']) {
      push(k, nLast[k], nPrev?.[k], 'seuz-s2cv national positivity');
    }
  }
  const mLast = naat.at(-1), mPrev = naat.at(-2);
  if (mLast) {
    for (const k of ['PIV', 'HMPV', 'Adenovirus', 'RV/EV', 'HCOV']) {
      push(k, mLast[`${region}|${k}`], mPrev?.[`${region}|${k}`], `rgnm-fkqb ${region}`);
    }
  }
  rows.push(`<tr>
    <td><span style="color:#f97316">■</span> iGAS / STREP A</td>
    <td class="num" colspan="2" style="color:#4b5a6b">annual only</td>
    <td style="text-align:left;color:#4b5a6b;font-size:10px">ABCs 9y49-tura — no weekly feed exists</td>
  </tr>`);

  return `<table class="dt">
    <thead><tr><th>Pathogen</th><th>Latest</th><th>WoW</th><th style="text-align:left">Source</th></tr></thead>
    <tbody>${rows.join('')}</tbody></table>`;
}
