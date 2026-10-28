import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import type { Scene } from "@babylonjs/core/scene";

import { FacetBuilder } from "./geometry";
import { PALETTE } from "./palette";
import { clamp, damp, shortestAngle } from "./utils";
import type { Track } from "./track";

/** Rapproche `value` de `target` de `rate` unités par seconde (constant). */
const approach = (value: number, target: number, rate: number, dt: number): number => {
  const delta = target - value;
  const step = rate * dt;
  if (Math.abs(delta) <= step) return target;
  return value + Math.sign(delta) * step;
};

/** Commandes normalisées, venant du clavier ou de la manette. */
export interface VehicleInput {
  /** 0 = relâché, 1 = enfoncé à fond. */
  throttle: number;
  brake: number;
  /** -1 = tout à gauche, +1 = tout à droite. */
  steer: number;
  handbrake: boolean;
}

export interface CarReadout {
  speedKmh: number;
  onRoad: boolean;
  lateral: number;
  /** Angle de glisse (rad) : 0 = la voiture suit sa trajectoire. */
  slip: number;
  /** 0..1 : front montant d'un choc contre une barrière (0 pendant un frottement continu). */
  impact: number;
  drifting: boolean;
}

const HALF_WIDTH = 0.95;
const FRONT_AXLE = 1.42;
const REAR_AXLE = 1.44;
const WHEEL_BASE = FRONT_AXLE + REAR_AXLE;
const WHEEL_RADIUS = 0.34;
/** Vitesse de référence : 225 km/h sur route, ~95 km/h dans l'herbe. */
const TOP_ROAD = 62.5;
const TOP_GRASS = 26;
const TOP_REVERSE = 13;
/**
 * Sens de rotation de `heading`. L'avant est `(cos h, 0, sin h)` et la normale
 * gauche `(-sin h, 0, cos h)` : c'est exactement la normale de la piste
 * (`track.positionAt`, « lateral positif = gauche de l'axe »). Dans le repère
 * main-gauche de Babylon, `d(avant)/dh` pointe donc vers la GAUCHE : augmenter
 * `heading` tourne à gauche. Un braquage à droite (`input.steer > 0`, roues
 * avant vers `+x` local) doit par conséquent *diminuer* `heading`.
 */
const HEADING_SIGN = -1;

/**
 * Voiture arcade : l'adhérence latérale est molle (drift possible au frein à
 * main), la vitesse reste alignée sur l'avant du châssis. Le relief est fourni
 * par la piste : aucun moteur physique externe.
 */
export class Car {
  readonly root: TransformNode;
  private readonly scene: Scene;
  private readonly bodyNode: TransformNode;
  private readonly meshes: Mesh[] = [];
  private readonly materials: StandardMaterial[] = [];
  private readonly hubs: TransformNode[] = [];
  private readonly wheels: Mesh[] = [];
  private roofTop: Mesh | null = null;
  private glassMesh: Mesh | null = null;

  heading = 0;
  private readonly velocity = new Vector3(0, 0, 0);
  private steer = 0;
  private spin = 0;
  private roll = 0;
  private pitch = 0;
  private bounce = 0;
  private hint = 0;
  private forwardSpeed = 0;
  private lateralSpeed = 0;
  private prevForward = 0;
  private longAccel = 0;
  private impact = 0;
  private contact = false;
  private brakeGlow = 0;
  private tailMat: StandardMaterial | null = null;
  private prevX = 0;
  private prevY = 0;
  private prevZ = 0;
  private prevHeading = 0;
  /** Intensité du nid de poule sous la voiture à l'image précédente. */
  private prevHole = 0;
  /** Temps restant de glisse forcée après un nid moyen ou gros. */
  private skidTime = 0;
  /** Position/cap interpolés entre le dernier pas physique et la prochaine image. */
  readonly renderPos = new Vector3();
  renderHeading = 0;

  readonly readout: CarReadout = {
    speedKmh: 0,
    onRoad: true,
    lateral: 0,
    slip: 0,
    impact: 0,
    drifting: false,
  };

  constructor(scene: Scene, bodyColor: Color3, name = "car") {
    this.scene = scene;
    this.root = new TransformNode(name, scene);
    this.bodyNode = new TransformNode(`${name}-body`, scene);
    this.bodyNode.parent = this.root;
    this.buildModel(bodyColor);
    this.buildWheels();
  }

  // ------------------------------------------------------------------- modèle

  private mat(
    name: string,
    opts: { color?: Color3; specular?: number; alpha?: number; emissive?: Color3 } = {},
  ): StandardMaterial {
    const material = new StandardMaterial(name, this.scene);
    material.diffuseColor = opts.color ?? Color3.White();
    material.emissiveColor = opts.emissive ?? new Color3(0.015, 0.016, 0.02);
    const gloss = (opts.specular ?? 12) / 100;
    material.specularColor = new Color3(0.02 + gloss, 0.02 + gloss, 0.02 + gloss);
    material.specularPower = 42;
    if (opts.alpha !== undefined) material.alpha = opts.alpha;
    this.materials.push(material);
    return material;
  }

