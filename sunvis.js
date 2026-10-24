// ==== Sunrise, sunset and visibility on the front page ====
//
// One slim line under the headline cells, following the same place, Date
// slider and hour slider as everything else on the front page:
//   Sunrise 07:51 · Sunset 18:07 · Visibility Good, 14 km
//
// Sunrise and sunset are worked out on the phone from the date and
// position (same method as the callout screen), so they need no download.
// Visibility comes from Open-Meteo's forecast for the hour the slider is
// on, in shipping-forecast words. It's only shown for today's forecast
// (Date slider on today): there's no visibility history to look back on.
//
// Kept in its own file so it can't disturb app.js. It only reads
// state.lat/lon, state.rollback and the hour slider.

const SUNVIS_LINE_ID = "sunVisLine";
const SUNVIS_CACHE_MS = 30 * 60000;
let sunVisCache = null; // { key, fetchedAt, times, vis }
let sunVisFetching = null;

function sunVisEvent(dayUtcNoon, lat, lon, altitudeDeg) {
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
  if (cosH > 1 || cosH < -1) return null;
  const H = Math.acos(cosH) / rad;
  const toDate = j => new Date((j - 2440587.5) * 86400000);
  return { rise: toDate(jTransit - H / 360), set: toDate(jTransit + H / 360) };
}

function sunVisWord(metres) {
  if (metres < 1000) return "Very poor";
  if (metres < 4000) return "Poor";
  if (metres < 10000) return "Moderate";
  return "Good";
}

function sunVisClock(date) {
  return date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

function sunVisSliderHours() {
  const slider = document.getElementById("hourSlider");
  return slider ? Math.round(Number(slider.value) || 0) : 0;
}

// The moment the front page is showing: now, moved by the Date slider
// (days) and the hour slider (hours).
function sunVisTargetMoment() {
  const rollback = (typeof state !== "undefined" && state.rollback) ? state.rollback : 0;
  return new Date(Date.now() - rollback * 86400000 + sunVisSliderHours() * 3600000);
}

async function sunVisFetch(lat, lon) {
  const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  if (sunVisCache && sunVisCache.key === key && Date.now() - sunVisCache.fetchedAt < SUNVIS_CACHE_MS) return sunVisCache;
  if (sunVisFetching && sunVisFetching.key === key) return sunVisFetching.promise;
  const url = "https://api.open-meteo.com/v1/forecast" +
    `?latitude=${lat}&longitude=${lon}&hourly=visibility&timeformat=unixtime&timezone=UTC&forecast_days=3`;
  const promise = (async () => {
    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      const data = await res.json();
      if (!data.hourly || !data.hourly.time) return null;
      sunVisCache = { key, fetchedAt: Date.now(), times: data.hourly.time, vis: data.hourly.visibility };
      return sunVisCache;
    } catch {
      return null; // no signal — the line just shows sunrise and sunset
    } finally {
      sunVisFetching = null;
    }
  })();
  sunVisFetching = { key, promise };
  return promise;
}

function sunVisVisibilityText(cache, moment) {
  if (!cache) return "";
  const sec = moment.getTime() / 1000;
  let idx = -1;
  for (let i = 0; i < cache.times.length; i++) {
    if (cache.times[i] <= sec) idx = i; else break;
  }
  if (idx < 0 || typeof cache.vis[idx] !== "number") return "";
  const m = cache.vis[idx];
  const km = m < 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m / 1000)} km`;
  return `Visibility ${sunVisWord(m)}, ${km}`;
}

function renderSunVis() {
  const line = document.getElementById(SUNVIS_LINE_ID);
  if (!line) return;
  if (typeof state === "undefined" || typeof state.lat !== "number" || typeof state.lon !== "number") {
    line.hidden = true;
    return;
  }
  const moment = sunVisTargetMoment();
  const noon = new Date(Date.UTC(moment.getUTCFullYear(), moment.getUTCMonth(), moment.getUTCDate(), 12));
  const sun = sunVisEvent(noon, state.lat, state.lon, -0.833);
  const parts = [];
  if (sun) parts.push(`Sunrise ${sunVisClock(sun.rise)}`, `Sunset ${sunVisClock(sun.set)}`);

  const rollback = state.rollback || 0;
  if (rollback === 0) {
    const cached = sunVisCache && sunVisCache.key === `${state.lat.toFixed(2)},${state.lon.toFixed(2)}` ? sunVisCache : null;
    const visText = sunVisVisibilityText(cached, moment);
    if (visText) parts.push(visText);
    if (!cached || Date.now() - cached.fetchedAt >= SUNVIS_CACHE_MS) {
      sunVisFetch(state.lat, state.lon).then(result => { if (result) renderSunVisText(); });
    }
  }
  line.textContent = parts.join(" · ");
  line.hidden = parts.length === 0;
}

// Re-render without starting another download (used after one finishes).
function renderSunVisText() {
  renderSunVis();
}

document.addEventListener("cloude:location-ready", () => {
  sunVisCache = null; // new place: new visibility
  renderSunVis();
});
document.addEventListener("input", e => {
  if (e.target && (e.target.id === "hourSlider" || e.target.type === "range")) renderSunVis();
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") renderSunVis();
});
// The Date slider and anything else that changes state without an event
// this file hears: a cheap check once a minute keeps the line honest.
setInterval(renderSunVis, 60000);
renderSunVis();
