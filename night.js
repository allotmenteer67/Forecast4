// Night mode for the Callout screen and the Coast map: the whole page
// turned to dim red, to keep night vision when looking at the phone in
// the dark (red light upsets dark-adapted eyes least). One setting for
// both pages, kept on this device until switched off.
//
// Loaded in the <head> so the page never flashes white-and-blue first.
// The look is one filter on the whole page (the "nightRed" SVG filter
// written at the top of each page's <body>): every colour, the map
// included, becomes a shade of pure red by its brightness, with no green
// or blue at all. Brighter things stay brighter, so the map's light and
// dark differences still read; dark backgrounds stay near black.

const NIGHT_KEY = "cloude-callout:night";

(function () {
  const css =
    "html.night { filter: url(#nightRed); background: #000; }" +
    "html.night body { background: #000; }" +
    ".night-toggle { display: inline-flex; align-items: center; justify-content: center; gap: 5px; }" +
    ".night-toggle svg { width: 18px; height: 18px; flex-shrink: 0; }";
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
  let on = false;
  try { on = localStorage.getItem(NIGHT_KEY) === "1"; } catch { /* ignore */ }
  document.documentElement.classList.toggle("night", on);
})();

function nightIsOn() { return document.documentElement.classList.contains("night"); }

function setNight(on) {
  document.documentElement.classList.toggle("night", on);
  try { on ? localStorage.setItem(NIGHT_KEY, "1") : localStorage.removeItem(NIGHT_KEY); } catch { /* ignore */ }
  document.querySelectorAll(".night-toggle").forEach(b => {
    b.setAttribute("aria-pressed", on ? "true" : "false");
    const label = b.querySelector(".night-label");
    if (label) label.textContent = on ? "Day" : "Night";
  });
}

document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll(".night-toggle").forEach(b => b.addEventListener("click", () => setNight(!nightIsOn())));
  setNight(nightIsOn());
});
