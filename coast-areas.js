// ==== Coast map areas (app side) ====
//
// The stretches of coast the Coast map has data for. The ids match
// scripts/coast-areas.json, which the GitHub Actions builds read (step 1
// collect-coast-names.mjs, step 2 build-coast-heights.py); each area's
// files are under data/coast/<id>/.
//
// Loaded by coast.html (before coast.js) and index.html (before
// tide-ui.js, for the tide sheet's "Coast map" link).
//
// Per area:
//   name, short   full name (lists, the tide sheet link); short name for
//                 the Coast map's title on narrow phones
//   bounds        the box the data covers
//   start         where the map opens the first time (mpp = metres per pixel)
//   midLat        latitude used for the map's fixed east-west scale
//   wmm           magnetic variation from the World Magnetic Model
//                 WMM2025 at the area's middle: decl at 2025.0 (east is
//                 positive) and its yearly change, exactly linear over
//                 the model's life (2025.0-2030.0)
//   tide.stationId / tide.point
//                 the tide gauge: that EA station, or the one nearest
//                 the point (tide.js)
//   tide.useSavedLocation
//                 if one of the main app's tide locations within
//                 tide.savedWithinKm has been "Checked against Admiralty",
//                 its learned correction is used, so the map's tide
//                 matches the tide card
//   tide.zones    Open-Meteo model points for adjusting the gauge's tide
//                 (first = the reference, near the gauge; see coast.js
//                 "Tide zones"); used where the view's middle is north
//                 of tide.zonesNorthOf. needsAdjust: the gauge alone is
//                 wrong here, so say so until adjusted; scaleChartDatum:
//                 scale the datum with the range (see coast.js)
//   unsurveyedDryOD
//                 hatched grey foreshore (no height at all) counts as dry
//                 when the tide is below this, m above Ordnance Datum
//   places        reference places for the Position box ("2 miles SW of …")
//   viewKey, zonesKey
//                 where this area's last view and tide adjustments are
//                 kept (St Brides keeps the keys it always had)
const COAST_AREAS = [
  {
    id: "stbrides",
    name: "St Brides Bay",
    short: "St Brides Bay",
    bounds: { north: 51.885, south: 51.665, west: -5.380, east: -5.050 },
    start: { lat: 51.775, lon: -5.11, mpp: 6 },          // Little Haven
    midLat: 51.78,
    wmm: { epoch: 2025.0, decl: -0.872, perYear: 0.1865, validTo: 2030.0 },
    tide: {
      point: { lat: 51.75, lon: -5.15 },                 // Milford Haven
      useSavedLocation: false,
      zones: [
        { id: "bay", label: "", lat: 51.770, lon: -5.200 },          // reference: the gauge as is
        { id: "solva", label: "Solva", lat: 51.855, lon: -5.200 },   // just off Solva
        { id: "ramsey", label: "Ramsey Sound", lat: 51.845, lon: -5.335 } // south end of the Sound
      ],
      zonesNorthOf: 51.815,
      needsAdjust: false,
      scaleChartDatum: false,
      note: "Milford Haven gauge"
    },
    unsurveyedDryOD: -1.0,   // about 2.7 m above Chart Datum at Milford Haven
    windSpot: { lat: 51.79, lon: -5.17 },
    places: [
      { name: "Haverfordwest", lat: 51.8015, lon: -4.9690 },
      { name: "Milford Haven", lat: 51.7144, lon: -5.0427 },
      { name: "St Davids", lat: 51.8818, lon: -5.2655 },
      { name: "Solva", lat: 51.8747, lon: -5.1965 },
      { name: "Roch", lat: 51.8488, lon: -5.0757 },
      { name: "Simpson Cross", lat: 51.8155, lon: -5.0710 },
      { name: "Druidston", lat: 51.8000, lon: -5.1035 },
      { name: "Marloes", lat: 51.7262, lon: -5.2132 },
      { name: "Martin's Haven", lat: 51.7367, lon: -5.2460 },
      { name: "Dale", lat: 51.7070, lon: -5.1700 },
      { name: "Broad Haven", lat: 51.7820, lon: -5.1030 },
      { name: "Little Haven", lat: 51.7735, lon: -5.1090 },
      { name: "Nolton Haven", lat: 51.8155, lon: -5.1070 },
      { name: "Newgale", lat: 51.8530, lon: -5.1220 }
    ],
    viewKey: "cloude-coast:view",
    zonesKey: "cloude-coast:tideZones"
  },
  {
    id: "charmouth",
    name: "Lyme Regis & Charmouth",
    short: "Lyme & Charmouth",
    bounds: { north: 50.752, south: 50.700, west: -2.962, east: -2.876 },
    start: { lat: 50.728, lon: -2.918, mpp: 8 },
    midLat: 50.726,
    wmm: { epoch: 2025.0, decl: 0.040, perYear: 0.1754, validTo: 2030.0 },
    tide: {
      // Without an Admiralty-checked tide location (below), the tide is
      // Plymouth's, as Admiralty's own tables do for Lyme Regis:
      // Weymouth is nearer but its tide has an odd shape and a much
      // smaller range. Adjusted with the Open-Meteo model like Solva.
      stationId: "E72139",                               // Plymouth (Devonport)
      point: { lat: 50.368, lon: -4.185 },
      useSavedLocation: true,
      savedWithinKm: 15,
      needsAdjust: true,
      scaleChartDatum: true,
      zones: [
        { id: "ref", label: "", lat: 50.320, lon: -4.150 },          // off Plymouth Sound: the gauge as is
        { id: "lyme", label: "Lyme Regis", lat: 50.700, lon: -2.900 } // Lyme Bay off Lyme Regis and Charmouth
      ],
      zonesNorthOf: -90,     // the whole area takes the Lyme Bay adjustment
      note: "Lyme Regis"
    },
    unsurveyedDryOD: -0.8,   // near mean low water here (about -1.2 m OD)
    windSpot: { lat: 50.725, lon: -2.92 },
    places: [
      { name: "Lyme Regis", lat: 50.7254, lon: -2.9362 },
      { name: "The Cobb", lat: 50.7207, lon: -2.9395 },
      { name: "Charmouth", lat: 50.7376, lon: -2.9015 },
      { name: "Uplyme", lat: 50.7357, lon: -2.9534 },
      { name: "Seatown", lat: 50.7213, lon: -2.8233 },
      { name: "Seaton", lat: 50.7048, lon: -3.0710 }
    ],
    viewKey: "cloude-coast:view:charmouth",
    zonesKey: "cloude-coast:tideZones:charmouth"
  }
];

const COAST_AREA_KEY = "cloude-coast:area";

function coastAreaById(id) {
  return COAST_AREAS.find(a => a.id === id) || null;
}

// Distance in km from a point to an area's box (0 inside it).
function coastAreaDistanceKm(area, lat, lon) {
  const b = area.bounds;
  const cl = Math.min(Math.max(lat, b.south), b.north);
  const cn = Math.min(Math.max(lon, b.west), b.east);
  const kx = 111.32 * Math.cos(lat * Math.PI / 180);
  return Math.hypot((lon - cn) * kx, (lat - cl) * 110.574);
}

// The area a place belongs to: inside it or within maxKm (default 10),
// the nearest if several. null if none.
function coastAreaNear(lat, lon, maxKm = 10) {
  let best = null, bestD = Infinity;
  for (const a of COAST_AREAS) {
    const d = coastAreaDistanceKm(a, lat, lon);
    if (d <= maxKm && d < bestD) { best = a; bestD = d; }
  }
  return best;
}
