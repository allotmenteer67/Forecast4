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
// Step 3c adds:
//   - a pin: tap "Pin", then tap the map. It's saved under
//     cloude-callout:spot (the key callout.js reads), so the callout
//     screen's weather, sea and tide switch to that spot. It stays until
//     "Clear" here, or "Back to normal" on the callout screen.
//     With the pin, the distance and bearing to the nearest dry ground
//     and the nearest way off are worked out here and saved with it, so
//     the callout screen can show them without loading the map data.
//   - "Me": the phone's own position (GPS), live, with its accuracy, and
//     the distance and bearing from you to the pin. Handy in fog.
//   Bearings were true (°T) in 3c; from 3d they're shown magnetic (°M).
//
// Double-tap zoom has been removed, as on the weather map: a tap now
// places the pin, and the + / − buttons zoom.
//
// Step 3d adds rescue position entry ("Position" button), as positions
// are reported to crew:
//   - latitude/longitude, typed almost any way (decimal degrees, degrees
//     and decimal minutes as the coastguard gives them, or degrees,
//     minutes and seconds)
//   - from a place: "2 miles SW of Broad Haven", or a bearing in degrees
//     from a named point, my position or the pin. With a distance it
//     sets the pin; with a bearing and no distance it draws a line
//     ("somewhere along here"), and a distance can be added later.
// and switches bearings to magnetic. Magnetic variation is from the World
// Magnetic Model (WMM2025) for the middle of the bay; across the bay it
// differs by under 0.1°. Distances are in nautical miles by default.

const COAST_BASE = "data/coast/stbrides/";
const COAST_TILE_DIR = COAST_BASE + "heights/";
// The tide gauge for the whole bay (tide.js picks Milford Haven).
const COAST_TIDE_POINT = { lat: 51.75, lon: -5.15 };
// Where the map opens if nothing else is chosen: Little Haven.
const COAST_START = { lat: 51.775, lon: -5.11, mpp: 6 };
const COAST_VIEW_KEY = "cloude-coast:view";
const CALLOUT_SPOT_KEY = "cloude-callout:spot"; // shared with callout.js
const NM = 1852;
const STATUTE_MILE = 1609.344;
const LINE_KEY = "cloude-coast:line"; // a bearing line with no distance yet
// Magnetic variation (declination) for St Brides Bay (51.78°N 5.17°W)
// from the World Magnetic Model WMM2025, which is exactly linear in time
// over its life (2025.0-2030.0): about 0.5° west in late 2026, passing
// through zero around the end of 2029. East is positive.
const WMM = { epoch: 2025.0, decl: -0.872, perYear: 0.1865, validTo: 2030.0 };
function declinationNow() {
  const now = new Date();
  const year = now.getUTCFullYear() + (now - Date.UTC(now.getUTCFullYear(), 0, 1)) / (365.25 * 86400000);
  return WMM.decl + WMM.perYear * (Math.min(year, WMM.validTo) - WMM.epoch);
}
function trueToMag(t) { return ((t - declinationNow()) % 360 + 360) % 360; }
function magToTrue(m) { return ((m + declinationNow()) % 360 + 360) % 360; }

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
const SERIES_HOURS = 30;
// Foreshore the survey couldn't see (hatched grey) has no height. It's
// treated as walkable when the tide is below this level (m OD, about
// 2.7 m above Chart Datum at Milford Haven) — around low water it's
// almost certainly exposed sand or rock — and as water above it. Without
// this, a low-tide beach next to unsurveyed sand showed as cut off.
const UNSURVEYED_DRY_OD = -1.0;
// Pink (cut off) is only shown for stranded patches that come within
// this many cells (~60 m) of land above beach height — the whole patch,
// so a wide stranded beach is pink right down to the water's edge. Out
// in the bay, isolated low "ground" is mostly laser returns off the
// water surface at survey time, or lone rocks: neither is where people
// get cut off, and pink there just looked like the sea was cut off.
const CUTOFF_NEAR_SHORE_CELLS = 30;       // far enough ahead to cover the slider (24 h) plus a tide

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
  lowWater: [],        // OS mean low water: { pts: [[lat, lon]...], south, west, north, east }
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
  cutoffTimer: null,
  pin: null,           // { lat, lon, ... } as saved under CALLOUT_SPOT_KEY
  pinMode: false,      // next tap on the map places the pin
  me: null,            // { lat, lon, acc } from the phone's GPS
  show: { shore: false, way: false }, // lines drawn from the pin when its card lines are tapped
  line: null,          // { lat, lon, bearingT, label } a reported bearing with no distance
  entry: { mode: "latlon", place: null, dir: null, unit: "nm", bearingType: "M" },
  meWatch: null,
  meError: ""
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

