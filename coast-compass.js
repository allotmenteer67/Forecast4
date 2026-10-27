// The phone's own compass on the Coast map.
//
// "Take a bearing" (on the map card while Me is on): point the top of
// the phone at a casualty, flare or boat, and tap Mark. That reading
// becomes a bearing line from where you are (real GPS or the practice
// position), exactly like one typed into Position, so the crossing
// circle works with it too.
//
// While the compass is running, a pale wedge on the Me dot shows which
// way the phone is pointing.
//
// iPhone and iPad: Safari only gives compass readings after a tap and a
// one-off "Allow" (DeviceOrientationEvent.requestPermission). The
// reading (webkitCompassHeading) is magnetic, which is what's shown;
// lines are stored true, like every other bearing on the map.
// Android: the "absolute" orientation event, treated the same way.
//
// A phone compass is a rough instrument: a few degrees at best, and
// thrown out by steel, engines, radios and magnets nearby (including
// a magnetic phone case). The panel says so, and shows iOS's own
// accuracy estimate when it gives one.

const compass = {
  running: false,
  heading: null,   // magnetic, degrees, smoothed
  accuracy: null,  // ± degrees, iOS only
  lastDraw: 0,
  handler: null,
  eventName: null,
  panelOpen: false,
};

function compassSupported() {
  return typeof window.DeviceOrientationEvent !== "undefined";
}

// Must be called straight from a tap (iOS asks for permission then).
async function startCompass() {
  if (compass.running) return true;
  if (!compassSupported()) { compassMessage("This device has no compass the browser can use."); return false; }
  try {
    if (typeof DeviceOrientationEvent.requestPermission === "function") {
      const r = await DeviceOrientationEvent.requestPermission();
      if (r !== "granted") {
        compassMessage("Compass not allowed. Close and reopen the app to be asked again, or allow Motion & Orientation for it in Settings.");
        return false;
      }
    }
  } catch {
    compassMessage("Couldn't ask for the compass — try tapping again.");
    return false;
  }
  compass.handler = onOrientation;
  compass.eventName = "ondeviceorientationabsolute" in window ? "deviceorientationabsolute" : "deviceorientation";
  window.addEventListener(compass.eventName, compass.handler, true);
  compass.running = true;
  compass.heading = null;
  return true;
}

function stopCompass() {
  if (compass.handler && compass.eventName) window.removeEventListener(compass.eventName, compass.handler, true);
  compass.running = false;
  compass.handler = null;
  compass.heading = null;
  compass.accuracy = null;
  queueDraw();
}

function screenAngle() {
  if (screen.orientation && typeof screen.orientation.angle === "number") return screen.orientation.angle;
  return typeof window.orientation === "number" ? window.orientation : 0;
}

function onOrientation(e) {
  let h = null;
  if (typeof e.webkitCompassHeading === "number" && !Number.isNaN(e.webkitCompassHeading)) {
    h = e.webkitCompassHeading; // iOS: magnetic, already for the top of the phone
    compass.accuracy = typeof e.webkitCompassAccuracy === "number" && e.webkitCompassAccuracy >= 0 ? e.webkitCompassAccuracy : null;
  } else if ((e.absolute || e.type === "deviceorientationabsolute") && typeof e.alpha === "number") {
    h = (360 - e.alpha + screenAngle()) % 360; // Android
    compass.accuracy = null;
  }
  if (h === null) return;
  // Smooth the jitter (on the circle, so 359° and 1° average to 0°).
  if (compass.heading === null) compass.heading = h;
  else {
    const d = ((h - compass.heading + 540) % 360) - 180;
    compass.heading = (compass.heading + d * 0.25 + 360) % 360;
  }
  const now = Date.now();
  if (now - compass.lastDraw > 100) {
    compass.lastDraw = now;
    renderCompassPanel();
    queueDraw();
  }
}

function compassMessage(text) {
  const el = $("compassNote");
  if (el) { el.textContent = text; el.hidden = false; }
}

