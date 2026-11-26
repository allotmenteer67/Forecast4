// ==== Air quality (and pollen) ====
//
// Shared by the Travel page (travel.js) and the optional "Air quality"
// cell on the UK front page (ticked in Settings → Front page cells, off
// by default).
//
// Data: Open-Meteo's free Air Quality API (Copernicus CAMS), no key.
// The index shown is the one people locally would recognise, worked out
// on the phone from the pollutant levels:
//   UK      → DAQI 1–10 (Defra bands)
//   India   → India AQI 0–500 (CPCB bands)
//   China   → China AQI 0–500 (HJ 633-2012 bands)
//   US      → US AQI 0–500 (Open-Meteo works this one out)
//   others  → European AQI (Open-Meteo works this one out)
// These are close matches built from a forecast model, not the official
// figures from each country's own monitoring stations — Help says so.
//
// Pollen (alder, birch, grass, mugwort, olive, ragweed) only exists for
// Europe in the CAMS data, and only in season, so the pollen cell hides
// itself everywhere else. Its Low/Moderate/High/Very high words are a
// rough guide, not an official pollen count.
//
// Kept in its own file so it can't disturb app.js.

const AQ_URL = "https://air-quality-api.open-meteo.com/v1/air-quality";
const AQ_POLLUTANTS = ["pm2_5", "pm10", "nitrogen_dioxide", "ozone", "sulphur_dioxide", "carbon_monoxide"];
const AQ_POLLEN = ["alder_pollen", "birch_pollen", "grass_pollen", "mugwort_pollen", "olive_pollen", "ragweed_pollen"];
const AQ_HOURLY_FIELDS = [
  ...AQ_POLLUTANTS,
  "us_aqi", ...AQ_POLLUTANTS.map(p => `us_aqi_${p}`),
  "european_aqi", ...AQ_POLLUTANTS.filter(p => p !== "carbon_monoxide").map(p => `european_aqi_${p}`),
  ...AQ_POLLEN
];

const AQ_POLLUTANT_NAMES = {
  pm2_5: "PM2.5", pm10: "PM10", nitrogen_dioxide: "NO₂",
  ozone: "Ozone", sulphur_dioxide: "SO₂", carbon_monoxide: "CO"
};
const AQ_POLLEN_NAMES = {
  alder_pollen: "Alder", birch_pollen: "Birch", grass_pollen: "Grass",
  mugwort_pollen: "Mugwort", olive_pollen: "Olive", ragweed_pollen: "Ragweed"
};

// Band tints, best to worst. Fixed colours (not the theme's) because the
// colour IS the reading, the same way the frost tint is.
const AQ_TINTS = ["#d9efd9", "#ecf2cc", "#fbecc0", "#f8d8c4", "#f2cbd2", "#e3d1ee"];

function aqSchemeFor(countryCode) {
  const cc = String(countryCode || "").toUpperCase();
  if (cc === "GB") return "daqi";
  if (cc === "IN") return "india";
  if (cc === "CN") return "china";
  if (cc === "US") return "us";
  return "eu";
}

const AQ_SCHEME_LABEL = { daqi: "Air DAQI", india: "Air India", china: "Air China", us: "Air US", eu: "Air EU" };

// word + tint index for an index value in each scheme
function aqBand(scheme, v) {
  if (v === null || v === undefined || Number.isNaN(v)) return null;
  const pick = (edges, words) => {
    for (let i = 0; i < edges.length; i++) if (v <= edges[i]) return { word: words[i], tint: i };
    return { word: words[words.length - 1], tint: words.length - 1 };
  };
  switch (scheme) {
    case "daqi": {
      if (v <= 3) return { word: "Low", tint: 0 };
      if (v <= 6) return { word: "Moderate", tint: 2 };
      if (v <= 9) return { word: "High", tint: 3 };
      return { word: "Very high", tint: 5 };
    }
    case "us": return pick([50, 100, 150, 200, 300], ["Good", "Moderate", "Sensitive", "Unhealthy", "Very unhealthy", "Hazardous"]);
    case "eu": return pick([20, 40, 60, 80, 100], ["Good", "Fair", "Moderate", "Poor", "Very poor", "Extreme"]);
    case "india": return pick([50, 100, 200, 300, 400], ["Good", "Satisfactory", "Moderate", "Poor", "Very poor", "Severe"]);
    case "china": return pick([50, 100, 150, 200, 300], ["Excellent", "Good", "Light", "Moderate", "Heavy", "Severe"]);
    default: return null;
  }
}

