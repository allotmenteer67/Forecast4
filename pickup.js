// "Can't do pickup" — one button on the Callout screen that texts the
// people who'd collect a child (or dog) when the user is called out.
//
// How the sending works: a web app isn't allowed to send a text by
// itself, and anything that switches to another app (Messages, or
// running a shortcut by its shortcuts:// link) means coming back by
// hand. The one route that stays inside Cloude is the share sheet:
// a shortcut picked there runs in the share panel, over Cloude.
//
// So Send now does two things in the same tap:
//   1. copies the message to the clipboard, and
//   2. opens the share panel with the numbers as its text
//      ("07700900123, 07700900456").
// The user taps "Cloude Send" in the panel. That shortcut is ONE
// action, shared to everyone from an iCloud link (PICKUP_SHORTCUT_LINK):
//   Send [Clipboard] to [Shortcut Input]   (Show Compose Sheet off,
//                                           Show in Share Sheet on)
// Both filled from the press-and-hold menu, so there are no variables
// to pick. One run texts every number in the shared line (tested: two
// numbers, two texts). Messages never opens, the panel closes, and
// Cloude is still on the same page. The text leaves from the user's own
// number. The message overwrites whatever was on the clipboard.
//
// History, so nobody goes round this loop again:
//   v121  JSON to a dictionary-reading shortcut by shortcuts:// link,
//         plus email. Never sent: "Texts" had been TYPED into the
//         Recipients box as a word, and Shortcuts dialled it as keypad
//         digits (T-E-X-T-S = 83987). The Recipients box can't easily
//         take a variable at all.
//   v122  sms:/mailto: links opening Messages and Mail filled in: too
//         much switching and tapping.
//   v124  six-action version of v121, texts only: same Recipients
//         problem ("numbers" = 6862377).
//   v125  the share-sheet design above.
//
// If it ever doesn't send, "If not sent" opens Messages with the
// numbers and message filled in, to send by hand.
//
// The numbers (up to 3) are typed into Cloude itself, in "Who gets the
// message", and kept on this phone. No server is involved.
//
// Stored on this device only (and copied into whole-device backups,
// see BACKUP_KEY_PREFIXES in app.js):
//   cloude-pickup:details   the saved wording and numbers, kept until changed or deleted;
//                           also setup: { shortcutTapped, ready } — the first-time
//                           set-up card shows at the top until a test has gone through
//   cloude-pickup:lastSent  when the last message was sent
//
// Several pickups can be saved (a child from the carer, the dog from
// the kennels, another child from gymnastics), each with who and from
// where. At send time only the times are typed, one per pickup; a
// blank time makes the message say "Check pickup time".
// Each pickup can be left out for one callout ("Include" untick)
// without deleting it. Times and Include ticks are never saved: every
// opening starts with all pickups included and no times.

const PICKUP_DETAILS_KEY = "cloude-pickup:details";
const PICKUP_LAST_KEY = "cloude-pickup:lastSent";
const PICKUP_MAX_RECIPIENTS = 3;
const PICKUP_SHORTCUT = "Cloude Send";
// The shared one-action shortcut. An iCloud link is a snapshot: after
// any change to the shortcut it has to be shared again and the new link
// put here. Empty = not shared yet, and the "Get the shortcut" button
// stays hidden.
const PICKUP_SHORTCUT_LINK = "https://www.icloud.com/shortcuts/68f69ebe69654eee9a4a5e998a2aa1a8";
const PICKUP_DEFAULT_OPENING = "I've been called out on the lifeboat and can't do the pickup.";
// Sent instead when no pickup is named or ticked: just "called out".
const PICKUP_DEFAULT_CALLED_OUT = "I've been called out on the lifeboat. No pickups needed — just letting you know.";
// (No waiting for a position at Send any more: the share panel has to
// open in the same instant as the tap, or iOS refuses it. The position
// search starts when this screen opens, so it's normally found by the
// time Send is tapped; if not, the message says it wasn't available.)

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
    delete d.emails; // email was dropped in v124
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

