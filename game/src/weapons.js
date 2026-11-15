// The armoury: four guns and three grenades, all original Sable Yard issue. A weapon def
// owns its numbers — damage by range, spread that grows with the shooter's speed, recoil,
// price — and builds its own first-person view model from boxes, so the gun in the
// screenshots is the gun the numbers describe. Damage falls off past falloffStart and a
// headshot multiplies it, which is what makes the Piercer a one-shot answer and the
// Raptor a close-range argument.
import * as THREE from 'three';
import { PALETTE } from './palette.js';

export const WEAPONS = {
  p9: {
    id: 'p9', name: 'P9 Sidearm', slot: 'sidearm', price: 0, damage: 34, headMult: 3.2,
    fireGap: 0.19, magSize: 12, reserveStart: 48, reloadTime: 1.1, auto: false,
    spreadStill: 0.004, spreadMove: 0.03, falloffStart: 14, falloffEnd: 42, minDamageScale: 0.5,
    recoilPitch: 0.011, pellets: 1, zoom: 1.12, soundPitch: 1.4, soundLength: 0.11,
  },
  raptor: {
    id: 'raptor', name: 'Raptor SMG', slot: 'primary', price: 1400, damage: 26, headMult: 2.6,
    fireGap: 0.075, magSize: 32, reserveStart: 96, reloadTime: 1.7, auto: true,
    spreadStill: 0.009, spreadMove: 0.034, falloffStart: 10, falloffEnd: 30, minDamageScale: 0.45,
    recoilPitch: 0.006, pellets: 1, zoom: 1.12, soundPitch: 1.25, soundLength: 0.09,
  },
  kr7: {
    id: 'kr7', name: 'KR-7 Carbine', slot: 'primary', price: 2700, damage: 40, headMult: 3.1,
    fireGap: 0.1, magSize: 30, reserveStart: 90, reloadTime: 1.9, auto: true,
    spreadStill: 0.0024, spreadMove: 0.03, falloffStart: 22, falloffEnd: 60, minDamageScale: 0.62,
    recoilPitch: 0.0095, pellets: 1, zoom: 1.18, soundPitch: 1.0, soundLength: 0.14,
  },
  piercer: {
    id: 'piercer', name: 'Piercer Long Rifle', slot: 'primary', price: 4300, damage: 112, headMult: 2.4,
    fireGap: 1.45, magSize: 5, reserveStart: 20, reloadTime: 2.6, auto: false,
    spreadStill: 0.0004, spreadMove: 0.06, falloffStart: 40, falloffEnd: 110, minDamageScale: 0.85,
    recoilPitch: 0.045, pellets: 1, zoom: 3.2, soundPitch: 0.7, soundLength: 0.3,
  },
};

export const GRENADES = {
  frag: { id: 'frag', name: 'Frag Grenade', price: 300, key: 'Digit3', radius: 6.5, maxDamage: 105 },
  flash: { id: 'flash', name: 'Flash Charge', price: 200, key: 'Digit4', radius: 17 },
  smoke: { id: 'smoke', name: 'Smoke Canister', price: 300, key: 'Digit5', radius: 3.4, duration: 13 },
};

export const ARMOR_PRICE = 1000;

export function damageAt(def, dist, part) {
  let scale = 1;
  if (dist > def.falloffStart) {
    const t = Math.min(1, (dist - def.falloffStart) / (def.falloffEnd - def.falloffStart));
    scale = 1 - t * (1 - def.minDamageScale);
  }
  const partMult = part === 'head' ? def.headMult : part === 'legs' ? 0.72 : 1;
  return def.damage * scale * partMult;
}

// The carried state of one gun: rounds where they belong, timers where they tick.
export function createGunState(def) {
  return {
    def,
    mag: def.magSize,
    reserve: def.reserveStart,
    cooldown: 0,
    reloadLeft: 0,
    triggerHeld: false,
  };
}

export function gunReady(gun) {
  return gun.mag > 0 && gun.cooldown <= 0 && gun.reloadLeft <= 0;
}

export function startReload(gun) {
  if (gun.reloadLeft > 0 || gun.mag >= gun.def.magSize || gun.reserve <= 0) return false;
  gun.reloadLeft = gun.def.reloadTime;
  return true;
}

export function stepGun(gun, dt) {
  gun.cooldown = Math.max(0, gun.cooldown - dt);
  if (gun.reloadLeft > 0) {
    gun.reloadLeft = Math.max(0, gun.reloadLeft - dt);
    if (gun.reloadLeft === 0) {
      const take = Math.min(gun.def.magSize - gun.mag, gun.reserve);
      gun.mag += take;
      gun.reserve -= take;
    }
  }
}

