// ==== Coast map (step 3a) ====
//
// A close-up map of St Brides Bay (Newgale to Dale, with Skomer and
// Skokholm) drawn from the Welsh Government LIDAR tiles built by
// scripts/build-coast-heights.py, with the predicted tide laid over it:
//
//   - ground below the tide at the chosen time is shown as water
//   - while the tide is rising, ground that will be covered within the
//     next 30 minutes is picked out in bright cyan: the width of that
//     band is how fast the water's edge is moving across the ground
//   - steep ground (30° and over) amber, cliffs (55° and over) red
//   - place names from data/coast/stbrides/names.json when zoomed in
//
// Opened from the callout screen's Coast map button. Like callout.js it
// does NOT load app.js; it loads tide.js for the same Milford Haven
// prediction the tide card and callout use.
//
// Drawing: a plain canvas with a simple flat (equirectangular)
// projection, the same approach as the main map (map.js) — no map
// library and no internet base map, so it works with whatever has been
// cached. Drag to move, pinch or the +/- buttons to zoom.
//
// Heights are metres above Ordnance Datum (ODN), as in the LIDAR. The
// tide prediction from tide.js is also in metres above OD (the EA gauge
// datum), so the two compare directly. The level is shown on screen
// above Chart Datum, like the tide card, using the gauge's CD offset.
//
// Step 3b adds:
//   - ways off the beach (slipways, steps and paths checked against the
//     LIDAR in step 2 as reaching beach level), each with the time the
//     tide reaches its foot
//   - for each named beach, the time its last way off is cut
//   - a "cut off" overlay: dry beach and rock at the chosen time from
//     which there is no dry route — without crossing water or a cliff —
//     to a way off or to higher ground
//
// Coming in later parts: a pin and own position (3c), rescue position
// entry (3d).

const COAST_BASE = "data/coast/stbrides/";
const COAST_TILE_DIR = COAST_BASE + "heights/";
// The tide gauge for the whole bay (tide.js picks Milford Haven).
const COAST_TIDE_POINT = { lat: 51.75, lon: -5.15 };
// Where the map opens if nothing else is chosen: Little Haven.
const COAST_START = { lat: 51.775, lon: -5.11, mpp: 6 };
const COAST_VIEW_KEY = "cloude-coast:view";

const STEEP_DEG = 30;
const CLIFF_DEG = 55;
const SLIDER_STEP_MIN = 10;
const SLIDER_HOURS = 24;
const MIN_MPP = 0.6;   // metres per screen pixel, closest
const MAX_MPP = 60;    // furthest: the whole bay on a phone
const NAMES_MPP = 9;   // place names shown when closer than this
const DECODED_TILE_LIMIT = 36;
const CUTOFF_MPP = 6;          // cut-off overlay and way-off times shown when this close
const CUTOFF_MAX_TILES = 20;   // limit on the area checked at once (phone memory)
const IMPASSABLE_DEG = 40;     // ground this steep counts as a wall for walkers
const SERIES_STEP_MIN = 5;     // tide worked out every 5 minutes for the cut times
const SERIES_HOURS = 30;       // far enough ahead to cover the slider (24 h) plus a tide

// Colours (dark map, readable at night).
const C = {
  sea: [22, 34, 52],
  covered: [43, 95, 138],
  soon: [63, 200, 215],
  sand: [214, 196, 150],
  land: [104, 136, 92],
  steep: [222, 156, 58],
  cliff: [205, 70, 60],
  cutoff: [214, 72, 190],         // dry, but no dry way out
  unsurveyed: [92, 96, 108],      // foreshore the survey couldn't see
  unsurveyedHatch: [122, 126, 138],
  // Plain land (inland, and the coarse outline) is drawn at the shade
  // typical of gently sloping fields, so the joins with detailed land
  // don't show as lighter rectangles.
  maskLand: [96, 125, 85]
};
const PLAIN_LAND_SHADE = 0.92;

// Fixed east-west scale for the whole bay, so the map doesn't stretch
// as you pan north or south.
const KY = 110574;
const KX = 111320 * Math.cos(51.78 * Math.PI / 180);

// tide.js calls fetchWithTimeout, normally from app.js (not loaded here).
async function fetchWithTimeout(url, options = {}, timeoutMs = 20000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err.name === "AbortError") throw new Error("Timed out — check your connection and try again");
    throw err;
  } finally {
    clearTimeout(id);
  }
}

// ---- State ----
const coast = {
  index: null,
  mask: null,          // { canvas, width, height }
  names: [],
  tiles: new Map(),    // file -> { meta, codes, slopes, canvas, renderKey, loading, used }
  view: null,          // { lat, lon, mpp }
  canvas: null, ctx: null, dpr: 1, w: 0, h: 0,
  tide: null,          // { fit, epochMs, fudge, cdOffset, label }
  offsetMin: 0,        // slider position, minutes from now (rounded)
  baseTime: 0,         // now, rounded down to SLIDER_STEP_MIN
  drawQueued: false,
  status: "",
  access: [],          // ways off at beach level: { lat, lon, kind, name, groundM }
  beaches: [],         // { name, lat, lon, outline, access: [indexes] }
  series: null,        // { startMs, levels: Float32Array } tide every SERIES_STEP_MIN
  cutoffKey: null,     // what the current cut-off overlay was worked out for
  cutoffTimer: null
};

