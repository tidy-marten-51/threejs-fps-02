// One character for everybody: the player and each bot are the same actor — a body that
// walks with acceleration and friction, crouches, jumps, and resolves against the map's
// boxes one axis at a time. Combat tests three body-part boxes (head, torso, legs), kept
// axis-aligned on purpose: at rifle distances the difference from a rotated box is
// invisible, and the head box is what makes a headshot a headshot. The visible figure is
// boxes too — boots, legs, a team-coloured vest, a helmet — posed each frame from the
// walk cycle, and it falls where it dies.
import * as THREE from 'three';
import { PALETTE, TEAM_COLORS } from './palette.js';

export const RADIUS = 0.34;
export const STAND_HEIGHT = 1.72;
export const CROUCH_HEIGHT = 1.14;
export const STAND_EYE = 1.58;
export const CROUCH_EYE = 1.0;
export const WALK_SPEED = 5.3;
const CROUCH_SPEED = 2.5;
const GROUND_ACCEL = 40;
const AIR_ACCEL = 8;
const FRICTION = 9;
const GRAVITY = 20;
const JUMP_SPEED = 6.1;

const partScratch = [
  { part: 'head', box: { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 } },
  { part: 'torso', box: { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 } },
  { part: 'legs', box: { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 } },
];

const bodyMaterials = new Map();
function bodyMaterial(color, roughness = 0.85) {
  if (!bodyMaterials.has(color)) {
    bodyMaterials.set(color, new THREE.MeshStandardMaterial({ color: new THREE.Color(color), roughness, metalness: 0.05 }));
  }
  return bodyMaterials.get(color);
}

function limb(w, h, d, color) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), bodyMaterial(color));
  mesh.castShadow = true;
  return mesh;
}

