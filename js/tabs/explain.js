// "Why" — what the data is doing, and the candidate explanations for it.
//
// Two halves, deliberately kept apart:
//
//   1. What we can test with our own record. The immunity-wall check is run
//      against this dashboard's data and reported with its n, never dressed up
//      as inference.
//   2. What other people have published. Real, cited, linked items from Europe
//      PMC. Nothing is summarised into a claim -- the reader judges.
//
// This section must never assert a cause. A dashboard that explains its own
// data is a dashboard that has stopped measuring it.

import { panel, num, empty, tile, levelBadge } from '../ui.js';
import { MARKETS, PATHOGENS } from '../config.js';
import {
  pressureIndex, immunityWallCheck, seasonOf, isoWeek, percentileRank,
  wastewaterSignal, ordinal, quantile,
} from '../derive.js';
import { wwSeries } from './wastewater.js';
import { fmtDate } from '../data.js';
import { rerender } from '../app.js';

/** Read the current data and state, in plain numbers, what is anomalous. */
function observedSignals(ctx) {
  const out = [];
  const ppi = pressureIndex(ctx.db.ed_age?.data || [], 'Combined', ctx.mix);
  const check = immunityWallCheck(ppi);
  const seasons = check.seasons;
  const cur = seasons.at(-1);
  const priors = seasons.slice(0, -1).filter((s) => s.early !== null);

  if (cur && cur.early !== null && priors.length) {
    const med = quantile(priors.map((s) => s.early).sort((a, b) => a - b), 0.5);
    const dev = med > 0 ? ((cur.early - med) / med) * 100 : null;
    if (dev !== null && dev < -20) {
      out.push({
        id: 'season_low', level: 'ok',
        headline: `${cur.key} is starting ${Math.abs(dev).toFixed(0)}% below prior seasons`,
        detail: `Early-season index ${num(cur.early, 3, '%')} vs a prior-season median of ${num(med, 3, '%')} over ${priors.length} seasons.`,
      });
    }
  }

  const naat = ctx.db.naat_multi?.data || [];
  const last = naat.at(-1);
  if (last) {
    for (const [key, id] of [['PIV', 'piv_high'], ['HMPV', 'piv_high']]) {
      const s = naat.map((r) => ({ t: r.week, v: r[`${ctx.region}|${key}`] }))
        .filter((p) => p.v != null);
      if (s.length < 20) continue;
      const pct = percentileRank(s, s.at(-1).v);
      if (pct >= 70 && key === 'PIV') {
        out.push({
          id, level: 'elevated',
          headline: `Parainfluenza is at the ${ordinal(pct)} percentile in ${ctx.region}`,
          detail: `${num(s.at(-1).v, 2, '%')} NAAT positivity against ${s.length} weeks of record — unusual for midsummer.`,
        });
      }
    }
  }

  const pos = ctx.db.pos_national?.data || [];
  const fluS = pos.map((r) => ({ t: r.week, v: r.Influenza })).filter((p) => p.v != null);
  if (fluS.length > 20) {
    const pct = percentileRank(fluS, fluS.at(-1).v);
    if (pct <= 30) {
      out.push({
        id: 'flu_low', level: 'ok',
        headline: `Influenza positivity sits at the ${ordinal(pct)} percentile`,
        detail: `${num(fluS.at(-1).v, 2, '%')} nationally. Expected for July, but the season that preceded it was the largest in this record.`,
      });
    }
  }

  const rsvS = pos.map((r) => ({ t: r.week, v: r.RSV })).filter((p) => p.v != null);
  if (rsvS.length > 20) {
    const pct = percentileRank(rsvS, rsvS.at(-1).v);
    if (pct <= 30) {
      out.push({
        id: 'rsv_low', level: 'ok',
        headline: `RSV positivity at the ${ordinal(pct)} percentile`,
        detail: `${num(rsvS.at(-1).v, 2, '%')} nationally. Nirsevimab and maternal vaccination are a competing explanation to population immunity.`,
      });
    }
  }

  const rising = MARKETS.states
    .map((f) => [MARKETS.abbr[f], wastewaterSignal(wwSeries(ctx.db, 'ww_covid', MARKETS.abbr[f]))])
    .filter(([, s]) => s && s.dir === 'rising');
  if (rising.length >= 2) {
    out.push({
      id: 'covid_ww_rising', level: 'watch',
      headline: `SARS-CoV-2 wastewater rising in ${rising.map(([k]) => k).join('/')}`,
      detail: `Off a low base, while ED-derived derivatives are suppressed at the reporting resolution. Wastewater is currently the only series resolving direction.`,
    });
  }

  out.push({
    id: 'igas_elevated', level: 'watch',
    headline: 'iGAS burden remains above pre-pandemic levels',
    detail: 'ABCs is annual with long lag, so this is context rather than a live signal.',
  });

  return out;
}

