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
  const n = Number(String(v ?? '').replace(/[,$\s]/g, ''));
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
