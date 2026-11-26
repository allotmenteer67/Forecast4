// ==== Travel page cells (which boxes the Travel page shows) ====
//
// Loaded by travel.html and settings.html. A separate set of ticks from
// the UK front page's, so UV can be on for Mexico while it's off at home
// for the winter, or air quality on for India but off in the UK. One
// set for every destination.
//
// The first time it's needed it starts as a copy of the UK front page
// ticks, with UV, air quality and pollen switched on. After that the two
// sets are independent.
//
// Order is fixed (same as the UK front page), Rain/Temperature/Wind
// always show.

const TRAVEL_CORE_FIELDS = ["rain", "temperature", "wind"];
const TRAVEL_OPTIONAL_FIELDS = ["pressure", "sunshine", "cloud", "soilTemperature", "dewPoint", "feelsLike", "visibility", "uv", "airQuality", "pollen"];
const TRAVEL_FIELD_LABELS = {
  pressure: "Pressure",
  sunshine: "Sunshine",
  cloud: "Cloud",
  soilTemperature: "Soil Temp",
  dewPoint: "Dew Point",
  feelsLike: "Feels Like",
  visibility: "Visibility",
  uv: "UV",
  airQuality: "Air quality (local index)",
  pollen: "Pollen (Europe, in season)"
};
const TRAVEL_TOGGLES_KEY = "cloude-travel:fields";

function loadTravelToggles() {
  try {
    const raw = localStorage.getItem(TRAVEL_TOGGLES_KEY);
    if (raw) {
      const stored = JSON.parse(raw);
      const out = {};
      TRAVEL_OPTIONAL_FIELDS.forEach(f => { out[f] = !!stored[f]; });
      return out;
    }
  } catch {
    // fall through to a fresh copy
  }
  const uk = typeof loadHeadlineToggles === "function" ? loadHeadlineToggles() : {};
  const out = {};
  TRAVEL_OPTIONAL_FIELDS.forEach(f => { out[f] = !!uk[f]; });
  out.uv = true;
  out.airQuality = true;
  out.pollen = true;
  try { localStorage.setItem(TRAVEL_TOGGLES_KEY, JSON.stringify(out)); } catch {}
  return out;
}

function saveTravelToggle(field, enabled) {
  const t = loadTravelToggles();
  t[field] = !!enabled;
  try { localStorage.setItem(TRAVEL_TOGGLES_KEY, JSON.stringify(t)); } catch {}
}

function activeTravelFields() {
  const t = loadTravelToggles();
  return [...TRAVEL_CORE_FIELDS, ...TRAVEL_OPTIONAL_FIELDS.filter(f => t[f])];
}
