import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { parseBedrockGeometry } from './bedrock-parser.js';
import { splitGeometryByBones } from './mesh-splitter.js';
import { buildSingleObj, buildGroupObj } from './obj-exporter.js';

// ---------------------------------------------------------------------------
// Модель данных костей: "кость" = { name, enabled, color, boxes: [box, ...] }
// Пользователь может создавать сколько угодно костей и добавлять несколько
// кубов в одну кость (объединение) — тогда вся геометрия внутри любого из
// этих кубов уходит в один общий mesh при экспорте.
// box = { mesh (THREE.Mesh), center, size, rotation }
// ---------------------------------------------------------------------------

const BONE_PALETTE = [0xff6b6b, 0x4ecdc4, 0xa78bfa, 0xffd93d, 0x6bcb77, 0xff9f43, 0x54a0ff, 0xee5a9e];

const state = {
  loadedJson: null,
  sourceName: 'model',
  formatVersion: 'unknown',
  mergedGeometry: null,
  modelObject: null,
  bones: [],
  selectedBoneIndex: -1,
  selectedBoxIndex: -1,
  gizmoMode: 'translate',
  wireframe: false,
  splitResult: [],
  activeSheet: null,
  isDraggingGizmo: false,
  nextBoneNumber: 1,
  mergeSourceIndex: -1,
};

function colorForBoneIndex(i) {
  return BONE_PALETTE[i % BONE_PALETTE.length];
}

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
transformControls.setSize(0.85);
scene.add(transformControls.getHelper ? transformControls.getHelper() : transformControls);

transformControls.addEventListener('dragging-changed', (e) => {
  controls.enabled = !e.value;
  state.isDraggingGizmo = e.value;
  if (!e.value) {
    if (state.activeSheet === 'bones') renderBonesSheetBody();
    recompute();
  }
});

let objectChangeRAF = null;
transformControls.addEventListener('objectChange', () => {
  if (state.selectedBoneIndex < 0 || state.selectedBoxIndex < 0) return;
  syncBoxStateFromMesh(state.selectedBoneIndex, state.selectedBoxIndex);
  updateQuickReadout();
  if (objectChangeRAF) cancelAnimationFrame(objectChangeRAF);
  objectChangeRAF = requestAnimationFrame(() => {
    objectChangeRAF = null;
    recompute();
  });
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
// Кости и боксы
// ---------------------------------------------------------------------------

function makeBoxMesh(color) {
  const geo = new THREE.BoxGeometry(1, 1, 1);
  const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.3, depthWrite: false });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = 10;
  const edges = new THREE.EdgesGeometry(geo);
  const line = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color }));
  mesh.add(line);
  return mesh;
}

function addBone(center, size, name) {
  const idx = state.bones.length;
  const color = colorForBoneIndex(idx);
  const boneName = name || `bone_${state.nextBoneNumber++}`;

  const mesh = makeBoxMesh(color);
  mesh.position.set(center[0], center[1], center[2]);
  mesh.scale.set(size[0], size[1], size[2]);
  mesh.rotation.set(0, 0, 0);
  mesh.userData.boneIndex = idx;
  mesh.userData.boxIndex = 0;
  bonesGroup.add(mesh);

  const box = { mesh, center: center.slice(), size: size.slice(), rotation: [0, 0, 0] };
  state.bones.push({ name: boneName, enabled: true, color, boxes: [box] });
  return idx;
}

function addBoxToBone(boneIndex, center, size) {
  const bone = state.bones[boneIndex];
  const mesh = makeBoxMesh(bone.color);
  mesh.position.set(center[0], center[1], center[2]);
  mesh.scale.set(size[0], size[1], size[2]);
  mesh.rotation.set(0, 0, 0);
  mesh.userData.boneIndex = boneIndex;
  mesh.userData.boxIndex = bone.boxes.length;
  bonesGroup.add(mesh);
  bone.boxes.push({ mesh, center: center.slice(), size: size.slice(), rotation: [0, 0, 0] });
  return bone.boxes.length - 1;
}

function reindexBoxUserData() {
  state.bones.forEach((b, i) => {
    b.boxes.forEach((box, j) => {
      box.mesh.userData.boneIndex = i;
      box.mesh.userData.boxIndex = j;
    });
  });
}

