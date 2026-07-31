#!/usr/bin/env python3
"""
Urgent-care CLOSURE ledger, reconstructed from the Internet Archive.

No public dataset records urgent care closures. But operators publish their own
location lists, and the Wayback Machine has been archiving those lists for a
decade. A location page that existed then and does not exist now is a closure
that appears in no registry anywhere.

Method
------
1. CDX API -> every /location/<slug> URL ever archived for the operator's
   domains, with the first and last timestamp it returned HTTP 200.
2. The operator's live sitemap -> the current roster.
3. Diff the two. Anything historical but not current is a CANDIDATE.
4. Fetch each candidate live and classify by what actually happens:

       404                            -> CLOSED
       redirect to a non-location page-> CLOSED, delisted to the finder
       redirect to a DIFFERENT site   -> CONSOLIDATED into that site
       redirect to the same site      -> RENAMED slug, not a closure
       200 at the original URL        -> still open, sitemap omission

Step 4 is the whole point. Absence from a sitemap proves nothing on its own --
a rebrand, a CMS migration or a slug rename all produce absences. Only the live
response separates a closure from a redesign.

Politeness: sequential requests with a delay, and robots.txt is respected
(pmpediatriccare.com publishes "Disallow:" — i.e. everything permitted — and
advertises the sitemap this script reads).
"""

import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict
from datetime import datetime, timezone

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data")
CDX = "http://web.archive.org/cdx/search/cdx"
UA = "pm-peds-surveillance/1.0 (investor research; contact via repo)"
DELAY = 0.6

# Slug prefixes that encode geography, stripped before comparing rosters so a
# rebrand that renames "commack" to "ny-commack" is not read as a closure plus
# an opening.
GEO_PREFIX = re.compile(
    r"^(ny|nj|ct|dc|pa|md|va|fl|tx|ma|nc|il|de|new-york-city|new-york|new-jersey|"
    r"long-island|rockland|westchester|maryland|california|florida|connecticut|"
    r"delaware|alaska|virginia|texas|pennsylvania|massachusetts|north-carolina|"
    r"illinois|tennessee|pm-pediatrics)-"
)

# Slugs that are not physical clinics. "virtual-visit-*" are telehealth
# products; counting their retirement as a closure would be plain wrong.
NOT_A_CLINIC = re.compile(
    r"(^(corporate-office|texas|florida|maryland|careers|about)$)|virtual-visit|telehealth",
    re.I)

# Partner path segments that pin a GoHealth location to one of our markets.
PARTNER_STATE = {"northwell": "NY", "hartford": "CT"}

# Rough state inference from the slug. Only used for labelling; unknown is fine.
STATE_HINTS = [
    (re.compile(r"^(ny|new-york|new-york-city|long-island|rockland|westchester|bronx|"
                r"brooklyn|queens|staten)"), "NY"),
    (re.compile(r"^(nj|new-jersey)"), "NJ"),
    (re.compile(r"^(ct|connecticut)"), "CT"),
]
# Slugs with no prefix that are nonetheless in-market, learned from the roster.
KNOWN_NY = {"bensonhurst", "commack", "syosset", "selden", "manhasset", "carle-place",
            "north-babylon", "nanuet", "yonkers", "white-plains", "riverdale",
            "bayside", "midwood", "spring-valley"}
KNOWN_NJ = {"clifton", "paramus", "cherry-hill", "livingston", "marlton", "morristown",
            "woodbridge", "east-brunswick", "hazlet", "wayne-nj"}
KNOWN_CT = {"manchester", "stamford", "norwalk", "fairfield", "danbury"}

