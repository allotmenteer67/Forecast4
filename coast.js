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
// Coming in later parts: ways off the beach and time until each is cut
// (3b), a pin and own position (3c), rescue position entry (3d).

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

// Colours (dark map, readable at night).
const C = {
  sea: [22, 34, 52],
  covered: [43, 95, 138],
  soon: [63, 200, 215],
  sand: [214, 196, 150],
  land: [104, 136, 92],
  steep: [222, 156, 58],
  cliff: [205, 70, 60],
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
  status: ""
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
    e.codes = null; e.slopes = null; e.flags = null; e.canvas = null; e.renderKey = null;
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
  const key = lv ? `${lv.now.toFixed(2)}|${lv.later.toFixed(2)}` : "none";
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

  if (coast.view.mpp <= NAMES_MPP) drawNames();
  drawScaleBar();
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
  coast.baseTime = Math.floor(Date.now() / step) * step;
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
  await Promise.all([loadMask().catch(() => {}), loadNames()]);
  queueDraw();
  loadTide();
  prefetchAllTiles();
  // Keep "now" honest if the page is left open.
  setInterval(() => {
    if (coast.offsetMin === 0) { resetBaseTime(); updateTimeLabel(); queueDraw(); }
  }, 60000);
}

initCoast();