function removeBone(boneIndex) {
  const bone = state.bones[boneIndex];
  for (const box of bone.boxes) {
    bonesGroup.remove(box.mesh);
    box.mesh.geometry.dispose();
    box.mesh.material.dispose();
  }
  state.bones.splice(boneIndex, 1);
  reindexBoxUserData();

  if (state.selectedBoneIndex === boneIndex) {
    state.selectedBoneIndex = -1;
    state.selectedBoxIndex = -1;
    transformControls.detach();
  } else if (state.selectedBoneIndex > boneIndex) {
    state.selectedBoneIndex--;
  }
}

function removeBox(boneIndex, boxIndex) {
  const bone = state.bones[boneIndex];
  if (bone.boxes.length <= 1) {
    removeBone(boneIndex);
    return;
  }
  const box = bone.boxes[boxIndex];
  bonesGroup.remove(box.mesh);
  box.mesh.geometry.dispose();
  box.mesh.material.dispose();
  bone.boxes.splice(boxIndex, 1);
  reindexBoxUserData();

  if (state.selectedBoneIndex === boneIndex) {
    if (state.selectedBoxIndex === boxIndex) {
      state.selectedBoxIndex = 0;
      transformControls.attach(bone.boxes[0].mesh);
    } else if (state.selectedBoxIndex > boxIndex) {
      state.selectedBoxIndex--;
    }
  }
}

function mergeBoneInto(sourceIndex, targetIndex) {
  if (sourceIndex === targetIndex) return;
  const source = state.bones[sourceIndex];
  const target = state.bones[targetIndex];

  for (const box of source.boxes) {
    box.mesh.material.color.setHex(target.color);
    box.mesh.children.forEach(child => {
      if (child.material && child.material.color) child.material.color.setHex(target.color);
    });
    target.boxes.push(box);
  }

  state.bones.splice(sourceIndex, 1);
  reindexBoxUserData();

  state.selectedBoneIndex = state.bones.indexOf(target);
  state.selectedBoxIndex = 0;
  transformControls.attach(target.boxes[0].mesh);
}

function createDefaultBones() {
  for (const bone of state.bones) {
    for (const box of bone.boxes) {
      bonesGroup.remove(box.mesh);
      box.mesh.geometry.dispose();
      box.mesh.material.dispose();
    }
  }
  state.bones = [];
  state.nextBoneNumber = 1;
  state.selectedBoneIndex = -1;
  state.selectedBoxIndex = -1;

  const DEFAULT_COUNT = 4;
  for (let i = 0; i < DEFAULT_COUNT; i++) {
    const size = [0.5, 0.5, 0.5];
    const angle = (i / DEFAULT_COUNT) * Math.PI * 2;
    const center = [Math.cos(angle) * 1.2, 0.25, Math.sin(angle) * 1.2];
    addBone(center, size);
    state.bones[i].boxes[0].mesh.visible = false;
  }
}

function fitBonesToModel(box3) {
  const sizeVec = new THREE.Vector3();
  box3.getSize(sizeVec);
  const centerVec = new THREE.Vector3();
  box3.getCenter(centerVec);

  const cubeSize = Math.max(sizeVec.x, sizeVec.y, sizeVec.z) * 0.32 || 0.5;

  const offsets = [
    [-0.5, 0.55, 0],
    [0.5, 0.55, 0],
    [-0.5, -0.55, 0],
    [0.5, -0.55, 0],
  ];

  state.bones.forEach((bone, i) => {
    const offset = offsets[i % offsets.length];
    const [ox, oy, oz] = offset;
    const cx = centerVec.x + ox * sizeVec.x * 0.5;
    const cy = centerVec.y + oy * sizeVec.y * 0.5;
    const cz = centerVec.z + oz * sizeVec.z * 0.5;

    const box = bone.boxes[0];
    box.size = [cubeSize, cubeSize, cubeSize];
    box.center = [cx, cy, cz];
    box.rotation = [0, 0, 0];
    box.mesh.position.set(cx, cy, cz);
    box.mesh.scale.set(cubeSize, cubeSize, cubeSize);
    box.mesh.rotation.set(0, 0, 0);
    box.mesh.visible = true;
  });
}

function syncBoxStateFromMesh(boneIndex, boxIndex) {
  const box = state.bones[boneIndex].boxes[boxIndex];
  box.center = [box.mesh.position.x, box.mesh.position.y, box.mesh.position.z];
  box.size = [box.mesh.scale.x, box.mesh.scale.y, box.mesh.scale.z];
  box.rotation = [box.mesh.rotation.x, box.mesh.rotation.y, box.mesh.rotation.z];
}