// ---- Distances, bearings and positions ----
function distanceM(a, b) {
  const dx = (b.lon - a.lon) * KX, dy = (b.lat - a.lat) * KY;
  return Math.hypot(dx, dy);
}
// True bearing from a to b, 0-359.
function bearingT(a, b) {
  const dx = (b.lon - a.lon) * KX, dy = (b.lat - a.lat) * KY;
  return (Math.round(Math.atan2(dx, dy) * 180 / Math.PI) + 360) % 360;
}
function distText(m) {
  return m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / NM).toFixed(m < 10 * NM ? 2 : 1)} nm`;
}
// Bearings are worked out true and shown magnetic.
function bearingText(degTrue) { return `${String(Math.round(trueToMag(degTrue)) % 360).padStart(3, "0")}°M`; }
// Degrees and decimal minutes, as the coastguard gives positions.
function degMin(lat, lon) {
  const f = (v, pos, neg, w) => {
    const a = Math.abs(v);
    let d = Math.floor(a), m = (a - d) * 60;
    if (m >= 59.995) { d += 1; m = 0; }
    return `${String(d).padStart(w, "0")}°${m.toFixed(2).padStart(5, "0")}′${v >= 0 ? pos : neg}`;
  };
  return `${f(lat, "N", "S", 2)} ${f(lon, "E", "W", 1)}`;
}

// ---- Pin ----
function loadPin() {
  const p = readJson(CALLOUT_SPOT_KEY, null);
  coast.pin = p && typeof p.lat === "number" && typeof p.lon === "number" ? p : null;
}

async function setPin(lat, lon, source) {
  coast.pin = { lat, lon, setAt: Date.now() };
  if (source) coast.pin.source = source;
  coast.show = { shore: false, way: false };
  writeJson(CALLOUT_SPOT_KEY, coast.pin);
  updatePinCard();
  queueDraw();
  await describePin();
}

function clearPin() {
  coast.pin = null;
  coast.line = null;
  try { localStorage.removeItem(CALLOUT_SPOT_KEY); localStorage.removeItem(LINE_KEY); } catch { /* ignore */ }
  updatePinCard();
  queueDraw();
}

// Nearest dry ground (now) and nearest way off, saved with the pin so
// the callout screen can show them.
async function describePin() {
  const pin = coast.pin;
  if (!pin || !coast.index) return;
  const shore = await nearestDryGround(pin);
  if (coast.pin !== pin) return; // moved meanwhile
  let way = null;
  for (const a of coast.access) {
    const d = distanceM(pin, a);
    if (!way || d < way.distM) way = { distM: d, a };
  }
  pin.shore = shore ? { distM: Math.round(shore.distM), bearing: bearingT(pin, shore), bearingM: Math.round(trueToMag(bearingT(pin, shore))) % 360, lat: shore.lat, lon: shore.lon } : null;
  if (way) {
    const ct = cutTimeFromNow(way.a.foot);
    pin.wayOff = {
      distM: Math.round(way.distM), bearing: bearingT(pin, way.a), bearingM: Math.round(trueToMag(bearingT(pin, way.a))) % 360, lat: way.a.lat, lon: way.a.lon,
      kind: way.a.kind, cut: ct ? (ct.state === "now" ? "cut now" : ct.state === "at" ? `cut ${clockTime(ct.time)}` : "above high tide") : null
    };
  } else pin.wayOff = null;
  writeJson(CALLOUT_SPOT_KEY, pin);
  updatePinCard();
}

// Cut time from the real "now", whatever the slider says.
function cutTimeFromNow(footOd) {
  const saved = coast.offsetMin;
  coast.offsetMin = 0;
  const r = cutTime(footOd);
  coast.offsetMin = saved;
  return r;
}

// Searches the detailed tiles within ~1.5 km of the point for the
// closest ground that's dry at the current real time; beyond that, the
// coarse land outline. Returns { lat, lon, distM } or null.
async function nearestDryGround(pt) {
  const g = coast.index.grid, T = g.tileSize;
  const now = tideOdAt(new Date());
  const cover = now === null ? 0 : codeFor(now);
  const row = Math.floor((g.north - pt.lat) / g.dLat);
  const col = Math.floor((pt.lon - g.west) / g.dLon);
  const tr = Math.floor(row / T), tc = Math.floor(col / T);
  let best = null;
  const near = coast.index.tiles.filter(t => Math.abs(t.r - tr) <= 1 && Math.abs(t.c - tc) <= 1);
  for (const meta of near) {
    const e = tileEntry(meta);
    e.used = performance.now();
    if (!e.codes) await decodeTile(e);
    if (!e.codes) continue;
    for (let y = 0; y < T; y++) {
      const gy = meta.r * T + y;
      for (let x = 0; x < T; x++) {
        const code = e.codes[y * T + x];
        if (code === 0 || code <= cover) continue;
        const gx = meta.c * T + x;
        const dy = (gy - row) * g.dLat * KY, dx = (gx - col) * g.dLon * KX;
        const d2 = dx * dx + dy * dy;
        if (!best || d2 < best.d2) best = { d2, gy, gx };
      }
    }
  }
  if (best) {
    return { lat: g.north - (best.gy + 0.5) * g.dLat, lon: g.west + (best.gx + 0.5) * g.dLon, distM: Math.sqrt(best.d2) };
  }
  if (!coast.mask) return null;
  const m = coast.mask, c = m.canvas;
  const p = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
  for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
    if (p[(y * c.width + x) * 4 + 3] === 0) continue;
    const lat = g.north - (y + 0.5) * m.dLat, lon = g.west + (x + 0.5) * m.dLon;
    const d = distanceM(pt, { lat, lon });
    if (!best || d < best.distM) best = { lat, lon, distM: d };
  }
  return best;
}

// ---- Own position ----
function toggleMe() {
  if (coast.meWatch !== null) {
    navigator.geolocation.clearWatch(coast.meWatch);
    coast.meWatch = null; coast.me = null; coast.meError = "";
    $("coastMeBtn").classList.remove("on");
    updatePinCard(); queueDraw();
    return;
  }
  if (!("geolocation" in navigator)) { coast.meError = "Location isn't available on this device"; updatePinCard(); return; }
  $("coastMeBtn").classList.add("on");
  coast.meError = "Finding your position…";
  updatePinCard();
  let first = true;
  coast.meWatch = navigator.geolocation.watchPosition(pos => {
    coast.me = { lat: pos.coords.latitude, lon: pos.coords.longitude, acc: pos.coords.accuracy };
    coast.meError = "";
    if (first) { first = false; coast.view.lat = coast.me.lat; coast.view.lon = coast.me.lon; clampView(); }
    updatePinCard(); queueDraw();
  }, err => {
    coast.meError = err.code === 1 ? "Location permission is off for this app" : "Can't get a position right now";
    updatePinCard();
  }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 });
}

// ---- Pin / position card (bottom of the map) ----
function updatePinCard() {
  const card = $("coastPinCard");
  const lines = [];
  const pin = coast.pin;
  if (pin) {
    lines.push(`<div class="pc-title"><span class="pc-pin"></span>Pin · ${degMin(pin.lat, pin.lon)}</div>`);
    if (pin.source) lines.push(`<div class="pc-dim">Reported: ${escapeHtml(pin.source)}</div>`);
    // These two lines can be tapped to draw the route from the pin.
    if (pin.shore) lines.push(`<div class="pc-tap${coast.show.shore ? " on" : ""}" data-show="shore">Nearest dry ground now: <b>${distText(pin.shore.distM)}</b> ${bearingText(pin.shore.bearing)}<span class="pc-show">${coast.show.shore ? "hide" : "show"}</span></div>`);
    if (pin.wayOff) lines.push(`<div class="pc-tap way${coast.show.way ? " on" : ""}" data-show="way">Nearest way off: <b>${distText(pin.wayOff.distM)}</b> ${bearingText(pin.wayOff.bearing)}${pin.wayOff.cut ? ` · ${pin.wayOff.cut}` : ""}<span class="pc-show">${coast.show.way ? "hide" : "show"}</span></div>`);
  }
  if (coast.line) {
    lines.push(`<div class="pc-title"><span class="pc-line"></span>Line ${escapeHtml(coast.line.label)}</div><div class="pc-dim">Somewhere along the orange line — add a distance with Position to set the pin.</div>`);
  }
  if (coast.me) {
    const acc = Math.round(coast.me.acc);
    let line = `<div class="pc-title"><span class="pc-me"></span>You · ${degMin(coast.me.lat, coast.me.lon)} <span class="pc-dim">±${acc} m</span></div>`;
    if (pin) line += `<div>To pin: <b>${distText(distanceM(coast.me, pin))}</b> ${bearingText(bearingT(coast.me, pin))}</div>`;
    lines.push(line);
  } else if (coast.meError) {
    lines.push(`<div class="pc-dim">${coast.meError}</div>`);
  }
  if (coast.pinMode) lines.unshift(`<div class="pc-hint">Tap the map to place the pin</div>`);
  // Clear (pin and line) lives on the card, so the button row fits a phone.
  if (pin || coast.line) lines.unshift(`<button class="pc-clear" type="button">Clear</button>`);
  card.innerHTML = lines.join("");
  const clearBtn = card.querySelector(".pc-clear");
  if (clearBtn) clearBtn.addEventListener("click", () => { coast.pinMode = false; clearPin(); });
  card.hidden = lines.length === 0;
  card.querySelectorAll(".pc-tap").forEach(el => el.addEventListener("click", () => {
    const which = el.dataset.show;
    coast.show[which] = !coast.show[which];
    const target = which === "shore" ? coast.pin && coast.pin.shore : coast.pin && coast.pin.wayOff;
    if (coast.show[which] && target && typeof target.lat === "number") fitPinAnd(target);
    updatePinCard();
  }));
  $("coastPinBtn").classList.toggle("on", coast.pinMode);
  $("coastPinBtn").setAttribute("aria-label", pin ? "Move the pin" : "Place a pin");
  queueDraw();
}

// ---- Rescue position entry ----
function escapeHtml(t) {
  return String(t).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]));
}

// Reads a typed latitude/longitude, as forgivingly as possible:
//   51 46.2N 5 08.7W     51°46.2′N 5°08.7′W     N51 46.2 W005 08.7
//   51.770 -5.145        51.77N 5.145W          51 46 12N 5 08 42W
// With no E/W given, a positive longitude is taken as west (this map is
// in west Wales). Returns { lat, lon } or null.
function parseLatLon(text) {
  const t = String(text).toUpperCase().replace(/[°º′'’″"”:,;]/g, " ").replace(/\s+/g, " ").trim();
  if (!t) return null;
  const hasS = /S/.test(t), hasE = /E/.test(t), hasW = /W/.test(t);
  // Split at the first longitude letter or into numbers.
  const nums = (t.match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
  let lat, lon;
  const dm = (d, m, sec = 0) => Math.abs(d) + m / 60 + sec / 3600;
  if (nums.length === 2) { lat = Math.abs(nums[0]); lon = Math.abs(nums[1]); if (nums[1] < 0) lon = -lon; if (nums[0] < 0) lat = -lat; }
  else if (nums.length === 4) { lat = dm(nums[0], nums[1]); lon = dm(nums[2], nums[3]); if (nums[0] < 0) lat = -lat; if (nums[2] < 0) lon = -lon; }
  else if (nums.length === 6) { lat = dm(nums[0], nums[1], nums[2]); lon = dm(nums[3], nums[4], nums[5]); if (nums[0] < 0) lat = -lat; if (nums[3] < 0) lon = -lon; }
  else return null;
  if (hasS && lat > 0) lat = -lat;
  if (hasW && lon > 0) lon = -lon;
  if (!hasE && !hasW && lon > 0) lon = -lon; // west Wales: assume west
  if (hasE && lon < 0) lon = -lon;
  if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) return null;
  return { lat, lon };
}

const COMPASS_POINTS = { N: 0, NNE: 22.5, NE: 45, ENE: 67.5, E: 90, ESE: 112.5, SE: 135, SSE: 157.5, S: 180, SSW: 202.5, SW: 225, WSW: 247.5, W: 270, WNW: 292.5, NW: 315, NNW: 337.5 };

function normName(s) {
  return String(s).toLowerCase().replace(/\([^)]*\)/g, " ").replace(/['’]/g, "").replace(/[^a-z0-9]+/g, " ").trim().replace(/^the /, "");
}

// Places to measure from: my position and the pin first (if set), then
// names (with their other names) matching what's typed.
function placeMatches(q) {
  const out = [];
  const nq = normName(q);
  if (coast.me) out.push({ name: "My position", lat: coast.me.lat, lon: coast.me.lon, special: true });
  if (coast.pin) out.push({ name: "The pin", lat: coast.pin.lat, lon: coast.pin.lon, special: true });
  if (!nq) return out.slice(0, 2);
  const scored = [];
  for (const n of coast.names) {
    const all = [n.name, ...(n.alt || [])];
    let best = 0, via = null;
    for (const a of all) {
      const na = normName(a);
      const sc = na === nq ? 3 : na.startsWith(nq) ? 2 : na.includes(nq) ? 1 : 0;
      if (sc > best) { best = sc; via = a; }
    }
    if (best) scored.push({ sc: best, name: n.name, via: via !== n.name ? via : null, kind: n.kind, lat: n.lat, lon: n.lon });
  }
  scored.sort((a, b) => b.sc - a.sc || a.name.localeCompare(b.name));
  return [...out.filter(p => normName(p.name).includes(nq)), ...scored.slice(0, 8)];
}

function openEntry() {
  $("coastEntry").hidden = false;
  coast.pinMode = false;
  renderEntry();
  updatePinCard();
}
function closeEntry() { $("coastEntry").hidden = true; }

function renderEntry() {
  const e = coast.entry;
  $("entTabLatLon").classList.toggle("on", e.mode === "latlon");
  $("entTabPlace").classList.toggle("on", e.mode === "place");
  $("entLatLon").hidden = e.mode !== "latlon";
  $("entPlace").hidden = e.mode !== "place";
  document.querySelectorAll("#entDirs button").forEach(b => b.classList.toggle("on", b.dataset.dir === e.dir));
  document.querySelectorAll("#entUnits button").forEach(b => b.classList.toggle("on", b.dataset.unit === e.unit));
  document.querySelectorAll("#entBType button").forEach(b => b.classList.toggle("on", b.dataset.bt === e.bearingType));
  $("entPlaceChosen").textContent = e.place ? `✓ ${e.place.name}` : "";
  updateEntryPreview();
}

function renderPlaceList() {
  const list = $("entPlaceList");
  const q = $("entPlaceInput").value;
  const items = placeMatches(q);
  list.innerHTML = items.map((p, i) =>
    `<button type="button" data-i="${i}">${escapeHtml(p.name)}${p.via ? ` <span class="ent-dim">(${escapeHtml(p.via)})</span>` : ""}${p.kind ? ` <span class="ent-dim">· ${escapeHtml(p.kind)}</span>` : ""}</button>`).join("");
  list.querySelectorAll("button").forEach(b => b.addEventListener("click", () => {
    const p = items[Number(b.dataset.i)];
    coast.entry.place = { name: p.name, lat: p.lat, lon: p.lon };
    $("entPlaceInput").value = p.name;
    list.innerHTML = "";
    renderEntry();
  }));
}

// What the "from a place" fields add up to: a point, or a line.
function placeResult() {
  const e = coast.entry;
  if (!e.place) return { error: "Choose a place to measure from" };
  const bearingNum = parseFloat($("entBearing").value);
  let bT = null, dirText = "";
  if (!isNaN(bearingNum)) {
    const b = ((bearingNum % 360) + 360) % 360;
    bT = e.bearingType === "M" ? magToTrue(b) : b;
    dirText = `${String(Math.round(b)).padStart(3, "0")}°${e.bearingType}`;
  } else if (e.dir) {
    bT = COMPASS_POINTS[e.dir];
    dirText = e.dir;
  }
  if (bT === null) return { error: "Choose a direction, or type a bearing" };
  const dist = parseFloat($("entDist").value);
  if (isNaN(dist) || dist <= 0) {
    return { line: { lat: e.place.lat, lon: e.place.lon, bearingT: bT, label: `${dirText} from ${e.place.name}` } };
  }
  const unitM = e.unit === "nm" ? NM : e.unit === "mi" ? STATUTE_MILE : 1;
  const unitText = e.unit === "nm" ? "nm" : e.unit === "mi" ? (dist === 1 ? "mile" : "miles") : "m";
  const pt = destination(e.place, bT, dist * unitM);
  return { point: pt, source: `${dist} ${unitText} ${dirText} of ${e.place.name}` };
}

function updateEntryPreview() {
  const el = $("entPreview");
  if (coast.entry.mode === "latlon") {
    const p = parseLatLon($("entLatLonInput").value);
    el.textContent = p ? `= ${degMin(p.lat, p.lon)}` : ($("entLatLonInput").value ? "Can't read that yet" : "");
    el.classList.toggle("bad", !p && !!$("entLatLonInput").value);
    $("entGo").textContent = "Set pin";
    return;
  }
  const r = placeResult();
  el.classList.toggle("bad", !!r.error);
  if (r.error) { el.textContent = r.error; $("entGo").textContent = "Set"; return; }
  if (r.line) { el.textContent = `Line ${r.line.label} — no distance, so no pin yet`; $("entGo").textContent = "Draw line"; return; }
  el.textContent = `Pin ${r.source} = ${degMin(r.point.lat, r.point.lon)}`;
  $("entGo").textContent = "Set pin";
}

function applyEntry() {
  if (coast.entry.mode === "latlon") {
    const p = parseLatLon($("entLatLonInput").value);
    if (!p) return;
    coast.line = null;
    try { localStorage.removeItem(LINE_KEY); } catch { /* ignore */ }
    setPin(p.lat, p.lon); // the card already shows the position
    centreOn(p);
  } else {
    const r = placeResult();
    if (r.error) return;
    if (r.line) {
      coast.line = r.line;
      writeJson(LINE_KEY, r.line);
      const far = destination(r.line, r.line.bearingT, 3 * NM);
      centreOn({ lat: (r.line.lat + far.lat) / 2, lon: (r.line.lon + far.lon) / 2 }, 3.5 * NM);
    } else {
      coast.line = null;
      try { localStorage.removeItem(LINE_KEY); } catch { /* ignore */ }
      setPin(r.point.lat, r.point.lon, r.source);
      centreOn(r.point);
    }
  }
  closeEntry();
  updatePinCard();
  queueDraw();
}

function centreOn(p, spanM) {
  coast.view.lat = p.lat; coast.view.lon = p.lon;
  if (spanM) coast.view.mpp = Math.max(coast.view.mpp, spanM / Math.max(Math.min(coast.w, coast.h), 200));
  clampView();
}

function setUpEntry() {
  $("coastPosBtn").addEventListener("click", openEntry);
  $("entClose").addEventListener("click", closeEntry);
  $("entTabLatLon").addEventListener("click", () => { coast.entry.mode = "latlon"; renderEntry(); });
  $("entTabPlace").addEventListener("click", () => { coast.entry.mode = "place"; renderEntry(); renderPlaceList(); });
  $("entLatLonInput").addEventListener("input", updateEntryPreview);
  $("entPlaceInput").addEventListener("input", () => { coast.entry.place = null; renderPlaceList(); renderEntry(); });
  $("entPlaceInput").addEventListener("focus", renderPlaceList);
  $("entBearing").addEventListener("input", () => { if ($("entBearing").value) coast.entry.dir = null; renderEntry(); });
  $("entDist").addEventListener("input", updateEntryPreview);
  document.querySelectorAll("#entDirs button").forEach(b => b.addEventListener("click", () => {
    coast.entry.dir = coast.entry.dir === b.dataset.dir ? null : b.dataset.dir;
    $("entBearing").value = "";
    renderEntry();
  }));
  document.querySelectorAll("#entUnits button").forEach(b => b.addEventListener("click", () => { coast.entry.unit = b.dataset.unit; renderEntry(); }));
  document.querySelectorAll("#entBType button").forEach(b => b.addEventListener("click", () => { coast.entry.bearingType = b.dataset.bt; renderEntry(); }));
  $("entGo").addEventListener("click", applyEntry);
  $("entVariation").textContent = `Magnetic variation here: ${Math.abs(declinationNow()).toFixed(1)}° ${declinationNow() < 0 ? "W" : "E"} (WMM2025).`;
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

// The Ordnance Survey mean low water line (optional: older data sets
// don't have it, and the map works the same without).
async function loadLowWater() {
  try {
    const res = await fetch(COAST_BASE + "low-water.json");
    if (!res.ok) return;
    const data = await res.json();
    coast.lowWater = (data.lines || []).filter(l => Array.isArray(l) && l.length >= 2).map(pts => {
      let south = 90, north = -90, west = 180, east = -180;
      for (const [la, lo] of pts) {
        if (la < south) south = la; if (la > north) north = la;
        if (lo < west) west = lo; if (lo > east) east = lo;
      }
      return { pts, south, west, north, east };
    });
  } catch { /* optional */ }
}

// Drawn as a dotted pale line, with a dark edge so it shows on sand and
// sea alike. Dots, not dashes, so it can't be mistaken for the dashed
// line from the pin to dry ground.
function drawLowWater() {
  if (!coast.lowWater.length) return;
  const { ctx } = coast;
  const vb = viewBounds();
  const path = new Path2D();
  let any = false;
  for (const l of coast.lowWater) {
    if (l.east < vb.west || l.west > vb.east || l.north < vb.south || l.south > vb.north) continue;
    const pts = l.pts;
    let p = toScreen(pts[0][0], pts[0][1]);
    path.moveTo(p.x, p.y);
    let lx = p.x, ly = p.y;
    for (let i = 1; i < pts.length; i++) {
      p = toScreen(pts[i][0], pts[i][1]);
      // Skip points less than half a pixel on, zoomed right out.
      if (i < pts.length - 1 && Math.abs(p.x - lx) < 0.5 && Math.abs(p.y - ly) < 0.5) continue;
      path.lineTo(p.x, p.y);
      lx = p.x; ly = p.y;
    }
    any = true;
  }
  if (!any) return;
  const close = coast.view.mpp <= 6;
  ctx.save();
  ctx.lineCap = "round";
  ctx.setLineDash([0, close ? 6 : 5]);
  ctx.lineWidth = close ? 4.5 : 3.5; ctx.strokeStyle = "rgba(10,12,16,0.7)"; ctx.stroke(path);
  ctx.lineWidth = close ? 2.5 : 2; ctx.strokeStyle = "rgba(240,244,248,0.95)"; ctx.stroke(path);
  ctx.restore();
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
  const unsurveyedDry = lv.now < UNSURVEYED_DRY_OD;
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
        const k = dst + x;
        if (code === 0) {
          if (unsurveyedDry && e.flags && e.flags[src + x]) state[k] = 1;
          continue;
        }
        if (code <= coverCode) continue;
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
  // How far each cell is from land above beach height (up to the limit).
  const near = new Uint8Array(N);
  {
    let h0 = 0, h1 = 0;
    for (let k = 0; k < N; k++) if (high[k]) { near[k] = 1; queue[h1++] = k; }
    while (h0 < h1) {
      const k = queue[h0++];
      const d = near[k];
      if (d > CUTOFF_NEAR_SHORE_CELLS) continue;
      const y = (k / W) | 0, x = k - y * W;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= H) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= W) continue;
          const n = yy * W + xx;
          if (!near[n]) { near[n] = d + 1; queue[h1++] = n; }
        }
      }
    }
  }
  // Stranded patches that reach near the shore: spread from their
  // near-shore cells through the rest of the stranded ground (state 1,
  // not reached from any way out). Marked as state 4.
  {
    let h0 = 0, h1 = 0;
    for (let k = 0; k < N; k++) if (state[k] === 1 && near[k]) { state[k] = 4; queue[h1++] = k; }
    while (h0 < h1) {
      const k = queue[h0++];
      const y = (k / W) | 0, x = k - y * W;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= H) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= W) continue;
          const n = yy * W + xx;
          if (state[n] === 1) { state[n] = 4; queue[h1++] = n; }
        }
      }
    }
  }
  // Mark the stranded dry beach-height cells, per tile.
  for (const e of coast.tiles.values()) e.cut = null;
  for (let pr = 0; pr < rows; pr++) for (let pc = 0; pc < cols; pc++) {
    const e = patch[pr * cols + pc];
    if (!e) continue;
    let cut = null;
    for (let y = 0; y < T; y++) {
      const src = y * T, dst = (pr * T + y) * W + pc * T;
      for (let x = 0; x < T; x++) {
        const k = dst + x;
        const code = e.codes[src + x];
        if (state[k] === 4 && code !== 0 && code <= sandCode) {
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
      // Foreshore the survey couldn't see (blue channel 2: Ordnance
      // Survey foreshore, between mean low and mean high water; 1 in
      // tiles built before that): grey with a fine diagonal hatch.
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

  drawLowWater();
  if (coast.view.mpp <= CUTOFF_MPP) drawAccess();
  if (coast.view.mpp <= NAMES_MPP) drawNames();
  if (coast.view.mpp <= CUTOFF_MPP) drawBeachTimes();
  drawPinAndMe();
  scheduleCutoff();
  drawScaleBar();
}

// Make sure the pin and a target are both on screen (zooming out if
// needed, never in), leaving room for the time pill and the card.
function fitPinAnd(target) {
  const pin = coast.pin;
  const ptA = toScreen(pin.lat, pin.lon), ptB = toScreen(target.lat, target.lon);
  const inView = p => p.x > 30 && p.x < coast.w - 30 && p.y > 130 && p.y < coast.h - 130;
  if (inView(ptA) && inView(ptB)) return;
  coast.view.lat = (pin.lat + target.lat) / 2;
  coast.view.lon = (pin.lon + target.lon) / 2;
  const dx = Math.abs(target.lon - pin.lon) * KX, dy = Math.abs(target.lat - pin.lat) * KY;
  const need = Math.max(dx / Math.max(coast.w - 80, 100), dy / Math.max(coast.h - 280, 100));
  coast.view.mpp = Math.max(coast.view.mpp, need);
  clampView();
  queueDraw();
}

// A line from the pin to a target, with a ring at the far end.
function drawRouteLine(target, colour) {
  if (!target || typeof target.lat !== "number") return;
  const { ctx } = coast;
  const a = toScreen(coast.pin.lat, coast.pin.lon), b = toScreen(target.lat, target.lon);
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineWidth = 6; ctx.strokeStyle = "rgba(10,12,16,0.75)";
  ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  ctx.lineWidth = 3; ctx.strokeStyle = colour;
  ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  ctx.beginPath(); ctx.arc(b.x, b.y, 9, 0, Math.PI * 2);
  ctx.lineWidth = 3; ctx.stroke();
  ctx.restore();
}

// A reported bearing with no distance: an orange line from the point
// out to 12 nm, with ticks every nautical mile so a distance can be
// judged against it.
function drawBearingLine() {
  const L = coast.line;
  if (!L) return;
  const { ctx } = coast;
  const end = destination(L, L.bearingT, 12 * NM);
  const a = toScreen(L.lat, L.lon), b = toScreen(end.lat, end.lon);
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineWidth = 6; ctx.strokeStyle = "rgba(10,12,16,0.75)";
  ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  ctx.lineWidth = 3; ctx.strokeStyle = "#ff9a3c";
  ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  ctx.font = "600 11px -apple-system, BlinkMacSystemFont, sans-serif";
  ctx.textBaseline = "middle";
  for (let n = 1; n <= 12; n++) {
    const p = destination(L, L.bearingT, n * NM);
    const s2 = toScreen(p.lat, p.lon);
    if (s2.x < -20 || s2.y < -20 || s2.x > coast.w + 20 || s2.y > coast.h + 20) continue;
    ctx.beginPath(); ctx.arc(s2.x, s2.y, 4, 0, Math.PI * 2); ctx.fillStyle = "#ff9a3c"; ctx.fill();
    ctx.lineWidth = 3; ctx.strokeStyle = "rgba(12,16,22,0.9)";
    ctx.strokeText(`${n} nm`, s2.x + 7, s2.y); ctx.fillStyle = "#ffd2a8"; ctx.fillText(`${n} nm`, s2.x + 7, s2.y);
  }
  ctx.beginPath(); ctx.arc(a.x, a.y, 6, 0, Math.PI * 2); ctx.fillStyle = "#ff9a3c"; ctx.fill();
  ctx.restore();
}

function destination(from, bearingTrue, distM) {
  const b = bearingTrue * Math.PI / 180;
  const kx = 111320 * Math.cos(from.lat * Math.PI / 180);
  return { lat: from.lat + distM * Math.cos(b) / KY, lon: from.lon + distM * Math.sin(b) / kx };
}

function drawPinAndMe() {
  const { ctx } = coast;
  const pin = coast.pin, me = coast.me;
  drawBearingLine();
  if (pin && coast.show.shore) drawRouteLine(pin.shore, "#ffe08a");
  if (pin && coast.show.way) drawRouteLine(pin.wayOff, "#5fe08a");
  if (pin && me) {
    const a = toScreen(me.lat, me.lon), b = toScreen(pin.lat, pin.lon);
    ctx.save();
    ctx.setLineDash([6, 5]); ctx.lineWidth = 2; ctx.strokeStyle = "rgba(255,255,255,0.85)";
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    ctx.restore();
  }
  if (me) {
    const s = toScreen(me.lat, me.lon);
    const r = Math.max(me.acc / coast.view.mpp, 8);
    ctx.beginPath(); ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(80,150,255,0.18)"; ctx.fill();
    ctx.lineWidth = 1; ctx.strokeStyle = "rgba(120,180,255,0.6)"; ctx.stroke();
    ctx.beginPath(); ctx.arc(s.x, s.y, 7, 0, Math.PI * 2);
    ctx.fillStyle = "#3d8bff"; ctx.fill();
    ctx.lineWidth = 2.5; ctx.strokeStyle = "#ffffff"; ctx.stroke();
  }
  if (pin) {
    const s = toScreen(pin.lat, pin.lon);
    // A map pin: a red head on a short stem, the point at the spot.
    ctx.lineWidth = 2; ctx.strokeStyle = "#0e1116";
    ctx.beginPath();
    ctx.moveTo(s.x, s.y);
    ctx.bezierCurveTo(s.x - 4, s.y - 10, s.x - 10, s.y - 14, s.x - 10, s.y - 21);
    ctx.arc(s.x, s.y - 21, 10, Math.PI, 0);
    ctx.bezierCurveTo(s.x + 10, s.y - 14, s.x + 4, s.y - 10, s.x, s.y);
    ctx.fillStyle = "#e5484d"; ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.arc(s.x, s.y - 21, 3.5, 0, Math.PI * 2); ctx.fillStyle = "#ffffff"; ctx.fill();
  }
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
    // Ways off above the reach of the tide need no label: the green
    // marker says it all, and it keeps busy spots like Little Haven clear.
    if (showTimes && ct && ct.state !== "clear") {
      const text = ct.state === "now" ? "cut" : `cut ${clockTime(ct.time)}`;
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
      if (times.some(t => t.state === "clear")) { text = "Way off above high tide"; colour = "#b8f0c8"; }
      else if (times.every(t => t.state === "now")) { text = "All ways off cut"; colour = "#f09595"; }
      else {
        const last = times.filter(t => t.state === "at").map(t => t.time).sort((x, y) => y - x)[0];
        text = `Last way off cut ${clockTime(last)} (in ${inText(last)})`;
        colour = "#fac775";
      }
    }
    const w = ctx.measureText(text).width;
    // Above the beach's middle, nudged further up if a way-off marker
    // sits right there.
    let y = s.y - 14;
    for (let tries = 0; tries < 4; tries++) {
      const clash = coast.access.some(a => {
        const m = toScreen(a.lat, a.lon);
        return Math.abs(m.y - y) < 14 && m.x > s.x - w / 2 - 12 && m.x < s.x + w / 2 + 12;
      });
      if (!clash) break;
      y -= 16;
    }
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
  // Top left (the bottom of the map is for the pin card; the time pill
  // is top right).
  const x = 14, y = 34;
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
  let tap = null; // a possible tap: start point, time; cancelled by moving

  c.addEventListener("pointerdown", ev => {
    c.setPointerCapture(ev.pointerId);
    pointers.set(ev.pointerId, { x: ev.offsetX, y: ev.offsetY });
    tap = pointers.size === 1 ? { x: ev.offsetX, y: ev.offsetY, t: Date.now(), moved: false } : null;
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinchStart = { dist: Math.hypot(a.x - b.x, a.y - b.y), mpp: coast.view.mpp };
    }
  });
  c.addEventListener("pointermove", ev => {
    const prev = pointers.get(ev.pointerId);
    if (!prev) return;
    const cur = { x: ev.offsetX, y: ev.offsetY };
    if (tap && Math.hypot(cur.x - tap.x, cur.y - tap.y) > 8) tap.moved = true;
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
  c.addEventListener("pointerup", ev => {
    const wasTap = tap && !tap.moved && pointers.size === 1 && Date.now() - tap.t < 600;
    end(ev);
    tap = null;
    if (wasTap && coast.pinMode) {
      const ll = toLatLon(ev.offsetX, ev.offsetY);
      coast.pinMode = false;
      setPin(ll.lat, ll.lon);
    }
  });
  c.addEventListener("pointercancel", end);
  c.addEventListener("wheel", ev => { ev.preventDefault(); zoomAt(ev.deltaY > 0 ? 1.2 : 1 / 1.2, ev.offsetX, ev.offsetY); }, { passive: false });

  $("coastPinBtn").addEventListener("click", () => { coast.pinMode = !coast.pinMode; updatePinCard(); });
  $("coastMeBtn").addEventListener("click", toggleMe);
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
  loadPin();
  const savedLine = readJson(LINE_KEY, null);
  if (savedLine && typeof savedLine.lat === "number") coast.line = savedLine;
  // Opened with a pin (e.g. from the callout screen): start there.
  if (coast.pin) { coast.view.lat = coast.pin.lat; coast.view.lon = coast.pin.lon; }
  resetBaseTime();
  resize();
  window.addEventListener("resize", resize);
  setUpGestures();
  setUpSlider();
  setUpEntry();
  updateTimeLabel();
  updatePinCard();
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
  await Promise.all([loadMask().catch(() => {}), loadNames(), loadAccessAndBeaches(), loadLowWater()]);
  queueDraw();
  loadTide().then(() => { if (coast.pin) describePin(); });
  prefetchAllTiles();
  // Keep "now" honest if the page is left open.
  setInterval(() => {
    if (coast.offsetMin === 0) { resetBaseTime(); updateTimeLabel(); queueDraw(); }
  }, 60000);
}

initCoast();
