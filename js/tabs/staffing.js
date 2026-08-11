// Staffing engine: percentile-derived tiers + acceleration promotion,
// with the visit-mix assumption exposed as a live control.

import { panel, num, delta, levelBadge, empty, tile, noteGap } from '../ui.js';
import { line, hexA } from '../charts.js';
import { TIERS, ACCEL, MARKETS, PED_AGES, PROVENANCE_GAPS, VISIT_MIX } from '../config.js';
import { pressureIndex, staffing, d1, d2, percentileRank, quantile, indexQuantum, ordinal,
  wastewaterSignal, corroborate } from '../derive.js';
import { wwSeries } from './wastewater.js';
import { toWeekly, fmtDate } from '../data.js';
import { rerender } from '../app.js';

export default function staffingTab(root, ctx) {
  const edAge = ctx.db.ed_age?.data || [];
  const edState = ctx.db.ed_state?.data || [];
  if (!edAge.length) { root.innerHTML = empty('ed_age snapshot missing'); return; }

  const quantum = indexQuantum(ctx.mix);
  const ppi = pressureIndex(edAge, 'Combined', ctx.mix);
  const alert = staffing(ppi, quantum);
  const vals = ppi.map((p) => p.v).sort((a, b) => a - b);
  const cuts = TIERS.map((t) => ({ ...t, at: quantile(vals, t.pct / 100) }));

  // Independent read from wastewater. Advisory only -- see corroborate().
  const wwSignals = Object.fromEntries(MARKETS.states.map((full) => {
    const ab = MARKETS.abbr[full];
    return [ab, wastewaterSignal(wwSeries(ctx.db, 'ww_covid', ab))];
  }));
  const corr = corroborate(alert, wwSignals);

  root.innerHTML = `
    <div class="grid g-2-1" style="margin-bottom:10px">
      ${panel('Current recommendation', `wk ending ${fmtDate(alert.t)}`,
        `<div style="display:flex;align-items:center;gap:18px;flex-wrap:wrap">
          <div>
            <div style="font-size:44px;font-weight:700;line-height:1" class="s-${alert.tier.class}">
              ${alert.tier.mult.toFixed(1)}×</div>
            <div style="margin-top:4px">${levelBadge(alert.tier.name, alert.tier.class)}</div>
          </div>
          <div style="flex:1;min-width:220px">
            <table class="dt">
              <tr><td>Pressure index</td><td class="num">${num(alert.value, 3, '%')}</td></tr>
              <tr><td>Percentile</td><td class="num">${ordinal(alert.pct)} of ${alert.n} wks</td></tr>
              <tr><td>d1 week over week</td><td class="num">${delta(alert.d1, { noisy: alert.noisy })}</td></tr>
              <tr><td>d2 acceleration</td><td class="num">${delta(alert.d2, { suffix: 'pp', noisy: alert.noisy })}</td></tr>
              <tr><td>Reporting resolution</td><td class="num" style="color:#7f8ea0">±${quantum.toFixed(3)}pp</td></tr>
              <tr><td>Acceleration promotion</td><td class="num">${alert.promoted
                ? '<span class="s-elevated">APPLIED</span>'
                : alert.noisy ? '<span style="color:#4b5a6b">blocked — noise</span>'
                : '<span style="color:#4b5a6b">no</span>'}</td></tr>
            </table>
          </div>
        </div>
        <div class="note">${alert.reason}</div>
        ${alert.noisy ? `<div class="note warn">CDC publishes ED visit share to one decimal place.
        At the current level a single 0.1pp tick in one age band moves this index by
        ${quantum.toFixed(3)}pp — about
        ${((quantum / alert.value) * 100).toFixed(1)}%. Week-over-week derivatives are therefore
        inside the rounding step and are <strong>not</strong> being used to promote the tier.</div>` : ''}`)}

      ${panel('Visit mix', 'assumption — drives the index', mixControls(ctx))}
    </div>

    ${panel('Wastewater corroboration', 'independent signal · advisory, never moves the multiplier',
      `<div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-bottom:8px">
        <div style="font-size:16px;font-weight:700" class="s-${corr.cls}">
          ${levelBadge(corr.verdict, corr.cls)}
        </div>
        <div style="flex:1;min-width:260px;color:#7f8ea0;font-size:11px">${corr.detail}</div>
      </div>
      <table class="dt">
        <thead><tr><th>Mkt</th><th>WW pctile</th><th>3wk trend</th><th>Direction</th><th>n wks</th></tr></thead>
        <tbody>${MARKETS.states.map((full) => {
          const ab = MARKETS.abbr[full];
          const s = wwSignals[ab];
          if (!s) return `<tr><td>${ab}</td><td class="num" colspan="4" style="color:#4b5a6b">no signal</td></tr>`;
          const dir = s.dir === 'rising' ? '<span class="s-critical">▲ rising</span>'
            : s.dir === 'falling' ? '<span class="s-ok">▼ falling</span>'
            : '<span style="color:#7f8ea0">■ flat</span>';
          return `<tr>
            <td>${ab}</td>
            <td class="num ${s.pct >= 75 ? 's-elevated' : ''}">${ordinal(s.pct)}</td>
            <td class="num">${delta(s.trendPct)}</td>
            <td style="text-align:left">${dir}</td>
            <td class="num" style="color:#4b5a6b">${s.n}</td>
          </tr>`;
        }).join('')}</tbody>
      </table>
      <div class="note">Wastewater growth rates correlate with ED growth rates far more weakly than
      their levels do (see the Wastewater tab for the measured curve), so this panel cannot promote a
      tier. Its value is that concentration is continuous:
      when the ED index is pinned to its 0.1pp quantisation floor, this is the only series still able
      to show direction. See the Wastewater tab for the measured lead/lag curve.</div>`)}

    <div style="height:10px"></div>

    ${panel('Recalibrated thresholds', 'derived from this series, not transplanted from ILINet',
      thresholdTable(cuts, alert))}

    <div style="height:10px"></div>

    ${panel('Index vs tier bands', 'full available history',
      `<div class="chart-wrap tall"><canvas id="c-tiers"></canvas></div>`)}

    <div style="height:10px"></div>

    <div class="grid g2">
      ${panel('Per-market signal', 'state ARI — all ages, no pediatric breakout',
        marketTable(edState))}
      ${panel('Why these numbers changed', 'threshold provenance',
        legacyCheck(ppi, alert) +
        `<div class="note">Tiers are instead percentile ranks against this series' own
        ${alert.n} weeks of history, so they self-calibrate as the record grows. The 1.0/1.1/1.3/1.6×
        multipliers from the brief are preserved unchanged — only the trigger levels moved.</div>
        ${noteGap(PROVENANCE_GAPS.find((g) => g.wanted === 'State-level pediatric age bands'))}`)}
    </div>
  `;

  // mix controls
  for (const age of PED_AGES) {
    const inp = document.getElementById(`mix-${slug(age)}`);
    if (!inp) continue;
    inp.oninput = (e) => {
      ctx.mix[age] = Math.max(0, +e.target.value || 0);
      rerender();
    };
  }
  const reset = document.getElementById('mix-reset');
  if (reset) reset.onclick = () => { ctx.mix = { ...VISIT_MIX }; rerender(); };

  // tier chart
  const labels = ppi.map((p) => {
    const d = new Date(p.t + 'T00:00:00Z');
    return d.toLocaleDateString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' });
  });
  line(document.getElementById('c-tiers'), {
    labels,
    datasets: [
      ...cuts.slice(1).map((c) => ({
        label: `${c.name} ≥ ${c.at.toFixed(2)}%`,
        data: ppi.map(() => +c.at.toFixed(3)),
        borderColor: { watch: '#fbbf24', elevated: '#f97316', critical: '#ef4444' }[c.class],
        borderWidth: 1, borderDash: [3, 3], pointRadius: 0, backgroundColor: 'transparent',
      })),
      { label: 'pressure index', data: ppi.map((p) => +p.v.toFixed(3)),
        borderColor: '#22d3ee', borderWidth: 2,
        backgroundColor: hexA('#22d3ee', 0.08), fill: true },
    ],
  });
}

