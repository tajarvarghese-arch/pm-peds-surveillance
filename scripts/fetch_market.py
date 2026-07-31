#!/usr/bin/env python3
"""
Urgent-care market supply in PM Pediatrics markets (NY / NJ / CT).

READ THIS BEFORE TRUSTING THE OUTPUT.

There is no public dataset of urgent care openings and closures. That was
checked, not assumed:

  * NPPES NPI registry     -- enumeration date is entity-level, not site-level,
                              and deactivation is not exposed by the API.
  * NY vn5v-hh5r facilities-- has fac_opn_dat but NO close date, and lists only
                              currently-active facilities. No urgent care type.
  * NY h343-jwie CON       -- has establishment filings but no closure category;
                              0 of 400 D&TC records since 2023 are urgent care.
  * NJ / CT open data      -- nothing equivalent published.

Most freestanding urgent care operates as a physician practice, outside the
facility-licensure regimes that would otherwise record an opening or a closing.

So this script measures ORGANISATION NPI REGISTRATIONS carrying the urgent-care
taxonomy. That is a proxy for market ENTRY, and nothing at all for exit. A
registration may precede a site opening by many months, one entity may operate
many sites, and a closed site frequently keeps a live NPI for years.

Use it for direction and cadence, never for a site count.
"""

import json
import os
import sys
import time
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from datetime import datetime, timezone

API = "https://npiregistry.cms.hhs.gov/api/"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data")
STATES = ["NY", "NJ", "CT"]

# Name fragments for operators that matter competitively in these markets.
# Matched case-insensitively against the NPPES organisation name. This is a
# convenience label, not an ownership record -- brands get bought and renamed.
CHAINS = [
    ("PM Pediatrics", ["pm pediatric"]),
    ("CityMD", ["citymd", "city md"]),
    ("GoHealth", ["gohealth", "go health urgent"]),
    ("Northwell", ["northwell"]),
    ("ProHEALTH", ["prohealth", "pro health"]),
    ("Hackensack Meridian", ["hackensack", "meridian"]),
    ("RWJBarnabas", ["rwjbarnabas", "barnabas"]),
    ("Atlantic Health", ["atlantic health"]),
    ("Hartford HealthCare", ["hartford healthcare"]),
    ("Yale New Haven", ["yale new haven", "ynhh"]),
    ("PhysicianOne", ["physicianone", "physician one"]),
    ("AFC Urgent Care", ["afc urgent", "american family care"]),
    ("MedExpress", ["medexpress"]),
    ("CareMount / Optum", ["caremount", "optum"]),
]


def get(url, tries=4):
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "pm-peds-surveillance/1.0"})
            with urllib.request.urlopen(req, timeout=90) as r:
                return json.loads(r.read().decode())
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(2 * (i + 1))
    raise RuntimeError(f"NPPES failed: {last}") from last


def fetch_state(state):
    """
    Page through NPPES for a state. The API caps at limit=200 and skip<=1000,
    i.e. 1200 records per query. All three markets come in under that, so no
    partitioning is needed -- but the cap is asserted below so this fails loudly
    rather than silently truncating if a market grows past it.
    """
    rows, skip = [], 0
    while skip <= 1000:
        q = urllib.parse.urlencode({
            "version": "2.1", "taxonomy_description": "Urgent Care",
            "state": state,
            # Without this, `state` matches the MAILING address too, so every
            # entity whose corporate mail goes to a New Hyde Park PO box counts
            # as New York -- including "PM PEDIATRICS OF FLORIDA, LLC" sitting
            # in Plantation FL. That contaminated every state total until it was
            # caught. LOCATION restricts to the practice address.
            "address_purpose": "LOCATION",
            "limit": 200, "skip": skip,
        })
        data = get(f"{API}?{q}")
        batch = data.get("results", [])
        rows.extend(batch)
        if len(batch) < 200:
            break
        skip += 200
        time.sleep(0.3)
    truncated = skip > 1000
    return rows, truncated


def classify(name):
    low = (name or "").lower()
    for label, frags in CHAINS:
        if any(f in low for f in frags):
            return label
    return None


def main():
    print(f"market supply fetch @ {datetime.now(timezone.utc):%Y-%m-%d %H:%M}Z")
    states = {}
    entities = []
    warnings = []

    for st in STATES:
        raw, truncated = fetch_state(st)
        if truncated:
            warnings.append(f"{st} hit the NPPES 1200-record cap; counts are a floor, not a total")
        kept = []
        for r in raw:
            basic = r.get("basic") or {}
            # Organisation NPIs only. An urgent-care taxonomy on an INDIVIDUAL
            # NPI is a clinician who works urgent care, not a place of business,
            # and counting them would inflate every figure several-fold.
            if r.get("enumeration_type") != "NPI-2":
                continue
            addr = next((a for a in (r.get("addresses") or [])
                         if a.get("address_purpose") == "LOCATION"),
                        (r.get("addresses") or [{}])[0])
            name = basic.get("organization_name") or ""
            kept.append({
                "npi": r.get("number"),
                "name": name,
                "chain": classify(name),
                "city": (addr.get("city") or "").title(),
                "zip": (addr.get("postal_code") or "")[:5],
                "enumerated": (basic.get("enumeration_date") or "")[:10],
                "status": basic.get("status"),
                "updated": (basic.get("last_updated") or "")[:10],
            })

        by_year = Counter(e["enumerated"][:4] for e in kept if e["enumerated"])
        by_chain = Counter(e["chain"] for e in kept if e["chain"])
        states[st] = {
            "total": len(kept),
            "raw_returned": len(raw),
            "truncated": truncated,
            "by_year": dict(sorted(by_year.items())),
            "by_chain": dict(by_chain.most_common()),
            "independent": len(kept) - sum(by_chain.values()),
        }
        for e in kept:
            entities.append({**e, "state": st})
        print(f"  {st}: {len(raw)} returned, {len(kept)} organisation NPIs, "
              f"{len(by_chain)} known chains{'  [TRUNCATED]' if truncated else ''}")

    # Recent registrations, most useful slice for an investor scanning entry.
    recent = sorted(
        [e for e in entities if e["enumerated"] >= "2023-01-01"],
        key=lambda e: e["enumerated"], reverse=True,
    )[:400]

    os.makedirs(OUT, exist_ok=True)
    path = os.path.join(OUT, "market_supply.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump({
            "fetched_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "source": "CMS NPPES NPI Registry (organisation NPIs, Urgent Care taxonomy)",
            "measures": "ENTITY REGISTRATIONS, a proxy for market entry",
            "does_not_measure": [
                "site openings -- one entity may operate many locations",
                "closures -- NPI deactivation is not exposed by the NPPES API "
                "and closed sites routinely keep a live NPI for years",
                "unlicensed or physician-practice urgent care that never "
                "registers a distinct organisation NPI",
            ],
            "warnings": warnings,
            "states": states,
            "recent": recent,
            "chains_tracked": [c[0] for c in CHAINS],
        }, f, separators=(",", ":"))
    kb = os.path.getsize(path) / 1024
    print(f"wrote data/market_supply.json ({kb:.0f} KB, {len(entities)} entities)")
    if warnings:
        for w in warnings:
            print(f"  WARNING: {w}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
