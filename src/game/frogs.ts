import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { InstancedMesh } from "@babylonjs/core/Meshes/instancedMesh";
import type { Scene } from "@babylonjs/core/scene";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode";

import { FacetBuilder } from "./geometry";
import { PALETTE } from "./palette";
import type { Track } from "./track";
import { clamp, createRandom, wrap01 } from "./utils";

/** Une grenouille et son petit automate de bond. */
interface Frog {
  node: InstancedMesh;
  /** Avancement sur la piste (m) : dérive lentement à chaque bond. */
  s: number;
  lateral: number;
  baseLateral: number;
  /** +1 = traverse vers la gauche, -1 = vers la droite. */
  dir: 1 | -1;
  /** Compte à rebours avant le prochain bond (s). */
  timer: number;
  hopping: boolean;
  hopT: number;
  hopSpan: number;
  hopDur: number;
  hopHeight: number;
  /** Hauteur au-dessus du sol (m). */
  air: number;
  /** Écrasée : aplatie un moment puis réapparée ailleurs. */
  dead: boolean;
  deadTimer: number;
  /** Position monde XZ (pour les contrôles). */
  x: number;
  z: number;
}

const DEFAULT_COUNT = 6;
const MAX_FROGS = 24;
/** Taille du modèle (~0,7 m de long) : grosse pour une grenouille, petit face à la caisse. */
const FROG_SCALE = 0.68;
/** Rayon de contact caisse ↔ grenouille (m). */
const SQUASH_RADIUS = 1.15;
/** Durée d'affichage de la grenouille écrasée avant réapparition (s). */
const DEAD_TIME = 7;

/**
 * Grosses grenouilles vertes qui traversent la piste en bondissant. Le modèle
 * est construit en facettes (aucune ressource externe) et instancié par
 * grenouille ; chaque instance anime position, cap et écrasement.
 */
export class Frogs {
  private readonly frogs: Frog[] = [];
  private readonly source: Mesh | null;
  private readonly material: StandardMaterial;
  private readonly rnd: () => number;
  private readonly scratch = new Vector3();
  private readonly half: number;
  private readonly length: number;
  private readonly world: TransformNode;
  private born = 0;

  constructor(
    private readonly scene: Scene,
    world: TransformNode,
    private readonly track: Track,
    count = DEFAULT_COUNT,
  ) {
    this.half = track.roadHalf;
    this.length = track.totalLength;
    this.world = world;
    this.rnd = createRandom(0x9f5ee1);
    this.material = new StandardMaterial("frog-mat", scene);
    this.material.diffuseColor = Color3.White();
    this.material.specularColor = new Color3(0.05, 0.06, 0.04);
    this.material.specularPower = 24;
    this.source = this.buildSource();
    if (!this.source) return;
    this.source.material = this.material;
    this.source.isVisible = false;
    this.source.isPickable = false;
    this.setCount(count);
  }

  get list(): readonly Frog[] {
    return this.frogs;
  }

  /** Ajuste le nombre de grenouilles en piste (0 … 24). */
  setCount(count: number): void {
    const target = clamp(Math.round(count), 0, MAX_FROGS);
    while (this.frogs.length > target) this.frogs.pop()?.node.dispose();
    while (this.frogs.length < target && this.source) {
      const node = this.source.createInstance(`frog-${this.born}`);
      this.born += 1;
      node.parent = this.world;
      node.isPickable = false;
      this.frogs.push(this.spawn(node));
    }
  }

  /** Modèle ~1 m : corps et tête en ellipsoïdes bombés, yeux globuleux, pattes repliées. */
  private buildSource(): Mesh | null {
    const b = new FacetBuilder();
    const G = PALETTE.frogGreen;
    b.place({ position: { x: 0, y: 0.27, z: -0.04 } }).ellipsoid({ rx: 0.33, ry: 0.22, rz: 0.5, segments: 14, rings: 8 }, G);
    b.place({ position: { x: 0, y: 0.3, z: 0.46 } }).ellipsoid({ rx: 0.23, ry: 0.17, rz: 0.24, segments: 12, rings: 7 }, G.scale(1.08));
    for (const x of [-0.14, 0.14]) {
      b.place({ position: { x, y: 0.45, z: 0.5 } }).ellipsoid({ rx: 0.085, ry: 0.085, rz: 0.085, segments: 10, rings: 6 }, PALETTE.frogEye);
      b.place({ position: { x, y: 0.47, z: 0.575 } }).ellipsoid({ rx: 0.045, ry: 0.05, rz: 0.03, segments: 8, rings: 5 }, PALETTE.frogDark);
    }
    for (const x of [-0.28, 0.28]) {
      b.place({ position: { x, y: 0.1, z: 0.26 } }).ellipsoid({ rx: 0.08, ry: 0.09, rz: 0.16, segments: 8, rings: 5 }, PALETTE.frogDark);
      b.place({ position: { x: x * 1.25, y: 0.19, z: -0.3 } }).ellipsoid({ rx: 0.11, ry: 0.15, rz: 0.24, segments: 10, rings: 6 }, PALETTE.frogDark.scale(1.15));
    }
    return b.toMesh(this.scene, "frog");
  }