  private add(mesh: Mesh | null, material: StandardMaterial): void {
    if (!mesh) return;
    mesh.material = material;
    mesh.parent = this.bodyNode;
    this.meshes.push(mesh);
  }

  // ------------------------------------------------------------------- modèle

  private buildModel(bodyColor: Color3): void {
    const paint = new FacetBuilder();
    const top = new FacetBuilder();
    const trim = new FacetBuilder();
    const glass = new FacetBuilder();
    const lamps = new FacetBuilder();
    const tails = new FacetBuilder();

    // Coque profilée : anneaux (demi-largeur / hauteur de pont) relingués le
    // long de z, du nez (z+) à la poupe (z-). Les faces sont orientées vers
    // l'extérieur et éclairées par une teinte facettée (toit clair, fond sombre).
    interface P2 {
      x: number;
      y: number;
    }
    type P3 = { x: number; y: number; z: number };
    // Coupe en super-ellipse (coins arrondis, faces plates) : le nez est un
    // peu plus étroit en bas, la poupe un peu plus large → formes galbées.
    const superRing = (hw: number, low: number, top: number, n: number, count: number): P2[] => {
      const c = (low + top) / 2;
      const hh = (top - low) / 2;
      const pts: P2[] = [];
      for (let i = 0; i < count; i++) {
        const t = (i / count) * Math.PI * 2;
        const ct = Math.cos(t);
        const st = Math.sin(t);
        const x = hw * Math.sign(ct) * Math.pow(Math.abs(ct), 2 / n);
        const y = c + hh * Math.sign(st) * Math.pow(Math.abs(st), 2 / n);
        pts.push({ x: x * (0.92 + 0.08 * ((y - c) / hh)), y });
      }
      return pts;
    };
    // contrôles (z décroissant, demi-largeur, hauteur de pont) : interpolation
    // lissée puis échantillonnage dense pour une carrosserie sans à-coups.
    const bodyControls: readonly [number, number, number][] = [
      [2.18, 0.4, 0.46],
      [1.98, 0.66, 0.53],
      [1.72, 0.8, 0.575],
      [1.4, 0.9, 0.61],
      [1.05, 0.945, 0.655],
      [0.65, 0.96, 0.695],
      [0.2, 0.97, 0.715],
      [-0.35, 0.98, 0.725],
      [-0.9, 0.975, 0.715],
      [-1.4, 0.95, 0.68],
      [-1.8, 0.86, 0.6],
      [-2.05, 0.74, 0.545],
      [-2.18, 0.66, 0.5],
    ];
    const cabinControls: readonly [number, number, number][] = [
      [0.95, 0.4, 0.72],
      [0.8, 0.55, 0.9],
      [0.58, 0.635, 1.05],
      [0.3, 0.675, 1.15],
      [-0.05, 0.69, 1.2],
      [-0.4, 0.675, 1.17],
      [-0.68, 0.64, 1.08],
      [-0.88, 0.57, 0.95],
      [-1, 0.48, 0.78],
    ];
    const stations = (
      controls: readonly [number, number, number][],
      steps: number,
      n: number,
      count: number,
      low: number,
    ): { z: number; pts: P2[] }[] => {
      const list: { z: number; pts: P2[] }[] = [];
      const z0 = controls[0][0];
      const z1 = controls[controls.length - 1][0];
      for (let i = 0; i <= steps; i++) {
        const z = z0 - (i / steps) * (z0 - z1);
        let k = 0;
        while (k < controls.length - 2 && controls[k + 1][0] > z) k++;
        const a = controls[k];
        const b = controls[k + 1];
        const u = Math.max(0, Math.min(1, (z - a[0]) / (b[0] - a[0])));
        const s = 0.5 - 0.5 * Math.cos(u * Math.PI);
        list.push({ z, pts: superRing(a[1] + (b[1] - a[1]) * s, low, a[2] + (b[2] - a[2]) * s, n, count) });
      }
      return list;
    };
    const shade = (a: P3, b: P3, c: P3, tint: Color3): Color3 => {
      const ux = b.x - a.x;
      const uy = b.y - a.y;
      const uz = b.z - a.z;
      const vx = c.x - a.x;
      const vy = c.y - a.y;
      const vz = c.z - a.z;
      let nx = uy * vz - uz * vy;
      let ny = uz * vx - ux * vz;
      let nz = ux * vy - uy * vx;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len;
      ny /= len;
      nz /= len;
      const lit = 0.72 + 0.52 * Math.max(0, ny) + 0.18 * Math.max(0, nx) + 0.05 * Math.max(0, nz);
      return tint.scale(lit);
    };
    const loft = (fb: FacetBuilder, rings: { z: number; pts: P2[] }[], color: Color3): void => {
      for (let i = 0; i < rings.length - 1; i++) {
        const front = rings[i];
        const back = rings[i + 1];
        const n = front.pts.length;
        for (let k = 0; k < n; k++) {
          const A = { x: back.pts[k].x, y: back.pts[k].y, z: back.z };
          const B = { x: back.pts[(k + 1) % n].x, y: back.pts[(k + 1) % n].y, z: back.z };
          const C = { x: front.pts[(k + 1) % n].x, y: front.pts[(k + 1) % n].y, z: front.z };
          const D = { x: front.pts[k].x, y: front.pts[k].y, z: front.z };
          fb.quad(A, B, C, D, shade(A, B, C, color));
        }
      }
      const nose = rings[0];
      let noseLow = Infinity;
      let noseHigh = -Infinity;
      for (const p of nose.pts) {
        noseLow = Math.min(noseLow, p.y);
        noseHigh = Math.max(noseHigh, p.y);
      }
      const noseC: P3 = { x: 0, y: (noseLow + noseHigh) / 2, z: nose.z };
      for (let k = 0; k < nose.pts.length; k++) {
        const a = nose.pts[k];
        const b = nose.pts[(k + 1) % nose.pts.length];
        fb.tri(noseC, { x: a.x, y: a.y, z: nose.z }, { x: b.x, y: b.y, z: nose.z }, color.scale(0.92));
      }
      const tail = rings[rings.length - 1];
      let tailLow = Infinity;
      let tailHigh = -Infinity;
      for (const p of tail.pts) {
        tailLow = Math.min(tailLow, p.y);
        tailHigh = Math.max(tailHigh, p.y);
      }
      const tailC: P3 = { x: 0, y: (tailLow + tailHigh) / 2, z: tail.z };
      for (let k = 0; k < tail.pts.length; k++) {
        const a = tail.pts[(k + 1) % tail.pts.length];
        const b = tail.pts[k];
        fb.tri(tailC, { x: a.x, y: a.y, z: tail.z }, { x: b.x, y: b.y, z: tail.z }, color.scale(0.78));
      }
    };

    loft(paint, stations(bodyControls, 26, 3.4, 12, 0.33), bodyColor);
    // verrière teintée : pare-brise incliné, toit bombé, lunette arrière
    const cabinSt = stations(cabinControls, 18, 2.8, 12, 0.6);
    loft(glass, cabinSt, PALETTE.carGlass);

    // toit peint : bande qui épouse le dôme de la verrière (décalée de 2,5 %
    // vers l'extérieur pour ne pas fights avec le verre), masquée en cockpit
    const roofTint = bodyColor.scale(1.12);
    const out = (p: P2): P2 => ({ x: p.x * 1.025, y: 0.9 + (p.y - 0.9) * 1.025 });
    const roofY = 1.06;
    for (let i = 0; i < cabinSt.length - 1; i++) {
      const front = cabinSt[i];
      const back = cabinSt[i + 1];
      for (let k = 0; k < front.pts.length; k++) {
        const k2 = (k + 1) % front.pts.length;
        if (
          front.pts[k].y < roofY ||
          front.pts[k2].y < roofY ||
          back.pts[k].y < roofY ||
          back.pts[k2].y < roofY
        )
          continue;
        const A = { x: out(back.pts[k]).x, y: out(back.pts[k]).y, z: back.z };
        const B = { x: out(back.pts[k2]).x, y: out(back.pts[k2]).y, z: back.z };
        const C = { x: out(front.pts[k2]).x, y: out(front.pts[k2]).y, z: front.z };
        const D = { x: out(front.pts[k]).x, y: out(front.pts[k]).y, z: front.z };
        top.quad(A, B, C, D, shade(A, B, C, roofTint));
      }
    }
    // bandes de course sur le pont arrière, épouse la pente du pont
    for (const x of [-0.3, 0.3]) {
      for (const [z, y] of [[-0.95, 0.714], [-1.25, 0.687], [-1.55, 0.655]] as const) {
        paint.box({ w: 0.2, h: 0.05, d: 0.3, x, y, z }, PALETTE.paintWhite);
      }
    }
    // liseré blanc le long des épaules
    for (const x of [-0.89, 0.89]) {
      paint.box({ w: 0.05, h: 0.045, d: 2.4, x, y: 0.5, z: -0.4 }, PALETTE.paintWhite);
    }
    // rétroviseurs : coque verticale et glace ovale tournée vers l'arrière
    for (const side of [-1, 1]) {
      paint.box({ w: 0.16, h: 0.05, d: 0.2, x: side * 1, y: 0.75, z: 0.52 }, bodyColor.scale(0.9));
      paint.box({ w: 0.16, h: 0.2, d: 0.3, x: side * 1.12, y: 0.82, z: 0.5 }, bodyColor.scale(0.8));
      paint.place({ position: { x: side * 1.12, y: 0.82, z: 0.34 }, rotationY: Math.PI });
      paint.disc({ rx: 0.12, ry: 0.075, segments: 12 }, PALETTE.carGlass.scale(1.3), bodyColor.scale(0.5));
      paint.place(null);
    }
    // ouïes d'aération du capot
    for (const x of [-0.3, 0.3]) {
      trim.box({ w: 0.2, h: 0.04, d: 0.5, x, y: 0.645, z: 1.2 }, PALETTE.carTrim);
    }
    // boucliers, bas de caisse, diffuseur : lippes et blocs ovales
    trim
      .place({ position: { x: 0, y: 0.28, z: 2.12 }, scale: { x: 1.85, y: 1, z: 0.3 } })
      .prism({ radius: 0.5, height: 0.05, segments: 16 }, PALETTE.carTrim)
      .place(null);
    trim
      .place({ position: { x: 0, y: 0.36, z: 2.165 }, scale: { x: 0.7, y: 1, z: 0.12 } })
      .prism({ radius: 0.5, height: 0.1, segments: 12 }, PALETTE.carTrim)
      .place(null);
    for (const x of [-0.99, 0.99]) {
      trim.box({ w: 0.08, h: 0.18, d: 2.9, x, y: 0.36, z: -0.4 }, PALETTE.carTrim);
    }
    for (const x of [-0.5, -0.17, 0.17, 0.5]) {
      trim.box({ w: 0.05, h: 0.12, d: 0.2, x, y: 0.34, z: -2.2 }, PALETTE.carTrim);
    }
    // aileron : plan ovale sur étriers + plats latéraux arrondis
    trim
      .place({ position: { x: 0, y: 1.09, z: -1.98 }, scale: { x: 1.76, y: 1, z: 0.5 } })
      .prism({ radius: 0.5, height: 0.07, segments: 20 }, PALETTE.carTrim)
      .place(null);
    for (const x of [-0.58, 0.58]) {
      trim.box({ w: 0.07, h: 0.26, d: 0.14, x, y: 0.98, z: -1.95 }, PALETTE.carTrim);
    }
    for (const x of [-0.84, 0.84]) {
      trim
        .place({ position: { x, y: 0.9, z: -1.96 }, scale: { x: 0.05, y: 1, z: 0.52 } })
        .prism({ radius: 0.5, height: 0.3, segments: 12 }, bodyColor.scale(1.2))
        .place(null);
    }
    // optiques ovales affleurant le nez, légèrement pincés vers l'extérieur
    for (const x of [-0.46, 0.46]) {
      lamps.place({ position: { x, y: 0.48, z: 2.055 }, rotationY: -Math.sign(x) * 0.22 });
      lamps.disc({ rx: 0.16, ry: 0.065, segments: 14 }, PALETTE.carLight, PALETTE.carTrim);
      lamps.place(null);
    }
    // barre arrière ovale full-width (matériau séparé : s'allume au freinage)
    tails
      .place({ position: { x: 0, y: 0.455, z: -2.165 }, scale: { x: 1.45, y: 1, z: 0.09 } })
      .prism({ radius: 0.5, height: 0.08, segments: 16 }, PALETTE.carTail)
      .place(null);

    const paintMat = this.mat("car-paint-mat", { specular: 78 });
    this.add(paint.toMesh(this.scene, "car-paint"), paintMat);
    // vitres et toit : maillages séparés, masqués en vue cockpit pour que la
    // caméra (y ≈ 1,0) ne traverse aucune caisse.
    const topMesh = top.toMesh(this.scene, "car-top");
    this.roofTop = topMesh;
    this.add(topMesh, paintMat);
    const glassMesh = glass.toMesh(this.scene, "car-glass");
    this.glassMesh = glassMesh;
    this.add(glassMesh, this.mat("car-glass-mat", { alpha: 0.62, specular: 95 }));
    this.add(trim.toMesh(this.scene, "car-trim"), this.mat("car-trim-mat", { specular: 22 }));
    this.add(
      lamps.toMesh(this.scene, "car-heads"),
      this.mat("car-heads-mat", { emissive: new Color3(0.5, 0.46, 0.38), specular: 6 }),
    );
    const tailMesh = tails.toMesh(this.scene, "car-tails");
    this.tailMat = this.mat("car-tails-mat", { emissive: new Color3(0.22, 0.03, 0.02), specular: 6 });
    this.add(tailMesh, this.tailMat);
  }