function applyBoxStateToMesh(boneIndex, boxIndex) {
  const box = state.bones[boneIndex].boxes[boxIndex];
  box.mesh.position.set(box.center[0], box.center[1], box.center[2]);
  box.mesh.scale.set(box.size[0], box.size[1], box.size[2]);
  box.mesh.rotation.set(box.rotation[0], box.rotation[1], box.rotation[2]);
}

const _tmpEuler = new THREE.Euler();
const _tmpMat3 = new THREE.Matrix3();
const _tmpMat4 = new THREE.Matrix4();

function boxOBB(box) {
  const halfSize = [box.size[0] / 2, box.size[1] / 2, box.size[2] / 2];
  _tmpEuler.set(box.rotation[0], box.rotation[1], box.rotation[2], 'XYZ');
  _tmpMat4.makeRotationFromEuler(_tmpEuler);
  _tmpMat3.setFromMatrix4(_tmpMat4);
  _tmpMat3.transpose();
  const e = _tmpMat3.elements;
  const invRotation = [e[0], e[3], e[6], e[1], e[4], e[7], e[2], e[5], e[8]];
  return { center: box.center.slice(), halfSize, invRotation };
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
  selectBox(0, 0);

  frameCameraToBox(geometry.boundingBox);

  filenameLabel.textContent = filename;
  dropHint.classList.add('hidden');

  setStatus(`Загружено: ${positions.length / 9} треугольников`);

  updateFileSheetInfo();
  scheduleRecompute();
}

function frameCameraToBox(box3) {
  const size = new THREE.Vector3();
  box3.getSize(size);
  const center = new THREE.Vector3();
  box3.getCenter(center);
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
    if (state.activeSheet === name) closeSheet();
    else openSheet(name);
  });
});
sheetClose.addEventListener('click', closeSheet);
sheetBackdrop.addEventListener('click', closeSheet);

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
    const isSelectedBone = i === state.selectedBoneIndex;
    card.className = 'bone-card' + (bone.enabled ? '' : ' disabled') + (isSelectedBone ? ' selected' : '');

    const color = '#' + bone.color.toString(16).padStart(6, '0');

    const boxesHtml = bone.boxes.map((box, j) => {
      const isSelectedBox = isSelectedBone && j === state.selectedBoxIndex;
      return `
        <div class="box-row ${isSelectedBox ? 'active' : ''}" data-idx="${i}" data-box="${j}" data-role="select-box">
          <span class="box-label">куб ${j + 1}</span>
          <button class="box-remove-btn" data-idx="${i}" data-box="${j}" data-role="remove-box" title="Удалить этот куб">✕</button>
        </div>
      `;
    }).join('');

    card.innerHTML = `
      <div class="bone-head">
        <div class="bone-swatch" style="background:${color}"></div>
        <input class="bone-name-input" value="${escapeHtml(bone.name)}" data-idx="${i}" data-role="name">
        <div class="bone-toggle ${bone.enabled ? 'on' : ''}" data-idx="${i}" data-role="toggle"></div>
      </div>
      <div class="bone-boxes-list">${boxesHtml}</div>
      <div class="bone-actions-row">
        <button class="bone-mini-btn" data-idx="${i}" data-role="add-box">+ куб к этой кости</button>
        <button class="bone-mini-btn danger" data-idx="${i}" data-role="delete-bone">Удалить кость</button>
      </div>
      ${renderBoxEditorIfSelected(bone, i)}
      <div class="bone-stat">
        <span>треугольников</span>
        <span>${getTriCountForBone(bone.name)}</span>
      </div>
    `;

    if (isSelectedBone) card.style.borderColor = color;
    bonesListEl.appendChild(card);
  });

  wireBonesSheetEvents(bonesListEl);
}

