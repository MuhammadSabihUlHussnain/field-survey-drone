// Run with: npm test   (Node 18 or newer)
// Each test names the SRS requirement it checks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { generateField, fieldStats, HealthState, PlantStatus } from '../js/core/field.js';
import { generateLawnmowerRoute, coverageReport, insertWaypoint, deleteWaypoint, moveWaypoint } from '../js/core/route.js';
import { CameraSensor } from '../js/core/camera.js';
import { createDetector, RuleBasedDetector, IDiseaseDetector, isFlagged, DetectionStatus } from '../js/core/detectors.js';
import { SurveyManager, EndReason, SurveyState } from '../js/core/survey.js';
import { buildZones, ZoneDecision } from '../js/core/healthmap.js';
import { surveyToCsv, CSV_COLUMNS } from '../js/core/report.js';
import { ResultsStore } from '../js/core/storage.js';

const settings = JSON.parse(readFileSync(new URL('../config/settings.json', import.meta.url)));
const defaultField = JSON.parse(readFileSync(new URL('../fields/default-field.json', import.meta.url)));

function runSurvey({ fieldDef = defaultField, battery = 100, detector = createDetector(settings.detection), routeOpts, stopAt } = {}) {
  const field = generateField(fieldDef);
  const route = generateLawnmowerRoute(field, routeOpts ?? { altitude: settings.route.defaultAltitude, lineSpacing: settings.route.defaultLineSpacing });
  const survey = new SurveyManager({
    surveyId: 'S-test',
    field,
    route,
    detector,
    camera: new CameraSensor(field, settings.camera),
    settings,
    initialBattery: battery,
    startedAt: new Date('2026-10-29T12:00:00Z'),
  });
  survey.start();
  let guard = 0;
  while (survey.state !== SurveyState.Finished && guard++ < 100000) {
    survey.step(0.1);
    if (stopAt && survey.simTime >= stopAt) survey.stop();
  }
  return { field, route, survey, record: survey.record() };
}

