// Top-down 2D map used by the route planner, the survey minimap and the map dashboard (UI-3).
// Field x runs left to right, field z runs top to bottom.

export const MAP_COLORS = {
  background: '#141a17',
  soil: '#4a3a2a',
  soilRow: '#3f3124',
  fieldEdge: '#7d6a52',
  plantNeutral: '#5f8f4e',
  plantHealthy: '#3f7f3a',
  plantStressed: '#c3b13d',
  plantDiseased: '#c9622e',
  unscanned: '#6b6f68',
  scannedHealthy: '#4fa046',
  flagged: '#f0a43a',
  confirmed: '#e5484d',
  route: 'rgba(235, 240, 230, 0.75)',
  routeDone: '#7fd16b',
  waypoint: '#e8efe4',
  waypointHot: '#ffd166',
  footprint: 'rgba(120, 200, 255, 0.10)',
  footprintEdge: 'rgba(120, 200, 255, 0.35)',
  uncovered: 'rgba(229, 72, 77, 0.22)',
  pad: '#d9d4c7',
  drone: '#ffffff',
  zonePending: '#f5c542',
  zoneApproved: '#e5484d',
  zoneRejected: '#8b8f88',
};

export class MapView {
  constructor(canvas, { padding = 16 } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.padding = padding;
    this.field = null;
    this.base = null;
    this.scale = 1;
    this.ox = 0;
    this.oy = 0;
    this.drawFn = null;
    this.observer = new ResizeObserver(() => this.redraw());
    this.observer.observe(canvas);
  }

  setField(field, base) {
    this.field = field;
    this.base = base;
  }

  fit() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.dpr = dpr;
    this.cssWidth = rect.width;
    this.cssHeight = rect.height;
    if (!this.field) return;
    const minX = Math.min(-1.5, this.base.x - 3);
    const minZ = Math.min(-1.5, this.base.z - 3);
    const maxX = this.field.width + 1.5;
    const maxZ = this.field.length + 1.5;
    const p = this.padding;
    this.scale = Math.max(0.1, Math.min((rect.width - 2 * p) / (maxX - minX), (rect.height - 2 * p) / (maxZ - minZ)));
    this.ox = (rect.width - (maxX - minX) * this.scale) / 2 - minX * this.scale;
    this.oy = (rect.height - (maxZ - minZ) * this.scale) / 2 - minZ * this.scale;
  }

  toCanvas(x, z) {
    return [this.ox + x * this.scale, this.oy + z * this.scale];
  }

  toField(px, py) {
    return [(px - this.ox) / this.scale, (py - this.oy) / this.scale];
  }

  eventToField(e) {
    const rect = this.canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const [x, z] = this.toField(px, py);
    return { px, py, x, z };
  }

  draw(fn) {
    this.drawFn = fn;
    this.redraw();
  }

  redraw() {
    this.fit();
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = MAP_COLORS.background;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    if (!this.field || !this.drawFn) return;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.drawFn(ctx, this);
  }
}

export function drawGround(ctx, v) {
  const f = v.field;
  const [x0, y0] = v.toCanvas(0, 0);
  const w = f.width * v.scale;
  const h = f.length * v.scale;
  ctx.fillStyle = MAP_COLORS.soil;
  ctx.fillRect(x0, y0, w, h);
  if (f.spacing * v.scale >= 4) {
    ctx.strokeStyle = MAP_COLORS.soilRow;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let r = 1; r < f.rows; r++) {
      const y = y0 + r * f.spacing * v.scale;
      ctx.moveTo(x0, y);
      ctx.lineTo(x0 + w, y);
    }
    ctx.stroke();
  }
  ctx.strokeStyle = MAP_COLORS.fieldEdge;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(x0, y0, w, h);
  drawPad(ctx, v);
}

