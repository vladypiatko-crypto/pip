// Mood effects around Pip: thought bubbles, orbiting sparks, sound rings, confetti...
// Everything is built from simple glowing shapes tinted with the current skin's colors.
import * as THREE from 'three';

const MAX_PARTICLES = 160;
const CONFETTI = ['#ff5d73', '#ffc145', '#5ad1a4', '#5aa9ff', '#b07cff', '#ff8fd0'];

function heartGeometry() {
  const s = new THREE.Shape();
  s.moveTo(0, -0.5);
  s.bezierCurveTo(-0.15, -0.35, -0.6, -0.1, -0.5, 0.2);
  s.bezierCurveTo(-0.42, 0.45, -0.1, 0.5, 0, 0.25);
  s.bezierCurveTo(0.1, 0.5, 0.42, 0.45, 0.5, 0.2);
  s.bezierCurveTo(0.6, -0.1, 0.15, -0.35, 0, -0.5);
  const g = new THREE.ExtrudeGeometry(s, { depth: 0.18, bevelEnabled: true, bevelSize: 0.05, bevelThickness: 0.05, bevelSegments: 3 });
  g.center();
  return g;
}

export class MoodFx {
  constructor(parent) {
    this.group = new THREE.Group();
    parent.add(this.group);
    this.particles = [];
    this.color = new THREE.Color('#ffc857');
    this.geo = {
      orb: new THREE.SphereGeometry(1, 16, 12),
      cube: new THREE.BoxGeometry(1, 1, 1),
      ring: new THREE.TorusGeometry(1, 0.07, 8, 48),
      heart: heartGeometry(),
      drop: new THREE.CapsuleGeometry(0.5, 1, 4, 8),
    };
    this.spawnClock = {};
    this.state = 'idle';

    // Thinking: a ring of glowing dots circling the head.
    this.halo = new THREE.Group();
    this.halo.position.set(0, 1.15, 0);
    this.halo.rotation.x = 0.35;
    this.haloDots = [];
    for (let i = 0; i < 10; i++) {
      const m = new THREE.Mesh(this.geo.orb, this.glow(this.color, 0));
      const a = (i / 10) * Math.PI * 2;
      m.position.set(Math.cos(a) * 0.95, 0, Math.sin(a) * 0.95);
      m.scale.setScalar(0.05 + (i % 3) * 0.015);
      this.halo.add(m);
      this.haloDots.push(m);
    }
    this.group.add(this.halo);
    this.haloAmt = 0;

    // Working: sparks orbiting the body on a tilted ring.
    this.orbit = new THREE.Group();
    this.orbit.rotation.set(0.5, 0, 0.35);
    this.orbitSparks = [];
    for (let i = 0; i < 6; i++) {
      const m = new THREE.Mesh(this.geo.cube, this.glow(this.color, 0));
      m.userData.a = (i / 6) * Math.PI * 2;
      m.scale.setScalar(0.09);
      this.orbit.add(m);
      this.orbitSparks.push(m);
    }
    this.group.add(this.orbit);
    this.orbitAmt = 0;

    // Sad: a tiny rain cloud.
    this.cloud = new THREE.Group();
    this.cloud.position.set(0, 1.75, 0);
    const cloudMat = new THREE.MeshStandardMaterial({ color: '#8a93a6', roughness: 1, transparent: true, opacity: 0 });
    for (const [x, y, r] of [[-0.32, 0, 0.26], [0, 0.1, 0.34], [0.32, 0, 0.25], [0.12, -0.08, 0.24], [-0.14, -0.08, 0.22]]) {
      const m = new THREE.Mesh(this.geo.orb, cloudMat);
      m.position.set(x, y, 0);
      m.scale.setScalar(r);
      this.cloud.add(m);
    }
    this.cloudMat = cloudMat;
    this.group.add(this.cloud);
    this.cloudAmt = 0;
  }

