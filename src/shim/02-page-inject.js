// ---------------------------------------------------------------------
// Page-context script runner
//
// Upstream, these 4 files (socket-sniffer, graphql-sniffer, storyblocking,
// voice-sniffer, websocket-interceptor) got injected via a <script src=
// chrome-extension://...> tag, specifically to escape the content script's
// isolated JS world and patch the *page's* window.WebSocket/fetch/etc, since
// Instagram's own scripts only see patches made to their own real window.
// Instagram's CSP blocks inline <script> tags, which is why the extension
// needed a src= URL instead of just writing the code inline.
//
// A userscript sidesteps this entirely: with @grant unsafeWindow, we already
// have a live reference to the page's real window object, and calling a
// plain JS function against it is not a script *tag* at all -- there's
// nothing for Instagram's CSP to block, because we never ask the page to
// parse or fetch anything. So instead of injecting a URL, we just call the
// vendored IIFE body directly, with its `window` parameter bound to
// unsafeWindow. The vendored source for these files is completely
// unmodified (see PAGE_SCRIPTS_LIST / toPageScript in transform.js) -- every
// `window.WebSocket = ...` inside them already does exactly the right thing
// once `window` here means the real page window.
// ---------------------------------------------------------------------

var __realWindow = (typeof unsafeWindow !== "undefined") ? unsafeWindow : window;
var __injectedPageScripts = Object.create(null);

// ---- universal (Chrome + Firefox) page-window proxy ---------------------
//
// Chrome-based managers (Tampermonkey/Violentmonkey on Chrome) give
// unsafeWindow as a fully transparent reference to the page window --
// `unsafeWindow.WebSocket = function(){...}` just works, page scripts see
// it immediately. Firefox-based managers run userscripts in an Xray-wrapped
// sandbox for security, and a *function created in the sandbox* assigned
// directly onto unsafeWindow can misbehave in the page compartment --
// `new`-invocation and identity checks aren't guaranteed, which matters a
// lot here since these page scripts replace WebSocket/fetch constructors
// that Instagram's own code then calls with `new` or checks with
// `instanceof`. Firefox's fix for exactly this is `exportFunction`, which
// builds a proper page-compartment-native wrapper around a sandbox function.
// Chrome has no such function (and doesn't need one).
//
// Rather than editing every vendored page script to conditionally call
// exportFunction, this Proxy does it transparently: any `window.X = fn`
// a page script performs gets exported automatically on Firefox, and is a
// plain passthrough assignment on Chrome (or any manager without
// exportFunction/cloneInto). Reads and method calls (postMessage, atob,
// addEventListener, ...) are passed through with `this` bound to the real
// window, which a bare Proxy would otherwise break (native DOM methods
// reject being called with the Proxy itself as `this`).
// A small, fixed set of Window methods these 5 scripts actually call as
// `window.methodName(...)` and need a genuine Window `this` for (native DOM
// methods reject being invoked with the Proxy itself as receiver). Bound
// once per proxy and cached, rather than binding every function property on
// every read: WebSocket/fetch are themselves function-valued properties
// that get mutated after assignment (`.prototype = ...`, static props
// copied on), and a fresh `.bind()` wrapper on every `get` would silently
// break that -- each read would hand back a *new* wrapper object with none
// of the previous read's mutations on it.
var __PROXY_BOUND_METHODS = ["postMessage", "addEventListener", "removeEventListener", "dispatchEvent"];

function makePageWindowProxy(target) {
    if (typeof exportFunction !== "function" || typeof cloneInto !== "function") {
        // Chrome/Edge/etc, or a manager that doesn't need this at all.
        return target;
    }
    var boundMethods = Object.create(null);
    for (var i = 0; i < __PROXY_BOUND_METHODS.length; i++) {
        var name = __PROXY_BOUND_METHODS[i];
        if (typeof target[name] === "function") boundMethods[name] = target[name].bind(target);
    }
    return new Proxy(target, {
        get: function (t, prop, receiver) {
            if (boundMethods[prop]) return boundMethods[prop];
            return Reflect.get(t, prop, t);
        },
        set: function (t, prop, value) {
            if (typeof value === "function") {
                try {
                    value = exportFunction(value, t, { defineAs: typeof prop === "string" ? prop : undefined });
                } catch (e) {
                    console.error("[Instafn] exportFunction failed for", prop, e);
                }
            }
            return Reflect.set(t, prop, value);
        }
    });
}

