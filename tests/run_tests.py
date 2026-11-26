#!/usr/bin/env python3
"""Cloude test kit — run by Claude in its own workspace, not on a phone.

    python3 tests/run_tests.py            # everything
    python3 tests/run_tests.py coast      # only checks whose name contains "coast"

Serves this repo locally, opens pages in a phone-sized headless Chromium
(Playwright) and checks behaviour. Outside sites are blocked unless
LIVE=1 is set, so results don't depend on today's weather or tide; tide
is replaced by a pretend one where a check needs it.

Add a check for every bug fixed, so it can't quietly come back.
Screenshots go to tests/out/ (not committed).
"""
import functools, http.server, json, os, re, socketserver, subprocess, sys, threading, traceback
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "tests" / "out"; OUT.mkdir(exist_ok=True)
PORT = 8765
BASE = f"http://127.0.0.1:{PORT}"
LIVE = os.environ.get("LIVE") == "1"
PHONE = {"width": 375, "height": 667}  # iPhone SE: the smallest screen in use

SERVED = []  # every path the local server was asked for (sw check counts these)
def serve():
    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *a): pass
        def do_GET(self):
            SERVED.append(self.path); super().do_GET()
        def end_headers(self):
            # Like GitHub Pages, so the browser's own cache behaves the same.
            self.send_header("Cache-Control", "max-age=600"); super().end_headers()
    H = functools.partial(Quiet, directory=str(ROOT))
    socketserver.TCPServer.allow_reuse_address = True
    s = socketserver.ThreadingTCPServer(("127.0.0.1", PORT), H)
    threading.Thread(target=s.serve_forever, daemon=True).start()

CHECKS = []
def check(fn): CHECKS.append(fn); return fn

class Fail(Exception): pass
def expect(cond, msg):
    if not cond: raise Fail(msg)

# ---------- checks that need no browser ----------

@check
def js_syntax_all_files():
    bad = []
    for f in sorted(ROOT.glob("*.js")):
        r = subprocess.run(["node", "--check", str(f)], capture_output=True, text=True)
        if r.returncode: bad.append(f"{f.name}: {r.stderr.strip().splitlines()[-1]}")
    expect(not bad, "; ".join(bad))

@check
def sw_shell_files_exist_and_pages_covered():
    sw = (ROOT / "sw.js").read_text()
    files = set(re.findall(r'"([^"]+)"', re.search(r"SHELL_FILES\s*=\s*\[(.*?)\]", sw, re.S).group(1)))
    missing = [f for f in files if not (ROOT / f).exists()]
    expect(not missing, f"in SHELL_FILES but not in repo: {missing}")
    refs = set()
    for h in ROOT.glob("*.html"):
        if h.name.startswith("prepare-"): continue
        for r in re.findall(r'(?:src|href)="([^"#?:]+)"', h.read_text()):
            if not r.startswith(("http", "data:")) and (ROOT / r).is_file(): refs.add(r)
    expect(not (refs - files), f"used by pages but not cached for offline: {sorted(refs - files)}")

@check
def no_tokens_in_repo():
    hits = []
    for f in ROOT.rglob("*"):
        if ".git" in f.parts or not f.is_file() or f.stat().st_size > 2_000_000: continue
        try: t = f.read_text(errors="ignore")
        except Exception: continue
        if re.search(r"github_pat_[A-Za-z0-9_]{20,}|ghp_[A-Za-z0-9]{30,}", t): hits.append(str(f.relative_to(ROOT)))
    expect(not hits, f"possible GitHub token in: {hits}")

TIDE_NODE = r"""
const fs = require('fs'), vm = require('vm');
const store = {};
const ctx = { console, Date, Math, JSON,
  localStorage: { getItem: k => store[k] ?? null, setItem: (k, v) => store[k] = String(v), removeItem: k => delete store[k] } };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(process.argv[1] + '/tide.js', 'utf8'), ctx);
const T = n => vm.runInContext(n, ctx);
const out = {};
// Gauge choice: Charmouth goes to Plymouth (as Admiralty does), Weymouth itself keeps Weymouth.
out.charmouth = T('nearestTideStation')(50.7376, -2.9015).label;
out.weymouth = T('nearestTideStation')(50.61, -2.45).label;
out.lulworth = T('nearestTideStation')(50.62, -2.25).label;
// A place saved on Weymouth moves to Plymouth, and its old Weymouth-learned correction goes.
store['cloude-tide:locations'] = JSON.stringify([{ id: 'a', label: 'Charmouth, Dorset', lat: 50.7376, lon: -2.9015,
  station: { id: 'E72039', label: 'Weymouth', cdOffsetOD: -0.93 }, discoveryStation: { id: '0024' } }]);
store['cloude-tide:secondary:0024'] = '{}';
out.moved = T('loadTideLocations')()[0].station.label;
out.offsetCleared = !('cloude-tide:secondary:0024' in store);
// A pretend gauge with a stand at low water (M2 plus a strong M4), and a
// correction whose high and low parts differ a lot (like Lyme Regis vs
// Plymouth). The place's curve must have exactly the gauge's real highs
// and lows, no extra ones.
const k = 1 + 2 * 8; const coeffs = new Array(1 + 2 * 10).fill(0);
coeffs[1] = 2.0; coeffs[k] = 0.55;
const fit = { coeffs }; const st = { cdOffsetOD: -3.22 };
const off = { highTimeMin: 68, highHeightSlope: 1.48, highHeightIntercept: -3.7,
              lowTimeMin: 23, lowHeightSlope: 0.82, lowHeightIntercept: -0.4 };
const gaugeEvents = T('significantTideExtremes')(T('findTideExtremes')(fit, 12, 60));
const pts = [];
for (let h = 13; h <= 59; h += 1 / 12) { const r = T('applySecondaryOffset')(fit, h, T('predictTideLevel')(fit, h), st, off); if (r) pts.push(r); }
let turns = 0, backwards = 0;
for (let i = 1; i < pts.length - 1; i++) {
  const a = pts[i - 1].levelCD, b = pts[i].levelCD, c = pts[i + 1].levelCD;
  if ((b > a && b >= c) || (b < a && b <= c)) turns++;
  if (pts[i].hours < pts[i - 1].hours) backwards++;
}
out.gaugeEvents = gaugeEvents.filter(e => e.hours > 13 && e.hours < 59).length;
out.placeTurns = turns; out.backwards = backwards;
console.log(JSON.stringify(out));
"""

@check
def tide_place_curve_has_no_false_highs_or_lows():
    r = subprocess.run(["node", "-e", TIDE_NODE, str(ROOT)], capture_output=True, text=True)
    expect(r.returncode == 0, r.stderr.strip()[-300:])
    o = json.loads(r.stdout)
    expect(o["charmouth"] == "Plymouth", f"Charmouth's gauge is {o['charmouth']}, should be Plymouth")
    expect(o["weymouth"] == "Weymouth" and o["lulworth"] == "Weymouth", f"places by Weymouth should keep it: {o}")
    expect(o["moved"] == "Plymouth" and o["offsetCleared"], f"saved Charmouth not moved off Weymouth: {o}")
    expect(o["placeTurns"] == o["gaugeEvents"], f"place curve has {o['placeTurns']} highs/lows, gauge has {o['gaugeEvents']}")
    expect(o["backwards"] == 0, "place curve's times run backwards somewhere")

