// background.js — MV3 service worker
// Responsibilities:
//  1. Keep a right-click "Capture as ▸ <field>" menu in sync with user-defined fields.
//  2. On capture click, read the value from the page (selection or right-clicked
//     element) and store it against that field.
//  3. Serve get/set storage requests from the popup and the on-page overlay.
//  4. Route Alt+1..Alt+0 / Alt+Shift+H keyboard shortcuts to the active tab.

const STORAGE_FIELDS_KEY = "safb_fields"; // array of {id, label, aliases:[]}
const STORAGE_CAPTURED_KEY = "safb_captured"; // { [fieldId]: {value, ts, source} }
const MENU_PREFIX = "safb_capture_";
const MENU_PARENT_ID = "safb_capture_parent";
const MENU_CLEAR_ID = "safb_clear_all";

// type: "dynamic" -> value changes per call, captured via right-click or
//                    Alt+N shortcut on other tabs. Numbered 1, 2, 3... in
//                    the order they're stored, which is also the order the
//                    overlay HUD numbers them and the order shortcuts map to.
// type: "fixed"   -> value never changes (e.g. your name, team, department);
//                    set once in Manage Fields and auto-filled on every form
//                    load, no click needed.
const DEFAULT_FIELDS = [
  { id: "field_order_id", label: "Order ID", aliases: ["order no", "order number", "order#"], type: "dynamic" },
  { id: "field_awb", label: "AWB Number", aliases: ["awb", "airway bill", "tracking number", "tracking id"], type: "dynamic" },
  { id: "field_phone", label: "Phone Number", aliases: ["mobile", "mobile number", "contact number"], type: "dynamic" },
];

// Maps a chrome.commands command name to a 0-based index into the list of
// "dynamic" fields (in stored order) — same order the overlay numbers them.
const SHORTCUT_COMMAND_INDEX = {
  capture_1: 0,
  capture_2: 1,
  capture_3: 2,
  capture_4: 3,
  capture_5: 4,
  capture_6: 5,
  capture_7: 6,
  capture_8: 7,
  capture_9: 8,
  capture_10: 9,
};

