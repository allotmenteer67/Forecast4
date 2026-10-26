// ==== Callout screen ====
//
// A fixed, one-screen summary for an inshore lifeboat callout: wind and
// gusts, sea state, tide, light and visibility, in that order of
// importance. Opened from the front page's Callout button (only shown
// when "Show Callout button" is ticked in Settings) and stays on until
// "Back to normal" is tapped — there is deliberately no automatic
// turn-off, because long callouts happen.
//
// This page does NOT load app.js. It needs none of the forecast
// comparison machinery, and keeping it separate means nothing here can
// upset the front page. It does load tide.js, so the tide box uses the
// exact same gauge, harmonic fit, TFV correction and (where one has been
// learned) Admiralty correction as the tide card — the two can never
// disagree.
//
// Data: Open-Meteo forecast (wind, gusts, visibility), Open-Meteo
// Marine (waves, swell, sea temperature), Environment Agency tide gauge
// via tide.js. Sunrise, sunset and civil twilight are worked out here
// from the date and position, so they still show with no signal.
//
// The last successful download of each is kept on the phone and shown
// straight away on opening, with its time, before fresh data arrives.

// ---- Where the callout screen looks by default ----
// Roughly 4 km offshore in St Brides Bay, so the marine forecast lands
// on a sea grid square rather than a land one. Stage 3 (the Coast map)
// will let a pin replace this; that pin will be stored under
// CALLOUT_SPOT_KEY and cleared by "Back to normal".
const CALLOUT_DEFAULT_SPOT = { lat: 51.79, lon: -5.17, label: "St Brides Bay" };

const CALLOUT_SHOW_BUTTON_KEY = "cloude-callout:showButton"; // "1" = Settings tick box on
const CALLOUT_ACTIVE_KEY = "cloude-callout:active";          // "1" = callout mode on
const CALLOUT_SPOT_KEY = "cloude-callout:spot";              // pinned spot (stage 3)
const CALLOUT_CACHE_KEY = "cloude-callout:cache";            // last good downloads
const CONDITION_UNITS_KEY_CALLOUT = "forecast-compare:conditionUnits"; // same key app.js uses

const CALLOUT_REFRESH_MS = 10 * 60000; // fresh data every 10 minutes while open
const CALLOUT_STALE_MS = 45 * 60000;   // older than this = flagged in amber
const CALLOUT_TIME_ZONE = "Europe/London";

// tide.js calls fetchWithTimeout, which normally comes from app.js.
// This page doesn't load app.js, so it gets the same small helper here.
async function fetchWithTimeout(url, options = {}, timeoutMs = 20000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err.name === "AbortError") throw new Error("Timed out — check your connection and try again");
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

// ---- Small helpers ----
function calloutEl(id) { return document.getElementById(id); }

function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage full or off */ }
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]));
}

function clockTime(date) {
  return date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: CALLOUT_TIME_ZONE });
}

