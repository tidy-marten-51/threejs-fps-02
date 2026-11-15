// The map: Depot Sable, a freight yard at last light. Two bomb sites — Dock A in the
// north-west, Crane B in the south-east — a warehouse across the middle with doors on both
// faces, and container lanes north and south joining the spawns to the sites. Every solid
// is one box record used three ways: a mesh to see, a collider to walk against, and a
// blocker for bullets and sight. The waypoint graph at the bottom is how bots travel:
// nodes on the lanes, edges where a walker can go straight, next hops computed once.
import * as THREE from 'three';
import { PALETTE } from './palette.js';

export const WORLD_BOUNDS = { minX: -36, maxX: 36, minZ: -26, maxZ: 26 };

export const SITES = [
  { id: 'A', name: 'Dock A', x: -22, z: -14, radius: 5.5 },
  { id: 'B', name: 'Crane B', x: 21, z: 14, radius: 5.5 },
];

export const SPAWNS = {
  west: [
    { x: -31, z: -3 }, { x: -31, z: 0 }, { x: -31, z: 3 }, { x: -29.5, z: -1.5 }, { x: -29.5, z: 1.5 },
  ],
  east: [
    { x: 31, z: 3 }, { x: 31, z: 0 }, { x: 31, z: -3 }, { x: 29.5, z: 1.5 }, { x: 29.5, z: -1.5 },
  ],
};

// Waypoints: [id, x, z]. Edges join nodes a walker can cross between in a straight line.
const NODES = [
  ['wSpawn', -30, 0], ['eSpawn', 30, 0],
  ['wNorth', -26, -8], ['wSouth', -26, 8], ['wLink', -18, 2],
  ['aWest', -16, -10], ['aNorth', -16, -18], ['aSite', -22, -14],
  ['nLane1', -8, -16], ['nLane2', 4, -16], ['nLane3', 14, -14], ['nEast', 24, -10],
  ['eLink', 18, -6], ['eNorth', 24, -2],
  ['midWest', -12, 0], ['midDoorN', -4, -6], ['midIn', 0, 0], ['midDoorS', 4, 6], ['midEast', 12, 0],
  ['sLane1', -14, 14], ['sLane2', -4, 16], ['sLane3', 8, 16], ['sEast', 18, 12],
  ['bWest', 16, 18], ['bSite', 21, 14], ['bNorth', 26, 10],
];
const EDGES = [
  ['wSpawn', 'wNorth'], ['wSpawn', 'wSouth'], ['wSpawn', 'wLink'],
  ['wNorth', 'aWest'], ['wNorth', 'nLane1'], ['wSouth', 'sLane1'], ['wSouth', 'wLink'],
  ['aWest', 'aSite'], ['aWest', 'aNorth'], ['aNorth', 'aSite'], ['aNorth', 'nLane1'],
  ['nLane1', 'nLane2'], ['nLane2', 'nLane3'], ['nLane2', 'midDoorN'], ['nLane3', 'nEast'],
  ['nEast', 'eNorth'], ['nEast', 'eLink'], ['eLink', 'midEast'], ['eLink', 'nLane3'],
  ['eNorth', 'bNorth'], ['eNorth', 'eSpawn'], ['eSpawn', 'eLink'], ['eSpawn', 'sEast'],
  ['midWest', 'wLink'], ['midWest', 'midIn'], ['midWest', 'sLane1'], ['midIn', 'midDoorN'],
  ['midIn', 'midDoorS'], ['midIn', 'midEast'], ['midDoorS', 'sLane2'], ['midEast', 'sEast'],
  ['sLane1', 'sLane2'], ['sLane2', 'sLane3'], ['sLane3', 'sEast'], ['sEast', 'bWest'],
  ['bWest', 'bSite'], ['bSite', 'bNorth'], ['bNorth', 'sEast'],
];