// ---- Working out the local indices from pollutant levels ----

function aqTrailingMean(arr, i, hours) {
  let sum = 0, n = 0;
  for (let k = Math.max(0, i - hours + 1); k <= i; k++) {
    const v = arr[k];
    if (v !== null && v !== undefined) { sum += v; n++; }
  }
  // Needs most of the window to count, or the start of the data (with
  // no history behind it) would give a misleading average.
  return n >= Math.ceil(hours * 0.75) ? sum / n : null;
}

// Linear interpolation between breakpoints (India and China both work
// this way). conc and idx are the same length.
function aqInterp(c, conc, idx) {
  if (c === null || c === undefined) return null;
  if (c <= conc[0]) return idx[0];
  for (let i = 1; i < conc.length; i++) {
    if (c <= conc[i]) {
      return idx[i - 1] + (c - conc[i - 1]) * (idx[i] - idx[i - 1]) / (conc[i] - conc[i - 1]);
    }
  }
  return idx[idx.length - 1];
}

// Defra DAQI: upper bound of bands 1–9 (band 10 above the last).
const DAQI_BOUNDS = {
  ozone: [33, 66, 100, 120, 140, 160, 187, 213, 240],              // 8-hour mean
  nitrogen_dioxide: [67, 134, 200, 267, 334, 400, 467, 534, 600],   // hourly
  sulphur_dioxide: [88, 177, 266, 354, 443, 532, 710, 887, 1064],   // hourly (officially 15-minute)
  pm2_5: [11, 23, 35, 41, 47, 53, 58, 64, 70],                      // 24-hour mean
  pm10: [16, 33, 50, 58, 66, 75, 83, 91, 100]                       // 24-hour mean
};
function daqiBandFor(value, bounds) {
  if (value === null || value === undefined) return null;
  const v = Math.round(value);
  for (let i = 0; i < bounds.length; i++) if (v <= bounds[i]) return i + 1;
  return 10;
}

// CPCB India AQI breakpoints, sub-index 0–500.
const INDIA_IDX = [0, 50, 100, 200, 300, 400, 500];
const INDIA_BP = {
  pm10: [0, 50, 100, 250, 350, 430, 600],
  pm2_5: [0, 30, 60, 90, 120, 250, 380],
  nitrogen_dioxide: [0, 40, 80, 180, 280, 400, 520],
  ozone: [0, 50, 100, 168, 208, 748, 1000],
  sulphur_dioxide: [0, 40, 80, 380, 800, 1600, 2100],
  carbon_monoxide: [0, 1, 2, 10, 17, 34, 50] // mg/m³
};
const INDIA_HOURS = { pm10: 24, pm2_5: 24, nitrogen_dioxide: 24, ozone: 8, sulphur_dioxide: 24, carbon_monoxide: 8 };

// China HJ 633-2012 daily breakpoints, IAQI 0–500.
const CHINA_IDX = [0, 50, 100, 150, 200, 300, 400, 500];
const CHINA_BP = {
  sulphur_dioxide: [0, 50, 150, 475, 800, 1600, 2100, 2620],
  nitrogen_dioxide: [0, 40, 80, 180, 280, 565, 750, 940],
  pm10: [0, 50, 150, 250, 350, 420, 500, 600],
  carbon_monoxide: [0, 2, 4, 14, 24, 36, 48, 60], // mg/m³
  pm2_5: [0, 35, 75, 115, 150, 250, 350, 500]
};
const CHINA_O3_BP = [0, 100, 160, 215, 265, 800];  // 8-hour mean
const CHINA_O3_IDX = [0, 50, 100, 150, 200, 300];
const CHINA_HOURS = { sulphur_dioxide: 24, nitrogen_dioxide: 24, pm10: 24, carbon_monoxide: 24, pm2_5: 24, ozone: 8 };

