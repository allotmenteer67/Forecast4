// ==== Sunrise / sunset and Visibility headline cells ====
//
// Two optional front page cells, ticked in Settings → Front page cells
// ("Sunrise & sunset", "Visibility"). app.js's renderHeadline calls
// buildSunVisHeadlineCell() for each one that's ticked, in the same
// place in the grid as the other optional cells.
//
// Sun: sunrise / sunset for the day the front page is showing, worked
// out on the phone from the date and position (no download, works with
// no signal). Times are this device's local time, like the rest of the
// app.
//
// Visibility: Open-Meteo's forecast for the hour on the hour slider, in
// shipping-forecast words (Good over 10 km, Moderate 4–10 km, Poor
// 1–4 km, Very poor under 1 km) with the distance beside it in the unit
// chosen in Settings → Units (km or miles). Forecast only, so it shows
// "—" when the Date slider is off today.
//
// Kept in its own file so it can't disturb app.js.

const SUNVIS_CACHE_MS = 30 * 60000;   // fresh visibility every 30 minutes
const SUNVIS_RETRY_MS = 5 * 60000;    // after a failed download, wait before trying again
let sunVisCache = null;               // { key, fetchedAt, times, vis }
let sunVisInFlight = null;            // key being downloaded
let sunVisLastAttempt = { key: null, at: 0 };
const SUNVIS_SUN_FONT = "clamp(14px, 4.5vw, 22px)"; // as large as the cell width allows

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

function sunVisUsesMiles() {
  return typeof conditionUnit === "function" && conditionUnit("visibility") === "imperial";
}

function sunVisDistanceText(metres) {
  if (sunVisUsesMiles()) {
    const miles = metres / 1609.344;
    return miles < 1 ? `${miles.toFixed(1)} mi` : `${Math.round(miles)} mi`;
  }
  const km = metres / 1000;
  return km < 1 ? `${km.toFixed(1)} km` : `${Math.round(km)} km`;
}

// The moment the front page is showing: the hour slider's hour when the
// hourly figures are up, otherwise now moved by the Date slider.
function sunVisTargetMoment() {
  const rollback = state.rollback || 0;
  if (rollback === 0 && typeof currentHourDate === "function" && state.hourly && state.hourly.status === "ready") {
    return currentHourDate();
  }
  return new Date(Date.now() - rollback * 86400000);
}

function sunVisKey() { return `${state.lat.toFixed(2)},${state.lon.toFixed(2)}`; }

function sunVisMaybeFetch() {
  const key = sunVisKey();
  const fresh = sunVisCache && sunVisCache.key === key && Date.now() - sunVisCache.fetchedAt < SUNVIS_CACHE_MS;
  if (fresh || sunVisInFlight === key) return;
  if (sunVisLastAttempt.key === key && Date.now() - sunVisLastAttempt.at < SUNVIS_RETRY_MS) return;
  sunVisInFlight = key;
  sunVisLastAttempt = { key, at: Date.now() };
  const lat = state.lat, lon = state.lon;
  const url = "https://api.open-meteo.com/v1/forecast" +
    `?latitude=${lat}&longitude=${lon}&hourly=visibility&timeformat=unixtime&timezone=UTC&forecast_days=3`;
  fetch(url)
    .then(res => (res.ok ? res.json() : null))
    .then(data => {
      if (data && data.hourly && data.hourly.time) {
        sunVisCache = { key, fetchedAt: Date.now(), times: data.hourly.time, vis: data.hourly.visibility };
      }
    })
    .catch(() => { /* no signal: the cell shows "—" until the next try */ })
    .finally(() => {
      sunVisInFlight = null;
      // Repaint the cells now there's data. Only if the place hasn't
      // changed meanwhile, and only once per download.
      if (sunVisCache && sunVisCache.key === key && typeof renderHeadline === "function" && typeof state !== "undefined" && typeof state.lat === "number" && sunVisKey() === key) {
        renderHeadline();
      }
    });
}

function sunVisVisibilityMetres(moment) {
  if (!sunVisCache || sunVisCache.key !== sunVisKey()) return null;
  const sec = moment.getTime() / 1000;
  let idx = -1;
  for (let i = 0; i < sunVisCache.times.length; i++) {
    if (sunVisCache.times[i] <= sec) idx = i; else break;
  }
  if (idx < 0) return null;
  const m = sunVisCache.vis[idx];
  return typeof m === "number" ? m : null;
}

// These cells have no graph behind them yet, so they mustn't show the
// little ">" that tells you a cell opens one. Added once, here, rather
// than in style.css, to keep this feature in one file.
(function () {
  const style = document.createElement("style");
  style.textContent = ".headline-label.sunvis-no-chevron::after { display: none; }";
  document.head.appendChild(style);
})();

// Builds one cell with the same structure and classes as app.js's own
// headline cells, so it picks up exactly the same look in every theme.
function sunVisCellShell(conditionName, labelText) {
  const cell = document.createElement("button");
  cell.type = "button";
  cell.className = "headline-cell";
  cell.style.cursor = "default"; // no graph behind these yet

  const icon = document.createElement("span");
  icon.className = "headline-cell-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.innerHTML = (typeof HEADLINE_CELL_ICONS !== "undefined" && HEADLINE_CELL_ICONS[conditionName]) || "";

  const label = document.createElement("span");
  label.className = "headline-label sunvis-no-chevron";
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

function buildSunVisHeadlineCell(conditionName) {
  if (typeof state === "undefined" || typeof state.lat !== "number" || typeof state.lon !== "number") return null;
  const moment = sunVisTargetMoment();

  if (conditionName === "sun") {
    const { cell, valueEl } = sunVisCellShell("sun", "Sunrise / set");
    const noon = new Date(Date.UTC(moment.getFullYear(), moment.getMonth(), moment.getDate(), 12));
    const sun = sunVisEvent(noon, state.lat, state.lon, -0.833);
    valueEl.textContent = sun ? `${sunVisClock(sun.rise)}/${sunVisClock(sun.set)}` : "—";
    // Two times are wider than one number: a touch smaller so they fit
    // the half-width cell on a phone without wrapping.
    valueEl.style.fontSize = SUNVIS_SUN_FONT;
    valueEl.style.whiteSpace = "nowrap";
    return cell;
  }

  if (conditionName === "visibility") {
    const { cell, valueEl, valueRow } = sunVisCellShell("visibility", "Visibility");
    if ((state.rollback || 0) !== 0) {
      valueEl.textContent = "—";
      return cell;
    }
    sunVisMaybeFetch();
    const metres = sunVisVisibilityMetres(moment);
    if (metres === null) {
      valueEl.textContent = "—";
      return cell;
    }
    valueEl.textContent = sunVisWord(metres);
    valueEl.style.whiteSpace = "nowrap";
    if (metres >= 0) {
      const dist = document.createElement("span");
      dist.textContent = sunVisDistanceText(metres);
      dist.style.cssText = "font-size:0.8em;font-weight:600;opacity:0.75;white-space:nowrap;";
      valueRow.appendChild(dist);
    }
    return cell;
  }
  return null;
}

// New place: the old place's visibility mustn't be shown for it.
document.addEventListener("cloude:location-ready", () => {
  sunVisCache = null;
  sunVisLastAttempt = { key: null, at: 0 };
});
