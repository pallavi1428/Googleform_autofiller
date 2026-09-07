// content-autofill.js — runs only on https://docs.google.com/forms/*
// Reads the rendered form, matches each question's label against the
// user's field definitions (label + aliases) using FuzzyMatch (lib/fuzzy.js),
// then fills matching text/textarea inputs by simulating real user input so
// Google Forms' own validation and "required" checks fire correctly.

const SAFB_MATCH_THRESHOLD = 0.72;

function getQuestionContainers() {
  // Each Google Forms question is wrapped in a div with role="listitem".
  return Array.from(document.querySelectorAll('div[role="listitem"]'));
}

function getLabelForContainer(container) {
  // The question title is rendered inside a heading-like div; Google's
  // generated class names are unstable, so we search by role/heading text
  // rather than a specific class.
  const heading = container.querySelector('[role="heading"]');
  if (heading && heading.textContent) return heading.textContent.trim();

  // Fallback: first non-empty text node near the top of the container.
  const candidate = container.querySelector("span, div");
  return candidate ? candidate.textContent.trim() : "";
}

function getFillableInput(container) {
  // Short answer / paragraph questions render a plain <input type="text">
  // or <textarea>. We only auto-fill these (not radio/checkbox/dropdown),
  // since free-text fields are what order IDs, AWB numbers, phone numbers
  // etc. belong in, and mis-clicking a radio option is a much worse failure
  // mode than skipping it.
  return (
    container.querySelector('input[type="text"]') ||
    container.querySelector("textarea")
  );
}

function nativeValueSetter(element) {
  const proto = element instanceof HTMLTextAreaElement
    ? window.HTMLTextAreaElement.prototype
    : window.HTMLInputElement.prototype;
  return Object.getOwnPropertyDescriptor(proto, "value").set;
}

function fillInput(element, value) {
  element.focus();
  const setter = nativeValueSetter(element);
  setter.call(element, value);

  // Dispatch the full event sequence React/Google Forms listens for so
  // their internal state (and "required" validation) actually updates.
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
  element.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true }));
  element.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
  element.blur();
  element.dispatchEvent(new Event("blur", { bubbles: true }));
}

function highlightElement(element) {
  const original = element.style.transition;
  element.style.transition = "background-color .3s ease, box-shadow .3s ease";
  element.style.backgroundColor = "#f0fdf4";
  element.style.boxShadow = "0 0 0 2px #16a34a inset";
  setTimeout(() => {
    element.style.backgroundColor = "";
    element.style.boxShadow = "";
    setTimeout(() => {
      element.style.transition = original;
    }, 350);
  }, 1200);
}

function showToast(message) {
  const el = document.createElement("div");
  el.textContent = message;
  Object.assign(el.style, {
    position: "fixed",
    bottom: "20px",
    right: "20px",
    background: "#111827",
    color: "#fff",
    padding: "10px 14px",
    borderRadius: "8px",
    fontSize: "13px",
    fontFamily: "system-ui, sans-serif",
    zIndex: 2147483647,
    boxShadow: "0 4px 14px rgba(0,0,0,.25)",
    opacity: "0",
    transition: "opacity .15s ease",
    maxWidth: "280px",
  });
  document.body.appendChild(el);
  requestAnimationFrame(() => (el.style.opacity = "1"));
  setTimeout(() => {
    el.style.opacity = "0";
    setTimeout(() => el.remove(), 200);
  }, 2200);
}

// isAutoRun=true -> silent, fixed-fields-only pass triggered on page load/refresh/
// after-submit, no button click needed. isAutoRun=false -> the explicit "Fill
// Google Form" button, which fills BOTH fixed and dynamic (captured) fields.
async function runAutofill({ isAutoRun = false } = {}) {
  const { fields } = await chrome.runtime.sendMessage({ type: "GET_FIELDS" });
  const { captured } = await chrome.runtime.sendMessage({ type: "GET_CAPTURED" });

  const eligibleFields = isAutoRun
    ? fields.filter((f) => (f.type || "dynamic") === "fixed")
    : fields;
  const definitionsWithValues = eligibleFields.filter((f) => captured[f.id]?.value);

  if (definitionsWithValues.length === 0) {
    if (!isAutoRun) {
      showToast("No captured values yet — right-click a value on your other tabs first.");
    }
    return { filled: 0, total: 0 };
  }

  const containers = getQuestionContainers();
  const labelToContainer = new Map();
  for (const container of containers) {
    const label = getLabelForContainer(container);
    const input = getFillableInput(container);
    if (label && input) labelToContainer.set(label, { container, input });
  }

  const formLabels = Array.from(labelToContainer.keys());
  const matches = FuzzyMatch.matchAll(formLabels, definitionsWithValues, SAFB_MATCH_THRESHOLD);

  let filled = 0;
  safbIsFilling = true;
  for (const { formLabel, definition } of matches) {
    const { input } = labelToContainer.get(formLabel);
    const value = captured[definition.id].value;
    // Never overwrite something the person already typed themselves.
    if (isAutoRun && input.value && input.value.trim()) continue;
    fillInput(input, value);
    highlightElement(input);
    filled += 1;
  }
  setTimeout(() => (safbIsFilling = false), 50);

  if (!isAutoRun) {
    showToast(
      filled > 0
        ? `Filled ${filled} of ${formLabels.length} field${formLabels.length === 1 ? "" : "s"}.`
        : "No matching fields found on this form."
    );
  } else if (filled > 0) {
    showToast(`Auto-filled ${filled} fixed field${filled === 1 ? "" : "s"}.`);
  }
  return { filled, total: formLabels.length };
}

// Let the popup (or overlay) trigger a full fill on demand.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "RUN_AUTOFILL") {
    runAutofill({ isAutoRun: false }).then((result) => sendResponse(result));
    return true;
  }
});

// --- Automatic fixed-field filling, no click required ---
// Google Forms is a single-page app: the same URL is reused after "Submit
// another response" and after a plain refresh, and questions render in
// asynchronously. We watch for question containers appearing/changing and
// silently re-run the fixed-field fill each time, guarding against our own
// fill operations re-triggering the observer.
let safbIsFilling = false;
let safbDebounceTimer = null;

function scheduleAutoFill() {
  if (safbIsFilling) return;
  clearTimeout(safbDebounceTimer);
  safbDebounceTimer = setTimeout(() => {
    if (getQuestionContainers().length > 0) {
      runAutofill({ isAutoRun: true });
    }
  }, 600);
}

const safbObserver = new MutationObserver(() => {
  if (safbIsFilling) return;
  scheduleAutoFill();
});
safbObserver.observe(document.documentElement, { childList: true, subtree: true });

// Also try once shortly after initial load, in case the form is already
// present before the observer attaches.
scheduleAutoFill();