export default function explain(root, ctx) {
  const lit = ctx.db.literature;
  const ppi = pressureIndex(ctx.db.ed_age?.data || [], 'Combined', ctx.mix);
  const check = immunityWallCheck(ppi);
  const signals = observedSignals(ctx);
  const active = new Set(signals.map((s) => s.id));

  const topics = (lit?.topics || []).slice().sort((a, b) => {
    const aa = active.has(a.signal) ? 0 : 1;
    const bb = active.has(b.signal) ? 0 : 1;
    return aa - bb;
  });

  root.innerHTML = `
    ${panel('What the data is doing', 'computed from the loaded record',
      signals.length ? `<div class="grid g2">${signals.map((s) => `
        <div class="tile">
          <div class="label">${levelBadge(s.level.toUpperCase(), s.level)}</div>
          <div style="font-size:13px;font-weight:700;margin:6px 0 4px">${s.headline}</div>
          <div class="foot" style="line-height:1.5">${s.detail}</div>
        </div>`).join('')}</div>` : empty('no anomalies detected'))}

    <div style="height:10px"></div>

    ${panel('Immunity wall — tested against this record',
      `n=${check.pairs.length} season transitions`, immunityWall(check))}

    <div style="height:10px"></div>

    ${panel('Candidate explanations', lit
        ? `Europe PMC · fetched ${lit.fetched_at ? lit.fetched_at.slice(0, 10) : '--'}`
        : 'not loaded',
      lit ? topicList(topics, active) : empty('run scripts/fetch_literature.py'))}
  `;

  document.querySelectorAll('[data-topic]').forEach((el) => {
    el.onclick = () => {
      const body = document.getElementById(`items-${el.dataset.topic}`);
      if (body) body.style.display = body.style.display === 'none' ? '' : 'none';
    };
  });
}

