#!/usr/bin/env python3
"""
Pull real, citable literature that bears on what the surveillance data is doing.

Source: Europe PMC REST API. No key, no auth, CORS-open, covers PubMed/MEDLINE
plus preprints. Verified live 2026-07-31.

This exists so the dashboard can offer CANDIDATE EXPLANATIONS with citations
attached, rather than asserting causes. Every item rendered in the UI links back
to a real record. Nothing here is summarised into a claim -- the dashboard shows
titles, journals, dates and links, and labels the whole section as hypotheses.
"""

import json
import os
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone

EPMC = "https://www.ebi.ac.uk/europepmc/webservices/rest/search"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data")

# Recency window. Older foundational work exists, but the question this section
# answers is "why THIS year", so the window is deliberately tight.
WINDOW = "FIRST_PDATE:[2025-01-01 TO 2026-12-31]"

# Each topic maps to a signal the dashboard can actually observe. `signal` is
# the hook the UI uses to decide which topics to surface first.
# Queries are TITLE_ABS-restricted and RELEVANCE-sorted. Both matter: an
# unrestricted query matches any paper mentioning the term in passing, and
# sorting by date instead of relevance returns the most RECENT loose match
# rather than the most relevant one -- which produced vaccine-economics papers
# under "immunity debt" before this was fixed.
TOPICS = [
    {
        "id": "immunity_wall",
        "label": "Immunity wall / immunity debt",
        "signal": "season_low",
        "question": "Does a large prior season suppress the next one?",
        "query": 'TITLE_ABS:("immunity debt" OR "immunity gap" OR "immunity wall") '
                 'AND TITLE_ABS:(respiratory OR influenza OR RSV OR children)',
    },
    {
        "id": "flu_severity",
        "label": "Influenza severity & H3N2 subclade K",
        "signal": "flu_low",
        "question": "Why is influenza activity so far below prior years?",
        "query": 'TITLE_ABS:(influenza) AND TITLE_ABS:("subclade K" OR H3N2) '
                 'AND TITLE_ABS:(season OR severity OR "vaccine effectiveness")',
    },
    {
        "id": "parainfluenza",
        "label": "Parainfluenza / croup burden",
        "signal": "piv_high",
        "question": "Is the off-season parainfluenza elevation documented elsewhere?",
        "query": 'TITLE_ABS:(parainfluenza OR croup) '
                 'AND TITLE_ABS:(children OR pediatric OR paediatric)',
    },
    {
        "id": "sars2_variant",
        "label": "SARS-CoV-2 variant landscape",
        "signal": "covid_ww_rising",
        "question": "Is a new variant driving the wastewater rise?",
        "query": 'TITLE_ABS:("SARS-CoV-2" AND (variant OR lineage)) '
                 'AND TITLE_ABS:("immune evasion" OR "immune escape" OR '
                 'transmissibility OR wastewater)',
    },
    {
        "id": "rsv_prophylaxis",
        "label": "RSV nirsevimab & maternal vaccine",
        "signal": "rsv_low",
        "question": "Could prophylaxis explain suppressed RSV rather than immunity?",
        "query": 'TITLE_ABS:(nirsevimab OR "RSV vaccine" OR "maternal vaccination") '
                 'AND TITLE_ABS:(effectiveness OR impact OR hospitalisation OR '
                 'hospitalization OR bronchiolitis)',
    },
    {
        "id": "igas",
        "label": "Invasive Group A Strep",
        "signal": "igas_elevated",
        "question": "Is iGAS still running above pre-pandemic baseline?",
        "query": 'TITLE_ABS:("group A streptococcus" OR iGAS OR "scarlet fever") '
                 'AND TITLE_ABS:(invasive OR surveillance OR incidence OR children)',
    },
]


def get(url, tries=4):
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(
                url, headers={"User-Agent": "pm-peds-surveillance/1.0 (investor research)"}
            )
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read().decode())
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(2 * (i + 1))
    raise RuntimeError(f"europepmc failed: {last}") from last


def clean(s):
    """EPMC returns HTML entities and inline italic markup in titles."""
    if not s:
        return ""
    for a, b in [("&lt;i&gt;", ""), ("&lt;/i&gt;", ""), ("&lt;b&gt;", ""),
                 ("&lt;/b&gt;", ""), ("&amp;", "&"), ("&lt;", "<"), ("&gt;", ">"),
                 ("<i>", ""), ("</i>", ""), ("<b>", ""), ("</b>", "")]:
        s = s.replace(a, b)
    return " ".join(s.split())


def search(topic, page_size=8):
    q = f"({topic['query']}) AND {WINDOW}"
    # No sort parameter: Europe PMC's default is relevance, which is what we
    # want. Explicit date sort returns recent noise instead of relevant work.
    url = (f"{EPMC}?query={urllib.parse.quote(q)}"
           f"&format=json&pageSize={page_size}&resultType=core")
    data = get(url)
    items = []
    for r in data.get("resultList", {}).get("result", []):
        jinfo = (r.get("journalInfo") or {}).get("journal", {}) or {}
        pmid = r.get("pmid")
        doi = r.get("doi")
        link = (f"https://pubmed.ncbi.nlm.nih.gov/{pmid}/" if pmid
                else f"https://doi.org/{doi}" if doi
                else f"https://europepmc.org/article/{r.get('source')}/{r.get('id')}")
        items.append({
            "title": clean(r.get("title")),
            "journal": clean(jinfo.get("title") or r.get("bookOrReportDetails", {}).get("publisher", "")),
            "date": r.get("firstPublicationDate") or "",
            "authors": clean(r.get("authorString", ""))[:120],
            "link": link,
            "open": r.get("isOpenAccess") == "Y",
            "type": r.get("pubType", ""),
        })
    return {"hitCount": data.get("hitCount", 0), "items": items}


def main():
    print(f"literature fetch @ {datetime.now(timezone.utc):%Y-%m-%d %H:%M}Z")
    topics, failed = [], []
    for t in TOPICS:
        print(f"- {t['id']}")
        try:
            res = search(t)
            topics.append({**{k: v for k, v in t.items() if k != "query"},
                           "query": t["query"],
                           "hitCount": res["hitCount"],
                           "items": res["items"]})
            print(f"    {res['hitCount']} hits, kept {len(res['items'])}")
        except Exception as e:  # noqa: BLE001
            print(f"    !! {e}")
            failed.append(t["id"])
            topics.append({**{k: v for k, v in t.items() if k != "query"},
                           "query": t["query"], "hitCount": 0, "items": [],
                           "error": str(e)})
        time.sleep(0.4)  # be polite to a free public API

    os.makedirs(OUT, exist_ok=True)
    path = os.path.join(OUT, "literature.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump({
            "fetched_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "source": "Europe PMC REST API",
            "window": WINDOW,
            "note": "Candidate explanations with citations. Nothing here is a "
                    "finding of this dashboard; items are surfaced for the reader "
                    "to judge.",
            "topics": topics,
        }, f, separators=(",", ":"))
    kb = os.path.getsize(path) / 1024
    print(f"wrote data/literature.json ({kb:.0f} KB, {len(topics)} topics)")
    return 1 if len(failed) == len(TOPICS) else 0


if __name__ == "__main__":
    sys.exit(main())