// Spread in radians for a shooter moving at speed (m/s), crouched or airborne. Standing
// still and crouching is the most accurate way to shoot; running is the least.
export function spreadFor(def, speed, crouching, airborne) {
  const moveT = Math.min(1, speed / 5.4);
  let spread = def.spreadStill + moveT * moveT * def.spreadMove;
  if (crouching) spread *= 0.72;
  if (airborne) spread += 0.035;
  return spread;
}

const viewMaterials = {
  body: new THREE.MeshStandardMaterial({ color: new THREE.Color('#2c3036'), roughness: 0.5, metalness: 0.4 }),
  grip: new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.hairline), roughness: 0.75, metalness: 0.15 }),
  accent: new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.lamp), roughness: 0.4, metalness: 0.3 }),
};

function part(w, h, d, x, y, z, mat = viewMaterials.body) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  mesh.position.set(x, y, z);
  return mesh;
}

// A first-person view model per gun, plus the muzzle point the flash and sounds hang off.
export function buildViewModel(def) {
  const model = new THREE.Group();
  if (def.id === 'p9') {
    model.add(part(0.055, 0.09, 0.24, 0, 0, 0));
    model.add(part(0.05, 0.12, 0.07, 0, -0.09, 0.07, viewMaterials.grip));
    model.add(part(0.012, 0.03, 0.012, 0, 0.06, -0.1, viewMaterials.accent));
  } else if (def.id === 'raptor') {
    model.add(part(0.07, 0.11, 0.4, 0, 0, 0));
    model.add(part(0.05, 0.16, 0.06, 0, -0.1, -0.02, viewMaterials.grip));
    model.add(part(0.04, 0.04, 0.22, 0, 0.02, -0.3, viewMaterials.grip));
    model.add(part(0.06, 0.05, 0.1, 0, 0.08, 0.05));
  } else if (def.id === 'piercer') {
    model.add(part(0.06, 0.09, 0.62, 0, 0, 0));
    model.add(part(0.03, 0.03, 0.5, 0, 0.03, -0.5, viewMaterials.grip));
    model.add(part(0.055, 0.07, 0.16, 0, 0.09, -0.05, viewMaterials.grip)); // scope
    model.add(part(0.05, 0.14, 0.07, 0, -0.09, 0.16, viewMaterials.grip));
    model.add(part(0.07, 0.08, 0.2, 0, -0.02, 0.34, viewMaterials.grip));
  } else {
    model.add(part(0.075, 0.11, 0.46, 0, 0, 0));
    model.add(part(0.04, 0.04, 0.34, 0, 0.03, -0.36, viewMaterials.grip));
    model.add(part(0.055, 0.15, 0.06, 0, -0.11, 0.02, viewMaterials.grip));
    model.add(part(0.05, 0.13, 0.05, 0, -0.09, -0.16, viewMaterials.grip));
    model.add(part(0.07, 0.07, 0.18, 0, -0.01, 0.3, viewMaterials.grip));
    model.add(part(0.014, 0.035, 0.014, 0, 0.075, -0.5, viewMaterials.accent));
  }
  model.position.set(0.23, -0.21, -0.45);
  const flash = new THREE.Mesh(
    new THREE.PlaneGeometry(0.3, 0.3),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(PALETTE.lamp), transparent: true, opacity: 0.95, depthWrite: false, side: THREE.DoubleSide }),
  );
  flash.position.set(0.23, -0.19, def.id === 'piercer' ? -1.2 : -0.85);
  flash.visible = false;
  const light = new THREE.PointLight(new THREE.Color(PALETTE.lamp), 0, 6);
  light.position.copy(flash.position);
  return { model, flash, light, kick: 0, flashLeft: 0 };
}

export function stepViewModel(view, gun, dt) {
  view.flashLeft = Math.max(0, view.flashLeft - dt);
  view.kick += (0 - view.kick) * Math.min(1, dt * 13);
  const reloading = gun.reloadLeft > 0;
  view.model.position.z = -0.45 + view.kick;
  view.model.rotation.x = view.kick * 2.4 + (reloading ? -0.5 * Math.min(1, (gun.def.reloadTime - gun.reloadLeft) * 2.4) : 0);
  view.flash.visible = view.flashLeft > 0;
  if (view.flash.visible) view.flash.rotation.z = view.flashLeft * 40;
  view.light.intensity = view.flashLeft > 0 ? 14 : 0;
}

export function fireViewModel(view) {
  view.kick = 0.05;
  view.flashLeft = 0.055;
}
