// Builds data/forecast.json — a small, corrected daily + frost feed for
// My Plot (a separate app/repo) to read. Run by
// .github/workflows/build-forecast-feed.yml, as its own job rather than
// folded into precache-weather.yml's — see that workflow's own header
// for why.
//
// ---- What this deliberately reuses rather than re-fetches ----
// No live Open-Meteo call of its own. Everything it needs is already
// being fetched and committed by two other scripts:
//   - data/precache-weather.json (precache-weather.mjs) — TA7's current
//     3-day hourly forecast from the top forecasters, refreshed ~20 min
//   - data/backfill/TA7.json (backfill-weather.mjs) — a year of
//     forecast-vs-actual pairs for TA7, refreshed monthly, which is all
//     the raw material FFV correction actually needs (see ffv-core.mjs)
// If either file is missing or doesn't cover TA7, this writes nothing
// and exits cleanly — My Plot's own fallback to a plain Open-Meteo call
// covers that gap; a half-written forecast.json would be worse than none.
//
// ---- "Ours, with a fallback to metoffice" ----
// For every hour and every one of rain/wind/temperature/cloud: take the
// median of that hour's FFV-corrected reading across every source that
// has data for it. Only if NO source has data for that hour (a genuine
// gap, not just low confidence) does that hour fall back to metoffice's
// own raw reading instead — metoffice is the one source always present
// (see precache-weather.mjs's own reasoning). A field only ever comes
// back null if metoffice itself has nothing for that hour either.
//
// ---- Cloud ----
// Each band (cloudLow/cloudMid/cloudHigh) is corrected and blended
// exactly like any other real condition, THEN combined into one
// "effective cloud" figure via the same max(low, mid*0.7, high*0.4)
// weighting app.js's own effectiveCloudCover uses — see ffv-core.mjs.
//
// ---- Frost ----
// Ported from app.js's own frostRiskTonight(), restricted to the night
// window specifically (22:00–07:00) rather than the whole displayed
// window, per the agreed design: hourly night cloud is a better frost
// signal than a whole day's average. Threshold: 4°C (ground frost can
// form at a few degrees above freezing), cloud < 40%, wind < 8mph —
// same numbers as app.js's own FROST_* constants.

import { readFile, writeFile } from "node:fs/promises";
import { buildFFVStore, ffvFor, applyCorrection, median, effectiveCloudCover } from "./ffv-core.mjs";

const CONFIG_PATH = new URL("../data/precache-config.json", import.meta.url);
const PRECACHE_PATH = new URL("../data/precache-weather.json", import.meta.url);
const BACKFILL_DIR = new URL("../data/backfill/", import.meta.url);
const OUTPUT_PATH = new URL("../data/forecast.json", import.meta.url);

// The one area this feed serves — the allotment's own saved favourite.
// Hand-set here rather than derived, same "asks rather than guesses"
// reasoning backfill-weather.mjs already uses for areaCode: there's no
// safe way to infer which of possibly several favourites is "the
// allotment" from the config file alone.
const AREA_CODE = "TA7";

const FROST_TEMP_THRESHOLD = 4; // °C
const FROST_CLOUD_THRESHOLD = 40; // %
const FROST_WIND_THRESHOLD = 8; // mph
const NIGHT_START_HOUR = 22;
const NIGHT_END_HOUR = 7;

// Conditions this feed corrects — a subset of app.js's REAL_DATA_
// CONDITIONS, just the ones the feed actually uses.
const CONDITIONS = ["rain", "wind", "temperature", "cloudLow", "cloudMid", "cloudHigh"];

async function readJsonIfExists(url) {
  try {
    return JSON.parse(await readFile(url, "utf8"));
  } catch {
    return null;
  }
}

// day bucket convention, matching app.js's applyHourlyBlend exactly: an
// hour before midnight tonight is lead-day 1, the next day is lead-day
// 2. (Same known simplification for a hypothetical day-3 hour as
// app.js itself has — not a new limitation introduced here.)
function leadDayForHourIndex(i) {
  return i < 24 ? 1 : 2;
}

// For one field at one hour: median of FFV-corrected values across every
// source with data, falling back to metoffice's raw reading only if no
// source has data at all.
function blendHour(sourcesById, sourceIds, field, conditionName, hourIdx, ffvStore) {
  const values = sourceIds
    .map(sourceId => {
      const raw = sourcesById[sourceId]?.[field]?.[hourIdx];
      if (raw === null || raw === undefined) return null;
      const day = leadDayForHourIndex(hourIdx);
      const ffv = ffvFor(ffvStore, sourceId, conditionName, day);
      return ffv !== null ? applyCorrection(raw, ffv, conditionName) : raw;
    })
    .filter(v => v !== null && v !== undefined);

  if (values.length) return { value: median(values), corrected: true };

  const metofficeRaw = sourcesById.metoffice?.[field]?.[hourIdx];
  if (metofficeRaw !== null && metofficeRaw !== undefined) {
    return { value: metofficeRaw, corrected: false };
  }
  return { value: null, corrected: false };
}

function localDate(isoLike) {
  return isoLike.slice(0, 10);
}

function localHour(isoLike) {
  return Number(isoLike.slice(11, 13));
}

