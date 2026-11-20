const KEY = "approvedOrigins";
const SCRIPT_ID = "omniroute-oauth-bridge";

const $ = (id) => document.getElementById(id);
let activeTab = null;
let activeOrigin = null;

async function getApproved() {
  const stored = await chrome.storage.local.get(KEY);
  return Array.isArray(stored[KEY]) ? stored[KEY] : [];
}

async function saveApproved(origins) {
  await chrome.storage.local.set({ [KEY]: origins });
}

async function registerContentScript(origins) {
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [SCRIPT_ID] });
  if (existing.length > 0) await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] });
  if (origins.length === 0) return;
  await chrome.scripting.registerContentScripts([
    {
      id: SCRIPT_ID,
      js: ["src/content.js"],
      matches: origins.map((o) => o + "/*"),
      runAt: "document_start",
      persistAcrossSessions: true,
    },
  ]);
}

function setStatus(text) {
  $("status").textContent = text;
}

function renderList(origins) {
  const list = $("list");
  list.replaceChildren();
  $("empty").hidden = origins.length > 0;
  for (const origin of origins) {
    const item = document.createElement("li");
    const label = document.createElement("span");
    label.className = "origin";
    label.textContent = origin;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "remove";
    button.textContent = "Remove";
    button.addEventListener("click", () => removeOrigin(origin));
    item.append(label, button);
    list.append(item);
  }
  $("approve").hidden = activeOrigin !== null && origins.includes(activeOrigin);
}

async function removeOrigin(origin) {
  try {
    await chrome.permissions.remove({ origins: [origin + "/*"] });
  } catch {
    // Required host permissions cannot be removed; still drop the approval.
  }
  const next = (await getApproved()).filter((o) => o !== origin);
  await saveApproved(next);
  await registerContentScript(next);
  renderList(next);
  setStatus("Removed.");
}

function onApproveClick() {
  const origin = activeOrigin;
  const tabId = activeTab && activeTab.id;
  // The permission request must run synchronously inside the click gesture.
  chrome.permissions.request({ origins: [origin + "/*"] }).then(async (granted) => {
    if (!granted) {
      setStatus("Permission was not granted.");
      return;
    }
    const next = Array.from(new Set([...(await getApproved()), origin]));
    await saveApproved(next);
    await registerContentScript(next);
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ["src/content.js"] });
    } catch {
      // The tab may be unreachable; the registered script covers the next load.
    }
    renderList(next);
    setStatus("Approved. Reload the dashboard if it was already open.");
  });
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTab = tab || null;
  try {
    const url = new URL((tab && tab.url) || "");
    if (url.protocol === "http:" || url.protocol === "https:") activeOrigin = url.origin;
  } catch {
    activeOrigin = null;
  }
  if (activeOrigin) {
    $("origin").textContent = activeOrigin;
    $("current").hidden = false;
  } else {
    $("note").hidden = false;
  }
  $("approve").addEventListener("click", onApproveClick);
  renderList(await getApproved());
}

init();
