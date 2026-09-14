// Pre-computes a full year of real-source forecast-vs-actual history for
// every known saved weather place (data/precache-config.json's
// weatherLocations + weatherFavourites), so tapping "Backfill 1 year of
// real data" on Compare for one of THESE areas downloads one small file
// instead of running the full live year-long fetch on the phone itself.
// Run monthly — not daily, a year of history barely moves day to day —
// by .github/workflows/backfill-weather.yml, or manually via
// workflow_dispatch.
//
// ---- Why this duplicates collect-weather.mjs's own fetch logic rather
// than importing it ----
// collect-weather.mjs's main() runs unconditionally at import time (no
// entry-point guard) — importing anything from that file would also
// trigger its own single-area daily collection as a side effect, which
// needs FORECAST_LAT/FORECAST_LON secrets this workflow doesn't set.
// Duplicating the small stateless helpers (isoDate, addDays,
// aggregateHourlyByDay, the actual/model fetchers) instead follows the
// same convention precache-weather.mjs already established for its own
// REAL_SOURCES_BY_ID copy — these scripts have no shared module system
// between them, so a hand-kept-in-sync copy is the existing house
// style here, not a shortcut invented for this file.
//
// ---- Output shape ----
// Deliberately identical to data/history.json — { updated, areaCode,
// days: { <date>: { actual: {...}, models: { <sourceId>: { <day 1-7>:
// {...} } } } } } — because app.js already has a fully-tested function
// that turns that exact shape into FFV samples
// (applyHistoryFileToFFV, shared with loadCommittedHistory's own
// replay). One file per area, data/backfill/<areaCode>.json, rather
// than one combined file: the app only ever wants ONE area at a time
// (whatever the current postcode resolves to), so serving the rest
// would just be wasted download.
//
// ---- Coverage ----
// weatherFavourites already carry their own outward code (areaCode IS
// the outcode, e.g. "TA6") — no extra step needed, resolved via the
// same postcodes.io outcode lookup precache-weather.mjs's own
// geocodeOutcode already trusts. weatherLocations (the hand-typed
// places) need an explicit "areaCode" field added by hand in
// precache-config.json, same hand-maintained spirit as the rest of
// that file — a location with no areaCode set is skipped with a
// warning, exactly how collect-weather.mjs already treats a missing
// FORECAST_AREA_CODE secret ("not fatal... the app just won't apply
// it"). There's no safe way to derive a postcode area from a bare
// lat/lon here without risking a silent mismatch against whatever area
// the app itself would resolve for that place, so this doesn't try —
// it asks rather than guesses.

import { readFile, writeFile, mkdir } from "node:fs/promises";

const CONFIG_PATH = new URL("../data/precache-config.json", import.meta.url);
const BACKFILL_DIR = new URL("../data/backfill/", import.meta.url);

const ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive";
const PREVIOUS_RUNS_URL = "https://previous-runs-api.open-meteo.com/v1/forecast";
const OUTCODE_GEOCODE_URL = "https://api.postcodes.io/outcodes/";
const BACKFILL_DAYS = 365;

// Kept in sync BY HAND with REAL_SOURCES in app.js — same duplication
// collect-weather.mjs and precache-weather.mjs each already carry their
// own copy of, for the reason given at the top of this file.
const MODELS = [
  { id: "metoffice", model: "ukmo_global_deterministic_10km" },
  { id: "ecmwf", model: "ecmwf_ifs025" },
  { id: "gfs", model: "gfs_seamless" },
  { id: "icon", model: "icon_seamless" },
  { id: "gem", model: "gem_seamless" },
  { id: "meteofrance", model: "meteofrance_seamless" },
  { id: "jma", model: "jma_seamless" },
  { id: "bom", model: "bom_access_global" },
  { id: "cma", model: "cma_grapes_global" }
];

