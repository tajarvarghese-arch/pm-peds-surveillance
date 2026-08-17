// PM Pediatrics visit volumes — private, browser-only.
//
// The point of this tab is not to draw your own numbers back at you. It is to
// answer the question the rest of the dashboard cannot: does the public
// surveillance signal actually predict PM Pediatrics volume? Everything else
// here is a staffing heuristic built on a proxy. This is the only place that
// proxy can be tested against ground truth.

import { panel, tile, num, delta, empty, levelBadge } from '../ui.js';
import { line, bar, hexA } from '../charts.js';
import { PATHOGENS } from '../config.js';
import {
  parseWorkbook, save, load, clear, toWeekly as volWeekly,
} from '../volumes.js';
import {
  pressureIndex, crossCorrelate, logChange, smooth, correlate, percentileRank,
  ordinal, quantile,
} from '../derive.js';
import { rerender } from '../app.js';

const PALETTE = ['#22d3ee', '#fbbf24', '#4ade80', '#f97316', '#a78bfa',
                 '#f472b6', '#94a3b8', '#ef4444', '#64748b', '#2dd4bf'];

export default function volumes(root, ctx) {
  const store = load();

  if (!store) { root.innerHTML = uploadPrompt(); wireUpload(root, ctx); return; }

  const rows = store.data || [];
  const types = [...new Set(rows.map((r) => r.type))].filter((t) => t !== '(all)');
  const locs = [...new Set(rows.map((r) => r.location))].filter((l) => l !== '(all)');
  const total = rows.reduce((a, r) => a + r.visits, 0);
  const weeklyAll = volWeekly(rows);

  // The validation: their weekly volume against the public index.
  const ppi = pressureIndex(ctx.db.ed_age?.data || [], 'Combined', ctx.mix);
  const ppiWeekly = alignToMonday(ppi);
  const xcLevel = crossCorrelate(ppiWeekly, weeklyAll, { from: -4, to: 8 });
  const xcGrowth = crossCorrelate(logChange(smooth(ppiWeekly, 3)), logChange(weeklyAll),
                                  { from: -4, to: 8 });
  const overlap = correlate(ppiWeekly, weeklyAll).n;

  // The natural experiment. If the index only correlated because both series
  // rise in winter, a non-respiratory category would correlate too. Injury does
  // not, which is what turns a suggestive number into evidence.
  const cats = [...new Set(rows.map((r) => r.category))].filter((c) => c !== '(all)');
  const controls = cats.map((c) => {
    const w = volWeekly(rows, (r) => r.category === c);
    if (w.length < 12) return null;
    const L = crossCorrelate(ppiWeekly, w, { from: -4, to: 8 }).peak;
    const G = crossCorrelate(logChange(smooth(ppiWeekly, 3)), logChange(w), { from: -4, to: 8 }).peak;
    return { name: c, n: w.reduce((a, p) => a + p.v, 0), L, G,
             respiratory: /season/i.test(c) && !/non/i.test(c) };
  }).filter(Boolean).sort((a, b) => (b.L?.r ?? -9) - (a.L?.r ?? -9));

  root.innerHTML = `
    ${privacyBar(store)}

    <div style="height:10px"></div>

    <div class="grid g4" style="margin-bottom:10px">
      ${tile('Visits loaded', total.toLocaleString(),
        `${weeklyAll.length} weeks · ${rows.length.toLocaleString()} aggregated rows`)}
      ${tile('Date range', weeklyAll.length ? weeklyAll[0].t : '--',
        weeklyAll.length ? `through ${weeklyAll.at(-1).t}` : '')}
      ${tile('Visit types', String(types.length), types.slice(0, 3).join(', ') + (types.length > 3 ? '…' : ''))}
      ${tile('Locations', String(locs.length || '—'),
        locs.length ? locs.slice(0, 2).join(', ') + (locs.length > 2 ? '…' : '') : 'not in this export')}
    </div>

    ${validationPanel(xcLevel, xcGrowth, overlap, ppiWeekly, weeklyAll, controls)}

    <div style="height:10px"></div>

    ${panel('Visits by type over time', 'weekly totals',
      `<div class="chart-wrap tall"><canvas id="v-types"></canvas></div>`)}

    <div style="height:10px"></div>

    <div class="grid g2">
      ${panel('Type mix', 'share of all visits in the loaded period', mixTable(rows, total))}
      ${locs.length
        ? panel('By location', 'total visits in the loaded period',
            `<div class="chart-wrap"><canvas id="v-locs"></canvas></div>`)
        : panel('By location', 'unavailable',
            empty('this export has no location column'))}
    </div>
  `;

  wireUpload(root, ctx);

  // --- charts -------------------------------------------------------------
  const weeks = weeklyAll.map((p) => p.t);
  const labels = weeks.map((t) => {
    const d = new Date(t + 'T00:00:00Z');
    return d.toLocaleDateString('en-US', { month: 'short', day: '2-digit', timeZone: 'UTC' });
  });

  const topTypes = types
    .map((t) => ({ t, n: rows.filter((r) => r.type === t).reduce((a, r) => a + r.visits, 0) }))
    .sort((a, b) => b.n - a.n).slice(0, 8).map((x) => x.t);

  line(document.getElementById('v-types'), {
    labels,
    datasets: (topTypes.length ? topTypes : ['(all)']).map((t, i) => {
      const s = new Map(volWeekly(rows, (r) => (topTypes.length ? r.type === t : true))
        .map((p) => [p.t, p.v]));
      return {
        label: t,
        data: weeks.map((w) => (s.has(w) ? s.get(w) : null)),
        borderColor: PALETTE[i % PALETTE.length],
        backgroundColor: 'transparent',
      };
    }),
  });

  if (locs.length) {
    const byLoc = locs.map((l) => ({
      l, n: rows.filter((r) => r.location === l).reduce((a, r) => a + r.visits, 0),
    })).sort((a, b) => b.n - a.n).slice(0, 15);
    bar(document.getElementById('v-locs'), {
      labels: byLoc.map((x) => x.l),
      datasets: [{ label: 'visits', data: byLoc.map((x) => x.n),
                   backgroundColor: hexA('#22d3ee', 0.75) }],
      options: { indexAxis: 'y', plugins: { legend: { display: false } } },
    });
  }

  // Index vs volume, dual axis.
  const cmp = document.getElementById('v-compare');
  if (cmp) {
    const pm = new Map(ppiWeekly.map((p) => [p.t, p.v]));
    line(cmp, {
      labels,
      datasets: [
        { label: 'PM Pediatrics visits', data: weeks.map((w) => {
            const hit = weeklyAll.find((p) => p.t === w); return hit ? hit.v : null; }),
          borderColor: '#22d3ee', borderWidth: 2, yAxisID: 'y',
          backgroundColor: hexA('#22d3ee', 0.10), fill: true },
        { label: 'pediatric pressure index', data: weeks.map((w) => pm.get(w) ?? null),
          borderColor: '#fbbf24', borderWidth: 1.6, borderDash: [4, 3],
          yAxisID: 'y1', backgroundColor: 'transparent' },
      ],
      options: {
        scales: {
          y: { position: 'left', title: { display: true, text: 'visits',
            color: '#22d3ee', font: { family: 'monospace', size: 9 } } },
          y1: { position: 'right', grid: { drawOnChartArea: false },
            title: { display: true, text: '% ED visits (index)',
              color: '#fbbf24', font: { family: 'monospace', size: 9 } } },
        },
      },
    });
  }
}

