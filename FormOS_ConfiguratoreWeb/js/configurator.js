import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

/* ============================================================
   MATERIAL PRESETS
   (targets will be populated after mesh discovery)
   ============================================================ */
const MATERIAL_PRESETS = {
  upholstery: {
    label: 'Seduta',
    targets: [],   // filled after GLB load
    swatches: [
      { id: '6R10', label: 'Inchiostro',  color: '#2A2C2A', roughness: 0.99, metalness: 0.0 },
      { id: '6R29', label: 'Tortora',     color: '#A89E96', roughness: 0.99, metalness: 0.0 },
      { id: '6R33', label: 'Acquamarina', color: '#7C9681', roughness: 0.99, metalness: 0.0 },
      { id: '6R16', label: 'Salmone',     color: '#C8826A', roughness: 0.99, metalness: 0.0 },
      { id: '6R47', label: 'Moka',        color: '#645246', roughness: 0.99, metalness: 0.0 },
      { id: '6R22', label: 'Titanio',     color: '#8A8880', roughness: 0.99, metalness: 0.0 },
    ],
    default: '6R16',
    keywords: ['fabric', 'seat', 'cushion', 'upholster', 'tessuto', 'seduta',
               'back', 'pad', 'foam', 'imbott', 'schiena', 'cuscino', 'leather', 'pelle'],
  },

  frame: {
    label: 'Struttura',
    targets: [],
    swatches: [
      { id: '01112', label: 'Bronzo',   color: '#6B4226', roughness: 0.88, metalness: 0.85 },
      { id: '0110',  label: 'Nero',     color: '#1A1A1C', roughness: 0.82, metalness: 0.75 },
      { id: '0122',  label: 'Grafite',  color: '#3C3C42', roughness: 0.55, metalness: 0.85 },
      { id: '0139',  label: 'Terra',    color: '#B8943A', roughness: 0.45, metalness: 0.80 },
      { id: '0124',  label: 'Ghiaccio', color: '#C8CDD8', roughness: 0.35, metalness: 0.90 },
    ],
    default: '0139',
    keywords: ['metal', 'steel', 'iron', 'acciaio', 'ferro', 'chrome', 'leg', 'frame',
               'struttura', 'gamba', 'base', 'support', 'rail', 'bar', 'traversa',
               'screw', 'bolt', 'vite', 'hardware', 'fitting'],
  },
};

/* ============================================================
   STATE
   ============================================================ */
const state = { activeSwatches: {}, materials: {} };
Object.keys(MATERIAL_PRESETS).forEach(key => {
  state.activeSwatches[key] = MATERIAL_PRESETS[key].default;
  state.materials[key] = null;
});

/* ============================================================
   SCENE GLOBALS
   ============================================================ */
let renderer, scene, camera, controls;
let meshMap = {};
let allMeshes = [];
let hoveredMesh = null;
let chairRoot = null;

// AR state
let xrHitTestSource = null;
let arReticle = null;
let arChairPlaced = false;
let arOriginalPosition = null;
const pointer = new THREE.Vector2(-9999, -9999);
const raycaster = new THREE.Raycaster();
const HOVER_EMISSIVE = new THREE.Color(0x303030);
const ZERO_EMISSIVE  = new THREE.Color(0x000000);

/* ============================================================
   MATERIAL FACTORY
   ============================================================ */
function resolveSwatch(groupKey, swatchId) {
  const group = MATERIAL_PRESETS[groupKey];
  const swatch = group.swatches.find(s => s.id === swatchId);
  if (!swatch) return null;
  if (swatch.inherit) {
    return resolveSwatch(swatch.inherit, state.activeSwatches[swatch.inherit]);
  }
  return swatch;
}