# `cdx` is the pattern handed to the archive; `slug_re` pulls the identifying
# path out of any URL. Keeping them separate is what lets an operator like
# GoHealth, whose locations nest under a partner segment
# (/henry-ford/locations/livonia), be tracked with the same machinery as
# PM Pediatrics' flat /location/<slug>.
OPERATORS = [
    {
        "id": "pm_pediatrics",
        "name": "PM Pediatrics",
        # The rebrand from pmpediatrics.com to pmpediatriccare.com is why both
        # are listed: history lives on the old domain, the roster on the new.
        "domains": [("pmpediatrics.com/location/*", None),
                    ("pmpediatriccare.com/location/*", None)],
        "slug_re": r"/location/([a-z0-9\-]+)/?$",
        "sitemaps": ["https://pmpediatriccare.com/store_pages-sitemap.xml"],
        "live_base": "https://pmpediatriccare.com/location/{slug}/",
        "finder_paths": ["/find-care", "/locations", "/location-types"],
    },
    {
        "id": "gohealth",
        "name": "GoHealth Urgent Care",
        "domains": [("gohealthuc.com", "domain")],
        "slug_re": r"/([a-z0-9\-]+/locations/[a-z0-9\-]+)/?$",
        "sitemaps": ["https://www.gohealthuc.com/sitemap.xml",
                     "https://www.gohealthuc.com/dynamic-sitemap.xml"],
        "live_base": "https://www.gohealthuc.com/{slug}",
        "finder_paths": ["/locations", "/find"],
    },
    {
        # The largest urgent-care operator in these markets, and the cleanest to
        # track: the state is a path segment, so market filtering needs no
        # guesswork at all.
        "id": "citymd",
        "name": "CityMD",
        "domains": [("citymd.com/urgent-care-locations/*", None)],
        "slug_re": r"/urgent-care-locations/([a-z]{2}/[a-z0-9\-]+)/?$",
        "sitemaps": ["https://www.citymd.com/sitemap.xml"],
        "live_base": "https://www.citymd.com/urgent-care-locations/{slug}",
        "finder_paths": ["/urgent-care-locations", "/locations"],
    },
    {
        # Health systems run urgent care alongside every other kind of clinic,
        # so these are restricted to URLs that say "urgent" -- otherwise a
        # closed cardiology office would land in an urgent-care ledger.
        "id": "atlantic_health",
        "name": "Atlantic Health (NJ)",
        "domains": [("atlantichealth.org/locations/*", None)],
        "slug_re": r"/locations/([a-z0-9\-]*urgent[a-z0-9\-]*)/?$",
        "sitemaps": ["https://www.atlantichealth.org/sitemap.xml"],
        "live_base": "https://www.atlantichealth.org/locations/{slug}",
        "finder_paths": ["/locations"],
        "default_state": "NJ",
    },
    {
        "id": "hackensack",
        "name": "Hackensack Meridian (NJ)",
        "domains": [("hackensackmeridianhealth.org", "domain")],
        "slug_re": r"/([a-z0-9\-]+/locations/[a-z0-9\-]*urgent[a-z0-9\-]*)/?$",
        "sitemaps": ["https://www.hackensackmeridianhealth.org/sitemap.xml"],
        "live_base": "https://www.hackensackmeridianhealth.org/{slug}",
        "finder_paths": ["/locations"],
        "default_state": "NJ",
    },
]


def fetch(url, timeout=90, redirect=True):
    """Return (status, final_url, body_bytes). Never raises on HTTP error."""
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *a, **k):
            return None

    opener = (urllib.request.build_opener() if redirect
              else urllib.request.build_opener(NoRedirect))
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    try:
        with opener.open(req, timeout=timeout) as r:
            return r.status, r.url, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.headers.get("Location", url), b""
    except Exception:  # noqa: BLE001
        return 0, url, b""


