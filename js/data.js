// Data access layer.
//
// Default path: read the JSON snapshots committed by the nightly GitHub Action.
// LIVE path: hit data.cdc.gov directly from the browser. Every CDC endpoint we
// use returns `Access-Control-Allow-Origin: *`, verified 2026-07-30, so this
// works from GitHub Pages with no proxy and no backend.

import { DATASETS } from './config.js';

const CDC = 'https://data.cdc.gov/resource';
const cache = new Map();

export const state = {
  live: false,
  manifest: null,
};

async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} :: ${url}`);
  return r.json();
}

/** Load a named snapshot from data/. Returns {fetched_at, meta, data}. */
export async function snapshot(name) {
  if (cache.has(name)) return cache.get(name);
  const p = getJSON(`./data/${name}.json`).catch((e) => {
    console.error(`snapshot ${name} failed`, e);
    return { fetched_at: null, meta: {}, data: [], error: String(e) };
  });
  cache.set(name, p);
  return p;
}

export async function manifest() {
  if (state.manifest) return state.manifest;
  state.manifest = await getJSON('./data/manifest.json').catch(() => ({ sources: {} }));
  return state.manifest;
}

/** Direct Socrata query -- used by the LIVE toggle and the freshness probe. */
export async function live(name, params = {}) {
  const id = DATASETS[name];
  if (!id) throw new Error(`unknown dataset ${name}`);
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) q.set(k.startsWith('$') ? k : `$${k}`, v);
  return getJSON(`${CDC}/${id}.json?${q}`);
}

/**
 * Ask CDC for the newest date in a dataset without downloading it, so the
 * header can tell you whether the committed snapshot has gone stale.
 */
export async function freshness(name, dateCol) {
  try {
    const r = await live(name, { select: `max(${dateCol})` });
    const v = Object.values(r[0] || {})[0];
    return v ? String(v).slice(0, 10) : null;
  } catch {
    return null;
  }
}

/** Pull a numeric column out of a wide row series, dropping gaps. */
export function series(rows, key, dateKey = 'week') {
  const out = [];
  for (const r of rows) {
    const v = r[key];
    if (v === undefined || v === null || Number.isNaN(+v)) continue;
    out.push({ t: r[dateKey], v: +v });
  }
  return out;
}

/** Collapse a daily series to weekly means, keyed to week-ending Saturday. */
export function toWeekly(points) {
  const buckets = new Map();
  for (const p of points) {
    const d = new Date(p.t + 'T00:00:00Z');
    const dow = d.getUTCDay();
    d.setUTCDate(d.getUTCDate() + (6 - dow)); // week ending Saturday
    const k = d.toISOString().slice(0, 10);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(p.v);
  }
  return [...buckets.entries()]
    .map(([t, vs]) => ({ t, v: vs.reduce((a, b) => a + b, 0) / vs.length }))
    .sort((a, b) => (a.t < b.t ? -1 : 1));
}

export function fmtDate(s) {
  if (!s) return '--';
  const d = new Date(s + (s.length === 10 ? 'T00:00:00Z' : ''));
  return d.toLocaleDateString('en-US', {
    month: 'short', day: '2-digit', year: 'numeric', timeZone: 'UTC',
  });
}

export function daysAgo(s) {
  if (!s) return null;
  const d = new Date(s + 'T00:00:00Z');
  return Math.floor((Date.now() - d.getTime()) / 86400000);
}
