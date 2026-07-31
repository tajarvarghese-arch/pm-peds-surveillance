#!/usr/bin/env python3
"""
PM Pediatrics Respiratory Surveillance -- data fetcher.

Pulls public CDC Socrata endpoints, reshapes to compact JSON, writes to data/.
Run locally or via .github/workflows/refresh.yml (daily cron).

EVERY endpoint here was probed live on 2026-07-30 and returns 200.
The endpoints in the original project brief (ua7e-t2fy as ILINet, pb4z-ynha,
g62h-syeh, 29hc-w2bd) are dead or mislabelled -- see README "Data provenance".

No PHI. No auth. All sources are public aggregate surveillance.
"""

import json
import os
import sys
import time
import urllib.parse
import urllib.request
from collections import defaultdict
from datetime import datetime, timezone

BASE = "https://data.cdc.gov/resource"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data")

# Markets: PM Pediatrics Northeast core. HHS Region 1 = CT/MA/ME/NH/RI/VT,
# Region 2 = NY/NJ/PR/VI.
STATES = ["New York", "New Jersey", "Connecticut"]
REGIONS = ["National", "Region 1", "Region 2"]
WW_STATES = ["ny", "nj", "ct"]

PED_AGES = ["<1 year", "1-4 years", "5-17 years"]


def soql(dataset, **params):
    """GET a Socrata resource with $-prefixed params, with retry."""
    q = {("$" + k if not k.startswith("$") else k): v for k, v in params.items()}
    url = f"{BASE}/{dataset}.json?" + urllib.parse.urlencode(q)
    last = None
    for attempt in range(4):
        try:
            req = urllib.request.Request(
                url, headers={"User-Agent": "pm-peds-surveillance/1.0"}
            )
            with urllib.request.urlopen(req, timeout=90) as r:
                return json.loads(r.read().decode())
        except Exception as e:  # noqa: BLE001 - want any transport error to retry
            last = e
            time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"{dataset} failed after retries: {last}") from last


def paged(dataset, page=50000, cap=400000, **params):
    """Pull all rows for a query, following $offset until exhausted."""
    rows, offset = [], 0
    while offset < cap:
        batch = soql(dataset, limit=page, offset=offset, **params)
        rows.extend(batch)
        if len(batch) < page:
            break
        offset += page
    return rows


def num(v):
    """Socrata sends '.' for suppressed cells and '' for missing."""
    if v is None:
        return None
    s = str(v).strip()
    if s in ("", ".", "NA", "N/A", "null"):
        return None
    try:
        return float(s)
    except ValueError:
        return None


def day(v):
    return str(v)[:10] if v else None


