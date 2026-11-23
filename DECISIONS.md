# Cloude — decisions

The choices behind the app, so they don't get undone by accident. README.md
says how things work; this file says what was decided and why. Read it
before changing anything, and add to it whenever something is settled.

Newest at the top of each section. "Rejected" means considered and turned
down on purpose: don't bring it back without asking.

## How changes are made

- The owner works on an iPad and iPhone only: no computer, no command line,
  no code editing. Since Nov 2026 Claude commits changes straight to `main`
  itself (GitHub Pages deploys from there) and, at the end of each session,
  lists the files that changed so the owner can download copies from GitHub.
  Never send snippets or hand-edit instructions.
- The repo is public. Claude can fetch the latest code from GitHub itself, so
  files don't need sending to it.
- Discuss first when there's a real design trade-off; build straight away when
  the request is concrete. State caveats and limitations plainly.
- Every release bumps `SHELL_CACHE_NAME` in `sw.js`; the number is the version
  shown in Settings. Say the new version number.
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
- Switching place never waits for the previous place's load: the new load
  starts at once and late results from the old one are dropped, never
  shown or cached under the new place (21 Nov 2026: "jumps back to the
  wrong place and weather doesn't load"). A place's snapshot is only
  cached once both the daily and hourly data have loaded.
- Sun hrs and Cloud (today) come from the latest model runs over the same
  24/48h window as the sheet, not yesterday's daily figure (that sat on
  "2 hrs" and a grey cloud all through a clear day, Nov 2026). Sun hrs on
  48h shows rest of today / tomorrow ("3/8"); on 24h, one figure for the
  next 24 h. Capped at daylight hours. Cloud averages daylight hours only.

## Forecasts and accuracy

- Merge as many user-selected forecasters' FFV-corrected data as possible.
- Met Office Spot (Nov 2026, v151): the Met Office's own site forecast via
  Weather DataHub ("Site Specific – Global Spot", free, 360 calls/day), as a
  tenth forecaster separate from the raw "metoffice" model. Each person uses
  their own key, saved in Settings on their device only — never in the repo.
  Their API allows direct browser calls, so no relay. The Met Office keeps no
  past forecasts, so Cloude records its own (per area, from each refresh)
  and learns fudge factors from that, once per past date; it joins the
  blend after the usual 14 days. Provides rain, wind, temperature, pressure
  and feels-like only. Not on the map (single points, not a grid).
- Met Office Spot gap-filling (Nov 2026, v152): a daily GitHub job
  (collect-mo-spot.yml, 20:41 UTC) records the forecast for the shared
  places into data/mo-spot-record.json, using the owner's key as the repo
  secret MO_SPOT_KEY. Places are keyed like the app's areas (outward code
  or one-decimal coordinates); nothing about the Met Office site is stored.
  A device's own record always wins; the shared one only fills missed days.
