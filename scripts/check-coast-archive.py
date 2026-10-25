# ==== Coast map: check the NRW historic LIDAR archive (check only) ====
#
# Run by .github/workflows/coast-archive-check.yml, by hand. Changes
# nothing on the map. It answers one question: could older LIDAR
# surveys fill in the foreshore that the 2020-23 survey couldn't see
# (the hatched grey "not surveyed" cells on the coast map)?
#
#   1. Asks the NRW LiDAR tile catalogue archive (DataMapWales) for every
#      historic terrain-model (DTM) tile over St Brides Bay, with the date
#      flown and resolution.
#   2. Downloads each DTM tile and counts how many of the coast map's
#      "not surveyed" cells it has a height for, and how low those heights
#      go (foreshore that only dries near low water is the useful part).
#   3. Writes data/coast/stbrides/archive-check.md (a readable report) and
#      archive-tiles.json (the tile list), to show before deciding whether
#      to build a step that actually fills the gaps.
#
# Uses the height tiles from step 2 (build-coast-heights.py) to know
# where the "not surveyed" cells are, so run that first.
#
# DataMapWales is a GeoNode/GeoServer site; the catalogue is a WFS layer.
# The exact address isn't documented for scripts, so several standard
# GeoServer forms are tried and every attempt is logged. If none answers,
# the report says so and shows what came back.
#
# Licence: Contains Natural Resources Wales information © Natural
# Resources Wales and Database Right (Open Government Licence).

import io
import json
import math
import os
import sys
import tempfile
import time
import urllib.parse
import urllib.request
import zipfile
from datetime import datetime, timezone

import numpy as np
import rasterio
from rasterio.warp import transform as warp_transform
from PIL import Image

AREA_DIR = os.path.join("data", "coast", "stbrides")
HEIGHTS_DIR = os.path.join(AREA_DIR, "heights")
LAYER = "geonode:nrw_lidar_tile_catalogue_archive"
SAMPLE_STEP = 2            # every 2nd flagged cell each way (~4 m) — plenty for a check
MAX_DOWNLOAD_BYTES = 4e9   # stop downloading after ~4 GB in total
USER_AGENT = "Cloude coast map (GitHub Actions; one-off data check)"

WFS_BASES = [
    "https://datamap.gov.wales/geoserver/ows",
    "https://datamap.gov.wales/geoserver/wfs",
    "https://datamap.gov.wales/geoserver/geonode/ows",
]

log_lines = []


def log(msg):
    print(msg, flush=True)
    log_lines.append(msg)


def http_get(url, timeout=120, binary=False):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        data = r.read()
        return data if binary else data.decode("utf-8", errors="replace")


def area_bng_box(index):
    """The height-tile grid's extent, in British National Grid metres."""
    g = index["grid"]
    tiles = index["tiles"]
    south = min(t["south"] for t in tiles)
    north = max(t["north"] for t in tiles)
    west = min(t["west"] for t in tiles)
    east = max(t["east"] for t in tiles)
    xs, ys = warp_transform("EPSG:4326", "EPSG:27700", [west, east, west, east], [south, south, north, north])
    return min(xs), min(ys), max(xs), max(ys)


def fetch_catalogue(box):
    """Returns a list of feature property dicts, or raises with a log."""
    override = os.environ.get("COAST_ARCHIVE_CATALOGUE")
    if override:  # a local GeoJSON file, for testing
        with open(override) as f:
            return [ft["properties"] for ft in json.load(f)["features"]]
    x0, y0, x1, y1 = box
    attempts = []
    for base in WFS_BASES:
        for version, tn in (("2.0.0", "typeNames"), ("1.1.0", "typeName"), ("1.0.0", "typeName")):
            if version == "1.0.0":
                bbox = f"{x0:.0f},{y0:.0f},{x1:.0f},{y1:.0f}"
            else:
                bbox = f"{x0:.0f},{y0:.0f},{x1:.0f},{y1:.0f},EPSG:27700"
            params = {
                "service": "WFS", "version": version, "request": "GetFeature",
                tn: LAYER, "outputFormat": "application/json",
                "srsName": "EPSG:27700", "bbox": bbox,
            }
            url = base + "?" + urllib.parse.urlencode(params)
            try:
                text = http_get(url, timeout=90)
                data = json.loads(text)
                feats = data.get("features")
                if isinstance(feats, list):
                    log(f"Catalogue answered at {base} (WFS {version}): {len(feats)} tiles")
                    return [ft.get("properties", {}) for ft in feats]
                attempts.append(f"{base} WFS {version}: JSON without features: {text[:200]!r}")
            except Exception as err:  # noqa: BLE001 — every failure is reported
                attempts.append(f"{base} WFS {version}: {type(err).__name__}: {str(err)[:200]}")
    for a in attempts:
        log("  tried " + a)
    raise RuntimeError("The NRW archive catalogue didn't answer at any of the usual addresses.")