function createMaterial(swatch, originalMat, groupKey) {
  // Preserve normal map and other maps from original if present
  const mat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(swatch.color),
    roughness: swatch.roughness,
    metalness: swatch.metalness,
    envMapIntensity: 1.2,
  });
  if (originalMat) {
    if (originalMat.normalMap)     mat.normalMap     = originalMat.normalMap;
    if (originalMat.aoMap)         mat.aoMap         = originalMat.aoMap;
    if (originalMat.roughnessMap)  mat.roughnessMap  = originalMat.roughnessMap;
  }
  // Normal map leggera per la tappezzeria
  if (groupKey === 'upholstery' && mat.normalMap) {
    mat.normalScale.set(0.25, 0.25);
    mat.envMapIntensity = 0.2;
  }
  return mat;
}

// Store original materials for normal/AO map reuse
const originalMaterials = {};

function applyMaterial(groupKey, swatchId) {
  const swatch = resolveSwatch(groupKey, swatchId);
  if (!swatch) return;

  state.activeSwatches[groupKey] = swatchId;

  // Get a representative original material for this group (for texture reuse)
  const firstTarget = MATERIAL_PRESETS[groupKey].targets[0];
  const origMat = firstTarget ? originalMaterials[firstTarget] : null;

  const mat = createMaterial(swatch, origMat, groupKey);

  if (state.materials[groupKey]) state.materials[groupKey].dispose();
  state.materials[groupKey] = mat;

  MATERIAL_PRESETS[groupKey].targets.forEach(name => {
    if (meshMap[name]) meshMap[name].material = mat;
  });

  // Re-apply inheriting groups
  Object.entries(MATERIAL_PRESETS).forEach(([gk, g]) => {
    if (gk === groupKey) return;
    const activeSwatch = g.swatches.find(s => s.id === state.activeSwatches[gk]);
    if (activeSwatch?.inherit === groupKey) applyMaterial(gk, state.activeSwatches[gk]);
  });
}

/* ============================================================
   MESH DISCOVERY — classify each mesh by material name keywords
   ============================================================ */
function classifyMeshes(gltf) {
  const groups = {
    upholstery: [],
    frame: [],
    metal: [],
    unclassified: [],
  };

  gltf.scene.traverse(obj => {
    if (!obj.isMesh) return;

    const meshName = (obj.name || '').toLowerCase();
    const matName  = (Array.isArray(obj.material)
      ? obj.material[0]?.name
      : obj.material?.name || ''
    ).toLowerCase();

    const combined = meshName + ' ' + matName;

    // Store original material for later reuse of maps
    originalMaterials[obj.name] = Array.isArray(obj.material)
      ? obj.material[0]
      : obj.material;

    // Check against each group's keywords
    let classified = false;
    for (const [groupKey, group] of Object.entries(MATERIAL_PRESETS)) {
      if (!group.keywords) continue;
      if (group.keywords.some(kw => combined.includes(kw))) {
        groups[groupKey] = groups[groupKey] || [];
        groups[groupKey].push(obj.name);
        classified = true;
        break;
      }
    }
    if (!classified) groups.unclassified.push(obj.name);

    meshMap[obj.name] = obj;
    allMeshes.push(obj);
    obj.castShadow = true;
    obj.receiveShadow = true;
  });

  // Log for debugging
  console.group('[Configuratore] Struttura GLB');
  console.log('Tappezzeria →', groups.upholstery);
  console.log('Struttura →',   groups.frame);
  console.log('Metallo →',     groups.metal);
  console.log('Non classificati →', groups.unclassified);
  console.groupEnd();

  // Assign targets
  Object.keys(MATERIAL_PRESETS).forEach(key => {
    MATERIAL_PRESETS[key].targets = groups[key] || [];
  });

  // Unclassified: assign to the largest empty group, or frame as fallback
  if (groups.unclassified.length > 0) {
    const emptyGroups = Object.keys(MATERIAL_PRESETS).filter(k =>
      MATERIAL_PRESETS[k].targets.length === 0
    );
    const target = emptyGroups[0] || 'frame';
    MATERIAL_PRESETS[target].targets.push(...groups.unclassified);
    console.log(`[Configuratore] Mesh non classificate aggiunte a "${target}":`, groups.unclassified);
  }

  // Piedini plastici: rimuovili da tutti i gruppi configurabili e applica materiale fisso
  applyFixedPlasticFeet(gltf);
}

