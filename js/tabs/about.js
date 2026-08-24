// About — the front door, written for someone seeing the site for the first
// time. The audience is management, not the operator: it explains what this
// is, where every number comes from, how to read the constructs, and exactly
// what happens to company data. The source table is generated from the live
// manifest so it cannot drift out of date.

import { panel, tile, empty } from '../ui.js';
import { fmtDate } from '../data.js';

export default function about(root, ctx) {
  const mf = ctx.manifest || {};
  const sources = mf.sources || {};
  const snapAt = (mf.generated_at || '').slice(0, 10);
  const okCount = Object.values(sources).filter((s) => s.ok).length;

  const cdcRows = Object.entries(sources).map(([key, s]) => `<tr>
    <td style="text-align:left"><code>${s.dataset || key}</code></td>
    <td style="text-align:left">${s.source || key}</td>
    <td style="text-align:left">${s.geography || '--'}</td>
    <td>${s.cadence || '--'}</td>
    <td class="num">${s.last ? String(s.last).slice(0, 10) : '--'}</td>
    <td>${s.ok ? '<span class="s-ok">live</span>' : '<span class="s-critical">failed</span>'}</td>
  </tr>`).join('');

  root.innerHTML = `
    <section class="panel" style="border-color:#22d3ee">
      <h2 style="color:#22d3ee">What this is</h2>
      <div class="panel-body" style="font-size:12.5px;line-height:1.75;max-width:900px">
        <p style="margin:0 0 10px">
          A decision-support terminal for PM Pediatrics built around one question:
          <strong>how much pediatric respiratory demand is coming, and is the business capturing
          it?</strong> Pediatric urgent care is a seasonal machine — most of the year's volume arrives
          in a handful of winter weeks — so the operating problem is anticipation: staffing, hours and
          capacity decisions made ahead of the wave rather than inside it.
        </p>
        <p style="margin:0 0 10px">
          The site has two halves. The <strong>public half</strong> (every tab except the two marked ▪)
          rebuilds itself daily from public health surveillance — CDC emergency-department data, lab
          test positivity, wastewater, and market-supply sources. It answers: <em>what is the disease
          environment doing?</em> The <strong>private half</strong> (Volumes ▪ and Report ▪) analyzes
          PM Pediatrics' own visit data against that environment. It answers: <em>how is the business
          performing relative to what the environment handed it?</em>
        </p>
        <p style="margin:0">
          That separation matters because a raw volume number is ambiguous — down 10% can be a bad
          business in a normal season or a resilient business in a terrible one. Everything here is
          built to separate the <strong>season</strong> from the <strong>business</strong>.
        </p>
      </div>
    </section>

    <div style="height:10px"></div>

    <section class="panel" style="border-color:#4ade80">
      <h2 style="color:#4ade80">Where company data goes — and where it cannot go</h2>
      <div class="panel-body" style="font-size:12px;line-height:1.7;max-width:900px">
        <p style="margin:0 0 8px">
          <strong>Company data never leaves the browser it is loaded in.</strong> This site is a
          static page — there is no server behind it, no upload endpoint, no database. When a
          spreadsheet is loaded on the Volumes tab, the browser reads the file locally, computes every
          chart in-page, and keeps the parsed data in that browser's local storage only. Close the
          file, and it was never anywhere else.
        </p>
        <ul style="margin:0 0 8px 18px;padding:0">
          <li>Nothing is transmitted — that is a property of the architecture, not a policy promise.</li>
          <li>The site's public code contains the <em>analysis machinery</em>, never a company figure.</li>
          <li>Anyone else opening this URL sees only the public surveillance half.</li>
          <li>“Erase all from this browser” on the Volumes tab removes every trace.</li>
        </ul>
        <p style="margin:0;color:#7f8ea0">
          Practical consequence for presenting: load the spreadsheet on the machine you present from.
          The private tabs are empty on any other device — by design.
        </p>
      </div>
    </section>

    <div style="height:10px"></div>

    ${panel(`Public data sources — refreshed daily, ${okCount}/${Object.keys(sources).length || '--'} live`,
      `snapshot ${snapAt || '--'} · table generated from the live pipeline manifest`,
      `<div style="overflow-x:auto"><table class="dt">
        <thead><tr><th style="text-align:left">Dataset</th><th style="text-align:left">What it measures</th>
        <th style="text-align:left">Geography</th><th>Cadence</th><th>Data through</th><th>Status</th></tr></thead>
        <tbody>${cdcRows || '<tr><td colspan="6">manifest unavailable</td></tr>'}</tbody>
      </table></div>
      <div class="note">A pipeline pulls these from CDC's public APIs every morning and commits the
      snapshots this site serves. The masthead also probes CDC live from your browser on every page
      load — if the pipeline ever stops, a banner says so rather than letting stale data pass as
      current. Public surveillance runs roughly one week behind reality; that lag is CDC's reporting
      pipeline and applies to everyone.</div>
      <div class="note" style="margin-top:6px">
        <strong>Non-CDC sources.</strong>
        Market entities: CMS NPPES registry (organisation registrations — an entry proxy, not a site
        census). Site census: Overture Maps (open map data, monthly releases). Closures: reconstructed
        from the Internet Archive by diffing operators' own historical location pages against their
        live sites, each candidate verified by fetching it live — closures appear in no public registry,
        so this ledger is built, with evidence links on every row. Literature: Europe PMC, cited and
        linked, never summarised into claims.</div>`)}

    <div style="height:10px"></div>

    ${panel('How to read it — five constructs that carry the site', '',
      `<div style="font-size:12px;line-height:1.7;max-width:900px">
        <p style="margin:0 0 8px"><strong>1 · The Pediatric Pressure Index.</strong> The spine of the
        public half: the share of pediatric emergency-department visits that are respiratory, weighted
        across three age bands. It is this site's own construct (no public index survived to borrow),
        and its full arithmetic is shown on the Exec Summary tab, computed live. The age weights are
        an <span class="assumption">assumption</span> until replaced with actual visit mix — flagged
        wherever they matter.</p>
        <p style="margin:0 0 8px"><strong>2 · Percentiles, not fixed thresholds.</strong> Alert tiers
        rank the present against the series' own history (“the 90th percentile of everything observed”)
        rather than against fixed cutoffs calibrated to a retired CDC metric. Every percentile carries
        its sample size, because four seasons of history is an honest but thin baseline.</p>
        <p style="margin:0 0 8px"><strong>3 · Level vs growth.</strong> Two series that both rise every
        winter will always correlate on <em>levels</em>; that proves seasonality, not signal. The site
        holds itself to the harder test — correlation of week-over-week <em>growth</em> — and reports
        both. Where company data is loaded, injury visits act as a built-in control group: a signal
        that “predicts” counter-seasonal injuries the same as respiratory illness is measuring the
        calendar, not demand.</p>
        <p style="margin:0 0 8px"><strong>4 · Corroboration over automation.</strong> Wastewater is
        wired in as a confidence check on the ED signal, never as an autonomous trigger — measured
        against this site's own data, it tracks levels well but predicts week-to-week turns poorly,
        and the display says so. Signals that failed validation are labelled as failed rather than
        removed.</p>
        <p style="margin:0"><strong>5 · Guards against data artifacts.</strong> Partial trailing weeks
        in exports are detected and excluded loudly (a half-week reads as a volume collapse otherwise);
        week-over-week moves smaller than CDC's rounding step are marked as noise and cannot promote an
        alert tier; year-over-year momentum is always measured against the same calendar weeks, never
        the prior eight.</p>
      </div>`)}

    <div style="height:10px"></div>

    <div class="grid g-2-1">
      ${panel('Suggested walkthrough', 'a presentation path through the tabs',
        `<table class="dt">
          <thead><tr><th style="text-align:left">Stop</th><th style="text-align:left">What it shows</th></tr></thead>
          <tbody>
            <tr><td style="text-align:left"><a href="#exec">Exec Summary</a></td>
              <td style="text-align:left">The disease environment now: index, season topography vs prior
              years, wastewater check, and the index's full derivation.</td></tr>
            <tr><td style="text-align:left"><a href="#year">2026</a></td>
              <td style="text-align:left">The year in question: below, at, or above trend — computed
              week-by-week against every prior observed year, with the windows where it deviates.</td></tr>
            <tr><td style="text-align:left"><a href="#report">Report ▪</a></td>
              <td style="text-align:left">The executive analysis of company volume — load the master
              dataset on Volumes first. Season vs business, environment-adjusted performance, service
              lines, sites.</td></tr>
            <tr><td style="text-align:left"><a href="#volumes">Volumes ▪</a></td>
              <td style="text-align:left">The working analytics behind the report, including the
              ground-truth test of whether the public index actually tracks company volume.</td></tr>
            <tr><td style="text-align:left"><a href="#staffing">Staffing</a></td>
              <td style="text-align:left">The alert engine: percentile tiers, the acceleration rule, and
              the visit-mix weights (editable, browser-only).</td></tr>
            <tr><td style="text-align:left"><a href="#market">Market Supply</a></td>
              <td style="text-align:left">Competitive context: the site census, entry registrations, and
              the closure ledger with evidence links.</td></tr>
            <tr><td style="text-align:left"><a href="#explain">Why</a></td>
              <td style="text-align:left">Candidate explanations for the season, tested where possible
              against this site's own record, with cited literature.</td></tr>
          </tbody>
        </table>`)}

      ${panel('What this is not', 'read before relying on any number',
        `<div style="font-size:11.5px;line-height:1.7">
          <p style="margin:0 0 8px">Not clinical guidance — a planning tool for staffing and capacity.</p>
          <p style="margin:0 0 8px">Not a forecast engine. The 8-week projection is a labelled
          heuristic resting on a handful of seasons; direction is the signal, levels are estimates.</p>
          <p style="margin:0 0 8px">Not free of assumptions — but every assumption is marked
          <span class="assumption">assumption</span> at the point of use, and the single largest one
          (age-band visit mix) is replaceable with company data in one control.</p>
          <p style="margin:0">Public surveillance is national or regional; company data is the only
          site-level truth here. Where the two disagree, the residual — performance the environment
          cannot explain — is usually the interesting number.</p>
        </div>`)}
    </div>
  `;
}
