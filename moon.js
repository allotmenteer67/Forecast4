// The moon for the Callout screen's Light box: how much of it is lit,
// waxing or waning, whether it's up, and when it next rises or sets.
// Worked out on the phone (no download), using the standard low-
// precision formulae (good to a few minutes for rise and set, which is
// plenty for "will there be moonlight?").

const MOON = (() => {
  const rad = Math.PI / 180;
  const dayMs = 86400000, J1970 = 2440588, J2000 = 2451545;
  const e = rad * 23.4397; // obliquity of the Earth

  const toDays = date => date.valueOf() / dayMs - 0.5 + J1970 - J2000;
  const rightAscension = (l, b) => Math.atan2(Math.sin(l) * Math.cos(e) - Math.tan(b) * Math.sin(e), Math.cos(l));
  const declination = (l, b) => Math.asin(Math.sin(b) * Math.cos(e) + Math.cos(b) * Math.sin(e) * Math.sin(l));
  const siderealTime = (d, lw) => rad * (280.16 + 360.9856235 * d) - lw;

  function sunCoords(d) {
    const M = rad * (357.5291 + 0.98560028 * d);
    const C = rad * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
    const L = M + C + rad * 102.9372 + Math.PI;
    return { dec: declination(L, 0), ra: rightAscension(L, 0) };
  }

  function moonCoords(d) {
    const L = rad * (218.316 + 13.176396 * d);
    const M = rad * (134.963 + 13.064993 * d);
    const F = rad * (93.272 + 13.229350 * d);
    const l = L + rad * 6.289 * Math.sin(M);
    const b = rad * 5.128 * Math.sin(F);
    return { ra: rightAscension(l, b), dec: declination(l, b), dist: 385001 - 20905 * Math.cos(M) };
  }

  // Altitude in radians, with a refraction allowance.
  function altitude(date, lat, lon) {
    const d = toDays(date);
    const c = moonCoords(d);
    const phi = rad * lat;
    const H = siderealTime(d, rad * -lon) - c.ra;
    let h = Math.asin(Math.sin(phi) * Math.sin(c.dec) + Math.cos(phi) * Math.cos(c.dec) * Math.cos(H));
    const hh = Math.max(h, 0);
    h += 0.0002967 / Math.tan(hh + 0.00312536 / (hh + 0.08901179));
    return h;
  }

  // fraction lit 0..1; phase 0 new, 0.25 first quarter, 0.5 full, 0.75 last quarter.
  function illumination(date) {
    const d = toDays(date);
    const s = sunCoords(d), m = moonCoords(d), sdist = 149598000;
    const phi = Math.acos(Math.sin(s.dec) * Math.sin(m.dec) + Math.cos(s.dec) * Math.cos(m.dec) * Math.cos(s.ra - m.ra));
    const inc = Math.atan2(sdist * Math.sin(phi), m.dist - sdist * Math.cos(phi));
    const angle = Math.atan2(Math.cos(s.dec) * Math.sin(s.ra - m.ra),
      Math.sin(s.dec) * Math.cos(m.dec) - Math.cos(s.dec) * Math.sin(m.dec) * Math.cos(s.ra - m.ra));
    return { fraction: (1 + Math.cos(inc)) / 2, phase: 0.5 + 0.5 * inc * (angle < 0 ? -1 : 1) / Math.PI };
  }

  // First moonrise and moonset after `from`, looking `hours` ahead.
  // Steps two hours at a time and fits a curve through each three
  // altitudes, as the usual method does.
  function nextEvents(from, lat, lon, hours = 36) {
    const hc = 0.133 * rad; // the moon's apparent size and parallax
    const at = h => altitude(new Date(from.valueOf() + h * 3600000), lat, lon) - hc;
    let rise = null, set = null;
    let h0 = at(0);
    for (let i = 1; i <= hours && (rise === null || set === null); i += 2) {
      const h1 = at(i), h2 = at(i + 1);
      const a = (h0 + h2) / 2 - h1, b = (h2 - h0) / 2;
      const xe = -b / (2 * a), ye = (a * xe + b) * xe + h1;
      const disc = b * b - 4 * a * h1;
      let roots = 0, x1 = 0, x2 = 0;
      if (disc >= 0) {
        const dx = Math.sqrt(disc) / (Math.abs(a) * 2);
        x1 = xe - dx; x2 = xe + dx;
        if (Math.abs(x1) <= 1) roots++;
        if (Math.abs(x2) <= 1) roots++;
        if (x1 < -1) x1 = x2;
      }
      const toDate = x => new Date(from.valueOf() + (i + x) * 3600000);
      if (roots === 1) {
        if (h0 < 0 && rise === null) rise = toDate(x1);
        else if (h0 >= 0 && set === null) set = toDate(x1);
      } else if (roots === 2) {
        const r = ye < 0 ? x2 : x1, s = ye < 0 ? x1 : x2;
        if (rise === null) rise = toDate(r);
        if (set === null) set = toDate(s);
      }
      h0 = h2;
    }
    return { up: at(0) > 0, rise, set };
  }

  function phaseName(phase, fraction) {
    if (fraction < 0.03) return "New moon";
    if (fraction > 0.97) return "Full moon";
    const waxing = phase < 0.5;
    if (Math.abs(fraction - 0.5) < 0.04) return waxing ? "First quarter" : "Last quarter";
    return (waxing ? "Waxing " : "Waning ") + (fraction < 0.5 ? "crescent" : "gibbous");
  }

  return { altitude, illumination, nextEvents, phaseName };
})();
