// ==== Coast map, step 1: names, ways off the beach, cliffs ====
//
// Run by .github/workflows/coast-data.yml (by hand, from the Actions
// tab — not on a schedule; this data hardly ever changes). Collects, for
// one stretch of coast (COAST_AREA below: Skomer to Newgale):
//
//   names.json     every named coastal feature — headlands, points,
//                  bays, beaches, rocks, islands, villages near the shore
//                  — from Ordnance Survey Open Names and OpenStreetMap,
//                  merged where both have the same name close together.
//                  Welsh names from OS are kept as alternative names.
//   access.json    possible ways off the beach: slipways, and the
//                  beach-end of steps and paths that reach a beach.
//                  "Possible" because a path along a cliff top can pass
//                  close to a beach without going down to it — step 2
//                  (the LIDAR heights) will weed those out.
//   cliffs.json    mapped cliff edges (OpenStreetMap natural=cliff).
//   beaches.json   beach outlines (OpenStreetMap natural=beach).
//   names-list.md  the names as a readable list, grouped by kind and
//                  sorted north to south, with positions and a map link
//                  for each — for checking with local crew.
//
// Also reads aliases.json if it exists: a hand-kept list of local names
// for features, added after checking with crew. It's never overwritten.
//
// All written to data/coast/<area id>/.
//
// Sources and licences:
//   Ordnance Survey Open Names — Contains OS data © Crown copyright and
//     database right. Open Government Licence.
//   OpenStreetMap — © OpenStreetMap contributors, Open Database Licence.
//
// If one source fails (a busy server, a changed download address), the
// script carries on with the other and says so in the log and in the
// readable list, rather than failing outright.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ---- The stretch of coast ----
const COAST_AREA = {
  id: "stbrides",
  label: "St Brides Bay — Newgale to Dale, with Skomer and Skokholm",
  south: 51.70,
  west: -5.36,
  north: 51.87,
  east: -5.05
};
// The download box above is a simple rectangle, which also catches the
// north side of the bay (Solva to Ramsey, St Davids' patch) and the
// inside of Milford Haven east of Dale. Everything is trimmed to this
// outline instead: Newgale round the bay, Skomer and Skokholm, the
// Marloes peninsula, and down to Dale. [lat, lon] corners.
const COAST_OUTLINE = [
  [51.875, -5.140], [51.875, -5.050], [51.735, -5.050], [51.735, -5.150],
  [51.690, -5.150], [51.690, -5.360], [51.835, -5.360], [51.835, -5.140]
];

// Names further than this from the coastline are left out (farms and
// inland hamlets aren't useful for describing a position at sea).
const MAX_DISTANCE_FROM_COAST_M = 800;
// Two entries with the same name closer than this are the same feature.
const SAME_FEATURE_M = 600;
// A path or steps counts as reaching a beach if a point on it is within
// this distance of the beach outline.
const PATH_TO_BEACH_M = 25;

const OUT_DIR = path.join("data", "coast", COAST_AREA.id);
const OVERPASS_URLS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter"
];
const OS_OPEN_NAMES_URL = "https://api.os.uk/downloads/v1/products/OpenNames/downloads?area=GB&format=CSV&redirect";
const USER_AGENT = "Cloude coast map (GitHub Actions; one-off data build)";

// ---- Geometry helpers ----
const R_EARTH = 6371008.8;
function distanceM(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.sqrt(a));
}

