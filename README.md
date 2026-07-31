# PM Pediatrics — Respiratory Surveillance

Static dashboard forecasting pediatric respiratory volume for PM Pediatrics
markets (NY / NJ / CT). Public CDC aggregate surveillance only — **no EHR, no
PHI, no auth**.

Zero build step: plain ES modules + Chart.js from CDN. GitHub Actions refreshes
the data daily and publishes to GitHub Pages.

```bash
python scripts/fetch_data.py      # pull CDC -> data/*.json
python -m http.server 8099        # serve
```

---

## Data provenance

Every endpoint below was probed live and returns 200. **The endpoints in the
original project brief were largely dead** — this is what replaced them.

### Endpoints in the brief that do not work

| Brief said | Reality |
|---|---|
| `ua7e-t2fy` = CDC ILINet | Returns 200 but is **NHSN hospital bed occupancy**, not ILINet |
| `pb4z-ynha` = NREVSS | **404** |
| `g62h-syeh` = COVID-NET | **404** — retired with the public health emergency |
| `29hc-w2bd` = RSV-NET | **404** — real id is `29hc-w46k` |
| Biobot wastewater | Public programme ended |

### What this dashboard actually reads

| File | Dataset | Scope | Cadence |
|---|---|---|---|
| `ed_age` | `7xva-uux8` NSSP ED visits by demographics | **National only** | weekly |
| `ed_state` | `vjzj-u7u8` NSSP ED respiratory daily | NY/NJ/CT/US | **daily** |
| `naat_multi` | `rgnm-fkqb` NAAT positivity | National, HHS R1, R2 | weekly |
| `pos_national` | `seuz-s2cv` positivity, big three | National | weekly |
| `ari_level` | `f3zz-zga5` ARI activity level | NY/NJ/CT | weekly **snapshot** |
| `respnet` | `kvib-3txy` RESP-NET hospitalisation | network catchment | weekly |
| `igas` | `9y49-tura` ABCs Group A Strep | ABCs catchment | **annual** |
| `ww_covid` | `j9g8-acpt` NWSS SARS-CoV-2 | NY/NJ/CT | weekly (aggregated) |
| `ww_flu` | `ymmh-divb` NWSS Influenza A | NY/NJ/CT | weekly (aggregated) |

CORS is `Access-Control-Allow-Origin: *` on all of them, so the browser can hit
CDC directly. No proxy, no backend — which is why GitHub Pages is sufficient.

---

## Known gaps — read before trusting a number

**ILINet is gone.** No live public feed. The brief's entire staffing rule was
keyed to ILI %. Substituted with NSSP ED visit share, which is a *closer* proxy
to urgent-care door volume anyway (it has `<1`, `1-4`, `5-17` age bands).

**Thresholds were recalibrated, not transplanted.** The brief's 2.0 / 4.0 / 7.0%
ILI cutoffs applied to NSSP ED share would fire CRITICAL 1.6× staffing in **30%
of all observed weeks**. Tiers are now percentile ranks against the series' own
history. The 1.0/1.1/1.3/1.6× multipliers are unchanged. The Staffing tab shows
this comparison computed live.

**There is no 10-year history.** NSSP begins 2022-09-25 (~4 seasons); NAAT
positivity begins 2019-07-06 (~7 seasons). Percentile bands carry their `n` on
every chart. A "typical year" cannot be inferred yet.

**No state-level pediatric data exists.** `7xva-uux8` has age bands but is
national; `vjzj-u7u8` has states but no ages. These are shown separately and
**never blended**. The staffing multiplier comes from the national pediatric
index; state tiers are all-ages and are for relative market timing only.

**No regional influenza positivity exists.** `rgnm-fkqb` carries seven viruses
but excludes flu. Regional flu must be read off ED visit share.

**iGAS is annual.** ABCs publishes yearly with long lag. Deliberately not wired
into the staffing engine — a yearly count cannot drive a weekly rota.

**Derivatives hit a resolution floor.** CDC publishes ED visit share to one
decimal place. At summer levels a single 0.1pp tick moves the weighted index
~2.3%, so d1/d2 are flagged as noise and cannot promote a staffing tier.

**Wastewater needs care.** NWSS mixes `copies/l wastewater` with
`copies/g dry sludge` in one column; only the liquid assay is used. State-weeks
with fewer than 5 samples are dropped (the newest week is often one plant
reporting early). Series are indexed to each state's own median because absolute
concentrations are not comparable across labs.

**Wastewater is corroboration, not an early-warning trigger.** Measured on this
repo's own data (n≈200 weeks, NY/NJ/CT), SARS-CoV-2 wastewater vs ED COVID share:

| | Level correlation | Growth-rate correlation |
|---|---|---|
| NY | r=0.72 @ lag +1wk | r=0.30 |
| NJ | r=0.82 @ lag +1wk | r=0.49 |
| CT | r=0.83 @ lag 0 | r=0.42 |

Levels track strongly, but levels share a seasonal wave — that inflates the
number. Week-over-week *growth* is what would justify an early-warning trigger,
and at r≈0.3–0.5 it does not. So wastewater can raise or lower confidence in an
ED-derived signal, and it breaks ties when ED derivatives sit on the
quantisation floor, but it **never moves the staffing multiplier**. The
Wastewater tab recomputes this whole lead/lag curve at render time, so the claim
stays honest as the record grows.

Its real value: concentration is continuous, so it still resolves direction in
the summer trough where the 0.1pp-rounded ED series cannot.

**`f3zz-zga5` has no history.** CDC overwrites it weekly. `scripts/archive_history.py`
appends each cron run to `data/history/` so a back-series accumulates over time.

---

## The one assumption

`VISIT_MIX` in `js/config.js` — estimated PM Pediatrics urgent-care visit share
by age band (`<1`: 0.15, `1-4`: 0.40, `5-17`: 0.45). These are **not** population
shares and **not** PM Pediatrics' real mix; there is no clinic-level utilisation
data available. Adjustable live on the Staffing tab. Supplying the real
distribution is the single highest-value improvement to this tool.

---

## Deploy

Push to `main`. Enable Pages → Source: **GitHub Actions**. The workflow pulls
CDC data, commits snapshots, and deploys — daily at 11:10 UTC and on push.

GitHub Pages has no authentication. This dashboard contains no PHI and no
proprietary PM Pediatrics data, so it is safe to serve publicly; if you later add
internal figures (actual visit counts, clinic utilisation), move it behind
Cloudflare Access or switch hosts.

---

## Layout

```
index.html            shell + tab chrome
css/terminal.css      brutalist dark theme
js/config.js          markets, palette, thresholds, documented gaps
js/data.js            snapshot loader + live CDC fallback + freshness probe
js/derive.js          d1/d2, percentiles, seasonal bands, forecast, staffing
js/charts.js          Chart.js theming, sparklines, heat ramp
js/tabs/*.js          seven tabs (exec, pathogens, historical,
                      forecast, geo, wastewater, staffing)
scripts/fetch_data.py CDC -> data/*.json
scripts/archive_history.py  accumulates the snapshot-only dataset
```

Not clinical guidance. A planning heuristic for staffing.