function $(id) { return document.getElementById(id); }

function readJson(key, fallback) {
  try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; } catch { return fallback; }
}
function writeJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
}

function clockTime(date) {
  return date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" });
}

// ---- Projection ----
function toScreen(lat, lon) {
  const v = coast.view;
  return {
    x: (lon - v.lon) * KX / v.mpp + coast.w / 2,
    y: (v.lat - lat) * KY / v.mpp + coast.h / 2
  };
}
function toLatLon(x, y) {
  const v = coast.view;
  return {
    lat: v.lat - (y - coast.h / 2) * v.mpp / KY,
    lon: v.lon + (x - coast.w / 2) * v.mpp / KX
  };
}
function viewBounds() {
  const a = toLatLon(0, 0), b = toLatLon(coast.w, coast.h);
  return { north: a.lat, west: a.lon, south: b.lat, east: b.lon };
}

// ---- Tide ----
function slideTime() { return new Date(coast.baseTime + coast.offsetMin * 60000); }

function tideOdAt(date) {
  const t = coast.tide;
  if (!t) return null;
  const hours = (date.getTime() - t.epochMs) / 3600000;
  return applyTideFudge(predictTideLevel(t.fit, hours), t.fudge);
}

async function loadTide() {
  if (typeof nearestTideStation !== "function") return;
  const station = nearestTideStation(COAST_TIDE_POINT.lat, COAST_TIDE_POINT.lon);
  if (!station) return;
  setTideText("Loading tide…", "");
  try {
    const built = await getOrBuildTideFit(station);
    if (!built) throw new Error("no tide data");
    coast.tide = {
      fit: built.fit,
      epochMs: Date.parse(built.epochIso),
      fudge: loadTideFudge(station.id),
      cdOffset: typeof station.cdOffsetOD === "number" ? station.cdOffsetOD : null,
      label: station.label
    };
    buildSeries();
  } catch {
    coast.tide = null;
    setTideText("Tide not available — showing ground only", "");
  }
  invalidateTiles();
  updateTimeLabel();
  queueDraw();
}

// Water level now and in 30 min, in m OD, for the slider time.
function levelsForSlider() {
  const t = slideTime();
  const now = tideOdAt(t);
  if (now === null) return null;
  const later = tideOdAt(new Date(t.getTime() + 30 * 60000));
  return { now, later, rate: (later - now) * 2 };
}

function setTideText(main, sub) {
  $("coastTide").textContent = main;
  $("coastTideSub").textContent = sub;
}

function updateTimeLabel() {
  const t = slideTime();
  const h = Math.floor(coast.offsetMin / 60), m = coast.offsetMin % 60;
  const span = h === 0 ? `${m} min` : m === 0 ? `${h} h` : `${h} h ${String(m).padStart(2, "0")}`;
  const ahead = coast.offsetMin === 0 ? "Now" : `In ${span}`;
  // Big clock time on the map itself (so it's in any screenshot), and a
  // short version next to the slider.
  $("coastClock").textContent = clockTime(t);
  $("coastAhead").textContent = ahead;
  $("coastTime").textContent = coast.offsetMin === 0 ? `Now · ${clockTime(t)}` : `${clockTime(t)} (in ${span})`;
  $("coastAhead").classList.toggle("future", coast.offsetMin !== 0);
  const lv = levelsForSlider();
  if (!lv) return;
  const shown = coast.tide.cdOffset !== null ? lv.now - coast.tide.cdOffset : lv.now;
  const datum = coast.tide.cdOffset !== null ? "" : " (gauge datum)";
  const abs = Math.abs(lv.rate);
  const state = abs < 0.25 ? "Turning" : (lv.rate > 0 ? "Rising" : "Falling") + (abs >= 0.9 ? " fast" : "");
  setTideText(`Tide ${shown.toFixed(1)} m${datum} · ${state}`,
    `${lv.rate >= 0 ? "+" : "−"}${abs.toFixed(1)} m per hour · ${coast.tide.label}`);
}

// ---- Data loading ----
async function loadIndex() {
  const res = await fetch(COAST_TILE_DIR + "index.json");
  if (!res.ok) throw new Error(`index ${res.status}`);
  coast.index = await res.json();
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image failed: " + src));
    img.src = src;
  });
}

async function loadMask() {
  const lm = coast.index.landmask;
  if (!lm) return;
  const img = await loadImage(COAST_TILE_DIR + lm.file);
  const c = document.createElement("canvas");
  c.width = img.width; c.height = img.height;
  const x = c.getContext("2d");
  x.drawImage(img, 0, 0);
  const data = x.getImageData(0, 0, c.width, c.height);
  const p = data.data;
  for (let i = 0; i < p.length; i += 4) {
    const land = p[i] > 127;
    p[i] = C.maskLand[0]; p[i + 1] = C.maskLand[1]; p[i + 2] = C.maskLand[2];
    p[i + 3] = land ? 255 : 0;
  }
  x.putImageData(data, 0, 0);
  coast.mask = { canvas: c, dLat: lm.dLat, dLon: lm.dLon };
}

