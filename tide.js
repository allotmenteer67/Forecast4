// Tide maths — harmonic fit, FFV-equivalent correction (TFV), and the
// EA Tide Gauge API backfill. Kept separate from tide-ui.js's DOM code,
// the same split solar.js/solar-ui.js already use.

const MIN_FIT_READINGS = 500; // roughly a week of 15-min data — below
                               // this a harmonic fit is too noisy to trust

// ---- Harmonic constituents ----
// Standard semidiurnal/diurnal constituents plus two shallow-water terms
// (M4/MS4), fit by least-squares against a station's own historical
// readings — see the session addendum for the full decision trail
// (dropped UKHO's paid tier in favour of this, self-derived approach).
const TIDE_CONSTITUENTS = [
  { name: "M2", speed: 28.9841042 },
  { name: "S2", speed: 30.0000000 },
  { name: "N2", speed: 28.4397295 },
  { name: "K2", speed: 30.0821373 },
  { name: "K1", speed: 15.0410686 },
  { name: "O1", speed: 13.9430356 },
  { name: "P1", speed: 14.9589314 },
  { name: "Q1", speed: 13.3986609 },
  { name: "M4", speed: 57.9682084 },
  { name: "MS4", speed: 58.9841042 }
];

// Extra constituents, used only when a gauge has about a year of
// readings (data/tide-gauges, see scripts/collect-tide-gauges.py). Four
// weeks can't tell K2 from S2 or P1 from K1, or fit these smaller ones,
// which is why a four-week fit drifts at neaps; a year can. Speeds in
// degrees per hour (standard values).
const TIDE_CONSTITUENTS_LONG = TIDE_CONSTITUENTS.concat([
  { name: "2N2", speed: 27.8953548 },
  { name: "MU2", speed: 27.9682084 },
  { name: "NU2", speed: 28.5125831 },
  { name: "LAM2", speed: 29.4556253 },
  { name: "L2", speed: 29.5284789 },
  { name: "J1", speed: 15.5854433 },
  { name: "OO1", speed: 16.1391017 },
  { name: "M3", speed: 43.4761563 },
  { name: "MN4", speed: 57.4238337 },
  { name: "MK4", speed: 59.0662415 },
  { name: "S4", speed: 60.0000000 },
  { name: "M6", speed: 86.9523127 },
  { name: "2MS6", speed: 87.9682084 },
  { name: "2MN6", speed: 86.4079380 },
  { name: "M8", speed: 115.9364166 },
  { name: "MSF", speed: 1.0158958 },
  { name: "MM", speed: 0.5443747 },
  { name: "SSA", speed: 0.0821373 }
]);
const TIDE_CONSTITUENT_BY_NAME = new Map(TIDE_CONSTITUENTS_LONG.map(c => [c.name, c]));

// The constituents a fit was made with: its own list if it carries one
// (every fit made since the long records), else the original ten (fits
// saved on a phone before then).
function fitConstituents(fit) {
  if (fit && Array.isArray(fit.names)) return fit.names.map(n => TIDE_CONSTITUENT_BY_NAME.get(n)).filter(Boolean);
  return TIDE_CONSTITUENTS;
}

function fitTideHarmonics(readings, constituents) {
  if (!readings || readings.length < MIN_FIT_READINGS) return null;
  const list = constituents || TIDE_CONSTITUENTS;
  const n = readings.length;
  const cols = 1 + list.length * 2; // mean level + (cos,sin) per constituent
  // Build the normal equations (X^T X) and (X^T y) directly rather than
  // holding the full design matrix in memory — thousands of readings is
  // fine either way, but this is the standard approach and avoids a
  // large intermediate array.
  const XtX = Array.from({ length: cols }, () => new Array(cols).fill(0));
  const Xty = new Array(cols).fill(0);

  const row = new Array(cols);
  for (let i = 0; i < n; i++) {
    const t = readings[i].hours;
    const y = readings[i].level;
    row[0] = 1;
    list.forEach((c, k) => {
      const theta = ((c.speed * t) % 360) * (Math.PI / 180);
      row[1 + k * 2] = Math.cos(theta);
      row[2 + k * 2] = Math.sin(theta);
    });
    for (let a = 0; a < cols; a++) {
      Xty[a] += row[a] * y;
      for (let b = a; b < cols; b++) {
        XtX[a][b] += row[a] * row[b];
      }
    }
  }
  for (let a = 0; a < cols; a++) {
    for (let b = 0; b < a; b++) XtX[a][b] = XtX[b][a];
  }

  const coeffs = solveLinearSystem(XtX, Xty);
  if (!coeffs) return null;
  return { coeffs, names: list.map(c => c.name) };
}


// Plain Gaussian elimination with partial pivoting — the matrix here is
// at most 21x21 (1 + 10 constituents * 2), so nothing fancier is needed.
function solveLinearSystem(A, b) {
  const n = b.length;
  const M = A.map(row => row.slice());
  const v = b.slice();
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    }
    if (Math.abs(M[pivot][col]) < 1e-9) return null; // singular — not enough data variety to fit
    [M[col], M[pivot]] = [M[pivot], M[col]];
    [v[col], v[pivot]] = [v[pivot], v[col]];
    for (let r = col + 1; r < n; r++) {
      const factor = M[r][col] / M[col][col];
      for (let c = col; c < n; c++) M[r][c] -= factor * M[col][c];
      v[r] -= factor * v[col];
    }
  }
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let sum = v[i];
    for (let j = i + 1; j < n; j++) sum -= M[i][j] * x[j];
    x[i] = sum / M[i][i];
  }
  return x;
}

// Spring/neap cycle labels — the M2/S2 constituents already fitted for
// each station ARE the spring/neap cycle (their ~14.77-day beat is
// exactly what produces it), so this reads that beat directly rather
// than scanning history separately. Deliberately in one place and
// easy to swap: change the wording here only, nothing else needs to
// know about it.
const TIDE_CYCLE_LABELS = [
  "Springs",       // peak
  "Taking off",    // easing from springs, early
  "Taking off",    // easing from springs, mid
  "Near neaps",
  "Neaps",         // trough
  "Making",        // building toward springs, early
  "Making",        // building toward springs, mid
  "Near springs"
];

// Returns one of TIDE_CYCLE_LABELS for a given moment, purely from the
// fitted M2 and S2 constituents' relative phase — no separate
// historical min/max scan needed. M2 and S2 beating in phase (their
// combined amplitude at its largest) IS a spring tide; beating in
// opposition (their combined amplitude smallest) IS a neap — this is
// the actual physical mechanism, not an approximation of it.
function tideCyclePhase(fit, hours) {
  if (!fit) return null;
  const list = fitConstituents(fit);
  const m2 = list.findIndex(c => c.name === "M2");
  const s2 = list.findIndex(c => c.name === "S2");
  if (m2 < 0 || s2 < 0) return null;
  const { coeffs } = fit;
  const cosM2 = coeffs[1 + m2 * 2], sinM2 = coeffs[2 + m2 * 2];
  const cosS2 = coeffs[1 + s2 * 2], sinS2 = coeffs[2 + s2 * 2];
  const phaseM2 = Math.atan2(sinM2, cosM2) * (180 / Math.PI);
  const phaseS2 = Math.atan2(sinS2, cosS2) * (180 / Math.PI);
  const speedM2 = list[m2].speed, speedS2 = list[s2].speed;

  // psi = 0 at the moment M2 and S2 add constructively (spring), 180 at
  // their most destructive (neap). Moves at a constant rate forever
  // (speedM2 - speedS2 is fixed), so this always sweeps the same
  // direction around the cycle — the 8 bins below are ordered to match
  // that direction rather than needing a separate rising/falling check.
  let psi = ((speedM2 - speedS2) * hours - (phaseM2 - phaseS2)) % 360;
  if (psi < 0) psi += 360;

  const bin = Math.round(psi / 45) % 8;
  // Rotates the label list so index 0 (Springs) lines up with psi≈0,
  // and walks forward through Taking off → Neaps → Making → Near
  // springs as psi increases toward 360/0 — matching how psi actually
  // decreases over real time (see comment above), so what a person
  // sees scrubbing forward through the week moves through the labels
  // in the sailing-almanac order, not backwards.
  return TIDE_CYCLE_LABELS[(8 - bin) % 8];
}

function predictTideLevel(fit, hours) {
  if (!fit) return null;
  const { coeffs } = fit;
  let level = coeffs[0];
  fitConstituents(fit).forEach((c, k) => {
    const theta = ((c.speed * hours) % 360) * (Math.PI / 180);
    level += coeffs[1 + k * 2] * Math.cos(theta) + coeffs[2 + k * 2] * Math.sin(theta);
  });
  return level;
}

// Finds local highs/lows by sampling densely and keeping sign changes in
// the slope — plenty precise for a semidiurnal signal at this sample
// rate, no need for anything more exact than that.
function findTideExtremes(fit, startHours, endHours) {
  const stepHours = 1 / 30; // 2-minute steps
  const events = [];
  let prevLevel = predictTideLevel(fit, startHours);
  let prevSlope = null;
  for (let h = startHours + stepHours; h <= endHours; h += stepHours) {
    const level = predictTideLevel(fit, h);
    const slope = level - prevLevel;
    if (prevSlope !== null && slope !== 0 && prevSlope !== 0 && (slope > 0) !== (prevSlope > 0)) {
      events.push({
        hours: h - stepHours / 2,
        level: predictTideLevel(fit, h - stepHours / 2),
        type: prevSlope > 0 ? "high" : "low"
      });
    }
    prevLevel = level;
    prevSlope = slope;
  }
  return events;
}

// ---- TFV (Tidal Fudge Value) — learned correction against this
// station's OWN observed reading, recency-weighted the same way FFV is
// (~30-day effective memory) — see the session addendum for the bug
// found and fixed in this session (reused FFV's daily-sample alpha
// unchanged, which gave TFV a real memory of ~8 hours instead of 30
// days at tide's 15-minute sampling rate).
const TIDE_FUDGE_ALPHA = 2 / (30 * 96 + 1); // 30 days at 15-min samples

function applyTideFudge(level, fudge) {
  if (fudge === null || fudge === undefined || Number.isNaN(fudge)) return level;
  return level + fudge;
}