// Per hour: { index, main } where main is the pollutant key giving the
// highest sub-index. Worked out once per download.
function aqComputeHourly(data, scheme) {
  const h = data.hourly || {};
  const n = (data.times || []).length;
  const index = new Array(n).fill(null);
  const main = new Array(n).fill(null);
  const best = subs => {
    let top = null, key = null;
    Object.entries(subs).forEach(([k, v]) => {
      if (v === null || v === undefined) return;
      if (top === null || v > top) { top = v; key = k; }
    });
    return { top, key };
  };
  for (let i = 0; i < n; i++) {
    let subs = {};
    if (scheme === "us") {
      AQ_POLLUTANTS.forEach(p => { subs[p] = h[`us_aqi_${p}`]?.[i]; });
      const { key } = best(subs);
      index[i] = h.us_aqi?.[i] ?? null;
      main[i] = key;
      continue;
    }
    if (scheme === "eu") {
      AQ_POLLUTANTS.forEach(p => { if (p !== "carbon_monoxide") subs[p] = h[`european_aqi_${p}`]?.[i]; });
      const { key } = best(subs);
      index[i] = h.european_aqi?.[i] ?? null;
      main[i] = key;
      continue;
    }
    if (scheme === "daqi") {
      subs = {
        ozone: daqiBandFor(aqTrailingMean(h.ozone || [], i, 8), DAQI_BOUNDS.ozone),
        nitrogen_dioxide: daqiBandFor(h.nitrogen_dioxide?.[i], DAQI_BOUNDS.nitrogen_dioxide),
        sulphur_dioxide: daqiBandFor(h.sulphur_dioxide?.[i], DAQI_BOUNDS.sulphur_dioxide),
        pm2_5: daqiBandFor(aqTrailingMean(h.pm2_5 || [], i, 24), DAQI_BOUNDS.pm2_5),
        pm10: daqiBandFor(aqTrailingMean(h.pm10 || [], i, 24), DAQI_BOUNDS.pm10)
      };
    } else if (scheme === "india") {
      Object.keys(INDIA_BP).forEach(p => {
        let c = aqTrailingMean(h[p] || [], i, INDIA_HOURS[p]);
        if (p === "carbon_monoxide" && c !== null) c /= 1000; // µg/m³ → mg/m³
        subs[p] = aqInterp(c, INDIA_BP[p], INDIA_IDX);
      });
    } else if (scheme === "china") {
      Object.keys(CHINA_BP).forEach(p => {
        let c = aqTrailingMean(h[p] || [], i, CHINA_HOURS[p]);
        if (p === "carbon_monoxide" && c !== null) c /= 1000;
        subs[p] = aqInterp(c, CHINA_BP[p], CHINA_IDX);
      });
      subs.ozone = aqInterp(aqTrailingMean(h.ozone || [], i, 8), CHINA_O3_BP, CHINA_O3_IDX);
    }
    const { top, key } = best(subs);
    // The main pollutant (and so the index) needs PM to be there: without
    // particles the index would just be missing its usual biggest part.
    const hasPM = subs.pm2_5 !== null && subs.pm2_5 !== undefined;
    index[i] = hasPM && top !== null ? Math.round(top) : null;
    main[i] = hasPM ? key : null;
  }
  return { index, main };
}

// Worst hour between two times (unix seconds, end exclusive).
function aqWorstBetween(computed, times, fromSec, toSec) {
  let best = null;
  times.forEach((t, i) => {
    if (t < fromSec || t >= toSec) return;
    const v = computed.index[i];
    if (v === null || v === undefined) return;
    if (!best || v > best.index) best = { index: v, main: computed.main[i] };
  });
  return best;
}

// The hour that contains a moment.
function aqAtMoment(computed, times, sec) {
  let idx = -1;
  for (let i = 0; i < times.length; i++) { if (times[i] <= sec) idx = i; else break; }
  if (idx < 0 || computed.index[idx] === null || computed.index[idx] === undefined) return null;
  return { index: computed.index[idx], main: computed.main[idx] };
}

// Pollen: worst type between two times. Rough levels in grains/m³.
function aqPollenWord(v) {
  if (v < 1) return null;
  if (v < 10) return { word: "Low", tint: 0 };
  if (v < 50) return { word: "Moderate", tint: 2 };
  if (v < 200) return { word: "High", tint: 3 };
  return { word: "Very high", tint: 5 };
}
function aqPollenBetween(data, fromSec, toSec) {
  const h = data.hourly || {};
  let top = null;
  (data.times || []).forEach((t, i) => {
    if (t < fromSec || t >= toSec) return;
    AQ_POLLEN.forEach(p => {
      const v = h[p]?.[i];
      if (v === null || v === undefined) return;
      if (!top || v > top.value) top = { value: v, type: p };
    });
  });
  return top;
}
// Any pollen at all in the whole download (Europe, in season).
function aqHasPollen(data) {
  const h = (data && data.hourly) || {};
  return AQ_POLLEN.some(p => (h[p] || []).some(v => typeof v === "number" && v >= 1));
}

