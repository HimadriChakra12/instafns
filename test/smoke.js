const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", {
    url: "https://www.instagram.com/someuser/",
    runScripts: "outside-only",
    pretendToBeVisual: true,
});

const { window } = dom;

// ---- GM_* stubs -----------------------------------------------------------
const store = {};
window.GM_getValue = (k, d) => (k in store ? store[k] : d);
window.GM_setValue = (k, v) => { store[k] = v; };
window.GM_addValueChangeListener = () => 1;
window.GM_registerMenuCommand = (label, fn) => { console.log("  [menu] registered:", label); return 1; };
window.GM_addStyle = (css) => { const s = window.document.createElement("style"); s.textContent = css; window.document.head.appendChild(s); };
window.GM_xmlhttpRequest = (opts) => { setTimeout(() => opts.onerror && opts.onerror(new Error("stub: no network in smoke test")), 0); };
window.GM_download = (opts) => { setTimeout(() => opts.onload && opts.onload(), 0); };
window.GM_info = { script: { version: "1.1.0-usertest" } };
window.unsafeWindow = window;
// jsdom doesn't implement fetch itself; real browsers always have one.
if (typeof window.fetch !== "function") {
    window.fetch = () => Promise.reject(new Error("stub: no fetch in smoke test"));
}
window.alert = () => {};
window.confirm = () => true;

let errorCount = 0;
window.addEventListener("error", (e) => {
    errorCount++;
    console.error("  [window error]", e.error ? (e.error.stack || e.error.message) : e.message);
});

const src = fs.readFileSync(path.join(__dirname, "..", "dist", "instafn.user.js"), "utf8");
// Strip the userscript metadata header block -- it's comment-only, but let's
// be explicit that only the executable body runs here.
const body = src.replace(/^\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==\n/, "");

try {
    window.eval(body);
} catch (err) {
    errorCount++;
    console.error("  [top-level throw]", err.stack || err.message);
}

setTimeout(() => {
    console.log("\n--- smoke test summary ---");
    console.log("errors so far:", errorCount);
    console.log("window.Instafn keys:", window.Instafn ? Object.keys(window.Instafn) : "(none)");
    console.log("settings FAB present:", !!window.document.getElementById("instafn-settings-fab"));

    // Exercise the settings page itself -- never triggered by content.js's
    // own boot path, so it needs a deliberate call to actually get covered.
    // openSettingsPage lives inside the bundle's own closure, so trigger it
    // the same way a real user would: click the floating gear button.
    try {
        const fab = window.document.getElementById("instafn-settings-fab");
        fab.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
        const root = window.document.getElementById("instafn-settings-root");
        console.log("settings overlay mounted:", !!root);
        console.log("has splash screen:", !!root.querySelector("#splashScreen"));
        console.log("has settings page:", !!root.querySelector("#settingsPage"));
        console.log("sidebar items:", root.querySelectorAll(".sidebar-item").length);
        console.log("toggle inputs:", root.querySelectorAll(".toggle input").length);
        console.log("InstafnToast defined:", !!window.InstafnToast);
        console.log("InstafnSettings defined:", !!window.InstafnSettings);

        // splash screen should be showing (splashScreenShown defaults to false/unset)
        const splash = root.querySelector("#splashScreen");
        console.log("splash visible (not .hidden):", splash && !splash.classList.contains("hidden"));

        // click "Continue" -> should reveal the real settings page
        const continueBtn = root.querySelector("#continueButton");
        continueBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
        const settingsPage = root.querySelector("#settingsPage");
        console.log("settings page visible after continue:", !settingsPage.classList.contains("hidden"));

        // confirm the CONFIRM_ON_ENABLE removal: flipping a risky toggle
        // shouldn't ever call confirm()/alert() now.
        let confirmCalled = false;
        window.confirm = () => { confirmCalled = true; return true; };
        const followAnalyzerToggle = [...root.querySelectorAll('input[type=checkbox]')]
            .find(cb => cb.closest('.setting')?.textContent.includes('Follow Analyzer'));
        if (followAnalyzerToggle) {
            followAnalyzerToggle.checked = true;
            followAnalyzerToggle.dispatchEvent(new window.Event('change', { bubbles: true }));
        }
        console.log("confirm() called for risky toggle:", confirmCalled, "(should be false)");
    } catch (err) {
        errorCount++;
        console.error("  [settings page throw]", err.stack || err.message);
    }

    console.log("\nerrors:", errorCount);
    process.exit(errorCount > 0 ? 1 : 0);
}, 200);