// ---- EA Tide Gauge Network — real, no-key station list ----
// id/measureId let this reuse the exact same EA Tide Gauge API this
// project already depends on elsewhere; lat/lon are each station's own
// published position, used only to find the nearest one to a resolved
// location (see nearestTideStation below).
//
// cdOffsetOD: each station's Chart Datum height relative to Ordnance
// Datum Newlyn (metres), published by the National Tidal and Sea Level
// Facility (https://ntslf.org/tides/datum). CD height = OD height minus
// this value. Confident matches only — omitted (undefined) for stations
// NTSLF doesn't publish a value for, and for the handful that use a
// LOCAL Ordnance Datum rather than ODN (St Mary's, Port Erin, Stornoway,
// Lerwick, Jersey/St Helier — flagged individually below), since it's
// not yet confirmed whether this station's own EA mAOD readings share
// that same local reference or the national one. Any code using this
// value must treat its absence as "no CD conversion available" rather
// than assume 0.
const EA_TIDE_STATIONS = [
  { id: "E70039", measureId: "E70039-level-tidal_level-Mean-15_min-mAOD", label: "Lowestoft", lat: 52.473075, lon: 1.750085, cdOffsetOD: -1.50 },
  { id: "E72639", measureId: "E72639-level-tidal_level-Mean-15_min-mAOD", label: "Avonmouth Portbury", lat: 51.49999, lon: -2.728468, cdOffsetOD: -6.50 }, // NTSLF publishes "Avonmouth" — likely the same tidal regime as this Portbury gauge, not individually confirmed as the identical physical station
  { id: "E71539", measureId: "E71539-level-tidal_level-Mean-15_min-mAOD", label: "Sheerness", lat: 51.445627, lon: 0.743415, cdOffsetOD: -2.90 },
  { id: "E71939", measureId: "E71939-level-tidal_level-Mean-15_min-mAOD", label: "Bournemouth", lat: 50.714331, lon: -1.874873, cdOffsetOD: -1.40, oddShape: true, insteadEast: "E71839" }, // double high water and a small range — see ODD_GAUGE_MAX_KM
  { id: "E71239", measureId: "E71239-level-tidal_level-Mean-15_min-mAOD", label: "Cromer", lat: 52.934316, lon: 1.301623, cdOffsetOD: -2.75 },
  { id: "E72039", measureId: "E72039-level-tidal_level-Mean-15_min-mAOD", label: "Weymouth", lat: 50.608501, lon: -2.447945, cdOffsetOD: -0.93, oddShape: true, insteadWest: "E72139", insteadEast: "E71839" }, // double low water and a small range — see ODD_GAUGE_MAX_KM
  { id: "E71639", measureId: "E71639-level-tidal_level-Mean-15_min-mAOD", label: "Dover", lat: 51.114372, lon: 1.322641, cdOffsetOD: -3.67 },
  { id: "E73439-anglian", measureId: "E73439-anglian-level-tidal_level-Mean-15_min-mAOD", label: "Heysham", lat: 54.031798, lon: -2.920253, cdOffsetOD: -4.90 },
  { id: "E72439", measureId: "E72439-level-tidal_level-Mean-15_min-mAOD", label: "Ilfracombe", lat: 51.211131, lon: -4.112362, cdOffsetOD: -4.80 },
  { id: "E70939", measureId: "E70939-level-tidal_level-Mean-15_min-mAOD", label: "North Shields", lat: 55.007415, lon: -1.439769, cdOffsetOD: -2.60 },
  { id: "E73639-anglian", measureId: "E73639-anglian-level-tidal_level-Mean-15_min-mAOD", label: "Workington", lat: 54.650691, lon: -3.56717, cdOffsetOD: -4.20 },
  { id: "E72139", measureId: "E72139-level-tidal_level-Mean-15_min-mAOD", label: "Plymouth", lat: 50.368401, lon: -4.185217, cdOffsetOD: -3.22 }, // NTSLF's own network listing names this station "Plymouth (Devonport)" — confirmed same station, not a guess
  { id: "E71739", measureId: "E71739-level-tidal_level-Mean-15_min-mAOD", label: "Newhaven", lat: 50.781775, lon: 0.057004, cdOffsetOD: -3.52 },
  { id: "E71039", measureId: "E71039-level-tidal_level-Mean-15_min-mAOD", label: "Whitby", lat: 54.489967, lon: -0.614597, cdOffsetOD: -3.00 },
  { id: "E70139-anglian", measureId: "E70139-anglian-level-tidal_level-Mean-15_min-mAOD", label: "Liverpool", lat: 53.44967, lon: -3.01815, cdOffsetOD: -4.93 },
  { id: "E72539", measureId: "E72539-level-tidal_level-Mean-15_min-mAOD", label: "Hinkley Point", lat: 51.210605, lon: -3.131326, cdOffsetOD: -5.90 },
  { id: "E71439", measureId: "E71439-level-tidal_level-Mean-15_min-mAOD", label: "Harwich", lat: 51.947978, lon: 1.292108 }, // no published NTSLF offset found
  { id: "E72239", measureId: "E72239-level-tidal_level-Mean-15_min-mAOD", label: "Newlyn", lat: 50.103007, lon: -5.542779, cdOffsetOD: -3.05 },
  { id: "E71839", measureId: "E71839-level-tidal_level-Mean-15_min-mAOD", label: "Portsmouth", lat: 50.80229, lon: -1.11119, cdOffsetOD: -2.73 },
  { id: "E71139", measureId: "E71139-level-tidal_level-Mean-15_min-mAOD", label: "Immingham", lat: 53.63018, lon: -0.18742, cdOffsetOD: -3.90 },
  { id: "E71339", measureId: "E71339-level-tidal_level-Mean-15_min-mAOD", label: "Washpile", lat: 52.875861, lon: 0.218395 }, // no published NTSLF offset found
  { id: "E72339", measureId: "E72339-level-tidal_level-Mean-15_min-m", label: "St Marys", lat: 49.91786, lon: -6.31722 }, // NTSLF value (-2.91m) is against a LOCAL OD, not confirmed to match this station's own mAOD reference — omitted rather than risk a wrong conversion
  { id: "E73939", measureId: "E73939-level-tidal_level-Mean-15_min-mAOD", label: "Portrush", lat: 55.20108, lon: -6.65123, cdOffsetOD: -1.24 },
  { id: "E70539", measureId: "E70539-level-tidal_level-Mean-15_min-mAOD", label: "Holyhead", lat: 53.31394, lon: -4.62043, cdOffsetOD: -3.05 },
  { id: "E73139", measureId: "E73139-level-tidal_level-Mean-15_min-mAOD", label: "Fishguard", lat: 52.01321, lon: -4.98371, cdOffsetOD: -2.44 },
  { id: "E70439", measureId: "E70439-level-tidal_level-Mean-15_min-mAOD", label: "Ullapool", lat: 57.89527, lon: -5.15789, cdOffsetOD: -2.75 },
  { id: "E70839", measureId: "E70839-level-tidal_level-Mean-15_min-mAOD", label: "Leith", lat: 55.98983, lon: -3.18168, cdOffsetOD: -2.90 },
  { id: "E72939", measureId: "E72939-level-tidal_level-Mean-15_min-mAOD", label: "Mumbles", lat: 51.57, lon: -3.97544, cdOffsetOD: -5.00 },
  { id: "E72839", measureId: "E72839-level-tidal_level-Mean-15_min-mAOD", label: "Newport", lat: 51.55001, lon: -2.98743, cdOffsetOD: -5.81 },
  { id: "E70739", measureId: "E70739-level-tidal_level-Mean-15_min-mAOD", label: "Aberdeen", lat: 57.14406, lon: -2.08013, cdOffsetOD: -2.25 },
  { id: "E73039", measureId: "E73039-level-tidal_level-Mean-15_min-mAOD", label: "Milford Haven", lat: 51.70738, lon: -5.05184, cdOffsetOD: -3.71 },
  { id: "E74039", measureId: "E74039-level-tidal_level-Mean-15_min-mAOD", label: "Millport", lat: 55.7498, lon: -4.90634, cdOffsetOD: -1.62 },
  { id: "E73839", measureId: "E73839-level-tidal_level-Mean-15_min-mAOD", label: "Bangor", lat: 54.66518, lon: -5.67045, cdOffsetOD: -2.01 },
  { id: "E70639", measureId: "E70639-level-tidal_level-Mean-15_min-mAOD", label: "Wick", lat: 58.44098, lon: -3.08631, cdOffsetOD: -1.71 },
  { id: "E73539", measureId: "E73539-level-tidal_level-Mean-15_min-mAOD", label: "Port Erin", lat: 54.08538, lon: -4.76807 }, // NTSLF value is against a LOCAL OD — omitted, see St Marys note above
  { id: "E70339", measureId: "E70339-level-tidal_level-Mean-15_min-mAOD", label: "Kinlochbervie", lat: 58.45673, lon: -5.05018, cdOffsetOD: -2.50 },
  { id: "E74239", measureId: "E74239-level-tidal_level-Mean-15_min-mAOD", label: "Tobermory", lat: 56.62314, lon: -6.06424, cdOffsetOD: -2.39 },
  { id: "E73739", measureId: "E73739-level-tidal_level-Mean-15_min-mAOD", label: "Portpatrick", lat: 54.84254, lon: -5.12004, cdOffsetOD: -1.80 },
  { id: "E74339", measureId: "E74339-level-tidal_level-Mean-15_min-mAOD", label: "Stornoway", lat: 58.20781, lon: -6.38897 }, // NTSLF value is against a LOCAL OD — omitted, see St Marys note above
  { id: "E70239", measureId: "E70239-level-tidal_level-Mean-15_min-mAOD", label: "Jersey", lat: 49.18333, lon: -2.11667 }, // NTSLF's St Helier value is against a LOCAL OD — omitted, see St Marys note above
  { id: "E73239", measureId: "E73239-level-tidal_level-Mean-15_min-mAOD", label: "Barmouth", lat: 52.71931, lon: -4.04503, cdOffsetOD: -2.44 },
  { id: "E74439", measureId: "E74439-level-tidal_level-Mean-15_min-mAOD", label: "Lerwick", lat: 60.15402, lon: -1.1403 }, // NTSLF value is against a LOCAL OD — omitted, see St Marys note above
  { id: "E73339", measureId: "E73339-level-tidal_level-Mean-15_min-mAOD", label: "Llandudno", lat: 53.33164, lon: -3.82521, cdOffsetOD: -3.85 }
];

