// Front-page map preview strip — REBUILT FROM SCRATCH.
//
// Two previous versions (a <canvas>, then a hard-coded <svg>) both went
// permanently blank after certain page transitions, for a reason an
// extended debugging session was never able to pin down — every
// standard diagnostic eventually stopped producing any signal at all,
// even on a brand new repository, ruling out caching/deployment.
//
// This version confirmed the basic foundation first (a stage-1 build
// that only changed plain text on screen — no canvas, no SVG, nothing
// a browser could fail to composite) genuinely works on-device. This
// is that same confirmed-working foundation with the real map drawing
// built back on top of it: the drawing surface is created and inserted
// by JavaScript at the moment it's actually ready to draw, rather than
// sitting hard-coded and empty in the HTML from the start, and every
// failure path falls back to plain visible text (mapStripShow) instead
// of silently doing nothing.
//
// Deliberately NOT using alert() anywhere in here — Safari has a real,
// documented anti-spam feature that can silently suppress further
// dialogs from a page after enough appear in a short time, which fits
// some of tonight's stranger results uncomfortably well. Plain on-screen
// text can't be suppressed the same way.

const mapStripRoot = document.getElementById("mapStripRoot");

function mapStripShow(text) {
  if (!mapStripRoot) return;
  mapStripRoot.textContent = text;
}

mapStripShow("Map strip script loaded, waiting for location…");

const MAP_STRIP_RADIUS_KM = 25;
const MAP_STRIP_GRID_SPACING_KM = 5;
const MAP_STRIP_FORECAST_DAYS = 3;
const KM_PER_DEG_LAT = 111.32;
function kmPerDegLon(lat) { return 111.32 * Math.cos(lat * Math.PI / 180); }

let mapStripHourOffset = 0;

const MAP_STRIP_RAIN_THRESHOLDS = [0.1, 0.5, 1, 2, 4, 8];
function rainBandIndex(value) {
  if (value === null || value === undefined || value < MAP_STRIP_RAIN_THRESHOLDS[0]) return -1;
  let idx = 0;
  for (let i = 1; i < MAP_STRIP_RAIN_THRESHOLDS.length; i++) {
    if (value >= MAP_STRIP_RAIN_THRESHOLDS[i]) idx = i;
  }
  return idx;
}

const MAP_STRIP_PALETTES = {
  paper: { land: "#e4efe6", sea: "#EEF5FA", coast: "#9c9a92", ink: "#4a4844", river: "#8FB9E2", tideMarker: "#CC3B2E", ramp: ["#BBD5EE", "#8FB9E2", "#6098D2", "#3B76BC", "#22539B", "#12376F"] },
  slate: { land: "#234f39", sea: "#33454f", coast: "#7a7a72", ink: "#d8d6cf", river: "#85B7EB", tideMarker: "#FF6B52", ramp: ["#E6F1FB", "#B5D4F4", "#85B7EB", "#378ADD", "#185FA5", "#0C447C"] },
  mono: { land: "#FFFFFF", sea: "#ECECEC", coast: "#555555", ink: "#111111", river: "#7C7C7C", tideMarker: "#141414", ramp: ["#C9C9C9", "#A2A2A2", "#7C7C7C", "#585858", "#363636", "#141414"] }
};
function mapStripPalette() {
  let id = "paper";
  try { id = localStorage.getItem("forecast-compare:map:palette") || "paper"; } catch {}
  return MAP_STRIP_PALETTES[id] || MAP_STRIP_PALETTES.paper;
}

let mapStripSvgEl = null; // created on demand — see ensureMapStripSvg()
let mapStripCoastline = null;
let mapStripPlaces = null;
let mapStripTerrain = null;
let mapStripLakes = null;
let mapStripWaterways = null;
let mapStripLastCentre = null;
let mapStripLastGrid = null;

