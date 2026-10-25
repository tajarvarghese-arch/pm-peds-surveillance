// Executive summary: one screen that answers "do I need more staff soon?"

import { panel, tile, num, delta, levelBadge, labelsFrom, valuesFrom, empty } from '../ui.js';
import { line, bar, hexA, sparkline, SERIES, AGE_COLORS, yearColor, setXRange } from '../charts.js';
import { PATHOGENS, PED_AGES, MARKETS } from '../config.js';
import { pressureIndex, staffing, d1, d2, seasonalBands, isoWeek, seasonOf, percentileRank,
  indexQuantum, wastewaterSignal, corroborate, quantile } from '../derive.js';
import { wwSeries } from './wastewater.js';
import { series, toWeekly, fmtDate } from '../data.js';
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

  // --- pathogen status strip ---------------------------------------------
  const statusRows = pathogenStatus(posNat, naat, edAge, ctx.region);

  root.innerHTML = `
    <div class="grid g5" style="margin-bottom:10px">${tiles.join('')}</div>
    <div class="note" style="margin:-4px 0 10px">${corr.detail}</div>

    ${recentPanel(ppi, quantum)}

    <div style="height:10px"></div>

    ${methodPanel(edAge, ctx, alert, quantum)}

    <div style="height:10px"></div>

    ${seasonPanel(ppi, ctx)}

    <div style="height:10px"></div>

    <div class="grid g3">
      ${panel('Market activity level', 'CDC ARI activity · current week only',
        marketLevels(ari, edState))}

      ${panel('Pathogen status', `positivity + ED share · ${ctx.region}`,
        `<div class="scroll-y">${statusRows}</div>`, { tight: true })}

      ${panel('Pediatric age bands', 'national ED %visits · combined respiratory',
        `<div class="chart-wrap"><canvas id="c-ages"></canvas></div>
         <div class="note">Age bands are published <strong>nationally only</strong>. State feeds carry no age
         breakout, so these are never blended with the NY/NJ/CT lines on the Geography tab.</div>`)}
    </div>
  `;

  mountSeason(ppi, ctx);
  mountRecent(ppi, quantum);

  // age band chart
  const recent = edAge.slice(-78);
  line(document.getElementById('c-ages'), {
    labels: labelsFrom(recent.map((r) => ({ t: r.week })), 'year'),
    datasets: PED_AGES.map((age, i) => ({
      label: age,
      data: recent.map((r) => r[`Combined|${age}`] ?? null),
      borderColor: AGE_COLORS[i],
      backgroundColor: 'transparent',
    })),
    options: { unit: '%' },
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
      <div style="font-size:13.5px;line-height:1.6;margin-bottom:10px">
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
 * Season comparison. Every season on one week-of-season axis, each in its own
 * colour, with the prior-season median and p25-p75 band behind them. Seasons
 * toggle on and off, the axis zooms to a preset window or to any span dragged
 * on the plot, and the scale switches between level, log, and "relative" --
 * each week as a percentage of the median of the other seasons at that week,
 * which makes a 2% summer and a 20% winter comparable on one axis.
 */
const SEASON_PRESETS = [
  { id: 'todate', label: 'Season to date' },
  { id: 'ramp', label: 'Ramp · Sep–Dec', lo: 9, hi: 25 },
  { id: 'peak', label: 'Peak · Nov–Feb', lo: 18, hi: 33 },
  { id: 'spring', label: 'Spring · Feb–Jun', lo: 31, hi: 51 },
  { id: 'full', label: 'Full season', lo: null, hi: null },
];

function seasonState(ctx, keys) {
  const cur = keys.at(-1);
  if (!ctx.season || ctx.season.cur !== cur) {
    // Default: the current season against the two before it, season to date.
    ctx.season = { cur, on: new Set(keys.slice(-3)), median: true, band: true,
                   scale: 'linear', preset: 'todate', range: null };
  }
  return ctx.season;
}

function seasonPanel(ppi, ctx) {
  const seasons = bySeasonMap(ppi);
  const keys = [...seasons.keys()].sort();
  if (keys.length < 2) return panel('Season comparison', '', empty('need at least two seasons'));
  const currentKey = keys.at(-1);
  const st = seasonState(ctx, keys);
  const dev = seasonDeviation(seasons, currentKey);

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
        <td class="num">${num(r.med, 3, '%')}</td>
        <td class="num" style="color:#8797a9">${num(r.lo, 2)}–${num(r.hi, 2)}</td>
        <td class="num ${r.dev < -25 ? 's-ok' : r.dev > 25 ? 's-critical' : 's-watch'}">
          ${r.dev > 0 ? '+' : ''}${r.dev.toFixed(0)}%</td>
        <td class="num" style="color:#8797a9">${r.n}</td>
      </tr>`).join('')}</tbody>
    </table>`;

  const chip = (id, label, color, on, dash = false) => `
    <button class="chip" data-season="${id}" aria-pressed="${on}" style="--c:${color}">
      <i class="${dash ? 'dash' : ''}"></i>${label}</button>`;

  const chips = keys.map((k) => chip(k, k === currentKey ? `${k} (current)` : k,
    yearColor(k, currentKey), st.on.has(k))).join('')
    + chip('median', 'prior median', '#eef3f8', st.median, true)
    + chip('band', 'p25–p75 band', 'rgba(34,211,238,0.6)', st.band);

  return `<section class="panel">
    <h2>Season comparison — pediatric pressure index
      <span class="sub">${keys.length} seasons on one week-of-season axis (Jul → Jun)</span></h2>
    <div class="panel-body">
      <div class="chip-row" id="season-chips">${chips}</div>
      <div class="chip-row" style="margin-top:6px">
        <span class="chip-label">Zoom</span>
        ${SEASON_PRESETS.map((p) => `<button class="ghost" data-preset="${p.id}"
          aria-pressed="${st.preset === p.id}">${p.label}</button>`).join('')}
        <span class="chip-label" style="margin-left:14px">Scale</span>
        ${[['linear', 'Level'], ['log', 'Log'], ['rel', '% of typical']].map(([v, l]) =>
          `<button class="ghost" data-scale="${v}" aria-pressed="${st.scale === v}">${l}</button>`).join('')}
        <span style="margin-left:auto;color:#8797a9;font-size:12px">
          drag across the chart to zoom · double-click to reset</span>
      </div>
      <div class="grid g-2-1" style="margin-top:10px">
        <div>
          <div class="chart-wrap" style="height:440px"><canvas id="c-season"></canvas></div>
          <div class="note" id="season-note"></div>
        </div>
        <div>
          ${summary}
          <div class="scroll-y" style="max-height:300px">${devTable}</div>
        </div>
      </div>
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
    color: yearColor(y, curYear),
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
        borderColor: s.color, borderWidth: 2,
        backgroundColor: 'transparent', pointRadius: 0,
      })),
      ...(median.some((v) => v !== null) ? [{
        label: `${priorSeries.length}-yr median`, data: median,
        shortLabel: 'median',
        borderColor: SERIES.reference, borderDash: [5, 4], borderWidth: 1.8,
        backgroundColor: 'transparent', pointRadius: 0,
      }] : []),
      {
        label: `${curYear} (current)`,
        data: tail.map((p) => +p.v.toFixed(4)),
        shortLabel: String(curYear),
        borderColor: SERIES.focus, emphasis: true,
        backgroundColor: hexA(SERIES.focus, 0.10), fill: true,
        pointRadius: 3, pointBackgroundColor: SERIES.focus,
      },
    ],
    options: {
      unit: '%',
      scales: {
        y: {
          // Pin the axis to the data range. Adding prior years widens the
          // spread, and Chart.js would otherwise anchor at zero and squash the
          // current-year move back into the hairline this panel exists to fix.
          min: Math.max(0, Math.floor(allMin * 0.85 * 100) / 100),
          max: Math.ceil(allMax * 1.05 * 100) / 100,
          title: { display: true, text: '% ED visits',
            color: '#8797a9', font: { family: 'monospace', size: 9 } },
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
          : p.v > 0 ? '#f97316' : '#4ade80')) },
      { label: 'resolution floor', type: 'line', data: noiseBand.slice(1),
        borderColor: SERIES.reference, borderDash: [4, 4], borderWidth: 1.5,
        pointRadius: 0, fill: false },
    ],
    options: {
      unit: '%',
      scales: { y: { title: { display: true, text: 'WoW %',
        color: '#8797a9', font: { family: 'monospace', size: 9 } } } },
    },
  });
}

function mountSeason(ppi, ctx) {
  const canvas = document.getElementById('c-season');
  if (!canvas) return;
  const seasons = bySeasonMap(ppi);
  const keys = [...seasons.keys()].sort();
  const currentKey = keys.at(-1);
  const st = seasonState(ctx, keys);
  const axis = SEASON_AXIS;
  const idx = (w) => axis.indexOf(w);
  const curWeeks = [...seasons.get(currentKey).keys()];
  const curEnd = Math.max(...curWeeks.map(idx));

  // Prior-season median + quartiles at every week, over every season but the
  // current one -- the reference the current season is judged against.
  const ref = new Map();
  for (const w of axis) {
    const vals = keys.filter((k) => k !== currentKey).map((k) => seasons.get(k).get(w))
      .filter((v) => v != null).sort((a, b) => a - b);
    if (vals.length) ref.set(w, { med: quantile(vals, 0.5), lo: quantile(vals, 0.25), hi: quantile(vals, 0.75), n: vals.length });
  }
  // For "% of typical", each season is measured against the median of the
  // OTHER seasons at that week, so a season is never compared to itself.
  const medExcluding = (k, w) => {
    const vals = keys.filter((x) => x !== k).map((x) => seasons.get(x).get(w))
      .filter((v) => v != null).sort((a, b) => a - b);
    return vals.length ? quantile(vals, 0.5) : null;
  };
  const isRel = () => st.scale === 'rel';
  const valueOf = (k, w) => {
    const v = seasons.get(k).get(w);
    if (v == null) return null;
    if (!isRel()) return +v.toFixed(3);
    const m = medExcluding(k, w);
    return m ? +((v / m) * 100).toFixed(1) : null;
  };

  const rangeFor = () => {
    if (st.range) return st.range;
    const p = SEASON_PRESETS.find((x) => x.id === st.preset) || SEASON_PRESETS[0];
    if (p.id === 'todate') return [0, Math.min(axis.length - 1, Math.max(curEnd + 2, 8))];
    return p.lo == null ? null : [p.lo, p.hi];
  };

  const draw = () => {
    const rel = isRel();
    const ds = [];
    if (st.band && !rel) {
      ds.push({ label: 'band lo', data: axis.map((w) => ref.get(w)?.lo ?? null), borderColor: 'transparent',
        backgroundColor: 'transparent', pointRadius: 0, fill: false });
      ds.push({ label: 'prior p25–p75', data: axis.map((w) => ref.get(w)?.hi ?? null), borderColor: 'transparent',
        backgroundColor: hexA('#22d3ee', 0.10), pointRadius: 0, fill: '-1' });
    }
    if (st.median) {
      ds.push({ label: 'prior median', shortLabel: 'median',
        data: axis.map((w) => (rel ? (ref.get(w) ? 100 : null) : (ref.get(w) ? +ref.get(w).med.toFixed(3) : null))),
        borderColor: '#eef3f8', borderDash: [5, 4], borderWidth: 1.6, backgroundColor: 'transparent' });
    }
    for (const k of keys) {
      if (!st.on.has(k)) continue;
      const cur = k === currentKey;
      ds.push({ label: cur ? `${k} (current)` : k, shortLabel: k,
        data: axis.map((w) => valueOf(k, w)),
        borderColor: yearColor(k, currentKey), emphasis: cur,
        borderWidth: cur ? 3 : 2, backgroundColor: 'transparent',
        pointRadius: cur ? 2.5 : 0, pointBackgroundColor: yearColor(k, currentKey) });
    }
    const range = rangeFor();
    line(canvas, {
      labels: axis.map((w) => `w${w}`),
      datasets: ds,
      options: {
        unit: '%',
        zoomSelect: {
          range,
          onChange: (lo, hi) => {
            st.range = lo == null ? null : [lo, hi];
            if (lo == null) st.preset = 'full';
            else st.preset = null;
            document.querySelectorAll('[data-preset]').forEach((b) =>
              b.setAttribute('aria-pressed', String(b.dataset.preset === st.preset)));
            note();
          },
        },
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { autoSkip: false, callback(v, i) {
            const m = MONTH_TICKS.find((t) => t.at === i);
            // Month names when the whole season is in view; week numbers when zoomed.
            const r = rangeFor();
            const span = r ? r[1] - r[0] : axis.length;
            if (span <= 30) return i % 2 === 0 ? `w${axis[i]}` : null;
            return m ? m.label : null;
          } } },
          y: {
            type: st.scale === 'log' ? 'logarithmic' : 'linear',
            title: { display: true, text: rel ? '% of typical week (median of other seasons = 100)'
              : `% ED visits${st.scale === 'log' ? ' (log)' : ''}` },
          },
        },
      },
    });
    note();
  };

  const note = () => {
    const el = document.getElementById('season-note');
    if (!el) return;
    const rel = isRel();
    const r = rangeFor();
    const span = r ? `weeks w${axis[r[0]]}–w${axis[r[1]]}` : 'the full season';
    const n = [...st.on].length;
    el.innerHTML = rel
      ? `Showing ${span}. Each season is drawn as a percentage of the <strong>median of the other
         seasons</strong> at that week, so the dashed line at 100 is "typical", and a 2% summer week
         and a 20% winter week sit on the same footing. Read the gap from 100, not the level.`
      : `Showing ${span}, ${n} season${n === 1 ? '' : 's'}. The dashed white line is the median of the
         ${keys.length - 1} prior seasons; the shaded band is their p25–p75 — a rough envelope from
         ${keys.length - 1} observations, not a stable percentile. ${st.scale === 'log'
           ? 'Log scale gives proportional moves equal weight, so the summer floor stays legible under the winter peak.'
           : 'Switch to Log to see the summer floor, or "% of typical" to compare shapes across magnitudes.'}`;
  };

  draw();

  const root = canvas.closest('.panel');
  root.querySelectorAll('[data-season]').forEach((b) => {
    b.onclick = () => {
      const id = b.dataset.season;
      if (id === 'median') st.median = !st.median;
      else if (id === 'band') st.band = !st.band;
      else if (id === currentKey) return;            // the current season is always shown
      else if (st.on.has(id)) st.on.delete(id); else st.on.add(id);
      b.setAttribute('aria-pressed', String(id === 'median' ? st.median : id === 'band' ? st.band : st.on.has(id)));
      draw();
    };
  });
  root.querySelectorAll('[data-preset]').forEach((b) => {
    b.onclick = () => {
      st.preset = b.dataset.preset;
      st.range = null;
      root.querySelectorAll('[data-preset]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      draw();
    };
  });
  root.querySelectorAll('[data-scale]').forEach((b) => {
    b.onclick = () => {
      st.scale = b.dataset.scale;
      root.querySelectorAll('[data-scale]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
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
      <td style="text-align:left;color:#8797a9;font-size:12px">${src}${extra}</td>
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
    <td class="num" colspan="2" style="color:#8797a9">annual only</td>
    <td style="text-align:left;color:#8797a9;font-size:12px">ABCs 9y49-tura — no weekly feed exists</td>
  </tr>`);

  return `<table class="dt">
    <thead><tr><th>Pathogen</th><th>Latest</th><th>WoW</th><th style="text-align:left">Source</th></tr></thead>
    <tbody>${rows.join('')}</tbody></table>`;
}