// Distance from a point to a line segment, on a local flat projection
// (fine over the few km involved here).
function distanceToSegmentM(lat, lon, a, b) {
  const kx = Math.cos(lat * Math.PI / 180) * 111320;
  const ky = 110574;
  const px = lon * kx, py = lat * ky;
  const ax = a.lon * kx, ay = a.lat * ky;
  const bx = b.lon * kx, by = b.lat * ky;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

function distanceToLinesM(lat, lon, lines) {
  let best = Infinity;
  for (const line of lines) {
    for (let i = 1; i < line.length; i++) {
      const d = distanceToSegmentM(lat, lon, line[i - 1], line[i]);
      if (d < best) best = d;
    }
  }
  return best;
}

function insideBox(lat, lon) {
  return lat >= COAST_AREA.south && lat <= COAST_AREA.north && lon >= COAST_AREA.west && lon <= COAST_AREA.east;
}

// Inside COAST_OUTLINE (standard ray-casting test).
function insideArea(lat, lon) {
  if (!insideBox(lat, lon)) return false;
  let inside = false;
  for (let i = 0, j = COAST_OUTLINE.length - 1; i < COAST_OUTLINE.length; j = i++) {
    const [yi, xi] = COAST_OUTLINE[i], [yj, xj] = COAST_OUTLINE[j];
    if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const lineInsideArea = line => line.some(p => insideArea(p.lat, p.lon));

// Many coastal features come from OS as a catch-all type ("Other
// landform", "Other"), and some OSM rocks and headlands are tagged as
// a "locality". Their names usually say what they are, in English or
// Welsh, so the name decides the group in those cases. Checked in this
// order, so "Ynys" wins over "Pen", "Rock" over "Head" and so on.
const NAME_HINTS = [
  [/\b(ynys|island|isle|holm)\b|holm$/i, "Islands and islets"],
  [/\b(ogof|cave|caves|twll|hole|holes|leap|arch)\b/i, "Arches, caves and chasms"],
  [/\b(landing|dock|slip|quay|jetty)\b/i, "Landing places"],
  [/\b(rock|rocks|rk|carreg|careg|maen|meini|stack|stacks|stacen|stone|stones|ledge|ledges|llech|bitches|reef)\b/i, "Rocks and reefs"],
  [/\b(point|head|nab|ness|trwyn|trwynmynachdy|pen|pentir|penrhyn|chins?|horn|nose)\b|^trwyn|^pen/i, "Headlands and points"],
  [/\b(bay|haven|cove|porth|wick|pwll|pill|sound|roads|reach|mouth|gully|inlet|harbour|cwm)\b/i, "Bays, coves and sounds"],
  [/\b(sands|beach|traeth)\b/i, "Beaches"],
  [/\b(cliff|cliffs|clogwyn)\b/i, "Cliffs"]
];
const CATCH_ALL_KINDS = new Set(["Other", "Other landforms", "Water features"]);
function hintedKind(name, baseKind) {
  for (const [re, kind] of NAME_HINTS) if (re.test(name)) return kind;
  return baseKind;
}

// OS names that aren't useful for describing a position on the coast.
// OS_SKIP is matched against OS's own type for the name; OS_SKIP_NAME
// against the name itself (kept short so "Driftwood Beach" or the
// hamlet "Wood" aren't caught).
const OS_SKIP = /school|education|college|hospital|surgery|cemetery|police|fire station|leisure|sport|golf|retail|business|industrial|terminal|woodland|forest/i;
const OS_SKIP_NAME = /\b(school|college|hospital|terminal)\b/i;

function round5(x) { return Math.round(x * 1e5) / 1e5; }

// Degrees and decimal minutes, as the coastguard gives positions:
// 51°46.20′N 5°08.70′W
function degMin(lat, lon) {
  const f = (v, pos, neg, degDigits) => {
    const hemi = v >= 0 ? pos : neg;
    const a = Math.abs(v);
    let d = Math.floor(a);
    let m = (a - d) * 60;
    if (m >= 59.995) { d += 1; m = 0; }
    return `${String(d).padStart(degDigits, "0")}°${m.toFixed(2).padStart(5, "0")}′${hemi}`;
  };
  return `${f(lat, "N", "S", 2)} ${f(lon, "E", "W", 1)}`;
}

// ---- British National Grid → WGS84 lat/lon ----
// OS Open Names gives positions as eastings/northings on the OSGB36
// datum. Inverse transverse Mercator (Airy 1830 ellipsoid) to OSGB36
// lat/lon, then a Helmert transform to WGS84. Accurate to a few metres,
// which is plenty for place names.
function bngToWgs84(E, N) {
  const a = 6377563.396, b = 6356256.909;
  const F0 = 0.9996012717;
  const lat0 = 49 * Math.PI / 180, lon0 = -2 * Math.PI / 180;
  const N0 = -100000, E0 = 400000;
  const e2 = 1 - (b * b) / (a * a);
  const n = (a - b) / (a + b), n2 = n * n, n3 = n * n * n;

  let lat = lat0, M = 0;
  do {
    lat = (N - N0 - M) / (a * F0) + lat;
    const Ma = (1 + n + (5 / 4) * n2 + (5 / 4) * n3) * (lat - lat0);
    const Mb = (3 * n + 3 * n * n + (21 / 8) * n3) * Math.sin(lat - lat0) * Math.cos(lat + lat0);
    const Mc = ((15 / 8) * n2 + (15 / 8) * n3) * Math.sin(2 * (lat - lat0)) * Math.cos(2 * (lat + lat0));
    const Md = (35 / 24) * n3 * Math.sin(3 * (lat - lat0)) * Math.cos(3 * (lat + lat0));
    M = b * F0 * (Ma - Mb + Mc - Md);
  } while (N - N0 - M >= 0.00001);

  const cosLat = Math.cos(lat), sinLat = Math.sin(lat);
  const nu = a * F0 / Math.sqrt(1 - e2 * sinLat * sinLat);
  const rho = a * F0 * (1 - e2) / Math.pow(1 - e2 * sinLat * sinLat, 1.5);
  const eta2 = nu / rho - 1;
  const tanLat = Math.tan(lat);
  const tan2 = tanLat * tanLat, tan4 = tan2 * tan2, tan6 = tan4 * tan2;
  const secLat = 1 / cosLat;
  const nu3 = nu * nu * nu, nu5 = nu3 * nu * nu, nu7 = nu5 * nu * nu;
  const VII = tanLat / (2 * rho * nu);
  const VIII = tanLat / (24 * rho * nu3) * (5 + 3 * tan2 + eta2 - 9 * tan2 * eta2);
  const IX = tanLat / (720 * rho * nu5) * (61 + 90 * tan2 + 45 * tan4);
  const X = secLat / nu;
  const XI = secLat / (6 * nu3) * (nu / rho + 2 * tan2);
  const XII = secLat / (120 * nu5) * (5 + 28 * tan2 + 24 * tan4);
  const XIIA = secLat / (5040 * nu7) * (61 + 662 * tan2 + 1320 * tan4 + 720 * tan6);
  const dE = E - E0, dE2 = dE * dE, dE3 = dE2 * dE, dE4 = dE2 * dE2, dE5 = dE3 * dE2, dE6 = dE3 * dE3, dE7 = dE5 * dE2;
  const latO = lat - VII * dE2 + VIII * dE4 - IX * dE6;
  const lonO = lon0 + X * dE - XI * dE3 + XII * dE5 - XIIA * dE7;

  // OSGB36 lat/lon → cartesian
  const sinO = Math.sin(latO), cosO = Math.cos(latO);
  const nuO = a / Math.sqrt(1 - e2 * sinO * sinO);
  const x1 = nuO * cosO * Math.cos(lonO);
  const y1 = nuO * cosO * Math.sin(lonO);
  const z1 = (1 - e2) * nuO * sinO;

  // Helmert OSGB36 → WGS84
  const tx = 446.448, ty = -125.157, tz = 542.060;
  const s = -20.4894e-6;
  const rx = (0.1502 / 3600) * Math.PI / 180, ry = (0.2470 / 3600) * Math.PI / 180, rz = (0.8421 / 3600) * Math.PI / 180;
  const x2 = tx + (1 + s) * x1 - rz * y1 + ry * z1;
  const y2 = ty + rz * x1 + (1 + s) * y1 - rx * z1;
  const z2 = tz - ry * x1 + rx * y1 + (1 + s) * z1;

  // cartesian → WGS84 lat/lon
  const aW = 6378137.0, bW = 6356752.3142;
  const e2W = 1 - (bW * bW) / (aW * aW);
  const p = Math.sqrt(x2 * x2 + y2 * y2);
  let latW = Math.atan2(z2, p * (1 - e2W)), prev = 2 * Math.PI;
  while (Math.abs(latW - prev) > 1e-12) {
    const nuW = aW / Math.sqrt(1 - e2W * Math.sin(latW) ** 2);
    prev = latW;
    latW = Math.atan2(z2 + e2W * nuW * Math.sin(latW), p);
  }
  const lonW = Math.atan2(y2, x2);
  return { lat: latW * 180 / Math.PI, lon: lonW * 180 / Math.PI };
}

// ---- OpenStreetMap ----
function overpassQuery() {
  const bb = `(${COAST_AREA.south},${COAST_AREA.west},${COAST_AREA.north},${COAST_AREA.east})`;
  return `[out:json][timeout:180];
(
  nwr["name"]["natural"~"^(cape|peninsula|bay|beach|rock|stone|bare_rock|reef|shoal|cliff|arch|cave_entrance|headland|sand|shingle|strait|isthmus)$"]${bb};
  nwr["name"]["place"~"^(island|islet|village|hamlet|locality|isolated_dwelling)$"]${bb};
  nwr["seamark:name"]${bb};
  nwr["name"]["man_made"~"^(lighthouse|pier|breakwater|beacon)$"]${bb};
  nwr["leisure"="slipway"]${bb};
  way["natural"="cliff"]${bb};
  way["natural"="beach"]${bb};
  relation["natural"="beach"]${bb};
  way["natural"="coastline"]${bb};
  way["highway"~"^(steps|path|footway|track|bridleway)$"]${bb};
);
out geom;`;
}

async function fetchOsm() {
  const body = "data=" + encodeURIComponent(overpassQuery());
  let lastErr = null;
  for (const url of OVERPASS_URLS) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": USER_AGENT },
          body
        });
        if (!res.ok) throw new Error(`${url} answered ${res.status}`);
        const data = await res.json();
        console.log(`OpenStreetMap: ${data.elements.length} elements from ${url}`);
        return data.elements;
      } catch (err) {
        lastErr = err;
        console.warn(`OpenStreetMap attempt ${attempt} at ${url} failed: ${err.message}`);
        await new Promise(r => setTimeout(r, 15000 * attempt));
      }
    }
  }
  throw lastErr || new Error("OpenStreetMap download failed");
}

