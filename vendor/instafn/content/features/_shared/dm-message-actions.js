/**
 * Shared DM message action helpers.
 *
 * Instagram's DM DOM no longer uses role="row" / data-scope="messages_table" /
 * "Double tap to like" buttons. Each message is now wrapped in
 * `[role="group"][tabindex="-1"]`, the bubble is a `[role="presentation"]`
 * element, and the hover action bar lives in a `div[style*="--x-width: 96px"]`
 * placeholder inside the group. The on-hover buttons and the popup menus still
 * expose stable aria-labels ("React to message…", "Reply to message…",
 * "See more options…", "Edit", and the ❤️ as the first reaction), so the
 * click pipelines are driven off those.
 *
 * Everything here is built to be instant and flash-free: action buttons and
 * popup dialogs are hidden the moment they are added to the DOM (before paint),
 * the real handler is invoked directly via the React fiber, then visibility is
 * restored.
 */

// A single message bubble. Old DOM fallback kept for safety.
export const MESSAGE_GROUP_SELECTOR = '[role="group"][tabindex="-1"], [role="row"]';

// Bare `window` here is NOT reliably the real page window: this module runs
// as a normal (non-toPageScript) part of the userscript bundle, and in a
// Tampermonkey/Violentmonkey sandbox -- Firefox in particular -- unqualified
// `window` is a sandbox wrapper, not the actual platform Window object.
// Constructing a MouseEvent/PointerEvent with `view` set to that wrapper
// throws ("'view' member of UIEventInit does not implement interface
// Window") the moment Firefox's WebIDL layer checks it, which is exactly
// what broke every synthetic hover/click dispatch in this file. __realWindow
// is declared once in shim/02-page-inject.js and is in lexical scope here
// since this module is concatenated into that same bundle.
function realView() {
  return typeof __realWindow !== "undefined" ? __realWindow : window;
}

// The quick reply/edit keyboard shortcuts must only fire when the user is
// actually typing in a DM composer — not globally, and not just on /direct/
// (the docked DM widget in the bottom-right corner appears on any page, and the
// shortcuts should work there too). The composer is the contenteditable inside
// Instagram's IGDComposer pagelet; the docked widget reuses the same component.
// Checked at event time (listeners register once at document_start, but this is
// an SPA and focus moves around).
export function isDmComposerFocused() {
  const el = document.activeElement;
  if (!el) return false;
  const editable =
    el.isContentEditable ||
    el.tagName === "TEXTAREA" ||
    el.getAttribute?.("role") === "textbox";
  if (!editable) return false;

  // Quick positive: focused inside the IGDComposer pagelet, or a field whose
  // label reads "Message…".
  if (el.closest('[data-pagelet^="IGDComposer"]')) return true;
  const label = (
    el.getAttribute("aria-label") ||
    el.getAttribute("aria-placeholder") ||
    el.getAttribute("placeholder") ||
    ""
  ).trim();
  if (/^message/i.test(label)) return true;

  // Fallback that works in the docked DM widget (whose composer doesn't carry
  // the pagelet): an editable field with an open conversation present. Message
  // group detection is the same signal double-tap-to-like relies on, so it's
  // known-good wherever a DM thread is actually open.
  return getMessageGroups().length > 0;
}

const HIDE_STYLE_ID = "instafn-dm-action-hide-style";

// SVG labels for the three on-hover buttons (suffixed with "from <name>").
const REACT_SVG = 'svg[aria-label^="React to message"]';
const REPLY_SVG = 'svg[aria-label^="Reply to message"]';
const MORE_SVG = 'svg[aria-label^="See more options"]';

// -------------------------------------------------------------------------
// No-flash hide / restore
// -------------------------------------------------------------------------

