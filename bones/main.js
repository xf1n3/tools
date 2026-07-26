import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { parseBedrockGeometry } from './bedrock-parser.js';
import { splitGeometryByBones } from './mesh-splitter.js';
import { buildSingleObj, buildGroupObj } from './obj-exporter.js';

// ---------------------------------------------------------------------------
// Константы / состояние
// ---------------------------------------------------------------------------

const BONE_COLORS = [0xff6b6b, 0x4ecdc4, 0xa78bfa, 0xffd93d];

const state = {
  loadedJson: null,
  sourceName: 'model',
  formatVersion: 'unknown',
  mergedGeometry: null,
  modelObject: null,
  bones: [],
  selectedBoneIndex: -1,
  gizmoMode: 'translate',
  wireframe: false,
  splitResult: [],
  activeSheet: null, // 'bones' | 'meshes' | 'file' | null
};

// ---------------------------------------------------------------------------
// Сцена Three.js
// ---------------------------------------------------------------------------

const viewportWrap = document.getElementById('viewport-wrap');
const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(50, 1, 0.01, 5000);
camera.position.set(4, 3.2, 5);

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
viewportWrap.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.1;
controls.target.set(0, 0, 0);
// Тач-жесты: один палец — вращение, два пальца — зум+пан (стандартное поведение OrbitControls на touch)
controls.touches = {
  ONE: THREE.TOUCH.ROTATE,
  TWO: THREE.TOUCH.DOLLY_PAN,
};
controls.rotateSpeed = 0.85;
controls.panSpeed = 0.85;
controls.zoomSpeed = 0.9;

const hemi = new THREE.HemisphereLight(0xffffff, 0x2a2f3a, 1.1);
scene.add(hemi);
const keyLight = new THREE.DirectionalLight(0xffffff, 1.4);
keyLight.position.set(5, 8, 6);
scene.add(keyLight);
const fillLight = new THREE.DirectionalLight(0x89a5ff, 0.35);
fillLight.position.set(-6, 2, -4);
scene.add(fillLight);

const grid = new THREE.GridHelper(10, 20, 0x3a4150, 0x272b34);
scene.add(grid);
const axes = new THREE.AxesHelper(1.2);
scene.add(axes);

const modelGroup = new THREE.Group();
scene.add(modelGroup);

const bonesGroup = new THREE.Group();
scene.add(bonesGroup);

const transformControls = new TransformControls(camera, renderer.domElement);
transformControls.setMode('translate');
transformControls.setSize(1.15); // побольше, под палец
scene.add(transformControls.getHelper ? transformControls.getHelper() : transformControls);

transformControls.addEventListener('dragging-changed', (e) => {
  controls.enabled = !e.value;
});
transformControls.addEventListener('objectChange', () => {
  if (state.selectedBoneIndex >= 0) {
    syncBoneStateFromMesh(state.selectedBoneIndex);
    updateQuickReadout();
    if (state.activeSheet === 'bones') renderBonesSheetBody();
    scheduleRecompute();
  }
});

function resizeRenderer() {
  const w = viewportWrap.clientWidth;
  const h = viewportWrap.clientHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resizeRenderer);
window.addEventListener('orientationchange', () => setTimeout(resizeRenderer, 200));

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}

// ---------------------------------------------------------------------------
// Кости (кубы)
// ---------------------------------------------------------------------------

const DEFAULT_BONE_NAMES = ['bone_1', 'bone_2', 'bone_3', 'bone_4'];

function createDefaultBones() {
  bonesGroup.clear();
  state.bones = [];

  DEFAULT_BONE_NAMES.forEach((name, i) => {
    const size = [0.5, 0.5, 0.5];
    const angle = (i / 4) * Math.PI * 2;
    const center = [Math.cos(angle) * 1.2, 0.25, Math.sin(angle) * 1.2];

    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshBasicMaterial({
      color: BONE_COLORS[i],
      transparent: true,
      opacity: 0.3,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 10;

    const edges = new THREE.EdgesGeometry(geo);
    const line = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: BONE_COLORS[i] }));
    mesh.add(line);

    mesh.position.set(center[0], center[1], center[2]);
    mesh.scale.set(size[0], size[1], size[2]);
    mesh.rotation.set(0, 0, 0);
    mesh.userData.boneIndex = i;
    mesh.visible = false;

    bonesGroup.add(mesh);

    state.bones.push({
      name,
      enabled: true,
      mesh,
      size: size.slice(),
      center: center.slice(),
      rotation: [0, 0, 0], // Эйлеровы углы в радианах (порядок XYZ)
    });
  });
}

