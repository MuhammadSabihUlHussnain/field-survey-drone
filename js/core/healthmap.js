// HealthMap and Zone (class diagram). Covers FR-5.1, FR-5.3, FR-5.4 and FR-6.2.
import { PlantStatus } from './field.js';
import { round } from './rng.js';

export const ZoneDecision = Object.freeze({
  Pending: 'pending',
  Approved: 'approved',
  Rejected: 'rejected',
});

// FR-5.1: flagged plants within `distance` metres of each other end up in the same zone
// (single-linkage grouping with a union-find over a spatial grid).
export function buildZones(flaggedPlants, distance) {
  const n = flaggedPlants.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i) => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const cellKey = (cx, cz) => `${cx},${cz}`;
  const grid = new Map();
  flaggedPlants.forEach((p, i) => {
    const key = cellKey(Math.floor(p.x / distance), Math.floor(p.z / distance));
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(i);
  });
  flaggedPlants.forEach((p, i) => {
    const cx = Math.floor(p.x / distance);
    const cz = Math.floor(p.z / distance);
    for (let ox = -1; ox <= 1; ox++) {
      for (let oz = -1; oz <= 1; oz++) {
        for (const j of grid.get(cellKey(cx + ox, cz + oz)) ?? []) {
          if (j <= i) continue;
          const q = flaggedPlants[j];
          if (Math.hypot(p.x - q.x, p.z - q.z) <= distance + 1e-9) parent[find(i)] = find(j);
        }
      }
    }
  });

  const groups = new Map();
  flaggedPlants.forEach((p, i) => {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(p);
  });

  const zones = [...groups.values()].map((members) => {
    const cx = members.reduce((s, p) => s + p.x, 0) / members.length;
    const cz = members.reduce((s, p) => s + p.z, 0) / members.length;
    const confs = members.map((p) => p.confidence);
    return {
      zoneId: '',
      plantIds: members.map((p) => p.plantId),
      centerX: round(cx, 2),
      centerZ: round(cz, 2),
      radius: round(Math.max(...members.map((p) => Math.hypot(p.x - cx, p.z - cz))) + 0.8, 2),
      avgConfidence: round(confs.reduce((s, c) => s + c, 0) / confs.length),
      maxConfidence: round(Math.max(...confs)),
      decision: ZoneDecision.Pending,
      decidedAt: null,
    };
  });
  // Strongest zones first, so Z1 is the one to look at first.
  zones.sort((a, b) => b.maxConfidence - a.maxConfidence || b.plantIds.length - a.plantIds.length || a.centerX - b.centerX || a.centerZ - b.centerZ);
  zones.forEach((z, i) => (z.zoneId = `Z${i + 1}`));
  return zones;
}

export class HealthMap {
  // plants: one record per field plant, with status and best detection (see SurveyManager.plantRecords).
  constructor({ surveyId, plants, groupingDistance, zones = null, decisions = [] }) {
    this.surveyId = surveyId;
    this.groupingDistance = groupingDistance;
    this.plants = plants;
    this.plantById = new Map(plants.map((p) => [p.plantId, p]));
    this.zones = zones ?? buildZones(plants.filter((p) => p.status === PlantStatus.Flagged), groupingDistance);
    this.decisions = decisions;
    this.zoneByPlant = new Map();
    for (const z of this.zones) for (const id of z.plantIds) this.zoneByPlant.set(id, z);
  }

  getZone(zoneId) {
    return this.zones.find((z) => z.zoneId === zoneId) ?? null;
  }

  zoneForPlant(plantId) {
    return this.zoneByPlant.get(plantId) ?? null;
  }

  // FR-5.3 and FR-5.4. Approved plants become Confirmed, rejected ones go back to Healthy.
  decide(zoneId, decision, at = new Date()) {
    if (decision !== ZoneDecision.Approved && decision !== ZoneDecision.Rejected) {
      throw new Error(`Decision must be "${ZoneDecision.Approved}" or "${ZoneDecision.Rejected}"`);
    }
    const zone = this.getZone(zoneId);
    if (!zone) throw new Error(`No zone ${zoneId} in survey ${this.surveyId}`);
    zone.decision = decision;
    zone.decidedAt = at.toISOString();
    const status = decision === ZoneDecision.Approved ? PlantStatus.Confirmed : PlantStatus.Healthy;
    for (const id of zone.plantIds) this.plantById.get(id).status = status;
    const entry = { zoneId, decision, decidedAt: zone.decidedAt };
    this.decisions.push(entry);
    return entry;
  }

  // FR-6.2 (flight time comes from the survey record).
  summary() {
    const scanned = this.plants.filter((p) => p.status !== PlantStatus.Unscanned).length;
    const flagged = this.zones.reduce((s, z) => s + z.plantIds.length, 0);
    const count = (d) => this.zones.filter((z) => z.decision === d).length;
    return {
      plantsTotal: this.plants.length,
      plantsScanned: scanned,
      plantsFlagged: flagged,
      zonesFound: this.zones.length,
      zonesApproved: count(ZoneDecision.Approved),
      zonesRejected: count(ZoneDecision.Rejected),
      zonesPending: count(ZoneDecision.Pending),
    };
  }

  toJSON() {
    return {
      surveyId: this.surveyId,
      groupingDistance: this.groupingDistance,
      plants: this.plants,
      zones: this.zones,
      decisions: this.decisions,
    };
  }

  static fromJSON(data) {
    return new HealthMap(data);
  }
}