def write(name, payload, meta=None):
    os.makedirs(OUT, exist_ok=True)
    body = {
        "fetched_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "meta": meta or {},
        "data": payload,
    }
    path = os.path.join(OUT, f"{name}.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(body, f, separators=(",", ":"))
    n = payload if isinstance(payload, list) else payload.get("_n", payload)
    size = os.path.getsize(path) / 1024
    print(f"  wrote data/{name}.json  ({len(n) if hasattr(n,'__len__') else '?'} rows, {size:.0f} KB)")


# --------------------------------------------------------------------------
# 1. NSSP ED visits by age band -- NATIONAL ONLY. The pediatric backbone.
#    7xva-uux8 | weekly | 2022-10-01 -> present
# --------------------------------------------------------------------------
def ed_age():
    rows = paged(
        "7xva-uux8",
        where="demographics_type='Age Group'",
        select="week_end,pathogen,demographics_values,percent_visits",
        order="week_end",
    )
    out = defaultdict(dict)
    for r in rows:
        wk = day(r.get("week_end"))
        pv = num(r.get("percent_visits"))
        if wk is None or pv is None:
            continue
        out[wk][f"{r['pathogen']}|{r['demographics_values']}"] = pv
    series = [{"week": k, **v} for k, v in sorted(out.items())]
    return series


# --------------------------------------------------------------------------
# 2. NSSP ED visits by state -- DAILY, no age bands. Geographic + freshest.
#    vjzj-u7u8 | daily | 2022-09-25 -> present
# --------------------------------------------------------------------------
def ed_state():
    geos = STATES + ["United States"]
    quoted = ",".join(f"'{g}'" for g in geos)
    rows = paged(
        "vjzj-u7u8",
        where=f"geography in({quoted})",
        select="date,geography,pathogen,percent_visits",
        order="date",
    )
    out = defaultdict(dict)
    for r in rows:
        d = day(r.get("date"))
        pv = num(r.get("percent_visits"))
        if d is None or pv is None:
            continue
        out[d][f"{r['geography']}|{r['pathogen']}"] = pv
    return [{"date": k, **v} for k, v in sorted(out.items())]


# --------------------------------------------------------------------------
# 3. Multi-pathogen NAAT positivity by HHS region.
#    rgnm-fkqb | weekly | 2019-07-06 -> present
#    Covers PIV, HMPV, Adenovirus, RV/EV, HCOV, RSV, SARS-COV-2.
#    NOTE: contains NO influenza. Flu positivity is national-only (seuz-s2cv).
# --------------------------------------------------------------------------
def naat_multi():
    # Aggregate rows are NOT encoded consistently across pathogens:
    #   SARS-COV-2 / RSV / RV-EV / HMPV / Adenovirus -> subtype IS NULL
    #   PIV / HCOV                                   -> no NULL row at all,
    #                                                   only per-subtype +
    #                                                   subtype='Combined Type'
    # Filtering on `subtype IS NULL` alone silently drops parainfluenza and
    # seasonal coronavirus -- two of the six pathogens in scope. So pull both
    # encodings and prefer NULL per (week, level, pathogen), falling back to
    # 'Combined Type'.
    quoted = ",".join(f"'{r}'" for r in REGIONS)
    rows = paged(
        "rgnm-fkqb",
        where=f"level in({quoted}) AND (subtype IS NULL OR subtype='Combined Type')",
        select="mmwrweek_end,level,pathogen,subtype,percent_pos",
        order="mmwrweek_end",
    )
    best = {}
    for r in rows:
        wk = day(r.get("mmwrweek_end"))
        pp = num(r.get("percent_pos"))
        if wk is None or pp is None or not r.get("pathogen"):
            continue
        key = (wk, r["level"], r["pathogen"])
        is_null = r.get("subtype") in (None, "")
        # NULL wins; only let 'Combined Type' fill a slot NULL never occupied.
        if key not in best or (is_null and not best[key][1]):
            best[key] = (pp, is_null)

    out = defaultdict(dict)
    for (wk, level, pathogen), (pp, _) in best.items():
        out[wk][f"{level}|{pathogen}"] = pp
    return [{"week": k, **v} for k, v in sorted(out.items())]


# --------------------------------------------------------------------------
# 4. National positivity for the big three (flu lives here and nowhere else).
#    seuz-s2cv | weekly | 2022-10-01 -> present
# --------------------------------------------------------------------------
def pos_national():
    rows = paged(
        "seuz-s2cv",
        select="week_end,pathogen,percent_test_positivity",
        order="week_end",
    )
    out = defaultdict(dict)
    for r in rows:
        wk = day(r.get("week_end"))
        pp = num(r.get("percent_test_positivity"))
        if wk is None or pp is None:
            continue
        out[wk][r["pathogen"]] = pp
    return [{"week": k, **v} for k, v in sorted(out.items())]


# --------------------------------------------------------------------------
# 5. State ARI activity level (categorical). f3zz-zga5 | weekly
# --------------------------------------------------------------------------
def ari_level():
    quoted = ",".join(f"'{g}'" for g in STATES)
    rows = paged(
        "f3zz-zga5",
        where=f"geography in({quoted})",
        select="week_end,geography,label",
        order="week_end",
    )
    out = defaultdict(dict)
    for r in rows:
        wk = day(r.get("week_end"))
        if wk is None or not r.get("label"):
            continue
        out[wk][r["geography"]] = r["label"]
    return [{"week": k, **v} for k, v in sorted(out.items())]


# --------------------------------------------------------------------------
# 6. RESP-NET pediatric hospitalization rates. kvib-3txy | weekly
#    Severity denominator -- what share of the surge lands in hospital.
# --------------------------------------------------------------------------
def respnet():
    ages = ["0-<1 yr", "1-4 yr", "5-17 yr", "0-4 yr", "0-17 years"]
    quoted = ",".join(f"'{a}'" for a in ages)
    rows = paged(
        "kvib-3txy",
        where=(
            f"age_category in({quoted}) AND state='Overall' "
            "AND race='All' AND sex='All' AND data_type='Weekly Rate'"
        ),
        select="surveillance_network,date,age_category,estimate",
        order="date",
    )
    out = defaultdict(dict)
    for r in rows:
        d = day(r.get("date"))
        est = num(r.get("estimate"))
        if d is None or est is None:
            continue
        out[d][f"{r['surveillance_network']}|{r['age_category']}"] = est
    return [{"date": k, **v} for k, v in sorted(out.items())]


# --------------------------------------------------------------------------
# 7. Wastewater, aggregated weekly. j9g8-acpt (SARS-CoV-2), ymmh-divb (Flu A)
#    Per-sample rows -> population-weighted weekly mean per state.
#    This is the live replacement for Biobot, whose public feed ended.
# --------------------------------------------------------------------------
# A state-week built from one or two grab samples is a single treatment plant,
# not a state signal. Anything thinner than this is dropped rather than plotted.
WW_MIN_SAMPLES = 5


def wastewater(dataset, label):
    quoted = ",".join(f"'{s}'" for s in WW_STATES)
    rows = paged(
        dataset,
        where=(
            # Match the NSSP ED record so lead/lag can be tested over every
            # wave we have clinical data for, not just the last two years.
            f"state_territory in({quoted}) AND sample_collect_date > '2022-09-01' "
            # NWSS mixes liquid and solids assays in the same column. Solids
            # (copies/g dry sludge) run orders of magnitude above liquid
            # (copies/l wastewater); averaging them together produces a series
            # driven by which lab happened to report that week.
            "AND pcr_target_units='copies/l wastewater'"
        ),
        select=(
            "sample_collect_date,state_territory,population_served,"
            "pcr_target_avg_conc_lin"
        ),
        order="sample_collect_date",
    )
    buckets = defaultdict(lambda: defaultdict(list))
    for r in rows:
        d = day(r.get("sample_collect_date"))
        conc = num(r.get("pcr_target_avg_conc_lin"))
        pop = num(r.get("population_served")) or 1.0
        if d is None or conc is None or conc < 0:
            continue
        dt = datetime.strptime(d, "%Y-%m-%d")
        wk = datetime.fromordinal(dt.toordinal() - dt.weekday()).strftime("%Y-%m-%d")
        buckets[wk][r["state_territory"]].append((conc, pop))

    series = []
    for wk in sorted(buckets):
        row = {"week": wk}
        counts = {}
        for st, samples in buckets[wk].items():
            # Reporting lag means the newest week is often one plant reporting
            # early. Suppress it instead of drawing a cliff.
            if len(samples) < WW_MIN_SAMPLES:
                continue
            psum = sum(p for _, p in samples)
            if psum <= 0:
                continue
            wsum = sum(c * p for c, p in samples)
            row[st.upper()] = round(wsum / psum, 1)
            counts[st.upper()] = len(samples)
        if len(row) > 1:
            row["_n"] = counts
            series.append(row)
    return series


# --------------------------------------------------------------------------
# 8. iGAS / Group A Strep -- ABCs. 9y49-tura
#    ANNUAL ONLY. There is no weekly public iGAS feed. Presented as a burden
#    trend, not a leading indicator. Do not wire this to staffing alerts.
# --------------------------------------------------------------------------
def igas():
    rows = paged(
        "9y49-tura",
        where="bacteria='group A Streptococcus'",
        select="year,topic,viewby,viewby2,value,units",
        order="year",
    )
    keep = []
    for r in rows:
        v = num(r.get("value"))
        if v is None or not r.get("year"):
            continue
        keep.append(
            {
                "year": int(r["year"]),
                "topic": r.get("topic", ""),
                "by": r.get("viewby", ""),
                "by2": r.get("viewby2", ""),
                "value": v,
                "units": r.get("units", ""),
            }
        )
    return keep


TASKS = [
    ("ed_age", ed_age, {
        "source": "CDC NSSP ED Visits by Demographics",
        "dataset": "7xva-uux8",
        "geography": "United States only (no state breakout exists)",
        "cadence": "weekly",
        "note": "Primary pediatric volume proxy. Age bands <1/1-4/5-17.",
    }),
    ("ed_state", ed_state, {
        "source": "CDC NSSP ED Respiratory Daily",
        "dataset": "vjzj-u7u8",
        "geography": "NY / NJ / CT / US",
        "cadence": "daily",
        "note": "Freshest feed. No age breakout -- all ages.",
    }),
    ("naat_multi", naat_multi, {
        "source": "CDC NAAT percent positivity by respiratory virus",
        "dataset": "rgnm-fkqb",
        "geography": "National / HHS Region 1 / HHS Region 2",
        "cadence": "weekly",
        "note": "PIV, HMPV, Adenovirus, RV/EV, HCOV, RSV, SARS-CoV-2. NO influenza.",
    }),
    ("pos_national", pos_national, {
        "source": "CDC Percent of Tests Positive for Viral Respiratory Pathogens",
        "dataset": "seuz-s2cv",
        "geography": "United States",
        "cadence": "weekly",
        "note": "Only live source of influenza positivity. National only.",
    }),
    ("ari_level", ari_level, {
        "source": "CDC Level of Acute Respiratory Illness Activity",
        "dataset": "f3zz-zga5",
        "geography": "NY / NJ / CT",
        "cadence": "weekly",
        "note": "Categorical activity level.",
    }),
    ("respnet", respnet, {
        "source": "CDC RESP-NET (FluSurv/COVID/RSV-NET)",
        "dataset": "kvib-3txy",
        "geography": "Overall (network catchment)",
        "cadence": "weekly",
        "note": "Pediatric hospitalization rates per 100k. Severity denominator.",
    }),
    ("igas", igas, {
        "source": "CDC ABCs Group A Streptococcus",
        "dataset": "9y49-tura",
        "geography": "ABCs catchment",
        "cadence": "ANNUAL",
        "note": "Annual only. No weekly public iGAS feed exists. Not a leading indicator.",
    }),
]


def main():
    only = sys.argv[1:] or None
    print(f"PM Peds surveillance fetch @ {datetime.now(timezone.utc):%Y-%m-%d %H:%M}Z")
    manifest, failed = {}, []

    for name, fn, meta in TASKS:
        if only and name not in only:
            continue
        print(f"- {name} ({meta['dataset']})")
        try:
            payload = fn()
            write(name, payload, meta)
            manifest[name] = {**meta, "rows": len(payload),
                              "ok": True,
                              "first": payload[0].get("week") or payload[0].get("date")
                                       or payload[0].get("year") if payload else None,
                              "last": payload[-1].get("week") or payload[-1].get("date")
                                      or payload[-1].get("year") if payload else None}
        except Exception as e:  # noqa: BLE001
            print(f"  !! FAILED: {e}")
            manifest[name] = {**meta, "ok": False, "error": str(e)}
            failed.append(name)

    for name, ds, label in [("ww_covid", "j9g8-acpt", "SARS-CoV-2"),
                            ("ww_flu", "ymmh-divb", "Influenza A")]:
        if only and name not in only:
            continue
        print(f"- {name} ({ds})")
        meta = {
            "source": f"CDC NWSS Wastewater -- {label}",
            "dataset": ds,
            "geography": "NY / NJ / CT",
            "cadence": "weekly (aggregated from per-sample)",
            "note": "Population-weighted mean concentration. Replaces defunct Biobot feed.",
        }
        try:
            payload = wastewater(ds, label)
            write(name, payload, meta)
            manifest[name] = {**meta, "rows": len(payload), "ok": True,
                              "first": payload[0]["week"] if payload else None,
                              "last": payload[-1]["week"] if payload else None}
        except Exception as e:  # noqa: BLE001
            print(f"  !! FAILED: {e}")
            manifest[name] = {**meta, "ok": False, "error": str(e)}
            failed.append(name)

    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(
            {
                "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                "markets": {"states": STATES, "hhs_regions": REGIONS},
                "sources": manifest,
            },
            f,
            indent=1,
        )
    print(f"\nmanifest.json written. {len(manifest)-len(failed)}/{len(manifest)} ok.")
    if failed:
        print(f"FAILED: {', '.join(failed)}")
    # Non-zero only if everything failed -- a single dead feed shouldn't
    # break the nightly refresh and blank the whole dashboard.
    return 1 if len(failed) == len(manifest) else 0


if __name__ == "__main__":
    sys.exit(main())