/** The index is keyed to CDC's week-ending dates; volumes roll to Mondays. */
function alignToMonday(points) {
  return points.map((p) => {
    const d = new Date(p.t + 'T00:00:00Z');
    const dow = (d.getUTCDay() + 6) % 7;
    d.setUTCDate(d.getUTCDate() - dow);
    return { t: d.toISOString().slice(0, 10), v: p.v };
  });
}

function privacyBar(store) {
  return `<section class="panel" style="border-color:#4ade80">
    <h2 style="color:#4ade80">Private — this file never left your browser
      <span class="sub">${store.fileName || 'loaded file'} · ${store.loadedAt || ''}</span></h2>
    <div class="panel-body">
      <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:center">
        <div style="flex:1;min-width:260px;font-size:11.5px;line-height:1.6;color:#7f8ea0">
          This site is static — there is no server and no upload endpoint. The workbook was read in
          the page and kept in this browser's local storage. It was not transmitted, is not in the
          repository, and is visible to nobody else on this URL.
          ${store.collapsed ? `<br><span class="s-watch">Note: ${store.collapsed}.</span>` : ''}
        </div>
        <div style="display:flex;gap:6px">
          <button class="ghost" id="v-replace">replace file</button>
          <button class="ghost" id="v-clear">erase from this browser</button>
        </div>
      </div>
      <input type="file" id="v-file" accept=".xlsx,.xlsm,.xls,.csv" style="display:none">
      <div id="v-status" class="note" style="display:none"></div>
    </div>
  </section>`;
}

