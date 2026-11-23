// Real measured rain from Environment Agency gauges (23 Nov 2026).
//
// The rain "actual" every correction learns from used to be Open-Meteo's
// archive: a computer model's reconstruction of what fell, not a
// measurement. At TA7 it read about 8% under the EA gauges, with daily
// misses of 5-10 mm either way. Where real gauges exist, their average is
// now the actual instead; the archive figure is kept alongside it.
//
// Source: the EA Hydrology API (environment.data.gov.uk/hydrology) —
// years of 15-minute rain readings per gauge, free, no key, Open
// Government Licence ("This uses Environment Agency rainfall data from
// the real-time data API (Beta)" credit already in Help covers EA data).
// England only: Wales and Scotland run separate systems, so places there
// simply keep the archive figure.
//
// Rules, all deliberate:
// - Gauges within GAUGE_RADIUS_KM of the place's centre.
// - Readings summed per UK calendar day (midnight to midnight, BST
//   handled), to match the forecasts. The EA's own daily totals run
//   9am-9am, which is why they aren't used.
// - A gauge-day only counts with at least 90% of its readings, and
//   readings marked Suspect or Rejected are dropped.
// - The actual is the plain average of the usable gauges that day: at
//   least 2 where 2 or more exist, otherwise the single one.
//
// Privacy: places here are shared areas (postcode districts), already in
// the public repo. Gauge IDs and positions are public EA data.

const HYDRO = "https://environment.data.gov.uk/hydrology";
export const GAUGE_RADIUS_KM = 10;
const MIN_SHARE = 0.9;
const BAD_QUALITY = new Set(["Suspect", "Rejected"]);

async function getJson(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
      if (res.ok) return await res.json();
      if (res.status < 500 && res.status !== 429) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      if (i === tries - 1) throw err;
    }
    await new Promise(r => setTimeout(r, 4000 * (i + 1)));
  }
  throw new Error("unreachable");
}

// Rain gauges near a place, each with its 15-minute measure.
export async function findGauges(lat, lon, km = GAUGE_RADIUS_KM) {
  const url = `${HYDRO}/id/stations?observedProperty=rainfall&lat=${lat}&long=${lon}&dist=${km * 2}&_limit=100`;
  const data = await getJson(url);
  // The API's own distance search is loose (it returned gauges 14-16 km
  // away for 10 km), so the distance is checked here too.
  return (data.items || []).map(s => {
    const m = (s.measures || []).find(x => x.period === 900 && /rainfall-t-900-mm/.test(x["@id"] || ""));
    if (!m || typeof s.lat !== "number" || typeof s.long !== "number") return null;
    const dist = kmBetween(lat, lon, s.lat, s.long);
    if (dist > km) return null;
    return { id: String(s.wiskiID || s.stationReference || s.notation), label: s.label, km: Math.round(dist * 10) / 10, measure: m["@id"] };
  }).filter(Boolean).sort((a, b) => a.km - b.km);
}

function kmBetween(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180;
  const a = Math.sin((lat2 - lat1) * r / 2) ** 2 +
    Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin((lon2 - lon1) * r / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(a));
}

// "2026-11-22" for a UTC instant, in UK local time.
const ukDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" });
function ukDayOf(isoUtc) {
  return ukDate.format(new Date(isoUtc.endsWith("Z") ? isoUtc : isoUtc + "Z"));
}

// How many 15-minute slots a UK day has: 96, or 92/100 on clock-change days.
function slotsIn(ukDay) {
  const start = Date.parse(`${ukDay}T00:00:00Z`);
  let n = 0;
  for (let t = start - 3 * 3600e3; t < start + 27 * 3600e3; t += 900e3) {
    if (ukDayOf(new Date(t).toISOString()) === ukDay) n += 1;
  }
  return n;
}

// One gauge's rain per UK day, only days with enough good readings.
// The EA's reading times are GMT throughout the year.
async function gaugeDays(gauge, startDate, endDate) {
  // A day either side, so UK-day edges (BST) are fully covered.
  const from = new Date(Date.parse(`${startDate}T00:00:00Z`) - 86400e3).toISOString().slice(0, 10);
  const to = new Date(Date.parse(`${endDate}T00:00:00Z`) + 86400e3).toISOString().slice(0, 10);
  const url = `${gauge.measure}/readings?mineq-date=${from}&max-date=${to}&_limit=200000`;
  const data = await getJson(url);
  const sum = {}, count = {};
  (data.items || []).forEach(r => {
    if (typeof r.value !== "number" || r.value < 0 || BAD_QUALITY.has(r.quality)) return;
    const day = ukDayOf(r.dateTime);
    if (day < startDate || day > endDate) return;
    sum[day] = (sum[day] || 0) + r.value;
    count[day] = (count[day] || 0) + 1;
  });
  const out = {};
  Object.keys(sum).forEach(day => {
    if (count[day] >= MIN_SHARE * slotsIn(day)) out[day] = sum[day];
  });
  return out;
}

// { "<date>": { mm, gauges } } for every day with enough usable gauges.
export async function gaugeRainByDay(gauges, startDate, endDate) {
  const perGauge = [];
  for (const g of gauges) {
    try {
      perGauge.push(await gaugeDays(g, startDate, endDate));
    } catch (err) {
      console.error(`  gauge ${g.id} (${g.label}) failed, carrying on without it: ${err.message}`);
    }
  }
  const need = gauges.length >= 2 ? 2 : 1;
  const out = {};
  const days = new Set(perGauge.flatMap(p => Object.keys(p)));
  days.forEach(day => {
    const vals = perGauge.map(p => p[day]).filter(v => typeof v === "number");
    if (vals.length >= need) {
      out[day] = { mm: Math.round(100 * vals.reduce((a, b) => a + b, 0) / vals.length) / 100, gauges: vals.length };
    }
  });
  return out;
}

// Puts gauge rain into a history-shaped days object, in place. For each
// date in `dates`: actual.rain becomes the gauge average, the archive
// figure moves to actual.rainModel, and actual.rainSource says which was
// used ("gauges" or "model"), so a date is never fetched twice.
export function applyGaugeRain(days, dates, byDay) {
  let used = 0;
  dates.forEach(date => {
    const a = days[date]?.actual;
    if (!a) return;
    if (a.rainModel === undefined) a.rainModel = a.rain ?? null;
    const g = byDay[date];
    if (g) {
      a.rain = g.mm;
      a.rainGauges = g.gauges;
      a.rainSource = "gauges";
      used += 1;
    } else {
      a.rain = a.rainModel;
      delete a.rainGauges;
      a.rainSource = "model";
    }
  });
  return used;
}