  private spawn(node: InstancedMesh): Frog {
    const frog: Frog = {
      node,
      // N'importe où sur la boucle, jamais sur la ligne de départ.
      s: this.length * (0.08 + 0.85 * this.rnd()),
      lateral: (this.rnd() * 2 - 1) * (this.half - 1),
      baseLateral: 0,
      dir: this.rnd() > 0.5 ? 1 : -1,
      timer: 0.4 + this.rnd() * 2.2,
      hopping: false,
      hopT: 0,
      hopSpan: 2,
      hopDur: 0.45,
      hopHeight: 0.6,
      air: 0,
      dead: false,
      deadTimer: 0,
      x: 0,
      z: 0,
    };
    frog.baseLateral = frog.lateral;
    this.place(frog);
    return frog;
  }

  /** Repositionne l'instance (sol + arc du bond) et l'oriente face à sa route. */
  private place(frog: Frog): void {
    const p = this.track.positionAt(frog.s, frog.lateral, this.scratch);
    frog.x = p.x;
    frog.z = p.z;
    frog.node.position.set(p.x, p.y + frog.air, p.z);
    const heading = this.track.headingAt(frog.s) + frog.dir * (Math.PI / 2);
    frog.node.rotation.y = Math.PI / 2 - heading;
    const stretch = frog.hopping ? 1 + 0.16 * Math.sin(Math.PI * frog.hopT) : 1;
    if (frog.dead) frog.node.scaling.set(1.6 * FROG_SCALE, 0.16 * FROG_SCALE, 1.6 * FROG_SCALE);
    else frog.node.scaling.set((2 - stretch) * FROG_SCALE, stretch * FROG_SCALE, (2 - stretch) * FROG_SCALE);
  }

  /**
   * Fait bondir les grenouilles ; renvoie true si le joueur vient d'en écraser
   * une (le Frog est déjà aplati, l'app déclenche la glisse).
   */
  update(dt: number, carPos: Vector3, carSpeed: number): boolean {
    let squashed = false;
    for (const frog of this.frogs) {
      if (frog.dead) {
        frog.deadTimer -= dt;
        if (frog.deadTimer <= 0) {
          frog.dead = false;
          frog.s = this.length * (0.08 + 0.85 * this.rnd());
          frog.dir = this.rnd() > 0.5 ? 1 : -1;
          frog.lateral = frog.baseLateral = frog.dir * -(this.half + 1.5);
          frog.air = 0;
          frog.timer = 0.3 + this.rnd() * 1.2;
        }
        continue;
      }
      if (frog.hopping) {
        frog.hopT = clamp(frog.hopT + dt / frog.hopDur, 0, 1);
        frog.lateral = frog.baseLateral + frog.dir * frog.hopSpan * frog.hopT;
        frog.air = Math.sin(Math.PI * frog.hopT) * frog.hopHeight;
        if (frog.hopT >= 1) {
          frog.hopping = false;
          frog.air = 0;
          frog.baseLateral = frog.lateral;
          frog.timer = 0.7 + this.rnd() * 1.6;
          if (Math.abs(frog.lateral) > this.half + 2.5) frog.dir = frog.dir === 1 ? -1 : 1;
        }
      } else {
        frog.timer -= dt;
        if (frog.timer <= 0) {
          frog.hopping = true;
          frog.hopT = 0;
          frog.hopSpan = 1.6 + this.rnd() * 1.2;
          frog.hopDur = 0.42 + this.rnd() * 0.16;
          frog.hopHeight = 0.45 + this.rnd() * 0.4;
          frog.s = wrap01((frog.s + (this.rnd() - 0.5) * 5) / this.length) * this.length;
        }
      }
      // Écrasement : grenouille au sol (ou presque) sous la caisse lancée.
      if (frog.air < 0.3 && Math.abs(carSpeed) > 4) {
        const dx = frog.x - carPos.x;
        const dz = frog.z - carPos.z;
        if (dx * dx + dz * dz < SQUASH_RADIUS * SQUASH_RADIUS) {
          frog.dead = true;
          frog.deadTimer = DEAD_TIME;
          frog.air = 0;
          squashed = true;
        }
      }
      this.place(frog);
    }
    return squashed;
  }

  /** Remise à zéro (redémarrage de course) : plus de grenouille écrasée. */
  reset(): void {
    for (const frog of this.frogs) {
      frog.dead = false;
      frog.deadTimer = 0;
      frog.hopping = false;
      frog.air = 0;
      frog.timer = 0.5 + this.rnd() * 1.5;
      this.place(frog);
    }
  }

  dispose(): void {
    for (const frog of this.frogs) frog.node.dispose();
    this.frogs.length = 0;
    if (this.source) this.source.dispose(false, false);
    this.material.dispose();
  }
}
