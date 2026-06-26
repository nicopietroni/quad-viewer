import { loadMesh } from "./viewer.js";

const listEl = document.getElementById("mesh-list");
const searchEl = document.getElementById("search-input");
const countEl = document.getElementById("mesh-count");
const emptyViewport = document.getElementById("empty-viewport");

let allMeshes = [];
let selectedId = null;

async function loadConfig() {
  try {
    const res = await fetch("./config.json");
    const cfg = await res.json();
    if (cfg.pageTitle) {
      document.getElementById("page-title").textContent = cfg.pageTitle;
      document.title = cfg.pageTitle;
    }
    if (cfg.subtitle) {
      document.getElementById("page-subtitle").textContent = cfg.subtitle;
    }
  } catch (e) {
    console.warn("No config.json found, using defaults.");
  }
}

async function loadManifest() {
  const res = await fetch("./meshes/manifest.json");
  const data = await res.json();
  allMeshes = data.meshes || [];
  countEl.textContent = `${allMeshes.length} mesh${allMeshes.length === 1 ? "" : "es"}`;
  renderList(allMeshes);
}

function renderList(items) {
  listEl.innerHTML = "";

  if (items.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = allMeshes.length === 0
      ? "no meshes in manifest yet"
      : "no matches";
    listEl.appendChild(empty);
    return;
  }

  for (const entry of items) {
    const item = document.createElement("div");
    item.className = "mesh-item" + (entry.id === selectedId ? " selected" : "");
    item.tabIndex = 0;
    item.setAttribute("role", "button");
    item.setAttribute("aria-label", `Load mesh ${entry.name}`);

    const img = document.createElement("img");
    img.className = "thumb";
    img.loading = "lazy";
    img.src = entry.thumbnail || "";
    img.alt = entry.name;

    const label = document.createElement("div");
    label.className = "label";
    label.textContent = entry.name;

    item.appendChild(img);
    item.appendChild(label);

    const select = () => selectMesh(entry);
    item.addEventListener("click", select);
    item.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        select();
      }
    });

    listEl.appendChild(item);
  }
}

function selectMesh(entry) {
  selectedId = entry.id;
  renderList(filterMeshes(searchEl.value));
  emptyViewport.style.display = "none";
  loadMesh(entry);
}

function filterMeshes(query) {
  const q = query.trim().toLowerCase();
  if (!q) return allMeshes;
  return allMeshes.filter((m) => m.name.toLowerCase().includes(q));
}

searchEl.addEventListener("input", () => {
  renderList(filterMeshes(searchEl.value));
});

async function init() {
  await loadConfig();
  await loadManifest();
}

init();
