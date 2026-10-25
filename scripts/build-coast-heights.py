# ==== Coast map, step 2: ground heights and steepness ====
#
# Run by .github/workflows/coast-heights.yml (by hand, from the Actions
# tab). Reads the Welsh Government 1 m LIDAR terrain model (the DTM, with
# buildings and plants removed) straight from its online copy, only the
# parts that are needed, and turns the coastal strip of St Brides Bay
# (Newgale to Dale, with Skomer and Skokholm) into small picture tiles
# the phone can read:
#
#   data/coast/stbrides/heights/index.json   which tiles exist, where
#                                            they are, how to read them
#   data/coast/stbrides/heights/r<row>c<col>.png
#                                            one tile, about 1 km square,
#                                            2 m per pixel
#   data/coast/stbrides/heights/preview.png  a small picture of the whole
#                                            area, to check by eye that
#                                            the run worked
#
# How a tile is read (also written into index.json):
#   red   = ground height. 0 = no data (sea, or no laser return);
#           1-254 = -6.0 m to +19.3 m above Ordnance Datum in 0.1 m steps
#           (height = (red - 1) / 10 - 6); 255 = higher than 19.3 m, or
#           land more than about 250 m from the sea, which is kept only
#           as "land" so islands and headlands still look solid.
#           That range covers the whole tidal range at Milford Haven
#           with room to spare, at 10 cm detail.
#   green = steepness of the ground in degrees (0-90), but only where the
#           height changes by at least RELIEF_MIN_M within about 14 m —
#           so field banks and hedges (short but steep) read as flat,
#           while cliffs, dune faces and rock steps keep their steepness.
#   blue  = 2 where there's no survey data but Ordnance Survey maps the
#           ground as Foreshore (between the mean low and mean high water
#           marks, OS OpenMap Local): it dries at low tide, height
#           unknown. The map hatches these.
#           1 (only if the OS download failed, as before): no survey data
#           but surveyed foreshore below +1 m OD within about 40 m.
#           0 everywhere else — including no-data cells outside the OS
#           foreshore, which are sea (below mean low water).
#
# Also saves the Ordnance Survey mean low water line (OS OpenMap Local,
# Tidal Boundary, "Low Water Mark") over the area, for the map to draw:
#
#   data/coast/stbrides/low-water.json       lines of [lat, lon]
#
# Tiles are on a plain latitude/longitude grid, the same simple
# projection the app's own map already draws with.
#
# Also checks the possible ways off the beach found in step 1
# (access.json): each gets the ground height at its beach end, and is
# marked as at beach level or not, so a cliff-top path that merely
# passes close to a beach in plan isn't shown as a way off.
#
# Source and licence: Welsh Government LiDAR 2020-2023, 1 m DTM,
# published on DataMapWales under the Open Government Licence v3.0.
#
# The sea itself usually gives no laser return, so it shows as "no
# data". Foreshore that was underwater when the survey plane flew over
# is missing too; the map will show it as unknown rather than guess.

import json
import math
import os
import sys
from datetime import datetime, timezone

import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.transform import from_origin
from rasterio.vrt import WarpedVRT
from rasterio.windows import Window
from PIL import Image
import urllib.request
import tempfile
from rasterio.features import rasterize
from rasterio.warp import transform_geom

SOURCE_URL = os.environ.get(
    "COAST_DTM_URL",
    "https://dmwproductionblob.blob.core.windows.net/cogs/lidar/wales_dtm_32bit_cog.tif",
)

AREA_ID = "stbrides"
# Same outline as scripts/collect-coast-names.mjs: Newgale round the bay,
# Skomer and Skokholm, the Marloes peninsula, down to Dale.
NORTH, SOUTH, WEST, EAST = 51.875, 51.690, -5.360, -5.050
COAST_OUTLINE = [
    (51.875, -5.140), (51.875, -5.050), (51.735, -5.050), (51.735, -5.150),
    (51.690, -5.150), (51.690, -5.360), (51.835, -5.360), (51.835, -5.140),
]