async function loadAccessAndBeaches() {
  try {
    const [ra, rb] = await Promise.all([fetch(COAST_BASE + "access.json"), fetch(COAST_BASE + "beaches.json")]);
    const access = ra.ok ? (await ra.json()).access || [] : [];
    const beaches = rb.ok ? (await rb.json()).beaches || [] : [];
    // Only ways off that step 2 confirmed reach the beach. If step 2
    // hasn't checked them yet, none are shown rather than guessing.
    coast.access = access.filter(a => a.atBeachLevel && typeof a.lat === "number")
      .map(a => ({ ...a, foot: typeof a.groundM === "number" ? a.groundM : (a.kind === "slipway" ? 0 : null) }));
    coast.beaches = beaches.filter(b => b.name && b.outline && b.outline.length).map(b => {
      const pts = b.outline.flat();
      const lat = pts.reduce((t, p) => t + p[0], 0) / pts.length;
      const lon = pts.reduce((t, p) => t + p[1], 0) / pts.length;
      // Ways off within 40 m of the beach outline belong to it.
      const mine = [];
      coast.access.forEach((a, i) => {
        if (b.outline.some(line => distanceToLineM(a.lat, a.lon, line) <= 40)) mine.push(i);
      });
      return { name: b.name, lat, lon, outline: b.outline, access: mine };
    });
  } catch { /* optional */ }
}

function distanceToLineM(lat, lon, line) {
  let best = Infinity;
  for (let i = 1; i < line.length; i++) {
    const ax = line[i - 1][1] * KX, ay = line[i - 1][0] * KY;
    const bx = line[i][1] * KX, by = line[i][0] * KY;
    const px = lon * KX, py = lat * KY;
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    best = Math.min(best, Math.hypot(px - (ax + t * dx), py - (ay + t * dy)));
  }
  return best;
}

// ---- Tide series and cut times ----
function buildSeries() {
  if (!coast.tide) { coast.series = null; return; }
  const n = SERIES_HOURS * 60 / SERIES_STEP_MIN + 1;
  const levels = new Float32Array(n);
  for (let i = 0; i < n; i++) levels[i] = tideOdAt(new Date(coast.baseTime + i * SERIES_STEP_MIN * 60000));
  coast.series = { startMs: coast.baseTime, levels };
}

// First time at or after the slider time that the tide reaches `footOd`.
// Returns { state: "now" } if already covered, { state: "at", time } or
// { state: "clear" } if not within the series.
function cutTime(footOd) {
  const sr = coast.series;
  if (!sr || footOd === null) return null;
  const i0 = Math.round(coast.offsetMin / SERIES_STEP_MIN);
  if (sr.levels[i0] >= footOd) return { state: "now" };
  for (let i = i0 + 1; i < sr.levels.length; i++) {
    if (sr.levels[i] >= footOd) return { state: "at", time: new Date(sr.startMs + i * SERIES_STEP_MIN * 60000) };
  }
  return { state: "clear" };
}

function inText(date) {
  const min = Math.round((date - slideTime()) / 60000);
  const h = Math.floor(min / 60), m = min % 60;
  return h === 0 ? `${m} min` : m === 0 ? `${h} h` : `${h} h ${String(m).padStart(2, "0")}`;
}

// ---- Cut-off overlay ----
// Works on a patchwork of the tiles round the view. A cell is walkable
// if it has a height, is above the water and isn't steeper than
// IMPASSABLE_DEG. Starting from every way off and from all higher land
// (and walkable land at the patchwork's edge), it spreads through
// walkable cells; dry beach-height cells it never reaches are cut off.
function scheduleCutoff() {
  clearTimeout(coast.cutoffTimer);
  coast.cutoffTimer = setTimeout(computeCutoff, 120);
}

