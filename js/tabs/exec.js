// Executive summary: one screen that answers "do I need more staff soon?"

import { panel, tile, num, delta, levelBadge, labelsFrom, valuesFrom, empty } from '../ui.js';
import { line, hexA, sparkline } from '../charts.js';
import { PATHOGENS, PED_AGES, MARKETS } from '../config.js';
import { pressureIndex, staffing, d1, d2, seasonalBands, isoWeek, seasonOf, percentileRank,
  indexQuantum, wastewaterSignal, corroborate, quantile } from '../derive.js';
import { wwSeries } from './wastewater.js';
import { series, toWeekly, fmtDate } from '../data.js';
import { renderIso, attachOrbit } from '../iso3d.js';
import { rerender } from '../app.js';

// Week-of-season axis: respiratory seasons run w27 -> w26 of the next year.
const SEASON_AXIS = [...Array(26).keys()].map((i) => i + 27)
  .concat([...Array(26).keys()].map((i) => i + 1));

const MONTH_TICKS = [
  { at: 0, label: 'Jul' }, { at: 9, label: 'Sep' }, { at: 18, label: 'Nov' },
  { at: 27, label: 'Jan' }, { at: 35, label: 'Mar' }, { at: 44, label: 'May' },
];

/** Group the index into {season -> Map(weekOfSeason -> value)}. */
function bySeasonMap(points) {
  const m = new Map();
  for (const p of points) {
    const s = seasonOf(p.t);
    if (!m.has(s)) m.set(s, new Map());
    m.get(s).set(isoWeek(p.t), p.v);
  }
  return m;
}

/**
 * Deviation of the current season against the median of prior seasons, week by
 * week, over the weeks that actually overlap. With a 3-week-old season this is
 * the only defensible comparison -- a whole-season average would be comparing a
 * summer stub to four full winters.
 */
function seasonDeviation(seasons, currentKey) {
  const cur = seasons.get(currentKey);
  const priors = [...seasons.entries()].filter(([k]) => k !== currentKey).map(([, v]) => v);
  if (!cur || !priors.length) return null;
  const rows = [];
  for (const w of [...cur.keys()].sort((a, b) => SEASON_AXIS.indexOf(a) - SEASON_AXIS.indexOf(b))) {
    const vals = priors.map((p) => p.get(w)).filter((v) => v != null).sort((a, b) => a - b);
    if (!vals.length) continue;
    const med = quantile(vals, 0.5);
    rows.push({
      w, cur: cur.get(w), med, n: vals.length,
      lo: vals[0], hi: vals[vals.length - 1],
      dev: med > 0 ? ((cur.get(w) - med) / med) * 100 : null,
    });
  }
  if (!rows.length) return null;
  const devs = rows.map((r) => r.dev).filter((v) => v !== null);
  return {
    rows,
    latest: rows[rows.length - 1],
    mean: devs.reduce((a, b) => a + b, 0) / devs.length,
    widening: devs.length > 1 && devs[devs.length - 1] < devs[0],
  };
}

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

    ${topographyPanel(ppi)}

    <div style="height:10px"></div>

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

  mountIso(ctx);

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

/**
 * Season topography: one ridge per season receding into depth, plus a dashed
 * ghost ridge carrying the prior-season median so the current season can be
 * read against expectation directly in the geometry.
 */
