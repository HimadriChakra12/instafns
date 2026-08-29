// ---------------------------------------------------------------------
// chrome.* shim
//
// Every vendored feature file still says `chrome.storage.sync.get(...)`,
// `chrome.runtime.sendMessage(...)`, etc. -- completely unmodified from the
// upstream extension. We don't touch that code at all; instead we declare a
// local `chrome` inside this same closure that shadows whatever `window.
// chrome` may or may not exist (Firefox has none, Chrome's real one is a
// different, unrelated object) and backs the same call shapes with GM_*
// storage. Every vendored module resolves the bare identifier `chrome` to
// this one, because they're all concatenated into one function scope.
// ---------------------------------------------------------------------

var __onChangedListeners = [];

function __gmGet(key, fallback) {
    try {
        var v = GM_getValue(key);
        return v === undefined ? fallback : v;
    } catch (e) {
        return fallback;
    }
}

function __gmSet(key, value) {
    GM_setValue(key, value);
}

// Shared by chrome.storage.sync.get and chrome.storage.local.get. `query` is
// either an array of keys (no defaults -- missing keys are simply absent
// from the result, matching chrome.storage semantics), a single string key,
// or an object mapping key -> default value.
function __storageGet(query, callback) {
    var result = {};
    if (Array.isArray(query)) {
        for (var i = 0; i < query.length; i++) {
            var k = query[i];
            var v = __gmGet(k, undefined);
            if (v !== undefined) result[k] = v;
        }
    } else if (typeof query === "string") {
        var sv = __gmGet(query, undefined);
        if (sv !== undefined) result[query] = sv;
    } else if (query && typeof query === "object") {
        for (var key in query) {
            if (!Object.prototype.hasOwnProperty.call(query, key)) continue;
            result[key] = __gmGet(key, query[key]);
        }
    }
    // chrome.storage callbacks are technically async; a microtask keeps that
    // contract without actually costing anything (GM_getValue is sync).
    Promise.resolve().then(function () { callback(result); });
}

function __storageSet(items, callback) {
    var changes = {};
    for (var key in items) {
        if (!Object.prototype.hasOwnProperty.call(items, key)) continue;
        var oldValue = __gmGet(key, undefined);
        var newValue = items[key];
        __gmSet(key, newValue);
        changes[key] = { oldValue: oldValue, newValue: newValue };
    }
    Promise.resolve().then(function () {
        if (callback) callback();
        for (var i = 0; i < __onChangedListeners.length; i++) {
            try { __onChangedListeners[i](changes, "sync"); } catch (e) { console.error("[Instafn] onChanged listener threw:", e); }
        }
    });
}

// ---- downloads bridge --------------------------------------------------
// Upstream: content script -> chrome.runtime.sendMessage -> background
// service worker -> chrome.downloads.download (bypasses CORS on
// cdninstagram/fbcdn because the browser fetches it, not the page). A
// userscript has no service worker, but GM_download does the exact same
// job -- it's a manager-side fetch + save, not a page fetch, so it doesn't
// touch CORS either.
function __performDownload(msg, sendResponse) {
    if (typeof GM_download !== "function") {
        sendResponse({ ok: false, error: "GM_download is not available (grant missing?)" });
        return;
    }
    try {
        GM_download({
            url: msg.url,
            name: msg.filename || undefined,
            saveAs: !!msg.saveAs,
            onload: function () { sendResponse({ ok: true }); },
            onerror: function (err) {
                sendResponse({ ok: false, error: (err && (err.error || err.details || err.message)) || "download failed" });
            },
            ontimeout: function () { sendResponse({ ok: false, error: "download timed out" }); }
        });
    } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
    }
}

