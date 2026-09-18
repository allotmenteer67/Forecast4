// ---- FFV correction math, ported from app.js ----
//
// app.js's own FFV store lives in each phone's localStorage, built by
// replaying data/history.json or data/backfill/<areaCode>.json through
// applyHistoryFileToFFV / recordFFVSample. Both of those files are
// public, committed data — so the exact same replay can run here in
// Node, with no dependency on any one phone's browser storage.
//
// Kept in sync BY HAND with the matching constants/functions in app.js
// (FFV_MIN_SAMPLES, FFV_RATIO_CLAMP, FFV_OFFSET_CLAMP, FFV_EMA_ALPHA,
// isRatioCondition, applyCorrection, recordFFVSample, effectiveCloudCover)
// — same duplication convention collect-weather.mjs/precache-weather.mjs/
// backfill-weather.mjs already use for REAL_SOURCES, not a shortcut
// invented for this file. If any of those change in app.js, mirror the
// change here too.

export const FFV_MIN_SAMPLES = 3;
export const FFV_RATIO_CLAMP = [0.1, 5];
export const FFV_OFFSET_CLAMP = [-15, 15];
export const FFV_EMA_ALPHA = 2 / (30 + 1);

// Same set as app.js's REAL_DATA_CONDITIONS minus sunshine/pressure/soil/
// dew point — this module only ever needs to correct the conditions the
// weather feed actually uses (rain, wind, temperature, and the three
// cloud bands), but the functions below work for any condition name.
export function isRatioCondition(conditionName) {
  return !["temperature", "pressure", "soilTemperature", "dewPoint"].includes(conditionName);
}

export function applyCorrection(mean, ffv, conditionName) {
  return isRatioCondition(conditionName) ? mean * ffv : mean + ffv;
}

function clampRatio(ratio) {
  return Math.min(FFV_RATIO_CLAMP[1], Math.max(FFV_RATIO_CLAMP[0], ratio));
}

function clampOffset(offset) {
  return Math.min(FFV_OFFSET_CLAMP[1], Math.max(FFV_OFFSET_CLAMP[0], offset));
}

// Simplified from app.js's own recordFFVSample — this only ever needs to
// learn the current correction (emaRatio/emaOffset/count), not also track
// accuracy/eligibility bookkeeping, which is a browser-only concern.
function recordSample(entry, conditionName, mean, actual) {
  if (!mean) return entry; // guards against divide-by-zero ratios
  const newRatio = clampRatio(actual / mean);
  const newOffset = clampOffset(actual - mean);
  entry.emaRatio = entry.count === 0 ? newRatio : FFV_EMA_ALPHA * newRatio + (1 - FFV_EMA_ALPHA) * entry.emaRatio;
  entry.emaOffset = entry.count === 0 ? newOffset : FFV_EMA_ALPHA * newOffset + (1 - FFV_EMA_ALPHA) * entry.emaOffset;
  entry.count += 1;
  return entry;
}

// meanFromHistoryDay, ported from app.js: the forecast a given source
// made `day` lead-days ahead of `date`, read back out of a history-
// shaped file's per-date, per-lead-day storage.
function meanFromHistoryDay(dayEntry, sourceId, day, conditionName) {
  const modelDay = dayEntry.models?.[sourceId]?.[day];
  if (!modelDay) return null;
  const v = modelDay[conditionName];
  return v === null || v === undefined ? null : v;
}

// Replays a history-shaped file — { areaCode, days: { <date>: { actual,
// models: { <sourceId>: { <1-7>: {...} } } } } }, the exact shape both
// data/history.json and data/backfill/<areaCode>.json already use — into
// an FFV store: { [conditionName]: { [sourceId]: { [day]: { emaRatio,
// emaOffset, count } } } }.
export function buildFFVStore(historyData, conditionNames, sourceIds) {
  const store = {};
  const days = historyData?.days || {};
  Object.keys(days).forEach(date => {
    const dayEntry = days[date];
    if (!dayEntry.actual) return;

    sourceIds.forEach(sourceId => {
      if (!dayEntry.models?.[sourceId]) return;

      conditionNames.forEach(conditionName => {
        const actual = dayEntry.actual[conditionName];
        if (actual === null || actual === undefined) return;

        for (let day = 1; day <= 7; day++) {
          const mean = meanFromHistoryDay(dayEntry, sourceId, day, conditionName);
          if (!mean) continue;
          store[conditionName] ??= {};
          store[conditionName][sourceId] ??= {};
          const entry = (store[conditionName][sourceId][day] ??= { emaRatio: 1, emaOffset: 0, count: 0 });
          recordSample(entry, conditionName, mean, actual);
        }
      });
    });
  });
  return store;
}

// Returns the learned FFV for this source/condition/day, or null if
// there isn't enough history yet to trust it — same FFV_MIN_SAMPLES gate
// app.js's own ffvFor uses.
export function ffvFor(store, sourceId, conditionName, day) {
  const entry = store[conditionName]?.[sourceId]?.[day];
  if (!entry || entry.count < FFV_MIN_SAMPLES) return null;
  return isRatioCondition(conditionName) ? entry.emaRatio : entry.emaOffset;
}

export function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Ported from app.js: a single "how overcast does this actually look"
// figure from the three real cloud bands. Low cloud blocks outgoing
// radiation and greys out the sky; high cirrus is thin enough that even
// a high percentage barely registers — max() rather than a plain
// average, so a thick low layer alone still reads as properly overcast
// even if mid/high are both clear.
export function effectiveCloudCover(low, mid, high) {
  return Math.max(low ?? 0, (mid ?? 0) * 0.7, (high ?? 0) * 0.4);
}
