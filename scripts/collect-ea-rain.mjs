// Environment Agency rain gauge collection — step 1 of the "real rain
// actuals" plan (see HANDOVER-precis-5.md). Called from
// collect-weather.mjs once a day.
//
// "This uses Environment Agency rainfall data from the real-time data
// API (Beta)" — required attribution, Open Government Licence. No key
// or registration needed. England only: Wales (NRW) and Scotland (SEPA)
// run separate systems.
//
// WHAT THIS DOES
// 1. Downloads the list of every EA rainfall gauge in England and keeps
//    data/rain-gauges.json up to date (ID + position only). The app will
//    use that file for the gauge layer on the expanded map (step 2). The
//    file is only rewritten when the list itself has changed, so it
//    doesn't create a commit every day.
// 2. Collects daily rain totals from:
//      - every gauge within 10 km of home (FORECAST_LAT / FORECAST_LON), and
//      - any gauge listed in data/rain-gauge-choice.json, wherever it is
//        (that file doesn't exist yet — step 2 adds tap-to-choose on the
//        map, saved through the favourite relay).
// 3. Stores each gauge's day in history.json under days[date].gauges.
//    Nothing scores against it yet — same "collect first, judge later"
//    approach as the aviation field.
//
// PRIVACY: Forecast4 is public, so nothing written to history.json or the
// Actions log may reveal the home location precisely. Gauge IDs and their
// own (public) positions only — never distances or directions from home.
//
// WHAT EACH GAUGE-DAY HOLDS (deliberately nothing thrown away):
//   mm      — rain total for the UK-time day, midnight to midnight
//   n / of  — readings received / readings expected (96 normally,
//             92 or 100 on the clock-change days)
//   gapRain — only when readings are missing: true if another collected
//             gauge recorded rain during one of the missing quarter-hours,
//             false if others were dry throughout them, null if no other
//             gauge had readings for those slots either
//   big     — only present if any single 15-minute reading exceeded 50 mm
//             (physically implausible — a likely fault). The reading is
//             still included in mm; scoring decides later.

const API = "https://environment.data.gov.uk/flood-monitoring";
const HOME_RADIUS_KM = 10;
const SLOT_MS = 15 * 60 * 1000;
const IMPLAUSIBLE_15MIN_MM = 50;
const GAUGES_PATH = new URL("../data/rain-gauges.json", import.meta.url);
const CHOICE_PATH = new URL("../data/rain-gauge-choice.json", import.meta.url);

import fs from "node:fs/promises";

// ---- small helpers ----

function firstNumber(v) {
  // A few EA stations return lat/long as an array of values rather than
  // a single number — take the first real one.
  if (Array.isArray(v)) v = v.find(x => typeof x === "number");
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function distanceKm(lat1, lon1, lat2, lon2) {
  const toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(date, days) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

const londonFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23"
});