// Created once, the first time there's actually something to draw —
// not hard-coded into index.html from the start. Reuses mapStripRoot
// (the proven-working element from stage 1) as its parent throughout;
// mapStripRoot's own "Loading…"/status text is what this replaces.
function ensureMapStripSvg() {
  if (mapStripSvgEl && mapStripSvgEl.isConnected) return mapStripSvgEl;
  if (!mapStripRoot) return null;
  mapStripRoot.textContent = "";
  mapStripSvgEl = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  mapStripSvgEl.setAttribute("viewBox", "0 0 300 150");
  mapStripSvgEl.style.cssText = "display:block;width:100%;height:100%;";
  mapStripRoot.appendChild(mapStripSvgEl);
  return mapStripSvgEl;
}

function sizeMapStripSvg() {
  const svg = ensureMapStripSvg();
  if (!svg) return false;
  const rect = mapStripRoot.getBoundingClientRect();
  const w = Math.round(rect.width), h = Math.round(rect.height);
  if (w <= 0 || h <= 0) return false;
  const wanted = `0 0 ${w} ${h}`;
  if (svg.getAttribute("viewBox") === wanted) return false;
  svg.setAttribute("viewBox", wanted);
  return true;
}

function mapStripView(centre) {
  const rect = mapStripRoot.getBoundingClientRect();
  const w = rect.width, h = rect.height;
  const spanKm = MAP_STRIP_RADIUS_KM * 2;
  const pxPerKm = Math.max(w, h) / spanKm;
  const dLon = kmPerDegLon(centre.lat);
  return {
    w, h, pxPerKm,
    x: lon => w / 2 + (lon - centre.lon) * dLon * pxPerKm,
    y: lat => h / 2 - (lat - centre.lat) * KM_PER_DEG_LAT * pxPerKm,
    lat: py => centre.lat - (py - h / 2) / (pxPerKm * KM_PER_DEG_LAT),
    lon: px => centre.lon + (px - w / 2) / (pxPerKm * dLon)
  };
}

function escapeXml(str) {
  return String(str).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));
}

// Replaces the SVG's children from a markup string via DOMParser rather
// than element.innerHTML — proven correct in a real browser test during
// tonight's debugging, and avoids relying on Safari's own (historically
// patchy) support for setting innerHTML directly on SVG elements.
function setSvgContent(svgEl, innerMarkup) {
  const wrapped = `<svg xmlns="http://www.w3.org/2000/svg">${innerMarkup}</svg>`;
  const parsed = new DOMParser().parseFromString(wrapped, "image/svg+xml");
  while (svgEl.firstChild) svgEl.removeChild(svgEl.firstChild);
  if (parsed.querySelector("parsererror")) {
    mapStripShow("Map strip: SVG markup failed to parse");
    return;
  }
  Array.from(parsed.documentElement.childNodes).forEach(node => {
    svgEl.appendChild(document.importNode(node, true));
  });
}

function svgPolygonPath(geojson, view) {
  if (!geojson) return "";
  const parts = [];
  geojson.features.forEach(feature => {
    const polygons = feature.geometry.type === "Polygon" ? [feature.geometry.coordinates] : feature.geometry.coordinates;
    polygons.forEach(polygon => {
      polygon.forEach(ring => {
        if (!ring.length) return;
        const points = ring.map(([lon, lat]) => `${view.x(lon).toFixed(1)},${view.y(lat).toFixed(1)}`);
        parts.push(`M${points.join("L")}Z`);
      });
    });
  });
  return parts.join(" ");
}

function eachMapStripRing(geometry, visit) {
  if (!geometry) return;
  const t = geometry.type, c = geometry.coordinates;
  if (t === "LineString") visit(c);
  else if (t === "MultiLineString" || t === "Polygon") c.forEach(visit);
  else if (t === "MultiPolygon") c.forEach(poly => poly.forEach(visit));
}

