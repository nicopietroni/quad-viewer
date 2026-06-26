import * as THREE from "three";
import { TrackballControls } from "three/addons/controls/TrackballControls.js";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";

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
let latestRequestId = 0; // incremented on every loadMesh/setMode call; used to discard stale async results
const objCache = new Map(); // url -> parsed THREE.Group (unattached, cached, from OBJLoader)
const faceCache = new Map(); // url -> { vertices: Float32Array, faces: number[][] } from custom text parse
const groupCacheForEntry = new Map(); // `${entry.id}:${mode}` -> built THREE.Group (materials applied)

function initThree() {
  renderer = new THREE.WebGLRenderer({ canvas: viewportEl, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0xffffff);

  camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
  camera.position.set(2, 1.6, 2.4);

  controls = new TrackballControls(camera, renderer.domElement);
  controls.rotateSpeed = 3.0;
  controls.zoomSpeed = 1.2;
  controls.panSpeed = 0.8;
  controls.staticMoving = false;
  controls.dynamicDampingFactor = 0.15;

  // Light, neutral lighting for a white background scene
  const hemi = new THREE.HemisphereLight(0xffffff, 0xcfcfcf, 1.2);
  scene.add(hemi);
  const dir1 = new THREE.DirectionalLight(0xffffff, 0.7);
  dir1.position.set(3, 5, 4);
  scene.add(dir1);
  const dir2 = new THREE.DirectionalLight(0xffffff, 0.4);
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
  if (w === 0 || h === 0) return; // avoid setting a degenerate size during layout shifts
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  if (controls && controls.handleResize) controls.handleResize();
}

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}

// ---------------------------------------------------------------------
// Custom lightweight OBJ text parser.
// We only need vertex positions and the ORIGINAL face vertex count
// (3, 4, or more) so we can draw the true polygon perimeter as a line
// loop, instead of relying on Three.js's internal triangulation (which
// would add a visible diagonal across every quad).
// ---------------------------------------------------------------------
async function parseOBJFaces(url) {
  if (faceCache.has(url)) return faceCache.get(url);

  const res = await fetch(url);
  const text = await res.text();

  const vertices = [];
  const faces = []; // each entry: array of 0-based vertex indices, in original order

  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.charCodeAt(0) === 118 && line.charCodeAt(1) === 32) {
      // "v "
      const parts = line.trim().split(/\s+/);
      vertices.push(
        parseFloat(parts[1]),
        parseFloat(parts[2]),
        parseFloat(parts[3])
      );
    } else if (line.charCodeAt(0) === 102 && line.charCodeAt(1) === 32) {
      // "f "
      const parts = line.trim().split(/\s+/);
      const idx = [];
      for (let p = 1; p < parts.length; p++) {
        const vIdxStr = parts[p].split("/")[0];
        let vIdx = parseInt(vIdxStr, 10);
        if (vIdx < 0) {
          // negative indices are relative to the current end of the vertex list
          vIdx = vertices.length / 3 + vIdx + 1;
        }
        idx.push(vIdx - 1); // OBJ is 1-indexed
      }
      faces.push(idx);
    }
  }

  const result = { vertices: new Float32Array(vertices), faces };
  faceCache.set(url, result);
  return result;
}

