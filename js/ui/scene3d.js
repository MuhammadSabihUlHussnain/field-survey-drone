// 3D view of the survey (UI-2): chase or orbit camera plus the drone's own down-facing camera.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const SKY = 0xc4dcec;
// Layer 1 holds things the drone's own camera should not see (its body, shadow and footprint).
const MAIN_VIEW_LAYER = 1;

const healthyColor = new THREE.Color(0x3f8a36);
const sickColor = new THREE.Color(0xa47d2c);

// FR-1.3: leaf color follows the plant's leaf color index, and spotted plants get dark spots.
function plantColor(leafColorIndex, out) {
  const t = Math.min(1, Math.max(0, (leafColorIndex - 0.35) / 0.5));
  return out.copy(sickColor).lerp(healthyColor, t);
}

function seeded(i) {
  const x = Math.sin(i * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

function padTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#3b3f45';
  g.beginPath();
  g.arc(128, 128, 124, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = '#f2b134';
  g.lineWidth = 12;
  g.beginPath();
  g.arc(128, 128, 100, 0, Math.PI * 2);
  g.stroke();
  g.fillStyle = '#f4f1e8';
  g.font = 'bold 150px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('H', 128, 136);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function soilTexture(field) {
  const c = document.createElement('canvas');
  c.width = 1024;
  c.height = 1024;
  const g = c.getContext('2d');
  g.fillStyle = '#6a4e34';
  g.fillRect(0, 0, c.width, c.height);
  for (let i = 0; i < 2500; i++) {
    g.fillStyle = i % 2 ? 'rgba(40,25,12,0.12)' : 'rgba(150,120,90,0.10)';
    g.fillRect(seeded(i) * c.width, seeded(i + 7) * c.height, 3, 3);
  }
  // One furrow between each crop row (rows run along x).
  const rowH = c.height / field.rows;
  g.fillStyle = 'rgba(45, 30, 18, 0.45)';
  for (let r = 0; r <= field.rows; r++) g.fillRect(0, r * rowH - rowH * 0.18, c.width, rowH * 0.36);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function buildDrone() {
  const drone = new THREE.Group();
  const dark = new THREE.MeshStandardMaterial({ color: 0x29313b, roughness: 0.45, metalness: 0.35 });
  const shell = new THREE.MeshStandardMaterial({ color: 0xeceff1, roughness: 0.35, metalness: 0.1 });
  const accent = new THREE.MeshStandardMaterial({ color: 0xf2b134, roughness: 0.5 });

  const body = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.14, 0.66), shell);
  drone.add(body);
  const canopy = new THREE.Mesh(new THREE.SphereGeometry(0.22, 18, 12), shell);
  canopy.scale.set(1, 0.45, 1.3);
  canopy.position.y = 0.07;
  drone.add(canopy);
  const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.47, 0.03, 0.2), accent);
  stripe.position.set(0, 0.02, 0.18);
  drone.add(stripe);

  const rotors = [];
  const bladeMat = new THREE.MeshStandardMaterial({ color: 0x1b1f24, roughness: 0.6 });
  const blurMat = new THREE.MeshBasicMaterial({ color: 0x9aa7b3, transparent: true, opacity: 0.22, depthWrite: false, side: THREE.DoubleSide });
  for (const [sx, sz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.05, 0.75), dark);
    arm.position.set(sx * 0.27, 0, sz * 0.27);
    arm.rotation.y = (sx * sz > 0 ? 1 : -1) * Math.PI * 0.25;
    drone.add(arm);
    const motor = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.07, 0.1, 12), dark);
    motor.position.set(sx * 0.52, 0.04, sz * 0.52);
    drone.add(motor);
    const rotor = new THREE.Group();
    rotor.position.set(sx * 0.52, 0.11, sz * 0.52);
    const b1 = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.01, 0.05), bladeMat);
    const b2 = b1.clone();
    b2.rotation.y = Math.PI / 2;
    const disc = new THREE.Mesh(new THREE.CircleGeometry(0.31, 24), blurMat);
    disc.rotation.x = -Math.PI / 2;
    rotor.add(b1, b2, disc);
    rotor.userData.disc = disc;
    drone.add(rotor);
    rotors.push(rotor);
  }
  const gimbal = new THREE.Mesh(new THREE.SphereGeometry(0.08, 12, 8), dark);
  gimbal.position.set(0, -0.11, 0.22);
  drone.add(gimbal);
  const ledFront = new THREE.Mesh(new THREE.SphereGeometry(0.035, 8, 6), new THREE.MeshBasicMaterial({ color: 0x55ff77 }));
  ledFront.position.set(0, 0, 0.34);
  const ledBack = new THREE.Mesh(new THREE.SphereGeometry(0.035, 8, 6), new THREE.MeshBasicMaterial({ color: 0xff4040 }));
  ledBack.position.set(0, 0, -0.34);
  drone.add(ledFront, ledBack);
  drone.scale.setScalar(1.5);
  drone.userData = { rotors, ledBack };
  return drone;
}

