// "Can't do pickup" — one button on the Callout screen that sends the
// same message by text and email to the people who'd collect a child
// (or dog) when the user is called out.
//
// How the sending works: a web app isn't allowed to send texts or
// emails by itself, so Cloude builds the message and hands it to an
// iPhone Shortcut called "Cloude Pickup" (via the shortcuts:// link).
// That Shortcut holds the recipients (picked from Contacts, up to 3 by
// text and 3 by email) and sends without asking. So no phone numbers
// or email addresses are stored in Cloude, and nothing goes through any
// server: the message leaves from the user's own phone number and
// email account.
//
// Stored on this device only (and copied into whole-device backups,
// see BACKUP_KEY_PREFIXES in app.js):
//   cloude-pickup:details   the saved wording, kept until changed or deleted
//   cloude-pickup:lastSent  when the last message was handed to Shortcuts
//
// The only thing typed at send time is the pickup time. Left blank,
// the message says plainly that no time was given.

const PICKUP_DETAILS_KEY = "cloude-pickup:details";
const PICKUP_LAST_KEY = "cloude-pickup:lastSent";
const PICKUP_SHORTCUT = "Cloude Pickup";
const PICKUP_DEFAULT_OPENING = "I've been called out on the lifeboat and can't do the pickup.";
const PICKUP_POSITION_WAIT_MS = 6000; // at Send, wait at most this long for a position

function pickupLoad() {
  try {
    const d = JSON.parse(localStorage.getItem(PICKUP_DETAILS_KEY) || "null");
    return d && typeof d === "object" ? d : null;
  } catch {
    return null;
  }
}

function pickupSave(d) {
  try { localStorage.setItem(PICKUP_DETAILS_KEY, JSON.stringify(d)); return true; } catch { return false; }
}

function pickupEsc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// "15:00" from the time box, or "" if left blank.
function pickupTimeText(value) {
  const m = /^(\d{1,2}):(\d{2})/.exec(value || "");
  return m ? `${m[1].padStart(2, "0")}:${m[2]}` : "";
}

const pickup = {
  pos: null,        // { lat, lon, acc, at } once found
  posError: "",
  posWaiters: [],
  watching: false,
};

function pickupStartPosition() {
  pickup.pos = null;
  pickup.posError = "";
  if (!("geolocation" in navigator)) { pickup.posError = "not available on this device"; return; }
  pickup.watching = true;
  navigator.geolocation.getCurrentPosition(p => {
    pickup.watching = false;
    pickup.pos = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy, at: new Date() };
    pickupRenderPreview();
    pickup.posWaiters.splice(0).forEach(fn => fn());
  }, err => {
    pickup.watching = false;
    pickup.posError = err && err.code === 1 ? "not allowed (check Location for Cloude/Safari)" : "couldn't be found";
    pickupRenderPreview();
    pickup.posWaiters.splice(0).forEach(fn => fn());
  }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
}

function pickupWaitForPosition(ms) {
  if (!pickup.watching) return Promise.resolve();
  return new Promise(resolve => {
    const t = setTimeout(resolve, ms);
    pickup.posWaiters.push(() => { clearTimeout(t); resolve(); });
  });
}

function pickupPositionLine(d) {
  if (!d.includePosition) return "";
  if (pickup.pos) {
    const { lat, lon, acc, at } = pickup.pos;
    const hhmm = at.toTimeString().slice(0, 5);
    return `My position at ${hhmm}: ${lat.toFixed(5)}, ${lon.toFixed(5)} (to about ${Math.max(5, Math.round(acc))} m)\nhttps://maps.google.com/?q=${lat.toFixed(5)},${lon.toFixed(5)}`;
  }
  return "My position wasn't available.";
}

function pickupMessage(d, time) {
  const who = (d.who || "").trim() || "the children";
  const where = (d.where || "").trim();
  const from = where ? ` from ${where}` : "";
  const lines = [];
  lines.push((d.opening || "").trim() || PICKUP_DEFAULT_OPENING);
  if (time) {
    lines.push(`Please pick up ${who}${from} at ${time}.`);
  } else {
    lines.push(`Please pick up ${who}${from}.`);
    lines.push(`NO PICKUP TIME WAS GIVEN — please check when ${who} needs collecting${where ? ` (ask ${where})` : ""}.`);
  }
  if ((d.ifUnable || "").trim()) lines.push(`If you can't, please contact ${d.ifUnable.trim()}.`);
  lines.push("Please reply to everyone to say you've got it.");
  const pos = pickupPositionLine(d);
  if (pos) lines.push(pos);
  return lines.join("\n\n");
}

// ---------- Screen ----------

function pickupEl(id) { return document.getElementById(id); }

function pickupRenderButton() {
  const btn = pickupEl("pickupButton");
  const last = pickupEl("pickupLast");
  if (!btn) return;
  const d = pickupLoad();
  btn.innerHTML = d
    ? `Can't do pickup<small>Send the pickup message${d.who ? ` for ${pickupEsc(d.who)}` : ""}</small>`
    : `Set up "Can't do pickup"<small>One-tap message by text and email</small>`;
  let lastText = "";
  try {
    const t = Date.parse(localStorage.getItem(PICKUP_LAST_KEY) || "");
    if (Number.isFinite(t)) {
      const when = new Date(t);
      const today = when.toDateString() === new Date().toDateString();
      lastText = `Last pickup message handed to Shortcuts ${today ? "today" : when.toLocaleDateString("en-GB", { day: "numeric", month: "short" })} at ${when.toTimeString().slice(0, 5)}.`;
    }
  } catch { /* ignore */ }
  if (last) { last.textContent = lastText; last.hidden = !lastText; }
}

