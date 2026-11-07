// Pip in 3D: loads the Blender model, applies skins, and animates moods.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { MoodFx } from './fx.js';

export class Pet3D {
  constructor(canvas, skins) {
    this.skins = skins;
    this.state = 'idle';
    this.stateSince = 0;
    this.lookTarget = new THREE.Vector2(0, 0);
    this.look = new THREE.Vector2(0, 0);
    this.lean = 0;
    this.leanTarget = 0;
    this.squash = 0;
    this.nextBlink = 2;
    this.blink = 0;
    this.ready = false;

    const r = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, premultipliedAlpha: false });
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    r.setSize(canvas.clientWidth, canvas.clientHeight, false);
    r.setClearColor(0x000000, 0);
    r.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer = r;

    this.scene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(r);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.55;

    // The canvas is taller than Pip so effects have room above its head. Keep Pip the same
    // size on screen (30° for a 220px-tall view) and sitting at the bottom of the canvas.
    const h = canvas.clientHeight, base = 220;
    const fov = (2 * Math.atan(Math.tan((15 * Math.PI) / 180) * (h / base)) * 180) / Math.PI;
    const lift = ((h - base) / 2) * ((2 * 7.2 * Math.tan((15 * Math.PI) / 180)) / base);
    this.camera = new THREE.PerspectiveCamera(fov, canvas.clientWidth / h, 0.1, 50);
    this.camera.position.set(0, 0.5 + lift, 7.2);
    this.camera.lookAt(0, 0.22 + lift, 0);

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8888aa, 1.1));
    const key = new THREE.DirectionalLight(0xfff2e0, 2.2);
    key.position.set(-3, 4, 5);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0xffffff, 1.5);
    rim.position.set(2, 3, -4);
    this.scene.add(rim);

    // Soft shadow blob under the pet
    const shadowTex = (() => {
      const c = document.createElement('canvas');
      c.width = c.height = 128;
      const g = c.getContext('2d');
      const grd = g.createRadialGradient(64, 64, 4, 64, 64, 64);
      grd.addColorStop(0, 'rgba(0,0,0,0.35)');
      grd.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = grd;
      g.fillRect(0, 0, 128, 128);
      return new THREE.CanvasTexture(c);
    })();
    this.shadow = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 0.7), new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false }));
    this.shadow.position.set(0, -1.05, 0);
    this.shadow.rotation.x = -Math.PI / 2.4;
    this.scene.add(this.shadow);

    this.root = new THREE.Group();
    this.scene.add(this.root);
    this.clock = new THREE.Clock();
  }

  async load(url) {
    const gltf = await new GLTFLoader().loadAsync(url);
    this.model = gltf.scene;
    this.root.add(this.model);
    this.parts = {};
    this.mats = {};
    this.model.traverse((o) => {
      if (o.isMesh) {
        const slot = (o.material?.name || '').replace(/^mat_/, '');
        if (slot) this.mats[slot] = o.material;
      }
      this.parts[o.name] = o;
      o.userData.baseScale = o.scale.clone();
      o.userData.basePos = o.position.clone();
    });
    this.eyes = ['eye_L', 'eye_R', 'highlight_L', 'highlight_R'].map((n) => this.parts[n]).filter(Boolean);
    this.hands = [this.parts.hand_L, this.parts.hand_R].filter(Boolean);
    this.mouth = this.parts.mouth;
    this.bulb = this.parts.bulb;
    this.fxAnchor = new THREE.Group(); // follows Pip's bobbing, but not its spinning
    this.scene.add(this.fxAnchor);
    this.fx = new MoodFx(this.fxAnchor);
    this.ready = true;
    this.loop();
  }

  setSkin(id) {
    const skin = this.skins.skins[id] || this.skins.skins[this.skins.default];
    if (!this.ready) { this.pendingSkin = id; return; }
    for (const [slot, m] of Object.entries(this.mats)) {
      const s = skin[slot];
      if (!s) continue;
      m.color.set(s.color);
      m.metalness = s.metalness ?? 0;
      m.roughness = s.roughness ?? 0.5;
      m.emissive.set(s.emissive || '#000000');
      m.emissiveIntensity = s.emissive ? (s.emissiveIntensity ?? 1) : 0;
      m.userData.baseEmissive = m.emissiveIntensity;
      m.needsUpdate = true;
    }
    this.model.traverse((o) => {
      if (o.userData.part) o.visible = skin.parts.includes(o.userData.part);
    });
    this.buildExtras(skin.extras || []);
    this.fx?.setColor(skin.bulb?.emissive || skin.bulb?.color || '#ffc857');
    this.squash = 1; // a little bounce when changing outfits
  }

  // Accessories Pip designed itself, made of simple shapes.
  buildExtras(list) {
    for (const o of this.extraObjs || []) { o.removeFromParent(); o.geometry.dispose(); o.material.dispose(); }
    this.extraObjs = [];
    const geo = {
      sphere: () => new THREE.SphereGeometry(0.5, 32, 16),
      box: () => new THREE.BoxGeometry(1, 1, 1),
      cylinder: () => new THREE.CylinderGeometry(0.5, 0.5, 1, 32),
      cone: () => new THREE.ConeGeometry(0.5, 1, 32),
      capsule: () => new THREE.CapsuleGeometry(0.25, 0.5, 8, 16),
      torus: (e) => new THREE.TorusGeometry(0.5, e.tube ?? 0.12, 16, 48),
    };
    for (const e of list) {
      if (!geo[e.shape]) continue;
      const mat = new THREE.MeshStandardMaterial({
        color: e.color, metalness: e.metalness ?? 0, roughness: e.roughness ?? 0.5,
        emissive: e.emissive || '#000000', emissiveIntensity: e.emissive ? (e.emissiveIntensity ?? 1) : 0,
      });
      const mesh = new THREE.Mesh(geo[e.shape](e), mat);
      mesh.position.fromArray(e.position || [0, 0, 0]);
      mesh.rotation.fromArray([...(e.rotation || [0, 0, 0]), 'XYZ']);
      mesh.scale.fromArray(e.scale || [1, 1, 1]);
      const parent = (e.attach && e.attach !== 'body' && this.parts[e.attach]) || this.model;
      parent.add(mesh);
      this.extraObjs.push(mesh);
    }
  }

  // A picture of Pip for the skin list (transparent PNG).
  snapshot() {
    if (this.fxAnchor) this.fxAnchor.visible = false;
    this.renderer.render(this.scene, this.camera);
    const url = this.renderer.domElement.toDataURL('image/png');
    if (this.fxAnchor) this.fxAnchor.visible = true;
    return url;
  }

  setState(state) {
    this.fx?.setState(state);
    if (state === this.state) return;
    this.state = state;
    this.stateSince = this.clock.elapsedTime;
    if (state === 'happy' || state === 'tap') this.squash = 1;
  }

  lookAt(nx, ny) { this.lookTarget.set(Math.max(-1, Math.min(1, nx)), Math.max(-1, Math.min(1, ny))); }
  setMoving(dx) { this.leanTarget = dx === 0 ? 0 : Math.sign(dx) * 0.35; }
  poke() { this.setState('tap'); }

  loop() {
    requestAnimationFrame(() => this.loop());
    const dt = Math.min(this.clock.getDelta(), 0.05);
    const t = this.clock.elapsedTime;
    const since = t - this.stateSince;
    if (this.pendingSkin) { this.setSkin(this.pendingSkin); this.pendingSkin = null; }

    // Temporary moods fall back to idle.
    if ((this.state === 'happy' && since > 1.6) || (this.state === 'sad' && since > 2.5) || (this.state === 'tap' && since > 0.6)) this.setState('idle');
    const s = this.state;

    // Floating bob
    const speed = s === 'working' ? 5 : s === 'thinking' ? 1.4 : 2.2;
    const amp = s === 'sad' ? 0.03 : 0.09;
    let y = Math.sin(t * speed) * amp;
    if (s === 'happy') y += Math.abs(Math.sin(since * 7)) * 0.35 * Math.max(0, 1 - since / 1.6);
    if (s === 'sad') y -= 0.12;
    this.root.position.y = y;
    this.shadow.scale.setScalar(1 - y * 0.6);
    this.shadow.material.opacity = 0.9 - y;

    // Lean while gliding, tilt while thinking, spin when happy
    this.lean += (this.leanTarget - this.lean) * Math.min(1, dt * 4);
    let tiltZ = -this.lean * 0.5 + Math.sin(t * 0.9) * 0.04;
    if (s === 'thinking') tiltZ += Math.sin(t * 1.3) * 0.15;
    if (s === 'sad') tiltZ += 0.12;
    this.root.rotation.z = tiltZ;
    let spin = 0;
    if (s === 'happy') spin = Math.min(1, since / 0.9) * Math.PI * 2;
    // Look toward the cursor (or up and around while thinking)
    let lt = this.lookTarget;
    if (s === 'thinking') lt = new THREE.Vector2(Math.sin(t * 0.7) * 0.6, 0.7);
    if (s === 'working') lt = new THREE.Vector2(Math.sin(t * 2.1) * 0.3, -0.2);
    this.look.lerp(lt, Math.min(1, dt * 5));
    this.root.rotation.y = this.look.x * 0.45 + this.lean * 0.6 + spin;
    this.root.rotation.x = -this.look.y * 0.25 + (s === 'sad' ? 0.2 : 0);

    // Squash and stretch
    this.squash = Math.max(0, this.squash - dt * 2.5);
    const sq = Math.sin(this.squash * Math.PI * 3) * this.squash * 0.18;
    this.root.scale.set(1 + sq, 1 - sq, 1 + sq);

    // Blinking
    this.nextBlink -= dt;
    if (this.nextBlink <= 0) { this.blink = 1; this.nextBlink = 2 + Math.random() * 3.5; }
    this.blink = Math.max(0, this.blink - dt * 7);
    const lid = s === 'sad' ? 0.55 : s === 'happy' ? 0.35 : 1;
    const open = Math.min(lid, 1 - Math.sin(this.blink * Math.PI) * 0.92);
    for (const e of this.eyes) e.scale.y = e.userData.baseScale.y * open;

    // Hands: wave hello on tap, type while working, gentle float otherwise
    this.hands.forEach((h, i) => {
      const side = i === 0 ? -1 : 1;
      const base = h.userData.basePos;
      let hy = Math.sin(t * speed + i * 1.7) * 0.06;
      let hx = 0;
      if (s === 'working') hy = Math.abs(Math.sin(t * 14 + i * Math.PI)) * 0.12 - 0.05;
      if (s === 'tap' && side === 1) { hy = 0.55 + Math.sin(since * 30) * 0.08; hx = -0.1; }
      if (s === 'happy') hy = 0.45;
      h.position.set(base.x + hx * side, base.y + hy, base.z);
    });

    // Mouth flaps while talking
    if (this.mouth) {
      const m = this.mouth.userData.baseScale;
      const talk = s === 'talking' ? 1 + Math.abs(Math.sin(t * 16)) * 0.9 : s === 'happy' ? 1.5 : s === 'sad' ? 0.6 : 1;
      this.mouth.scale.set(m.x * (s === 'sad' ? 0.8 : 1), m.y * talk, m.z);
      this.mouth.rotation.z = s === 'sad' ? Math.PI : 0;
    }

    // Antenna bulb pulses when busy
    const bulbMat = this.mats.bulb;
    if (bulbMat && bulbMat.userData.baseEmissive !== undefined) {
      const base = bulbMat.userData.baseEmissive;
      const pulse = s === 'thinking' ? 0.6 + Math.sin(t * 4) * 0.5 : s === 'working' ? (Math.sin(t * 12) > 0 ? 1.4 : 0.5) : 1;
      bulbMat.emissiveIntensity = base * pulse;
    }

    this.fxAnchor.position.copy(this.root.position);
    this.fx.update(dt, t, this.mouth ? this.mouth.userData.basePos : new THREE.Vector3(0, -0.04, 0.93));
    this.renderer.render(this.scene, this.camera);
  }
}