function computeCutoff() {
  if (!coast.index || coast.view.mpp > CUTOFF_MPP) { clearCutoff(); return; }
  const lv = levelsForSlider();
  if (!lv) { clearCutoff(); return; }
  const g = coast.index.grid, T = g.tileSize;
  const vb = viewBounds();
  const padLat = T * g.dLat * 0.5, padLon = T * g.dLon * 0.5;
  const r0 = Math.max(0, Math.floor((g.north - (vb.north + padLat)) / (T * g.dLat)));
  const r1 = Math.floor((g.north - (vb.south - padLat)) / (T * g.dLat));
  const c0 = Math.max(0, Math.floor((vb.west - padLon - g.west) / (T * g.dLon)));
  const c1 = Math.floor((vb.east + padLon - g.west) / (T * g.dLon));
  const rows = r1 - r0 + 1, cols = c1 - c0 + 1;
  if (rows * cols > CUTOFF_MAX_TILES) { clearCutoff(); return; }

  // Every tile in the patch must be decoded first; decode and retry.
  const byRC = new Map(coast.index.tiles.map(t => [`${t.r},${t.c}`, t]));
  const patch = [];
  let waiting = false;
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
    const meta = byRC.get(`${r},${c}`);
    if (!meta) { patch.push(null); continue; }
    const e = tileEntry(meta);
    e.used = performance.now();
    if (!e.codes) { decodeTile(e); waiting = true; }
    patch.push(e);
  }
  if (waiting) { scheduleCutoff(); return; }

  const key = `${r0},${c0},${rows},${cols}|${lv.now.toFixed(2)}`;
  if (key === coast.cutoffKey) return;

  const W = cols * T, H = rows * T, N = W * H;
  const coverCode = codeFor(lv.now);
  const sandCode = codeFor(5);
  // 0 = blocked, 1 = walkable, 2 = reached
  const state = new Uint8Array(N);
  const queue = new Int32Array(N);
  const wall = new Uint8Array(N);
  let qh = 0, qt = 0;
  for (let pr = 0; pr < rows; pr++) for (let pc = 0; pc < cols; pc++) {
    const e = patch[pr * cols + pc];
    if (!e) continue;
    for (let y = 0; y < T; y++) {
      const src = y * T, dst = (pr * T + y) * W + pc * T;
      for (let x = 0; x < T; x++) {
        const code = e.codes[src + x];
        if (code === 0 || code <= coverCode) continue;
        const k = dst + x;
        if (e.slopes[src + x] >= IMPASSABLE_DEG) { wall[k] = 1; continue; }
        state[k] = code === 255 ? 3 : 1; // 3 = higher land, seeded below
      }
    }
  }
  // Thicken cliffs by one cell all round, so a cliff face with the odd
  // less-steep cell in it (a ledge, or survey noise) still counts as a
  // wall rather than a way up.
  for (let k = 0; k < N; k++) {
    if (!wall[k]) continue;
    const y = (k / W) | 0, x = k - y * W;
    for (let dy = -1; dy <= 1; dy++) {
      const yy = y + dy;
      if (yy < 0 || yy >= H) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx;
        if (xx >= 0 && xx < W) state[yy * W + xx] = 0;
      }
    }
  }
  // Higher land is a way out in itself.
  for (let k = 0; k < N; k++) if (state[k] === 3) { state[k] = 2; queue[qt++] = k; }
  // Walkable ground above beach height on the patch's edge is assumed to
  // lead somewhere. Beach-height ground on the edge is NOT: the patch
  // reaches half a tile (~500 m) beyond the screen, and a beach that
  // carries on further than that without a way off or a slope up is
  // better shown as cut off than wrongly shown as safe.
  const high = new Uint8Array(N);
  for (let pr = 0; pr < rows; pr++) for (let pc = 0; pc < cols; pc++) {
    const e = patch[pr * cols + pc];
    if (!e) continue;
    for (let y = 0; y < T; y++) {
      const src = y * T, dst = (pr * T + y) * W + pc * T;
      for (let x = 0; x < T; x++) if (e.codes[src + x] > sandCode) high[dst + x] = 1;
    }
  }
  const edgeSeed = k => { if (state[k] === 1 && high[k]) { state[k] = 2; queue[qt++] = k; } };
  for (let x = 0; x < W; x++) { edgeSeed(x); edgeSeed((H - 1) * W + x); }
  for (let y = 0; y < H; y++) { edgeSeed(y * W); edgeSeed(y * W + W - 1); }
  // Each way off: its foot, or the nearest walkable cell within ~10 m.
  for (const a of coast.access) {
    const row = Math.floor((g.north - a.lat) / g.dLat) - r0 * T;
    const col = Math.floor((a.lon - g.west) / g.dLon) - c0 * T;
    if (row < 0 || col < 0 || row >= H || col >= W) continue;
    for (let d = 0; d <= 5; d++) {
      let seeded = false;
      for (let dy = -d; dy <= d && !seeded; dy++) for (let dx = -d; dx <= d && !seeded; dx++) {
        const y = row + dy, x = col + dx;
        if (y < 0 || x < 0 || y >= H || x >= W) continue;
        const k = y * W + x;
        if (state[k] === 1) { state[k] = 2; queue[qt++] = k; seeded = true; }
        else if (state[k] === 2) seeded = true;
      }
      if (seeded) break;
    }
  }
  // Spread (8 directions).
  while (qh < qt) {
    const k = queue[qh++];
    const y = (k / W) | 0, x = k - y * W;
    for (let dy = -1; dy <= 1; dy++) {
      const yy = y + dy;
      if (yy < 0 || yy >= H) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx;
        if (xx < 0 || xx >= W || (dx === 0 && dy === 0)) continue;
        const n = yy * W + xx;
        if (state[n] === 1) { state[n] = 2; queue[qt++] = n; }
      }
    }
  }
  // Mark dry beach-height cells that weren't reached, per tile.
  for (const e of coast.tiles.values()) e.cut = null;
  for (let pr = 0; pr < rows; pr++) for (let pc = 0; pc < cols; pc++) {
    const e = patch[pr * cols + pc];
    if (!e) continue;
    let cut = null;
    for (let y = 0; y < T; y++) {
      const src = y * T, dst = (pr * T + y) * W + pc * T;
      for (let x = 0; x < T; x++) {
        const k = dst + x;
        if (state[k] === 1 && e.codes[src + x] <= sandCode) {
          if (!cut) cut = new Uint8Array(T * T);
          cut[src + x] = 1;
        }
      }
    }
    e.cut = cut;
  }
  coast.cutoffKey = key;
  invalidateTiles();
  queueDraw();
}

