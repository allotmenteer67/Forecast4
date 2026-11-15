// Records the Met Office Spot forecast (Weather DataHub "Site Specific –
// Global Spot") once a day for the shared places, so Met Office Spot's
// record in the app has no gaps on days nobody opens it. Run by
// .github/workflows/collect-mo-spot.yml. Writes data/mo-spot-record.json.
//
// The Met Office publishes no past forecasts, so the app keeps its own
// record of what this forecast said for each of the next six days (see
// "Met Office Spot" in app.js). A phone only records on days it's opened;
// this fills the rest. On the phone, its OWN record always wins — this
// file only fills issue dates the phone doesn't have.
//
// Key: the repo secret MO_SPOT_KEY (never written anywhere). No key, no
// run — the script exits quietly.
//
// Privacy: places are keyed exactly as the app keys their area —
// favourites by postcode outward code only ("TA7"), hand-typed
// weatherLocations by one-decimal coordinates (already public in
// precache-config.json). Nothing about the Met Office site itself (name,
// coordinates) is stored.
//
// Cost: one three-hourly call per place per day, against a 360/day free
// allowance shared with the owner's own devices.
import { readFile, writeFile } from "node:fs/promises";

const CONFIG_PATH = new URL("../data/precache-config.json", import.meta.url);
const OUTPUT_PATH = new URL("../data/mo-spot-record.json", import.meta.url);
const MO_SPOT_URL = "https://data.hub.api.metoffice.gov.uk/sitespecific/v0/point/three-hourly";
const OUTCODE_GEOCODE_URL = "https://api.postcodes.io/outcodes/";
const KEEP_DAYS = 21; // issue dates kept — the app needs ~17 for every lead of every past date on Compare
const MS_TO_MPH = 2.236936;

// Same as app.js isoDate().
const isoDate = d => d.toISOString().slice(0, 10);
function addDaysIso(isoDay, n) {
  const d = new Date(`${isoDay}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return isoDate(d);
}

// Copy of app.js moSpotDailyFromThreeHourly() — keep the two in step.
function moSpotDailyFromThreeHourly(series) {
  const byDay = {};
  series.forEach(s => {
    const mid = new Date(Date.parse(s.time) - 90 * 60 * 1000);
    const day = isoDate(mid);
    (byDay[day] ??= []).push(s);
  });
  const out = {};
  Object.entries(byDay).forEach(([day, slots]) => {
    if (slots.length < 8) return;
    const nums = f => slots.map(f).filter(v => v !== null && v !== undefined && !Number.isNaN(v));
    const sum = a => a.reduce((x, y) => x + y, 0);
    const winds = slots.map(s => s.windSpeed10m);
    const peakIdx = winds.reduce((best, w, i) => (w != null && (best < 0 || w > winds[best]) ? i : best), -1);
    const tMax = nums(s => s.maxScreenAirTemp), tMin = nums(s => s.minScreenAirTemp);
    const precip = nums(s => s.totalPrecipAmount), pr = nums(s => s.mslp), fl = nums(s => s.feelsLikeTemp);
    const w = nums(s => s.windSpeed10m), g = nums(s => s.windGustSpeed10m ?? s.max10mWindGust);
    out[day] = {
      p: precip.length ? Math.round(sum(precip) * 100) / 100 : null,
      tx: tMax.length ? Math.max(...tMax) : null,
      tn: tMin.length ? Math.min(...tMin) : null,
      w: w.length ? Math.max(...w) * MS_TO_MPH : null,
      g: g.length ? Math.max(...g) * MS_TO_MPH : null,
      d: peakIdx >= 0 ? slots[peakIdx].windDirectionFrom10m ?? null : null,
      pr: pr.length ? sum(pr) / pr.length / 100 : null,
      fl: fl.length ? sum(fl) / fl.length : null
    };
  });
  return out;
}

async function geocodeOutcode(outcode) {
  try {
    const res = await fetch(OUTCODE_GEOCODE_URL + encodeURIComponent(outcode), { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const data = await res.json();
    return data.result ? { lat: data.result.latitude, lon: data.result.longitude } : null;
  } catch {
    return null;
  }
}

async function main() {
  const key = (process.env.MO_SPOT_KEY || "").trim();
  if (!key) {
    console.log("No MO_SPOT_KEY secret set — nothing to do.");
    return;
  }
  const config = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
  let record = { places: {} };
  try { record = JSON.parse(await readFile(OUTPUT_PATH, "utf8")); } catch {}
  record.places ??= {};

  const places = [];
  for (const loc of config.weatherLocations || []) {
    places.push({ key: `${loc.lat.toFixed(1)},${loc.lon.toFixed(1)}`, lat: loc.lat, lon: loc.lon });
  }
  for (const fav of config.weatherFavourites || []) {
    const outcode = String(fav.outcode || "").toUpperCase();
    const geo = outcode ? await geocodeOutcode(outcode) : null;
    if (!geo) { console.error(`Skipping ${outcode}: couldn't geocode`); continue; }
    places.push({ key: outcode, lat: geo.lat, lon: geo.lon });
  }

  const today = isoDate(new Date());
  const oldest = addDaysIso(today, -KEEP_DAYS);
  let ok = 0;
  for (const place of places) {
    try {
      const params = new URLSearchParams({ latitude: place.lat.toFixed(4), longitude: place.lon.toFixed(4), dataSource: "BD1" });
      const res = await fetch(`${MO_SPOT_URL}?${params}`, {
        headers: { apikey: key, accept: "application/json" },
        signal: AbortSignal.timeout(20000)
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const daily = moSpotDailyFromThreeHourly(data?.features?.[0]?.properties?.timeSeries || []);
      const ahead = {};
      Object.entries(daily).forEach(([day, v]) => { if (day > today) ahead[day] = v; });
      if (!Object.keys(ahead).length) throw new Error("no complete days in response");
      const entry = (record.places[place.key] ??= { issued: {} });
      entry.issued[today] = ahead;
      ok++;
    } catch (err) {
      console.error(`${place.key}: ${err.message}`);
    }
  }
  // Trim old issue dates everywhere.
  Object.values(record.places).forEach(entry => {
    Object.keys(entry.issued || {}).forEach(day => { if (day < oldest) delete entry.issued[day]; });
  });
  record.updated = today;
  await writeFile(OUTPUT_PATH, JSON.stringify(record) + "\n");
  console.log(`Recorded ${ok} of ${places.length} places.`);
  if (places.length && !ok) process.exit(1); // every place failed: make the run show red
}

main();
