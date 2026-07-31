#!/usr/bin/env python3
"""
Append the current ARI activity snapshot to a growing history file.

CDC dataset f3zz-zga5 holds only the current week (56 jurisdiction rows) and is
overwritten in place -- there is no archive. Appending each daily pull is the
only way this dashboard will ever have a back-series for it. Six months of cron
runs buys a real seasonal curve; nothing else will.
"""

import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "..", "data")
HIST = os.path.join(DATA, "history")


def main():
    src = os.path.join(DATA, "ari_level.json")
    if not os.path.exists(src):
        print("no ari_level.json to archive")
        return 0

    with open(src, encoding="utf-8") as f:
        current = json.load(f).get("data", [])

    os.makedirs(HIST, exist_ok=True)
    path = os.path.join(HIST, "ari_level_history.json")

    history = []
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            history = json.load(f)

    seen = {r.get("week") for r in history}
    added = 0
    for row in current:
        if row.get("week") and row["week"] not in seen:
            history.append(row)
            seen.add(row["week"])
            added += 1

    history.sort(key=lambda r: r.get("week") or "")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(history, f, separators=(",", ":"))

    print(f"ari history: +{added} week(s), {len(history)} total")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