function clearCutoff() {
  if (coast.cutoffKey === null) return;
  for (const e of coast.tiles.values()) e.cut = null;
  coast.cutoffKey = null;
  invalidateTiles();
  queueDraw();
}

async function loadNames() {
  try {
    const res = await fetch(COAST_BASE + "names.json");
    if (!res.ok) return;
    const data = await res.json();
    // Bigger features first, so they win when labels would overlap.
    const rank = k => ({
      "Villages and places": 0, "Islands and islets": 1, "Headlands and points": 2,
      "Bays, coves and sounds": 3, "Beaches": 4, "Rocks and reefs": 5
    }[k] ?? 6);
    coast.names = (data.names || []).slice().sort((a, b) => rank(a.kind) - rank(b.kind));
  } catch { /* names are optional */ }
}

function tileEntry(meta) {
  let e = coast.tiles.get(meta.file);
  if (!e) { e = { meta, codes: null, slopes: null, canvas: null, renderKey: null, loading: false, used: 0 }; coast.tiles.set(meta.file, e); }
  return e;
}

async function decodeTile(e) {
  if (e.loading || e.codes) return;
  e.loading = true;
  try {
    const img = await loadImage(COAST_TILE_DIR + e.meta.file);
    const c = document.createElement("canvas");
    c.width = img.width; c.height = img.height;
    const x = c.getContext("2d", { willReadFrequently: true });
    x.drawImage(img, 0, 0);
    const p = x.getImageData(0, 0, c.width, c.height).data;
    const n = c.width * c.height;
    e.codes = new Uint8Array(n);
    e.slopes = new Uint8Array(n);
    e.flags = new Uint8Array(n);
    for (let i = 0, j = 0; i < n; i++, j += 4) { e.codes[i] = p[j]; e.slopes[i] = p[j + 1]; e.flags[i] = p[j + 2]; }
    e.size = c.width;
    e.canvas = c; // reused as the coloured tile
    e.renderKey = null;
    trimDecoded();
    queueDraw();
  } catch {
    /* leave it; the coarse land outline still shows */
  } finally {
    e.loading = false;
  }
}

// Phones have limited memory: keep only the most recently used tiles decoded.
function trimDecoded() {
  const decoded = [...coast.tiles.values()].filter(e => e.codes);
  if (decoded.length <= DECODED_TILE_LIMIT) return;
  decoded.sort((a, b) => a.used - b.used);
  for (const e of decoded.slice(0, decoded.length - DECODED_TILE_LIMIT)) {
    e.codes = null; e.slopes = null; e.flags = null; e.cut = null; e.canvas = null; e.renderKey = null;
  }
}

function invalidateTiles() {
  for (const e of coast.tiles.values()) e.renderKey = null;
}

// Fetch every tile once in the background so the whole bay is cached on
// the phone for a weak signal later (about 2.6 MB). Not decoded — just
// requested, which the service worker stores.
function prefetchAllTiles() {
  const files = (coast.index.tiles || []).map(t => COAST_TILE_DIR + t.file);
  let i = 0;
  const next = () => {
    if (i >= files.length) return;
    const f = files[i++];
    fetch(f).catch(() => {}).finally(() => setTimeout(next, 150));
  };
  setTimeout(next, 3000);
}

// ---- Colouring a tile for the current tide ----
const HEIGHT_OFFSET = -6, HEIGHT_STEP = 0.1;
function codeFor(heightOd) {
  // The tile's red value at or below which ground is under this level.
  return Math.floor((heightOd - HEIGHT_OFFSET) / HEIGHT_STEP) + 1;
}

