// Bot minds. A mind sees the world the way a player does: an enemy counts only inside its
// view cone, within range, with a clear line to the chest or head that no wall and no
// smoke crosses; a gunshot it cannot see still turns its head. What it knows drives a
// small state machine — follow the plan's route, hold the plan's angle, fight what is in
// front of it, chase the last place it saw or heard trouble, and work the objective
// (plant, defuse, retake) when the round asks for it. Firing is bursty and human: a
// reaction beat after first sight, three-to-six-round bursts, aim that settles the
// longer the target stays visible, and strafing between bursts — so a player who stops
// and aims beats a bot, and a player who runs into one dies.
import { segmentHitsBox } from './geometry.js';
import { nearestNode, nextHop } from './map.js';
import { WALK_SPEED } from './actor.js';

const SIGHT_RANGE = 58;
const SIGHT_COS = Math.cos(1.05); // ~120° cone
const HEAR_RANGE = 30;

export function lineBlocked(ax, ay, az, bx, by, bz, blockers) {
  for (let i = 0; i < blockers.length; i += 1) {
    if (segmentHitsBox(ax, ay, az, bx, by, bz, blockers[i])) return true;
  }
  return false;
}

function smokeBlocks(ax, ay, az, bx, by, bz, smokes) {
  for (const s of smokes) {
    // Segment-to-centre distance under the radius means the look passes through smoke.
    const abx = bx - ax;
    const aby = by - ay;
    const abz = bz - az;
    const t = Math.max(0, Math.min(1, ((s.x - ax) * abx + (s.y - ay) * aby + (s.z - az) * abz) / (abx * abx + aby * aby + abz * abz || 1)));
    const dx = ax + abx * t - s.x;
    const dy = ay + aby * t - s.y;
    const dz = az + abz * t - s.z;
    if (dx * dx + dy * dy + dz * dz < s.r * s.r) return true;
  }
  return false;
}

export function canSee(mind, target, blockers, smokes) {
  const me = mind.actor.state;
  const them = target.state;
  const dx = them.position.x - me.position.x;
  const dz = them.position.z - me.position.z;
  const dist = Math.hypot(dx, dz);
  if (dist > SIGHT_RANGE) return false;
  const fx = -Math.sin(me.yaw);
  const fz = -Math.cos(me.yaw);
  if (dist > 2.2 && (dx * fx + dz * fz) / (dist || 1) < SIGHT_COS) return false;
  const eyeY = me.position.y + me.eye;
  const chestY = them.position.y + (them.crouching ? 0.62 : 1.15);
  const headY = them.position.y + (them.crouching ? 1.02 : 1.56);
  const from = [me.position.x, eyeY, me.position.z];
  if (!lineBlocked(...from, them.position.x, chestY, them.position.z, blockers)
    && !smokeBlocks(...from, them.position.x, chestY, them.position.z, smokes)) return true;
  if (!lineBlocked(...from, them.position.x, headY, them.position.z, blockers)
    && !smokeBlocks(...from, them.position.x, headY, them.position.z, smokes)) return true;
  return false;
}