function svgWaterwaysPaths(geo, view, colour) {
  if (!geo) return "";
  const features = geo.type === "FeatureCollection" ? geo.features : [geo];
  const parts = [];
  features.forEach(feature => {
    const geometry = feature.geometry || feature;
    const dash = feature.properties?.kind === "canal" ? ' stroke-dasharray="4,3"' : "";
    eachMapStripRing(geometry, ring => {
      if (!ring.length) return;
      const points = ring.map(([lon, lat]) => `${view.x(lon).toFixed(1)},${view.y(lat).toFixed(1)}`);
      parts.push(`<path d="M${points.join("L")}" fill="none" stroke="${colour}" stroke-width="1"${dash}/>`);
    });
  });
  return parts.join("");
}

function mapStripElevationAt(grid, fr, fc) {
  const r0 = Math.floor(fr), c0 = Math.floor(fc);
  const r1 = Math.min(grid.rows - 1, r0 + 1), c1 = Math.min(grid.cols - 1, c0 + 1);
  if (r0 < 0 || c0 < 0 || r0 > grid.rows - 1 || c0 > grid.cols - 1) return null;
  const tr = fr - r0, tc = fc - c0;
  const z00 = grid.values[r0][c0], z01 = grid.values[r0][c1];
  const z10 = grid.values[r1][c0], z11 = grid.values[r1][c1];
  if ([z00, z01, z10, z11].some(v => v === null || v === undefined)) return null;
  const top = z00 + (z01 - z00) * tc;
  const bottom = z10 + (z11 - z10) * tc;
  return top + (bottom - top) * tr;
}

function mapStripShadeAt(grid, fr, fc) {
  const zC = mapStripElevationAt(grid, fr, fc);
  if (zC === null) return 0;
  const landOr = v => (v === null || v <= 0 ? zC : v);
  const zN = landOr(mapStripElevationAt(grid, fr - 1, fc));
  const zS = landOr(mapStripElevationAt(grid, fr + 1, fc));
  const zW = landOr(mapStripElevationAt(grid, fr, fc - 1));
  const zE = landOr(mapStripElevationAt(grid, fr, fc + 1));
  const dzdx = (zE - zW) / 2;
  const dzdy = (zS - zN) / 2;
  const stepMetres = grid.dLat * KM_PER_DEG_LAT * 1000;
  const slopeX = dzdx / stepMetres;
  const slopeY = dzdy / stepMetres;
  const EXAGGERATION = 8;
  return Math.max(-1, Math.min(1, (slopeX - slopeY) * EXAGGERATION));
}

function mapStripShadeBilinear(grid, fr, fc) {
  const r0 = Math.floor(fr), c0 = Math.floor(fc);
  const r1 = Math.min(grid.rows - 1, r0 + 1), c1 = Math.min(grid.cols - 1, c0 + 1);
  const tr = fr - r0, tc = fc - c0;
  const s00 = mapStripShadeAt(grid, r0, c0), s01 = mapStripShadeAt(grid, r0, c1);
  const s10 = mapStripShadeAt(grid, r1, c0), s11 = mapStripShadeAt(grid, r1, c1);
  const top = s00 + (s01 - s00) * tc;
  const bottom = s10 + (s11 - s10) * tc;
  return top + (bottom - top) * tr;
}

function svgTerrainRects(view, grid) {
  if (!grid) return "";
  const cell = 6;
  const parts = [];
  for (let px = 0; px < view.w; px += cell) {
    for (let py = 0; py < view.h; py += cell) {
      const lat = view.lat(py + cell / 2), lon = view.lon(px + cell / 2);
      const fr = (lat - grid.lat0) / grid.dLat, fc = (lon - grid.lon0) / grid.dLon;
      if (fr < 0 || fc < 0 || fr > grid.rows - 1 || fc > grid.cols - 1) continue;
      const z = grid.values[Math.round(fr)][Math.round(fc)];
      if (z === null || z === undefined || z <= 0) continue;
      const shade = mapStripShadeBilinear(grid, fr, fc);
      if (Math.abs(shade) < 0.02) continue;
      const colour = shade > 0 ? "#ffffff" : "#000000";
      const opacity = Math.min(0.50, Math.abs(shade) * 0.7).toFixed(2);
      parts.push(`<rect x="${px}" y="${py}" width="${cell}" height="${cell}" fill="${colour}" fill-opacity="${opacity}"/>`);
    }
  }
  return parts.join("");
}