// Same WMO DNI>120W/m² rule as collect-weather.mjs's own
// sunshineHoursFromDni — see that file's header for why this is needed
// at all (the previous-runs endpoint has no sunshine_duration field of
// its own).
const SUNSHINE_DNI_THRESHOLD_WM2 = 120;
function sunshineHoursFromDni(dniValues) {
  return dniValues.filter(v => v !== null && v !== undefined && v > SUNSHINE_DNI_THRESHOLD_WM2).length;
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(date, days) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function aggregateHourlyByDay(hourlyTimes, values, dayCount, mode) {
  const buckets = Array.from({ length: dayCount }, () => []);
  hourlyTimes.forEach((t, i) => {
    const dayIndex = Math.floor(i / 24);
    const v = values[i];
    if (dayIndex < dayCount && v !== null && v !== undefined) {
      buckets[dayIndex].push(v);
    }
  });
  return buckets.map(vals => {
    if (!vals.length) return null;
    switch (mode) {
      case "max": return Math.max(...vals);
      case "min": return Math.min(...vals);
      case "sum": return vals.reduce((a, b) => a + b, 0);
      case "mean":
      default:
        return vals.reduce((a, b) => a + b, 0) / vals.length;
    }
  });
}

// Identical to collect-weather.mjs's own fetchActual — neither function
// hardcodes its own window, so the only real difference here is the
// year-long start/end this script calls it with, versus that file's
// rolling week.
async function fetchActual(lat, lon, start, end) {
  const params = new URLSearchParams({
    latitude: lat,
    longitude: lon,
    daily: "temperature_2m_max,temperature_2m_min,precipitation_sum,windspeed_10m_max,sunshine_duration",
    hourly: "cloudcover_low,cloudcover_mid,cloudcover_high,pressure_msl,soil_temperature_0cm,dewpoint_2m",
    start_date: isoDate(start),
    end_date: isoDate(end),
    wind_speed_unit: "mph",
    timezone: "auto"
  });
  const res = await fetch(`${ARCHIVE_URL}?${params.toString()}`, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`Actual weather fetch failed: ${res.status}`);
  const data = await res.json();
  const dayCount = data.daily.time.length;

  const cloudLow = aggregateHourlyByDay(data.hourly.time, data.hourly.cloudcover_low, dayCount, "mean");
  const cloudMid = aggregateHourlyByDay(data.hourly.time, data.hourly.cloudcover_mid, dayCount, "mean");
  const cloudHigh = aggregateHourlyByDay(data.hourly.time, data.hourly.cloudcover_high, dayCount, "mean");
  const pressure = aggregateHourlyByDay(data.hourly.time, data.hourly.pressure_msl, dayCount, "mean");
  const soilTemperature = aggregateHourlyByDay(data.hourly.time, data.hourly.soil_temperature_0cm, dayCount, "mean");
  const dewPoint = aggregateHourlyByDay(data.hourly.time, data.hourly.dewpoint_2m, dayCount, "mean");

  const byDate = {};
  data.daily.time.forEach((date, i) => {
    const max = data.daily.temperature_2m_max[i];
    const min = data.daily.temperature_2m_min[i];
    // Real archive field, in seconds — already has the DNI>120W/m² rule
    // applied by Open-Meteo itself here, unlike the per-model side
    // below. Converted to hours to match the unit the rest of the app
    // already uses for Sunshine.
    const sunshineSeconds = data.daily.sunshine_duration ? data.daily.sunshine_duration[i] : null;
    byDate[date] = {
      rain: data.daily.precipitation_sum[i],
      wind: data.daily.windspeed_10m_max[i],
      cloudLow: cloudLow[i],
      cloudMid: cloudMid[i],
      cloudHigh: cloudHigh[i],
      pressure: pressure[i],
      soilTemperature: soilTemperature[i],
      dewPoint: dewPoint[i],
      temperature: (max !== null && min !== null) ? (max + min) / 2 : null,
      sunshine: sunshineSeconds !== null && sunshineSeconds !== undefined ? sunshineSeconds / 3600 : null
    };
  });
  return byDate;
}

// Identical to collect-weather.mjs's own fetchModel — see that file for
// the full reasoning on field naming/units (in particular why
// "cloud_cover" here has an underscore but fetchActual's "cloudcover"
// above doesn't — the archive and previous-runs endpoints spell it
// differently).
async function fetchModel(lat, lon, model, start, end) {
  const hourlyVars = [];
  for (let d = 1; d <= 7; d++) {
    hourlyVars.push(
      `temperature_2m_previous_day${d}`,
      `precipitation_previous_day${d}`,
      `wind_speed_10m_previous_day${d}`,
      `cloud_cover_low_previous_day${d}`,
      `cloud_cover_mid_previous_day${d}`,
      `cloud_cover_high_previous_day${d}`,
      `pressure_msl_previous_day${d}`,
      `soil_temperature_0cm_previous_day${d}`,
      `dewpoint_2m_previous_day${d}`,
      `direct_normal_irradiance_previous_day${d}`
    );
  }

  const params = new URLSearchParams({
    latitude: lat,
    longitude: lon,
    hourly: hourlyVars.join(","),
    start_date: isoDate(start),
    end_date: isoDate(end),
    models: model,
    wind_speed_unit: "mph",
    timezone: "auto"
  });
  const res = await fetch(`${PREVIOUS_RUNS_URL}?${params.toString()}`, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`Model fetch failed for ${model}: ${res.status}`);
  const data = await res.json();
  const hourlyTimes = data.hourly.time;
  const dayCount = Math.floor(hourlyTimes.length / 24);
  const dates = [];
  for (let i = 0; i < dayCount; i++) dates.push(isoDate(addDays(start, i)));

  const byLeadDay = {};
  for (let d = 1; d <= 7; d++) {
    const tempMax = aggregateHourlyByDay(hourlyTimes, data.hourly[`temperature_2m_previous_day${d}`], dayCount, "max");
    const tempMin = aggregateHourlyByDay(hourlyTimes, data.hourly[`temperature_2m_previous_day${d}`], dayCount, "min");
    // Counted, not aggregated via aggregateHourlyByDay — "sunshine
    // hours" needs a count of hours clearing the DNI threshold, not a
    // mean/sum/max/min of the raw DNI values themselves.
    const dniSeries = data.hourly[`direct_normal_irradiance_previous_day${d}`];
    const sunshine = [];
    for (let day = 0; day < dayCount; day++) {
      const dayValues = dniSeries.slice(day * 24, day * 24 + 24);
      sunshine.push(dayValues.some(v => v !== null && v !== undefined) ? sunshineHoursFromDni(dayValues) : null);
    }
    byLeadDay[d] = {
      tempAvg: tempMax.map((max, i) => (max !== null && tempMin[i] !== null) ? (max + tempMin[i]) / 2 : null),
      precip: aggregateHourlyByDay(hourlyTimes, data.hourly[`precipitation_previous_day${d}`], dayCount, "sum"),
      wind: aggregateHourlyByDay(hourlyTimes, data.hourly[`wind_speed_10m_previous_day${d}`], dayCount, "max"),
      cloudLow: aggregateHourlyByDay(hourlyTimes, data.hourly[`cloud_cover_low_previous_day${d}`], dayCount, "mean"),
      cloudMid: aggregateHourlyByDay(hourlyTimes, data.hourly[`cloud_cover_mid_previous_day${d}`], dayCount, "mean"),
      cloudHigh: aggregateHourlyByDay(hourlyTimes, data.hourly[`cloud_cover_high_previous_day${d}`], dayCount, "mean"),
      pressure: aggregateHourlyByDay(hourlyTimes, data.hourly[`pressure_msl_previous_day${d}`], dayCount, "mean"),
      soilTemperature: aggregateHourlyByDay(hourlyTimes, data.hourly[`soil_temperature_0cm_previous_day${d}`], dayCount, "mean"),
      dewPoint: aggregateHourlyByDay(hourlyTimes, data.hourly[`dewpoint_2m_previous_day${d}`], dayCount, "mean"),
      sunshine
    };
  }

  const byDate = {};
  dates.forEach((date, i) => {
    byDate[date] = {};
    for (let d = 1; d <= 7; d++) {
      byDate[date][d] = {
        rain: byLeadDay[d].precip[i],
        wind: byLeadDay[d].wind[i],
        cloudLow: byLeadDay[d].cloudLow[i],
        cloudMid: byLeadDay[d].cloudMid[i],
        cloudHigh: byLeadDay[d].cloudHigh[i],
        pressure: byLeadDay[d].pressure[i],
        soilTemperature: byLeadDay[d].soilTemperature[i],
        dewPoint: byLeadDay[d].dewPoint[i],
        temperature: byLeadDay[d].tempAvg[i],
        sunshine: byLeadDay[d].sunshine[i]
      };
    }
  });
  return byDate;
}

// Same outcode -> centroid resolution as precache-weather.mjs's own
// geocodeOutcode — duplicated for the reason given at the top of this
// file. Never throws; a favourite that fails to geocode is skipped
// with a logged error rather than failing the whole run.
async function geocodeOutcode(outcode) {
  try {
    const res = await fetch(OUTCODE_GEOCODE_URL + encodeURIComponent(outcode), { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.result) return null;
    return { lat: data.result.latitude, lon: data.result.longitude };
  } catch (err) {
    console.error(`Favourite outcode "${outcode}" failed to geocode: ${err.message}`);
    return null;
  }
}

// Turns config.weatherLocations + weatherFavourites into one flat list
// of { areaCode, lat, lon, label } to backfill — see this file's own
// header for why a hand-typed location with no areaCode is skipped
// rather than guessed at.
async function resolveAreas(config) {
  const areas = [];

  (config.weatherLocations || []).forEach(loc => {
    if (!loc.areaCode) {
      console.warn(`Skipping "${loc.id}" — no areaCode set in precache-config.json (add one, e.g. "areaCode": "TA1", to include it).`);
      return;
    }
    areas.push({ areaCode: loc.areaCode, lat: loc.lat, lon: loc.lon, label: loc.label });
  });

  const favouriteGeo = await Promise.all((config.weatherFavourites || []).map(async fav => {
    const geo = await geocodeOutcode(fav.outcode);
    if (!geo) {
      console.error(`Skipping favourite "${fav.outcode}" — couldn't geocode.`);
      return null;
    }
    return { areaCode: fav.outcode, lat: geo.lat, lon: geo.lon, label: fav.outcode };
  }));
  favouriteGeo.filter(Boolean).forEach(a => areas.push(a));

  // A hand-typed location and a favourite could legitimately resolve to
  // the same area (e.g. someone starred their own already-saved TA6) —
  // de-duplicate by areaCode, first entry wins, so this never fetches
  // (and never writes) the same file twice in one run.
  const seen = new Set();
  return areas.filter(a => {
    if (seen.has(a.areaCode)) return false;
    seen.add(a.areaCode);
    return true;
  });
}

async function backfillArea(area) {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const end = addDays(today, -1); // yesterday — today's actual isn't final yet
  const start = addDays(end, -(BACKFILL_DAYS - 1));

  const actualByDate = await fetchActual(area.lat, area.lon, start, end);

  const modelsByDate = {};
  const failedSourceIds = [];
  for (const { id, model } of MODELS) {
    try {
      modelsByDate[id] = await fetchModel(area.lat, area.lon, model, start, end);
    } catch (err) {
      console.error(`  ${area.areaCode}/${id} failed, continuing with the remaining sources: ${err.message}`);
      failedSourceIds.push(id);
    }
  }

  const days = {};
  Object.keys(actualByDate).forEach(date => {
    days[date] = { actual: actualByDate[date], models: {} };
    for (const { id } of MODELS) {
      if (modelsByDate[id]?.[date]) days[date].models[id] = modelsByDate[id][date];
    }
  });

  return { output: { updated: isoDate(today), areaCode: area.areaCode, days }, failedSourceIds };
}

async function main() {
  const config = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
  const areas = await resolveAreas(config);

  if (!areas.length) {
    console.log("No areas with a usable areaCode to backfill — nothing to do.");
    return;
  }

  await mkdir(BACKFILL_DIR, { recursive: true });

  console.log(`Backfill run starting — ${areas.length} area(s): ${areas.map(a => a.areaCode).join(", ")}`);

  for (const area of areas) {
    try {
      console.log(`Backfilling ${area.areaCode} (${area.label})...`);
      const { output, failedSourceIds } = await backfillArea(area);
      const outPath = new URL(`${area.areaCode}.json`, BACKFILL_DIR);
      await writeFile(outPath, JSON.stringify(output), "utf8");
      const dayCount = Object.keys(output.days).length;
      const failedNote = failedSourceIds.length ? ` (${failedSourceIds.join(", ")} failed this run)` : "";
      console.log(`  wrote ${area.areaCode}.json — ${dayCount} days${failedNote}.`);
    } catch (err) {
      // A whole-area failure (e.g. the Actual archive fetch itself
      // failing) skips writing that area's file this run rather than
      // half-writing one — whatever's already committed for it stays as
      // it is, and this self-heals on next month's run, same "a missed
      // run self-heals" convention collect-weather.mjs already follows.
      console.error(`${area.areaCode} failed entirely, leaving any existing file untouched: ${err.message}`);
    }
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
