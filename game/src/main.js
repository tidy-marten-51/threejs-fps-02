// Sable Yard: a round-based tactical FPS in a freight depot at dusk. Wardens and Jackals
// trade halves attacking and defending two bomb sites; money earned in a round buys the
// next round's guns, armour and grenades. This file owns the match — the state machine
// (buy, live, planted, round end), combat resolution, the charge, the economy and the
// camera — while the modules own their crafts: map, actors, minds, weapons, effects,
// sound and HUD. The simulation steps at a fixed 60 Hz; rendering rides the display.
// ?shot=cover|buy|site|end with &seed=N stages a deterministic scene for a screenshot,
// renders it twice, freezes it and sets window.__shotReady.
import * as THREE from 'three';
import { PALETTE, TEAM_COLORS } from './palette.js';
import { createRng } from './rng.js';
import { createMap, SITES, SPAWNS, nearestNode } from './map.js';
import { rayBox, nearestRayHit } from './geometry.js';
import { createInput } from './input.js';
import { createActor } from './actor.js';
import { createMind } from './bots.js';
import { WEAPONS, GRENADES, ARMOR_PRICE, createGunState, gunReady, startReload, stepGun, spreadFor, damageAt, buildViewModel, stepViewModel, fireViewModel } from './weapons.js';
import { createEffects } from './effects.js';
import { createAudio } from './audio.js';
import { createHud, BUY_ITEMS } from './hud.js';

const FIXED_STEP = 1 / 60;
const ROUND_TIME = 100;
const BUY_TIME = 12;
const BOMB_TIME = 40;
const PLANT_TIME = 3.5;
const DEFUSE_TIME = 5;
const ROUNDS_TO_WIN = 5;
const MAX_ROUNDS = 9;

const params = new URLSearchParams(window.location.search);
const shot = params.get('shot');
const seed = Number.parseInt(params.get('seed') ?? '1', 10) || 1;
const rng = createRng(shot ? seed * 7919 : (Date.now() % 100000) + 1);

// ---------- scene ----------
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.12;
document.getElementById('game').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(PALETTE.sky);
scene.fog = new THREE.Fog(new THREE.Color(PALETTE.sky), 30, 95);
const camera = new THREE.PerspectiveCamera(74, window.innerWidth / window.innerHeight, 0.05, 220);
scene.add(camera);

const map = createMap(scene);
const effects = createEffects(scene);
const audio = createAudio();

// ---------- rosters ----------
const WARDEN_NAMES = ['You', 'Voss', 'Ibarra', 'Kett', 'Maren'];
const JACKAL_NAMES = ['Rook', 'Sable', 'Fen', 'Ostra', 'Grimm'];
const actors = [];
const minds = new Map();

function createLoadout() {
  return {
    primary: null,
    sidearm: createGunState(WEAPONS.p9),
    grenades: { frag: 0, flash: 0, smoke: 0 },
    slot: 'sidearm',
    currentGun() {
      if (this.slot === 'primary') return this.primary;
      if (this.slot === 'sidearm') return this.sidearm;
      return null;
    },
  };
}

let player = null;
for (let i = 0; i < 5; i += 1) {
  const a = createActor(scene, map.colliders, 'wardens', WARDEN_NAMES[i]);
  a.loadout = createLoadout();
  a.money = 800;
  a.kills = 0;
  a.deaths = 0;
  actors.push(a);
  if (i === 0) {
    player = a;
    a.state.isPlayer = true;
    a.state.group.visible = false;
  }
}
for (let i = 0; i < 5; i += 1) {
  const a = createActor(scene, map.colliders, 'jackals', JACKAL_NAMES[i]);
  a.loadout = createLoadout();
  a.money = 800;
  a.kills = 0;
  a.deaths = 0;
  actors.push(a);
}
for (const a of actors) {
  if (a !== player) minds.set(a, createMind(a, createRng(seed * 31 + actors.indexOf(a) * 101 + 7)));
}

// View models for the player's guns, built once and swapped on the camera.
const viewModels = new Map();
for (const def of Object.values(WEAPONS)) {
  const view = buildViewModel(def);
  view.model.visible = false;
  view.flash.visible = false;
  camera.add(view.model, view.flash, view.light);
  viewModels.set(def.id, view);
}
const grenadeView = new THREE.Mesh(
  new THREE.SphereGeometry(0.055, 12, 10),
  new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.steel), roughness: 0.5, metalness: 0.4 }),
);
grenadeView.position.set(0.23, -0.2, -0.4);
grenadeView.visible = false;
camera.add(grenadeView);

// ---------- match state ----------
const match = {
  phase: 'menu', // menu | buy | live | roundEnd | matchEnd
  round: 0,
  score: { wardens: 0, jackals: 0 },
  phaseTime: 0,
  time: 0,
  attacking: 'jackals', // round 1: Jackals attack from the east
  bomb: { carrier: null, dropped: null, planted: null, channel: null },
  stats: { shots: 0, hits: 0 },
  winner: null,
};

const hud = createHud({
  onPlay: () => {
    audio.wake();
    if (match.phase === 'matchEnd') startMatch();
    else if (match.phase === 'menu') startMatch();
    input.requestLock();
  },
  onBuy: (id) => buyItem(player, id, true),
});
hud.paintMinimapBase(map.footprints);

const input = createInput(renderer.domElement, onLockChange);
let uiHold = false; // buy menu or an overlay is up: losing the lock is not a pause

function otherTeam(team) {
  return team === 'wardens' ? 'jackals' : 'wardens';
}
function teamActors(team) {
  return actors.filter((a) => a.state.team === team);
}
function aliveCount(team) {
  return teamActors(team).filter((a) => a.state.alive).length;
}
function siteById(id) {
  return SITES.find((s) => s.id === id);
}

// ---------- economy ----------
function ownedSet(a) {
  const owned = new Set();
  if (a.loadout.primary) owned.add(a.loadout.primary.def.id);
  if (a.state.armor > 0) owned.add('armor');
  for (const [id, count] of Object.entries(a.loadout.grenades)) if (count > 0) owned.add(id);
  return owned;
}

