// Map Dashboard, screens and wiring. The simulation itself lives in js/core.
import { generateField, fieldStats, HealthState, PlantStatus } from './core/field.js';
import {
  generateLawnmowerRoute,
  coverageReport,
  insertWaypoint,
  moveWaypoint,
  deleteWaypoint,
  estimateFlight,
  formatRanges,
  footprintHalfSize,
} from './core/route.js';
import { CameraSensor } from './core/camera.js';
import { createDetector, isFlagged } from './core/detectors.js';
import { SurveyManager, SurveyState, EndReason, newSurveyId } from './core/survey.js';
import { ZoneDecision } from './core/healthmap.js';
import { surveyToCsv, surveyToJson, surveyLogToJson, groundTruthCheck, formatDuration } from './core/report.js';
import { ResultsStore } from './core/storage.js';
import { MapView, MAP_COLORS, drawGround, drawPlants, drawRoute, drawDrone, drawFootprint, hitWaypoint } from './ui/mapview.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const app = {
  settings: null,
  fieldDef: null,
  field: null,
  route: null,
  routeOpts: null,
  coverage: null,
  store: new ResultsStore(),
  logs: new Map(), // surveyId -> log, for surveys flown this session
  survey: null,
  speed: 1,
  tool: 'move',
  drag: null,
  hoverWp: -1,
  scene: null,
  scenePromise: null,
  sceneFailed: false,
  sceneField: null,
  viewing: null,
  viewingField: null,
  selectedZone: null,
  schedule: null,
  screen: 'loading',
  events: [],
  lastStatus: 0,
};

const DRONE_STATE_LABEL = {
  Idle: 'On pad',
  TakingOff: 'Taking off',
  Flying: 'Flying',
  Scanning: 'Scanning',
  Returning: 'Returning',
  Landing: 'Landing',
};

const ZONE_COLORS = {
  [ZoneDecision.Pending]: MAP_COLORS.zonePending,
  [ZoneDecision.Approved]: MAP_COLORS.zoneApproved,
  [ZoneDecision.Rejected]: MAP_COLORS.zoneRejected,
};

const TRUTH_COLORS = {
  [HealthState.Healthy]: MAP_COLORS.plantHealthy,
  [HealthState.Stressed]: MAP_COLORS.plantStressed,
  [HealthState.Diseased]: MAP_COLORS.plantDiseased,
};

// ---------- small helpers ----------

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

const fmtInt = (n) => Number(n).toLocaleString('en-US');
const fmtConf = (c) => (c === null || c === undefined ? '–' : c.toFixed(2));
const fmtPct = (n) => `${Math.round(n)}%`;
const clockTime = (d) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const shortDateTime = (iso) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

function toast(message, kind = 'info', ms = 4200) {
  const el = h('div', { class: `toast ${kind}` }, message);
  $('#toasts').append(el);
  setTimeout(() => el.remove(), ms);
}

