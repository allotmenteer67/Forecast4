// ==== Travel page locator map ====
//
// A pale map behind the destination's local time: coastline, country
// borders, state/province lines for big countries, big rivers and lakes,
// a few large cities, and a red dot on the destination. Roughly 560 km
// across. For a place far enough inland that no sea shows, a small
// continent inset in the corner shows where that patch is.
//
// Natural Earth data (public domain, no credit needed), saved with the
// app as data/world-50m.json and data/world-110m.json (built by
// scripts/build-world-map.py). No weather data and no API calls: it
// works with no signal once the files are saved.
//
// Colours come from the current theme, so it matches Settings →
// Appearance like everything else.

const TRAVEL_MAP_WIDTH_KM = 560;
const TRAVEL_MAP_DOT_X = 0.72;   // the dot sits right of centre, clear of the clock text
const TRAVEL_INSET_WIDTH_KM = 6500;
let travelWorld50 = null;
let travelWorld110 = null;
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

function travelLoadWorld() {
  if (travelWorldLoading) return travelWorldLoading;
  const get = url => (typeof fetchWithTimeout === "function" ? fetchWithTimeout(url, {}, 20000) : fetch(url))
    .then(r => (r.ok ? r.json() : null));
  travelWorldLoading = Promise.all([get("data/world-50m.json"), get("data/world-110m.json")])
    .then(([w50, w110]) => {
      if (w50) {
        const q = w50.q;
        travelWorld50 = {
          countries: w50.countries.map(c => ({ a: c.a, rings: c.r.map(r => travelDecode(r, q)) })),
          states: w50.states.map(l => travelDecode(l, q)),
          rivers: w50.rivers.map(l => travelDecode(l, q)),
          lakes: w50.lakes.map(l => travelDecode(l, q)),
          cities: w50.cities
        };
        // Bounding boxes so drawing can skip everything off screen.
        const bbox = pts => {
          let a = 180, b = 90, c = -180, d = -90;
          pts.forEach(([x, y]) => { if (x < a) a = x; if (x > c) c = x; if (y < b) b = y; if (y > d) d = y; });
          return [a, b, c, d];
        };
        travelWorld50.countries.forEach(c => { c.boxes = c.rings.map(bbox); });
        travelWorld50.stateBoxes = travelWorld50.states.map(bbox);
        travelWorld50.riverBoxes = travelWorld50.rivers.map(bbox);
        travelWorld50.lakeBoxes = travelWorld50.lakes.map(bbox);
      }
      if (w110) {
        travelWorld110 = { land: w110.land.map(r => travelDecode(r, w110.q)) };
        travelWorld110.boxes = travelWorld110.land.map(r => {
          let a = 180, b = 90, c = -180, d = -90;
          r.forEach(([x, y]) => { if (x < a) a = x; if (x > c) c = x; if (y < b) b = y; if (y > d) d = y; });
          return [a, b, c, d];
        });
      }
      return !!w50;
    })
    .catch(() => { travelWorldLoading = null; return false; });
  return travelWorldLoading;
}

function travelThemeColours() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name, fallback) => (cs.getPropertyValue(name) || "").trim() || fallback;
  return {
    sea: v("--accent-light", "#e4efe6"),
    muted: v("--accent-muted", "#4c6a58"),
    dark: v("--accent-dark", "#234f39")
  };
}

// Longitude difference folded into -180..180, so a place near the date
// line still draws the land on both sides of it.
function travelLonDiff(lon, lon0) {
  let d = lon - lon0;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return d;
}