function fitBonesToModel(box) {
  const sizeVec = new THREE.Vector3();
  box.getSize(sizeVec);
  const centerVec = new THREE.Vector3();
  box.getCenter(centerVec);

  const cubeSize = Math.max(sizeVec.x, sizeVec.y, sizeVec.z) * 0.22 || 0.5;

  const offsets = [
    [-0.6, 0.6, 0],
    [0.6, 0.6, 0],
    [-0.6, -0.6, 0],
    [0.6, -0.6, 0],
  ];

  state.bones.forEach((bone, i) => {
    const [ox, oy, oz] = offsets[i];
    const cx = centerVec.x + ox * sizeVec.x * 0.5;
    const cy = centerVec.y + oy * sizeVec.y * 0.5;
    const cz = centerVec.z + oz * sizeVec.z * 0.5;

    bone.size = [cubeSize, cubeSize, cubeSize];
    bone.center = [cx, cy, cz];
    bone.rotation = [0, 0, 0];
    bone.mesh.position.set(cx, cy, cz);
    bone.mesh.scale.set(cubeSize, cubeSize, cubeSize);
    bone.mesh.rotation.set(0, 0, 0);
    bone.mesh.visible = true;
  });
}

function syncBoneStateFromMesh(index) {
  const bone = state.bones[index];
  bone.center = [bone.mesh.position.x, bone.mesh.position.y, bone.mesh.position.z];
  bone.size = [bone.mesh.scale.x, bone.mesh.scale.y, bone.mesh.scale.z];
  bone.rotation = [bone.mesh.rotation.x, bone.mesh.rotation.y, bone.mesh.rotation.z];
}

function applyBoneStateToMesh(index) {
  const bone = state.bones[index];
  bone.mesh.position.set(bone.center[0], bone.center[1], bone.center[2]);
  bone.mesh.scale.set(bone.size[0], bone.size[1], bone.size[2]);
  bone.mesh.rotation.set(bone.rotation[0], bone.rotation[1], bone.rotation[2]);
}

// Переиспользуемые временные объекты, чтобы не аллоцировать на каждый вызов
const _tmpEuler = new THREE.Euler();
const _tmpMat3 = new THREE.Matrix3();
const _tmpMat4 = new THREE.Matrix4();

/**
 * Возвращает описание ориентированного бокса (OBB) кости в формате,
 * который принимает splitGeometryByBones: центр, half-extents и инверсию
 * матрицы поворота (плоский 3x3, row-major).
 */
function boneOBB(bone) {
  const halfSize = [bone.size[0] / 2, bone.size[1] / 2, bone.size[2] / 2];

  _tmpEuler.set(bone.rotation[0], bone.rotation[1], bone.rotation[2], 'XYZ');
  _tmpMat4.makeRotationFromEuler(_tmpEuler);
  _tmpMat3.setFromMatrix4(_tmpMat4);
  // Инверсия матрицы поворота = транспонирование (т.к. матрица ортонормированная)
  _tmpMat3.transpose();

  const e = _tmpMat3.elements; // column-major в Three.js
  // Переупорядочиваем в row-major плоский массив для mesh-splitter.js
  const invRotation = [
    e[0], e[3], e[6],
    e[1], e[4], e[7],
    e[2], e[5], e[8],
  ];

  return { center: bone.center.slice(), halfSize, invRotation };
}

// ---------------------------------------------------------------------------
// Загрузка модели
// ---------------------------------------------------------------------------

const fileInput = document.getElementById('file-input');
const btnOpen = document.getElementById('btn-open');
const filenameLabel = document.getElementById('filename');
const dropHint = document.getElementById('drop-hint');
const statusToast = document.getElementById('status-toast');