TIDE_DIFF_NODE = r"""
const fs = require('fs'), vm = require('vm');
const store = {};
const ctx = { console, Date, Math, JSON,
  localStorage: { getItem: k => store[k] ?? null, setItem: (k, v) => store[k] = String(v), removeItem: k => delete store[k] } };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(process.argv[1] + '/tide.js', 'utf8'), ctx);
const T = n => vm.runInContext(n, ctx);
const out = {};
// Table interpolation: Little Haven low water is +25 at 01:00/13:00 GMT, +15 at 07:00/19:00.
const lh = T('timeDifferenceByName')('Little Haven');
const at = (h, m) => Date.UTC(2026, 10, 12, h, m);
out.lw0100 = T('tableTimeDifferenceMin')(lh, 'low', at(1, 0));
out.lw0700 = T('tableTimeDifferenceMin')(lh, 'low', at(7, 0));
out.lw0400 = T('tableTimeDifferenceMin')(lh, 'low', at(4, 0));
out.lw2200 = T('tableTimeDifferenceMin')(lh, 'low', at(22, 0));
// A pretend gauge (M2 + S2) moved to Ramsey Sound (+30 for all): each high and low 30 minutes later, same height.
const coeffs = new Array(1 + 2 * 10).fill(0); coeffs[0] = 0.1; coeffs[1] = 2.5; coeffs[3] = 0.8;
const epochIso = new Date(Date.now() - 10 * 86400000).toISOString();
const built = { fit: { coeffs, names: T('TIDE_CONSTITUENTS').map(c => c.name) }, epochIso };
const made = T('timeDifferenceFit')(built, T('timeDifferenceByName')('Ramsey Sound'));
const nowH = 10 * 24;
const g = T('significantTideExtremes')(T('findTideExtremes')(built.fit, nowH, nowH + 48));
const p = T('significantTideExtremes')(T('findTideExtremes')(made.fit, nowH, nowH + 49));
out.shifts = g.map(e => { const q = p.find(x => x.type === e.type && Math.abs(x.hours - e.hours) < 2); return q ? Math.round((q.hours - e.hours) * 60) : null; });
out.heights = g.map(e => { const q = p.find(x => x.type === e.type && Math.abs(x.hours - e.hours) < 2); return q ? +(q.level - e.level).toFixed(2) : null; });
out.rms = made.rmsM;
out.nearLittleHaven = (T('nearestTimeDifference')(51.775, -5.11, 'E73039') || {}).name;
out.nearFishguard = T('nearestTimeDifference')(52.01, -4.98, 'E73039');
console.log(JSON.stringify(out));
"""

@check
def tide_published_time_differences():
    r = subprocess.run(["node", "-e", TIDE_DIFF_NODE, str(ROOT)], capture_output=True, text=True)
    expect(r.returncode == 0, r.stderr.strip()[-300:])
    o = json.loads(r.stdout)
    expect(o["lw0100"] == 25 and o["lw0700"] == 15 and abs(o["lw0400"] - 20) < 0.01, f"table interpolation wrong: {o}")
    expect(abs(o["lw2200"] - 20) < 0.01, f"22:00 low water should be halfway from 19:00 to 01:00: {o['lw2200']}")
    expect(all(s is not None and abs(s - 30) <= 3 for s in o["shifts"]), f"Ramsey Sound highs/lows not 30 min after the gauge: {o['shifts']}")
    expect(all(h is not None and abs(h) <= 0.05 for h in o["heights"]), f"heights changed: {o['heights']}")
    expect(o["nearLittleHaven"] == "Little Haven" and o["nearFishguard"] is None, f"nearest table place wrong: {o}")

LONG_RECORD_NODE = r"""
const fs = require('fs'), vm = require('vm');
const ctx = { console, Date, Math, JSON, localStorage: { getItem: () => null, setItem() {}, removeItem() {} } };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(process.argv[1] + '/tide.js', 'utf8'), ctx);
const T = n => vm.runInContext(n, ctx);
const rec = JSON.parse(fs.readFileSync(process.argv[1] + '/data/tide-gauges/E73039.json'));
const all = []; rec.cm.forEach((v, i) => { if (v !== null) all.push({ hours: i, level: v / 100 }); });
const end = all[all.length - 1].hours, cut = end - 21 * 24;
const train = all.filter(r => r.hours < cut), test = all.filter(r => r.hours >= cut);
const rms = fit => Math.sqrt(test.reduce((s, r) => s + (r.level - T('predictTideLevel')(fit, r.hours)) ** 2, 0) / test.length);
const four = T('fitTideHarmonics')(train.filter(r => r.hours >= cut - 28 * 24));
const year = T('fitTideHarmonicsRobust')(train, T('TIDE_CONSTITUENTS_LONG'));
console.log(JSON.stringify({ days: all.length / 24, four: rms(four), year: rms(year) }));
"""

@check
def tide_long_record_beats_four_weeks():
    # Milford Haven: a year's fit should predict the next three weeks
    # better than a four-week one (it was 0.28 m against 0.19 m, Nov 2026).
    # Skipped until the GitHub job has saved the records.
    if not (ROOT / "data" / "tide-gauges" / "E73039.json").exists():
        print("        (no data/tide-gauges yet — skipped)"); return
    r = subprocess.run(["node", "-e", LONG_RECORD_NODE, str(ROOT)], capture_output=True, text=True)
    expect(r.returncode == 0, r.stderr.strip()[-300:])
    o = json.loads(r.stdout)
    expect(o["days"] > 300, f"only {o['days']:.0f} days in the Milford Haven record")
    expect(o["year"] < o["four"] * 0.9, f"year fit {o['year']:.3f} m not better than four-week {o['four']:.3f} m")

# ---------- browser checks ----------

def new_page(browser, night=False):
    ctx = browser.new_context(viewport=PHONE, device_scale_factor=2, is_mobile=True, has_touch=True)
    if not LIVE:
        ctx.route(lambda u: not u.startswith(BASE), lambda r: r.abort())
    pg = ctx.new_page()
    pg.errors = []
    pg.on("pageerror", lambda e: pg.errors.append(str(e)))
    pg.on("dialog", lambda d: d.accept())
    return pg

PRETEND_TIDE = """(()=>{const t0=Date.now();
  tideOdAt = d => 0.15 - 3.15*Math.cos(2*Math.PI*(d.getTime()-t0)/(12.42*3600e3)); // low water now
  coast.tide = coast.tide || {cdOffset:null,label:'pretend',fit:null}; buildSeries();})()"""

def coast(browser, area="stbrides", tide=True):
    pg = new_page(browser)
    pg.goto(f"{BASE}/coast.html?area={area}"); pg.wait_for_timeout(2500)
    if tide: pg.evaluate(PRETEND_TIDE)
    return pg

def enter(pg, tab, **kw):
    pg.click("#coastPosBtn"); pg.wait_for_timeout(120)
    pg.click({"latlon": "#entTabLatLon", "grid": "#entTabGrid", "place": "#entTabPlace"}[tab])
    if tab == "latlon": pg.fill("#entLatLonInput", kw["text"])
    if tab == "grid": pg.fill("#entGridInput", kw["text"])
    if tab == "place":
        pg.fill("#entPlaceInput", kw["place"]); pg.wait_for_timeout(150)
        pg.click(f'#entPlaceList button >> text={kw["place"]}')
        if "dir" in kw: pg.click(f'#entDirs button[data-dir={kw["dir"]}]')
        pg.fill("#entBearing", kw.get("bearing", "")) if "bearing" in kw else None
        pg.fill("#entDist", kw.get("dist", ""))
        if "unit" in kw: pg.click(f'#entUnits button[data-unit={kw["unit"]}]')
    if kw.get("new") and pg.is_visible("#entAsNew"): pg.check("#entAsNew")
    pg.wait_for_timeout(100)
    preview = pg.inner_text("#entPreview")
    if kw.get("go", True): pg.click("#entGo"); pg.wait_for_timeout(700)
    return preview