function travelProjector(lat0, lon0, widthKm, w, h, dotX) {
  const kmPerDegLat = 110.57;
  const kmPerDegLon = 111.32 * Math.cos(lat0 * Math.PI / 180);
  const s = w / widthKm;
  const cx = w * dotX, cy = h / 2;
  const project = (lon, lat) => [cx + travelLonDiff(lon, lon0) * kmPerDegLon * s, cy - (lat - lat0) * kmPerDegLat * s];
  // Degrees visible either side, with a margin, for skipping off-screen shapes.
  const halfLat = (h / s) / kmPerDegLat;
  const lonLeft = (cx / s) / Math.max(1, kmPerDegLon);
  const lonRight = ((w - cx) / s) / Math.max(1, kmPerDegLon);
  const view = { latMin: lat0 - halfLat * 1.2 - 0.5, latMax: lat0 + halfLat * 1.2 + 0.5, lonLeft: lonLeft * 1.2 + 0.5, lonRight: lonRight * 1.2 + 0.5 };
  const boxVisible = ([a, b, c, d]) => {
    if (d < view.latMin || b > view.latMax) return false;
    if (c - a > 300) return true; // a shape spanning the date line: just draw it
    const l = travelLonDiff(a, lon0), r = travelLonDiff(c, lon0);
    if (l <= r) return !(r < -view.lonLeft || l > view.lonRight);
    return true; // wraps round behind the view centre: cheap to just draw
  };
  return { project, boxVisible };
}

function travelPath(ctx, pts, project, closed, lon0) {
  let prevD = null;
  pts.forEach(([lon, lat], i) => {
    const [x, y] = project(lon, lat);
    // Don't join two points either side of the meridian opposite the
    // view centre (they'd be drawn as a line right across the map).
    const d = travelLonDiff(lon, lon0);
    if (i === 0 || Math.abs(d - prevD) > 180) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    prevD = d;
  });
  if (closed) ctx.closePath();
}

function travelPointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function travelOnLand(lon, lat) {
  if (!travelWorld110) return true;
  for (let i = 0; i < travelWorld110.land.length; i++) {
    const [a, b, c, d] = travelWorld110.boxes[i];
    if (lon < a || lon > c || lat < b || lat > d) continue;
    if (travelPointInRing(lon, lat, travelWorld110.land[i])) return true;
  }
  return false;
}