function londonParts(ms) {
  const p = Object.fromEntries(londonFormat.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

// The UTC instant of UK-time midnight at the start of `dateStr`.
// UK midnight is either 00:00 UTC (GMT) or 23:00 UTC the day before (BST).
export function londonMidnightMs(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const gmtGuess = Date.UTC(y, m - 1, d);
  for (const candidate of [gmtGuess, gmtGuess - 3600000]) {
    const p = londonParts(candidate);
    if (p.date === dateStr && p.time === "00:00") return candidate;
  }
  throw new Error(`Couldn't find UK midnight for ${dateStr}`);
}

async function getJson(url) {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${res.status} from ${url}`);
  return res.json();
}

// ---- 1. the gauge list ----

// Returns [{ id, lat, lon, measure }] for every active rainfall gauge.
async function fetchGaugeList() {
  const data = await getJson(`${API}/id/stations?parameter=rainfall&_limit=10000`);
  const gauges = [];
  for (const s of data.items || []) {
    const id = s.notation || s.stationReference;
    const lat = firstNumber(s.lat);
    const lon = firstNumber(s.long);
    if (!id || lat === null || lon === null) continue;
    if (typeof s.status === "string" && /closed/i.test(s.status)) continue;

    // Prefer the 15-minute rainfall measure; fall back to any rainfall one.
    const measures = (Array.isArray(s.measures) ? s.measures : s.measures ? [s.measures] : [])
      .filter(m => m && (m.parameter === "rainfall" || /rainfall/i.test(m["@id"] || "")));
    const measure = measures.find(m => m.period === 900) || measures[0];
    gauges.push({ id: String(id), lat, lon, measure: measure?.["@id"] || null });
  }
  gauges.sort((a, b) => a.id.localeCompare(b.id));
  return gauges;
}

async function updateGaugeListFile(gauges) {
  // Positions are already rounded to a 100m grid by the EA; 4 decimal
  // places (~10m) keeps that without adding false precision.
  const compact = gauges.map(g => [g.id, Number(g.lat.toFixed(4)), Number(g.lon.toFixed(4))]);
  let existing = null;
  try {
    existing = JSON.parse(await fs.readFile(GAUGES_PATH, "utf-8"));
  } catch { /* first run — no file yet */ }

  if (existing && JSON.stringify(existing.gauges) === JSON.stringify(compact)) {
    return false; // unchanged — don't touch the file, so no commit
  }
  const file = {
    updated: isoDate(new Date()),
    attribution: "This uses Environment Agency rainfall data from the real-time data API (Beta)",
    licence: "Open Government Licence v3.0",
    format: "gauges: [id, lat, lon]",
    gauges: compact
  };
  await fs.mkdir(new URL(".", GAUGES_PATH), { recursive: true });
  await fs.writeFile(GAUGES_PATH, JSON.stringify(file));
  return true;
}

async function loadChosenIds() {
  try {
    const data = JSON.parse(await fs.readFile(CHOICE_PATH, "utf-8"));
    return Array.isArray(data.gauges) ? data.gauges.map(String) : [];
  } catch {
    return []; // no choice made yet
  }
}

// ---- 2. readings ----

// Raw 15-minute readings for one gauge, as [{ t (ms), mm }].
async function fetchReadings(gauge, startStr, endStr) {
  const base = gauge.measure
    ? `${gauge.measure}/readings?`
    : `${API}/id/stations/${encodeURIComponent(gauge.id)}/readings?parameter=rainfall&`;
  const data = await getJson(`${base}startdate=${startStr}&enddate=${endStr}&_sorted&_limit=5000`);
  const seen = new Map(); // the API occasionally repeats a timestamp — keep one
  for (const r of data.items || []) {
    const t = Date.parse(r.dateTime);
    const mm = firstNumber(r.value);
    if (!Number.isFinite(t) || mm === null || mm < 0) continue;
    seen.set(t, mm);
  }
  return [...seen.entries()].map(([t, mm]) => ({ t, mm }));
}

// Turns raw readings into per-day slot arrays. A reading stamped at time
// t is the total for the quarter-hour ENDING at t, so the one stamped at
// exactly midnight belongs to the day before.
// Returns { [date]: Array(slotCount) of mm or null }.
export function slotsByDay(readings, dates) {
  const out = {};
  for (const date of dates) {
    const start = londonMidnightMs(date);
    const next = londonMidnightMs(isoDate(addDays(new Date(`${date}T12:00:00Z`), 1)));
    const slots = new Array(Math.round((next - start) / SLOT_MS)).fill(null);
    for (const { t, mm } of readings) {
      if (t <= start || t > next) continue;
      const k = Math.ceil((t - start) / SLOT_MS) - 1;
      if (k >= 0 && k < slots.length) slots[k] = mm;
    }
    out[date] = slots;
  }
  return out;
}

// Builds the stored gauge-day records for one date from every collected
// gauge's slots — the gap check needs to see all gauges together.
export function summariseDay(slotsByGauge) {
  const result = {};
  for (const [id, slots] of Object.entries(slotsByGauge)) {
    const got = slots.filter(v => v !== null);
    if (!got.length) continue; // nothing at all for this gauge-day — leave it absent

    const rec = {
      mm: Math.round(got.reduce((a, b) => a + b, 0) * 10) / 10,
      n: got.length,
      of: slots.length
    };

    if (got.length < slots.length) {
      const missing = [];
      slots.forEach((v, k) => { if (v === null) missing.push(k); });
      let anyRain = false;
      let allCovered = true;
      for (const k of missing) {
        const others = Object.entries(slotsByGauge)
          .filter(([otherId]) => otherId !== id)
          .map(([, s]) => s[k])
          .filter(v => v !== null && v !== undefined);
        if (!others.length) allCovered = false;
        if (others.some(v => v > 0)) anyRain = true;
      }
      rec.gapRain = anyRain ? true : allCovered ? false : null;
    }

    if (got.some(v => v > IMPLAUSIBLE_15MIN_MM)) rec.big = true;
    result[id] = rec;
  }
  return result;
}

// ---- main entry, called by collect-weather.mjs ----

// Returns { byDate: { [date]: { [gaugeId]: record } }, gaugeIds }.
export async function fetchGaugeRain(lat, lon, start, end) {
  const homeLat = Number(lat);
  const homeLon = Number(lon);

  const gauges = await fetchGaugeList();
  if (!gauges.length) throw new Error("EA returned an empty gauge list");
  const listChanged = await updateGaugeListFile(gauges);
  console.log(`Rain gauges: ${gauges.length} in England list${listChanged ? " (rain-gauges.json updated)" : " (unchanged)"}.`);

  const chosen = new Set(await loadChosenIds());
  const wanted = gauges.filter(g =>
    chosen.has(g.id) || distanceKm(homeLat, homeLon, g.lat, g.lon) <= HOME_RADIUS_KM
  );
  // Counts only, plus IDs — never distances (see PRIVACY above).
  console.log(`Rain gauges: collecting ${wanted.length} (${chosen.size} chosen): ${wanted.map(g => g.id).join(", ") || "none"}.`);

  const dates = [];
  for (let d = new Date(start); d <= end; d = addDays(d, 1)) dates.push(isoDate(d));

  // A day either side, because UK midnight in summer is 23:00 UTC.
  const startStr = isoDate(addDays(start, -1));
  const endStr = isoDate(addDays(end, 1));

  const slots = {}; // gaugeId -> { date -> slots }
  for (const g of wanted) {
    try {
      const readings = await fetchReadings(g, startStr, endStr);
      slots[g.id] = slotsByDay(readings, dates);
    } catch (err) {
      console.warn(`Rain gauge ${g.id}: fetch failed, skipped this run (${err.message}).`);
    }
  }

  const byDate = {};
  for (const date of dates) {
    const forDay = {};
    for (const [id, perDate] of Object.entries(slots)) forDay[id] = perDate[date];
    const summary = summariseDay(forDay);
    if (Object.keys(summary).length) byDate[date] = summary;
  }
  return { byDate };
}

// Merges into history.json without ever going backwards: a gauge-day is
// only replaced when the new one has at least as many readings. So a
// gauge whose fetch failed this run, or whose old readings have aged out
// of the EA's window, keeps what was collected before.
export function mergeGaugesIntoHistory(history, byDate) {
  for (const [date, gaugesForDay] of Object.entries(byDate)) {
    const day = history.days[date];
    if (!day) continue; // only dates the main collection already holds
    day.gauges ??= { source: "EA", stations: {} };
    for (const [id, rec] of Object.entries(gaugesForDay)) {
      const old = day.gauges.stations[id];
      if (!old || rec.n >= old.n) day.gauges.stations[id] = rec;
    }
  }
}