function compassDegText(h) {
  return String(Math.round(h) % 360).padStart(3, "0");
}

// ---- Panel ----
async function openCompassPanel() {
  const panel = $("compassPanel");
  panel.hidden = false;
  compass.panelOpen = true;
  $("compassNote").hidden = true;
  $("compassHeading").textContent = "---°M";
  $("compassSub").textContent = "Starting the compass…";
  $("compassMark").disabled = true;
  const ok = await startCompass();
  if (!ok) { $("compassSub").textContent = ""; return; }
  // Nothing after a couple of seconds: no compass, or it's switched off.
  setTimeout(() => {
    if (compass.panelOpen && compass.heading === null) {
      $("compassSub").textContent = "";
      compassMessage("No compass reading. On iPhone check Settings › Privacy & Security › Location Services › System Services › Compass Calibration is on, then try again.");
    }
  }, 2500);
  renderCompassPanel();
}

function closeCompassPanel() {
  $("compassPanel").hidden = true;
  compass.panelOpen = false;
  stopCompass();
}

function renderCompassPanel() {
  if (!compass.panelOpen) return;
  const h = compass.heading;
  if (h === null) return;
  $("compassHeading").textContent = `${compassDegText(h)}°M`;
  const acc = compass.accuracy;
  const poor = acc !== null && acc > 15;
  $("compassSub").textContent = acc !== null
    ? `Phone says accurate to about ±${Math.round(acc)}°${poor ? " — wave the phone in a figure of eight to settle it" : ""}`
    : "Accuracy not known — check against a fixed mark if you can";
  $("compassSub").classList.toggle("poor", poor);
  $("compassMark").disabled = false;
  // Rotate the card so its N points to magnetic north.
  const rose = $("compassRose");
  if (rose) rose.style.transform = `rotate(${-h}deg)`;
}

function markCompassBearing() {
  const h = compass.heading;
  if (h === null) return;
  if (!coast.me) {
    compassMessage("Turn on Me first (or set a practice position): the bearing is drawn from where you are.");
    return;
  }
  if (coast.lines.length >= MAX_LINES) {
    compassMessage("Three bearings are drawn already — remove one on the map card first.");
    return;
  }
  const mag = Math.round(h) % 360;
  const where = coast.me.practice ? "practice position" : "my position";
  const ok = addLine({
    lat: coast.me.lat, lon: coast.me.lon, bearingT: magToTrue(mag),
    label: `${compassDegText(mag)}°M from ${where} (phone compass)`,
    from: { name: where === "my position" ? "My position" : "Practice position", lat: coast.me.lat, lon: coast.me.lon },
    bearingNum: mag, bearingType: "M", dir: null,
    compass: true, accuracy: compass.accuracy,
  });
  if (!ok) return;
  closeCompassPanel();
  updatePinCard();
  queueDraw();
}

// A wedge on the Me dot showing where the phone points (while running).
function drawCompassWedge() {
  if (!compass.running || compass.heading === null || !coast.me) return;
  const { ctx } = coast;
  const s = toScreen(coast.me.lat, coast.me.lon);
  const t = magToTrue(compass.heading) * Math.PI / 180;
  const spread = Math.max(compass.accuracy || 10, 6) * Math.PI / 180;
  const len = 70;
  // Screen angle: north is up, clockwise.
  const a0 = t - spread - Math.PI / 2, a1 = t + spread - Math.PI / 2;
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(s.x, s.y);
  ctx.arc(s.x, s.y, len, a0, a1);
  ctx.closePath();
  const g = ctx.createRadialGradient(s.x, s.y, 4, s.x, s.y, len);
  g.addColorStop(0, "rgba(120,180,255,0.55)");
  g.addColorStop(1, "rgba(120,180,255,0)");
  ctx.fillStyle = g;
  ctx.fill();
  ctx.restore();
}

(function setUpCompass() {
  const open = $("compassMark");
  if (!open) return;
  $("compassMark").addEventListener("click", markCompassBearing);
  $("compassCancel").addEventListener("click", closeCompassPanel);
})();