def cdx_history(pattern, match_type, slug_re):
    """Every archived URL matching slug_re, with the timestamps it returned 200."""
    params = {"url": pattern, "output": "json",
              "fl": "original,timestamp,statuscode", "limit": 40000,
              "filter": "statuscode:200"}
    if match_type:
        params["matchType"] = match_type
    status, _, body = fetch(f"{CDX}?{urllib.parse.urlencode(params)}", timeout=240)
    if status != 200 or not body:
        return {}
    try:
        rows = json.loads(body.decode())[1:]
    except Exception:  # noqa: BLE001
        return {}
    pat = re.compile(slug_re, re.I)
    out = defaultdict(list)
    for row in rows:
        if len(row) < 2:
            continue
        url, ts = row[0], row[1]
        m = pat.search(urllib.parse.urlparse(url.split("?")[0]).path)
        if m:
            out[m.group(1).lower()].append(ts)
    return {k: sorted(v) for k, v in out.items()}


def current_roster(sitemaps, slug_re):
    slugs = set()
    pat = re.compile(slug_re.rstrip("$") + r"/?", re.I)
    for sm in sitemaps:
        status, _, body = fetch(sm, timeout=120)
        if status != 200 or not body:
            continue
        text = body.decode("utf-8", "ignore")
        for m in re.finditer(r"<loc>([^<]+)</loc>", text):
            p = urllib.parse.urlparse(m.group(1).strip()).path
            hit = re.search(slug_re, p, re.I)
            if hit:
                slugs.add(hit.group(1).lower())
    return slugs


def core(slug):
    """Strip geography prefixes and a trailing -N duplicate marker, so
    'pm-pediatrics-new-jersey-paramus-2' and 'new-jersey-paramus' compare
    equal and a slug rename is not read as a closure."""
    return re.sub(r"-\d+$", "", GEO_PREFIX.sub("", slug))


def guess_state(slug, default=None):
    # Three encodings in the wild: a bare state path segment (CityMD's
    # ny/bay-ridge), a partner segment (GoHealth's hartford/...), or a slug
    # prefix (PM Pediatrics' new-york-city-...). Try all three, then the
    # operator default, before giving up.
    head = slug.split("/")[0]
    if re.fullmatch(r"(ny|nj|ct)", head, re.I):
        return head.upper()
    if head in PARTNER_STATE:
        return PARTNER_STATE[head]
    tail = slug.split("/")[-1]
    for candidate in (slug, tail, core(tail)):
        for pat, st in STATE_HINTS:
            if pat.match(candidate):
                return st
    c = core(tail)
    if c in KNOWN_NY:
        return "NY"
    if c in KNOWN_NJ:
        return "NJ"
    if c in KNOWN_CT:
        return "CT"
    return default


def classify(op, slug, current_cores):
    """Fetch the candidate live and decide what actually happened to it."""
    url = op["live_base"].format(slug=slug)
    status, final, _ = fetch(url, timeout=45)
    final_path = urllib.parse.urlparse(final or "").path or ""

    if status == 404 or status == 410:
        return "closed", "page returns 404", url, final
    if status == 0:
        return "unknown", "no response from live site", url, final

    m = re.search(op["slug_re"], final_path, re.I)
    if m:
        dest = m.group(1).lower()
        if dest == slug:
            return "open", "still live at its original URL", url, final
        if core(dest) == core(slug):
            return "renamed", f"slug renamed to {dest}", url, final
        return "consolidated", f"redirects to {dest}", url, final

    if any(final_path.rstrip("/").endswith(p.rstrip("/")) for p in op["finder_paths"]):
        return "closed", "delisted — redirects to the location finder", url, final
    if final_path in ("", "/"):
        return "closed", "redirects to the site root", url, final
    return "unknown", f"redirects to {final_path}", url, final