const EA_STATIONS_URL = "https://environment.data.gov.uk/flood-monitoring/id/stations?type=TideGauge";
const EA_READINGS_BASE = "https://environment.data.gov.uk/flood-monitoring/id/measures";
const EA_READINGS_MAX_LIMIT = 10000; // EA's own hard cap per request — at
                                      // 15-min readings that's just over
                                      // 104 days, plenty for a first fit

// Haversine distance in km — plenty precise for "which of 44 UK coastal
// stations is nearest", no need for anything more exact than that.
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Weymouth and Bournemouth sit near the Portland/Solent amphidromic
// region: small ranges and odd shapes (a double low at Weymouth, a
// double high at Bournemouth). Right for places close to them, but a
// poor pattern for anywhere further off — Admiralty's own tables work
// Lyme Regis, Bridport and the Exe out from Plymouth, not Weymouth, and
// using Weymouth for Charmouth gave a tide graph with a false low about
// three hours after high water (Nov 2026). So an odd-shaped gauge is
// only picked within ODD_GAUGE_MAX_KM; further off, the gauge named for
// that side of it along the coast (insteadWest / insteadEast — Plymouth
// to the west of Weymouth, Portsmouth to the east) is used instead.
// Named, not the next nearest by distance, because the next nearest to
// Charmouth as the crow flies is Hinkley Point, on the wrong sea.
const ODD_GAUGE_MAX_KM = 25;

function nearestTideStation(lat, lon) {
  const withDistance = station => ({ ...station, distanceKm: haversineKm(lat, lon, station.lat, station.lon) });
  let nearest = null;
  EA_TIDE_STATIONS.forEach(station => {
    const candidate = withDistance(station);
    if (!nearest || candidate.distanceKm < nearest.distanceKm) nearest = candidate;
  });
  if (!nearest || !nearest.oddShape || nearest.distanceKm <= ODD_GAUGE_MAX_KM) return nearest;
  const insteadId = lon < nearest.lon ? nearest.insteadWest : nearest.insteadEast;
  const instead = insteadId && EA_TIDE_STATIONS.find(station => station.id === insteadId);
  return instead ? withDistance(instead) : nearest;
}

// Tiny wiggles in a gauge's fitted curve (a stand at low or high water,
// like Weymouth's double low) come out of findTideExtremes as a
// high/low pair only a few centimetres apart. Treated as real highs and
// lows they get the full high- or low-water correction and throw the
// place's curve about, so any neighbouring pair closer than this is
// dropped, leaving the real highs and lows.
const MIN_TIDE_EVENT_RISE_M = 0.3;

function significantTideExtremes(events) {
  const list = events.slice();
  let removed = true;
  while (removed && list.length > 1) {
    removed = false;
    let smallest = -1, smallestRise = MIN_TIDE_EVENT_RISE_M;
    for (let i = 0; i < list.length - 1; i++) {
      const rise = Math.abs(list[i + 1].level - list[i].level);
      if (rise < smallestRise) { smallestRise = rise; smallest = i; }
    }
    if (smallest >= 0) {
      list.splice(smallest, 2);
      removed = true;
    }
  }
  return list;
}

// Fetches this station's own recent history live and fits it on the
// spot — the "backfill" equivalent for a genuinely new tide location.
// EA needs no key, so (unlike UKHO) this can run directly from the
// browser rather than needing to wait for the next scheduled
// collection. Returns null if the fetch fails or comes back too thin
// to fit (see MIN_FIT_READINGS in the fit function itself).
async function backfillTideStation(station) {
  const url = `${EA_READINGS_BASE}/${station.measureId}/readings?_sorted&_limit=${EA_READINGS_MAX_LIMIT}`;
  // One retry on a timeout/network failure specifically — this is a
  // genuinely large request (up to 10,000 readings) against a public
  // government API with no CDN or paid-tier reliability guarantees,
  // independent of anything else going on in the app at the time. A
  // single slow or dropped attempt shouldn't need a full manual retry
  // (switching away and back, or reopening the app) when trying once
  // more automatically is nearly free by comparison. Only retries on a
  // fetch-level failure (timeout, network drop) — a real HTTP error
  // status from EA itself (4xx/5xx) fails straight away, same as
  // before, since retrying an error EA already answered definitively
  // isn't going to change its mind.
  let res;
  try {
    res = await fetchWithTimeout(url, {}, 30000);
  } catch (err) {
    try {
      res = await fetchWithTimeout(url, {}, 30000);
    } catch {
      throw err; // report the original failure, not the retry's
    }
  }
  if (!res.ok) throw new Error(`Tide gauge fetch failed: ${res.status}`);
  const data = await res.json();
  const parsed = data.items
    .map(item => ({ time: Date.parse(item.dateTime), level: item.value }))
    .filter(r => typeof r.level === "number" && !Number.isNaN(r.time))
    .sort((a, b) => a.time - b.time);
  if (!parsed.length) return { readings: [], epochIso: new Date().toISOString() };

  // Epoch is deliberately the earliest reading in the batch, not "just
  // whatever came back first" — readable and conventional, though the
  // fit itself works the same regardless of which fixed point every
  // reading's hours-offset is measured relative to.
  const epoch = parsed[0].time;
  const readings = parsed.map(r => ({ hours: (r.time - epoch) / 3600000, level: r.level }));
  return { readings, epochIso: new Date(epoch).toISOString() };
}

// ---- Saved tide locations ----
// A separate list from weather's saved places (PLACES_KEY) — a tide
// spot and a weather postcode are conceptually different things (see
// the discussion when this was scoped), so they get their own storage
// rather than being forced to share one list.
const TIDE_LOCATIONS_KEY = "cloude-tide:locations";
const CURRENT_TIDE_LOCATION_KEY = "cloude-tide:current";

function loadTideLocations() {
  try {
    const raw = localStorage.getItem(TIDE_LOCATIONS_KEY);
    if (raw) {
      const locations = JSON.parse(raw);
      if (Array.isArray(locations) && moveOffOddGauges(locations)) saveTideLocations(locations);
      return locations;
    }
  } catch {
    // fall through to default
  }
  return [];
}

// Places saved before the odd-gauge rule (see ODD_GAUGE_MAX_KM) keep
// the gauge they were given then — Charmouth was on Weymouth. Moves
// each one to the gauge it would get now. Its Admiralty correction was
// learned against the old gauge and means nothing against the new one,
// so that's cleared: Settings then shows "not checked yet" and one tap
// of "Check against Admiralty" learns it again. Returns true if
// anything changed.
function moveOffOddGauges(locations) {
  let changed = false;
  locations.forEach(loc => {
    if (!loc || !loc.station || typeof loc.lat !== "number" || typeof loc.lon !== "number") return;
    const known = EA_TIDE_STATIONS.find(s => s.id === loc.station.id);
    if (!known || !known.oddShape) return;
    const better = nearestTideStation(loc.lat, loc.lon);
    if (!better || better.id === loc.station.id) return;
    if (loc.discoveryStation) {
      try { localStorage.removeItem(secondaryOffsetKey(loc.discoveryStation.id)); } catch { /* nothing stored */ }
    }
    loc.station = better;
    changed = true;
  });
  return changed;
}

function saveTideLocations(locations) {
  try {
    localStorage.setItem(TIDE_LOCATIONS_KEY, JSON.stringify(locations));
  } catch {
    // Storage unavailable — saved tide locations just won't persist.
  }
}

function loadCurrentTideLocationId() {
  try {
    return localStorage.getItem(CURRENT_TIDE_LOCATION_KEY) || null;
  } catch {
    return null;
  }
}

function saveCurrentTideLocationId(id) {
  try {
    localStorage.setItem(CURRENT_TIDE_LOCATION_KEY, id);
  } catch {
    // Storage unavailable — current tide location just won't persist.
  }
}

// ---- Per-station TFV storage ----
// Keyed by the EA station id, NOT by the saved location's own id —
// two saved locations that happen to share a nearest station (e.g. two
// nearby villages both closest to the same gauge) should share that
// station's learned correction rather than tracking it twice, since
// it's genuinely the same station's own model error either way.
function tideFudgeKey(stationId) {
  return `cloude-tide:tfv:${stationId}`;
}

function loadTideFudge(stationId) {
  try {
    const raw = localStorage.getItem(tideFudgeKey(stationId));
    return raw === null ? null : parseFloat(raw);
  } catch {
    return null;
  }
}

function saveTideFudge(stationId, fudge) {
  try {
    localStorage.setItem(tideFudgeKey(stationId), String(fudge));
  } catch {
    // Storage unavailable — correction just won't persist between visits.
  }
}

// Cached fit per station — an in-memory layer for the current page load
// (fastest, no I/O at all), backed by a persisted copy in localStorage
// so a location that's already been fitted once stays instant across
// page loads and app restarts too, not just within one session.
//
// Tides are astronomically stable — the constituents underlying a
// harmonic fit don't meaningfully drift over a week — so there's no
// need to hold up a location switch on a fresh multi-second rebuild
// just to keep the model current. TIDE_FIT_MAX_AGE_MS instead triggers
// a QUIET background refresh once a persisted fit is old enough, using
// whatever's already cached in the meantime rather than making the
// person wait for it — the same stale-while-revalidate approach the
// service worker (sw.js) already uses for the app shell.
const tideFitCache = new Map();
const tideFitRefreshing = new Set(); // stationIds with a background refresh already in flight — avoids piling up duplicate refreshes on repeat visits while one's still running
// stationId -> in-flight promise, for a station's very FIRST build (no
// persisted fit yet at all) — the equivalent coalescing to
// tideFitRefreshing above, but for buildAndCacheTideFit's other call
// site below. Without this, swiping to a never-before-seen station,
// swiping away, then swiping back before that first fetch has finished
// fired a second, fully redundant EA request (each carrying its own
// up-to-30-second timeout) rather than just waiting on the one already
// running.
const tideFitBuildInFlight = new Map();
const TIDE_FIT_MAX_AGE_MS = 7 * 24 * 3600000; // a week

function tideFitStorageKey(stationId) {
  return `cloude-tide:fit:${stationId}`;
}

