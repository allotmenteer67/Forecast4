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
// Several pickups can be saved (a child from the carer, the dog from
// the kennels, another child from gymnastics), each with who and from
// where. At send time only the times are typed, one per pickup; a
// blank time makes the message say plainly that no time was given.
// Each pickup can be left out for one callout ("Include" untick)
// without deleting it. Times and Include ticks are never saved: every
// opening starts with all pickups included and no times.

const PICKUP_DETAILS_KEY = "cloude-pickup:details";
const PICKUP_LAST_KEY = "cloude-pickup:lastSent";
const PICKUP_SHORTCUT = "Cloude Pickup";
const PICKUP_DEFAULT_OPENING = "I've been called out on the lifeboat and can't do the pickup.";
const PICKUP_POSITION_WAIT_MS = 6000; // at Send, wait at most this long for a position

function pickupLoad() {
  try {
    const d = JSON.parse(localStorage.getItem(PICKUP_DETAILS_KEY) || "null");
    if (!d || typeof d !== "object") return null;
    // Older saves had a single who/where.
    if (!Array.isArray(d.pickups)) {
      d.pickups = (d.who || d.where) ? [{ who: d.who || "", where: d.where || "" }] : [];
      delete d.who; delete d.where;
    }
    return d;
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

// "15:00" from a time box, or "" if left blank.
function pickupTimeText(value) {
  const m = /^(\d{1,2}):(\d{2})/.exec(value || "");
  return m ? `${m[1].padStart(2, "0")}:${m[2]}` : "";
}

// "Ellie", "Ellie and the dog", "Ellie, the dog and Tom"
function pickupNames(list) {
  const n = list.map(p => p.who).filter(Boolean);
  return n.length <= 1 ? (n[0] || "") : n.slice(0, -1).join(", ") + " and " + n[n.length - 1];
}

const pickup = {
  pos: null,        // { lat, lon, acc, at } once found
  posError: "",
  posWaiters: [],
  watching: false,
  rows: [],         // on screen: { who, where, time, include }
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

// d: saved details; list: the pickups going out this time, each
// { who, where, time }.
function pickupMessage(d, list) {
  const lines = [];
  lines.push((d.opening || "").trim() || PICKUP_DEFAULT_OPENING);
  const item = p => {
    const from = p.where ? ` from ${p.where}` : "";
    return p.time
      ? `${p.who}${from} at ${p.time}`
      : `${p.who}${from} — NO TIME GIVEN, please check when${p.where ? ` with ${p.where}` : ""}`;
  };
  if (list.length === 1) {
    const p = list[0];
    const from = p.where ? ` from ${p.where}` : "";
    if (p.time) {
      lines.push(`Please pick up ${p.who}${from} at ${p.time}.`);
    } else {
      lines.push(`Please pick up ${p.who}${from}.`);
      lines.push(`NO PICKUP TIME WAS GIVEN — please check when ${p.who} needs collecting${p.where ? ` (ask ${p.where})` : ""}.`);
    }
  } else {
    lines.push("Please pick up:\n" + list.map(p => "• " + item(p)).join("\n"));
  }
  if ((d.ifUnable || "").trim()) lines.push(`If you can't, please contact ${d.ifUnable.trim()}.`);
  lines.push("Please reply to everyone to say you've got it.");
  const pos = pickupPositionLine(d);
  if (pos) lines.push(pos);
  return lines.join("\n\n");
}

// ---------- Screen ----------
// One screen does everything: a card per pickup (who, from where, and
// that callout's time), "Add another pickup", who to contact if unable,
// Send, then the message as it will be sent. Who and where are saved as
// they're typed, so a change at a callout needs no extra tap. First
// line and position live under "More options".

function pickupEl(id) { return document.getElementById(id); }

function pickupRenderButton() {
  const btn = pickupEl("pickupButton");
  const last = pickupEl("pickupLast");
  if (!btn) return;
  const d = pickupLoad();
  const names = d ? pickupNames(d.pickups) : "";
  btn.innerHTML = names
    ? `Can't do pickup<small>Send the pickup message for ${pickupEsc(names)}</small>`
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

function pickupDefaults() {
  return { opening: PICKUP_DEFAULT_OPENING, pickups: [], ifUnable: "", includePosition: true };
}

function pickupOpen() {
  const saved = pickupLoad();
  const d = saved || pickupDefaults();
  pickupEl("pickupSheet").hidden = false;
  document.body.classList.add("sheet-open");
  pickupEl("pickupSetupIntro").hidden = !!(saved && saved.pickups.some(p => p.who));
  // Times and Include ticks start fresh every time.
  pickup.rows = (d.pickups.length ? d.pickups : [{ who: "", where: "" }])
    .map(p => ({ who: p.who || "", where: p.where || "", time: "", include: true }));
  pickupEl("pickupIfUnable").value = d.ifUnable || "";
  pickupEl("pickupOpening").value = d.opening || "";
  pickupEl("pickupIncludePos").checked = d.includePosition !== false;
  pickupEl("pickupStatus").textContent = "";
  pickupEl("pickupSheet").scrollTop = 0;
  pickupBuildRows();
  if (d.includePosition !== false) pickupStartPosition();
  pickupRender();
}

function pickupClose() {
  pickupEl("pickupSheet").hidden = true;
  document.body.classList.remove("sheet-open");
  pickupRenderButton();
}

function pickupBuildRows() {
  const box = pickupEl("pickupRows");
  box.innerHTML = "";
  const many = pickup.rows.length > 1;
  pickup.rows.forEach((r, i) => {
    const card = document.createElement("div");
    card.className = "pickup-card" + (r.include ? "" : " left-out");
    card.innerHTML = `
      <div class="card-top">
        ${many ? `<label class="check include"><input type="checkbox" data-f="include"${r.include ? " checked" : ""}> Include</label>` : `<span class="card-title">Pickup</span>`}
        ${many ? `<button type="button" class="remove" data-act="remove">Remove</button>` : ""}
      </div>
      <div class="card-pair">
        <div><label>Who</label>
        <input type="text" data-f="who" placeholder="e.g. Ellie" autocomplete="off" value="${pickupEsc(r.who)}"></div>
        <div><label>From where</label>
        <input type="text" data-f="where" placeholder="e.g. the carer" autocomplete="off" value="${pickupEsc(r.where)}"></div>
      </div>
      <div class="time-row card-time">
        <input type="time" data-f="time" value="${pickupEsc(r.time)}">
        <button type="button" data-act="notime">No time</button>
      </div>
      <p class="no-time"${r.time ? " hidden" : ""}>No time set — the message will say so.</p>`;
    card.querySelectorAll("[data-f]").forEach(el => {
      const f = el.dataset.f;
      const handler = () => {
        r[f] = el.type === "checkbox" ? el.checked : (f === "time" ? el.value : el.value);
        if (f === "include") card.classList.toggle("left-out", !r.include);
        if (f === "time") card.querySelector(".no-time").hidden = !!pickupTimeText(r.time);
        if (f === "who" || f === "where") pickupSaveScreen();
        pickupRender();
      };
      el.addEventListener("input", handler);
      el.addEventListener("change", handler);
    });
    card.querySelector('[data-act="notime"]').addEventListener("click", () => {
      r.time = "";
      card.querySelector('[data-f="time"]').value = "";
      card.querySelector(".no-time").hidden = false;
      pickupRender();
    });
    const rm = card.querySelector('[data-act="remove"]');
    if (rm) rm.addEventListener("click", () => {
      const name = r.who || "this pickup";
      if (!confirm(`Remove ${name} from the saved pickups?`)) return;
      pickup.rows.splice(i, 1);
      pickupSaveScreen();
      pickupBuildRows();
      pickupRender();
    });
    box.appendChild(card);
  });
}

function pickupAddRow() {
  pickup.rows.push({ who: "", where: "", time: "", include: true });
  pickupBuildRows();
  pickupRender();
  const cards = pickupEl("pickupRows").querySelectorAll(".pickup-card");
  const last = cards[cards.length - 1];
  if (last) { last.scrollIntoView({ block: "center" }); last.querySelector('[data-f="who"]').focus(); }
}

// The saved part of what's on screen (no times, no Include ticks).
function pickupFromScreen() {
  return {
    opening: pickupEl("pickupOpening").value.trim(),
    pickups: pickup.rows.map(r => ({ who: r.who.trim(), where: r.where.trim() })).filter(p => p.who || p.where),
    ifUnable: pickupEl("pickupIfUnable").value.trim(),
    includePosition: pickupEl("pickupIncludePos").checked,
  };
}

function pickupSaveScreen() { pickupSave(pickupFromScreen()); }

// The pickups going out this time.
function pickupGoing() {
  return pickup.rows
    .filter(r => r.include && r.who.trim())
    .map(r => ({ who: r.who.trim(), where: r.where.trim(), time: pickupTimeText(r.time) }));
}

function pickupChanged() {
  const d = pickupFromScreen();
  pickupSave(d);
  if (d.includePosition && !pickup.pos && !pickup.watching) pickupStartPosition();
  pickupRender();
}

function pickupRender() {
  const d = pickupFromScreen();
  const going = pickupGoing();
  pickupEl("pickupSendNow").disabled = !going.length;
  pickupEl("pickupSendNow").textContent = going.length > 1 ? `Send now (${going.length} pickups)` : "Send now";
  pickupEl("pickupPreview").textContent = going.length
    ? pickupMessage(d, going)
    : (pickup.rows.some(r => r.who.trim()) ? "Every pickup is left out — tick Include on at least one." : "Put in who's to be picked up, and the message will appear here.");
  const posLine = pickupEl("pickupPosState");
  if (!d.includePosition) posLine.textContent = "Position: not included (see More options).";
  else if (pickup.pos) posLine.textContent = `Position found, to about ${Math.max(5, Math.round(pickup.pos.acc))} m.`;
  else if (pickup.posError) posLine.textContent = `Position ${pickup.posError} — the message will say so.`;
  else posLine.textContent = "Getting your position…";
}
// Position updates call this name.
function pickupRenderPreview() { if (!pickupEl("pickupSheet").hidden) pickupRender(); }

async function pickupSendNow() {
  const going = pickupGoing();
  if (!going.length) return;
  const d = pickupFromScreen();
  pickupSave(d);
  const btn = pickupEl("pickupSendNow");
  const status = pickupEl("pickupStatus");
  btn.disabled = true;
  if (d.includePosition && pickup.watching) {
    status.textContent = "Getting your position…";
    await pickupWaitForPosition(PICKUP_POSITION_WAIT_MS);
  }
  const message = pickupMessage(d, pickupGoing());
  try { localStorage.setItem(PICKUP_LAST_KEY, new Date().toISOString()); } catch { /* ignore */ }
  status.textContent = `Opening the "${PICKUP_SHORTCUT}" shortcut to send it… If nothing happens, the shortcut isn't set up yet — see "How to set up the shortcut" below.`;
  btn.disabled = false;
  pickupRender();
  pickupRenderButton();
  window.location.href = "shortcuts://run-shortcut?name=" + encodeURIComponent(PICKUP_SHORTCUT) +
    "&input=text&text=" + encodeURIComponent(message);
}

function pickupDeleteAll() {
  if (!confirm("Delete all the saved pickups and wording? (The shortcut and its contacts stay in the Shortcuts app.)")) return;
  try { localStorage.removeItem(PICKUP_DETAILS_KEY); localStorage.removeItem(PICKUP_LAST_KEY); } catch { /* ignore */ }
  pickupClose();
}

(function pickupInit() {
  const btn = pickupEl("pickupButton");
  if (!btn) return;
  btn.addEventListener("click", pickupOpen);
  pickupEl("pickupClose").addEventListener("click", pickupClose);
  pickupEl("pickupAdd").addEventListener("click", pickupAddRow);
  ["pickupIfUnable", "pickupOpening"].forEach(id => pickupEl(id).addEventListener("input", pickupChanged));
  pickupEl("pickupIncludePos").addEventListener("change", pickupChanged);
  pickupEl("pickupSendNow").addEventListener("click", pickupSendNow);
  pickupEl("pickupDelete").addEventListener("click", pickupDeleteAll);
  pickupRenderButton();
})();