btnOpen.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (file) loadFile(file);
  fileInput.value = '';
});

function setStatus(msg, isError = false) {
  statusToast.textContent = msg;
  statusToast.classList.toggle('error', isError);
  statusToast.classList.add('show');
  clearTimeout(setStatus._t);
  setStatus._t = setTimeout(() => statusToast.classList.remove('show'), 3200);
}

function loadFile(file) {
  if (!file.name.toLowerCase().endsWith('.json')) {
    setStatus('Нужен файл .json', true);
    return;
  }
  const reader = new FileReader();
  reader.onload = (ev) => {
    try {
      const json = JSON.parse(ev.target.result);
      importBedrockJson(json, file.name);
    } catch (err) {
      console.error(err);
      setStatus('Ошибка: ' + err.message, true);
    }
  };
  reader.onerror = () => setStatus('Не удалось прочитать файл', true);
  reader.readAsText(file);
}

function importBedrockJson(json, filename) {
  const parsed = parseBedrockGeometry(json);
  state.loadedJson = json;
  state.formatVersion = parsed.formatVersion;
  state.sourceName = parsed.sourceName;

  const positions = [];
  const normals = [];
  const uvs = [];
  for (const g of parsed.groups) {
    for (const v of g.positions) positions.push(v);
    for (const v of g.normals) normals.push(v);
    for (const v of g.uvs) uvs.push(v);
  }

  if (positions.length === 0) {
    setStatus('В файле не найдено геометрии', true);
    return;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));

  // Некоторые экспортеры (например Blockbench + Meshy) пишут в geometry всего одну
  // "заглушку"-нормаль на всю модель (обычно [0,1,0]). Такие нормали делают освещение
  // плоским и неправильным, поэтому проверяем разнообразие нормалей и, если оно
  // вырождено, просто пересчитываем нормали по геометрии сами.
  const uniqueNormals = new Set();
  for (let i = 0; i < normals.length; i += 3) {
    uniqueNormals.add(`${normals[i].toFixed(3)},${normals[i + 1].toFixed(3)},${normals[i + 2].toFixed(3)}`);
    if (uniqueNormals.size > 1) break;
  }
  if (uniqueNormals.size <= 1) {
    geometry.computeVertexNormals();
  } else {
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  }

  const SCALE = 1 / 16;
  geometry.scale(SCALE, SCALE, SCALE);
  geometry.computeBoundingBox();

  const box = geometry.boundingBox;
  const center = new THREE.Vector3();
  box.getCenter(center);
  geometry.translate(-center.x, -box.min.y, -center.z);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  modelGroup.clear();
  if (state.modelObject) {
    state.modelObject.geometry.dispose();
  }

  const material = new THREE.MeshStandardMaterial({
    color: 0x9aa3b2,
    roughness: 0.75,
    metalness: 0.05,
    side: THREE.DoubleSide,
    wireframe: state.wireframe,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'main';
  modelGroup.add(mesh);

  state.mergedGeometry = geometry;
  state.modelObject = mesh;

  createDefaultBones();
  fitBonesToModel(geometry.boundingBox);
  selectBone(0);

  frameCameraToBox(geometry.boundingBox);

  filenameLabel.textContent = filename;
  dropHint.classList.add('hidden');

  setStatus(`Загружено: ${positions.length / 9} треугольников`);

  updateFileSheetInfo();
  scheduleRecompute();
}

function frameCameraToBox(box) {
  const size = new THREE.Vector3();
  box.getSize(size);
  const center = new THREE.Vector3();
  box.getCenter(center);
  const maxDim = Math.max(size.x, size.y, size.z, 0.5);
  const dist = maxDim * 2.4;

  camera.position.set(center.x + dist * 0.6, center.y + dist * 0.5, center.z + dist * 0.8);
  controls.target.copy(center);
  controls.update();
}

// ---------------------------------------------------------------------------
// Bottom sheet infrastructure
// ---------------------------------------------------------------------------

const sheetEl = document.getElementById('sheet');
const sheetBackdrop = document.getElementById('sheet-backdrop');
const sheetTitle = document.getElementById('sheet-title');
const sheetBody = document.getElementById('sheet-body');
const sheetClose = document.getElementById('sheet-close');
const tabButtons = document.querySelectorAll('.tab-btn');

const SHEET_TITLES = { bones: 'Кости', meshes: 'Меши', file: 'Файл' };

function openSheet(name) {
  state.activeSheet = name;
  sheetTitle.textContent = SHEET_TITLES[name];
  sheetBody.innerHTML = '';

  if (name === 'bones') {
    const tpl = document.getElementById('tpl-bones-sheet').content.cloneNode(true);
    sheetBody.appendChild(tpl);
    renderBonesSheetBody();
  } else if (name === 'meshes') {
    const tpl = document.getElementById('tpl-meshes-sheet').content.cloneNode(true);
    sheetBody.appendChild(tpl);
    renderMeshList();
  } else if (name === 'file') {
    const tpl = document.getElementById('tpl-file-sheet').content.cloneNode(true);
    sheetBody.appendChild(tpl);
    wireFileSheet();
  }

  sheetEl.classList.add('open');
  sheetBackdrop.classList.add('show');
  tabButtons.forEach(b => b.classList.toggle('active', b.dataset.sheet === name));
}

function closeSheet() {
  sheetEl.classList.remove('open');
  sheetBackdrop.classList.remove('show');
  tabButtons.forEach(b => b.classList.remove('active'));
  state.activeSheet = null;
}

tabButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    const name = btn.dataset.sheet;
    if (state.activeSheet === name) {
      closeSheet();
    } else {
      openSheet(name);
    }
  });
});
sheetClose.addEventListener('click', closeSheet);
sheetBackdrop.addEventListener('click', closeSheet);

