// Static configuration: markets, pathogen identity, thresholds, assumptions.
// Everything tunable lives here so the rest of the code stays declarative.

export const MARKETS = {
  states: ['New York', 'New Jersey', 'Connecticut'],
  abbr: { 'New York': 'NY', 'New Jersey': 'NJ', 'Connecticut': 'CT' },
  regions: ['National', 'Region 1', 'Region 2'],
  regionNote: {
    'Region 1': 'CT MA ME NH RI VT',
    'Region 2': 'NY NJ PR VI',
    National: 'US aggregate',
  },
};

// Terminal palette. Pathogen -> accent, per the brief's colour language.
export const PATHOGENS = {
  'COVID-19': { key: 'COVID-19', edKey: 'COVID', color: '#22d3ee', label: 'COVID' },
  Influenza: { key: 'Influenza', edKey: 'Influenza', color: '#fbbf24', label: 'FLU' },
  RSV: { key: 'RSV', edKey: 'RSV', color: '#4ade80', label: 'RSV' },
  PIV: { key: 'PIV', color: '#f97316', label: 'PARAINFLU' },
  HMPV: { key: 'HMPV', color: '#a78bfa', label: 'HMPV' },
  Adenovirus: { key: 'Adenovirus', color: '#f472b6', label: 'ADENO' },
  'RV/EV': { key: 'RV/EV', color: '#94a3b8', label: 'RHINO/ENTERO' },
  HCOV: { key: 'HCOV', color: '#64748b', label: 'SEASONAL HCOV' },
  Combined: { key: 'Combined', edKey: 'ARI', color: '#e2e8f0', label: 'COMBINED' },
};

export const PED_AGES = ['<1 year', '1-4 years', '5-17 years'];

// --- ASSUMPTION -----------------------------------------------------------
// PM Pediatrics visit mix by age band. We have no clinic-level utilisation
// data, so these are estimates of urgent-care pediatric visit share, not
// population share. Surfaced in the UI as editable + flagged as an assumption.
// Change these and the Pediatric Pressure Index rescales.
export const VISIT_MIX = {
  '<1 year': 0.15,
  '1-4 years': 0.40,
  '5-17 years': 0.45,
};

// --- STAFFING ENGINE ------------------------------------------------------
// The brief's thresholds (ILI 2/4/7%) were calibrated to CDC ILINet, which no
// longer publishes. NSSP ED %visits runs on a different scale entirely
// (pediatric combined sits near 1% in summer vs ILINet's ~2% floor), so those
// cutoffs do not transfer. We derive tiers from percentile rank against the
// series' own history instead -- self-calibrating, and honest about n.
export const TIERS = [
  { name: 'NORMAL', pct: 0, mult: 1.0, class: 'ok' },
  { name: 'WATCH', pct: 50, mult: 1.1, class: 'watch' },
  { name: 'ELEVATED', pct: 75, mult: 1.3, class: 'elevated' },
  { name: 'CRITICAL', pct: 90, mult: 1.6, class: 'critical' },
];

// Acceleration modifiers applied on top of the percentile tier.
export const ACCEL = {
  // d1 = week-over-week % change in the index
  d1Surge: 15, // % -- sustained climb
  d1Fast: 30, // % -- steep climb
  bumpOnAccel: true, // promote one tier if d1 > d1Surge AND d2 > 0
};

export const DATASETS = {
  ed_age: '7xva-uux8',
  ed_state: 'vjzj-u7u8',
  naat_multi: 'rgnm-fkqb',
  pos_national: 'seuz-s2cv',
  ari_level: 'f3zz-zga5',
  respnet: 'kvib-3txy',
  igas: '9y49-tura',
  ww_covid: 'j9g8-acpt',
  ww_flu: 'ymmh-divb',
};

// Feeds that do NOT exist, and what we substituted. Rendered in the UI so the
// gaps are visible rather than silently papered over.
export const PROVENANCE_GAPS = [
  {
    wanted: 'CDC ILINet outpatient ILI %',
    status: 'RETIRED',
    detail: 'No live public endpoint. Closest survivor 6svj-q4zv last updated 2024-10-18.',
    using: 'NSSP ED visit % by age band (7xva-uux8) -- closer proxy to urgent-care volume anyway.',
  },
  {
    wanted: 'Biobot wastewater',
    status: 'DISCONTINUED',
    detail: 'Public program ended.',
    using: 'CDC NWSS (j9g8-acpt SARS-CoV-2, ymmh-divb Influenza A).',
  },
  {
    wanted: 'Regional influenza positivity',
    status: 'DOES NOT EXIST',
    detail: 'rgnm-fkqb covers 7 viruses but excludes influenza. No HHS-region flu positivity feed published.',
    using: 'National positivity (seuz-s2cv) + state-level ED flu %visits (vjzj-u7u8).',
  },
  {
    wanted: 'Weekly iGAS / Group A Strep surveillance',
    status: 'ANNUAL ONLY',
    detail: 'ABCs (9y49-tura) publishes yearly. No weekly public feed.',
    using: 'Annual burden trend. Deliberately NOT wired to staffing alerts.',
  },
  {
    wanted: 'State-level pediatric age bands',
    status: 'NOT PUBLISHED',
    detail: '7xva-uux8 age breakout is national only; vjzj-u7u8 has states but no ages.',
    using: 'National age structure + state all-ages trend, shown separately. Never blended.',
  },
  {
    wanted: '10-year history',
    status: 'UNAVAILABLE',
    detail: 'NSSP begins 2022-09-25 (~4 seasons). NAAT positivity begins 2019-07-06 (~7 seasons).',
    using: 'Percentile bands over actual available history, with n labelled on every band.',
  },
];
