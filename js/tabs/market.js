// Market supply: who else is opening urgent care in NY / NJ / CT.
//
// The honest framing, stated up front and repeated in the UI: there is NO
// public dataset of urgent care openings and closures. This tab shows
// organisation NPI registrations carrying the urgent-care taxonomy, which is a
// weak proxy for market ENTRY and no proxy at all for EXIT. The limitations
// panel is not boilerplate -- it is the most useful thing here, because it
// stops a plausible-looking count from being mistaken for a site census.

import { panel, num, delta, empty, tile, levelBadge } from '../ui.js';
import { line, bar, hexA } from '../charts.js';
import { MARKETS } from '../config.js';
import { fmtDate } from '../data.js';
import { rerender } from '../app.js';

const STATE_COLOR = { NY: '#22d3ee', NJ: '#fbbf24', CT: '#4ade80' };

export default function market(root, ctx) {
  const ms = ctx.db.market_supply;
  const ledger = ctx.db.market_events;

  if (!ms || !ms.states) {
    root.innerHTML = empty('market_supply snapshot missing — run scripts/fetch_market.py');
    return;
  }

  const states = ms.states;
  const years = [...new Set(Object.values(states)
    .flatMap((s) => Object.keys(s.by_year || {})))].sort().filter((y) => y >= '2016');
  const curYear = String(new Date().getUTCFullYear());

  const events = (ledger?.events || [])
    .filter((e) => e.operator && !e.operator.startsWith('EXAMPLE'))
    .sort((a, b) => (a.date < b.date ? 1 : -1));

  const cl = ctx.db.closures;

  root.innerHTML = `
    ${closurePanel(cl)}

    <div style="height:10px"></div>

    ${limitations(ms)}

    <div style="height:10px"></div>

    <div class="grid g3" style="margin-bottom:10px">
      ${MARKETS.states.map((full) => {
        const ab = MARKETS.abbr[full];
        const s = states[ab];
        if (!s) return tile(ab, '--', 'no data');
        const yr = s.by_year || {};
        const thisYear = yr[curYear] || 0;
        const lastYear = yr[String(+curYear - 1)] || 0;
        return `<div class="tile">
          <div class="label">${ab} · urgent-care entities</div>
          <div class="value" style="font-size:24px">${s.total.toLocaleString()}</div>
          <div class="foot">
            ${thisYear} registered in ${curYear} (partial) · ${lastYear} in ${+curYear - 1}<br>
            ${s.independent} unmatched to a tracked chain
          </div>
        </div>`;
      }).join('')}
    </div>

    ${panel('New registrations per year', 'NPPES enumeration date · entity, not site',
      `<div class="chart-wrap tall"><canvas id="c-entries"></canvas></div>
       <div class="note warn">${curYear} is a partial year — it covers only the weeks elapsed so far,
       so the final bar always understates. Registration dates also precede any site opening by an
       unknown lag, and one registration can cover many sites or none.</div>`)}

    <div style="height:10px"></div>

    <div class="grid g2">
      ${panel('Tracked operators', 'name matching · badly incomplete, see note',
        chainTable(states, ms))}
      ${panel('Manual event ledger', 'openings & closures you record by hand',
        ledgerPanel(events))}
    </div>

    <div style="height:10px"></div>

    ${panel('Recent registrations', 'most recent first · unverified',
      recentTable(ms.recent || []), { tight: true })}
  `;

  // registrations per year, grouped bars
  bar(document.getElementById('c-entries'), {
    labels: years,
    datasets: MARKETS.states.map((full) => {
      const ab = MARKETS.abbr[full];
      return {
        label: ab,
        data: years.map((y) => states[ab]?.by_year?.[y] ?? 0),
        backgroundColor: hexA(STATE_COLOR[ab], 0.75),
      };
    }),
    options: {
      scales: {
        x: { stacked: false },
        y: { beginAtZero: true, title: { display: true, text: 'new entity registrations',
          color: '#4b5a6b', font: { family: 'monospace', size: 9 } } },
      },
    },
  });
}

