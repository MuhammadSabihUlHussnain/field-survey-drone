// CSV report (FR-6.1) and the JSON files the Results Store writes.

export const CSV_COLUMNS = ['survey_id', 'plant_id', 'x', 'z', 'status', 'confidence', 'zone_id', 'decision', 'timestamp'];

function csvCell(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function surveyToCsv(record) {
  const { meta, healthMap } = record;
  const lines = [CSV_COLUMNS.join(',')];
  for (const p of healthMap.plants) {
    const zone = healthMap.zoneForPlant(p.plantId);
    lines.push(
      [meta.surveyId, p.plantId, p.x, p.z, p.status, p.confidence, zone?.zoneId ?? '', zone?.decision ?? '', p.timestamp ?? '']
        .map(csvCell)
        .join(','),
    );
  }
  return lines.join('\n') + '\n';
}

export function surveyToJson(record) {
  return JSON.stringify({ meta: record.meta, ...record.healthMap.toJSON() }, null, 2);
}

export function surveyLogToJson(meta, log) {
  return JSON.stringify({ surveyId: meta.surveyId, detectorName: meta.detectorName, entries: log }, null, 1);
}

// Simulation-only check against ground truth. A real field has no answer key.
export function groundTruthCheck(field, healthMap) {
  const truth = new Map(field.plants.map((p) => [p.plantId, p.healthState]));
  let truePos = 0;
  let falsePos = 0;
  let missed = 0;
  let diseased = 0;
  let flaggedStressed = 0;
  for (const p of healthMap.plants) {
    if (p.status === 'Unscanned') continue;
    const state = truth.get(p.plantId);
    const flagged = !!healthMap.zoneForPlant(p.plantId);
    if (state === 'Diseased') {
      diseased++;
      if (flagged) truePos++;
      else missed++;
    } else if (flagged) {
      if (state === 'Stressed') flaggedStressed++;
      else falsePos++;
    }
  }
  return { diseased, truePos, missed, flaggedStressed, falsePos };
}

export function formatDuration(seconds) {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