function download(filename, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

async function fetchJson(url) {
  let res;
  try {
    res = await fetch(url, { cache: 'no-cache' });
  } catch {
    throw new Error(`Could not read ${url}.`);
  }
  if (!res.ok) throw new Error(`Could not read ${url} (HTTP ${res.status}).`);
  return res.json();
}

function show(name) {
  for (const s of $$('.screen')) s.hidden = s.id !== `screen-${name}`;
  document.body.dataset.screen = name;
  app.screen = name;
  if (name === 'menu') renderMenu();
  if (name === 'setup') drawPlanner();
  if (name === 'dashboard') drawDashboard();
  updateSteps();
}

function updateSteps() {
  const flying = app.survey && app.survey.state !== SurveyState.Finished;
  $('[data-step="survey"]').disabled = !app.survey;
  $('[data-step="dashboard"]').disabled = !app.viewing && app.store.list().length === 0;
  $('[data-step="setup"]').disabled = !!flying;
}

function openModal(id) {
  $(id).hidden = false;
  $(id).querySelector('button, input')?.focus();
}

function closeModals() {
  for (const m of $$('.modal')) m.hidden = true;
}

// ---------- field and route (FR-1.x, FR-2.x) ----------

function setField(def, { quiet = false } = {}) {
  const field = generateField(def);
  app.fieldDef = field.definition;
  app.field = field;
  app.planner.setField(field, app.settings.drone.basePad);
  syncFieldForm();
  rebuildRoute();
  if (!quiet) toast(`Loaded ${field.name}: ${field.columns} × ${field.rows} plants.`);
}

function rebuildRoute() {
  app.route = generateLawnmowerRoute(app.field, app.routeOpts);
  routeChanged();
}

function routeChanged() {
  app.coverage = coverageReport(app.field, app.route, app.settings.camera.fovDegrees);
  renderRouteStats();
  drawPlanner();
}

function syncFieldForm() {
  const d = app.fieldDef;
  $('#field-name').value = d.name;
  $('#field-seed').value = d.seed;
  const size = $('#field-size');
  const key = d.grid.columns === d.grid.rows ? String(d.grid.columns) : `${d.grid.columns}x${d.grid.rows}`;
  if (![...size.options].some((o) => o.value === key)) {
    size.append(h('option', { value: key }, `${d.grid.columns} × ${d.grid.rows} (${fmtInt(d.grid.columns * d.grid.rows)} plants)`));
  }
  size.value = key;
  $('#field-share').value = Math.round(d.diseasedShare * 100);
  $('#field-share-out').textContent = fmtPct(d.diseasedShare * 100);
  for (const r of $$('input[name="distribution"]')) r.checked = r.value === d.distribution;
  const st = fieldStats(app.field);
  $('#field-stats').textContent = `${fmtInt(st.total)} plants · ${fmtInt(st.Diseased)} diseased · ${fmtInt(st.Stressed)} stressed (simulated)`;
}

function applyFieldForm() {
  const d = app.fieldDef;
  const [cols, rows] = $('#field-size').value.split('x').map(Number);
  const def = {
    ...d,
    name: $('#field-name').value.trim() || d.name,
    seed: Math.trunc(Number($('#field-seed').value)),
    grid: { columns: cols, rows: rows ?? cols, spacing: d.grid.spacing },
    diseasedShare: Number($('#field-share').value) / 100,
    stressedShare: undefined,
    distribution: $('input[name="distribution"]:checked')?.value ?? d.distribution,
  };
  try {
    setField(def, { quiet: true });
  } catch (err) {
    toast(err.message, 'error');
    syncFieldForm();
  }
}

function renderRouteStats() {
  const s = app.settings;
  const r = app.route;
  const est = estimateFlight(r, s.drone);
  const half = footprintHalfSize(r.altitude, s.camera.fovDegrees);
  const kv = $('#route-stats');
  kv.replaceChildren(
    h('dt', {}, 'Waypoints'),
    h('dd', {}, `${r.waypoints.length}${r.edited ? ' (edited)' : ''}`),
    h('dt', {}, 'Route length'),
    h('dd', {}, `${Math.round(est.lengthMeters)} m`),
    h('dt', {}, 'Camera footprint'),
    h('dd', {}, `${(half * 2).toFixed(1)} × ${(half * 2).toFixed(1)} m`),
    h('dt', {}, 'Estimated flight'),
    h('dd', {}, `${formatDuration(est.seconds)} at 1×`),
    h('dt', {}, 'Estimated battery use'),
    h('dd', {}, fmtPct(est.batteryPercent)),
  );

  const box = $('#coverage-box');
  const cov = app.coverage;
  const notes = [];
  let warn = false;
  if (!r.waypoints.length) {
    warn = true;
    notes.push('The route has no waypoints. Add some, or reset the route.');
  } else if (cov.uncoveredRows.length) {
    // FR-2.3
    warn = true;
    const missing = cov.totalPlants - cov.coveredPlants;
    notes.push(`${fmtInt(missing)} plants would not be scanned. Rows left out: ${formatRanges(cov.uncoveredRows)}.`);
  } else {
    notes.push('Every plant falls inside a camera footprint.');
  }
  const battery = Number($('#start-battery').value);
  if (r.waypoints.length && battery - est.batteryPercent < s.drone.returnBelowPercent) {
    warn = true;
    notes.push(`This route needs about ${fmtPct(est.batteryPercent)} battery. Starting at ${battery}%, the drone will turn back before it finishes.`);
  }
  box.className = `notice ${warn ? 'warn' : 'ok'}`;
  box.replaceChildren(...notes.map((n) => h('div', {}, n)));
  $('#btn-start-survey').disabled = r.waypoints.length === 0;
}

function drawPlanner() {
  if (!app.field || app.screen !== 'setup') return;
  const showTruth = $('#planner-truth').checked;
  const showFp = $('#planner-footprints').checked;
  const cov = app.coverage;
  const f = app.field;
  const half = footprintHalfSize(app.route.altitude, app.settings.camera.fovDegrees);
  app.planner.draw((ctx, v) => {
    drawGround(ctx, v);
    if (cov.uncoveredRows.length) {
      ctx.fillStyle = MAP_COLORS.uncovered;
      for (const row of cov.uncoveredRows) {
        const [x0, y0] = v.toCanvas(0, (row - 1) * f.spacing);
        ctx.fillRect(x0, y0, f.width * v.scale, f.spacing * v.scale);
      }
    }
    drawPlants(ctx, v, (p) => {
      if (!cov.covered[p.index]) return '#e5484d';
      return showTruth ? TRUTH_COLORS[p.healthState] : MAP_COLORS.plantNeutral;
    });
    drawRoute(ctx, v, app.route, { highlight: app.drag ? app.drag.index : app.hoverWp, numbers: true, halfSize: showFp ? half : null });
  });
}

function bindPlanner() {
  const canvas = $('#planner-canvas');
  let pending = false;
  const redrawSoon = () => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      drawPlanner();
    });
  };
  canvas.addEventListener('pointerdown', (e) => {
    const { px, py, x, z } = app.planner.eventToField(e);
    const hit = hitWaypoint(app.planner, app.route, px, py);
    if (app.tool === 'move' && hit >= 0) {
      app.drag = { index: hit };
      canvas.setPointerCapture(e.pointerId);
      drawPlanner();
    } else if (app.tool === 'add') {
      app.route = insertWaypoint(app.route, app.field, x, z);
      routeChanged();
    } else if (app.tool === 'delete' && hit >= 0) {
      app.route = deleteWaypoint(app.route, hit);
      app.hoverWp = -1;
      routeChanged();
    }
  });
  canvas.addEventListener('pointermove', (e) => {
    const { px, py, x, z } = app.planner.eventToField(e);
    if (app.drag) {
      app.route = moveWaypoint(app.route, app.field, app.drag.index, x, z);
      app.coverage = coverageReport(app.field, app.route, app.settings.camera.fovDegrees);
      redrawSoon();
      return;
    }
    const hit = hitWaypoint(app.planner, app.route, px, py);
    canvas.style.cursor = app.tool === 'add' ? 'copy' : hit >= 0 ? (app.tool === 'delete' ? 'not-allowed' : 'grab') : 'default';
    if (hit !== app.hoverWp) {
      app.hoverWp = hit;
      redrawSoon();
    }
  });
  const endDrag = () => {
    if (!app.drag) return;
    app.drag = null;
    routeChanged();
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('pointerleave', () => {
    if (!app.drag && app.hoverWp !== -1) {
      app.hoverWp = -1;
      redrawSoon();
    }
  });
}