  private buildWheels(): void {
    const tireBuilder = new FacetBuilder().prism({ radius: WHEEL_RADIUS, height: 0.26, segments: 16 }, PALETTE.tire);
    const rimBuilder = new FacetBuilder()
      .prism({ radius: WHEEL_RADIUS * 0.62, height: 0.29, segments: 12 }, PALETTE.rim.scale(0.75))
      .place({ position: { x: 0, y: 0.05, z: 0 } })
      .prism({ radius: WHEEL_RADIUS * 0.55, height: 0.12, segments: 12 }, PALETTE.carTrim.scale(1.25))
      .place({ position: { x: 0, y: 0.02, z: 0 } })
      .prism({ radius: WHEEL_RADIUS * 0.3, height: 0.31, segments: 6 }, PALETTE.rim);
    for (let k = 0; k < 5; k++) {
      rimBuilder
        .place({ position: { x: 0, y: 0.295, z: 0 }, rotationY: (k * Math.PI) / 5 })
        .box({ w: WHEEL_RADIUS * 1.18, h: 0.05, d: 0.1 }, PALETTE.rim.scale(1.12));
    }
    rimBuilder.place(null);
    const tireMesh = tireBuilder.toMesh(this.scene, "wheel-tire");
    const rimMesh = rimBuilder.toMesh(this.scene, "wheel-rim");
    if (!tireMesh || !rimMesh) return;
    const tireMat = this.mat("tire-mat", { specular: 4 });
    const rimMat = this.mat("rim-mat", { specular: 55 });
    tireMesh.material = tireMat;
    rimMesh.material = rimMat;
    const axles: readonly [number, number][] = [
      [-HALF_WIDTH, FRONT_AXLE],
      [HALF_WIDTH, FRONT_AXLE],
      [-HALF_WIDTH, -REAR_AXLE],
      [HALF_WIDTH, -REAR_AXLE],
    ];
    for (const [x, z] of axles) {
      const hub = new TransformNode("wheel-hub", this.scene);
      hub.parent = this.root;
      hub.position.set(x, WHEEL_RADIUS, z);
      hub.rotation.z = Math.PI / 2;
      const tire = tireMesh.clone("wheel-tire") as Mesh | null;
      const rim = rimMesh.clone("wheel-rim") as Mesh | null;
      if (!tire || !rim) continue;
      tire.parent = hub;
      rim.parent = hub;
      this.hubs.push(hub);
      this.wheels.push(tire);
      this.meshes.push(tire, rim);
    }
    tireMesh.dispose();
    rimMesh.dispose();
  }