function mapStripRainAt(grid, fr, fc, hourIndex) {
  const r0 = Math.floor(fr), c0 = Math.floor(fc);
  const r1 = Math.min(grid.rows - 1, r0 + 1), c1 = Math.min(grid.cols - 1, c0 + 1);
  const tr = fr - r0, tc = fc - c0;
  const v00 = grid.rainByHour[r0][c0][hourIndex];
  const v01 = grid.rainByHour[r0][c1][hourIndex];
  const v10 = grid.rainByHour[r1][c0][hourIndex];
  const v11 = grid.rainByHour[r1][c1][hourIndex];
  const top = v00 + (v01 - v00) * tc;
  const bottom = v10 + (v11 - v10) * tc;
  return top + (bottom - top) * tr;
}

function svgRainRects(view, centre, grid, palette) {
  if (!grid) return "";
  const hourIndex = Math.min(
    grid.startIdx + mapStripHourOffset,
    grid.rainByHour[0][0].length - 1
  );
  const cell = 6;
  const parts = [];
  for (let px = 0; px < view.w; px += cell) {
    for (let py = 0; py < view.h; py += cell) {
      const lon = centre.lon + (px - view.w / 2) / (view.pxPerKm * kmPerDegLon(centre.lat));
      const lat = centre.lat - (py - view.h / 2) / (view.pxPerKm * KM_PER_DEG_LAT);
      const fr = (lat - grid.lat0) / grid.dLat, fc = (lon - grid.lon0) / grid.dLon;
      if (fr < 0 || fc < 0 || fr > grid.rows - 1 || fc > grid.cols - 1) continue;
      const value = mapStripRainAt(grid, fr, fc, hourIndex);
      const band = rainBandIndex(value);
      if (band < 0) continue;
      parts.push(`<rect x="${px}" y="${py}" width="${cell}" height="${cell}" fill="${palette.ramp[band]}" fill-opacity="0.85"/>`);
    }
  }
  return parts.join("");
}