export function drawPad(ctx, v) {
  const [px, py] = v.toCanvas(v.base.x, v.base.z);
  const r = Math.max(6, 1.8 * v.scale);
  ctx.fillStyle = 'rgba(217, 212, 199, 0.15)';
  ctx.strokeStyle = MAP_COLORS.pad;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(px, py, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = MAP_COLORS.pad;
  ctx.font = `600 ${Math.max(8, r)}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('H', px, py + 0.5);
}

// colorFor(plant, index) returns a CSS color or null to skip the plant.
export function drawPlants(ctx, v, colorFor) {
  const f = v.field;
  const size = Math.max(1.2, f.spacing * v.scale * 0.62);
  const half = size / 2;
  let last = null;
  for (let i = 0; i < f.plants.length; i++) {
    const p = f.plants[i];
    const color = colorFor(p, i);
    if (!color) continue;
    if (color !== last) {
      ctx.fillStyle = color;
      last = color;
    }
    const [px, py] = v.toCanvas(p.x, p.z);
    ctx.fillRect(px - half, py - half, size, size);
  }
}

export function drawRoute(ctx, v, route, { doneUpTo = -1, highlight = -1, numbers = false, halfSize = null } = {}) {
  const wps = route.waypoints;
  if (halfSize) {
    for (const w of wps) {
      const [px, py] = v.toCanvas(w.x - halfSize, w.z - halfSize);
      const s = halfSize * 2 * v.scale;
      ctx.fillStyle = MAP_COLORS.footprint;
      ctx.fillRect(px, py, s, s);
      ctx.strokeStyle = MAP_COLORS.footprintEdge;
      ctx.lineWidth = 0.5;
      ctx.strokeRect(px, py, s, s);
    }
  }
  const pts = [v.base, ...wps, v.base].map((p) => v.toCanvas(p.x, p.z));
  ctx.lineWidth = 1.5;
  ctx.setLineDash([5, 4]);
  ctx.strokeStyle = MAP_COLORS.route;
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.stroke();
  ctx.setLineDash([]);
  if (doneUpTo >= 0) {
    ctx.strokeStyle = MAP_COLORS.routeDone;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    for (let i = 0; i <= Math.min(doneUpTo + 1, pts.length - 1); i++) {
      const [x, y] = pts[i];
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.stroke();
  }
  const r = Math.max(2.5, Math.min(6, v.scale * 0.55));
  wps.forEach((w, i) => {
    const [x, y] = v.toCanvas(w.x, w.z);
    ctx.beginPath();
    ctx.arc(x, y, i === highlight ? r + 2.5 : r, 0, Math.PI * 2);
    ctx.fillStyle = i === highlight ? MAP_COLORS.waypointHot : i <= doneUpTo ? MAP_COLORS.routeDone : MAP_COLORS.waypoint;
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.stroke();
  });
  if (numbers && r >= 4) {
    ctx.fillStyle = '#e8efe4';
    ctx.font = '600 10px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    wps.forEach((w, i) => {
      const [x, y] = v.toCanvas(w.x, w.z);
      ctx.fillText(String(i + 1), x + r + 1, y - r + 1);
    });
  }
}

export function drawDrone(ctx, v, x, z, heading) {
  const [px, py] = v.toCanvas(x, z);
  ctx.save();
  ctx.translate(px, py);
  // heading is atan2(dx, dz); on the map z points down
  ctx.rotate(-heading + Math.PI);
  ctx.beginPath();
  ctx.moveTo(0, -8);
  ctx.lineTo(6, 6);
  ctx.lineTo(0, 3);
  ctx.lineTo(-6, 6);
  ctx.closePath();
  ctx.fillStyle = MAP_COLORS.drone;
  ctx.strokeStyle = '#111';
  ctx.lineWidth = 1.5;
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

export function drawFootprint(ctx, v, x, z, half, alpha = 1) {
  const [px, py] = v.toCanvas(x - half, z - half);
  const s = half * 2 * v.scale;
  ctx.fillStyle = `rgba(120, 200, 255, ${0.18 * alpha})`;
  ctx.fillRect(px, py, s, s);
  ctx.strokeStyle = `rgba(150, 215, 255, ${0.9 * alpha})`;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(px, py, s, s);
}

export function hitWaypoint(v, route, px, py, radius = 9) {
  let best = -1;
  let bestD = radius;
  route.waypoints.forEach((w, i) => {
    const [x, y] = v.toCanvas(w.x, w.z);
    const d = Math.hypot(x - px, y - py);
    if (d <= bestD) {
      best = i;
      bestD = d;
    }
  });
  return best;
}