/**
 * The closure ledger. This is the only place in the dashboard that reports
 * something no registry publishes, so the evidence travels with every row:
 * when the page was first and last archived, what the live URL does today, and
 * a link straight into the Wayback capture so any row can be checked by hand.
 */
function closurePanel(cl) {
  if (!cl || !cl.operators) {
    return panel('Closure ledger', 'not loaded',
      empty('run scripts/fetch_closures.py'));
  }
  const events = cl.operators.flatMap((o) => o.events || []);
  const closed = events.filter((e) => e.verdict === 'closed');
  const inMarket = closed.filter((e) => e.in_market);
  const consolidated = events.filter((e) => e.verdict === 'consolidated');
  const tracked = cl.operators.filter((o) => !o.error && o.roster);

  const openings = cl.operators.flatMap((o) => o.openings || [])
    .filter((o) => o.in_market && o.first_seen);
  const byYear = {};
  for (const o of openings) byYear[o.first_seen.slice(0, 4)] = (byYear[o.first_seen.slice(0, 4)] || 0) + 1;

  const row = (e) => `<tr>
    <td><strong>${e.state || '·'}</strong></td>
    <td style="text-align:left">${e.operator}</td>
    <td style="text-align:left">${e.slug.split('/').pop()}
      <div style="color:#4b5a6b;font-size:10px">${e.why}</div></td>
    <td class="num" style="color:#7f8ea0">${e.first_seen}</td>
    <td class="num" style="color:#7f8ea0">${e.last_seen}</td>
    <td style="text-align:left"><a href="${e.wayback}" target="_blank" rel="noopener">archive</a></td>
  </tr>`;

  return `<section class="panel" style="border-color:#22d3ee">
    <h2 style="color:#22d3ee">Closure ledger — reconstructed from the Internet Archive
      <span class="sub">${tracked.length} operators tracked · verified ${cl.fetched_at ? cl.fetched_at.slice(0, 10) : '--'}</span></h2>
    <div class="panel-body">
      <div class="grid g4" style="margin-bottom:10px">
        ${tile('Closures in market', `<span class="s-critical">${inMarket.length}</span>`,
          'NY / NJ / CT, each verified live')}
        ${tile('Closures all markets', String(closed.length), 'includes out-of-footprint sites')}
        ${tile('Consolidations', String(consolidated.length),
          'redirected into another site — not closures')}
        ${tile('Operators tracked', String(tracked.length),
          `${tracked.reduce((a, o) => a + (o.roster || 0), 0)} live locations`)}
      </div>

      ${inMarket.length ? `<table class="dt">
        <thead><tr><th>St</th><th style="text-align:left">Operator</th><th style="text-align:left">Site</th>
          <th>First archived</th><th>Last archived</th><th style="text-align:left">Evidence</th></tr></thead>
        <tbody>${inMarket.map(row).join('')}</tbody>
      </table>` : empty('no in-market closures detected')}

      <div class="note warn">
        <strong>How each row was established.</strong> Every location page the operator has ever
        published is recovered from the Wayback CDX index, diffed against their live sitemap, and then
        <em>the surviving candidate is fetched live</em>. Only a 404, or a redirect to the location
        finder, is called a closure. A redirect to a different site is a consolidation and a redirect
        to the same site is a slug rename — both are excluded. That last step is what separates a real
        closure from a website redesign, and it removed
        ${events.length - closed.length} of ${events.length} candidates here.
      </div>

      <div class="note gap">
        <strong>last archived is not the closing date.</strong> It is the last time the crawler
        happened to capture the page, so the true closure falls somewhere after it — sometimes a year
        after. Treat these as "closed by roughly this date", never as a filing.
        ${closed.some((e) => e.slug.includes('summit-health'))
          ? ' Several CityMD New Jersey rows carry "summit-health-hub" slugs; CityMD and Summit Health merged, so those may be rebrands rather than closed doors — worth a manual check before acting on them.'
          : ''}
      </div>

      ${Object.keys(byYear).length ? `<div class="note">
        <strong>Openings.</strong> ${openings.length} in-market locations have a first archive capture,
        by year: ${Object.entries(byYear).sort().map(([y, n]) => `${y}:${n}`).join(' · ')}.
        A first capture is an <em>upper bound</em> on the opening date — the page can only be archived
        after it exists, and often well after.
      </div>` : ''}

      <div class="note">Tracked: ${cl.operators.map((o) => `${o.name}${o.error ? ' <span class="s-watch">(no roster)</span>' : ''}`).join(' · ')}.
      Operators without a public location sitemap cannot be tracked this way — AFC runs franchise sites
      and publishes only blog pages nationally, and several regional groups publish no sitemap at all.</div>
    </div>
  </section>`;
}