def run_operator(op):
    print(f"- {op['name']}")
    hist = {}
    for pattern, match_type in op["domains"]:
        h = cdx_history(pattern, match_type, op["slug_re"])
        print(f"    wayback {pattern}: {len(h)} slugs")
        for k, v in h.items():
            hist.setdefault(k, []).extend(v)
        time.sleep(DELAY)
    hist = {k: sorted(v) for k, v in hist.items() if not NOT_A_CLINIC.search(k)}

    current = {s for s in current_roster(op["sitemaps"], op["slug_re"])
               if not NOT_A_CLINIC.search(s)}
    print(f"    live roster: {len(current)} slugs")
    if not current:
        print("    !! empty roster — refusing to call every slug a closure")
        return {"id": op["id"], "name": op["name"], "error": "empty live roster",
                "events": [], "roster": 0, "historical": len(hist)}

    current_cores = {core(s) for s in current}
    candidates = [s for s in hist if core(s) not in current_cores]
    print(f"    candidates: {len(candidates)} — verifying each against the live site")

    events = []
    for slug in sorted(candidates):
        verdict, why, url, final = classify(op, slug, current_cores)
        ts = hist[slug]
        events.append({
            "operator": op["name"], "slug": slug, "verdict": verdict, "why": why,
            "state": guess_state(slug, op.get("default_state")),
            "in_market": guess_state(slug, op.get("default_state")) in ("NY", "NJ", "CT"),
            "first_seen": f"{ts[0][:4]}-{ts[0][4:6]}-{ts[0][6:8]}",
            "last_seen": f"{ts[-1][:4]}-{ts[-1][4:6]}-{ts[-1][6:8]}",
            "snapshots": len(ts),
            "url": url, "resolved_to": final,
            "wayback": f"https://web.archive.org/web/{ts[-1]}/{url}",
        })
        print(f"      {slug:<38} {verdict:<13} {why}")
        time.sleep(DELAY)

    # Openings: in the roster now, with the earliest archive capture as an
    # UPPER BOUND on when the site opened (the page may postdate the opening).
    openings = []
    for slug in sorted(current):
        if slug in hist:
            ts = hist[slug]
            openings.append({"operator": op["name"], "slug": slug,
                             "state": guess_state(slug, op.get("default_state")),
                             "in_market": guess_state(slug, op.get("default_state")) in ("NY", "NJ", "CT"),
                             "first_seen": f"{ts[0][:4]}-{ts[0][4:6]}-{ts[0][6:8]}",
                             "snapshots": len(ts)})
        else:
            openings.append({"operator": op["name"], "slug": slug,
                             "state": guess_state(slug, op.get("default_state")),
                             "in_market": guess_state(slug, op.get("default_state")) in ("NY", "NJ", "CT"),
                             "first_seen": None, "snapshots": 0})

    return {"id": op["id"], "name": op["name"], "roster": len(current),
            "historical": len(hist), "events": events, "openings": openings}


def main():
    print(f"closure ledger @ {datetime.now(timezone.utc):%Y-%m-%d %H:%M}Z")
    only = sys.argv[1:] or None
    operators = []
    for op in OPERATORS:
        if only and op["id"] not in only:
            continue
        try:
            operators.append(run_operator(op))
        except Exception as e:  # noqa: BLE001
            print(f"    !! {op['id']} failed: {e}")
            operators.append({"id": op["id"], "name": op["name"], "error": str(e),
                              "events": [], "openings": []})

    all_events = [e for o in operators for e in o.get("events", [])]
    closed = [e for e in all_events if e["verdict"] == "closed"]
    print(f"\n{len(closed)} closures confirmed across {len(operators)} operators")

    os.makedirs(OUT, exist_ok=True)
    path = os.path.join(OUT, "closures.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump({
            "fetched_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "method": "Wayback CDX roster vs live sitemap, each candidate verified "
                      "by fetching the live URL",
            "caveats": [
                "last_seen is the last ARCHIVE capture, not the closing date. The "
                "true closure falls somewhere after it, and the gap can be a year "
                "or more if the crawler lost interest.",
                "first_seen is an upper bound on opening: a location page can "
                "postdate the site opening.",
                "Only operators who publish a location sitemap can be tracked. "
                "CityMD, the largest operator in these markets, publishes none.",
                "A verdict of 'closed' means the page is gone or delisted. It is "
                "strong evidence, not a filing.",
            ],
            "operators": operators,
        }, f, separators=(",", ":"))
    print(f"wrote data/closures.json ({os.path.getsize(path)/1024:.0f} KB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