export function createMind(actor, rng) {
  const mind = {
    actor,
    rng,
    plan: { kind: 'hold', x: actor.state.position.x, z: actor.state.position.z, watchYaw: actor.state.yaw },
    targetNode: -1,
    finalTarget: null,
    visible: null,
    visibleSince: 0,
    lastKnown: null,
    lastKnownAt: -99,
    investigate: null,
    burstLeft: 0,
    burstPause: 0,
    strafeDir: 1,
    strafeFlipAt: 0,
    peekPhase: rng.range(0, 6),
    stuckTime: 0,
    lastX: actor.state.position.x,
    lastZ: actor.state.position.z,
    nudgeUntil: 0,
    nudgeDir: 0,
    thinkAt: rng.range(0, 0.15),
    grenadeUsed: false,
  };

  mind.setPlan = (plan) => {
    mind.plan = plan;
    mind.finalTarget = { x: plan.x, z: plan.z };
    mind.targetNode = -1;
    mind.investigate = null;
  };

  mind.hearNoise = (x, z, now, range = HEAR_RANGE) => {
    const me = actor.state;
    const dist = Math.hypot(x - me.position.x, z - me.position.z);
    if (dist > range || mind.visible) return;
    if (now - mind.lastKnownAt > 1.2) {
      mind.lastKnown = { x, z };
      mind.lastKnownAt = now;
      if (mind.plan.kind === 'hold' || mind.plan.kind === 'defend') {
        mind.investigate = { x, z, until: now + 6 };
      }
    }
  };

  function pathWish(ctx, tx, tz, intent) {
    const me = actor.state;
    const graph = ctx.graph;
    const here = nearestNode(graph, me.position.x, me.position.z);
    const goal = nearestNode(graph, tx, tz);
    let waypoint = { x: tx, z: tz };
    const directDist = Math.hypot(tx - me.position.x, tz - me.position.z);
    if (here.index !== goal.index && directDist > 2.5) {
      const hop = nextHop(graph, here.index, goal.index);
      if (hop >= 0) waypoint = graph.nodes[hop];
    }
    const dx = waypoint.x - me.position.x;
    const dz = waypoint.z - me.position.z;
    const d = Math.hypot(dx, dz);
    if (d > 0.35) {
      intent.wishX = dx / d;
      intent.wishZ = dz / d;
    }
    return directDist;
  }

  function faceToward(intent, tx, tz, dt, rate = 8) {
    const me = actor.state;
    const want = Math.atan2(-(tx - me.position.x), -(tz - me.position.z));
    turnToward(intent, want, dt, rate);
  }

  function turnToward(intent, wantYaw, dt, rate = 8) {
    const me = actor.state;
    let diff = wantYaw - me.yaw;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    const step = Math.max(-rate * dt, Math.min(rate * dt, diff));
    intent.yaw = me.yaw + step;
  }

  mind.update = (dt, ctx, intent) => {
    const me = actor.state;
    const now = ctx.time;
    intent.wishX = 0;
    intent.wishZ = 0;
    intent.jump = false;
    intent.crouch = false;
    intent.wantFire = false;
    intent.wantReload = false;
    intent.action = null;
    intent.wantGrenade = null;
    intent.yaw = me.yaw;
    intent.pitch = me.pitch;

    // Blinded by a flash: stand, keep facing, wait for the ringing to stop.
    if (now < (mind.blindUntil ?? 0)) {
      mind.visible = null;
      intent.crouch = me.crouching;
      return intent;
    }

    // Perception on a stagger, so ten minds never spike on the same frame.
    mind.thinkAt -= dt;
    if (mind.thinkAt <= 0) {
      mind.thinkAt = 0.14;
      let best = null;
      let bestDist = Infinity;
      for (const other of ctx.actors) {
        if (other === actor || !other.state.alive || other.state.team === me.team) continue;
        const d = Math.hypot(other.state.position.x - me.position.x, other.state.position.z - me.position.z);
        if (d < bestDist && canSee(mind, other, ctx.sightBlockers, ctx.smokes)) {
          best = other;
          bestDist = d;
        }
      }
      if (best && best !== mind.visible) {
        mind.visible = best;
        mind.visibleSince = now;
        mind.burstPause = mind.rng.range(0.22, 0.42);
        mind.burstLeft = 0;
      } else if (best) {
        mind.visible = best;
      } else if (mind.visible && !canSee(mind, mind.visible, ctx.sightBlockers, ctx.smokes)) {
        mind.lastKnown = { x: mind.visible.state.position.x, z: mind.visible.state.position.z };
        mind.lastKnownAt = now;
        mind.visible = null;
      }
      if (mind.visible) {
        mind.lastKnown = { x: mind.visible.state.position.x, z: mind.visible.state.position.z };
        mind.lastKnownAt = now;
      }
    }

    const gun = actor.loadout ? actor.loadout.currentGun() : null;
    if (gun && gun.mag === 0 && gun.reloadLeft <= 0) intent.wantReload = true;

    // Fight what is visible: settle aim, fire bursts, strafe between them.
    if (mind.visible && mind.visible.state.alive) {
      const them = mind.visible.state;
      const dx = them.position.x - me.position.x;
      const dz = them.position.z - me.position.z;
      const dist = Math.hypot(dx, dz);
      const aimY = them.position.y + (mind.rng.chance(0.3) ? 1.5 : 1.12) - (me.position.y + me.eye);
      const wantYaw = Math.atan2(-dx, -dz);
      const aimTime = now - mind.visibleSince;
      const settle = Math.max(0.012, 0.075 - aimTime * 0.09);
      intent.aimError = settle;
      turnToward(intent, wantYaw, dt, 9);
      intent.pitch = Math.atan2(aimY, dist) + mind.rng.range(-settle, settle) * 0.4;
      intent.yaw += mind.rng.range(-settle, settle) * 0.5;

      if (mind.burstPause > 0) {
        mind.burstPause -= dt;
        // Strafe while the burst rests, unless a sniper is holding an angle.
        if (!gun || gun.def.id !== 'piercer') {
          if (now > mind.strafeFlipAt) {
            mind.strafeDir = mind.rng.chance(0.5) ? 1 : -1;
            mind.strafeFlipAt = now + mind.rng.range(0.4, 0.9);
          }
          const px = -dz / (dist || 1) * mind.strafeDir;
          const pz = dx / (dist || 1) * mind.strafeDir;
          intent.wishX = px;
          intent.wishZ = pz;
        }
        if (dist > 16 && mind.rng.chance(0.35)) intent.crouch = true;
      } else if (gun) {
        intent.wantFire = true;
        mind.burstLeft -= dt;
        if (mind.burstLeft <= 0) {
          const burstSeconds = gun.def.auto ? mind.rng.range(0.25, 0.55) : gun.def.fireGap + 0.05;
          mind.burstLeft = burstSeconds;
          mind.burstPause = gun.def.auto ? mind.rng.range(0.3, 0.65) : mind.rng.range(0.5, 0.9);
        }
      }
      // A frag for a target that just broke line of sight at mid range.
      if (!mind.grenadeUsed && actor.loadout && actor.loadout.grenades.frag > 0 && dist > 9 && dist < 19 && mind.rng.chance(0.004)) {
        intent.wantGrenade = 'frag';
        mind.grenadeUsed = true;
      }
      return intent;
    }

    // Work the objective when the plan calls for it and the spot is reached.
    const plan = mind.plan;
    const goal = mind.investigate && now < mind.investigate.until
      ? mind.investigate
      : (mind.lastKnown && now - mind.lastKnownAt < 3.5 && plan.kind !== 'hold' ? mind.lastKnown : null);
    const tx = goal ? goal.x : plan.x;
    const tz = goal ? goal.z : plan.z;
    const distGoal = pathWish(ctx, tx, tz, intent);

    if (!goal && (plan.kind === 'plant' || plan.kind === 'defuse')) {
      if (distGoal < 1.6) {
        intent.wishX = 0;
        intent.wishZ = 0;
        intent.crouch = true;
        faceToward(intent, plan.faceX ?? tx, plan.faceZ ?? tz, dt);
        intent.action = plan.kind;
        return intent;
      }
    }

    if (!goal && (plan.kind === 'hold' || plan.kind === 'route')) {
      if (distGoal < 1.4) {
        // Settle on the angle: face the watch direction, peek a half-step either side.
        intent.wishX = 0;
        intent.wishZ = 0;
        turnToward(intent, plan.watchYaw, dt, 5);
        mind.peekPhase += dt;
        const peek = Math.sin(mind.peekPhase * 0.7);
        if (Math.abs(peek) > 0.86) {
          const px = Math.cos(plan.watchYaw);
          const pz = -Math.sin(plan.watchYaw);
          const dir = peek > 0 ? 1 : -1;
          intent.wishX = px * dir * 0.6;
          intent.wishZ = pz * dir * 0.6;
        }
        if (mind.rng.chance(0.002)) intent.crouch = true;
        return intent;
      }
    }

    // Travelling: face the way we walk, unless fresh trouble is remembered.
    if (intent.wishX !== 0 || intent.wishZ !== 0) {
      if (mind.lastKnown && now - mind.lastKnownAt < 2) {
        faceToward(intent, mind.lastKnown.x, mind.lastKnown.z, dt, 6);
      } else {
        turnToward(intent, Math.atan2(-intent.wishX, -intent.wishZ), dt, 7);
      }
    }

    // Stuck detection: wanting to move but going nowhere earns a sideways nudge.
    const moved = Math.hypot(me.position.x - mind.lastX, me.position.z - mind.lastZ);
    if ((intent.wishX !== 0 || intent.wishZ !== 0) && moved < 0.05) {
      mind.stuckTime += dt;
    } else {
      mind.stuckTime = 0;
    }
    mind.lastX = me.position.x;
    mind.lastZ = me.position.z;
    if (mind.stuckTime > 1.1) {
      mind.nudgeUntil = now + 0.35;
      mind.nudgeDir = mind.rng.chance(0.5) ? 1 : -1;
      mind.stuckTime = 0;
    }
    if (now < mind.nudgeUntil) {
      const fx = -Math.sin(me.yaw);
      const fz = -Math.cos(me.yaw);
      intent.wishX = -fz * mind.nudgeDir + fx * 0.4;
      intent.wishZ = fx * mind.nudgeDir + fz * 0.4;
      const n = Math.hypot(intent.wishX, intent.wishZ) || 1;
      intent.wishX /= n;
      intent.wishZ /= n;
    }
    return intent;
  };

  return mind;
}

export { WALK_SPEED };