function limitations(ms) {
  return `<section class="panel" style="border-color:#f97316">
    <h2 style="color:#f97316">⚠ What this tab is — and is not
      <span class="sub">read before quoting any number here</span></h2>
    <div class="panel-body">
      <div style="font-size:12px;margin-bottom:8px">
        <strong>There is no public dataset of urgent care openings and closures.</strong>
        That was checked, not assumed:
      </div>
      <table class="dt">
        <thead><tr><th>Source</th><th style="text-align:left">Openings</th><th style="text-align:left">Closures</th><th style="text-align:left">Covers urgent care?</th></tr></thead>
        <tbody>
          <tr><td>CMS NPPES NPI registry</td>
            <td style="text-align:left">registration date — <span class="s-watch">entity, not site</span></td>
            <td style="text-align:left"><span class="s-critical">not exposed by the API</span></td>
            <td style="text-align:left">yes, but self-reported taxonomy</td></tr>
          <tr><td>NY facility file <code>vn5v-hh5r</code></td>
            <td style="text-align:left">has <code>fac_opn_dat</code></td>
            <td style="text-align:left"><span class="s-critical">no close date; active-only file</span></td>
            <td style="text-align:left"><span class="s-critical">no urgent care type at all</span></td></tr>
          <tr><td>NY Certificate of Need <code>h343-jwie</code></td>
            <td style="text-align:left">establishment filings</td>
            <td style="text-align:left"><span class="s-critical">no closure category</span></td>
            <td style="text-align:left"><span class="s-critical">0 of 400 D&amp;TC records since 2023</span></td></tr>
          <tr><td>NJ / CT open data portals</td>
            <td style="text-align:left"><span class="s-critical">nothing published</span></td>
            <td style="text-align:left"><span class="s-critical">nothing published</span></td>
            <td style="text-align:left">—</td></tr>
        </tbody>
      </table>
      <div class="note gap">
        Most freestanding urgent care operates as a physician practice, outside the facility-licensure
        regimes that would otherwise record an opening or a closing. Nobody is obliged to publish a
        closure, and closed sites routinely keep a live NPI for years.
      </div>
      <div class="note warn">
        <strong>So the counts below measure entity registrations, a proxy for market entry.</strong>
        They are not a site census and they contain no exit signal whatsoever. PM Pediatrics shows
        ${ms.states?.NY?.by_chain?.['PM Pediatrics'] ?? '~13'} New York entities against roughly
        thirty New York locations — that ratio is the clearest illustration that registrations and
        sites are different things.
      </div>
      ${(ms.warnings || []).length ? `<div class="note gap">${ms.warnings.join('<br>')}</div>` : ''}
    </div>
  </section>`;
}

function chainTable(states, ms) {
  const rows = [];
  const all = new Map();
  for (const [ab, s] of Object.entries(states)) {
    for (const [chain, n] of Object.entries(s.by_chain || {})) {
      if (!all.has(chain)) all.set(chain, { NY: 0, NJ: 0, CT: 0 });
      all.get(chain)[ab] = n;
    }
  }
  for (const [chain, counts] of [...all.entries()]
    .sort((a, b) => (b[1].NY + b[1].NJ + b[1].CT) - (a[1].NY + a[1].NJ + a[1].CT))) {
    rows.push(`<tr>
      <td>${chain === 'PM Pediatrics' ? `<strong class="s-ok">${chain}</strong>` : chain}</td>
      <td class="num">${counts.NY || '·'}</td>
      <td class="num">${counts.NJ || '·'}</td>
      <td class="num">${counts.CT || '·'}</td>
    </tr>`);
  }
  const missed = (ms.chains_tracked || []).filter((c) => !all.has(c));

  return `<table class="dt">
      <thead><tr><th>Operator</th><th>NY</th><th>NJ</th><th>CT</th></tr></thead>
      <tbody>${rows.join('') || '<tr><td colspan="4" style="color:#4b5a6b">no chain matches</td></tr>'}</tbody>
    </table>
    <div class="note gap"><strong>This table badly understates chain presence.</strong>
    CityMD operates on the order of 150 New York sites and returns
    <strong>zero</strong> matches here, because taxonomy is self-reported and large groups often bill
    through a single corporate NPI that carries a different taxonomy entirely. Absence from this table
    is not absence from the market.
    ${missed.length ? `<br>Tracked but unmatched: ${missed.join(', ')}.` : ''}</div>`;
}

