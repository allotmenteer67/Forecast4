// Cloude service worker — makes the installed app shell (HTML/CSS/JS)
// available instantly and offline, so opening the app never shows a
// blank "not connected" screen. Only live weather/postcode data needs a
// real connection, and the app already shows its own inline status
// messages when that's unavailable — this only covers the app's own
// files, nothing more.
//
// Strategy: stale-while-revalidate for every same-origin app-shell file —
// serve whatever's cached immediately (fast, and works with no
// connection at all), then fetch a fresh copy in the background to
// update the cache for next time. Deliberately needs no manual "bump the
// cache version" step on every deploy — each update to app.js/style.css
// gets picked up automatically the next time the app opens online.
//
// BUT: "picked up automatically" only means the NEXT open gets a fresh
// copy in the background — THIS open still serves whatever was cached
// from before, stale-while-revalidate's whole point. That's invisible
// for small tweaks, but map.js isn't even in SHELL_FILES below (it's
// still cached anyway — the fetch handler applies this strategy to
// every same-origin request, not just the precached list) and a
// substantial change to it (new layers, new fetch/dedupe logic) landing
// on top of an old cached copy is a real way for things to look like
// they've silently broken or reverted after a deploy, with no error
// anywhere to explain why. Bumping this version string forces every
// old cache to be dropped on the next activate (see below) and
// everything refetched fresh — do this on any deploy where "it looks
// like an old version" is a live possibility, not just for
// SHELL_FILES changes.
//
// Bumped to v6: waterways/lakes rendering (the new "waterways" layer,
// lakes folded into clipToLand, the river palette colour) and the
// place-label rank caps all landed in map.js AFTER v5 was set — v5 was
// bumped specifically to clear the drag-diagnostics removal, one
// message before waterways got built, so it never actually included
// any of this. Textbook case of exactly what these version bumps
// exist to prevent: real new code sitting unseen behind a cache that
// looks current but predates it.
//
// Bumped to v7: the river/estuary clip fix in map.js (rivers were
// drawing out into the sea at estuary mouths — clipToLand now applied
// to the waterways layer) and the iOS status-bar relayout fix in
// app.js (forceIOSStatusBarRelayout, replacing the scroll-only nudge
// that was confirmed on a real device NOT to clear the grey strip).
// Both are files already in SHELL_FILES, so both would otherwise be
// served from the v6 cache indefinitely — the exact failure mode the
// v6 note below describes, one deploy later. The status-bar fix in
// particular would be impossible to evaluate from behind a stale
// cache: it'd look like the fix simply didn't work.
//
// Bumped to v8: the same river/estuary clip fix now applied to
// map-strip.js as well. v7 covered map.js's own waterways layer, but
// the front-page strip draws rivers through its own separate code
// path and was missed — confirmed on a real device, where the
// expanded map came out correct and the strip still showed rivers
// running into the sea. map-strip.js is in SHELL_FILES, so without
// this bump the strip would keep being served from the v7 cache and
// the fix would look like it hadn't worked.
//
// Bumped to v9: tide sheet now opens scrolled to the last past tide
// event instead of the raw left edge of the 24h-past/72h-future
// window — previously every open started a full day back, showing
// tides that had already happened before you could see what's still
// ahead. tide-ui.js is in SHELL_FILES, so without this bump it would
// keep being served from the v8 cache and the fix would look like it
// hadn't worked.
// Bumped to v10: apple-mobile-web-app-status-bar-style changed from
// "default" to "black-translucent" on every page (index/compare/
// settings/help/map .html) — "default" was iOS painting its own solid
// grey bar behind the status-bar icons on every launch, unrelated to
// the sheet-close grey-strip issue noted in v7 above. All five .html
// files are in SHELL_FILES, so without this bump they'd keep being
// served from the v9 cache and the fix would look like it hadn't
// worked.
// Bumped to v16: map.js now persists its weather grid to localStorage
// (same MAP_STALE_MS window its in-memory checks already use, keyed on
// rounded centre + radius, values rounded to 1dp to keep the worst-case
// 150km grid under ~0.9MB). map.html is its own document, so every
// arrival previously started with an empty grid and refetched 81-361
// locations — the same per-location billing that caused the daily-limit
// error, now closed on the map page as well as the strip.
//
// Bumped to v15: the title strip overlapping the status bar, now with
// a cause. viewport-fit=cover lets the page draw under the status bar,
// and .app relied on env(safe-area-inset-top) to clear it — but in
// standalone (installed PWA) mode iOS does not reliably report that
// inset, and when it resolves to 0 the calc collapsed to 2px, putting
// the title and chips straight on top of the clock. style.css now uses
// max(calc(2px + env(...)), 44px) under a display-mode: standalone
// query, so a real inset still wins and a missing one gets a floor.
//
// Bumped to v14: map-strip.js now caches its grid fetch (localStorage,
// 60 min, keyed on the rounded centre). That one call asks Open-Meteo
// for 256 locations and Open-Meteo bills per location, so every
// uncached front-page load spent ~256 of the 10,000/day free-tier
// allowance — about 39 launches — which is what produced the "Daily API
// request limit exceeded" error on device.
//
// Bumped to v13: the grey status-bar strip, now diagnosed properly —
// iOS samples the page colour under the status bar WHILE the sheet
// backdrop is open (the blend computes to exactly the reported grey)
// and never re-samples on close. forceIOSStatusBarRelayout in app.js
// now toggles theme-color, which is the meta iOS actually re-reads,
// instead of the viewport meta the v11 attempt toggled; .sheet-backdrop
// in style.css also now goes visibility:hidden when closed.
//
// Bumped to v12: the black-translucent status-bar experiment from v10
// reverted on all five .html files (it fixed the grey strip but pushed
// the title under the notch — the spacing under "default" was already
// right), plus the real map-strip fix in style.css: .app-home had
// min-height: 100svh with no matching max-height, so flex-shrink never
// engaged and the strip could grow into spare space but never give it
// back. style.css and all five .html files are in SHELL_FILES.
//
// Bumped to v11: closeHourlySheet's grey-status-bar-strip workaround
// replaced — a no-op scroll (v6-era) was confirmed on a real device to
// NOT clear it; forceIOSStatusBarRelayout() (a viewport-meta toggle)
// replaces it in app.js. app.js is in SHELL_FILES, so without this bump
// it would keep being served from the v10 cache and the fix would look
// like it hadn't worked.
//
// Bumped to v17: adding a tide/fishing location now checks it against
// the same elevation-uk.json and coastline-50m.json data map.js already
// uses, and warns (doesn't block) when a location is BOTH far from the
// sea AND well above it — genuinely inland/upland spots like Snowdon,
// not high-but-coastal ones like a clifftop path, which stay unflagged
// on purpose. tide.js and tide-ui.js are both in SHELL_FILES, so
// without this bump they'd keep being served from the v16 cache and the
// warning would never appear.
// Bumped to v18: a batch of front-page/map/tide fixes — (1) the map
// strip's rain grid no longer leaves blank rectangles either side (the
// projection was scaling to the strip's shorter dimension, so the
// wider one showed more real distance than the fetched grid covered —
// now scales to the longer dimension instead); (2) the coastline
// outline is bolder (1 -> 1.5px) and, on the strip, now gets a
// stroke-only redraw AFTER the rain layer the same way the full map
// already does, so rain can no longer bury it entirely; (3) the map's
// time/conditions pill moved from bottom-right to top-right and no
// longer shows the zoom-distance figure or the word "Now"; (4)
// map.html's header now matches the front page's own icon/title/
// back-link layout instead of a separate stacked arrangement, and its
// now-redundant bottom Settings link is gone; (5) the divider between
// the headline grid and the Hour slider is bolder (1 -> 2px); (6) the
// tide sheet's scrollable window widened from 24h-past/72h-future to a
// full 7 days each way — no technical or licensing reason was ever
// found for the old, narrower figure; (7) the map's zoom buttons no
// longer stay visually "pressed" after a tap (blur() plus tap-
// highlight suppression); (8) the temperature legend now previews the
// SAME partial-opacity blend the layer itself actually paints with,
// instead of a full-strength colour nothing on the map ever shows —
// the mismatch between those two was the real cause of a reported
// reading looking like it belonged to a noticeably warmer swatch than
// its own true value. map.js, map-strip.js, style.css, map.html and
// tide-ui.js are all in SHELL_FILES, so without this bump every one of
// these would keep being served from the v17 cache and look like none
// of it had worked.
// Bumped to v19: the real fix for rivers drawing out into the sea at
// estuary mouths (#17) — a previous session's handover notes claimed
// this was already done (clipToLand applied to the waterways layer),
// but the actual code never called it for that layer at all, on either
// map.js or map-strip.js; confirmed still broken even after a full
// Safari "delete website data" wipe ruled out a stale cache as the
// explanation. Both files' waterways layers now clip to land the same
// way their terrain layers already did. Cross-checked the other two
// "already fixed" items (#2's forceIOSStatusBarRelayout, #3's
// .app-home max-height) against the real files while here — both
// genuinely exist in the code, unlike waterways' clip, so if either is
// still misbehaving it's a real remaining edge case, not another
// phantom fix.
// Bumped to v20: two changes. (1) The tide overlay on the fishing
// graph no longer auto-scales to the full plot height alongside the
// score curve — it was reading as a second, equally-weighted data
// series rather than the background timing reference it's meant to be;
// now confined to a band at the bottom of the chart instead. (2) The
// front page's tide/fishing swipe-to-switch-location gesture now works
// from either card, not just the tide card — it used to live on
// tideRow alone, and the small place-dot icons below the pair existed
// specifically because there was no other way to switch location from
// the fishing side. Both the tide-only restriction and the dots are
// gone; swiping either card in the pair now switches both. index.html,
// style.css, tide-ui.js and fishing-ui.js are all in SHELL_FILES.
// Bumped to v21: the expanded map's Hour slider now steps in half-hours
// (MAP_HOUR_STEP in map.js) — a client-side blend between the two
// nearest hourly grid values already in memory, not genuinely finer
// weather data (Open-Meteo has none to offer here). Deliberately built
// around one single constant: every part of it (slider step, hour
// rounding, sampleGrid/sampleWindDir's interpolation, mapHourClock's
// readout, the autoplay increment) collapses back to its old exact
// behaviour at whole hours, so setting MAP_HOUR_STEP back to 1 is a
// complete, one-line revert if this reads as too smooth or misleading.
// Wind direction and the pressure/isobar contours still snap to the
// nearest whole hour rather than attempting to blend an angle or a
// traced contour line — the same call already made for wind direction,
// extended to isobars, which was a genuine crash risk otherwise (that
// layer indexes the grid array directly, not through sampleGrid).
// Bumped to v22: two changes, working together. (1) The front page's
// recent-location cache (app.js) widened from 5 to 15 minutes and now
// actually SKIPS the Open-Meteo fetch within that window, rather than
// only painting a cached snapshot instantly while still refetching
// behind it every time — this is the change that makes switching
// between a couple of saved places feel instant on repeat visits AND
// cuts real request count. (2) The map strip and headline card are now
// swipeable to switch between saved weather places, same pointer-based
// technique as tide/fishing's own swipe, with the hour slider
// explicitly excluded from the headline's tracking so its own native
// drag is untouched. Two separate swipe targets rather than one shared
// wrapper, deliberately — wrapping them together would have pulled
// .map-strip out from being a direct child of .app-home, breaking the
// flex-shrink sizing that keeps the date bar on screen. app.js and
// style.css are both in SHELL_FILES.
// Bumped to v23: two changes. (1) The place name now shows on the front
// page's own headline card, to the right of "Today and Tomorrow" — a
// new currentPlaceLabel() helper (app.js) is shared with the header's
// place chip, so the two can never show a different name for the same
// place. (2) Verified (not just assumed) that the recent-location cache
// genuinely covers a second, third, etc. saved place, not just the
// first — cacheCurrentLocationSnapshot() is keyed by postcode into a
// plain dictionary, and every completed load calls it for whatever
// place that load was actually for, so switching between several places
// builds up a genuinely multi-entry cache. No code change was needed
// for that part, only confirmation. index.html, app.js and style.css
// are all in SHELL_FILES.
// Bumped to v24: tide's fit-building (tide.js) now coalesces a
// station's very first build the same way its weekly background
// refresh already did — swiping to a never-before-cached station,
// swiping away, then back again before that first EA fetch finishes no
// longer fires a second, fully redundant fetch. tide.js is in
// SHELL_FILES.
// Bumped to v25: the map strip's own re-centring depends entirely on
// the "cloude:location-ready" event (map-strip.js has no other way to
// learn where to move to) — which the new caching guard in
// loadLocationData() (app.js, v22) was bypassing on every cache hit,
// since that event is normally only dispatched from inside
// runLoadLocationData(), which the cache-skip path never calls. That's
// the actual explanation for the map strip silently showing the wrong
// place after switching — permanently, since nothing else was ever
// going to prompt a redraw. The cache-skip path now dispatches the same
// event itself, using state.lat/state.lon already restored by
// resetForLocationChange() a few lines earlier. app.js is in
// SHELL_FILES.
// Bumped to v26: two changes to the front page's place name (chip +
// headline card). (1) County dropped from both — currentPlaceLabel()
// (app.js) now trims to before the first comma, same treatment
// tide/fishing's own cards already had, just not previously extended
// here. Settings' places list and the switch-place dropdown menu are
// deliberately left showing full labels still, for the same reason
// tide/fishing's own version keeps them full: telling apart two
// same-named places in different counties matters exactly where you're
// choosing between them. (2) The headline card's place name now pins to
// the right via margin-left: auto rather than the row's own
// justify-content: space-between — functionally the same result for
// two items, but more direct and not dependent on exactly two items
// being in the row. If "Today and TomorrowSomerset" (no gap at all) was
// showing on a real device despite the CSS already being correct for
// that case, it strongly suggests the style.css from the batch that
// added this (v23) didn't actually make it into that deploy — worth
// double-checking all files from a batch land together. app.js and
// style.css are both in SHELL_FILES.
// Bumped to v27: stage 2 of GitHub precaching — app.js and fishing.js
// now actually READ data/precache-weather.json, not just the GitHub
// Action that writes it. fetchHourlyForecast (the 9-source fetch that
// drives the front page's headline) and fishing.js's own forecast fetch
// both check the precache first, matched by PROXIMITY to the resolved
// coordinates (not postcode/id string, which would be fragile against
// however this device's own geocoding happens to round). A genuine hit
// skips the live Open-Meteo call(s) entirely and populates state
// through the exact same blend/correction code a live fetch uses
// (applyHourlyBlend, extracted from fetchHourlyForecast so there's one
// implementation, not two that could drift). Everywhere else falls
// through to the live fetch completely unaffected.
//
// Scope, stated plainly: this covers the hourly/headline fetch and
// fishing's own fetch — the two costs this feature was actually sized
// against. fetchActualWeather and the nine parallel fetchRealSourceLive
// calls (accuracy tracking / FFV learning, not the instant display)
// still run live on every switch, untouched — short-circuiting those
// safely needs more care than this pass, given they feed the learning
// system rather than just what's on screen. app.js and fishing.js are
// both in SHELL_FILES.
// Bumped to v28: refresh buttons for weather and fishing. Weather's
// sits on the headline's own date row, immediately left of the place
// name (index.html/style.css); fishing's sits in its card's top-right
// corner as a sibling of fishingRow, since a <button> can't nest another
// interactive control inside it. Both use var(--accent) — confirmed
// against the Gold theme specifically (the one where "will this stand
// out" was a real question) that it still reads as a distinct filled
// circle, same as the existing Play button already does on that theme.
//
// Wired via a new `force` parameter threaded through loadLocationData
// -> runLoadLocationData -> fetchHourlyForecast (app.js) and
// renderFishingRow -> fetchFishingForecast (fishing-ui.js/fishing.js) —
// force=true skips both the live 15/30-minute caches AND the GitHub
// precache entirely, going straight to a genuine live fetch. Also
// excluded both new buttons from their respective swipe-to-switch
// trackers' pointerdown handling (the headline's own, and the
// tide+fishing pair's), matching the same exclusion the Hour slider
// already had, so a tap on either button can't be misread as a swipe
// gesture starting there. index.html, style.css, app.js, fishing.js,
// fishing-ui.js and tide-ui.js are all in SHELL_FILES.
//
// Bumped to v58: split into two caches instead of one. Everything
// above this point was one CACHE_NAME shared by the app-shell files
// AND the static geo data files (data/waterways.json — 8+MB on its
// own — plus elevation-uk.json, coastline-50m.json, lakes-50m.json,
// places.json). That meant every shell bump above, including ones
// for a one-line CSS tweak with nothing to do with maps, wiped the geo
// data out of the cache too (activate deletes anything that isn't the
// current CACHE_NAME) and forced a full re-fetch of 10MB+ on the next
// map open — on a phone, possibly on poor signal, for data that never
// actually changed.
//
// SHELL_CACHE_NAME still bumps on every deploy exactly as CACHE_NAME
// always did. GEO_CACHE_NAME is new and versioned completely
// separately — it should only ever be bumped when the underlying data
// files themselves are regenerated (a new elevation build, more
// waterways coverage), never for an ordinary app-code deploy. The
// activate handler below now keeps both names alive, so a shell bump
// no longer touches the geo cache at all.
//
// The geo files are also now precached proactively (GEO_DATA_FILES,
// added to install alongside SHELL_FILES) rather than only being
// cached lazily the first time map.html happens to be opened — so a
// fresh install downloads them once, up front, and every map open
// after that is offline-safe even if the map page itself was never
// visited yet. Guarded by caches.has(GEO_CACHE_NAME) first, so a
// routine shell-only deploy (GEO_CACHE_NAME unchanged) doesn't
// re-trigger that whole fetch on every single install — only a
// genuinely fresh geo cache (first install ever, or a deliberate
// GEO_CACHE_NAME bump) does.
// Bumped to v59: removed solar.html/solar.js/solar-ui.js from
// SHELL_FILES. They were added in v58 on the untested assumption that
// they existed, because every page's bottom nav links to solar.html —
// never actually confirmed the files themselves had been built (the
// solar feature was spec'd, not built, as of that session). If any one
// of them 404s, cache.addAll() fails its ENTIRE install, which can
// silently stop a service worker update from ever taking effect at
// all — not just fail to precache those three files. Real risk: this
// may be why v58 never actually activated, reported as the expanded
// map going blank with no error shown anywhere. Re-add once solar's
// files are confirmed to exist; everything not in this list still
// works fine via ordinary lazy caching in the meantime.
const SHELL_CACHE_NAME = "cloude-shell-v59";
const SHELL_FILES = [
  "index.html",
  "compare.html",
  "settings.html",
  "help.html",
  // map.html/map.js/map-strip.js added to the precache list. They were
  // always cached anyway (the fetch handler applies to every
  // same-origin request, not just this list), but only lazily, on first
  // visit — so the map page alone didn't work offline until it had been
  // opened once online. No reason for it to be the one page that
  // doesn't, especially now it's a main destination rather than an
  // afterthought.
  "map.html",
  "map.js",
  "mapstrip3.js",
  "app.js",
  "settings.js",
  "tide.js",
  "tide-ui.js",
  "fishing.js",
  "fishing-ui.js",
  "style.css",
  "manifest.json"
];