// True when no sea shows anywhere in the main map's window.
function travelIsInland(lat, lon) {
  const kmLon = 111.32 * Math.cos(lat * Math.PI / 180);
  const halfW = TRAVEL_MAP_WIDTH_KM / 2, halfH = TRAVEL_MAP_WIDTH_KM * 0.2;
  for (let i = -3; i <= 3; i++) {
    for (let j = -2; j <= 2; j++) {
      const plat = lat + (j / 2) * halfH / 110.57;
      const plon = lon + (i / 3) * halfW / Math.max(1, kmLon);
      if (!travelOnLand(plon, plat)) return false;
    }
  }
  return true;
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

function travelDrawDot(ctx, x, y, r) {
  ctx.beginPath();
  ctx.arc(x, y, r + 2, 0, Math.PI * 2);
  ctx.fillStyle = "#ffffff";
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = "#d0342c";
  ctx.fill();
}

async function drawTravelMap(canvas, insetCanvas, lat, lon) {
  if (!canvas) return;
  const ok = await travelLoadWorld();
  const { ctx, w, h } = travelSizeCanvas(canvas);
  const col = travelThemeColours();
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = col.sea;
  ctx.fillRect(0, 0, w, h);

  const { project, boxVisible } = travelProjector(lat, lon, TRAVEL_MAP_WIDTH_KM, w, h, TRAVEL_MAP_DOT_X);

  if (ok && travelWorld50) {
    const W = travelWorld50;
    // Land: every country filled, so the coastline is just where the fill stops.
    ctx.beginPath();
    W.countries.forEach(c => c.rings.forEach((ring, i) => { if (boxVisible(c.boxes[i])) travelPath(ctx, ring, project, true, lon); }));
    ctx.fillStyle = "rgba(255,255,255,0.72)";
    ctx.fill("evenodd");

    // Lakes back to the sea colour.
    ctx.beginPath();
    W.lakes.forEach((ring, i) => { if (boxVisible(W.lakeBoxes[i])) travelPath(ctx, ring, project, true, lon); });
    ctx.fillStyle = col.sea;
    ctx.fill();

    // Rivers.
    ctx.beginPath();
    W.rivers.forEach((line, i) => { if (boxVisible(W.riverBoxes[i])) travelPath(ctx, line, project, false, lon); });
    ctx.strokeStyle = "rgba(90,140,190,0.45)";
    ctx.lineWidth = 1;
    ctx.stroke();

    // State / province lines (big countries only), dashed and faint.
    ctx.save();
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    W.states.forEach((line, i) => { if (boxVisible(W.stateBoxes[i])) travelPath(ctx, line, project, false, lon); });
    ctx.globalAlpha = 0.3;
    ctx.strokeStyle = col.muted;
    ctx.lineWidth = 0.8;
    ctx.stroke();
    ctx.restore();

    // Country outlines (and so the coast).
    ctx.beginPath();
    W.countries.forEach(c => c.rings.forEach((ring, i) => { if (boxVisible(c.boxes[i])) travelPath(ctx, ring, project, true, lon); }));
    ctx.save();
    ctx.globalAlpha = 0.45;
    ctx.strokeStyle = col.muted;
    ctx.lineWidth = 0.9;
    ctx.stroke();
    ctx.restore();

    // A few big reference cities, biggest first, spaced apart and kept
    // clear of the destination's own dot.
    const [dx, dy] = project(lon, lat);
    const chosen = [];
    for (const [name, clon, clat] of W.cities) {
      if (chosen.length >= 4) break;
      const [x, y] = project(clon, clat);
      if (x < 6 || x > w - 6 || y < 8 || y > h - 6) continue;
      if (Math.hypot(x - dx, y - dy) < 22) continue;
      if (chosen.some(c => Math.abs(c.x - x) < 70 && Math.abs(c.y - y) < 16)) continue;
      chosen.push({ name, x, y });
    }
    ctx.save();
    ctx.globalAlpha = 0.55;
    ctx.fillStyle = col.muted;
    ctx.font = "600 10px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
    chosen.forEach(c => {
      ctx.beginPath();
      ctx.arc(c.x, c.y, 2, 0, Math.PI * 2);
      ctx.fill();
      const right = c.x < w - 70;
      ctx.textAlign = right ? "left" : "right";
      ctx.fillText(c.name, c.x + (right ? 5 : -5), c.y + 3.5);
    });
    ctx.restore();
  }

  const [dx, dy] = project(lon, lat);
  travelDrawDot(ctx, dx, dy, 4.5);

  // Inset for inland places.
  if (insetCanvas) {
    const inland = ok && travelWorld110 && travelIsInland(lat, lon);
    insetCanvas.hidden = !inland;
    if (inland) {
      const inset = travelSizeCanvas(insetCanvas);
      const ic = inset.ctx;
      ic.fillStyle = col.sea;
      ic.fillRect(0, 0, inset.w, inset.h);
      const p = travelProjector(lat, lon, TRAVEL_INSET_WIDTH_KM, inset.w, inset.h, 0.5);
      ic.beginPath();
      travelWorld110.land.forEach((ring, i) => { if (p.boxVisible(travelWorld110.boxes[i])) travelPath(ic, ring, p.project, true, lon); });
      ic.fillStyle = "rgba(255,255,255,0.85)";
      ic.fill("evenodd");
      ic.save();
      ic.globalAlpha = 0.45;
      ic.strokeStyle = col.muted;
      ic.lineWidth = 0.7;
      ic.stroke();
      ic.restore();
      // The main map's window, as a small box, with the dot inside it.
      const s = inset.w / TRAVEL_INSET_WIDTH_KM;
      const bw = TRAVEL_MAP_WIDTH_KM * s, bh = bw * (h / w);
      ic.strokeStyle = "#d0342c";
      ic.lineWidth = 1;
      ic.strokeRect(inset.w / 2 - bw * TRAVEL_MAP_DOT_X, inset.h / 2 - bh / 2, bw, bh);
      travelDrawDot(ic, inset.w / 2, inset.h / 2, 2.2);
    }
  }
}
