// A minimal CommonJS-lite module system. Modules register themselves with
// defineModule(key, factory); factory runs lazily, once, the first time
// something require()s that key -- same semantics as Node's require cache,
// which is all the vendored code actually needs (it was written as real ES
// modules, so import order across files was never something it relied on).
var __modules = Object.create(null);
var __cache = Object.create(null);
var __loading = Object.create(null);

function defineModule(key, factory) {
    __modules[key] = factory;
}

function require(key) {
    if (__cache[key]) return __cache[key].exports;

    var factory = __modules[key];
    if (!factory) {
        throw new Error("[Instafn] require(\"" + key + "\"): no such module registered");
    }
    if (__loading[key]) {
        // Circular require: hand back the in-progress (possibly incomplete)
        // exports object rather than looping forever. None of the vendored
        // modules are circular in practice, but this keeps a future one from
        // hanging the whole page instead of just being wrong.
        return __loading[key].exports;
    }

    var module = { exports: {} };
    __loading[key] = module;
    factory(module, module.exports, require);
    delete __loading[key];
    __cache[key] = module;
    return module.exports;
}

// Page-context scripts (not ES modules -- see toPageScript in transform.js)
// live in a separate registry, since they're invoked directly against
// unsafeWindow rather than require()'d.
var PAGE_SCRIPTS = Object.create(null);

// Embedded CSS text, keyed the same way as the vendor tree. Populated by
// transform.js; consumed by the injectStylesheet() shim below.
var STYLE_SOURCES = Object.create(null);