# About 2 m per cell at this latitude, in both directions.
D_LAT = 0.000018
D_LON = 0.000029
TILE = 512            # cells per tile side: about 1 km
COARSE = 32           # first pass at 32 x coarser, to find which tiles are coastal
NEAR_SEA_COARSE = 4   # detail kept within 4 coarse cells (about 250 m) of the sea

HEIGHT_MIN, HEIGHT_MAX = -6.0, 19.3
ACCESS_BEACH_LEVEL_M = 12.0  # a way off's beach end must be this low or lower
RELIEF_MIN_M = 4.0          # steepness only counts where height changes this much nearby
RELIEF_HALF = 3             # ... within 3 cells each way (a 7 x 7 cell, ~14 m window)
UNSURVEYED_LOW_M = 1.0      # surveyed ground this low counts as foreshore
UNSURVEYED_REACH = 20       # unsurveyed cells within 20 cells (~40 m) of it are flagged

OUT_DIR = os.path.join("data", "coast", AREA_ID)
HEIGHTS_DIR = os.path.join(OUT_DIR, "heights")


def inside_outline(lat, lon):
    inside = False
    n = len(COAST_OUTLINE)
    j = n - 1
    for i in range(n):
        yi, xi = COAST_OUTLINE[i]
        yj, xj = COAST_OUTLINE[j]
        if (yi > lat) != (yj > lat) and lon < (xj - xi) * (lat - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def tile_touches_outline(south, west, north, east):
    pts = [(south, west), (south, east), (north, west), (north, east),
           ((south + north) / 2, (west + east) / 2)]
    return any(inside_outline(la, lo) for la, lo in pts)


def clean(arr, nodata):
    """Float array with no-data as NaN."""
    a = arr.astype("float32")
    if nodata is not None and not (isinstance(nodata, float) and math.isnan(nodata)):
        a[a == nodata] = np.nan
    # Belt and braces: anything absurd is treated as no data.
    a[(a < -50) | (a > 1500)] = np.nan
    return a


def dilate(mask, radius):
    """Grow a True/False grid outwards by `radius` cells (round brush)."""
    out = mask.copy()
    h, w = mask.shape
    for dy in range(-radius, radius + 1):
        for dx in range(-radius, radius + 1):
            if dy * dy + dx * dx > radius * radius or (dy == 0 and dx == 0):
                continue
            ys, yd = (slice(0, h - dy), slice(dy, h)) if dy >= 0 else (slice(-dy, h), slice(0, h + dy))
            xs, xd = (slice(0, w - dx), slice(dx, w)) if dx >= 0 else (slice(-dx, w), slice(0, w + dx))
            out[yd, xd] |= mask[ys, xs]
    return out


def grow(mask, steps):
    """Grow a True/False grid by `steps` cells using repeated 3 x 3 steps."""
    out = mask.copy()
    for _ in range(steps):
        g = out.copy()
        g[1:, :] |= out[:-1, :]; g[:-1, :] |= out[1:, :]
        g[:, 1:] |= out[:, :-1]; g[:, :-1] |= out[:, 1:]
        g[1:, 1:] |= out[:-1, :-1]; g[:-1, :-1] |= out[1:, 1:]
        g[1:, :-1] |= out[:-1, 1:]; g[:-1, 1:] |= out[1:, :-1]
        out = g
    return out


def local_relief(h, half):
    """Height range (max - min) in a (2*half+1)-cell square round each cell,
    ignoring no-data."""
    hi = np.where(np.isnan(h), -np.inf, h)
    lo = np.where(np.isnan(h), np.inf, h)
    mx, mn = hi.copy(), lo.copy()
    rows, cols = h.shape
    for dy in range(-half, half + 1):
        for dx in range(-half, half + 1):
            if dy == 0 and dx == 0:
                continue
            ys = slice(max(0, dy), rows + min(0, dy)); yd = slice(max(0, -dy), rows + min(0, -dy))
            xs = slice(max(0, dx), cols + min(0, dx)); xd = slice(max(0, -dx), cols + min(0, -dx))
            np.maximum(mx[yd, xd], hi[ys, xs], out=mx[yd, xd])
            np.minimum(mn[yd, xd], lo[ys, xs], out=mn[yd, xd])
    r = mx - mn
    r[~np.isfinite(r)] = 0
    return r


# ---- Ordnance Survey foreshore (OS OpenMap Local, Open Government Licence) ----
OS_DOWNLOADS = os.environ.get("COAST_OS_DOWNLOADS", "https://api.os.uk/downloads/v1/products/OpenMapLocal/downloads")
OS_AREA = "SM"  # the 100 km grid square covering west Pembrokeshire


def _find_layer(layers, want):
    """The layer whose name, ignoring case, spaces and underscores,
    contains `want` (e.g. "foreshore", "tidalboundary")."""
    norm = lambda t: t.lower().replace("_", "").replace(" ", "")
    return (next((l for l in layers if norm(l) == want), None) or
            next((l for l in layers if want in norm(l)), None))


def _os_sources(tmpdir):
    """Where to read the OS layers from: {"foreshore": (path, layer),
    "tidalboundary": (path, layer)}, either from one GeoPackage or from
    the SM tile's shapefiles. Missing layers are left out."""
    path = os.environ.get("COAST_FORESHORE_GPKG")
    zpath = os.environ.get("COAST_OS_ZIP")  # local copy of the OS zip, for testing
    if not path and not zpath:
        req = urllib.request.Request(OS_DOWNLOADS, headers={"User-Agent": "Cloude coast map"})
        items = json.loads(urllib.request.urlopen(req, timeout=60).read().decode())
        fmt = lambda i: str(i.get("format", "")).lower()
        area = lambda i: str(i.get("area", "")).upper()
        # OS supplies OpenMap Local per 100 km tile only as shapefiles
        # (GeoPackage is the whole of Great Britain, 2.4 GB), so the SM
        # tile's shapefiles come first; the national GeoPackage is the
        # fallback.
        pick = ([i for i in items if area(i) == OS_AREA and "shapefile" in fmt(i)] or
                [i for i in items if area(i) == OS_AREA and "geopackage" in fmt(i)] or
                [i for i in items if area(i) == "GB" and "geopackage" in fmt(i)])
        if not pick:
            offered = sorted({f"{area(i)}:{i.get('format')}" for i in items if area(i) in (OS_AREA, "GB")})
            print(f"OS OpenMap Local: nothing usable for {OS_AREA}; offered: {offered}")
            return {}
        print(f"OS OpenMap Local: using {area(pick[0])} {pick[0].get('format')}")
        zpath = os.path.join(tmpdir, "oml.zip")
        print(f"OS OpenMap Local {OS_AREA}: downloading {pick[0].get('size', '?')} bytes…")
        req = urllib.request.Request(pick[0]["url"], headers={"User-Agent": "Cloude coast map"})
        with urllib.request.urlopen(req, timeout=600) as r, open(zpath, "wb") as f:
            while True:
                chunk = r.read(8 * 1024 * 1024)
                if not chunk:
                    break
                f.write(chunk)
    if path:
        layers = [l[0] for l in pyogrio_list(path)]
        out = {}
        for want in ("foreshore", "tidalboundary"):
            l = _find_layer(layers, want)
            if l:
                out[want] = (path, l)
        if not out:
            print(f"No Foreshore or TidalBoundary layer in the OS data (layers: {layers})")
        return out
    import zipfile
    if not zipfile.is_zipfile(zpath):
        print("OS OpenMap Local download isn't a zip — skipped")
        return {}
    out = {}
    with zipfile.ZipFile(zpath) as z:
        names = z.namelist()
        gpkg = [n for n in names if n.lower().endswith(".gpkg")]
        shps = [n for n in names if n.lower().endswith(".shp")]
        for want in ("foreshore", "tidalboundary"):
            hit = [n for n in shps if want in os.path.basename(n).lower().replace("_", "")]
            if hit:
                # A shapefile is several files with the same stem.
                stem = hit[0][:-4]
                for n in names:
                    if n.startswith(stem + "."):
                        z.extract(n, tmpdir)
                out[want] = (os.path.join(tmpdir, hit[0]), None)
        if not out and gpkg:
            g = z.extract(gpkg[0], tmpdir)
            layers = [l[0] for l in pyogrio_list(g)]
            for want in ("foreshore", "tidalboundary"):
                l = _find_layer(layers, want)
                if l:
                    out[want] = (g, l)
        if not out:
            print(f"OS OpenMap Local zip has no foreshore or tidal boundary data (e.g. {names[:6]})")
    return out


def pyogrio_list(path):
    import pyogrio
    return pyogrio.list_layers(path)


def _read(src, bng_box):
    """(crs, [shapely geometries], {field: values}) from one OS layer."""
    import pyogrio
    import shapely
    path, layer = src
    kw = {"bbox": bng_box}
    if layer:
        kw["layer"] = layer
    meta, _fids, geoms, fields = pyogrio.raw.read(path, **kw)
    crs = meta.get("crs") or "EPSG:27700"  # OS data is British National Grid
    names = list(meta.get("fields", []))
    table = {n: list(v) for n, v in zip(names, fields)}
    shapes = [None if w is None else shapely.from_wkb(w) for w in geoms]
    return crs, shapes, table


def load_os(bng_box):
    """Ordnance Survey foreshore polygons and the mean low water line over
    the area, in lat/lon: (foreshore, low_water). foreshore is a list of
    GeoJSON-like dicts, or None if OS data couldn't be had (the old 40 m
    rule is used then); low_water is a list of lines, each a list of
    [lat, lon], or None."""
    try:
        import pyogrio  # noqa: F401
        import shapely
    except ImportError:
        print("pyogrio/shapely not installed — foreshore from OS skipped")
        return None, None
    tmpdir = tempfile.mkdtemp()
    foreshore = low_water = None
    try:
        srcs = _os_sources(tmpdir)
        if "foreshore" in srcs:
            try:
                crs, geoms, _t = _read(srcs["foreshore"], bng_box)
                foreshore = [transform_geom(crs, "EPSG:4326", shapely.geometry.mapping(g))
                             for g in geoms if g is not None and not g.is_empty]
                print(f"OS foreshore: {len(foreshore)} areas over the bay")
            except Exception as err:  # noqa: BLE001
                print(f"OS foreshore couldn't be read ({type(err).__name__}: {err}) — using the old 40 m rule")
        else:
            print("OS foreshore not found — using the old 40 m rule")
        if "tidalboundary" in srcs:
            try:
                low_water = low_water_lines(srcs["tidalboundary"], bng_box)
            except Exception as err:  # noqa: BLE001
                print(f"OS low water line couldn't be read ({type(err).__name__}: {err}) — no line drawn")
        else:
            print("OS TidalBoundary not found — no low water line")
    except Exception as err:  # noqa: BLE001
        print(f"OS data couldn't be loaded ({type(err).__name__}: {err}) — using the old 40 m rule, no low water line")
    finally:
        import shutil
        shutil.rmtree(tmpdir, ignore_errors=True)
    return foreshore, low_water


LOW_WATER_SIMPLIFY_M = 1.5  # drop points that move the line less than this


def low_water_lines(src, bng_box):
    """The OS Low Water Mark (mean low water in England and Wales) from the
    TidalBoundary layer, cut to the area, joined up, lightly simplified,
    as lines of [lat, lon] rounded to about 1 m."""
    import shapely
    from shapely.ops import linemerge
    crs, geoms, table = _read(src, bng_box)
    # Which features are low water: a text field saying "Low Water Mark"
    # (CLASSIFICA in the shapefiles, classification in the GeoPackage).
    keep = None
    for name, vals in table.items():
        texts = [str(v).lower() for v in vals]
        if any("low water" in t for t in texts):
            keep = ["low water" in t for t in texts]
            print(f"OS TidalBoundary: low water taken from field {name}; values {sorted(set(map(str, vals)))}")
            break
    if keep is None:
        print(f"OS TidalBoundary: no field says 'Low Water' (fields: {list(table)}) — no line drawn")
        return None
    parts = []
    for g, k in zip(geoms, keep):
        if not k or g is None or g.is_empty:
            continue
        # OS lines carry a height on every point (x, y, z); only x and y
        # are wanted.
        g = shapely.force_2d(g)
        g = shapely.clip_by_rect(g, *bng_box)
        if g.is_empty:
            continue
        parts.extend(getattr(g, "geoms", [g]))
    parts = [p for p in parts if p.geom_type == "LineString" and len(p.coords) >= 2]
    if not parts:
        print("OS TidalBoundary: no low water line over the bay")
        return []
    merged = linemerge(parts)
    merged = merged.simplify(LOW_WATER_SIMPLIFY_M, preserve_topology=False)
    lines = []
    for ln in getattr(merged, "geoms", [merged]):
        if ln.is_empty or len(ln.coords) < 2:
            continue
        gj = transform_geom(crs, "EPSG:4326", shapely.geometry.mapping(ln))
        pts = [[round(c[1], 5), round(c[0], 5)] for c in gj["coordinates"]]
        # Keep only lines that touch the coast outline (not the far corners
        # of the box round it).
        if any(inside_outline(la, lo) for la, lo in pts[::max(1, len(pts) // 20)] + [pts[-1]]):
            lines.append(pts)
    n = sum(len(l) for l in lines)
    print(f"OS low water line: {len(lines)} lines, {n} points over the bay")
    return lines


def write_low_water(lines):
    path = os.path.join(OUT_DIR, "low-water.json")
    if lines is None:
        # Leave any earlier file alone rather than lose the line on a bad download.
        return
    data = {
        "area": AREA_ID,
        "builtAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "meaning": "Mean low water (the Low Water Mark): below this line is sea at an average low tide; on big spring tides a strip beyond it can briefly dry",
        "format": "lines: each a list of [lat, lon]",
        "lines": lines,
        "source": "Ordnance Survey OpenMap Local, Tidal Boundary (Contains OS data © Crown copyright and database right, OGL)",
    }
    with open(path, "w") as f:
        json.dump(data, f, separators=(",", ":"))
        f.write("\n")
    print(f"Wrote {path} ({os.path.getsize(path) / 1e3:.0f} kB)")


def shape_bounds(geom):
    xs, ys = [], []
    def walk(c):
        if isinstance(c[0], (int, float)):
            xs.append(c[0]); ys.append(c[1])
        else:
            for cc in c:
                walk(cc)
    walk(geom["coordinates"])
    return min(xs), min(ys), max(xs), max(ys)


def encode_height(h):
    code = np.zeros(h.shape, dtype=np.uint8)
    valid = ~np.isnan(h)
    hv = h[valid]
    c = np.round((np.clip(hv, HEIGHT_MIN, HEIGHT_MAX) - HEIGHT_MIN) * 10).astype(np.int32) + 1
    c[hv > HEIGHT_MAX] = 255
    code[valid] = np.clip(c, 1, 255).astype(np.uint8)
    return code


def slope_degrees(h, lat_centre):
    dy = D_LAT * 110574.0
    dx = D_LON * 111320.0 * math.cos(math.radians(lat_centre))
    gy, gx = np.gradient(h, dy, dx)
    s = np.degrees(np.arctan(np.hypot(gx, gy)))
    s = np.nan_to_num(s, nan=0.0)
    return np.clip(np.round(s), 0, 90).astype(np.uint8)


def main():
    os.makedirs(HEIGHTS_DIR, exist_ok=True)
    total_rows = int(math.ceil((NORTH - SOUTH) / D_LAT))
    total_cols = int(math.ceil((EAST - WEST) / D_LON))
    tile_rows = int(math.ceil(total_rows / TILE))
    tile_cols = int(math.ceil(total_cols / TILE))
    print(f"Grid {total_cols} x {total_rows} cells, {tile_cols} x {tile_rows} tiles of {TILE}")

    env = dict(
        GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR",
        CPL_VSIL_CURL_ALLOWED_EXTENSIONS=".tif",
        GDAL_HTTP_MAX_RETRY=6,
        GDAL_HTTP_RETRY_DELAY=5,
        GDAL_CACHEMAX=1024,
        VSI_CACHE="TRUE",
    )
    # The area in British National Grid metres, for the OS download.
    from rasterio.warp import transform as warp_transform
    bx, by = warp_transform("EPSG:4326", "EPSG:27700", [WEST, EAST, WEST, EAST], [SOUTH, SOUTH, NORTH, NORTH])
    foreshore, low_water = load_os((min(bx), min(by), max(bx), max(by)))
    os.makedirs(OUT_DIR, exist_ok=True)
    write_low_water(low_water)
    fs_bounds = [shape_bounds(g) for g in foreshore] if foreshore else []

    with rasterio.Env(**env), rasterio.open(SOURCE_URL) as src:
        print(f"Source: {src.width} x {src.height}, {src.crs}, nodata={src.nodata}, overviews={src.overviews(1)}")
        nodata = src.nodata

        # ---- Pass 1: coarse look at the whole area to find coastal tiles ----
        coarse_t = from_origin(WEST, NORTH, D_LON * COARSE, D_LAT * COARSE)
        cw = tile_cols * TILE // COARSE
        ch = tile_rows * TILE // COARSE
        with WarpedVRT(src, crs="EPSG:4326", transform=coarse_t, width=cw, height=ch,
                       resampling=Resampling.average, src_nodata=nodata, nodata=np.nan,
                       dtype="float32") as vrt:
            coarse = clean(vrt.read(1), np.nan)
        per = TILE // COARSE
        # Ground within about 250 m of the sea is what the coast map needs.
        # Further inland is kept only as "land" (no detail), which costs
        # almost nothing to store and keeps islands and headlands solid.
        sea = np.isnan(coarse)
        near_sea_land = dilate(sea, NEAR_SEA_COARSE) & ~sea
        # Whole-area land/sea outline at the coarse spacing (about 60 m):
        # the coast map uses it for everywhere that has no detailed tile,
        # so open sea and inland fields aren't confused.
        Image.fromarray(np.where(sea, 0, 255).astype(np.uint8), "L").save(
            os.path.join(HEIGHTS_DIR, "landmask.png"), optimize=True)
        wanted = []
        for r in range(tile_rows):
            for c in range(tile_cols):
                north = NORTH - r * TILE * D_LAT
                south = north - TILE * D_LAT
                west = WEST + c * TILE * D_LON
                east = west + TILE * D_LON
                if not tile_touches_outline(south, west, north, east):
                    continue
                block = near_sea_land[r * per:(r + 1) * per, c * per:(c + 1) * per]
                if block.size and block.any():
                    wanted.append((r, c, south, west, north, east))
        print(f"Coastal tiles to build: {len(wanted)}")

        # ---- Pass 2: full detail for each coastal tile ----
        # The detailed grid starts one cell outside the area all round, so
        # every tile can be read with a one-cell border (needed for the
        # steepness at tile edges) without reading off the grid's edge.
        fine_t = from_origin(WEST - D_LON, NORTH + D_LAT, D_LON, D_LAT)
        tiles = []
        with WarpedVRT(src, crs="EPSG:4326", transform=fine_t,
                       width=tile_cols * TILE + 2, height=tile_rows * TILE + 2,
                       resampling=Resampling.average, src_nodata=nodata, nodata=np.nan,
                       dtype="float32") as vrt:
            for n, (r, c, south, west, north, east) in enumerate(wanted, 1):
                # One extra cell all round, so steepness at tile edges is right.
                win = Window(c * TILE, r * TILE, TILE + 2, TILE + 2)
                h = clean(vrt.read(1, window=win), np.nan)
                slope_full = slope_degrees(h, (south + north) / 2)
                slope_full[local_relief(h, RELIEF_HALF) < RELIEF_MIN_M] = 0
                slope = slope_full[1:-1, 1:-1]
                h = h[1:-1, 1:-1]
                if np.isnan(h).all():
                    continue
                near = np.kron(near_sea_land[r * per:(r + 1) * per, c * per:(c + 1) * per],
                               np.ones((COARSE, COARSE), dtype=bool))
                near = near[:TILE, :TILE] if near.shape[0] >= TILE else np.pad(near, ((0, TILE - near.shape[0]), (0, TILE - near.shape[1])))
                code = encode_height(h)
                far_land = (~near) & (code > 0)
                code[far_land] = 255
                slope[far_land] = 0
                rgb = np.zeros((TILE, TILE, 3), dtype=np.uint8)
                rgb[..., 0] = code
                rgb[..., 1] = slope
                if foreshore is not None:
                    # OS foreshore without survey heights: dries at low tide.
                    here = [g for g, (x0, y0, x1, y1) in zip(foreshore, fs_bounds)
                            if x1 >= west and x0 <= east and y1 >= south and y0 <= north]
                    if here:
                        fmask = rasterize(here, out_shape=(TILE, TILE),
                                          transform=from_origin(west, north, D_LON, D_LAT),
                                          fill=0, default_value=1, dtype="uint8").astype(bool)
                        rgb[..., 2] = (np.isnan(h) & fmask).astype(np.uint8) * 2
                else:
                    low = (~np.isnan(h)) & (h <= UNSURVEYED_LOW_M)
                    unsurveyed = np.isnan(h) & grow(low, UNSURVEYED_REACH)
                    rgb[..., 2] = unsurveyed.astype(np.uint8)
                name = f"r{r}c{c}.png"
                Image.fromarray(rgb, "RGB").save(os.path.join(HEIGHTS_DIR, name), optimize=True)
                tiles.append({"r": r, "c": c, "file": name,
                              "south": round(south, 6), "west": round(west, 6),
                              "north": round(north, 6), "east": round(east, 6)})
                if n % 10 == 0 or n == len(wanted):
                    print(f"  built {n}/{len(wanted)}")

    # Remove tiles left over from an earlier run that aren't built now.
    keep = {t["file"] for t in tiles}
    for f in os.listdir(HEIGHTS_DIR):
        if f.startswith("r") and f.endswith(".png") and f not in keep:
            os.remove(os.path.join(HEIGHTS_DIR, f))

    index = {
        "area": AREA_ID,
        "builtAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "grid": {"north": NORTH, "west": WEST, "dLat": D_LAT, "dLon": D_LON, "tileSize": TILE},
        "encoding": {
            "red": "ground height: 0 = no data (usually sea); 1-254 = (red - 1) / 10 - 6 metres above Ordnance Datum; 255 = above 19.3 m, or land more than about 250 m from the sea (kept without detail)",
            "green": "steepness in degrees",
            "blue": ("2 = no survey data, but Ordnance Survey foreshore (between mean low and mean high water): dries at low tide, height unknown; 0 otherwise (no-data outside it is sea)"
                     if foreshore is not None else
                     "1 = no survey data but almost certainly foreshore or shallows (within ~40 m of surveyed ground below +1 m OD); 0 otherwise"),
            "foreshoreSource": "Ordnance Survey OpenMap Local (Contains OS data © Crown copyright and database right, OGL)" if foreshore is not None else None,
            "heightMin": HEIGHT_MIN, "heightMax": HEIGHT_MAX, "heightStep": 0.1,
        },
        "landmask": {"file": "landmask.png", "dLat": D_LAT * COARSE, "dLon": D_LON * COARSE,
                     "meaning": "white = land, black = sea or no data; covers the whole grid at the coarse spacing"},
        "tiles": tiles,
        "source": "Contains Welsh Government LiDAR 2020-2023 (1 m terrain model), Open Government Licence v3.0",
    }
    with open(os.path.join(HEIGHTS_DIR, "index.json"), "w") as f:
        json.dump(index, f)
        f.write("\n")

    make_preview(tiles, tile_rows, tile_cols)
    check_access(tiles)
    size = sum(os.path.getsize(os.path.join(HEIGHTS_DIR, t["file"])) for t in tiles)
    print(f"Done: {len(tiles)} tiles, {size / 1e6:.1f} MB")


def read_tile(t):
    return np.asarray(Image.open(os.path.join(HEIGHTS_DIR, t["file"])).convert("RGB"))


def make_preview(tiles, tile_rows, tile_cols):
    """A small picture of the whole area: sea dark blue, ground below
    ~5 m (the tidal zone and beaches) sand, higher ground green, steep
    ground amber, cliffs red. Just for checking by eye."""
    step = 8  # every 8th cell: about 16 m per preview pixel
    per = TILE // step
    img = np.zeros((tile_rows * per, tile_cols * per, 3), dtype=np.uint8)
    img[...] = (30, 40, 60)
    mask = np.asarray(Image.open(os.path.join(HEIGHTS_DIR, "landmask.png")))
    up = np.kron(mask > 0, np.ones((COARSE // step, COARSE // step), dtype=bool))[:img.shape[0], :img.shape[1]]
    img[:up.shape[0], :up.shape[1]][up] = (90, 120, 80)  # land without detail: darker green
    for t in tiles:
        a = read_tile(t)[::step, ::step]
        code, slope, flag = a[..., 0].astype(int), a[..., 1].astype(int), a[..., 2].astype(int)
        h = (code - 1) / 10.0 - 6.0
        out = np.zeros(code.shape + (3,), dtype=np.uint8)
        out[...] = (30, 40, 60)
        land = code > 0
        out[land & (h <= 5)] = (225, 205, 150)
        out[land & ((h > 5) | (code == 255))] = (120, 160, 100)
        out[land & (slope >= 30)] = (230, 160, 40)
        out[land & (slope >= 55)] = (200, 50, 40)
        out[(code == 0) & (flag >= 1)] = (110, 110, 120)  # foreshore not surveyed
        img[t["r"] * per:(t["r"] + 1) * per, t["c"] * per:(t["c"] + 1) * per] = out
    Image.fromarray(img, "RGB").save(os.path.join(HEIGHTS_DIR, "preview.png"), optimize=True)


def check_access(tiles):
    path = os.path.join(OUT_DIR, "access.json")
    if not os.path.exists(path):
        print("No access.json yet — run step 1 (coast-data) first to check ways off the beach.")
        return
    with open(path) as f:
        data = json.load(f)
    lookup = {(t["r"], t["c"]): t for t in tiles}
    cache = {}
    checked = 0
    for a in data.get("access", []):
        row = int((NORTH - a["lat"]) / D_LAT)
        col = int((a["lon"] - WEST) / D_LON)
        key = (row // TILE, col // TILE)
        t = lookup.get(key)
        ground = None
        if t is not None:
            if key not in cache:
                cache[key] = read_tile(t)
            # Lowest ground within 3 cells (6 m): the point is the path's
            # nearest vertex to the beach, so allow a little slack.
            r0, c0 = row % TILE, col % TILE
            block = cache[key][max(0, r0 - 3):r0 + 4, max(0, c0 - 3):c0 + 4, 0].astype(int)
            block = block[block > 0]
            if block.size:
                code = int(block.min())
                ground = None if code == 255 else round((code - 1) / 10 - 6, 1)
                if code == 255:
                    ground = 99.0
        a["groundM"] = ground
        a["checked"] = True
        a["atBeachLevel"] = a.get("kind") == "slipway" or (ground is not None and ground <= ACCESS_BEACH_LEVEL_M)
        checked += 1
    data["accessCheckedAt"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    with open(path, "w") as f:
        json.dump(data, f)
        f.write("\n")
    ok = sum(1 for a in data.get("access", []) if a.get("atBeachLevel"))
    print(f"Ways off checked: {checked}, at beach level: {ok}")


if __name__ == "__main__":
    try:
        main()
    except Exception as err:
        print(f"Failed: {err}", file=sys.stderr)
        raise