// The usable numbers, plus a count of boxes with something in them
// that doesn't look like a mobile number.
function pickupRecipients(d) {
  const texts = [];
  let badTexts = 0;
  (d.texts || []).forEach(v => {
    if (!String(v || "").trim()) return;
    const n = pickupCleanNumber(v);
    if (n) { if (!texts.includes(n)) texts.push(n); } else badTexts++;
  });
  return { texts, badTexts };
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
  prepared: null,   // { message, numbers, at } — the last message sent, for "If not sent"
  setup: { shortcutTapped: false, ready: false }, // first-time set-up progress (saved with the details)
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
      : `${p.who}${from} — check pickup time`;
  };
  if (list.length === 1) {
    const p = list[0];
    const from = p.where ? ` from ${p.where}` : "";
    if (p.time) {
      lines.push(`Please pick up ${p.who}${from} at ${p.time}.`);
    } else {
      lines.push(`Please pick up ${p.who}${from}. Check pickup time.`);
    }
  } else {
    lines.push("Please pick up:\n" + list.map(p => "• " + item(p)).join("\n"));
  }
  if ((d.ifUnable || "").trim()) lines.push(`If you can't, please contact ${d.ifUnable.trim()}.`);
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
      : `Set up "Can't do pickup"<small>One-tap text to whoever can collect</small>`;
  let lastText = "";
  try {
    const t = Date.parse(localStorage.getItem(PICKUP_LAST_KEY) || "");
    if (Number.isFinite(t)) {
      const when = new Date(t);
      const today = when.toDateString() === new Date().toDateString();
      lastText = `Last pickup message sent ${today ? "today" : when.toLocaleDateString("en-GB", { day: "numeric", month: "short" })} at ${when.toTimeString().slice(0, 5)}.`;
    }
  } catch { /* ignore */ }
  if (last) { last.textContent = lastText; last.hidden = !lastText; }
}