async function aqFetch(lat, lon, timezone) {
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    hourly: AQ_HOURLY_FIELDS.join(","),
    timeformat: "unixtime",
    timezone: timezone || "UTC",
    past_days: "1", // the day behind the forecast, for the 8- and 24-hour averages
    forecast_days: "5"
  });
  const fetcher = typeof fetchWithTimeout === "function" ? fetchWithTimeout : fetch;
  const res = await fetcher(`${AQ_URL}?${params.toString()}`);
  if (!res.ok) throw new Error(`Air quality lookup failed (${res.status})`);
  const data = await res.json();
  const hourly = {};
  AQ_HOURLY_FIELDS.forEach(k => { if (data.hourly && data.hourly[k]) hourly[k] = data.hourly[k]; });
  return { times: (data.hourly && data.hourly.time) || [], hourly, fetchedAt: Date.now() };
}

// ---- The headline cell (same structure as every other cell) ----

const AQ_ICONS = {
  // Three curling lines of air.
  airQuality: '<svg viewBox="0 0 18 18" fill="none"><path d="M2 6 h7 a2 2 0 1 0 -2 -2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M2 10 h12" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M2 14 h5 a2 2 0 1 1 -2 2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><circle cx="14.5" cy="5" r="1" fill="currentColor"/><circle cx="12.5" cy="14" r="1" fill="currentColor"/></svg>',
  // A simple five-petal flower.
  pollen: '<svg viewBox="0 0 18 18" fill="none"><circle cx="9" cy="7" r="1.8" stroke="currentColor" stroke-width="1.3"/><circle cx="9" cy="3.3" r="1.7" stroke="currentColor" stroke-width="1.2"/><circle cx="12.5" cy="5.8" r="1.7" stroke="currentColor" stroke-width="1.2"/><circle cx="11.2" cy="10" r="1.7" stroke="currentColor" stroke-width="1.2"/><circle cx="6.8" cy="10" r="1.7" stroke="currentColor" stroke-width="1.2"/><circle cx="5.5" cy="5.8" r="1.7" stroke="currentColor" stroke-width="1.2"/><path d="M9 11.5 V16.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
  // A sun with "UV" feel: circle with short rays.
  uv: '<svg viewBox="0 0 18 18" fill="none"><circle cx="9" cy="9" r="3.4" stroke="currentColor" stroke-width="1.4"/><path d="M9 1.5 v2 M9 14.5 v2 M1.5 9 h2 M14.5 9 h2 M3.7 3.7 l1.4 1.4 M12.9 12.9 l1.4 1.4 M14.3 3.7 l-1.4 1.4 M5.1 12.9 l-1.4 1.4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><circle cx="9" cy="9" r="1.2" fill="currentColor"/></svg>'
};

(function () {
  const style = document.createElement("style");
  style.textContent =
    ".headline-label.aq-no-chevron::after { display: none; }" +
    ".aq-detail { display: flex; flex-direction: column; line-height: 1.1; font-size: 11px; font-weight: 600; color: #3a4740; white-space: nowrap; }" +
    ".aq-detail span:last-child { opacity: 0.75; }" +
    ".headline-cell.aq-tinted .headline-value { color: #1f2a24; }" +
    ".headline-cell.aq-tinted .headline-label, .headline-cell.aq-tinted .headline-cell-icon { color: #3a4740; }";
  document.head.appendChild(style);
})();

// Builds an empty cell shell: { cell, valueEl, valueRow }.
function aqCellShell(iconKey, labelText) {
  const cell = document.createElement("button");
  cell.type = "button";
  cell.className = "headline-cell";
  cell.style.cursor = "default"; // no graph behind it

  const icon = document.createElement("span");
  icon.className = "headline-cell-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.innerHTML = AQ_ICONS[iconKey] || "";

  const label = document.createElement("span");
  label.className = "headline-label aq-no-chevron";
  label.textContent = labelText;

  const valueRow = document.createElement("div");
  valueRow.className = "headline-value-row";
  const valueEl = document.createElement("span");
  valueEl.className = "headline-value";
  valueRow.appendChild(valueEl);

  const textWrap = document.createElement("div");
  textWrap.className = "headline-cell-text";
  textWrap.append(label, valueRow);
  cell.append(icon, textWrap);
  return { cell, valueEl, valueRow };
}

function aqAddDetail(valueRow, top, bottom) {
  const d = document.createElement("span");
  d.className = "aq-detail";
  const a = document.createElement("span");
  a.textContent = top || "";
  const b = document.createElement("span");
  b.textContent = bottom || "";
  d.append(a, b);
  valueRow.appendChild(d);
}