// ---------- survey flight (UC1, UC2) ----------

function loadScene() {
  if (!app.scenePromise) {
    app.scenePromise = import('./ui/scene3d.js')
      .then(({ FieldScene }) => {
        app.scene = new FieldScene($('#scene-host'), $('#inset-frame'), {
          fovDegrees: app.settings.camera.fovDegrees,
          basePad: app.settings.drone.basePad,
        });
      })
      .catch((err) => {
        console.error('3D view unavailable:', err);
        app.sceneFailed = true;
        $('#scene-fallback').hidden = false;
        $('#inset-frame').hidden = true;
        $('.cam-toggle').hidden = true;
      });
  }
  return app.scenePromise;
}

async function startSurvey(trigger = 'farmer') {
  if (app.survey && app.survey.state !== SurveyState.Finished) {
    toast('A survey is already in progress.', 'warn');
    return false;
  }
  if (!app.route.waypoints.length) {
    toast('The route has no waypoints. Add some, or reset the route.', 'error');
    return false;
  }
  const settings = app.settings;
  let detector;
  try {
    detector = createDetector(settings.detection);
  } catch (err) {
    toast(err.message, 'error');
    return false;
  }
  const field = app.field;
  const survey = new SurveyManager({
    surveyId: newSurveyId(),
    field,
    route: app.route,
    detector,
    camera: new CameraSensor(field, settings.camera),
    settings,
    initialBattery: Number($('#start-battery').value),
    trigger,
  });
  app.survey = survey;
  app.events = [];
  app.minimap.setField(field, settings.drone.basePad);
  $('#st-survey-id').textContent = survey.surveyId;
  $('#st-battery-mark').style.left = `${settings.drone.returnBelowPercent}%`;
  setSpeedButtons();

  survey
    .on('start', ({ trigger: t }) => logEvent(t === 'timer' ? 'Survey Timer started the survey. Taking off.' : 'Taking off from the base pad.', 'done'))
    .on('scan', (e) => {
      app.scene?.pulseFootprint();
      if (e.flagged) {
        app.scene?.addFlags(e.flaggedPlantIds);
        logEvent(`Waypoint ${e.waypointIndex + 1}: ${e.readings} plants read, ${e.flagged} flagged.`, 'flag');
      }
    })
    .on('lowBattery', ({ battery, waypoint }) => {
      const msg = `Battery at ${battery.toFixed(0)}% near waypoint ${waypoint}. Leaving the route and returning to base.`;
      logEvent(msg, 'warn');
      toast(msg, 'warn');
    })
    .on('routeDone', () => logEvent('Route complete. Returning to base.', 'done'))
    .on('stop', () => logEvent('Survey stopped. Returning to base.', 'warn'))
    .on('pause', () => logEvent('Paused.'))
    .on('resume', () => logEvent('Resumed.'))
    .on('finish', (record) => onSurveyFinished(survey, record));

  show('survey');
  renderEvents();
  await loadScene();
  if (app.scene) {
    if (app.sceneField !== field) {
      app.scene.setField(field);
      app.sceneField = field;
    }
    app.scene.setRoute(app.route);
    app.scene.resetSurvey();
  }
  if (app.survey !== survey) return false; // quit while loading
  survey.start();
  renderStatus();
  updateSteps();
  return true;
}

function logEvent(text, kind = '') {
  if (!app.survey) return;
  app.events.unshift({ t: app.survey.simTime, text, kind });
  app.events.length = Math.min(app.events.length, 80);
  renderEvents();
}

function renderEvents() {
  $('#event-log').replaceChildren(
    ...app.events.map((e) => h('li', { class: e.kind }, h('time', {}, formatDuration(e.t)), h('span', {}, e.text))),
  );
}

