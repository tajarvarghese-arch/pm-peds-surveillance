// Bootstrap: load snapshots once, mount tabs, keep shared state.

import { snapshot, manifest, freshness, fmtDate, daysAgo, state } from './data.js';
import { destroyAll } from './charts.js';
import { VISIT_MIX } from './config.js';

import aboutTab from './tabs/about.js';
import execTab from './tabs/exec.js';
import yearTab from './tabs/year.js';
import pathogensTab from './tabs/pathogens.js';
import historicalTab from './tabs/historical.js';
import forecastTab from './tabs/forecast.js';
import geoTab from './tabs/geo.js';
import wastewaterTab from './tabs/wastewater.js';
import explainTab from './tabs/explain.js';
import marketTab from './tabs/market.js';
import staffingTab from './tabs/staffing.js';
import volumesTab from './tabs/volumes.js';
import reportTab from './tabs/report.js';

const TABS = [
  { id: 'about', label: 'About', mod: aboutTab },
  { id: 'exec', label: 'Exec Summary', mod: execTab },
  { id: 'year', label: '2026', mod: yearTab },
  { id: 'pathogens', label: 'Pathogens', mod: pathogensTab },
  { id: 'historical', label: 'Historical', mod: historicalTab },
  { id: 'forecast', label: 'Forecast & d1/d2', mod: forecastTab },
  { id: 'geo', label: 'Geography', mod: geoTab },
  { id: 'wastewater', label: 'Wastewater', mod: wastewaterTab },
  { id: 'explain', label: 'Why', mod: explainTab },
  { id: 'market', label: 'Market Supply', mod: marketTab },
  { id: 'staffing', label: 'Staffing', mod: staffingTab },
  { id: 'volumes', label: 'Volumes ▪', mod: volumesTab },
  { id: 'report', label: 'Report ▪', mod: reportTab },
];

// Shared, mutable across tabs. Controls write here, tabs read.
/**
 * Visit-mix weights persist in localStorage, never in the repo.
 *
 * The real distribution is PM Pediatrics' own operating data. Putting it in
 * js/config.js would publish it -- this site is a public GitHub Pages build.
 * Kept in the browser, it survives reloads for whoever set it and is visible to
 * nobody else.
 */
const MIX_KEY = 'pmpeds.visitMix.v1';

function loadMix() {
  try {
    const raw = localStorage.getItem(MIX_KEY);
    if (!raw) return { ...VISIT_MIX };
    const saved = JSON.parse(raw);
    const merged = { ...VISIT_MIX };
    for (const k of Object.keys(VISIT_MIX)) {
      const v = Number(saved[k]);
      if (Number.isFinite(v) && v >= 0) merged[k] = v;
    }
    return merged;
  } catch { return { ...VISIT_MIX }; }
}

export function saveMix(mix) {
  try { localStorage.setItem(MIX_KEY, JSON.stringify(mix)); } catch { /* private mode */ }
}

export function clearMix() {
  try { localStorage.removeItem(MIX_KEY); } catch { /* ignore */ }
}

export function mixIsCustom() {
  try { return !!localStorage.getItem(MIX_KEY); } catch { return false; }
}

export const ctx = {
  db: {},
  manifest: null,
  mix: loadMix(),
  pathogen: 'Combined',
  region: 'Region 2',
  smoothing: 1,
};

const view = document.getElementById('view');
const tabsEl = document.getElementById('tabs');

async function boot() {
  const names = ['ed_age', 'ed_state', 'naat_multi', 'pos_national', 'ari_level',
                 'respnet', 'igas', 'ww_covid', 'ww_flu', 'literature',
                 'market_supply', 'market_events', 'closures', 'places_roster'];
  const [mf, ...loaded] = await Promise.all([manifest(), ...names.map(snapshot)]);
  ctx.manifest = mf;
  names.forEach((n, i) => { ctx.db[n] = loaded[i]; });

  renderMasthead();
  renderTabs();
  const initial = location.hash.replace('#', '') || 'about';
  select(TABS.some((t) => t.id === initial) ? initial : 'exec');

  // Non-blocking staleness probe against live CDC.
  probeFreshness();
}

function renderMasthead() {
  const snapAt = ctx.db.ed_state?.fetched_at || ctx.db.ed_age?.fetched_at;
  const latest = ctx.db.ed_state?.data?.at(-1)?.date;
  document.getElementById('m-snapshot').innerHTML =
    `snapshot <span class="s-ok">${snapAt ? snapAt.slice(0, 10) : '--'}</span>` +
    (latest ? ` // data thru <span class="s-ok">${fmtDate(latest)}</span>` : '');
  document.getElementById('f-build').textContent =
    `sources: ${Object.values(ctx.manifest?.sources || {}).filter((s) => s.ok).length} live CDC datasets`;
}