def flagged_cells(index):
    """Lat/lon of the coast map's 'not surveyed' cells (blue channel 1),
    sampled every SAMPLE_STEP cells."""
    g = index["grid"]
    T = g["tileSize"]
    lats, lons = [], []
    for t in index["tiles"]:
        a = np.asarray(Image.open(os.path.join(HEIGHTS_DIR, t["file"])).convert("RGB"))
        ys, xs = np.nonzero(a[::SAMPLE_STEP, ::SAMPLE_STEP, 2] == 1)
        ys = ys * SAMPLE_STEP
        xs = xs * SAMPLE_STEP
        lats.append(g["north"] - (t["r"] * T + ys + 0.5) * g["dLat"])
        lons.append(g["west"] + (t["c"] * T + xs + 0.5) * g["dLon"])
    if not lats:
        return np.array([]), np.array([])
    return np.concatenate(lats), np.concatenate(lons)


def open_dtm(url, workdir):
    """Downloads a DTM tile (a raster, or a zip holding one) and returns
    an open rasterio dataset, or None."""
    data = http_get(url, timeout=600, binary=True)
    size = len(data)
    name = os.path.basename(urllib.parse.urlparse(url).path) or "tile"
    if data[:2] == b"PK":
        z = zipfile.ZipFile(io.BytesIO(data))
        rasters = [n for n in z.namelist() if n.lower().endswith((".tif", ".tiff", ".asc", ".img"))]
        if not rasters:
            raise RuntimeError(f"zip has no raster ({z.namelist()[:5]})")
        z.extractall(workdir)
        path = os.path.join(workdir, rasters[0])
    else:
        path = os.path.join(workdir, name)
        with open(path, "wb") as f:
            f.write(data)
    return rasterio.open(path), size


def sample(ds, xs, ys):
    """Heights at BNG points from an open raster; NaN where outside or no data."""
    out = np.full(xs.shape, np.nan, dtype="float32")
    b = ds.bounds
    inside = (xs >= b.left) & (xs < b.right) & (ys > b.bottom) & (ys <= b.top)
    if not inside.any():
        return out
    arr = ds.read(1).astype("float32")
    if ds.nodata is not None:
        arr[arr == ds.nodata] = np.nan
    arr[(arr < -50) | (arr > 1500)] = np.nan
    rows, cols = rasterio.transform.rowcol(ds.transform, xs[inside], ys[inside])
    rows = np.clip(np.asarray(rows), 0, ds.height - 1)
    cols = np.clip(np.asarray(cols), 0, ds.width - 1)
    out[inside] = arr[rows, cols]
    return out


def pick(props, *names):
    for n in names:
        for k, v in props.items():
            if k.lower() == n and v not in (None, ""):
                return v
    return None