function durationText(ms) {
  const totalMin = Math.max(0, Math.round(ms / 60000));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m} min`;
  return `${h} h ${String(m).padStart(2, "0")}`;
}

const COMPASS_16 = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
function compassPoint(deg) {
  if (typeof deg !== "number" || Number.isNaN(deg)) return "";
  return COMPASS_16[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];
}

function currentSpot() {
  const pinned = readJson(CALLOUT_SPOT_KEY, null);
  if (pinned && typeof pinned.lat === "number" && typeof pinned.lon === "number") {
    return { lat: pinned.lat, lon: pinned.lon, label: "Selected spot", pinned: true };
  }
  return { ...CALLOUT_DEFAULT_SPOT, pinned: false };
}

function spotKey(spot) { return `${spot.lat.toFixed(3)},${spot.lon.toFixed(3)}`; }

// Follows the Units choices in Settings, so the callout screen matches
// the rest of the app. Wind defaults to mph, temperature to °C.
function unitChoices() {
  const stored = readJson(CONDITION_UNITS_KEY_CALLOUT, {});
  return {
    windKmh: stored.wind === "metric",
    tempF: stored.temperature === "imperial",
    visMiles: stored.visibility === "imperial"
  };
}

function windValue(mph, units) {
  if (typeof mph !== "number") return null;
  return Math.round(units.windKmh ? mph * 1.60934 : mph);
}

// Index of the hour that "now" falls in (Open-Meteo hourly, unixtime).
function hourIndexForNow(times) {
  const nowSec = Date.now() / 1000;
  let idx = -1;
  for (let i = 0; i < times.length; i++) {
    if (times[i] <= nowSec) idx = i; else break;
  }
  return idx;
}

// ---- Downloads ----
async function fetchForecast(spot) {
  const url = "https://api.open-meteo.com/v1/forecast" +
    `?latitude=${spot.lat}&longitude=${spot.lon}` +
    "&hourly=wind_speed_10m,wind_gusts_10m,wind_direction_10m,visibility" +
    "&wind_speed_unit=mph&timeformat=unixtime&timezone=UTC&forecast_days=2";
  const res = await fetchWithTimeout(url, {}, 20000);
  if (!res.ok) throw new Error(`Forecast download failed (${res.status})`);
  return res.json();
}

async function fetchMarine(spot) {
  const base = "https://marine-api.open-meteo.com/v1/marine" +
    `?latitude=${spot.lat}&longitude=${spot.lon}` +
    "&timeformat=unixtime&timezone=UTC&forecast_days=2&hourly=";
  const withSeaTemp = "wave_height,wave_direction,wave_period,swell_wave_height,swell_wave_period,wind_wave_height,sea_surface_temperature";
  let res = await fetchWithTimeout(base + withSeaTemp, {}, 20000);
  // If the supplier ever rejects the sea temperature field, still get
  // the waves rather than losing the whole sea box.
  if (res.status === 400) res = await fetchWithTimeout(base + withSeaTemp.replace(",sea_surface_temperature", ""), {}, 20000);
  if (!res.ok) throw new Error(`Sea download failed (${res.status})`);
  return res.json();
}

function loadCache(spot) {
  const all = readJson(CALLOUT_CACHE_KEY, {});
  return all[spotKey(spot)] || {};
}

function saveCachePart(spot, part, data) {
  const all = readJson(CALLOUT_CACHE_KEY, {});
  const key = spotKey(spot);
  // Only ever keep the current spot — this is a "last seen" store, not
  // a history, and it should never grow.
  const entry = all[key] || {};
  entry[part] = { fetchedAt: Date.now(), data };
  writeJson(CALLOUT_CACHE_KEY, { [key]: entry });
}

// ---- Beaufort scale ----
// Mean wind (not gusts), standard UK Met Office bands in mph.
const BEAUFORT = [
  [1, "Calm"], [4, "Light air"], [8, "Light breeze"], [13, "Gentle breeze"],
  [19, "Moderate breeze"], [25, "Fresh breeze"], [32, "Strong breeze"],
  [39, "Near gale"], [47, "Gale"], [55, "Severe gale"], [64, "Storm"],
  [73, "Violent storm"], [Infinity, "Hurricane force"]
];
function beaufortFor(mph) {
  for (let force = 0; force < BEAUFORT.length; force++) {
    if (mph < BEAUFORT[force][0]) return { force, name: BEAUFORT[force][1] };
  }
  return { force: 12, name: "Hurricane force" };
}

// ---- Wind box ----
function renderWind(entry, units) {
  const box = calloutEl("calloutWind");
  const h = entry && entry.data && entry.data.hourly;
  const idx = h ? hourIndexForNow(h.time) : -1;
  if (idx < 0 || typeof h.wind_speed_10m[idx] !== "number") {
    box.innerHTML = boxHtml("Wind", `<span class="big">—</span>`, "Not available right now");
    return;
  }
  const unit = units.windKmh ? "km/h" : "mph";
  const speed = windValue(h.wind_speed_10m[idx], units);
  const gust = windValue(h.wind_gusts_10m[idx], units);
  const dir = compassPoint(h.wind_direction_10m[idx]);

  // Trend over the next six hours, judged on gusts (what actually knocks
  // a small boat about). A change of under 5 mph counts as steady.
  const step = units.windKmh ? 8 : 5;
  let maxG = gust, maxAt = null, minG = gust, minAt = null;
  for (let i = idx + 1; i <= idx + 6 && i < h.time.length; i++) {
    const g = windValue(h.wind_gusts_10m[i], units);
    if (g === null) continue;
    if (g > maxG) { maxG = g; maxAt = h.time[i]; }
    if (g < minG) { minG = g; minAt = h.time[i]; }
  }
  let trend = "Steady for the next 6 hours";
  if (maxAt && maxG - gust >= step) trend = `Rising — gusts ${maxG} by ${clockTime(new Date(maxAt * 1000))}`;
  else if (minAt && gust - minG >= step) trend = `Easing — gusts ${minG} by ${clockTime(new Date(minAt * 1000))}`;

  const gustMph = h.wind_gusts_10m[idx];
  const gustClass = gustMph >= 30 ? "hot" : gustMph >= 20 ? "warm" : "";
  // Force 6 (strong breeze) and up in amber, gale force and up in red.
  const bf = beaufortFor(h.wind_speed_10m[idx]);
  const bfClass = bf.force >= 8 ? "hot" : bf.force >= 6 ? "warm" : "";
  const windLabel = `Wind<span class="label-right ${bfClass}">Force ${bf.force} · ${bf.name}</span>`;
  box.innerHTML = boxHtml(windLabel,
    `<span class="big">${speed}</span><span class="unit">${unit} ${dir}</span>` +
    `<span class="push unit">Gusts</span><span class="big ${gustClass}">${gust}</span>`,
    trend);
}

// ---- Sea box ----
// ---- Official sea and swell words ----
// Sea state: WMO sea state code (the Douglas sea scale), from the
// significant wave height — the same words the Met Office shipping and
// inshore waters forecasts use.
const SEA_STATES = [
  [0.1, "Calm"], [0.5, "Smooth"], [1.25, "Slight"], [2.5, "Moderate"],
  [4, "Rough"], [6, "Very rough"], [9, "High"], [14, "Very high"], [Infinity, "Phenomenal"]
];
function seaStateFor(metres) {
  for (let i = 0; i < SEA_STATES.length; i++) {
    if (metres < SEA_STATES[i][0]) return { rank: i, name: SEA_STATES[i][1] };
  }
  return { rank: SEA_STATES.length - 1, name: "Phenomenal" };
}

// Swell: the Douglas swell scale. Height: low under 2 m, moderate
// 2–4 m, heavy over 4 m. Length: short under 100 m, average 100–200 m,
// long over 200 m. Length comes from the swell period using the
// deep-water rule wavelength = 1.56 × period², so short is under about
// 8 seconds and long is over about 11.3 seconds.
function swellWords(heightM, periodS) {
  if (typeof heightM !== "number" || heightM < 0.1) return "No swell";
  if (typeof periodS !== "number") return "";
  const height = heightM < 2 ? "low" : heightM <= 4 ? "moderate" : "heavy";
  const wavelength = 1.56 * periodS * periodS;
  const length = wavelength < 100 ? "Short" : wavelength <= 200 ? "Average" : "Long";
  return `${length} ${height} swell`;
}

function renderSea(entry, units) {
  const box = calloutEl("calloutSea");
  const h = entry && entry.data && entry.data.hourly;
  const idx = h ? hourIndexForNow(h.time) : -1;
  if (idx < 0 || typeof h.wave_height[idx] !== "number") {
    box.innerHTML = boxHtml("Sea", `<span class="big">—</span>`, "No sea forecast for this spot");
    return;
  }
  const wave = h.wave_height[idx];
  const period = h.wave_period ? h.wave_period[idx] : null;
  const dir = compassPoint(h.wave_direction ? h.wave_direction[idx] : null);
  const swellH = h.swell_wave_height ? h.swell_wave_height[idx] : null;
  // Swell length needs the swell's own period; the overall wave period
  // is only used if the supplier didn't send it.
  const swellT = h.swell_wave_period && typeof h.swell_wave_period[idx] === "number" ? h.swell_wave_period[idx] : period;

  const state = seaStateFor(wave);
  const stateClass = state.rank >= 5 ? "hot" : state.rank >= 4 ? "warm" : ""; // Very rough+ red, Rough amber
  const seaLabel = `Sea<span class="label-right ${stateClass}">${state.name}</span>`;

  // Building or easing over the next six hours: at least 0.3 m and 15%.
  let trend = "";
  let maxW = wave, maxAt = null, minW = wave, minAt = null;
  for (let i = idx + 1; i <= idx + 6 && i < h.time.length; i++) {
    const w = h.wave_height[i];
    if (typeof w !== "number") continue;
    if (w > maxW) { maxW = w; maxAt = h.time[i]; }
    if (w < minW) { minW = w; minAt = h.time[i]; }
  }
  if (maxAt && maxW - wave >= 0.3 && maxW >= wave * 1.15) {
    trend = `Building to ${maxW.toFixed(1)} m (${seaStateFor(maxW).name.toLowerCase()}) by ${clockTime(new Date(maxAt * 1000))}`;
  } else if (minAt && wave - minW >= 0.3 && minW <= wave * 0.85) {
    trend = `Easing to ${minW.toFixed(1)} m by ${clockTime(new Date(minAt * 1000))}`;
  }

  const sstC = h.sea_surface_temperature ? h.sea_surface_temperature[idx] : null;
  const sst = typeof sstC === "number"
    ? `sea ${Math.round(units.tempF ? sstC * 9 / 5 + 32 : sstC)}°`
    : "";
  const line1 = [swellWords(swellH, swellT), sst].filter(Boolean).join(" · ");

  box.innerHTML =
    `<div class="label">${seaLabel}</div>` +
    `<div class="row"><span class="big">${wave.toFixed(1)}</span><span class="unit">m${dir ? " from " + dir : ""}</span>` +
    (typeof period === "number" ? `<span class="push unit">Period</span><span class="big">${Math.round(period)}</span><span class="unit">s</span>` : "") +
    `</div>` +
    `<div class="line strong">${line1 || "&nbsp;"}</div>` +
    (trend ? `<div class="line">${trend}</div>` : "");
}

// ---- Visibility box ----
// Uses the same words as the shipping forecast: Good over 10 km,
// Moderate 4–10 km, Poor 1–4 km, Very poor under 1 km.
function visibilityWord(metres) {
  if (metres < 1000) return "Very poor";
  if (metres < 4000) return "Poor";
  if (metres < 10000) return "Moderate";
  return "Good";
}
const VIS_RANK = { "Good": 0, "Moderate": 1, "Poor": 2, "Very poor": 3 };

function visibilityDistance(metres, units) {
  if (units && units.visMiles) {
    const miles = metres / 1609.344;
    return miles < 1 ? `${miles.toFixed(1)} miles` : `${Math.round(miles)} miles`;
  }
  const km = metres / 1000;
  return km < 1 ? `${km.toFixed(1)} km` : `${Math.round(km)} km`;
}

function renderVisibility(entry, units) {
  const box = calloutEl("calloutVis");
  const h = entry && entry.data && entry.data.hourly;
  const idx = h ? hourIndexForNow(h.time) : -1;
  if (idx < 0 || typeof h.visibility[idx] !== "number") {
    box.innerHTML = smallBoxHtml("Visibility", "—", "Not available");
    return;
  }
  const now = visibilityWord(h.visibility[idx]);
  // First time in the next 12 hours that it gets a category worse.
  let line = `${visibilityDistance(h.visibility[idx], units)} now`;
  for (let i = idx + 1; i <= idx + 12 && i < h.time.length; i++) {
    if (typeof h.visibility[i] !== "number") continue;
    const later = visibilityWord(h.visibility[i]);
    if (VIS_RANK[later] > VIS_RANK[now]) {
      line = `${later} after ${clockTime(new Date(h.time[i] * 1000))}`;
      break;
    }
  }
  const cls = VIS_RANK[now] >= 2 ? "warm" : "";
  box.innerHTML = smallBoxHtml("Visibility", now, line, cls);
}

// ---- Light box (worked out on the phone — no download needed) ----
// Standard sunrise equation. altitudeDeg -0.833 = sunrise/sunset,
// -6 = civil twilight (the usual meaning of "dark" for being outdoors).
function sunEvent(dayUtcNoon, lat, lon, altitudeDeg) {
  const rad = Math.PI / 180;
  const J2000 = 2451545.0;
  const jd = dayUtcNoon.getTime() / 86400000 + 2440587.5;
  const n = Math.round(jd - J2000 + 0.0008);
  const jStar = n - lon / 360;
  const M = (357.5291 + 0.98560028 * jStar) % 360;
  const C = 1.9148 * Math.sin(M * rad) + 0.02 * Math.sin(2 * M * rad) + 0.0003 * Math.sin(3 * M * rad);
  const lambda = (M + C + 180 + 102.9372) % 360;
  const jTransit = J2000 + jStar + 0.0053 * Math.sin(M * rad) - 0.0069 * Math.sin(2 * lambda * rad);
  const decl = Math.asin(Math.sin(lambda * rad) * Math.sin(23.4397 * rad));
  const cosH = (Math.sin(altitudeDeg * rad) - Math.sin(lat * rad) * Math.sin(decl)) / (Math.cos(lat * rad) * Math.cos(decl));
  if (cosH > 1 || cosH < -1) return null; // never rises/sets — not a UK concern, but safe
  const H = Math.acos(cosH) / rad;
  const toDate = j => new Date((j - 2440587.5) * 86400000);
  return { rise: toDate(jTransit - H / 360), set: toDate(jTransit + H / 360) };
}

// One line for the Light box: how much moon there is, and whether it's
// up. E.g. "Moon 78% · up till 03:40", "Moon 12% · rises 22:15".
// moon.js does the sums; with no moon.js loaded the line is left out.
function moonLine(spot) {
  if (typeof MOON === "undefined") return "";
  try {
    const now = new Date();
    const il = MOON.illumination(now);
    const pct = Math.round(il.fraction * 100);
    if (il.fraction < 0.03) return "New moon · no moonlight";
    const ev = MOON.nextEvents(now, spot.lat, spot.lon, 36);
    // Always the next rise or set, so within the coming day: no date needed.
    const when = d => clockTime(d);
    const waxing = il.phase < 0.5 ? "waxing" : "waning";
    const head = il.fraction > 0.97 ? "Full moon" : `Moon ${pct}% ${waxing}`;
    if (ev.up) return ev.set ? `${head} · up till ${when(ev.set)}` : `${head} · up`;
    return ev.rise ? `${head} · rises ${when(ev.rise)}` : `${head} · not up`;
  } catch {
    return "";
  }
}

function renderLight(spot) {
  const box = calloutEl("calloutLight");
  const now = new Date();
  const noonToday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 12));
  const noonTomorrow = new Date(noonToday.getTime() + 86400000);
  const sunToday = sunEvent(noonToday, spot.lat, spot.lon, -0.833);
  const civilToday = sunEvent(noonToday, spot.lat, spot.lon, -6);
  const sunTomorrow = sunEvent(noonTomorrow, spot.lat, spot.lon, -0.833);
  const civilTomorrow = sunEvent(noonTomorrow, spot.lat, spot.lon, -6);
  if (!sunToday || !civilToday || !sunTomorrow || !civilTomorrow) {
    box.innerHTML = smallBoxHtml("Light", "—", "");
    return;
  }
  if (now < civilToday.rise) {
    box.innerHTML = smallBoxHtml("Light in", durationText(civilToday.rise - now), `Sunrise ${clockTime(sunToday.rise)}`, "warm");
  } else if (now < civilToday.set) {
    const line = now < sunToday.set ? `Sunset ${clockTime(sunToday.set)}` : `Sunset was ${clockTime(sunToday.set)}`;
    box.innerHTML = smallBoxHtml("Dark in", durationText(civilToday.set - now), line, "warm");
  } else {
    box.innerHTML = smallBoxHtml("Light in", durationText(civilTomorrow.rise - now), `Sunrise ${clockTime(sunTomorrow.rise)}`, "warm");
  }
  const moon = moonLine(spot);
  if (moon) box.insertAdjacentHTML("beforeend", `<div class="line moon">${escapeHtml(moon)}</div>`);
}

// ---- Tide box ----
// Same correction chain as the tide card (tide-ui.js applyLocationCorrection),
// copied here because tide-ui.js expects the front page's elements.
function calloutLocationCorrection(location, fit, hours, odLevel) {
  const secondary = location.discoveryStation ? loadSecondaryOffset(location.discoveryStation.id) : null;
  if (secondary) {
    const result = applySecondaryOffset(fit, hours, odLevel, location.station, secondary);
    if (result) return { hours: result.hours, level: result.levelCD, isCD: true };
  }
  if (typeof location.station.cdOffsetOD === "number") {
    return { hours, level: odLevel - location.station.cdOffsetOD, isCD: true };
  }
  return { hours, level: odLevel, isCD: false };
}

// The nearest gauge to the callout spot (Milford Haven for St Brides
// Bay). If the phone already has a saved tide place that uses the same
// gauge and lies within 20 km of the spot, its learned Admiralty
// correction is used too and the box is labelled with its name.
function calloutTideLocation(spot) {
  if (typeof nearestTideStation !== "function") return null;
  const station = nearestTideStation(spot.lat, spot.lon);
  if (!station) return null;
  let best = null, bestKm = 20;
  (loadTideLocations() || []).forEach(loc => {
    if (!loc || !loc.station || loc.station.id !== station.id) return;
    if (typeof loc.lat !== "number" || typeof loc.lon !== "number") return;
    const km = haversineKm(spot.lat, spot.lon, loc.lat, loc.lon);
    if (km < bestKm) { bestKm = km; best = loc; }
  });
  if (best) return { ...best, station: best.station };
  return { label: station.label, station };
}

let calloutTideToken = 0;
async function renderTide(spot) {
  const box = calloutEl("calloutTide");
  const location = calloutTideLocation(spot);
  if (!location) {
    box.innerHTML = boxHtml("Tide", `<span class="big">—</span>`, "No tide gauge found");
    return;
  }
  const title = `Tide · ${escapeHtml(String(location.label).split(",")[0])}`;
  if (!box.dataset.filled) box.innerHTML = boxHtml(title, `<span class="big dim">Loading…</span>`, "First time can take a minute");
  const myToken = ++calloutTideToken;

  let built = null;
  try {
    built = await getOrBuildTideFit(location.station);
  } catch {
    built = null;
  }
  if (myToken !== calloutTideToken) return;
  if (!built) {
    box.innerHTML = boxHtml(title, `<span class="big">—</span>`, "Not available right now");
    return;
  }

  const epochMs = Date.parse(built.epochIso);
  const nowHours = (Date.now() - epochMs) / 3600000;
  const fudge = loadTideFudge(location.station.id);
  const levelAt = hrs => calloutLocationCorrection(location, built.fit, hrs, applyTideFudge(predictTideLevel(built.fit, hrs), fudge));

  // Rate of rise or fall over the next half hour, in metres per hour.
  const a = levelAt(nowHours);
  const b = levelAt(nowHours + 0.5);
  const rate = (b.level - a.level) * 2;
  const abs = Math.abs(rate);
  let state;
  if (abs < 0.25) state = "Turning";
  else state = (rate > 0 ? "Rising" : "Falling") + (abs >= 0.9 ? " fast" : "");

  // Shared with the 24-hour tide view (callout-detail.js).
  window.calloutTideModel = {
    epochMs, levelAt, label: String(location.label).split(",")[0],
    extremes: (fromH, toH) => findTideExtremes(built.fit, fromH, toH).map(e => {
      const r = calloutLocationCorrection(location, built.fit, e.hours, applyTideFudge(e.level, fudge));
      return { type: e.type, hours: r.hours, level: r.level, isCD: r.isCD };
    }).sort((x, y) => x.hours - y.hours)
  };
  if (typeof calloutDetailRefresh === "function") calloutDetailRefresh();

  const events = findTideExtremes(built.fit, nowHours - 1, nowHours + 30)
    .map(e => {
      const r = calloutLocationCorrection(location, built.fit, e.hours, applyTideFudge(e.level, fudge));
      return { type: e.type, hours: r.hours, level: r.level, isCD: r.isCD };
    })
    .sort((x, y) => x.hours - y.hours)
    .filter(e => e.hours >= nowHours)
    .slice(0, 2);

  const datumNote = a.isCD ? "" : " (gauge datum)";
  const eventText = e => `${e.type === "high" ? "High" : "Low"} ${clockTime(new Date(epochMs + e.hours * 3600000))} (${e.level.toFixed(1)} m${datumNote})`;
  const sign = rate >= 0 ? "+" : "−";
  const line1 = [abs >= 0.05 ? `${sign}${abs.toFixed(1)} m per hour` : "", events[0] ? eventText(events[0]) : ""].filter(Boolean).join(" · ");
  const line2 = events[1] ? `Then ${eventText(events[1]).replace(/^High/, "high").replace(/^Low/, "low")}` : "";

  box.dataset.filled = "1";
  box.innerHTML =
    `<div class="label">${title}</div>` +
    `<div class="row"><span class="big tide">${state}</span><span class="push unit">now ${a.level.toFixed(1)} m</span></div>` +
    `<div class="line strong">${line1}</div>` +
    (line2 ? `<div class="line">${line2}</div>` : "");
}

// ---- Shared box markup ----
function boxHtml(label, rowHtml, line) {
  return `<div class="label">${label}</div><div class="row">${rowHtml}</div><div class="line">${line}</div>`;
}
function smallBoxHtml(label, value, line, cls = "") {
  return `<div class="label">${label}</div><div class="mid ${cls}">${escapeHtml(value)}</div><div class="line">${escapeHtml(line)}</div>`;
}

// ---- Updated line ----
function renderUpdated(cache, errors) {
  const el = calloutEl("calloutUpdated");
  const spot = currentSpot();
  const times = [cache.forecast, cache.marine].filter(Boolean).map(p => p.fetchedAt);
  let text = spot.label;
  let stale = false;
  if (times.length) {
    const oldest = Math.min(...times);
    stale = Date.now() - oldest > CALLOUT_STALE_MS;
    text += ` · updated ${clockTime(new Date(oldest))}`;
  } else {
    text += " · no data yet";
  }
  if (errors.length) text += " · no signal?";
  el.textContent = text;
  el.classList.toggle("stale", stale || errors.length > 0);
}

// ---- Pin from the Coast map ----
// coast.js saves the pin with the distance and bearing (true) to the
// nearest dry ground and the nearest way off, worked out when it was
// placed. Shown here in a red-edged line with a Clear button.
// Bearings saved from step 3d on are magnetic (bearingM); older pins
// only have the true bearing.
function pinBearingText(o) {
  return typeof o.bearingM === "number" ? `${String(o.bearingM).padStart(3, "0")}°M` : `${String(o.bearing).padStart(3, "0")}°T`;
}
function pinDistText(m) {
  return m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1852).toFixed(2)} nm`;
}
function renderPinLine() {
  const el = calloutEl("calloutPin");
  const pin = readJson(CALLOUT_SPOT_KEY, null);
  if (!pin || typeof pin.lat !== "number") { el.hidden = true; el.innerHTML = ""; return; }
  const parts = [];
  if (pin.shore) parts.push(`dry ground <b>${pinDistText(pin.shore.distM)}</b> ${pinBearingText(pin.shore)}`);
  if (pin.wayOff) parts.push(`way off <b>${pinDistText(pin.wayOff.distM)}</b> ${pinBearingText(pin.wayOff)}${pin.wayOff.cut ? ` (${pin.wayOff.cut})` : ""}`);
  if (pin.source) parts.unshift(`reported ${escapeHtml(pin.source)}`);
  el.innerHTML = `<span class="dot"></span><span class="pin-text">Pin set on the Coast map: weather and sea are for the pin${parts.length ? "<br>" + parts.join(" · ") : ""}</span><button id="calloutPinClear" type="button">Clear</button>`;
  el.hidden = false;
  calloutEl("calloutPinClear").addEventListener("click", () => {
    try { localStorage.removeItem(CALLOUT_SPOT_KEY); localStorage.removeItem("cloude-coast:line"); } catch { /* ignore */ }
    renderPinLine();
    renderFromCache();
    refreshCallout();
  });
}

