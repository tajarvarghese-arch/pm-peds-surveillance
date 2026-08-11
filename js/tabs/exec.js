// Executive summary: one screen that answers "do I need more staff soon?"

import { panel, tile, num, delta, levelBadge, labelsFrom, valuesFrom, empty } from '../ui.js';
import { line, bar, hexA, sparkline } from '../charts.js';
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

    ${recentPanel(ppi, quantum)}

    <div style="height:10px"></div>

    ${methodPanel(edAge, ctx, alert, quantum)}

    <div style="height:10px"></div>

    ${topographyPanel(ppi)}

    <div style="height:10px"></div>

    <div class="grid g-2-1" style="margin-bottom:10px">
      ${panel('Season overlay — pediatric pressure index',
        `p25–p75 band from ${seasons.length} seasons (n=${nMin}–${nMax}/wk)`,
        `<div style="display:flex;gap:6px;margin-bottom:6px">
           <button class="ghost" id="ov-lin" aria-pressed="${!ctx.overlayLog}">linear</button>
           <button class="ghost" id="ov-log" aria-pressed="${!!ctx.overlayLog}">log</button>
           <span style="margin-left:auto;color:#4b5a6b;font-size:10px;align-self:center">
             this series spans ~35× floor to peak</span>
         </div>
         <div class="chart-wrap tall"><canvas id="c-overlay"></canvas></div>
         <div class="note">A linear axis has to hold the winter peak, which flattens the summer floor
         into a straight line. <strong>Log scale</strong> gives proportional moves equal visual weight,
         so an off-season ramp is visible at the bottom of the range.</div>
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
  mountRecent(ppi, quantum);

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
    options: {
      scales: {
        y: {
          // Logarithmic gives proportional moves equal visual weight, which is
          // the only way an off-season ramp near 0.6% is legible on an axis
          // that must also hold a 23% winter peak.
          type: ctx.overlayLog ? 'logarithmic' : 'linear',
          title: { display: true, text: `% ED visits${ctx.overlayLog ? ' (log)' : ''}`,
            color: '#4b5a6b', font: { family: 'monospace', size: 9 } },
        },
      },
    },
  });

  const setScale = (v) => { ctx.overlayLog = v; rerender(); };
  const lin = document.getElementById('ov-lin');
  const log = document.getElementById('ov-log');
  if (lin) lin.onclick = () => setScale(false);
  if (log) log.onclick = () => setScale(true);

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
 * The season overlay is drawn on an axis that has to hold a ~23% winter peak,
 * which renders a move from 0.65% to 0.94% as a hairline -- invisible exactly
 * when it matters, because the interesting part of an off-season ramp is the
 * shape near the floor.
 *
 * Three framings of the same weeks, none of which needs a winter-scaled axis:
 * an auto-scaled recent window, the move expressed against the season's own
 * floor, and the week-over-week rate.
 */
function recentPanel(ppi, quantum) {
  if (ppi.length < 6) return '';
  const N = 14;
  const tail = ppi.slice(-N);
  const cur = tail.at(-1).v;
  const first = tail[0].v;

  // Trough of the current season, so "off the floor" means something specific.
  const curSeason = seasonOf(ppi.at(-1).t);
  const thisSeason = ppi.filter((p) => seasonOf(p.t) === curSeason);
  const floorPts = thisSeason.length >= 3 ? thisSeason : ppi.slice(-26);
  const floor = Math.min(...floorPts.map((p) => p.v));
  const offFloor = floor > 0 ? ((cur / floor) - 1) * 100 : null;

  const f = d1(tail, quantum);
  const rises = f.filter((p) => p.v !== null && p.v > 0 && !p.noisy).length;
  let streak = 0;
  for (let i = f.length - 1; i >= 0; i--) {
    if (f[i].v !== null && f[i].v > 0) streak++; else break;
  }

  return `<section class="panel" style="border-color:${streak >= 3 ? '#f97316' : 'var(--line)'}">
    <h2>Recent trajectory — is it actually moving?
      <span class="sub">last ${N} weeks, axis scaled to the window</span></h2>
    <div class="panel-body">
      <div class="grid g5" style="margin-bottom:10px">
        ${tile('Off the season floor', offFloor === null ? '--'
          : `<span class="${offFloor > 25 ? 's-elevated' : ''}">${offFloor > 0 ? '+' : ''}${offFloor.toFixed(0)}%</span>`,
          `floor was ${num(floor, 3, '%')} · now ${num(cur, 3, '%')}`)}
        ${(() => {
          // Same calendar week in prior years: is this level normal for August,
          // or is the ramp itself the anomaly?
          const byYearWeek = new Map();
          const years = new Set();
          for (const p of ppi) {
            const y = +p.t.slice(0, 4);
            byYearWeek.set(`${y}-${isoWeek(p.t)}`, p.v);
            years.add(y);
          }
          const cy = +tail.at(-1).t.slice(0, 4);
          const w = isoWeek(tail.at(-1).t);
          const priors = [...years].filter((y) => y < cy)
            .map((y) => byYearWeek.get(`${y}-${w}`))
            .filter((v) => v !== undefined).sort((a, b) => a - b);
          if (!priors.length) return tile('vs prior years', '--', 'no matching week');
          const med = quantile(priors, 0.5);
          const dev = med > 0 ? ((cur / med) - 1) * 100 : null;
          const cls = dev === null ? '' : dev < -25 ? 's-ok' : dev > 25 ? 's-critical' : 's-watch';
          return tile(`vs prior years · wk ${w}`,
            `<span class="${cls}">${dev > 0 ? '+' : ''}${dev.toFixed(0)}%</span>`,
            `median ${num(med, 3, '%')} across ${priors.length} yr${priors.length === 1 ? '' : 's'}`);
        })()}
        ${tile('Consecutive rises', `<span class="${streak >= 3 ? 's-elevated' : ''}">${streak}</span>`,
          streak >= 3 ? 'a run, not a wobble' : 'weeks up in a row')}
        ${(() => {
          // A fixed 14-week lookback straddles the spring decline and the
          // summer turn, so it reports -48% while the index is climbing. Four
          // weeks sits inside the current move and answers the actual question.
          const back = tail.length > 4 ? tail.at(-5).v : first;
          const chg = back > 0 ? (cur / back - 1) * 100 : null;
          return tile('Change over 4 wks',
            chg === null ? '--'
              : `<span class="${chg > 15 ? 's-elevated' : ''}">${chg > 0 ? '+' : ''}${chg.toFixed(0)}%</span>`,
            `${num(back, 3, '%')} → ${num(cur, 3, '%')}`);
        })()}
        ${tile('Ticks per move', (quantum > 0 && f.at(-1)?.abs)
          ? Math.abs(f.at(-1).abs / quantum).toFixed(1) : '--',
          `1 tick = ${quantum.toFixed(3)}pp · >2 is signal`)}
      </div>
      <div class="grid g2">
        <div>
          <div class="chart-wrap"><canvas id="c-recent"></canvas></div>
          <div class="note">Same calendar weeks in prior years, on an axis that fits this window only.
          Aligned by <strong>calendar week</strong>, not week of season — this lookback reaches back
          past week 27, which belongs to the previous respiratory season, so season-alignment would
          straddle a boundary and misalign every comparison.</div>
        </div>
        <div>
          <div class="chart-wrap short"><canvas id="c-recent-d1"></canvas></div>
          <div class="note">Week-over-week %. Bars inside the shaded band are within the
          reporting resolution and mean nothing.</div>
        </div>
      </div>
    </div>
  </section>`;
}

/**
 * What the index actually is, derived live from the current week rather than
 * written down once and left to rot.
 *
 * The index is this dashboard's own construct, not a CDC metric, and it carries
 * an assumption that materially moves every staffing number. Anyone reading a
 * multiplier off this page is entitled to see the arithmetic that produced it
 * without opening the source.
 */
function methodPanel(edAge, ctx, alert, quantum) {
  const last = edAge.at(-1);
  if (!last) return '';
  const total = Object.values(ctx.mix).reduce((a, b) => a + b, 0) || 1;

  const rows = PED_AGES.map((age) => {
    const v = last[`Combined|${age}`];
    const w = ctx.mix[age] ?? 0;
    return { age, v, w, contrib: v == null ? null : (v * w) / total };
  });
  const idx = rows.reduce((a, r) => a + (r.contrib ?? 0), 0);
  const simple = rows.filter((r) => r.v != null);
  const mean = simple.length ? simple.reduce((a, r) => a + r.v, 0) / simple.length : null;

  // Same week, one band, broken out by pathogen -- shows what "Combined" is.
  const band = '1-4 years';
  const parts = ['COVID-19', 'Influenza', 'RSV', 'Combined']
    .map((p) => ({ p, v: last[`${p}|${band}`] }));

  return `<section class="panel">
    <h2>What the Pediatric Pressure Index is
      <span class="sub">this dashboard's construct, not a CDC metric</span></h2>
    <div class="panel-body">
      <div style="font-size:12px;line-height:1.6;margin-bottom:10px">
        The share of <strong>pediatric emergency department visits that are respiratory</strong>,
        from CDC NSSP <code>7xva-uux8</code>, weighted across three age bands. It exists because the
        metric the original plan was keyed to — CDC ILINet's outpatient ILI % — no longer publishes a
        live feed. There is no published index of this kind to borrow, so this one is built here and
        shown in full.
      </div>

      <div class="grid g2">
        <div style="overflow-x:auto">
          <table class="dt">
            <thead><tr><th>Age band</th><th>CDC "Combined"</th><th>Weight</th><th>Contribution</th></tr></thead>
            <tbody>
              ${rows.map((r) => `<tr>
                <td>${r.age}</td>
                <td class="num">${num(r.v, 1, '%')}</td>
                <td class="num">${r.w.toFixed(2)}</td>
                <td class="num">${num(r.contrib, 4)}</td>
              </tr>`).join('')}
              <tr style="border-top:1px solid var(--line-hot)">
                <td colspan="3"><strong>Index — week ending ${last.week}</strong></td>
                <td class="num"><strong class="s-ok">${num(idx, 4, '%')}</strong></td>
              </tr>
            </tbody>
          </table>
          <div class="note">Weights are normalised, so only their ratios matter.
          The same week reads ${num(mean, 2, '%')} as a plain average of the three bands, and
          ${num(rows[0].v, 1, '%')} if you looked at infants alone — which is how much the weighting
          choice moves the answer.</div>
        </div>

        <div style="overflow-x:auto">
          <table class="dt">
            <thead><tr><th>What "Combined" contains</th><th>${band}</th></tr></thead>
            <tbody>${parts.map((x) => `<tr>
              <td>${x.p === 'Combined' ? '<strong>Combined (used here)</strong>' : x.p}</td>
              <td class="num">${num(x.v, 1, '%')}</td>
            </tr>`).join('')}</tbody>
          </table>
          <div class="note">CDC's own rollup of COVID-19, influenza and RSV. It is not every
          respiratory pathogen — parainfluenza, hMPV, adenovirus and rhino/entero are tracked
          separately on the Pathogens tab and are <strong>not</strong> in this index.</div>
        </div>
      </div>

      <div class="note warn" style="margin-top:10px">
        <span class="assumption">assumption</span>
        <strong>The weights are estimates, and they are not PM Pediatrics' real visit mix.</strong>
        No clinic-level utilisation data is public, so
        &lt;1yr ${ctx.mix['<1 year']} / 1-4yr ${ctx.mix['1-4 years']} / 5-17yr ${ctx.mix['5-17 years']}
        are an estimate of urgent-care <em>visit share</em> by age — not population share. Adjust them
        live on the Staffing tab. Supplying the real distribution is the single highest-value
        improvement available to this tool.
      </div>

      <div class="note gap">
        <strong>Two more limits worth holding against it.</strong>
        It is <strong>national</strong>: CDC publishes age bands only nationally, and the state feed
        <code>vjzj-u7u8</code> carries no age breakout — the two are never blended, so the staffing
        multiplier is a national pediatric signal and the market lines on the Geography tab are
        all-ages. And it is <strong>emergency department</strong> visits, a proxy for urgent-care
        demand rather than the same thing; the mapping from ED share to your door count is
        unvalidated.
      </div>

      <div class="note">
        Resolution: CDC reports to one decimal place, so one reporting tick moves this index by
        ${quantum.toFixed(3)}pp — about ${((quantum / (alert.value || 1)) * 100).toFixed(1)}% at the
        current level. Week-over-week changes smaller than that are rounding, not trend, and the
        staffing engine refuses to act on them.
      </div>
    </div>
  </section>`;
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

function mountRecent(ppi, quantum) {
  const host = document.getElementById('c-recent');
  if (!host) return;
  const N = 14;
  const tail = ppi.slice(-N);
  const labels = tail.map((p) => {
    const d = new Date(p.t + 'T00:00:00Z');
    return d.toLocaleDateString('en-US', { month: 'short', day: '2-digit', timeZone: 'UTC' });
  });

  // Prior years on the same axis, aligned by CALENDAR week rather than by week
  // of season. Week-of-season alignment breaks here: the current window reaches
  // back past week 27, which belongs to the previous respiratory season, so the
  // lookback would straddle a season boundary and misalign every comparison.
  const byYearWeek = new Map();
  const years = new Set();
  for (const p of ppi) {
    const y = +p.t.slice(0, 4);
    byYearWeek.set(`${y}-${isoWeek(p.t)}`, p.v);
    years.add(y);
  }
  const curYear = +tail.at(-1).t.slice(0, 4);
  const priorYears = [...years].filter((y) => y < curYear).sort((a, b) => b - a).slice(0, 3);

  // Each window point carries its own (year, week), so a window spanning a
  // year boundary still looks up the right prior-year cell.
  const cells = tail.map((p) => ({ y: +p.t.slice(0, 4), w: isoWeek(p.t) }));
  const seriesFor = (offset) => cells.map((c) => {
    const v = byYearWeek.get(`${c.y - offset}-${c.w}`);
    return v === undefined ? null : +v.toFixed(4);
  });

  const priorSeries = priorYears.map((y, i) => ({
    year: y,
    data: seriesFor(curYear - y),
    color: `rgba(127,142,160,${(0.78 - i * 0.20).toFixed(2)})`,
  })).filter((s) => s.data.some((v) => v !== null));

  // Median across prior years at each week, so "normal for this week" has a line.
  const median = cells.map((_, i) => {
    const vs = priorSeries.map((s) => s.data[i]).filter((v) => v !== null).sort((a, b) => a - b);
    return vs.length ? +quantile(vs, 0.5).toFixed(4) : null;
  });

  const allVals = [...tail.map((p) => p.v),
                   ...priorSeries.flatMap((s) => s.data)].filter((v) => v !== null);
  const allMin = Math.min(...allVals);
  const allMax = Math.max(...allVals);

  line(host, {
    labels,
    datasets: [
      ...priorSeries.map((s) => ({
        label: String(s.year), data: s.data,
        borderColor: s.color, borderWidth: 1.2,
        backgroundColor: 'transparent', pointRadius: 0,
      })),
      ...(median.some((v) => v !== null) ? [{
        label: `${priorSeries.length}-yr median`, data: median,
        borderColor: 'rgba(251,191,36,0.85)', borderDash: [4, 3], borderWidth: 1.3,
        backgroundColor: 'transparent', pointRadius: 0,
      }] : []),
      {
        label: `${curYear} (current)`,
        data: tail.map((p) => +p.v.toFixed(4)),
        borderColor: '#22d3ee', borderWidth: 2.4,
        backgroundColor: hexA('#22d3ee', 0.12), fill: true,
        pointRadius: 2.5, pointBackgroundColor: '#22d3ee',
      },
    ],
    options: {
      scales: {
        y: {
          // Pin the axis to the data range. Adding prior years widens the
          // spread, and Chart.js would otherwise anchor at zero and squash the
          // current-year move back into the hairline this panel exists to fix.
          min: Math.max(0, Math.floor(allMin * 0.85 * 100) / 100),
          max: Math.ceil(allMax * 1.05 * 100) / 100,
          title: { display: true, text: '% ED visits',
            color: '#4b5a6b', font: { family: 'monospace', size: 9 } },
        },
      },
    },
  });

  const dHost = document.getElementById('c-recent-d1');
  if (!dHost) return;
  const f = d1(tail, quantum);
  // Shade the band where a week-over-week move is smaller than two reporting
  // ticks, so noise is visually separated from signal rather than argued about.
  const noiseBand = tail.map((p, i) => (i === 0 || !p.v ? null
    : +((quantum * 2 / tail[i - 1].v) * 100).toFixed(2)));

  bar(dHost, {
    labels: labels.slice(1),
    datasets: [
      { label: 'WoW %', data: f.map((p) => (p.v === null ? null : +p.v.toFixed(2))),
        backgroundColor: f.map((p) => (p.noisy ? 'rgba(127,142,160,0.45)'
          : p.v > 0 ? 'rgba(249,115,22,0.85)' : 'rgba(74,222,128,0.85)')) },
      { label: 'resolution floor', type: 'line', data: noiseBand.slice(1),
        borderColor: 'rgba(251,191,36,0.55)', borderDash: [3, 3], borderWidth: 1,
        pointRadius: 0, fill: false },
    ],
    options: {
      plugins: { legend: { display: false } },
      scales: { y: { title: { display: true, text: 'WoW %',
        color: '#4b5a6b', font: { family: 'monospace', size: 9 } } } },
    },
  });
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