function mapStripHourClock(grid, hoursAhead) {
  const idx = grid && grid.times ? Math.min(grid.startIdx + hoursAhead, grid.times.length - 1) : null;
  const iso = idx !== null ? grid.times[idx] : null;
  const when = iso ? new Date(iso) : new Date(Date.now() + hoursAhead * 3600000);
  const time = when.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const isToday = when.toDateString() === new Date().toDateString();
  if (hoursAhead === 0) return `Now, ${time}`;
  if (isToday) return time;
  return `${when.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
}

let mapStripScaleEl = null;
function ensureMapStripScale() {
  if (mapStripScaleEl || !mapStripRoot) return mapStripScaleEl;
  const host = mapStripRoot.closest(".map-strip");
  if (!host) return null;
  mapStripScaleEl = document.createElement("div");
  mapStripScaleEl.className = "map-strip-scale";
  host.appendChild(mapStripScaleEl);
  return mapStripScaleEl;
}

async function renderMapStrip(centre, grid) {
  try {
    await renderMapStripInner(centre, grid);
  } catch (err) {
    mapStripShow("Map draw error: " + (err && err.message || err));
  }
}

async function renderMapStripInner(centre, grid) {
  const svg = ensureMapStripSvg();
  if (!svg) return;
  mapStripLastCentre = centre;
  mapStripLastGrid = grid;
  const view = mapStripView(centre);
  const p = mapStripPalette();

  const coastlinePath = svgPolygonPath(mapStripCoastline, view);
  const lakesPath = svgPolygonPath(mapStripLakes, view);

  let svgMarkup = `<rect width="${view.w}" height="${view.h}" fill="${p.sea}"/>`;
  if (coastlinePath) {
    svgMarkup += `<path d="${coastlinePath}" fill="${p.land}" stroke="${p.coast}" stroke-width="1.5" fill-rule="evenodd"/>`;
  }

  const clipId = "mapStripLandClip";
  let defs = "";
  if (coastlinePath) {
    defs = `<defs><clipPath id="${clipId}"><path d="${coastlinePath}"/></clipPath></defs>`;
  }

  if (mapStripTerrain && coastlinePath) {
    svgMarkup += `<g clip-path="url(#${clipId})">${svgTerrainRects(view, mapStripTerrain)}</g>`;
  }
  if (lakesPath) {
    svgMarkup += `<path d="${lakesPath}" fill="${p.sea}" stroke="${p.coast}" stroke-width="1.5" fill-rule="evenodd"/>`;
  }
  if (mapStripWaterways && coastlinePath) {
    svgMarkup += `<g clip-path="url(#${clipId})">${svgWaterwaysPaths(mapStripWaterways, view, p.river)}</g>`;
  }
  if (grid) {
    svgMarkup += svgRainRects(view, centre, grid, p);
  }
  if (coastlinePath) {
    svgMarkup += `<path d="${coastlinePath}" fill="none" stroke="${p.coast}" stroke-width="1.5"/>`;
  }

  if (mapStripPlaces) {
    const withDistance = mapStripPlaces
      .map(place => ({ place, d: Math.hypot(place.lat - centre.lat, place.lon - centre.lon) }))
      .filter(({ d }) => d < 0.35)
      .sort((a, b) => (a.place.rank - b.place.rank) || (a.d - b.d))
      .slice(0, 4);

    withDistance.forEach(({ place }) => {
      const x = view.x(place.lon), y = view.y(place.lat);
      if (x < 0 || x > view.w || y < 0 || y > view.h) return;
      svgMarkup += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2" fill="${p.ink}"/>`;
      svgMarkup += `<text x="${(x + 5).toFixed(1)}" y="${(y + 4).toFixed(1)}" font-size="11" font-family="-apple-system, system-ui, sans-serif" fill="${p.ink}" stroke="${p.land}" stroke-width="3" stroke-linejoin="round" paint-order="stroke fill">${escapeXml(place.name)}</text>`;
    });
  }

  if (typeof loadTideLocations === "function") {
    const tideLocations = loadTideLocations();
    tideLocations.forEach(loc => {
      const x = view.x(loc.lon), y = view.y(loc.lat);
      if (x < 0 || x > view.w || y < 0 || y > view.h) return;
      svgMarkup += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.5" fill="${p.tideMarker}" stroke="#fff" stroke-width="1"/>`;
    });
  }

  svgMarkup += `<circle cx="${(view.w / 2).toFixed(1)}" cy="${(view.h / 2).toFixed(1)}" r="4" fill="${p.ink}"/>`;

  setSvgContent(svg, defs + svgMarkup);

  const scaleEl = ensureMapStripScale();
  if (scaleEl) {
    scaleEl.classList.toggle("is-visible", mapStripHourOffset !== 0);
    if (mapStripHourOffset !== 0) scaleEl.textContent = mapStripHourClock(grid, mapStripHourOffset);
  }
}

const WEATHER_URL = "https://api.open-meteo.com/v1/forecast";
const MAP_STRIP_GRID_CACHE_KEY = "forecast-compare:mapstrip:grid";
const MAP_STRIP_GRID_CACHE_MS = 15 * 60 * 1000;

function mapStripGridCacheKey(centre) {
  return `${centre.lat.toFixed(2)},${centre.lon.toFixed(2)}`;
}

function loadMapStripGridCache(centre) {
  try {
    const raw = localStorage.getItem(MAP_STRIP_GRID_CACHE_KEY);
    if (!raw) return null;
    const entry = JSON.parse(raw);
    if (entry.key !== mapStripGridCacheKey(centre)) return null;
    if (Date.now() - entry.cachedAt > MAP_STRIP_GRID_CACHE_MS) return null;
    const grid = entry.grid;
    const now = Date.now();
    const idx = grid.times.findIndex(t => new Date(t).getTime() >= now - 30 * 60 * 1000);
    if (idx === -1) return null;
    return { ...grid, startIdx: Math.max(0, idx) };
  } catch {
    return null;
  }
}