function renderBoxEditorIfSelected(bone, boneIndex) {
  if (boneIndex !== state.selectedBoneIndex || state.selectedBoxIndex < 0) return '';
  const box = bone.boxes[state.selectedBoxIndex];
  if (!box) return '';

  return `
    <div class="box-editor">
      <div class="bone-section-label">Позиция (центр) — куб ${state.selectedBoxIndex + 1}</div>
      <div class="bone-grid">
        <div class="row-label"></div>
        <div class="axis-label">X</div><div class="axis-label">Y</div><div class="axis-label">Z</div>
        <div class="row-label">pos</div>
        <input class="bone-num" type="number" step="0.05" value="${fmt(box.center[0])}" data-role="pos" data-axis="0" inputmode="decimal">
        <input class="bone-num" type="number" step="0.05" value="${fmt(box.center[1])}" data-role="pos" data-axis="1" inputmode="decimal">
        <input class="bone-num" type="number" step="0.05" value="${fmt(box.center[2])}" data-role="pos" data-axis="2" inputmode="decimal">
      </div>
      <div class="bone-section-label">Размер</div>
      <div class="bone-grid">
        <div class="row-label"></div>
        <div class="axis-label">X</div><div class="axis-label">Y</div><div class="axis-label">Z</div>
        <div class="row-label">size</div>
        <input class="bone-num" type="number" step="0.05" min="0.01" value="${fmt(box.size[0])}" data-role="size" data-axis="0" inputmode="decimal">
        <input class="bone-num" type="number" step="0.05" min="0.01" value="${fmt(box.size[1])}" data-role="size" data-axis="1" inputmode="decimal">
        <input class="bone-num" type="number" step="0.05" min="0.01" value="${fmt(box.size[2])}" data-role="size" data-axis="2" inputmode="decimal">
      </div>
      <div class="bone-section-label">Поворот (°)</div>
      <div class="bone-grid">
        <div class="row-label"></div>
        <div class="axis-label">X</div><div class="axis-label">Y</div><div class="axis-label">Z</div>
        <div class="row-label">rot</div>
        <input class="bone-num" type="number" step="1" value="${fmt(radToDeg(box.rotation[0]))}" data-role="rot" data-axis="0" inputmode="decimal">
        <input class="bone-num" type="number" step="1" value="${fmt(radToDeg(box.rotation[1]))}" data-role="rot" data-axis="1" inputmode="decimal">
        <input class="bone-num" type="number" step="1" value="${fmt(radToDeg(box.rotation[2]))}" data-role="rot" data-axis="2" inputmode="decimal">
      </div>
    </div>
  `;
}

function wireBonesSheetEvents(bonesListEl) {
  bonesListEl.querySelectorAll('[data-role="select-box"]').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.dataset.role === 'remove-box') return;
      const idx = Number(el.dataset.idx);
      const boxIdx = Number(el.dataset.box);
      selectBox(idx, boxIdx);
      renderBonesSheetBody();
    });
  });

  bonesListEl.querySelectorAll('[data-role="remove-box"]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = Number(btn.dataset.idx);
      const boxIdx = Number(btn.dataset.box);
      removeBox(idx, boxIdx);
      renderBonesSheetBody();
      scheduleRecompute();
    });
  });

  bonesListEl.querySelectorAll('[data-role="add-box"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = Number(btn.dataset.idx);
      const bone = state.bones[idx];
      const lastBox = bone.boxes[bone.boxes.length - 1];
      const newCenter = [lastBox.center[0] + lastBox.size[0] * 0.8, lastBox.center[1], lastBox.center[2]];
      const newBoxIdx = addBoxToBone(idx, newCenter, lastBox.size.slice());
      selectBox(idx, newBoxIdx);
      renderBonesSheetBody();
      scheduleRecompute();
    });
  });

  bonesListEl.querySelectorAll('[data-role="delete-bone"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = Number(btn.dataset.idx);
      removeBone(idx);
      renderBonesSheetBody();
      scheduleRecompute();
    });
  });

  bonesListEl.querySelectorAll('[data-role="name"]').forEach(input => {
    input.addEventListener('change', (e) => {
      const idx = Number(e.target.dataset.idx);
      state.bones[idx].name = e.target.value.trim() || `bone_${idx + 1}`;
      scheduleRecompute();
      updateQuickReadout();
    });
    input.addEventListener('click', (e) => e.stopPropagation());
  });

  bonesListEl.querySelectorAll('[data-role="toggle"]').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = Number(e.target.dataset.idx);
      const bone = state.bones[idx];
      bone.enabled = !bone.enabled;
      bone.boxes.forEach(box => { box.mesh.visible = bone.enabled; });
      renderBonesSheetBody();
      scheduleRecompute();
    });
  });

  bonesListEl.querySelectorAll('[data-role="pos"]').forEach(input => {
    input.addEventListener('click', (e) => e.stopPropagation());
    input.addEventListener('input', (e) => {
      const axis = Number(e.target.dataset.axis);
      const val = parseFloat(e.target.value);
      if (Number.isNaN(val) || state.selectedBoneIndex < 0) return;
      const box = state.bones[state.selectedBoneIndex].boxes[state.selectedBoxIndex];
      box.center[axis] = val;
      applyBoxStateToMesh(state.selectedBoneIndex, state.selectedBoxIndex);
      updateQuickReadout();
      scheduleRecompute();
    });
  });

  bonesListEl.querySelectorAll('[data-role="size"]').forEach(input => {
    input.addEventListener('click', (e) => e.stopPropagation());
    input.addEventListener('input', (e) => {
      const axis = Number(e.target.dataset.axis);
      const val = Math.max(0.01, parseFloat(e.target.value));
      if (Number.isNaN(val) || state.selectedBoneIndex < 0) return;
      const box = state.bones[state.selectedBoneIndex].boxes[state.selectedBoxIndex];
      box.size[axis] = val;
      applyBoxStateToMesh(state.selectedBoneIndex, state.selectedBoxIndex);
      updateQuickReadout();
      scheduleRecompute();
    });
  });

  bonesListEl.querySelectorAll('[data-role="rot"]').forEach(input => {
    input.addEventListener('click', (e) => e.stopPropagation());
    input.addEventListener('input', (e) => {
      const axis = Number(e.target.dataset.axis);
      const val = parseFloat(e.target.value);
      if (Number.isNaN(val) || state.selectedBoneIndex < 0) return;
      const box = state.bones[state.selectedBoneIndex].boxes[state.selectedBoxIndex];
      box.rotation[axis] = degToRad(val);
      applyBoxStateToMesh(state.selectedBoneIndex, state.selectedBoxIndex);
      updateQuickReadout();
      scheduleRecompute();
    });
  });
}

