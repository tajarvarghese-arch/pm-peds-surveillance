// Client-side ingest for PM Pediatrics visit data.
//
// PRIVACY, BY CONSTRUCTION
// ------------------------
// This is a static site. There is no server, no endpoint, no upload. A file
// chosen here is read by FileReader in the page, parsed in memory, and kept in
// this browser's localStorage. It is never transmitted anywhere and never
// touches the repository. Clearing it removes every trace.
//
// That is not a policy promise -- it is the only thing a static page can do.

const KEY = 'pmpeds.volumes.v1';
// Second slot: an ICD-coded export (the high-acuity file) is a different
// dataset, not a replacement for the visit-type file. Both persist, so the
// acuity analysis can join against the main volume series.
const KEY_ACUITY = 'pmpeds.volumes.acuity.v1';
// Third slot: a totals-only export (channel mix — walk-in vs pre-booked etc.)
// has no time dimension, so it cannot join the weekly analyses; but it answers
// a question the other files cannot: HOW demand arrives.
const KEY_CHANNEL = 'pmpeds.volumes.channel.v1';
// Fourth slot: the by-location export (sites on rows, months across). It is the
// only file that can split network change into same-store performance versus
// footprint (openings/closures), so it persists separately too.
const KEY_LOCATIONS = 'pmpeds.volumes.locations.v1';
const MAX_BYTES = 4_000_000; // localStorage is ~5MB; leave headroom

// Same fuzzy-header idea as scripts/ingest_visits.py, because the export schema
// is unknown and a board portal will not name its columns to suit us.
const CANDIDATES = {
  date: ['date', 'visitdate', 'servicedate', 'day', 'weekending', 'weekend',
         'week', 'month', 'period', 'encounterdate', 'dos'],
  location: ['location', 'site', 'clinic', 'center', 'centre', 'facility',
             'practice', 'office', 'market', 'sitename', 'locationname'],
  type: ['visittype', 'type', 'category', 'servicetype', 'acuity', 'complaint',
         'diagnosis', 'reason', 'chiefcomplaint', 'service', 'encountertype',
         'icdcode', 'icd', 'code', 'diagnosisdescription', 'description'],
  visits: ['visits', 'visitcount', 'encounters', 'patients', 'volume',
           'patientvisits', 'totalvisits', 'count', 'census', 'arrivals'],
  age: ['ageband', 'agegroup', 'age', 'agerange', 'agecategory'],
};

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

export function detectColumns(headers) {
  const found = {};
  const map = new Map(headers.map((h) => [norm(h), h]));
  for (const [field, names] of Object.entries(CANDIDATES)) {
    let hit = names.map((n) => map.get(n)).find(Boolean);
    if (!hit) {
      const subs = [...map.entries()]
        .filter(([n]) => names.some((w) => n.includes(w)))
        .map(([, h]) => h)
        .sort((a, b) => a.length - b.length);
      hit = subs[0];
    }
    if (hit) found[field] = hit;
  }
  return found;
}

// Excel serial window for 2000-01-01 .. 2040-01-01. Anything outside it is a
// measurement, not a date. Without this bound a visit count of 22,397 converts
// happily to 1961-04-26 and a count of 2,087 to the year 2087 -- which is how a
// data row can out-score the real header row and hijack the whole parse.
const SERIAL_MIN = 36526;
const SERIAL_MAX = 51136;

/** Excel serials, ISO strings and US dates. Deliberately strict. */
function toISO(v) {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || v < SERIAL_MIN || v > SERIAL_MAX) return null;
    return new Date(Date.UTC(1899, 11, 30) + v * 86400000).toISOString().slice(0, 10);
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/);
  if (m) {
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${y}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  }
  // A bare run of digits is a number. Only accept it as a date if it is a
  // plausible serial; never fall through to Date parsing, which turns "945"
  // into the year 945.
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return (n >= SERIAL_MIN && n <= SERIAL_MAX)
      ? new Date(Date.UTC(1899, 11, 30) + n * 86400000).toISOString().slice(0, 10) : null;
  }
  if (!/[a-z]/i.test(s)) return null;      // no month name, no separators -> not a date
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