// ---- Main refresh ----
let calloutRefreshing = false;
async function refreshCallout() {
  if (calloutRefreshing) return;
  calloutRefreshing = true;
  const spot = currentSpot();
  const units = unitChoices();
  const errors = [];
  const refreshBtn = calloutEl("calloutRefresh");
  if (refreshBtn) refreshBtn.classList.add("spinning");

  renderLight(spot);
  renderTide(spot); // runs on its own; never waits on the weather

  const [forecastResult, marineResult] = await Promise.allSettled([fetchForecast(spot), fetchMarine(spot)]);
  if (forecastResult.status === "fulfilled") saveCachePart(spot, "forecast", forecastResult.value);
  else errors.push(forecastResult.reason);
  if (marineResult.status === "fulfilled") saveCachePart(spot, "marine", marineResult.value);
  else errors.push(marineResult.reason);

  const cache = loadCache(spot);
  renderWind(cache.forecast, units);
  renderSea(cache.marine, units);
  renderVisibility(cache.forecast, units);
  renderUpdated(cache, errors);
  if (typeof calloutDetailRefresh === "function") calloutDetailRefresh();

  if (refreshBtn) refreshBtn.classList.remove("spinning");
  calloutRefreshing = false;
}

// Shows whatever was last downloaded, straight away, before any fetch.
function renderFromCache() {
  renderPinLine();
  const spot = currentSpot();
  const units = unitChoices();
  const cache = loadCache(spot);
  renderWind(cache.forecast, units);
  renderSea(cache.marine, units);
  renderVisibility(cache.forecast, units);
  renderLight(spot);
  renderUpdated(cache, []);
}

