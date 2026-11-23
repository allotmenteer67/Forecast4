// Data checks (23 Nov 2026) — two jobs in one file:
//
//   node scripts/data-checks.mjs health   nightly, writes data/health.json
//   node scripts/data-checks.mjs weekly   weekly,  writes data/weekly-check.json
//
// WHY: both bugs found on 23 Nov were silent. BOM had sent nothing but
// blanks for its whole life in the app, and every 0 mm forecast was being
// skipped by the learning without anyone knowing. The tests run on tidy
// made-up data, so they can't see problems in the real data. These checks
// look at the real files the app learns from and say plainly what's wrong.
// Settings shows the results quietly — no notifications.
//
// HEALTH (nightly)
// 1. Each forecaster in the latest precache: is it sending anything?
// 2. Each forecaster, each condition, in the stored history (backfill
//    files + history.json): counts over the last 30 days of what the
//    learning uses and what it leaves out, by reason — blank, zero (rain
//    and sunshine; scored but not learned from), out of range. A field
//    a source used to send that has gone blank in the last 7 days is
//    flagged; a field a source has never sent (e.g. JMA sunshine) isn't.
// 3. Stuck values: the same next-day figure 7 days running (not counting
//    a run of dry days).
// 4. Met Office Spot record: when it last recorded each place.
// 5. EA rain gauges: any chosen gauge with under 90% of its readings on
//    one of the last 7 days.
//
// WEEKLY (reality check)
// For each shared place, the last 7 days with an actual: Cloude's blended
// next-day forecast (median of each forecaster after its shared
// correction, same as the app) against what happened, for rain,
// temperature and wind. Flags big misses, any forecaster far worse than
// the rest, and — where EA gauges exist — whether the "actual" the app
// learns from agrees with the gauges.
//
// Privacy: this repo is public. Only area codes, dates, forecaster names
// and figures already in the repo go into the output files.

import { readFile, writeFile, readdir } from "node:fs/promises";
import vm from "node:vm";

const DATA = new URL("../data/", import.meta.url);
const APP_PATH = new URL("../app.js", import.meta.url);

// What counts as impossible for a whole-day figure. Anything outside is
// probably a feed fault, so it's counted and flagged.
const RANGES = {
  rain: [0, 250], temperature: [-30, 45], wind: [0, 150], pressure: [900, 1080],
  dewPoint: [-40, 35], sunshine: [0, 17], cloudLow: [0, 100], cloudMid: [0, 100],
  cloudHigh: [0, 100], soilTemperature: [-20, 50]
};
// Conditions where a real 0 is common, so a zero isn't learned from
// (see recordFFVSample in app.js) but is still scored.
const ZERO_COMMON = new Set(["rain", "sunshine"]);
const WINDOW_DAYS = 30;
const STUCK_CONDITIONS = new Set(["rain", "temperature", "wind", "pressure", "dewPoint"]);
const RECENT_DAYS = 7;
const BLANK_FLAG_SHARE = 0.25; // a usually-sent field blank on more than this share of recent days
const GAUGE_MIN_SHARE = 0.9;

// Big-miss thresholds for the weekly check (next-day blend vs actual).
const MISS = {
  rain: a => Math.max(3, a * 0.5),          // mm
  temperature: () => 3,                     // °C
  wind: () => 8                             // mph
};
const WEEKLY_CONDITIONS = ["rain", "temperature", "wind"];
const UNITS = { rain: "mm", temperature: "°C", wind: "mph" };

// ---- borrowed from app.js, same approach as build-shared-ffv.mjs ----
function matchClose(src, open) {
  const pairs = { "{": "}", "[": "]", "(": ")" };
  const stack = [pairs[src[open]]];
  let i = open + 1;
  while (i < src.length && stack.length) {
    const c = src[i], next = src[i + 1];
    if (c === "/" && next === "/") { i = src.indexOf("\n", i); if (i < 0) break; continue; }
    if (c === "/" && next === "*") { i = src.indexOf("*/", i) + 2; continue; }
    if (c === '"' || c === "'" || c === "`") {
      i += 1;
      while (i < src.length && src[i] !== c) i += src[i] === "\\" ? 2 : 1;
      i += 1; continue;
    }
    if (pairs[c]) stack.push(pairs[c]);
    else if (c === stack[stack.length - 1]) stack.pop();
    i += 1;
  }
  return i;
}
function extract(src, kind, name) {
  const at = src.indexOf(`\n${kind} ${name}${kind === "const" ? " =" : "("}`);
  if (at < 0) throw new Error(`app.js has no ${kind} ${name} — update data-checks.mjs`);
  if (kind === "function") {
    const bodyOpen = src.indexOf("{", matchClose(src, src.indexOf("(", at)));
    return src.slice(at + 1, matchClose(src, bodyOpen));
  }
  let i = src.indexOf("=", at) + 1;
  while (src[i] !== ";") i = "{[(".includes(src[i]) ? matchClose(src, i) : i + 1;
  return src.slice(at + 1, i + 1);
}
async function loadApp() {
  const src = await readFile(APP_PATH, "utf8");
  const code = [
    extract(src, "const", "REAL_SOURCES"),
    extract(src, "function", "isRatioCondition"),
    "({ ids: REAL_SOURCES.map(s => s.id), isRatioCondition })"
  ].join("\n\n");
  return vm.runInNewContext(code, {});
}