const PLASTIC_FEET_KEYWORD = 'targetpoint_vovochair1_2';

function applyFixedPlasticFeet(gltf) {
  const plasticMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color('#1A1A1A'),
    roughness: 0.95,
    metalness: 0.0,
    envMapIntensity: 0.1,
  });

  gltf.scene.traverse(obj => {
    if (!obj.isMesh) return;
    if (obj.name.toLowerCase() !== PLASTIC_FEET_KEYWORD) return;

    // Rimuovi dai target di tutti i gruppi
    Object.values(MATERIAL_PRESETS).forEach(group => {
      group.targets = group.targets.filter(t => t !== obj.name);
    });

    // Applica materiale fisso
    obj.material = plasticMat;
    console.log('[Configuratore] Piedini fissi applicati a:', obj.name);
  });

  // Soppresso dal log precedente — il blocco seguente non deve più girare
  void 0;

  // Remove groups with no targets from UI
  Object.keys(MATERIAL_PRESETS).forEach(key => {
    if (MATERIAL_PRESETS[key].targets.length === 0) {
      delete MATERIAL_PRESETS[key];
      delete state.activeSwatches[key];
      delete state.materials[key];
    }
  });
}

/* ============================================================
   GLB LOADER
   ============================================================ */
function loadChair() {
  return new Promise((resolve, reject) => {
    const dracoLoader = new DRACOLoader();
    dracoLoader.setDecoderPath('https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/libs/draco/');

    const loader = new GLTFLoader();
    loader.setDRACOLoader(dracoLoader);

    loader.load(
      'TARGETPOINT_VovoChair.glb',
      gltf => {
        classifyMeshes(gltf);

        // Centre and scale the model
        const box = new THREE.Box3().setFromObject(gltf.scene);
        const size   = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z);
        const scale  = 1.8 / maxDim;

        gltf.scene.scale.setScalar(scale);
        gltf.scene.position.sub(center.multiplyScalar(scale));

        // Sit on floor (y=0)
        const box2 = new THREE.Box3().setFromObject(gltf.scene);
        gltf.scene.position.y -= box2.min.y;

        chairRoot = gltf.scene;
        scene.add(gltf.scene);

        // Update camera target to model centre
        const box3 = new THREE.Box3().setFromObject(gltf.scene);
        const centre3 = box3.getCenter(new THREE.Vector3());
        controls.target.copy(centre3);
        controls.update();

        resolve(gltf);
      },
      xhr => {
        const pct = Math.round((xhr.loaded / xhr.total) * 100);
        document.querySelector('.loader-text').textContent =
          `Caricamento modello... ${pct}%`;
      },
      err => reject(err)
    );
  });
}

/* ============================================================
   SCENE SETUP
   ============================================================ */
function initRenderer() {
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.xr.enabled = true;
  document.getElementById('canvas-container').appendChild(renderer.domElement);
}

function initScene() {
  scene = new THREE.Scene();
  // Background transparent — gradient via CSS
}

function initCamera() {
  camera = new THREE.PerspectiveCamera(42, window.innerWidth / window.innerHeight, 0.01, 60);
  camera.position.set(-2.037, 1.529, 2.528);
}

function initControls() {
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.minDistance = 0.5;
  controls.maxDistance = 8;
  controls.maxPolarAngle = Math.PI / 2 + 0.1;
  controls.autoRotate = false;
  controls.autoRotateSpeed = 0.4;
  controls.update();
}