function saveMapStripGridCache(centre, grid) {
  try {
    localStorage.setItem(MAP_STRIP_GRID_CACHE_KEY, JSON.stringify({
      key: mapStripGridCacheKey(centre),
      cachedAt: Date.now(),
      grid
    }));
  } catch {
    // Storage full or unavailable — the strip just pays for a fresh
    // fetch next time, exactly as it did before this cache existed.
  }
}

async function fetchMapStripGrid(centre) {
  const spanKm = MAP_STRIP_RADIUS_KM * 1.5;
  const dLat = MAP_STRIP_GRID_SPACING_KM / KM_PER_DEG_LAT;
  const dLon = MAP_STRIP_GRID_SPACING_KM / kmPerDegLon(centre.lat);
  const rows = Math.ceil((spanKm * 2) / MAP_STRIP_GRID_SPACING_KM) + 1;
  const lat0 = centre.lat - (rows - 1) / 2 * dLat;
  const lon0 = centre.lon - (rows - 1) / 2 * dLon;

  const lats = [], lons = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < rows; c++) {
      lats.push((lat0 + r * dLat).toFixed(4));
      lons.push((lon0 + c * dLon).toFixed(4));
    }
  }

  const params = new URLSearchParams({
    latitude: lats.join(","),
    longitude: lons.join(","),
    hourly: "precipitation",
    forecast_days: String(MAP_STRIP_FORECAST_DAYS),
    timezone: "auto"
  });
  const res = await fetchOpenMeteo(`${WEATHER_URL}?${params.toString()}`, {}, 20000);
  if (!res.ok) throw new Error(`Map strip fetch failed: ${res.status}`);
  const data = await res.json();
  const points = Array.isArray(data) ? data : [data];
  if (points.length !== rows * rows) throw new Error("Map strip fetch returned an unexpected number of points");

  const now = new Date();
  const startIdx = points[0].hourly.time.findIndex(t => new Date(t).getTime() >= now.getTime() - 30 * 60 * 1000);

  const rainByHour = [];
  for (let r = 0; r < rows; r++) {
    const row = [];
    for (let c = 0; c < rows; c++) {
      const series = points[r * rows + c].hourly.precipitation;
      row.push(series.map(v => (v === null || v === undefined ? 0 : v)));
    }
    rainByHour.push(row);
  }
  const times = points[0].hourly.time;

  const grid = { lat0, lon0, dLat, dLon, rows, cols: rows, rainByHour, times, startIdx: Math.max(0, startIdx) };
  saveMapStripGridCache(centre, grid);
  return grid;
}

let mapStripGeneration = 0;

