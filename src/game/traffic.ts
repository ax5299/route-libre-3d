import { Color3, Scene, TransformNode, Vector3 } from "@babylonjs/core";
import { Car } from "./vehicle";
import type { Track } from "./track";
import { clamp, damp, wrap01 } from "./utils";

/** Teintes des voitures de trafic (sRGB, comme la palette du projet). */
const COLORS = [
  new Color3(0.22, 0.46, 0.85),
  new Color3(0.85, 0.26, 0.2),
  new Color3(0.92, 0.76, 0.16),
  new Color3(0.26, 0.6, 0.36),
  new Color3(0.86, 0.86, 0.9),
  new Color3(0.46, 0.32, 0.7),
];

/** Distance (m) à laquelle un véhicule placé devant fait ralentir. */
const MIN_SPACING = 16;
const MAX_CARS = 24;

export interface Runner {
  car: Car;
  /** Avancement sur la piste (m). */
  s: number;
  /** Décalage latéral constant par rapport à l'axe (m). */
  lateral: number;
  /** Vitesse de croisière visée (m/s). */
  cruise: number;
  speed: number;
}

/**
 * Trafic IA : voitures placées cinématiquement sur la piste (modèle du joueur,
 * sans simulation), réparties de part et d'autre de l'axe, qui ralentissent
 * quand un véhicule ou le joueur les précède dans leur couloir.
 */
export class Traffic {
  private readonly runners: Runner[] = [];
  private readonly scratch = new Vector3();
  private spawned = 0;

  constructor(
    private readonly scene: Scene,
    private readonly world: TransformNode,
    private readonly track: Track,
    count: number,
  ) {
    this.setCount(count);
  }

  get list(): readonly Runner[] {
    return this.runners;
  }

  /** Ajuste le nombre de voitures en circulation (0 … 12). */
  setCount(count: number): void {
    const target = clamp(Math.round(count), 0, MAX_CARS);
    while (this.runners.length > target) this.runners.pop()?.car.dispose();
    while (this.runners.length < target) this.spawn(target);
  }

  private spawn(total: number): void {
    const length = this.track.totalLength;
    const car = new Car(this.scene, COLORS[this.spawned % COLORS.length].clone(), `traffic-${this.spawned}`);
    this.spawned += 1;
    car.root.parent = this.world;
    const lane = (this.runners.length % 2 === 0 ? 1 : -1) * (2.4 + Math.random() * 1.8);
    const runner: Runner = {
      car,
      // Hors de la zone de départ pour ne pas gêner la grille.
      s: length * (0.12 + (0.72 * (this.runners.length + Math.random() * 0.5)) / Math.max(1, total)),
      lateral: lane,
      cruise: 9 + Math.random() * 5,
      speed: 0,
    };
    runner.speed = runner.cruise;
    this.place(runner);
    this.runners.push(runner);
  }

  private place(runner: Runner): void {
    const pos = this.track.positionAt(runner.s, runner.lateral, this.scratch);
    runner.car.placeAt(pos, this.track.headingAt(runner.s));
  }

  /** Avance le trafic d'une image ; `playerPos` sert à anticiper le joueur. */
  update(dt: number, playerPos: Vector3): void {
    const length = this.track.totalLength;
    for (const r of this.runners) {
      const pos = r.car.position;
      const fx = Math.cos(r.car.heading);
      const fz = Math.sin(r.car.heading);
      let target = r.cruise;
      for (const o of this.runners) {
        if (o === r) continue;
        const dx = o.car.position.x - pos.x;
        const dz = o.car.position.z - pos.z;
        const ahead = dx * fx + dz * fz;
        if (ahead > 0 && ahead < MIN_SPACING && Math.abs(dx * fz - dz * fx) < 2.6) {
          target = Math.min(target, o.speed * 0.9);
        }
      }
      const dx = playerPos.x - pos.x;
      const dz = playerPos.z - pos.z;
      const ahead = dx * fx + dz * fz;
      if (ahead > 0 && ahead < MIN_SPACING + 6 && Math.abs(dx * fz - dz * fx) < 3) target = Math.min(target, 5);
      r.speed = damp(r.speed, target, 2, dt);
      r.s = wrap01((r.s + r.speed * dt) / length) * length;
      this.place(r);
      r.car.spinWheels(r.speed, dt);
    }
  }

  dispose(): void {
    for (const r of this.runners) r.car.dispose();
    this.runners.length = 0;
  }
}