  glow(color, opacity = 1) {
    return new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending });
  }

  setColor(hex) {
    this.color.set(hex);
    for (const m of [...this.haloDots, ...this.orbitSparks]) m.material.color.set(this.color);
  }

  setState(state) {
    const prev = this.state;
    this.state = state;
    if (state === 'happy' && prev !== 'happy') this.confetti();
    if (state === 'tap') this.heart();
  }

  add(mesh, p) {
    if (this.particles.length >= MAX_PARTICLES) this.remove(this.particles[0]);
    this.group.add(mesh);
    this.particles.push({ mesh, age: 0, life: 1, vel: new THREE.Vector3(), gravity: 0, spin: 0, grow: 0, baseScale: mesh.scale.x, fadeIn: 0.1, ...p });
  }

  remove(p) {
    this.group.remove(p.mesh);
    p.mesh.material.dispose();
    this.particles.splice(this.particles.indexOf(p), 1);
  }

  every(key, seconds, dt) {
    this.spawnClock[key] = (this.spawnClock[key] || 0) + dt;
    if (this.spawnClock[key] < seconds) return false;
    this.spawnClock[key] = 0;
    return true;
  }

  // ---- one-off effects
  confetti() {
    for (let i = 0; i < 46; i++) {
      const m = new THREE.Mesh(this.geo.cube, new THREE.MeshBasicMaterial({ color: CONFETTI[i % CONFETTI.length], transparent: true }));
      m.scale.set(0.09, 0.05, 0.02);
      m.position.set((Math.random() - 0.5) * 0.4, 1.0, 0.3);
      const a = Math.random() * Math.PI * 2;
      const sp = 1.6 + Math.random() * 2.2;
      this.add(m, { life: 1.6 + Math.random() * 0.6, vel: new THREE.Vector3(Math.cos(a) * sp * 0.8, 2.5 + Math.random() * 2.5, Math.sin(a) * sp * 0.4), gravity: -6, spin: 8 + Math.random() * 10, fadeIn: 0 });
    }
  }

  heart() {
    const m = new THREE.Mesh(this.geo.heart, new THREE.MeshBasicMaterial({ color: '#ff5d8f', transparent: true }));
    m.position.set(0.55, 1.05, 0.4);
    m.scale.setScalar(0.32);
    this.add(m, { life: 1.1, vel: new THREE.Vector3(0.15, 1.1, 0), grow: 0.35, fadeIn: 0.05, wobble: true });
  }

  // ---- per-frame
  update(dt, t, mouthPos) {
    const s = this.state;
    const ease = (cur, target) => cur + (target - cur) * Math.min(1, dt * 5);

    // Thinking halo
    this.haloAmt = ease(this.haloAmt, s === 'thinking' ? 1 : 0);
    this.halo.visible = this.haloAmt > 0.01;
    this.halo.rotation.y = t * 1.6;
    this.haloDots.forEach((m, i) => {
      m.material.opacity = this.haloAmt * (0.45 + 0.55 * Math.max(0, Math.sin(t * 5 - i * 0.7)));
    });

    // Thought bubbles rising beside the head
    if (s === 'thinking' && this.every('thought', 0.55, dt)) {
      const m = new THREE.Mesh(this.geo.orb, this.glow(this.color));
      m.position.set(0.75 + Math.random() * 0.1, 0.95, 0.2);
      m.scale.setScalar(0.05);
      this.add(m, { life: 1.6, vel: new THREE.Vector3(0.28, 0.75, 0), grow: 0.11, fadeIn: 0.25 });
    }

    // Working: orbiting sparks + code bits flying up from the hands
    this.orbitAmt = ease(this.orbitAmt, s === 'working' ? 1 : 0);
    this.orbit.visible = this.orbitAmt > 0.01;
    this.orbitSparks.forEach((m, i) => {
      const a = m.userData.a + t * 3.2;
      m.position.set(Math.cos(a) * 1.55, Math.sin(t * 6 + i) * 0.06, Math.sin(a) * 1.55);
      m.rotation.set(t * 4 + i, t * 3, 0);
      m.material.opacity = this.orbitAmt * 0.95;
    });
    if (s === 'working' && this.every('bits', 0.09, dt)) {
      const side = Math.random() < 0.5 ? -1 : 1;
      const m = new THREE.Mesh(this.geo.cube, this.glow(Math.random() < 0.3 ? '#ffffff' : this.color));
      m.position.set(side * 1.15, -0.3, 0.3);
      m.scale.setScalar(0.05 + Math.random() * 0.04);
      this.add(m, { life: 0.9, vel: new THREE.Vector3(side * -0.25 + (Math.random() - 0.5) * 0.4, 1.4 + Math.random() * 0.8, 0.2), spin: 6, fadeIn: 0.05 });
    }

    // Talking: sound rings from the mouth
    if (s === 'talking' && this.every('ring', 0.32, dt)) {
      const m = new THREE.Mesh(this.geo.ring, this.glow(this.color));
      m.position.copy(mouthPos).add(new THREE.Vector3(0, 0, 0.08));
      m.scale.setScalar(0.06);
      this.add(m, { life: 0.55, vel: new THREE.Vector3(0, 0, 1.2), grow: 0.38, fadeIn: 0 });
    }

    // Sad: rain cloud
    this.cloudAmt = ease(this.cloudAmt, s === 'sad' ? 1 : 0);
    this.cloud.visible = this.cloudAmt > 0.01;
    this.cloudMat.opacity = this.cloudAmt * 0.95;
    this.cloud.position.x = Math.sin(t * 1.5) * 0.08;
    if (s === 'sad' && this.every('rain', 0.07, dt)) {
      const m = new THREE.Mesh(this.geo.drop, new THREE.MeshBasicMaterial({ color: '#7cc4ff', transparent: true }));
      m.position.set(this.cloud.position.x + (Math.random() - 0.5) * 0.7, 1.55, (Math.random() - 0.5) * 0.3);
      m.scale.set(0.025, 0.05, 0.025);
      this.add(m, { life: 0.55, vel: new THREE.Vector3(0, -3.2, 0), fadeIn: 0 });
    }

    // Move and fade everything
    for (const p of [...this.particles]) {
      p.age += dt;
      if (p.age >= p.life) { this.remove(p); continue; }
      p.vel.y += p.gravity * dt;
      p.mesh.position.addScaledVector(p.vel, dt);
      if (p.spin) { p.mesh.rotation.x += p.spin * dt; p.mesh.rotation.z += p.spin * 0.7 * dt; }
      if (p.wobble) p.mesh.rotation.z = Math.sin(p.age * 10) * 0.25;
      if (p.grow) p.mesh.scale.setScalar(p.baseScale + p.grow * p.age);
      const k = p.age / p.life;
      const fadeIn = p.fadeIn ? Math.min(1, p.age / (p.life * p.fadeIn)) : 1;
      p.mesh.material.opacity = fadeIn * (k > 0.6 ? 1 - (k - 0.6) / 0.4 : 1);
    }
  }
}