export class FieldScene {
  constructor(container, insetEl, { fovDegrees, basePad }) {
    this.container = container;
    this.insetEl = insetEl;
    this.basePad = basePad;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.domElement.className = 'scene-canvas';
    container.prepend(this.renderer.domElement);

    const scene = (this.scene = new THREE.Scene());
    scene.background = new THREE.Color(SKY);
    scene.fog = new THREE.Fog(SKY, 110, 320);
    scene.add(new THREE.HemisphereLight(0xeaf5ff, 0x5b4a33, 1.25));
    const sun = new THREE.DirectionalLight(0xfff1d6, 2.1);
    sun.position.set(60, 90, 25);
    scene.add(sun);

    const grass = new THREE.Mesh(new THREE.PlaneGeometry(900, 900), new THREE.MeshLambertMaterial({ color: 0x7d9b57 }));
    grass.rotation.x = -Math.PI / 2;
    grass.position.y = -0.02;
    scene.add(grass);

    const pad = new THREE.Mesh(new THREE.CircleGeometry(2, 40), new THREE.MeshLambertMaterial({ map: padTexture() }));
    pad.rotation.x = -Math.PI / 2;
    pad.position.set(basePad.x, 0.03, basePad.z);
    scene.add(pad);

    this.drone = buildDrone();
    this.drone.position.set(basePad.x, 0.1, basePad.z);
    this.drone.traverse((o) => o.layers.set(MAIN_VIEW_LAYER));
    scene.add(this.drone);

    this.shadow = new THREE.Mesh(
      new THREE.CircleGeometry(0.9, 24),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.28, depthWrite: false }),
    );
    this.shadow.rotation.x = -Math.PI / 2;
    this.shadow.layers.set(MAIN_VIEW_LAYER);
    scene.add(this.shadow);

    // Camera footprint: visible in the main view only, not in the drone's own camera.
    this.footprint = new THREE.Group();
    const fpFill = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ color: 0x6cc6ff, transparent: true, opacity: 0.16, depthWrite: false, side: THREE.DoubleSide }),
    );
    fpFill.rotation.x = -Math.PI / 2;
    const fpEdge = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.PlaneGeometry(1, 1)),
      new THREE.LineBasicMaterial({ color: 0x9fdcff, transparent: true, opacity: 0.9 }),
    );
    fpEdge.rotation.x = -Math.PI / 2;
    this.footprint.add(fpFill, fpEdge);
    this.footprint.traverse((o) => o.layers.set(MAIN_VIEW_LAYER));
    this.footprint.visible = false;
    this.fpFill = fpFill;
    scene.add(this.footprint);

    this.chaseCam = new THREE.PerspectiveCamera(55, 1, 0.1, 900);
    this.overviewCam = new THREE.PerspectiveCamera(48, 1, 0.1, 900);
    for (const cam of [this.chaseCam, this.overviewCam]) cam.layers.enable(MAIN_VIEW_LAYER);
    this.droneCam = new THREE.PerspectiveCamera(fovDegrees, 1, 0.1, 300);
    this.controls = new OrbitControls(this.overviewCam, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = Math.PI * 0.47;
    this.controls.enabled = false;
    this.mode = 'chase';
    this.camTarget = new THREE.Vector3();
    this.chaseInit = false;

    this.fieldGroup = null;
    this.routeGroup = null;
    this.flags = null;
    this.flash = 0;
    this.time = 0;
    this.tmpM = new THREE.Matrix4();
    this.tmpQ = new THREE.Quaternion();
    this.tmpV = new THREE.Vector3();
    this.tmpS = new THREE.Vector3();

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
  }

  disposeGroup(group) {
    if (!group) return;
    this.scene.remove(group);
    group.traverse((o) => {
      o.geometry?.dispose();
      if (o.material) {
        o.material.map?.dispose();
        o.material.dispose();
      }
    });
  }

  setField(field) {
    this.disposeGroup(this.fieldGroup);
    this.field = field;
    const group = (this.fieldGroup = new THREE.Group());

    const soil = new THREE.Mesh(new THREE.PlaneGeometry(field.width + 1, field.length + 1), new THREE.MeshLambertMaterial({ map: soilTexture(field) }));
    soil.rotation.x = -Math.PI / 2;
    soil.position.set(field.width / 2, 0.01, field.length / 2);
    group.add(soil);

    const n = field.plants.length;
    const coneGeo = new THREE.ConeGeometry(0.4 * field.spacing, 1, 6);
    coneGeo.translate(0, 0.5, 0);
    const plants = new THREE.InstancedMesh(coneGeo, new THREE.MeshStandardMaterial({ roughness: 0.95, metalness: 0, flatShading: true }), n);
    const spotsList = [];
    const color = new THREE.Color();
    field.plants.forEach((p, i) => {
      const h = p.traits.canopyHeight;
      const wobble = 0.85 + seeded(i + 1) * 0.3;
      this.tmpQ.setFromAxisAngle(new THREE.Vector3(0, 1, 0), seeded(i + 3) * Math.PI * 2);
      this.tmpM.compose(this.tmpV.set(p.x, 0, p.z), this.tmpQ, this.tmpS.set(wobble, h, wobble));
      plants.setMatrixAt(i, this.tmpM);
      plants.setColorAt(i, plantColor(p.traits.leafColorIndex, color));
      if (p.traits.leafSpotCoverage > 0.06) {
        const count = Math.min(5, Math.max(1, Math.round(p.traits.leafSpotCoverage * 12)));
        for (let k = 0; k < count; k++) spotsList.push({ p, h, k, i });
      }
    });
    plants.instanceMatrix.needsUpdate = true;
    plants.instanceColor.needsUpdate = true;
    group.add(plants);

    if (spotsList.length) {
      const spots = new THREE.InstancedMesh(new THREE.SphereGeometry(0.075, 6, 4), new THREE.MeshLambertMaterial({ color: 0x3a2312 }), spotsList.length);
      spotsList.forEach(({ p, h, k, i }, j) => {
        const along = 0.25 + seeded(i * 7 + k) * 0.55; // height up the cone
        const ang = seeded(i * 13 + k) * Math.PI * 2;
        const rad = 0.4 * field.spacing * (1 - along) * 0.95;
        this.tmpM.compose(
          this.tmpV.set(p.x + Math.cos(ang) * rad, along * h, p.z + Math.sin(ang) * rad),
          this.tmpQ.identity(),
          this.tmpS.set(1, 1, 1),
        );
        spots.setMatrixAt(j, this.tmpM);
      });
      spots.instanceMatrix.needsUpdate = true;
      group.add(spots);
    }

    const flagGeo = new THREE.ConeGeometry(0.2, 0.5, 10);
    flagGeo.rotateX(Math.PI);
    this.flags = new THREE.InstancedMesh(flagGeo, new THREE.MeshBasicMaterial({ color: 0xff5a2e }), n);
    this.flags.count = 0;
    this.flags.frustumCulled = false;
    group.add(this.flags);

    this.scene.add(group);
    this.overviewCam.position.set(field.width * 0.5, Math.max(field.width, field.length) * 0.95 + 12, field.length + 34);
    this.controls.target.set(field.width / 2, 0, field.length / 2);
    this.controls.update();
    this.chaseInit = false;
  }

  setRoute(route) {
    this.disposeGroup(this.routeGroup);
    const group = (this.routeGroup = new THREE.Group());
    const pts = [this.basePad, ...route.waypoints, this.basePad].map((p) => new THREE.Vector3(p.x, 0.12, p.z));
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineDashedMaterial({ color: 0xffffff, dashSize: 0.8, gapSize: 0.6, transparent: true, opacity: 0.6 }),
    );
    line.computeLineDistances();
    group.add(line);
    const dotGeo = new THREE.CylinderGeometry(0.22, 0.22, 0.05, 12);
    const dots = new THREE.InstancedMesh(dotGeo, new THREE.MeshBasicMaterial({ color: 0xf4f1e8 }), Math.max(1, route.waypoints.length));
    route.waypoints.forEach((w, i) => {
      this.tmpM.makeTranslation(w.x, 0.14, w.z);
      dots.setMatrixAt(i, this.tmpM);
    });
    dots.count = route.waypoints.length;
    group.add(dots);
    this.scene.add(group);
  }

  resetSurvey() {
    if (this.flags) this.flags.count = 0;
    this.flagIndex = 0;
    this.footprint.visible = false;
    this.drone.position.set(this.basePad.x, 0.1, this.basePad.z);
    this.drone.rotation.set(0, 0, 0);
    this.chaseInit = false;
  }

  // FR-4.4: a marker over every flagged plant.
  addFlags(plantIds) {
    if (!this.flags || !plantIds.length) return;
    for (const id of plantIds) {
      const p = this.field.plants[Number(id.slice(1)) - 1];
      this.tmpM.makeTranslation(p.x, p.traits.canopyHeight + 0.65, p.z);
      this.flags.setMatrixAt(this.flags.count, this.tmpM);
      this.flags.count++;
    }
    this.flags.instanceMatrix.needsUpdate = true;
  }

  pulseFootprint() {
    this.flash = 1;
  }

  setMode(mode) {
    this.mode = mode;
    this.controls.enabled = mode === 'overview';
    if (mode === 'chase') this.chaseInit = false;
  }

  update(dt, drone, halfSize, active) {
    this.time += dt;
    const d = this.drone;
    const airborne = drone.y > 0.01;
    const bob = airborne ? Math.sin(this.time * 2.3) * 0.06 : 0;
    d.position.set(drone.x, drone.y + 0.1 + bob, drone.z);
    // Smooth the yaw so turns at the end of each pass look natural.
    let dh = drone.heading - d.rotation.y;
    dh = Math.atan2(Math.sin(dh), Math.cos(dh));
    d.rotation.y += dh * Math.min(1, dt * 6);
    d.rotation.z = airborne && drone.moving ? Math.sin(this.time * 1.7) * 0.02 : 0;
    d.rotation.x = airborne && drone.moving ? 0.08 : 0;
    for (const r of d.userData.rotors) {
      r.rotation.y += (airborne ? 40 : active ? 8 : 0) * dt;
      r.userData.disc.visible = airborne;
    }
    d.userData.ledBack.visible = Math.floor(this.time * 2) % 2 === 0;

    this.shadow.position.set(drone.x, 0.04, drone.z);
    const shadowScale = Math.max(0.4, 1.3 - drone.y * 0.05);
    this.shadow.scale.set(shadowScale, shadowScale, 1);

    this.footprint.visible = airborne && active && halfSize > 0;
    if (this.footprint.visible) {
      this.footprint.position.set(drone.x, 0.08, drone.z);
      this.footprint.scale.set(halfSize * 2, 1, halfSize * 2);
      this.flash = Math.max(0, this.flash - dt * 1.8);
      this.fpFill.material.opacity = 0.1 + this.flash * 0.3;
    }

    if (this.mode === 'chase') {
      const back = 11;
      const up = 7;
      const want = this.tmpV.set(drone.x - Math.sin(d.rotation.y) * back, Math.max(drone.y, 1) + up, drone.z - Math.cos(d.rotation.y) * back);
      const k = this.chaseInit ? 1 - Math.exp(-dt * 2.2) : 1;
      this.chaseCam.position.lerp(want, k);
      const look = new THREE.Vector3(drone.x + Math.sin(d.rotation.y) * 5, drone.y * 0.4, drone.z + Math.cos(d.rotation.y) * 5);
      this.camTarget.lerp(look, k);
      this.chaseCam.lookAt(this.camTarget);
      this.chaseInit = true;
    } else {
      this.controls.update();
    }

    const h = d.rotation.y;
    this.droneCam.position.set(drone.x, Math.max(drone.y, 0.5), drone.z);
    this.droneCam.up.set(Math.sin(h), 0, Math.cos(h));
    this.droneCam.lookAt(drone.x, 0, drone.z);
  }

  resize() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    for (const cam of [this.chaseCam, this.overviewCam]) {
      cam.aspect = w / h;
      cam.updateProjectionMatrix();
    }
  }

  render() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (!w || !h) return;
    const r = this.renderer;
    r.setScissorTest(true);
    r.setViewport(0, 0, w, h);
    r.setScissor(0, 0, w, h);
    r.render(this.scene, this.mode === 'chase' ? this.chaseCam : this.overviewCam);

    // Inset: what the drone camera sees (square, same field of view as the sensor footprint).
    const box = this.insetEl.getBoundingClientRect();
    const host = this.container.getBoundingClientRect();
    const size = Math.round(Math.min(box.width, box.height));
    if (size > 10 && this.insetEl.offsetParent !== null) {
      const x = Math.round(box.left - host.left);
      const y = Math.round(host.bottom - box.bottom);
      this.droneCam.aspect = 1;
      this.droneCam.updateProjectionMatrix();
      r.setViewport(x, y, size, size);
      r.setScissor(x, y, size, size);
      r.render(this.scene, this.droneCam);
    }
    r.setScissorTest(false);
  }
}
