import { getApproved, removeOrigin as removeApproved } from "./approval.js";

const $ = (id) => document.getElementById(id);

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
}

async function removeOrigin(origin) {
  renderList(await removeApproved(chrome, origin));
  setStatus("Removed.");
}

async function init() {
  renderList(await getApproved(chrome));
}

init();