function buyItem(a, id, byPlayer) {
  const loadout = a.loadout;
  if (id === 'armor') {
    if (a.state.armor > 0 || a.money < ARMOR_PRICE) { if (byPlayer) audio.denied(); return false; }
    a.money -= ARMOR_PRICE;
    a.state.armor = 100;
  } else if (GRENADES[id]) {
    if (loadout.grenades[id] > 0 || a.money < GRENADES[id].price) { if (byPlayer) audio.denied(); return false; }
    a.money -= GRENADES[id].price;
    loadout.grenades[id] += 1;
  } else {
    const def = WEAPONS[id];
    if (!def || (loadout.primary && loadout.primary.def.id === id) || a.money < def.price) { if (byPlayer) audio.denied(); return false; }
    a.money -= def.price;
    loadout.primary = createGunState(def);
    if (a === player) loadout.slot = 'primary';
  }
  if (byPlayer) {
    audio.buy();
    hud.refreshBuy(a.money, ownedSet(a));
    hud.setMoney(a.money);
  }
  return true;
}

function botBuy(a) {
  const r = rng;
  if (!a.loadout.primary) {
    if (a.money >= WEAPONS.piercer.price && r.chance(0.22)) buyItem(a, 'piercer', false);
    else if (a.money >= WEAPONS.kr7.price) buyItem(a, 'kr7', false);
    else if (a.money >= WEAPONS.raptor.price && r.chance(0.75)) buyItem(a, 'raptor', false);
  }
  if (a.state.armor <= 0 && a.money >= ARMOR_PRICE && r.chance(0.8)) buyItem(a, 'armor', false);
  if (r.chance(0.4)) buyItem(a, 'frag', false);
  if (r.chance(0.25)) buyItem(a, 'flash', false);
  if (r.chance(0.2)) buyItem(a, 'smoke', false);
  a.loadout.slot = a.loadout.primary ? 'primary' : 'sidearm';
}

// ---------- plans ----------
const HOLD_POINTS = {
  A: [
    { x: -17.5, z: -9.5, watch: [-30, -16] }, { x: -26, z: -18.5, watch: [-8, -14] }, { x: -13.5, z: -16, watch: [-26, -8] },
  ],
  B: [
    { x: 16.5, z: 10.5, watch: [28, 20] }, { x: 25.5, z: 18, watch: [10, 12] }, { x: 15, z: 17.5, watch: [30, 8] },
  ],
  mid: [
    { x: -10.5, z: -1.5, watch: [14, 0] }, { x: 10.5, z: 1.5, watch: [-14, 0] }, { x: -1.5, z: -6.5, watch: [6, -16] }, { x: 1.5, z: 6.5, watch: [-6, 16] },
  ],
};

function holdPlan(point) {
  return {
    kind: 'hold', x: point.x, z: point.z,
    watchYaw: Math.atan2(-(point.watch[0] - point.x), -(point.watch[1] - point.z)),
  };
}

function assignPlans() {
  const attackTeam = match.attacking;
  const defendTeam = otherTeam(attackTeam);
  const site = siteById(rng.chance(0.5) ? 'A' : 'B');
  const otherSite = siteById(site.id === 'A' ? 'B' : 'A');
  const attackers = teamActors(attackTeam).filter((a) => a.state.alive);
  const defenders = teamActors(defendTeam).filter((a) => a.state.alive);

  // The carrier: a bot if the player is attacking (the player may volunteer by picking
  // it up), otherwise a random attacker.
  const botAttackers = attackers.filter((a) => a !== player);
  const carrier = attackTeam === player.state.team && rng.chance(0.25)
    ? player
    : botAttackers[rng.int(0, botAttackers.length - 1)] ?? attackers[0];
  match.bomb.carrier = carrier;
  match.bomb.dropped = null;
  match.bomb.planted = null;
  match.bomb.channel = null;
  effects.clearBomb();

  attackers.forEach((a, i) => {
    if (a === player) return;
    const mind = minds.get(a);
    if (a === carrier) {
      mind.setPlan({ kind: 'plant', x: site.x, z: site.z, site: site.id, faceX: site.x + (site.x > 0 ? -6 : 6), faceZ: site.z });
    } else if (i % 3 === 2) {
      mind.setPlan({ kind: 'route', x: otherSite.x + rng.range(-3, 3), z: otherSite.z + rng.range(-3, 3), watchYaw: a.state.yaw });
    } else if (i % 3 === 1) {
      const mid = HOLD_POINTS.mid[rng.int(0, HOLD_POINTS.mid.length - 1)];
      mind.setPlan(holdPlan(mid));
    } else {
      const point = HOLD_POINTS[site.id][i % HOLD_POINTS[site.id].length];
      mind.setPlan({ kind: 'route', x: point.x, z: point.z, watchYaw: holdPlan(point).watchYaw });
    }
    mind.grenadeUsed = false;
  });
  defenders.forEach((a, i) => {
    if (a === player) return;
    const mind = minds.get(a);
    const home = i % 2 === 0 ? 'A' : 'B';
    const point = HOLD_POINTS[home][Math.floor(i / 2) % HOLD_POINTS[home].length];
    mind.setPlan(i === 4 ? holdPlan(HOLD_POINTS.mid[rng.int(0, 3)]) : holdPlan(point));
    mind.grenadeUsed = false;
  });
}

function plansForPlant(site) {
  const defendTeam = otherTeam(match.attacking);
  let defuser = null;
  let bestDist = Infinity;
  for (const a of teamActors(defendTeam)) {
    if (!a.state.alive || a === player) continue;
    const d = Math.hypot(a.state.position.x - site.x, a.state.position.z - site.z);
    if (d < bestDist) {
      bestDist = d;
      defuser = a;
    }
  }
  for (const a of teamActors(defendTeam)) {
    if (!a.state.alive || a === player) continue;
    const mind = minds.get(a);
    if (a === defuser) {
      mind.setPlan({ kind: 'defuse', x: site.x, z: site.z, faceX: site.x, faceZ: site.z });
    } else {
      const point = HOLD_POINTS[site.id][rng.int(0, 2)];
      mind.setPlan({ kind: 'route', x: point.x, z: point.z, watchYaw: holdPlan(point).watchYaw });
    }
  }
  for (const a of teamActors(match.attacking)) {
    if (!a.state.alive || a === player) continue;
    const point = HOLD_POINTS[site.id][rng.int(0, 2)];
    minds.get(a).setPlan(holdPlan(point));
  }
}

// ---------- combat ----------
const eyeScratch = new THREE.Vector3();
const muzzleScratch = new THREE.Vector3();
const hitScratch = new THREE.Vector3();

