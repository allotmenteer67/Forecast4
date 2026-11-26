// ==== Travel page ====
//
// Simplified worldwide weather (agreed 26 Nov 2026, see DECISIONS.md):
//
// - Destinations are saved on this phone only, separate from UK places.
// - A plain blend of four forecasters chosen by region (fixed table
//   below), fetched in one multi-model request. No FFV corrections, no
//   two-week wait, no rain gauges, no Met Office Spot, no shared
//   corrections. Rain is the average of the four, everything else the
//   middle value, the same rule the UK page uses.
// - Date slider: today to +4 days. Hour slider: as on the UK page
//   (24 or 48 hours, from Settings), in the destination's own time.
// - The destination's local time sits on top, clock changes handled by
//   the phone's own time zone rules, beside a small continent map
//   (travel-map.js).
// - Cells: same look and fixed order as the UK front page, a little
//   slimmer, chosen by their own ticks in Settings (travel-fields.js).
//   Up to 8 show; more than that scrolls.
// - The last forecast fetched for each destination is kept on the phone,
//   so it still shows on landing with no signal ("Updated 5h ago").
//
// Everything is wrapped in one function so nothing here can clash with
// app.js's own names (this page loads app.js for the shared helpers:
// units, formatting, icons, themes, fetchOpenMeteo).