function pickupOpen() {
  const d = pickupLoad();
  pickupEl("pickupSheet").hidden = false;
  document.body.classList.add("sheet-open");
  if (d) pickupShowSend(); else pickupShowSetup(true);
}

function pickupClose() {
  pickupEl("pickupSheet").hidden = true;
  document.body.classList.remove("sheet-open");
  pickupRenderButton();
}

function pickupShowSend() {
  pickupEl("pickupSetup").hidden = true;
  pickupEl("pickupSend").hidden = false;
  pickupEl("pickupTime").value = "";
  pickupEl("pickupStatus").textContent = "";
  const d = pickupLoad();
  if (d && d.includePosition) pickupStartPosition();
  pickupRenderPreview();
}

function pickupShowSetup(first) {
  const d = pickupLoad() || { opening: PICKUP_DEFAULT_OPENING, who: "", where: "", ifUnable: "", includePosition: true };
  pickupEl("pickupSend").hidden = true;
  pickupEl("pickupSetup").hidden = false;
  pickupEl("pickupSetupIntro").hidden = !first;
  pickupEl("pickupDelete").hidden = !!first;
  pickupEl("pickupOpening").value = d.opening || "";
  pickupEl("pickupWho").value = d.who || "";
  pickupEl("pickupWhere").value = d.where || "";
  pickupEl("pickupIfUnable").value = d.ifUnable || "";
  pickupEl("pickupIncludePos").checked = d.includePosition !== false;
  pickupEl("pickupSetupStatus").textContent = "";
}

function pickupRenderPreview() {
  const box = pickupEl("pickupPreview");
  if (!box || pickupEl("pickupSend").hidden) return;
  const d = pickupLoad();
  if (!d) return;
  const time = pickupTimeText(pickupEl("pickupTime").value);
  box.textContent = pickupMessage(d, time);
  const noTime = pickupEl("pickupNoTime");
  noTime.hidden = !!time;
  const posLine = pickupEl("pickupPosState");
  if (!d.includePosition) posLine.textContent = "Position: not included (change in Edit details).";
  else if (pickup.pos) posLine.textContent = `Position found, to about ${Math.max(5, Math.round(pickup.pos.acc))} m.`;
  else if (pickup.posError) posLine.textContent = `Position ${pickup.posError} — the message will say so.`;
  else posLine.textContent = "Getting your position…";
}

async function pickupSendNow() {
  const d = pickupLoad();
  if (!d) return;
  const btn = pickupEl("pickupSendNow");
  const status = pickupEl("pickupStatus");
  btn.disabled = true;
  if (d.includePosition && pickup.watching) {
    status.textContent = "Getting your position…";
    await pickupWaitForPosition(PICKUP_POSITION_WAIT_MS);
  }
  const time = pickupTimeText(pickupEl("pickupTime").value);
  const message = pickupMessage(d, time);
  try { localStorage.setItem(PICKUP_LAST_KEY, new Date().toISOString()); } catch { /* ignore */ }
  status.textContent = `Opening the "${PICKUP_SHORTCUT}" shortcut to send it… If nothing happens, the shortcut isn't set up yet — see "How to set up the shortcut" below.`;
  btn.disabled = false;
  pickupRenderButton();
  window.location.href = "shortcuts://run-shortcut?name=" + encodeURIComponent(PICKUP_SHORTCUT) +
    "&input=text&text=" + encodeURIComponent(message);
}

function pickupSaveSetup() {
  const d = {
    opening: pickupEl("pickupOpening").value.trim(),
    who: pickupEl("pickupWho").value.trim(),
    where: pickupEl("pickupWhere").value.trim(),
    ifUnable: pickupEl("pickupIfUnable").value.trim(),
    includePosition: pickupEl("pickupIncludePos").checked,
  };
  if (!d.who) {
    pickupEl("pickupSetupStatus").textContent = "Put in who's to be picked up first.";
    pickupEl("pickupWho").focus();
    return;
  }
  if (!pickupSave(d)) {
    pickupEl("pickupSetupStatus").textContent = "Couldn't save on this device.";
    return;
  }
  pickupRenderButton();
  pickupShowSend();
}

function pickupDeleteAll() {
  if (!confirm("Delete the saved pickup message? (The shortcut and its contacts stay in the Shortcuts app.)")) return;
  try { localStorage.removeItem(PICKUP_DETAILS_KEY); localStorage.removeItem(PICKUP_LAST_KEY); } catch { /* ignore */ }
  pickupClose();
}

(function pickupInit() {
  const btn = pickupEl("pickupButton");
  if (!btn) return;
  btn.addEventListener("click", pickupOpen);
  pickupEl("pickupClose").addEventListener("click", pickupClose);
  pickupEl("pickupTime").addEventListener("input", pickupRenderPreview);
  pickupEl("pickupTimeClear").addEventListener("click", () => { pickupEl("pickupTime").value = ""; pickupRenderPreview(); });
  pickupEl("pickupSendNow").addEventListener("click", pickupSendNow);
  pickupEl("pickupEdit").addEventListener("click", () => pickupShowSetup(false));
  pickupEl("pickupSave").addEventListener("click", pickupSaveSetup);
  pickupEl("pickupCancel").addEventListener("click", () => { if (pickupLoad()) pickupShowSend(); else pickupClose(); });
  pickupEl("pickupDelete").addEventListener("click", pickupDeleteAll);
  pickupRenderButton();
})();