function muzzleOf(a) {
  const s = a.state;
  const fx = -Math.sin(s.yaw);
  const fz = -Math.cos(s.yaw);
  muzzleScratch.set(s.position.x + fx * 0.5, s.position.y + 1.32, s.position.z + fz * 0.5);
  return muzzleScratch;
}

function notifyShot(shooter) {
  for (const [bot, mind] of minds) {
    if (bot.state.team !== shooter.state.team && bot.state.alive) {
      mind.hearNoise(shooter.state.position.x, shooter.state.position.z, match.time);
    }
  }
}

// One trigger pull from one actor. Returns true when a round actually left the gun.
function fireGun(shooter, aimError = 0) {
  const gun = shooter.loadout.currentGun();
  if (!gun || !gunReady(gun)) return false;
  const def = gun.def;
  gun.mag -= 1;
  gun.cooldown = def.fireGap;
  const s = shooter.state;
  const speed = Math.hypot(s.velocity.x, s.velocity.z);
  let spread = spreadFor(def, speed, s.crouching, !s.onGround);
  if (shooter !== player) spread = Math.max(spread, aimError);
  const gauss = () => (rng.next() + rng.next() + rng.next() - 1.5) / 1.5;
  const yaw = s.yaw + gauss() * spread;
  const pitch = s.pitch + gauss() * spread * 0.8;
  const dx = -Math.sin(yaw) * Math.cos(pitch);
  const dy = Math.sin(pitch);
  const dz = -Math.cos(yaw) * Math.cos(pitch);
  shooter.eyePos(eyeScratch);
  const from = { x: eyeScratch.x, y: eyeScratch.y, z: eyeScratch.z };

  const worldHit = nearestRayHit(from.x, from.y, from.z, dx, dy, dz, map.colliders, 120);
  let bestDist = worldHit ? worldHit.dist : 120;
  let bestActor = null;
  let bestPart = null;
  for (const other of actors) {
    if (other === shooter || !other.state.alive) continue;
    for (const entry of other.parts()) {
      const t = rayBox(from.x, from.y, from.z, dx, dy, dz, entry.box);
      if (t < bestDist) {
        bestDist = t;
        bestActor = other;
        bestPart = entry.part;
      }
    }
  }
  hitScratch.set(from.x + dx * bestDist, from.y + dy * bestDist, from.z + dz * bestDist);
  const muzzle = muzzleOf(shooter);
  if (shooter === player) {
    // The player's tracer starts at the view model's muzzle (low right), not the body axis.
    muzzle.x += -dz * 0.22;
    muzzle.z += dx * 0.22;
    muzzle.y -= 0.18;
  }
  effects.tracer(muzzle, hitScratch);
  audio.shot(def, shooter === player ? 0 : Math.hypot(s.position.x - player.state.position.x, s.position.z - player.state.position.z));

  if (bestActor) {
    const wasAlive = bestActor.state.alive;
    const dealt = bestActor.applyDamage(damageAt(def, bestDist, bestPart));
    effects.burst(hitScratch, 7, TEAM_COLORS[bestActor.state.team], 1.6, 1.1);
    if (shooter === player) {
      match.stats.hits += 1;
      audio.hit(!bestActor.state.alive);
      hud.hitMarker(!bestActor.state.alive);
    }
    if (bestActor === player) {
      hud.damageFlash(0.85);
      audio.hurt();
    }
    if (wasAlive && !bestActor.state.alive) onKill(shooter, bestActor, bestPart === 'head');
  } else if (worldHit) {
    effects.burst(hitScratch, 5, PALETTE.lamp, 2.2, 1.4);
  }
  // Recoil: the muzzle climbs; a bot's aim model absorbs most of it, the player's does not.
  s.pitch = Math.min(1.45, s.pitch + def.recoilPitch * (shooter === player ? 1 : 0.25));
  if (shooter === player) {
    fireViewModel(viewModels.get(def.id));
    match.stats.shots += 1;
  }
  notifyShot(shooter);
  return true;
}

function onKill(killer, victim, headshot) {
  killer.kills += 1;
  victim.deaths += 1;
  killer.money += 300;
  hud.killfeed(killer.state.name, killer.state.team, victim.state.name, victim.state.team, headshot);
  if (match.bomb.carrier === victim) {
    match.bomb.carrier = null;
    match.bomb.dropped = { x: victim.state.position.x, z: victim.state.position.z };
    effects.setDropped(match.bomb.dropped.x, match.bomb.dropped.z);
    // The nearest attacking bot goes for the charge.
    let best = null;
    let bestDist = Infinity;
    for (const a of teamActors(match.attacking)) {
      if (!a.state.alive || a === player) continue;
      const d = Math.hypot(a.state.position.x - match.bomb.dropped.x, a.state.position.z - match.bomb.dropped.z);
      if (d < bestDist) {
        bestDist = d;
        best = a;
      }
    }
    if (best) minds.get(best).setPlan({ kind: 'route', x: match.bomb.dropped.x, z: match.bomb.dropped.z, watchYaw: best.state.yaw, pickup: true });
  }
  checkElimination();
}

function checkElimination() {
  if (match.phase !== 'live') return;
  const defending = otherTeam(match.attacking);
  if (match.bomb.planted) {
    // With the charge down, wiping the defenders ends it at once; wiping the attackers
    // does not — the defenders can still defuse, and the attackers can still win on the timer.
    if (aliveCount(defending) === 0) endRound(match.attacking, 'elimination');
    return;
  }
  if (aliveCount('wardens') === 0) endRound('jackals', 'elimination');
  else if (aliveCount('jackals') === 0) endRound('wardens', 'elimination');
}

// ---------- grenades ----------
const projectiles = [];
const grenadeGeo = new THREE.SphereGeometry(0.07, 10, 8);
const grenadeMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.steel), roughness: 0.45, metalness: 0.4 });

function throwGrenade(a, kind) {
  const s = a.state;
  if (a.loadout.grenades[kind] <= 0) return false;
  a.loadout.grenades[kind] -= 1;
  const mesh = new THREE.Mesh(grenadeGeo, grenadeMat);
  scene.add(mesh);
  const pitch = s.pitch + 0.16;
  const speed = 15.5;
  projectiles.push({
    kind,
    team: s.team,
    thrower: a,
    mesh,
    x: s.position.x, y: s.position.y + s.eye - 0.1, z: s.position.z,
    vx: -Math.sin(s.yaw) * Math.cos(pitch) * speed,
    vy: Math.sin(pitch) * speed + 2.2,
    vz: -Math.cos(s.yaw) * Math.cos(pitch) * speed,
    fuse: kind === 'frag' ? 1.35 : kind === 'flash' ? 1.05 : Infinity,
    landed: false,
  });
  audio.throwWhoosh();
  return true;
}