function pickupDefaults() {
  return { opening: PICKUP_DEFAULT_OPENING, calledOut: PICKUP_DEFAULT_CALLED_OUT, pickups: [], ifUnable: "", includePosition: true, texts: [] };
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
    pickupEl(`pickupText${i}`).value = (d.texts || [])[i] || "";
  }
  pickup.setup = {
    shortcutTapped: !!(d.setup && d.setup.shortcutTapped),
    // Anyone who'd already sent before this card existed counts as set up.
    ready: !!(d.setup && d.setup.ready) || !!(saved && saved.setup === undefined && localStorage.getItem(PICKUP_LAST_KEY)),
  };
  pickupEl("pickupSending").open = false;
  pickupEl("pickupSetupDone").hidden = true;
  pickupEl("pickupSetupSteps").hidden = false;
  pickupEl("pickupHideSetup").hidden = false;
  pickupPlaceSetup();
  pickupEl("pickupStatus").textContent = "";
  pickupEl("pickupTestStatus").textContent = "";
  pickup.prepared = null;
  pickupEl("pickupFallback").hidden = true;
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
      <p class="no-time"${r.time ? " hidden" : ""}>If no time set, the message will say \u201cCheck pickup time\u201d.</p>`;
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
    setup: { ...pickup.setup },
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
  const n = r.texts.length;
  pickupEl("pickupTo").textContent = n
    ? `Goes by text to ${n === 1 ? "1 number" : `${n} numbers`}.`
    : "No one to send to yet — fill in \u201cWho gets the message\u201d below.";
  pickupEl("pickupTo").classList.toggle("warn", !n);
  pickupEl("pickupSendingSummary").textContent = n
    ? `Who gets the message (${n === 1 ? "1 number" : `${n} numbers`})`
    : "Who gets the message (not set yet)";
  pickupEl("pickupRecipientsCheck").textContent = r.badTexts
    ? `${r.badTexts === 1 ? "1 number doesn't" : `${r.badTexts} numbers don't`} look right (a mobile needs all 11 digits, like 07700 900123), so it will be left out.`
    : "";
  pickupEl("pickupRecipientsCheck").hidden = !r.badTexts;
  pickupEl("pickupStep1").classList.toggle("done", pickup.setup.shortcutTapped);
  pickupEl("pickupStep2").classList.toggle("done", n > 0);
  const posLine = pickupEl("pickupPosState");
  if (!d.includePosition) posLine.textContent = "Position: not included (see More options).";
  else if (pickup.pos) posLine.textContent = `Position found, to about ${Math.max(5, Math.round(pickup.pos.acc))} m.`;
  else if (pickup.posError) posLine.textContent = `Position ${pickup.posError} — the message will say so.`;
  else posLine.textContent = "Getting your position…";
}
// Position updates call this name.
function pickupRenderPreview() { if (!pickupEl("pickupSheet").hidden) pickupRender(); }

// Copies the message and opens the share panel with the numbers, all
// in the tap itself (see the top of this file). Resolves "sent",
// "closed" (panel dismissed without choosing) or "unsupported".
async function pickupShare(message, numbers) {
  pickup.prepared = { message, numbers, at: new Date() };
  pickupEl("pickupFallback").hidden = false;
  // Both calls start before any await, so they count as part of the tap.
  const copied = navigator.clipboard && navigator.clipboard.writeText
    ? navigator.clipboard.writeText(message).then(() => true, () => false)
    : Promise.resolve(false);
  if (!navigator.share) return "unsupported";
  const shared = navigator.share({ text: numbers.join(", ") });
  if (!(await copied)) return "nocopy";
  try {
    await shared;
    return "sent";
  } catch (err) {
    return err && err.name === "AbortError" ? "closed" : "unsupported";
  }
}

function pickupShareOutcome(result, status, what) {
  const at = pickupClock(new Date());
  if (result === "sent") {
    status.textContent = `${what} at ${at}. If it didn't arrive, tap \u201cIf not sent\u201d.`;
  } else if (result === "closed") {
    status.textContent = "Not sent: the share panel was closed. Tap Send again and choose \u201cCloude Send\u201d in the panel.";
  } else if (result === "nocopy") {
    status.textContent = "Couldn't copy the message, so nothing was sent. Use \u201cIf not sent\u201d to send it from Messages.";
  } else {
    status.textContent = "This phone can't open the share panel from Cloude. Use \u201cIf not sent\u201d to send it from Messages.";
  }
}

// "If not sent": the same message, opened in Messages to send by hand.
// More than one number makes a group message.
function pickupFallback() {
  const p = pickup.prepared;
  if (!p) return;
  pickupEl("pickupStatus").textContent = "Messages is opening with everything filled in: tap Send.";
  window.location.href = "sms:/open?addresses=" + p.numbers.map(encodeURIComponent).join(",") +
    "&body=" + encodeURIComponent(p.message);
}

// The set-up card sits at the top until a test has gone through. The
// number boxes live in it during set-up, and in "Who gets the message"
// at the bottom afterwards (the same boxes, moved, never duplicated).
function pickupPlaceSetup() {
  const ready = pickup.setup.ready;
  pickupEl("pickupSetupCard").hidden = ready && pickupEl("pickupSetupDone").hidden;
  pickupEl("pickupSending").hidden = !ready;
  const slot = pickupEl(ready ? "pickupNumbersSlotBottom" : "pickupNumbersSlotTop");
  const numbers = pickupEl("pickupNumbers");
  if (numbers.parentNode !== slot) slot.appendChild(numbers);
}

function pickupSetupChanged(change) {
  Object.assign(pickup.setup, change);
  pickupSave(pickupFromScreen());
  pickupRender();
}

// Nobody to send to: say so, and show where the numbers go.
function pickupNeedRecipients(status) {
  status.textContent = pickup.setup.ready
    ? "There's no one to send to yet. Put at least one mobile number in \u201cWho gets the message\u201d."
    : "There's no one to send to yet. Do the set-up steps at the top first.";
  const box = pickup.setup.ready ? pickupEl("pickupSending") : pickupEl("pickupSetupCard");
  if (pickup.setup.ready) box.open = true;
  box.scrollIntoView({ block: "start", behavior: "smooth" });
}