- Sources by place (Nov 2026, v153): the front page always blends all nine
  forecasters (the GitHub precache now fetches nine too, so it no longer
  switches between four and nine). Rain everywhere, including the map and
  the front-page strip, uses all nine. The map's other layers use the top
  four (precache-config.json topForecasters) to keep its cost down. Callout
  and Coast wind is the nine-forecaster median (wind-blend.js), not
  corrected, with the plain single-model download kept as a fallback and
  for visibility (most forecasters don't provide visibility).
- Only real forecasters, ever (Nov 2026, v150). Eleven placeholder names
  with made-up numbers (BBC, Meteoblue, YR, AccuWeather, Netweather,
  XCWeather, Weather Underground, WeatherAPI, Windy, OpenWeatherMap,
  Tomorrow.io) were removed along with the demo formula: after 14 days they
  had been qualifying for the daily blend like real sources. Where no real
  figure exists the app shows a blank, never an invented number. A name
  comes back only with a real data feed, starting its own record and
  joining the blend after the usual two weeks. Possible: YR (MET Norway's
  free API, needs a relay), OpenWeatherMap / WeatherAPI / Tomorrow.io (free
  keyed tiers, but mostly built from the same national models). Not
  realistic: BBC, Netweather, XCWeather (no public feed), Weather
  Underground (station owners only), AccuWeather, Meteoblue, Windy (paid).
- UV is not offered on Compare: no source keeps past UV forecasts.
- Everything shown is that blend — maps included. The map page and the
  front-page map strip use the same top forecasters as the precached front
  page (precache-config.json `topForecasters`), each FFV-corrected for the
  current place, then the median (Nov 2026, v149). Before that both maps
  asked Open-Meteo for its default "best match", which in the UK is the Met
  Office UKV model alone, and disagreed with the rain graph. Any Open-Meteo
  request whose numbers are shown as Cloude's forecast must name its models.
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

## Precache: stale places no longer shown as "now" (15 Nov 2026)
- Open-Meteo was answering many GitHub precache requests with 429. A failed place kept last run's data, but the file's dataAsOf still moved on, so the app trusted it. TA7's rain graph started at 06:00 when it was 14:00.
- The precache job now retries 429/5xx (waits 4s, 12s, 30s), fetches one place at a time, and stamps each place with its own fetchedAt.
- The app rejects a precached place if its fetchedAt is over 30 min old, or its first hour is over 90 min in the past, and does a live fetch instead.
- Follow-up the same day: the app also refuses a precached place holding fewer than seven of the nine forecasters (live fetch instead); fishing spots carry their own fetchedAt and are judged by it; the My Plot feed's "updated" is the TA7 place's own fetch time, not the file's.

## Overnight precache slowdown (15 Nov 2026)
- 22:00-03:00 UK time, GitHub refreshes each saved weather place hourly instead of every 20 min (about 500 fewer Open-Meteo requests a night). The My Plot feed's place (TA7) is exempt: My Plot's frost warning matters most overnight and it only trusts the feed for 40 min.
- The app accepts a place's data up to 75 min old in that window (30 min otherwise), and always trims hours that have already passed, so graphs still start at the current hour.
- Considered and rejected: fetching sunrise/sunset or soil temperature separately/less often. Open-Meteo counts each request as at least one call, so splitting items off adds calls rather than saving them. Same reason a GitHub-vs-phone split by item doesn't help.

## Sky pictures use blended cloud (16 Nov 2026)
- The Sunshine/Cloud sheet strip, the hour slider's sky icon and the frost-risk cloud check read Met Office cloud alone, while SUN HRS blends every source. On 16 Nov Met Office alone forecast thick cloud all day while six of seven sources expected 4-7 h of sun, so the sheet showed overcast beside "7/6".
- All of them now read state.hourly.skyLow/Mid/High: the blended cloud bands, falling back to Met Office per hour only where the blend has no value.

## Shared corrections (FFV) for shared places (16 Nov 2026)
- Why: each device learned its own FFV. On 16 Nov the phone showed 23.6 mm rain for Zoy (TA7) and the iPad 17.4 mm from the same forecasts. TA7 learned only from the yearly backfill file, and each device replayed that on top of what it already had, at different times — drift, plus double counting.
- Now: .github/workflows/backfill-weather.yml runs nightly at 03:40 UTC. backfill-weather.mjs tops each shared area up with its last 14 days (or back to the file's last date), or fetches a full year for a new area (max one new area per run, ~2,000 calls). build-shared-ffv.mjs then replays each area's history from scratch with app.js's own applyHistoryFileToFFV (lifted out of app.js at run time, so the maths can't drift) and writes data/shared-ffv/<area>.json. Also covers history.json's area (TA6).
- App: loadCommittedHistory / backfillRealSourceHistory use the shared file when one exists, replacing the nine Open-Meteo sources' FFV and eligibility for that area, then re-blend the front page. Unreachable file: last applied set stays. File older than 21 days: ignored. Met Office Spot still learns on the device.
- Safeguards: an area's file is only written with ≥60 days of actuals and ≥5 sources reporting in the last 30 days; otherwise the previous file stays.
- Also fixed: the per-device backfill-file path now rebuilds instead of adding the year on top again.
- Known gap: Cloud bands and Soil Temp have no past-forecast values from the Previous Runs API (always null), so they never get FFV — the Cloud cell's "Collecting data" never clears. Separate job.
- Taunton/Tiree/Teesside in precache-config.json have no areaCode, so they get no backfill or shared corrections until one is added.

## Removed Taunton/Tiree/Teesside from the precache (16 Nov 2026)
- They were hand-picked test places nobody uses, costing about 1,900 Open-Meteo requests a day in the 20-minute weather precache (plus Met Office Spot calls). weatherLocations is now empty; the shared favourites (TA7, SA62, CM7) carry on as before.
- Same day: removed the three test fishing spots too (Lowestoft, Lyme Regis, Liverpool), picked for spread and alliteration, not real use. None fed the Charmouth card (Lyme Regis is 2.7 km away, outside the 2 km match).

## BOM paused (23 Nov 2026)
- Open-Meteo sends BOM (bom_access_global) as blanks for every field, everywhere (checked TA7 and Sydney). The whole year of backfill and every day of history.json hold no BOM figures, so it never learned a correction and never joined a blend. Cloude has really been blending eight forecasters.
- Blanks were already handled safely: the blend, the per-device learning and the nightly shared-FFV job all skip a missing value rather than treating it as 0 mm.
- Paused, not deleted: every BOM line is commented out with a "PAUSED 23 Nov 2026" note (app.js x2, settings.js, wind-blend.js, scripts/precache-weather.mjs, collect-weather.mjs, backfill-weather.mjs) and its forecast-config.json entry removed. To bring it back: uncomment those lines, re-add `{ "id": "bom", "name": "BOM (Australia)", "enabled": true }` to forecast-config.json, and put the tests back to nine sources (map median 5, callout wind 14 from 9, ten Settings boxes).
- Saves about one Open-Meteo request in nine for the precache and daily jobs.

## Zero forecasts are scored, not learned from (23 Nov 2026)
- Before: recordFFVSample (and its real-source and Spot callers) skipped any forecast of exactly 0, because the correction divides actual by forecast. So "said 0 mm, 9 mm fell" never counted against a model, and every correct dry call was left out too.
- Now (option 1 of 5 discussed): a 0 forecast is scored for accuracy (raw and corrected error) but leaves count, ratio and offset untouched, so the correction still learns only from days a model forecast some amount. A missing (null) forecast is still skipped completely. Applies to every condition (a 0.0 degC temperature forecast too).
- Effect on TA7 rain, day 1: correction factors unchanged; average errors fall (e.g. Met Office 2.54 -> 1.73 mm), because most dry calls were right. Over the year each model said 0 mm on 136-176 days and 1 mm or more fell on 5-16 of them (Met Office/ECMWF/CMA 5, Meteo-France 16).
- Rejected: counting 0 as 0.1 mm (one wet day blows the ratio up) and a fixed mm top-up (shows drizzle on every dry day). Possible follow-on: a separate "missed rain" score per model on Compare.