@check
def coast_latlon_parsing(browser):
    pg = coast(browser, tide=False)
    cases = {
        "51 46.2N 5 08.7W": (51.77, -5.145), "51-46.2N 5-08.7W": (51.77, -5.145),
        "51.46.2N 5.08.7W": (51.77, -5.145), "5146.2N 00508.7W": (51.77, -5.145),
        "51.770 -5.145": (51.77, -5.145), "51 46 12N 5 08 42W": (51.77, -5.145),
        "51 75.0N 5 08.7W": None,
    }
    for text, want in cases.items():
        got = pg.evaluate("t => parseLatLon(t)", text)
        if want is None: expect(got is None, f"{text!r} should be refused, got {got}")
        else: expect(got and abs(got["lat"] - want[0]) < 1e-6 and abs(got["lon"] - want[1]) < 1e-6, f"{text!r} -> {got}")
    expect("outside this map" in enter(pg, "latlon", text="-5.145 51.77", go=False), "off-map position not flagged")
    expect(not pg.errors, pg.errors)

@check
def coast_grid_refs(browser):
    pg = coast(browser, tide=False)
    g = pg.evaluate("parseGridRef('SM 812 093')")
    expect(abs(g["lat"] - 51.740048) < 2e-5 and abs(g["lon"] + 5.169794) < 2e-5, f"SM 812 093 -> {g}")
    expect(pg.evaluate("gridRefFromLatLon(51.775,-5.11,8)") == "SM 8554 1305", "lat/long -> grid ref wrong")
    expect(pg.evaluate("parseGridRef('SM8120093')") is None, "odd number of figures accepted")

@check
def coast_positions_bearings_and_card(browser):
    pg = coast(browser)
    enter(pg, "latlon", text="51 47.3N 5 09.4W")
    enter(pg, "grid", text="SM 812 093", new=True)
    enter(pg, "place", place="Broad Haven", dir="W", dist="2", unit="mi", new=True)
    pins = pg.evaluate("coast.pins.map(p=>[p.label,p.lat,p.lon,p.source||''])")
    expect(len(pins) == 3, f"expected 3 pins, got {pins}")
    # 2 statute miles W of Broad Haven, near enough (flat-earth maths over 3 km)
    expect(abs(pins[2][1] - 51.77994) < 0.0005 and abs(pins[2][2] + 5.1493) < 0.001, f"2 mi W of Broad Haven -> {pins[2]}")
    for name, b in [("Little Haven", "297"), ("Nolton Haven", "222")]:
        enter(pg, "place", place=name, bearing=b, dist="")
    fix = pg.evaluate("computeFix()")
    expect(fix and not fix.get("none"), "bearings didn't cross")
    # the crossing circle sits in the clear map between the tide box and the card
    y, top, bottom = pg.evaluate("(()=>{const f=computeFix();return [toScreen(f.centre.lat,f.centre.lon).y, mapTopInset(), coast.h-cardHeight()]})()")
    expect(abs(y - (top + bottom) / 2) < 6, f"circle at y={y}, clear area {top}-{bottom}")
    card = pg.inner_text("#coastPinCard")
    expect("Add a second bearing" not in card and "297°M" in card and "222°M" in card, f"card: {card!r}")
    pg.click('#coastPinCard [data-sel="1"]'); pg.wait_for_timeout(400)
    expect("Grid ref SM 812 093" in pg.inner_text(".pc-pos"), "grid-ref pin should show its grid ref only")
    pg.screenshot(path=str(OUT / "coast_card.png"))
    pg.evaluate("document.documentElement.classList.add('night')"); pg.wait_for_timeout(300)
    pg.screenshot(path=str(OUT / "coast_card_night.png"))
    expect(not pg.errors, pg.errors)

@check
def coast_dry_ground_and_open_way_off_follow_slider(browser):
    pg = coast(browser)
    enter(pg, "latlon", text="51.7815 -5.110")  # off Broad Haven beach
    now_card = pg.inner_text("#coastPinCard")
    expect("Nearest dry ground" in now_card and "Open way off" in now_card, now_card)
    pg.evaluate("(()=>{const s=$('coastSlider'); s.value=36; s.dispatchEvent(new Event('input'))})()"); pg.wait_for_timeout(900)
    later = pg.inner_text("#coastPinCard")
    expect("Dry ground at" in later, f"card didn't follow the slider: {later!r}")
    expect("cut by then" not in later or "all cut" in later, "showing a cut way off while an open one exists")
    stored = pg.evaluate("JSON.parse(localStorage.getItem('cloude-callout:spot')).shore")
    expect(stored and stored["distM"] < 250, "Callout copy should keep the now figures")
    pg.click("#coastAhead"); pg.wait_for_timeout(500)
    expect("Nearest dry ground" in pg.inner_text("#coastPinCard"), "tapping the time didn't return to now")
    allcut = pg.evaluate("pickWayOff({lat:51.7815,lon:-5.1045}, ()=>({state:'now'}), 'now')")
    expect(allcut["allCut"] and allcut["cut"] == "all cut now", f"all-cut case: {allcut}")

@check
def coast_weather_allowance(browser):
    pg = coast(browser)
    # Stockdon run-up: calm adds little, a big sea on a flat beach about a metre
    r = pg.evaluate("[waveRunupM(0.3,5,0.03), waveRunupM(3.5,11,0.02), waveRunupM(2.5,9,0.05)]")
    expect(r[0] < 0.2 and 0.9 < r[1] < 1.4 and 0.9 < r[2] < 1.3, f"run-up {r}")
    # surge: raised sea used, held 6 h then fading out by 24 h; lowered sea ignored
    pg.evaluate("coast.weather.surge = {m: 0.5, atMs: Date.now()}")
    s = pg.evaluate("[surgeAt(new Date()), surgeAt(new Date(Date.now()+15*3600e3)), surgeAt(new Date(Date.now()+25*3600e3))]")
    expect(abs(s[0] - 0.5) < 1e-6 and 0.2 < s[1] < 0.3 and s[2] == 0, f"surge over time {s}")
    pg.evaluate("coast.weather.surge = {m: -0.4, atMs: Date.now()}")
    expect(pg.evaluate("surgeAt(new Date())") == 0, "a lowered sea shouldn't be used")
    # with a stormy sea the beach pin's dry ground is further away and the card says why
    enter(pg, "latlon", text="51.7815 -5.108")  # just off the beach at low water
    pg.evaluate("coast.weather.surge = null; coast.weather.waves = null; weatherChanged()"); pg.wait_for_timeout(700)
    calm = pg.evaluate("coast.pin.shore.distM")
    pg.evaluate("coast.weather.surge = {m: 0.4, atMs: Date.now()}; const n=Math.floor(Date.now()/1000/3600)*3600; coast.weather.waves = {time:[n-3600,n,n+3600,n+7200], height:[3.5,3.5,3.5,3.5], period:[11,11,11,11]}; weatherChanged()")
    pg.wait_for_timeout(900)
    card = pg.inner_text("#coastPinCard")
    stormy = pg.evaluate("coast.pin.shore.distM")
    expect(stormy > calm and "for waves and surge" in card, f"calm {calm} m, stormy {stormy} m, card {card!r}")
    expect("sea +" in pg.inner_text("#coastTideSub"), "tide box should show the sea allowance")

@check
def coast_dry_ground_on_land_and_without_tide(browser):
    pg = coast(browser, tide=False)
    # No tide: outside sites are blocked, but the gauge records in
    # data/tide-gauges are served locally and can give the map a tide.
    pg.evaluate("coast.tide = null")
    r = pg.evaluate("(async()=>{const a=await nearestDryGround({lat:51.75936,lon:-5.13582}); const b=await nearestDryGround({lat:51.775,lon:-5.135}); return [a&&a.distM, b]})()")
    expect(r[0] == 0, f"field inland should be 'on dry ground', got {r[0]}")
    expect(r[1] is None, f"at sea with no tide there should be no answer, got {r[1]}")