function backToNormal() {
  try {
    localStorage.removeItem(CALLOUT_ACTIVE_KEY);
    localStorage.removeItem(CALLOUT_SPOT_KEY); // the pin ends with the callout
    localStorage.removeItem("cloude-coast:line"); // and so does a reported bearing line
  } catch { /* nothing to clear */ }
  window.location.href = "index.html";
}

function initCallout() {
  try { localStorage.setItem(CALLOUT_ACTIVE_KEY, "1"); } catch { /* still works this visit */ }

  calloutEl("calloutBack").addEventListener("click", backToNormal);
  calloutEl("calloutRefresh").addEventListener("click", refreshCallout);

  renderFromCache();
  refreshCallout();

  setInterval(() => {
    if (document.visibilityState === "visible") refreshCallout();
  }, CALLOUT_REFRESH_MS);
  // Coming back to the phone after kitting up: refresh straight away if
  // what's on screen is more than a few minutes old.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    const cache = loadCache(currentSpot());
    const last = cache.forecast ? cache.forecast.fetchedAt : 0;
    if (Date.now() - last > 3 * 60000) refreshCallout();
    else renderLight(currentSpot());
  });
  // The light countdown ticks over every minute even with no download.
  setInterval(() => renderLight(currentSpot()), 60000);
}

initCallout();