// Swipe-down-to-close on the handle/header
let dragStartY = null;
let dragCurrentY = 0;
function onSheetDragStart(y) { dragStartY = y; dragCurrentY = y; sheetEl.style.transition = 'none'; }
function onSheetDragMove(y) {
  if (dragStartY === null) return;
  dragCurrentY = y;
  const delta = Math.max(0, y - dragStartY);
  sheetEl.style.transform = `translateY(${delta}px)`;
}
function onSheetDragEnd() {
  if (dragStartY === null) return;
  const delta = dragCurrentY - dragStartY;
  sheetEl.style.transition = '';
  sheetEl.style.transform = '';
  if (delta > 90) closeSheet();
  dragStartY = null;
}
const sheetHandle = document.getElementById('sheet-handle');
sheetHandle.addEventListener('touchstart', (e) => onSheetDragStart(e.touches[0].clientY), { passive: true });
sheetHandle.addEventListener('touchmove', (e) => onSheetDragMove(e.touches[0].clientY), { passive: true });
sheetHandle.addEventListener('touchend', onSheetDragEnd);
sheetHandle.addEventListener('mousedown', (e) => {
  onSheetDragStart(e.clientY);
  const mm = (ev) => onSheetDragMove(ev.clientY);
  const mu = () => { onSheetDragEnd(); window.removeEventListener('mousemove', mm); window.removeEventListener('mouseup', mu); };
  window.addEventListener('mousemove', mm);
  window.addEventListener('mouseup', mu);
});

// ---------------------------------------------------------------------------
// Bones sheet content
// ---------------------------------------------------------------------------