async function initMapStrip(centre) {
  if (!mapStripRoot) return;
  const myGeneration = ++mapStripGeneration;
  mapStripShow(`Loading map for ${centre.lat.toFixed(2)}, ${centre.lon.toFixed(2)}…`);
  sizeMapStripSvg();

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (sizeMapStripSvg() && mapStripLastCentre) {
        renderMapStrip(mapStripLastCentre, mapStripLastGrid);
      }
    });
  });

  try {
    if (!mapStripCoastline) {
      const res = await fetchWithTimeout("data/coastline-50m.json", {}, 15000);
      if (res.ok) mapStripCoastline = await res.json();
    }
    if (!mapStripPlaces) {
      const res = await fetchWithTimeout("data/places.json", {}, 15000);
      if (res.ok) mapStripPlaces = await res.json();
    }
    if (!mapStripTerrain) {
      try {
        const res = await fetchWithTimeout("data/elevation-uk.json", {}, 15000);
        if (res.ok) {
          const data = await res.json();
          const values = [];
          for (let r = 0; r < data.rows; r++) {
            values.push(data.values.slice(r * data.cols, (r + 1) * data.cols));
          }
          mapStripTerrain = { ...data, values };
        }
      } catch {
        // No terrain texture this time — the strip still renders sea,
        // coastline, places and rain, which is everything it actually
        // promises; terrain here is decoration on top of that.
      }
    }
    if (!mapStripLakes) {
      try {
        const res = await fetchWithTimeout("data/lakes-50m.json", {}, 15000);
        if (res.ok) mapStripLakes = await res.json();
      } catch {
        // No lakes this time — same degrade-not-break reasoning as terrain.
      }
    }
    if (!mapStripWaterways) {
      try {
        const res = await fetchWithTimeout("data/waterways.json", {}, 15000);
        if (res.ok) mapStripWaterways = await res.json();
      } catch {
        // No rivers/canals this time — same degrade-not-break reasoning.
      }
    }
  } catch (err) {
    mapStripShow("Map data fetch error: " + (err && err.message || err));
  }
  if (myGeneration !== mapStripGeneration) return;
  renderMapStrip(centre, null); // whatever arrived (coastline/places/terrain) shown immediately, rain follows once fetched

  const cached = loadMapStripGridCache(centre);
  if (cached) {
    if (myGeneration !== mapStripGeneration) return;
    renderMapStrip(centre, cached);
    return;
  }

  try {
    const grid = await fetchMapStripGrid(centre);
    if (myGeneration !== mapStripGeneration) return;
    renderMapStrip(centre, grid);
  } catch (err) {
    console.error("Map strip weather fetch failed:", err);
    // Not shown on screen — the strip already has a real map from the
    // coastline/places pass above, just without the rain layer; that's
    // a reasonable degrade rather than something worth overwriting a
    // good picture with an error message about.
  }
}

document.addEventListener("cloude:location-ready", e => {
  initMapStrip({ lat: e.detail.lat, lon: e.detail.lon });
});

const mapStripHourSlider = document.getElementById("hourSlider");
if (mapStripHourSlider) {
  mapStripHourOffset = Number(mapStripHourSlider.value) || 0;
  mapStripHourSlider.addEventListener("input", () => {
    mapStripHourOffset = Number(mapStripHourSlider.value) || 0;
    if (mapStripLastCentre) renderMapStrip(mapStripLastCentre, mapStripLastGrid);
  });
}

let mapStripResizeObserver = null;
if (mapStripRoot && "ResizeObserver" in window) {
  mapStripResizeObserver = new ResizeObserver(() => {
    if (sizeMapStripSvg() && mapStripLastCentre) {
      renderMapStrip(mapStripLastCentre, mapStripLastGrid);
    }
  });
  mapStripResizeObserver.observe(mapStripRoot);
} else {
  window.addEventListener("resize", () => {
    if (sizeMapStripSvg() && mapStripLastCentre) renderMapStrip(mapStripLastCentre, mapStripLastGrid);
  });
}

// Confirmed genuinely firing on-device during stage 1 (plain text
// changes proved it) — now reconnected to the real drawing logic
// instead of just a status message.
setInterval(() => {
  if (document.visibilityState === "visible" && mapStripRoot && mapStripLastCentre) {
    renderMapStrip(mapStripLastCentre, mapStripLastGrid);
  }
}, 1200);
window.addEventListener("pageshow", () => {
  if (mapStripRoot && mapStripLastCentre) renderMapStrip(mapStripLastCentre, mapStripLastGrid);
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && mapStripRoot && mapStripLastCentre) renderMapStrip(mapStripLastCentre, mapStripLastGrid);
});
window.addEventListener("focus", () => {
  if (mapStripRoot && mapStripLastCentre) renderMapStrip(mapStripLastCentre, mapStripLastGrid);
});

window.addEventListener("error", e => {
  mapStripShow(`PAGE ERROR: ${e.message} (${e.filename}:${e.lineno})`);
});
window.addEventListener("unhandledrejection", e => {
  mapStripShow(`UNHANDLED REJECTION: ${e.reason && e.reason.message || e.reason}`);
});