function setupLighting() {
  scene.add(new THREE.AmbientLight(0xffffff, 0.15));

  const key = new THREE.DirectionalLight(0xfff8f0, 2.0);
  keyLight = key;
  key.position.set(4, 6, 4);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.near = 0.5;
  key.shadow.camera.far = 20;
  key.shadow.camera.left = key.shadow.camera.bottom = -3;
  key.shadow.camera.right = key.shadow.camera.top  =  3;
  key.shadow.bias = -0.0008;
  scene.add(key);

  const fill = new THREE.DirectionalLight(0xd0d8ff, 0.7);
  fill.position.set(-4, 2, -2);
  scene.add(fill);

  const rim = new THREE.DirectionalLight(0xffffff, 0.35);
  rim.position.set(0, 4, -5);
  scene.add(rim);

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(16, 16),
    new THREE.ShadowMaterial({ opacity: 0.2 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);
}

function setupEnvironment() {
  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
}

/* ============================================================
   UI — DYNAMIC PANEL
   ============================================================ */
function buildPanel() {
  const container = document.querySelector('.panel-sections');
  container.innerHTML = '';

  Object.entries(MATERIAL_PRESETS).forEach(([groupKey, group]) => {
    const section = document.createElement('div');
    section.className = 'config-section expanded';
    section.dataset.group = groupKey;

    const header = document.createElement('div');
    header.className = 'section-header';
    header.innerHTML = `
      <span class="section-label">${group.label}</span>
      <svg class="section-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="6 9 12 15 18 9"/>
      </svg>`;
    header.addEventListener('click', () => {
      const body = section.querySelector('.section-body');
      const collapsed = body.classList.toggle('collapsed');
      section.classList.toggle('expanded', !collapsed);
    });

    const body = document.createElement('div');
    body.className = 'section-body';

    group.swatches.forEach(swatch => {
      const wrap = document.createElement('div');
      wrap.className = 'swatch-wrap';
      wrap.title = swatch.label;

      const el = document.createElement('div');
      el.className = 'swatch' + (swatch.id === group.default ? ' swatch--active' : '');
      el.dataset.swatchId = swatch.id;
      el.style.backgroundColor = swatch.color || '#888';
      if (!swatch.color) {
        el.style.background = 'linear-gradient(135deg, #666 50%, #333 50%)';
      }

      el.addEventListener('click', () => {
        body.querySelectorAll('.swatch').forEach(s => s.classList.remove('swatch--active'));
        el.classList.add('swatch--active');
        applyMaterial(groupKey, swatch.id);
      });

      const lbl = document.createElement('span');
      lbl.className = 'swatch-label';
      lbl.textContent = swatch.label;

      wrap.append(el, lbl);
      body.appendChild(wrap);
    });

    section.append(header, body);
    container.appendChild(section);
  });
}

function highlightPanelSection(groupKey) {
  document.querySelectorAll('.config-section').forEach(s => s.classList.remove('highlighted'));
  if (!groupKey) return;
  const el = document.querySelector(`.config-section[data-group="${groupKey}"]`);
  if (!el) return;
  el.classList.add('highlighted');
  const body = el.querySelector('.section-body');
  if (body.classList.contains('collapsed')) {
    body.classList.remove('collapsed');
    el.classList.add('expanded');
  }
  el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  setTimeout(() => el.classList.remove('highlighted'), 1500);
}

function findGroupForMesh(meshName) {
  for (const [key, group] of Object.entries(MATERIAL_PRESETS)) {
    if (group.targets.includes(meshName)) return key;
  }
  return null;
}

/* ============================================================
   RAYCASTING
   ============================================================ */
function onPointerMove(e) {
  pointer.x =  (e.clientX / window.innerWidth)  * 2 - 1;
  pointer.y = -(e.clientY / window.innerHeight) * 2 + 1;
}

function updateHover() {
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObjects(allMeshes, false);

  if (hits.length > 0) {
    const hit = hits[0].object;
    if (hit !== hoveredMesh) {
      if (hoveredMesh?.material?.emissive) hoveredMesh.material.emissive.copy(ZERO_EMISSIVE);
      hoveredMesh = hit;
      if (hoveredMesh?.material?.emissive) hoveredMesh.material.emissive.copy(HOVER_EMISSIVE);
    }
    renderer.domElement.style.cursor = 'pointer';
  } else {
    if (hoveredMesh?.material?.emissive) hoveredMesh.material.emissive.copy(ZERO_EMISSIVE);
    hoveredMesh = null;
    renderer.domElement.style.cursor = 'default';
  }
}

function onPointerClick(e) {
  if (Math.abs(e.movementX) + Math.abs(e.movementY) > 4) return;
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObjects(allMeshes, false);
  if (!hits.length) return;
  highlightPanelSection(findGroupForMesh(hits[0].object.name));
}

/* ============================================================
   RESIZE / RESET
   ============================================================ */
function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

function resetAll() {
  Object.keys(MATERIAL_PRESETS).forEach(groupKey => {
    const defaultId = MATERIAL_PRESETS[groupKey].default;
    applyMaterial(groupKey, defaultId);
    const sec = document.querySelector(`.config-section[data-group="${groupKey}"]`);
    sec?.querySelectorAll('.swatch').forEach(s => {
      s.classList.toggle('swatch--active', s.dataset.swatchId === defaultId);
    });
  });
}

/* ============================================================
   AUTO-ROTATE (starts after 30s of inactivity)
   ============================================================ */
const AUTO_ROTATE_DELAY = 30000;
let autoRotateTimer = null;

function startAutoRotateTimer() {
  clearTimeout(autoRotateTimer);
  autoRotateTimer = setTimeout(() => {
    controls.autoRotate = true;
  }, AUTO_ROTATE_DELAY);
}

function stopAutoRotate() {
  controls.autoRotate = false;
  startAutoRotateTimer();
}

/* ============================================================
   AR — REALTÀ AUMENTATA
   ============================================================ */
function createARReticle() {
  const geo = new THREE.RingGeometry(0.12, 0.15, 32);
  geo.rotateX(-Math.PI / 2);
  const reticle = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0xffffff }));
  reticle.matrixAutoUpdate = false;
  reticle.visible = false;
  return reticle;
}