async function main() {
  const config = await readJsonIfExists(CONFIG_PATH);
  const isFavourite = (config?.weatherFavourites || []).some(f => f.outcode === AREA_CODE);
  if (!isFavourite) {
    console.log(`${AREA_CODE} isn't in weatherFavourites — nothing to build. Add it as a saved favourite first.`);
    return;
  }

  const precache = await readJsonIfExists(PRECACHE_PATH);
  const entry = precache?.weather?.find(w => w.label === AREA_CODE);
  if (!entry) {
    console.log(`No precached weather entry for ${AREA_CODE} yet — nothing to build this run.`);
    return;
  }

  const history = await readJsonIfExists(new URL(`${AREA_CODE}.json`, BACKFILL_DIR));
  const sourceIds = entry.sourcesFetched || Object.keys(entry.sources || {});
  const ffvStore = history ? buildFFVStore(history, CONDITIONS, sourceIds) : {};
  if (!history) {
    console.log(`No backfill file for ${AREA_CODE} yet — proceeding with raw (uncorrected) figures only.`);
  }

  const times = entry.times || [];
  const hourly = { rain: [], wind: [], temperature: [], cloud: [] };
  let anyCorrected = false;

  for (let i = 0; i < times.length; i++) {
    const rain = blendHour(entry.sources, sourceIds, "precipitation", "rain", i, ffvStore);
    const wind = blendHour(entry.sources, sourceIds, "windSpeed", "wind", i, ffvStore);
    const temp = blendHour(entry.sources, sourceIds, "temperature", "temperature", i, ffvStore);
    const cLow = blendHour(entry.sources, sourceIds, "cloudLow", "cloudLow", i, ffvStore);
    const cMid = blendHour(entry.sources, sourceIds, "cloudMid", "cloudMid", i, ffvStore);
    const cHigh = blendHour(entry.sources, sourceIds, "cloudHigh", "cloudHigh", i, ffvStore);

    if (rain.corrected || wind.corrected || temp.corrected || cLow.corrected) anyCorrected = true;

    hourly.rain.push(rain.value);
    hourly.wind.push(wind.value);
    hourly.temperature.push(temp.value);
    hourly.cloud.push(
      cLow.value === null ? null : effectiveCloudCover(cLow.value, cMid.value, cHigh.value)
    );
  }

  // ---- Daily aggregates, one entry per local calendar date present ----
  const daily = {};
  times.forEach((t, i) => {
    const date = localDate(t);
    daily[date] ??= { rain: 0, rainKnown: false, windMax: null, tempMin: null, tempMax: null };
    const d = daily[date];
    if (hourly.rain[i] !== null) {
      d.rain += hourly.rain[i];
      d.rainKnown = true;
    }
    if (hourly.wind[i] !== null) d.windMax = d.windMax === null ? hourly.wind[i] : Math.max(d.windMax, hourly.wind[i]);
    if (hourly.temperature[i] !== null) {
      d.tempMin = d.tempMin === null ? hourly.temperature[i] : Math.min(d.tempMin, hourly.temperature[i]);
      d.tempMax = d.tempMax === null ? hourly.temperature[i] : Math.max(d.tempMax, hourly.temperature[i]);
    }
  });
  Object.keys(daily).forEach(date => {
    const d = daily[date];
    daily[date] = {
      rain: d.rainKnown ? Math.round(d.rain * 10) / 10 : null,
      wind: d.windMax === null ? null : Math.round(d.windMax),
      temperature: (d.tempMin === null || d.tempMax === null) ? null : { min: Math.round(d.tempMin * 10) / 10, max: Math.round(d.tempMax * 10) / 10 }
    };
  });

  // ---- Frost: the first 22:00→07:00 window at or after now ----
  let nightStartIdx = -1;
  for (let i = 0; i < times.length; i++) {
    if (localHour(times[i]) === NIGHT_START_HOUR) {
      nightStartIdx = i;
      break;
    }
  }
  let frost = null;
  if (nightStartIdx !== -1) {
    let idx = nightStartIdx;
    let minTemp = Infinity;
    let minIdx = -1;
    while (idx < times.length) {
      const hour = localHour(times[idx]);
      const pastMidnight = idx > nightStartIdx && hour === NIGHT_START_HOUR; // wrapped into the following night
      if (pastMidnight) break;
      if (hour >= NIGHT_START_HOUR || hour < NIGHT_END_HOUR) {
        if (hourly.temperature[idx] !== null && hourly.temperature[idx] < minTemp) {
          minTemp = hourly.temperature[idx];
          minIdx = idx;
        }
        if (hour === NIGHT_END_HOUR - 1) break; // 06:xx was the last in-window hour before 07:00
      } else {
        break; // ran past 07:00 without a wrap flag — window's over
      }
      idx++;
    }

    if (minIdx !== -1) {
      const cloud = hourly.cloud[minIdx];
      const wind = hourly.wind[minIdx];
      const risk = minTemp <= FROST_TEMP_THRESHOLD && cloud !== null && cloud < FROST_CLOUD_THRESHOLD && wind !== null && wind < FROST_WIND_THRESHOLD;
      frost = {
        night: localDate(times[nightStartIdx]),
        minTemp: Math.round(minTemp * 10) / 10,
        cloud: cloud === null ? null : Math.round(cloud),
        wind: wind === null ? null : Math.round(wind),
        risk
      };
    }
  }

  const output = {
    updated: precache.dataAsOf,
    areaCode: AREA_CODE,
    corrected: anyCorrected,
    daily,
    frost
  };

  await writeFile(OUTPUT_PATH, JSON.stringify(output), "utf8");
  console.log(`Wrote ${OUTPUT_PATH.pathname} — ${Object.keys(daily).length} day(s), frost ${frost ? (frost.risk ? "risk tonight" : "no risk tonight") : "not computed"}.`);
}

main().catch(err => {
  console.error("build-forecast-feed failed:", err);
  process.exit(1);
});
