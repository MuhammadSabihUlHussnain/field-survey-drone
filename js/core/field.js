// Field and Plant (class diagram). Covers FR-1.1, FR-1.2 and FR-1.4.
import { createRng, hashSeed, clamp, round } from './rng.js';

export const HealthState = Object.freeze({
  Healthy: 'Healthy',
  Stressed: 'Stressed',
  Diseased: 'Diseased',
});

// Survey status of a plant (plant state chart in the UML diagrams).
export const PlantStatus = Object.freeze({
  Unscanned: 'Unscanned',
  Healthy: 'Healthy',
  Flagged: 'Flagged',
  Confirmed: 'Confirmed',
});

export const Distribution = Object.freeze({ Scattered: 'scattered', Patches: 'patches' });

export const FIELD_LIMITS = Object.freeze({
  minGrid: 5,
  maxGrid: 50, // PR-1: up to 2,500 plants (50 x 50)
  minSpacing: 0.5,
  maxSpacing: 3,
  maxDiseasedShare: 0.3, // FR-1.4: 0 to 30 percent
});

// Simulated plant traits per health state. The camera adds noise on top of these.
const TRAIT_PROFILES = {
  [HealthState.Healthy]: { color: [0.82, 0.04], spots: [0.0, 0.04], height: [2.0, 0.1] },
  [HealthState.Stressed]: { color: [0.6, 0.06], spots: [0.04, 0.14], height: [1.75, 0.12] },
  [HealthState.Diseased]: { color: [0.42, 0.07], spots: [0.15, 0.45], height: [1.5, 0.15] },
};

export function normalizeFieldDefinition(def) {
  if (!def || typeof def !== 'object') throw new Error('Field definition must be a JSON object.');
  const problems = [];
  const grid = def.grid ?? {};
  const out = {
    fieldId: String(def.fieldId ?? 'field-1').trim() || 'field-1',
    name: String(def.name ?? def.fieldId ?? 'Field').trim() || 'Field',
    cropType: String(def.cropType ?? 'corn').toLowerCase(),
    grid: {
      columns: Number(grid.columns ?? 50),
      rows: Number(grid.rows ?? 50),
      spacing: Number(grid.spacing ?? 1),
    },
    seed: Number(def.seed ?? 1),
    diseasedShare: Number(def.diseasedShare ?? 0.08),
    stressedShare: def.stressedShare === undefined ? null : Number(def.stressedShare),
    distribution: String(def.distribution ?? Distribution.Patches).toLowerCase(),
  };

  if (out.cropType !== 'corn') problems.push(`crop type "${out.cropType}" is not supported in version 1.0 (corn only)`);
  for (const key of ['columns', 'rows']) {
    const v = out.grid[key];
    if (!Number.isInteger(v) || v < FIELD_LIMITS.minGrid || v > FIELD_LIMITS.maxGrid) {
      problems.push(`grid.${key} must be a whole number from ${FIELD_LIMITS.minGrid} to ${FIELD_LIMITS.maxGrid}`);
    }
  }
  if (!(out.grid.spacing >= FIELD_LIMITS.minSpacing && out.grid.spacing <= FIELD_LIMITS.maxSpacing)) {
    problems.push(`grid.spacing must be from ${FIELD_LIMITS.minSpacing} to ${FIELD_LIMITS.maxSpacing} m`);
  }
  if (!Number.isInteger(out.seed)) problems.push('seed must be a whole number');
  if (!(out.diseasedShare >= 0 && out.diseasedShare <= FIELD_LIMITS.maxDiseasedShare)) {
    problems.push('diseasedShare must be from 0 to 0.30');
  }
  if (out.stressedShare === null) out.stressedShare = round(out.diseasedShare * 0.75, 4);
  if (!(out.stressedShare >= 0 && out.diseasedShare + out.stressedShare <= 1)) {
    problems.push('stressedShare must be 0 or more, and diseasedShare + stressedShare cannot pass 1');
  }
  if (!Object.values(Distribution).includes(out.distribution)) {
    problems.push('distribution must be "scattered" or "patches"');
  }
  if (problems.length) throw new Error(`Invalid field definition: ${problems.join('; ')}.`);
  return out;
}

export function generateField(definition) {
  const def = normalizeFieldDefinition(definition);
  const { columns, rows, spacing } = def.grid;
  const rng = createRng(hashSeed('field', def.seed));
  const total = columns * rows;

  const plants = new Array(total);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < columns; c++) {
      const index = r * columns + c;
      plants[index] = {
        plantId: `p${index + 1}`,
        index,
        row: r,
        col: c,
        x: round((c + 0.5) * spacing, 3),
        z: round((r + 0.5) * spacing, 3),
        healthState: HealthState.Healthy,
        traits: null,
      };
    }
  }

  // Order plants by how likely they are to be sick, then hand out states in that order.
  const nDiseased = Math.round(def.diseasedShare * total);
  const nStressed = Math.round(def.stressedShare * total);
  const score = new Float64Array(total);
  if (def.distribution === Distribution.Patches) {
    const k = Math.max(1, Math.round((nDiseased + nStressed) / 45));
    const centers = Array.from({ length: k }, () => ({
      c: rng.range(columns * 0.12, columns * 0.88),
      r: rng.range(rows * 0.12, rows * 0.88),
    }));
    for (const p of plants) {
      let best = Infinity;
      for (const ctr of centers) best = Math.min(best, Math.hypot(p.col - ctr.c, p.row - ctr.r));
      score[p.index] = best + rng.next() * 1.6;
    }
  } else {
    for (const p of plants) score[p.index] = rng.next();
  }
  const order = plants.map((p) => p.index).sort((a, b) => score[a] - score[b] || a - b);
  order.forEach((idx, i) => {
    if (i < nDiseased) plants[idx].healthState = HealthState.Diseased;
    else if (i < nDiseased + nStressed) plants[idx].healthState = HealthState.Stressed;
  });

  for (const p of plants) {
    const prof = TRAIT_PROFILES[p.healthState];
    p.traits = {
      leafColorIndex: round(clamp(rng.normal(prof.color[0], prof.color[1]), 0.2, 0.95)),
      leafSpotCoverage: round(clamp(rng.range(prof.spots[0], prof.spots[1]), 0, 0.6)),
      canopyHeight: round(clamp(rng.normal(prof.height[0], prof.height[1]), 1.0, 2.4)),
    };
  }

  return {
    definition: def,
    fieldId: def.fieldId,
    name: def.name,
    cropType: def.cropType,
    seed: def.seed,
    columns,
    rows,
    spacing,
    width: columns * spacing,
    length: rows * spacing,
    plants,
  };
}

export function fieldStats(field) {
  const counts = { total: field.plants.length, [HealthState.Healthy]: 0, [HealthState.Stressed]: 0, [HealthState.Diseased]: 0 };
  for (const p of field.plants) counts[p.healthState]++;
  return counts;
}