function uid(prefix = "field") {
  return `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

async function getFields() {
  const data = await chrome.storage.local.get(STORAGE_FIELDS_KEY);
  return data[STORAGE_FIELDS_KEY] || [];
}

async function setFields(fields) {
  await chrome.storage.local.set({ [STORAGE_FIELDS_KEY]: fields });
  await rebuildContextMenu();
}

async function getCaptured() {
  const data = await chrome.storage.local.get(STORAGE_CAPTURED_KEY);
  return data[STORAGE_CAPTURED_KEY] || {};
}

async function setCapturedValue(fieldId, value, source) {
  const captured = await getCaptured();
  captured[fieldId] = { value, ts: Date.now(), source: source || "" };
  await chrome.storage.local.set({ [STORAGE_CAPTURED_KEY]: captured });
  return captured;
}

async function clearCaptured() {
  // Only clear "dynamic" values (per-call data like Order ID/AWB) — "fixed"
  // field values are meant to persist forever until manually edited/removed.
  const fields = await getFields();
  const fixedIds = new Set(fields.filter((f) => f.type === "fixed").map((f) => f.id));
  const captured = await getCaptured();
  const kept = {};
  for (const [id, entry] of Object.entries(captured)) {
    if (fixedIds.has(id)) kept[id] = entry;
  }
  await chrome.storage.local.set({ [STORAGE_CAPTURED_KEY]: kept });
}

async function rebuildContextMenu() {
  await chrome.contextMenus.removeAll();
  const fields = await getFields();
  // Only "dynamic" fields make sense to capture on the fly — "fixed" fields
  // have a constant value set once in Manage Fields and don't need capturing.
  const dynamicFields = fields.filter((f) => (f.type || "dynamic") === "dynamic");

  if (dynamicFields.length === 0) {
    chrome.contextMenus.create({
      id: MENU_CLEAR_ID,
      title: "Clear all captured values",
      contexts: ["page", "selection", "editable"],
    });
    return;
  }

  chrome.contextMenus.create({
    id: MENU_PARENT_ID,
    title: "Capture as \u25B8", // ▸
    contexts: ["selection", "editable"],
  });

  dynamicFields.forEach((field, index) => {
    let shortcutSuffix = "";
    if (index === 0) shortcutSuffix = "  (Alt+1)";
    else if (index === 1) shortcutSuffix = "  (Alt+2)";
    else if (index === 2) shortcutSuffix = "  (Alt+3)";
    chrome.contextMenus.create({
      id: `${MENU_PREFIX}${field.id}`,
      parentId: MENU_PARENT_ID,
      title: field.label + shortcutSuffix,
      contexts: ["selection", "editable"],
    });
  });

  chrome.contextMenus.create({
    id: MENU_CLEAR_ID,
    title: "Clear all captured values",
    contexts: ["page", "selection", "editable"],
  });
}

// Ask the content script (content-capture.js) what value to use for this
// click: prefers highlighted selection text, falls back to the value of the
// element that was right-clicked (input/textarea/contenteditable), since
// selectionText is only populated by Chrome when text is actually selected.
async function resolveCaptureValue(tabId, info) {
  if (info.selectionText && info.selectionText.trim()) {
    return info.selectionText.trim();
  }
  try {
    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const el = window.__safbLastContextTarget;
        if (!el) return null;
        if ("value" in el && typeof el.value === "string") return el.value.trim();
        if (el.isContentEditable) return el.innerText.trim();
        return (el.innerText || el.textContent || "").trim();
      },
    });
    return result || null;
  } catch (e) {
    return null;
  }
}

async function flashConfirmation(tabId, label, value) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (label, value) => {
        const el = document.createElement("div");
        el.textContent = `Captured "${label}": ${value.length > 40 ? value.slice(0, 40) + "…" : value}`;
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
        });
        document.body.appendChild(el);
        requestAnimationFrame(() => (el.style.opacity = "1"));
        setTimeout(() => {
          el.style.opacity = "0";
          setTimeout(() => el.remove(), 200);
        }, 1600);
      },
      args: [label, value],
    });
  } catch (e) {
    // best-effort only; page may not allow script injection (e.g. chrome:// pages)
  }
}

async function notifyCommandProblem(message) {
  try {
    await chrome.notifications.create({
      type: "basic",
      iconUrl: "icons/icon48.png",
      title: "Support Autofill Bridge",
      message,
      priority: 1,
    });
  } catch (e) {
    // notifications can fail to register in some environments; non-fatal
  }
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab || !tab.id) return;

  if (info.menuItemId === MENU_CLEAR_ID) {
    await clearCaptured();
    return;
  }

  if (typeof info.menuItemId === "string" && info.menuItemId.startsWith(MENU_PREFIX)) {
    const fieldId = info.menuItemId.slice(MENU_PREFIX.length);
    const fields = await getFields();
    const field = fields.find((f) => f.id === fieldId);
    if (!field) return;

    const value = await resolveCaptureValue(tab.id, info);
    if (!value) {
      await flashConfirmation(tab.id, field.label, "(nothing found — select the text first)");
      return;
    }
    await setCapturedValue(fieldId, value, tab.url);
    await flashConfirmation(tab.id, field.label, value);
  }
});

// --- Keyboard shortcuts (Alt+1..Alt+0 capture, Alt+Shift+H toggle) ---
// These are declared in manifest.json under "commands". Chrome only
// auto-registers a shortcut for a handful of commands out of the box — if
// Alt+N doesn't do anything on your machine, open chrome://extensions/shortcuts
// and assign it manually (also useful if Alt+N collides with something else
// you use).
chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) return;

  if (command === "toggle_overlay") {
    try {
      await chrome.tabs.sendMessage(tab.id, { type: "TOGGLE_OVERLAY" });
    } catch (e) {
      // No content script on this tab (e.g. chrome:// or the Web Store) — ignore.
    }
    return;
  }

  const index = SHORTCUT_COMMAND_INDEX[command];
  if (index === undefined) return;

  const fields = await getFields();
  const dynamicFields = fields.filter((f) => (f.type || "dynamic") === "dynamic");

  if (index >= dynamicFields.length) {
    await notifyCommandProblem(`Field #${index + 1} isn't defined yet — add it under Manage Fields.`);
    return;
  }

  const field = dynamicFields[index];
  try {
    await chrome.tabs.sendMessage(tab.id, {
      type: "CAPTURE_FROM_SHORTCUT",
      fieldId: field.id,
      fieldLabel: field.label,
    });
  } catch (e) {
    await notifyCommandProblem("Can't capture on this page — try a regular webpage tab.");
  }
});

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === "install") {
    await setFields(DEFAULT_FIELDS);
    await chrome.storage.local.set({ [STORAGE_CAPTURED_KEY]: {} });
  } else {
    await rebuildContextMenu();
  }
});