// A representative point for any element (node, or way/relation with geometry).
function elementPoint(el) {
  if (el.type === "node") return { lat: el.lat, lon: el.lon };
  const pts = elementLines(el).flat();
  if (!pts.length) {
    if (el.center) return { lat: el.center.lat, lon: el.center.lon };
    if (el.bounds) return { lat: (el.bounds.minlat + el.bounds.maxlat) / 2, lon: (el.bounds.minlon + el.bounds.maxlon) / 2 };
    return null;
  }
  const lat = pts.reduce((s, p) => s + p.lat, 0) / pts.length;
  const lon = pts.reduce((s, p) => s + p.lon, 0) / pts.length;
  return { lat, lon };
}

function elementLines(el) {
  if (el.type === "way" && Array.isArray(el.geometry)) return [el.geometry.filter(Boolean)];
  if (el.type === "relation" && Array.isArray(el.members)) {
    return el.members.filter(m => Array.isArray(m.geometry)).map(m => m.geometry.filter(Boolean));
  }
  return [];
}

function osmKind(tags) {
  const nat = tags.natural, place = tags.place, mm = tags.man_made;
  if (nat === "cape" || nat === "peninsula" || nat === "headland") return "Headlands and points";
  if (nat === "bay" || nat === "strait") return "Bays, coves and sounds";
  if (nat === "beach" || nat === "sand" || nat === "shingle") return "Beaches";
  if (["rock", "stone", "bare_rock", "reef", "shoal"].includes(nat)) return "Rocks and reefs";
  if (nat === "arch" || nat === "cave_entrance") return "Arches, caves and chasms";
  if (nat === "cliff") return "Cliffs";
  if (place === "island" || place === "islet") return "Islands and islets";
  if (["village", "hamlet", "locality", "isolated_dwelling"].includes(place)) return "Villages and places";
  if (mm) return "Landmarks";
  const sm = tags["seamark:type"];
  if (sm) return /^(rock|obstruction|wreck)$/.test(sm) ? "Rocks and reefs" : "Landmarks";
  return "Other";
}

