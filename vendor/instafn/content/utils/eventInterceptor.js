/**
 * Reusable event interception utility
 * Provides common patterns for intercepting user actions
 */

// Bare `window` is not reliably the real page window inside a userscript
// sandbox (Firefox in particular gives unqualified `window` a wrapper that
// fails the strict WebIDL check MouseEvent/PointerEvent's `view` field
// requires -- "'view' member of UIEventInit does not implement interface
// Window"). __realWindow is declared once in shim/02-page-inject.js and is
// in lexical scope here since this module is concatenated into that bundle.
function realView() {
  return typeof __realWindow !== "undefined" ? __realWindow : window;
}

/**
 * Stop event propagation and prevent default
 */
export function stopEvent(e) {
  e.stopImmediatePropagation();
  e.stopPropagation();
  e.preventDefault();
}

/**
 * Full click event configuration
 */
function fullClickInit() {
  return {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: realView(),
  };
}

/**
 * Dispatch a full click sequence (pointerdown, mousedown, mouseup, click)
 */
export function dispatchFullClick(target) {
  if (!target) return;

  const init = fullClickInit();
  const events = [
    new PointerEvent("pointerdown", {
      ...init,
      pointerType: "mouse",
    }),
    new MouseEvent("mousedown", init),
    new MouseEvent("mouseup", init),
    new MouseEvent("click", init),
  ];

  events.forEach((evt) => {
    try {
      target.dispatchEvent(evt);
    } catch (_) {
      // Ignore errors
    }
  });
}

/**
 * Dispatch a simple mouse click
 */
export function dispatchMouseClick(target) {
  if (!target) return;

  const evt = new MouseEvent("click", {
    bubbles: true,
    cancelable: true,
    view: realView(),
  });
  target.dispatchEvent(evt);
}

/**
 * Create an event interceptor for click events
 * @param {Function} matcher - Function that returns true if event should be intercepted
 * @param {Function} handler - Async function that handles the intercepted event
 * @param {Object} options - Options
 * @param {boolean} options.capture - Use capture phase (default: true)
 * @returns {Function} - Cleanup function to remove listener
 */
export function interceptClicks(matcher, handler, options = {}) {
  const { capture = true } = options;

  const listener = async (e) => {
    if (e.isTrusted === false) return;

    if (matcher(e)) {
      stopEvent(e);
      const result = await handler(e);
      if (result === false) {
        return false;
      }
    }
  };

  document.addEventListener("click", listener, capture);

  return () => {
    document.removeEventListener("click", listener, capture);
  };
}

/**
 * Create an event interceptor for keyboard events
 * @param {Function} matcher - Function that returns true if event should be intercepted
 * @param {Function} handler - Async function that handles the intercepted event
 * @param {Object} options - Options
 * @param {boolean} options.capture - Use capture phase (default: true)
 * @returns {Function} - Cleanup function to remove listener
 */
export function interceptKeydown(matcher, handler, options = {}) {
  const { capture = true } = options;

  const listener = async (e) => {
    if (e.isTrusted === false) return;

    if (matcher(e)) {
      stopEvent(e);
      const result = await handler(e);
      if (result === false) {
        return false;
      }
    }
  };

  document.addEventListener("keydown", listener, capture);

  return () => {
    document.removeEventListener("keydown", listener, capture);
  };
}