function pointInColliders(x, y, z, pad) {
  for (const c of map.colliders) {
    if (x > c.minX - pad && x < c.maxX + pad && y > c.minY - pad && y < c.maxY + pad && z > c.minZ - pad && z < c.maxZ + pad) return c;
  }
  return null;
}

function detonate(p) {
  if (p.kind === 'frag') {
    effects.burst({ x: p.x, y: p.y, z: p.z }, 26, PALETTE.lamp, 5, 3.4);
    audio.explosion();
    for (const a of actors) {
      if (!a.state.alive) continue;
      const chest = { x: a.state.position.x, y: a.state.position.y + 1.1, z: a.state.position.z };
      const dist = Math.hypot(chest.x - p.x, chest.y - p.y, chest.z - p.z);
      if (dist > GRENADES.frag.radius) continue;
      const blocked = map.sightBlockers.some((c) => {
        const dx = chest.x - p.x;
        const dy = chest.y - p.y;
        const dz = chest.z - p.z;
        const len = Math.hypot(dx, dy, dz) || 1;
        const t = rayBox(p.x, p.y, p.z, dx / len, dy / len, dz / len, c);
        return t < len;
      });
      if (blocked) continue;
      const fall = 1 - dist / (GRENADES.frag.radius + 1.5);
      let amount = GRENADES.frag.maxDamage * fall;
      if (a.state.team === p.team && a !== p.thrower) amount *= 0.5;
      const wasAlive = a.state.alive;
      a.applyDamage(amount);
      if (a === player) hud.damageFlash(0.9);
      if (wasAlive && !a.state.alive) onKill(p.thrower, a, false);
    }
  } else if (p.kind === 'flash') {
    effects.burst({ x: p.x, y: p.y, z: p.z }, 18, '#ffffff', 3, 2);
    audio.flashbang();
    for (const a of actors) {
      if (!a.state.alive) continue;
      const dx = p.x - a.state.position.x;
      const dz = p.z - a.state.position.z;
      const dist = Math.hypot(dx, dz);
      if (dist > GRENADES.flash.radius) continue;
      const fx = -Math.sin(a.state.yaw);
      const fz = -Math.cos(a.state.yaw);
      const facing = (dx * fx + dz * fz) / (dist || 1);
      if (facing < 0.15 && a !== p.thrower) continue;
      const strength = Math.max(0, 1 - dist / GRENADES.flash.radius) * (0.35 + 0.65 * Math.max(0, facing));
      if (a === player) effects.flashOverlay.strength = Math.max(effects.flashOverlay.strength, strength);
      else {
        const mind = minds.get(a);
        if (mind) mind.blindUntil = match.time + strength * 3.2;
      }
    }
  } else if (p.kind === 'smoke') {
    effects.smoke(p.x, p.z, GRENADES.smoke.radius, GRENADES.smoke.duration);
  }
}

function stepProjectiles(dt) {
  for (let i = projectiles.length - 1; i >= 0; i -= 1) {
    const p = projectiles[i];
    p.fuse -= dt;
    if (!p.landed) {
      p.vy -= 16 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      const hit = pointInColliders(p.x, p.y, p.z, 0.05);
      if (p.y <= 0.08 || hit) {
        if (p.kind === 'smoke') {
          p.y = Math.max(0.1, p.y);
          detonate(p);
          scene.remove(p.mesh);
          projectiles.splice(i, 1);
          continue;
        }
        p.landed = true;
        p.y = Math.max(0.08, p.y);
        p.vx = 0;
        p.vy = 0;
        p.vz = 0;
      }
    }
    p.mesh.position.set(p.x, p.y, p.z);
    if (p.fuse <= 0) {
      detonate(p);
      scene.remove(p.mesh);
      projectiles.splice(i, 1);
    }
  }
}

// ---------- round flow ----------
function refillGuns(a) {
  for (const gun of [a.loadout.primary, a.loadout.sidearm]) {
    if (!gun) continue;
    const need = gun.def.magSize - gun.mag;
    const take = Math.min(need, gun.reserve);
    gun.mag += take;
    gun.reserve -= take;
    if (gun.reserve < 12) gun.reserve = Math.max(gun.reserve, Math.floor(gun.def.reserveStart * 0.4));
    gun.cooldown = 0;
    gun.reloadLeft = 0;
  }
}

function startMatch() {
  match.score.wardens = 0;
  match.score.jackals = 0;
  match.round = 0;
  match.winner = null;
  match.stats = { shots: 0, hits: 0 };
  for (const a of actors) {
    a.money = 800;
    a.kills = 0;
    a.deaths = 0;
    a.loadout = createLoadout();
    a.state.armor = 0;
  }
  hud.showHud();
  startRound();
}

function startRound() {
  match.round += 1;
  match.attacking = match.round <= 4 ? 'jackals' : 'wardens';
  const defending = otherTeam(match.attacking);
  for (const a of actors) {
    const wasDead = !a.state.alive;
    if (wasDead) {
      a.loadout = createLoadout();
      a.state.armor = 0;
    } else {
      refillGuns(a);
    }
    const spawnSet = a.state.team === match.attacking ? SPAWNS.east : SPAWNS.west;
    const index = teamActors(a.state.team).indexOf(a);
    const spawn = spawnSet[index % spawnSet.length];
    a.reset(spawn, a.state.team === match.attacking ? Math.PI / 2 : -Math.PI / 2);
    a.loadout.slot = a.loadout.primary ? 'primary' : 'sidearm';
  }
  for (const p of projectiles) scene.remove(p.mesh);
  projectiles.length = 0;
  input.takePressed(); // keys pressed during the round-end pause buy nothing by accident
  assignPlans();
  for (const a of actors) if (a !== player) botBuy(a);
  match.phase = 'buy';
  match.phaseTime = BUY_TIME;
  hud.setScore(match.score.wardens, match.score.jackals, 5, 5);
  hud.setBombStatus(null);
  hud.progress(null);
  hud.banner(`ROUND ${match.round}`, match.attacking === player.state.team ? 'Your team attacks — plant the charge' : 'Your team defends the yard', 2400);
  syncViewModel();
  if (!shot) {
    uiHold = true;
    hud.showBuy(match.round, player.money, ownedSet(player));
    if (document.pointerLockElement) document.exitPointerLock();
  }
}

