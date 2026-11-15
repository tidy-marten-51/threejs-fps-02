// Ray and segment tests against axis-aligned boxes, written out by hand: combat casts a
// ray per bullet and perception casts one per glance, so neither can afford a scene-graph
// raycast. Boxes are plain {minX, minY, minZ, maxX, maxY, maxZ} records (the map's
// colliders and the actors' body parts share the shape).

// Nearest entry distance of a ray into a box, or Infinity when it misses. The ray is
// origin + t * dir with dir normalised; a ray starting inside the box reports 0.
export function rayBox(ox, oy, oz, dx, dy, dz, box) {
  let tmin = 0;
  let tmax = Infinity;
  if (dx === 0) {
    if (ox < box.minX || ox > box.maxX) return Infinity;
  } else {
    let t1 = (box.minX - ox) / dx;
    let t2 = (box.maxX - ox) / dx;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return Infinity;
  }
  if (dy === 0) {
    if (oy < box.minY || oy > box.maxY) return Infinity;
  } else {
    let t1 = (box.minY - oy) / dy;
    let t2 = (box.maxY - oy) / dy;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return Infinity;
  }
  if (dz === 0) {
    if (oz < box.minZ || oz > box.maxZ) return Infinity;
  } else {
    let t1 = (box.minZ - oz) / dz;
    let t2 = (box.maxZ - oz) / dz;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return Infinity;
  }
  return tmin;
}

// Does the segment from a to b touch the box? Used for line of sight and smoke checks.
export function segmentHitsBox(ax, ay, az, bx, by, bz, box) {
  const dx = bx - ax;
  const dy = by - ay;
  const dz = bz - az;
  const length = Math.hypot(dx, dy, dz);
  if (length === 0) return false;
  const t = rayBox(ax, ay, az, dx / length, dy / length, dz / length, box);
  return t <= length;
}

// The nearest hit along a ray among a list of boxes, with the box that was hit.
export function nearestRayHit(ox, oy, oz, dx, dy, dz, boxes, maxDist) {
  let best = maxDist;
  let bestBox = null;
  for (let i = 0; i < boxes.length; i += 1) {
    const t = rayBox(ox, oy, oz, dx, dy, dz, boxes[i]);
    if (t < best) {
      best = t;
      bestBox = boxes[i];
    }
  }
  return bestBox === null ? null : { dist: best, box: bestBox };
}