const numOf = (v) => {
  if (typeof v === 'number') return v;
  // Blank cells are absent data, not zeros: Number('') is 0, which would let an
  // empty cell (or a footer row's empty columns) masquerade as a measurement.
  const s = String(v ?? '').replace(/[,$\s]/g, '');
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

/**
 * Parse a workbook into aggregated rows.
 * Aggregating on import matters: a raw encounter-level export would blow past
 * the localStorage quota, and nothing here needs row-level detail.
 */
/**
 * Is this a crosstab rather than a list?
 *
 * A Power BI matrix export puts one column per period and one row per category,
 * which is the opposite of what the long-format path expects. Detect it by
 * finding the row with the most date-parseable cells.
 */
function findWideHeader(grid) {
  let best = { row: -1, cols: [] };
  const limit = Math.min(grid.length, 12);
  for (let r = 0; r < limit; r++) {
    const cols = [];
    const isos = [];
    (grid[r] || []).forEach((cell, c) => {
      if (cell === null || cell === undefined || cell === '') return;
      if (/total/i.test(String(cell))) return;      // trailing Total column
      const iso = toISO(cell);
      if (iso) { cols.push(c); isos.push(iso); }
    });
    // A period header runs forwards in time. A row of measurements that happen
    // to fall inside the serial window will not, so monotonicity is what
    // actually separates the header from the data.
    let monotonic = true;
    for (let i = 1; i < isos.length; i++) if (isos[i] <= isos[i - 1]) { monotonic = false; break; }
    if (!monotonic) continue;
    if (cols.length > best.cols.length) best = { row: r, cols };
  }
  return best.cols.length >= 3 ? best : null;
}

/**
 * Unpivot a crosstab into long rows.
 *
 * Two ways this goes wrong silently, both handled here:
 *
 *  - Subtotal rows. A matrix emits a "Total" row per group AND the detail rows
 *    beneath it. Summing both double-counts every figure.
 *  - Groups whose only row IS the total. In the observed export "Injury" has a
 *    Total row and no children, so a blanket "drop anything labelled Total"
 *    deletes the entire category. Such a row is kept and relabelled with its
 *    group name.
 */
function unpivot(grid, header) {
  const dimCols = [];
  const firstDate = Math.min(...header.cols);
  for (let c = 0; c < firstDate; c++) dimCols.push(c);
  if (!dimCols.length) dimCols.push(0);

  const dates = header.cols.map((c) => ({ c, iso: toISO(grid[header.row][c]) }))
    .filter((d) => d.iso);

  const body = [];
  for (let r = header.row + 1; r < grid.length; r++) {
    const row = grid[r] || [];
    const dims = dimCols.map((c) => String(row[c] ?? '').trim());
    if (!dims.some(Boolean)) continue;
    if (/^applied filters/i.test(dims[0])) break;      // export footer
    const hasNumber = dates.some(({ c }) => numOf(row[c]) !== null);
    if (!hasNumber) continue;                          // sub-header like "# Visits"
    body.push({ dims, row });
  }

  const isTotal = (s) => /^total$/i.test(String(s || '').trim());
  const last = dimCols.length - 1;

  // Count real children per group so a childless total survives.
  const childCount = new Map();
  for (const b of body) {
    if (isTotal(b.dims[0])) continue;
    if (isTotal(b.dims[last])) continue;
    childCount.set(b.dims[0], (childCount.get(b.dims[0]) || 0) + 1);
  }

  const out = [];
  let droppedSubtotals = 0;
  for (const b of body) {
    if (isTotal(b.dims[0])) { droppedSubtotals++; continue; }   // grand total
    let type = b.dims[last] || b.dims[0];
    if (isTotal(type)) {
      if ((childCount.get(b.dims[0]) || 0) > 0) { droppedSubtotals++; continue; }
      type = b.dims[0];                                          // childless group
    }
    for (const { c, iso } of dates) {
      const v = numOf(b.row[c]);
      if (v === null) continue;
      out.push({ date: iso, location: '(all)', type,
                 category: dimCols.length > 1 ? b.dims[0] : '(all)',
                 age: '(all)', visits: v });
    }
  }
  return { rows: out, droppedSubtotals, dates: dates.length,
           dims: dimCols.length, categories: [...childCount.keys()] };
}

/**
 * Totals-only export: a header row of labels over one numeric row, no time
 * dimension anywhere (the channel-mix export is exactly this shape). It cannot
 * join the weekly analyses, but as a mix snapshot it is still worth keeping --
 * so it becomes its own layout instead of an error.
 */
function tryTotals(wb) {
  for (const name of wb.SheetNames) {
    const grid = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: null });
    if (!grid.length) continue;
    let filterText = null;
    for (const row of grid.slice(0, 4)) {
      for (const cell of row || []) {
        if (typeof cell === 'string' && /^applied filters/i.test(cell.trim())) {
          filterText = cell.replace(/\s+/g, ' ').trim();
        }
      }
    }
    for (let r = 0; r < Math.min(grid.length - 1, 10); r++) {
      const labels = (grid[r] || []).map((c, i) => ({ c, i }))
        .filter((x) => typeof x.c === 'string' && x.c.trim() && !toISO(x.c)
                       && !/^applied filters/i.test(x.c.trim()));
      if (labels.length < 2) continue;
      const next = grid[r + 1] || [];
      const pairs = labels
        .map((x) => ({ label: x.c.trim(), value: numOf(next[x.i]) }))
        .filter((p) => p.value !== null);
      if (pairs.length < 2) continue;
      if ((grid[r] || []).some((c) => toISO(c))) continue;   // has dates: not totals
      return { layout: 'totals', sheetName: name, pairs, filterText,
               rawRows: 1, skipped: 0, data: [], cols: {},
               note: `${pairs.length} totals, no time dimension` };
    }
  }
  return null;
}

