#!/usr/bin/env python3
"""Long tide-gauge records for Cloude's tide predictions.

The Environment Agency's live API only keeps about four weeks of each
tide gauge's readings, and a tide fitted to four weeks drifts at neaps
(up to ~35 minutes and 0.3 m at Milford Haven against the official
table, Nov 2026). The EA also publishes one archive file per day with
every reading from every station (about 60 MB, kept for about a year):
https://environment.data.gov.uk/flood-monitoring/archive/readings-YYYY-MM-DD.csv

This script reads those daily files and keeps, for every tide gauge in
tide.js's EA_TIDE_STATIONS list, its hourly readings for the last
KEEP_DAYS days in data/tide-gauges/<station id>.json. The app fits its
tide to that year plus the live last four weeks (tide.js).

Run by .github/workflows/collect-tide-gauges.yml once a day. A day it
has already read is not downloaded again (data/tide-gauges/days.json),
so the first run does the whole year (about half an hour) and later
runs only the new day. If a run is stopped part way, what it read is
still saved and the next run carries on.

Public data only: gauge levels, no locations or personal details.
Python standard library only.
"""
import csv, io, json, os, re, sys, time, urllib.error, urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "tide-gauges"
ARCHIVE = "https://environment.data.gov.uk/flood-monitoring/archive/readings-{}.csv"
KEEP_DAYS = int(os.environ.get("TIDE_KEEP_DAYS", "370"))
MAX_MINUTES = float(os.environ.get("TIDE_MAX_MINUTES", "300"))
WORKERS = int(os.environ.get("TIDE_WORKERS", "4"))
GIVE_UP_AFTER_DAYS = 10  # a day still missing from the archive this long after is marked missing, not retried


def stations():
    """Station ids and measure ids, read from tide.js so the list lives in one place."""
    src = (ROOT / "tide.js").read_text()
    found = re.findall(r'\{ id: "([^"]+)", measureId: "([^"]+)", label: "([^"]+)"', src)
    if not found:
        sys.exit("No tide stations found in tide.js")
    return [{"id": i, "measure": m, "label": l} for i, m, l in found]


def load_json(path, default):
    try:
        return json.loads(path.read_text())
    except Exception:
        return default


def read_day(day, wanted):
    """Hourly readings (metres) for the wanted measures from one day's archive.
    Returns { measure: { hour index 0-23: value } }, or None if the file isn't there."""
    url = ARCHIVE.format(day.isoformat())
    for attempt in range(3):
        try:
            with urllib.request.urlopen(url, timeout=120) as res:
                text = io.TextIOWrapper(res, encoding="utf-8", newline="")
                out = {}
                for row in csv.reader(text):
                    if len(row) < 3 or "tidal_level" not in row[1]:
                        continue
                    measure = row[1].rsplit("/", 1)[-1]
                    if measure not in wanted:
                        continue
                    t = row[0]  # 2026-05-01T00:45:00Z
                    if len(t) < 16 or t[14:16] != "00":
                        continue  # hourly is plenty for fitting the tide
                    try:
                        value = float(row[2].split("|")[0])
                    except ValueError:
                        continue
                    if not -12 < value < 12:
                        continue  # obviously broken reading
                    out.setdefault(measure, {})[int(t[11:13])] = value
                return out
        except urllib.error.HTTPError as err:
            if err.code == 404:
                return None
            time.sleep(5 * (attempt + 1))
        except Exception:
            time.sleep(5 * (attempt + 1))
    raise RuntimeError(f"could not read {url}")


def main():
    started = time.time()
    OUT.mkdir(parents=True, exist_ok=True)
    gauges = stations()
    by_measure = {g["measure"]: g for g in gauges}
    days_file = OUT / "days.json"
    days = load_json(days_file, {"read": [], "missing": []})
    read, missing = set(days.get("read", [])), set(days.get("missing", []))

    today = datetime.now(timezone.utc).date()
    first = today - timedelta(days=KEEP_DAYS)
    wanted_days = [first + timedelta(days=n) for n in range(KEEP_DAYS)]
    todo = [d for d in reversed(wanted_days) if d.isoformat() not in read and d.isoformat() not in missing]
    print(f"{len(gauges)} gauges; {len(todo)} day(s) to read")

    # Hourly values per station: { station id: { "YYYY-MM-DDTHH": cm } }
    values = {}
    for g in gauges:
        rec = load_json(OUT / f"{g['id']}.json", None)
        v = {}
        if rec and rec.get("start") and isinstance(rec.get("cm"), list):
            t0 = datetime.fromisoformat(rec["start"].replace("Z", "+00:00"))
            for i, cm in enumerate(rec["cm"]):
                if cm is not None:
                    v[(t0 + timedelta(hours=i)).strftime("%Y-%m-%dT%H")] = cm
        values[g["id"]] = v

    done_now = 0
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        futures = {}
        queue = list(todo)
        def submit():
            while queue and len(futures) < WORKERS * 2:
                if (time.time() - started) / 60 > MAX_MINUTES:
                    queue.clear()
                    print("Out of time for this run; the rest next time.")
                    return
                d = queue.pop(0)
                futures[pool.submit(read_day, d, by_measure)] = d
        submit()
        while futures:
            for fut in as_completed(list(futures)):
                d = futures.pop(fut)
                key = d.isoformat()
                try:
                    got = fut.result()
                except Exception as err:
                    print(f"{key}: {err}")
                    got = False
                if got is None:
                    if (today - d).days > GIVE_UP_AFTER_DAYS:
                        missing.add(key)
                    print(f"{key}: not in the archive")
                elif got is not False:
                    for measure, hours in got.items():
                        sid = by_measure[measure]["id"]
                        for h, value in hours.items():
                            values[sid][f"{key}T{h:02d}"] = round(value * 100)
                    read.add(key)
                    done_now += 1
                break
            submit()

    # Write each station's record: a start time and one value per hour (null = no reading).
    start = datetime(first.year, first.month, first.day, tzinfo=timezone.utc)
    hours = KEEP_DAYS * 24
    for g in gauges:
        v = values[g["id"]]
        cm = [v.get((start + timedelta(hours=i)).strftime("%Y-%m-%dT%H")) for i in range(hours)]
        while cm and cm[-1] is None:
            cm.pop()
        lead = 0
        while lead < len(cm) and cm[lead] is None:
            lead += 1
        cm = cm[lead:]
        path = OUT / f"{g['id']}.json"
        if not cm:
            if path.exists():
                path.unlink()
            continue
        rec = {
            "id": g["id"], "label": g["label"], "measure": g["measure"],
            "units": "cm above Ordnance Datum, hourly", "source": "Environment Agency flood-monitoring archive (Open Government Licence)",
            "start": (start + timedelta(hours=lead)).strftime("%Y-%m-%dT%H:%M:%SZ"), "stepMinutes": 60, "cm": cm,
        }
        path.write_text(json.dumps(rec, separators=(",", ":")))

    keep_from = first.isoformat()
    days = {"read": sorted(k for k in read if k >= keep_from), "missing": sorted(k for k in missing if k >= keep_from),
            "updatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}
    days_file.write_text(json.dumps(days, indent=0))
    print(f"Read {done_now} day(s) this run; {len(days['read'])} held, {len(days['missing'])} missing from the archive")


if __name__ == "__main__":
    main()