function selectBox(boneIndex, boxIndex) {
  state.selectedBoneIndex = boneIndex;
  state.selectedBoxIndex = boxIndex;
  const box = state.bones[boneIndex]?.boxes[boxIndex];
  if (box) transformControls.attach(box.mesh);
  updateQuickReadout();
}

function fmt(n) { return Math.round(n * 1000) / 1000; }
function radToDeg(r) { return r * (180 / Math.PI); }
function degToRad(d) { return d * (Math.PI / 180); }
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------------------------------------------------------------------
// Добавление новой кости и объединение костей
// ---------------------------------------------------------------------------

function addNewBoneNearModel() {
  let center = [0, 0.5, 0];
  let size = [0.5, 0.5, 0.5];
  if (state.mergedGeometry) {
    const box3 = state.mergedGeometry.boundingBox;
    const c = new THREE.Vector3();
    box3.getCenter(c);
    const s = new THREE.Vector3();
    box3.getSize(s);
    const cubeSize = Math.max(s.x, s.y, s.z) * 0.28 || 0.5;
    const n = state.bones.length;
    const angle = n * 0.8;
    center = [c.x + Math.cos(angle) * cubeSize, c.y, c.z + Math.sin(angle) * cubeSize];
    size = [cubeSize, cubeSize, cubeSize];
  }
  const idx = addBone(center, size);
  selectBox(idx, 0);
  if (state.activeSheet === 'bones') renderBonesSheetBody();
  scheduleRecompute();
}

function openMergeDialog() {
  if (state.bones.length < 2) {
    setStatus('Нужно хотя бы 2 кости, чтобы объединить', true);
    return;
  }
  if (state.selectedBoneIndex < 0) {
    setStatus('Сначала выберите кость для объединения', true);
    return;
  }
  state.mergeSourceIndex = state.selectedBoneIndex;
  renderMergeSheet();
}

function renderMergeSheet() {
  sheetTitle.textContent = 'Объединить с...';
  sheetBody.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'hint-block';
  wrap.textContent = `Выберите кость, к которой присоединить «${state.bones[state.mergeSourceIndex].name}»:`;
  sheetBody.appendChild(wrap);

  state.bones.forEach((bone, i) => {
    if (i === state.mergeSourceIndex) return;
    const row = document.createElement('div');
    row.className = 'mesh-row';
    row.style.cursor = 'pointer';
    const color = '#' + bone.color.toString(16).padStart(6, '0');
    row.innerHTML = `
      <div class="swatch" style="background:${color}"></div>
      <div class="mname">${escapeHtml(bone.name)}</div>
      <div class="mcount">${bone.boxes.length} куб(ов)</div>
    `;
    row.addEventListener('click', () => {
      mergeBoneInto(state.mergeSourceIndex, i);
      openSheet('bones');
      scheduleRecompute();
      setStatus('Кости объединены');
    });
    sheetBody.appendChild(row);
  });

  sheetEl.classList.add('open');
  sheetBackdrop.classList.add('show');
}