function endRound(winner, reason) {
  if (match.phase !== 'live') return;
  match.phase = 'roundEnd';
  match.phaseTime = 4.6;
  match.score[winner] += 1;
  const loser = otherTeam(winner);
  for (const a of teamActors(winner)) a.money += 2500;
  for (const a of teamActors(loser)) a.money += 1800;
  const reasonText = {
    elimination: 'Elimination',
    detonation: 'The charge went off',
    defused: 'Charge defused',
    time: 'The yard holds — time expired',
  }[reason];
  hud.banner(`${winner.toUpperCase()} TAKE THE ROUND`, reasonText, 3400);
  hud.setBombStatus(null);
  hud.progress(null);
  hud.setScore(match.score.wardens, match.score.jackals, aliveCount('wardens'), aliveCount('jackals'));
  audio.stinger(player.state.team === winner);
  effects.clearBomb();
  match.bomb.planted = null;
  match.bomb.channel = null;
}

function endMatch() {
  match.phase = 'matchEnd';
  match.winner = match.score.wardens > match.score.jackals ? 'wardens' : 'jackals';
  const accuracy = match.stats.shots > 0 ? Math.round((match.stats.hits / match.stats.shots) * 100) : 0;
  const stats = `${match.winner.toUpperCase()} WIN ${match.score.wardens} — ${match.score.jackals}\nYour line: ${player.kills} kills · ${player.deaths} deaths · ${accuracy}% accuracy`;
  hud.showOverlay('end', stats);
  if (document.pointerLockElement) document.exitPointerLock();
}

// ---------- the charge ----------
function stepBomb(dt, intents) {
  const bomb = match.bomb;
  if (bomb.planted) {
    bomb.planted.timer -= dt;
    const planted = bomb.planted;
    effects.setBomb(planted.x, planted.z, 1 - planted.timer / BOMB_TIME);
    hud.setBombStatus(`CHARGE PLANTED — ${Math.max(0, Math.ceil(planted.timer))}s`);
    planted.beepIn -= dt;
    if (planted.beepIn <= 0) {
      planted.beepIn = Math.max(0.18, planted.timer / BOMB_TIME) * 0.9;
      audio.beep(planted.timer < 5);
    }
    if (planted.timer <= 0) {
      effects.burst({ x: planted.x, y: 1, z: planted.z }, 40, PALETTE.lamp, 8, 5);
      audio.explosion();
      for (const a of actors) {
        if (!a.state.alive) continue;
        const dist = Math.hypot(a.state.position.x - planted.x, a.state.position.z - planted.z);
        if (dist < 10) {
          const wasAlive = a.state.alive;
          a.applyDamage(160 * (1 - dist / 11));
          if (wasAlive && !a.state.alive) {
            const killer = planted.planter && planted.planter !== a
              ? planted.planter
              : teamActors(match.attacking).find((x) => x !== a);
            if (killer) onKill(killer, a, false);
          }
        }
      }
      endRound(match.attacking, 'detonation');
      return;
    }
  }

  // Pickup: an attacker standing on the dropped charge takes it.
  if (bomb.dropped && !bomb.planted) {
    for (const a of teamActors(match.attacking)) {
      if (!a.state.alive) continue;
      if (Math.hypot(a.state.position.x - bomb.dropped.x, a.state.position.z - bomb.dropped.z) < 1.3) {
        bomb.carrier = a;
        bomb.dropped = null;
        effects.clearBomb();
        if (a !== player) {
          const site = SITES.reduce((best, s) => {
            const d = Math.hypot(s.x - a.state.position.x, s.z - a.state.position.z);
            return !best || d < best.d ? { s, d } : best;
          }, null).s;
          minds.get(a).setPlan({ kind: 'plant', x: site.x, z: site.z, site: site.id, faceX: site.x + (site.x > 0 ? -6 : 6), faceZ: site.z });
        }
        break;
      }
    }
  }

  // Channels: one at a time, held by standing in place and holding the action.
  let channel = null;
  if (!bomb.planted && bomb.carrier && bomb.carrier.state.alive) {
    const carrier = bomb.carrier;
    const site = SITES.find((s) => Math.hypot(carrier.state.position.x - s.x, carrier.state.position.z - s.z) <= s.radius);
    if (site) {
      const acting = carrier === player
        ? input.state.keys.has('KeyE')
        : intents.get(carrier)?.action === 'plant';
      if (acting) channel = { kind: 'plant', actor: carrier, site };
    }
  }
  if (bomb.planted) {
    for (const a of teamActors(otherTeam(match.attacking))) {
      if (!a.state.alive) continue;
      if (Math.hypot(a.state.position.x - bomb.planted.x, a.state.position.z - bomb.planted.z) > 1.9) continue;
      const acting = a === player
        ? input.state.keys.has('KeyE')
        : intents.get(a)?.action === 'defuse';
      if (acting) {
        channel = { kind: 'defuse', actor: a, site: bomb.planted.site };
        break;
      }
    }
  }
  if (channel) {
    if (!bomb.channel || bomb.channel.kind !== channel.kind || bomb.channel.actor !== channel.actor) {
      bomb.channel = { ...channel, progress: 0 };
    }
    bomb.channel.progress += dt / (channel.kind === 'plant' ? PLANT_TIME : DEFUSE_TIME);
    if (bomb.channel.actor === player || bomb.planted) {
      hud.progress(Math.min(1, bomb.channel.progress), channel.kind === 'plant' ? 'Planting the charge' : 'Defusing the charge');
    }
    if (bomb.channel.progress >= 1) {
      if (channel.kind === 'plant') {
        const planter = channel.actor;
        planter.money += 300;
        bomb.planted = { x: planter.state.position.x, z: planter.state.position.z, site: channel.site, timer: BOMB_TIME, beepIn: 0, planter };
        bomb.carrier = null;
        bomb.channel = null;
        effects.setBomb(bomb.planted.x, bomb.planted.z, 0);
        audio.plantDone();
        hud.progress(null);
        hud.banner('CHARGE PLANTED', `${channel.site.name} — ${BOMB_TIME} seconds`, 2200);
        plansForPlant(channel.site);
      } else {
        channel.actor.money += 300;
        bomb.channel = null;
        hud.progress(null);
        endRound(otherTeam(match.attacking), 'defused');
      }
    }
  } else {
    bomb.channel = null;
    if (match.phase === 'live') hud.progress(null);
  }
}