function aqTint(cell, tint) {
  if (tint === null || tint === undefined) return;
  cell.classList.add("aq-tinted");
  cell.style.background = AQ_TINTS[tint];
}

// reading: { index, main } or null
function aqBuildCell(scheme, reading) {
  const { cell, valueEl, valueRow } = aqCellShell("airQuality", AQ_SCHEME_LABEL[scheme] || "Air");
  if (!reading) {
    valueEl.textContent = "–";
    return cell;
  }
  valueEl.textContent = String(Math.round(reading.index));
  const band = aqBand(scheme, reading.index);
  aqAddDetail(valueRow, band ? band.word : "", AQ_POLLUTANT_NAMES[reading.main] || "");
  if (band) aqTint(cell, band.tint);
  return cell;
}

// top: { value, type } or null
function aqBuildPollenCell(top) {
  const { cell, valueEl, valueRow } = aqCellShell("pollen", "Pollen");
  const level = top ? aqPollenWord(top.value) : null;
  if (!level) {
    valueEl.textContent = "None";
    valueEl.style.fontSize = "17px";
    return cell;
  }
  valueEl.textContent = level.word;
  valueEl.style.fontSize = level.word.length > 6 ? "15px" : "17px";
  aqAddDetail(valueRow, AQ_POLLEN_NAMES[top.type] || "", "");
  aqTint(cell, level.tint);
  return cell;
}

// ---- UK front page cell (Settings → Front page cells → Air quality) ----
// Uses the front page's own place and sliders. Forecast only, so it shows
// "–" for past days on the Date slider, like Visibility.

const AQ_UK_CACHE_MS = 30 * 60000;
const AQ_UK_RETRY_MS = 5 * 60000;
let aqUkCache = null;          // { key, data, computed }
let aqUkInFlight = null;
let aqUkLastAttempt = { key: null, at: 0 };

function aqUkKey() { return `${state.lat.toFixed(2)},${state.lon.toFixed(2)}`; }

function aqUkMaybeFetch() {
  const key = aqUkKey();
  const fresh = aqUkCache && aqUkCache.key === key && Date.now() - aqUkCache.data.fetchedAt < AQ_UK_CACHE_MS;
  if (fresh || aqUkInFlight === key) return;
  if (aqUkLastAttempt.key === key && Date.now() - aqUkLastAttempt.at < AQ_UK_RETRY_MS) return;
  aqUkInFlight = key;
  aqUkLastAttempt = { key, at: Date.now() };
  aqFetch(state.lat, state.lon, "UTC")
    .then(data => { aqUkCache = { key, data, computed: aqComputeHourly(data, "daqi") }; })
    .catch(() => { /* no signal: shows "–" until the next try */ })
    .finally(() => {
      aqUkInFlight = null;
      if (aqUkCache && aqUkCache.key === key && typeof renderHeadline === "function" && aqUkKey() === key) renderHeadline();
    });
}

function buildAirQualityHeadlineCell() {
  if (typeof state === "undefined" || typeof state.lat !== "number" || typeof state.lon !== "number") return null;
  const rollback = state.rollback || 0;
  if (rollback > 0) return aqBuildCell("daqi", null);
  aqUkMaybeFetch();
  if (!aqUkCache || aqUkCache.key !== aqUkKey()) return aqBuildCell("daqi", null);
  const { data, computed } = aqUkCache;
  const nowSec = Date.now() / 1000;
  let reading;
  if (rollback === 0 && state.hourlyActive && typeof currentHourDate === "function") {
    reading = aqAtMoment(computed, data.times, currentHourDate().getTime() / 1000);
  } else if (rollback === 0) {
    const hours = typeof loadHourRange === "function" ? loadHourRange() : 24;
    reading = aqWorstBetween(computed, data.times, nowSec - 3600, nowSec + hours * 3600);
  } else {
    // A future day: that whole calendar day on this device.
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - rollback);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    reading = aqWorstBetween(computed, data.times, start.getTime() / 1000, end.getTime() / 1000);
  }
  return aqBuildCell("daqi", reading);
}

// New place: start afresh. A refresh of the same place keeps what's
// there (no "–" flash, no extra download).
document.addEventListener("cloude:location-ready", () => {
  if (typeof state === "undefined" || typeof state.lat !== "number") return;
  if (aqUkCache && aqUkCache.key === aqUkKey()) return;
  aqUkCache = null;
  aqUkLastAttempt = { key: null, at: 0 };
});