export function createActor(scene, colliders, team, name) {
  const actor = {
    team,
    name,
    isPlayer: false,
    position: new THREE.Vector3(),
    velocity: new THREE.Vector3(),
    yaw: 0,
    pitch: 0,
    eye: STAND_EYE,
    height: STAND_HEIGHT,
    crouching: false,
    onGround: true,
    alive: true,
    health: 100,
    armor: 0,
    walkCycle: 0,
    deathTime: -1,
    group: new THREE.Group(),
  };

  const teamColor = TEAM_COLORS[team];
  const dark = PALETTE.hairline;
  const torso = limb(0.52, 0.62, 0.28, teamColor);
  torso.position.y = 1.13;
  const chestLight = new THREE.Mesh(
    new THREE.BoxGeometry(0.2, 0.06, 0.02),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(teamColor) }),
  );
  chestLight.position.set(0, 1.28, -0.15);
  const head = limb(0.25, 0.27, 0.25, '#c9a186');
  head.position.y = 1.6;
  const helmet = limb(0.29, 0.12, 0.29, dark);
  helmet.position.y = 1.72;
  const legL = limb(0.16, 0.8, 0.18, dark);
  legL.position.set(-0.13, 0.4, 0);
  const legR = limb(0.16, 0.8, 0.18, dark);
  legR.position.set(0.13, 0.4, 0);
  const armR = limb(0.11, 0.5, 0.11, teamColor);
  armR.position.set(0.2, 1.12, -0.22);
  armR.rotation.x = -1.15;
  const armL = limb(0.11, 0.44, 0.11, teamColor);
  armL.position.set(-0.16, 1.08, -0.2);
  armL.rotation.x = -1.3;
  const gunMesh = limb(0.07, 0.1, 0.55, dark, 0.5);
  gunMesh.position.set(0.1, 1.14, -0.42);
  actor.group.add(torso, chestLight, head, helmet, legL, legR, armR, armL, gunMesh);
  scene.add(actor.group);
  actor.parts3d = { torso, head, helmet, legL, legR, armR, armL, gunMesh };

  // Colliders are plain box records (see geometry.js), so the test is written out.
  function overlaps(x, y, z, height, lift) {
    const minX = x - RADIUS;
    const maxX = x + RADIUS;
    const minY = y + lift;
    const maxY = y + height - lift;
    const minZ = z - RADIUS;
    const maxZ = z + RADIUS;
    for (const c of colliders) {
      if (minX < c.maxX && maxX > c.minX && minY < c.maxY && maxY > c.minY && minZ < c.maxZ && maxZ > c.minZ) return c;
    }
    return null;
  }

  // wish is a world-space horizontal direction (not normalised by the caller when idle).
  function step(dt, wish, wantJump, wantCrouch) {
    if (!actor.alive) return;
    if (wantCrouch && !actor.crouching) {
      actor.crouching = true;
      actor.height = CROUCH_HEIGHT;
    } else if (!wantCrouch && actor.crouching && !overlaps(actor.position.x, actor.position.y, actor.position.z, STAND_HEIGHT, 0.02)) {
      actor.crouching = false;
      actor.height = STAND_HEIGHT;
    }
    const eyeTarget = actor.crouching ? CROUCH_EYE : STAND_EYE;
    actor.eye += (eyeTarget - actor.eye) * Math.min(1, dt * 11);

    const speed = actor.crouching ? CROUCH_SPEED : WALK_SPEED;
    const blend = Math.min(1, (actor.onGround ? GROUND_ACCEL : AIR_ACCEL) * dt / speed);
    actor.velocity.x += (wish.x * speed - actor.velocity.x) * blend;
    actor.velocity.z += (wish.z * speed - actor.velocity.z) * blend;
    if (actor.onGround && wish.x === 0 && wish.z === 0) {
      const damp = Math.max(0, 1 - FRICTION * dt);
      actor.velocity.x *= damp;
      actor.velocity.z *= damp;
    }
    if (wantJump && actor.onGround) {
      actor.velocity.y = JUMP_SPEED;
      actor.onGround = false;
    }
    actor.velocity.y -= GRAVITY * dt;

    const nextX = actor.position.x + actor.velocity.x * dt;
    if (!overlaps(nextX, actor.position.y, actor.position.z, actor.height, 0.04)) actor.position.x = nextX;
    else actor.velocity.x = 0;
    const nextZ = actor.position.z + actor.velocity.z * dt;
    if (!overlaps(actor.position.x, actor.position.y, nextZ, actor.height, 0.04)) actor.position.z = nextZ;
    else actor.velocity.z = 0;

    actor.position.y += actor.velocity.y * dt;
    actor.onGround = false;
    const hit = overlaps(actor.position.x, actor.position.y, actor.position.z, actor.height, 0);
    if (hit && actor.velocity.y <= 0) {
      actor.position.y = hit.maxY;
      actor.velocity.y = 0;
      actor.onGround = true;
    } else if (hit) {
      actor.position.y = hit.minY - actor.height;
      actor.velocity.y = 0;
    }
    if (actor.position.y < 0) {
      actor.position.y = 0;
      actor.velocity.y = 0;
      actor.onGround = true;
    }
    actor.velocity.y = Math.max(-30, actor.velocity.y);
    const groundSpeed = Math.hypot(actor.velocity.x, actor.velocity.z);
    actor.walkCycle += dt * groundSpeed * 1.9;
    return groundSpeed;
  }

  function parts() {
    const { x, y, z } = actor.position;
    const top = actor.crouching ? 1.16 : STAND_HEIGHT;
    const headBase = actor.crouching ? 0.9 : 1.42;
    const torsoBase = actor.crouching ? 0.4 : 0.78;
    const set = (entry, half, y0, y1) => {
      entry.box.minX = x - half;
      entry.box.maxX = x + half;
      entry.box.minZ = z - half;
      entry.box.maxZ = z + half;
      entry.box.minY = y + y0;
      entry.box.maxY = y + y1;
    };
    set(partScratch[0], 0.15, headBase, top);
    set(partScratch[1], 0.28, torsoBase, headBase);
    set(partScratch[2], 0.25, 0, torsoBase);
    return partScratch;
  }

  function updateVisual(dt) {
    const g = actor.group;
    g.position.copy(actor.position);
    if (!actor.alive) {
      // Fall sideways over half a second, then rest.
      const t = Math.min(1, (actor.deathTime >= 0 ? actor.deathTime : 0) / 0.45);
      g.rotation.set(0, actor.yaw, t * Math.PI * 0.48);
      g.position.y = actor.position.y + t * 0.12;
      return;
    }
    g.rotation.set(0, actor.yaw, 0);
    const speed = Math.hypot(actor.velocity.x, actor.velocity.z);
    const swing = Math.sin(actor.walkCycle) * Math.min(0.55, speed * 0.11);
    actor.parts3d.legL.rotation.x = swing;
    actor.parts3d.legR.rotation.x = -swing;
    const crouchDrop = actor.crouching ? 0.52 : 0;
    g.children.forEach((child) => {
      if (child !== actor.parts3d.legL && child !== actor.parts3d.legR) child.position.y = child.userData.baseY - crouchDrop;
    });
    actor.parts3d.torso.rotation.x = actor.pitch * 0.35;
  }

  actor.group.children.forEach((child) => {
    child.userData.baseY = child.position.y;
  });

  return {
    state: actor,
    step,
    parts,
    updateVisual,
    groundSpeed() {
      return Math.hypot(actor.velocity.x, actor.velocity.z);
    },
    eyePos(out) {
      out.set(actor.position.x, actor.position.y + actor.eye, actor.position.z);
      return out;
    },
    // Armour soaks half of what it can cover; the rest reaches health.
    applyDamage(amount) {
      if (!actor.alive) return 0;
      let dealt = amount;
      if (actor.armor > 0) {
        const soaked = Math.min(actor.armor, amount * 0.5);
        actor.armor -= soaked;
        dealt = amount - soaked;
      }
      actor.health -= dealt;
      if (actor.health <= 0) {
        actor.health = 0;
        actor.alive = false;
        actor.deathTime = 0;
      }
      return dealt;
    },
    reset(spawn, yaw) {
      actor.position.set(spawn.x, 0, spawn.z);
      actor.velocity.set(0, 0, 0);
      actor.yaw = yaw;
      actor.pitch = 0;
      actor.health = 100;
      actor.alive = true;
      actor.crouching = false;
      actor.height = STAND_HEIGHT;
      actor.eye = STAND_EYE;
      actor.deathTime = -1;
      actor.group.rotation.set(0, yaw, 0);
    },
  };
}
