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

def serve():
    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *a): pass
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
    enter(pg, "latlon", text="51.7815 -5.1045")  # Broad Haven beach
    now_card = pg.inner_text("#coastPinCard")
    expect("Nearest dry ground now" in now_card and "open way off" in now_card, now_card)
    pg.evaluate("(()=>{const s=$('coastSlider'); s.value=36; s.dispatchEvent(new Event('input'))})()"); pg.wait_for_timeout(900)
    later = pg.inner_text("#coastPinCard")
    expect("Nearest dry ground at" in later, f"card didn't follow the slider: {later!r}")
    expect("cut by then" not in later or "all cut" in later, "showing a cut way off while an open one exists")
    stored = pg.evaluate("JSON.parse(localStorage.getItem('cloude-callout:spot')).shore")
    expect(stored and stored["distM"] < 200, "Callout copy should keep the 'now' figures")
    pg.click("#coastAhead"); pg.wait_for_timeout(500)
    expect("Nearest dry ground now" in pg.inner_text("#coastPinCard"), "tapping the time didn't return to now")
    allcut = pg.evaluate("pickWayOff({lat:51.7815,lon:-5.1045}, ()=>({state:'now'}), 'now')")
    expect(allcut["allCut"] and allcut["cut"] == "all cut now", f"all-cut case: {allcut}")

@check
def coast_dry_ground_on_land_and_without_tide(browser):
    pg = coast(browser, tide=False)
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

# ---------- runner ----------

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