// ---------- stepping ----------
const botCtx = { time: 0, graph: map.graph, sightBlockers: map.sightBlockers, actors, smokes: effects.smokes };
const intents = new Map();
for (const a of actors) {
  if (a !== player) intents.set(a, { wishX: 0, wishZ: 0, jump: false, crouch: false, wantFire: false, wantReload: false, action: null, wantGrenade: null, yaw: 0, pitch: 0, aimError: 0.02 });
}
let prevFiring = false;
let footstepAcc = 0;

function stepBots(dt) {
  botCtx.time = match.time;
  botCtx.smokes = effects.smokes;
  for (const [bot, mind] of minds) {
    const s = bot.state;
    if (!s.alive) continue;
    const intent = mind.update(dt, botCtx, intents.get(bot));
    s.yaw = intent.yaw;
    s.pitch = Math.max(-1.45, Math.min(1.45, intent.pitch));
    bot.step(dt, { x: intent.wishX, z: intent.wishZ }, intent.jump, intent.crouch);
    for (const gun of [bot.loadout.primary, bot.loadout.sidearm]) if (gun) stepGun(gun, dt);
    const gun = bot.loadout.currentGun();
    if (intent.wantReload && gun) {
      if (startReload(gun) && Math.hypot(s.position.x - player.state.position.x, s.position.z - player.state.position.z) < 9) audio.reload();
    }
    if (intent.wantGrenade) throwGrenade(bot, intent.wantGrenade);
    else if (intent.wantFire) fireGun(bot, intent.aimError ?? 0.02);
  }
}

function stepPlayer(dt) {
  const s = player.state;
  if (!s.alive) return;
  const look = input.takeLook();
  s.yaw -= look.x * 0.0022;
  s.pitch = Math.max(-1.45, Math.min(1.45, s.pitch - look.y * 0.0022));
  const keys = input.state.keys;
  const forward = (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0);
  const strafe = (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0);
  const sin = Math.sin(s.yaw);
  const cos = Math.cos(s.yaw);
  const wish = { x: -sin * forward + cos * strafe, z: -cos * forward - sin * strafe };
  const len = Math.hypot(wish.x, wish.z);
  if (len > 0) {
    wish.x /= len;
    wish.z /= len;
  }
  if (keys.has('ShiftLeft') || keys.has('ShiftRight')) {
    wish.x *= 0.52;
    wish.z *= 0.52;
  }
  const crouch = keys.has('ControlLeft') || keys.has('ControlRight') || keys.has('KeyC');
  const speedBefore = Math.hypot(s.velocity.x, s.velocity.z);
  player.step(dt, wish, keys.has('Space'), crouch);
  const speedAfter = Math.hypot(s.velocity.x, s.velocity.z);
  footstepAcc += speedAfter * dt;
  if (footstepAcc > 3.4 && speedAfter > 4) {
    footstepAcc = 0;
    for (const [bot, mind] of minds) {
      if (bot.state.team !== s.team && bot.state.alive) mind.hearNoise(s.position.x, s.position.z, match.time, 13);
    }
  }
  void speedBefore;

  // Slot selection and gun handling.
  let slotChanged = false;
  for (const code of input.takePressed()) {
    if (code === 'Digit1' && player.loadout.primary) { player.loadout.slot = 'primary'; slotChanged = true; }
    else if (code === 'Digit2') { player.loadout.slot = 'sidearm'; slotChanged = true; }
    else if (code === 'Digit3' && player.loadout.grenades.frag > 0) { player.loadout.slot = 'frag'; slotChanged = true; }
    else if (code === 'Digit4' && player.loadout.grenades.flash > 0) { player.loadout.slot = 'flash'; slotChanged = true; }
    else if (code === 'Digit5' && player.loadout.grenades.smoke > 0) { player.loadout.slot = 'smoke'; slotChanged = true; }
    else if (code === 'KeyR') {
      const gun = player.loadout.currentGun();
      if (gun && startReload(gun)) audio.reload();
    } else if (code === 'KeyB' && match.phase === 'buy') {
      closeBuy();
    }
  }
  if (slotChanged) syncViewModel();
  const slot = player.loadout.slot;
  const gun = player.loadout.currentGun();
  const firing = input.state.firing;
  if (gun) {
    stepGun(gun, dt);
    const clicked = firing && !prevFiring;
    if (firing && (gun.def.auto || clicked)) {
      if (gun.mag <= 0) {
        if (clicked) {
          audio.dryFire();
          if (startReload(gun)) audio.reload();
        }
      } else {
        fireGun(player);
      }
    }
  } else if (firing && !prevFiring && GRENADES[slot]) {
    if (throwGrenade(player, slot)) {
      player.loadout.slot = player.loadout.primary ? 'primary' : 'sidearm';
      syncViewModel();
    }
  }
  prevFiring = firing;
  // The other gun's timers tick too, so a swapped-away reload still finishes.
  const other = slot === 'primary' ? player.loadout.sidearm : player.loadout.primary;
  if (other && other !== gun) stepGun(other, dt);
}

function stepLive(dt) {
  match.time += dt;
  match.phaseTime -= dt;
  stepBots(dt);
  stepPlayer(dt);
  stepProjectiles(dt);
  stepBomb(dt, intents);
  if (!match.bomb.planted && match.phaseTime <= 0 && match.phase === 'live') {
    endRound(otherTeam(match.attacking), 'time');
  }
}

