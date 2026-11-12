# Cloude — decisions

The choices behind the app, so they don't get undone by accident. README.md
says how things work; this file says what was decided and why. Read it
before changing anything, and add to it whenever something is settled.

Newest at the top of each section. "Rejected" means considered and turned
down on purpose: don't bring it back without asking.

## How changes are made

- The owner works on an iPad and iPhone only: no computer, no command line,
  no code editing. Changes arrive as **complete replacement files** to upload
  to GitHub, never snippets or hand-edit instructions.
- The repo is public. Claude can fetch the latest code from GitHub itself, so
  files don't need sending to it.
- Discuss first when there's a real design trade-off; build straight away when
  the request is concrete. State caveats and limitations plainly.
- Every release bumps `SHELL_CACHE_NAME` in `sw.js`; the number is the version
  shown in Settings. Say which files to upload and the new version number.
- Test with `tests/run_tests.py` (see the top of that file) and add a check for
  every bug fixed.
- Mockups go in the chat as plain pictures, not on a design canvas.
- Fixes must work for every user without them changing phone settings.

## Privacy (public repo)

- No exact locations, place names or personal details committed. Shared
  favourites are stored as postcode outward codes only (e.g. "TA6").
- Daily collection reads its location from repo secrets and commits only
  anonymous dates and numbers.
- No tokens or keys in this repo, ever. Workers that need a GitHub token live
  in private repos. (A token once leaked here; it was revoked, Oct 2026.)
- Each user keeps their own Admiralty Discovery API key; the shared relay
  Worker stores no keys and just forwards each request's own.

## Front page

- Space on a small phone is hard-won: no fix may push the front page down.
- Headline units go on the label line ("RAIN MM"), so only the number changes
  width. Labels are shortened to fit one line on a phone: Temp, Press, Feels,
  Sun hrs, Vis km/mi.
- Visibility cell: bold number, word (Good / Moderate / Poor / Very poor) in
  smaller text beside it. The number rounds **down** so it never disagrees
  with the word (9.6 km shows "9 Moderate").
- Hour slider stays wherever it's left; it resets only when the Date slider is
  touched or the app goes to the background (an auto-revert was rejected as
  irritating).
- Ground-frost threshold is 4 °C, not 2 °C.
- No notification-style nagging; passive visual cues only.
- Sun hrs and Cloud (today) come from the latest model runs over the same
  24/48h window as the sheet, not yesterday's daily figure (that sat on
  "2 hrs" and a grey cloud all through a clear day, Nov 2026). Sun hrs on
  48h shows rest of today / tomorrow ("3/8"); on 24h, one figure for the
  next 24 h. Capped at daylight hours. Cloud averages daylight hours only.

## Forecasts and accuracy

- Merge as many user-selected forecasters' FFV-corrected data as possible.
- FFV is tracked per postcode area. Temperature correction is additive (not a
  ratio scale); other conditions multiplicative.
- Units are chosen per condition, not one metric/imperial switch.
- Accuracy work goes one step at a time: rain against Environment Agency
  gauges first, then Met Office station temperatures. Amateur observer data
  only from the highest-rated observers, and not yet.
- Precache budget: about 28 Open-Meteo requests a day (3 weather favourites x
  top 4 forecasters daily, 4 fishing spots x 1 source four times daily).
  Shared favourites: 4 per person, 8 shared slots per list; duplicates share
  a slot; removing a local place doesn't remove it from the shared list.
- **Rejected:** third-party radar imagery (RainViewer) — single-supplier
  dependency and a required credit that advertises a rival app. The map is
  built from Cloude's own gridded forecast data instead.
- **Rejected:** advertising of any kind.
- Map waterways: rivers and canals only, from OpenStreetMap, with the OSM
  credit in Help. Town markers stay simple circles.

## Tide and fishing