// Bump this only when the DATA underneath actually changes (a fresh
// elevation build, a wider waterways extract, a places.json update) —
// never for an app-code deploy. Bumping it is exactly like bumping
// SHELL_CACHE_NAME: it makes activate() below drop the old geo cache
// and install() repopulate it fresh, the same "force a clean refetch"
// escape hatch SHELL_CACHE_NAME has always given the app files.
const GEO_CACHE_NAME = "cloude-geo-v1";

// Rivers/canals, terrain, coastline, lakes, place points — see the
// v58 note above for why these are cached separately from the app
// shell. Matched by exact filename in the fetch handler below, not a
// blanket "anything under data/" rule, because data/ also holds
// precache-config.json / precache-weather.json / history.json, which
// are refreshed daily by GitHub Actions and need the ordinary
// frequently-revalidated shell treatment, not this rarely-bumped one.
const GEO_DATA_FILES = [
  "data/waterways.json",
  "data/elevation-uk.json",
  "data/coastline-50m.json",
  "data/lakes-50m.json",
  "data/places.json"
];

function isGeoDataRequest(pathname) {
  return GEO_DATA_FILES.some(file => pathname.endsWith("/" + file));
}

self.addEventListener("install", event => {
  event.waitUntil(
    (async () => {
      const shellCache = await caches.open(SHELL_CACHE_NAME);
      await shellCache.addAll(SHELL_FILES);

      // Only populate the geo cache if it doesn't exist yet under its
      // current name — a plain shell deploy (GEO_CACHE_NAME unchanged)
      // means it's already sitting there from an earlier install, so
      // skip re-downloading 10MB+ of rivers/terrain/coastline for
      // nothing. This only actually fetches on a genuinely fresh
      // install (new device, cleared site data) or right after a
      // deliberate GEO_CACHE_NAME bump.
      const hasGeoCache = await caches.has(GEO_CACHE_NAME);
      if (!hasGeoCache) {
        const geoCache = await caches.open(GEO_CACHE_NAME);
        await geoCache.addAll(GEO_DATA_FILES);
      }

      await self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(names => Promise.all(
        names
          .filter(n => n !== SHELL_CACHE_NAME && n !== GEO_CACHE_NAME)
          .map(n => caches.delete(n))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);

  // Only this app's own GET requests are handled here. Everything else —
  // Open-Meteo, postcodes.io, any cross-origin call — passes straight
  // through untouched, so live weather data behaves exactly as it
  // already does: works online, fails with the app's own status message
  // offline. This service worker is deliberately never in that path.
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;

  // Same stale-while-revalidate strategy either way — only WHICH cache
  // a file lives in differs (see the v58 note above). A geo data file
  // still gets a background revalidation fetch on every request just
  // like a shell file does; what changes is that a shell version bump
  // can no longer evict it.
  const cacheName = isGeoDataRequest(url.pathname) ? GEO_CACHE_NAME : SHELL_CACHE_NAME;

  event.respondWith(
    caches.open(cacheName).then(async cache => {
      const cached = await cache.match(event.request);
      const network = fetch(event.request)
        .then(response => {
          if (response.ok) cache.put(event.request, response.clone());
          return response;
        })
        .catch(() => null); // offline — fall back to whatever's cached below

      return cached || (await network) || Response.error();
    })
  );
});
