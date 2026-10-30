// SurveyRoute and Waypoint (class diagram). Covers FR-2.1, FR-2.2 and FR-2.3.
import { round, clamp } from './rng.js';

export function footprintHalfSize(altitude, fovDegrees) {
  return altitude * Math.tan(((fovDegrees / 2) * Math.PI) / 180);
}

function renumber(waypoints) {
  return waypoints.map((w, i) => ({ ...w, id: `wp${i + 1}` }));
}

// FR-2.1: back-and-forth (lawnmower) route over the whole field.
export function generateLawnmowerRoute(field, { altitude, lineSpacing }) {
  const lines = Math.max(1, Math.ceil(field.length / lineSpacing));
  const stops = Math.max(1, Math.ceil(field.width / lineSpacing));
  const dz = field.length / lines;
  const dx = field.width / stops;
  const waypoints = [];
  for (let i = 0; i < lines; i++) {
    const z = round(dz * (i + 0.5), 2);
    for (let j = 0; j < stops; j++) {
      const col = i % 2 === 0 ? j : stops - 1 - j;
      waypoints.push({ x: round(dx * (col + 0.5), 2), z, altitude });
    }
  }
  return {
    routeId: `route-${field.fieldId}-${altitude}m-${lineSpacing}m`,
    altitude,
    lineSpacing,
    edited: false,
    waypoints: renumber(waypoints),
  };
}

function clampToField(field, x, z) {
  const margin = 2;
  return {
    x: round(clamp(x, -margin, field.width + margin), 2),
    z: round(clamp(z, -margin, field.length + margin), 2),
  };
}

function edited(route, waypoints) {
  return {
    ...route,
    routeId: route.routeId.endsWith('-edited') ? route.routeId : `${route.routeId}-edited`,
    edited: true,
    waypoints: renumber(waypoints),
  };
}

// FR-2.2: add a waypoint where it lengthens the route the least.
export function insertWaypoint(route, field, x, z) {
  const p = { ...clampToField(field, x, z), altitude: route.altitude };
  const wps = route.waypoints;
  if (wps.length === 0) return edited(route, [p]);
  const d = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
  let bestIndex = 0;
  let bestCost = d(p, wps[0]);
  const endCost = d(wps[wps.length - 1], p);
  if (endCost < bestCost) {
    bestCost = endCost;
    bestIndex = wps.length;
  }
  for (let i = 0; i < wps.length - 1; i++) {
    const cost = d(wps[i], p) + d(p, wps[i + 1]) - d(wps[i], wps[i + 1]);
    if (cost < bestCost) {
      bestCost = cost;
      bestIndex = i + 1;
    }
  }
  const next = wps.slice();
  next.splice(bestIndex, 0, p);
  return edited(route, next);
}

export function moveWaypoint(route, field, index, x, z) {
  const next = route.waypoints.slice();
  next[index] = { ...next[index], ...clampToField(field, x, z) };
  return edited(route, next);
}

export function deleteWaypoint(route, index) {
  const next = route.waypoints.slice();
  next.splice(index, 1);
  return edited(route, next);
}

// FR-2.3: which crop rows have plants that no waypoint's camera footprint covers.
export function coverageReport(field, route, fovDegrees) {
  const covered = new Uint8Array(field.plants.length);
  const s = field.spacing;
  for (const w of route.waypoints) {
    const h = footprintHalfSize(w.altitude ?? route.altitude, fovDegrees);
    const c0 = Math.max(0, Math.ceil((w.x - h) / s - 0.5));
    const c1 = Math.min(field.columns - 1, Math.floor((w.x + h) / s - 0.5));
    const r0 = Math.max(0, Math.ceil((w.z - h) / s - 0.5));
    const r1 = Math.min(field.rows - 1, Math.floor((w.z + h) / s - 0.5));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) covered[r * field.columns + c] = 1;
    }
  }
  const rowMissing = new Map();
  let coveredCount = 0;
  for (const p of field.plants) {
    if (covered[p.index]) coveredCount++;
    else rowMissing.set(p.row + 1, (rowMissing.get(p.row + 1) ?? 0) + 1);
  }
  return {
    totalPlants: field.plants.length,
    coveredPlants: coveredCount,
    covered,
    uncoveredRows: [...rowMissing.keys()].sort((a, b) => a - b),
    uncoveredByRow: rowMissing,
  };
}

export function routeLength(route, base) {
  const pts = [base, ...route.waypoints, base];
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
  return len;
}

// Rough flight time and battery use for the planner panel.
export function estimateFlight(route, droneConfig) {
  const len = routeLength(route, droneConfig.basePad);
  const climb = (2 * route.altitude) / droneConfig.climbRate;
  const flying = len / droneConfig.cruiseSpeed + climb;
  const hovering = route.waypoints.length * droneConfig.scanDwellSeconds;
  const battery = flying * droneConfig.batteryDrainPerSecond.flying + hovering * droneConfig.batteryDrainPerSecond.hovering;
  return { lengthMeters: len, seconds: flying + hovering, batteryPercent: battery };
}

// Turns [3,4,5,9] into "3-5, 9" for the coverage warning.
export function formatRanges(nums) {
  const parts = [];
  for (let i = 0; i < nums.length; i++) {
    let j = i;
    while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
    parts.push(i === j ? `${nums[i]}` : `${nums[i]}-${nums[j]}`);
    i = j;
  }
  return parts.join(', ');
}
