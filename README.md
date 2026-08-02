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

## The "Why" tab

Two halves, deliberately kept apart.

**What can be tested here.** The immunity-wall check runs against this
dashboard's own record: for each season transition, prior-season burden against
the next season's early level. It reports Spearman ρ with its n and never
dresses the result up as inference.

As of writing it returns a genuinely awkward result — prior-season *peak* ranks
perfectly against the next season's start (ρ=−1.00, every heavier season
followed by a softer one), while *cumulative* burden shows nothing (ρ=0.00). If
population immunity were the mechanism, total exposure should matter at least as
much as peak sharpness. The tab flags this disagreement rather than quoting the
stronger number, and notes that at n=4 a perfect ordering arises by chance in 1
of 24 permutations.

**What other people have published.** Real, cited, linked items from the
Europe PMC REST API (`scripts/fetch_literature.py`) — no key, CORS-open,
relevance-sorted and restricted to titles and abstracts. Topics map to signals
the dashboard can observe, and whichever signals are currently firing get
surfaced first.

Nothing in this section is summarised into a claim. It offers candidate
explanations with citations attached and leaves the judgement to the reader. A
dashboard that explains its own data has stopped measuring it.

## The Market Supply tab — read this before quoting it

**There is no public dataset of urgent care openings and closures.** Checked,
not assumed:

| Source | Openings | Closures | Covers urgent care? |
|---|---|---|---|
| CMS NPPES | registration date — **entity, not site** | not exposed by the API | yes, self-reported taxonomy |
| NY `vn5v-hh5r` facilities | has `fac_opn_dat` | **no close date; active-only file** | **no urgent care type** |
| NY `h343-jwie` CON | establishment filings | **no closure category** | **0 of 400 D&TC records since 2023** |
| NJ / CT portals | nothing published | nothing published | — |

Most freestanding urgent care operates as a physician practice, outside the
facility-licensure regimes that would record an opening or a closing. Nobody is
obliged to publish a closure, and closed sites keep live NPIs for years.

So the tab measures **organisation NPI registrations carrying the urgent-care
taxonomy** — a proxy for market *entry*, and no signal at all for *exit*.
PM Pediatrics shows 13 New York entities against roughly thirty New York
locations; that ratio is the honest scale of the gap.

Two traps found while building it, both fixed:

- **`state=NY` matches the mailing address**, so every entity whose corporate
  mail goes to New Hyde Park counted as New York — including
  "PM PEDIATRICS OF FLORIDA, LLC" in Plantation FL. `address_purpose=LOCATION`
  is required. Uncorrected, NY was inflated 26% (722 → 571).
- **Individual NPIs must be filtered out.** An urgent-care taxonomy on an
  individual NPI is a clinician, not a place of business.

Chain coverage is badly incomplete and the UI says so: CityMD runs ~150 NY sites
and matches **zero**, because large groups often bill through one corporate NPI
under a different taxonomy.

### Site census — Overture Maps

`scripts/fetch_places.py` pulls actual points on the ground for NY/NJ/CT from
Overture Maps Places: free, Apache/ODbL, public S3, no key, no account. DuckDB
reads the parquet remotely with predicate pushdown, so it stays cheap.

1,438 urgent-care sites with name, address, coordinates and website. This layer
finds operators NPPES structurally cannot — AFC runs franchise sites and files
no distinct organisation NPIs, so it is invisible in the registration data yet
shows 99 sites here.

**Overture cannot supply closures, and that was tested rather than assumed:**

- It holds 32,271 `permanently_closed` places in the NY/NJ/CT bbox and
  **zero** are urgent care. The closure signal covers retail and restaurants,
  not this vertical.
- Diffing consecutive monthly releases fails too: only **78.9%** of IDs survive
  from one release to the next, so a naive diff manufactures ~550 false
  closures a month out of ID churn alone.

Coverage is a floor, not a census: CityMD appears at 37 NY sites against
roughly 150 it actually operates.

### Closures, reconstructed from the Internet Archive