// ---- small helpers ----
async function readJson(name) {
  try { return JSON.parse(await readFile(new URL(name, DATA), "utf8")); } catch { return null; }
}
const isNum = v => typeof v === "number" && Number.isFinite(v);
const median = vs => {
  if (!vs.length) return null;
  const s = [...vs].sort((a, b) => a - b), m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
// "Sun 15 Nov" — easier to read on a phone than 2026-11-15.
const nice = date => new Date(date + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
const round = (v, dp = 1) => (isNum(v) ? Math.round(v * 10 ** dp) / 10 ** dp : v);
function lastDates(days, n) {
  return Object.keys(days || {}).filter(d => days[d]?.actual).sort().slice(-n);
}

// Every history-shaped file: shared places' backfill plus the home
// history.json (its own area code).
async function historyFiles() {
  const out = [];
  let names = [];
  try { names = (await readdir(new URL("backfill/", DATA))).filter(f => f.endsWith(".json")); } catch {}
  for (const f of names.sort()) {
    const d = await readJson(`backfill/${f}`);
    if (d?.days) out.push({ area: d.areaCode || f.replace(".json", ""), file: `backfill/${f}`, data: d });
  }
  const h = await readJson("history.json");
  if (h?.days) out.push({ area: h.areaCode || "home", file: "history.json", data: h });
  return out;
}

// ---- HEALTH ----
async function health() {
  const { ids } = await loadApp();
  const issues = [];
  const sources = {};
  ids.forEach(id => { sources[id] = { latest: null, conditions: {} }; });

  // 1. Latest precache: anything at all from each source?
  const pre = await readJson("precache-weather.json");
  const place = pre?.weather?.[0];
  if (place) {
    ids.forEach(id => {
      const fields = place.sources?.[id];
      let filled = 0, total = 0;
      Object.values(fields || {}).forEach(arr => {
        if (!Array.isArray(arr)) return;
        total += arr.length; filled += arr.filter(isNum).length;
      });
      sources[id].latest = { at: place.fetchedAt || pre.dataAsOf, filled, total };
      if (!fields) issues.push({ source: id, text: "missing from the latest refresh" });
      else if (filled === 0) issues.push({ source: id, text: "sent nothing in the latest refresh (every figure blank)" });
    });
  }

  // 2 + 3. Stored history, per source and condition.
  const files = await historyFiles();
  files.forEach(({ area, data }) => {
    const dates = lastDates(data.days, WINDOW_DAYS);
    const recentDates = dates.slice(-RECENT_DAYS);
    const olderDates = dates.slice(0, -RECENT_DAYS);
    ids.forEach(id => {
      Object.keys(RANGES).forEach(cond => {
        const c = (sources[id].conditions[cond] ??= {
          used: 0, blank: 0, zero: 0, outOfRange: 0, everSent: false,
          recentBlank: 0, recentTotal: 0, lastSent: null, stuck: []
        });
        const at = (date, lead) => data.days[date].models?.[id]?.[lead]?.[cond];
        dates.forEach(date => {
          for (let lead = 1; lead <= 7; lead++) {
            let v = at(date, lead);
            if (!isNum(v)) { c.blank += 1; continue; }
            if (Math.abs(v) < 0.05 && ZERO_COMMON.has(cond)) v = 0; // averaging noise, e.g. -2.8e-17
            c.everSent = true;
            if (!c.lastSent || date > c.lastSent) c.lastSent = date;
            const [lo, hi] = RANGES[cond];
            if (v < lo || v > hi) { c.outOfRange += 1; continue; }
            if (v === 0 && ZERO_COMMON.has(cond)) { c.zero += 1; continue; }
            c.used += 1;
          }
        });
        // Gone blank recently: only lead days this source normally covers
        // (Meteo-France only goes 3 days ahead, CMA 4, Met Office has
        // sunshine only for day 1, and so on), judged from the older part
        // of the window, so a short-range model never looks broken.
        for (let lead = 1; lead <= 7; lead++) {
          const usual = olderDates.filter(d => isNum(at(d, lead))).length;
          if (!olderDates.length || usual < olderDates.length / 2) continue;
          recentDates.forEach(d => { c.recentTotal += 1; if (!isNum(at(d, lead))) c.recentBlank += 1; });
        }
        // Stuck: the same next-day figure every one of the last 7 days.
        // Not rain at 0 (a dry week), not sunshine or cloud (a clear week
        // can genuinely sit at the daylight maximum).
        if (STUCK_CONDITIONS.has(cond) && recentDates.length === RECENT_DAYS) {
          const vs = recentDates.map(d => at(d, 1));
          if (vs.every(isNum) && vs.every(v => v === vs[0]) && !(cond === "rain" && vs[0] === 0) && !c.stuck.includes(area)) c.stuck.push(area);
        }
      });
    });
  });

  ids.forEach(id => {
    const conds = sources[id].conditions;
    const sentAny = Object.values(conds).some(c => c.everSent);
    if (files.length && !sentAny) {
      issues.push({ source: id, text: `no figures at all in the last ${WINDOW_DAYS} days of history` });
      return;
    }
    Object.entries(conds).forEach(([cond, c]) => {
      if (c.everSent && c.recentTotal && c.recentBlank / c.recentTotal > BLANK_FLAG_SHARE) {
        issues.push({ source: id, condition: cond, text: `${cond} blank on ${Math.round(100 * c.recentBlank / c.recentTotal)}% of the last ${RECENT_DAYS} days (last sent ${nice(c.lastSent)})` });
      }
      if (c.outOfRange) issues.push({ source: id, condition: cond, text: `${c.outOfRange} impossible ${cond} figure(s) in the last ${WINDOW_DAYS} days (e.g. negative rain)` });
      if (c.stuck.length) issues.push({ source: id, condition: cond, text: `${cond} stuck on the same figure for ${RECENT_DAYS} days (${c.stuck.join(", ")})` });
    });
  });

  // Actuals the learning is scored against.
  const actuals = {};
  files.forEach(({ area, data }) => {
    const dates = lastDates(data.days, RECENT_DAYS);
    const blanks = {};
    dates.forEach(d => Object.keys(RANGES).forEach(cond => {
      if (!isNum(data.days[d].actual?.[cond])) blanks[cond] = (blanks[cond] || 0) + 1;
    }));
    actuals[area] = { lastDate: dates[dates.length - 1] || null, blankDays: blanks };
    ["rain", "temperature", "wind"].forEach(cond => {
      if (blanks[cond]) issues.push({ area, condition: cond, text: `actual ${cond} missing on ${blanks[cond]} of the last ${dates.length} days for ${area}` });
    });
  });

  // 4. Met Office Spot record.
  const spot = await readJson("mo-spot-record.json");
  const spotOut = {};
  Object.entries(spot?.places || {}).forEach(([key, p]) => {
    if (!/^[A-Z]{1,2}\d/.test(key)) return; // only area-code places, never coordinates
    const issued = Object.keys(p.issued || {}).sort();
    spotOut[key] = issued[issued.length - 1] || null;
  });

  // 5. EA gauges (history.json).
  const gaugesOut = {};
  const hist = files.find(f => f.file === "history.json")?.data;
  if (hist) {
    const dates = Object.keys(hist.days).filter(d => hist.days[d].gauges).sort().slice(-RECENT_DAYS);
    dates.forEach(d => Object.entries(hist.days[d].gauges.stations || {}).forEach(([st, g]) => {
      const o = (gaugesOut[st] ??= { days: 0, shortDays: 0 });
      o.days += 1;
      if (!g.of || (g.n || 0) / g.of < GAUGE_MIN_SHARE) o.shortDays += 1;
    }));
    Object.entries(gaugesOut).forEach(([st, o]) => {
      if (o.shortDays) issues.push({ gauge: st, text: `rain gauge ${st} had gaps on ${o.shortDays} of the last ${o.days} days` });
    });
  }

  // Trim the per-condition detail to what's worth reading.
  const sourcesOut = {};
  ids.forEach(id => {
    sourcesOut[id] = {
      latest: sources[id].latest,
      conditions: Object.fromEntries(Object.entries(sources[id].conditions)
        .filter(([, c]) => c.everSent)
        .map(([cond, c]) => [cond, { used: c.used, blank: c.blank, zero: c.zero, outOfRange: c.outOfRange, lastSent: c.lastSent }]))
    };
  });

  const out = {
    checkedAt: new Date().toISOString(),
    windowDays: WINDOW_DAYS,
    ok: issues.length === 0,
    issues,
    sources: sourcesOut,
    actuals,
    moSpotLastRecorded: spotOut,
    gauges: gaugesOut
  };
  await writeFile(new URL("health.json", DATA), JSON.stringify(out, null, 1) + "\n");
  console.log(`health: ${issues.length} issue(s)`);
  issues.forEach(i => console.log(" -", i.source || i.area || i.gauge, i.text));
}

// ---- WEEKLY ----
async function weekly() {
  const { ids, isRatioCondition } = await loadApp();
  const files = await historyFiles();
  const areas = {};
  const flags = [];

  for (const { area, data } of files) {
    const shared = await readJson(`shared-ffv/${area}.json`);
    const ffv = shared?.ffv || {};
    const dates = lastDates(data.days, 7);
    const days = [];
    const perSourceErr = {};

    dates.forEach(date => {
      const day = data.days[date];
      const row = { date };
      WEEKLY_CONDITIONS.forEach(cond => {
        const actual = day.actual?.[cond];
        const corrected = [];
        ids.forEach(id => {
          const raw = day.models?.[id]?.[1]?.[cond];
          if (!isNum(raw)) return;
          const e = ffv[cond]?.[id]?.["1"];
          const f = e && e.count >= 3 ? e : null;
          const value = f ? (isRatioCondition(cond) ? raw * (f.emaRatio ?? 1) : raw + (f.emaOffset ?? 0)) : raw;
          corrected.push(value);
          if (isNum(actual)) {
            const err = (perSourceErr[id] ??= {});
            (err[cond] ??= []).push(Math.abs(value - actual));
          }
        });
        // Rain by average, the rest by middle value, as the app does (blendFor).
        const blend = cond === "rain" ? (corrected.length ? corrected.reduce((x, y) => x + y, 0) / corrected.length : null) : median(corrected);
        const cell = { forecast: round(blend), actual: round(actual) };
        if (isNum(blend) && isNum(actual) && Math.abs(blend - actual) > MISS[cond](actual)) {
          cell.miss = true;
          flags.push({ area, date, condition: cond,
            text: `${area} ${nice(date)}: ${cond} forecast ${round(blend)} ${UNITS[cond]}, actual ${round(actual)} ${UNITS[cond]}` });
        }
        row[cond] = cell;
      });

      // Does the "actual" agree with the EA gauges (only where we have them)?
      const st = Object.values(day.gauges?.stations || {})
        .filter(g => g.of && g.n / g.of >= GAUGE_MIN_SHARE && isNum(g.mm)).map(g => g.mm);
      if (st.length >= 2 && isNum(day.actual?.rain)) {
        const g = st.reduce((a, b) => a + b, 0) / st.length;
        row.gaugeRain = round(g);
        if (Math.abs(g - day.actual.rain) > Math.max(3, g * 0.5)) {
          row.gaugeDisagrees = true;
          flags.push({ area, date, condition: "rain",
            text: `${area} ${nice(date)}: the rain "actual" (${round(day.actual.rain)} mm) disagrees with the EA gauges (${round(g)} mm)` });
        }
      }
      days.push(row);
    });

    // A forecaster much worse than the rest this week.
    const sourceErr = {};
    WEEKLY_CONDITIONS.forEach(cond => {
      const maes = Object.entries(perSourceErr)
        .filter(([, e]) => e[cond]?.length >= 4)
        .map(([id, e]) => [id, e[cond].reduce((a, b) => a + b, 0) / e[cond].length]);
      const mid = median(maes.map(([, m]) => m));
      maes.forEach(([id, m]) => {
        (sourceErr[id] ??= {})[cond] = round(m, 2);
        const floor = cond === "rain" ? 1 : cond === "temperature" ? 1 : 3;
        if (maes.length >= 3 && m > 2 * mid && m - mid > floor) {
          flags.push({ area, source: id, condition: cond,
            text: `${area}: ${id} ${cond} off by ${round(m)} ${UNITS[cond]} a day on average this week, against ${round(mid)} for the rest` });
        }
      });
    });

    areas[area] = { days, sourceAverageError: sourceErr };
  }

  const out = { checkedAt: new Date().toISOString(), ok: flags.length === 0, flags, areas };
  await writeFile(new URL("weekly-check.json", DATA), JSON.stringify(out, null, 1) + "\n");
  console.log(`weekly: ${flags.length} flag(s)`);
  flags.forEach(f => console.log(" -", f.text));
}

const mode = process.argv[2];
if (mode === "health") await health();
else if (mode === "weekly") await weekly();
else { console.error("usage: node scripts/data-checks.mjs health|weekly"); process.exit(1); }