function stepSim(dt) {
  if (match.phase === 'live') stepLive(dt);
  else if (match.phase === 'buy') {
    match.phaseTime -= dt;
    for (const code of input.takePressed()) {
      if (code === 'KeyB' || code === 'Escape') {
        closeBuy();
        break;
      }
      const item = BUY_ITEMS.find((entry) => `Digit${entry.key}` === code);
      if (item) buyItem(player, item.id, true);
    }
    if (match.phase === 'buy' && match.phaseTime <= 0) closeBuy();
  } else if (match.phase === 'roundEnd') {
    match.phaseTime -= dt;
    for (const a of actors) if (!a.state.alive) a.state.deathTime += dt;
    if (match.phaseTime <= 0) {
      if (match.score.wardens >= ROUNDS_TO_WIN || match.score.jackals >= ROUNDS_TO_WIN || match.round >= MAX_ROUNDS) endMatch();
      else startRound();
    }
  }
  if (match.phase === 'live') {
    for (const a of actors) if (!a.state.alive) a.state.deathTime += dt;
  }
  effects.step(dt, match.time);
  for (const a of actors) a.updateVisual(dt);
}

// ---------- buy menu ----------
function closeBuy() {
  if (match.phase !== 'buy') return;
  hud.hideBuy();
  uiHold = false;
  match.phase = 'live';
  match.phaseTime = ROUND_TIME;
  syncViewModel();
  hud.banner(match.attacking === player.state.team ? 'ATTACK — PLANT THE CHARGE' : 'DEFEND THE YARD', `Round ${match.round} of ${MAX_ROUNDS}`, 1800);
  if (!shot && player.state.alive) input.requestLock();
}

// ---------- pointer lock / pause ----------
function onLockChange(locked) {
  if (shot) return;
  if (locked) {
    hud.hideOverlay();
  } else if (!uiHold && (match.phase === 'live' || match.phase === 'buy') && match.phase !== 'menu') {
    const accuracy = match.stats.shots > 0 ? Math.round((match.stats.hits / match.stats.shots) * 100) : 0;
    hud.showOverlay('paused', `Round ${match.round} · Score ${match.score.wardens} — ${match.score.jackals}\nYour line: ${player.kills} kills · ${player.deaths} deaths · ${accuracy}% accuracy`);
  }
}

// ---------- view models & camera ----------
function syncViewModel() {
  const slot = player.loadout.slot;
  for (const [id, view] of viewModels) {
    const gun = player.loadout.currentGun();
    const active = gun && gun.def.id === id && (slot === 'primary' || slot === 'sidearm');
    view.model.visible = active;
    if (!active) {
      view.flash.visible = false;
      view.light.intensity = 0;
    }
  }
  grenadeView.visible = !player.loadout.currentGun() && !!GRENADES[slot];
}

let currentFov = 74;
function syncCamera(dt) {
  const s = player.state;
  if (match.phase === 'menu') {
    const t = performance.now() / 1000;
    camera.position.set(Math.sin(t * 0.07) * 30, 13, Math.cos(t * 0.07) * 30);
    camera.lookAt(0, 0, 0);
    camera.fov = 58;
    camera.updateProjectionMatrix();
    return;
  }
  if (!s.alive && match.phase !== 'menu') {
    // Death cam: rise above the spot and watch the yard.
    camera.position.set(s.position.x, s.position.y + 7.5, s.position.z + 5);
    camera.lookAt(0, 0, 0);
    return;
  }
  camera.position.set(s.position.x, s.position.y + s.eye, s.position.z);
  camera.rotation.set(s.pitch, s.yaw, 0, 'YXZ');
  const gun = player.loadout.currentGun();
  const aiming = input.state.aiming && gun && !hud.buyOpen();
  const targetFov = aiming ? 74 / gun.def.zoom : 74;
  currentFov += (targetFov - currentFov) * Math.min(1, dt * 11);
  camera.fov = currentFov;
  camera.updateProjectionMatrix();
  const scoped = !!(aiming && gun.def.id === 'piercer' && currentFov < 30);
  hud.setScope(scoped);
  const view = gun ? viewModels.get(gun.def.id) : null;
  if (view) {
    stepViewModel(view, gun, dt);
    view.model.visible = !scoped;
  }
  grenadeView.visible = !gun && !!GRENADES[player.loadout.slot];
}

// ---------- HUD sync ----------
function syncHud() {
  const s = player.state;
  hud.setHealth(Math.max(0, s.health), s.armor);
  hud.setMoney(player.money);
  const slot = player.loadout.slot;
  const gun = player.loadout.currentGun();
  if (gun) hud.setAmmo(gun.mag, gun.reserve, gun.def.name, gun.reloadLeft > 0, false);
  else if (GRENADES[slot]) hud.setAmmo(0, player.loadout.grenades[slot], GRENADES[slot].name, false, true);
  if (match.phase === 'buy') hud.setTimer(match.phaseTime, false);
  else if (match.bomb.planted) hud.setTimer(match.bomb.planted.timer, match.bomb.planted.timer < 10);
  else hud.setTimer(match.phaseTime, match.phase === 'live' && match.phaseTime < 15);
  hud.setScore(match.score.wardens, match.score.jackals, aliveCount('wardens'), aliveCount('jackals'));
  // Crosshair bloom follows the same spread the bullets use.
  if (gun && s.alive) {
    const spread = spreadFor(gun.def, Math.hypot(s.velocity.x, s.velocity.z), s.crouching, !s.onGround);
    hud.crosshairSpread(5 + spread * 620);
  }
  hud.setFlash(effects.flashOverlay.strength);
  hud.decayDamage(1 / 60);
  // Prompts.
  let promptHtml = null;
  if (match.phase === 'live' && s.alive) {
    if (match.bomb.carrier === player) {
      const inSite = SITES.some((site) => Math.hypot(s.position.x - site.x, s.position.z - site.z) <= site.radius);
      promptHtml = inSite ? 'Hold <b>E</b> to plant the charge' : 'You carry the charge — plant it in ring <b>A</b> or <b>B</b>';
    } else if (match.bomb.planted && s.team !== match.attacking
      && Math.hypot(s.position.x - match.bomb.planted.x, s.position.z - match.bomb.planted.z) < 3.2) {
      promptHtml = 'Hold <b>E</b> to defuse';
    } else if (match.bomb.dropped && s.team === match.attacking
      && Math.hypot(s.position.x - match.bomb.dropped.x, s.position.z - match.bomb.dropped.z) < 4) {
      promptHtml = 'The charge is down — pick it up';
    }
  }
  hud.prompt(promptHtml);
  // Minimap: your team, the charge when planted or carried by a teammate.
  const dots = [];
  for (const a of actors) {
    if (a === player || !a.state.alive || a.state.team !== s.team) continue;
    dots.push({ x: a.state.position.x, z: a.state.position.z, color: TEAM_COLORS[a.state.team], r: 2.2 });
  }
  if (match.bomb.planted) dots.push({ x: match.bomb.planted.x, z: match.bomb.planted.z, color: '#ff4444', r: 3 });
  else if (match.bomb.dropped) dots.push({ x: match.bomb.dropped.x, z: match.bomb.dropped.z, color: PALETTE.lamp, r: 2.6 });
  hud.drawMinimap(s.position, s.yaw, dots);
}