var chrome = {
    storage: {
        sync: {
            get: function (query, callback) { __storageGet(query, callback); },
            set: function (items, callback) { __storageSet(items, callback); }
        },
        local: {
            get: function (query, callback) { __storageGet(query, callback); },
            set: function (items, callback) { __storageSet(items, callback); }
        },
        onChanged: {
            addListener: function (fn) { __onChangedListeners.push(fn); }
        }
    },
    runtime: {
        getURL: function (path) {
            // Only utils/scriptInjector.js and utils/styleLoader.js ever called
            // this upstream, and both of those vendored files are swapped out
            // for userscript-native replacements below (see
            // shim/02-page-inject.js) that never call getURL at all. Anything
            // else hitting this is new/unexpected -- fail loudly instead of
            // silently returning a dead chrome-extension:// URL.
            console.warn("[Instafn] chrome.runtime.getURL() called for", path, "-- this has no userscript equivalent");
            return path;
        },
        getManifest: function () {
            var version = (typeof GM_info !== "undefined" && GM_info.script && GM_info.script.version) || "0.0.0";
            return { version: version };
        },
        sendMessage: function (message, callback) {
            if (message && message.type === "INSTAFN_DOWNLOAD") {
                __performDownload(message, callback || function () {});
                return;
            }
            if (callback) callback(undefined);
        },
        lastError: undefined
    },
    // The settings page originally reloaded whichever browser tab had
    // Instagram open, from a *separate* settings tab. That page is now
    // mounted as an overlay inside the Instagram tab itself (see
    // shim/03-settings-page.js), so "the active Instagram tab" is just
    // this document -- reload it directly instead of actually querying tabs
    // (a real chrome.tabs API has no userscript equivalent regardless).
    tabs: {
        query: function (_queryInfo, callback) {
            callback([{ active: true, url: location.href, id: 0 }]);
        },
        reload: function () {
            location.reload();
        },
        create: function (opts) {
            window.open(opts && opts.url, "_blank");
        }
    }
};

// ---------------------------------------------------------------------
// fetch shim for the Instagram CDN hosts
//
// The extension could fetch() cdninstagram.com/fbcdn.net/fbsbx.com straight
// from the content script without hitting CORS, because those hosts are
// listed in manifest.json's host_permissions. A userscript has no such
// grant, and a plain page fetch() to those hosts *would* hit CORS. Route
// just those hosts through GM_xmlhttpRequest (a manager-side request, not
// a page one -- CORS doesn't apply) and return a Fetch-API-shaped Response
// so the vendored code (which only ever calls .ok/.status/.arrayBuffer())
// doesn't need to change at all. Instagram's own domain still goes through
// the real fetch, unchanged, so credentials/cookies keep working normally.
// ---------------------------------------------------------------------

var __CDN_HOST_RE = /(^|\.)(cdninstagram\.com|fbcdn\.net|fbsbx\.com)$/i;
var __realFetch = window.fetch.bind(window);

function __isCdnUrl(url) {
    try {
        var host = new URL(url, location.href).hostname;
        return __CDN_HOST_RE.test(host);
    } catch (e) {
        return false;
    }
}

function __gmFetchBytes(url) {
    return new Promise(function (resolve, reject) {
        if (typeof GM_xmlhttpRequest !== "function") {
            reject(new Error("GM_xmlhttpRequest is not available (grant missing?)"));
            return;
        }
        GM_xmlhttpRequest({
            method: "GET",
            url: url,
            responseType: "arraybuffer",
            onload: function (resp) {
                if (resp.status >= 200 && resp.status < 300) {
                    resolve({ ok: true, status: resp.status, body: resp.response });
                } else {
                    resolve({ ok: false, status: resp.status, body: null });
                }
            },
            onerror: function () { reject(new Error("GM_xmlhttpRequest network error for " + url)); },
            ontimeout: function () { reject(new Error("GM_xmlhttpRequest timed out for " + url)); }
        });
    });
}

function fetch(url, opts) {
    if (typeof url === "string" && __isCdnUrl(url)) {
        return __gmFetchBytes(url).then(function (r) {
            return {
                ok: r.ok,
                status: r.status,
                arrayBuffer: function () { return Promise.resolve(r.body); },
                blob: function () { return Promise.resolve(new Blob([r.body])); }
            };
        });
    }
    return __realFetch(url, opts);
}