// UI-2, FR-3.3: refreshed four times a second.
function renderStatus() {
  const s = app.survey;
  if (!s) return;
  const d = s.drone;
  const n = s.route.waypoints.length;
  const rule = app.settings.drone.returnBelowPercent;
  $('#st-battery').textContent = `${d.battery.toFixed(0)}%`;
  const bar = $('#st-battery-bar');
  bar.style.width = `${d.battery}%`;
  bar.className = d.battery < rule + 3 ? 'critical' : d.battery < 40 ? 'low' : '';
  const wp = s.targetIndex < 0 ? 0 : Math.min(s.targetIndex + 1, n);
  $('#st-waypoint').textContent = `${wp} of ${n}`;
  $('#st-scanned').textContent = fmtInt(s.plantsScanned);
  $('#st-flagged').textContent = fmtInt(s.flaggedCount);
  $('#st-altitude').textContent = `${d.y.toFixed(1)} m`;
  $('#st-state').textContent = s.state === SurveyState.Finished ? 'Landed' : DRONE_STATE_LABEL[d.state];
  $('#st-time').textContent = formatDuration(s.simTime);

  const hud = $('#hud-state');
  let label = DRONE_STATE_LABEL[d.state];
  let cls = '';
  if (s.state === SurveyState.Paused) {
    label = 'Paused';
    cls = 'warn';
  } else if (s.state === SurveyState.Finished) {
    label = 'Landed';
  } else if (s.endReason === EndReason.LowBattery) {
    label = 'Low battery · returning';
    cls = 'danger';
  } else if (s.endReason === EndReason.Stopped) {
    label = 'Stopped · returning';
    cls = 'warn';
  } else if (s.state === SurveyState.Ready) {
    label = 'Ready';
  }
  hud.textContent = label;
  hud.className = `hud-state ${cls}`;
  $('#hud-sub').textContent = `${s.field.name} · waypoint ${wp}/${n} · ${app.speed}× speed`;

  const done = s.state === SurveyState.Finished;
  const ending = !!s.endReason;
  const pause = $('#btn-pause');
  pause.textContent = s.state === SurveyState.Paused ? 'Resume' : 'Pause';
  pause.disabled = done || ending;
  $('#btn-stop').disabled = done || ending;
}

function drawMinimap() {
  const s = app.survey;
  if (!s) return;
  const thr = s.flagThreshold;
  app.minimap.draw((ctx, v) => {
    drawGround(ctx, v);
    drawPlants(ctx, v, (p) => {
      const b = s.best.get(p.plantId);
      if (!b) return MAP_COLORS.unscanned;
      return isFlagged(b.detection.confidence, thr) ? MAP_COLORS.flagged : MAP_COLORS.scannedHealthy;
    });
    drawRoute(ctx, v, s.route, { doneUpTo: s.waypointsScanned - 1 });
    if (s.drone.isSurveying) drawFootprint(ctx, v, s.drone.x, s.drone.z, s.camera.footprintHalfSize(s.drone.y), 0.9);
    drawDrone(ctx, v, s.drone.x, s.drone.z, s.drone.heading);
  });
}

function setSpeedButtons() {
  for (const b of $$('[data-speed]')) b.classList.toggle('active', Number(b.dataset.speed) === app.speed);
}

function onSurveyFinished(survey, record) {
  app.logs.set(record.meta.surveyId, survey.log);
  const saved = app.store.save(record);
  app.store.saveLog(record.meta, survey.log);
  if (!saved) toast('This browser would not store the results. Export them from the dashboard.', 'warn', 6000);
  const sum = record.healthMap.summary();
  logEvent(`Landed. ${sum.zonesFound} zone${sum.zonesFound === 1 ? '' : 's'} found from ${fmtInt(sum.plantsFlagged)} flagged plants.`, 'done');
  renderStatus();
  // FR-5.2 and PR-3: the map dashboard opens on its own, well inside 3 seconds.
  setTimeout(() => {
    if (app.survey !== survey) return;
    openDashboard(record);
    toast(`Survey ${record.meta.surveyId} ${record.meta.endReason === EndReason.Completed ? 'complete' : `ended (${record.meta.endReason})`}. Review each zone below.`);
  }, 1200);
}

// ---------- map dashboard (UC3) ----------

function openDashboard(record) {
  app.viewing = record;
  try {
    app.viewingField = generateField(record.meta.fieldDefinition);
  } catch {
    app.viewingField = null;
  }
  if (!app.viewingField || app.viewingField.plants.length !== record.healthMap.plants.length) {
    toast('This survey was saved with a field the app can no longer rebuild.', 'error');
    return;
  }
  app.dash.setField(app.viewingField, app.settings.drone.basePad);
  const pending = record.healthMap.zones.find((z) => z.decision === ZoneDecision.Pending);
  app.selectedZone = (pending ?? record.healthMap.zones[0])?.zoneId ?? null;
  show('dashboard');
  $('#screen-dashboard .panel-scroll').scrollTop = 0;
  renderDashboard();
}

function renderDashboard() {
  const rec = app.viewing;
  if (!rec) return;
  const { meta, healthMap: hm } = rec;
  const sum = hm.summary();

  const select = $('#dash-history');
  const list = app.store.list();
  if (!list.some((r) => r.meta.surveyId === meta.surveyId)) list.unshift(rec);
  select.replaceChildren(
    ...list.map((r) => h('option', { value: r.meta.surveyId }, `${r.meta.surveyId} · ${r.meta.fieldName} · ${r.meta.endReason}`)),
  );
  select.value = meta.surveyId;

  $('#dash-title').textContent = `${meta.fieldName} · ${meta.surveyId}`;
  const stat = (label, value) => h('div', {}, h('dt', {}, label), h('dd', {}, value));
  $('#summary-grid').replaceChildren(
    stat('Plants scanned', `${fmtInt(sum.plantsScanned)} / ${fmtInt(sum.plantsTotal)}`),
    stat('Plants flagged', fmtInt(sum.plantsFlagged)),
    stat('Zones found', fmtInt(sum.zonesFound)),
    stat('Zones approved', `${sum.zonesApproved} of ${sum.zonesFound}`),
    stat('Flight time', formatDuration(meta.flightTimeSeconds)),
    stat('Readings logged', fmtInt(meta.readingsCount)),
  );
  $('#dash-end').replaceChildren(
    'Ended: ',
    h('strong', {}, meta.endReason),
    ` · ${meta.waypointsScanned} of ${meta.waypointsPlanned} waypoints · started by ${meta.trigger === 'timer' ? 'the Survey Timer' : 'the Farmer'} · battery ${Math.round(meta.initialBattery)}% → ${Math.round(meta.finalBattery)}% · ${shortDateTime(meta.startTime)}`,
  );

  renderZoneList();
  renderZoneDetail();
  renderGroundTruth();
  const hasLog = app.logs.has(meta.surveyId) || !!app.store.getLog(meta.surveyId);
  const logBtn = $('#btn-export-log');
  logBtn.disabled = !hasLog;
  logBtn.title = hasLog ? '' : 'The browser keeps the full log for the most recent survey only.';
  drawDashboard();
}