test('FR-1.2: the same seed builds the same field, a different seed does not', () => {
  const a = generateField(defaultField).plants.map((p) => p.healthState).join();
  const b = generateField(defaultField).plants.map((p) => p.healthState).join();
  const c = generateField({ ...defaultField, seed: 9 }).plants.map((p) => p.healthState).join();
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('FR-1.4: diseased share is honoured and capped at 30 percent', () => {
  const field = generateField({ ...defaultField, diseasedShare: 0.2, distribution: 'scattered' });
  assert.equal(fieldStats(field)[HealthState.Diseased], Math.round(0.2 * 2500));
  assert.throws(() => generateField({ ...defaultField, diseasedShare: 0.31 }), /0 to 0.30/);
  assert.throws(() => generateField({ ...defaultField, cropType: 'wheat' }), /corn only/);
});

test('FR-2.1: the default lawnmower route covers every plant', () => {
  const field = generateField(defaultField);
  const route = generateLawnmowerRoute(field, { altitude: 10, lineSpacing: 6 });
  const cov = coverageReport(field, route, settings.camera.fovDegrees);
  assert.equal(cov.coveredPlants, cov.totalPlants);
  assert.deepEqual(cov.uncoveredRows, []);
});

test('FR-2.2 / FR-2.3: editing the route is reflected, and gaps are reported by row', () => {
  const field = generateField(defaultField);
  let route = generateLawnmowerRoute(field, { altitude: 10, lineSpacing: 6 });
  const n = route.waypoints.length;
  route = insertWaypoint(route, field, 25, 25);
  assert.equal(route.waypoints.length, n + 1);
  route = moveWaypoint(route, field, 0, 1, 1);
  assert.deepEqual([route.waypoints[0].x, route.waypoints[0].z], [1, 1]);
  // Remove the whole first pass line: rows near z = 0 lose coverage.
  const lineStops = Math.ceil(field.width / 6);
  for (let i = 0; i < lineStops; i++) route = deleteWaypoint(route, 0);
  const cov = coverageReport(field, route, settings.camera.fovDegrees);
  assert.ok(cov.uncoveredRows.length > 0);
  assert.equal(cov.uncoveredRows[0], 1);
  assert.ok(route.edited);
});

test('FR-4.3: the detector refuses a configuration without thresholds', () => {
  assert.throws(() => new RuleBasedDetector({ rules: [] }), /non-empty/);
  assert.throws(() => createDetector({ activeDetector: 'rule-based', ruleBased: settings.detection.ruleBased }), /flagThreshold/);
});

test('FR-4.4: confidence of 0.5 or more is flagged, below is healthy', () => {
  assert.equal(isFlagged(0.5, settings.detection.flagThreshold), true);
  assert.equal(isFlagged(0.499, settings.detection.flagThreshold), false);
  const det = createDetector(settings.detection);
  const healthy = det.detect({ readingId: 'h', leafColorIndex: 0.84, leafSpotCoverage: 0.01, canopyHeight: 2.05 });
  const sick = det.detect({ readingId: 'd', leafColorIndex: 0.4, leafSpotCoverage: 0.32, canopyHeight: 1.45 });
  assert.equal(healthy.status, DetectionStatus.Healthy);
  assert.ok(healthy.confidence < 0.5);
  assert.equal(sick.status, DetectionStatus.Diseased);
  assert.ok(sick.confidence >= 0.5);
});

test('PR-2: one detection takes well under 5 ms', () => {
  const det = createDetector(settings.detection);
  const t0 = performance.now();
  for (let i = 0; i < 10000; i++) det.detect({ readingId: 'x', leafColorIndex: 0.6, leafSpotCoverage: 0.1, canopyHeight: 1.7 });
  assert.ok((performance.now() - t0) / 10000 < 5);
});

test('FR-3.1 / FR-4.5 / PR-4: a full survey completes, logs every reading and finishes in under 5 minutes', () => {
  const { field, survey, record } = runSurvey();
  assert.equal(record.meta.endReason, EndReason.Completed);
  assert.equal(survey.plantsScanned, field.plants.length);
  assert.equal(record.meta.readingsCount, survey.log.length);
  assert.ok(survey.log.length >= field.plants.length);
  assert.ok(survey.log.every((e) => e.reading && e.detection && typeof e.detection.confidence === 'number'));
  assert.ok(record.meta.flightTimeSeconds < 300, `flight took ${record.meta.flightTimeSeconds}s`);
  // The drone is back on the pad.
  assert.equal(survey.drone.y, 0);
  assert.equal(survey.drone.x, settings.drone.basePad.x);
});

test('SRS 3.6 Reliability: same field and route give the same detections', () => {
  const a = runSurvey().record.healthMap.plants.map((p) => `${p.plantId}:${p.confidence}`).join();
  const b = runSurvey().record.healthMap.plants.map((p) => `${p.plantId}:${p.confidence}`).join();
  assert.equal(a, b);
});

test('FR-3.4: below 20 percent battery the drone returns and keeps its readings', () => {
  const { survey, record } = runSurvey({ battery: 45 });
  assert.equal(record.meta.endReason, EndReason.LowBattery);
  assert.ok(survey.plantsScanned > 0 && survey.plantsScanned < survey.field.plants.length);
  assert.ok(record.meta.waypointsScanned < record.meta.waypointsPlanned);
  assert.equal(survey.drone.y, 0);
  assert.equal(survey.drone.z, settings.drone.basePad.z);
  const unscanned = record.healthMap.plants.filter((p) => p.status === PlantStatus.Unscanned).length;
  assert.ok(unscanned > 0);
});

test('FR-3.5: stopping a survey ends it with reason "stopped"', () => {
  const { record } = runSurvey({ stopAt: 30 });
  assert.equal(record.meta.endReason, EndReason.Stopped);
});

test('FR-4.6: any IDiseaseDetector can replace the rule-based one with no other change', () => {
  class EverythingIsSick extends IDiseaseDetector {
    get name() {
      return 'EverythingIsSick';
    }
    detect(r) {
      return { readingId: r.readingId, status: 'Diseased', confidence: 0.99, detectorName: this.name };
    }
  }
  const { record } = runSurvey({ fieldDef: { ...defaultField, grid: { columns: 12, rows: 12, spacing: 1 } }, detector: new EverythingIsSick() });
  assert.equal(record.meta.detectorName, 'EverythingIsSick');
  assert.equal(record.healthMap.summary().plantsFlagged, 144);
  assert.equal(record.healthMap.zones.length, 1);
});

test('FR-5.1: flagged plants within 3 m share a zone, farther ones do not', () => {
  const pts = [
    { plantId: 'a', x: 0, z: 0, confidence: 0.9 },
    { plantId: 'b', x: 2.5, z: 0, confidence: 0.7 },
    { plantId: 'c', x: 5, z: 0, confidence: 0.6 }, // chains through b
    { plantId: 'd', x: 20, z: 20, confidence: 0.8 },
  ];
  const zones = buildZones(pts, 3);
  assert.equal(zones.length, 2);
  assert.deepEqual(zones[0].plantIds.sort(), ['a', 'b', 'c']);
  assert.equal(zones[0].zoneId, 'Z1');
  assert.equal(buildZones(pts, 2).length, 4);
});

test('FR-5.3 / FR-5.4: approve confirms plants, reject returns them to healthy, both are timestamped', () => {
  const { record } = runSurvey();
  const hm = record.healthMap;
  assert.ok(hm.zones.length >= 2, 'default field should produce at least two zones');
  const [z1, z2] = hm.zones;
  hm.decide(z1.zoneId, ZoneDecision.Approved, new Date('2026-10-29T13:00:00Z'));
  hm.decide(z2.zoneId, ZoneDecision.Rejected);
  assert.ok(z1.plantIds.every((id) => hm.plantById.get(id).status === PlantStatus.Confirmed));
  assert.ok(z2.plantIds.every((id) => hm.plantById.get(id).status === PlantStatus.Healthy));
  assert.equal(hm.decisions[0].decidedAt, '2026-10-29T13:00:00.000Z');
  assert.equal(hm.summary().zonesApproved, 1);
});

test('FR-6.1: CSV export has the required columns and one row per plant', () => {
  const { field, record } = runSurvey();
  const lines = surveyToCsv(record).trim().split('\n');
  assert.equal(lines[0], CSV_COLUMNS.join(','));
  assert.equal(lines[0], 'survey_id,plant_id,x,z,status,confidence,zone_id,decision,timestamp');
  assert.equal(lines.length, field.plants.length + 1);
});

test('FR-5.5: results of earlier surveys are kept in the store', () => {
  const mem = new Map();
  const store = new ResultsStore({ getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v), removeItem: (k) => mem.delete(k) });
  const a = runSurvey().record;
  const b = runSurvey().record;
  b.meta = { ...b.meta, surveyId: 'S-test-2', startTime: '2026-10-29T12:30:00.000Z' };
  store.save(a);
  store.save(b);
  const list = store.list();
  assert.equal(list.length, 2);
  assert.equal(list[0].meta.surveyId, 'S-test-2');
  assert.equal(list[1].healthMap.zones.length, a.healthMap.zones.length);
});