function renderTile(e, lv) {
  const key = (lv ? `${lv.now.toFixed(2)}|${lv.later.toFixed(2)}` : "none") + (e.cut ? "|cut" + coast.cutoffKey : "");
  if (e.renderKey === key) return;
  const n = e.codes.length;
  const ctx = e.canvas.getContext("2d", { willReadFrequently: true });
  const img = ctx.createImageData(e.size, e.size);
  const p = img.data;
  const coverCode = lv ? codeFor(lv.now) : -1;
  const soonCode = lv && lv.later > lv.now ? codeFor(lv.later) : coverCode;
  const sandCode = codeFor(5); // up to 5 m OD: the beach and foreshore
  const size = e.size;
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const code = e.codes[i];
    let col;
    if (code === 0) {
      // Foreshore the survey couldn't see (blue channel 1): grey with a
      // fine diagonal hatch, so it can't be mistaken for open sea.
      if (e.flags && e.flags[i]) {
        const x = i % size, y = (i / size) | 0;
        col = ((x + y) % 6) < 2 ? C.unsurveyedHatch : C.unsurveyed;
      } else col = C.sea;
    }
    else if (code !== 255 && code <= coverCode) col = C.covered;
    else if (code !== 255 && code <= soonCode) col = C.soon;
    else if (e.cut && e.cut[i]) col = C.cutoff;
    else {
      const s = e.slopes[i];
      if (s >= CLIFF_DEG) col = C.cliff;
      else if (s >= STEEP_DEG) col = C.steep;
      else if (code === 255 && s === 0) {
        col = C.maskLand; // plain land, same shade as the coarse outline
      } else {
        col = code !== 255 && code <= sandCode ? C.sand : C.land;
        // Gentle relief shading from steepness, so dunes and slopes read.
        // Flat ground sits at PLAIN_LAND_SHADE to match plain land.
        const k = PLAIN_LAND_SHADE - Math.min(s, 30) / 120;
        p[j] = col[0] * k; p[j + 1] = col[1] * k; p[j + 2] = col[2] * k; p[j + 3] = 255;
        continue;
      }
    }
    p[j] = col[0]; p[j + 1] = col[1]; p[j + 2] = col[2]; p[j + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  e.renderKey = key;
}

// ---- Drawing ----
function queueDraw() {
  if (coast.drawQueued) return;
  coast.drawQueued = true;
  requestAnimationFrame(() => { coast.drawQueued = false; draw(); });
}

function draw() {
  const { ctx, dpr } = coast;
  if (!ctx || !coast.view) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  // Round joins so the dark outline round text has no spikes.
  ctx.lineJoin = "round";
  ctx.miterLimit = 2;
  ctx.fillStyle = `rgb(${C.sea.join(",")})`;
  ctx.fillRect(0, 0, coast.w, coast.h);
  if (!coast.index) return;
  ctx.imageSmoothingEnabled = false;

  const g = coast.index.grid;
  // Coarse land outline under everything.
  if (coast.mask) {
    const m = coast.mask;
    const tl = toScreen(g.north, g.west);
    const br = toScreen(g.north - m.canvas.height * m.dLat, g.west + m.canvas.width * m.dLon);
    ctx.drawImage(m.canvas, tl.x, tl.y, br.x - tl.x, br.y - tl.y);
  }

  // Detailed tiles in view.
  const vb = viewBounds();
  const lv = levelsForSlider();
  const stamp = performance.now();
  for (const meta of coast.index.tiles) {
    if (meta.east < vb.west || meta.west > vb.east || meta.north < vb.south || meta.south > vb.north) continue;
    const e = tileEntry(meta);
    e.used = stamp;
    if (!e.codes) { decodeTile(e); continue; }
    renderTile(e, lv);
    const tl = toScreen(meta.north, meta.west);
    const br = toScreen(meta.south, meta.east);
    // Overlap by half a pixel so no seams show between tiles.
    ctx.drawImage(e.canvas, Math.floor(tl.x), Math.floor(tl.y), Math.ceil(br.x - tl.x) + 1, Math.ceil(br.y - tl.y) + 1);
  }

  if (coast.view.mpp <= CUTOFF_MPP) drawAccess();
  if (coast.view.mpp <= NAMES_MPP) drawNames();
  if (coast.view.mpp <= CUTOFF_MPP) drawBeachTimes();
  scheduleCutoff();
  drawScaleBar();
}

// Ways off: a green disc with an up arrow while open, grey with a cross
// once the tide is at its foot. When close in, the time it's cut.
function drawAccess() {
  const { ctx } = coast;
  ctx.font = "600 11px -apple-system, BlinkMacSystemFont, sans-serif";
  ctx.textBaseline = "middle";
  const showTimes = coast.view.mpp <= 3;
  for (const a of coast.access) {
    const s = toScreen(a.lat, a.lon);
    if (s.x < -20 || s.y < -20 || s.x > coast.w + 20 || s.y > coast.h + 20) continue;
    const ct = cutTime(a.foot);
    const shut = ct && ct.state === "now";
    ctx.beginPath(); ctx.arc(s.x, s.y, 7, 0, Math.PI * 2);
    ctx.fillStyle = shut ? "#6b6b6b" : "#2f9e55"; ctx.fill();
    ctx.lineWidth = 1.5; ctx.strokeStyle = "#0e1116"; ctx.stroke();
    ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 1.8; ctx.beginPath();
    if (shut) { ctx.moveTo(s.x - 3, s.y - 3); ctx.lineTo(s.x + 3, s.y + 3); ctx.moveTo(s.x + 3, s.y - 3); ctx.lineTo(s.x - 3, s.y + 3); }
    else { ctx.moveTo(s.x, s.y + 4); ctx.lineTo(s.x, s.y - 4); ctx.moveTo(s.x - 3, s.y - 1); ctx.lineTo(s.x, s.y - 4); ctx.lineTo(s.x + 3, s.y - 1); }
    ctx.stroke();
    if (showTimes && ct) {
      const text = ct.state === "now" ? "cut" : ct.state === "at" ? `cut ${clockTime(ct.time)}` : "open 24 h+";
      ctx.lineWidth = 3; ctx.strokeStyle = "rgba(12,16,22,0.9)";
      ctx.strokeText(text, s.x + 10, s.y); ctx.fillStyle = shut ? "#b4b2a9" : "#b8f0c8"; ctx.fillText(text, s.x + 10, s.y);
    }
  }
}

// For each named beach in view: when its last way off is cut.
function drawBeachTimes() {
  const { ctx } = coast;
  ctx.font = "700 12px -apple-system, BlinkMacSystemFont, sans-serif";
  ctx.textBaseline = "middle";
  for (const b of coast.beaches) {
    const s = toScreen(b.lat, b.lon);
    if (s.x < -60 || s.y < -20 || s.x > coast.w + 60 || s.y > coast.h + 20) continue;
    let text, colour;
    if (!b.access.length) { text = "No mapped way off"; colour = "#b4b2a9"; }
    else {
      const times = b.access.map(i => cutTime(coast.access[i].foot)).filter(Boolean);
      if (!times.length) continue;
      if (times.some(t => t.state === "clear")) { text = "Way off open 24 h+"; colour = "#b8f0c8"; }
      else if (times.every(t => t.state === "now")) { text = "All ways off cut"; colour = "#f09595"; }
      else {
        const last = times.filter(t => t.state === "at").map(t => t.time).sort((x, y) => y - x)[0];
        text = `Last way off cut ${clockTime(last)} (in ${inText(last)})`;
        colour = "#fac775";
      }
    }
    const y = s.y + 16;
    const w = ctx.measureText(text).width;
    ctx.lineWidth = 3; ctx.strokeStyle = "rgba(12,16,22,0.9)";
    ctx.strokeText(text, s.x - w / 2, y); ctx.fillStyle = colour; ctx.fillText(text, s.x - w / 2, y);
  }
}

function drawNames() {
  const { ctx } = coast;
  ctx.font = "600 12px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
  ctx.textBaseline = "middle";
  const placed = [];
  const showAll = coast.view.mpp <= 4;
  for (const n of coast.names) {
    // Further out, only the bigger features, to keep it readable.
    if (!showAll && !["Villages and places", "Islands and islets", "Headlands and points", "Bays, coves and sounds", "Beaches"].includes(n.kind)) continue;
    const s = toScreen(n.lat, n.lon);
    if (s.x < -50 || s.y < -20 || s.x > coast.w + 50 || s.y > coast.h + 20) continue;
    const w = ctx.measureText(n.name).width;
    const box = { x: s.x + 5, y: s.y - 8, w: w + 4, h: 16 };
    if (placed.some(b => box.x < b.x + b.w && box.x + box.w > b.x && box.y < b.y + b.h && box.y + box.h > b.y)) continue;
    placed.push(box);
    ctx.fillStyle = "#f2efe6";
    ctx.beginPath(); ctx.arc(s.x, s.y, 2.5, 0, Math.PI * 2); ctx.fill();
    ctx.lineWidth = 3; ctx.strokeStyle = "rgba(12,16,22,0.85)";
    ctx.strokeText(n.name, s.x + 6, s.y);
    ctx.fillText(n.name, s.x + 6, s.y);
  }
}

// Scale bar in nautical miles (or cables when close in) and metres.
function drawScaleBar() {
  const { ctx } = coast;
  const mpp = coast.view.mpp;
  const targetPx = 110;
  const nm = 1852;
  const choices = [0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 5]; // nautical miles
  let pick = choices[0];
  for (const c of choices) if (c * nm / mpp <= targetPx) pick = c;
  const px = pick * nm / mpp;
  const x = 14, y = coast.h - 18;
  ctx.strokeStyle = "#f2efe6"; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(x, y - 5); ctx.lineTo(x, y); ctx.lineTo(x + px, y); ctx.lineTo(x + px, y - 5); ctx.stroke();
  ctx.font = "600 12px -apple-system, BlinkMacSystemFont, sans-serif";
  ctx.fillStyle = "#f2efe6"; ctx.textBaseline = "bottom";
  const label = pick < 0.1 ? `${Math.round(pick * nm)} m` : `${pick} nm (${Math.round(pick * nm)} m)`;
  ctx.lineWidth = 3; ctx.strokeStyle = "rgba(12,16,22,0.85)";
  ctx.strokeText(label, x, y - 7); ctx.fillText(label, x, y - 7);
}

// ---- Size, pan and zoom ----
function resize() {
  const c = coast.canvas;
  const r = c.getBoundingClientRect();
  coast.dpr = window.devicePixelRatio || 1;
  coast.w = r.width; coast.h = r.height;
  c.width = Math.round(r.width * coast.dpr);
  c.height = Math.round(r.height * coast.dpr);
  queueDraw();
}

function clampView() {
  const v = coast.view;
  v.mpp = Math.min(MAX_MPP, Math.max(MIN_MPP, v.mpp));
  if (coast.index && coast.mask) {
    // Keep the middle of the screen over the bay's grid.
    const g = coast.index.grid, m = coast.mask;
    const south = g.north - m.canvas.height * m.dLat;
    const east = g.west + m.canvas.width * m.dLon;
    v.lat = Math.min(g.north, Math.max(south, v.lat));
    v.lon = Math.min(east, Math.max(g.west, v.lon));
  }
  writeJson(COAST_VIEW_KEY, v);
}

function zoomAt(factor, x, y) {
  const before = toLatLon(x, y);
  coast.view.mpp *= factor;
  coast.view.mpp = Math.min(MAX_MPP, Math.max(MIN_MPP, coast.view.mpp));
  const after = toLatLon(x, y);
  coast.view.lat += before.lat - after.lat;
  coast.view.lon += before.lon - after.lon;
  clampView();
  queueDraw();
}

function setUpGestures() {
  const c = coast.canvas;
  const pointers = new Map();
  let pinchStart = null;
  let lastTap = 0;

  c.addEventListener("pointerdown", ev => {
    c.setPointerCapture(ev.pointerId);
    pointers.set(ev.pointerId, { x: ev.offsetX, y: ev.offsetY });
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinchStart = { dist: Math.hypot(a.x - b.x, a.y - b.y), mpp: coast.view.mpp };
    }
    // Double tap zooms in.
    const now = Date.now();
    if (pointers.size === 1 && now - lastTap < 300) zoomAt(0.5, ev.offsetX, ev.offsetY);
    lastTap = now;
  });
  c.addEventListener("pointermove", ev => {
    const prev = pointers.get(ev.pointerId);
    if (!prev) return;
    const cur = { x: ev.offsetX, y: ev.offsetY };
    if (pointers.size === 1) {
      const v = coast.view;
      v.lat += (cur.y - prev.y) * v.mpp / KY;
      v.lon -= (cur.x - prev.x) * v.mpp / KX;
      clampView();
      queueDraw();
    } else if (pointers.size === 2 && pinchStart) {
      pointers.set(ev.pointerId, cur);
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const target = pinchStart.mpp * pinchStart.dist / Math.max(dist, 1);
      zoomAt(target / coast.view.mpp, mid.x, mid.y);
      return;
    }
    pointers.set(ev.pointerId, cur);
  });
  const end = ev => { pointers.delete(ev.pointerId); if (pointers.size < 2) pinchStart = null; };
  c.addEventListener("pointerup", end);
  c.addEventListener("pointercancel", end);
  c.addEventListener("wheel", ev => { ev.preventDefault(); zoomAt(ev.deltaY > 0 ? 1.2 : 1 / 1.2, ev.offsetX, ev.offsetY); }, { passive: false });

  $("coastZoomIn").addEventListener("click", () => zoomAt(0.5, coast.w / 2, coast.h / 2));
  $("coastZoomOut").addEventListener("click", () => zoomAt(2, coast.w / 2, coast.h / 2));
}