function buildPerimeterLineSegments(parsed, color) {
  const { vertices, faces } = parsed;
  const positions = [];

  for (const face of faces) {
    const n = face.length;
    if (n < 2) continue;
    for (let i = 0; i < n; i++) {
      const a = face[i];
      const b = face[(i + 1) % n];
      positions.push(
        vertices[a * 3], vertices[a * 3 + 1], vertices[a * 3 + 2],
        vertices[b * 3], vertices[b * 3 + 1], vertices[b * 3 + 2]
      );
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  const mat = new THREE.LineBasicMaterial({ color });
  return new THREE.LineSegments(geo, mat);
}

// For an already-triangulated mesh (primal/dual layout files), the true
// patch borders are edges shared by exactly ONE triangle -- internal
// edges (the diagonals from triangulating each patch) are shared by two
// triangles and must NOT be drawn.
function buildBoundaryLineSegments(parsed, color) {
  const { vertices, faces } = parsed;
  const edgeCount = new Map(); // "a_b" (a<b) -> count

  for (const face of faces) {
    const n = face.length;
    for (let i = 0; i < n; i++) {
      const a = face[i];
      const b = face[(i + 1) % n];
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      edgeCount.set(key, (edgeCount.get(key) || 0) + 1);
    }
  }

  const positions = [];
  for (const [key, count] of edgeCount) {
    if (count !== 1) continue;
    const [aStr, bStr] = key.split("_");
    const a = parseInt(aStr, 10);
    const b = parseInt(bStr, 10);
    positions.push(
      vertices[a * 3], vertices[a * 3 + 1], vertices[a * 3 + 2],
      vertices[b * 3], vertices[b * 3 + 1], vertices[b * 3 + 2]
    );
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  const mat = new THREE.LineBasicMaterial({ color });
  return new THREE.LineSegments(geo, mat);
}

// ---- Mode "quad": flat-shaded triangulated solid + true quad-perimeter wireframe ----
async function buildQuadGroup(url) {
  const group = new THREE.Group();

  const loader = new OBJLoader();
  const raw = await loader.loadAsync(url);
  raw.traverse((child) => {
    if (child.isMesh && child.geometry) {
      const geo = child.geometry.clone();
      geo.computeVertexNormals();
      const solidMat = new THREE.MeshStandardMaterial({
        color: 0xe2e4e2,
        flatShading: true,
        roughness: 1.0,
        metalness: 0.0,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1,
      });
      group.add(new THREE.Mesh(geo, solidMat));
    }
  });

  const parsed = await parseOBJFaces(url);
  const perimeter = buildPerimeterLineSegments(parsed, 0x1c1c1a);
  group.add(perimeter);

  return group;
}

// ---- Mode "primal"/"dual": flat-shaded solid + true polygon-perimeter edges in black ----
async function buildLayoutGroup(url, solidColor) {
  const group = new THREE.Group();

  const loader = new OBJLoader();
  const raw = await loader.loadAsync(url);
  let hasMeshGeometry = false;

  raw.traverse((child) => {
    if (child.isMesh && child.geometry) {
      hasMeshGeometry = true;
      const geo = child.geometry.clone();
      geo.computeVertexNormals();
      const solidMat = new THREE.MeshStandardMaterial({
        color: solidColor,
        flatShading: true,
        roughness: 1.0,
        metalness: 0.0,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1,
      });
      group.add(new THREE.Mesh(geo, solidMat));
    }
  });

  const parsed = await parseOBJFaces(url);

  if (parsed.faces.length > 0) {
    // Patch borders = edges shared by exactly one triangle, drawn in black
    const boundary = buildBoundaryLineSegments(parsed, 0x000000);
    group.add(boundary);
  } else if (!hasMeshGeometry) {
    // File has no "f" lines at all -- it's pure edge data ("l" elements).
    raw.traverse((child) => {
      if (child.isLine || child.isLineSegments) {
        const mat = new THREE.LineBasicMaterial({ color: 0x000000 });
        group.add(new THREE.LineSegments(child.geometry, mat));
      }
    });
  }

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

  let group;
  if (mode === "quad") {
    group = await buildQuadGroup(url);
  } else if (mode === "primal") {
    group = await buildLayoutGroup(url, 0xd99b3a); // amber for primal patches (darkened for white bg)
  } else {
    group = await buildLayoutGroup(url, 0x4fa583); // green for dual patches (darkened for white bg)
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

  const requestId = ++latestRequestId;
  loadingOverlay.classList.add("visible");
  try {
    const group = await buildGroupForMode(currentMeshEntry, mode);
    if (!group) return;
    if (requestId !== latestRequestId) return; // a newer request superseded this one

    clearCurrent();
    currentGroup = group;
    currentMode = mode;
    scene.add(currentGroup);
    updateModeButtons();
    frameCameraOnObject(currentGroup);
  } catch (err) {
    console.error("Failed to switch mode", mode, err);
  } finally {
    if (requestId === latestRequestId) {
      loadingOverlay.classList.remove("visible");
    }
  }
}

export async function loadMesh(entry) {
  const requestId = ++latestRequestId;
  currentMeshEntry = entry;
  emptyViewport.style.display = "none";
  loadingOverlay.classList.add("visible");
  meshNameEl.textContent = entry.name;

  try {
    // Prefer quad as default view; fall back to primal, then dual.
    const preferredOrder = ["quad", "primal", "dual"];
    const firstAvailable = preferredOrder.find((m) => entry[MODE_FIELD[m]]);
    if (!firstAvailable) {
      console.warn("No viewable variant for entry", entry);
      return;
    }

    const group = await buildGroupForMode(entry, firstAvailable);

    // Discard this result if a newer load request has started in the meantime.
    if (requestId !== latestRequestId) return;

    clearCurrent();
    currentGroup = group;
    currentMode = firstAvailable;
    scene.add(currentGroup);
    updateModeButtons();
    frameCameraOnObject(currentGroup);
  } catch (err) {
    console.error("Failed to load mesh", entry, err);
  } finally {
    if (requestId === latestRequestId) {
      loadingOverlay.classList.remove("visible");
    }
  }
}

initThree();
