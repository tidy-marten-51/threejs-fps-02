// Transient sights, all pooled: tracer rounds that stitch a shot across the yard for a
// frame or two, impact sparks where a bullet stops, a dust puff on a hit body, smoke
// canisters that bloom into a sight-blocking cloud, and the bomb's blink. Nothing here
// allocates in the frame loop — pools are sized once and recycled.
import * as THREE from 'three';
import { PALETTE } from './palette.js';

const TRACERS = 48;
const SPARKS = 240;

export function createEffects(scene) {
  // Tracers: one LineSegments with a position per pooled tracer, faded by age.
  const tracerPos = new Float32Array(TRACERS * 6);
  const tracerGeo = new THREE.BufferGeometry();
  tracerGeo.setAttribute('position', new THREE.BufferAttribute(tracerPos, 3));
  const tracerMat = new THREE.LineBasicMaterial({ color: new THREE.Color(PALETTE.lamp), transparent: true, opacity: 0.75 });
  const tracerLines = new THREE.LineSegments(tracerGeo, tracerMat);
  tracerLines.frustumCulled = false;
  scene.add(tracerLines);
  const tracers = Array.from({ length: TRACERS }, () => ({ life: 0 }));
  let tracerCursor = 0;

  // Sparks: one Points cloud, each particle with a velocity and a short life.
  const sparkPos = new Float32Array(SPARKS * 3);
  const sparkGeo = new THREE.BufferGeometry();
  sparkGeo.setAttribute('position', new THREE.BufferAttribute(sparkPos, 3));
  const sparkMat = new THREE.PointsMaterial({ color: new THREE.Color(PALETTE.lamp), size: 0.06, transparent: true, opacity: 0.9, depthWrite: false });
  const sparkPoints = new THREE.Points(sparkGeo, sparkMat);
  sparkPoints.frustumCulled = false;
  scene.add(sparkPoints);
  const sparks = Array.from({ length: SPARKS }, () => ({ life: 0, vx: 0, vy: 0, vz: 0 }));
  let sparkCursor = 0;
  for (let i = 0; i < SPARKS; i += 1) sparkPos[i * 3 + 1] = -50;

  // Smoke clouds: a handful of growing, fading spheres. The same records feed bot vision.
  const smokes = [];
  const smokeGroup = new THREE.Group();
  scene.add(smokeGroup);
  const smokeMat = new THREE.MeshBasicMaterial({ color: new THREE.Color('#aab3ba'), transparent: true, opacity: 0.34, depthWrite: false });

  // The planted charge: a small box with a lamp that blinks faster as the timer runs down.
  const bombGroup = new THREE.Group();
  const bombBody = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.16, 0.3), new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.hairline), roughness: 0.6 }));
  bombBody.position.y = 0.08;
  const bombLamp = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.04, 0.08), new THREE.MeshBasicMaterial({ color: new THREE.Color('#ff4444') }));
  bombLamp.position.y = 0.19;
  bombGroup.add(bombBody, bombLamp);
  bombGroup.visible = false;
  scene.add(bombGroup);

  // A dropped charge (carrier killed) lies where it fell until a teammate picks it up.
  const droppedGroup = bombGroup.clone();
  droppedGroup.visible = false;
  scene.add(droppedGroup);

  const flashOverlay = { strength: 0 };

  function tracer(from, to) {
    const index = tracerCursor;
    tracerCursor = (tracerCursor + 1) % TRACERS;
    tracers[index].life = 0.07;
    const o = index * 6;
    tracerPos[o] = from.x;
    tracerPos[o + 1] = from.y;
    tracerPos[o + 2] = from.z;
    tracerPos[o + 3] = to.x;
    tracerPos[o + 4] = to.y;
    tracerPos[o + 5] = to.z;
    tracerGeo.attributes.position.needsUpdate = true;
  }

  function burst(point, count, color, speed = 2.6, up = 1.6) {
    sparkMat.color.set(color);
    for (let n = 0; n < count; n += 1) {
      const s = sparks[sparkCursor];
      const i = sparkCursor;
      sparkCursor = (sparkCursor + 1) % SPARKS;
      s.life = 0.28 + Math.random() * 0.25;
      s.vx = (Math.random() * 2 - 1) * speed;
      s.vy = Math.random() * up;
      s.vz = (Math.random() * 2 - 1) * speed;
      sparkPos[i * 3] = point.x;
      sparkPos[i * 3 + 1] = point.y;
      sparkPos[i * 3 + 2] = point.z;
    }
    sparkGeo.attributes.position.needsUpdate = true;
  }

  function smoke(x, z, radius, duration) {
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 18, 12), smokeMat.clone());
    mesh.position.set(x, 1.4, z);
    mesh.scale.setScalar(0.3);
    smokeGroup.add(mesh);
    smokes.push({ x, y: 1.4, z, r: radius, mesh, age: 0, duration });
  }

  function step(dt, time) {
    let anyTracer = false;
    for (let i = 0; i < TRACERS; i += 1) {
      if (tracers[i].life > 0) {
        tracers[i].life -= dt;
        anyTracer = true;
        if (tracers[i].life <= 0) {
          tracerPos[i * 6 + 1] = -50;
          tracerPos[i * 6 + 4] = -50;
        }
      }
    }
    if (anyTracer) tracerGeo.attributes.position.needsUpdate = true;
    let anySpark = false;
    for (let i = 0; i < SPARKS; i += 1) {
      const s = sparks[i];
      if (s.life > 0) {
        s.life -= dt;
        anySpark = true;
        s.vy -= 6 * dt;
        sparkPos[i * 3] += s.vx * dt;
        sparkPos[i * 3 + 1] += s.vy * dt;
        sparkPos[i * 3 + 2] += s.vz * dt;
        if (s.life <= 0) sparkPos[i * 3 + 1] = -50;
      }
    }
    if (anySpark) sparkGeo.attributes.position.needsUpdate = true;
    for (let i = smokes.length - 1; i >= 0; i -= 1) {
      const s = smokes[i];
      s.age += dt;
      const grow = Math.min(1, s.age / 1.6);
      const fade = s.age > s.duration - 2 ? Math.max(0, (s.duration - s.age) / 2) : 1;
      s.mesh.scale.setScalar(0.3 + grow * s.r * 0.92);
      s.mesh.material.opacity = 0.34 * fade;
      if (s.age >= s.duration) {
        smokeGroup.remove(s.mesh);
        smokes.splice(i, 1);
      }
    }
    if (bombGroup.visible) {
      const urgency = bombGroup.userData.urgency ?? 0;
      const rate = 2 + urgency * 14;
      bombLamp.material.color.set(Math.sin(time * rate) > 0 ? '#ff4444' : '#571515');
    }
    flashOverlay.strength = Math.max(0, flashOverlay.strength - dt * 0.55);
  }

  return {
    tracer,
    burst,
    smoke,
    step,
    smokes,
    flashOverlay,
    setBomb(x, z, urgency) {
      bombGroup.position.set(x, 0, z);
      bombGroup.visible = true;
      bombGroup.userData.urgency = urgency;
      droppedGroup.visible = false;
    },
    setDropped(x, z) {
      droppedGroup.position.set(x, 0, z);
      droppedGroup.visible = true;
    },
    clearBomb() {
      bombGroup.visible = false;
      droppedGroup.visible = false;
    },
  };
}