// ---- Ordnance Survey Open Names ----
// The download is a zip of CSV files, one per 10 km grid square, with no
// header row. Only the SM (west Pembrokeshire) squares are unpacked.
const OS_COLS = { NAME1: 2, NAME1_LANG: 3, NAME2: 4, NAME2_LANG: 5, TYPE: 6, LOCAL_TYPE: 7, X: 8, Y: 9 };

function parseCsvLine(line) {
  const out = [];
  let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === "\"") {
        if (line[i + 1] === "\"") { cur += "\""; i++; } else inQ = false;
      } else cur += c;
    } else if (c === "\"") inQ = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

function osKind(type, localType) {
  const lt = (localType || "").toLowerCase();
  if (/headland|point|cape/.test(lt)) return "Headlands and points";
  if (/bay|cove|inlet|sound|harbour/.test(lt)) return "Bays, coves and sounds";
  if (/beach|foreshore|sand/.test(lt)) return "Beaches";
  if (/rock|reef/.test(lt)) return "Rocks and reefs";
  if (/cliff/.test(lt)) return "Cliffs";
  if (/island/.test(lt)) return "Islands and islets";
  if (type === "populatedPlace") return "Villages and places";
  if (type === "landform") return "Other landforms";
  if (type === "hydrography") return "Water features";
  return "Other";
}

