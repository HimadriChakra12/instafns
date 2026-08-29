/*
 * transform.js -- runs under MuJS (invoked by tools/build.c). This is the
 * "complex syntax" half of the build: instafn's vendored source is real ESM
 * (import {..} from "./x.js"; export function foo(){}), and turning that into
 * something a userscript can run needs actual text/AST-ish handling, not just
 * concatenation. That part lives here, in JS, because writing an ES-module
 * resolver in raw C is not a good time. Everything else (the userscript
 * metadata header, @grant/@match list, output path) is decided in build.c;
 * this script only ever touches paths build.c hands it.
 *
 * Only three host functions are available (given by build.c): readFile(path),
 * writeFile(path,data), exists(path), plus log(...) for stderr progress. No
 * fs, no require, no npm -- on purpose, same as avroc/Avroscript.
 *
 * What this produces, in order, inside one big IIFE:
 *   1. A tiny CommonJS-lite runtime (defineModule/require) -- see
 *      shim/00-runtime.js.
 *   2. The hand-written shim chunks (chrome.* shim, fetch/CORS shim,
 *      unsafeWindow page-script runner, settings panel) -- pasted verbatim,
 *      they're already plain scripts.
 *   3. Every vendored instafn content-script file, each wrapped as a
 *      CommonJS-lite module: import/export stripped and rewritten against a
 *      module registry keyed by its path relative to vendor/instafn/content/.
 *   4. The 4 page-context files (socket-sniffer, graphql-sniffer,
 *      storyblocking, voice-sniffer) registered into PAGE_SCRIPTS instead of
 *      the module registry, since they're not ES modules and are never
 *      require()'d -- they get invoked directly against unsafeWindow.
 *   5. A require("content.js") call to boot the whole thing, wrapped so a
 *      thrown error from any one feature can't take the others down with it.
 */

// ---------------------------------------------------------------------
// CSS scoping (for the vendored settings.html/settings.css, rendered as an
// in-page overlay rather than a separate document -- see toSettingsAssets)
// ---------------------------------------------------------------------