  // --------------------------------------------------------------- simulation

  /** Masque toit/habitacle/pare-brise en vue cockpit : la caméra ne traverse plus de caisse. */
  setCockpitView(on: boolean): void {
    if (this.roofTop) this.roofTop.isVisible = !on;
    if (this.glassMesh) this.glassMesh.isVisible = !on;
  }

  /** Repositionne la voiture (grille de départ, téléportation après sortie). */
  placeAt(position: Vector3, heading: number): void {
    this.root.position.copyFrom(position);
    this.heading = shortestAngle(heading);
    this.velocity.setAll(0);
    this.steer = 0;
    this.spin = 0;
    this.forwardSpeed = 0;
    this.lateralSpeed = 0;
    this.prevForward = 0;
    this.longAccel = 0;
    this.impact = 0;
    this.contact = false;
    this.brakeGlow = 0;
    if (this.tailMat) this.tailMat.emissiveColor.set(0.22, 0.03, 0.02);
    this.roll = 0;
    this.pitch = 0;
    this.bounce = 0;
    this.prevHole = 0;
    this.skidTime = 0;
    this.hint = 0;
    this.prevX = position.x;
    this.prevY = position.y;
    this.prevZ = position.z;
    this.prevHeading = this.heading;
    this.renderPos.copyFrom(position);
    this.renderHeading = this.heading;
    this.applyBody();
  }

