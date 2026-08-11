#!/usr/bin/env python3
"""
Ingest PM Pediatrics board-portal visit exports into a private local workbook.

CONFIDENTIALITY
---------------
This script only ever reads from and writes to private/, which is gitignored.
The published dashboard never reads it. Board-portal data is confidential
company information and, for a board member, potentially material non-public
information -- it must not enter the public repository, because a commit is
public permanently even if reverted.

WHAT IT DOES NOT DO
-------------------
It does not log into the portal. That requires your credentials, which is
yours to do and not something to automate here. The workflow is:

    export from the portal  ->  drop the file in private/inbox/  ->  run this

WHY COLUMN DETECTION IS FUZZY
-----------------------------
The portal's export schema is unknown, so columns are matched by name against
a set of likely headers and the mapping is printed every run. If it guesses
wrong, write private/column_map.json to override -- see --init.

Usage
-----
    python scripts/ingest_visits.py            # ingest everything in inbox/
    python scripts/ingest_visits.py --init     # create folders + a map template
    python scripts/ingest_visits.py --dry-run  # show the mapping, write nothing
"""

import argparse
import json
import os
import re
import shutil
import sys
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")
PRIV = os.path.join(ROOT, "private")
INBOX = os.path.join(PRIV, "inbox")
ARCHIVE = os.path.join(PRIV, "archive")
BOOK = os.path.join(PRIV, "pm_visits.xlsx")
MAP = os.path.join(PRIV, "column_map.json")

# Candidate header names, most specific first. Matched case-insensitively
# against normalised column names.
CANDIDATES = {
    "date": ["date", "visitdate", "servicedate", "day", "weekending", "weekend",
             "week", "month", "period", "encounterdate", "dos"],
    "location": ["location", "site", "clinic", "center", "centre", "facility",
                 "practice", "office", "market", "sitename", "locationname"],
    "visits": ["visits", "visitcount", "encounters", "patients", "volume",
               "patientvisits", "totalvisits", "count", "census", "arrivals"],
    "age_band": ["ageband", "agegroup", "age", "agerange", "agecategory"],
    "payer": ["payer", "payor", "insurance", "plan", "financialclass"],
}


def norm(s):
    return re.sub(r"[^a-z0-9]", "", str(s).lower())


def detect(columns, override):
    """Map canonical field -> actual column name."""
    found = {}
    normed = {norm(c): c for c in columns}
    for field, names in CANDIDATES.items():
        if field in override and override[field] in columns:
            found[field] = override[field]
            continue
        for want in names:
            if want in normed:
                found[field] = normed[want]
                break
        else:
            # substring fallback, longest column name loses to shortest match
            hits = [c for n, c in normed.items() if any(w in n for w in names)]
            if hits:
                found[field] = sorted(hits, key=len)[0]
    return found


def read_any(path):
    import pandas as pd
    ext = os.path.splitext(path)[1].lower()
    if ext in (".xlsx", ".xlsm", ".xls"):
        # Take the first sheet with more than a header row.
        book = pd.read_excel(path, sheet_name=None)
        for name, df in book.items():
            if len(df) > 0:
                return df, name
        return list(book.values())[0], list(book.keys())[0]
    if ext in (".csv", ".txt"):
        return pd.read_csv(path), "csv"
    if ext == ".tsv":
        return pd.read_csv(path, sep="\t"), "tsv"
    raise ValueError(f"unsupported file type: {ext}")


def to_long(df, cols, source):
    """Normalise one export into long rows."""
    import pandas as pd
    if "date" not in cols or "visits" not in cols:
        missing = [f for f in ("date", "visits") if f not in cols]
        raise ValueError(f"could not find required column(s): {', '.join(missing)}")

    out = pd.DataFrame()
    out["date"] = pd.to_datetime(df[cols["date"]], errors="coerce").dt.strftime("%Y-%m-%d")
    out["location"] = df[cols["location"]].astype(str).str.strip() if "location" in cols else "(all)"
    out["age_band"] = df[cols["age_band"]].astype(str).str.strip() if "age_band" in cols else "(all)"
    out["payer"] = df[cols["payer"]].astype(str).str.strip() if "payer" in cols else "(all)"
    out["visits"] = pd.to_numeric(df[cols["visits"]], errors="coerce")
    out["source_file"] = source
    out["ingested_at"] = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M")

    before = len(out)
    out = out.dropna(subset=["date", "visits"])
    dropped = before - len(out)
    return out, dropped


def load_existing():
    import pandas as pd
    if not os.path.exists(BOOK):
        return pd.DataFrame(columns=["date", "location", "age_band", "payer",
                                     "visits", "source_file", "ingested_at"])
    try:
        return pd.read_excel(BOOK, sheet_name="visits")
    except Exception:  # noqa: BLE001
        return pd.read_excel(BOOK)


