// overlay.js — floating on-page HUD.
//
// Shows every "dynamic" field numbered 1, 2, 3... with its Alt+N shortcut
// and current captured value, live, on top of whatever page you're on.
// Updates come from two places:
//   - chrome.storage.onChanged: fires in every tab whenever a value changes
//     anywhere (another tab, the popup, the Manage panel) — this is what
//     keeps the HUD in sync across tabs in real time.
//   - a "safb-capture" window event dispatched by content-capture.js right
//     after a shortcut capture on *this* tab, so the toast/flash feels
//     instant instead of waiting on a storage round trip.

(function () {
  if (window.__safbOverlayInjected) return; // avoid double-injection on SPA reloads
  window.__safbOverlayInjected = true;

  const STORAGE_FIELDS_KEY = "safb_fields";
  const STORAGE_CAPTURED_KEY = "safb_captured";
  const STORAGE_POSITION_KEY = "safb_overlay_position";
  const STORAGE_COLLAPSED_KEY = "safb_overlay_collapsed";

  let fields = [];
  let captured = {};
  let els = {}; // cached DOM refs

  function truncate(text, maxLen) {
    if (!text) return "";
    return text.length > maxLen ? text.slice(0, maxLen) + "…" : text;
  }

  function shortcutLabelFor(index) {
    // Chrome only lets an extension pre-register 4 keyboard shortcuts, so
    // only fields #1-#3 (plus the Alt+Shift+H toggle) have a default binding
    // out of the box. Fields #4+ still work — the person just has to assign
    // a key to "capture_4", "capture_5", etc. at chrome://extensions/shortcuts.
    if (index === 0) return "Alt+1";
    if (index === 1) return "Alt+2";
    if (index === 2) return "Alt+3";
    if (index <= 9) return "set shortcut";
    return "";
  }

  async function loadData() {
    const data = await chrome.storage.local.get([STORAGE_FIELDS_KEY, STORAGE_CAPTURED_KEY]);
    fields = data[STORAGE_FIELDS_KEY] || [];
    captured = data[STORAGE_CAPTURED_KEY] || {};
  }

  function getDynamicFields() {
    return fields.filter((f) => (f.type || "dynamic") === "dynamic");
  }

  function buildOverlay() {
    const overlay = document.createElement("div");
    overlay.id = "safb-overlay";

    const toast = document.createElement("div");
    toast.className = "safb-toast";
    overlay.appendChild(toast);

    const header = document.createElement("div");
    header.className = "safb-header";

    const left = document.createElement("div");
    left.className = "safb-header-left";
    const dots = document.createElement("span");
    dots.className = "safb-drag-dots";
    dots.textContent = "⠿";
    const title = document.createElement("span");
    title.className = "safb-title";
    title.textContent = "Autofill HUD";
    const badge = document.createElement("span");
    badge.className = "safb-badge";
    left.append(dots, title, badge);

    const right = document.createElement("div");
    right.className = "safb-header-right";
    const collapseBtn = document.createElement("button");
    collapseBtn.className = "safb-icon-btn";
    collapseBtn.title = "Collapse";
    collapseBtn.textContent = "\u2013"; // –
    const closeBtn = document.createElement("button");
    closeBtn.className = "safb-icon-btn";
    closeBtn.title = "Hide (Alt+Shift+H to bring back)";
    closeBtn.textContent = "\u00d7"; // ×
    right.append(collapseBtn, closeBtn);

    header.append(left, right);

    const body = document.createElement("div");
    body.className = "safb-body";

    const footer = document.createElement("div");
    footer.className = "safb-footer";
    const clearBtn = document.createElement("button");
    clearBtn.textContent = "Clear";
    const fillBtn = document.createElement("button");
    fillBtn.className = "safb-primary";
    fillBtn.textContent = "Fill Form";
    footer.append(clearBtn, fillBtn);

    overlay.append(header, body, footer);
    document.documentElement.appendChild(overlay);

    els = { overlay, toast, badge, body, header, collapseBtn, closeBtn, clearBtn, fillBtn };

    makeDraggable(overlay, header);
    collapseBtn.addEventListener("click", toggleCollapse);
    closeBtn.addEventListener("click", () => overlay.classList.add("safb-hidden"));
    clearBtn.addEventListener("click", handleClearAll);
    fillBtn.addEventListener("click", handleFillForm);

    restorePosition();
    restoreCollapsedState();
  }

  function makeDraggable(overlay, handle) {
    let dragging = false;
    let startX, startY, origLeft, origTop;

    handle.addEventListener("mousedown", (e) => {
      if (e.target === els.collapseBtn || e.target === els.closeBtn) return;
      dragging = true;
      const rect = overlay.getBoundingClientRect();
      startX = e.clientX;
      startY = e.clientY;
      origLeft = rect.left;
      origTop = rect.top;
      overlay.style.transition = "none";
      e.preventDefault();
    });

    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      overlay.style.left = Math.max(4, origLeft + dx) + "px";
      overlay.style.top = Math.max(4, origTop + dy) + "px";
      overlay.style.bottom = "auto";
      overlay.style.right = "auto";
    });

    window.addEventListener("mouseup", () => {
      if (!dragging) return;
      dragging = false;
      overlay.style.transition = "";
      const rect = overlay.getBoundingClientRect();
      chrome.storage.local.set({ [STORAGE_POSITION_KEY]: { left: rect.left, top: rect.top } });
    });
  }

  async function restorePosition() {
    const data = await chrome.storage.local.get(STORAGE_POSITION_KEY);
    const pos = data[STORAGE_POSITION_KEY];
    if (pos && els.overlay) {
      els.overlay.style.left = pos.left + "px";
      els.overlay.style.top = pos.top + "px";
      els.overlay.style.bottom = "auto";
      els.overlay.style.right = "auto";
    }
  }

  async function restoreCollapsedState() {
    const data = await chrome.storage.local.get(STORAGE_COLLAPSED_KEY);
    if (data[STORAGE_COLLAPSED_KEY]) {
      els.overlay.classList.add("safb-collapsed");
      els.collapseBtn.textContent = "\u25a1"; // □
    }
  }

  function toggleCollapse() {
    const collapsed = els.overlay.classList.toggle("safb-collapsed");
    els.collapseBtn.textContent = collapsed ? "\u25a1" : "\u2013";
    chrome.storage.local.set({ [STORAGE_COLLAPSED_KEY]: collapsed });
  }

  function render() {
    if (!els.overlay) return;
    const dynamicFields = getDynamicFields();
    const filledCount = dynamicFields.filter((f) => captured[f.id]?.value).length;
    els.badge.textContent = `${filledCount}/${dynamicFields.length}`;

    els.body.innerHTML = "";

    if (dynamicFields.length === 0) {
      const empty = document.createElement("div");
      empty.className = "safb-empty-state";
      empty.textContent = 'No dynamic fields yet — add one from the extension popup under "Manage fields".';
      els.body.appendChild(empty);
      return;
    }

    dynamicFields.forEach((field, index) => {
      const entry = captured[field.id];
      const hasValue = !!entry?.value;

      const row = document.createElement("div");
      row.className = "safb-field-row" + (hasValue ? " safb-has-value" : "");
      row.dataset.fieldId = field.id;

      const number = document.createElement("div");
      number.className = "safb-field-number";
      number.textContent = String(index + 1);

      const main = document.createElement("div");
      main.className = "safb-field-main";
      const label = document.createElement("div");
      label.className = "safb-field-label";
      label.textContent = field.label; // textContent — safe even if the label has odd characters
      const value = document.createElement("div");
      value.className = "safb-field-value" + (hasValue ? "" : " safb-empty-text");
      value.textContent = hasValue ? truncate(entry.value, 26) : "not captured yet";
      main.append(label, value);

      const shortcut = shortcutLabelFor(index);
      row.append(number, main);
      if (shortcut) {
        const hint = document.createElement("div");
        hint.className = "safb-shortcut-hint";
        hint.textContent = shortcut;
        row.appendChild(hint);
      }

      // Click a row to edit its value by hand — same manual-entry escape
      // hatch the popup offers, for when a shortcut/right-click doesn't fit.
      row.addEventListener("click", () => handleManualEdit(field, entry?.value || ""));

      els.body.appendChild(row);
    });
  }

  async function handleManualEdit(field, currentValue) {
    const next = window.prompt(`Value for "${field.label}":`, currentValue);
    if (next === null) return;
    await chrome.runtime.sendMessage({
      type: "SET_CAPTURED_VALUE",
      fieldId: field.id,
      value: next.trim(),
      source: "manual",
    });
    // storage.onChanged will trigger a re-render; no need to do it here too.
  }

  async function handleClearAll() {
    await chrome.runtime.sendMessage({ type: "CLEAR_CAPTURED" });
    showToast("Cleared captured values");
  }

  async function handleFillForm() {
    // Content scripts can't call chrome.tabs directly, so background.js
    // finds the Google Form tab and forwards the fill request on our behalf.
    const response = await chrome.runtime.sendMessage({ type: "RUN_AUTOFILL_ON_FORM_TAB" });
    if (!response?.ok) {
      showToast(
        response?.reason === "no-form-tab" ? "No Google Form tab open" : "Couldn't reach the form tab — reload it",
        true
      );
      return;
    }
    const result = response.result;
    showToast(result ? `Filled ${result.filled} of ${result.total}` : "Done");
  }

  function showToast(message, isError = false) {
    if (!els.toast) return;
    els.toast.textContent = message;
    els.toast.className = "safb-toast safb-show" + (isError ? " safb-error" : "");
    clearTimeout(els.toast._timer);
    els.toast._timer = setTimeout(() => {
      els.toast.classList.remove("safb-show");
    }, 2200);
  }

  function flashRow(fieldId) {
    const row = els.body?.querySelector(`.safb-field-row[data-field-id="${CSS.escape(fieldId)}"]`);
    if (!row) return;
    row.classList.add("safb-flash");
    setTimeout(() => row.classList.remove("safb-flash"), 650);
  }

  // --- Wiring ---

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes[STORAGE_FIELDS_KEY] || changes[STORAGE_CAPTURED_KEY]) {
      loadData().then(render);
    }
  });

  window.addEventListener("safb-capture", (e) => {
    const { ok, fieldLabel, value, message, fieldId } = e.detail || {};
    if (ok) {
      showToast(`Captured "${fieldLabel}": ${truncate(value, 30)}`);
      flashRow(fieldId);
    } else {
      showToast(message || `Couldn't capture "${fieldLabel}"`, true);
    }
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "TOGGLE_OVERLAY" && els.overlay) {
      els.overlay.classList.toggle("safb-hidden");
    }
  });

  async function init() {
    await loadData();
    buildOverlay();
    render();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