// ---------------------------------------------------------------------------
// Quick readout
// ---------------------------------------------------------------------------

const qrEl = document.getElementById('quick-readout');
const qrSwatch = document.getElementById('qr-swatch');
const qrName = document.getElementById('qr-name');
const qrCount = document.getElementById('qr-count');
const qrX = document.getElementById('qr-x');
const qrY = document.getElementById('qr-y');
const qrZ = document.getElementById('qr-z');

function updateQuickReadout() {
  if (state.selectedBoneIndex < 0 || state.selectedBoxIndex < 0 || !state.modelObject) {
    qrEl.classList.remove('show');
    return;
  }
  const bone = state.bones[state.selectedBoneIndex];
  const box = bone.boxes[state.selectedBoxIndex];
  if (!box) {
    qrEl.classList.remove('show');
    return;
  }
  qrEl.classList.add('show');
  qrSwatch.style.background = '#' + bone.color.toString(16).padStart(6, '0');
  qrName.textContent = bone.boxes.length > 1 ? `${bone.name} (куб ${state.selectedBoxIndex + 1})` : bone.name;
  qrCount.textContent = `${getTriCountForBone(bone.name)} tri`;

  const mode = state.gizmoMode;
  let vals;
  if (mode === 'translate') vals = box.center;
  else if (mode === 'scale') vals = box.size;
  else vals = box.rotation.map(radToDeg);

  qrX.value = fmt(vals[0]);
  qrY.value = fmt(vals[1]);
  qrZ.value = fmt(vals[2]);
}

[qrX, qrY, qrZ].forEach((input, axis) => {
  input.addEventListener('input', () => {
    if (state.selectedBoneIndex < 0 || state.selectedBoxIndex < 0) return;
    const val = parseFloat(input.value);
    if (Number.isNaN(val)) return;
    const box = state.bones[state.selectedBoneIndex].boxes[state.selectedBoxIndex];
    if (state.gizmoMode === 'translate') box.center[axis] = val;
    else if (state.gizmoMode === 'scale') box.size[axis] = Math.max(0.01, val);
    else box.rotation[axis] = degToRad(val);
    applyBoxStateToMesh(state.selectedBoneIndex, state.selectedBoxIndex);
    if (state.activeSheet === 'bones') renderBonesSheetBody();
    scheduleRecompute();
  });
});

// ---------------------------------------------------------------------------
// Recompute split
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
    .map(b => ({ name: b.name, enabled: true, boxes: b.boxes.map(boxOBB) }));

  state.splitResult = splitGeometryByBones(flat, boneDefs);

  if (state.activeSheet === 'meshes') renderMeshList();
  if (state.activeSheet === 'bones') {
    const stats = sheetBody.querySelectorAll('.bone-stat span:last-child');
    state.bones.forEach((bone, i) => {
      if (stats[i]) stats[i].textContent = getTriCountForBone(bone.name);
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
    const bone = state.bones.find(b => b.name === name);
    if (!bone) return '#6b7280';
    return '#' + bone.color.toString(16).padStart(6, '0');
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

document.getElementById('vbtn-add-bone').addEventListener('click', addNewBoneNearModel);
document.getElementById('vbtn-merge-bone').addEventListener('click', openMergeDialog);

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
    const boneIdx = hits[0].object.userData.boneIndex;
    const boxIdx = hits[0].object.userData.boxIndex;
    if (boneIdx !== undefined) {
      selectBox(boneIdx, boxIdx || 0);
      if (state.activeSheet === 'bones') renderBonesSheetBody();
    }
  }
}

renderer.domElement.addEventListener('dblclick', (e) => tryPickBone(e.clientX, e.clientY));

renderer.domElement.addEventListener('touchend', (e) => {
  if (e.changedTouches.length !== 1) return;
  const t = e.changedTouches[0];
  const now = Date.now();
  const pos = { x: t.clientX, y: t.clientY };
  if (now - lastTapTime < 320 && lastTapPos && Math.abs(pos.x - lastTapPos.x) < 24 && Math.abs(pos.y - lastTapPos.y) < 24) {
    tryPickBone(pos.x, pos.y);
    lastTapTime = 0;
    lastTapPos = null;
  } else {
    lastTapTime = now;
    lastTapPos = pos;
  }
});

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