async function startARWebXR() {
  try {
    const session = await navigator.xr.requestSession('immersive-ar', {
      requiredFeatures: ['hit-test'],
      optionalFeatures: ['dom-overlay'],
      domOverlay: { root: document.getElementById('ar-overlay') },
    });

    renderer.xr.setReferenceSpaceType('local');
    await renderer.xr.setSession(session);

    const viewerSpace = await session.requestReferenceSpace('viewer');
    xrHitTestSource = await session.requestHitTestSource({ space: viewerSpace });

    arReticle = createARReticle();
    scene.add(arReticle);
    arChairPlaced = false;

    if (chairRoot) {
      arOriginalPosition = chairRoot.position.clone();
      chairRoot.visible = false;
    }

    document.getElementById('ar-overlay').style.display = 'flex';
    document.getElementById('panel').style.display = 'none';

    session.addEventListener('select', () => {
      if (arReticle?.visible && !arChairPlaced && chairRoot) {
        const pos = new THREE.Vector3();
        pos.setFromMatrixPosition(arReticle.matrix);
        chairRoot.position.copy(pos);
        chairRoot.visible = true;
        arReticle.visible = false;
        arChairPlaced = true;
        document.getElementById('ar-hint').style.display = 'none';
      }
    });

    session.addEventListener('end', () => {
      if (arReticle) { scene.remove(arReticle); arReticle = null; }
      xrHitTestSource = null;
      arChairPlaced = false;
      if (chairRoot && arOriginalPosition) {
        chairRoot.position.copy(arOriginalPosition);
        chairRoot.visible = true;
      }
      document.getElementById('ar-hint').style.display = '';
      document.getElementById('ar-overlay').style.display = 'none';
      document.getElementById('panel').style.display = '';
    });

  } catch (err) {
    console.error('[AR] Errore:', err);
    alert('AR non disponibile: ' + err.message);
  }
}