function loadPersistedTideFit(stationId) {
  try {
    const raw = localStorage.getItem(tideFitStorageKey(stationId));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function savePersistedTideFit(stationId, result) {
  try {
    localStorage.setItem(tideFitStorageKey(stationId), JSON.stringify({
      fit: result.fit,
      epochIso: result.epochIso,
      longRecordDays: result.longRecordDays || 0,
      builtAt: Date.now()
    }));
  } catch {
    // Storage unavailable — just won't persist between visits; falls
    // back to a live rebuild each time, same as before this change.
  }
}

// ---- Long gauge records ----
// About a year of each gauge's hourly readings, kept in the repo by
// scripts/collect-tide-gauges.py (run daily on GitHub) from the
// Environment Agency's daily archive files, because the live API only
// keeps about four weeks. A tide fitted to four weeks drifts at neaps —
// up to ~35 minutes and 0.3 m at Milford Haven against the official
// table (Nov 2026). With a year, more constituents can be fitted
// (TIDE_CONSTITUENTS_LONG). The live four weeks are still added on the
// end, so the newest readings are always in.
const LONG_RECORD_MIN_DAYS = 300;
const LONG_RECORD_RETRY_MS = 12 * 3600000; // a fit made without a long record is redone after this, in case one has appeared

async function loadLongTideRecord(station) {
  try {
    const res = await fetchWithTimeout(`data/tide-gauges/${encodeURIComponent(station.id)}.json`, {}, 20000);
    if (!res.ok) return null;
    const rec = await res.json();
    const t0 = Date.parse(rec.start);
    const step = (rec.stepMinutes || 60) * 60000;
    if (!Array.isArray(rec.cm) || Number.isNaN(t0)) return null;
    const out = [];
    rec.cm.forEach((cm, i) => {
      if (typeof cm === "number") out.push({ time: t0 + i * step, level: cm / 100 });
    });
    return out.length ? out : null;
  } catch {
    return null;
  }
}

// Fits, drops readings far off the fit (a broken gauge reading, or a
// big storm surge, would otherwise pull every prediction a little),
// and fits again.
function fitTideHarmonicsRobust(readings, constituents) {
  const first = fitTideHarmonics(readings, constituents);
  if (!first) return null;
  const residuals = readings.map(r => r.level - predictTideLevel(first, r.hours));
  const rms = Math.sqrt(residuals.reduce((a, x) => a + x * x, 0) / residuals.length);
  const limit = Math.max(1.0, 4 * rms);
  const kept = readings.filter((r, i) => Math.abs(residuals[i]) <= limit);
  if (kept.length === readings.length || kept.length < MIN_FIT_READINGS) return first;
  return fitTideHarmonics(kept, constituents) || first;
}

// Does the actual fetch + fit — the one genuinely slow path, only ever
// hit for a station that's never been fitted before, or during a quiet
// background refresh.
async function buildAndCacheTideFit(station) {
  const [liveResult, longResult] = await Promise.allSettled([backfillTideStation(station), loadLongTideRecord(station)]);
  const backfill = liveResult.status === "fulfilled" ? liveResult.value : null;
  const long = longResult.status === "fulfilled" ? longResult.value : null;
  const longDays = long ? (long[long.length - 1].time - long[0].time) / 86400000 : 0;

  let result;
  if (long && longDays >= LONG_RECORD_MIN_DAYS) {
    const live = backfill && backfill.readings.length ? backfill : null;
    const epochMs = live ? Date.parse(live.epochIso) : long[0].time;
    const lastLong = long[long.length - 1].time;
    const readings = long.map(r => ({ hours: (r.time - epochMs) / 3600000, level: r.level }));
    if (live) {
      // Hourly, like the long record, so the last four weeks don't
      // count four times as much as the rest of the year.
      live.readings.forEach(r => {
        const t = Math.round(epochMs + r.hours * 3600000);
        if (t > lastLong && t % 3600000 === 0) readings.push(r);
      });
    }
    const fit = fitTideHarmonicsRobust(readings, TIDE_CONSTITUENTS_LONG);
    if (!fit) throw new Error("Harmonic fit failed on the long gauge record");
    result = { fit, epochIso: new Date(epochMs).toISOString(), longRecordDays: Math.round(longDays) };
  } else {
    if (!backfill) throw (liveResult.reason || new Error("Tide gauge fetch failed"));
    // TEMPORARY diagnostic — these two now throw a specific reason instead
    // of silently returning null, purely so the actual cause reaches the
    // "Not available right now" message on screen (see tide-ui.js/
    // fishing-ui.js) rather than being swallowed. Every existing caller
    // already handles a rejected promise here (getOrBuildTideFit's own
    // try/catch, refreshTideFitInBackground's .catch()), so this is safe
    // to revert to a plain `return null` once the cause is found.
    if (backfill.readings.length < MIN_FIT_READINGS) {
      throw new Error(`Only ${backfill.readings.length} readings available (need ${MIN_FIT_READINGS})`);
    }
    const fit = fitTideHarmonics(backfill.readings);
    if (!fit) throw new Error("Harmonic fit failed on otherwise-sufficient readings");
    result = { fit, epochIso: backfill.epochIso, longRecordDays: 0 };
  }
  tideFitCache.set(station.id, result);
  savePersistedTideFit(station.id, result);
  return result;
}

function refreshTideFitInBackground(station) {
  if (tideFitRefreshing.has(station.id)) return;
  tideFitRefreshing.add(station.id);
  buildAndCacheTideFit(station)
    .catch(() => {
      // A failed background refresh just means the existing (still
      // perfectly usable) cached fit keeps being used until one succeeds.
    })
    .finally(() => tideFitRefreshing.delete(station.id));
}

async function getOrBuildTideFit(station) {
  if (tideFitCache.has(station.id)) return tideFitCache.get(station.id);

  const persisted = loadPersistedTideFit(station.id);
  if (persisted && persisted.fit && persisted.epochIso) {
    const result = { fit: persisted.fit, epochIso: persisted.epochIso, longRecordDays: persisted.longRecordDays || 0 };
    tideFitCache.set(station.id, result);
    // A fit made without a year's record is redone twice a day, so a
    // phone picks the long record up within hours of it appearing.
    const maxAge = persisted.longRecordDays ? TIDE_FIT_MAX_AGE_MS : LONG_RECORD_RETRY_MS;
    if (!persisted.builtAt || Date.now() - persisted.builtAt > maxAge) {
      refreshTideFitInBackground(station); // don't await — use what's cached now, improve it quietly for next time
    }
    return result;
  }

  // Never built before — this one genuinely has to wait on a real EA
  // fetch. Coalesced per station via tideFitBuildInFlight above: a
  // swipe back to this exact station while its first-ever fetch is
  // still running reuses that SAME promise instead of starting a
  // second one.
  if (tideFitBuildInFlight.has(station.id)) return tideFitBuildInFlight.get(station.id);
  const promise = buildAndCacheTideFit(station).finally(() => tideFitBuildInFlight.delete(station.id));
  tideFitBuildInFlight.set(station.id, promise);
  return promise;
}

// ==== Admiralty Discovery API — secondary-port correction ====
//
// The 44 EA stations above are real gauges, but most saved locations
// are inevitably SOME distance from the nearest one — Teignmouth is
// ~52km from Plymouth, for example. That distance is a genuine source
// of error distinct from anything TFV can fix: TFV corrects Plymouth's
// own model against Plymouth's own gauge, so it can only ever make
// Plymouth's prediction more accurate FOR Plymouth. It has no way to
// know Teignmouth exists, let alone that its tide runs ~35-40 minutes
// and the better part of a metre different from Plymouth's.
//
// UKHO's free Discovery tier of the Admiralty Tidal API covers 607
// named UK tidal stations — standard AND secondary ports — so it very
// likely has a REAL station for wherever the nearest EA gauge is only
// an approximation for. This section: (1) finds the nearest of those
// 607 stations to a saved location, (2) pulls its real ~6-day
// high/low predictions, (3) compares them against what our own
// EA-station-based model would have predicted for the same moments,
// and (4) stores the learned time/height difference so it can be
// applied going forward — including for dates well outside that 6-day
// window, and without needing to keep calling the API.
//
// This is a genuinely different kind of correction to TFV: it's a
// fixed geographic offset between two real places, not a drifting model
// error, so it doesn't need TFV's 30-day rolling memory — a single
// ~6-day sample (roughly a dozen tidal events) should already land
// close to a stable value. It's user-triggered (see "Check against
// Admiralty" in Settings) rather than automatic, matching this app's
// existing convention for anything that spends an external API's rate
// limit (see the Compare page's "Backfill 1 year of real data" button).

const DISCOVERY_KEY_STORAGE = "cloude-tide:discoveryKey";
const DISCOVERY_PROXY_STORAGE = "cloude-tide:discoveryProxyUrl";
const DISCOVERY_STATIONS_CACHE_KEY = "cloude-tide:discoveryStations";
const DISCOVERY_STATIONS_CACHE_MAX_AGE_MS = 30 * 24 * 3600000; // 30 days — this list barely ever changes
const DISCOVERY_DIRECT_HOST = "https://admiraltyapi.azure-api.net"; // Admiralty's own docs confirm this can't be called directly from a browser — no CORS header on their side — so this is only ever used as a fallback label, not expected to actually succeed from here

function loadDiscoveryKey() {
  try {
    return localStorage.getItem(DISCOVERY_KEY_STORAGE) || "";
  } catch {
    return "";
  }
}

function saveDiscoveryKey(key) {
  try {
    if (key) localStorage.setItem(DISCOVERY_KEY_STORAGE, key);
    else localStorage.removeItem(DISCOVERY_KEY_STORAGE);
  } catch {
    // Storage unavailable — key just won't persist between visits.
  }
}

function loadDiscoveryProxyUrl() {
  try {
    return (localStorage.getItem(DISCOVERY_PROXY_STORAGE) || "").replace(/\/+$/, "");
  } catch {
    return "";
  }
}

function saveDiscoveryProxyUrl(url) {
  try {
    const trimmed = (url || "").replace(/\/+$/, "");
    if (trimmed) localStorage.setItem(DISCOVERY_PROXY_STORAGE, trimmed);
    else localStorage.removeItem(DISCOVERY_PROXY_STORAGE);
  } catch {
    // Storage unavailable — proxy URL just won't persist between visits.
  }
}

// The proxy forwards whatever path/query it receives straight on to
// Admiralty (see admiralty-proxy-worker.js), so the client-side path
// structure stays identical either way — only the host changes.
function discoveryApiBase() {
  const proxy = loadDiscoveryProxyUrl();
  return `${proxy || DISCOVERY_DIRECT_HOST}/uktidalapi/api/V1`;
}

// Wraps a Discovery fetch so a raw network-level failure (TypeError,
// "Load failed", "Failed to fetch" — exactly what a CORS block looks
// like from fetch()'s perspective) gets a clear, actionable message
// when there's no proxy configured yet, rather than a cryptic browser
// error with no indication of what to actually do about it.
async function fetchDiscovery(path, apiKey) {
  try {
    // cache: "no-store" — every Admiralty check genuinely needs fresh
    // data (tide predictions and the reliability of a learned
    // correction both depend on it), so this must never be served
    // from the browser's own HTTP cache even if a future response
    // ever carried cache-friendly headers.
    return await fetchWithTimeout(`${discoveryApiBase()}${path}`, {
      headers: { "Ocp-Apim-Subscription-Key": apiKey },
      cache: "no-store"
    }, 30000);
  } catch (err) {
    if (!loadDiscoveryProxyUrl()) {
      throw new Error("Couldn't reach Admiralty directly — browsers can't call their API without a small relay in between. Set a Discovery proxy URL in Settings (see admiralty-proxy-worker.js in the project files).");
    }
    throw err;
  }
}

// Fetches and caches the full 607-station list. GeoJSON: each feature's
// coordinates are [lon, lat] (GeoJSON's own convention, the opposite
// order to everywhere else in this codebase — deliberately converted
// back to {lat, lon} immediately here so nothing downstream has to
// remember which order this one source uses).
async function loadDiscoveryStations(apiKey) {
  try {
    const raw = localStorage.getItem(DISCOVERY_STATIONS_CACHE_KEY);
    if (raw) {
      const cached = JSON.parse(raw);
      if (cached.fetchedAt && Date.now() - cached.fetchedAt < DISCOVERY_STATIONS_CACHE_MAX_AGE_MS) {
        return cached.stations;
      }
    }
  } catch {
    // fall through to a fresh fetch
  }

  const res = await fetchDiscovery("/Stations/", apiKey);
  if (!res.ok) throw new Error(`Admiralty station list fetch failed: ${res.status}`);
  const geojson = await res.json();
  const stations = (geojson.features || [])
    .map(f => ({
      id: f.properties?.Id,
      name: f.properties?.Name,
      lat: f.geometry?.coordinates?.[1],
      lon: f.geometry?.coordinates?.[0]
    }))
    .filter(s => s.id && typeof s.lat === "number" && typeof s.lon === "number");

  try {
    localStorage.setItem(DISCOVERY_STATIONS_CACHE_KEY, JSON.stringify({ fetchedAt: Date.now(), stations }));
  } catch {
    // Cache write failing just means a slower re-fetch next time — not fatal.
  }
  return stations;
}

// Normalises a place name for comparison — lowercase, drop a trailing
// ", County" (resolveLocation's own labels always carry one) and any
// trailing "(qualifier)" like "(New Quay)" or "(Approaches)" — several
// real Discovery stations share one town name this way (e.g. Teignmouth
// has both "Teignmouth (New Quay)" and "Teignmouth (Approaches)") — then
// strips punctuation. Kept deliberately simple: this only needs to
// recognise "this is genuinely the same named place", not handle every
// possible spelling variant.
function normalizePlaceName(name) {
  return (name || "")
    .split(",")[0]
    .replace(/\([^)]*\)/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Finds the real Admiralty station for a location — preferring an exact
// NAME match over raw distance. This matters because Admiralty's own
// secondary-port predictions are already correctly adjusted from
// whichever standard port each place is traditionally referenced
// against (e.g. Lyme Regis is referenced to Plymouth, not its nearer-
// by-air neighbour Weymouth, because Weymouth sits on an amphidromic
// point that makes it a poor tidal proxy despite being geographically
// closer) — so if a station literally named after the place exists in
// Discovery's 607-station list, that IS the right, already-correctly-
// adjusted answer, and picking the nearest-by-distance station instead
// would silently ignore Admiralty's own considered choice of reference.
// Nearest-by-distance is only a fallback for wherever no station bears
// the place's own name (e.g. a postcode resolving to an unnamed stretch
// of coast, or a genuinely ungauged location).
async function nearestDiscoveryStation(lat, lon, apiKey, label) {
  const stations = await loadDiscoveryStations(apiKey);

  if (label) {
    const target = normalizePlaceName(label);
    if (target.length >= 3) {
      // A town can have more than one qualified entry (Teignmouth has
      // both "(New Quay)" and "(Approaches)") — collect every match
      // rather than taking the first, and pick whichever is physically
      // closest to the location actually being added, since a plain
      // "Teignmouth" search has no way to know which qualifier the
      // person meant.
      const nameMatches = stations.filter(s => normalizePlaceName(s.name) === target);
      if (nameMatches.length) {
        let best = nameMatches[0], bestDist = haversineKm(lat, lon, best.lat, best.lon);
        nameMatches.forEach(s => {
          const d = haversineKm(lat, lon, s.lat, s.lon);
          if (d < bestDist) { bestDist = d; best = s; }
        });
        return { ...best, distanceKm: bestDist };
      }
    }
  }

  let best = null, bestDist = Infinity;
  stations.forEach(station => {
    const dist = haversineKm(lat, lon, station.lat, station.lon);
    if (dist < bestDist) {
      bestDist = dist;
      best = station;
    }
  });
  return best ? { ...best, distanceKm: bestDist } : null;
}

// Admiralty's own FAQ is explicit: "Is British Summer Time applied to
// predictions? No. All predicted height times are shown at Greenwich
// Mean Time (GMT)" — never adjusted for BST, even in summer. Their own
// published schema never shows an explicit UTC marker on the DateTime
// string, though ("DateTime": "string" is the whole example). If their
// real response omits one too, plain Date.parse() would treat it as
// LOCAL time per the ES2015+ spec for a timezone-less ISO datetime —
// which during BST silently shifts every Admiralty event an hour
// early, systematically. This forces UTC whenever the string doesn't
// already specify its own timezone, rather than trusting that default.
function parseAdmiraltyDateTime(raw) {
  if (!raw) return NaN;
  const hasTimezone = /Z$|[+-]\d{2}:?\d{2}$/.test(raw);
  return Date.parse(hasTimezone ? raw : `${raw}Z`);
}

async function fetchDiscoveryEvents(stationId, apiKey, durationDays) {
  const duration = Math.max(1, Math.min(7, durationDays || 7));
  const res = await fetchDiscovery(`/Stations/${stationId}/TidalEvents?duration=${duration}`, apiKey);
  if (!res.ok) throw new Error(`Admiralty tidal events fetch failed: ${res.status}`);
  const data = await res.json();
  // Admiralty's own predictions are always Chart-Datum-referenced — no
  // conversion needed on this side.
  return data
    .filter(e => !e.Filtered && typeof e.Height === "number")
    .map(e => ({
      type: e.EventType === "HighWater" ? "high" : "low",
      time: parseAdmiraltyDateTime(e.DateTime),
      heightCD: e.Height
    }))
    .filter(e => !Number.isNaN(e.time))
    .sort((a, b) => a.time - b.time);
}

// ---- Learned secondary-port offset storage ----
// Keyed by the DISCOVERY station id (not the saved location's own id),
// mirroring how TFV is keyed by EA station id — two saved locations
// that share a nearest Discovery station share the same real-world
// geographic offset, since it's the same two physical places being
// compared either way.
function secondaryOffsetKey(discoveryStationId) {
  return `cloude-tide:secondary:${discoveryStationId}`;
}

function loadSecondaryOffset(discoveryStationId) {
  try {
    const raw = localStorage.getItem(secondaryOffsetKey(discoveryStationId));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveSecondaryOffset(discoveryStationId, offset) {
  try {
    localStorage.setItem(secondaryOffsetKey(discoveryStationId), JSON.stringify(offset));
  } catch {
    // Storage unavailable — learned offset just won't persist between visits.
  }
}

// Runs the full learn: fetch Discovery's real events, compare each
// against our own EA-station model's nearest same-type prediction (in
// Chart Datum terms, via the EA station's own cdOffsetOD — comparing
// before that conversion would just measure the OD/CD gap between the
// two data sources, not the real geographic difference between the two
// places), and average the differences separately for highs and lows.
//
// Returns null (and stores nothing) if the EA station has no confident
// cdOffsetOD — proceeding without it would silently produce a "learned
// offset" that's actually just measuring the wrong thing.
async function learnSecondaryOffset({ eaStation, discoveryStationId, discoveryStationDistanceFromEaStationKm, apiKey, fit, epochIso }) {
  if (typeof eaStation.cdOffsetOD !== "number") {
    throw new Error("This location's nearest EA station has no confirmed Chart Datum offset yet, so a learned correction against it wouldn't be trustworthy.");
  }

  const discoveryEvents = await fetchDiscoveryEvents(discoveryStationId, apiKey, 7);
  if (discoveryEvents.length < 4) {
    throw new Error("Admiralty didn't return enough tidal events to learn from — try again later.");
  }

  const fudge = loadTideFudge(eaStation.id);
  const windowStartHours = (discoveryEvents[0].time - Date.parse(epochIso)) / 3600000 - 12;
  const windowEndHours = (discoveryEvents[discoveryEvents.length - 1].time - Date.parse(epochIso)) / 3600000 + 12;
  const modelEvents = significantTideExtremes(findTideExtremes(fit, windowStartHours, windowEndHours)).map(e => ({
    type: e.type,
    time: Date.parse(epochIso) + e.hours * 3600000,
    // OD (mAOD-consistent, since the model was fit to EA's own mAOD
    // readings) → Chart Datum, so this is comparable to Discovery's
    // own CD-referenced heights.
    heightCD: applyTideFudge(e.level, fudge) - eaStation.cdOffsetOD
  }));

  const diffsByType = { high: { time: [], discoveryHeight: [], modelHeight: [] }, low: { time: [], discoveryHeight: [], modelHeight: [] } };
  discoveryEvents.forEach(dEvent => {
    let nearest = null, nearestGap = Infinity;
    modelEvents.forEach(mEvent => {
      if (mEvent.type !== dEvent.type) return;
      const gap = Math.abs(mEvent.time - dEvent.time);
      if (gap < nearestGap) {
        nearestGap = gap;
        nearest = mEvent;
      }
    });
    // A match more than 4 hours off is almost certainly the wrong cycle
    // (e.g. comparing against a neighbouring day's event rather than
    // the corresponding one) — skip rather than pollute the average.
    // Also requires nearest.heightCD to be a real, meaningfully positive
    // Chart Datum height (not near zero) before dividing by it — Chart
    // Datum heights are heights above LAT, so this should almost always
    // hold for a genuine tidal extreme; skip rather than risk an
    // unstable ratio if it doesn't.
    if (nearest && nearestGap <= 4 * 3600000 && nearest.heightCD > 0.15) {
      diffsByType[dEvent.type].time.push((dEvent.time - nearest.time) / 60000); // minutes
      diffsByType[dEvent.type].discoveryHeight.push(dEvent.heightCD);
      diffsByType[dEvent.type].modelHeight.push(nearest.heightCD);
    }
  });

  // Standard deviation of an array — used below to see how much the
  // individual per-event samples disagree with each other, not just
  // their average. With typically only 6-14 samples in a week this is
  // a noisy estimate, not a precise figure — treated as a rough flag
  // in the UI, never as a confident diagnosis.
  const stdDev = arr => {
    if (arr.length < 2) return null;
    const m = arr.reduce((a, b) => a + b, 0) / arr.length;
    const variance = arr.reduce((a, b) => a + (b - m) ** 2, 0) / (arr.length - 1);
    return Math.sqrt(variance);
  };

  const mean = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;

  // Fits real = a + b*model (ordinary least squares) rather than a pure
  // ratio (real = b*model, forced through zero). A pure ratio was found
  // to badly misrepresent a genuine ADDITIVE height bias — the kind
  // that shows up as roughly the same real-world error in metres at
  // both high and low tide — because dividing that same fixed error by
  // a much smaller low-tide height inflates the ratio far more than it
  // does at high tide. That exact fingerprint (a much bigger "% correction"
  // on low tide than high tide, with individual samples agreeing closely
  // with each other) is what a same-place self-check against Weymouth
  // showed: not noise, not a real amplitude difference, but a fixed
  // metres-level offset being forced through the wrong kind of model.
  // The general linear fit resolves correctly either way without having
  // to know in advance which kind of mismatch a location has: a=0,b≈1
  // for a well-matched station; a large b with small a for a genuine
  // amplitude difference (Lyme Regis vs Weymouth); a small b-deviation
  // with a real nonzero a for a same-place additive bias (this case).
  const linearFit = (modelArr, realArr) => {
    const n = modelArr.length;
    if (n < 2) return null;
    const meanModel = mean(modelArr), meanReal = mean(realArr);
    let cov = 0, varModel = 0;
    for (let i = 0; i < n; i++) {
      const dm = modelArr[i] - meanModel;
      cov += dm * (realArr[i] - meanReal);
      varModel += dm * dm;
    }
    // No spread in the model's own heights to fit a slope against
    // (can happen with very few samples) — fall back to a pure
    // additive shift rather than an undefined/unstable slope.
    if (varModel === 0) return { intercept: meanReal - meanModel, slope: 1 };
    const slope = cov / varModel;
    const intercept = meanReal - slope * meanModel;
    return { intercept, slope };
  };

  const residualStdDev = (modelArr, realArr, fit) => {
    if (!fit) return null;
    const residuals = modelArr.map((m, i) => realArr[i] - (fit.intercept + fit.slope * m));
    return stdDev(residuals);
  };

  const highFit = linearFit(diffsByType.high.modelHeight, diffsByType.high.discoveryHeight);
  const lowFit = linearFit(diffsByType.low.modelHeight, diffsByType.low.discoveryHeight);

  const offset = {
    highTimeMin: mean(diffsByType.high.time),
    highHeightIntercept: highFit ? highFit.intercept : null,
    highHeightSlope: highFit ? highFit.slope : null,
    highHeightResidualSpread: residualStdDev(diffsByType.high.modelHeight, diffsByType.high.discoveryHeight, highFit),
    highTimeSpread: stdDev(diffsByType.high.time),
    lowTimeMin: mean(diffsByType.low.time),
    lowHeightIntercept: lowFit ? lowFit.intercept : null,
    lowHeightSlope: lowFit ? lowFit.slope : null,
    lowHeightResidualSpread: residualStdDev(diffsByType.low.modelHeight, diffsByType.low.discoveryHeight, lowFit),
    lowTimeSpread: stdDev(diffsByType.low.time),
    sampleCount: diffsByType.high.time.length + diffsByType.low.time.length,
    learnedAt: new Date().toISOString(),
    // How far the matched Admiralty station is from the EA gauge itself
    // (not from the saved location — a different distance). When this is
    // small, the two are essentially the same physical place, so a large
    // correction here would mean the model disagrees with real data about
    // the SAME location — a red flag in its own right, not a genuine
    // geographic correction (see the reliability check below).
    eaToDiscoveryDistanceKm: typeof discoveryStationDistanceFromEaStationKm === "number" ? discoveryStationDistanceFromEaStationKm : null
  };
  if (!highFit && !lowFit) {
    // linearFit needs at least 2 matched same-type events to produce a
    // real slope+intercept — this is a DIFFERENT condition from "zero
    // events matched at all" (which the old check here tested for).
    // With exactly one matched high event and one matched low event,
    // the old check passed silently, then saved an offset with null
    // height fields anyway — indistinguishable from a genuinely stale
    // pre-fix offset, which is exactly the confusing "stored correction
    // is outdated" message a location kept showing no matter how many
    // times it was rechecked. Catching it here, before anything is
    // saved, means a real cause (the two places' tide timings not
    // lining up well enough within the 4-hour matching window — quite
    // possible for an open coastal bay checked against an estuary
    // gauge) gets its own honest message instead.
    throw new Error("Admiralty's predictions and this location's own model only lined up closely enough to compare on 1 or fewer high and low events each this week — too few to learn a reliable height correction from. This can happen when the matched places have a genuinely different tidal timing (e.g. an open bay vs a sheltered estuary) — try again in a few days once more events are available, or check a more local named station if one exists nearby.");
  }

  saveSecondaryOffset(discoveryStationId, offset);
  return offset;
}

// Rough, best-effort read on whether a location's learned correction
// looks trustworthy — three checks, none of them a confident diagnosis
// on their own, but together a useful flag for "look more closely here":
//
// 1. Plain distance from the nearest EA gauge — the further away, the
//    more this location depends on the correction actually being good,
//    since the uncorrected model itself is weaker here than usual.
// 2. The SIZE of the learned ratio — a ratio far from 1.0 means a real
//    amplitude mismatch (Weymouth vs Lyme Regis is the known example).
//    This is exactly what the ratio correction is FOR, so a big ratio
//    isn't itself a problem — just worth knowing how much correcting
//    is happening.
// 3. The CONSISTENCY of the individual samples — this is the one that
//    can catch a genuine SHAPE mismatch (Southampton's double high
//    water is the known example), which no single ratio or time shift
//    can properly fix. If the real per-event samples disagree with each
//    other by a lot, no single number was ever going to describe this
//    location well, and that disagreement is the tell — no need to
//    already know it's a "Southampton-style" case in advance.
// Rough, best-effort read on whether a location's learned correction
// looks trustworthy — checks, none a confident diagnosis on their own,
// but together a useful flag for "look more closely here":
//
// 1. Plain distance from the nearest EA gauge — the further away, the
//    more this location depends on the correction actually being good,
//    since the uncorrected model itself is weaker here than usual.
// 2. Same-place sanity check — if the matched Admiralty station is
//    essentially the same physical place as the EA gauge, BOTH the
//    slope should sit close to 1 AND the intercept close to 0; either
//    one being off means the comparison itself is untrustworthy, not a
//    genuine correction.
// 3. The SIZE of the learned slope — a slope far from 1.0 means a real
//    amplitude mismatch (Weymouth vs Lyme Regis is the known example).
//    This is exactly what the correction is FOR, so a big slope isn't
//    itself a problem — just worth knowing how much correcting is
//    happening.
// 4. The CONSISTENCY of the individual samples around the fitted line
//    (the residual spread) — this is the one that can catch a genuine
//    SHAPE mismatch (Southampton's double high water is the known
//    example), which no single slope+intercept pair can properly fix.
//    If real samples scatter widely around the fitted line relative to
//    the tide's own typical size, no simple correction was ever going
//    to describe this location well, and that scatter is the tell — no
//    need to already know it's a "Southampton-style" case in advance.
function assessSecondaryOffsetReliability(eaStation, offset) {
  const notes = [];

  const SAME_PLACE_KM = 5;
  const SAME_PLACE_MAX_SLOPE_DEVIATION = 0.15;
  const SAME_PLACE_MAX_INTERCEPT_M = 0.3;
  const isSamePlace = typeof offset.eaToDiscoveryDistanceKm === "number" && offset.eaToDiscoveryDistanceKm <= SAME_PLACE_KM;

  if (isSamePlace) {
    [["high", offset.highHeightSlope, offset.highHeightIntercept], ["low", offset.lowHeightSlope, offset.lowHeightIntercept]].forEach(([type, slope, intercept]) => {
      const slopeOff = typeof slope === "number" && Math.abs(slope - 1) > SAME_PLACE_MAX_SLOPE_DEVIATION;
      const interceptOff = typeof intercept === "number" && Math.abs(intercept) > SAME_PLACE_MAX_INTERCEPT_M;
      if (slopeOff || interceptOff) {
        const parts = [];
        if (slopeOff) parts.push(`a scaling factor of ×${slope.toFixed(2)}`);
        if (interceptOff) parts.push(`a fixed shift of ${intercept >= 0 ? "+" : ""}${intercept.toFixed(2)}m`);
        notes.push(`⚠ This correction looks unreliable: the Admiralty station used is only ${offset.eaToDiscoveryDistanceKm.toFixed(1)}km from the gauge itself, essentially the same physical place, yet the learned ${type}-tide correction includes ${parts.join(" and ")} — a real same-place comparison should need almost neither. Treat this correction with real caution until it's been rechecked.`);
      }
    });
  }

  if (eaStation.distanceKm > 40) {
    notes.push(`This location's nearest gauge is ${eaStation.distanceKm.toFixed(0)}km away — further than usual, so this correction matters more here than most.`);
  }

  if (!isSamePlace) {
    [["high", offset.highHeightSlope], ["low", offset.lowHeightSlope]].forEach(([type, slope]) => {
      if (typeof slope === "number" && Math.abs(slope - 1) > 0.2) {
        const pct = Math.round((slope - 1) * 100);
        notes.push(`A substantial ${type} correction (scaling by ${pct >= 0 ? "+" : ""}${pct}%) has been applied — this location's tide differs considerably in size from its nearest gauge.`);
      }
    });
  }

  [["high", offset.highHeightResidualSpread], ["low", offset.lowHeightResidualSpread]].forEach(([type, spread]) => {
    // Residual spread relative to a typical tidal range (2m — a rough
    // but reasonable UK-wide yardstick) rather than relative to the
    // slope/ratio itself, since a residual is already in metres and
    // comparing it to a near-zero ratio would be meaningless.
    if (typeof spread === "number" && spread > 0.3) {
      notes.push(`The ${type}-tide samples used to learn this correction scattered more than usual around the fitted line (±${spread.toFixed(2)}m) — possibly a sign this location's tide has a genuinely different SHAPE from its nearest gauge (like a double high or low water), which a single correction can't fully fix. Worth treating ${type} predictions here with extra caution.`);
    }
  });

  return notes;
}

// Applies a learned secondary-port offset to a single hours/OD-level
// pair, returning a Chart-Datum-referenced result. The time shift
// blends between the high-tide and low-tide offsets by how far through
// the current half-cycle the given hour sits, rather than snapping
// straight from one to the other at each event — real secondary-port
// tide tables interpolate between reference points the same way. The
// height follows the gauge's curve between the place's own corrected
// high and low (see below).
//
// Returns null if there's no usable offset, or if eaStation has no
// confirmed cdOffsetOD (the learned offset is itself CD-referenced,
// since that's what Admiralty's own data uses — applying it to an
// unconverted OD level would silently mix two different height
// references, which is exactly the mismatch this function exists to
// avoid rather than reproduce).
function applySecondaryOffset(fit, hours, odLevel, eaStation, offset) {
  if (!offset || typeof eaStation.cdOffsetOD !== "number") return null;
  const allNearbyEvents = findTideExtremes(fit, hours - 8, hours + 8);
  const nearbyEvents = significantTideExtremes(allNearbyEvents);
  if (nearbyEvents.length < 2) return null;

  let before = null, after = null;
  for (const e of nearbyEvents) {
    if (e.hours <= hours) before = e;
    if (e.hours > hours && !after) after = e;
  }
  if (!before || !after) return null;

  const offsetFor = type => ({
    timeMin: type === "high" ? offset.highTimeMin : offset.lowTimeMin,
    slope: type === "high" ? offset.highHeightSlope : offset.lowHeightSlope,
    intercept: type === "high" ? offset.highHeightIntercept : offset.lowHeightIntercept
  });
  const beforeOffset = offsetFor(before.type);
  const afterOffset = offsetFor(after.type);
  if (beforeOffset.timeMin === null || afterOffset.timeMin === null) return null;
  if (typeof beforeOffset.slope !== "number" || typeof afterOffset.slope !== "number") return null;
  if (typeof beforeOffset.intercept !== "number" || typeof afterOffset.intercept !== "number") return null;

  const span = after.hours - before.hours;
  const frac = span > 0 ? (hours - before.hours) / span : 0;
  const timeMin = beforeOffset.timeMin + (afterOffset.timeMin - beforeOffset.timeMin) * frac;

  // Heights, the way Admiralty does a secondary port: work out the
  // place's own high and low water either side (each with its own
  // learned correction), then go between them following the gauge's
  // curve — how far the gauge has risen or fallen between its own two
  // events is how far the place has between its two. That can never
  // make a high or low that isn't one at the gauge.
  //
  // (It used to blend the high-water and low-water corrections
  // themselves across the half-cycle and apply the blend to the gauge's
  // height. When the two corrections differ a lot — Lyme Regis against
  // Weymouth or Plymouth — that blend dips and rises on its own, which
  // drew false lows: Charmouth showed one about three hours after high
  // water, Nov 2026.)
  //
  // odLevel can include the gauge's learned fudge; the same shift is
  // added to the two events so all three heights are on one footing.
  const gaugeNow = predictTideLevel(fit, hours);
  const fudgeShift = odLevel - gaugeNow;
  const placeHeight = (event, o) => (event.level + fudgeShift - eaStation.cdOffsetOD) * o.slope + o.intercept;
  const beforeCD = placeHeight(before, beforeOffset);
  const afterCD = placeHeight(after, afterOffset);
  // Where the gauge has a stand or wiggle in this half-cycle (a double
  // low, say), its shape isn't one the place shares, so a plain smooth
  // rise or fall (a half cosine) is used for that half-cycle instead.
  const gaugeChange = before.level - after.level;
  const gaugeHasStand = allNearbyEvents.some(e => e.hours > before.hours && e.hours < after.hours);
  const through = (gaugeHasStand || Math.abs(gaugeChange) <= 0.05)
    ? (1 - Math.cos(Math.PI * frac)) / 2
    : Math.max(0, Math.min(1, (before.level - gaugeNow) / gaugeChange));
  const levelCD = beforeCD + (afterCD - beforeCD) * through;
  return { hours: hours + timeMin / 60, levelCD };
}

// ---- Published time differences (secondary ports) ----
// Admiralty's high and low water time differences for places round St
// Brides Bay, from Milford Haven, as printed in the Port of Milford
// Haven's own tide tables (Crown copyright, reproduced there from
// Admiralty Tide Tables). The gauge's tide is right for the Haven; these
// make it right for the place. Minutes later (+) or earlier (-):
//   hw: [when Milford's high water is at 0100 or 1300, at 0800 or 2000]
//   lw: [when Milford's low water is at 0100 or 1300, at 0700 or 1900]
// all GMT, with times in between interpolated, as the tables say.
// Times only: the tables give no height differences for these places,
// so heights stay Milford Haven's (on its Chart Datum).
// Used for a tide place within TIME_DIFFERENCE_MAX_KM of one of these
// that hasn't been checked against Admiralty, for the Callout tide box,
// and for the coast map (coast-areas.js zones).
const TIDE_TIME_DIFFERENCES = [
  { name: "Little Haven", stationId: "E73039", lat: 51.7735, lon: -5.1090, hw: [10, 10], lw: [25, 15] },
  { name: "Martin's Haven", stationId: "E73039", lat: 51.7367, lon: -5.2460, hw: [10, 10], lw: [15, 15] },
  { name: "Skomer Island", stationId: "E73039", lat: 51.7360, lon: -5.2960, hw: [-5, -5], lw: [5, 5] },
  { name: "Dale Roads", stationId: "E73039", lat: 51.7030, lon: -5.1580, hw: [-5, -5], lw: [-8, -8] },
  { name: "Solva", stationId: "E73039", lat: 51.8700, lon: -5.1970, hw: [15, 10], lw: [35, 15] },
  { name: "Ramsey Sound", stationId: "E73039", lat: 51.8650, lon: -5.3350, hw: [30, 30], lw: [30, 30] }
];
const TIME_DIFFERENCE_MAX_KM = 6;

function nearestTimeDifference(lat, lon, stationId, maxKm = TIME_DIFFERENCE_MAX_KM) {
  if (typeof lat !== "number" || typeof lon !== "number") return null;
  let best = null, bestKm = maxKm;
  TIDE_TIME_DIFFERENCES.forEach(entry => {
    if (stationId && entry.stationId !== stationId) return;
    const km = haversineKm(lat, lon, entry.lat, entry.lon);
    if (km <= bestKm) { bestKm = km; best = entry; }
  });
  return best;
}

function timeDifferenceByName(name) {
  return TIDE_TIME_DIFFERENCES.find(entry => entry.name === name) || null;
}

// Minutes to add to a gauge high or low at eventMs, interpolated between
// the table's two columns by the gauge event's time of day (GMT, which
// repeats every 12 hours: column A at 01:00, B at 08:00 for high water
// or 07:00 for low water).
function tableTimeDifferenceMin(entry, type, eventMs) {
  const [a, b] = type === "high" ? entry.hw : entry.lw;
  const at = type === "high" ? 8 : 7;
  let h = ((eventMs / 3600000) % 12 + 12) % 12; // hours past 00:00 or 12:00
  if (h < 1) h += 12;                            // 00:00-01:00 belongs between B and the next A (13:00)
  if (h <= at) return a + (b - a) * (h - 1) / (at - 1);
  return b + (a - b) * (h - at) / (13 - at);
}

// The gauge's moment `hours` moved to the place's time, blending the
// differences of the gauge's high or low either side. events: the
// gauge's significant highs and lows, if already worked out (faster).
function timeDifferenceHoursAt(fit, epochMs, hours, entry, events) {
  const list = events || significantTideExtremes(findTideExtremes(fit, hours - 8, hours + 8));
  let lo = 0, hi = list.length - 1;
  if (hi < 1 || list[0].hours > hours || list[hi].hours <= hours) return null;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (list[mid].hours <= hours) lo = mid; else hi = mid;
  }
  const before = list[lo], after = list[hi];
  const span = after.hours - before.hours;
  const frac = span > 0 ? (hours - before.hours) / span : 0;
  const dBefore = tableTimeDifferenceMin(entry, before.type, epochMs + before.hours * 3600000);
  const dAfter = tableTimeDifferenceMin(entry, after.type, epochMs + after.hours * 3600000);
  return hours + (dBefore + (dAfter - dBefore) * frac) / 60;
}

// Constituents for a tide fitted to a place's moved curve (below): the
// main ones plus shallow-water ones that can carry the place's highs
// and lows being moved by different amounts. All tell apart over the
// two months it's fitted to.
const TIDE_CONSTITUENTS_PLACE = TIDE_CONSTITUENTS.concat(
  ["MU2", "L2", "M3", "MN4", "MK4", "S4", "M6", "2MS6"].map(n => TIDE_CONSTITUENT_BY_NAME.get(n))
);

// A tide fit for a place with published time differences: the gauge's
// prediction every 15 minutes for 20 days either side of now, each moved
// to the place's time, fitted again — so everything that uses a fit
// (heights at any time, highs and lows) is the place's own. Heights are
// the gauge's, scaled about mean level by `ratio` if given (the coast
// map's tide-model range ratio). Without fudge: callers add the gauge's
// fudge as usual. Returns { fit, rmsM } or null.
//
// Takes about a second on a phone, so it's kept on the phone and reused
// for PLACE_FIT_MAX_AGE_MS while the gauge's fit is the same.
const PLACE_FIT_MAX_AGE_MS = 5 * 24 * 3600000;

function timeDifferenceFit(built, entry, ratio = 1) {
  const sig = [built.epochIso, built.fit.coeffs.slice(0, 5).map(x => x.toFixed(5)).join(","), entry.name, ratio.toFixed(3)].join("|");
  const key = `cloude-tide:placefit:${entry.name}`;
  try {
    const saved = JSON.parse(localStorage.getItem(key) || "null");
    if (saved && saved.sig === sig && Date.now() - saved.madeAt < PLACE_FIT_MAX_AGE_MS && saved.fit) {
      return { fit: saved.fit, rmsM: saved.rmsM };
    }
  } catch { /* nothing kept */ }
  const made = makeTimeDifferenceFit(built, entry, ratio);
  if (made) {
    try { localStorage.setItem(key, JSON.stringify({ sig, madeAt: Date.now(), fit: made.fit, rmsM: made.rmsM })); } catch { /* not kept */ }
  }
  return made;
}

function makeTimeDifferenceFit(built, entry, ratio) {
  const epochMs = Date.parse(built.epochIso);
  const nowH = (Date.now() - epochMs) / 3600000;
  const from = nowH - 20 * 24, to = nowH + 20 * 24;
  const events = significantTideExtremes(findTideExtremes(built.fit, from - 12, to + 12));
  const mean = built.fit.coeffs[0];
  const readings = [];
  for (let h = from; h <= to; h += 0.25) {
    const moved = timeDifferenceHoursAt(built.fit, epochMs, h, entry, events);
    if (moved === null) continue;
    readings.push({ hours: moved, level: mean + (predictTideLevel(built.fit, h) - mean) * ratio });
  }
  if (readings.length < 1500) return null;
  const fit = fitTideHarmonics(readings, TIDE_CONSTITUENTS_PLACE);
  if (!fit) return null;
  let sq = 0;
  for (const r of readings) sq += (predictTideLevel(fit, r.hours) - r.level) ** 2;
  return { fit, rmsM: Math.sqrt(sq / readings.length) };
}

// ---- Coastal suitability check, for the "are you sure?" warning when
// adding a tide/fishing location ----
//
// Deliberately NOT a height-alone check. A location can be genuinely
// high (a clifftop path, a harbour wall town built up a hillside) and
// still be right on the coast, where tides matter completely normally
// — Tintagel is ~90m up and a perfectly sensible tide location. What
// actually makes a location a poor fit for tide prediction is being
// BOTH far from the sea AND well above it — a real inland/upland spot
// like Snowdon, not a high coastal one. So this always requires both
// conditions together, never either alone; see
// COASTAL_SUITABILITY_THRESHOLDS below for the two rules combined this
// way (a coastal cliff will fail every distance check regardless of
// its height).
//
// Reuses the exact same static data files map.js already depends on
// for terrain shading (data/elevation-uk.json) and the coastline layer
// (data/coastline-50m.json) — fetched independently here since
// settings.html (where locations get added) never loads map.js, and
// nothing about this check needs the rest of the map renderer. Both
// fetches are lazy (only triggered by an actual add) and cached in
// memory for the rest of the page's life.
const ELEVATION_DATA_URL = "data/elevation-uk.json";
const COASTLINE_DATA_URL = "data/coastline-50m.json";

let coastalCheckDataPromise = null;

async function loadCoastalCheckData() {
  if (coastalCheckDataPromise) return coastalCheckDataPromise;
  coastalCheckDataPromise = (async () => {
    const [elevationResult, coastlineResult] = await Promise.allSettled([
      fetchWithTimeout(ELEVATION_DATA_URL, {}, 20000).then(res => {
        if (!res.ok) throw new Error(String(res.status));
        return res.json();
      }),
      fetchWithTimeout(COASTLINE_DATA_URL, {}, 20000).then(res => {
        if (!res.ok) throw new Error(String(res.status));
        return res.json();
      })
    ]);

    let elevation = null;
    if (elevationResult.status === "fulfilled") {
      const data = elevationResult.value;
      const values = [];
      for (let r = 0; r < data.rows; r++) {
        values.push(data.values.slice(r * data.cols, (r + 1) * data.cols));
      }
      elevation = { ...data, values };
    }

    const coastline = coastlineResult.status === "fulfilled" ? coastlineResult.value : null;

    // Either or both can be legitimately missing (not yet built, or a
    // fetch failure) — callers treat that as "can't verify" and skip
    // the warning rather than blocking the add, same as every other
    // degrade-not-break pattern this app already uses for map data.
    return { elevation, coastline };
  })();
  return coastalCheckDataPromise;
}

// Bilinear elevation lookup — identical maths to terrainElevationAt in
// map.js (kept as a separate copy rather than a shared import, since
// this is a plain multi-page static site with no build step and
// map.js is never loaded on settings.html).
function coastalCheckElevationAt(grid, lat, lon) {
  const fr = (lat - grid.lat0) / grid.dLat;
  const fc = (lon - grid.lon0) / grid.dLon;
  if (fr < 0 || fc < 0 || fr > grid.rows - 1 || fc > grid.cols - 1) return null;
  const r0 = Math.floor(fr), c0 = Math.floor(fc);
  const r1 = Math.min(grid.rows - 1, r0 + 1), c1 = Math.min(grid.cols - 1, c0 + 1);
  const tr = fr - r0, tc = fc - c0;

  const z00 = grid.values[r0][c0], z01 = grid.values[r0][c1];
  const z10 = grid.values[r1][c0], z11 = grid.values[r1][c1];
  if ([z00, z01, z10, z11].some(v => v === null || v === undefined)) return null;

  const top = z00 + (z01 - z00) * tc;
  const bottom = z10 + (z11 - z10) * tc;
  return top + (bottom - top) * tr;
}

// Same ring-walking shape as eachRing in map.js (kept as a separate
// copy for the same no-shared-import reason as above).
function coastalCheckEachRing(geometry, visit) {
  if (!geometry) return;
  const t = geometry.type, c = geometry.coordinates;
  if (t === "LineString") visit(c);
  else if (t === "MultiLineString" || t === "Polygon") c.forEach(visit);
  else if (t === "MultiPolygon") c.forEach(poly => poly.forEach(visit));
}

const KM_PER_DEG_LAT_APPROX = 111.32; // same constant map.js calls KM_PER_DEG_LAT — duplicated for the same no-shared-import reason as above

// Straight-line (not walking-route) distance from a point to the
// nearest coastline vertex, in km. A bounding-box pre-filter — cheap,
// one pass over each ring's own points — skips whole rings that
// couldn't possibly have a point within searchMarginKm before doing
// any real distance maths, which is what keeps this fast enough to
// run synchronously against a whole-UK coastline file on an "Add"
// button tap. Vertex-to-point rather than segment-to-point: at the
// distances this check actually cares about (tens of km) the
// difference between the two is far smaller than the coastline file's
// own simplification, so the simpler check is enough.
function distanceToCoastKm(coastline, lat, lon, searchMarginKm) {
  if (!coastline) return null;
  const kmPerDegLon = KM_PER_DEG_LAT_APPROX * Math.cos(lat * Math.PI / 180);
  const latMargin = searchMarginKm / KM_PER_DEG_LAT_APPROX;
  const lonMargin = kmPerDegLon > 0 ? searchMarginKm / kmPerDegLon : 180;

  const features = coastline.type === "FeatureCollection" ? coastline.features : [coastline];
  let bestKm = Infinity;

  features.forEach(feature => {
    const geometry = feature.geometry || feature;
    coastalCheckEachRing(geometry, ring => {
      // Cheap ring bounding box first.
      let lonMin = Infinity, lonMax = -Infinity, latMin = Infinity, latMax = -Infinity;
      for (let i = 0; i < ring.length; i++) {
        const [rLon, rLat] = ring[i];
        if (rLon < lonMin) lonMin = rLon;
        if (rLon > lonMax) lonMax = rLon;
        if (rLat < latMin) latMin = rLat;
        if (rLat > latMax) latMax = rLat;
      }
      const nearEnough = lonMax >= lon - lonMargin && lonMin <= lon + lonMargin &&
        latMax >= lat - latMargin && latMin <= lat + latMargin;
      if (!nearEnough) return;

      for (let i = 0; i < ring.length; i++) {
        const [rLon, rLat] = ring[i];
        const km = haversineKm(lat, lon, rLat, rLon);
        if (km < bestKm) bestKm = km;
      }
    });
  });

  return Number.isFinite(bestKm) ? bestKm : null;
}

// The two rules agreed on: either one alone is fine (a clifftop stays
// fine on distance; a low-lying spot a long way inland stays fine on
// height), only their combination is worth a warning. Two separate
// combined checks rather than one, since "far and fairly high" and
// "very far and only moderately high" are both worth flagging even
// though neither alone crosses the other's threshold.
const COASTAL_SUITABILITY_THRESHOLDS = [
  { distanceKm: 15, elevationM: 100 },
  { distanceKm: 30, elevationM: 30 }
];

// Returns { concerning, distanceKm, elevationM } — or { concerning:
// false, distanceKm: null, elevationM: null } if either data file
// couldn't be loaded (can't verify, so doesn't block the add). Never
// throws.
async function assessCoastalSuitability(lat, lon) {
  try {
    const { elevation, coastline } = await loadCoastalCheckData();
    if (!elevation || !coastline) return { concerning: false, distanceKm: null, elevationM: null };

    const elevationM = coastalCheckElevationAt(elevation, lat, lon);
    // Search margin generous above the largest threshold distance
    // (30km) so the bounding-box pre-filter can never itself be the
    // reason a genuinely-nearby coastline point gets missed.
    const distanceKm = distanceToCoastKm(coastline, lat, lon, 60);

    if (elevationM === null || distanceKm === null) {
      return { concerning: false, distanceKm, elevationM };
    }

    const concerning = COASTAL_SUITABILITY_THRESHOLDS.some(
      t => distanceKm > t.distanceKm && elevationM > t.elevationM
    );
    return { concerning, distanceKm, elevationM };
  } catch {
    // Any failure here (bad JSON, unexpected shape) — treat exactly
    // like missing data: can't verify, don't block the add.
    return { concerning: false, distanceKm: null, elevationM: null };
  }
}