@check
def coast_now_catches_up_after_sleep(browser):
    pg = coast(browser, tide=False)
    pg.evaluate("coast.baseTime -= 20*60000; document.dispatchEvent(new Event('visibilitychange'))")
    behind = pg.evaluate("Math.round((Date.now()-coast.baseTime)/60000)")
    expect(behind < 10, f"'now' still {behind} min behind after waking")
    expect(not pg.query_selector("#coastNow"), "the Time/Now row should be gone")

@check
def coast_little_haven_labelled(browser):
    pg = coast(browser, tide=False)
    expect(pg.evaluate("coast.names.findIndex(n=>n.name==='Little Haven') < coast.names.findIndex(n=>n.name==='Walton West')"),
           "villages should be labelled before hamlets")

@check
def coast_charmouth_loads(browser):
    pg = coast(browser, area="charmouth", tide=False)
    preview = enter(pg, "grid", text="SY 365 925")
    expect("50°43.75′N 2°54.02′W" in preview, preview)
    expect(not pg.errors, pg.errors)

@check
def coast_stbrides_uses_published_time_differences(browser):
    # With a (pretend) Milford Haven tide, the bay's tide is Little Haven's
    # from Admiralty's published differences, not the gauge's as is.
    pg = coast(browser, tide=False)
    pg.evaluate("""async () => {
      const coeffs = new Array(21).fill(0); coeffs[0] = 0.1; coeffs[1] = 2.5; coeffs[3] = 0.8;
      const fit = { coeffs, names: TIDE_CONSTITUENTS.map(c => c.name) };
      getOrBuildTideFit = async () => ({ fit, epochIso: new Date(Date.now() - 5 * 86400000).toISOString() });
      await loadTide();
    }""")
    pg.wait_for_timeout(1500)
    t = pg.evaluate("coast.tide && { label: coast.tide.zoneLabel, source: coast.tide.sourceText, moved: coast.tide.fit !== coast.tide.baseFit }")
    expect(t, "no tide on the map")
    expect(t["label"] == "Little Haven" and "published time differences" in t["source"] and t["moved"], f"bay tide not Little Haven's: {t}")
    expect(not pg.errors, f"page errors: {pg.errors}")

@check
def callout_loads(browser):
    pg = new_page(browser)
    pg.goto(f"{BASE}/callout.html"); pg.wait_for_timeout(2500)
    pg.screenshot(path=str(OUT / "callout.png"), full_page=True)
    expect(not pg.errors, pg.errors)

@check
def front_page_loads_and_visibility_label(browser):
    pg = new_page(browser)
    pg.goto(f"{BASE}/index.html"); pg.wait_for_timeout(3000)
    pg.screenshot(path=str(OUT / "front.png"))
    if pg.evaluate("typeof sunVisDistanceNumber") == "function":
        nums = pg.evaluate("[960, 9600, 10000].map(m => sunVisDistanceNumber(m) + ' ' + sunVisWord(m))")
        expect(nums == ["0.9 Very poor", "9 Moderate", "10 Good"], f"visibility number/word disagree: {nums}")
    expect(not pg.errors, pg.errors)

@check
def front_sun_and_cloud_follow_latest_runs(browser):
    # Nov 2026 bug: Sun hrs sat on 2 and Cloud on a grey cloud all day,
    # read from yesterday's runs. They now come from the latest hourly
    # runs over the 24/48h window, Sun hrs capped at daylight.
    pg = new_page(browser)
    pg.goto(f"{BASE}/index.html"); pg.wait_for_timeout(2500)
    res = pg.evaluate("""() => {
      const times = [];
      for (let d = 12; d <= 13; d++) for (let h = (d === 12 ? 14 : 0); h < 24; h++)
        times.push(`2026-11-${d}T${String(h).padStart(2, '0')}:00`);
      const dni = times.map(t => { const h = +t.slice(11, 13); return h >= 9 && h <= 17 ? 500 : 0; });
      state.hourly.times = times;
      state.hourly.sunriseByDate = { '2026-11-12': '2026-11-12T07:22', '2026-11-13': '2026-11-13T07:24' };
      state.hourly.sunsetByDate = { '2026-11-12': '2026-11-12T16:28', '2026-11-13': '2026-11-13T16:27' };
      state.hourly.sunDniBySource = Object.fromEntries(REAL_SOURCES.map(({ id }) => [id, dni]));
      state.hourly.cloudLowBlend = times.map(t => +t.slice(11, 13) < 7 ? 100 : 0);
      state.hourly.cloudMidBlend = times.map(() => 0);
      state.hourly.cloudHighBlend = times.map(() => 0);
      state.hourly.status = 'ready';
      const out = {};
      localStorage.setItem(HOUR_RANGE_KEY, '48'); out.pair = liveSunshineHours(); out.cloud = liveCloudMean('cloudLow');
      localStorage.setItem(HOUR_RANGE_KEY, '24'); out.single = liveSunshineHours();
      return out;
    }""")
    # Today: hours ending 14,15,16,17 are lit and in daylight (17:00 covers 16-17,
    # overlapping 16:28 sunset) = 4. Tomorrow: 9..17 = 9 lit, daylight cap 10.
    expect(res["pair"] == {"today": 4, "tomorrow": 9}, f"48h sun pair wrong: {res['pair']}")
    expect(res["single"] == {"total": 9}, f"24h sun total wrong: {res['single']}")
    expect(res["cloud"] == 0, f"night cloud leaked into the daytime cloud mean: {res['cloud']}")
    expect(not pg.errors, pg.errors)

def om_body(url):
    from urllib.parse import urlparse, parse_qs
    from datetime import datetime, timedelta, timezone
    q = parse_qs(urlparse(url).query)
    n = len(q["latitude"][0].split(","))
    vars_ = q["hourly"][0].split(",")
    models = [m for m in q.get("models", [""])[0].split(",") if m]
    start = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0) - timedelta(hours=2)
    time = [(start + timedelta(hours=i)).strftime("%Y-%m-%dT%H:%M") for i in range(72)]
    def val(v, k): return k + 1 if v == "precipitation" else (90 * k if v == "wind_direction_10m" else 10 + k)
    def one():
        h = {"time": time}
        if not models:
            for v in vars_: h[v] = [9 if v == "precipitation" else 5] * 72
        for k, m in enumerate(models):
            for v in vars_: h[f"{v}_{m}"] = [val(v, k)] * 72
        return {"timezone": "UTC", "hourly": h}
    return json.dumps(one() if n == 1 else [one() for _ in range(n)])

@check
def map_is_the_blend_not_best_match(browser):
    # Nov 2026: the map and the front-page strip asked Open-Meteo for its
    # default "best match" (= Met Office UKV alone in the UK) and so
    # disagreed with the rain graph. Every map request must name the
    # models, and the map's value must be the median across them.
    ctx = browser.new_context(viewport=PHONE, device_scale_factor=2, is_mobile=True, has_touch=True)
    ctx.route(lambda u: not u.startswith(BASE) and "api.open-meteo.com" not in u, lambda r: r.abort())
    seen = []
    def handle(route):
        seen.append(route.request.url)
        route.fulfill(status=200, content_type="application/json", body=om_body(route.request.url))
    ctx.route("https://api.open-meteo.com/**", handle)
    ctx.add_init_script("localStorage.setItem('forecast-compare:currentPostcode','51.131,-2.911');"
                        "localStorage.setItem('forecast-compare:map:centre', JSON.stringify({lat:51.131,lon:-2.911}));")
    pg = ctx.new_page(); pg.errors = []
    pg.on("pageerror", lambda e: pg.errors.append(str(e)))
    pg.goto(f"{BASE}/map.html"); pg.wait_for_function("typeof mapGrid !== 'undefined' && mapGrid && mapGrid.rain", timeout=20000)
    grid_reqs = [u for u in seen if "latitude=" in u and "%2C" in u.split("latitude=")[1].split("&")[0]]
    expect(grid_reqs, "map made no grid request")
    expect(all("models=" in u for u in grid_reqs), "a map grid request didn't name its models (would get UKV best-match)")
    rain = pg.evaluate("sampleGrid(mapGrid,'rain',3,51.131,-2.911)")
    # rain from all eight sources giving 1..8 -> median 4.5; best-match would have been higher
    # (eight since BOM was paused, 23 Nov 2026)
    expect(rain is not None and abs(rain - 4.5) < 1e-6, f"map rain at pin {rain}, expected eight-source median 4.5")
    temp = pg.evaluate("sampleGrid(mapGrid,'temp',3,51.131,-2.911)")
    # other layers from the top four giving 10..13 -> median 11.5
    expect(temp is not None and abs(temp - 11.5) < 1e-6, f"map temperature at pin {temp}, expected top-four median 11.5")
    expect(pg.evaluate("mapGrid.sources.join(',')") == "metoffice,ecmwf,gfs,icon", "map's other layers aren't using the top forecasters")
    expect(len(pg.evaluate("mapGrid.rainSources")) == 8, "map rain isn't using all eight forecasters")
    expect(not pg.errors, pg.errors)
    ctx.close()