  /**
   * Interpole la position de rendu entre le pas physique précédent et le
   * suivant (`alpha` = reste de l'accumulateur / pas) : sans ça, la caméra suit
   * des positions discrètes à 120 Hz et le décor tremble sur les écrans dont le
   * rafraîchissement n'est pas un multiple exact du pas.
   */
  blendRender(alpha: number): void {
    const pos = this.root.position;
    this.renderPos.set(
      this.prevX + (pos.x - this.prevX) * alpha,
      this.prevY + (pos.y - this.prevY) * alpha,
      this.prevZ + (pos.z - this.prevZ) * alpha,
    );
    this.renderHeading = this.prevHeading + shortestAngle(this.heading - this.prevHeading) * alpha;
  }

  get position(): Vector3 {
    return this.root.position;
  }

  /** Vitesse signée le long de l'axe de la voiture. */
  get forwardVelocity(): number {
    return this.forwardSpeed;
  }

  /** Direction de la voiture dans le plan XZ (normalisée). */
  forward(out: Vector3): Vector3 {
    return out.set(Math.cos(this.heading), 0, Math.sin(this.heading));
  }

  /** Centre d'un moyeu, ramené au sol (pour les traces et la fumée). */
  wheelContact(index: number, out: Vector3): Vector3 {
    const hub = this.hubs[clamp(index, 0, this.hubs.length - 1)];
    if (!hub) return out.setAll(0);
    hub.computeWorldMatrix(true);
    Vector3.TransformCoordinatesToRef(hub.position, hub.getWorldMatrix(), out);
    return out.set(out.x, out.y - WHEEL_RADIUS * 0.92, out.z);
  }

  /** Fait tourner les roues sans simulation complète (placement cinématique). */
  spinWheels(speed: number, dt: number): void {
    this.spin -= (speed / WHEEL_RADIUS) * dt;
    for (const wheel of this.wheels) wheel.rotation.y = this.spin;
  }

