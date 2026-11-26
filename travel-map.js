// ==== Travel page locator map ====
//
// A small continent map beside the destination's local time: country
// borders, big lakes, blue sea, and a red dot on the destination. About
// 5,500 km across, so it says "where in the world" at a glance.
//
// (v167 put a detailed 560 km map behind the clock, with this continent
// map as an inset for inland places only. v168, on request: the
// continent map alone, always shown, and water always blue.)
//
// Natural Earth data (public domain, no credit needed), saved with the
// app as data/world-countries.json (built by scripts/build-world-map.py).
// (Renamed from world-110m.json in v170: phones kept v167's old file of
// that name, in a different format, and drew only sea.) No
// weather data and no API calls: it works with no signal once saved.

const TRAVEL_MAP_WIDTH_KM = 5500;
const TRAVEL_MAP_WATER = "#b9d8ef";
const TRAVEL_MAP_LAND = "#fbfaf4";
let travelWorld = null;
let travelWorldLoading = null;

function travelDecode(arr, q) {
  const pts = [];
  let x = 0, y = 0;
  for (let i = 0; i < arr.length; i += 2) {
    if (i === 0) { x = arr[0]; y = arr[1]; } else { x += arr[i]; y += arr[i + 1]; }
    pts.push([x / q, y / q]);
  }
  return pts;
}

function travelBox(pts) {
  let a = 180, b = 90, c = -180, d = -90;
  pts.forEach(([x, y]) => { if (x < a) a = x; if (x > c) c = x; if (y < b) b = y; if (y > d) d = y; });
  return [a, b, c, d];
}

function travelLoadWorld() {
  if (travelWorldLoading) return travelWorldLoading;
  const url = "data/world-countries.json";
  const get = typeof fetchWithTimeout === "function" ? fetchWithTimeout(url, {}, 20000) : fetch(url);
  travelWorldLoading = get
    .then(r => (r.ok ? r.json() : null))
    .then(w => {
      if (!w || !w.countries) return false;
      const rings = [];
      w.countries.forEach(c => c.forEach(r => rings.push(travelDecode(r, w.q))));
      const lakes = (w.lakes || []).map(r => travelDecode(r, w.q));
      travelWorld = { rings, ringBoxes: rings.map(travelBox), lakes, lakeBoxes: lakes.map(travelBox) };
      return true;
    })
    .catch(() => { travelWorldLoading = null; return false; });
  return travelWorldLoading;
}

function travelMutedColour() {
  const v = (getComputedStyle(document.documentElement).getPropertyValue("--accent-muted") || "").trim();
  return v || "#4c6a58";
}

// Longitude difference folded into -180..180, so a place near the date
// line still draws the land on both sides of it.
function travelLonDiff(lon, lon0) {
  let d = lon - lon0;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return d;
}

function travelProjector(lat0, lon0, widthKm, w, h) {
  const kmPerDegLat = 110.57;
  const kmPerDegLon = 111.32 * Math.cos(lat0 * Math.PI / 180);
  const s = w / widthKm;
  const cx = w / 2, cy = h / 2;
  const project = (lon, lat) => [cx + travelLonDiff(lon, lon0) * kmPerDegLon * s, cy - (lat - lat0) * kmPerDegLat * s];
  const halfLat = (h / 2 / s) / kmPerDegLat;
  const halfLon = (w / 2 / s) / Math.max(1, kmPerDegLon);
  const boxVisible = ([a, b, c, d]) => {
    if (d < lat0 - halfLat * 1.3 - 1 || b > lat0 + halfLat * 1.3 + 1) return false;
    if (c - a > 300) return true; // spans the date line: just draw it
    const l = travelLonDiff(a, lon0), r = travelLonDiff(c, lon0);
    if (l <= r) return !(r < -halfLon * 1.3 - 1 || l > halfLon * 1.3 + 1);
    return true;
  };
  return { project, boxVisible };
}

function travelPath(ctx, pts, project, lon0) {
  let prevD = null;
  pts.forEach(([lon, lat], i) => {
    const [x, y] = project(lon, lat);
    // Don't join two points either side of the meridian opposite the
    // map centre (they'd be drawn as a line right across the map).
    const d = travelLonDiff(lon, lon0);
    if (i === 0 || Math.abs(d - prevD) > 180) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    prevD = d;
  });
  ctx.closePath();
}

function travelSizeCanvas(canvas) {
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  const w = Math.max(1, Math.round(rect.width)), h = Math.max(1, Math.round(rect.height));
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

async function drawTravelMap(canvas, lat, lon) {
  if (!canvas) return;
  const ok = await travelLoadWorld();
  const { ctx, w, h } = travelSizeCanvas(canvas);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = TRAVEL_MAP_WATER;
  ctx.fillRect(0, 0, w, h);
  const { project, boxVisible } = travelProjector(lat, lon, TRAVEL_MAP_WIDTH_KM, w, h);

  if (ok && travelWorld) {
    const W = travelWorld;
    ctx.beginPath();
    W.rings.forEach((r, i) => { if (boxVisible(W.ringBoxes[i])) travelPath(ctx, r, project, lon); });
    ctx.fillStyle = TRAVEL_MAP_LAND;
    ctx.fill("evenodd");
    ctx.save();
    ctx.globalAlpha = 0.45;
    ctx.strokeStyle = travelMutedColour();
    ctx.lineWidth = 0.7;
    ctx.stroke();
    ctx.restore();

    ctx.beginPath();
    W.lakes.forEach((r, i) => { if (boxVisible(W.lakeBoxes[i])) travelPath(ctx, r, project, lon); });
    ctx.fillStyle = TRAVEL_MAP_WATER;
    ctx.fill();
  }

  // The destination: red dot with a white ring.
  const [x, y] = project(lon, lat);
  ctx.beginPath();
  ctx.arc(x, y, 5, 0, Math.PI * 2);
  ctx.fillStyle = "#ffffff";
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x, y, 3.5, 0, Math.PI * 2);
  ctx.fillStyle = "#d0342c";
  ctx.fill();
}