def write_book(df):
    import pandas as pd
    # Concatenating with an empty starter frame leaves `visits` as object dtype,
    # which silently breaks every downstream sum and rounding.
    df = df.copy()
    df["visits"] = pd.to_numeric(df["visits"], errors="coerce")
    df = df.dropna(subset=["date", "visits"])
    key = ["date", "location", "age_band", "payer"]
    # Last write wins on a repeated key: a re-export of the same period is a
    # correction, not a duplicate to be summed.
    df = df.sort_values("ingested_at").drop_duplicates(subset=key, keep="last")
    df = df.sort_values(["date", "location", "age_band"])

    monthly = (df.assign(month=df["date"].str.slice(0, 7))
                 .groupby(["month", "location"], as_index=False)["visits"].sum()
                 .pivot(index="month", columns="location", values="visits").fillna(0))

    # The payoff: the real age distribution, which replaces the estimated
    # VISIT_MIX weights the dashboard currently assumes.
    mix = None
    if (df["age_band"] != "(all)").any():
        m = df[df["age_band"] != "(all)"].groupby("age_band", as_index=False)["visits"].sum()
        total = m["visits"].sum()
        if total > 0:
            m["share"] = (m["visits"] / total).round(4)
            mix = m.sort_values("visits", ascending=False)

    with pd.ExcelWriter(BOOK, engine="openpyxl") as xl:
        df.to_excel(xl, sheet_name="visits", index=False)
        monthly.to_excel(xl, sheet_name="monthly_by_location")
        if mix is not None:
            mix.to_excel(xl, sheet_name="age_mix", index=False)
        pd.DataFrame({"note": [
            "CONFIDENTIAL — PM Pediatrics board-portal data.",
            "This workbook lives in private/ and is gitignored. Do not commit it,",
            "do not paste its contents into the public repo, and do not put real",
            "visit-mix weights into js/config.js — that file is published.",
            "",
            "To use the real age mix in the dashboard: open the Staffing tab and",
            "set the sliders. They persist in your browser only.",
            "",
            f"Rows: {len(df)}   Last ingested: {datetime.now(timezone.utc):%Y-%m-%d %H:%M}Z",
        ]}).to_excel(xl, sheet_name="READ ME", index=False)
    return df, mix


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--init", action="store_true", help="create folders and a map template")
    ap.add_argument("--dry-run", action="store_true", help="show mapping, write nothing")
    ap.add_argument("--source", metavar="PATH",
                    help="read this workbook in place instead of the inbox, and do "
                         "not move it. Use with a Power BI 'Analyze in Excel' "
                         "workbook so a refresh-then-run needs no manual export.")
    args = ap.parse_args()

    for d in (PRIV, INBOX, ARCHIVE):
        os.makedirs(d, exist_ok=True)

    if args.init:
        if not os.path.exists(MAP):
            with open(MAP, "w", encoding="utf-8") as f:
                json.dump({"_comment": "Override auto-detection. Set a canonical "
                                       "field to the EXACT column name in your export.",
                           "date": "", "location": "", "visits": "",
                           "age_band": "", "payer": ""}, f, indent=2)
        print(f"ready.\n  drop exports in : {os.path.relpath(INBOX, ROOT)}\n"
              f"  workbook        : {os.path.relpath(BOOK, ROOT)}\n"
              f"  column overrides: {os.path.relpath(MAP, ROOT)}")
        return 0

    override = {}
    if os.path.exists(MAP):
        with open(MAP, encoding="utf-8") as f:
            override = {k: v for k, v in json.load(f).items() if v and not k.startswith("_")}

    # --source reads a workbook where it lives and leaves it there, so a live
    # "Analyze in Excel" file can be re-read after every refresh.
    in_place = bool(args.source)
    if in_place:
        if not os.path.exists(args.source):
            print(f"source not found: {args.source}")
            return 1
        base, files = os.path.dirname(os.path.abspath(args.source)), [os.path.basename(args.source)]
    else:
        base = INBOX
        files = [f for f in sorted(os.listdir(INBOX))
                 if os.path.splitext(f)[1].lower() in (".csv", ".tsv", ".txt", ".xlsx", ".xlsm", ".xls")]
        if not files:
            print(f"nothing to ingest in {os.path.relpath(INBOX, ROOT)}/")
            print("export from the board portal, drop the file there, and re-run.")
            return 0

    import pandas as pd
    frames = [load_existing()]
    ok, failed = 0, 0

    for fn in files:
        path = os.path.join(base, fn)
        print(f"\n- {fn}")
        try:
            df, sheet = read_any(path)
            cols = detect(df.columns, override)
            print(f"    sheet '{sheet}', {len(df)} rows, {len(df.columns)} columns")
            for field in ("date", "location", "visits", "age_band", "payer"):
                print(f"      {field:<9} -> {cols.get(field, '(not found)')}")
            long, dropped = to_long(df, cols, fn)
            if dropped:
                print(f"    dropped {dropped} rows with unparseable date or visits")
            print(f"    {len(long)} rows ready, {long['date'].min()} .. {long['date'].max()}")
            if not args.dry_run:
                frames.append(long)
                if not in_place:
                    shutil.move(path, os.path.join(ARCHIVE, fn))
            ok += 1
        except Exception as e:  # noqa: BLE001
            print(f"    !! {e}")
            print("    fix the mapping in private/column_map.json and re-run")
            failed += 1

    if args.dry_run:
        print("\ndry run — nothing written, nothing moved")
        return 0
    if ok == 0:
        return 1

    combined = pd.concat(frames, ignore_index=True)
    final, mix = write_book(combined)
    print(f"\nwrote {os.path.relpath(BOOK, ROOT)}  ({len(final)} rows, "
          f"{final['date'].min()} .. {final['date'].max()})")
    if mix is not None:
        print("\n  REAL AGE MIX — set these on the dashboard's Staffing tab:")
        for _, r in mix.iterrows():
            print(f"    {str(r['age_band']):<16} {r['share']:.3f}")
        print("  (do NOT put them in js/config.js — that file is published)")
    if failed:
        print(f"\n{failed} file(s) failed; they were left in inbox/")
    return 0


if __name__ == "__main__":
    sys.exit(main())
