// Drone (class diagram) and its state chart: Idle -> TakingOff -> Surveying (Flying / Scanning)
// -> Returning -> Landing -> Idle.

export const DroneState = Object.freeze({
  Idle: 'Idle',
  TakingOff: 'TakingOff',
  Flying: 'Flying',
  Scanning: 'Scanning',
  Returning: 'Returning',
  Landing: 'Landing',
});

export class Drone {
  constructor({ cruiseSpeed, climbRate, batteryDrainPerSecond, basePad, battery = 100 }) {
    this.cruiseSpeed = cruiseSpeed;
    this.climbRate = climbRate;
    this.drain = batteryDrainPerSecond;
    this.basePad = { ...basePad };
    this.battery = battery;
    this.x = basePad.x;
    this.y = 0;
    this.z = basePad.z;
    this.heading = 0;
    this.moving = false;
    this.state = DroneState.Idle;
  }

  get isSurveying() {
    return this.state === DroneState.Flying || this.state === DroneState.Scanning;
  }

  takeOff() {
    if (this.state !== DroneState.Idle) throw new Error(`Cannot take off while ${this.state}`);
    this.state = DroneState.TakingOff;
  }

  // Returns true once the drone holds the target altitude.
  climbTo(altitude, dt) {
    const step = this.climbRate * dt;
    const diff = altitude - this.y;
    this.y = Math.abs(diff) <= step ? altitude : this.y + Math.sign(diff) * step;
    this.moving = true;
    return this.y === altitude;
  }

  // Flies level toward (x, z), correcting altitude on the way. Returns true on arrival.
  flyTo(x, z, altitude, dt) {
    this.climbTo(altitude, dt);
    const dx = x - this.x;
    const dz = z - this.z;
    const dist = Math.hypot(dx, dz);
    const step = this.cruiseSpeed * dt;
    if (dist > 1e-6) this.heading = Math.atan2(dx, dz);
    if (dist <= step) {
      this.x = x;
      this.z = z;
    } else {
      this.x += (dx / dist) * step;
      this.z += (dz / dist) * step;
    }
    this.moving = true;
    return dist <= step && this.y === altitude;
  }

  hover() {
    this.moving = false;
  }

  // Returns true on touchdown.
  descend(dt) {
    this.y = Math.max(0, this.y - this.climbRate * 0.8 * dt);
    this.moving = true;
    if (this.y === 0) {
      this.state = DroneState.Idle;
      this.moving = false;
      return true;
    }
    return false;
  }

  drainBattery(dt) {
    if (this.state === DroneState.Idle) return;
    const rate = this.moving ? this.drain.flying : this.drain.hovering;
    this.battery = Math.max(0, this.battery - rate * dt);
  }
}
