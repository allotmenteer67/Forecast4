// Builds the shared corrections (FFV) every device uses — one small file
// per area, data/shared-ffv/<areaCode>.json (Nov 2026).
//
// ---- Why ----
// Each device used to learn its own corrections, so on 16 Nov the phone
// showed 23.6 mm of rain for Zoy and the iPad 17.4 mm from the very same
// forecasts. Devices learnt from the same yearly backfill file, but each
// replayed it on top of whatever it already had, at different times, so
// they drifted apart. Now GitHub replays the history once, from scratch,
// every night, and every device simply uses the result: same place,
// same figures, on every device, and a new user starts fully trained.
//
// ---- Same maths as the app, not a copy of it ----
// The calculation is lifted out of app.js itself at run time
// (APP_FUNCTIONS / APP_CONSTANTS below) and run here unchanged, so the
// shared corrections can never quietly differ from what a device would
// have worked out. If one of those names is renamed in app.js this
// script fails loudly rather than guessing.
//
// ---- Inputs ----
// data/backfill/<area>.json (a year, topped up nightly by
// backfill-weather.mjs) plus data/history.json for the one area it
// covers (dates the backfill file doesn't have are added).
//
// ---- Safeguards ----
// An area's file is only written if its history looks healthy (enough
// days with actual weather, enough sources reporting lately). Otherwise
// the previous file stays, and devices keep using the last good set.

import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import vm from "node:vm";

const APP_PATH = new URL("../app.js", import.meta.url);
const BACKFILL_DIR = new URL("../data/backfill/", import.meta.url);
const HISTORY_PATH = new URL("../data/history.json", import.meta.url);
const OUT_DIR = new URL("../data/shared-ffv/", import.meta.url);

const MIN_DAYS_WITH_ACTUAL = 60;
const MIN_RECENT_SOURCES = 5; // of the nine, reporting in the last 30 days — a run where Open-Meteo turned most requests away

const APP_CONSTANTS = [
  "REAL_SOURCES", "REAL_DATA_CONDITIONS", "FFV_MIN_SAMPLES", "FFV_RATIO_CLAMP",
  "FFV_OFFSET_CLAMP", "FFV_EMA_ALPHA", "ACCURACY_EMA_ALPHA", "RATIO_FORECAST_FLOOR"
];
const APP_FUNCTIONS = [
  "realSourceIds", "meanFromHistoryDay", "applyHistoryFileToFFV", "recordFFVSample",
  "ensureFFVEmaSeeded", "ensureAccuracyEmaSeeded", "isRatioCondition", "applyCorrection",
  "clampRatio", "clampOffset", "markDateSeen"
];

// Index just past the bracket that closes the one at `open`, skipping
// strings and comments so a brace inside them doesn't count.
function matchClose(src, open) {
  const pairs = { "{": "}", "[": "]", "(": ")" };
  const stack = [pairs[src[open]]];
  let i = open + 1;
  while (i < src.length && stack.length) {
    const c = src[i];
    const next = src[i + 1];
    if (c === "/" && next === "/") { i = src.indexOf("\n", i); if (i < 0) break; continue; }
    if (c === "/" && next === "*") { i = src.indexOf("*/", i) + 2; continue; }
    if (c === '"' || c === "'" || c === "`") {
      i += 1;
      while (i < src.length && src[i] !== c) i += src[i] === "\\" ? 2 : 1;
      i += 1;
      continue;
    }
    if (pairs[c]) stack.push(pairs[c]);
    else if (c === stack[stack.length - 1]) stack.pop();
    i += 1;
  }
  return i;
}

function extractFunction(src, name) {
  const at = src.indexOf(`\nfunction ${name}(`);
  if (at < 0) throw new Error(`app.js has no function ${name} — update build-shared-ffv.mjs`);
  const paramsOpen = src.indexOf("(", at);
  const bodyOpen = src.indexOf("{", matchClose(src, paramsOpen));
  return src.slice(at + 1, matchClose(src, bodyOpen));
}