@check
def no_placeholder_forecasters(browser):
    # Nov 2026: eleven placeholder forecasters fed made-up numbers into the
    # daily blend once they'd "qualified". Only real sources may exist, a
    # missing real figure is blank (never invented), and old saved data for
    # the placeholders is tidied away.
    ctx = browser.new_context(viewport=PHONE)
    ctx.route(lambda u: not u.startswith(BASE), lambda r: r.abort())
    ctx.add_init_script("""
      if (!sessionStorage.getItem('seeded')) {
        sessionStorage.setItem('seeded', '1');
        localStorage.setItem('forecast-compare:selectedForecasters', JSON.stringify(['metoffice','bbc','yr']));
        localStorage.setItem('forecast-compare:ffv:TA7', JSON.stringify({rain:{metoffice:{1:{count:9}}, bbc:{1:{count:9}}}}));
        localStorage.setItem('forecast-compare:eligibility:TA7', JSON.stringify({rain:{bbc:{'2026-11-01':true}, ecmwf:{'2026-11-01':true}}}));
      }""")
    pg = ctx.new_page(); pg.errors = []
    pg.on("pageerror", lambda e: pg.errors.append(str(e)))
    pg.goto(f"{BASE}/settings.html"); pg.wait_for_timeout(800)
    ids = pg.evaluate("CONFIG.forecasters.map(f => f.id)")
    expect(ids == pg.evaluate("[...REAL_SOURCES.map(s => s.id), MO_SPOT_ID]"), f"non-real forecaster listed: {ids}")
    expect(pg.evaluate("typeof demoValue") == "undefined", "demo formula still present")
    boxes = pg.evaluate("document.querySelectorAll('#forecasters input').length")
    expect(boxes == len(ids), f"Settings shows {boxes} forecasters, expected {len(ids)}")
    expect(pg.evaluate("forecastValueFor(1, CONFIG.forecasters[0], 'uv', 1)") is None, "UV invented a figure")
    expect(pg.evaluate("JSON.parse(localStorage.getItem('forecast-compare:selectedForecasters'))") == ["metoffice"], "selection not tidied")
    ffv = pg.evaluate("JSON.parse(localStorage.getItem('forecast-compare:ffv:TA7'))")
    expect("bbc" not in ffv["rain"] and "metoffice" in ffv["rain"], f"FFV not tidied correctly: {ffv}")
    el = pg.evaluate("JSON.parse(localStorage.getItem('forecast-compare:eligibility:TA7'))")
    expect(list(el["rain"].keys()) == ["ecmwf"], f"eligibility not tidied correctly: {el}")
    expect(not pg.errors, pg.errors)
    ctx.close()

@check
def met_office_spot_record_and_blend(browser):
    # Met Office Spot keeps its own record of past forecasts (the Met
    # Office publishes none). The record must turn into lead-day figures
    # the rest of the app understands, stay out of the blend until 14
    # days are recorded, then join it.
    ctx = browser.new_context(viewport=PHONE)
    ctx.route(lambda u: not u.startswith(BASE), lambda r: r.abort())
    ctx.add_init_script("localStorage.setItem('forecast-compare:moSpotKey','test-key');")
    pg = ctx.new_page(); pg.errors = []
    pg.on("pageerror", lambda e: pg.errors.append(str(e)))
    pg.goto(f"{BASE}/settings.html"); pg.wait_for_timeout(800)
    res = pg.evaluate("""(() => {
      const today = isoDate(new Date());
      const tomorrow = addDaysIso(today, 1), in3 = addDaysIso(today, 3);
      const archive = { issued: {
        [today]: { [tomorrow]: { p: 4, tx: 10, tn: 6, w: 20, g: 30, d: 200, pr: 1000, fl: 5 } },
        [addDaysIso(today, 1 - 3)]: { [tomorrow]: { p: 9, tx: 12, tn: 8, w: 25, g: 35, d: 210, pr: 995, fl: 7 } }
      }, scored: {} };
      const slot = moSpotSlotFromArchive(archive);
      const i = slot.dates.indexOf(tomorrow);
      state.realSources.mospot = slot;
      state.selected = new Set(['metoffice', 'mospot']);
      const src = CONFIG.forecasters.find(s => s.id === 'mospot');
      const out = { lead1: slot.byLeadDay[1].precip[i], lead3: slot.byLeadDay[3].precip[i],
        t1: slot.byLeadDay[1].tempAvg[i], cloud: forecastValueFor(1, src, 'cloudLow', -1),
        viaApp: forecastValueFor(1, src, 'rain', -1) };
      // hourly blend: Open-Meteo sources say 0 and 10, Spot says 6
      const t0 = new Date(); t0.setMinutes(0, 0, 0);
      const times = [0, 1].map(h => { const d = new Date(t0.getTime() + h * 3600e3); return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0') + 'T' + String(d.getHours()).padStart(2,'0') + ':00'; });
      state.moSpot = { status: 'ready', hourly: [0, 1].map(h => ({ t: new Date(times[h]).getTime(), p: 6, T: 10, w: 10, g: 15, d: 180, pr: 1000, fl: 8, dp: 5 })) };
      const per = { metoffice: { precipitation: [0, 0] }, ecmwf: { precipitation: [10, 10] } };
      applyHourlyBlend(per, times, {});
      out.before = state.hourly.precipitation[0];
      const elig = {}; elig.rain = { mospot: {} };
      for (let k = 1; k <= 14; k++) elig.rain.mospot[addDaysIso(today, -k)] = true;
      state.areaCode = 'TEST'; saveEligibilityStore('TEST', elig);
      applyHourlyBlend(per, times, {});
      out.after = state.hourly.precipitation[0];
      out.joins = moSpotJoinsBlend('rain');
      return out;
    })()""")
    expect(res["lead1"] == 4 and res["lead3"] == 9, f"record -> lead days wrong: {res}")
    expect(res["t1"] == 8, f"temperature mean wrong: {res}")
    expect(res["cloud"] is None, "Spot invented a cloud figure")
    expect(res["viaApp"] == 4, f"Compare would show {res['viaApp']} not 4")
    expect(res["before"] == 5, f"Spot joined the blend before 14 days (average of 0,10 is 5): {res}")
    # rain blends by average since 23 Nov 2026: (0 + 10 + 6) / 3
    expect(res["joins"] and abs(res["after"] - 16 / 3) < 1e-9, f"after 14 days the average of 0,10,6 should be 5.33: {res}")
    boxes = pg.evaluate("[...document.querySelectorAll('#forecasters input')].map(i => i.disabled)")
    expect(len(boxes) == 9 and not boxes[-1]  # 9 since BOM paused
          , f"Spot box should be enabled with a key: {boxes}")
    pg.evaluate("localStorage.removeItem('forecast-compare:moSpotKey'); refreshSpotCheckbox()")
    expect(pg.evaluate("document.querySelectorAll('#forecasters input')[8].disabled"), "Spot box should be greyed out without a key")
    expect(not pg.errors, pg.errors)
    ctx.close()