export function parseWorkbook(arrayBuffer, overrides = {}) {
  const wb = XLSX.read(arrayBuffer, { type: 'array' });

  // Try every sheet as a crosstab first, since a matrix export has no usable
  // header row for the long-format reader.
  for (const name of wb.SheetNames) {
    const grid = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: null });
    if (!grid.length) continue;
    const header = findWideHeader(grid);
    if (!header) continue;
    const { rows: long, droppedSubtotals, dates, dims } = unpivot(grid, header);
    if (!long.length) continue;
    const agg = new Map();
    for (const r of long) {
      const k = `${r.date}|${r.location}|${r.type}|${r.category}|${r.age}`;
      agg.set(k, (agg.get(k) || 0) + r.visits);
    }
    const data = [...agg.entries()].map(([k, visits]) => {
      const [date, location, type, category, age] = k.split('|');
      return { date, location, type, category, age, visits };
    }).sort((a, b) => (a.date < b.date ? -1 : 1));
    return {
      data, layout: 'crosstab', sheetName: name,
      cols: { date: `${dates} period columns`, type: `${dims} row dimension(s)`, visits: '# Visits' },
      headers: [], skipped: droppedSubtotals, rawRows: long.length,
      note: `unpivoted ${dates} period columns; dropped ${droppedSubtotals} subtotal row(s)`,
    };
  }

  // Long format. Power BI prefixes exports with an "Applied filters:" block, so
  // the real header is rarely row 0 -- find the row whose successor actually
  // holds a date and a number.
  let rows = [];
  let sheetName = wb.SheetNames[0];
  for (const name of wb.SheetNames) {
    const grid = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: null });
    if (!grid.length) continue;
    let headerRow = -1;
    for (let r = 0; r < Math.min(grid.length - 1, 15); r++) {
      const labels = (grid[r] || []).filter((c) => c !== null && c !== '');
      if (labels.length < 2) continue;
      // A header row is all labels; the row beneath it carries the data.
      const next = grid[r + 1] || [];
      const hasDate = next.some((c) => toISO(c));
      const hasNum = next.some((c) => numOf(c) !== null);
      const selfIsData = (grid[r] || []).some((c) => toISO(c)) && (grid[r] || []).some((c) => numOf(c) !== null);
      if (hasDate && hasNum && !selfIsData) { headerRow = r; break; }
    }
    if (headerRow < 0) {
      // No date-bearing header. Still read the sheet so the caller can be told
      // precisely what is wrong -- a totals-only export with no time dimension
      // deserves a better message than "no rows".
      const plain = XLSX.utils.sheet_to_json(wb.Sheets[name], { defval: null });
      if (plain.length && !rows.length) { rows = plain; sheetName = name; }
      continue;
    }
    rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { defval: null, range: headerRow });
    if (rows.length) { sheetName = name; break; }
  }
  if (!rows.length) {
    // Last resort: the sheet may be a single header row over one totals row.
    for (const name of wb.SheetNames) {
      const grid = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: null });
      const hdr = (grid || []).findIndex((r) => (r || []).filter((c) => c !== null && c !== '').length >= 2);
      if (hdr >= 0 && grid.length > hdr + 1) {
        rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { defval: null, range: hdr });
        if (rows.length) { sheetName = name; break; }
      }
    }
  }
  if (!rows.length) {
    const totals = tryTotals(wb);
    if (totals) return totals;
    throw new Error('no data rows found in any sheet');
  }

  const headers = Object.keys(rows[0]);
  const cols = { ...detectColumns(headers), ...overrides };
  if (!cols.date) {
    const totals = tryTotals(wb);
    if (totals) return totals;
    // A totals-only export (one row of grand totals per channel) has no time
    // dimension and cannot join anything else here. Say so specifically rather
    // than failing with a generic missing-column message.
    throw new Error(
      `this export has no date column, so it cannot be charted over time. `
      + `Columns found: ${headers.join(', ')}. Re-export with the week or month `
      + `dimension on rows.`);
  }
  if (!cols.visits) {
    // The preamble cell often contains the word "date", so a totals sheet can
    // reach this branch instead of the no-date one. Give totals its shot here
    // as well before declaring failure.
    const totals = tryTotals(wb);
    if (totals) return totals;
    throw new Error(`could not find a visit-count column — headers were: ${headers.join(', ')}`);
  }

  const agg = new Map();
  let skipped = 0;
  for (const r of rows) {
    const date = toISO(r[cols.date]);
    const v = numOf(r[cols.visits]);
    if (!date || v === null) { skipped++; continue; }
    const loc = cols.location ? String(r[cols.location] ?? '').trim() || '(unspecified)' : '(all)';
    const type = cols.type ? String(r[cols.type] ?? '').trim() || '(unspecified)' : '(all)';
    const age = cols.age ? String(r[cols.age] ?? '').trim() || '(all)' : '(all)';
    const k = `${date}|${loc}|${type}|(all)|${age}`;
    agg.set(k, (agg.get(k) || 0) + v);
  }

  const data = [...agg.entries()].map(([k, visits]) => {
    const [date, location, type, category, age] = k.split('|');
    return { date, location, type, category, age, visits };
  }).sort((a, b) => (a.date < b.date ? -1 : 1));

  return { data, cols, headers, sheetName, skipped, rawRows: rows.length };
}