function ledgerPanel(events) {
  if (!events.length) {
    return `<div class="empty" style="text-align:left;padding:14px">
      <div style="color:#7f8ea0;font-size:11.5px;line-height:1.6">
        <strong style="color:#d8e0e8">Empty by design.</strong><br><br>
        Since no feed publishes openings and closures, this is where you record what you learn —
        a press release, a local paper, a broker call, a drive-past.<br><br>
        Edit <code style="color:#22d3ee">data/market_events.json</code> and add entries with
        <code>date</code>, <code>type</code> (open / close / relocate / acquire), <code>operator</code>,
        <code>site</code>, <code>state</code>, <code>conf</code> and a <code>source</code> URL.
        They render here and survive the nightly refresh, which never touches this file.
      </div>
    </div>`;
  }
  const cls = { open: 'critical', close: 'ok', relocate: 'watch', acquire: 'watch' };
  return `<div class="scroll-y"><table class="dt">
    <thead><tr><th>Date</th><th style="text-align:left">Type</th><th style="text-align:left">Operator / site</th><th>Conf</th></tr></thead>
    <tbody>${events.map((e) => `<tr>
      <td>${e.date || '--'}</td>
      <td style="text-align:left">${levelBadge(e.type || '?', cls[e.type] || 'watch')}</td>
      <td style="text-align:left">
        <strong>${e.operator}</strong>
        <div style="color:#4b5a6b;font-size:10px">${e.site || ''} ${e.state ? `· ${e.state}` : ''}
        ${e.source ? `· <a href="${e.source}" target="_blank" rel="noopener">source</a>` : ''}</div>
      </td>
      <td class="num" style="color:#7f8ea0;font-size:10px">${e.conf || '--'}</td>
    </tr>`).join('')}</tbody>
  </table></div>
  <div class="note">Hand-maintained. Nothing here is fetched or verified by any script.</div>`;
}

function recentTable(recent) {
  if (!recent.length) return empty('no recent registrations');
  const genericish = (n) => /^[A-Z]{6,10}\s+(LLC|INC|CORP)\.?$/.test(n || '');
  const flagged = recent.filter((r) => genericish(r.name)).length;
  return `<div class="scroll-y"><table class="dt">
      <thead><tr><th>Registered</th><th>State</th><th style="text-align:left">Entity</th><th style="text-align:left">City</th><th style="text-align:left">Operator</th></tr></thead>
      <tbody>${recent.slice(0, 120).map((r) => `<tr>
        <td>${r.enumerated}</td>
        <td class="num" style="color:${STATE_COLOR[r.state]}">${r.state}</td>
        <td style="text-align:left">${r.name}${genericish(r.name)
          ? ' <span class="s-watch" title="generic entity name — often a billing vehicle rather than a clinic">?</span>' : ''}</td>
        <td style="text-align:left;color:#7f8ea0">${r.city || '--'}</td>
        <td style="text-align:left;color:#7f8ea0">${r.chain || '<span style="color:#4b5a6b">independent</span>'}</td>
      </tr>`).join('')}</tbody>
    </table></div>
    <div class="note warn">Individual rows are <strong>unverified</strong>. ${flagged} of the
    ${recent.length} shown carry generic entity names of the form "XXXXXX LLC"
    (marked <span class="s-watch">?</span>) — these are frequently billing vehicles or holding
    companies rather than clinics. Read the aggregate trend, not the individual line.</div>`;
}