function triggerIOSQuickLook() {
  document.getElementById('ar-ios-link').click();
}

async function onARButtonClick() {
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
  if (isIOS) { triggerIOSQuickLook(); return; }

  if (navigator.xr) {
    const supported = await navigator.xr.isSessionSupported('immersive-ar').catch(() => false);
    if (supported) { startARWebXR(); return; }
  }
  alert('La realtà aumentata non è supportata su questo dispositivo o browser.');
}

async function checkARSupport() {
  const btn = document.getElementById('btn-ar');
  // Show on any touch device (iOS, Android, tablet)
  if (navigator.maxTouchPoints > 0) {
    btn.style.display = 'flex';
    return;
  }
  // Also show on desktop if WebXR AR is supported
  if (navigator.xr) {
    const ok = await navigator.xr.isSessionSupported('immersive-ar').catch(() => false);
    if (ok) btn.style.display = 'flex';
  }
}

/* ============================================================
   ANIMATION LOOP
   ============================================================ */
function animate(time, frame) {
  if (renderer.xr.isPresenting && frame && xrHitTestSource && arReticle) {
    const refSpace = renderer.xr.getReferenceSpace();
    const hits = frame.getHitTestResults(xrHitTestSource);
    if (hits.length > 0 && !arChairPlaced) {
      const pose = hits[0].getPose(refSpace);
      arReticle.visible = true;
      arReticle.matrix.fromArray(pose.transform.matrix);
    } else {
      arReticle.visible = false;
    }
  } else {
    controls.update();
    updateHover();
  }
  renderer.render(scene, camera);
}

/* ============================================================
   INIT
   ============================================================ */
async function init() {
  initRenderer();
  initScene();
  initCamera();
  initControls();
  setupLighting();
  setupEnvironment();

  // AR button — show before model loads so it's always visible on compatible devices
  await checkARSupport();
  document.getElementById('btn-ar').addEventListener('click', onARButtonClick);
  document.getElementById('btn-ar-exit').addEventListener('click', () => {
    renderer.xr.getSession()?.end();
  });

  await loadChair();

  // Apply default materials to classified meshes
  Object.keys(MATERIAL_PRESETS).forEach(key => {
    applyMaterial(key, MATERIAL_PRESETS[key].default);
  });

  buildPanel();

  renderer.render(scene, camera);
  await new Promise(r => setTimeout(r, 300));
  document.getElementById('loading-overlay').classList.add('hidden');

  const hint = document.getElementById('orbit-hint');
  renderer.domElement.addEventListener('pointerdown', () => hint.classList.add('hidden'), { once: true });

  // Esponi camera per lettura posizione
  window.__camera = camera;
  window.__controls = controls;

  // Start auto-rotate countdown
  startAutoRotateTimer();

  // Any user interaction resets the timer and stops auto-rotate
  ['pointerdown', 'wheel', 'keydown'].forEach(evt => {
    window.addEventListener(evt, stopAutoRotate, { passive: true });
  });

  renderer.setAnimationLoop(animate);
}

window.addEventListener('resize', onResize);
window.addEventListener('pointermove', onPointerMove);
window.addEventListener('click', onPointerClick);
document.getElementById('btn-reset').addEventListener('click', resetAll);

// Light rotation slider
const KEY_LIGHT_RADIUS = 7;
const KEY_LIGHT_HEIGHT = 6;
let keyLight = null; // set after setupLighting

document.getElementById('light-angle').addEventListener('input', e => {
  if (!keyLight) return;
  const angle = THREE.MathUtils.degToRad(Number(e.target.value));
  keyLight.position.set(
    Math.sin(angle) * KEY_LIGHT_RADIUS,
    KEY_LIGHT_HEIGHT,
    Math.cos(angle) * KEY_LIGHT_RADIUS
  );
});

init().catch(err => {
  console.error('[Configuratore] Errore:', err);
  document.getElementById('loading-overlay').classList.add('hidden');
});
