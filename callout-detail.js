// Callout screen: tap the Wind, Sea, Tide or Visibility box to see the
// next 12 hours for the callout spot, as a graph and an hour-by-hour
// list. Uses the data the Callout screen already has (its own forecast
// and sea downloads, and its own tide), so it's for the callout spot,
// not the front page's place, and works on whatever was last downloaded.
// Loaded after callout.js and uses its helpers.

const DETAIL_HOURS = 12;

const detail = { kind: null };

function detailEl(id) { return document.getElementById(id); }

// The hours from now on: now + DETAIL_HOURS.
function detailHourRange(h) {
  const idx = h ? hourIndexForNow(h.time) : -1;
  if (idx < 0) return null;
  const end = Math.min(h.time.length - 1, idx + DETAIL_HOURS);
  const out = [];
  for (let i = idx; i <= end; i++) out.push(i);
  return out;
}

function detailHourLabel(sec) {
  const d = new Date(sec * 1000);
  return clockTime(d);
}

// ---- Graph (SVG) ----
// series: [{ points: [[tSec, value]...], color, width, dash }]
// opts: { yMin, yMax, unit, bands: [{ from, to, color }], marks: [{ t, v, text }] }
function detailChart(series, opts) {
  const W = Math.max(300, Math.min(560, (detailEl("detailBody").clientWidth || 340)));
  // Bigger than usual text, for reading in rain on a moving boat.
  const H = 230, L = 44, R = 10, T = 22, B = 32;
  const all = series.flatMap(s => s.points);
  if (!all.length) return "";
  const t0 = Math.min(...all.map(p => p[0])), t1 = Math.max(...all.map(p => p[0]));
  let yMin = opts.yMin !== undefined ? opts.yMin : Math.min(...all.map(p => p[1]));
  let yMax = Math.max(...all.map(p => p[1]));
  if (opts.yMax !== undefined) yMax = Math.max(yMax, opts.yMax);
  if (opts.yCap !== undefined) yMax = Math.min(yMax, opts.yCap);
  if (yMax - yMin < 1e-6) yMax = yMin + 1;
  const pad = (yMax - yMin) * 0.08;
  if (opts.yMin === undefined) yMin -= pad;
  yMax += pad;
  const x = t => L + (t - t0) / Math.max(1, t1 - t0) * (W - L - R);
  const y = v => T + (1 - (Math.min(v, yMax) - yMin) / (yMax - yMin)) * (H - T - B);
  let svg = `<svg class="detail-chart" viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img">`;
  (opts.bands || []).forEach(b => {
    const top = y(Math.min(b.to, yMax)), bot = y(Math.max(b.from, yMin));
    if (bot > top) svg += `<rect x="${L}" y="${top}" width="${W - L - R}" height="${bot - top}" fill="${b.color}"/>`;
  });
  // Horizontal grid: 4 steps.
  for (let i = 0; i <= 4; i++) {
    const v = yMin + (yMax - yMin) * i / 4;
    const yy = y(v);
    svg += `<line x1="${L}" x2="${W - R}" y1="${yy}" y2="${yy}" stroke="#2c3036" stroke-width="1"/>`;
    svg += `<text x="${L - 6}" y="${yy + 5}" text-anchor="end" class="ax">${opts.fmt ? opts.fmt(v) : (Math.abs(yMax - yMin) < 5 ? v.toFixed(1) : Math.round(v))}</text>`;
  }
  // Time ticks every 2 hours on the clock.
  const first = Math.ceil(t0 / 7200) * 7200;
  for (let t = first; t <= t1; t += 7200) {
    const xx = x(t);
    svg += `<line x1="${xx}" x2="${xx}" y1="${T}" y2="${H - B}" stroke="#2c3036" stroke-width="1"/>`;
    svg += `<text x="${xx}" y="${H - 9}" text-anchor="middle" class="ax">${clockTime(new Date(t * 1000)).slice(0, 2)}</text>`;
  }
  series.forEach(s => {
    const pts = s.points.filter(p => typeof p[1] === "number" && isFinite(p[1]));
    if (pts.length < 2) return;
    const d = pts.map((p, i) => `${i ? "L" : "M"}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join("");
    svg += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="${s.width || 3}" stroke-linejoin="round" stroke-linecap="round"${s.dash ? ` stroke-dasharray="${s.dash}"` : ""}/>`;
  });
  (opts.marks || []).forEach(m => {
    const xx = x(m.t), yy = y(m.v);
    const above = m.below ? false : true;
    svg += `<circle cx="${xx}" cy="${yy}" r="4.5" fill="#e8e6df"/>`;
    const tx = Math.max(L + 24, Math.min(W - R - 24, xx));
    svg += `<text x="${tx}" y="${above ? yy - 9 : yy + 21}" text-anchor="middle" class="mk">${m.text}</text>`;
  });
  // "Now" line.
  const nowX = x(Date.now() / 1000);
  if (nowX >= L && nowX <= W - R) svg += `<line x1="${nowX}" x2="${nowX}" y1="${T}" y2="${H - B}" stroke="#fac775" stroke-width="1.5" stroke-dasharray="3 3"/>`;
  return svg + "</svg>";
}

function detailKey(items) {
  return `<div class="detail-key">${items.map(i => `<span><i style="background:${i.color}"></i>${i.text}</span>`).join("")}</div>`;
}

function detailTable(head, rows) {
  return `<table class="detail-table"><thead><tr>${head.map(h => `<th>${h}</th>`).join("")}</tr></thead><tbody>` +
    rows.map(r => `<tr${r.cls ? ` class="${r.cls}"` : ""}>${r.cells.map(c =>
      (c && typeof c === "object") ? `<td class="${c.cls || ""}">${c.text}</td>` : `<td>${c}</td>`).join("")}</tr>`).join("") +
    "</tbody></table>";
}

const DETAIL_NONE = `<p class="detail-empty">Not available right now. It will fill in after the next successful refresh.</p>`;

// ---- Wind ----
function detailWind() {
  const units = unitChoices();
  const h = (loadCache(currentSpot()).forecast || {}).data;
  const hh = h && h.hourly;
  const range = detailHourRange(hh);
  if (!range) return DETAIL_NONE;
  const unit = units.windKmh ? "km/h" : "mph";
  const sp = range.map(i => [hh.time[i], windValue(hh.wind_speed_10m[i], units)]);
  const gu = range.map(i => [hh.time[i], windValue(hh.wind_gusts_10m[i], units)]);
  const k = units.windKmh ? 1.60934 : 1;
  const chart = detailChart([
    { points: gu, color: "#fac775", width: 2 },
    { points: sp, color: "#85b7eb" },
  ], { yMin: 0, yMax: 20 * k, bands: [{ from: 25 * k, to: 39 * k, color: "rgba(250,199,117,0.08)" }, { from: 39 * k, to: 999, color: "rgba(240,149,149,0.10)" }] });
  const rows = range.map(i => {
    const g = hh.wind_gusts_10m[i];
    const bf = beaufortFor(hh.wind_speed_10m[i]);
    // Same colours as the Wind box: gusts amber from 20 mph, red from
    // 30; force amber from 6, red from gale force 8.
    const gCls = g >= 30 ? "hot" : g >= 20 ? "warm" : "";
    const fCls = bf.force >= 8 ? "hot" : bf.force >= 6 ? "warm" : "";
    return {
      cells: [detailHourLabel(hh.time[i]), `${windValue(hh.wind_speed_10m[i], units)} ${compassPoint(hh.wind_direction_10m[i])}`,
        { text: `${windValue(g, units)}`, cls: gCls }, { text: `F${bf.force}`, cls: fCls }],
    };
  });
  return chart + detailKey([{ color: "#85b7eb", text: `Wind (${unit})` }, { color: "#fac775", text: "Gusts" }]) +
    detailTable(["Time", `Wind ${unit}`, "Gusts", "Force"], rows);
}

// ---- Sea ----
function detailSea() {
  const units = unitChoices();
  const h = (loadCache(currentSpot()).marine || {}).data;
  const hh = h && h.hourly;
  const range = detailHourRange(hh);
  if (!range || !hh.wave_height) return DETAIL_NONE;
  const wave = range.map(i => [hh.time[i], hh.wave_height[i]]);
  const swell = hh.swell_wave_height ? range.map(i => [hh.time[i], hh.swell_wave_height[i]]) : [];
  const chart = detailChart([
    { points: swell, color: "#9fe1cb", width: 2, dash: "5 4" },
    { points: wave, color: "#85b7eb" },
  ], { yMin: 0, yMax: 1.5, fmt: v => v.toFixed(1),
       bands: [{ from: 2.5, to: 4, color: "rgba(250,199,117,0.08)" }, { from: 4, to: 99, color: "rgba(240,149,149,0.10)" }] });
  const rows = range.map(i => {
    const w = hh.wave_height[i];
    const st = typeof w === "number" ? seaStateFor(w) : null;
    const cls = st && st.rank >= 5 ? "hot" : st && st.rank >= 4 ? "warm" : "";
    const per = hh.wave_period && typeof hh.wave_period[i] === "number" ? `${Math.round(hh.wave_period[i])} s` : "—";
    const dir = hh.wave_direction ? compassPoint(hh.wave_direction[i]) : "";
    return { cells: [detailHourLabel(hh.time[i]), typeof w === "number" ? `${w.toFixed(1)} m ${dir}` : "—", per, { text: st ? st.name : "—", cls }] };
  });
  return chart + detailKey([{ color: "#85b7eb", text: "Waves (m)" }, { color: "#9fe1cb", text: "Swell" }]) +
    detailTable(["Time", "Waves", "Period", "Sea state"], rows);
}

// ---- Tide ----
function detailTide() {
  const m = window.calloutTideModel;
  if (!m) return `<p class="detail-empty">The tide is still loading — this fills in by itself when it's ready.</p>`;
  const nowH = (Date.now() - m.epochMs) / 3600000;
  const toSec = hrs => (m.epochMs + hrs * 3600000) / 1000;
  const pts = [];
  for (let hh = nowH; hh <= nowH + DETAIL_HOURS + 0.01; hh += 0.25) {
    const r = m.levelAt(hh);
    pts.push([toSec(r.hours), r.level]);
  }
  const ev = m.extremes(nowH - 1, nowH + DETAIL_HOURS + 1).filter(e => e.hours >= nowH && e.hours <= nowH + DETAIL_HOURS);
  const isCD = m.levelAt(nowH).isCD;
  const datum = isCD ? "" : " (gauge datum)";
  const chart = detailChart([{ points: pts, color: "#85b7eb" }], {
    fmt: v => v.toFixed(0),
    marks: ev.map(e => ({ t: toSec(e.hours), v: e.level, below: e.type === "low", text: clockTime(new Date(toSec(e.hours) * 1000)) })),
  });
  const evRows = ev.map(e => ({
    cls: "tide-ev",
    cells: [clockTime(new Date(toSec(e.hours) * 1000)), e.type === "high" ? "High water" : "Low water", `${e.level.toFixed(1)} m`],
  }));
  // Hourly heights with rising/falling.
  const hourly = [];
  const startSec = Math.ceil(Date.now() / 3600000) * 3600;
  for (let s = startSec; s <= Date.now() / 1000 + DETAIL_HOURS * 3600; s += 3600) {
    const hrs = (s * 1000 - m.epochMs) / 3600000;
    const a = m.levelAt(hrs), b = m.levelAt(hrs + 0.5);
    const rate = (b.level - a.level) * 2;
    const word = Math.abs(rate) < 0.25 ? "Turning" : rate > 0 ? "Rising" : "Falling";
    hourly.push({ cells: [clockTime(new Date(s * 1000)), `${a.level.toFixed(1)} m`, `${word}${Math.abs(rate) >= 0.05 ? ` ${rate > 0 ? "+" : "−"}${Math.abs(rate).toFixed(1)} m/h` : ""}`] });
  }
  return chart +
    `<p class="detail-note">Heights in metres${datum} at ${escapeHtml(m.label)}.</p>` +
    detailTable(["Time", "Next high and low", "Height"], evRows) +
    detailTable(["Time", "Height", "Tide"], hourly);
}

// ---- Visibility ----
function detailVis() {
  const units = unitChoices();
  const h = (loadCache(currentSpot()).forecast || {}).data;
  const hh = h && h.hourly;
  const range = detailHourRange(hh);
  if (!range || !hh.visibility) return DETAIL_NONE;
  const toUnit = mtr => units.visMiles ? mtr / 1609.344 : mtr / 1000;
  const u = units.visMiles ? "miles" : "km";
  const pts = range.map(i => [hh.time[i], typeof hh.visibility[i] === "number" ? toUnit(hh.visibility[i]) : null]);
  const chart = detailChart([{ points: pts, color: "#85b7eb" }], {
    yMin: 0, yMax: toUnit(12000), yCap: toUnit(30000),
    bands: [{ from: 0, to: toUnit(1000), color: "rgba(240,149,149,0.14)" }, { from: toUnit(1000), to: toUnit(4000), color: "rgba(250,199,117,0.10)" }],
  });
  const rows = range.map(i => {
    const v = hh.visibility[i];
    if (typeof v !== "number") return { cells: [detailHourLabel(hh.time[i]), "—", "—"] };
    const word = visibilityWord(v);
    const cls = VIS_RANK[word] >= 3 ? "hot" : VIS_RANK[word] >= 2 ? "warm" : "";
    return { cells: [detailHourLabel(hh.time[i]), visibilityDistance(v, units), { text: word, cls }] };
  });
  return chart + detailKey([{ color: "#85b7eb", text: `Visibility (${u})` }]) +
    `<p class="detail-note">Shaded: poor (amber) and very poor (red). Visibility from weather models is a rough guide, especially for fog.</p>` +
    detailTable(["Time", "Visibility", ""], rows);
}

const DETAIL_KINDS = {
  wind: { title: "Wind", build: detailWind },
  sea: { title: "Sea", build: detailSea },
  tide: { title: "Tide", build: detailTide },
  vis: { title: "Visibility", build: detailVis },
};

function calloutDetailRefresh() {
  if (!detail.kind || detailEl("detailSheet").hidden) return;
  const k = DETAIL_KINDS[detail.kind];
  const keep = detailEl("detailSheet").scrollTop;
  detailEl("detailBody").innerHTML = k.build();
  detailEl("detailSheet").scrollTop = keep;
}

function calloutDetailOpen(kind) {
  const k = DETAIL_KINDS[kind];
  if (!k) return;
  detail.kind = kind;
  detailEl("detailTitle").textContent = `${k.title} · next ${DETAIL_HOURS} hours`;
  detailEl("detailPlace").textContent = currentSpot().label || "St Brides Bay";
  detailEl("detailSheet").hidden = false;
  document.body.classList.add("sheet-open");
  detailEl("detailBody").innerHTML = k.build();
  detailEl("detailSheet").scrollTop = 0;
}

function calloutDetailClose() {
  detail.kind = null;
  detailEl("detailSheet").hidden = true;
  document.body.classList.remove("sheet-open");
}

(function calloutDetailInit() {
  const map = { calloutWind: "wind", calloutSea: "sea", calloutTide: "tide", calloutVis: "vis" };
  Object.entries(map).forEach(([id, kind]) => {
    const el = detailEl(id);
    if (!el) return;
    el.classList.add("tappable");
    el.setAttribute("role", "button");
    el.setAttribute("tabindex", "0");
    el.addEventListener("click", () => calloutDetailOpen(kind));
  });
  detailEl("detailClose").addEventListener("click", calloutDetailClose);
})();