  /**
   * Choc du joueur contre un objet non simulé (trafic) : ralentit, repousse
   * hors du rayon et signale un impact. Renvoie true si collision.
   */
  collideWith(px: number, pz: number, radius: number): boolean {
    const pos = this.root.position;
    let dx = pos.x - px;
    let dz = pos.z - pz;
    let d = Math.hypot(dx, dz);
    if (d >= radius) return false;
    if (d < 0.001) {
      dx = 0;
      dz = -1;
      d = 1;
    }
    const nx = dx / d;
    const nz = dz / d;
    const into = this.velocity.x * nx + this.velocity.z * nz;
    if (into < 0) {
      this.velocity.x -= nx * into * 1.5;
      this.velocity.z -= nz * into * 1.5;
    }
    this.velocity.x *= 0.7;
    this.velocity.z *= 0.7;
    pos.x = px + nx * radius;
    pos.z = pz + nz * radius;
    this.impact = Math.max(this.impact, clamp(Math.abs(into) / 12 + 0.15, 0, 1));
    this.readout.impact = this.impact;
    const fx = Math.cos(this.heading);
    const fz = Math.sin(this.heading);
    this.forwardSpeed = this.velocity.x * fx + this.velocity.z * fz;
    this.readout.speedKmh = Math.abs(this.forwardSpeed) * 3.6;
    return true;
  }

  /**
   * Obstacle brutal (grosse grenouille) : l'arrière décroche vers la barrière
   * du côté où roule la caisse, avec choc, perte de vitesse et glisse longue.
   */
  swerve(severity = 1): void {
    const speed = Math.abs(this.forwardSpeed);
    if (speed < 4) return;
    const fx = Math.cos(this.heading);
    const fz = Math.sin(this.heading);
    const side = this.readout.lateral >= 0 ? 1 : -1;
    const kick = severity * (4 + speed * 0.18);
    this.velocity.x += -fz * side * kick;
    this.velocity.z += fx * side * kick;
    this.heading = shortestAngle(this.heading + side * severity * 0.16);
    this.skidTime = Math.max(this.skidTime, 0.9);
    this.impact = Math.max(this.impact, 0.9);
    this.readout.impact = this.impact;
    const slow = 1 - severity * 0.16;
    this.velocity.x *= slow;
    this.velocity.z *= slow;
  }

