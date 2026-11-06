// "Can't do pickup" — one button on the Callout screen that sends the
// same message by text and email to the people who'd collect a child
// (or dog) when the user is called out.
//
// How the sending works: a web app isn't allowed to send texts or
// emails by itself, so Cloude builds the message and hands it to an
// iPhone Shortcut called "Cloude Send" (via the shortcuts:// link).
// The shortcut is the same for everyone and is added from one shared
// iCloud link (PICKUP_SHORTCUT_LINK), so nobody edits anything in the
// Shortcuts app. Cloude passes it a small JSON object:
//   { message, subject, texts: [mobile numbers], emails: [addresses] }
// (texts / emails left out when empty). The shortcut reads those four
// keys and sends by Messages and Mail without asking.
//
// So the recipients (up to 3 mobiles and 3 email addresses) are typed
// into Cloude itself, in "Set up sending", and kept on this phone. They
// go nowhere except into the message itself: no server is involved, and
// the message leaves from the user's own number and email account.
// (Until v120 the recipients lived in a hand-built "Cloude Pickup"
// shortcut instead; that turned out too fiddly for people with no
// computer experience.)
//
// Stored on this device only (and copied into whole-device backups,
// see BACKUP_KEY_PREFIXES in app.js):
//   cloude-pickup:details   the saved wording and recipients, kept until changed or deleted
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
const PICKUP_SHORTCUT = "Cloude Send";
// The shared shortcut, built once by the app's owner. Tapping this opens
// the Shortcuts app with an "Add Shortcut" button.
const PICKUP_SHORTCUT_LINK = "https://www.icloud.com/shortcuts/19d109a020ae4ba1bd6e343ae91929a6";
const PICKUP_MAX_RECIPIENTS = 3;
const PICKUP_DEFAULT_OPENING = "I've been called out on the lifeboat and can't do the pickup.";
// Sent instead when no pickup is named or ticked: just "called out".
const PICKUP_DEFAULT_CALLED_OUT = "I've been called out on the lifeboat. No pickups needed — just letting you know.";
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
    if (!Array.isArray(d.texts)) d.texts = [];
    if (!Array.isArray(d.emails)) d.emails = [];
    return d;
  } catch {
    return null;
  }
}

function pickupSave(d) {
  try { localStorage.setItem(PICKUP_DETAILS_KEY, JSON.stringify(d)); return true; } catch { return false; }
}

// "07700 900123" -> "07700900123"; keeps a leading +. Anything with
// fewer than 10 digits isn't a usable mobile number.
function pickupCleanNumber(s) {
  const t = String(s || "").trim();
  const digits = t.replace(/[^\d]/g, "");
  if (digits.length < 10 || digits.length > 15) return "";
  return (t.startsWith("+") ? "+" : "") + digits;
}

function pickupCleanEmail(s) {
  const t = String(s || "").trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t) ? t : "";
}