function topographyPanel(ppi) {
  const seasons = bySeasonMap(ppi);
  const keys = [...seasons.keys()].sort();
  if (keys.length < 2) return panel('Season topography', '', empty('need at least two seasons'));
  const currentKey = keys[keys.length - 1];
  const priorKeys = keys.slice(0, -1);
  const dev = seasonDeviation(seasons, currentKey);

  // Prior-season median at every week of the season.
  const ghost = new Map();
  for (const w of SEASON_AXIS) {
    const vals = priorKeys.map((k) => seasons.get(k).get(w)).filter((v) => v != null)
      .sort((a, b) => a - b);
    if (vals.length) ghost.set(w, quantile(vals, 0.5));
  }

  const maxV = Math.max(...ppi.map((p) => p.v));

  // Older seasons recede in brightness as well as depth.
  const ridges = priorKeys.map((k, i) => {
    const t = priorKeys.length === 1 ? 1 : i / (priorKeys.length - 1);
    const a = 0.30 + t * 0.45;
    return {
      key: k, label: k, values: seasons.get(k),
      color: `rgba(127,142,160,${a.toFixed(2)})`,
      fill: `rgba(45,63,82,${(0.18 + t * 0.22).toFixed(2)})`,
      width: 0.9, current: false,
    };
  });
  ridges.push({
    key: 'median', label: 'prior median', values: ghost,
    color: 'rgba(251,191,36,0.85)', fill: 'rgba(251,191,36,0.07)',
    width: 1.1, dash: '2.5 2', current: false,
  });
  ridges.push({
    key: currentKey, label: currentKey, values: seasons.get(currentKey),
    color: '#22d3ee', fill: 'rgba(34,211,238,0.22)', width: 1.8, current: true,
  });

  const devCls = !dev ? '' : dev.latest.dev < -25 ? 's-ok'
    : dev.latest.dev > 25 ? 's-critical' : 's-watch';

  const summary = !dev ? '' : `
    <div class="grid g3" style="margin-bottom:8px">
      ${tile('vs prior-season median', `${dev.latest.dev > 0 ? '+' : ''}${dev.latest.dev.toFixed(0)}%`,
        `week ${dev.latest.w} · ${num(dev.latest.cur, 2, '%')} vs ${num(dev.latest.med, 2, '%')} expected`,
        devCls)}
      ${tile('season to date', `${dev.mean > 0 ? '+' : ''}${dev.mean.toFixed(0)}%`,
        `mean across ${dev.rows.length} overlapping week${dev.rows.length === 1 ? '' : 's'}`, devCls)}
      ${tile('gap direction', dev.widening
        ? '<span class="s-ok" style="font-size:17px">WIDENING</span>'
        : '<span class="s-watch" style="font-size:17px">NARROWING</span>',
        dev.widening ? 'running further below prior years each week'
                     : 'converging toward prior years', '')}
    </div>`;

  const devTable = !dev ? '' : `
    <table class="dt">
      <thead><tr><th>Wk</th><th>${currentKey}</th><th>Prior median</th><th>Prior range</th><th>Deviation</th><th>n</th></tr></thead>
      <tbody>${dev.rows.map((r) => `<tr>
        <td>w${r.w}</td>
        <td class="num">${num(r.cur, 3, '%')}</td>
        <td class="num" style="color:#fbbf24">${num(r.med, 3, '%')}</td>
        <td class="num" style="color:#4b5a6b">${num(r.lo, 2)}–${num(r.hi, 2)}</td>
        <td class="num ${r.dev < -25 ? 's-ok' : r.dev > 25 ? 's-critical' : 's-watch'}">
          ${r.dev > 0 ? '+' : ''}${r.dev.toFixed(0)}%</td>
        <td class="num" style="color:#4b5a6b">${r.n}</td>
      </tr>`).join('')}</tbody>
    </table>`;

  window.__isoModel = { axis: SEASON_AXIS, ridges, maxV, monthTicks: MONTH_TICKS };

  return `<section class="panel">
    <h2>Season topography — pediatric pressure index
      <span class="sub">${keys.length} seasons · drag to orbit</span></h2>
    <div class="panel-body">
      <div class="grid g-2-1">
        <div>
          <div id="iso-host" style="height:340px"></div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px">
            <button class="ghost" data-iso="-28,58">default</button>
            <button class="ghost" data-iso="0,80">plan</button>
            <button class="ghost" data-iso="-60,35">raking</button>
            <button class="ghost" data-iso="0,22">side</button>
            <span style="margin-left:auto;color:#4b5a6b;font-size:10px;align-self:center">
              drag the scene to rotate</span>
          </div>
        </div>
        <div>
          ${summary}
          <div class="scroll-y" style="max-height:210px">${devTable}</div>
        </div>
      </div>
      <div class="note">Each ridge is one season on a week-of-season axis (w27→w26). Depth is the only
      thing the third dimension encodes — it is not decoration. The dashed amber ridge is the
      <strong>median of the ${priorKeys.length} prior seasons</strong>, placed directly behind the
      current season so the gap between them is the deviation. Older seasons fade with depth.</div>
      ${dev && dev.rows.length < 6 ? `<div class="note warn">The ${currentKey} season is only
      ${dev.rows.length} week${dev.rows.length === 1 ? '' : 's'} old. The deviation is real but rests on
      a short overlap, and summer weeks sit near the floor of the index where small absolute moves read
      as large percentages.</div>` : ''}
    </div>
  </section>`;
}

function mountIso(ctx) {
  const host = document.getElementById('iso-host');
  if (!host || !window.__isoModel) return;
  ctx.iso ||= { yaw: -28, pitch: 58 };
  const draw = () => {
    const svg = renderIso(host, window.__isoModel, ctx.iso);
    attachOrbit(svg, ctx.iso, () => draw());
  };
  draw();
  document.querySelectorAll('[data-iso]').forEach((b) => {
    b.onclick = () => {
      const [y, p] = b.dataset.iso.split(',').map(Number);
      ctx.iso.yaw = y; ctx.iso.pitch = p;
      draw();
    };
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
