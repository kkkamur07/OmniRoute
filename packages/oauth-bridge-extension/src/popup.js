import { tabOrigin } from "./origin.js";
import { approveOrigin, getApproved, removeOrigin as removeApproved } from "./approval.js";

const $ = (id) => document.getElementById(id);
let activeOrigin = null;

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
  renderList(await removeApproved(chrome, origin));
  setStatus("Removed.");
}

function onApproveClick() {
  const origin = activeOrigin;
  // The permission request must run synchronously inside the click gesture.
  chrome.permissions.request({ origins: [origin + "/*"] }).then(async (granted) => {
    if (!granted) {
      setStatus("Permission was not granted.");
      return;
    }
    // Also injects content.js into open tabs of this origin, so no reload is needed.
    renderList(await approveOrigin(chrome, origin));
    setStatus("Approved.");
  });
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeOrigin = tabOrigin(tab);
  if (activeOrigin) {
    $("origin").textContent = activeOrigin;
    $("current").hidden = false;
  } else {
    $("note").hidden = false;
  }
  $("approve").addEventListener("click", onApproveClick);
  renderList(await getApproved(chrome));
}

init();