function uploadPrompt() {
  return `<section class="panel">
    <h2>Load PM Pediatrics visit data <span class="sub">stays in this browser</span></h2>
    <div class="panel-body">
      <div style="font-size:12px;line-height:1.7;margin-bottom:12px">
        Pick a spreadsheet with visits by type. <strong>Nothing is uploaded.</strong> This site is
        static — there is no server to receive a file. The workbook is read in the page with
        FileReader, parsed in memory, and stored in this browser only. It never enters the
        repository and is invisible to anyone else opening this URL.
      </div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <button class="ghost" id="v-replace" style="border-color:#22d3ee;color:#22d3ee">
          choose spreadsheet…</button>
        <span style="color:#4b5a6b;font-size:10.5px">.xlsx, .xls or .csv</span>
      </div>
      <input type="file" id="v-file" accept=".xlsx,.xlsm,.xls,.csv" style="display:none">
      <div id="v-status" class="note" style="display:none"></div>
      <div class="note">Columns are detected by name — date, visit type, visits, and optionally
      location and age band. The mapping is shown after loading so you can check it. A date and a
      visit-count column are the only hard requirements.</div>
      <div class="note gap">If this came from the board portal, it is confidential. Keeping it in the
      browser is the safe path; do not commit it to the repository, which is public.</div>
    </div>
  </section>`;
}

function wireUpload(root, ctx) {
  const input = root.querySelector('#v-file');
  const pick = root.querySelector('#v-replace');
  const wipe = root.querySelector('#v-clear');
  const status = root.querySelector('#v-status');
  if (pick && input) pick.onclick = () => input.click();
  if (wipe) wipe.onclick = () => {
    if (confirm('Erase the loaded visit data from this browser?')) { clear(); rerender(); }
  };
  if (!input) return;

  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    status.style.display = '';
    status.innerHTML = `reading ${file.name}…`;
    try {
      const buf = await file.arrayBuffer();
      const parsed = parseWorkbook(buf);
      const payload = save({
        ...parsed, fileName: file.name,
        loadedAt: new Date().toISOString().slice(0, 16).replace('T', ' '),
      });
      const mapped = Object.entries(parsed.cols)
        .map(([k, v]) => `${k} → ${v}`).join(' · ');
      status.innerHTML = `<strong class="s-ok">loaded.</strong> ${parsed.rawRows.toLocaleString()}
        rows from sheet "${parsed.sheetName}"${parsed.skipped ? `, ${parsed.skipped} skipped` : ''}.
        <br>columns detected: ${mapped}`;
      setTimeout(rerender, 900);
    } catch (e) {
      status.innerHTML = `<strong class="s-critical">could not read that file.</strong> ${e.message}`;
    }
  };
}

/**
 * Does the public index actually track PM Pediatrics volume?
 *
 * Reported on levels AND growth rates, because levels share a seasonal wave and
 * will look impressively correlated even when the index has no predictive
 * content -- the same trap the wastewater layer had to be protected from.
 */
