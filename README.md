# Instafn (userscript build)

A userscript port of [instafn](https://github.com/xafn/instafn), an
Instagram web mod. Built with a small MuJS-hosted compiler instead of
npm/vite -- see "How it's built" below. Works in both Tampermonkey and
Violentmonkey, on both Chrome and Firefox.

## Install

1. Build it (see below), or grab `dist/instafn.user.js` if it's already built.
2. Open it in a browser with Tampermonkey/Violentmonkey installed, or drag
   it onto the extension's dashboard. Confirm the install prompt.
3. Visit instagram.com. A small gear button appears bottom-right -- click it
   (or use the manager's menu -> "Instafn settings") for the settings page.

## Build

```sh
apt install libmujs-dev    # or build mujs from source, see Makefile
make
```

Produces `dist/instafn.user.js`. `make rebuild` re-runs the transform
without recompiling the C build tool; `make clean` removes both.

## Layout

```
tools/build.c        MuJS host: readFile/writeFile/exists/log for
                      transform.js, plus the plain-C parts (directory walk,
                      userscript @grant/@match/header block) -- adapted from
                      avroc.c (Avroscript) + bundlejs's build.c/build.h split.
tools/build.h         The C-side helpers (file IO, dir walk, header emission).
tools/transform.js    Runs under MuJS. Strips ES module import/export from
                      the vendored source and rewraps each file as a
                      CommonJS-lite module; also builds the settings-page
                      assets (see below).
src/shim/             Hand-written glue -- everything the extension had that
                      a userscript can't (chrome.storage, background
                      service worker, popup/settings pages).
vendor/instafn/       Unmodified copy of upstream's src/content/ and
                      src/settings/. To pick up an upstream update: replace
                      this directory with the new copy and `make rebuild`.
dist/instafn.user.js  Build output.
```

## What changed vs. the extension, and why

Everything below is a shim living in `src/shim/` -- **the vendored feature
code itself is untouched**, byte-for-byte from upstream. `chrome`, `fetch`,
etc. are just local variables inside the bundle's closure that happen to
shadow what the vendored files already call.

- **`chrome.storage.sync/local`** -> `GM_getValue`/`GM_setValue`, with a
  synthesized `chrome.storage.onChanged` so existing listeners still fire.
- **Downloads** (background service worker -> `chrome.downloads`) ->
  `GM_download`. Cross-origin CDN fetches (cdninstagram.com/fbcdn.net,
  previously CORS-free via `host_permissions`) -> a local `fetch()` shadow
  that routes just those hosts through `GM_xmlhttpRequest`; everything else
  (instagram.com itself) still uses the real `fetch`, cookies included.
- **Page-context script injection** (`<script src=chrome-extension://...>`,
  needed to escape the isolated content-script world and patch the *page's*
  WebSocket/fetch) -> called directly against `unsafeWindow`. No script tag
  means Instagram's CSP never enters into it.
  - On Firefox, a sandbox function assigned directly onto `unsafeWindow`
    isn't reliably usable by the page as a constructor (`new`/`instanceof`
    across the Xray boundary). A small `Proxy` in front of `unsafeWindow`
    runs every function-valued `window.X = ...` these scripts do through
    `exportFunction` automatically when it's available (Firefox only --
    it's a no-op passthrough on Chrome). Nothing in the vendored scripts
    needed to change for this.
- **Popup + settings.html** -> the *actual* vendored `settings.html` /
  `settings.css` / `settings.js` / `settings-shared.js` / `toast.js`,
  mounted as a full-viewport overlay inside the current Instagram tab
  (`#instafn-settings-root`) instead of a separate extension page. This
  keeps GM_* storage access working (a genuinely separate tab would need
  the userscript manager's `@match` to cover whatever URL it opened, which
  is unreliable for `data:`/`blob:` URLs across managers) and means
  "reload the Instagram tab after saving" is just `location.reload()`.
  `settings.css` is scoped under `#instafn-settings-root` at build time
  (see `scopeCss` in transform.js) so it can't leak onto the rest of the
  page. **Removed**: the "are you sure?" confirmation prompts before
  enabling Typing Receipt Blocking / Native DM Themes / Follow Analyzer
  (`CONFIRM_ON_ENABLE` in `settings-shared.js`) -- emptied at build time,
  a product decision rather than a technical shim.
- **`chrome.tabs.query/reload/create`** (used only by the settings page, to
  reload "the Instagram tab" after saving) -> `location.reload()` /
  `window.open()`, since the settings UI now lives in that same tab.
- **`chrome.runtime.getManifest().version`** -> `GM_info.script.version`.

## Testing

`test/smoke.js` boots the built bundle in jsdom with stubbed `GM_*`/
`unsafeWindow` (and, in a second pass, stubbed `exportFunction`/`cloneInto`
to exercise the Firefox code path) and exercises the settings overlay end
to end: mount, splash -> continue, toggle flip, nested enable/disable, and
confirms no confirmation dialog fires anymore. It is **not** a substitute
for testing against real Instagram DOM -- that needs a real browser and a
real page.

## Known limitations

- Feature-level behavior (follow analyzer, media downloader, message
  logger, etc.) is verified to *load* without errors, not verified against
  live Instagram markup -- that vendored code is completely unmodified from
  upstream, so it should behave identically, but hasn't been exercised
  end-to-end outside of the extension.
- `exportFunction`/`cloneInto` handling covers direct `window.X = fn`
  assignments (WebSocket, fetch) in the 5 page-context scripts. A function
  nested inside an assigned object (e.g. a method added later onto
  `window.InstafnStory`) isn't separately exported; low risk since nothing
  in the vendored code has Instagram's own page scripts calling into that
  object directly.