/**
 * Does a parsed crosstab look like a by-location file rather than a by-type
 * one? A visit-type export carries a couple dozen categories at most; a
 * location export carries the whole clinic roster. Row-label cardinality is
 * the tell, and it needs no knowledge of any actual site name.
 */
export function looksLikeLocations(parsed) {
  if (parsed.layout !== 'crosstab' || !parsed.data?.length) return false;
  // Two dimensions (group + category) marks the visit-type matrix, whatever its
  // cardinality — only a single-dimension crosstab can be a site roster.
  if (parsed.data.some((r) => r.category !== '(all)')) return false;
  const labels = new Set(parsed.data.map((r) => r.type));
  return labels.size >= 30;
}

/** Re-key a location crosstab so sites land in `location`, not `type`. */
export function asLocationRows(parsed) {
  return {
    ...parsed,
    data: parsed.data.map((r) => ({ ...r, location: r.type, type: '(all)' })),
  };
}

export function saveLocations(payload) {
  try { localStorage.setItem(KEY_LOCATIONS, JSON.stringify(payload)); } catch { /* quota */ }
  return payload;
}

export function loadLocations() {
  try {
    const raw = localStorage.getItem(KEY_LOCATIONS);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

export function clearLocations() {
  try { localStorage.removeItem(KEY_LOCATIONS); } catch { /* ignore */ }
}

export function saveChannel(payload) {
  try { localStorage.setItem(KEY_CHANNEL, JSON.stringify(payload)); } catch { /* quota */ }
  return payload;
}

export function loadChannel() {
  try {
    const raw = localStorage.getItem(KEY_CHANNEL);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

export function clearChannel() {
  try { localStorage.removeItem(KEY_CHANNEL); } catch { /* ignore */ }
}

export function saveAcuity(payload) {
  try { localStorage.setItem(KEY_ACUITY, JSON.stringify(payload)); } catch { /* quota */ }
  return payload;
}

export function loadAcuity() {
  try {
    const raw = localStorage.getItem(KEY_ACUITY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

export function clearAcuity() {
  try { localStorage.removeItem(KEY_ACUITY); } catch { /* ignore */ }
}

export function save(payload) {
  const json = JSON.stringify(payload);
  if (json.length > MAX_BYTES) {
    // Collapse the least useful dimension rather than refusing the file.
    const byDateType = new Map();
    for (const r of payload.data) {
      const k = `${r.date}|${r.type}`;
      byDateType.set(k, (byDateType.get(k) || 0) + r.visits);
    }
    payload = {
      ...payload,
      collapsed: 'location and age dropped to fit browser storage',
      data: [...byDateType.entries()].map(([k, visits]) => {
        const [date, type] = k.split('|');
        return { date, location: '(all)', type, category: '(all)', age: '(all)', visits };
      }),
    };
  }
  localStorage.setItem(KEY, JSON.stringify(payload));
  return payload;
}

export function load() {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

export function clear() {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
}

/** Roll aggregated rows up to weekly totals keyed to the Monday of the week. */
export function toWeekly(rows, filterFn = () => true) {
  const b = new Map();
  for (const r of rows) {
    if (!filterFn(r)) continue;
    const d = new Date(r.date + 'T00:00:00Z');
    const dow = (d.getUTCDay() + 6) % 7;
    d.setUTCDate(d.getUTCDate() - dow);
    const k = d.toISOString().slice(0, 10);
    b.set(k, (b.get(k) || 0) + r.visits);
  }
  return [...b.entries()].map(([t, v]) => ({ t, v })).sort((a, b2) => (a.t < b2.t ? -1 : 1));
}

/* ------------------------------------------------------------------------- */
/* Fifth slot: a weekly multi-metric export (walk-in / pre-booked / new       */
/* patients / patients-per-hour by week). The generic long-format reader      */
/* would keep only one numeric column, so this shape gets its own parser.     */
/* ------------------------------------------------------------------------- */

const KEY_CHWEEKLY = 'pmpeds.volumes.chweekly.v1';

/**
 * Parse "date column + several metric columns" — or return null if the
 * workbook isn't that shape. Routing rule: at least two numeric metric
 * columns, and at least one whose name says booking channel (walk/book).
 */
export function parseWeeklyMetrics(arrayBuffer) {
  const wb = XLSX.read(arrayBuffer, { type: 'array' });
  for (const name of wb.SheetNames) {
    const grid = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: null });
    for (let r = 0; r < Math.min(grid.length - 1, 12); r++) {
      const hdr = grid[r] || [];
      const next = grid[r + 1] || [];
      const dateCol = hdr.findIndex((h, i) => typeof h === 'string' && toISO(next[i]));
      if (dateCol < 0) continue;
      const metricCols = hdr.map((h, i) => ({ h, i }))
        .filter((x) => x.i !== dateCol && typeof x.h === 'string' && x.h.trim()
                       && numOf(next[x.i]) !== null);
      if (metricCols.length < 2) continue;
      if (!metricCols.some((m) => /walk|book/i.test(m.h))) continue;
      const rows = [];
      for (let k = r + 1; k < grid.length; k++) {
        const row = grid[k] || [];
        const date = toISO(row[dateCol]);
        if (!date) continue;               // Total row, footer, blanks
        const rec = { date };
        let got = 0;
        for (const m of metricCols) {
          const v = numOf(row[m.i]);
          if (v !== null) { rec[m.h.trim()] = v; got++; }
        }
        // A row with a date but no metric values is prose that happened to
        // contain a parseable date (a "Source: ... retrieved 8/18/2026"
        // footer, say) — never data.
        if (got > 0) rows.push(rec);
      }
      if (rows.length >= 8) {
        return { layout: 'weekly-metrics', sheetName: name, data: rows,
                 metrics: metricCols.map((m) => m.h.trim()),
                 note: `${rows.length} weeks × ${metricCols.length} metrics` };
      }
    }
  }
  return null;
}

export function saveChannelWeekly(payload) {
  try { localStorage.setItem(KEY_CHWEEKLY, JSON.stringify(payload)); } catch { /* quota */ }
  return payload;
}

export function loadChannelWeekly() {
  try {
    const raw = localStorage.getItem(KEY_CHWEEKLY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

export function clearChannelWeekly() {
  try { localStorage.removeItem(KEY_CHWEEKLY); } catch { /* ignore */ }
}

/* ------------------------------------------------------------------------- */
/* MASTER WORKBOOK                                                            */
/*                                                                            */
/* One aggregated workbook carrying every export as its own sheet, replacing  */
/* the five-separate-files workflow. Detection is by sheet name, never by row */
/* counts or column guesses: a workbook is "the master" only if it carries    */
/* both the raw weekly diagnoses and the derived weekly series.               */
/*                                                                            */
/* Sheets land in the existing slots where one exists, so every tab keeps     */
/* working unchanged, and in new slots where the data has no home yet.        */
/* ------------------------------------------------------------------------- */

const KEY_FUNNEL   = 'pmpeds.volumes.funnel.v1';
const KEY_NEWPAT   = 'pmpeds.volumes.newpatients.v1';
const KEY_SITEWK   = 'pmpeds.volumes.siteweekly.v1';
const KEY_BHTELE   = 'pmpeds.volumes.bhtele.v1';
const KEY_SITES    = 'pmpeds.volumes.sitemaster.v1';
const KEY_DERIVED  = 'pmpeds.volumes.derived.v1';
const KEY_REFTOT   = 'pmpeds.volumes.reftotals.v1';

const MASTER_SHEETS = {
  dx:       '01_Weekly_Diagnoses',
  acuity:   '02_Weekly_HighAcuity',
  channel:  '03_Weekly_Channel',
  funnel:   '04_Weekly_Funnel_Regional',
  locs:     '05_Monthly_Locations',
  newpat:   '06_Monthly_NewPatients',
  siteWk:   '07_Weekly_Site_Visits',
  bhTele:   '08_Daily_BH_Telehealth',
  sites:    '09_Site_Master',
  refTot:   '10_Reference_Totals',
  derived:  '11_Derived_Weekly',
  siteMeta: '12_Site_Metadata',
};

/** Row 1 is a source banner and row 2 the header, so data starts on row 3. */
function readMasterSheet(wb, name) {
  if (!wb.SheetNames.includes(name)) return null;
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { defval: null, range: 1 });
  return rows.length ? rows : null;
}

/** Is this the aggregated master workbook rather than a single portal export? */
export function looksLikeMaster(wb) {
  return wb.SheetNames.includes(MASTER_SHEETS.dx)
      && wb.SheetNames.includes(MASTER_SHEETS.derived);
}

/**
 * Parse the master workbook into one payload per slot. Returns null when the
 * workbook is not the master, so callers fall through to the single-file
 * parsers.
 */
export function parseMasterWorkbook(arrayBuffer) {
  const wb = XLSX.read(arrayBuffer, { type: 'array' });
  if (!looksLikeMaster(wb)) return null;

  const S = MASTER_SHEETS;
  const out = { layout: 'master', sheets: [], counts: {} };
  const note = (k, n) => { out.sheets.push(k); out.counts[k] = n; };

  const dxRows = readMasterSheet(wb, S.dx);
  if (dxRows) {
    out.visits = dxRows.map((r) => ({
      date: toISO(r.week), location: '(all)',
      type: String(r.diagnosis_category ?? '').trim() || '(unspecified)',
      category: String(r.seasonality_group ?? '').trim() || '(all)',
      age: '(all)', visits: numOf(r.visits) ?? 0,
    })).filter((r) => r.date);
    note(S.dx, out.visits.length);
  }

  const acRows = readMasterSheet(wb, S.acuity);
  if (acRows) {
    out.acuity = acRows.map((r) => ({
      date: toISO(r.week), location: '(all)',
      type: String(r.icd_code ?? '').trim(),
      category: String(r.clinical_grouping ?? '').trim() || '(all)',
      age: '(all)', visits: numOf(r.diagnoses) ?? 0,
    })).filter((r) => r.date && r.type);
    note(S.acuity, out.acuity.length);
  }

  // The report's role-matcher keys off the portal's own column names, so emit
  // those rather than this workbook's snake_case headers.
  const chRows = readMasterSheet(wb, S.channel);
  if (chRows) {
    const M = { walk: 'Walk-In Visits', book: 'Pre-Booked Visits',
                hour: 'Patients per Operating Hour', newp: 'New Patients By Patient ID' };
    out.channelWeekly = {
      layout: 'weekly-metrics', sheetName: S.channel,
      metrics: [M.walk, M.book, M.hour, M.newp],
      data: chRows.map((r) => {
        const rec = { date: toISO(r.week) };
        const put = (k, v) => { const n = numOf(v); if (n !== null) rec[k] = n; };
        put(M.walk, r.walkin_visits); put(M.book, r.prebooked_visits);
        put(M.hour, r.patients_per_operating_hour); put(M.newp, r.new_patients);
        return rec;
      }).filter((r) => r.date && Object.keys(r).length > 1),
    };
    note(S.channel, out.channelWeekly.data.length);
  }

  const locRows = readMasterSheet(wb, S.locs);
  if (locRows) {
    const cols = Object.keys(locRows[0]).filter((c) => c !== 'Location' && c !== 'Total' && toISO(c));
    const long = [];
    for (const r of locRows) {
      const site = String(r.Location ?? '').trim();
      if (!site || /^total$/i.test(site)) continue;
      for (const c of cols) {
        const v = numOf(r[c]);
        if (v === null) continue;                     // blank = site not active
        long.push({ date: toISO(c), location: site, type: '(all)',
                    category: '(all)', age: '(all)', visits: v });
      }
    }
    out.locations = long;
    note(S.locs, long.length);
  }

  const simple = (sheet, map) => {
    const rows = readMasterSheet(wb, sheet);
    if (!rows) return null;
    const mapped = rows.map(map).filter(Boolean);
    note(sheet, mapped.length);
    return mapped;
  };

  out.funnel = simple(S.funnel, (r) => {
    const date = toISO(r.week);
    if (!date || !r.region) return null;
    return { date, region: String(r.region).trim(),
      slots: numOf(r.available_slots), bookingRate: numOf(r.booking_rate),
      prebooked: numOf(r.prebooked_visits), noShow: numOf(r.pct_no_show),
      cancelled: numOf(r.pct_cancelled), lwbs: numOf(r.pct_left_without_being_seen),
      toOtherPM: numOf(r.cancel_went_to_other_pm),
      notOffered: numOf(r.cancel_service_not_offered),
      nonPar: numOf(r.cancel_nonpar_or_inactive_insurance) };
  });

  out.newPatients = simple(S.newpat, (r) => {
    const date = toISO(r.month);
    if (!date) return null;
    return { date, newPatients: numOf(r.new_patients_by_patient_id),
             priorYear: numOf(r.prior_year_same_month), yoyPct: numOf(r.yoy_pct) };
  });

  out.siteWeekly = simple(S.siteWk, (r) => {
    const date = toISO(r.week);
    if (!date || !r.site) return null;
    return { date, site: String(r.site).trim(),
             cohort: String(r.growth_assumption ?? '').trim(), visits: numOf(r.visits) ?? 0 };
  });

  out.bhTele = simple(S.bhTele, (r) => {
    const date = toISO(r.date);
    if (!date) return null;
    return { date, uc: numOf(r.urgent_care_visits),
             tele: numOf(r.telemedicine_visits), bh: numOf(r.behavioral_health_visits) };
  });

  out.siteMaster = simple(S.sites, (r) => {
    if (!r.site) return null;
    return { site: String(r.site).trim(), state: String(r.state ?? '').trim(),
      market: String(r.market_group ?? '').trim(),
      tenure: numOf(r.tenure_years_at_jan_2026), v25: numOf(r.visits_jan_jul_2025),
      yoy: numOf(r.yoy_pct_jan_jul),
      grew: r.grew_2026 === true || String(r.grew_2026).toLowerCase() === 'true',
      lat: numOf(r.lat), lon: numOf(r.lon) };
  });

  out.derived = simple(S.derived, (r) => {
    const date = toISO(r.week);
    if (!date) return null;
    return { date, total: numOf(r.total_visits), seasonal: numOf(r.seasonal_visits),
      nonSeasonal: numOf(r.non_seasonal_visits), injury: numOf(r.injury_visits),
      uncategorized: numOf(r.uncategorized_visits),
      infectious: numOf(r.infectious_visits), nonInfectious: numOf(r.non_infectious_visits),
      acuity: numOf(r.high_acuity_diagnoses), acuityPer1000: numOf(r.high_acuity_per_1000_visits),
      walkin: numOf(r.walkin_visits), prebooked: numOf(r.prebooked_visits),
      newPatients: numOf(r.new_patients), pphr: numOf(r.patients_per_operating_hour) };
  });

  const refRows = readMasterSheet(wb, S.refTot);
  if (refRows) {
    out.refTotals = refRows
      .map((r) => ({ metric: String(r.Metric ?? '').trim(), value: numOf(r.Value),
                     window: String(r.Window ?? '').trim() }))
      .filter((r) => r.metric && r.value !== null);
    note(S.refTot, out.refTotals.length);
  }

  out.note = out.sheets.length + ' sheets: ' +
    out.sheets.map((s) => s.replace(/^\d+_/, '') + ' ' + out.counts[s].toLocaleString()).join(', ');
  return out;
}

/**
 * Persist a parsed master workbook across the slots.
 *
 * localStorage is ~5MB and the site-week sheet alone is ~18k rows, so anything
 * that will not fit is degraded to a coarser grain rather than dropped, and the
 * degradation is reported back so the UI can say so.
 */
export function saveMaster(parsed, fileName) {
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const meta = { fileName, loadedAt: stamp, fromMaster: true };
  const put = (key, payload) => {
    try { localStorage.setItem(key, JSON.stringify(payload)); return true; }
    catch { return false; }
  };
  const degraded = [];

  if (parsed.visits) save({ ...meta, data: parsed.visits, layout: 'master',
                            sheetName: MASTER_SHEETS.dx, rawRows: parsed.visits.length });
  if (parsed.acuity) saveAcuity({ ...meta, data: parsed.acuity, layout: 'master',
                                  sheetName: MASTER_SHEETS.acuity, rawRows: parsed.acuity.length });
  if (parsed.channelWeekly) saveChannelWeekly({ ...parsed.channelWeekly, ...meta });
  if (parsed.locations) saveLocations({ ...meta, data: parsed.locations, layout: 'master',
                                        sheetName: MASTER_SHEETS.locs, rawRows: parsed.locations.length });

  const slots = [
    [KEY_FUNNEL, parsed.funnel], [KEY_NEWPAT, parsed.newPatients],
    [KEY_BHTELE, parsed.bhTele], [KEY_SITES, parsed.siteMaster],
    [KEY_DERIVED, parsed.derived], [KEY_REFTOT, parsed.refTotals],
  ];
  for (const [key, data] of slots) {
    if (data && data.length) put(key, { ...meta, data });
  }

  if (parsed.siteWeekly && parsed.siteWeekly.length) {
    if (!put(KEY_SITEWK, { ...meta, data: parsed.siteWeekly })) {
      // Collapse weeks to months rather than lose the series entirely.
      const agg = new Map();
      for (const r of parsed.siteWeekly) {
        const k = r.date.slice(0, 7) + '-01|' + r.site + '|' + r.cohort;
        agg.set(k, (agg.get(k) || 0) + (r.visits || 0));
      }
      const monthly = [...agg.entries()].map(([k, visits]) => {
        const [date, site, cohort] = k.split('|');
        return { date, site, cohort, visits };
      });
      put(KEY_SITEWK, { ...meta, data: monthly,
                        collapsed: 'weeks aggregated to months to fit browser storage' });
      degraded.push('site visits collapsed to monthly');
    }
  }
  return degraded;
}

function readSlot(key) {
  try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : null; }
  catch { return null; }
}
export function loadFunnel()      { return readSlot(KEY_FUNNEL); }
export function loadNewPatients() { return readSlot(KEY_NEWPAT); }
export function loadSiteWeekly()  { return readSlot(KEY_SITEWK); }
export function loadBhTele()      { return readSlot(KEY_BHTELE); }
export function loadSiteMaster()  { return readSlot(KEY_SITES); }
export function loadDerived()     { return readSlot(KEY_DERIVED); }
export function loadRefTotals()   { return readSlot(KEY_REFTOT); }

export function clearMaster() {
  [KEY_FUNNEL, KEY_NEWPAT, KEY_SITEWK, KEY_BHTELE, KEY_SITES, KEY_DERIVED, KEY_REFTOT]
    .forEach((k) => { try { localStorage.removeItem(k); } catch { /* ignore */ } });
}