chrome.runtime.onStartup.addListener(rebuildContextMenu);

// Message API used by popup.js and overlay.js
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg?.type) {
      case "GET_FIELDS":
        sendResponse({ fields: await getFields() });
        break;
      case "SET_FIELDS":
        await setFields(msg.fields);
        sendResponse({ ok: true });
        break;
      case "ADD_FIELD": {
        const fields = await getFields();
        const newField = {
          id: uid(),
          label: msg.label,
          aliases: msg.aliases || [],
          type: msg.fieldType === "fixed" ? "fixed" : "dynamic",
        };
        fields.push(newField);
        await setFields(fields);
        // A fixed field's value is entered once right here, not "captured" later.
        if (newField.type === "fixed" && msg.fixedValue) {
          await setCapturedValue(newField.id, msg.fixedValue, "fixed-default");
        }
        sendResponse({ ok: true, fields });
        break;
      }
      case "UPDATE_FIXED_VALUE": {
        await setCapturedValue(msg.fieldId, msg.value, "fixed-default");
        sendResponse({ ok: true });
        break;
      }
      case "REMOVE_FIELD": {
        const fields = (await getFields()).filter((f) => f.id !== msg.fieldId);
        await setFields(fields);
        const captured = await getCaptured();
        delete captured[msg.fieldId];
        await chrome.storage.local.set({ [STORAGE_CAPTURED_KEY]: captured });
        sendResponse({ ok: true, fields });
        break;
      }
      case "GET_CAPTURED":
        sendResponse({ captured: await getCaptured() });
        break;
      case "SET_CAPTURED_VALUE":
        sendResponse({ captured: await setCapturedValue(msg.fieldId, msg.value, msg.source) });
        break;
      case "CLEAR_CAPTURED":
        await clearCaptured();
        sendResponse({ ok: true });
        break;
      case "RUN_AUTOFILL_ON_FORM_TAB": {
        // Content scripts (like overlay.js) don't have chrome.tabs access,
        // so the HUD's "Fill Form" button routes through here: find the
        // Google Form tab and forward the fill request to it.
        const [formTab] = await chrome.tabs.query({ url: "https://docs.google.com/forms/*" });
        if (!formTab) {
          sendResponse({ ok: false, reason: "no-form-tab" });
          break;
        }
        try {
          const result = await chrome.tabs.sendMessage(formTab.id, { type: "RUN_AUTOFILL" });
          sendResponse({ ok: true, result });
        } catch (e) {
          sendResponse({ ok: false, reason: "unreachable" });
        }
        break;
      }
      default:
        sendResponse({ error: "unknown message type" });
    }
  })();
  return true; // keep the message channel open for the async response
});