- Tide predictions are fitted to about a year of each gauge's hourly
  readings (data/tide-gauges, kept by the daily collect-tide-gauges job from
  the EA's daily archive files), plus the live last four weeks; the live API
  alone keeps only ~4 weeks, which drifted up to 38 min at neaps at Milford
  Haven. With a year, more constituents (TIDE_CONSTITUENTS_LONG). All ~43
  gauges are kept (one archive download covers them all). (Nov 2026)
- St Brides Bay times use Admiralty's published time differences from
  Milford Haven (port's tide tables): Little Haven for the bay, Martin's
  Haven, Skomer, Dale, Solva, Ramsey Sound; the tide model only for range.
  Applied on the coast map, the Callout tide box, and tide places within
  6 km not checked against Admiralty. No published height differences, so
  heights stay Milford's. Porthgain/Fishguard are not used: places there are
  on the Fishguard gauge. (Nov 2026)
- Weymouth and Bournemouth gauges are only used within 25 km of them; further
  off, Plymouth (west of Weymouth) or Portsmouth (east) instead, as Admiralty
  does for Lyme Regis. Replacement gauges are named, not "next nearest":
  the next nearest to Charmouth is Hinkley Point, on the wrong sea. (Nov 2026,
  after Charmouth showed a false low ~3 h after high water.)
- A place's Admiralty-corrected tide follows the gauge's curve between the
  place's own corrected high and low; where the gauge has a stand (double
  low/high), a smooth half cosine. **Rejected:** blending the high- and
  low-water corrections across the half-cycle — it makes false highs/lows.
- Tide and fishing share one location list.
- Heights can be shown on Chart Datum using NTSLF's per-station offsets.
- The "are you sure?" warning for a tide/fishing location uses height above
  sea level AND distance from the sea together (a clifftop is fine; Snowdon
  isn't).
- Moon influence on fishing is framed as spring/neap tidal range, not folklore.

## Callout screen and Coast map

Used on inshore lifeboat callouts, mostly glanced at while kitting up, often
at night, sometimes with poor signal.

- Callout mode is opt-in from Settings, so other users' app looks unchanged.
- Positions are entered however they're reported: lat/long (typed any common
  way, including dashes, dots or run together), OS grid reference, distance
  and direction from a named place, or a bearing (lines A, B, C, with the
  crossing circled). Nautical miles and magnetic bearings by default; "miles"
  means land miles.
- A typed position outside the map is flagged, not silently pinned.
- Pin card (Nov 2026):
  - full screen width, resting on the time slider;
  - a coloured button per pin — red, teal, white, by pin number — matching
    the pin and its name tag on the map; colours chosen to differ in
    brightness so they still tell apart in night mode;
  - the selected pin's position shown once, the way it was reported (a grid
    ref stays a grid ref; anything else is lat/long);
  - bearings as small A/B/C buttons; the letter is also drawn where each line
    comes on screen, because at night every line is red;
  - the crossing circle is centred in the clear map above the card;
  - no distance between pins — the scale line is enough.
- Nearest dry ground and way off follow the time slider, and the "now"
  figures update as time passes. The Callout screen always shows "now".
- Weather allowance (Nov 2026): everything that asks "is this covered?" —
  map colours, cut-offs, dry ground, ways off — uses the predicted tide
  **plus surge plus wave run-up**. Surge = Milford Haven gauge's measured
  level minus its prediction over the last hour, raised sea only (≥10 cm),
  held 6 h then fading to nothing at 24 h. Run-up = Stockdon (2006) from
  Open-Meteo marine wave height and peak period offshore and the beach's
  own slope from the LiDAR. The tide box still shows the predicted tide,
  with "sea +0.8 m" beside it. **Rejected:** a fixed safety margin — it
  ignores the weather (0.5 m means something very different in a force 7).
- Estimated beach (heights the LiDAR missed, filled in) counts as dry
  ground, marked "Estimated beach" on the card; it used to be skipped,
  which sent people the long way round.
- Way off is the nearest **open** one (not just the nearest); if all are cut,
  the nearest, marked "all cut".
- No dry-ground answer without the tide (it used to point at seabed); a pin
  on land says "On dry ground".
- The Time / Now / clock row under the map was removed: the box on the map
  says "Now" or "In 2 h · 07:30" (tap it to return to now), and the phone
  shows the time anyway. Only +12h / +24h stay under the slider.
- Night mode is a dim red filter over the whole page.
- **Rejected:** tidal stream data (free models too coarse for the Sounds;
  charts and local knowledge are the tool for that).
- **Rejected for now:** a weather-warnings banner on the Callout screen (the
  Beaufort force is enough); may revisit if asked.
- Coast areas: St Brides Bay; Lyme Regis & Charmouth (small area first).
  Covering the whole South West was rejected as too big.
- Place names come from OS and OpenStreetMap; local names vary, so the list
  is checked locally before being trusted. Villages are labelled before
  hamlets.

## Repos

- Forecast4 is the live repo. Forecast2 is archived (Nov 2026).