(function () {
  const DEST_KEY = "cloude-travel:destinations";
  const CURRENT_KEY = "cloude-travel:current";
  // Saved forecasts live under their own prefix, outside the backup
  // (BACKUP_KEY_PREFIXES has "cloude-travel:"), since they're only a
  // copy of downloaded data and would just bloat a backup.
  const CACHE_PREFIX = "cloude-travelcache:";
  const REFRESH_AFTER_MS = 20 * 60000;     // re-download if older than this
  const SHOW_AGE_AFTER_MS = 45 * 60000;    // say "Updated …" once older than this
  const DAYS = 5;                          // today + 4
  const MAX_VISIBLE_CELLS = 8;

  // Four forecasters by region. Fixed: no settings.
  const REGION_MODELS = {
    europe: ["ecmwf", "icon", "meteofrance", "metoffice"],
    northAmerica: ["ecmwf", "gfs", "gem", "icon"],
    eastAsia: ["ecmwf", "jma", "cma", "icon"],
    elsewhere: ["ecmwf", "gfs", "icon", "metoffice"]
  };
  function regionFor(lat, lon) {
    if (lat >= 27 && lat <= 72 && lon >= -32 && lon <= 45) return "europe";
    if (lat >= 7 && lat <= 85 && lon >= -170 && lon <= -50) return "northAmerica";
    if (lat >= -11 && lat <= 55 && lon >= 95 && lon <= 150) return "eastAsia";
    return "elsewhere";
  }
  function modelFor(id) {
    const src = REAL_SOURCES.find(s => s.id === id);
    return src ? src.model : null;
  }

  const $ = id => document.getElementById(id);
  const el = {
    chip: $("travelChip"), chipLabel: $("travelChipLabel"), menu: $("travelMenu"), menuList: $("travelMenuList"),
    menuManage: $("travelMenuManage"),
    timeCard: $("travelTimeCard"), map: $("travelMap"),
    clock: $("travelClock"), place: $("travelPlace"), dayLine: $("travelDayLine"),
    headline: $("travelHeadline"), dateText: $("travelDateText"), refresh: $("travelRefresh"), updated: $("travelUpdated"),
    statusBlock: $("travelStatusBlock"), status: $("travelStatus"), retry: $("travelRetry"),
    grid: $("travelGrid"), hourSlider: $("travelHourSlider"), hourLabel: $("travelHourLabel"),
    dateControls: $("travelDateControls"), dateSlider: $("travelDateSlider"), dateMid: $("travelDateMid"), dateEnd: $("travelDateEnd"),
    manage: $("travelManage"), manageHint: $("travelManageHint"), destList: $("travelDestList"),
    searchInput: $("travelSearchInput"), searchButton: $("travelSearchButton"), searchStatus: $("travelSearchStatus"),
    searchResults: $("travelSearchResults"), manageDone: $("travelManageDone")
  };

  const view = {
    dest: null,
    fc: null,      // blended forecast (see blendForecast)
    aq: null,      // air quality download (airquality.js)
    aqComputed: null,
    day: 0,        // date slider: 0 = today .. 4
    hour: 0,       // hour slider: hours from now
    loading: false,
    lastError: null
  };

  // ---- Storage ----

  function loadDestinations() {
    try {
      const list = JSON.parse(localStorage.getItem(DEST_KEY) || "[]");
      return Array.isArray(list) ? list.filter(d => d && typeof d.lat === "number" && typeof d.lon === "number") : [];
    } catch { return []; }
  }
  function saveDestinations(list) {
    try { localStorage.setItem(DEST_KEY, JSON.stringify(list)); } catch {}
  }
  function loadCurrentId() {
    try { return localStorage.getItem(CURRENT_KEY); } catch { return null; }
  }
  function saveCurrentId(id) {
    try { localStorage.setItem(CURRENT_KEY, id); } catch {}
  }
  function loadSaved(id) {
    try {
      const raw = localStorage.getItem(CACHE_PREFIX + id);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }
  function storeSaved(id, payload) {
    const text = JSON.stringify(payload);
    try {
      localStorage.setItem(CACHE_PREFIX + id, text);
    } catch {
      // Storage full: drop the other destinations' saved forecasts and
      // try once more, so the one being looked at is always kept.
      try {
        Object.keys(localStorage).filter(k => k.startsWith(CACHE_PREFIX) && k !== CACHE_PREFIX + id).forEach(k => localStorage.removeItem(k));
        localStorage.setItem(CACHE_PREFIX + id, text);
      } catch {}
    }
  }
  function dropSaved(id) {
    try { localStorage.removeItem(CACHE_PREFIX + id); } catch {}
  }

  // ---- Time zone helpers ----
  // All forecast times are unix seconds. Days and clock times are worked
  // out in the destination's own time zone by the phone (Intl), which
  // knows each country's clock-change rules.

  const fmtCache = {};
  function fmt(tz, opts) {
    const key = tz + JSON.stringify(opts);
    if (!fmtCache[key]) {
      try { fmtCache[key] = new Intl.DateTimeFormat("en-GB", { timeZone: tz, ...opts }); }
      catch { fmtCache[key] = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", ...opts }); }
    }
    return fmtCache[key];
  }
  function dayKey(sec, tz) {
    const parts = fmt(tz, { year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(sec * 1000));
    const get = t => parts.find(p => p.type === t).value;
    return `${get("year")}-${get("month")}-${get("day")}`;
  }
  function clockText(sec, tz) {
    return fmt(tz, { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(sec * 1000));
  }
  function shortDayText(sec, tz) {
    return fmt(tz, { weekday: "short", day: "numeric", month: "short" }).format(new Date(sec * 1000));
  }
  function longDayText(sec, tz) {
    return fmt(tz, { weekday: "long", day: "numeric", month: "long" }).format(new Date(sec * 1000));
  }
  // Minutes the destination's clock is ahead of UTC at this moment.
  function tzOffsetMinutes(tz, date) {
    const parts = fmt(tz, { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).formatToParts(date);
    const get = t => Number(parts.find(p => p.type === t).value);
    const hour = get("hour") % 24;
    const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), hour, get("minute"), get("second"));
    return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60000);
  }
  function aheadBehindText(tz) {
    const now = new Date();
    const diff = tzOffsetMinutes(tz, now) - (-now.getTimezoneOffset());
    if (diff === 0) return "Same time as you";
    const abs = Math.abs(diff);
    const h = Math.floor(abs / 60), m = abs % 60;
    const amount = m ? (h ? `${h}h ${m}m` : `${m}m`) : `${h}h`;
    return `${amount} ${diff > 0 ? "ahead of" : "behind"} you`;
  }

  // ---- Fetching ----

  const HOURLY_FIELDS = [
    "temperature_2m", "precipitation", "wind_speed_10m", "wind_direction_10m", "wind_gusts_10m",
    "pressure_msl", "soil_temperature_0cm", "dewpoint_2m", "apparent_temperature",
    "direct_normal_irradiance", "cloud_cover_low", "cloud_cover_mid", "cloud_cover_high"
  ];

  async function fetchForecast(dest) {
    const ids = REGION_MODELS[regionFor(dest.lat, dest.lon)];
    const models = ids.map(modelFor).filter(Boolean);
    const common = {
      latitude: String(dest.lat),
      longitude: String(dest.lon),
      timeformat: "unixtime",
      timezone: dest.tz || "auto",
      forecast_days: String(DAYS)
    };
    const multiParams = new URLSearchParams({ ...common, hourly: HOURLY_FIELDS.join(","), models: models.join(","), wind_speed_unit: "mph" });
    // UV, visibility and sunrise/sunset aren't sent per model for most of
    // these, so they come from Open-Meteo's own best match for the place.
    const extraParams = new URLSearchParams({ ...common, hourly: "uv_index,visibility", daily: "sunrise,sunset" });

    const [multiRes, extraRes] = await Promise.all([
      fetchOpenMeteo(`${WEATHER_URL}?${multiParams.toString()}`),
      fetchOpenMeteo(`${WEATHER_URL}?${extraParams.toString()}`).catch(() => null)
    ]);
    if (!multiRes.ok) throw new Error(`Weather lookup failed (${multiRes.status})${typeof openMeteoErrorSuffix === "function" ? openMeteoErrorSuffix() : ""}`);
    const multi = await multiRes.json();
    const extra = extraRes && extraRes.ok ? await extraRes.json() : null;
    return blendForecast(multi, extra, ids, models);
  }

  const round = (v, dp) => (v === null || v === undefined || Number.isNaN(v) ? null : Math.round(v * 10 ** dp) / 10 ** dp);
  function mid(values) {
    if (!values.length) return null;
    const s = [...values].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  // One blended series per field, plus the extras. Saved as-is for
  // offline use, so values are rounded to keep it small.
  function blendForecast(multi, extra, ids, models) {
    const times = multi.hourly.time;
    const series = field => models.map(m => multi.hourly[`${field}_${m}`] || []);
    const blend = (field, how, dp) => {
      const per = series(field);
      return times.map((_, i) => {
        const vals = per.map(s => s[i]).filter(v => v !== null && v !== undefined);
        if (!vals.length) return null;
        const v = how === "mean" ? vals.reduce((a, b) => a + b, 0) / vals.length : mid(vals);
        return round(v, dp);
      });
    };
    // Direction can't be averaged; first forecaster (ECMWF) that has one.
    const dirPer = series("wind_direction_10m");
    const dir = times.map((_, i) => {
      for (const s of dirPer) if (s[i] !== null && s[i] !== undefined) return s[i];
      return null;
    });
    // Sunshine: the share of forecasters with direct sun over the WMO
    // threshold that hour (0..1). Summed over a day it's the forecasters'
    // average sunny hours.
    const thr = typeof LIVE_SUNSHINE_DNI_THRESHOLD_WM2 === "number" ? LIVE_SUNSHINE_DNI_THRESHOLD_WM2 : 120;
    const dniPer = series("direct_normal_irradiance");
    const sunFrac = times.map((_, i) => {
      const vals = dniPer.map(s => s[i]).filter(v => v !== null && v !== undefined);
      return vals.length ? round(vals.filter(v => v > thr).length / vals.length, 2) : null;
    });

    const fc = {
      times,
      ids,
      rain: blend("precipitation", "mean", 2),
      temperature: blend("temperature_2m", "mid", 1),
      wind: blend("wind_speed_10m", "mid", 1),
      gust: blend("wind_gusts_10m", "mid", 1),
      dir,
      pressure: blend("pressure_msl", "mid", 1),
      soilTemperature: blend("soil_temperature_0cm", "mid", 1),
      dewPoint: blend("dewpoint_2m", "mid", 1),
      feelsLike: blend("apparent_temperature", "mid", 1),
      sunFrac,
      cloudLow: blend("cloud_cover_low", "mid", 0),
      cloudMid: blend("cloud_cover_mid", "mid", 0),
      cloudHigh: blend("cloud_cover_high", "mid", 0),
      uv: times.map(() => null),
      visibility: times.map(() => null),
      sunrise: [],
      sunset: []
    };
    if (extra && extra.hourly) {
      const at = new Map((extra.hourly.time || []).map((t, i) => [t, i]));
      fc.uv = times.map(t => round(extra.hourly.uv_index?.[at.get(t)], 1));
      fc.visibility = times.map(t => round(extra.hourly.visibility?.[at.get(t)], -1));
    }
    if (extra && extra.daily) {
      fc.sunrise = extra.daily.sunrise || [];
      fc.sunset = extra.daily.sunset || [];
    }
    return fc;
  }

  // Air quality rounded down a little for saving.
  function compactAq(aq) {
    const hourly = {};
    Object.entries(aq.hourly).forEach(([k, arr]) => { hourly[k] = arr.map(v => round(v, 1)); });
    return { times: aq.times, hourly, fetchedAt: aq.fetchedAt };
  }

  let loadGen = 0;
  async function refresh(force) {
    const dest = view.dest;
    if (!dest) return;
    const saved = loadSaved(dest.id);
    if (!force && saved && Date.now() - saved.fetchedAt < REFRESH_AFTER_MS) return;
    const gen = ++loadGen;
    view.loading = true;
    view.lastError = null;
    renderStatus();
    let fc = null, aq = null, error = null;
    try {
      const results = await Promise.allSettled([
        fetchForecast(dest),
        aqFetch(dest.lat, dest.lon, dest.tz || "UTC")
      ]);
      if (results[0].status === "fulfilled") fc = results[0].value; else error = results[0].reason;
      if (results[1].status === "fulfilled") aq = compactAq(results[1].value);
    } catch (e) {
      error = e;
    }
    if (gen !== loadGen || view.dest !== dest) return;
    view.loading = false;
    if (fc) {
      const payload = { fetchedAt: Date.now(), fc, aq: aq || (saved && saved.aq) || null };
      storeSaved(dest.id, payload);
      applySaved(payload);
    } else {
      view.lastError = (error && error.message) || "Couldn't load the weather";
    }
    render();
  }

  function applySaved(payload) {
    view.fc = payload ? payload.fc : null;
    view.fetchedAt = payload ? payload.fetchedAt : null;
    view.aq = payload ? payload.aq : null;
    view.aqComputed = view.aq ? aqComputeHourly(view.aq, aqSchemeFor(view.dest.cc)) : null;
  }

  // ---- Working out what to show ----

  function nowIndex() {
    const fc = view.fc;
    if (!fc) return -1;
    const now = Date.now() / 1000;
    // The hour now is in (times are the start of each hour).
    let idx = -1;
    for (let i = 0; i < fc.times.length; i++) { if (fc.times[i] <= now) idx = i; else break; }
    if (idx < 0 && fc.times.length && fc.times[0] > now) idx = 0;
    return idx;
  }

  function dayKeys() {
    const fc = view.fc;
    const keys = [];
    fc.times.forEach(t => { const k = dayKey(t, view.dest.tz); if (!keys.includes(k)) keys.push(k); });
    return keys;
  }

  // Index range on screen: hourly → one hour; Today → now onward for the
  // Settings 24/48h window; another day → that whole local day.
  function currentIndices() {
    const fc = view.fc;
    const n0 = nowIndex();
    if (n0 < 0) return { indices: [], mode: "none" };
    if (view.hour > 0) {
      const i = n0 + view.hour;
      return { indices: i < fc.times.length ? [i] : [], mode: "hour" };
    }
    if (view.day === 0) {
      const count = loadHourRange();
      const indices = [];
      for (let i = n0; i < Math.min(fc.times.length, n0 + count); i++) indices.push(i);
      return { indices, mode: "today" };
    }
    const todayKey = dayKey(fc.times[n0], view.dest.tz);
    const keys = dayKeys();
    const k = keys[keys.indexOf(todayKey) + view.day];
    const indices = [];
    if (k) fc.times.forEach((t, i) => { if (dayKey(t, view.dest.tz) === k) indices.push(i); });
    return { indices, mode: "day", key: k };
  }

  function isDaylight(i) {
    const fc = view.fc;
    const t = fc.times[i];
    const k = dayKey(t, view.dest.tz);
    for (let d = 0; d < fc.sunrise.length; d++) {
      if (dayKey(fc.sunrise[d], view.dest.tz) !== k) continue;
      // The hour starting at t counts as daylight if any of it is.
      return t + 3600 > fc.sunrise[d] && t < fc.sunset[d];
    }
    return null;
  }

  // Sunshine (radiation) values cover the hour ENDING at their time, as
  // on the UK page (hourIsDaylight in app.js), so daylight is judged on
  // that hour instead.
  function endingHourDaylight(i) {
    const fc = view.fc;
    const end = fc.times[i];
    const k = dayKey(end - 1, view.dest.tz);
    for (let d = 0; d < fc.sunrise.length; d++) {
      if (dayKey(fc.sunrise[d], view.dest.tz) !== k) continue;
      return end > fc.sunrise[d] && end - 3600 < fc.sunset[d];
    }
    return null;
  }

  const vals = (arr, indices) => indices.map(i => arr[i]).filter(v => v !== null && v !== undefined);
  const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

  function sunHours(indices) {
    const fc = view.fc;
    let seen = false, total = 0, daylight = 0;
    indices.forEach(i => {
      if (endingHourDaylight(i) !== false) daylight++;
      const f = fc.sunFrac[i];
      if (f === null || f === undefined) return;
      seen = true;
      total += f;
    });
    return seen ? Math.min(total, daylight) : null;
  }

  // ---- Rendering ----

  function cellShell(field, labelText) {
    const cell = document.createElement("button");
    cell.type = "button";
    cell.className = "headline-cell";
    const icon = document.createElement("span");
    icon.className = "headline-cell-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.innerHTML = (HEADLINE_CELL_ICONS && HEADLINE_CELL_ICONS[field]) || (typeof AQ_ICONS !== "undefined" && AQ_ICONS[field]) || "";
    const label = document.createElement("span");
    label.className = "headline-label";
    if (typeof labelText === "string") label.textContent = labelText; else label.append(...labelText);
    const valueRow = document.createElement("div");
    valueRow.className = "headline-value-row";
    const valueEl = document.createElement("span");
    valueEl.className = "headline-value";
    valueRow.appendChild(valueEl);
    const textWrap = document.createElement("div");
    textWrap.className = "headline-cell-text";
    textWrap.append(label, valueRow);
    cell.append(icon, textWrap);
    return { cell, valueEl, valueRow };
  }

  function standardLabel(field) {
    const name = (HEADLINE_LABEL_NAME && HEADLINE_LABEL_NAME[field]) || CONFIG.conditions[field]?.name || field;
    if (field === "pressure") {
      const unit = document.createElement("span");
      unit.className = "headline-label-unit-cased";
      unit.textContent = unitLabel("pressure");
      return [`${name} `, unit];
    }
    return `${name} ${unitLabel(field)}`;
  }

  function addWindArrow(valueRow, direction) {
    const rotation = windArrowRotation(direction);
    if (rotation === null) return;
    const arrow = document.createElement("span");
    arrow.className = "wind-arrow";
    arrow.innerHTML = '<svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true"><path d="M12 2.5 L18 20 L12 16 L6 20 Z" fill="currentColor"/></svg>';
    arrow.style.transform = `rotate(${rotation}deg)`;
    valueRow.appendChild(arrow);
  }

  function addPressureArrow(valueRow, delta, hours) {
    if (delta === null || Math.abs(delta) <= 0.05 || typeof pressureTrendArrowSvg !== "function") return;
    const arrow = document.createElement("span");
    arrow.className = "pressure-arrow";
    arrow.innerHTML = pressureTrendArrowSvg({ delta, hours });
    valueRow.appendChild(arrow);
  }

  function smallWord(valueRow, text) {
    const w = document.createElement("span");
    w.textContent = text;
    w.style.cssText = "font-size:0.8em;font-weight:600;opacity:0.75;white-space:nowrap;";
    valueRow.appendChild(w);
  }

  function buildCell(field, sel) {
    const fc = view.fc;
    const { indices, mode } = sel;
    const hourly = mode === "hour";
    const i0 = indices[0];
    const nowLike = hourly || mode === "today"; // point readings use the first hour shown

    if (field === "airQuality") {
      const scheme = aqSchemeFor(view.dest.cc);
      if (!view.aq || !indices.length) return aqBuildCell(scheme, null);
      const from = fc.times[indices[0]];
      const to = fc.times[indices[indices.length - 1]] + 3600;
      return aqBuildCell(scheme, aqWorstBetween(view.aqComputed, view.aq.times, from, to));
    }
    if (field === "pollen") {
      // Europe in season only: no cell at all otherwise.
      if (regionFor(view.dest.lat, view.dest.lon) !== "europe") return null;
      if (!view.aq || !aqHasPollen(view.aq) || !indices.length) return null;
      const from = fc.times[indices[0]];
      const to = fc.times[indices[indices.length - 1]] + 3600;
      return aqBuildPollenCell(aqPollenBetween(view.aq, from, to));
    }

    let labelText;
    if (field === "cloud") labelText = "Cloud";
    else if (field === "uv") labelText = "UV";
    else if (field === "visibility") labelText = sunVisUsesMiles() ? "Vis mi" : "Vis km";
    else if (field === "sunshine") labelText = hourly ? "Sun" : `${HEADLINE_LABEL_NAME.sunshine} ${unitLabel("sunshine")}`;
    else labelText = standardLabel(field);
    const { cell, valueEl, valueRow } = cellShell(field, labelText);
    if (!indices.length) { valueEl.textContent = "–"; return cell; }

    switch (field) {
      case "rain": {
        const v = vals(fc.rain, indices);
        valueEl.textContent = v.length ? formatValue(v.reduce((a, b) => a + b, 0), "rain") : "–";
        break;
      }
      case "temperature": {
        const v = vals(fc.temperature, indices);
        if (!v.length) valueEl.textContent = "–";
        else if (hourly) valueEl.textContent = formatValue(v[0], "temperature");
        else valueEl.textContent = `${formatValue(Math.max(...v), "temperature")} / ${formatValue(Math.min(...v), "temperature")}`;
        break;
      }
      case "wind": {
        // Peak hour: its speed, gust and direction together.
        let peak = null;
        indices.forEach(i => { const s = fc.wind[i]; if (s !== null && s !== undefined && (peak === null || s > fc.wind[peak])) peak = i; });
        if (peak === null) { valueEl.textContent = "–"; break; }
        const speed = fc.wind[peak], gust = fc.gust[peak];
        const margin = typeof GUST_NOTABLE_MARGIN_MPH === "number" ? GUST_NOTABLE_MARGIN_MPH : 5;
        valueEl.textContent = gust !== null && gust !== undefined && gust > speed + margin
          ? `${formatValue(speed, "wind")}/${formatValue(gust, "wind")}`
          : formatValue(speed, "wind");
        addWindArrow(valueRow, fc.dir[peak]);
        break;
      }
      case "pressure": {
        if (nowLike) {
          const v = fc.pressure[i0];
          valueEl.textContent = formatValue(v, "pressure");
          const later = fc.pressure[i0 + 3];
          if (!hourly && v !== null && later !== null && later !== undefined) addPressureArrow(valueRow, later - v, 3);
        } else {
          const m = mean(vals(fc.pressure, indices));
          valueEl.textContent = formatValue(m, "pressure");
          const prev = mean(vals(fc.pressure, indices.map(i => i - 24).filter(i => i >= 0)));
          if (m !== null && prev !== null) addPressureArrow(valueRow, m - prev, 24);
        }
        break;
      }
      case "soilTemperature":
      case "dewPoint":
      case "feelsLike": {
        const v = nowLike ? fc[field][i0] : mean(vals(fc[field], indices));
        valueEl.textContent = formatValue(v, field);
        break;
      }
      case "sunshine": {
        if (hourly) {
          if (endingHourDaylight(i0) === false) { valueEl.textContent = "–"; break; }
          const f = fc.sunFrac[i0];
          if (f === null || f === undefined) { valueEl.textContent = "–"; break; }
          valueEl.textContent = f >= 0.75 ? "Sunny" : f >= 0.25 ? "Some" : "None";
          valueEl.style.fontSize = "17px";
          break;
        }
        if (mode === "today" && loadHourRange() === 48) {
          // Same "today/tomorrow" pair as the UK page's 48-hour setting.
          const tz = view.dest.tz;
          const k0 = dayKey(fc.times[indices[0]], tz);
          const keys = [...new Set(indices.map(i => dayKey(fc.times[i], tz)))];
          const a = indices.filter(i => dayKey(fc.times[i], tz) === k0);
          const b = keys[1] ? indices.filter(i => dayKey(fc.times[i], tz) === keys[1]) : [];
          const ha = sunHours(a), hb = b.length ? sunHours(b) : null;
          valueEl.textContent = ha !== null && hb !== null ? `${formatValue(ha, "sunshine")}/${formatValue(hb, "sunshine")}` : formatValue(ha, "sunshine");
          break;
        }
        valueEl.textContent = formatValue(sunHours(indices), "sunshine");
        break;
      }
      case "cloud": {
        let use = indices;
        if (!hourly) {
          const day = indices.filter(i => isDaylight(i) === true);
          if (day.length) use = day;
        }
        const low = mean(vals(fc.cloudLow, use)), m = mean(vals(fc.cloudMid, use)), high = mean(vals(fc.cloudHigh, use));
        if (low === null) { valueEl.textContent = "–"; break; }
        const night = hourly && isDaylight(i0) === false;
        valueEl.appendChild(sheetCloudIcon(low, m ?? 0, high ?? 0, night));
        valueEl.classList.add("headline-cloud-icon");
        break;
      }
      case "uv": {
        const v = vals(fc.uv, indices);
        if (!v.length) { valueEl.textContent = "–"; break; }
        const top = Math.max(...v);
        valueEl.textContent = String(Math.round(top));
        smallWord(valueRow, top < 3 ? "Low" : top < 6 ? "Moderate" : top < 8 ? "High" : top < 11 ? "Very high" : "Extreme");
        break;
      }
      case "visibility": {
        // Today/hour: that hour. Another day: the lowest in daylight, so
        // a foggy morning isn't hidden by a clear afternoon.
        let metres;
        if (nowLike) metres = fc.visibility[i0];
        else {
          const day = indices.filter(i => isDaylight(i) !== false);
          const v = vals(fc.visibility, day.length ? day : indices);
          metres = v.length ? Math.min(...v) : null;
        }
        if (metres === null || metres === undefined) { valueEl.textContent = "–"; break; }
        valueEl.textContent = sunVisDistanceNumber(Math.max(0, metres));
        smallWord(valueRow, sunVisWord(metres));
        break;
      }
      default:
        valueEl.textContent = "–";
    }
    return cell;
  }

  function renderGrid() {
    const grid = el.grid;
    grid.innerHTML = "";
    grid.style.maxHeight = "";
    if (!view.fc) return;
    const sel = currentIndices();
    if (!sel.indices.length) {
      const p = document.createElement("p");
      p.className = "headline-loading";
      p.textContent = "The saved forecast has run out. It will update once there's signal.";
      grid.appendChild(p);
      return;
    }
    activeTravelFields().forEach(field => {
      try {
        const cell = buildCell(field, sel);
        if (cell) grid.appendChild(cell);
      } catch (err) {
        console.error(`Travel cell "${field}" failed:`, err);
      }
    });
    // More than 8 boxes: show 8 and let the rest scroll.
    const cells = grid.querySelectorAll(".headline-cell");
    if (cells.length > MAX_VISIBLE_CELLS) {
      const last = cells[MAX_VISIBLE_CELLS - 1];
      const height = last.offsetTop + last.offsetHeight - grid.offsetTop;
      if (height > 0) grid.style.maxHeight = `${height + 2}px`;
      grid.classList.add("travel-grid-scrolls");
    } else {
      grid.classList.remove("travel-grid-scrolls");
    }
  }

  function renderDateText() {
    const fc = view.fc;
    if (!fc || !view.dest) { el.dateText.textContent = ""; return; }
    const n0 = nowIndex();
    if (view.day === 0) {
      el.dateText.textContent = loadHourRange() === 48 ? "Today and Tomorrow" : "Today";
    } else {
      const t = (n0 >= 0 ? fc.times[n0] : Date.now() / 1000) + view.day * 86400;
      el.dateText.textContent = longDayText(t, view.dest.tz);
    }
  }

  function renderStatus() {
    const age = view.fetchedAt ? Date.now() - view.fetchedAt : null;
    let updated = "";
    if (view.loading && !view.fc) updated = "";
    else if (age !== null && age > SHOW_AGE_AFTER_MS) updated = `Updated ${ageText(age)} ago`;
    if (view.lastError && view.fc) updated = `Saved forecast, ${ageText(age)} old`;
    el.updated.textContent = updated;

    const showBlock = !view.fc && (view.loading || view.lastError);
    el.statusBlock.hidden = !showBlock;
    if (showBlock) {
      el.status.textContent = view.loading ? "Loading weather…" : `${view.lastError}. No saved forecast for this place yet.`;
      el.retry.hidden = view.loading;
    }
    el.refresh.classList.toggle("is-spinning", !!view.loading);
  }

  function ageText(ms) {
    const mins = Math.max(1, Math.round(ms / 60000));
    if (mins < 60) return `${mins} min`;
    const hours = Math.round(mins / 60);
    if (hours < 48) return `${hours}h`;
    return `${Math.round(hours / 24)} days`;
  }

  function renderHourLabel() {
    const range = loadHourRange();
    el.hourSlider.max = String(range);
    if (view.hour === 0 || !view.fc) {
      el.hourLabel.textContent = `+${range}h`;
      return;
    }
    const n0 = nowIndex();
    const t = view.fc.times[n0 + view.hour];
    if (!t) { el.hourLabel.textContent = `+${view.hour}h`; return; }
    const tz = view.dest.tz;
    const sameDay = dayKey(t, tz) === dayKey(Date.now() / 1000, tz);
    el.hourLabel.textContent = sameDay ? clockText(t, tz) : `${clockText(t, tz)}, ${shortDayText(t, tz)}`;
  }

  function renderDateRange() {
    if (!view.dest) return;
    const now = Date.now() / 1000;
    el.dateMid.textContent = shortDayText(now + 2 * 86400, view.dest.tz);
    el.dateEnd.textContent = shortDayText(now + 4 * 86400, view.dest.tz);
  }

  function renderClock() {
    const d = view.dest;
    if (!d) return;
    const now = Date.now() / 1000;
    el.clock.textContent = clockText(now, d.tz);
    el.dayLine.textContent = `${shortDayText(now, d.tz)} · ${aheadBehindText(d.tz)}`;
  }

  // "Paris, France" but "Paris, Texas": the state or province for big
  // countries where the country name alone doesn't place it.
  const BY_REGION = new Set(["US", "CA", "AU", "BR", "IN", "CN", "MX", "RU"]);
  function placeLabel(d) {
    const second = BY_REGION.has(d.cc) && d.admin1 && d.admin1 !== d.name ? d.admin1 : d.country;
    return [d.name, second].filter(Boolean).join(", ");
  }
  function menuLabel(d, list) {
    return list.filter(x => x.name === d.name).length > 1 ? placeLabel(d) : d.name;
  }

  let mapDrawnFor = null;
  function renderTimeCard() {
    const d = view.dest;
    el.timeCard.hidden = !d;
    if (!d) return;
    el.place.textContent = placeLabel(d);
    renderClock();
    const key = `${d.id}|${el.timeCard.clientWidth}|${document.documentElement.dataset.theme || ""}`;
    if (mapDrawnFor !== key) {
      mapDrawnFor = key;
      drawTravelMap(el.map, d.lat, d.lon);
    }
  }

  function render() {
    const has = !!view.dest;
    el.headline.hidden = !has;
    el.dateControls.hidden = !has;
    el.chipLabel.textContent = has ? view.dest.name : "Abroad";
    renderTimeCard();
    if (!has) return;
    renderStatus();
    renderDateText();
    renderHourLabel();
    renderDateRange();
    updateSliderFill(el.hourSlider);
    updateSliderFill(el.dateSlider);
    renderGrid();
  }

  // ---- Destinations ----

  function setDestination(dest) {
    view.dest = dest;
    view.day = 0;
    view.hour = 0;
    view.lastError = null;
    view.loading = false;
    el.dateSlider.value = "0";
    el.hourSlider.value = "0";
    if (dest) {
      saveCurrentId(dest.id);
      applySaved(loadSaved(dest.id));
    } else {
      applySaved(null);
    }
    render();
    if (dest) refresh(false);
  }

  function renderMenu() {
    el.menuList.innerHTML = "";
    const list = loadDestinations();
    if (!list.length) {
      const hint = document.createElement("p");
      hint.className = "place-menu-empty";
      hint.textContent = "No destinations yet.";
      el.menuList.appendChild(hint);
    }
    list.forEach(d => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "place-menu-item" + (view.dest && d.id === view.dest.id ? " is-current" : "");
      item.textContent = menuLabel(d, list);
      item.addEventListener("click", () => { closeMenu(); setDestination(d); });
      el.menuList.appendChild(item);
    });
  }
  function closeMenu() {
    el.menu.hidden = true;
    el.chip.setAttribute("aria-expanded", "false");
  }

  function openManage() {
    closeMenu();
    el.manage.hidden = false;
    renderDestList();
    el.manageHint.textContent = loadDestinations().length
      ? "Saved on this phone only, separate from your UK places."
      : "Add your first destination: a town or city anywhere. Saved on this phone only, separate from your UK places.";
    el.manage.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function renderDestList() {
    el.destList.innerHTML = "";
    loadDestinations().forEach(d => {
      const row = document.createElement("div");
      row.className = "place-row";
      const name = document.createElement("span");
      name.className = "place-row-label";
      name.textContent = [d.name, d.admin1, d.country].filter(Boolean).join(", ");
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "place-row-remove";
      remove.textContent = "\u2715";
      remove.setAttribute("aria-label", `Remove ${d.name}`);
      remove.addEventListener("click", () => {
        const left = loadDestinations().filter(x => x.id !== d.id);
        saveDestinations(left);
        dropSaved(d.id);
        renderDestList();
        if (view.dest && view.dest.id === d.id) setDestination(left[0] || null);
      });
      row.append(name, remove);
      el.destList.appendChild(row);
    });
  }

  async function search() {
    const q = el.searchInput.value.trim();
    el.searchResults.innerHTML = "";
    if (!q) { el.searchStatus.textContent = "Type a town or city first."; return; }
    el.searchStatus.textContent = "Searching…";
    try {
      const res = await fetchWithTimeout(`${PLACE_GEOCODE_URL}?name=${encodeURIComponent(q)}&count=10&language=en&format=json`);
      if (!res.ok) throw new Error("Search failed");
      const data = await res.json();
      const results = (data.results || []).filter(r => typeof r.latitude === "number" && typeof r.longitude === "number");
      if (!results.length) { el.searchStatus.textContent = `Nothing found for "${q}".`; return; }
      el.searchStatus.textContent = results.length > 1 ? "Pick the right one:" : "";
      results.forEach(r => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "travel-search-result";
        const main = document.createElement("span");
        main.textContent = r.name;
        const sub = document.createElement("span");
        sub.className = "travel-search-sub";
        sub.textContent = [r.admin2 && r.admin2 !== r.name ? r.admin2 : null, r.admin1, r.country].filter(Boolean).join(", ");
        b.append(main, sub);
        b.addEventListener("click", () => addDestination(r));
        el.searchResults.appendChild(b);
      });
    } catch {
      el.searchStatus.textContent = "Couldn't search just now. Check the signal and try again.";
    }
  }

  function addDestination(r) {
    const dest = {
      id: `${r.latitude.toFixed(2)},${r.longitude.toFixed(2)}`,
      name: r.name,
      admin1: r.admin1 || "",
      country: r.country || "",
      cc: r.country_code || "",
      lat: Math.round(r.latitude * 10000) / 10000,
      lon: Math.round(r.longitude * 10000) / 10000,
      tz: r.timezone || "UTC"
    };
    const list = loadDestinations();
    if (!list.some(d => d.id === dest.id)) list.push(dest);
    saveDestinations(list);
    el.searchInput.value = "";
    el.searchResults.innerHTML = "";
    el.searchStatus.textContent = `${dest.name} added.`;
    renderDestList();
    el.manage.hidden = true;
    setDestination(list.find(d => d.id === dest.id));
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function switchAdjacent(direction) {
    const list = loadDestinations();
    if (list.length < 2 || !view.dest) return;
    const i = list.findIndex(d => d.id === view.dest.id);
    setDestination(list[(i + direction + list.length) % list.length]);
  }

  // ---- Wiring ----

  el.chip.addEventListener("click", () => {
    if (el.menu.hidden) {
      renderMenu();
      el.menu.hidden = false;
      el.chip.setAttribute("aria-expanded", "true");
    } else closeMenu();
  });
  document.addEventListener("click", e => {
    if (!el.menu.hidden && !el.menu.contains(e.target) && !el.chip.contains(e.target)) closeMenu();
  });
  el.menuManage.addEventListener("click", openManage);
  el.manageDone.addEventListener("click", () => { el.manage.hidden = true; window.scrollTo({ top: 0, behavior: "smooth" }); });
  el.searchButton.addEventListener("click", search);
  el.searchInput.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); search(); } });
  el.refresh.addEventListener("click", () => refresh(true));
  el.retry.addEventListener("click", () => refresh(true));

  el.hourSlider.addEventListener("input", () => {
    const h = Math.round(Number(el.hourSlider.value) || 0);
    if (h === view.hour) { updateSliderFill(el.hourSlider); return; }
    view.hour = h;
    updateSliderFill(el.hourSlider);
    renderHourLabel();
    renderGrid();
  });
  el.dateSlider.addEventListener("input", () => {
    view.day = Number(el.dateSlider.value) || 0;
    // Touching the Date slider puts the Hour slider back to Now, as on
    // the UK page.
    view.hour = 0;
    el.hourSlider.value = "0";
    updateSliderFill(el.hourSlider);
    updateSliderFill(el.dateSlider);
    renderHourLabel();
    renderDateText();
    renderGrid();
  });

  // Swipe across the weather card to move between destinations, like the
  // UK page's saved places. Not on the sliders.
  (function () {
    let sx = null, sy = null, pid = null, swiped = false;
    el.headline.addEventListener("pointerdown", e => {
      if (pid !== null || e.target.closest("input, #travelRefresh")) return;
      pid = e.pointerId; sx = e.clientX; sy = e.clientY;
    });
    el.headline.addEventListener("pointermove", e => {
      if (sx === null || e.pointerId !== pid) return;
      const dx = e.clientX - sx, dy = e.clientY - sy;
      if (Math.abs(dx) > 32 && Math.abs(dx) > Math.abs(dy) * 1.5) {
        swiped = true;
        sx = sy = pid = null;
        switchAdjacent(dx < 0 ? 1 : -1);
      }
    });
    const end = e => { if (e.pointerId === pid) sx = sy = pid = null; };
    el.headline.addEventListener("pointerup", end);
    el.headline.addEventListener("pointercancel", end);
    el.headline.addEventListener("click", e => { if (swiped) { swiped = false; e.stopPropagation(); } }, true);
  })();

  // Back on screen: hour slider to Now (as on the UK page), fresh
  // weather if the saved copy is old, and the clock up to date.
  function resume() {
    if (view.hour !== 0) {
      view.hour = 0;
      el.hourSlider.value = "0";
    }
    render();
    refresh(false);
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden) resume(); });
  window.addEventListener("pageshow", e => { if (e.persisted) resume(); });
  window.addEventListener("online", () => refresh(false));
  window.addEventListener("resize", () => { if (view.dest) renderTimeCard(); });

  setInterval(() => { if (!document.hidden) renderClock(); }, 15000);
  setInterval(() => {
    if (document.hidden || !view.dest) return;
    renderStatus();
    refresh(false);
  }, 5 * 60000);

  // ---- Start ----
  const list = loadDestinations();
  const currentId = loadCurrentId();
  const start = list.find(d => d.id === currentId) || list[0] || null;
  if (start) setDestination(start);
  else {
    render();
    openManage();
  }
})();