function slug(s) { return s.replace(/[^a-z0-9]/gi, ''); }

/**
 * Show what the brief's original ILINet cutoffs would actually have done to
 * this series. Computed live rather than asserted, so it stays true as the
 * record grows.
 */
function legacyCheck(ppi, alert) {
  const LEGACY = [[2.0, 'WATCH'], [4.0, 'ELEVATED'], [7.0, 'CRITICAL']];
  const n = ppi.length;
  const rows = LEGACY.map(([th, name]) => {
    const hits = ppi.filter((p) => p.v >= th).length;
    const share = (hits / n) * 100;
    return `<tr>
      <td>${name}</td>
      <td class="num">≥ ${th.toFixed(1)}%</td>
      <td class="num">${hits} / ${n}</td>
      <td class="num ${share > 25 ? 's-critical' : share > 15 ? 's-elevated' : ''}">${share.toFixed(0)}%</td>
    </tr>`;
  }).join('');
  const critShare = (ppi.filter((p) => p.v >= 7.0).length / n) * 100;

  return `<div class="note gap"><strong>The brief's 2.0 / 4.0 / 7.0% ILI cutoffs are not used.</strong>
    They were calibrated against CDC ILINet, which no longer publishes a live feed. Applied to NSSP ED
    visit share — which spans ${Math.min(...ppi.map((p) => p.v)).toFixed(2)}%–${Math.max(...ppi.map((p) => p.v)).toFixed(2)}%
    rather than ILINet's roughly 1–8% — they would have called
    <strong>CRITICAL 1.6× staffing in ${critShare.toFixed(0)}% of all observed weeks</strong>.
    A trigger that fires a third of the time is not a trigger.</div>
    <table class="dt">
      <thead><tr><th>Legacy tier</th><th>ILI cutoff</th><th>Weeks fired</th><th>Share</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function mixControls(ctx) {
  const total = Object.values(ctx.mix).reduce((a, b) => a + b, 0);
  return `<div style="display:grid;gap:8px">
    ${PED_AGES.map((age) => `
      <label style="display:grid;grid-template-columns:70px 1fr 44px;gap:8px;align-items:center;text-transform:none;letter-spacing:0">
        <span style="color:#d8e0e8">${age}</span>
        <input type="range" id="mix-${slug(age)}" min="0" max="1" step="0.01" value="${ctx.mix[age]}">
        <span class="num" style="color:#7f8ea0;font-size:11px">${(ctx.mix[age] / (total || 1) * 100).toFixed(0)}%</span>
      </label>`).join('')}
    <button class="ghost" id="mix-reset">reset to default</button>
    <div class="note warn"><span class="assumption">assumption</span>
    These are estimated <strong>urgent-care visit shares</strong> by age band, not population shares,
    and not PM Pediatrics' actual mix — we have no clinic-level utilisation data. If you can supply the
    real distribution the index becomes materially more accurate. Weights are normalised, so only the
    ratios matter. <a href="#exec">See the full derivation on the Exec Summary tab</a>.</div>
  </div>`;
}

function thresholdTable(cuts, alert) {
  return `<table class="dt">
    <thead><tr>
      <th>Tier</th><th>Percentile</th><th>Index ≥</th><th>Multiplier</th>
      <th style="text-align:left">Trigger</th>
    </tr></thead>
    <tbody>${cuts.map((c) => {
      const active = c.name === alert.tier.name;
      return `<tr style="${active ? 'background:#10161d' : ''}">
        <td>${levelBadge(c.name, c.class, active)}</td>
        <td class="num">${c.pct}th</td>
        <td class="num">${num(c.at, 3, '%')}</td>
        <td class="num" style="font-weight:700">${c.mult.toFixed(1)}×</td>
        <td style="text-align:left;color:#7f8ea0;font-size:10.5px">
          ${c.pct === 0 ? 'below median of observed history'
            : `index at or above the ${c.pct}th percentile of ${alert.n} observed weeks`}
        </td>
      </tr>`;
    }).join('')}</tbody></table>
    <div class="note">Promotion rule: any tier is bumped one step when d1 &gt; ${ACCEL.d1Surge}%
    <em>and</em> d2 &gt; 0 — climbing and still accelerating. That preserves the brief's intent
    (act on the second derivative, not the level) without depending on dead ILINet cutoffs.</div>`;
}

function marketTable(edState) {
  if (!edState.length) return empty('no state data');
  const rows = MARKETS.states.map((s) => {
    const pts = edState.map((r) => ({ t: r.date, v: r[`${s}|ARI`] })).filter((p) => p.v != null);
    if (!pts.length) return '';
    const wk = toWeekly(pts);
    const f = d1(wk), sd = d2(f);
    const pct = percentileRank(wk, wk.at(-1).v);
    const idx = TIERS.reduce((acc, t, i) => (pct >= t.pct ? i : acc), 0);
    const tier = TIERS[idx];
    return `<tr>
      <td>${MARKETS.abbr[s]}</td>
      <td class="num">${num(wk.at(-1).v, 2, '%')}</td>
      <td class="num">${delta(f.at(-1)?.v)}</td>
      <td class="num">${delta(sd.at(-1)?.v, { suffix: 'pp' })}</td>
      <td class="num">${ordinal(pct)}</td>
      <td>${levelBadge(tier.name, tier.class)}</td>
    </tr>`;
  }).join('');
  return `<table class="dt">
    <thead><tr><th>Mkt</th><th>ARI</th><th>d1</th><th>d2</th><th>Pctile</th><th>Tier</th></tr></thead>
    <tbody>${rows}</tbody></table>
    <div class="note">State tiers use <strong>all-ages</strong> ARI — CDC publishes no state-level
    pediatric breakout. Use these for relative market timing, and the national pediatric index above
    for the actual staffing multiplier.</div>`;
}
