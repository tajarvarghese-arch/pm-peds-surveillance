// Bootstrap: load snapshots once, mount tabs, keep shared state.

import { snapshot, manifest, freshness, fmtDate, daysAgo, state } from './data.js';
import { destroyAll } from './charts.js';
import { VISIT_MIX } from './config.js';

import execTab from './tabs/exec.js';
import pathogensTab from './tabs/pathogens.js';
import historicalTab from './tabs/historical.js';
import forecastTab from './tabs/forecast.js';
import geoTab from './tabs/geo.js';
import staffingTab from './tabs/staffing.js';

const TABS = [
  { id: 'exec', label: 'Exec Summary', mod: execTab },
  { id: 'pathogens', label: 'Pathogens', mod: pathogensTab },
  { id: 'historical', label: 'Historical', mod: historicalTab },
  { id: 'forecast', label: 'Forecast & d1/d2', mod: forecastTab },
  { id: 'geo', label: 'Geography', mod: geoTab },
  { id: 'staffing', label: 'Staffing', mod: staffingTab },
];

// Shared, mutable across tabs. Controls write here, tabs read.
export const ctx = {
  db: {},
  manifest: null,
  mix: { ...VISIT_MIX },
  pathogen: 'Combined',
  region: 'Region 2',
  smoothing: 1,
};

const view = document.getElementById('view');
const tabsEl = document.getElementById('tabs');

async function boot() {
  const names = ['ed_age', 'ed_state', 'naat_multi', 'pos_national', 'ari_level',
                 'respnet', 'igas', 'ww_covid', 'ww_flu'];
  const [mf, ...loaded] = await Promise.all([manifest(), ...names.map(snapshot)]);
  ctx.manifest = mf;
  names.forEach((n, i) => { ctx.db[n] = loaded[i]; });

  renderMasthead();
  renderTabs();
  const initial = location.hash.replace('#', '') || 'exec';
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

async function probeFreshness() {
  const latestLocal = ctx.db.ed_state?.data?.at(-1)?.date;
  const remote = await freshness('ed_state', 'date');
  const box = document.getElementById('m-freshness');
  if (!remote) { box.innerHTML = '<span style="color:#4b5a6b">live probe unavailable</span>'; return; }
  if (latestLocal && remote > latestLocal) {
    box.innerHTML = `<span class="s-watch">CDC has newer (${remote}) — snapshot stale</span>`;
  } else {
    const age = daysAgo(remote);
    box.innerHTML = `<span class="s-ok">in sync</span> <span style="color:#4b5a6b">CDC lag ${age}d</span>`;
  }
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