def main():
    started = time.time()
    with open(os.path.join(HEIGHTS_DIR, "index.json")) as f:
        index = json.load(f)
    box = area_bng_box(index)
    log(f"Area (British National Grid): {box[0]:.0f},{box[1]:.0f} to {box[2]:.0f},{box[3]:.0f}")

    lats, lons = flagged_cells(index)
    n_flagged = lats.size
    cell_m2 = (SAMPLE_STEP * 2.0) ** 2
    log(f"'Not surveyed' cells sampled: {n_flagged} (about {n_flagged * cell_m2 / 1e6:.2f} km²)")
    report = []
    report.append("# St Brides Bay — NRW historic LIDAR archive check\n")
    report.append(f"Run {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}. Check only — nothing on the map was changed.\n")
    report.append(f"The coast map has about **{n_flagged * cell_m2 / 1e6:.2f} km²** of hatched \"not surveyed\" foreshore "
                  f"(sampled every {SAMPLE_STEP * 2} m).\n")

    try:
        tiles = fetch_catalogue(box)
    except Exception as err:  # noqa: BLE001
        report.append(f"\n**The archive catalogue couldn't be reached:** {err}\n")
        report.append("\n## Log\n\n```\n" + "\n".join(log_lines) + "\n```\n")
        write_report(report, [])
        sys.exit(0)  # a report is still useful; don't fail the run

    if n_flagged == 0:
        report.append("\nNo 'not surveyed' cells found — nothing to fill.\n")
        write_report(report, tiles)
        return

    xs, ys = warp_transform("EPSG:4326", "EPSG:27700", lons.tolist(), lats.tolist())
    xs = np.asarray(xs); ys = np.asarray(ys)
    covered = np.zeros(n_flagged, dtype=bool)
    lowest = np.full(n_flagged, np.nan, dtype="float32")
    rows = []
    downloaded = 0
    tiles_sorted = sorted(tiles, key=lambda p: str(pick(p, "date_flown", "year") or ""))
    for props in tiles_sorted:
        name = pick(props, "lidar_name", "name") or "?"
        date = pick(props, "date_flown", "year") or "?"
        res = pick(props, "resolution") or "?"
        url = pick(props, "dtm_url")
        row = {"name": name, "date": str(date), "resolution": str(res), "dtm_url": url}
        if not url:
            row["result"] = "no DTM (surface model only)"
            rows.append(row); log(f"{name} {date}: no DTM link"); continue
        if downloaded > MAX_DOWNLOAD_BYTES:
            row["result"] = "skipped (download limit reached)"
            rows.append(row); continue
        try:
            with tempfile.TemporaryDirectory() as tmp:
                ds, size = open_dtm(url, tmp)
                downloaded += size
                with ds:
                    if ds.crs is None:
                        log(f"  {name}: no CRS in file, assuming British National Grid")
                    h = sample(ds, xs, ys)
            got = ~np.isnan(h)
            new = got & ~covered
            covered |= got
            lowest = np.where(got & (np.isnan(lowest) | (h < lowest)), h, lowest)
            row.update({
                "result": "ok", "mb": round(size / 1e6, 1),
                "cellsWithHeight": int(got.sum()), "newCells": int(new.sum()),
                "below0OD": int((got & (h <= 0)).sum()),
                "minHeight": None if not got.any() else round(float(np.nanmin(h[got])), 2),
            })
            log(f"{name} {date} ({res}): {int(got.sum())} cells with height, {int(new.sum())} new, {size / 1e6:.1f} MB")
        except Exception as err:  # noqa: BLE001
            row["result"] = f"failed: {type(err).__name__}: {str(err)[:150]}"
            log(f"{name} {date}: FAILED {err}")
        rows.append(row)

    n_cov = int(covered.sum())
    pct = 100.0 * n_cov / n_flagged
    low = lowest[covered]
    report.append(f"\nThe catalogue lists **{len(tiles)}** historic tiles over the bay; "
                  f"{sum(1 for r in rows if r.get('result') == 'ok')} were downloaded and read "
                  f"({downloaded / 1e6:.0f} MB).\n")
    report.append(f"\n**Result: older surveys have heights for {pct:.0f}% of the 'not surveyed' foreshore** "
                  f"(about {n_cov * cell_m2 / 1e6:.2f} km² of {n_flagged * cell_m2 / 1e6:.2f} km²).\n")
    if low.size:
        bands = [(-99, -3), (-3, -2), (-2, -1), (-1, 0), (0, 99)]
        report.append("\nHow low the filled heights go (m above Ordnance Datum; Milford Haven chart datum is −3.71 m OD, "
                      "so −3 m OD is about 0.7 m above chart datum):\n")
        for lo, hi in bands:
            n = int(((low > lo) & (low <= hi)).sum())
            label = f"below {hi} m" if lo == -99 else (f"above {lo} m" if hi == 99 else f"{lo} to {hi} m")
            report.append(f"- {label}: {100.0 * n / max(low.size, 1):.0f}%")
        report.append("")
    report.append("\n## Tiles\n")
    report.append("| Tile | Date flown | Resolution | Result | Cells with height | New | Lowest (m OD) |")
    report.append("|---|---|---|---|---|---|---|")
    for r in rows:
        report.append(f"| {r['name']} | {r['date']} | {r['resolution']} | {r.get('result', '')} | "
                      f"{r.get('cellsWithHeight', '')} | {r.get('newCells', '')} | {r.get('minHeight', '')} |")
    report.append(f"\nTook {(time.time() - started) / 60:.1f} minutes.\n")
    report.append("\nContains Natural Resources Wales information © Natural Resources Wales and Database Right (Open Government Licence).\n")
    report.append("\n## Log\n\n```\n" + "\n".join(log_lines[-200:]) + "\n```\n")
    write_report(report, rows)


def write_report(lines, tiles):
    with open(os.path.join(AREA_DIR, "archive-check.md"), "w") as f:
        f.write("\n".join(lines) + "\n")
    with open(os.path.join(AREA_DIR, "archive-tiles.json"), "w") as f:
        json.dump({"checkedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"), "tiles": tiles}, f)
        f.write("\n")
    log("Wrote archive-check.md and archive-tiles.json")


if __name__ == "__main__":
    main()
