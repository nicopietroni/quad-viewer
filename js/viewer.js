import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js";
import { OrbitControls } from "https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/controls/OrbitControls.js";
import { OBJLoader } from "https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/loaders/OBJLoader.js";

const viewportEl = document.getElementById("viewport");
const loadingOverlay = document.getElementById("loading-overlay");
const emptyViewport = document.getElementById("empty-viewport");
const modeTagEl = document.getElementById("mode-tag");
const meshNameEl = document.getElementById("mesh-name-pill");
const modeButtons = Array.from(document.querySelectorAll(".mode-btn"));

const MODE_FIELD = {
  quad: "quad",
  primal: "primal",
  dual: "dual",
};

let renderer, scene, camera, controls;
let currentGroup = null; // currently displayed THREE.Group
let currentMode = "quad";
let currentMeshEntry = null;
const objCache = new Map(); // url -> parsed THREE.Group (unattached, cached)
const groupCacheForEntry = new Map(); // `${entry.id}:${mode}` -> built THREE.Group (materials applied)

function initThree() {
  renderer = new THREE.WebGLRenderer({ canvas: viewportEl, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  scene = new THREE.Scene();
  scene.background = null;

  camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
  camera.position.set(2, 1.6, 2.4);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.rotateSpeed = 0.8;

  const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1.1);
  scene.add(hemi);
  const dir1 = new THREE.DirectionalLight(0xffffff, 0.9);
  dir1.position.set(3, 5, 4);
  scene.add(dir1);
  const dir2 = new THREE.DirectionalLight(0xffffff, 0.35);
  dir2.position.set(-4, -2, -3);
  scene.add(dir2);

  window.addEventListener("resize", onResize);
  onResize();
  animate();

  modeButtons.forEach((btn) => {
    btn.addEventListener("click", () => setMode(btn.dataset.mode));
  });

  window.addEventListener("keydown", (e) => {
    if (e.key === "1") setMode("quad");
    else if (e.key === "2") setMode("primal");
    else if (e.key === "3") setMode("dual");
  });
}

function onResize() {
  const wrap = document.getElementById("viewport-wrap");
  const w = wrap.clientWidth;
  const h = wrap.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}

// ---- Mode "quad": flat-shaded solid + faint wireframe overlay ----
function buildSolidGroup(rawGroup) {
  const group = new THREE.Group();

  rawGroup.traverse((child) => {
    if (child.isMesh && child.geometry) {
      const geo = child.geometry.clone();
      geo.computeVertexNormals();

      const solidMat = new THREE.MeshStandardMaterial({
        color: 0xb8bcb9,
        flatShading: true,
        roughness: 1.0,
        metalness: 0.0,
        side: THREE.DoubleSide,
      });
      group.add(new THREE.Mesh(geo, solidMat));

      const wireGeo = new THREE.WireframeGeometry(geo);
      const wireMat = new THREE.LineBasicMaterial({
        color: 0x2a2a2a,
        transparent: true,
        opacity: 0.55,
      });
      group.add(new THREE.LineSegments(wireGeo, wireMat));
    }
  });

  return group;
}

// ---- Mode "primal"/"dual": edges only (patch borders), no solid fill ----
function buildEdgesOnlyGroup(rawGroup, color) {
  const group = new THREE.Group();

  rawGroup.traverse((child) => {
    if (child.isMesh && child.geometry) {
      const wireGeo = new THREE.WireframeGeometry(child.geometry);
      const wireMat = new THREE.LineBasicMaterial({
        color,
        transparent: false,
      });
      group.add(new THREE.LineSegments(wireGeo, wireMat));
    } else if (child.isLine || child.isLineSegments) {
      // OBJLoader may produce line objects if the file has only edges ("l" elements)
      const mat = new THREE.LineBasicMaterial({ color });
      group.add(new THREE.LineSegments(child.geometry, mat));
    }
  });

  return group;
}

function frameCameraOnObject(object) {
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) return;
  const size = new THREE.Vector3();
  box.getSize(size);
  const center = new THREE.Vector3();
  box.getCenter(center);

  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  const fitDist = maxDim / (2 * Math.tan((Math.PI * camera.fov) / 360));
  const dist = fitDist * 1.8;

  controls.target.copy(center);
  const dir = new THREE.Vector3(0.6, 0.45, 0.8).normalize();
  camera.position.copy(center.clone().add(dir.multiplyScalar(dist)));
  camera.near = Math.max(dist / 100, 0.001);
  camera.far = dist * 100;
  camera.updateProjectionMatrix();
  controls.update();
}

