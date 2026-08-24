// The year in question: is the current calendar year epidemiologically
// below trend, on trend, or above trend — and WHERE?
//
// This tab exists because "our volumes have suffered — is it the environment?"
// is not answerable with one number. A year can be on-trend in aggregate while
// being made of an above-trend spring and a record-low summer, and the business
// conclusion differs completely depending on which window the volume weakness
// falls in. So everything here is computed per-week against the same calendar
// week of every prior observed year, then aggregated into windows — never the
// other way around.
//
// All figures are computed at render time from the public snapshots. Nothing
// is asserted in code; the verdict sentence itself is assembled from the
// computed facts.

import { panel, tile, empty, levelBadge } from '../ui.js';
import { line, bar, hexA } from '../charts.js';
import { pressureIndex, seasonOf } from '../derive.js';
import { isoWeekOf } from '../analysis.js';

const YEAR_COLORS = ['#64748b', '#94a3b8', '#fbbf24', '#22d3ee', '#a78bfa'];

/** ISO year (the year of the week's Thursday) — must pair with isoWeekOf. */
function isoYearOf(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7) + 3);
  return t.getUTCFullYear();
}

export default function yearTab(root, ctx) {
  const ppi = pressureIndex(ctx.db.ed_age?.data || [], 'Combined', ctx.mix);
  if (ppi.length < 60) { root.innerHTML = empty('insufficient index history'); return; }

  // ---- per-week structure -------------------------------------------------
  const pts = ppi.map((p) => ({
    ...p, y: isoYearOf(p.t), w: isoWeekOf(p.t),
    month: +p.t.slice(5, 7),
  }));
  const years = [...new Set(pts.map((p) => p.y))].sort();
  const Y = years.at(-1);
  const priors = years.filter((y) => y < Y && pts.filter((p) => p.y === y).length >= 20);
  const latestW = Math.max(...pts.filter((p) => p.y === Y).map((p) => p.w));

  // week-by-week rank of the current year against the same calendar week
  const weekRows = [];
  for (const p of pts.filter((x) => x.y === Y).sort((a, b) => a.w - b.w)) {
    const prior = pts.filter((x) => x.y < Y && x.w === p.w).map((x) => x.v);
    if (prior.length < 2) continue;
    const below = prior.filter((v) => v < p.v).length;
    weekRows.push({
      w: p.w, t: p.t, v: p.v, month: p.month, n: prior.length,
      pct: (below / prior.length) * 100,
      recLow: p.v < Math.min(...prior),
      recHigh: p.v > Math.max(...prior),
    });
  }
  if (weekRows.length < 10) { root.innerHTML = empty('not enough comparable weeks yet'); return; }

  const n = weekRows.length;
  const recLows = weekRows.filter((r) => r.recLow).length;
  const recHighs = weekRows.filter((r) => r.recHigh).length;
  const meanPct = weekRows.reduce((a, r) => a + r.pct, 0) / n;
  let streak = 0;
  for (let i = weekRows.length - 1; i >= 0 && weekRows[i].recLow; i--) streak++;

  // cumulative race over matched weeks
  const cumByYear = new Map();
  for (const y of [...priors, Y]) {
    const sub = pts.filter((p) => p.y === y && p.w <= latestW).sort((a, b) => a.w - b.w);
    let acc = 0;
    cumByYear.set(y, sub.map((p) => ({ w: p.w, cum: acc += p.v })));
  }
  const cumNow = cumByYear.get(Y)?.at(-1)?.cum ?? 0;
  const priorCums = priors.map((y) => ({ y, cum: cumByYear.get(y)?.at(-1)?.cum ?? 0 }))
    .sort((a, b) => b.cum - a.cum);
  const rank = 1 + priorCums.filter((p) => p.cum > cumNow).length;
  const vsLast = priorCums.find((p) => p.y === Y - 1);
  const vsLastPct = vsLast && vsLast.cum > 0 ? ((cumNow / vsLast.cum) - 1) * 100 : null;

  // the two-halves split: find where the record-low regime begins
  const firstOfStreak = streak > 0 ? weekRows[weekRows.length - streak] : null;
  const before = firstOfStreak ? weekRows.filter((r) => r.w < firstOfStreak.w) : weekRows;
  const meanBefore = before.length ? before.reduce((a, r) => a + r.pct, 0) / before.length : null;

  // windows
  const windows = [
    { name: 'Jan – Feb (peak tail)', lo: 1, hi: 8 },
    { name: 'Mar – May (spring)', lo: 9, hi: 22 },
    { name: `Jun → now (trough)`, lo: 23, hi: latestW },
  ].map((win) => {
    const per = [...priors, Y].map((y) => ({
      y, cum: pts.filter((p) => p.y === y && p.w >= win.lo && p.w <= win.hi)
        .reduce((a, p) => a + p.v, 0),
    }));
    const cur = per.find((p) => p.y === Y);
    const others = per.filter((p) => p.y !== Y).map((p) => p.cum);
    return { ...win, per, cur: cur?.cum ?? 0,
      recLow: others.length && cur.cum < Math.min(...others),
      recHigh: others.length && cur.cum > Math.max(...others) };
  });

  // pathogen YTD means, matched weeks
  const pos = ctx.db.pos_national?.data || [];
  const pathRows = ['Influenza', 'RSV', 'COVID-19'].map((k) => {
    const per = [...priors, Y].map((y) => {
      const vs = pos.map((r) => ({ t: r.week, v: r[k] }))
        .filter((p) => p.v != null && isoYearOf(p.t) === y && isoWeekOf(p.t) <= latestW)
        .map((p) => p.v);
      return { y, mean: vs.length > 10 ? vs.reduce((a, b) => a + b, 0) / vs.length : null };
    }).filter((p) => p.mean !== null);
    const cur = per.find((p) => p.y === Y);
    const others = per.filter((p) => p.y !== Y).map((p) => p.mean);
    return { k, per, cur: cur?.mean ?? null,
      recLow: cur && others.length >= 2 && cur.mean < Math.min(...others),
      recHigh: cur && others.length >= 2 && cur.mean > Math.max(...others) };
  });

  // season shapes
  const bySeason = new Map();
  for (const p of ppi) {
    const s = seasonOf(p.t);
    if (!bySeason.has(s)) bySeason.set(s, []);
    bySeason.get(s).push(p);
  }
  const seasonRows = [...bySeason.entries()]
    .filter(([, v]) => v.length >= 30)
    .map(([s, v]) => {
      const peak = v.reduce((a, b) => (b.v > a.v ? b : a));
      const jan1 = `${+s.slice(0, 4) + 1}-01-01`;
      const preJan = v.filter((p) => p.t < jan1).reduce((a, p) => a + p.v, 0);
      const cum = v.reduce((a, p) => a + p.v, 0);
      return { s, n: v.length, cum, peak: peak.v, peakAt: peak.t,
               frontLoad: cum > 0 ? preJan / cum : null };
    }).sort((a, b) => (a.s < b.s ? -1 : 1));

  // ---- verdict, assembled from the computed facts -------------------------
  const overall = rank === 1 ? { t: 'ABOVE ALL PRIOR YEARS', c: 'critical' }
    : rank > priors.length ? { t: 'BELOW ALL PRIOR YEARS', c: 'ok' }
    : meanPct < 35 ? { t: 'BELOW TREND', c: 'ok' }
    : meanPct > 65 ? { t: 'ABOVE TREND', c: 'critical' }
    : { t: 'MID-RANGE — BUT NOT UNIFORM', c: 'watch' };

  root.innerHTML = `
    <section class="panel" style="border-color:#fbbf24">
      <h2 style="color:#fbbf24">Is ${Y} an unusual year?
        <span class="sub">every figure computed against ${priors.length} prior observed year${priors.length === 1 ? '' : 's'}, week by week</span></h2>
      <div class="panel-body">
        <div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap;margin-bottom:10px">
          ${levelBadge(overall.t, overall.c)}
          <div style="font-size:12px;color:#d8e0e8;max-width:760px;line-height:1.6">
            Cumulative disease pressure through week ${latestW} ranks
            <strong>#${rank} of ${priors.length + 1}</strong> observed years
            ${vsLastPct !== null ? `(${vsLastPct > 0 ? '+' : ''}${vsLastPct.toFixed(0)}% vs ${Y - 1})` : ''}.
            ${streak >= 4 && meanBefore !== null && meanBefore >= 45 ? `
            But the year is <strong>not uniform</strong>: through the spring it ran at the
            ${meanBefore.toFixed(0)}th percentile of prior years, and since week ${firstOfStreak.w}
            <strong>every single week has been the lowest ever observed for that calendar week</strong>
            (${streak} consecutive record-low weeks). The anomaly is the summer, not the year.`
            : streak >= 4 ? `The most recent ${streak} weeks are all record lows for their calendar week.`
            : ''}
          </div>
        </div>

        <div class="grid g5" style="margin-bottom:10px">
          ${tile('YTD rank', `#${rank} / ${priors.length + 1}`, 'cumulative index, matched weeks')}
          ${tile(`vs ${Y - 1}`, vsLastPct === null ? '--'
              : `<span class="${vsLastPct < 0 ? 's-ok' : 's-critical'}">${vsLastPct > 0 ? '+' : ''}${vsLastPct.toFixed(0)}%</span>`,
            vsLast ? `${Y - 1} was rank #${1 + priorCums.filter((p) => p.cum > vsLast.cum).length} of priors` : '')}
          ${tile('Mean weekly percentile', `${meanPct.toFixed(0)}th`, `across ${n} comparable weeks`)}
          ${tile('Record-low weeks', `<span class="${recLows > n / 4 ? 's-ok' : ''}">${recLows}</span>`,
            `of ${n} · ${recHighs} record highs`)}
          ${tile('Current record-low streak', `<span class="${streak >= 4 ? 's-watch' : ''}">${streak}</span>`,
            streak ? `every week since wk ${firstOfStreak.w}` : 'none')}
        </div>

        <div class="grid g2">
          <div>
            <div class="chart-wrap"><canvas id="y-race"></canvas></div>
            <div class="note">Cumulative disease pressure by calendar week, one line per year. Where
            the ${Y} line sits in the pack — and where it bends away — is the year's story in one
            picture.</div>
          </div>
          <div>
            <div class="chart-wrap"><canvas id="y-strip"></canvas></div>
            <div class="note">Each ${Y} week ranked against the same calendar week of prior years.
            <span style="color:#ef4444">■</span> record low ·
            <span style="color:#fbbf24">■</span> record high ·
            <span style="color:#22d3ee">■</span> in range. A cluster at the bottom right is a regime,
            not noise.</div>
          </div>
        </div>
      </div>
    </section>

    <div style="height:10px"></div>

    <div class="grid g2">
      ${panel('Where the year deviates', 'cumulative index by window, per year',
        `<table class="dt">
          <thead><tr><th style="text-align:left">Window</th>
            ${[...priors, Y].map((y) => `<th>${y}</th>`).join('')}<th>Verdict</th></tr></thead>
          <tbody>${windows.map((w) => `<tr>
            <td style="text-align:left">${w.name}</td>
            ${w.per.map((p) => `<td class="num" ${p.y === Y ? 'style="font-weight:700"' : 'style="color:#7f8ea0"'}>${p.cum.toFixed(1)}</td>`).join('')}
            <td>${w.recLow ? '<span class="s-ok">record low</span>'
                : w.recHigh ? '<span class="s-critical">record high</span>'
                : '<span style="color:#7f8ea0">in range</span>'}</td>
          </tr>`).join('')}</tbody>
        </table>
        <div class="note">The same year can hold a record-high window and a record-low window. For
        planning, the window verdicts matter more than the annual total — staffing is set by week,
        not by year.</div>`)}

      ${panel('Pathogen mix — YTD mean positivity by year', 'the composition of the year',
        `<table class="dt">
          <thead><tr><th style="text-align:left">Pathogen</th>
            ${[...priors, Y].map((y) => `<th>${y}</th>`).join('')}<th>Verdict</th></tr></thead>
          <tbody>${pathRows.map((r) => `<tr>
            <td style="text-align:left">${r.k}</td>
            ${[...priors, Y].map((y) => {
              const p = r.per.find((x) => x.y === y);
              return `<td class="num" ${y === Y ? 'style="font-weight:700"' : 'style="color:#7f8ea0"'}>${p ? p.mean.toFixed(2) : '·'}</td>`;
            }).join('')}
            <td>${r.recLow ? '<span class="s-ok">record low</span>'
                : r.recHigh ? '<span class="s-critical">record high</span>'
                : '<span style="color:#7f8ea0">in range</span>'}</td>
          </tr>`).join('')}</tbody>
        </table>
        <div class="note">A year can be "down" in total while individual pathogens set records in
        both directions — the mix determines which service lines feel it.</div>`)}
    </div>

    <div style="height:10px"></div>

    ${panel('Season shapes on record', 'July-to-June seasons · cumulative, peak, timing',
      `<table class="dt">
        <thead><tr><th>Season</th><th>Weeks</th><th>Cumulative</th><th>Peak</th><th>Peak date</th>
          <th>Front-loaded</th></tr></thead>
        <tbody>${seasonRows.map((s) => `<tr>
          <td>${s.s}</td>
          <td class="num" style="color:#7f8ea0">${s.n}</td>
          <td class="num">${s.cum.toFixed(0)}</td>
          <td class="num">${s.peak.toFixed(2)}%</td>
          <td class="num" style="color:#7f8ea0">${s.peakAt.slice(5)}</td>
          <td class="num">${s.frontLoad !== null ? (s.frontLoad * 100).toFixed(0) + '%' : '--'}</td>
        </tr>`).join('')}</tbody>
      </table>
      <div class="note">"Front-loaded" is the share of the season's cumulative pressure that arrived
      before January 1. A season with a record peak can still deliver a weak calendar year if the
      peak lands in December and the spring tail collapses — the calendar year and the season are
      different books.</div>`)}

    <div style="height:10px"></div>
    <div class="note" style="max-width:900px">
      <strong>Deliberately no company data on this tab.</strong> This page answers one question —
      what did the epidemiology do — from public surveillance alone. Company volume is kept off it
      on purpose: with locations being added, a raw volume comparison against the environment
      conflates footprint growth with demand, and the clean comparison (same-store, on the Report ▪
      tab) belongs with the rest of the company analysis, not here.
    </div>

    <div style="height:10px"></div>

    <div class="note gap" style="max-width:900px">
      <strong>Read the word "record" carefully.</strong> The comparable record is
      ${priors.length + 1} calendar years — NSSP pediatric ED surveillance begins in late 2022. A
      record within four observed years is a strong statement about this era, not about history; and
      the earliest year runs on a smaller reporting panel, which biases its levels low. The verdicts
      here are honest against everything observable, and everything observable is short.
    </div>
  `;

  // ---- charts -------------------------------------------------------------
  const axis = [];
  for (let w = 1; w <= latestW; w++) axis.push(w);
  line(document.getElementById('y-race'), {
    labels: axis.map((w) => `w${w}`),
    datasets: [...priors, Y].map((y, i) => {
      const m = new Map((cumByYear.get(y) || []).map((p) => [p.w, p.cum]));
      const isY = y === Y;
      return {
        label: String(y),
        data: axis.map((w) => (m.has(w) ? +m.get(w).toFixed(2) : null)),
        borderColor: isY ? '#fbbf24' : YEAR_COLORS[i % YEAR_COLORS.length],
        borderWidth: isY ? 2.4 : 1.3,
        borderDash: isY ? [] : [4, 3],
        backgroundColor: isY ? hexA('#fbbf24', 0.08) : 'transparent',
        fill: isY,
      };
    }),
  });

  bar(document.getElementById('y-strip'), {
    labels: weekRows.map((r) => `w${r.w}`),
    datasets: [{
      label: 'percentile vs prior years',
      data: weekRows.map((r) => +r.pct.toFixed(0)),
      backgroundColor: weekRows.map((r) => (r.recLow ? 'rgba(239,68,68,0.85)'
        : r.recHigh ? 'rgba(251,191,36,0.85)' : 'rgba(34,211,238,0.6)')),
    }],
    options: {
      plugins: { legend: { display: false } },
      scales: { y: { min: 0, max: 100, title: { display: true, text: 'percentile',
        color: '#4b5a6b', font: { family: 'monospace', size: 9 } } } },
    },
  });
}