  update(dt: number, input: VehicleInput, track: Track): void {
    const pos = this.root.position;
    this.prevX = pos.x;
    this.prevY = pos.y;
    this.prevZ = pos.z;
    this.prevHeading = this.heading;
    const near = track.query(pos.x, pos.z, this.heading, this.hint);
    this.hint = near.index;
    const half = track.roadHalf;
    const onRoad = Math.abs(near.lateral) <= half + 0.45;
    const topSpeed = onRoad ? TOP_ROAD : TOP_GRASS;
    const grip = onRoad ? 1 : 0.62;

    // --- longitudinal ------------------------------------------------------
    const fx = Math.cos(this.heading);
    const fz = Math.sin(this.heading);
    let forward = this.velocity.x * fx + this.velocity.z * fz;
    let lateral = -this.velocity.x * fz + this.velocity.z * fx;

    if (input.brake > 0.05 && forward > 0.6) {
      forward = approach(forward, 0, 8 + 22 * input.brake, dt);
    } else if (input.throttle > 0.02) {
      forward = approach(forward, input.throttle * topSpeed, onRoad ? 12 : 6, dt);
    } else if (input.brake > 0.05) {
      forward = approach(forward, -TOP_REVERSE * input.brake, 9, dt);
    } else {
      forward = approach(forward, 0, 3.4, dt);
    }
    if (input.handbrake) forward = approach(forward, 0, 10, dt);
    forward = clamp(forward, -TOP_REVERSE, topSpeed);

    // --- direction ---------------------------------------------------------
    const speedRatio = clamp(Math.abs(forward) / TOP_ROAD, 0, 1);
    // Braquet maximal : ~32° à basse vitesse pour négocier les épingles,
    // ~12° à 225 km/h pour garder la caisse stable en ligne droite.
    const maxRudder = 0.55 - 0.34 * speedRatio;
    // Les roues avant suivent toujours la commande, y compris en marche arrière :
    // la formule de taux de cap est déjà correcte dans les deux sens (en
    // reculant, des roues braquées à droite font tourner le cap vers la gauche
    // et la caisse se déplace bien vers la droite).
    const rudderTarget = input.steer * maxRudder;
    this.steer = damp(this.steer, rudderTarget, 11, dt);

    // Taux de cap converti dans le sens de `heading` (voir HEADING_SIGN) :
    // `yaw > 0` = tourne à gauche, `yaw < 0` = tourne à droite.
    const yaw =
      HEADING_SIGN *
      (forward / WHEEL_BASE) *
      Math.tan(this.steer) *
      grip *
      (input.handbrake ? 1.55 : 1);
    this.heading = shortestAngle(this.heading + yaw * dt);

    // --- glisse ------------------------------------------------------------
    // En dérive le cap tourne plus vite que la trajectoire : la caisse file vers
    // l'extérieur de la courbe, soit `lateral` (composante gauche) de signe
    // opposé à `yaw`. Un `skidTime` actif (gros nid de poule) fait perdre
    // l'adhérence latérale : la voiture dérape franchement.
    this.skidTime = Math.max(0, this.skidTime - dt);
    const hold = input.handbrake ? 1.6 : this.skidTime > 0 ? 0.5 : onRoad ? 7.5 : 3.4;
    const slide = input.handbrake && Math.abs(forward) > 8 ? -yaw * 0.5 * Math.abs(forward) : 0;
    lateral = damp(lateral, slide, hold, dt);

    // --- intégration + barrières -------------------------------------------
    const nfx = Math.cos(this.heading);
    const nfz = Math.sin(this.heading);
    this.velocity.x = nfx * forward - nfz * lateral;
    this.velocity.z = nfz * forward + nfx * lateral;

    let nx = pos.x + this.velocity.x * dt;
    let nz = pos.z + this.velocity.z * dt;
    const after = track.query(nx, nz, this.heading, this.hint);
    this.hint = after.index;
    const limit = half + 0.95;
    const hit = Math.abs(after.lateral) > limit;
    this.impact = 0;
    if (hit) {
      const side = Math.sign(after.lateral);
      const stop = track.positionAt(after.s, side * limit);
      nx = stop.x;
      nz = stop.z;
      const latX = -Math.sin(after.heading);
      const latZ = Math.cos(after.heading);
      const into = this.velocity.x * latX + this.velocity.z * latZ;
      this.velocity.x -= latX * into * 1.4;
      this.velocity.z -= latZ * into * 1.4;
      this.velocity.x *= 0.82;
      this.velocity.z *= 0.82;
      this.impact = this.contact ? 0 : clamp(Math.abs(into) / 14, 0, 1);
      forward = this.velocity.x * nfx + this.velocity.z * nfz;
      lateral = -this.velocity.x * nfz + this.velocity.z * nfx;
    }
    this.contact = hit;

    pos.x = nx;
    pos.z = nz;
    const moving = Math.hypot(this.velocity.x, this.velocity.z) > 2;
    // Nid de poule : l'asphalte décroche, la caisse tangute et s'enfonce.
    const hole = track.potholeAt(pos.x, pos.z);
    if (hole.rough > 0.02) {
      const drag = 1 - hole.rough * Math.min(1, 1.1 * dt);
      this.velocity.x *= drag;
      this.velocity.z *= drag;
      forward *= drag;
    }
    const enteringHole = this.prevHole < 0.25 && hole.rough >= 0.25;
    this.prevHole = hole.rough;
    if (enteringHole && Math.abs(forward) > 6) {
      if (hole.size <= 1) {
        // Petit nid : choc sec et net ralentissement, la trajectoire tient.
        this.impact = Math.max(this.impact, 0.45);
        const slow = 0.8;
        this.velocity.x *= slow;
        this.velocity.z *= slow;
        forward *= slow;
      } else if (Math.abs(forward) > 9) {
        // Moyen/gros nid : gros choc, l'arrière décroche et la caisse est
        // projetée vers la barrière du côté où elle se trouve déjà.
        this.impact = Math.max(this.impact, hole.size === 2 ? 0.68 : 0.92);
        const side = after.lateral >= 0 ? 1 : -1;
        const kick = (hole.size - 1) * (3.5 + Math.abs(forward) * 0.16);
        this.velocity.x += -nfz * side * kick;
        this.velocity.z += nfx * side * kick;
        lateral = -this.velocity.x * nfz + this.velocity.z * nfx;
        this.heading += side * (hole.size - 1) * 0.12;
        this.skidTime = hole.size === 2 ? 0.55 : 0.9;
        const slow = hole.size === 2 ? 0.9 : 0.82;
        this.velocity.x *= slow;
        this.velocity.z *= slow;
        forward *= slow;
      }
    }
    this.bounce =
      !onRoad && moving
        ? Math.sin(performance.now() * 0.035) * 0.05 + Math.sin(performance.now() * 0.017) * 0.03
        : hole.rough > 0.05 && moving
          ? Math.sin(performance.now() * 0.09) * 0.035 * hole.rough
          : damp(this.bounce, 0, 6, dt);
    pos.y = track.terrainHeight(nx, nz) + 0.02 - hole.sink;

    // --- lecture pour l'HUD, la caméra et l'audio ---------------------------
    if (dt > 0) this.longAccel = (forward - this.prevForward) / dt;
    this.prevForward = forward;
    this.forwardSpeed = forward;
    this.lateralSpeed = lateral;
    // En courbe la caisse s'incline vers l'extérieur : `steer > 0` (à droite)
    // avec `rotation.z > 0` soulève le côté `+x` (le droit) → inclinaison gauche.
    this.roll = damp(this.roll, this.steer * speedRatio * 0.17 * grip, 7, dt);
    this.pitch = damp(this.pitch, clamp(-this.longAccel * 0.012, -0.05, 0.05), 5, dt);
    this.spin -= (forward / WHEEL_RADIUS) * dt;

    // Feux stop : le rouge s'intensifie pendant le freinage.
    this.brakeGlow = damp(this.brakeGlow, input.brake > 0.05 ? 1 : 0, 16, dt);
    if (this.tailMat) {
      const g = this.brakeGlow;
      this.tailMat.emissiveColor.set(0.22 + 1.9 * g, 0.03 + 0.24 * g, 0.02 + 0.04 * g);
    }

    const slip = Math.abs(forward) > 3 ? Math.atan2(lateral, Math.abs(forward)) : 0;
    const readout = this.readout;
    readout.speedKmh = Math.abs(forward) * 3.6;
    readout.onRoad = onRoad;
    readout.lateral = after.lateral;
    readout.slip = slip;
    readout.impact = this.impact;
    readout.drifting = Math.abs(slip) > 0.16 && Math.abs(forward) > 9;

    this.applyBody();
  }

