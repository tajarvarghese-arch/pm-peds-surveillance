#!/usr/bin/env python3
"""
Urgent-care SITE roster for NY / NJ / CT, from Overture Maps Places.

Why this exists: the NPPES layer counts organisation REGISTRATIONS, which are
legal entities, not places. PM Pediatrics shows ~13 New York entities against
~30 New York locations. Overture gives actual points on the ground -- name,
address, coordinates, website, brand -- which is what "who else is in my market"
actually means.

Free, Apache-licensed, no key, no account. Public S3, monthly releases.

WHAT THIS IS NOT
----------------
It is not a closure source, and that was tested rather than assumed:

  * Overture carries 32,271 `permanently_closed` places in the NY/NJ/CT bbox,
    but ZERO of them are urgent care. The closure signal exists for restaurants
    and retail, not for this vertical.
  * Diffing consecutive monthly releases does not work either: only 78.9% of
    June IDs survive into July, so a naive diff invents ~550 closures a month
    out of pure ID churn.

Closures come from scripts/fetch_closures.py (Internet Archive) instead.
"""

import json
import os
import re
import sys
import urllib.request
from datetime import datetime, timezone

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data")
BUCKET = "overturemaps-us-west-2"
LISTING = f"https://{BUCKET}.s3.amazonaws.com/?list-type=2&prefix=release/&delimiter=/&max-keys=600"

# Generous bounding box over NY/NJ/CT. It is deliberately loose because bbox is
# only used for parquet row-group pruning; the authoritative filter is the
# address region below.
BBOX = (-80.6, -71.5, 38.8, 45.2)
STATES = ("NY", "NJ", "CT")

# Category and name matching. Overture's taxonomy uses urgent_care_clinic, but
# plenty of real sites are only identifiable by name, so both are accepted.
MATCH = (
    "(categories.primary = 'urgent_care_clinic'"
    " OR list_contains(categories.alternate, 'urgent_care_clinic')"
    " OR names.primary ILIKE '%urgent care%')"
)

BRANDS = [
    ("PM Pediatrics", ["pm pediatric"]),
    ("CityMD", ["citymd", "city md"]),
    ("GoHealth", ["gohealth", "go health"]),
    ("Northwell", ["northwell"]),
    ("ProHEALTH", ["prohealth"]),
    ("AFC Urgent Care", ["afc urgent", "american family care"]),
    ("MedExpress", ["medexpress"]),
    ("CareMount / Optum", ["caremount", "optum"]),
    ("Hackensack Meridian", ["hackensack"]),
    ("Atlantic Health", ["atlantic health"]),
    ("Hartford HealthCare", ["hartford healthcare"]),
    ("Yale New Haven", ["yale new haven"]),
    ("PhysicianOne", ["physicianone", "physician one"]),
    ("Summit Health", ["summit health"]),
    ("Stat Health", ["stat health", "stathealth"]),
    ("ModernMD", ["modernmd", "modern md"]),
]


def latest_release():
    """Newest release prefix in the public bucket."""
    with urllib.request.urlopen(LISTING, timeout=90) as r:
        body = r.read().decode()
    rels = sorted(set(re.findall(r"release/(\d{4}-\d{2}-\d{2}\.\d+)/", body)))
    if not rels:
        raise RuntimeError("no Overture releases found")
    return rels[-1]


def brand_of(name, brand_name):
    hay = f"{name or ''} {brand_name or ''}".lower()
    for label, frags in BRANDS:
        if any(f in hay for f in frags):
            return label
    return None


def main():
    try:
        import duckdb
    except ImportError:
        print("duckdb not installed -- pip install duckdb")
        return 1

    rel = latest_release()
    src = f"s3://{BUCKET}/release/{rel}/theme=places/type=place/*"
    print(f"Overture release {rel}")

    con = duckdb.connect()
    con.execute("INSTALL httpfs; LOAD httpfs; SET s3_region='us-west-2';")
    # ST_X/ST_Y live in the spatial extension; without it the geometry column
    # can be read but not measured.
    con.execute("INSTALL spatial; LOAD spatial;")
    con.execute("SET enable_progress_bar=false;")

    xmin, xmax, ymin, ymax = BBOX
    q = f"""
    SELECT
      id,
      names.primary                AS name,
      brand.names.primary          AS brand,
      categories.primary           AS category,
      coalesce(operating_status,'unknown') AS status,
      addresses[1].locality        AS city,
      addresses[1].region          AS state,
      addresses[1].postcode        AS zip,
      addresses[1].freeform        AS street,
      round(confidence, 3)         AS confidence,
      websites[1]                  AS website,
      round(ST_X(ST_Centroid(geometry)), 5) AS lon,
      round(ST_Y(ST_Centroid(geometry)), 5) AS lat
    FROM read_parquet('{src}')
    WHERE bbox.xmin BETWEEN {xmin} AND {xmax}
      AND bbox.ymin BETWEEN {ymin} AND {ymax}
      AND addresses[1].region IN {STATES}
      AND {MATCH}
    """
    rows = con.execute(q).fetchall()
    cols = [d[0] for d in con.description]
    print(f"  {len(rows)} urgent-care sites in {'/'.join(STATES)}")

    sites, by_state, by_brand, by_status = [], {}, {}, {}
    for r in rows:
        d = dict(zip(cols, r))
        d["brand_label"] = brand_of(d.get("name"), d.get("brand"))
        sites.append(d)
        by_state[d["state"]] = by_state.get(d["state"], 0) + 1
        by_status[d["status"]] = by_status.get(d["status"], 0) + 1
        if d["brand_label"]:
            key = d["brand_label"]
            by_brand.setdefault(key, {"NY": 0, "NJ": 0, "CT": 0})
            by_brand[key][d["state"]] += 1

    # Confidence is Overture's own belief the place is real. Low-confidence rows
    # are kept but flagged, so a thin record never silently inflates a count.
    low = sum(1 for s in sites if (s.get("confidence") or 0) < 0.5)

    ranked = dict(sorted(by_brand.items(),
                         key=lambda kv: -sum(kv[1].values())))

    os.makedirs(OUT, exist_ok=True)
    path = os.path.join(OUT, "places_roster.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump({
            "fetched_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "source": f"Overture Maps Places, release {rel}",
            "license": "Overture / ODbL + CDLA-Permissive; free, no key",
            "measures": "physical urgent-care SITES with name, address and coordinates",
            "does_not_measure": [
                "closures -- Overture holds 32,271 permanently_closed places in "
                "this bbox but ZERO urgent care, so the vertical has no closure "
                "coverage",
                "change over time -- only 78.9% of IDs survive between "
                "consecutive monthly releases, so diffing releases invents "
                "hundreds of false closures from ID churn alone",
            ],
            "release": rel,
            "totals": {"sites": len(sites), "by_state": by_state,
                       "by_status": by_status, "low_confidence": low},
            "by_brand": ranked,
            "sites": sorted(sites, key=lambda s: (s["state"], s.get("city") or "",
                                                  s.get("name") or "")),
        }, f, separators=(",", ":"))
    print(f"  by state: {by_state}")
    print(f"  branded:  {len(by_brand)} operators matched")
    print(f"  wrote data/places_roster.json ({os.path.getsize(path)/1024:.0f} KB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