async function fetchOsNames() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "osnames-"));
  const zipPath = path.join(tmp, "opennames.zip");
  console.log("Ordnance Survey Open Names: downloading (large file, can take a minute)…");
  const res = await fetch(OS_OPEN_NAMES_URL, { headers: { "User-Agent": USER_AGENT }, redirect: "follow" });
  if (!res.ok) throw new Error(`OS Open Names download answered ${res.status}`);
  fs.writeFileSync(zipPath, Buffer.from(await res.arrayBuffer()));
  const listing = execFileSync("unzip", ["-Z1", zipPath], { maxBuffer: 64 * 1024 * 1024 }).toString().split("\n");
  const wanted = listing.filter(n => /(^|\/)SM\d\d\.csv$/i.test(n));
  if (!wanted.length) throw new Error("OS Open Names zip has no SM grid files — has its layout changed?");
  execFileSync("unzip", ["-o", "-j", "-q", zipPath, ...wanted, "-d", tmp]);

  const results = [];
  for (const name of wanted) {
    const file = path.join(tmp, path.basename(name));
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) continue;
      const f = parseCsvLine(line);
      if (f[0] === "ID") continue; // in case a header row is ever added
      const type = f[OS_COLS.TYPE];
      const localType = f[OS_COLS.LOCAL_TYPE] || "";
      if (type === "transportNetwork" || type === "landcover") continue;
      if (type === "other" && /postcode/i.test(localType)) continue;
      if (OS_SKIP.test(localType) || OS_SKIP_NAME.test(f[OS_COLS.NAME1])) continue;
      const E = Number(f[OS_COLS.X]), N = Number(f[OS_COLS.Y]);
      if (!Number.isFinite(E) || !Number.isFinite(N)) continue;
      const { lat, lon } = bngToWgs84(E, N);
      if (!insideArea(lat, lon)) continue;
      const alt = [];
      if (f[OS_COLS.NAME2]) alt.push(f[OS_COLS.NAME2]);
      const baseKind = osKind(type, localType);
      results.push({
        name: f[OS_COLS.NAME1],
        alt,
        kind: CATCH_ALL_KINDS.has(baseKind) ? hintedKind(f[OS_COLS.NAME1], baseKind) : baseKind,
        detail: f[OS_COLS.LOCAL_TYPE] || type,
        lat, lon,
        sources: ["OS"]
      });
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`Ordnance Survey Open Names: ${results.length} names in the area`);
  return results;
}

