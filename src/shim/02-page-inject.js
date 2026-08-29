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
// unsafeWindow. The vendored source for these files is untouched (see
// PAGE_SCRIPTS_LIST in transform.js) -- every `window.WebSocket = ...`
// inside them already does exactly the right thing once `window` here means
// the real page window. The one thing that ISN'T untouched is bare global
// references these scripts make (`XMLHttpRequest.prototype.open = ...`,
// not `window.XMLHttpRequest...`) -- toPageScript() in transform.js shadows
// those identifiers with locals bound to the real window before the
// vendored src runs, since an unqualified `XMLHttpRequest`/`WebSocket`
// would otherwise resolve to the userscript sandbox's own constructor
// instead of the page's.
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

// ---- Xray-safe constructor wrapping (Firefox only) -----------------------
//
// makePageWindowProxy's `set` trap only fires for assignments made directly
// on the `window` object it wraps (`window.fetch = ...`). It does NOT fire
// for `XMLHttpRequest.prototype.open = ...` or `SomeCtor.prototype.x = fn`
// -- that's a property set on a *different* object (the constructor's
// prototype), two property-accesses removed from `window`, which no Proxy
// on `window` alone can see. On Chrome this is harmless (unsafeWindow is
// the real page window, so `window.XMLHttpRequest.prototype` already *is*
// the real prototype and a plain assignment just works). On Firefox,
// `window.XMLHttpRequest.prototype` is a real page-compartment object
// viewed through an Xray wrapper; assigning a sandbox-created function onto
// it as a method skips exportFunction, so the resulting property is not a
// callable a page-compartment caller can invoke correctly -- Instagram's
// own `xhr.open(...)` call silently no-ops instead of running our patch,
// which is exactly what broke DM voice-note capture (the thread loads over
// XHR, not fetch) despite XMLHttpRequest itself now correctly pointing at
// the real page constructor.
//
// wrapCtorForPatching(ctor) returns a stand-in for the constructor whose
// `.prototype` is a Proxy: any function assigned onto it gets run through
// exportFunction first. On Chrome (no exportFunction/cloneInto) this is a
// no-op passthrough, same as makePageWindowProxy above.
var __wrappedCtors = (typeof WeakMap !== "undefined") ? new WeakMap() : null;

function wrapCtorForPatching(realCtor) {
    if (typeof exportFunction !== "function" || typeof cloneInto !== "function") {
        return realCtor; // Chrome/Edge/etc -- direct assignment already works.
    }
    if (!realCtor || typeof realCtor !== "function") return realCtor;
    if (__wrappedCtors && __wrappedCtors.has(realCtor)) return __wrappedCtors.get(realCtor);

    var protoProxy = new Proxy(realCtor.prototype, {
        get: function (t, prop) { return Reflect.get(t, prop, t); },
        set: function (t, prop, value) {
            if (typeof value === "function") {
                try {
                    value = exportFunction(value, __realWindow, { defineAs: typeof prop === "string" ? prop : undefined });
                } catch (e) {
                    console.error("[Instafn] exportFunction failed for prototype." + String(prop), e);
                }
            }
            return Reflect.set(t, prop, value);
        }
    });

    // The Proxy target here is a throwaway plain function, NOT realCtor
    // itself -- a native constructor's own .prototype descriptor is
    // {writable:false, configurable:false}, and returning a different
    // object for it from a `get` trap on a Proxy targeting realCtor
    // directly violates the Proxy invariant for non-configurable,
    // non-writable properties (throws a TypeError the moment anything
    // reads `.prototype`). A fresh function's own .prototype is writable/
    // configurable by default, so the same substitution is legal there.
    var dummyTarget = function () {};
    var shim = new Proxy(dummyTarget, {
        get: function (t, prop) {
            if (prop === "prototype") return protoProxy;
            var v = Reflect.get(realCtor, prop, realCtor);
            return (typeof v === "function") ? v.bind(realCtor) : v;
        },
        construct: function (t, args, newTarget) {
            return Reflect.construct(realCtor, args, newTarget === shim ? realCtor : newTarget);
        },
        has: function (t, prop) { return prop in realCtor; }
    });
    if (__wrappedCtors) __wrappedCtors.set(realCtor, shim);
    return shim;
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
