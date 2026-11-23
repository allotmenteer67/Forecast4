// wind-blend.js — blended wind for the Callout and Coast pages.
//
// These two pages don't load app.js (they're kept light for use at sea),
// so they used to ask Open-Meteo for its single default "best match"
// model. Everything else in Cloude blends the nine real forecasters, so
// this does the same for wind: one request naming all nine models, then
// for each hour the median wind and gust across them, and the direction
// from the first forecaster that has one (Met Office first) — the same
// rules the front page uses.
//
// No fudge-factor correction here: these pages often look at a position
// at sea, far from the place your corrections were learned for.
//
// Keep WIND_BLEND_MODELS in step with REAL_SOURCES in app.js (copied, as
// this project does for helpers shared by pages that don't load app.js).
const WIND_BLEND_MODELS = [
  "ukmo_global_deterministic_10km", "ecmwf_ifs025", "gfs_seamless", "icon_seamless",
  "gem_seamless", "meteofrance_seamless", "jma_seamless", /* "bom_access_global", PAUSED 23 Nov 2026, see DECISIONS.md */ "cma_grapes_global"
];

function windBlendMedian(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Returns an hourly object shaped exactly like a plain Open-Meteo
// response's (time, wind_speed_10m, wind_gusts_10m, wind_direction_10m),
// so the pages' existing drawing code needs no changes.
async function fetchBlendedWindHourly(lat, lon, forecastDays = 2, timeoutMs = 20000) {
  const url = "https://api.open-meteo.com/v1/forecast" +
    `?latitude=${lat}&longitude=${lon}` +
    "&hourly=wind_speed_10m,wind_gusts_10m,wind_direction_10m" +
    `&models=${WIND_BLEND_MODELS.join(",")}` +
    `&wind_speed_unit=mph&timeformat=unixtime&timezone=UTC&forecast_days=${forecastDays}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let data;
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`Wind download failed (${res.status})`);
    data = await res.json();
  } finally {
    clearTimeout(timer);
  }
  const h = data && data.hourly;
  if (!h || !Array.isArray(h.time)) throw new Error("Wind download had no hourly data");
  const series = key => WIND_BLEND_MODELS.map(m => h[`${key}_${m}`] || []);
  const speed = series("wind_speed_10m"), gust = series("wind_gusts_10m"), dir = series("wind_direction_10m");
  const pick = (list, i) => list.map(s => s[i]).filter(v => typeof v === "number");
  const out = { time: h.time, wind_speed_10m: [], wind_gusts_10m: [], wind_direction_10m: [], blendedFrom: 0 };
  h.time.forEach((_, i) => {
    const sp = pick(speed, i);
    out.wind_speed_10m.push(windBlendMedian(sp));
    out.wind_gusts_10m.push(windBlendMedian(pick(gust, i)));
    const d = pick(dir, i);
    out.wind_direction_10m.push(d.length ? d[0] : null);
    out.blendedFrom = Math.max(out.blendedFrom, sp.length);
  });
  if (!out.blendedFrom) throw new Error("No forecaster had wind for this spot");
  return out;
}

// Puts blended wind into an existing hourly object (matched by time), so
// anything else it carries — visibility on the Callout page — is kept.
function mergeBlendedWind(hourly, blended) {
  const at = new Map(blended.time.map((t, i) => [t, i]));
  ["wind_speed_10m", "wind_gusts_10m", "wind_direction_10m"].forEach(key => {
    hourly[key] = hourly.time.map((t, i) => {
      const j = at.get(t);
      const v = j === undefined ? null : blended[key][j];
      return typeof v === "number" ? v : hourly[key] ? hourly[key][i] : null;
    });
  });
  hourly.windBlendedFrom = blended.blendedFrom;
  return hourly;
}