function pickupClock(d) { return d.toTimeString().slice(0, 5); }

// Not async up to pickupShare(): everything before it must happen in
// the tap itself.
function pickupSendNow() {
  const d = pickupFromScreen();
  pickupSave(d);
  const status = pickupEl("pickupStatus");
  const r = pickupRecipients(d);
  if (!r.texts.length) { pickupNeedRecipients(status); return; }
  const message = pickupMessage(d, pickupGoing());
  status.textContent = "In the share panel, tap \u201cCloude Send\u201d.";
  pickupShare(message, r.texts).then(result => {
    if (result === "sent") {
      try { localStorage.setItem(PICKUP_LAST_KEY, new Date().toISOString()); } catch { /* ignore */ }
      pickupRenderButton();
    }
    pickupShareOutcome(result, status, "Sent");
  });
}

// A practice run, headed TEST, so the people on the list see what a
// real one looks like, and the iPhone asks its one-off permission
// questions now rather than at a callout.
function pickupSendTest() {
  const d = pickupFromScreen();
  pickupSave(d);
  const status = pickupEl("pickupTestStatus");
  const r = pickupRecipients(d);
  if (!r.texts.length) {
    status.textContent = "Put in at least one mobile number in step 2 first.";
    return;
  }
  const going = pickupGoing().map(p => ({ ...p, time: p.time || "15:00" }));
  const message = "TEST from Cloude \u2014 please ignore, nothing has happened.\n\n" +
    "If I'm ever called out and can't do a pickup, you'll get a text like this from me:\n\n" +
    "\u2014\u2014\u2014\n" + pickupMessage(d, going);
  pickupEl("pickupStatus").textContent = "";
  status.textContent = "Now follow a\u2013d below in the panel that slides up.";
  pickupShare(message, r.texts).then(result => {
    pickupShareOutcome(result, status, "Test sent");
    if (result === "sent") {
      // Set up for good: tick everything off, then fold the card away
      // (it stays hidden from the next opening on).
      pickupSetupChanged({ ready: true, shortcutTapped: true });
      pickupEl("pickupSetupSteps").hidden = true;
      pickupEl("pickupHideSetup").hidden = true;
      pickupEl("pickupSetupDone").hidden = false;
      pickupPlaceSetup();
    }
  });
}

function pickupDeleteAll() {
  if (!confirm("Delete all the saved pickups, wording and numbers?")) return;
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
  }
  pickupEl("pickupSendTest").addEventListener("click", pickupSendTest);
  pickupEl("pickupFallback").addEventListener("click", pickupFallback);
  pickupEl("pickupGetShortcut").href = PICKUP_SHORTCUT_LINK;
  pickupEl("pickupGetShortcut").addEventListener("click", () => pickupSetupChanged({ shortcutTapped: true }));
  // "Hide these steps": closes the set-up box whether or not a test has
  // gone through ("Show the set-up steps again" at the bottom brings it
  // back). The numbers move down into "Who gets the message".
  pickupEl("pickupHideSetup").addEventListener("click", () => {
    pickupSetupChanged({ ready: true });
    pickupEl("pickupSetupDone").hidden = true;
    pickupPlaceSetup();
    pickupEl("pickupSheet").scrollTop = 0;
  });
  pickupEl("pickupShowSetup").addEventListener("click", () => {
    pickupSetupChanged({ ready: false });
    pickupEl("pickupSetupSteps").hidden = false;
    pickupEl("pickupSetupDone").hidden = true;
    pickupEl("pickupHideSetup").hidden = false;
    pickupEl("pickupTestStatus").textContent = "";
    pickupPlaceSetup();
    pickupEl("pickupSheet").scrollTop = 0;
  });
  pickupEl("pickupSendNow").addEventListener("click", pickupSendNow);
  pickupEl("pickupDelete").addEventListener("click", pickupDeleteAll);
  pickupRenderButton();
})();