function extractConstant(src, name) {
  const at = src.indexOf(`\nconst ${name} =`);
  if (at < 0) throw new Error(`app.js has no const ${name} — update build-shared-ffv.mjs`);
  let i = src.indexOf("=", at) + 1;
  while (src[i] !== ";") {
    if ("{[(".includes(src[i])) i = matchClose(src, i);
    else i += 1;
  }
  return src.slice(at + 1, i + 1);
}

async function loadAppMaths() {
  const src = await readFile(APP_PATH, "utf8");
  const code = [
    ...APP_CONSTANTS.map(n => extractConstant(src, n)),
    ...APP_FUNCTIONS.map(n => extractFunction(src, n)),
    "({ applyHistoryFileToFFV, realSourceIds, REAL_DATA_CONDITIONS })"
  ].join("\n\n");
  return vm.runInNewContext(code, {});
}

// Shorter numbers, smaller file. Five decimals is far finer than any
// correction could matter.
function rounded(value) {
  if (Array.isArray(value)) return value.map(rounded);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rounded(v)]));
  }
  return typeof value === "number" && !Number.isInteger(value) ? Math.round(value * 1e5) / 1e5 : value;
}

function healthCheck(days, realIds) {
  const dates = Object.keys(days);
  const withActual = dates.filter(d => days[d].actual && Object.values(days[d].actual).some(v => v !== null && v !== undefined));
  if (withActual.length < MIN_DAYS_WITH_ACTUAL) {
    return `only ${withActual.length} days with actual weather (need ${MIN_DAYS_WITH_ACTUAL})`;
  }
  const recent = dates.slice(-30);
  const reporting = realIds.filter(id => recent.some(d => days[d].models?.[id]));
  if (reporting.length < MIN_RECENT_SOURCES) {
    return `only ${reporting.length} sources reporting in the last 30 days (need ${MIN_RECENT_SOURCES})`;
  }
  return null;
}

async function main() {
  const maths = await loadAppMaths();
  const realIds = maths.realSourceIds();

  const inputs = {};
  let files = [];
  try { files = (await readdir(BACKFILL_DIR)).filter(f => f.endsWith(".json")); } catch { /* none yet */ }
  for (const file of files) {
    const data = JSON.parse(await readFile(new URL(file, BACKFILL_DIR), "utf8"));
    if (data.areaCode && data.days) inputs[data.areaCode] = { ...data.days };
  }
  try {
    const history = JSON.parse(await readFile(HISTORY_PATH, "utf8"));
    if (history.areaCode && history.days) {
      const into = (inputs[history.areaCode] ??= {});
      Object.entries(history.days).forEach(([date, entry]) => { if (!into[date]) into[date] = entry; });
    }
  } catch { /* no daily history */ }

  await mkdir(OUT_DIR, { recursive: true });

  for (const [areaCode, unsorted] of Object.entries(inputs)) {
    // Oldest to newest, so the recency weighting ends on the latest days.
    const days = {};
    Object.keys(unsorted).sort().forEach(d => { days[d] = unsorted[d]; });

    const problem = healthCheck(days, realIds);
    if (problem) {
      console.error(`${areaCode}: not updated — ${problem}. Devices keep the last good corrections.`);
      continue;
    }

    const ffv = {};
    const elig = {};
    const samples = maths.applyHistoryFileToFFV({ areaCode, days }, ffv, elig);
    const dates = Object.keys(days);
    const output = {
      version: 1,
      areaCode,
      updated: new Date().toISOString(),
      from: dates[0],
      to: dates[dates.length - 1],
      dayCount: dates.length,
      samples,
      ffv: rounded(ffv),
      elig
    };
    await writeFile(new URL(`${areaCode}.json`, OUT_DIR), JSON.stringify(output), "utf8");
    console.log(`${areaCode}: ${dates.length} days (${output.from} to ${output.to}), ${samples} samples.`);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