function renderBonesSheetBody() {
  const bonesListEl = sheetBody.querySelector('#bones-list');
  if (!bonesListEl) return;
  bonesListEl.innerHTML = '';

  state.bones.forEach((bone, i) => {
    const card = document.createElement('div');
    card.className = 'bone-card' + (bone.enabled ? '' : ' disabled') + (i === state.selectedBoneIndex ? ' selected' : '');

    const color = '#' + BONE_COLORS[i].toString(16).padStart(6, '0');

    card.innerHTML = `
      <div class="bone-head">
        <div class="bone-swatch" style="background:${color}"></div>
        <input class="bone-name-input" value="${escapeHtml(bone.name)}" data-idx="${i}" data-role="name">
        <button class="bone-select-btn ${i === state.selectedBoneIndex ? 'active' : ''}" data-idx="${i}" data-role="select">${i === state.selectedBoneIndex ? 'выбрана' : 'выбрать'}</button>
        <div class="bone-toggle ${bone.enabled ? 'on' : ''}" data-idx="${i}" data-role="toggle"></div>
      </div>
      <div class="bone-section-label">Позиция (центр)</div>
      <div class="bone-grid">
        <div class="row-label"></div>
        <div class="axis-label">X</div><div class="axis-label">Y</div><div class="axis-label">Z</div>
        <div class="row-label">pos</div>
        <input class="bone-num" type="number" step="0.05" value="${fmt(bone.center[0])}" data-idx="${i}" data-role="pos" data-axis="0" inputmode="decimal">
        <input class="bone-num" type="number" step="0.05" value="${fmt(bone.center[1])}" data-idx="${i}" data-role="pos" data-axis="1" inputmode="decimal">
        <input class="bone-num" type="number" step="0.05" value="${fmt(bone.center[2])}" data-idx="${i}" data-role="pos" data-axis="2" inputmode="decimal">
      </div>
      <div class="bone-section-label">Размер</div>
      <div class="bone-grid">
        <div class="row-label"></div>
        <div class="axis-label">X</div><div class="axis-label">Y</div><div class="axis-label">Z</div>
        <div class="row-label">size</div>
        <input class="bone-num" type="number" step="0.05" min="0.01" value="${fmt(bone.size[0])}" data-idx="${i}" data-role="size" data-axis="0" inputmode="decimal">
        <input class="bone-num" type="number" step="0.05" min="0.01" value="${fmt(bone.size[1])}" data-idx="${i}" data-role="size" data-axis="1" inputmode="decimal">
        <input class="bone-num" type="number" step="0.05" min="0.01" value="${fmt(bone.size[2])}" data-idx="${i}" data-role="size" data-axis="2" inputmode="decimal">
      </div>
      <div class="bone-section-label">Поворот (°)</div>
      <div class="bone-grid">
        <div class="row-label"></div>
        <div class="axis-label">X</div><div class="axis-label">Y</div><div class="axis-label">Z</div>
        <div class="row-label">rot</div>
        <input class="bone-num" type="number" step="1" value="${fmt(radToDeg(bone.rotation[0]))}" data-idx="${i}" data-role="rot" data-axis="0" inputmode="decimal">
        <input class="bone-num" type="number" step="1" value="${fmt(radToDeg(bone.rotation[1]))}" data-idx="${i}" data-role="rot" data-axis="1" inputmode="decimal">
        <input class="bone-num" type="number" step="1" value="${fmt(radToDeg(bone.rotation[2]))}" data-idx="${i}" data-role="rot" data-axis="2" inputmode="decimal">
      </div>
      <div class="bone-stat">
        <span>треугольников</span>
        <span>${getTriCountForBone(bone.name)}</span>
      </div>
    `;

    if (i === state.selectedBoneIndex) card.style.borderColor = color;

    bonesListEl.appendChild(card);
  });

  bonesListEl.querySelectorAll('[data-role="select"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = Number(btn.dataset.idx);
      selectBone(idx);
      renderBonesSheetBody();
    });
  });

  bonesListEl.querySelectorAll('[data-role="name"]').forEach(input => {
    input.addEventListener('change', (e) => {
      const idx = Number(e.target.dataset.idx);
      state.bones[idx].name = e.target.value.trim() || `bone_${idx + 1}`;
      scheduleRecompute();
      updateQuickReadout();
    });
  });

  bonesListEl.querySelectorAll('[data-role="toggle"]').forEach(el => {
    el.addEventListener('click', (e) => {
      const idx = Number(e.target.dataset.idx);
      state.bones[idx].enabled = !state.bones[idx].enabled;
      state.bones[idx].mesh.visible = state.bones[idx].enabled;
      renderBonesSheetBody();
      scheduleRecompute();
    });
  });

  bonesListEl.querySelectorAll('[data-role="pos"]').forEach(input => {
    input.addEventListener('input', (e) => {
      const idx = Number(e.target.dataset.idx);
      const axis = Number(e.target.dataset.axis);
      const val = parseFloat(e.target.value);
      if (Number.isNaN(val)) return;
      state.bones[idx].center[axis] = val;
      applyBoneStateToMesh(idx);
      updateQuickReadout();
      scheduleRecompute();
    });
  });

  bonesListEl.querySelectorAll('[data-role="size"]').forEach(input => {
    input.addEventListener('input', (e) => {
      const idx = Number(e.target.dataset.idx);
      const axis = Number(e.target.dataset.axis);
      const val = Math.max(0.01, parseFloat(e.target.value));
      if (Number.isNaN(val)) return;
      state.bones[idx].size[axis] = val;
      applyBoneStateToMesh(idx);
      updateQuickReadout();
      scheduleRecompute();
    });
  });

  bonesListEl.querySelectorAll('[data-role="rot"]').forEach(input => {
    input.addEventListener('input', (e) => {
      const idx = Number(e.target.dataset.idx);
      const axis = Number(e.target.dataset.axis);
      const val = parseFloat(e.target.value);
      if (Number.isNaN(val)) return;
      state.bones[idx].rotation[axis] = degToRad(val);
      applyBoneStateToMesh(idx);
      updateQuickReadout();
      scheduleRecompute();
    });
  });
}