Closures are not published anywhere — but operators publish their own location
lists, and the Wayback Machine has archived those lists for a decade.
`scripts/fetch_closures.py` recovers every `/location/<slug>` URL an operator
has ever served, diffs it against their live sitemap, then **fetches each
surviving candidate live** and classifies by what actually happens:

| Live response | Verdict |
|---|---|
| 404 | **closed** |
| redirect to the location finder | **closed**, delisted |
| redirect to a *different* site | consolidated — not a closure |
| redirect to the *same* site | slug rename — not a closure |
| 200 at the original URL | still open, sitemap omission |

That last step is the whole method. Absence from a sitemap proves nothing: a
rebrand, a CMS migration or a slug rename all produce absences. Live
verification removed 53 of 65 candidates.

Tracked operators are those publishing a location sitemap: PM Pediatrics,
CityMD, GoHealth (Northwell NY / Hartford CT), Atlantic Health. AFC runs
franchise sites and publishes only blog pages nationally; several regional
groups publish no sitemap at all, so they cannot be tracked this way.

**`last_seen` is not the closing date** — it is the last archive capture, so the
true closure falls somewhere after it. `first_seen` is an upper bound on
opening, since a page can only be archived after it exists.

`data/market_events.json` is a **hand-maintained ledger** for openings and
closures you learn about from press releases, local press or site visits. No
script writes it and the nightly refresh never touches it.

## The one assumption

`VISIT_MIX` in `js/config.js` — estimated PM Pediatrics urgent-care visit share
by age band (`<1`: 0.15, `1-4`: 0.40, `5-17`: 0.45). These are **not** population
shares and **not** PM Pediatrics' real mix; there is no clinic-level utilisation
data available. Adjustable live on the Staffing tab. Supplying the real
distribution is the single highest-value improvement to this tool.

---

## If nobody touches the repo

GitHub disables scheduled workflows in a public repo after **60 days with no
repository activity**, and commits made by `GITHUB_TOKEN` do not reliably reset
that timer — the exact trap a self-committing data pipeline falls into. Site
traffic is not repository activity, so a dashboard being read daily can still
have a dead refresh job.

Two defences, because the failure mode is silent:

1. **`.github/workflows/keepalive.yml`** runs on the 1st and 15th of each month.
   It calls the Actions API to re-enable `refresh.yml` and stamps
   `.github/last-alive` with a real commit.
2. **The site checks CDC itself.** On every page load the browser queries
   `vjzj-u7u8` directly (CORS is open) and compares against the committed
   snapshot. If the build is more than 10 days old, or CDC is 14+ days ahead, a
   banner appears above the tabs; past 45 days it escalates to red. So even with
   every workflow dead, the page tells you it is out of date instead of quietly
   serving old numbers.

### Guaranteed uptime: `REFRESH_PAT` (optional)

Both workflows check out with
`token: ${{ secrets.REFRESH_PAT || secrets.GITHUB_TOKEN }}`. Without the secret
they run exactly as before. With it, the daily data commit is pushed as a real
user, which **is** repository activity — so the 60-day timer resets every single
day and the schedule never approaches the cutoff.

To enable:

1. GitHub → Settings → Developer settings → Personal access tokens →
   **Fine-grained tokens** → Generate new token
2. Repository access: **only** `pm-peds-surveillance`
3. Repository permissions: **Contents: Read and write** and
   **Workflows: Read and write**. Nothing else.
4. Set an expiry you will actually renew (12 months is the practical maximum)
5. Copy the token, then repo → Settings → Secrets and variables → Actions →
   New repository secret → name it `REFRESH_PAT`

The token is write-scoped to one public repo containing only public CDC data, so
the blast radius is small — but it is still a credential, so keep the expiry
short enough that a leak ages out.

**When it expires the pushes start failing silently.** That is fine by design:
the in-app staleness banner still fires, because it asks CDC directly rather
than trusting the pipeline. Trust the banner, not the cron.

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
js/tabs/*.js          eight tabs (exec, pathogens, historical, forecast,
                      geo, wastewater, why, staffing)
scripts/fetch_data.py CDC -> data/*.json
scripts/archive_history.py  accumulates the snapshot-only dataset
```

Not clinical guidance. A planning heuristic for staffing.
