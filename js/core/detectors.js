// IDiseaseDetector and RuleBasedDetector (class diagram). Covers FR-4.2, FR-4.3, FR-4.4 and FR-4.6.
import { clamp, round } from './rng.js';

export const DetectionStatus = Object.freeze({
  Healthy: 'Healthy',
  Stressed: 'Stressed',
  Diseased: 'Diseased',
});

const READING_FEATURES = ['leafColorIndex', 'leafSpotCoverage', 'canopyHeight'];

// JavaScript has no interfaces, so this base class plays the part of IDiseaseDetector.
// Survey code only ever calls detect(reading), so a trained image classifier can
// replace the rule-based detector without touching SurveyManager, Drone or HealthMap.
export class IDiseaseDetector {
  get name() {
    throw new Error('IDiseaseDetector.name is not implemented');
  }

  /** @returns {{readingId: string, status: string, confidence: number, detectorName: string}} */
  detect(_reading) {
    throw new Error('IDiseaseDetector.detect() is not implemented');
  }
}

export class RuleBasedDetector extends IDiseaseDetector {
  // FR-4.3: every threshold comes from config/settings.json. Nothing here has a default.
  constructor(ruleConfig) {
    super();
    const problems = [];
    if (!ruleConfig || !Array.isArray(ruleConfig.rules) || ruleConfig.rules.length === 0) {
      problems.push('ruleBased.rules must be a non-empty list');
    } else {
      ruleConfig.rules.forEach((r, i) => {
        if (!READING_FEATURES.includes(r.feature)) problems.push(`rules[${i}].feature must be one of ${READING_FEATURES.join(', ')}`);
        if (typeof r.healthyValue !== 'number' || typeof r.diseasedValue !== 'number' || r.healthyValue === r.diseasedValue) {
          problems.push(`rules[${i}] needs different numeric healthyValue and diseasedValue`);
        }
        if (!(r.weight > 0)) problems.push(`rules[${i}].weight must be above 0`);
      });
    }
    const st = ruleConfig?.statusThresholds;
    if (!st || typeof st.stressed !== 'number' || typeof st.diseased !== 'number' || st.stressed > st.diseased) {
      problems.push('ruleBased.statusThresholds needs numeric stressed <= diseased');
    }
    if (problems.length) throw new Error(`Detector configuration is invalid: ${problems.join('; ')}.`);
    this.rules = ruleConfig.rules.map((r) => ({ ...r }));
    this.statusThresholds = { ...st };
    this.totalWeight = this.rules.reduce((sum, r) => sum + r.weight, 0);
  }

  get name() {
    return 'RuleBasedDetector';
  }

  detect(reading) {
    // Each feature scores 0 at its healthy value and 1 at its diseased value.
    let weighted = 0;
    for (const r of this.rules) {
      const score = clamp((reading[r.feature] - r.healthyValue) / (r.diseasedValue - r.healthyValue), 0, 1);
      weighted += r.weight * score;
    }
    const confidence = round(weighted / this.totalWeight);
    let status = DetectionStatus.Healthy;
    if (confidence >= this.statusThresholds.diseased) status = DetectionStatus.Diseased;
    else if (confidence >= this.statusThresholds.stressed) status = DetectionStatus.Stressed;
    return { readingId: reading.readingId, status, confidence, detectorName: this.name };
  }
}

// FR-4.4: 0.5 or higher is Flagged, below is Healthy.
export function isFlagged(confidence, flagThreshold) {
  return confidence >= flagThreshold;
}

export function createDetector(detectionConfig) {
  if (typeof detectionConfig?.flagThreshold !== 'number') {
    throw new Error('Detector configuration is invalid: detection.flagThreshold must be a number.');
  }
  switch (detectionConfig.activeDetector) {
    case 'rule-based':
      return new RuleBasedDetector(detectionConfig.ruleBased);
    default:
      throw new Error(`Unknown detector "${detectionConfig.activeDetector}". Version 1.0 ships the rule-based detector only.`);
  }
}