// ---------- shot staging ----------
// A staged scene is a real match state, dealt by the seeded rng and stepped with the
// same simulation the game runs, then frozen: the screenshots are the game itself.
function settle(steps) {
  for (let i = 0; i < steps; i += 1) stepSim(FIXED_STEP);
}

function stageShot(name) {
  hud.showHud();
  startMatch();
  hud.hideBuy();
  hud.hideOverlay();
  uiHold = false;
  const s = player.state;
  if (name === 'buy') {
    match.round = 2;
    match.score.wardens = 1;
    match.score.jackals = 0;
    player.money = 2900;
    player.loadout.primary = createGunState(WEAPONS.kr7);
    player.loadout.slot = 'primary';
    match.phase = 'buy';
    match.phaseTime = BUY_TIME;
    hud.setScore(1, 0, 5, 5);
    hud.showBuy(2, player.money, ownedSet(player));
    hud.banner('', '', 1);
    s.position.set(-30, 0, 0);
    s.yaw = -Math.PI / 2;
    s.pitch = 0.02;
  } else if (name === 'site') {
    match.phase = 'live';
    match.phaseTime = 58;
    const site = siteById('B');
    player.loadout.primary = createGunState(WEAPONS.kr7);
    player.loadout.slot = 'primary';
    s.position.set(13.5, 0, 8.5);
    s.yaw = Math.atan2(-(site.x - 13.5), -(site.z - 8.5));
    s.pitch = -0.03;
    s.health = 64;
    player.loadout.primary.mag = 17;
    match.bomb.planted = { x: site.x, z: site.z, site, timer: 24.3, beepIn: 1, planter: null };
    effects.setBomb(site.x, site.z, 0.4);
    hud.setBombStatus('CHARGE PLANTED — 24s');
    const defender = teamActors('wardens').find((a) => a !== player);
    defender.state.position.set(site.x + 0.8, 0, site.z + 0.4);
    defender.state.crouching = true;
    defender.state.yaw = 2.4;
    const holder = teamActors('jackals')[1];
    holder.state.position.set(25.5, 0, 17.5);
    holder.state.yaw = Math.atan2(-(site.x - 25.5), -(site.z - 17.5));
    hud.banner('CHARGE PLANTED', 'Crane B — defuse it', 60000);
    settle(2);
    hud.progress(0.45, 'Defusing the charge');
  } else if (name === 'end') {
    match.phase = 'live';
    match.phaseTime = 41;
    match.score.wardens = 5;
    match.score.jackals = 3;
    player.kills = 14;
    player.deaths = 9;
    match.stats = { shots: 212, hits: 87 };
    s.position.set(-6, 0, -13);
    s.yaw = -Math.PI / 2;
    hud.setScore(5, 3, aliveCount('wardens'), aliveCount('jackals'));
    endMatch();
    settle(2);
  } else {
    // cover: a live round in the north lane, caught mid-fight.
    match.phase = 'live';
    match.phaseTime = 63;
    match.round = 3;
    match.score.wardens = 2;
    match.score.jackals = 1;
    player.loadout.primary = createGunState(WEAPONS.kr7);
    player.loadout.slot = 'primary';
    player.state.armor = 100;
    settle(150);
    if (!s.alive) {
      s.alive = true;
      s.deathTime = -1;
    }
    s.position.set(-10.5, 0, -15.8);
    s.health = 78;
    player.loadout.primary.mag = 24;
    const enemy = teamActors('jackals').find((a) => a.state.alive);
    if (enemy) {
      enemy.state.position.set(1.5, 0, -13.9);
      enemy.state.health = 100; // settle may have bloodied it; the staged shot must not kill
      s.yaw = Math.atan2(-(enemy.state.position.x - s.position.x), -(enemy.state.position.z - s.position.z));
      s.pitch = -0.04; // torso height at this range — a headshot would kill and change the money/pips
      player.money = 450;
      hud.setMoney(450);
      fireGun(player);
      // The return shot cracks past the player's shoulder, not into the camera.
      enemy.state.yaw = Math.PI / 2 - 0.085;
      enemy.state.pitch = 0.02;
      fireGun(enemy, 0.02);
    }
    const mate = teamActors('wardens').find((a) => a !== player && a.state.alive);
    if (mate) {
      mate.state.position.set(-3.5, 0, -18.6);
      mate.state.yaw = -Math.PI / 2;
    }
    hud.setScore(2, 1, aliveCount('wardens'), aliveCount('jackals'));
    hud.banner('', '', 1);
  }
  syncViewModel();
  syncCamera(1);
  syncHud();
  for (const a of actors) a.updateVisual(0); // teleports land on the meshes, not just the state
  let painted = 0;
  function paint() {
    requestAnimationFrame(paint);
    syncCamera(0);
    renderer.render(scene, camera);
    painted += 1;
    if (painted === 2) window.__shotReady = true;
  }
  requestAnimationFrame(paint);
}

// ---------- boot & loop ----------
for (const a of actors) {
  const spawnSet = a.state.team === 'wardens' ? SPAWNS.west : SPAWNS.east;
  const index = teamActors(a.state.team).indexOf(a);
  a.reset(spawnSet[index % spawnSet.length], a.state.team === 'wardens' ? -Math.PI / 2 : Math.PI / 2);
}
syncViewModel();

let accumulator = 0;
let lastTime = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min((now - lastTime) / 1000, 0.1);
  lastTime = now;
  const paused = hud.overlayOpen() && (match.phase === 'live' || match.phase === 'buy');
  if (!paused) {
    accumulator += dt;
    let steps = 0;
    while (accumulator >= FIXED_STEP && steps < 5) {
      stepSim(FIXED_STEP);
      accumulator -= FIXED_STEP;
      steps += 1;
    }
    if (accumulator > FIXED_STEP * 5) accumulator = 0;
  }
  syncCamera(dt);
  syncHud();
  renderer.render(scene, camera);
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

if (shot) stageShot(shot);
else requestAnimationFrame(frame);