function selectBone(i) {
  state.selectedBoneIndex = i;
  const bone = state.bones[i];
  transformControls.attach(bone.mesh);
  updateQuickReadout();
  if (state.activeSheet === 'bones') renderBonesSheetBody();
}

function fmt(n) {
  return Math.round(n * 1000) / 1000;
}

function radToDeg(r) {
  return r * (180 / Math.PI);
}

function degToRad(d) {
  return d * (Math.PI / 180);
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------------------------------------------------------------------
// Quick readout (over the viewport, above tabbar) — always-visible mini control
// for the selected bone, so the user doesn't need to open the sheet every time.
// ---------------------------------------------------------------------------

const qrEl = document.getElementById('quick-readout');
const qrSwatch = document.getElementById('qr-swatch');
const qrName = document.getElementById('qr-name');
const qrCount = document.getElementById('qr-count');
const qrX = document.getElementById('qr-x');
const qrY = document.getElementById('qr-y');
const qrZ = document.getElementById('qr-z');

function updateQuickReadout() {
  if (state.selectedBoneIndex < 0 || !state.modelObject) {
    qrEl.classList.remove('show');
    return;
  }
  const bone = state.bones[state.selectedBoneIndex];
  qrEl.classList.add('show');
  qrSwatch.style.background = '#' + BONE_COLORS[state.selectedBoneIndex].toString(16).padStart(6, '0');
  qrName.textContent = bone.name;
  qrCount.textContent = `${getTriCountForBone(bone.name)} tri`;

  const mode = state.gizmoMode;
  let vals;
  if (mode === 'translate') vals = bone.center;
  else if (mode === 'scale') vals = bone.size;
  else vals = bone.rotation.map(radToDeg);

  qrX.value = fmt(vals[0]);
  qrY.value = fmt(vals[1]);
  qrZ.value = fmt(vals[2]);
}

[qrX, qrY, qrZ].forEach((input, axis) => {
  input.addEventListener('input', () => {
    if (state.selectedBoneIndex < 0) return;
    const val = parseFloat(input.value);
    if (Number.isNaN(val)) return;
    const bone = state.bones[state.selectedBoneIndex];
    if (state.gizmoMode === 'translate') {
      bone.center[axis] = val;
    } else if (state.gizmoMode === 'scale') {
      bone.size[axis] = Math.max(0.01, val);
    } else {
      bone.rotation[axis] = degToRad(val);
    }
    applyBoneStateToMesh(state.selectedBoneIndex);
    if (state.activeSheet === 'bones') renderBonesSheetBody();
    scheduleRecompute();
  });
});

// ---------------------------------------------------------------------------
// Recompute split (drives mesh counts everywhere)
// ---------------------------------------------------------------------------

let recomputeTimer = null;
function scheduleRecompute() {
  clearTimeout(recomputeTimer);
  recomputeTimer = setTimeout(recompute, 60);
}

function recompute() {
  if (!state.mergedGeometry) return;

  const geom = state.mergedGeometry;
  const posAttr = geom.getAttribute('position');
  const normAttr = geom.getAttribute('normal');
  const uvAttr = geom.getAttribute('uv');

  const flat = {
    positions: Array.from(posAttr.array),
    normals: Array.from(normAttr.array),
    uvs: Array.from(uvAttr.array),
  };

  const boneDefs = state.bones
    .filter(b => b.enabled)
    .map(b => {
      const { center, halfSize, invRotation } = boneOBB(b);
      return { name: b.name, enabled: true, center, halfSize, invRotation };
    });

  state.splitResult = splitGeometryByBones(flat, boneDefs);

  if (state.activeSheet === 'meshes') renderMeshList();
  if (state.activeSheet === 'bones') {
    // обновим только счётчики, не перерисовывая весь список (чтобы не терять фокус ввода)
    state.bones.forEach((bone, i) => {
      const stat = sheetBody.querySelectorAll('.bone-stat span:last-child')[i];
      if (stat) stat.textContent = getTriCountForBone(bone.name);
    });
  }
  updateQuickReadout();
}

function getTriCountForBone(name) {
  const found = state.splitResult.find(g => g.name === name);
  return found ? found.triCount : 0;
}

// ---------------------------------------------------------------------------
// Meshes sheet content
// ---------------------------------------------------------------------------

function renderMeshList() {
  const meshListEl = sheetBody.querySelector('#mesh-list');
  if (!meshListEl) return;
  meshListEl.innerHTML = '';

  if (!state.splitResult.length) {
    meshListEl.innerHTML = '<div class="hint-block">Загрузите модель, чтобы увидеть разбиение на меши.</div>';
    return;
  }

  const colorFor = (name) => {
    const idx = state.bones.findIndex(b => b.name === name);
    if (idx === -1) return '#6b7280';
    return '#' + BONE_COLORS[idx].toString(16).padStart(6, '0');
  };

  for (const g of state.splitResult) {
    if (g.triCount === 0 && g.name !== 'main') continue;
    const row = document.createElement('div');
    row.className = 'mesh-row';
    const swatchColor = g.name === 'main' ? '#6b7280' : colorFor(g.name);
    row.innerHTML = `
      <div class="swatch" style="background:${swatchColor}"></div>
      <div class="mname">${escapeHtml(g.name)}</div>
      <div class="mcount">${g.triCount} tri</div>
    `;
    meshListEl.appendChild(row);
  }
}

// ---------------------------------------------------------------------------
// File sheet content
// ---------------------------------------------------------------------------

function wireFileSheet() {
  const faOpen = sheetBody.querySelector('#fa-open');
  const faExport = sheetBody.querySelector('#fa-export');
  faOpen.addEventListener('click', () => fileInput.click());
  faExport.addEventListener('click', doExport);
  updateFileSheetInfo();
}

function updateFileSheetInfo() {
  const infoBlock = sheetBody.querySelector('#file-info-block');
  if (!infoBlock) return;
  if (!state.mergedGeometry) {
    infoBlock.textContent = 'Модель ещё не загружена.';
    return;
  }
  const tris = state.mergedGeometry.getAttribute('position').count / 3;
  infoBlock.innerHTML = `Источник: <b>${escapeHtml(state.sourceName)}</b><br>Формат: ${escapeHtml(state.formatVersion)}<br>Треугольников всего: ${tris}`;
}

// ---------------------------------------------------------------------------
// Viewport toolbars
// ---------------------------------------------------------------------------

document.getElementById('vbtn-solid').addEventListener('click', () => setWireframe(false));
document.getElementById('vbtn-wire').addEventListener('click', () => setWireframe(true));
document.getElementById('vbtn-grid').addEventListener('click', (e) => {
  grid.visible = !grid.visible;
  e.currentTarget.classList.toggle('active', grid.visible);
});

function setWireframe(on) {
  state.wireframe = on;
  if (state.modelObject) state.modelObject.material.wireframe = on;
  document.getElementById('vbtn-solid').classList.toggle('active', !on);
  document.getElementById('vbtn-wire').classList.toggle('active', on);
}

document.getElementById('vbtn-move').addEventListener('click', () => setGizmoMode('translate'));
document.getElementById('vbtn-scale').addEventListener('click', () => setGizmoMode('scale'));
document.getElementById('vbtn-rotate').addEventListener('click', () => setGizmoMode('rotate'));

function setGizmoMode(mode) {
  state.gizmoMode = mode;
  transformControls.setMode(mode);
  document.getElementById('vbtn-move').classList.toggle('active', mode === 'translate');
  document.getElementById('vbtn-scale').classList.toggle('active', mode === 'scale');
  document.getElementById('vbtn-rotate').classList.toggle('active', mode === 'rotate');
  updateQuickReadout();
}

// Двойной тап по кубу кости в 3D — выбрать её
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let lastTapTime = 0;
let lastTapPos = null;

function tryPickBone(clientX, clientY) {
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObjects(bonesGroup.children, false);
  if (hits.length > 0) {
    const idx = hits[0].object.userData.boneIndex;
    if (idx !== undefined) selectBone(idx);
  }
}

renderer.domElement.addEventListener('dblclick', (e) => tryPickBone(e.clientX, e.clientY));

renderer.domElement.addEventListener('touchend', (e) => {
  if (e.changedTouches.length !== 1) return;
  const t = e.changedTouches[0];
  const now = Date.now();
  const pos = { x: t.clientX, y: t.clientY };
  if (
    now - lastTapTime < 320 &&
    lastTapPos &&
    Math.abs(pos.x - lastTapPos.x) < 24 &&
    Math.abs(pos.y - lastTapPos.y) < 24
  ) {
    tryPickBone(pos.x, pos.y);
    lastTapTime = 0;
    lastTapPos = null;
  } else {
    lastTapTime = now;
    lastTapPos = pos;
  }
});

// ---------------------------------------------------------------------------
// Drag & drop (для десктопных браузеров в Codespaces, если открыто не с телефона)
// ---------------------------------------------------------------------------

viewportWrap.addEventListener('dragover', (e) => e.preventDefault());
viewportWrap.addEventListener('drop', (e) => {
  e.preventDefault();
  const file = e.dataTransfer.files[0];
  if (file) loadFile(file);
});

// ---------------------------------------------------------------------------
// Экспорт
// ---------------------------------------------------------------------------

async function doExport() {
  if (!state.mergedGeometry) {
    setStatus('Сначала загрузите модель', true);
    return;
  }
  recompute();

  const groups = state.splitResult.filter(g => g.triCount > 0);
  if (groups.length === 0) {
    setStatus('Нет геометрии для экспорта', true);
    return;
  }

  const formatSelect = sheetBody.querySelector('#export-format');
  const format = formatSelect ? formatSelect.value : 'single';
  const baseName = sanitizeFileBase(state.sourceName || 'model');

  if (format === 'single') {
    const text = buildSingleObj(groups);
    downloadBlob(new Blob([text], { type: 'text/plain' }), `${baseName}.obj`);
    setStatus('Экспортирован один .obj с группами');
    return;
  }

  const zip = new JSZip();
  for (const g of groups) {
    const text = buildGroupObj(g);
    zip.file(`${sanitizeFileBase(g.name)}.obj`, text);
  }
  const blob = await zip.generateAsync({ type: 'blob' });
  downloadBlob(blob, `${baseName}_split.zip`);
  setStatus(`Экспортировано ${groups.length} мешей в ZIP`);
}

function sanitizeFileBase(s) {
  return String(s).replace(/[^a-zA-Z0-9_\-]/g, '_') || 'mesh';
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// ---------------------------------------------------------------------------
// Инициализация
// ---------------------------------------------------------------------------

createDefaultBones();
resizeRenderer();
animate();
