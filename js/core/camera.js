// CameraSensor (component diagram, Simulation Core). Covers FR-4.1.
import { createRng, hashSeed, clamp, round } from './rng.js';
import { footprintHalfSize } from './route.js';

export class CameraSensor {
  constructor(field, cameraConfig) {
    this.field = field;
    this.fovDegrees = cameraConfig.fovDegrees;
    this.referenceAltitude = cameraConfig.referenceAltitude;
    this.noise = cameraConfig.noise;
  }

  footprintHalfSize(altitude) {
    return footprintHalfSize(altitude, this.fovDegrees);
  }

  // One PlantReading per plant inside the square footprint under the drone.
  capture({ surveyId, waypointIndex, x, z, altitude, timestamp }) {
    const f = this.field;
    const h = this.footprintHalfSize(altitude);
    const s = f.spacing;
    const c0 = Math.max(0, Math.ceil((x - h) / s - 0.5));
    const c1 = Math.min(f.columns - 1, Math.floor((x + h) / s - 0.5));
    const r0 = Math.max(0, Math.ceil((z - h) / s - 0.5));
    const r1 = Math.min(f.rows - 1, Math.floor((z + h) / s - 0.5));
    // Flying higher blurs the picture, so the readings get noisier.
    const blur = Math.max(0.5, altitude / this.referenceAltitude);
    const readings = [];
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const plant = f.plants[r * f.columns + c];
        // Seeded by field, plant and waypoint so the same route always reads the same values.
        const rng = createRng(hashSeed(f.seed, plant.plantId, waypointIndex));
        const t = plant.traits;
        readings.push({
          readingId: `${surveyId}-w${waypointIndex + 1}-${plant.plantId}`,
          surveyId,
          plantId: plant.plantId,
          x: plant.x,
          z: plant.z,
          timestamp,
          waypointIndex,
          leafColorIndex: round(clamp(t.leafColorIndex + rng.normal(0, this.noise.leafColorIndex * blur), 0, 1)),
          leafSpotCoverage: round(clamp(t.leafSpotCoverage + rng.normal(0, this.noise.leafSpotCoverage * blur), 0, 1)),
          canopyHeight: round(clamp(t.canopyHeight + rng.normal(0, this.noise.canopyHeight * blur), 0, 3)),
        });
      }
    }
    return readings;
  }
}