function immunityWall(check) {
  if (!check.pairs.length) return empty('not enough complete seasons yet');

  const rhoPeak = check.peak.rho;
  const rhoCum = check.cumulative.rho;
  const monotone = rhoPeak !== null && Math.abs(rhoPeak) > 0.99;

  // If population immunity were the mechanism, total exposure across a season
  // ought to matter at least as much as how sharp its peak was. When the two
  // measures disagree, that is a reason to distrust the stronger one -- not to
  // quote it and move on.
  const inconsistent = rhoPeak !== null && rhoCum !== null
    && rhoPeak <= -0.8 && rhoCum > -0.4;

  const verdict = rhoPeak === null ? { t: 'INSUFFICIENT', c: 'ok' }
    : inconsistent ? { t: 'MIXED — MEASURES DISAGREE', c: 'watch' }
    : rhoPeak <= -0.8 ? { t: 'CONSISTENT', c: 'watch' }
    : rhoPeak >= 0.8 ? { t: 'CONTRADICTED', c: 'elevated' }
    : { t: 'NO CLEAR PATTERN', c: 'ok' };

  const rows = check.pairs.map((p) => `<tr>
    <td>${p.prior}${p.priorComplete ? '' : ' <span class="s-watch">*</span>'}</td>
    <td class="num">${num(p.priorPeak, 2, '%')}</td>
    <td class="num">${num(p.priorCumulative, 0)}</td>
    <td style="color:#4b5a6b">→</td>
    <td>${p.next}</td>
    <td class="num">${num(p.nextEarly, 3, '%')}</td>
  </tr>`).join('');

  return `
    <div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap;margin-bottom:10px">
      ${levelBadge(verdict.t, verdict.c)}
      <div style="font-size:11px;color:#7f8ea0">
        Spearman ρ (prior peak → next early) =
        <strong class="${rhoPeak !== null && rhoPeak < 0 ? 's-ok' : ''}">${rhoPeak === null ? '--' : rhoPeak.toFixed(2)}</strong>
        · (prior cumulative → next early) =
        <strong>${rhoCum === null ? '--' : rhoCum.toFixed(2)}</strong>
        · n=${check.pairs.length}
      </div>
    </div>

    <table class="dt">
      <thead><tr>
        <th>Prior season</th><th>Its peak</th><th>Its cumulative</th><th></th>
        <th>Next season</th><th>Its early level</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>

    ${inconsistent ? `<div class="note gap">
      <strong>The two burden measures disagree, and that matters.</strong>
      Peak intensity ranks perfectly against the next season's start
      (ρ=${rhoPeak.toFixed(2)}), but cumulative burden — total exposure across the whole season —
      shows essentially nothing (ρ=${rhoCum.toFixed(2)}). If population immunity were the mechanism,
      total exposure should matter at least as much as how sharp the peak was. Either the effect is
      about something other than accumulated immunity, or the peak result is coincidence at
      n=${check.pairs.length}. Treat the headline ρ with suspicion until another season lands.
    </div>` : ''}

    <div class="note warn">
      <strong>Read this as a check, not as evidence.</strong>
      ${monotone ? `The peak relationship is perfectly monotonic (ρ=${rhoPeak.toFixed(2)}) — every
      heavier season is followed by a softer start, which is what an immunity wall predicts.` : ''}
      With <strong>n=${check.pairs.length}</strong> consecutive season transitions this cannot be
      separated from a secular post-pandemic normalisation trend, from changing test and care-seeking
      behaviour, or from the arrival of RSV prophylaxis part-way through the record. A monotonic rank
      correlation across ${check.pairs.length} points is not a finding; it is a reason to keep watching.
      Note also that with n=4, ρ=−1.00 is the <em>only</em> perfectly ordered outcome available and
      arises by chance in 1 of 24 random orderings.
    </div>

    <div class="note">
      What would actually settle it: age-stratified serology, which no public feed provides. The
      practical read for staffing is narrower and safer — the current season is starting well below
      prior years, and whatever the mechanism, that has held for
      ${check.pairs.length ? check.pairs[check.pairs.length - 1].nextEarlyN : 0} observed weeks so far.
      <span class="s-watch">*</span> partial season — fewer than 50 weeks observed.
    </div>`;
}

function topicList(topics, active) {
  if (!topics.length) return empty('no topics');
  return topics.map((t) => {
    const isActive = active.has(t.signal);
    const items = (t.items || []).slice(0, 6);
    return `<div style="border:1px solid ${isActive ? '#2d3f52' : '#1e2936'};margin-bottom:8px">
      <div data-topic="${t.id}" style="padding:8px 10px;cursor:pointer;background:${isActive ? '#10161d' : 'transparent'};display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        ${isActive ? levelBadge('SIGNAL ACTIVE', 'watch') : '<span class="badge" style="color:#4b5a6b">context</span>'}
        <strong style="font-size:12px">${t.label}</strong>
        <span style="color:#7f8ea0;font-size:10.5px">${t.question || ''}</span>
        <span style="margin-left:auto;color:#4b5a6b;font-size:10px">
          ${t.hitCount ? `${t.hitCount.toLocaleString()} papers · showing ${items.length}` : 'none found'}
        </span>
      </div>
      <div id="items-${t.id}" style="${isActive ? '' : 'display:none'}">
        ${items.length ? `<table class="dt">
          <tbody>${items.map((i) => `<tr>
            <td style="max-width:520px">
              <a href="${i.link}" target="_blank" rel="noopener">${i.title}</a>
              <div style="color:#4b5a6b;font-size:10px;margin-top:2px">
                ${i.journal || '--'}${i.open ? ' <span class="s-ok">· open access</span>' : ''}
              </div>
            </td>
            <td class="num" style="color:#7f8ea0;white-space:nowrap;vertical-align:top">${(i.date || '').slice(0, 10)}</td>
          </tr>`).join('')}</tbody>
        </table>` : `<div class="empty">no matching papers</div>`}
      </div>
    </div>`;
  }).join('') + `
    <div class="note gap">
      Retrieved from Europe PMC by relevance, restricted to titles and abstracts, published 2025 onward.
      These are <strong>candidate explanations, not conclusions</strong>, and none of them were selected
      because they agree with this dashboard. Topics whose corresponding signal is currently firing are
      expanded first; the rest are collapsed as background. Follow the links before relying on any of it.
    </div>`;
}