function renderZoneList() {
  const hm = app.viewing.healthMap;
  const ul = $('#zone-list');
  if (!hm.zones.length) {
    ul.replaceChildren(h('li', { class: 'zone-empty' }, 'No plants crossed the flag threshold, so there are no zones to review.'));
    return;
  }
  ul.replaceChildren(
    ...hm.zones.map((z) =>
      h(
        'li',
        {},
        h(
          'button',
          { type: 'button', class: z.zoneId === app.selectedZone ? 'selected' : '', onclick: () => selectZone(z.zoneId) },
          h('span', { class: 'zone-swatch', style: `background:${ZONE_COLORS[z.decision]}` }),
          h('span', { class: 'zone-id' }, z.zoneId),
          h('span', { class: 'zone-meta' }, `${z.plantIds.length} plant${z.plantIds.length === 1 ? '' : 's'} · avg ${fmtConf(z.avgConfidence)}`),
          h('span', { class: `zone-badge ${z.decision}` }, z.decision),
        ),
      ),
    ),
  );
}

// UI-4: zone detail with readings, confidences and the two decisions.
function renderZoneDetail() {
  const box = $('#zone-detail');
  const hm = app.viewing.healthMap;
  const z = app.selectedZone ? hm.getZone(app.selectedZone) : null;
  if (!z) {
    box.replaceChildren(h('p', { class: 'placeholder' }, hm.zones.length ? 'Click a zone on the map to see its readings.' : 'Nothing to review for this survey.'));
    return;
  }
  const plants = z.plantIds.map((id) => hm.plantById.get(id)).sort((a, b) => b.confidence - a.confidence);
  const fact = (label, value) => h('div', {}, h('dt', {}, label), h('dd', {}, value));
  box.replaceChildren(
    h(
      'div',
      { class: 'zone-detail-head' },
      h('span', { class: 'zone-swatch', style: `background:${ZONE_COLORS[z.decision]}` }),
      h('h3', {}, z.zoneId),
      h('span', { class: 'muted' }, `x ${z.centerX.toFixed(1)} m · z ${z.centerZ.toFixed(1)} m`),
      h('span', { class: `zone-badge ${z.decision}` }, z.decision),
    ),
    h('dl', { class: 'zone-facts' }, fact('Plants', z.plantIds.length), fact('Avg confidence', fmtConf(z.avgConfidence)), fact('Highest', fmtConf(z.maxConfidence))),
    h(
      'div',
      { class: 'readings' },
      h(
        'table',
        {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Plant'), h('th', {}, 'Leaf color'), h('th', {}, 'Spots'), h('th', {}, 'Height'), h('th', {}, 'Status'), h('th', {}, 'Conf.'))),
        h(
          'tbody',
          {},
          plants.map((p) =>
            h(
              'tr',
              {},
              h('td', {}, p.plantId),
              h('td', {}, p.reading.leafColorIndex.toFixed(2)),
              h('td', {}, `${Math.round(p.reading.leafSpotCoverage * 100)}%`),
              h('td', {}, `${p.reading.canopyHeight.toFixed(2)} m`),
              h('td', {}, p.detectionStatus),
              h('td', {}, fmtConf(p.confidence)),
            ),
          ),
        ),
      ),
    ),
    h(
      'div',
      { class: 'decision-row' },
      h('button', { type: 'button', class: 'btn danger', onclick: () => decide(z.zoneId, ZoneDecision.Approved) }, 'Approve treatment'),
      h('button', { type: 'button', class: 'btn ghost', onclick: () => decide(z.zoneId, ZoneDecision.Rejected) }, 'Reject as false alarm'),
    ),
    ...(z.decidedAt ? [h('p', { class: 'decided-note' }, `${z.decision === ZoneDecision.Approved ? 'Approved' : 'Rejected'} ${shortDateTime(z.decidedAt)}. You can still change it.`)] : []),
  );
}

function selectZone(zoneId) {
  app.selectedZone = zoneId;
  renderZoneList();
  renderZoneDetail();
  drawDashboard();
}

// FR-5.3, FR-5.4
function decide(zoneId, decision) {
  const rec = app.viewing;
  rec.healthMap.decide(zoneId, decision);
  if (!app.store.save(rec)) toast('Could not save the decision in this browser. Export the results to keep it.', 'warn');
  toast(decision === ZoneDecision.Approved ? `Zone ${zoneId} approved for treatment.` : `Zone ${zoneId} rejected as a false alarm.`);
  const next = rec.healthMap.zones.find((z) => z.decision === ZoneDecision.Pending);
  if (next) app.selectedZone = next.zoneId;
  renderDashboard();
}

function renderGroundTruth() {
  const on = $('#gt-toggle').checked;
  $('#gt-section').hidden = !on;
  if (!on || !app.viewingField) return;
  const g = groundTruthCheck(app.viewingField, app.viewing.healthMap);
  const rate = g.diseased ? Math.floor((g.truePos / g.diseased) * 1000) / 10 : 100;
  $('#gt-metrics').replaceChildren(
    h('dt', {}, 'Diseased plants scanned'),
    h('dd', {}, fmtInt(g.diseased)),
    h('dt', {}, 'Caught by the detector'),
    h('dd', {}, `${fmtInt(g.truePos)} (${rate}%)`),
    h('dt', {}, 'Missed'),
    h('dd', {}, fmtInt(g.missed)),
    h('dt', {}, 'Stressed plants flagged'),
    h('dd', {}, fmtInt(g.flaggedStressed)),
    h('dt', {}, 'Healthy plants flagged'),
    h('dd', {}, fmtInt(g.falsePos)),
  );
}

function drawDashboard() {
  if (!app.viewing || !app.viewingField || app.screen !== 'dashboard') return;
  const hm = app.viewing.healthMap;
  const field = app.viewingField;
  const truth = $('#gt-toggle').checked;
  app.dash.draw((ctx, v) => {
    drawGround(ctx, v);
    // Shade every plant cell that belongs to a zone, so an irregular zone reads as one area.
    const cell = field.spacing * v.scale;
    for (const z of hm.zones) {
      const selected = z.zoneId === app.selectedZone;
      ctx.fillStyle = selected ? 'rgba(108, 198, 255, 0.45)' : `${ZONE_COLORS[z.decision]}55`;
      for (const id of z.plantIds) {
        const p = hm.plantById.get(id);
        const [x, y] = v.toCanvas(p.x, p.z);
        ctx.fillRect(x - cell / 2, y - cell / 2, cell, cell);
      }
    }
    drawPlants(ctx, v, (p) => {
      const rec = hm.plants[p.index];
      if (truth) return rec.status === PlantStatus.Unscanned ? MAP_COLORS.unscanned : TRUTH_COLORS[p.healthState];
      switch (rec.status) {
        case PlantStatus.Unscanned:
          return MAP_COLORS.unscanned;
        case PlantStatus.Flagged:
          return MAP_COLORS.flagged;
        case PlantStatus.Confirmed:
          return MAP_COLORS.confirmed;
        default:
          return MAP_COLORS.scannedHealthy;
      }
    });
    // UI-3: one marker per zone, at its centre.
    const ordered = [...hm.zones].sort((a, b) => (a.zoneId === app.selectedZone) - (b.zoneId === app.selectedZone));
    for (const z of ordered) {
      const [x, y] = v.toCanvas(z.centerX, z.centerZ);
      const color = ZONE_COLORS[z.decision];
      const selected = z.zoneId === app.selectedZone;
      const r = selected ? 9 : 7;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = selected ? '#6cc6ff' : '#0b0f0d';
      ctx.stroke();
      ctx.font = '700 11px system-ui, sans-serif';
      const tw = ctx.measureText(z.zoneId).width;
      const lx = x + r + 4;
      ctx.fillStyle = 'rgba(10, 14, 12, 0.88)';
      ctx.fillRect(lx, y - 8, tw + 8, 16);
      ctx.fillStyle = selected ? '#6cc6ff' : color;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(z.zoneId, lx + 4, y + 0.5);
    }
  });
}

function bindDashboard() {
  const canvas = $('#dash-canvas');
  // A click picks the nearest zone marker, or the zone that owns the plant under the cursor.
  const zoneAt = (e) => {
    if (!app.viewing || !app.viewingField) return null;
    const hm = app.viewing.healthMap;
    const { px, py, x, z } = app.dash.eventToField(e);
    let best = null;
    let bestD = 14;
    for (const zone of hm.zones) {
      const [mx, my] = app.dash.toCanvas(zone.centerX, zone.centerZ);
      const d = Math.hypot(px - mx, py - my);
      if (d <= bestD) {
        best = zone;
        bestD = d;
      }
    }
    if (best) return best;
    const f = app.viewingField;
    const col = Math.floor(x / f.spacing);
    const row = Math.floor(z / f.spacing);
    if (col < 0 || row < 0 || col >= f.columns || row >= f.rows) return null;
    return hm.zoneForPlant(hm.plants[row * f.columns + col].plantId);
  };
  canvas.addEventListener('click', (e) => {
    const z = zoneAt(e);
    if (z) selectZone(z.zoneId);
  });
  canvas.addEventListener('pointermove', (e) => {
    canvas.style.cursor = zoneAt(e) ? 'pointer' : 'default';
  });
  $('#dash-history').addEventListener('change', (e) => {
    const rec = app.store.get(e.target.value) ?? (app.viewing?.meta.surveyId === e.target.value ? app.viewing : null);
    if (rec) openDashboard(rec);
  });
  $('#gt-toggle').addEventListener('change', () => {
    renderGroundTruth();
    drawDashboard();
  });
  $('#dash-new').addEventListener('click', () => show('setup'));
  $('#btn-export-csv').addEventListener('click', () => {
    const rec = app.viewing;
    download(`${rec.meta.surveyId}.csv`, surveyToCsv(rec), 'text/csv');
  });
  $('#btn-export-json').addEventListener('click', () => {
    const rec = app.viewing;
    download(`${rec.meta.surveyId}-results.json`, surveyToJson(rec), 'application/json');
  });
  $('#btn-export-log').addEventListener('click', () => {
    const rec = app.viewing;
    const log = app.logs.get(rec.meta.surveyId) ?? app.store.getLog(rec.meta.surveyId);
    if (log) download(`${rec.meta.surveyId}-log.json`, surveyLogToJson(rec.meta, log), 'application/json');
  });
}

// ---------- main menu (UI-1) ----------

function renderMenu() {
  if (!app.field) return;
  const d = app.fieldDef;
  const st = fieldStats(app.field);
  $('#menu-field-info').replaceChildren(
    h('dt', {}, 'Name'),
    h('dd', {}, d.name),
    h('dt', {}, 'Crop'),
    h('dd', {}, d.cropType),
    h('dt', {}, 'Grid'),
    h('dd', {}, `${d.grid.columns} × ${d.grid.rows} (${fmtInt(st.total)} plants)`),
    h('dt', {}, 'Diseased'),
    h('dd', {}, `${fmtPct(d.diseasedShare * 100)} · ${d.distribution}`),
    h('dt', {}, 'Seed'),
    h('dd', {}, d.seed),
    h('dt', {}, 'Route'),
    h('dd', {}, `${app.route.waypoints.length} waypoints at ${app.route.altitude} m`),
  );
  const list = app.store.list().slice(0, 8);
  $('#menu-history').replaceChildren(
    ...(list.length
      ? list.map((r) => {
          const s = r.healthMap.summary();
          return h(
            'li',
            {},
            h(
              'button',
              { type: 'button', onclick: () => openDashboard(r) },
              h('span', {}, h('span', { class: 'h-id' }, r.meta.surveyId), h('br'), h('span', { class: 'h-meta' }, r.meta.fieldName)),
              h('span', { class: 'h-meta' }, `${s.zonesFound} zones · ${s.zonesApproved} approved`, h('br'), r.meta.endReason),
            ),
          );
        })
      : [h('li', { class: 'empty' }, 'No surveys yet. Start one with New Survey.')]),
  );
}

// ---------- scheduling (FR-3.6) ----------

function setSchedule(at) {
  clearSchedule();
  app.schedule = { at, timer: setInterval(tickSchedule, 500) };
  $('#schedule-chip').hidden = false;
  tickSchedule();
  closeModals();
  toast(`Survey scheduled for ${clockTime(at)}. Keep this tab open.`);
}

function clearSchedule() {
  if (app.schedule) clearInterval(app.schedule.timer);
  app.schedule = null;
  $('#schedule-chip').hidden = true;
}

function tickSchedule() {
  if (!app.schedule) return;
  const ms = app.schedule.at.getTime() - Date.now();
  if (ms <= 0) {
    clearSchedule();
    if (app.survey && app.survey.state !== SurveyState.Finished) {
      toast('The Survey Timer fired, but a survey is already flying. Skipped this run.', 'warn');
      return;
    }
    startSurvey('timer');
    return;
  }
  $('#schedule-text').textContent = `Survey at ${clockTime(app.schedule.at)} · in ${formatDuration(ms / 1000)}`;
}

function openScheduleModal() {
  const t = new Date(Date.now() + 60_000);
  $('#schedule-time').value = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
  openModal('#schedule-modal');
}

// ---------- wiring ----------

function bindControls() {
  const s = app.settings;

  // Top bar
  $('#brand').addEventListener('click', () => show('menu'));
  $('[data-step="setup"]').addEventListener('click', () => show('setup'));
  $('[data-step="survey"]').addEventListener('click', () => app.survey && show('survey'));
  $('[data-step="dashboard"]').addEventListener('click', () => {
    const rec = app.viewing ?? app.store.list()[0];
    if (rec) openDashboard(rec);
  });
  $('#schedule-chip-cancel').addEventListener('click', () => {
    clearSchedule();
    toast('Scheduled survey cancelled.');
  });

  // Menu
  $('#menu-new').addEventListener('click', () => show('setup'));
  $('#menu-load').addEventListener('click', () => openModal('#load-modal'));
  $('#menu-schedule').addEventListener('click', openScheduleModal);
  $('#menu-quit').addEventListener('click', () => openModal('#quit-modal'));

  // Modals
  for (const m of $$('.modal')) {
    m.addEventListener('click', (e) => {
      if (e.target === m || e.target.closest('[data-close]')) closeModals();
    });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModals();
  });
  for (const b of $$('[data-sample]')) {
    b.addEventListener('click', async () => {
      try {
        setField(await fetchJson(b.dataset.sample));
        closeModals();
        show('setup');
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  }
  $('#btn-pick-file').addEventListener('click', () => $('#file-field').click());
  $('#btn-load-field').addEventListener('click', () => openModal('#load-modal'));
  $('#file-field').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      setField(JSON.parse(await file.text()));
      closeModals();
      show('setup');
    } catch (err) {
      toast(err instanceof SyntaxError ? `${file.name} is not valid JSON.` : err.message, 'error', 7000);
    }
  });
  for (const b of $$('[data-in]')) b.addEventListener('click', () => setSchedule(new Date(Date.now() + Number(b.dataset.in) * 1000)));
  $('#btn-schedule-confirm').addEventListener('click', () => {
    const [hh, mm] = ($('#schedule-time').value || '').split(':').map(Number);
    if (!Number.isFinite(hh) || !Number.isFinite(mm)) {
      toast('Pick a start time first.', 'warn');
      return;
    }
    const at = new Date();
    at.setHours(hh, mm, 0, 0);
    if (at.getTime() <= Date.now()) at.setDate(at.getDate() + 1);
    setSchedule(at);
  });
  $('#btn-quit-confirm').addEventListener('click', () => {
    closeModals();
    clearSchedule();
    app.survey = null;
    show('quit');
  });
  $('#btn-back-menu').addEventListener('click', () => show('menu'));

  // Field form
  $('#field-share').addEventListener('input', (e) => ($('#field-share-out').textContent = `${e.target.value}%`));
  for (const id of ['#field-name', '#field-seed', '#field-size', '#field-share']) $(id).addEventListener('change', applyFieldForm);
  for (const r of $$('input[name="distribution"]')) r.addEventListener('change', applyFieldForm);
  $('#btn-random-seed').addEventListener('click', () => {
    $('#field-seed').value = Math.floor(Math.random() * 100000);
    applyFieldForm();
  });
  $('#btn-save-field').addEventListener('click', () => {
    const d = { ...app.fieldDef };
    download(`${d.fieldId}.json`, `${JSON.stringify(d, null, 2)}\n`, 'application/json');
  });

  // Route form
  const alt = $('#route-alt');
  alt.min = s.route.minAltitude;
  alt.max = s.route.maxAltitude;
  alt.value = app.routeOpts.altitude;
  const sp = $('#route-spacing');
  sp.min = s.route.minLineSpacing;
  sp.max = s.route.maxLineSpacing;
  sp.value = app.routeOpts.lineSpacing;
  const syncRouteOutputs = () => {
    $('#route-alt-out').textContent = `${alt.value} m`;
    $('#route-spacing-out').textContent = `${sp.value} m`;
  };
  syncRouteOutputs();
  for (const el of [alt, sp]) {
    el.addEventListener('input', () => {
      syncRouteOutputs();
      app.routeOpts = { altitude: Number(alt.value), lineSpacing: Number(sp.value) };
      rebuildRoute();
    });
  }
  $('#btn-reset-route').addEventListener('click', rebuildRoute);
  for (const b of $$('[data-tool]')) {
    b.addEventListener('click', () => {
      app.tool = b.dataset.tool;
      for (const o of $$('[data-tool]')) o.classList.toggle('active', o === b);
    });
  }
  $('#planner-truth').addEventListener('change', drawPlanner);
  $('#planner-footprints').addEventListener('change', drawPlanner);
  $('#battery-rule').textContent = `${s.drone.returnBelowPercent}%`;
  $('#start-battery').addEventListener('input', (e) => {
    $('#start-battery-out').textContent = `${e.target.value}%`;
    renderRouteStats();
  });
  $('#btn-start-survey').addEventListener('click', () => startSurvey('farmer'));
  $('#btn-schedule').addEventListener('click', openScheduleModal);

  // Flight controls
  $('#btn-pause').addEventListener('click', () => {
    const sv = app.survey;
    if (!sv) return;
    if (sv.state === SurveyState.Paused) sv.resume();
    else sv.pause();
    renderStatus();
  });
  $('#btn-stop').addEventListener('click', () => {
    app.survey?.stop();
    renderStatus();
  });
  for (const b of $$('[data-speed]')) {
    b.addEventListener('click', () => {
      app.speed = Number(b.dataset.speed);
      setSpeedButtons();
      renderStatus();
    });
  }
  for (const b of $$('[data-cam]')) {
    b.addEventListener('click', () => {
      app.scene?.setMode(b.dataset.cam);
      for (const o of $$('[data-cam]')) o.classList.toggle('active', o === b);
    });
  }

  bindPlanner();
  bindDashboard();
}