// ---- Time slider ----
function setUpSlider() {
  const s = $("coastSlider");
  s.min = 0;
  s.max = SLIDER_HOURS * 60 / SLIDER_STEP_MIN;
  s.step = 1;
  s.value = 0;
  s.addEventListener("input", () => {
    coast.offsetMin = Number(s.value) * SLIDER_STEP_MIN;
    updateTimeLabel();
    queueDraw();
  });
  $("coastNow").addEventListener("click", () => {
    resetBaseTime();
    s.value = 0;
    coast.offsetMin = 0;
    updateTimeLabel();
    invalidateTiles();
    queueDraw();
  });
}

function resetBaseTime() {
  const step = SLIDER_STEP_MIN * 60000;
  const next = Math.floor(Date.now() / step) * step;
  if (next !== coast.baseTime) {
    coast.baseTime = next;
    if (coast.tide) buildSeries();
  }
}

// ---- Start ----
async function initCoast() {
  coast.canvas = $("coastCanvas");
  coast.ctx = coast.canvas.getContext("2d");
  const saved = readJson(COAST_VIEW_KEY, null);
  coast.view = saved && typeof saved.lat === "number" ? saved : { ...COAST_START };
  resetBaseTime();
  resize();
  window.addEventListener("resize", resize);
  setUpGestures();
  setUpSlider();
  updateTimeLabel();
  $("coastBack").addEventListener("click", () => {
    if (document.referrer && history.length > 1) history.back();
    else window.location.href = "callout.html";
  });
  $("coastLegendToggle").addEventListener("click", () => {
    const open = $("coastLegend").classList.toggle("open");
    $("coastLegendToggle").setAttribute("aria-expanded", String(open));
  });

  try {
    await loadIndex();
  } catch {
    $("coastMessage").textContent = "Coast map data isn't available right now — check your connection and try again.";
    $("coastMessage").hidden = false;
    return;
  }
  await Promise.all([loadMask().catch(() => {}), loadNames(), loadAccessAndBeaches()]);
  queueDraw();
  loadTide();
  prefetchAllTiles();
  // Keep "now" honest if the page is left open.
  setInterval(() => {
    if (coast.offsetMin === 0) { resetBaseTime(); updateTimeLabel(); queueDraw(); }
  }, 60000);
}

initCoast();
