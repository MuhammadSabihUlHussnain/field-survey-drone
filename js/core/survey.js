// SurveyManager (class diagram, Simulation Core). Runs UC1 and UC2: FR-3.1 to FR-3.5 and FR-4.1 to FR-4.5.
import { Drone, DroneState } from './drone.js';
import { PlantStatus } from './field.js';
import { HealthMap } from './healthmap.js';
import { isFlagged } from './detectors.js';
import { round } from './rng.js';

export const EndReason = Object.freeze({
  Completed: 'completed',
  LowBattery: 'low battery',
  Stopped: 'stopped',
});

export const SurveyState = Object.freeze({
  Ready: 'ready',
  Running: 'running',
  Paused: 'paused',
  Finished: 'finished',
});

const MAX_TICK = 0.05; // seconds of simulated time per physics step

export function newSurveyId(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `S-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

export class SurveyManager {
  constructor({ surveyId, field, route, detector, camera, settings, initialBattery = 100, startedAt = new Date(), trigger = 'farmer' }) {
    if (!route.waypoints.length) throw new Error('The route has no waypoints. Add at least one before starting.');
    this.surveyId = surveyId;
    this.field = field;
    this.route = route;
    this.detector = detector; // any IDiseaseDetector (FR-4.2, FR-4.6)
    this.camera = camera;
    this.settings = settings;
    this.trigger = trigger;
    this.flagThreshold = settings.detection.flagThreshold;
    this.returnBelow = settings.drone.returnBelowPercent;
    this.dwell = settings.drone.scanDwellSeconds;
    this.drone = new Drone({ ...settings.drone, battery: initialBattery });
    this.initialBattery = initialBattery;
    this.state = SurveyState.Ready;
    this.startedAt = startedAt;
    this.simTime = 0;
    this.endReason = null;
    this.targetIndex = -1;
    this.waypointsScanned = 0;
    this.scanTimer = 0;
    this.log = []; // FR-4.5: every reading and every detection, flagged or not
    this.best = new Map(); // plantId -> best detection so far
    this.flaggedCount = 0;
    this.healthMap = null;
    this.listeners = new Map();
  }

  on(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(fn);
    return this;
  }

  emit(event, payload) {
    for (const fn of this.listeners.get(event) ?? []) fn(payload);
  }

  get plantsScanned() {
    return this.best.size;
  }

  timestampAt(simSeconds) {
    return new Date(this.startedAt.getTime() + simSeconds * 1000).toISOString();
  }

  // FR-3.1
  start() {
    if (this.state !== SurveyState.Ready) throw new Error(`Survey ${this.surveyId} has already started`);
    this.state = SurveyState.Running;
    this.drone.takeOff();
    this.emit('start', { surveyId: this.surveyId, trigger: this.trigger });
  }

  // FR-3.5
  pause() {
    if (this.state === SurveyState.Running) {
      this.state = SurveyState.Paused;
      this.emit('pause');
    }
  }

  resume() {
    if (this.state === SurveyState.Paused) {
      this.state = SurveyState.Running;
      this.emit('resume');
    }
  }

  // Stopping sends the drone home; readings so far are kept.
  stop() {
    if (this.state === SurveyState.Finished || this.state === SurveyState.Ready || this.endReason) return;
    this.endReason = EndReason.Stopped;
    if (this.drone.state !== DroneState.TakingOff) this.drone.state = DroneState.Returning;
    this.state = SurveyState.Running;
    this.emit('stop');
  }

  step(dt) {
    let remaining = dt;
    while (remaining > 1e-9 && this.state === SurveyState.Running) {
      const h = Math.min(MAX_TICK, remaining);
      this.tick(h);
      remaining -= h;
    }
  }

  tick(dt) {
    this.simTime += dt;
    const d = this.drone;
    switch (d.state) {
      case DroneState.TakingOff:
        if (d.climbTo(this.route.altitude, dt)) {
          if (this.endReason) d.state = DroneState.Returning;
          else this.advance();
        }
        break;
      case DroneState.Flying: {
        const wp = this.route.waypoints[this.targetIndex];
        if (d.flyTo(wp.x, wp.z, wp.altitude ?? this.route.altitude, dt)) {
          d.state = DroneState.Scanning;
          d.hover();
          this.scanTimer = this.dwell;
          this.scan(wp);
        }
        break;
      }
      case DroneState.Scanning:
        d.hover();
        this.scanTimer -= dt;
        if (this.scanTimer <= 0) this.advance();
        break;
      case DroneState.Returning:
        if (d.flyTo(d.basePad.x, d.basePad.z, this.route.altitude, dt)) d.state = DroneState.Landing;
        break;
      case DroneState.Landing:
        if (d.descend(dt)) this.finish();
        break;
      default:
        break;
    }
    d.drainBattery(dt);

    // FR-3.4: below 20 percent, abandon the route and go home. Readings already taken stay.
    if (d.isSurveying && d.battery < this.returnBelow && !this.endReason) {
      this.endReason = EndReason.LowBattery;
      d.state = DroneState.Returning;
      this.emit('lowBattery', { battery: d.battery, waypoint: this.targetIndex + 1 });
    }
  }

  advance() {
    this.targetIndex++;
    if (this.targetIndex >= this.route.waypoints.length) {
      if (!this.endReason) this.endReason = EndReason.Completed;
      this.drone.state = DroneState.Returning;
      this.emit('routeDone');
    } else {
      this.drone.state = DroneState.Flying;
      this.emit('waypoint', { index: this.targetIndex, total: this.route.waypoints.length });
    }
  }

  // FR-4.1 to FR-4.5
  scan(wp) {
    const altitude = wp.altitude ?? this.route.altitude;
    const readings = this.camera.capture({
      surveyId: this.surveyId,
      waypointIndex: this.targetIndex,
      x: wp.x,
      z: wp.z,
      altitude,
      timestamp: this.timestampAt(this.simTime),
    });
    let newlyFlagged = 0;
    const flaggedNow = [];
    for (const reading of readings) {
      const detection = this.detector.detect(reading);
      this.log.push({ reading, detection });
      const prev = this.best.get(reading.plantId);
      // A plant seen from two waypoints keeps its strongest detection.
      if (!prev || detection.confidence > prev.detection.confidence) {
        const wasFlagged = prev && isFlagged(prev.detection.confidence, this.flagThreshold);
        this.best.set(reading.plantId, { reading, detection });
        if (!wasFlagged && isFlagged(detection.confidence, this.flagThreshold)) {
          newlyFlagged++;
          flaggedNow.push(reading.plantId);
        }
      }
    }
    this.flaggedCount += newlyFlagged;
    this.waypointsScanned++;
    this.emit('scan', {
      waypointIndex: this.targetIndex,
      x: wp.x,
      z: wp.z,
      halfSize: this.camera.footprintHalfSize(altitude),
      readings: readings.length,
      flagged: newlyFlagged,
      flaggedPlantIds: flaggedNow,
    });
  }

  plantRecords() {
    return this.field.plants.map((p) => {
      const b = this.best.get(p.plantId);
      if (!b) {
        return { plantId: p.plantId, x: p.x, z: p.z, status: PlantStatus.Unscanned, confidence: null, detectionStatus: null, timestamp: null, readingId: null, reading: null };
      }
      const flagged = isFlagged(b.detection.confidence, this.flagThreshold);
      return {
        plantId: p.plantId,
        x: p.x,
        z: p.z,
        status: flagged ? PlantStatus.Flagged : PlantStatus.Healthy,
        confidence: b.detection.confidence,
        detectionStatus: b.detection.status,
        timestamp: b.reading.timestamp,
        readingId: b.reading.readingId,
        reading: {
          leafColorIndex: b.reading.leafColorIndex,
          leafSpotCoverage: b.reading.leafSpotCoverage,
          canopyHeight: b.reading.canopyHeight,
        },
      };
    });
  }

  finish() {
    this.state = SurveyState.Finished;
    this.healthMap = new HealthMap({
      surveyId: this.surveyId,
      plants: this.plantRecords(),
      groupingDistance: this.settings.zones.groupingDistance,
    });
    this.emit('finish', this.record());
  }

  // The results file for this survey (SRS 3.4: Survey, Detection and Zone entities).
  record() {
    return {
      meta: {
        surveyId: this.surveyId,
        fieldId: this.field.fieldId,
        fieldName: this.field.name,
        fieldDefinition: this.field.definition,
        routeId: this.route.routeId,
        routeEdited: this.route.edited,
        altitude: this.route.altitude,
        lineSpacing: this.route.lineSpacing,
        trigger: this.trigger,
        startTime: this.startedAt.toISOString(),
        endTime: this.timestampAt(this.simTime),
        endReason: this.endReason,
        flightTimeSeconds: round(this.simTime, 1),
        detectorName: this.detector.name,
        flagThreshold: this.flagThreshold,
        waypointsPlanned: this.route.waypoints.length,
        waypointsScanned: this.waypointsScanned,
        readingsCount: this.log.length,
        initialBattery: this.initialBattery,
        finalBattery: round(this.drone.battery, 1),
      },
      healthMap: this.healthMap,
    };
  }
}