function buildGraph() {
  const nodes = NODES.map(([id, x, z], index) => ({ id, x, z, index }));
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const count = nodes.length;
  const dist = new Float64Array(count * count).fill(Infinity);
  const next = new Int32Array(count * count).fill(-1);
  for (let i = 0; i < count; i += 1) {
    dist[i * count + i] = 0;
    next[i * count + i] = i;
  }
  for (const [a, b] of EDGES) {
    const na = byId.get(a);
    const nb = byId.get(b);
    const d = Math.hypot(na.x - nb.x, na.z - nb.z);
    dist[na.index * count + nb.index] = d;
    dist[nb.index * count + na.index] = d;
    next[na.index * count + nb.index] = nb.index;
    next[nb.index * count + na.index] = na.index;
  }
  for (let k = 0; k < count; k += 1) {
    for (let i = 0; i < count; i += 1) {
      for (let j = 0; j < count; j += 1) {
        const through = dist[i * count + k] + dist[k * count + j];
        if (through < dist[i * count + j]) {
          dist[i * count + j] = through;
          next[i * count + j] = next[i * count + k];
        }
      }
    }
  }
  return { nodes, byId, next, count };
}

function stencilTexture(text, background, foreground) {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, 256, 128);
  ctx.fillStyle = foreground;
  ctx.font = '700 64px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 128, 68);
  const texture = new THREE.CanvasTexture(canvas);
  texture.anisotropy = 4;
  return texture;
}