let lastFrame = performance.now();
function frame(now) {
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;
  const s = app.survey;
  if (s && s.state === SurveyState.Running) s.step(dt * app.speed);
  if (s && app.screen === 'survey') {
    if (app.scene) {
      const half = s.camera.footprintHalfSize(Math.max(s.drone.y, 0.01));
      app.scene.update(dt, s.drone, half, s.drone.isSurveying);
      app.scene.render();
    }
    if (now - app.lastStatus > 250) {
      app.lastStatus = now;
      renderStatus();
      drawMinimap();
    }
  }
  requestAnimationFrame(frame);
}

async function boot() {
  app.planner = new MapView($('#planner-canvas'), { padding: 20 });
  app.minimap = new MapView($('#minimap'), { padding: 8 });
  app.dash = new MapView($('#dash-canvas'), { padding: 26 });
  try {
    const [settings, fieldDef] = await Promise.all([fetchJson('config/settings.json'), fetchJson('fields/default-field.json')]);
    createDetector(settings.detection); // FR-4.3: refuse to start on a bad detector config
    app.settings = settings;
    app.routeOpts = { altitude: settings.route.defaultAltitude, lineSpacing: settings.route.defaultLineSpacing };
    bindControls();
    setField(fieldDef, { quiet: true });
  } catch (err) {
    console.error(err);
    $('#fatal-message').textContent = err.message;
    show('fatal');
    return;
  }
  loadScene(); // warm up three.js in the background
  show('menu');
  requestAnimationFrame(frame);
}

boot();
