// content-capture.js — runs on every page, at document_start.
//
// Two jobs:
//
// 1. (Original) Track the most recent right-click target. The
//    chrome.contextMenus API tells background.js *which menu item* was
//    clicked but not *which element*, unless text was selected (via
//    info.selectionText). So we remember the last right-clicked element
//    here, and background.js reads it via chrome.scripting.executeScript
//    right after the click.
//
// 2. (New) Handle Alt+1..Alt+0 shortcut captures. background.js listens for
//    chrome.commands and, on a capture_N command, figures out which field
//    that maps to and sends this tab a CAPTURE_FROM_SHORTCUT message. This
//    script resolves a value the same way a person would expect:
//      a) current text selection on the page
//      b) if nothing is selected, the value of the currently focused
//         input/textarea/contenteditable
//      c) if nothing is focused either, the last right-clicked element
//    On success it stores the value (same SET_CAPTURED_VALUE message the
//    popup/manage panel already use) and dispatches a same-page
//    "safb-capture" window event so overlay.js can flash + toast instantly
//    without waiting on a storage round-trip. Other tabs pick up the new
//    value via chrome.storage.onChanged in overlay.js, which is what makes
//    the HUD update "in real time" everywhere.

(function () {
  document.addEventListener(
    "contextmenu",
    (event) => {
      window.__safbLastContextTarget = event.target;
    },
    true // capture phase, so this fires even if the page stops propagation
  );

  function readElementValue(el) {
    if (!el) return "";
    if ("value" in el && typeof el.value === "string") return el.value.trim();
    if (el.isContentEditable) return (el.innerText || "").trim();
    return (el.innerText || el.textContent || "").trim();
  }

  function resolveShortcutValue() {
    const selected = (window.getSelection()?.toString() || "").trim();
    if (selected) return selected;

    const active = document.activeElement;
    const fromActive = readElementValue(active);
    if (fromActive) return fromActive;

    return readElementValue(window.__safbLastContextTarget);
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type !== "CAPTURE_FROM_SHORTCUT") return;

    const value = resolveShortcutValue();

    if (!value) {
      window.dispatchEvent(
        new CustomEvent("safb-capture", {
          detail: {
            ok: false,
            fieldId: msg.fieldId,
            fieldLabel: msg.fieldLabel,
            message: "Nothing selected — highlight or click into a value first.",
          },
        })
      );
      sendResponse({ ok: false });
      return true;
    }

    chrome.runtime
      .sendMessage({
        type: "SET_CAPTURED_VALUE",
        fieldId: msg.fieldId,
        value,
        source: "shortcut",
      })
      .then(() => {
        window.dispatchEvent(
          new CustomEvent("safb-capture", {
            detail: { ok: true, fieldId: msg.fieldId, fieldLabel: msg.fieldLabel, value },
          })
        );
        sendResponse({ ok: true });
      })
      .catch(() => {
        window.dispatchEvent(
          new CustomEvent("safb-capture", {
            detail: { ok: false, fieldId: msg.fieldId, fieldLabel: msg.fieldLabel, message: "Could not save value." },
          })
        );
        sendResponse({ ok: false });
      });

    return true; // keep the message channel open for the async response
  });
})();