async function loadOBJCached(url) {
  if (objCache.has(url)) {
    return objCache.get(url).clone();
  }
  const loader = new OBJLoader();
  const raw = await loader.loadAsync(url);
  objCache.set(url, raw);
  return raw.clone();
}

function clearCurrent() {
  if (currentGroup) {
    scene.remove(currentGroup);
    currentGroup = null;
  }
}

function updateModeButtons() {
  modeButtons.forEach((btn) => {
    const mode = btn.dataset.mode;
    const available = !!(currentMeshEntry && currentMeshEntry[MODE_FIELD[mode]]);
    btn.classList.toggle("active", mode === currentMode);
    btn.classList.toggle("disabled", !available);
    btn.disabled = !available;
  });
  modeTagEl.textContent = currentMode.toUpperCase();
}

async function buildGroupForMode(entry, mode) {
  const cacheKey = `${entry.id}:${mode}`;
  if (groupCacheForEntry.has(cacheKey)) {
    return groupCacheForEntry.get(cacheKey);
  }

  const url = entry[MODE_FIELD[mode]];
  if (!url) return null;

  const raw = await loadOBJCached(url);
  let group;
  if (mode === "quad") {
    group = buildSolidGroup(raw);
  } else if (mode === "primal") {
    group = buildEdgesOnlyGroup(raw, 0xe8a23d); // amber for primal patch borders
  } else {
    group = buildEdgesOnlyGroup(raw, 0x7fd9b6); // accent green for dual
  }

  groupCacheForEntry.set(cacheKey, group);
  return group;
}

export async function setMode(mode) {
  if (!currentMeshEntry) return;
  if (!currentMeshEntry[MODE_FIELD[mode]]) return; // variant not available
  if (mode === currentMode && currentGroup) {
    updateModeButtons();
    return;
  }

  loadingOverlay.classList.add("visible");
  try {
    const group = await buildGroupForMode(currentMeshEntry, mode);
    if (!group) return;

    clearCurrent();
    currentGroup = group;
    currentMode = mode;
    scene.add(currentGroup);
    updateModeButtons();
    frameCameraOnObject(currentGroup);
  } catch (err) {
    console.error("Failed to switch mode", mode, err);
  } finally {
    loadingOverlay.classList.remove("visible");
  }
}

export async function loadMesh(entry) {
  currentMeshEntry = entry;
  emptyViewport.style.display = "none";
  loadingOverlay.classList.add("visible");
  meshNameEl.textContent = entry.name;

  try {
    clearCurrent();

    // Prefer quad as default view; fall back to primal, then dual.
    const preferredOrder = ["quad", "primal", "dual"];
    const firstAvailable = preferredOrder.find((m) => entry[MODE_FIELD[m]]);
    if (!firstAvailable) {
      console.warn("No viewable variant for entry", entry);
      return;
    }

    const group = await buildGroupForMode(entry, firstAvailable);
    currentGroup = group;
    currentMode = firstAvailable;
    scene.add(currentGroup);
    updateModeButtons();
    frameCameraOnObject(currentGroup);
  } catch (err) {
    console.error("Failed to load mesh", entry, err);
  } finally {
    loadingOverlay.classList.remove("visible");
  }
}

initThree();