@check
def met_office_spot_gaps_filled_from_github_record(browser):
    # The daily GitHub job's record fills issue dates this device missed;
    # the device's own record always wins.
    import datetime as dt
    today = dt.datetime.now(dt.timezone.utc).date()
    iso = lambda n: (today + dt.timedelta(days=n)).isoformat()
    shared = {"places": {"TA7": {"issued": {
        iso(-2): {iso(-1): {"p": 7, "tx": 9, "tn": 3, "w": 10, "g": 20, "d": 180, "pr": 1000, "fl": 5}},
        iso(-1): {iso(0): {"p": 99, "tx": 9, "tn": 3, "w": 10, "g": 20, "d": 180, "pr": 1000, "fl": 5}}}}}}
    own = {"issued": {iso(-1): {iso(0): {"p": 2, "tx": 9, "tn": 3, "w": 10, "g": 20, "d": 180, "pr": 1000, "fl": 5}}}, "scored": {}}
    slots = []
    t0 = dt.datetime.now(dt.timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    for k in range(1, 57):
        slots.append({"time": (t0 + dt.timedelta(hours=3 * k)).strftime("%Y-%m-%dT%H:%MZ"), "totalPrecipAmount": 0.5,
                      "maxScreenAirTemp": 10, "minScreenAirTemp": 5, "windSpeed10m": 4, "windGustSpeed10m": 8,
                      "windDirectionFrom10m": 200, "mslp": 100000, "feelsLikeTemp": 6})
    mo = json.dumps({"features": [{"properties": {"timeSeries": slots}}]})
    ctx = browser.new_context(viewport=PHONE)
    ctx.route(lambda u: not u.startswith(BASE) and "metoffice" not in u, lambda r: r.abort())
    ctx.route("https://data.hub.api.metoffice.gov.uk/**", lambda r: r.fulfill(status=200, content_type="application/json", body=mo))
    ctx.route(f"{BASE}/data/mo-spot-record.json", lambda r: r.fulfill(status=200, content_type="application/json", body=json.dumps(shared)))
    ctx.add_init_script("localStorage.setItem('forecast-compare:moSpotKey','test-key');"
                        f"localStorage.setItem('forecast-compare:moSpotArchive:TA7', {json.dumps(json.dumps(own))});")
    pg = ctx.new_page(); pg.errors = []
    pg.on("pageerror", lambda e: pg.errors.append(str(e)))
    pg.goto(f"{BASE}/settings.html"); pg.wait_for_timeout(600)
    res = pg.evaluate("""(async () => {
      state.areaCode = 'TA7';
      await fetchMoSpot(51.13, -2.91);
      const a = loadMoSpotArchive('TA7'), today = isoDate(new Date());
      const s = state.realSources.mospot, i = s.dates.indexOf(addDaysIso(today, -1)), j = s.dates.indexOf(today);
      return { status: s.status, filled: s.byLeadDay[1].precip[i], own: s.byLeadDay[1].precip[j],
               todayRecorded: !!a.issued[today], tomorrow: a.issued[today]?.[addDaysIso(today, 1)]?.p };
    })()""")
    expect(res["status"] == "ready", f"Spot didn't load: {res}")
    expect(res["filled"] == 7, f"gap not filled from the GitHub record: {res}")
    expect(res["own"] == 2, f"GitHub record overrode this device's own: {res}")
    expect(res["todayRecorded"] and res["tomorrow"] == 4, f"today's forecast not recorded (8 x 0.5mm): {res}")
    expect(not pg.errors, pg.errors)
    ctx.close()

@check
def callout_and_coast_wind_is_blended(browser):
    # Nov 2026: Callout and Coast took wind from Open-Meteo's single
    # default model. Wind is now the nine-forecaster median (direction from
    # the first), visibility still comes from the plain download, and if
    # the blend fails the plain wind is kept.
    def run(fail_blend):
        ctx = browser.new_context(viewport=PHONE)
        ctx.route(lambda u: not u.startswith(BASE) and "api.open-meteo.com" not in u, lambda r: r.abort())
        def handle(route):
            if fail_blend and "models=" in route.request.url: return route.abort()
            route.fulfill(status=200, content_type="application/json", body=om_body(route.request.url))
        ctx.route("https://api.open-meteo.com/**", handle)
        pg = ctx.new_page(); pg.errors = []
        pg.on("pageerror", lambda e: pg.errors.append(str(e)))
        pg.goto(f"{BASE}/callout.html"); pg.wait_for_timeout(1200)
        out = pg.evaluate("""(async () => { const d = await fetchForecast({ lat: 51.77, lon: -5.11 });
          return { sp: d.hourly.wind_speed_10m[5], gu: d.hourly.wind_gusts_10m[5], dir: d.hourly.wind_direction_10m[5],
                   vis: d.hourly.visibility[5], n: d.hourly.windBlendedFrom || 0 }; })()""")
        errs = pg.errors; ctx.close()
        return out, errs
    out, errs = run(False)
    # eight models (BOM paused) give 10..17 -> median 13.5; direction from the first (0)
    expect(out["sp"] == 13.5 and out["gu"] == 13.5 and out["dir"] == 0 and out["n"] == 8, f"wind not blended: {out}")
    expect(out["vis"] == 5, f"visibility lost: {out}")
    out, errs2 = run(True)
    expect(out["sp"] == 5 and out["vis"] == 5 and out["n"] == 0, f"fallback to plain wind failed: {out}")
    expect(not errs and not errs2, errs + errs2)

@check
def map_refetches_grid_on_zoom(browser):
    # Nov 2026 bug: zooming out kept the smaller grid (same centre, so
    # "not moved"), leaving data in a small square until the page reopened.
    pg = new_page(browser)
    pg.goto(f"{BASE}/map.html"); pg.wait_for_timeout(2500)
    res = pg.evaluate("""async () => {
      const calls = [];
      fetchWeatherGrid = async (c, r) => { calls.push(r); return buildStubGrid(c, r); };
      const c = { lat: 51.13, lon: -2.99 };
      const [small, big] = [MAP_ZOOM_RADII_KM[0], MAP_ZOOM_RADII_KM[MAP_ZOOM_RADII_KM.length - 1]];
      await ensureGrid(c, small, true);
      await ensureGrid(c, small);        // same view: no refetch
      await ensureGrid(c, big);          // zoomed out: must refetch
      return { calls, small, big };
    }""")
    expect(res["calls"] == [res["small"], res["big"]], f"grid fetches on zoom: {res}")
    expect(not pg.errors, pg.errors)

@check
def place_switch_while_loading_keeps_new_place(browser):
    # 21 Nov 2026: switching place while the previous one was still loading
    # queued behind it, then the old load's late result landed under the
    # new place's name (map and figures "jumped back").
    pg = new_page(browser)
    pg.goto(f"{BASE}/index.html"); pg.wait_for_timeout(2000)
    res = pg.evaluate("""async () => {
      const coords = { SLOW: [51.13, -2.88], FAST: [51.12, -3.01] };
      resolveLocation = async pc => {
        if (pc === 'SLOW') await new Promise(r => setTimeout(r, 1500));
        const [lat, lon] = coords[pc];
        return { lat, lon, label: pc, areaCode: pc };
      };
      state.postcode = 'SLOW'; resetForLocationChange(); loadLocationData();
      await new Promise(r => setTimeout(r, 100));
      switchToPostcode('FAST');
      const started = loadLocationPromisePostcode;
      await new Promise(r => setTimeout(r, 3000));
      return { started, pc: state.postcode, lat: state.lat };
    }""")
    expect(res["started"] == "FAST", f"new place waited behind the old load: {res}")
    expect(res["pc"] == "FAST" and res["lat"] == 51.12, f"old place's result overwrote the new one: {res}")

# ---------- runner ----------

@check
def zero_forecast_scored_and_learned(browser):
    # 23 Nov 2026: a forecast of exactly 0 mm was skipped by the learning,
    # so "said dry, then 9 mm fell" never counted against a model. Now it
    # counts for accuracy, but still doesn't move the correction itself.
    ctx = browser.new_context(viewport=PHONE)
    ctx.route(lambda u: not u.startswith(BASE), lambda r: r.abort())
    pg = ctx.new_page(); pg.errors = []
    pg.on("pageerror", lambda e: pg.errors.append(str(e)))
    pg.goto(f"{BASE}/compare.html"); pg.wait_for_timeout(1200)
    res = pg.evaluate("""(() => {
      const store = {};
      for (let i = 0; i < 5; i++) recordFFVSample(store, 'rain', 'gfs', 1, 4, 4, null, null);
      const e = store.rain.gfs[1];
      const before = { count: e.count, ratio: e.emaRatio, raw: e.emaErrorRaw, cor: e.emaErrorCorrected, scored: e.scoredCount };
      recordFFVSample(store, 'rain', 'gfs', 1, 0, 9, null, null);   // said dry, 9 mm fell
      recordFFVSample(store, 'rain', 'gfs', 1, null, 9, null, null); // no forecast at all
      const after = { count: e.count, ratio: e.emaRatio, raw: e.emaErrorRaw, cor: e.emaErrorCorrected, scored: e.scoredCount };
      const fresh = {}; recordFFVSample(fresh, 'rain', 'icon', 1, 0, 3, null, null);
      return { before, after, freshCount: fresh.rain.icon[1].count, freshRaw: fresh.rain.icon[1].emaErrorRaw };
    })()""")
    b, a = res["before"], res["after"]
    # Since the running-totals change (same night) a 0 mm forecast is also
    # learned from: "said dry, 9 mm fell" must push the factor up.
    expect(a["count"] == b["count"] + 1 and a["ratio"] > b["ratio"], f"a missed wet day after a 0 mm forecast wasn't learned: {res}")
    expect(a["raw"] > b["raw"] and a["cor"] > b["cor"] and a["scored"] == b["scored"] + 1, f"a 0 mm forecast wasn't scored: {res}")
    expect(res["freshCount"] == 1 and res["freshRaw"] == 3, f"first-ever 0 mm sample handled wrongly: {res}")
    expect(not pg.errors, pg.errors)
    ctx.close()

@check
def data_health_catches_a_silent_source(browser):
    # 23 Nov 2026: BOM sent only blanks for months and nothing noticed.
    # The nightly check must flag a source that sends nothing, and must
    # NOT flag a short-range model for the days it never covers.
    import shutil, tempfile
    tmp = Path(tempfile.mkdtemp())
    shutil.copytree(ROOT / "data", tmp / "data", ignore=shutil.ignore_patterns("coast", "*.geojson"))
    (tmp / "scripts").mkdir(); shutil.copy(ROOT / "scripts" / "data-checks.mjs", tmp / "scripts")
    shutil.copy(ROOT / "app.js", tmp / "app.js")
    pre = json.loads((tmp / "data" / "precache-weather.json").read_text())
    for k in pre["weather"][0]["sources"]["gem"]:
        pre["weather"][0]["sources"]["gem"][k] = [None] * len(pre["weather"][0]["sources"]["gem"][k])
    (tmp / "data" / "precache-weather.json").write_text(json.dumps(pre))
    r = subprocess.run(["node", "scripts/data-checks.mjs", "health"], cwd=tmp, capture_output=True, text=True)
    expect(r.returncode == 0, r.stderr)
    h = json.loads((tmp / "data" / "health.json").read_text())
    texts = [i["source"] + " " + i["text"] for i in h["issues"] if i.get("source")]
    expect(any(t.startswith("gem sent nothing") for t in texts), f"all-blank GEM not flagged: {texts}")
    expect(not any(t.startswith("meteofrance") and "blank" in t for t in texts), f"Meteo-France flagged for days it never covers: {texts}")
    r = subprocess.run(["node", "scripts/data-checks.mjs", "weekly"], cwd=tmp, capture_output=True, text=True)
    expect(r.returncode == 0 and (tmp / "data" / "weekly-check.json").exists(), r.stderr)
    shutil.rmtree(tmp)

@check
def settings_shows_data_checks(browser):
    ctx = browser.new_context(viewport=PHONE, device_scale_factor=2, is_mobile=True, has_touch=True)
    ctx.route(lambda u: not u.startswith(BASE), lambda r: r.abort())
    health = {"checkedAt": "2026-11-23T03:45:00Z", "ok": False, "issues": [{"source": "gem", "text": "sent nothing in the latest refresh (every figure blank)"}]}
    weekly = {"checkedAt": "2026-11-23T04:37:00Z", "ok": True, "flags": [], "areas": {}}
    ctx.route(f"{BASE}/data/health.json*", lambda r: r.fulfill(status=200, content_type="application/json", body=json.dumps(health)))
    ctx.route(f"{BASE}/data/weekly-check.json*", lambda r: r.fulfill(status=200, content_type="application/json", body=json.dumps(weekly)))
    pg = ctx.new_page(); pg.errors = []
    pg.on("pageerror", lambda e: pg.errors.append(str(e)))
    pg.goto(f"{BASE}/settings.html"); pg.wait_for_timeout(1500)
    h = pg.inner_text("#dataHealth"); w = pg.inner_text("#weeklyCheck")
    expect("1 thing to look at" in h, f"health headline wrong: {h}")
    pg.click("#dataHealth summary"); pg.wait_for_timeout(200)
    expect("GEM (Canada): sent nothing" in pg.inner_text("#dataHealth"), f"issue not in plain words: {pg.inner_text('#dataHealth')}")
    expect("close to what happened" in w, f"weekly all-clear wrong: {w}")
    pg.locator("#dataHealth").scroll_into_view_if_needed()
    pg.screenshot(path=str(OUT / "settings_data_checks.png"))
    expect(not pg.errors, pg.errors)
    ctx.close()

@check
def rain_correction_uses_running_totals(browser):
    # 23 Nov 2026: averaging each day's actual/forecast ran 30-90% high
    # (a 0.3 mm forecast with 3 mm fallen counted as "10x too low", a 6 mm
    # forecast with 3 mm fallen only as "0.5x"). A source whose totals
    # match reality must end up with a factor of about 1.
    ctx = browser.new_context(viewport=PHONE)
    ctx.route(lambda u: not u.startswith(BASE), lambda r: r.abort())
    pg = ctx.new_page(); pg.errors = []
    pg.on("pageerror", lambda e: pg.errors.append(str(e)))
    pg.goto(f"{BASE}/compare.html"); pg.wait_for_timeout(1200)
    res = pg.evaluate("""(() => {
      const store = {};
      // forecast 0.3 -> 3 fell, then 6 -> 3.3 fell: totals 6.3 vs 6.3
      for (let i = 0; i < 20; i++) {
        recordFFVSample(store, 'rain', 'gfs', 1, 0.3, 3, null, null);
        recordFFVSample(store, 'rain', 'gfs', 1, 6, 3.3, null, null);
      }
      const k = store.rain.gfs[1].emaRatio;
      // A long dry spell: factor held, not divided by nearly nothing
      for (let i = 0; i < 60; i++) recordFFVSample(store, 'rain', 'gfs', 1, 0, 0, null, null);
      const held = store.rain.gfs[1].emaRatio;
      // Said dry, it rained: now learned (factor goes up), not ignored
      const s2 = {};
      for (let i = 0; i < 10; i++) recordFFVSample(s2, 'rain', 'icon', 1, 2, 2, null, null);
      const before = s2.rain.icon[1].emaRatio;
      for (let i = 0; i < 3; i++) recordFFVSample(s2, 'rain', 'icon', 1, 0, 4, null, null);
      // Temperature still uses an average offset
      const t = {}; for (let i = 0; i < 5; i++) recordFFVSample(t, 'temperature', 'gfs', 1, 0, 1.5, null, null);
      return { k, held, before, after: s2.rain.icon[1].emaRatio, off: t.temperature.gfs[1].emaOffset };
    })()""")
    expect(0.9 < res["k"] < 1.1, f"factor should be about 1 when totals match, got {res['k']}")
    expect(abs(res["held"] - res["k"]) < 0.05, f"factor not held through a dry spell: {res}")
    expect(res["after"] > res["before"] + 0.1, f"a missed wet day after 'dry' wasn't learned: {res}")
    expect(abs(res["off"] - 1.5) < 1e-6, f"temperature offset changed: {res}")
    expect(not pg.errors, pg.errors)
    ctx.close()

@check
def gauge_rain_days_and_actual(browser):
    # 23 Nov 2026: EA gauge readings (GMT, 15-minute) are summed into UK
    # calendar days, clock changes included, and become the rain actual
    # with the archive figure kept beside it.
    code = """
import { applyGaugeRain } from './scripts/ea-gauge-rain.mjs';
const m = await import('./scripts/ea-gauge-rain.mjs');
const days = { '2026-11-22': { actual: { rain: 4 } }, '2026-11-21': { actual: { rain: 1 } } };
const used = applyGaugeRain(days, ['2026-11-22', '2026-11-21'], { '2026-11-22': { mm: 9.2, gauges: 3 } });
console.log(JSON.stringify({ used, days }));
"""
    r = subprocess.run(["node", "--input-type=module", "-e", code], cwd=ROOT, capture_output=True, text=True)
    expect(r.returncode == 0, r.stderr)
    out = json.loads(r.stdout)
    a, b = out["days"]["2026-11-22"]["actual"], out["days"]["2026-11-21"]["actual"]
    expect(out["used"] == 1 and a["rain"] == 9.2 and a["rainModel"] == 4 and a["rainSource"] == "gauges", f"gauge day wrong: {out}")
    expect(b["rain"] == 1 and b["rainSource"] == "model", f"no-gauge day wrong: {out}")
    src = (ROOT / "scripts" / "ea-gauge-rain.mjs").read_text()
    slots = subprocess.run(["node", "--input-type=module", "-e",
        src.replace("export ", "") + "\nconsole.log([slotsIn('2026-03-29'), slotsIn('2026-10-25'), slotsIn('2026-11-22'), ukDayOf('2026-06-30T23:30:00')].join(','));"],
        cwd=ROOT, capture_output=True, text=True)
    expect(slots.stdout.strip() == "92,100,96,2026-07-01", f"UK day handling wrong: {slots.stdout} {slots.stderr}")

@check
def rain_blends_by_average(browser):
    ctx = browser.new_context(viewport=PHONE)
    ctx.route(lambda u: not u.startswith(BASE), lambda r: r.abort())
    pg = ctx.new_page(); pg.errors = []
    pg.on("pageerror", lambda e: pg.errors.append(str(e)))
    pg.goto(f"{BASE}/compare.html"); pg.wait_for_timeout(1200)
    res = pg.evaluate("""[blendFor([0, 0, 1, 2, 12], 'rain'), blendFor([0, 0, 1, 2, 12], 'wind'),
      weightedBlend([{value: 2, weight: 1}, {value: 8, weight: 3}], 'rain'),
      weightedBlend([{value: 2, weight: 1}, {value: 8, weight: 3}], 'temperature')]""")
    expect(res == [3, 1, 6.5, 8], f"blend wrong: {res}")
    expect(not pg.errors, pg.errors)
    ctx.close()

@check
def bom_paused_everywhere(browser):
    # 23 Nov 2026: Open-Meteo sends BOM (bom_access_global) as all blanks,
    # everywhere, and has for the whole year of history. It's paused: no
    # page or GitHub job may ask for it, and Settings mustn't offer it.
    for f in ["app.js", "settings.js", "wind-blend.js", "scripts/precache-weather.mjs",
              "scripts/collect-weather.mjs", "scripts/backfill-weather.mjs"]:
        live = [l for l in (ROOT / f).read_text().splitlines()
                if "bom" in l.lower() and not l.strip().startswith("//") and "/* \"bom_access_global\"" not in l]
        expect(not live, f"{f} still uses BOM: {live}")
    expect("bom" not in (ROOT / "forecast-config.json").read_text(), "forecast-config.json still lists BOM")
    ctx = browser.new_context(viewport=PHONE)
    ctx.route(lambda u: not u.startswith(BASE), lambda r: r.abort())
    pg = ctx.new_page(); pg.goto(f"{BASE}/settings.html"); pg.wait_for_timeout(1500)
    expect("BOM" not in pg.inner_text("body"), "Settings still offers BOM")
    expect(pg.evaluate("typeof REAL_SOURCES === 'undefined' || !REAL_SOURCES.some(s => s.id === 'bom')"), "BOM still in REAL_SOURCES")
    ctx.close()

@check
def sw_data_files_fresh_and_geo_daily(browser):
    # 26 Nov 2026: after hours away, the service worker handed the app the
    # saved precache-weather.json from the last visit, which was too old to
    # use, so the front page fetched all nine forecasters live (20+ s).
    # GitHub-refreshed data files must come from the network first; geo
    # files must not be re-downloaded on every open (once a day at most).
    probe = ROOT / "data" / "_sw-probe.json"
    probe.write_text('"old"')
    ctx = browser.new_context(viewport=PHONE, service_workers="allow")
    ctx.route(lambda u: not u.startswith(BASE), lambda r: r.abort())
    try:
        pg = ctx.new_page(); pg.goto(f"{BASE}/index.html")
        pg.wait_for_function("navigator.serviceWorker.controller", timeout=20000)
        get = "fetch('data/_sw-probe.json').then(r=>r.json())"
        expect(pg.evaluate(get) == "old", "probe not served")
        probe.write_text('"new"')
        expect(pg.evaluate(get) == "new", "data file served from the saved copy, not the network")
        pg.reload(); pg.wait_for_timeout(1000)
        expect(pg.evaluate(get) == "new", "data file stale after reopening")
        geo = "fetch('data/lakes-50m.json').then(r=>r.ok)"
        expect(pg.evaluate(geo), "geo file not served")
        pg.wait_for_timeout(500)
        before = sum(1 for x in SERVED if x.endswith("lakes-50m.json"))
        for _ in range(3):
            pg.reload(); pg.wait_for_timeout(800); pg.evaluate(geo)
        pg.wait_for_timeout(800)
        after = sum(1 for x in SERVED if x.endswith("lakes-50m.json"))
        expect(after == before, f"geo file re-downloaded {after - before} times in 3 opens")
    finally:
        probe.unlink(missing_ok=True); ctx.close()

def main():
    only = sys.argv[1] if len(sys.argv) > 1 else ""
    serve()
    from playwright.sync_api import sync_playwright
    passed = failed = 0
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for fn in CHECKS:
            if only and only not in fn.__name__: continue
            try:
                fn(browser) if fn.__code__.co_argcount else fn()
                print(f"  PASS  {fn.__name__}"); passed += 1
            except Fail as e:
                print(f"  FAIL  {fn.__name__}: {e}"); failed += 1
            except Exception:
                print(f"  ERROR {fn.__name__}:\n{traceback.format_exc(limit=3)}"); failed += 1
        browser.close()
    print(f"\n{passed} passed, {failed} failed{'' if LIVE else ' (outside sites blocked; LIVE=1 to allow)'}")
    sys.exit(1 if failed else 0)

if __name__ == "__main__":
    main()