// Prefixes every real selector in `css` with `scope` so it only ever
// affects our own overlay subtree, never Instagram's page around it.
// Handles the one structural wrinkle this stylesheet actually has: verified
// against vendor/instafn/settings/settings.css directly (no @keyframes,
// just four `@media (prefers-color-scheme: dark) { :root { ... } }`
// blocks) rather than written as a general-purpose CSS parser.
function scopeCss(css, scope) {
    var out = "";
    var i = 0;
    var n = css.length;
    var atRuleStack = []; // "keyframes" | "other", so keyframe step selectors (0%, from, to) are left alone

    // strip comments first, so brace-matching below can't get confused by one
    css = css.replace(/\/\*[\s\S]*?\*\//g, "");
    n = css.length;

    function scopeSelectorList(sel) {
        var parts = sel.split(",");
        for (var p = 0; p < parts.length; p++) {
            var t = parts[p].replace(/^\s+|\s+$/g, "");
            if (t === "") { parts[p] = t; continue; }
            if (t === ":root" || t === "body" || t === "html") {
                parts[p] = scope;
            } else if (t === "*") {
                parts[p] = scope + ", " + scope + " *";
            } else {
                parts[p] = scope + " " + t;
            }
        }
        return parts.join(", ");
    }

    i = 0;
    while (i < n) {
        var braceIdx = css.indexOf("{", i);
        var closeIdx = css.indexOf("}", i);
        if (braceIdx === -1 && closeIdx === -1) {
            out += css.slice(i);
            break;
        }
        if (closeIdx !== -1 && (braceIdx === -1 || closeIdx < braceIdx)) {
            // closing an existing block
            out += css.slice(i, closeIdx + 1);
            atRuleStack.pop();
            i = closeIdx + 1;
            continue;
        }
        // braceIdx is the next meaningful token: a new block is opening
        var prelude = css.slice(i, braceIdx);
        var trimmedPrelude = prelude.replace(/^\s+/, "");
        var top = atRuleStack.length ? atRuleStack[atRuleStack.length - 1] : null;

        if (trimmedPrelude.charAt(0) === "@") {
            // @media / @supports / @keyframes / ... -- the prelude itself is a
            // condition or name, never a selector, so it's never rewritten.
            out += prelude + "{";
            atRuleStack.push(/^@(-\w+-)?keyframes/.test(trimmedPrelude) ? "keyframes" : "other");
        } else if (top === "keyframes") {
            // 0%, 50%, from, to -- leave exactly as written.
            out += prelude + "{";
            atRuleStack.push("keyframe-step");
        } else {
            out += scopeSelectorList(prelude) + "{";
            atRuleStack.push("rule");
        }
        i = braceIdx + 1;
    }
    return out;
}

// ---------------------------------------------------------------------
// Settings page assets
//
// Rather than a separate settings.html document (which a plain userscript
// has no privileged way to open with GM_* access intact -- a fresh tab only
// gets the sandbox if the manager's @match covers its URL, which a data:/
// blob: URL makes unreliable across managers), the vendored settings page
// is rendered as a full-viewport overlay inside the current Instagram tab:
// same document, so GM_getValue/GM_setValue/etc. are simply already there,
// no extra plumbing needed. This function does the one-time extraction:
// splash+settings markup (scripts stripped, they're run separately as
// plain functions -- see shim/03-settings-page.js), the stylesheet scoped
// under our overlay's root id, and the two page scripts with `export`
// stripped where needed.
// ---------------------------------------------------------------------

var SETTINGS_ROOT_ID = "instafn-settings-root";

function extractBodyMarkup(html) {
    // A regex capturing the whole multi-KB body via a greedy [\s\S]* trips
    // MuJS's regex engine on input this size ("regexec failed" -- its
    // backtracking engine isn't built for greedily matching tens of KB in
    // one capture group). Plain indexOf does the same job without asking
    // the regex engine to backtrack across the entire file.
    var openTagEnd = html.indexOf(">", html.indexOf("<body"));
    var closeTagStart = html.lastIndexOf("</body>");
    var body = (openTagEnd !== -1 && closeTagStart !== -1)
        ? html.slice(openTagEnd + 1, closeTagStart)
        : html;
    body = body.replace(/<script[\s\S]*?<\/script>/g, "");
    body = body.replace(/<link[^>]*rel=["']stylesheet["'][^>]*>/g, "");
    return body;
}

// Strips a leading `export ` off function/const declarations, same rule as
// DECL_EXPORT_RE, but for files whose exports are never require()'d --
// they publish themselves onto window.Instafn* instead (see toast.js: `
// window.InstafnToast = { showToast, CHECK_ICON };` at its own end) -- so
// there's no module wrapper or trailing exports object to build, just a
// syntax fix so `export` (invalid outside a real module) doesn't throw.
function stripBareExports(src) {
    return src.replace(/export\s+(async\s+function|function|const)\s+/g, "$1 ");
}

function buildSettingsPageAssets() {
    var SETTINGS_ROOT = "vendor/instafn/settings/";

    var html = readFile(SETTINGS_ROOT + "settings.html");
    var markup = extractBodyMarkup(html);

    var css = readFile(SETTINGS_ROOT + "settings.css");
    var scopedCss = scopeCss(css, "#" + SETTINGS_ROOT_ID);

    var toastJs = stripBareExports(readFile(SETTINGS_ROOT + "toast.js"));

    var sharedJs = readFile(SETTINGS_ROOT + "settings-shared.js");
    // Product decision (not a technical shim): drop the "are you sure?"
    // warnings before switching on the three riskier toggles. Emptying the
    // table is enough -- every consumer of it (a `for (const key of
    // Object.keys(CONFIRM_ON_ENABLE))` loop) already treats an unlisted key
    // as "no warning needed", so this is a complete removal, not a partial
    // patch: nothing else reads this object.
    var confirmBlockRe = /const CONFIRM_ON_ENABLE = \{[\s\S]*?\n  \};/;
    if (!confirmBlockRe.test(sharedJs)) {
        throw new Error("buildSettingsPageAssets: CONFIRM_ON_ENABLE block not found in settings-shared.js -- upstream format changed, update confirmBlockRe");
    }
    sharedJs = sharedJs.replace(confirmBlockRe, "const CONFIRM_ON_ENABLE = {};");

    var pageJs = readFile(SETTINGS_ROOT + "settings.js");

    var out = [];
    out.push("var SETTINGS_ROOT_ID = " + jsStringLiteral(SETTINGS_ROOT_ID) + ";");
    out.push("var SETTINGS_PAGE_HTML = " + jsStringLiteral(markup) + ";");
    out.push("var SETTINGS_PAGE_CSS = " + jsStringLiteral(scopedCss) + ";");
    out.push("function __runSettingsPageScripts() {");
    out.push(toastJs);
    out.push(sharedJs);
    out.push(pageJs);
    out.push("}");
    return out.join("\n\n");
}

// ---------------------------------------------------------------------
// path helpers (POSIX-ish, no host fs.path -- doing it by hand)
// ---------------------------------------------------------------------

function dirname(p) {
    var i = p.lastIndexOf("/");
    return i < 0 ? "" : p.slice(0, i);
}

// Resolve an import specifier ("./x.js", "../../ui/modal.js") against the
// directory of the importing module, producing a normalized key relative to
// vendor/instafn/content/ (e.g. "ui/modal.js").
function resolveSpecifier(fromDir, spec) {
    var base = fromDir ? fromDir.split("/") : [];
    var parts = spec.split("/");
    for (var i = 0; i < parts.length; i++) {
        var seg = parts[i];
        if (seg === "." || seg === "") continue;
        if (seg === "..") base.pop();
        else base.push(seg);
    }
    return base.join("/");
}

// ---------------------------------------------------------------------
// the ESM-lite -> CommonJS-lite rewrite
// ---------------------------------------------------------------------

// Matches `import { a, b, c } from "path";` across one or more lines.
var IMPORT_RE = /import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["'];?/g;
// Matches `export { a, b } from "path";` (re-export list).
var REEXPORT_RE = /export\s*\{([^}]*)\}\s*from\s*["']([^"']+)["'];?/g;
// Matches a bare `export { a, b };` (export of already-declared local names).
var BARE_EXPORT_RE = /export\s*\{([^}]*)\}\s*;?/g;
// Matches `export function name(`, `export async function name(`,
// `export const name =`.
var DECL_EXPORT_RE = /export\s+(async\s+function|function|const)\s+([A-Za-z_$][\w$]*)/g;

function splitNames(list) {
    var out = [];
    var parts = list.split(",");
    for (var i = 0; i < parts.length; i++) {
        var n = parts[i].replace(/\s+/g, "");
        if (n) out.push(n);
    }
    return out;
}

// Transform one vendored file's source into a CommonJS-lite module body.
// `key` is this module's own registry key (e.g. "features/branding/index.js").
function toModule(key, src) {
    var fromDir = dirname(key);
    var exportedNames = [];

    // export { a, b } from "./other.js";  -> pull straight from the other
    // module's exports and re-export under the same names.
    src = src.replace(REEXPORT_RE, function (_m, names, spec) {
        var targetKey = resolveSpecifier(fromDir, spec);
        var list = splitNames(names);
        var lines = [];
        for (var i = 0; i < list.length; i++) {
            lines.push("var " + list[i] + " = require(\"" + targetKey + "\")." + list[i] + ";");
            exportedNames.push(list[i]);
        }
        return lines.join("\n");
    });

    // import { a, b } from "./x.js";  -> var { a, b } = require("...");
    src = src.replace(IMPORT_RE, function (_m, names, spec) {
        var targetKey = resolveSpecifier(fromDir, spec);
        var list = splitNames(names).join(", ");
        return "var { " + list + " } = require(\"" + targetKey + "\");";
    });

    // export function NAME(...  /  export async function NAME(...  /
    // export const NAME =   -> strip the `export `, remember the name so we
    // can assign it onto module.exports after the fact (function decls are
    // hoisted, so this is safe even though the assignment line comes last;
    // const isn't hoisted, but by the time our trailing assignment block runs
    // every top-level statement above it -- including that const -- has
    // already executed in source order).
    src = src.replace(DECL_EXPORT_RE, function (_m, kind, name) {
        exportedNames.push(name);
        return kind + " " + name;
    });

    // export { a, b };  (bare, no `from`) -- names are already declared
    // above in this same file; just remember them.
    src = src.replace(BARE_EXPORT_RE, function (_m, names) {
        var list = splitNames(names);
        for (var i = 0; i < list.length; i++) exportedNames.push(list[i]);
        return "";
    });

    var tail = "";
    if (exportedNames.length) {
        // de-dupe (a name can appear more than once if both an inline
        // `export const` and a later bare re-mention exist)
        var seen = {};
        var uniq = [];
        for (var j = 0; j < exportedNames.length; j++) {
            if (!seen[exportedNames[j]]) { seen[exportedNames[j]] = true; uniq.push(exportedNames[j]); }
        }
        var assigns = [];
        for (var k = 0; k < uniq.length; k++) {
            assigns.push("module.exports." + uniq[k] + " = " + uniq[k] + ";");
        }
        tail = "\n\n" + assigns.join("\n");
    }

    return "defineModule(\"" + key + "\", function (module, exports, require) {\n" +
        src + tail + "\n});\n";
}

// Wrap a page-context script (plain IIFE, no import/export) so it runs
// against a caller-supplied `window` instead of whatever `window` means in
// the enclosing scope. Called with unsafeWindow at dispatch time -- see
// shim/02-page-inject.js.
function toPageScript(key, src) {
    return "PAGE_SCRIPTS[\"" + key + "\"] = function (window) {\n" + src + "\n};\n";
}

// ---------------------------------------------------------------------
// CSS embedding
// ---------------------------------------------------------------------

function jsStringLiteral(s) {
    return JSON.stringify(s);
}

function toCssEntry(key, src) {
    return "STYLE_SOURCES[\"" + key + "\"] = " + jsStringLiteral(src) + ";\n";
}

// ---------------------------------------------------------------------
// config: every file this build touches, and how
// ---------------------------------------------------------------------

var VENDOR_ROOT = "vendor/instafn/content/";
var SHIM_ROOT = "src/shim/";

// Vendored files that are page-context scripts, not ES modules. Registered
// into PAGE_SCRIPTS, run directly against unsafeWindow -- never require()'d.
var PAGE_SCRIPTS_LIST = [
    "features/message-logger/socket-sniffer.js",
    "features/message-logger/graphql-sniffer.js",
    "features/story-blocking/storyblocking.js",
    "features/media-downloader/voice-sniffer.js",
    "features/typing-receipt-blocker/websocket-interceptor.js"
];

var CSS_LIST = [
    "features/profile-grid-columns/profile-grid-columns.css",
    "features/video-scrubber/videoScrubber.css",
    "features/follow-analyzer/follow-analyzer.css",
    "features/branding/branding.css",
    "features/profile-follow-indicator/profile-follow-indicator.css",
    "features/call-timer/call-timer.css",
    "features/media-downloader/media-downloader.css",
    "features/post-hover-info/post-hover-info.css",
    "features/profile-pic-popup/profilePicPopup.css"
];

// Everything else under vendor/instafn/content/**.js that isn't in the two
// lists above is a real ESM module and gets require()-wrapped. Discovering
// this list needs a directory walk, which MuJS's host doesn't give us (by
// design, per avroc's "three functions only" rule) -- so build.c hands us
// the full file list it found on disk as MANIFEST, already relative to
// VENDOR_ROOT. See build.c's `walk()`.

function isPageScript(relPath) {
    for (var i = 0; i < PAGE_SCRIPTS_LIST.length; i++) {
        if (PAGE_SCRIPTS_LIST[i] === relPath) return true;
    }
    return false;
}

// Vendored files with a hand-written userscript-native replacement of the
// exact same module registry key, registered in shim/02-page-inject.js
// (chrome.runtime.getURL has no userscript equivalent, so these two can't
// be auto-wrapped like the rest -- see that file's comments). Skipped here
// so the vendored version is never registered and can't win a defineModule
// race against the replacement.
var EXCLUDED_MODULES = [
    "utils/scriptInjector.js",
    "utils/styleLoader.js"
];

function isExcluded(relPath) {
    for (var i = 0; i < EXCLUDED_MODULES.length; i++) {
        if (EXCLUDED_MODULES[i] === relPath) return true;
    }
    return false;
}

var SHIM_CHUNKS = [
    "00-runtime.js",
    "01-chrome-shim.js",
    "02-page-inject.js",
    "03-settings-page.js"
];

function main() {
    log("transform: reading manifest");
    var manifestRaw = readFile("build/manifest.txt");
    var manifest = manifestRaw.split("\n").filter(function (l) { return l.length > 0; });
    log("transform: " + manifest.length + " vendored .js files");

    var out = [];

    out.push("// ---- module runtime + shims ----");
    for (var s = 0; s < SHIM_CHUNKS.length; s++) {
        if (SHIM_CHUNKS[s] === "03-settings-page.js") {
            // Needs SETTINGS_PAGE_HTML/CSS + __runSettingsPageScripts in scope
            // before it -- see buildSettingsPageAssets().
            out.push(buildSettingsPageAssets());
        }
        out.push(readFile(SHIM_ROOT + SHIM_CHUNKS[s]));
    }

    out.push("// ---- embedded stylesheets ----");
    for (var c = 0; c < CSS_LIST.length; c++) {
        out.push(toCssEntry(CSS_LIST[c], readFile(VENDOR_ROOT + CSS_LIST[c])));
    }

    out.push("// ---- page-context scripts (run against unsafeWindow) ----");
    for (var p = 0; p < PAGE_SCRIPTS_LIST.length; p++) {
        out.push(toPageScript(PAGE_SCRIPTS_LIST[p], readFile(VENDOR_ROOT + PAGE_SCRIPTS_LIST[p])));
    }

    out.push("// ---- vendored feature modules ----");
    var moduleCount = 0;
    for (var m = 0; m < manifest.length; m++) {
        var relPath = manifest[m];
        if (isPageScript(relPath) || isExcluded(relPath)) continue;
        var src = readFile(VENDOR_ROOT + relPath);
        out.push(toModule(relPath, src));
        moduleCount++;
    }
    log("transform: wrapped " + moduleCount + " ES modules as CommonJS-lite");

    out.push("// ---- boot ----");
    out.push(
        "try {\n" +
        "  initSettingsPageEntryPoints();\n" +
        "} catch (err) {\n" +
        "  console.error(\"[Instafn] fatal error setting up the settings panel:\", err);\n" +
        "}\n" +
        "try {\n" +
        "  require(\"content.js\");\n" +
        "} catch (err) {\n" +
        "  console.error(\"[Instafn] fatal error during startup:\", err);\n" +
        "}\n"
    );

    writeFile("build/bundle.js", out.join("\n\n"));
    log("transform: wrote build/bundle.js");
}

main();