// ---- Main ----
async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const problems = [];

  let osm = [];
  try {
    osm = await fetchOsm();
  } catch (err) {
    problems.push(`OpenStreetMap could not be downloaded (${err.message}).`);
  }
  let osNames = [];
  try {
    osNames = await fetchOsNames();
  } catch (err) {
    problems.push(`Ordnance Survey Open Names could not be downloaded (${err.message}).`);
  }
  if (!osm.length && !osNames.length) {
    console.error(problems.join("\n"));
    process.exit(1);
  }

  // Coastline, beaches, cliffs
  const coastline = osm.filter(e => e.type === "way" && e.tags && e.tags.natural === "coastline").flatMap(elementLines);
  const beachEls = osm.filter(e => e.tags && e.tags.natural === "beach" && e.type !== "node" && elementLines(e).some(lineInsideArea));
  const beaches = beachEls.map(e => ({
    name: e.tags.name || null,
    outline: elementLines(e).map(l => l.map(p => [round5(p.lat), round5(p.lon)]))
  })).filter(b => b.outline.length);
  const beachLines = beachEls.flatMap(elementLines);
  const cliffs = osm.filter(e => e.type === "way" && e.tags && e.tags.natural === "cliff" && lineInsideArea(e.geometry.filter(Boolean)))
    .map(e => ({ name: e.tags.name || null, line: e.geometry.filter(Boolean).map(p => [round5(p.lat), round5(p.lon)]) }));

  if (!coastline.length) problems.push("No coastline found in OpenStreetMap, so names couldn't be filtered by distance from the shore — every name in the area is listed.");
  const nearCoast = (lat, lon) => !coastline.length || distanceToLinesM(lat, lon, coastline) <= MAX_DISTANCE_FROM_COAST_M;

  // Names from OSM
  const osmNames = [];
  for (const el of osm) {
    const t = el.tags || {};
    const name = t.name || t["seamark:name"];
    if (!name) continue;
    if (t.highway) continue; // named paths/tracks aren't positions
    const pt = elementPoint(el);
    if (!pt || !insideArea(pt.lat, pt.lon)) continue;
    const alt = [t["name:cy"], t["name:en"], t.alt_name, t.old_name, t.loc_name, t["seamark:name"]]
      .filter(Boolean).flatMap(v => String(v).split(";")).map(s => s.trim()).filter(s => s && s !== name);
    osmNames.push({
      name,
      alt: [...new Set(alt)],
      kind: (() => {
        const base = osmKind(t);
        // OSM "locality" is often a rock or headland; let the name decide.
        if (t.place === "locality" || t.place === "isolated_dwelling" || base === "Other") return hintedKind(name, base);
        return base;
      })(),
      detail: t.natural || t.place || t.man_made || t["seamark:type"] || t.leisure || "",
      lat: pt.lat, lon: pt.lon,
      sources: ["OSM"]
    });
  }

  // Merge: same name (ignoring case/punctuation) within SAME_FEATURE_M.
  // Ignores case, punctuation, a leading "The", a trailing "Island" and
  // anything in brackets, so "The Nab Head" / "Nab Head", "Gateholm
  // Island" / "Gateholm" and "Huntsman's Leap (St Bride's)" /
  // "Huntsman's Leap" count as the same name when they're close together.
  const norm = s => s.toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/^the /, "")
    .replace(/ island$/, "");
  const merged = [];
  for (const item of [...osNames, ...osmNames]) {
    if (!item.name || !nearCoast(item.lat, item.lon)) continue;
    const keys = [item.name, ...item.alt].map(norm);
    const match = merged.find(m =>
      [m.name, ...m.alt].map(norm).some(k => keys.includes(k)) &&
      distanceM(m.lat, m.lon, item.lat, item.lon) <= SAME_FEATURE_M);
    if (match) {
      for (const a of [item.name, ...item.alt]) {
        if (norm(a) !== norm(match.name) && !match.alt.some(x => norm(x) === norm(a))) match.alt.push(a);
      }
      for (const s of item.sources) if (!match.sources.includes(s)) match.sources.push(s);
      // OS kinds are coarser for some coastal features; prefer a more
      // specific OSM kind when the OS one is a catch-all.
      if (/^Other|Water features/.test(match.kind) && !/^Other/.test(item.kind)) match.kind = item.kind;
    } else {
      merged.push({ ...item, alt: [...item.alt] });
    }
  }

  // Hand-kept local names (added after checking with crew).
  const aliasFile = path.join(OUT_DIR, "aliases.json");
  if (fs.existsSync(aliasFile)) {
    try {
      const aliases = JSON.parse(fs.readFileSync(aliasFile, "utf8"));
      for (const a of aliases.names || []) {
        const target = merged.find(m => norm(m.name) === norm(a.name || ""));
        if (target && Array.isArray(a.alsoCalled)) {
          for (const x of a.alsoCalled) if (!target.alt.some(y => norm(y) === norm(x))) target.alt.push(x);
          if (!target.sources.includes("local")) target.sources.push("local");
        } else if (typeof a.lat === "number" && typeof a.lon === "number") {
          merged.push({ name: a.name, alt: a.alsoCalled || [], kind: a.kind || "Local names", detail: "local", lat: a.lat, lon: a.lon, sources: ["local"] });
        }
      }
    } catch (err) {
      problems.push(`aliases.json couldn't be read (${err.message}) — local names skipped this run.`);
    }
  }

  merged.sort((a, b) => b.lat - a.lat);
  const names = merged.map(m => ({
    name: m.name, alt: m.alt, kind: m.kind, detail: m.detail,
    lat: round5(m.lat), lon: round5(m.lon), sources: m.sources
  }));

  // Ways off the beach
  const access = [];
  for (const el of osm) {
    const t = el.tags || {};
    if (t.leisure === "slipway") {
      const pt = elementPoint(el);
      if (pt && insideArea(pt.lat, pt.lon)) access.push({ kind: "slipway", name: t.name || null, lat: round5(pt.lat), lon: round5(pt.lon) });
      continue;
    }
    if (el.type !== "way" || !t.highway || !beachLines.length) continue;
    const pts = (el.geometry || []).filter(Boolean);
    let best = null, bestD = Infinity;
    for (const p of pts) {
      const d = distanceToLinesM(p.lat, p.lon, beachLines);
      if (d < bestD) { bestD = d; best = p; }
    }
    if (best && bestD <= PATH_TO_BEACH_M && insideArea(best.lat, best.lon)) {
      access.push({
        kind: t.highway === "steps" ? "steps" : "path",
        name: t.name || null,
        lat: round5(best.lat), lon: round5(best.lon),
        checked: false // step 2 checks the height difference with LIDAR
      });
    }
  }
  // Several path pieces often meet the beach at one spot: keep one per 30 m.
  const accessDeduped = [];
  for (const a of access) {
    if (!accessDeduped.some(b => b.kind === a.kind && distanceM(a.lat, a.lon, b.lat, b.lon) < 30)) accessDeduped.push(a);
  }

  const meta = {
    area: COAST_AREA,
    builtAt: new Date().toISOString(),
    sources: [
      osNames.length ? "Contains OS data © Crown copyright and database right (Open Names, Open Government Licence)" : null,
      osm.length ? "© OpenStreetMap contributors (Open Database Licence)" : null
    ].filter(Boolean),
    problems
  };
  const write = (file, data) => fs.writeFileSync(path.join(OUT_DIR, file), JSON.stringify({ ...meta, ...data }) + "\n");
  write("names.json", { names });
  write("access.json", { access: accessDeduped });
  write("cliffs.json", { cliffs });
  write("beaches.json", { beaches });

  // Readable list
  const groups = {};
  for (const n of names) (groups[n.kind] ||= []).push(n);
  const order = ["Headlands and points", "Bays, coves and sounds", "Beaches", "Rocks and reefs", "Islands and islets",
    "Landing places", "Arches, caves and chasms", "Cliffs", "Landmarks", "Villages and places", "Other landforms", "Water features", "Local names", "Other"];
  const kinds = [...order.filter(k => groups[k]), ...Object.keys(groups).filter(k => !order.includes(k))];
  let md = `# ${COAST_AREA.label} — names found\n\n`;
  md += `Built ${new Date().toISOString().slice(0, 10)}. ${names.length} names, north to south within each group. `;
  md += `Positions are degrees and decimal minutes (WGS84, as on a GPS). Each "map" link opens OpenStreetMap at that spot.\n\n`;
  md += `Sources: OS = Ordnance Survey Open Names, OSM = OpenStreetMap, local = added by hand after checking with crew.\n\n`;
  if (problems.length) md += `**Problems this run:**\n\n${problems.map(p => `- ${p}`).join("\n")}\n\n`;
  md += `Ways off the beach found: ${accessDeduped.length} (slipways, steps and paths that reach a beach — not yet checked for height). Cliff edges mapped: ${cliffs.length}. Beaches outlined: ${beaches.length}.\n\n`;
  for (const k of kinds) {
    md += `## ${k} (${groups[k].length})\n\n`;
    for (const n of groups[k]) {
      const alt = n.alt.length ? ` — also: ${n.alt.join(", ")}` : "";
      const link = `https://www.openstreetmap.org/?mlat=${n.lat}&mlon=${n.lon}#map=16/${n.lat}/${n.lon}`;
      md += `- **${n.name}**${alt} — ${degMin(n.lat, n.lon)} — ${n.sources.join("+")} — [map](${link})\n`;
    }
    md += "\n";
  }
  md += `---\n\n${meta.sources.join(". ")}.\n`;
  fs.writeFileSync(path.join(OUT_DIR, "names-list.md"), md);

  console.log(`Wrote ${names.length} names, ${accessDeduped.length} ways off, ${cliffs.length} cliffs, ${beaches.length} beaches to ${OUT_DIR}`);
  if (problems.length) console.warn("Problems:\n" + problems.join("\n"));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