function validationPanel(xcLevel, xcGrowth, overlap, ppiWeekly, weekly, controls = []) {
  if (overlap < 8) {
    return panel('Does the index predict your volume?', `only ${overlap} overlapping weeks`,
      `${empty('need at least 8 overlapping weeks to say anything')}
       <div class="note">The loaded file and the CDC index must cover the same weeks. NSSP data
       begins 2022-09; if your export predates that, or is monthly rather than weekly, the overlap
       will be too thin.</div>`);
  }
  const L = xcLevel.peak;
  const G = xcGrowth.peak;
  const verdict = !G ? { t: 'INCONCLUSIVE', c: 'ok' }
    : G.r >= 0.6 ? { t: 'STRONG', c: 'elevated' }
    : G.r >= 0.35 ? { t: 'MODERATE', c: 'watch' }
    : { t: 'WEAK', c: 'ok' };

  return `<section class="panel" style="border-color:#22d3ee">
    <h2 style="color:#22d3ee">Does the index predict your volume?
      <span class="sub">${overlap} overlapping weeks · the only ground truth in this dashboard</span></h2>
    <div class="panel-body">
      <div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap;margin-bottom:10px">
        ${levelBadge(verdict.t, verdict.c)}
        <div style="font-size:11px;color:#7f8ea0">
          growth-rate peak <strong>${G ? `r=${G.r.toFixed(2)} @ ${G.lag > 0 ? '+' : ''}${G.lag}w` : '--'}</strong>
          · level peak <strong>${L ? `r=${L.r.toFixed(2)} @ ${L.lag > 0 ? '+' : ''}${L.lag}w` : '--'}</strong>
        </div>
      </div>
      <div class="chart-wrap tall"><canvas id="v-compare"></canvas></div>
      <div class="note warn">
        Judge this on the <strong>growth-rate</strong> number, not the level one. Both series ride the
        same respiratory season, so their levels will correlate even if the index carries no
        predictive information at all. Growth rates strip the shared seasonality out.
        ${G && G.lag > 0
          ? ` A positive lag of ${G.lag} week${G.lag === 1 ? '' : 's'} means the index moves first —
              that is the lead time you would actually be staffing against.`
          : G && G.lag <= 0
          ? ` The peak sits at lag ${G.lag}, meaning the index does <strong>not</strong> lead your
              volume. Treat it as a concurrent read, not an early warning.`
          : ''}
      </div>
      ${controls.length > 1 ? `
      <table class="dt" style="margin-top:10px">
        <thead><tr><th>Category</th><th>Visits</th><th>Level r</th><th>Lag</th><th>Growth r</th></tr></thead>
        <tbody>${controls.map((c) => `<tr>
          <td>${c.respiratory ? `<strong class="s-ok">${c.name}</strong>` : c.name}
            ${!c.respiratory && Math.abs(c.L?.r ?? 0) < 0.3 ? ' <span class="badge" style="color:#7f8ea0">control</span>' : ''}</td>
          <td class="num">${c.n.toLocaleString()}</td>
          <td class="num ${(c.L?.r ?? 0) > 0.6 ? 's-elevated' : ''}">${c.L ? c.L.r.toFixed(2) : '--'}</td>
          <td class="num" style="color:#7f8ea0">${c.L ? `${c.L.lag > 0 ? '+' : ''}${c.L.lag}w` : '--'}</td>
          <td class="num">${c.G ? c.G.r.toFixed(2) : '--'}</td>
        </tr>`).join('')}</tbody>
      </table>
      <div class="note gap"><strong>This table is the actual evidence.</strong> If the index only
      appeared to work because both series rise every winter, then a non-respiratory category would
      correlate just as well. The categories that are not respiratory act as controls: a high level
      correlation for respiratory visits alongside a near-zero one for injuries means the signal is
      real and not shared seasonality. If every row correlates equally, the index is measuring the
      calendar, not demand.</div>` : ''}

      <div class="note">If this comes back weak, that is a real finding and not a failure — it would
      mean the staffing multipliers on this site are not earning their keep for your markets, and the
      visit-mix weights or the choice of ED-visit share as a proxy need revisiting.</div>
    </div>
  </section>`;
}

function mixTable(rows, total) {
  const by = new Map();
  for (const r of rows) by.set(r.type, (by.get(r.type) || 0) + r.visits);
  const ranked = [...by.entries()].sort((a, b) => b[1] - a[1]);
  if (!ranked.length || (ranked.length === 1 && ranked[0][0] === '(all)')) {
    return empty('this export has no visit-type column');
  }
  return `<div class="scroll-y"><table class="dt">
    <thead><tr><th>Visit type</th><th>Visits</th><th>Share</th><th style="text-align:left">·</th></tr></thead>
    <tbody>${ranked.map(([t, n], i) => `<tr>
      <td><span style="color:${PALETTE[i % PALETTE.length]}">■</span> ${t}</td>
      <td class="num">${n.toLocaleString()}</td>
      <td class="num">${((n / total) * 100).toFixed(1)}%</td>
      <td style="text-align:left"><div style="height:8px;width:${((n / ranked[0][1]) * 100).toFixed(0)}%;background:${PALETTE[i % PALETTE.length]}"></div></td>
    </tr>`).join('')}</tbody></table></div>`;
}