function runPageScript(key) {
    if (__injectedPageScripts[key]) return true;
    var fn = PAGE_SCRIPTS[key];
    if (!fn) {
        console.error("[Instafn] runPageScript: no page script registered for", key);
        return false;
    }
    try {
        fn(makePageWindowProxy(__realWindow));
        __injectedPageScripts[key] = true;
        return true;
    } catch (err) {
        console.error("[Instafn] error running page script", key, err);
        return false;
    }
}

// ---- replacement for vendor's utils/scriptInjector.js -----------------
// Same exported shape (injectScript, injectScripts) so every vendored
// feature file that does `import { injectScript } from "./utils/
// scriptInjector.js"` keeps working unmodified -- only the underlying
// mechanism changes, from "create a <script src>" to "call the page-script
// function directly". The `path` argument upstream was a chrome-extension://
// relative path like "content/features/message-logger/socket-sniffer.js";
// we accept the same strings and map them onto PAGE_SCRIPTS keys.
(function () {
    var PATH_TO_KEY = {
        "content/features/message-logger/socket-sniffer.js": "features/message-logger/socket-sniffer.js",
        "content/features/message-logger/graphql-sniffer.js": "features/message-logger/graphql-sniffer.js",
        "content/features/story-blocking/storyblocking.js": "features/story-blocking/storyblocking.js",
        "content/features/media-downloader/voice-sniffer.js": "features/media-downloader/voice-sniffer.js",
        "content/features/typing-receipt-blocker/websocket-interceptor.js": "features/typing-receipt-blocker/websocket-interceptor.js"
    };

    defineModule("utils/scriptInjector.js", function (module, exports) {
        exports.injectScript = function (scriptPath, options) {
            options = options || {};
            var key = PATH_TO_KEY[scriptPath] || scriptPath;
            var ok = runPageScript(key);
            if (ok && options.onLoad) options.onLoad();
            if (!ok && options.onError) options.onError(new Error("page script not found: " + scriptPath));
            return ok;
        };
        exports.injectScripts = function (scriptPaths, options) {
            for (var i = 0; i < scriptPaths.length; i++) {
                exports.injectScript(scriptPaths[i], options);
            }
        };
    });
})();

// ---- replacement for vendor's utils/styleLoader.js ---------------------
// Upstream loaded each feature's .css as a <link href=chrome-extension://...>.
// We embed every stylesheet's text at build time (STYLE_SOURCES, populated
// by transform.js) and add it with GM_addStyle, which -- like GM_download
// above -- runs outside the page's CSP entirely, so style-src restrictions
// never come into play.
(function () {
    var injected = Object.create(null);

    defineModule("utils/styleLoader.js", function (module, exports) {
        exports.injectStylesheet = function (path, key) {
            key = key || path;
            if (injected[key]) return;
            // Vendored callers pass the same "content/features/..." style path
            // used for chrome.runtime.getURL upstream; our STYLE_SOURCES keys
            // (see CSS_LIST in transform.js) are relative to vendor/instafn/
            // content/ instead, i.e. without that leading segment.
            var lookupPath = path.indexOf("content/") === 0 ? path.slice("content/".length) : path;
            var css = STYLE_SOURCES[lookupPath];
            if (css === undefined) {
                console.error("[Instafn] injectStylesheet: no embedded CSS for", path);
                return;
            }
            if (typeof GM_addStyle === "function") {
                GM_addStyle(css);
            } else {
                var style = document.createElement("style");
                style.textContent = css;
                style.dataset.instafnStyle = key;
                (document.head || document.documentElement).appendChild(style);
            }
            injected[key] = true;
        };
    });
})();