function ensureHideStyle() {
  if (document.getElementById(HIDE_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = HIDE_STYLE_ID;
  style.textContent = `[data-instafn-hiding="true"]{opacity:0 !important;visibility:hidden !important;transition:none !important;pointer-events:none !important;}`;
  document.head.appendChild(style);

  // One-time sweep on first use in this page load: a guard from a previous
  // (buggy) version of this module could have set data-instafn-hiding="true"
  // on a still-live DOM node and never cleared it -- that attribute is state
  // on the actual page element, so it survives a userscript update even
  // though the *code* is now fixed, and would otherwise look exactly like
  // the bug recurring. Only needed once per page load, right as the style
  // (and therefore the hiding behavior) is first wired up.
  document.querySelectorAll('[data-instafn-hiding="true"]').forEach((el) => {
    delete el.dataset.instafnHiding;
  });
}

function hideEl(el, hidden) {
  if (!el || el.dataset.instafnHiding === "true") return;
  el.dataset.instafnHiding = "true";
  hidden.push(el);
}

function restore(hidden) {
  hidden.forEach((el) => {
    if (el && el.dataset.instafnHiding === "true") delete el.dataset.instafnHiding;
  });
  hidden.length = 0;
}

// Is this a transient element we want to keep invisible (hover action bar or
// popup menu / reaction panel)? Deliberately narrow so we never touch main UI.
function isTransientActionEl(node) {
  if (!node || node.nodeType !== 1) return false;
  if (node.matches?.('[role="dialog"]')) return true;
  // The on-hover action bar gets the 3 buttons injected into it.
  if (node.querySelector?.(`${REACT_SVG}, ${REPLY_SVG}, ${MORE_SVG}`)) return true;
  return false;
}

/**
 * Watches the DOM and instantly hides any hover action bar or popup menu the
 * moment Instagram inserts it, so the user never sees a flash. Returns the
 * MutationObserver plus the shared `hidden` list used for restoring.
 */
export function startFlashGuard() {
  ensureHideStyle();
  const hidden = [];

  // Hide anything already present.
  document
    .querySelectorAll(`[role="dialog"], ${REACT_SVG}, ${REPLY_SVG}, ${MORE_SVG}`)
    .forEach((el) => {
      const target = el.closest('[role="dialog"]') || el.closest('[role="button"]') || el;
      if (isTransientActionEl(target) || target.closest('[role="dialog"]')) hideEl(target, hidden);
    });

  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      m.addedNodes.forEach((node) => {
        if (node.nodeType !== 1) return;
        if (isTransientActionEl(node)) hideEl(node, hidden);
        // Action buttons injected inside an existing hover bar.
        node.querySelectorAll?.(`${REACT_SVG}, ${REPLY_SVG}, ${MORE_SVG}`).forEach((svg) => {
          const btn = svg.closest('[role="button"]');
          if (btn) hideEl(btn, hidden);
        });
        node.querySelectorAll?.('[role="dialog"]').forEach((d) => hideEl(d, hidden));
      });
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  // Absolute failsafe on top of the try/finally in reactToMessage/
  // replyToMessage/editMessage: those guarantee stopFlashGuard() runs on
  // every code path we know about, but "every path we know about" is
  // exactly the kind of claim that's been wrong before in this file. If
  // something disconnects the observer without ever calling restore() --
  // a bug we haven't found yet, a future Instagram DOM change, anything --
  // this guarantees the row can never stay invisible for more than 2s
  // instead of indefinitely.
  const failsafeTimer = setTimeout(() => {
    observer.disconnect();
    restore(hidden);
  }, 2000);

  return { observer, hidden, failsafeTimer };
}

export function stopFlashGuard(guard, { delay = 250 } = {}) {
  if (!guard) return;
  clearTimeout(guard.failsafeTimer);
  guard.observer?.disconnect();
  setTimeout(() => restore(guard.hidden), delay);
}

// -------------------------------------------------------------------------
// Message discovery
// -------------------------------------------------------------------------

function getThreadContainer() {
  // The open conversation's message list. (The virtualized list wraps each
  // message in its own `.x13dflua` item, so we must anchor on the list itself
  // rather than inferring a common parent of the message groups.)
  return (
    document.querySelector('[data-pagelet="IGDMessagesList"]') ||
    document.querySelector('[data-pagelet="IGDOpenMessageList"]') ||
    document.querySelector('[aria-label*="Messages in conversation"]') ||
    document.body
  );
}

/** All message groups in the open thread, oldest first (DOM order). */
export function getMessageGroups() {
  const container = getThreadContainer();
  return Array.from(container.querySelectorAll(MESSAGE_GROUP_SELECTOR)).filter(
    (g) =>
      g.querySelector('[role="presentation"]') ||
      g.querySelector('a[aria-label^="Open the profile page"]') ||
      g.querySelector("img")
  );
}

// The deepest stable element to aim hover/pointer events at. Events dispatched
// here bubble UP through every ancestor that owns the hover handler (the row,
// the group), which is what makes Instagram render the action bar. Dispatching
// on the group alone does not reach the child row that listens for the hover.
function getHoverTarget(group) {
  return (
    group.querySelector('[role="presentation"]') ||
    group.querySelector('[role="none"] > div') ||
    group.firstElementChild ||
    group
  );
}

/**
 * Sent vs received, detected by horizontal alignment (class-independent and
 * resilient to Instagram's obfuscated class churn). Received messages also
 * carry the sender's avatar link, which is treated as a definitive signal.
 */
export function isSentMessage(group) {
  if (group.querySelector('a[aria-label^="Open the profile page"]')) return false;
  const bubble = group.querySelector('[role="presentation"]') || group.firstElementChild;
  if (!bubble) return true;
  const gr = group.getBoundingClientRect();
  const br = bubble.getBoundingClientRect();
  if (!gr.width || !br.width) return true;
  const leftGap = br.left - gr.left;
  const rightGap = gr.right - br.right;
  return rightGap <= leftGap; // hugs the right edge => sent by us
}

/** Last message we sent (most recent), or null. */
export function findLastSentMessage() {
  const groups = getMessageGroups();
  for (let i = groups.length - 1; i >= 0; i--) {
    if (isSentMessage(groups[i])) return groups[i];
  }
  return null;
}

/** All messages from the other person, most recent first. */
export function findOtherPersonMessages() {
  return getMessageGroups()
    .filter((g) => !isSentMessage(g))
    .reverse();
}

// -------------------------------------------------------------------------
// Hover + click
// -------------------------------------------------------------------------

export function triggerHover(element) {
  const rect = element.getBoundingClientRect();
  const clientX = rect.left + rect.width / 2;
  const clientY = rect.top + rect.height / 2;
  ["mouseenter", "mouseover", "mousemove", "pointerenter", "pointerover"].forEach((type) => {
    const EventClass = type.startsWith("pointer") ? PointerEvent : MouseEvent;
    element.dispatchEvent(
      new EventClass(type, { bubbles: true, cancelable: true, view: realView(), clientX, clientY })
    );
  });
}

// Collapse the hover action bar so it doesn't stay stuck on the message after a
// synthetic hover (we never sent a real mouseleave). Aim at the same deep target
// we hovered so the bubbling mouseout reaches the row that owns the handler.
function triggerUnhover(group) {
  const target = getHoverTarget(group);
  ["mouseout", "mouseleave", "pointerout", "pointerleave"].forEach((type) => {
    const EventClass = type.startsWith("pointer") ? PointerEvent : MouseEvent;
    target.dispatchEvent(
      new EventClass(type, { bubbles: true, cancelable: true, view: realView() })
    );
  });
}

function findReactFiber(dom) {
  if (!dom) return null;
  for (const key in dom) {
    if (
      key.startsWith("__reactFiber") ||
      key.startsWith("__reactInternalInstance") ||
      key.startsWith("__reactContainer")
    ) {
      return dom[key];
    }
  }
  return null;
}

function findClickHandler(element) {
  let node = element;
  let depth = 0;
  while (node && depth < 4) {
    const fiber = findReactFiber(node);
    let f = fiber;
    let hops = 0;
    while (f && hops < 6) {
      const props = f.memoizedProps || f.pendingProps;
      // Quick-reaction chips in the dialog are plain divs (not <button>),
      // and this style of "zero-latency" picker commonly fires on
      // pointerdown/mousedown rather than click, so the click actually
      // registering nothing visually was never a heart-detection problem --
      // findClickHandler was only ever looking for onClick.
      if (props?.onClick) return { handler: props.onClick.bind(null), type: "click" };
      if (props?.onPointerDown) return { handler: props.onPointerDown.bind(null), type: "pointerdown" };
      if (props?.onMouseDown) return { handler: props.onMouseDown.bind(null), type: "mousedown" };
      f = f.return;
      hops++;
    }
    if (typeof node.onclick === "function") return { handler: node.onclick.bind(node), type: "click" };
    node = node.parentElement;
    depth++;
  }
  return null;
}

/** Click a button instantly via its React handler, falling back to synthetic events. */
export function clickInstantly(button, callback) {
  const found = findClickHandler(button);
  if (found) {
    try {
      const EventClass = found.type.startsWith("pointer") ? PointerEvent : MouseEvent;
      found.handler(
        new EventClass(found.type, {
          bubbles: true,
          cancelable: true,
          view: realView(),
          detail: 1,
          button: 0,
        })
      );
      if (callback) callback();
      return;
    } catch (e) {
      /* fall through to synthetic events */
    }
  }

  const rect = button.getBoundingClientRect();
  const clientX = rect.left + rect.width / 2;
  const clientY = rect.top + rect.height / 2;
  // Include pointerdown/pointerup alongside mousedown/mouseup/click -- the
  // dialog's quick-reaction chips are plain divs that fire on pointerdown
  // for a zero-latency feel, and dispatching only mouse events never
  // reached that handler even though the click event itself landed fine.
  ["pointerdown", "mousedown", "pointerup", "mouseup", "click"].forEach((type) => {
    const EventClass = type.startsWith("pointer") ? PointerEvent : MouseEvent;
    button.dispatchEvent(
      new EventClass(type, {
        bubbles: true,
        cancelable: true,
        view: realView(),
        clientX,
        clientY,
        button: 0,
        detail: 1,
      })
    );
  });
  button.click?.();
  if (callback) callback();
}

// Poll for an element (Instagram renders the menu a frame or two after hover/click).
function waitFor(getter, { maxAttempts = 20, interval = 30 } = {}) {
  return new Promise((resolve) => {
    let attempts = 0;
    const tick = () => {
      attempts++;
      // A throwing getter used to reject this promise outright, bypassing
      // even a try/finally in the caller if it happened on the very first
      // (synchronous) tick -- since that throw would escape before the
      // caller's own try block is entered. Resolving to null on error keeps
      // this a plain "not found" outcome instead of an escaping exception,
      // so callers' cleanup always runs.
      let found;
      try {
        found = getter();
      } catch (err) {
        console.error("[Instafn] waitFor getter threw:", err);
        return resolve(null);
      }
      if (found) return resolve(found);
      if (attempts >= maxAttempts) return resolve(null);
      setTimeout(tick, interval);
    };
    tick();
  });
}

function buttonFrom(svgSelector, scope) {
  const svg =
    scope.querySelector(svgSelector) ||
    scope.parentElement?.querySelector(svgSelector) ||
    scope.closest('[role="row"], [role="group"]')?.querySelector(svgSelector);
  return svg ? svg.closest('[role="button"]') : null;
}

// -------------------------------------------------------------------------
// Pipelines
// -------------------------------------------------------------------------

/** Double-tap to like: react to `group` with the heart (first reaction). */
export async function reactToMessage(group) {
  const guard = startFlashGuard();
  // The whole pipeline used to unhide (stopFlashGuard) only at each explicit
  // return point. That's exactly the kind of thing that's fragile against
  // Instagram DOM changes: if any step here throws instead of cleanly
  // returning null/false (e.g. a selector match that no longer holds), the
  // function aborts mid-pipeline and NEVER reaches triggerUnhover/
  // stopFlashGuard -- leaving the hover row's react/reply/more icons stuck
  // at opacity:0 (which is what the flash guard's hide style enforces)
  // permanently, since nothing else ever clears that dataset attribute.
  // try/finally guarantees cleanup runs on every exit path, including a
  // thrown error, so a failed react at worst does nothing instead of
  // wedging the row.
  try {
    triggerHover(getHoverTarget(group));

    const reactBtn = await waitFor(() => buttonFrom(REACT_SVG, group));
    if (!reactBtn) return false;
    clickInstantly(reactBtn);

    const heart = await waitFor(() => {
      const dialog = document.querySelector('[role="dialog"]');
      if (!dialog) return null;
      const buttons = Array.from(dialog.querySelectorAll('[role="button"]'));
      // Prefer the literal heart. Instagram doesn't always render reaction
      // emoji as plain unicode text -- it's also seen rendering them as an
      // <img> sprite (alt="❤️" / aria-label mentioning "heart") for consistent
      // cross-platform glyphs, which leaves textContent empty and breaks both
      // this match and the length<=2 fallback below (an empty string fails
      // the `text &&` guard, and no button textContent-includes-❤ anywhere).
      const explicit = buttons.find(
        (b) =>
          (b.textContent || "").includes("❤") ||
          /heart/i.test(b.getAttribute("aria-label") || "") ||
          [...b.querySelectorAll("img")].some((img) =>
            (img.getAttribute("alt") || "").includes("❤")
          )
      );
      if (explicit) return explicit;
      return buttons.find((b) => {
        if (b.querySelector('svg[aria-label="Choose an emoji"]')) return false;
        const text = b.querySelector("span")?.textContent?.trim() || "";
        return text && [...text].length <= 2;
      });
    });

    if (heart) clickInstantly(heart);
    return !!heart;
  } catch (err) {
    console.error("[Instafn] reactToMessage failed:", err);
    return false;
  } finally {
    triggerUnhover(group);
    stopFlashGuard(guard);
  }
}

/** Quick reply: open the reply composer for `group` (single click, no submenu). */
export async function replyToMessage(group) {
  const guard = startFlashGuard();
  try {
    triggerHover(getHoverTarget(group));
    const replyBtn = await waitFor(() => buttonFrom(REPLY_SVG, group));
    if (replyBtn) clickInstantly(replyBtn);
    return !!replyBtn;
  } catch (err) {
    console.error("[Instafn] replyToMessage failed:", err);
    return false;
  } finally {
    triggerUnhover(group);
    stopFlashGuard(guard);
  }
}

/** Quick edit: open the "See more options" menu for `group` and click Edit. */
export async function editMessage(group) {
  const guard = startFlashGuard();
  try {
    triggerHover(getHoverTarget(group));

    const moreBtn = await waitFor(
      () =>
        buttonFrom(MORE_SVG, group) ||
        group.querySelector('[role="button"][aria-haspopup="menu"]')
    );
    if (!moreBtn) return false;
    clickInstantly(moreBtn);

    const editBtn = await waitFor(() => {
      const dialog = document.querySelector('[role="dialog"]');
      if (!dialog) return null;
      return (
        dialog.querySelector('svg[aria-label="Edit"]')?.closest('[role="button"]') ||
        Array.from(dialog.querySelectorAll('[role="button"]')).find(
          (b) => b.textContent?.trim() === "Edit"
        ) ||
        null
      );
    });

    if (editBtn) {
      clickInstantly(editBtn);
      return true;
    }

    // Couldn't find Edit — close the menu so we don't leave it dangling.
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", keyCode: 27, bubbles: true })
    );
    return false;
  } catch (err) {
    console.error("[Instafn] editMessage failed:", err);
    return false;
  } finally {
    triggerUnhover(group);
    stopFlashGuard(guard);
  }
}
