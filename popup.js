// popup.js

const fieldListEl = document.getElementById("fieldList");
const managePanel = document.getElementById("managePanel");
const manageListEl = document.getElementById("manageList");
const manageToggle = document.getElementById("manageToggle");
const manageClose = document.getElementById("manageClose");
const addFieldForm = document.getElementById("addFieldForm");
const newFieldLabel = document.getElementById("newFieldLabel");
const newFieldFixedValue = document.getElementById("newFieldFixedValue");
const fillBtn = document.getElementById("fillBtn");
const clearBtn = document.getElementById("clearBtn");
const statusMsg = document.getElementById("statusMsg");

function send(message) {
  return chrome.runtime.sendMessage(message);
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

async function renderFieldList() {
  const [{ fields }, { captured }] = await Promise.all([
    send({ type: "GET_FIELDS" }),
    send({ type: "GET_CAPTURED" }),
  ]);

  fieldListEl.innerHTML = "";

  if (fields.length === 0) {
    fieldListEl.innerHTML = `<div class="empty-state">No fields yet — add one under "Manage fields".</div>`;
    return;
  }

  for (const field of fields) {
    const type = field.type || "dynamic";
    const entry = captured[field.id];
    const hasValue = !!entry?.value;

    const row = document.createElement("div");
    row.className = "field-row " + (hasValue ? "has-value" : "is-empty");

    const label = document.createElement("div");
    label.className = "field-row__label";
    label.title = field.label;
    label.innerHTML = `
      <span class="field-row__name">${escapeHtml(field.label)}</span>
      <span class="type-chip ${type}">${type === "fixed" ? "F" : "D"}</span>
    `;

    const input = document.createElement("input");
    input.className = "field-row__input" + (type === "fixed" ? " field-row__input--fixed" : "");
    input.value = entry?.value || "";
    input.placeholder = type === "fixed" ? "Set in Manage Fields" : "Not captured yet — or paste here";

    input.addEventListener("change", async () => {
      await send({ type: "SET_CAPTURED_VALUE", fieldId: field.id, value: input.value, source: "manual" });
      const filled = !!input.value;
      row.classList.toggle("has-value", filled);
      row.classList.toggle("is-empty", !filled);
    });

    row.appendChild(label);
    row.appendChild(input);
    fieldListEl.appendChild(row);
  }
}

async function renderManageList() {
  const [{ fields }, { captured }] = await Promise.all([
    send({ type: "GET_FIELDS" }),
    send({ type: "GET_CAPTURED" }),
  ]);
  manageListEl.innerHTML = "";

  for (const field of fields) {
    const type = field.type || "dynamic";
    const row = document.createElement("div");
    row.className = "manage-row";

    const info = document.createElement("div");
    info.className = "manage-row-info";
    info.innerHTML = `
      <div class="label-line">
        ${escapeHtml(field.label)}
        <span class="type-pill ${type}">${type}</span>
      </div>
    `;

    if (type === "fixed") {
      const valueInput = document.createElement("input");
      valueInput.className = "fixed-value-edit";
      valueInput.type = "text";
      valueInput.placeholder = "Value used every time";
      valueInput.value = captured[field.id]?.value || "";
      valueInput.addEventListener("change", async () => {
        await send({ type: "UPDATE_FIXED_VALUE", fieldId: field.id, value: valueInput.value });
        await renderFieldList();
      });
      info.appendChild(valueInput);
    }

    const removeBtn = document.createElement("button");
    removeBtn.className = "remove-btn";
    removeBtn.title = "Remove field";
    removeBtn.textContent = "\u2212"; // −
    removeBtn.addEventListener("click", async () => {
      await send({ type: "REMOVE_FIELD", fieldId: field.id });
      await renderManageList();
      await renderFieldList();
    });

    row.appendChild(info);
    row.appendChild(removeBtn);
    manageListEl.appendChild(row);
  }
}

function openManagePanel() {
  managePanel.classList.remove("hidden");
  renderManageList();
}

function closeManagePanel() {
  managePanel.classList.add("hidden");
}

manageToggle.addEventListener("click", () => {
  if (managePanel.classList.contains("hidden")) {
    openManagePanel();
  } else {
    closeManagePanel();
  }
});

manageClose.addEventListener("click", closeManagePanel);

// Show/hide the fixed-value input depending on the chosen type.
addFieldForm.querySelectorAll('input[name="fieldType"]').forEach((radio) => {
  radio.addEventListener("change", () => {
    const isFixed = addFieldForm.querySelector('input[name="fieldType"]:checked').value === "fixed";
    newFieldFixedValue.classList.toggle("hidden", !isFixed);
    newFieldFixedValue.required = isFixed;
  });
});

addFieldForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const label = newFieldLabel.value.trim();
  if (!label) return;
  const fieldType = addFieldForm.querySelector('input[name="fieldType"]:checked').value;
  const fixedValue = newFieldFixedValue.value.trim();

  await send({ type: "ADD_FIELD", label, aliases: [], fieldType, fixedValue });

  newFieldLabel.value = "";
  newFieldFixedValue.value = "";
  newFieldFixedValue.classList.add("hidden");
  addFieldForm.querySelector('input[value="dynamic"]').checked = true;

  await renderManageList();
  await renderFieldList();
});

fillBtn.addEventListener("click", async () => {
  statusMsg.textContent = "";
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/^https:\/\/docs\.google\.com\/forms\//.test(tab.url || "")) {
    statusMsg.textContent = "Open a Google Form tab first, then click Fill.";
    return;
  }
  try {
    const result = await chrome.tabs.sendMessage(tab.id, { type: "RUN_AUTOFILL" });
    statusMsg.textContent = result
      ? `Filled ${result.filled} of ${result.total} field(s).`
      : "Done — check the form tab.";
  } catch (err) {
    statusMsg.textContent = "Couldn't reach the form tab — reload it once, then Fill again.";
  }
});

clearBtn.addEventListener("click", async () => {
  await send({ type: "CLEAR_CAPTURED" });
  await renderFieldList();
  statusMsg.textContent = "Captured values cleared (fixed field values are kept).";
});

renderFieldList();