  /** Intensité de glisse 0..1 pour les traces de pneu et l'audio. */
  get skidIntensity(): number {
    const slide = Math.abs(this.lateralSpeed);
    const locked = this.readout.drifting ? 0.35 : 0;
    return clamp((slide - 1.2) / 9 + locked, 0, 1);
  }

  private applyBody(): void {
    this.root.rotation.y = Math.PI / 2 - this.heading;
    this.bodyNode.rotation.z = this.roll;
    this.bodyNode.rotation.x = this.pitch;
    this.bodyNode.position.y = this.bounce;
    for (let i = 0; i < this.hubs.length; i++) {
      this.hubs[i].rotation.y = i < 2 ? this.steer : 0;
      const wheel = this.wheels[i];
      if (wheel) wheel.rotation.y = this.spin;
    }
  }

  dispose(): void {
    for (const mesh of this.meshes) mesh.dispose();
    for (const material of this.materials) material.dispose();
    for (const hub of this.hubs) hub.dispose();
    this.bodyNode.dispose();
    this.root.dispose();
  }
}

/**
 * Traces de pneu : bande sombre au sol qui s'estompe, reconstruite par petits
 * paquets (une fois tous les 120 ms) pour éviter de toucher le GPU à chaque image.
 */
export class SkidMarks {
  private static readonly MAX_SEGMENTS = 240;
  private readonly samples: { lx: number; lz: number; rx: number; rz: number; y: number; a: number }[] = [];
  private mesh: Mesh | null = null;
  private readonly material: StandardMaterial;
  private timer = 0;

  constructor(private readonly scene: Scene) {
    this.material = new StandardMaterial("skid-mat", scene);
    this.material.diffuseColor = new Color3(0.08, 0.08, 0.09);
    this.material.emissiveColor = new Color3(0.02, 0.02, 0.02);
    this.material.disableLighting = true;
    this.material.specularColor = new Color3(0, 0, 0);
    this.material.backFaceCulling = false;
  }

  /** Enregistre l'empreinte des deux roues arrière. */
  push(left: Vector3, right: Vector3, strength: number): void {
    if (strength <= 0.03) return;
    this.samples.push({
      lx: left.x,
      lz: left.z,
      rx: right.x,
      rz: right.z,
      y: left.y + 0.035,
      a: clamp(strength, 0, 1),
    });
    if (this.samples.length > SkidMarks.MAX_SEGMENTS) this.samples.shift();
  }

  update(dt: number): void {
    if (this.samples.length === 0) return;
    let alive = 0;
    for (const sample of this.samples) {
      sample.a -= dt * 0.11;
      if (sample.a > 0.01) alive++;
    }
    if (alive < 2) {
      this.clear();
      return;
    }
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = 0.12;
    this.rebuild();
  }

  private rebuild(): void {
    const pts = this.samples.filter((s) => s.a > 0.01);
    const positions: number[] = [];
    const colors: number[] = [];
    const normals: number[] = [];
    const indices: number[] = [];
    const half = 0.27;
    for (let i = 1; i < pts.length; i++) {
      const prev = pts[i - 1];
      const cur = pts[i];
      const span = Math.hypot(cur.lx - prev.lx, cur.lz - prev.lz);
      if (span > 7 || span < 0.0005) continue;
      const alpha = Math.min(prev.a, cur.a) * 0.8;
      const strips: [number, number, number, number][] = [
        [prev.lx - half, prev.lz, cur.lx - half, cur.lz],
        [prev.lx + half, prev.lz, cur.lx + half, cur.lz],
        [prev.rx - half, prev.rz, cur.rx - half, cur.rz],
        [prev.rx + half, prev.rz, cur.rx + half, cur.rz],
      ];
      const base = positions.length / 3;
      for (const [ax, az, bx, bz] of strips) {
        positions.push(ax, cur.y, az, bx, cur.y, bz);
        normals.push(0, 1, 0, 0, 1, 0);
        colors.push(0, 0, 0, alpha, 0, 0, 0, alpha);
      }
      for (let s = 0; s < 4; s++) {
        const o = base + s * 2;
        indices.push(o, o + 1, o + 3, o, o + 3, o + 2);
      }
    }
    if (this.mesh) this.mesh.dispose();
    this.mesh = null;
    if (indices.length === 0) return;
    const mesh = new Mesh("skid-marks", this.scene);
    const data = new VertexData();
    data.positions = positions;
    data.normals = normals;
    data.colors = colors;
    data.indices = indices;
    data.applyToMesh(mesh);
    mesh.material = this.material;
    mesh.isPickable = false;
    mesh.applyFog = false;
    this.mesh = mesh;
  }

  clear(): void {
    this.samples.length = 0;
    if (this.mesh) this.mesh.dispose();
    this.mesh = null;
  }

  dispose(): void {
    this.clear();
    this.material.dispose();
  }
}