// The usable recipients, plus a count of boxes that have something in
// them that doesn't look right.
function pickupRecipients(d) {
  const texts = [], emails = [];
  let badTexts = 0, badEmails = 0;
  (d.texts || []).forEach(v => {
    if (!String(v || "").trim()) return;
    const n = pickupCleanNumber(v);
    if (n) { if (!texts.includes(n)) texts.push(n); } else badTexts++;
  });
  (d.emails || []).forEach(v => {
    if (!String(v || "").trim()) return;
    const e = pickupCleanEmail(v);
    if (e) { if (!emails.includes(e)) emails.push(e); } else badEmails++;
  });
  return { texts, emails, badTexts, badEmails };
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
// The plain "called out" message: no pickups, so no pickup lines and no
// reply request; position still added if chosen.
function pickupCalledOutMessage(d) {
  const lines = [(d.calledOut || "").trim() || PICKUP_DEFAULT_CALLED_OUT];
  const pos = pickupPositionLine(d);
  if (pos) lines.push(pos);
  return lines.join("\n\n");
}

function pickupMessage(d, list) {
  if (!list.length) return pickupCalledOutMessage(d);
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
    : d
      ? `Called out<small>Send the "called out" message</small>`
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
  return { opening: PICKUP_DEFAULT_OPENING, calledOut: PICKUP_DEFAULT_CALLED_OUT, pickups: [], ifUnable: "", includePosition: true, texts: [], emails: [] };
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
  pickupEl("pickupCalledOut").value = d.calledOut || PICKUP_DEFAULT_CALLED_OUT;
  pickupEl("pickupIncludePos").checked = d.includePosition !== false;
  for (let i = 0; i < PICKUP_MAX_RECIPIENTS; i++) {
    pickupEl(`pickupText${i}`).value = d.texts[i] || "";
    pickupEl(`pickupEmail${i}`).value = d.emails[i] || "";
  }
  // "Set up sending" starts open until there's someone to send to.
  const r = pickupRecipients(d);
  pickupEl("pickupSending").open = !(r.texts.length || r.emails.length);
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
    calledOut: pickupEl("pickupCalledOut").value.trim(),
    pickups: pickup.rows.map(r => ({ who: r.who.trim(), where: r.where.trim() })).filter(p => p.who || p.where),
    ifUnable: pickupEl("pickupIfUnable").value.trim(),
    includePosition: pickupEl("pickupIncludePos").checked,
    texts: Array.from({ length: PICKUP_MAX_RECIPIENTS }, (_, i) => pickupEl(`pickupText${i}`).value.trim()),
    emails: Array.from({ length: PICKUP_MAX_RECIPIENTS }, (_, i) => pickupEl(`pickupEmail${i}`).value.trim()),
  };
}

function pickupSaveScreen() { pickupSave(pickupFromScreen()); }

// The pickups going out this time (may be none: then it's "called out" only).
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
  // With no pickup named (or none ticked), Send still works: it sends
  // the plain "called out" message.
  pickupEl("pickupSendNow").disabled = false;
  pickupEl("pickupSendNow").textContent = going.length > 1 ? `Send now (${going.length} pickups)` : going.length ? "Send now" : "Send \u201ccalled out\u201d only";
  pickupEl("pickupPreview").textContent = pickupMessage(d, going);
  pickupEl("pickupNoneNote").hidden = !!going.length;
  const r = pickupRecipients(d);
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const parts = [];
  if (r.texts.length) parts.push(plural(r.texts.length, "by text", "by text"));
  if (r.emails.length) parts.push(plural(r.emails.length, "by email", "by email"));
  const toText = parts.length ? `Goes to ${parts.join(" and ")}.` : "No one to send to yet — fill in \u201cSet up sending\u201d below.";
  pickupEl("pickupTo").textContent = toText;
  pickupEl("pickupTo").classList.toggle("warn", !parts.length);
  pickupEl("pickupSendingSummary").textContent = parts.length
    ? `Set up sending (${parts.join(", ")})`
    : "Set up sending (not done yet)";
  const bad = [];
  if (r.badTexts) bad.push(`${plural(r.badTexts, "mobile number doesn't", "mobile numbers don't")} look right (it needs all 11 digits, like 07700 900123)`);
  if (r.badEmails) bad.push(`${plural(r.badEmails, "email address doesn't", "email addresses don't")} look right`);
  pickupEl("pickupRecipientsCheck").textContent = bad.length ? bad.join("; ") + ", so it will be left out." : "";
  pickupEl("pickupRecipientsCheck").hidden = !bad.length;
  const posLine = pickupEl("pickupPosState");
  if (!d.includePosition) posLine.textContent = "Position: not included (see More options).";
  else if (pickup.pos) posLine.textContent = `Position found, to about ${Math.max(5, Math.round(pickup.pos.acc))} m.`;
  else if (pickup.posError) posLine.textContent = `Position ${pickup.posError} — the message will say so.`;
  else posLine.textContent = "Getting your position…";
}
// Position updates call this name.
function pickupRenderPreview() { if (!pickupEl("pickupSheet").hidden) pickupRender(); }

// Hands one message to the "Cloude Send" shortcut.
function pickupRunShortcut(message, subject, r) {
  const payload = { message, subject };
  if (r.texts.length) payload.texts = r.texts;
  if (r.emails.length) payload.emails = r.emails;
  window.location.href = "shortcuts://run-shortcut?name=" + encodeURIComponent(PICKUP_SHORTCUT) +
    "&input=text&text=" + encodeURIComponent(JSON.stringify(payload));
}

