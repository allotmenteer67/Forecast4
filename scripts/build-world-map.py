#!/usr/bin/env python3
"""Builds data/world-110m.json for the Travel page's locator map, from
Natural Earth (public domain, no credit needed).

Run once by hand, not by a GitHub job - the map never changes. Needs the
Natural Earth GeoJSON files in one folder, from
https://github.com/nvkelso/natural-earth-vector/tree/master/geojson :

  ne_110m_admin_0_countries, ne_110m_lakes

  python3 scripts/build-world-map.py /path/to/geojson/folder

Coordinates are stored as whole numbers of 1/100th of a degree, each
point as the difference from the one before (smaller file). See
travel-map.js for the reader.

(v167 also had a detailed 50m map behind the clock; v168 dropped it for
the continent map alone, on request.)
"""
import json
import os
import sys

SRC = sys.argv[1] if len(sys.argv) > 1 else "."
OUT = os.path.join(os.path.dirname(__file__), "..", "data")
Q = 100  # 0.01 degree steps


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


def encode(points, tol):
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
    return out if len(out) >= 8 else None  # a ring needs 4+ points


def rings(geom):
    t, c = geom["type"], geom["coordinates"]
    if t == "Polygon":
        return c
    if t == "MultiPolygon":
        return [r for poly in c for r in poly]
    return []


def build():
    countries = []
    for f in load("ne_110m_admin_0_countries"):
        rs = [e for e in (encode(r, 0.1) for r in rings(f["geometry"])) if e]
        if rs:
            countries.append(rs)
    lakes = []
    for f in load("ne_110m_lakes"):
        for r in rings(f["geometry"]):
            e = encode(r, 0.1)
            if e:
                lakes.append(e)
    return {"v": 2, "q": Q, "countries": countries, "lakes": lakes}


if __name__ == "__main__":
    path = os.path.join(OUT, "world-110m.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(build(), f, separators=(",", ":"))
    print("world-110m.json", os.path.getsize(path), "bytes")
