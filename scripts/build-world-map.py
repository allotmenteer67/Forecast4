#!/usr/bin/env python3
"""Builds data/world-50m.json and data/world-110m.json for the Travel page's
locator map, from Natural Earth (public domain, no credit needed).

Run once by hand, not by a GitHub job - the map never changes. Needs the
Natural Earth GeoJSON files in one folder, from
https://github.com/nvkelso/natural-earth-vector/tree/master/geojson :

  ne_50m_admin_0_countries, ne_50m_admin_1_states_provinces_lines,
  ne_50m_rivers_lake_centerlines, ne_50m_lakes,
  ne_50m_populated_places_simple, ne_110m_land

  python3 scripts/build-world-map.py /path/to/geojson/folder

Coordinates are stored as whole numbers of 1/100th of a degree, each
point as the difference from the one before (smaller file). See
travel-map.js for the reader.
"""
import json
import os
import sys

SRC = sys.argv[1] if len(sys.argv) > 1 else "."
OUT = os.path.join(os.path.dirname(__file__), "..", "data")
Q = 100  # 0.01 degree steps

# Countries big enough that their state/province lines help find a place.
STATE_COUNTRIES = {"USA", "CAN", "AUS", "BRA", "RUS", "CHN", "IND"}


def load(name):
    with open(os.path.join(SRC, name + ".geojson"), encoding="utf-8") as f:
        return json.load(f)["features"]


def dp(points, tol):
    """Douglas-Peucker line simplification."""
    if len(points) < 3:
        return points
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        a, b = stack.pop()
        ax, ay = points[a]
        bx, by = points[b]
        dx, dy = bx - ax, by - ay
        norm = (dx * dx + dy * dy) ** 0.5
        best, idx = -1, -1
        for i in range(a + 1, b):
            px, py = points[i]
            if norm == 0:
                d = ((px - ax) ** 2 + (py - ay) ** 2) ** 0.5
            else:
                d = abs(dy * px - dx * py + bx * ay - by * ax) / norm
            if d > best:
                best, idx = d, i
        if best > tol:
            keep[idx] = True
            stack.append((a, idx))
            stack.append((idx, b))
    return [p for p, k in zip(points, keep) if k]


def encode(points, tol, closed):
    pts = dp(points, tol)
    out = []
    px = py = None
    for lon, lat in pts:
        x, y = round(lon * Q), round(lat * Q)
        if (x, y) == (px, py):
            continue
        if px is None:
            out += [x, y]
        else:
            out += [x - px, y - py]
        px, py = x, y
    min_len = 8 if closed else 4  # a ring needs 4+ points, a line 2+
    return out if len(out) >= min_len else None


def rings(geom):
    t, c = geom["type"], geom["coordinates"]
    if t == "Polygon":
        return c
    if t == "MultiPolygon":
        return [r for poly in c for r in poly]
    return []


def lines(geom):
    t, c = geom["type"], geom["coordinates"]
    if t == "LineString":
        return [c]
    if t == "MultiLineString":
        return c
    return []


def build_50m():
    countries = []
    for f in load("ne_50m_admin_0_countries"):
        p = f["properties"]
        code = p.get("ADM0_A3")
        rs = [e for e in (encode(r, 0.02, True) for r in rings(f["geometry"])) if e]
        if rs:
            countries.append({"a": code, "r": rs})

    states = []
    for f in load("ne_50m_admin_1_states_provinces_lines"):
        if f["properties"].get("ADM0_A3") not in STATE_COUNTRIES:
            continue
        for ln in lines(f["geometry"]):
            e = encode(ln, 0.03, False)
            if e:
                states.append(e)

    rivers = []
    for f in load("ne_50m_rivers_lake_centerlines"):
        if (f["properties"].get("scalerank") or 9) > 5:
            continue
        for ln in lines(f["geometry"]):
            e = encode(ln, 0.03, False)
            if e:
                rivers.append(e)

    lakes = []
    for f in load("ne_50m_lakes"):
        if (f["properties"].get("scalerank") or 9) > 4:
            continue
        for r in rings(f["geometry"]):
            e = encode(r, 0.03, True)
            if e:
                lakes.append(e)

    cities = []
    for f in load("ne_50m_populated_places_simple"):
        p = f["properties"]
        # Every place in the 50m set (about 1,250): the map shows at most
        # four, biggest first, so smaller ones only appear where there's
        # nothing bigger nearby.
        cities.append([p.get("nameascii") or p.get("name"),
                       round(p["longitude"], 2), round(p["latitude"], 2),
                       p.get("pop_max") or 0])
    cities.sort(key=lambda c: -c[3])

    return {"v": 1, "q": Q, "countries": countries, "states": states,
            "rivers": rivers, "lakes": lakes, "cities": cities}


def build_110m():
    land = []
    for f in load("ne_110m_land"):
        for r in rings(f["geometry"]):
            e = encode(r, 0.15, True)
            if e:
                land.append(e)
    return {"v": 1, "q": Q, "land": land}


def write(name, data):
    path = os.path.join(OUT, name)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, separators=(",", ":"))
    print(name, os.path.getsize(path), "bytes")


if __name__ == "__main__":
    write("world-50m.json", build_50m())
    write("world-110m.json", build_110m())