/**
 * Truth-telling about freshness, independent of the pipeline.
 *
 * The refresh job can die without anyone noticing: GitHub disables scheduled
 * workflows after 60 days with no repository activity, and commits made by
 * GITHUB_TOKEN do not reliably reset that timer. A repo that only ever commits
 * to itself can therefore go quiet while the site keeps serving whatever it
 * last built -- and a stale dashboard that looks healthy is worse than no
 * dashboard.
 *
 * So freshness is never inferred from the snapshot alone. The browser asks CDC
 * directly on every load (their endpoints are CORS-open, so this works from
 * GitHub Pages with no backend) and compares. If the pipeline has stopped, the
 * page says so in a banner nobody can miss.
 */
async function probeFreshness() {
  const box = document.getElementById('m-freshness');
  const latestLocal = ctx.db.ed_state?.data?.at(-1)?.date;
  const builtAt = ctx.db.ed_state?.fetched_at || ctx.manifest?.generated_at;
  const buildAge = builtAt
    ? Math.floor((Date.now() - new Date(builtAt).getTime()) / 86400000) : null;

  const remote = await freshness('ed_state', 'date');

  if (!remote) {
    box.innerHTML = '<span style="color:#4b5a6b">live probe unavailable</span>';
    if (buildAge !== null && buildAge > 10) staleBanner({ buildAge, behind: null, remote: null });
    return;
  }

  const behind = latestLocal
    ? Math.round((new Date(remote) - new Date(latestLocal)) / 86400000) : null;

  if (behind && behind > 0) {
    box.innerHTML = `<span class="s-watch">CDC has newer (${remote}) — snapshot ${behind}d behind</span>`;
  } else {
    box.innerHTML = `<span class="s-ok">in sync</span> <span style="color:#4b5a6b">CDC lag ${daysAgo(remote)}d</span>`;
  }

  // A build older than ~10 days means several scheduled runs were missed: the
  // job is failing, or the schedule has been disabled outright.
  if ((buildAge !== null && buildAge > 10) || (behind !== null && behind >= 14)) {
    staleBanner({ buildAge, behind, remote });
  }
}

function staleBanner({ buildAge, behind, remote }) {
  if (document.getElementById('stale-banner')) return;
  const severe = (buildAge ?? 0) > 45 || (behind ?? 0) >= 30;
  const el = document.createElement('div');
  el.id = 'stale-banner';
  el.className = `stale-banner${severe ? ' severe' : ''}`;
  el.innerHTML = `
    <strong>${severe ? '⚠ THIS DASHBOARD IS OUT OF DATE' : '⚠ Data may be stale'}</strong>
    <span>
      ${buildAge !== null ? `Last successful build was <strong>${buildAge} days ago</strong>.` : ''}
      ${behind ? ` CDC has published <strong>${behind} days</strong> of data since this snapshot${remote ? ` (through ${remote})` : ''}.` : ''}
      The scheduled refresh has probably stopped — GitHub disables scheduled workflows after 60 days
      with no repository activity, and the job's own commits do not reset that timer.
    </span>
    <span class="fix">Fix: repo → <em>Actions</em> → enable the workflow → <em>Run workflow</em>.
    Any push also revives it.</span>`;
  const main = document.getElementById('view');
  main.parentNode.insertBefore(el, main);
}

function renderTabs() {
  tabsEl.innerHTML = '';
  for (const t of TABS) {
    const b = document.createElement('button');
    b.textContent = t.label;
    b.setAttribute('role', 'tab');
    b.dataset.id = t.id;
    b.onclick = () => select(t.id);
    tabsEl.appendChild(b);
  }
}

export function select(id) {
  const tab = TABS.find((t) => t.id === id);
  if (!tab) return;
  destroyAll();
  [...tabsEl.children].forEach((b) =>
    b.setAttribute('aria-selected', String(b.dataset.id === id)));
  history.replaceState(null, '', `#${id}`);
  view.innerHTML = '<div class="loading">rendering<span class="cursor"></span></div>';
  try {
    tab.mod(view, ctx);
  } catch (e) {
    console.error(e);
    view.innerHTML = `<div class="empty">tab "${id}" failed to render<br><span style="color:#ef4444">${e.message}</span></div>`;
  }
}

/** Tabs call this after mutating ctx via a control. */
export function rerender() {
  const active = tabsEl.querySelector('[aria-selected="true"]');
  if (active) select(active.dataset.id);
}

window.addEventListener('hashchange', () => {
  const id = location.hash.replace('#', '');
  if (TABS.some((t) => t.id === id)) select(id);
});

boot().catch((e) => {
  console.error(e);
  view.innerHTML = `<div class="empty">boot failed: ${e.message}</div>`;
});