export function createMap(scene) {
  const group = new THREE.Group();
  scene.add(group);
  const colliders = [];
  const sightBlockers = [];
  const footprints = [];

  const materials = new Map();
  function material(color, roughness = 0.9, metalness = 0.05) {
    const key = `${color}|${roughness}|${metalness}`;
    if (!materials.has(key)) {
      materials.set(key, new THREE.MeshLambertMaterial({ color: new THREE.Color(color) }));
    }
    return materials.get(key);
  }

  // One solid: a mesh, a collider record and (when tall enough) a sight blocker.
  function box(w, h, d, x, y, z, mat, options = {}) {
    const mesh = new THREE.Mesh(options.geometry ?? new THREE.BoxGeometry(w, h, d), mat);
    mesh.position.set(x, y, z);
    if (options.ry) mesh.rotation.y = options.ry;
    mesh.castShadow = options.cast ?? true;
    mesh.receiveShadow = true;
    group.add(mesh);
    if (options.noCollide) return mesh;
    const record = {
      minX: x - w / 2, maxX: x + w / 2, minY: y - h / 2, maxY: y + h / 2,
      minZ: z - d / 2, maxZ: z + d / 2, mesh,
    };
    colliders.push(record);
    if (h >= 1.2 && y - h / 2 < 1.4) sightBlockers.push(record);
    if (y - h / 2 <= 0.01) footprints.push(record);
    return mesh;
  }

  // Ground and the yard's painted aprons.
  const ground = box(76, 0.4, 56, 0, -0.2, 0, material(PALETTE.ground, 0.96), { cast: false });
  ground.receiveShadow = true;
  const apronMat = material(PALETTE.concrete, 0.94);
  box(20, 0.06, 16, -22, 0.03, -14, apronMat, { noCollide: true, cast: false });
  box(20, 0.06, 16, 21, 0.03, 14, apronMat, { noCollide: true, cast: false });

  // Site rings and letters, painted flat on the aprons.
  for (const site of SITES) {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(site.radius - 0.35, site.radius, 40),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(PALETTE.lamp), transparent: true, opacity: 0.85, side: THREE.DoubleSide }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(site.x, 0.08, site.z);
    group.add(ring);
    const letter = new THREE.Mesh(
      new THREE.PlaneGeometry(3.4, 3.4),
      new THREE.MeshBasicMaterial({ map: stencilTexture(site.id, 'rgba(0,0,0,0)', PALETTE.lamp), transparent: true, opacity: 0.9 }),
    );
    letter.rotation.x = -Math.PI / 2;
    letter.position.set(site.x, 0.09, site.z);
    group.add(letter);
  }

  // Perimeter walls.
  const wallMat = material(PALETTE.concrete, 0.92);
  box(76, 5, 1, 0, 2.5, -27.5, wallMat);
  box(76, 5, 1, 0, 2.5, 27.5, wallMat);
  box(1, 5, 56, -37.5, 2.5, 0, wallMat);
  box(1, 5, 56, 37.5, 2.5, 0, wallMat);

  // Shipping containers: 6 m long, 2.6 high, 2.4 wide, in the yard's four liveries, some
  // stacked two high. A stencil number on the long side keeps rows from looking cloned.
  const liveries = [PALETTE.rust, PALETTE.teal, PALETTE.ochre, PALETTE.steel];
  const containers = [
    // North lane cover (between the lane and the wall, and mid-lane chicanes)
    [0, -21, 0, 1], [8, -21, 0, 1], [-14, -21, 0, 2], [20, -20, 0, 1], [-2, -11.5, 0, 1], [10, -11, 0, 2],
    // South lane cover
    [-8, 21, 0, 1], [2, 21, 0, 2], [14, 20.5, 0, 1], [-20, 11, 0, 1], [8, 11, 0, 1],
    // West / Dock A dressing
    [-28, -19, 1, 1], [-28, -6, 1, 2], [-13, -20, 0, 1],
    // East / Crane B dressing
    [28, 19, 1, 2], [28, -8, 1, 1], [13, 20, 0, 1],
    // Mid flanks
    [-8, -9.5, 0, 1], [8, 9.5, 0, 1], [-16, -3, 1, 1], [16, 4, 1, 1],
  ];
  let containerNo = 0;
  for (const [cx, cz, rotated, stack] of containers) {
    containerNo += 1;
    const color = liveries[containerNo % liveries.length];
    const w = rotated ? 2.4 : 6;
    const d = rotated ? 6 : 2.4;
    for (let level = 0; level < stack; level += 1) {
      const y = 1.3 + level * 2.6;
      const tex = stencilTexture(`SBL-${100 + containerNo}`, color, 'rgba(236,231,219,0.85)');
      const sideMat = new THREE.MeshLambertMaterial({ map: tex });
      const mesh = box(w, 2.6, d, cx, y, cz, material(color, 0.82, 0.12));
      // Stencil plate on the long side.
      const plate = new THREE.Mesh(new THREE.PlaneGeometry(3.6, 1.8), sideMat);
      if (rotated) {
        plate.position.set(cx + 1.21, y, cz);
        plate.rotation.y = Math.PI / 2;
      } else {
        plate.position.set(cx, y, cz + 1.21);
      }
      group.add(plate);
      box(w + 0.15, 0.14, d + 0.15, cx, y + 1.36, cz, material(PALETTE.hairline, 0.7, 0.2));
    }
  }

  // The mid warehouse: two long walls with door gaps, end walls, a roof, and lamps inside.
  const wareMat = material(PALETTE.steel, 0.85, 0.15);
  // North wall (z=-4): segments leaving a door at x in [-1.6, 1.6].
  box(10.4, 3.8, 0.5, -6.8, 1.9, -4, wareMat);
  box(10.4, 3.8, 0.5, 6.8, 1.9, -4, wareMat);
  box(3.2, 0.7, 0.5, 0, 3.45, -4, wareMat);
  // South wall (z=+4): door at x in [2.4, 5.6].
  box(13.2, 3.8, 0.5, -5.4, 1.9, 4, wareMat);
  box(8.4, 3.8, 0.5, 7.8, 1.9, 4, wareMat);
  box(3.2, 0.7, 0.5, 4, 3.45, 4, wareMat);
  // End walls with wide openings.
  box(0.5, 3.8, 3.4, -12, 1.9, -2.3, wareMat);
  box(0.5, 3.8, 3.4, -12, 1.9, 2.3, wareMat);
  box(0.5, 3.8, 3.4, 12, 1.9, -2.3, wareMat);
  box(0.5, 3.8, 3.4, 12, 1.9, 2.3, wareMat);
  const roof = box(25, 0.3, 9, 0, 3.95, 0, material(PALETTE.hairline, 0.8, 0.2));
  roof.castShadow = true;

  // The gantry crane over site B: four legs, a beam, and a container hanging in the sling.
  const craneMat = material(PALETTE.ochre, 0.6, 0.35);
  for (const [lx, lz] of [[15, 8], [27, 8], [15, 20], [27, 20]]) {
    box(0.5, 9, 0.5, lx, 4.5, lz, craneMat);
  }
  box(13.5, 0.7, 0.8, 21, 9.2, 8, craneMat);
  box(13.5, 0.7, 0.8, 21, 9.2, 20, craneMat);
  box(0.8, 0.7, 12.8, 15, 9.2, 14, craneMat);
  box(0.8, 0.7, 12.8, 27, 9.2, 14, craneMat);
  box(0.12, 2.6, 0.12, 21, 7.6, 14, craneMat);
  box(6, 2.6, 2.4, 21, 4.9, 14, material(PALETTE.teal, 0.82, 0.12));

  // Crates and barrels: low cover that stops a crouching player, never a standing eye line.
  const crateMat = material(PALETTE.ochre, 0.9, 0.02);
  const crateSpots = [
    [-22, -11], [-19, -16.5], [-25, -16], [21, 11], [18, 16.5], [24, 17], [0, -13], [0, 13],
    [-10, 6], [10, -6], [-24, 3], [24, -4], [-6, -1.5], [6, 1.5], [-30, -12], [30, 12],
  ];
  for (const [cx, cz] of crateSpots) {
    box(1.15, 1.15, 1.15, cx, 0.575, cz, crateMat);
  }
  const barrelGeo = new THREE.CylinderGeometry(0.34, 0.34, 0.95, 12);
  const barrelMats = [material(PALETTE.rust, 0.7, 0.25), material(PALETTE.steel, 0.7, 0.25)];
  const barrelSpots = [
    [-17, -6.5], [-16.4, -6.9], [15, 7], [15.6, 7.4], [-3, 8.5], [3, -8.5], [26, 2], [-26, -2], [12, 14.5], [-12, -14.5],
  ];
  barrelSpots.forEach(([bx, bz], i) => {
    const mesh = new THREE.Mesh(barrelGeo, barrelMats[i % 2]);
    mesh.position.set(bx, 0.475, bz);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    colliders.push({ minX: bx - 0.34, maxX: bx + 0.34, minY: 0, maxY: 0.95, minZ: bz - 0.34, maxZ: bz + 0.34, mesh });
  });

  // A skyline of harbour silhouettes beyond the walls, for depth in screenshots.
  const silhouette = material('#1b2129', 1, 0);
  const skyline = [[-30, -34, 10, 16], [-8, -36, 14, 22], [16, -34, 9, 13], [32, -35, 12, 18], [-24, 34, 12, 15], [6, 35, 16, 20], [28, 33, 10, 12]];
  for (const [sx, sz, sw, sh] of skyline) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(sw, sh, 6), silhouette);
    mesh.position.set(sx, sh / 2, sz);
    group.add(mesh);
  }

  // Light: dusk key with shadows, a cool sky gradient, and warm lamps at both sites and mid.
  scene.add(new THREE.HemisphereLight(new THREE.Color('#5a6c84'), new THREE.Color('#1d1a16'), 1.55));
  const fill = new THREE.DirectionalLight(new THREE.Color('#7d90a8'), 0.5);
  fill.position.set(30, 18, 24);
  scene.add(fill);
  const key = new THREE.DirectionalLight(new THREE.Color('#ffd9a8'), 2.3);
  key.position.set(-28, 34, -18);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.left = -44;
  key.shadow.camera.right = 44;
  key.shadow.camera.top = 36;
  key.shadow.camera.bottom = -36;
  key.shadow.camera.far = 110;
  key.shadow.bias = -0.0005;
  scene.add(key, key.target);
  const lampHeads = [];
  for (const [lx, lz] of [[-22, -14], [21, 14], [0, 0], [-30, 0], [30, 0]]) {
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.12, 6.4, 8), material(PALETTE.hairline, 0.7, 0.3));
    pole.position.set(lx + 3.4, 3.2, lz + 3.4);
    group.add(pole);
    const head = new THREE.Mesh(
      new THREE.BoxGeometry(0.7, 0.18, 0.4),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(PALETTE.lamp) }),
    );
    head.position.set(lx + 3.4, 6.45, lz + 3.4);
    group.add(head);
    lampHeads.push(head);
    const light = new THREE.PointLight(new THREE.Color(PALETTE.lamp), 60, 26, 1.8);
    light.position.set(lx + 3.2, 6.1, lz + 3.2);
    scene.add(light);
  }

  const graph = buildGraph();
  return { colliders, sightBlockers, footprints, graph, group };
}

// The next waypoint index on the shortest route from one node to another.
export function nextHop(graph, fromIndex, toIndex) {
  return graph.next[fromIndex * graph.count + toIndex];
}

export function nearestNode(graph, x, z) {
  let best = null;
  let bestDist = Infinity;
  for (const node of graph.nodes) {
    const d = (node.x - x) ** 2 + (node.z - z) ** 2;
    if (d < bestDist) {
      bestDist = d;
      best = node;
    }
  }
  return best;
}
