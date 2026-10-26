// Ordnance Survey grid references <-> latitude/longitude (WGS84, as GPS
// and the map use), worked out on the phone with no download.
//
//   parseGridRef("SM 812 093")  -> { lat, lon, squareM: 100, text: "SM 812 093" }
//   gridRefFromLatLon(lat, lon, 8) -> "SM 8123 0934"
//
// Method: the OS's own published formulae. Transverse Mercator on the
// Airy 1830 ellipsoid (the National Grid), and a Helmert transformation
// between OSGB36 and WGS84. That shift is good to about 5 m, which is
// finer than an 8-figure reference (10 m square) anyway.

const OSG = (() => {
  const rad = Math.PI / 180;
  const AIRY = { a: 6377563.396, b: 6356256.909 };
  const WGS84 = { a: 6378137, b: 6356752.314245 };
  const F0 = 0.9996012717, LAT0 = 49 * rad, LON0 = -2 * rad, N0 = -100000, E0 = 400000;
  // OSGB36 -> WGS84 (metres, ppm, arc-seconds).
  const TO_WGS = { tx: 446.448, ty: -125.157, tz: 542.060, s: -20.4894, rx: 0.1502, ry: 0.2470, rz: 0.8421 };
  const TO_OSGB = { tx: -446.448, ty: 125.157, tz: -542.060, s: 20.4894, rx: -0.1502, ry: -0.2470, rz: -0.8421 };

  function meridional(b, n, lat) {
    const n2 = n * n, n3 = n2 * n;
    const Ma = (1 + n + 1.25 * n2 + 1.25 * n3) * (lat - LAT0);
    const Mb = (3 * n + 3 * n2 + (21 / 8) * n3) * Math.sin(lat - LAT0) * Math.cos(lat + LAT0);
    const Mc = ((15 / 8) * n2 + (15 / 8) * n3) * Math.sin(2 * (lat - LAT0)) * Math.cos(2 * (lat + LAT0));
    const Md = (35 / 24) * n3 * Math.sin(3 * (lat - LAT0)) * Math.cos(3 * (lat + LAT0));
    return b * F0 * (Ma - Mb + Mc - Md);
  }

  // Easting/northing -> OSGB36 lat/lon (radians).
  function enToOsgb(E, N) {
    const { a, b } = AIRY;
    const e2 = 1 - (b * b) / (a * a), n = (a - b) / (a + b);
    let lat = LAT0, M = 0;
    do {
      lat = (N - N0 - M) / (a * F0) + lat;
      M = meridional(b, n, lat);
    } while (Math.abs(N - N0 - M) >= 0.00001);
    const s = Math.sin(lat), c = Math.cos(lat), t = Math.tan(lat);
    const nu = a * F0 / Math.sqrt(1 - e2 * s * s);
    const rho = a * F0 * (1 - e2) / Math.pow(1 - e2 * s * s, 1.5);
    const eta2 = nu / rho - 1;
    const t2 = t * t, t4 = t2 * t2, t6 = t4 * t2, sec = 1 / c;
    const nu3 = nu ** 3, nu5 = nu ** 5, nu7 = nu ** 7;
    const VII = t / (2 * rho * nu);
    const VIII = t / (24 * rho * nu3) * (5 + 3 * t2 + eta2 - 9 * t2 * eta2);
    const IX = t / (720 * rho * nu5) * (61 + 90 * t2 + 45 * t4);
    const X = sec / nu;
    const XI = sec / (6 * nu3) * (nu / rho + 2 * t2);
    const XII = sec / (120 * nu5) * (5 + 28 * t2 + 24 * t4);
    const XIIA = sec / (5040 * nu7) * (61 + 662 * t2 + 1320 * t4 + 720 * t6);
    const dE = E - E0;
    return {
      lat: lat - VII * dE ** 2 + VIII * dE ** 4 - IX * dE ** 6,
      lon: LON0 + X * dE - XI * dE ** 3 + XII * dE ** 5 - XIIA * dE ** 7,
    };
  }

  // OSGB36 lat/lon (radians) -> easting/northing.
  function osgbToEn(lat, lon) {
    const { a, b } = AIRY;
    const e2 = 1 - (b * b) / (a * a), n = (a - b) / (a + b);
    const s = Math.sin(lat), c = Math.cos(lat), t = Math.tan(lat);
    const nu = a * F0 / Math.sqrt(1 - e2 * s * s);
    const rho = a * F0 * (1 - e2) / Math.pow(1 - e2 * s * s, 1.5);
    const eta2 = nu / rho - 1;
    const M = meridional(b, n, lat);
    const c3 = c ** 3, c5 = c ** 5, t2 = t * t, t4 = t2 * t2;
    const I = M + N0;
    const II = (nu / 2) * s * c;
    const III = (nu / 24) * s * c3 * (5 - t2 + 9 * eta2);
    const IIIA = (nu / 720) * s * c5 * (61 - 58 * t2 + t4);
    const IV = nu * c;
    const V = (nu / 6) * c3 * (nu / rho - t2);
    const VI = (nu / 120) * c5 * (5 - 18 * t2 + t4 + 14 * eta2 - 58 * t2 * eta2);
    const dL = lon - LON0;
    return {
      N: I + II * dL ** 2 + III * dL ** 4 + IIIA * dL ** 6,
      E: E0 + IV * dL + V * dL ** 3 + VI * dL ** 5,
    };
  }

  // Datum shift via Cartesian coordinates (height taken as 0).
  function shift(lat, lon, from, to, p) {
    const e2f = 1 - (from.b * from.b) / (from.a * from.a);
    const nuF = from.a / Math.sqrt(1 - e2f * Math.sin(lat) ** 2);
    const x1 = nuF * Math.cos(lat) * Math.cos(lon);
    const y1 = nuF * Math.cos(lat) * Math.sin(lon);
    const z1 = nuF * (1 - e2f) * Math.sin(lat);
    const sc = p.s / 1e6 + 1;
    const rx = (p.rx / 3600) * rad, ry = (p.ry / 3600) * rad, rz = (p.rz / 3600) * rad;
    const x2 = p.tx + x1 * sc - y1 * rz + z1 * ry;
    const y2 = p.ty + x1 * rz + y1 * sc - z1 * rx;
    const z2 = p.tz - x1 * ry + y1 * rx + z1 * sc;
    const e2t = 1 - (to.b * to.b) / (to.a * to.a);
    const pp = Math.sqrt(x2 * x2 + y2 * y2);
    let la = Math.atan2(z2, pp * (1 - e2t)), prev;
    do {
      prev = la;
      const nu = to.a / Math.sqrt(1 - e2t * Math.sin(la) ** 2);
      la = Math.atan2(z2 + e2t * nu * Math.sin(la), pp);
    } while (Math.abs(la - prev) > 1e-12);
    return { lat: la, lon: Math.atan2(y2, x2) };
  }

  function enToLatLon(E, N) {
    const o = enToOsgb(E, N);
    const w = shift(o.lat, o.lon, AIRY, WGS84, TO_WGS);
    return { lat: w.lat / rad, lon: w.lon / rad };
  }

  function latLonToEn(lat, lon) {
    const o = shift(lat * rad, lon * rad, WGS84, AIRY, TO_OSGB);
    return osgbToEn(o.lat, o.lon);
  }

  // Two letters -> the 100 km square's easting and northing (km/100).
  function lettersToSquare(l) {
    let l1 = l.charCodeAt(0) - 65, l2 = l.charCodeAt(1) - 65;
    if (l1 === 8 || l2 === 8 || l1 < 0 || l2 < 0 || l1 > 25 || l2 > 25) return null; // no "I"
    if (l1 > 7) l1--;
    if (l2 > 7) l2--;
    const e = ((l1 - 2) % 5) * 5 + (l2 % 5);
    const n = (19 - Math.floor(l1 / 5) * 5) - Math.floor(l2 / 5);
    if (e < 0 || e > 6 || n < 0 || n > 12) return null; // outside Great Britain
    return { e, n };
  }

  function squareToLetters(e100, n100) {
    let l1 = (19 - n100) - (19 - n100) % 5 + Math.floor((e100 + 10) / 5);
    let l2 = (19 - n100) * 5 % 25 + e100 % 5;
    if (l1 > 7) l1++;
    if (l2 > 7) l2++;
    return String.fromCharCode(l1 + 65) + String.fromCharCode(l2 + 65);
  }

  // Reads "SM 812 093", "SM812093", "sm 8123 0934", "SM 81234 09345",
  // or a full easting and northing "181234 209345". A short reference
  // means a square (6 figures = 100 m), so its centre is used.
  function parseGridRef(text) {
    const t = String(text).toUpperCase().replace(/[^A-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
    if (!t) return null;
    let m = /^([A-Z])\s?([A-Z])\s?(\d[\d ]*)$/.exec(t);
    if (m) {
      const sq = lettersToSquare(m[1] + m[2]);
      if (!sq) return null;
      const parts = m[3].trim().split(" ");
      let es, ns;
      if (parts.length === 2 && parts[0].length === parts[1].length) [es, ns] = parts;
      else {
        const d = m[3].replace(/ /g, "");
        if (d.length % 2) return null;
        es = d.slice(0, d.length / 2); ns = d.slice(d.length / 2);
      }
      if (es.length < 1 || es.length > 5) return null;
      const squareM = 10 ** (5 - es.length);
      const E = sq.e * 100000 + Number(es.padEnd(5, "0")) + squareM / 2;
      const N = sq.n * 100000 + Number(ns.padEnd(5, "0")) + squareM / 2;
      const ll = enToLatLon(E, N);
      return { ...ll, squareM, text: `${m[1]}${m[2]} ${es} ${ns}` };
    }
    m = /^(\d{6})(?:\.\d+)?\s+(\d{6,7})(?:\.\d+)?$/.exec(t.replace(/^E\s*|\sN\s*/g, " ").trim());
    if (m) {
      const E = Number(m[1]), N = Number(m[2]);
      if (E > 700000 || N > 1300000) return null;
      const ll = enToLatLon(E, N);
      return { ...ll, squareM: 1, text: `${m[1]} ${m[2]}` };
    }
    return null;
  }

  // "SM 8123 0934" (digits = 6, 8 or 10 figures in all).
  function gridRefFromLatLon(lat, lon, digits = 8) {
    // Rounded to the metre first, so a square's centre read back in
    // doesn't come out a metre short (85849.999 -> 8584).
    const en = latLonToEn(lat, lon);
    const E = Math.round(en.E), N = Math.round(en.N);
    if (!(E >= 0 && E < 700000 && N >= 0 && N < 1300000)) return "";
    const e100 = Math.floor(E / 100000), n100 = Math.floor(N / 100000);
    const half = digits / 2;
    const f = v => String(Math.floor((v % 100000) / 10 ** (5 - half))).padStart(half, "0");
    return `${squareToLetters(e100, n100)} ${f(E)} ${f(N)}`;
  }

  return { parseGridRef, gridRefFromLatLon, enToLatLon, latLonToEn };
})();

const parseGridRef = OSG.parseGridRef;
const gridRefFromLatLon = OSG.gridRefFromLatLon;