// Nobody to send to: say so, and open "Set up sending".
function pickupNeedRecipients(status) {
  status.textContent = "There's no one to send to yet. Put at least one mobile number or email address in \u201cSet up sending\u201d.";
  const box = pickupEl("pickupSending");
  box.open = true;
  box.scrollIntoView({ block: "start", behavior: "smooth" });
}

async function pickupSendNow() {
  const d = pickupFromScreen();
  pickupSave(d);
  const btn = pickupEl("pickupSendNow");
  const status = pickupEl("pickupStatus");
  const r = pickupRecipients(d);
  if (!r.texts.length && !r.emails.length) { pickupNeedRecipients(status); return; }
  btn.disabled = true;
  if (d.includePosition && pickup.watching) {
    status.textContent = "Getting your position…";
    await pickupWaitForPosition(PICKUP_POSITION_WAIT_MS);
  }
  const going = pickupGoing();
  const message = pickupMessage(d, going);
  try { localStorage.setItem(PICKUP_LAST_KEY, new Date().toISOString()); } catch { /* ignore */ }
  status.textContent = `Opening the "${PICKUP_SHORTCUT}" shortcut to send it… If nothing happens, the shortcut hasn't been added yet: see \u201cSet up sending\u201d below.`;
  btn.disabled = false;
  pickupRender();
  pickupRenderButton();
  pickupRunShortcut(message, going.length ? "Pickup needed" : "Called out", r);
}

// Sends to everyone on the list, headed TEST, so the iPhone asks its
// permission question now rather than during a callout, and the people
// on the list see what a real message looks like.
async function pickupSendTest() {
  const d = pickupFromScreen();
  pickupSave(d);
  const status = pickupEl("pickupTestStatus");
  const r = pickupRecipients(d);
  if (!r.texts.length && !r.emails.length) {
    status.textContent = "Put in at least one mobile number or email address first.";
    return;
  }
  if (d.includePosition && pickup.watching) {
    status.textContent = "Getting your position…";
    await pickupWaitForPosition(PICKUP_POSITION_WAIT_MS);
  }
  const going = pickupGoing().map(p => ({ ...p, time: p.time || "15:00" }));
  const message = "TEST from Cloude \u2014 please ignore, nothing has happened.\n\n" +
    "If I'm ever called out and can't do a pickup, you'll get a message like this from me:\n\n" +
    "\u2014\u2014\u2014\n" + pickupMessage(d, going);
  status.textContent = `Opening the "${PICKUP_SHORTCUT}" shortcut… The first time, the iPhone asks whether it may send messages: tap Always Allow. If nothing happens, do step 1 first.`;
  pickupRunShortcut(message, "TEST from Cloude \u2014 please ignore", r);
}

function pickupDeleteAll() {
  if (!confirm("Delete all the saved pickups, wording, numbers and email addresses? (The Cloude Send shortcut stays in the Shortcuts app.)")) return;
  try { localStorage.removeItem(PICKUP_DETAILS_KEY); localStorage.removeItem(PICKUP_LAST_KEY); } catch { /* ignore */ }
  pickupClose();
}

(function pickupInit() {
  const btn = pickupEl("pickupButton");
  if (!btn) return;
  btn.addEventListener("click", pickupOpen);
  pickupEl("pickupClose").addEventListener("click", pickupClose);
  pickupEl("pickupAdd").addEventListener("click", pickupAddRow);
  ["pickupIfUnable", "pickupOpening", "pickupCalledOut"].forEach(id => pickupEl(id).addEventListener("input", pickupChanged));
  pickupEl("pickupIncludePos").addEventListener("change", pickupChanged);
  for (let i = 0; i < PICKUP_MAX_RECIPIENTS; i++) {
    pickupEl(`pickupText${i}`).addEventListener("input", pickupChanged);
    pickupEl(`pickupEmail${i}`).addEventListener("input", pickupChanged);
  }
  pickupEl("pickupSendTest").addEventListener("click", pickupSendTest);
  pickupEl("pickupGetShortcut").href = PICKUP_SHORTCUT_LINK;
  pickupEl("pickupSendNow").addEventListener("click", pickupSendNow);
  pickupEl("pickupDelete").addEventListener("click", pickupDeleteAll);
  pickupRenderButton();
})();
