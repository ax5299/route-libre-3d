import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { InstancedMesh } from "@babylonjs/core/Meshes/instancedMesh";
import type { Scene } from "@babylonjs/core/scene";

import { PALETTE } from "./palette";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { FacetBuilder, addBand, type BandRow } from "./geometry";
import type { CircuitId } from "./settings";
import { clamp, createRandom, lerp, wrap01 } from "./utils";

/** Définition d'un circuit : spline fermée + dénivelé par point. */
export interface CircuitDef {
  id: CircuitId;
  /** Nom affiché (menus, diagnostic). */
  label: string;
  points: CircuitPoint[];
  elevation: number[];
}

export class Track {
  readonly root: TransformNode;
  readonly samples: Sample[] = [];
  /** Circuit utilisé (points directeurs + nom). */
  readonly circuit: CircuitDef;
  /** Longueur totale du tour (m). */
  totalLength = 0;
  /** Portiques de contrôle, dans le sens de la course. */
  readonly checkpoints: { s: number; position: Vector3; heading: number }[] = [];
  /** Repère de départ (position et cap). */
  readonly startPos = Vector3.Zero();
  startHeading = 0;

  private readonly created: Mesh[] = [];
  private readonly instances: AbstractMesh[] = [];
  private stride = 1;

  constructor(
    readonly scene: Scene,
    parent: TransformNode,
    circuit: CircuitDef,
  ) {
    this.circuit = circuit;
    this.root = new TransformNode("track", scene);
    this.root.parent = parent;
    this.buildSamples();
    this.buildCheckpoints();
  }

  // ------------------------------------------------------------- échantillonnage de l'axe

  private buildSamples(): void {
    const pts = this.circuit.points;
    const elevSrc = this.circuit.elevation;
    const n = pts.length;
    const raw: { x: number; z: number }[] = [];
    const elev: number[] = [];
    for (let i = 0; i < n; i++) {
      const p0 = pts[(i - 1 + n) % n];
      const p1 = pts[i];
      const p2 = pts[(i + 1) % n];
      const p3 = pts[(i + 2) % n];
      const e0 = elevSrc[i] ?? 0;
      const e1 = elevSrc[(i + 1) % n] ?? 0;
      for (let j = 0; j < CURVE_SUBDIVISIONS; j++) {
        const t = j / CURVE_SUBDIVISIONS;
        raw.push(catmullRom(p0, p1, p2, p3, t));
        const k = t * t * (3 - 2 * t); // interpolation lissée du dénivelé
        elev.push(lerp(e0, e1, k));
      }
    }

    const cumulative: number[] = [0];
    for (let i = 1; i <= raw.length; i++) {
      const a = raw[i - 1];
      const b = raw[i % raw.length];
      cumulative.push(cumulative[i - 1] + Math.hypot(b.x - a.x, b.z - a.z));
    }
    const perimeter = cumulative[cumulative.length - 1];

    const count = Math.max(64, Math.round(perimeter / STEP));
    let cursor = 0;
    for (let i = 0; i < count; i++) {
      const target = (i / count) * perimeter;
      while (cursor < cumulative.length - 2 && cumulative[cursor + 1] < target) cursor++;
      const segLen = cumulative[cursor + 1] - cumulative[cursor] || 1;
      const f = clamp((target - cumulative[cursor]) / segLen, 0, 1);
      const a = raw[cursor];
      const b = raw[(cursor + 1) % raw.length];
      this.samples.push({
        x: lerp(a.x, b.x, f),
        z: lerp(a.z, b.z, f),
        y: lerp(elev[cursor] ?? 0, elev[(cursor + 1) % elev.length] ?? 0, f),
        tx: 0,
        tz: 0,
        nx: 0,
        nz: 0,
        s: target,
        curvature: 0,
      });
    }
    this.totalLength = perimeter;
    this.stride = Math.max(1, Math.round(20 / STEP));

    const m = this.samples.length;
    const headings: number[] = [];
    for (let i = 0; i < m; i++) {
      const prev = this.samples[(i - 1 + m) % m];
      const next = this.samples[(i + 1) % m];
      const dx = next.x - prev.x;
      const dz = next.z - prev.z;
      const len = Math.hypot(dx, dz) || 1;
      const smp = this.samples[i];
      smp.tx = dx / len;
      smp.tz = dz / len;
      smp.nx = -smp.tz;
      smp.nz = smp.tx;
      headings.push(Math.atan2(dz, dx));
    }

    // Courbure lissée sur 7 échantillons consécutifs.
    for (let i = 0; i < m; i++) {
      let sum = 0;
      for (let k = -3; k <= 3; k++) {
        const h0 = headings[(i + k - 1 + m) % m];
        const h1 = headings[(i + k) % m];
        let d = h1 - h0;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        sum += d / STEP;
      }
      this.samples[i].curvature = sum / 7;
    }
  }

  private buildCheckpoints(): void {
    for (let i = 0; i < CHECKPOINT_COUNT; i++) {
      const s = (i / CHECKPOINT_COUNT) * this.totalLength;
      this.checkpoints.push({
        s,
        position: this.positionAt(s, 0, new Vector3()),
        heading: this.headingAt(s),
      });
    }
    const target = this.circuit.points.find((p) => p.start) ?? this.circuit.points[0];
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < this.samples.length; i++) {
      const smp = this.samples[i];
      const d = (smp.x - target.x) ** 2 + (smp.z - target.z) ** 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    const first = this.samples[best];
    this.startPos.set(first.x, first.y, first.z);
    this.startHeading = Math.atan2(first.tz, first.tx);
  }

  private indexAtS(s: number): number {
    const m = this.samples.length;
    return Math.floor(wrap01(s / this.totalLength) * m) % m;
  }

  /** Cap de la piste à l'abscisse `s`. */
  headingAt(s: number): number {
    const smp = this.samples[this.indexAtS(s)];
    return Math.atan2(smp.tz, smp.tx);
  }

  /** Courbure locale (1/m), utilisée par la caméra et les indications sonores. */
  curvatureAt(s: number): number {
    return this.samples[this.indexAtS(s)].curvature;
  }

  /** Position sur la route, décalée latéralement (positive = gauche de l'axe). */
  positionAt(s: number, lateral: number, out = new Vector3()): Vector3 {
    const smp = this.samples[this.indexAtS(s)];
    out.set(smp.x + smp.nx * lateral, smp.y, smp.z + smp.nz * lateral);
    return out;
  }

  /** Hauteur du sol (revêtement, accotement ou talus). */
  heightAt(s: number, lateral: number): number {
    const smp = this.samples[this.indexAtS(s)];
    return this.heightFromSample(smp.y, lateral);
  }

  private heightFromSample(roadY: number, lateral: number): number {
    const a = Math.abs(lateral);
    if (a <= ROAD_HALF) return roadY;
    if (a <= SHOULDER_HALF) return roadY - (0.07 * (a - ROAD_HALF)) / (SHOULDER_HALF - ROAD_HALF);
    const t = clamp((a - SHOULDER_HALF) / 7, 0, 1);
    return roadY - 0.07 - 0.75 * t * t;
  }

  /** Demi-largeur du revêtement (m). */
  get roadHalf(): number {
    return ROAD_HALF;
  }

  /** Revêtement + accotement : au-delà, la voiture est dans l'herbe (m). */
  get shoulderHalf(): number {
    return SHOULDER_HALF;
  }

  // --------------------------------------------------------------------------- requêtes

  /** Index de l'échantillon le plus proche, en cherchant autour d'une indice connu. */
  private nearestIndex(x: number, z: number, hint: number): number {
    const m = this.samples.length;
    let best = hint;
    let bestD = Infinity;
    const window = this.stride * 3;
    for (let k = -window; k <= window; k++) {
      const i = (hint + k + m * 2) % m;
      const smp = this.samples[i];
      const d = (smp.x - x) ** 2 + (smp.z - z) ** 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    if (bestD > 3600) {
      // fenêtre insuffisante (téléportation, réinitialisation) : recherche globale
      bestD = Infinity;
      for (let i = 0; i < m; i += this.stride) {
        const smp = this.samples[i];
        const d = (smp.x - x) ** 2 + (smp.z - z) ** 2;
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      const coarse = best;
      for (let k = -this.stride; k <= this.stride; k++) {
        const i = (coarse + k + m) % m;
        const smp = this.samples[i];
        const d = (smp.x - x) ** 2 + (smp.z - z) ** 2;
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
    }
    return best;
  }

  /**
   * Position relative du véhicule par rapport à la piste. `hint` est l'index
   * de l'appel précédent (recherche locale donc quasi gratuite).
   */
  query(x: number, z: number, heading: number, hint: number): { index: number } & TrackQuery {
    const m = this.samples.length;
    const index = this.nearestIndex(x, z, hint);
    const smp = this.samples[index];
    const dx = x - smp.x;
    const dz = z - smp.z;
    const lateral = dx * smp.nx + dz * smp.nz;
    const absolute = Math.abs(lateral);
    const forward = Math.cos(heading) * smp.tx + Math.sin(heading) * smp.tz;
    return {
      index,
      s: (index / m) * this.totalLength,
      lateral,
      heading: Math.atan2(smp.tz, smp.tx),
      onRoad: absolute <= ROAD_HALF,
      offTrack: absolute > SHOULDER_HALF,
      wrongWay: forward < -0.15,
    };
  }

  /** Distance à l'axe pour une position libre (végétation, props). */
  distanceToTrack(x: number, z: number): { lateral: number; s: number } {
    const index = this.nearestIndex(x, z, 0);
    const smp = this.samples[index];
    const lateral = (x - smp.x) * smp.nx + (z - smp.z) * smp.nz;
    return { lateral, s: smp.s };
  }

  /**
   * Altitude du terrain. Le long du circuit, le sol suit la route sur une
   * large bande (le circuit est posé sur son emprise) puis des collines
   * sinusoïdales déterministes prennent le relais, et une chaîne de montagnes
   * se soulève au loin.
   */
  terrainHeight(x: number, z: number): number {
    const { lateral, s } = this.distanceToTrack(x, z);
    const roadY = this.samples[this.indexAtS(s)].y;
    const a = Math.abs(lateral);
    const base = this.heightFromSample(roadY, a);
    if (a <= FREE_RELIEF) return base;

    const t = clamp((a - FREE_RELIEF) / 120, 0, 1);
    const hills =
      Math.sin(x * 0.0071 + 1.2) * Math.cos(z * 0.0064 - 0.4) * 11 +
      Math.sin(x * 0.017 - 2.1) * Math.sin(z * 0.014 + 0.9) * 4.5 +
      Math.cos(x * 0.0035 + z * 0.0041) * 7;
    const ridge = a > 320 ? (a - 320) * 0.42 : 0;
    return base + t * t * (hills + ridge * ridge * 0.02 + ridge);
  }

  // ------------------------------------------------------------------ construction

  /** Fabrique tout le décor. À appeler après la création de la scène. */
  build(): void {
    this.buildTerrain();
    this.buildRoad();
    this.buildBarriers();
    this.buildStartAndFinish();
    this.buildCheckpointArch();
    this.buildProps();
    this.buildMountains();
  }

  private readonly materials = new Map<string, StandardMaterial>();

  private material(
    name: string,
    opts: { emissive?: number; specular?: number; unlit?: boolean; twoSided?: boolean } = {},
  ): StandardMaterial {
    const key = `${name}|${opts.emissive ?? 0}|${opts.specular ?? 0}|${opts.unlit ? 1 : 0}|${opts.twoSided ? 1 : 0}`;
    const cached = this.materials.get(key);
    if (cached) return cached;
    const mat = new StandardMaterial(name, this.scene);
    mat.diffuseColor = Color3.White();
    mat.specularColor = new Color3(0.03, 0.03, 0.035).scale(opts.specular ?? 1);
    mat.specularPower = 96;
    mat.emissiveColor = Color3.White().scale(opts.emissive ?? 0);
    if (opts.unlit) {
      mat.disableLighting = true;
      mat.emissiveColor = Color3.White().scale(0.9);
    }
    if (opts.twoSided) mat.backFaceCulling = false;
    this.materials.set(key, mat);
    return mat;
  }

  private register(mesh: Mesh | null, material: StandardMaterial, opts: { shadows?: boolean } = {}): void {
    if (!mesh) return;
    mesh.material = material;
    mesh.parent = this.root;
    mesh.receiveShadows = opts.shadows ?? false;
    mesh.freezeWorldMatrix();
    this.created.push(mesh);
  }

  /** Variation déterministe (0…1) qui casse l'uniformité des surfaces. */
  private static hash(i: number): number {
    const v = Math.sin(i * 12.9898) * 43758.5453;
    return v - Math.floor(v);
  }

  private buildRoad(): void {
    const m = this.samples.length;
    const asphalt = new FacetBuilder();
    const lines = new FacetBuilder();
    const rumbles = new FacetBuilder();
    const rows: BandRow[] = [];
    const leftLine: BandRow[] = [];
    const rightLine: BandRow[] = [];

    // Profil transversal : latérales croissantes => normales vers le haut.
    const profile: { lat: number; tint: number; color: Color3 }[] = [
      { lat: -17.5, tint: 0.92, color: PALETTE.grassDry },
      { lat: -SHOULDER_HALF, tint: 1, color: PALETTE.shoulder },
      { lat: -10.4, tint: 0.86, color: PALETTE.asphaltDark },
      { lat: -ROAD_HALF, tint: 1, color: PALETTE.asphaltDark },
      { lat: -4.6, tint: 1.14, color: PALETTE.asphaltLight },
      { lat: 0, tint: 1, color: PALETTE.asphalt },
      { lat: 4.6, tint: 1.14, color: PALETTE.asphaltLight },
      { lat: ROAD_HALF, tint: 1, color: PALETTE.asphaltDark },
      { lat: 10.4, tint: 0.86, color: PALETTE.asphaltDark },
      { lat: SHOULDER_HALF, tint: 1, color: PALETTE.shoulder },
      { lat: 17.5, tint: 0.92, color: PALETTE.grassDry },
    ];

    for (let i = 0; i < m; i++) {
      const smp = this.samples[i];
      const next = this.samples[(i + 1) % m];
      const patch = 0.94 + 0.11 * Track.hash(i);

      const row: BandRow = { points: [] };
      for (const p of profile) {
        row.points.push({
          p: {
            x: smp.x + smp.nx * p.lat,
            y: this.heightFromSample(smp.y, p.lat) + 0.006,
            z: smp.z + smp.nz * p.lat,
          },
          color: p.color.scale(p.tint * patch),
        });
      }
      rows.push(row);

      const lift = 0.02;
      const white = PALETTE.paintWhite.scale(0.94 + 0.1 * patch);
      const edgeRow = (from: number, to: number): BandRow => ({
        points: [
          { p: { x: smp.x + smp.nx * from, y: smp.y + lift, z: smp.z + smp.nz * from }, color: white },
          { p: { x: smp.x + smp.nx * to, y: smp.y + lift, z: smp.z + smp.nz * to }, color: white },
        ],
      });
      leftLine.push(edgeRow(8.2, 8.85));
      rightLine.push(edgeRow(-8.85, -8.2));

      // cordes bicolores alternées
      const striped = Track.hash(i * 7) < 0.5 ? PALETTE.curbRed : PALETTE.paintWhite;
      for (const side of [-1, 1]) {
        const latA = Math.min(9.05 * side, 9.8 * side);
        const latB = Math.max(9.05 * side, 9.8 * side);
        rumbles.quad(
          { x: smp.x + smp.nx * latA, y: smp.y + 0.03, z: smp.z + smp.nz * latA },
          { x: smp.x + smp.nx * latB, y: smp.y + 0.03, z: smp.z + smp.nz * latB },
          { x: next.x + next.nx * latB, y: next.y + 0.03, z: next.z + next.nz * latB },
          { x: next.x + next.nx * latA, y: next.y + 0.03, z: next.z + next.nz * latA },
          striped.scale(0.88 + 0.22 * patch),
        );
      }
    }

    addBand(asphalt, rows, true);
    addBand(lines, leftLine, true);
    addBand(lines, rightLine, true);
    this.register(asphalt.toMesh(this.scene, "road"), this.material("road", { specular: 1.7 }));
    this.register(lines.toMesh(this.scene, "road-lines"), this.material("road-lines", { unlit: true }));
    this.register(rumbles.toMesh(this.scene, "rumble"), this.material("rumble", { unlit: true }));

    // marquage central discontinu
    const dashes = new FacetBuilder();
    for (let i = 0; i < m; i++) {
      const smp = this.samples[i];
      if (smp.s % 7 > 3.4) continue;
      const next = this.samples[(i + 1) % m];
      const y0 = smp.y + 0.02;
      const y1 = next.y + 0.02;
      dashes.quad(
        { x: smp.x - smp.nx * 0.18, y: y0, z: smp.z - smp.nz * 0.18 },
        { x: smp.x + smp.nx * 0.18, y: y0, z: smp.z + smp.nz * 0.18 },
        { x: next.x + next.nx * 0.18, y: y1, z: next.z + next.nz * 0.18 },
        { x: next.x - next.nx * 0.18, y: y1, z: next.z - next.nz * 0.18 },
        PALETTE.paintYellow,
      );
    }
    this.register(dashes.toMesh(this.scene, "center-line"), this.material("center-line", { unlit: true }));
  }

  /**
   * Hauteur du terrain pour le MESH uniquement : 5 cm sous la surface physique
   * dans la bande routière. La corde des triangles du terrain (grille de ~17 m)
   * dépasse localement la chaussée de ~1 cm dans les virages ; sans cette marge,
   * elle perce l'asphalte en îlots d'herbe. Le décalage est invisible (fossé au
   * bord de route) et ne change pas la physique (`terrainHeight` inchangée).
   */
  private terrainRenderHeight(x: number, z: number): number {
    const { lateral, s } = this.distanceToTrack(x, z);
    const a = Math.abs(lateral);
    if (a > FREE_RELIEF) return this.terrainHeight(x, z);
    return this.heightFromSample(this.samples[this.indexAtS(s)].y, a) - 0.05;
  }

  private buildTerrain(): void {
    const fb = new FacetBuilder();
    const CELLS = 74;
    const EXTENT = 620;
    const cell = (EXTENT * 2) / CELLS;
    for (let ix = 0; ix < CELLS; ix++) {
      const x0 = -EXTENT + ix * cell;
      const x1 = x0 + cell;
      for (let iz = 0; iz < CELLS; iz++) {
        const z0 = -EXTENT + iz * cell;
        const z1 = z0 + cell;
        const y00 = this.terrainRenderHeight(x0, z0);
        const y01 = this.terrainRenderHeight(x0, z1);
        const y11 = this.terrainRenderHeight(x1, z1);
        const y10 = this.terrainRenderHeight(x1, z0);
        fb.quad(
          { x: x0, y: y00, z: z0 },
          { x: x0, y: y01, z: z1 },
          { x: x1, y: y11, z: z1 },
          { x: x1, y: y10, z: z0 },
          this.terrainColor((x0 + x1) / 2, (z0 + z1) / 2, (y00 + y01 + y11 + y10) / 4),
        );
      }
    }
    // Sans polygon offset, les triangles du terrain (grille grossière) peuvent
    // dépasser la chaussée dans les courbes verticales et transpercer l'asphalte.
    const terrainMat = this.material("terrain");
    terrainMat.zOffset = 1;
    terrainMat.zOffsetUnits = 1;
    this.register(fb.toMesh(this.scene, "terrain"), terrainMat);
  }

  /** Couleur de l'herbe : nuances déterministes, roche puis neige en altitude. */
  private terrainColor(x: number, z: number, y: number): Color3 {
    const cell = Math.floor(x * 0.31) * 73 + Math.floor(z * 0.27) * 131;
    let c = Color3.Lerp(PALETTE.grassDeep, PALETTE.grassLight, 0.25 + 0.55 * Track.hash(cell));
    const dry = Track.hash(Math.floor(x * 0.09) * 7 + Math.floor(z * 0.11) * 17);
    c = Color3.Lerp(c, PALETTE.grassDry, 0.12 + 0.28 * dry);
    if (y > 45) c = Color3.Lerp(c, PALETTE.rock, clamp((y - 45) / 80, 0, 0.8));
    if (y > 120) c = Color3.Lerp(c, PALETTE.snow, clamp((y - 120) / 70, 0, 0.92));
    if (y < -8) c = Color3.Lerp(c, PALETTE.dirt, clamp((-8 - y) / 30, 0, 0.6));
    return c;
  }

  private buildBarriers(): void {
    const m = this.samples.length;
    const rails = new FacetBuilder();
    for (const side of [-1, 1]) {
      const painted: BandRow[] = [];
      const steel: BandRow[] = [];
      for (let i = 0; i < m; i++) {
        const smp = this.samples[i];
        const x = smp.x + smp.nx * BARRIER_HALF * side;
        const z = smp.z + smp.nz * BARRIER_HALF * side;
        const y = this.heightFromSample(smp.y, BARRIER_HALF);
        const color = Track.hash(Math.floor(i / 22)) < 0.5 ? PALETTE.barrierRed : PALETTE.barrierWhite;
        painted.push({
          points: [
            { p: { x, y: y + 0.4, z }, color },
            { p: { x, y: y + 0.58, z }, color },
          ],
        });
        steel.push({
          points: [
            { p: { x, y: y + 0.72, z }, color: PALETTE.barrierSteel },
            { p: { x, y: y + 0.88, z }, color: PALETTE.barrierSteel.scale(1.1) },
          ],
        });
      }
      addBand(rails, painted, true);
      addBand(rails, steel, true);
    }
    this.register(
      rails.toMesh(this.scene, "barrier"),
      this.material("barrier", { twoSided: true, specular: 2.4 }),
    );

    // poteaux tous les 10 m
    const post = new FacetBuilder()
      .prism({ radius: 0.12, height: 0.95, segments: 5, topRadius: 0.09 }, PALETTE.barrierPost)
      .toMesh(this.scene, "barrier-post");
    if (!post) return;
    this.hideSource(post);
    const list: PlacementSpec[] = [];
    for (let i = 0; i < m; i += 5) {
      const smp = this.samples[i];
      for (const side of [-1, 1]) {
        const lat = BARRIER_HALF * side;
        list.push({
          position: new Vector3(
            smp.x + smp.nx * lat,
            this.heightFromSample(smp.y, BARRIER_HALF) - 0.05,
            smp.z + smp.nz * lat,
          ),
        });
      }
    }
    this.addInstances(post, list);
  }

  private readonly sources: Mesh[] = [];

  private hideSource(mesh: Mesh): void {
    mesh.isVisible = false;
    mesh.parent = this.root;
    mesh.alwaysSelectAsActiveMesh = false;
    this.sources.push(mesh);
  }

  private addInstances(source: Mesh, list: readonly PlacementSpec[]): void {
    for (let i = 0; i < list.length; i++) {
      const spec = list[i];
      const inst = source.createInstance(`${source.name}-${i}`);
      inst.parent = this.root;
      inst.position.copyFrom(spec.position);
      if (spec.rotationY !== undefined) inst.rotation.set(0, spec.rotationY, 0);
      if (spec.scale !== undefined) inst.scaling.setAll(spec.scale);
      else if (spec.scaleXYZ) inst.scaling.set(spec.scaleXYZ.x, spec.scaleXYZ.y, inst.scaling.z);
      this.instances.push(inst);
    }
  }

  private labelMaterial(text: string, accent: Color3): StandardMaterial {
    const texture = new DynamicTexture(`label-${text}`, { width: 512, height: 128 }, this.scene, false);
    const ctx = texture.getContext() as unknown as CanvasRenderingContext2D;
    ctx.clearRect(0, 0, 512, 128);
    ctx.fillStyle = "#182231";
    ctx.fillRect(0, 0, 512, 128);
    ctx.fillStyle = accent.toHexString();
    ctx.fillRect(0, 0, 512, 10);
    ctx.fillRect(0, 118, 512, 10);
    ctx.font = "bold 62px 'Segoe UI', system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#fdf6e6";
    ctx.fillText(text, 256, 70);
    texture.update();
    const mat = new StandardMaterial(`label-${text}`, this.scene);
    mat.emissiveTexture = texture;
    mat.diffuseTexture = texture;
    mat.disableLighting = true;
    mat.backFaceCulling = false;
    this.materials.set(`label-tex-${text}`, mat);
    return mat;
  }

  private buildStartAndFinish(): void {
    const m = this.samples.length;
    const checker = new FacetBuilder();
    const columns = 12;
    for (let i = 0; i < 3; i++) {
      const smp = this.samples[i];
      const next = this.samples[(i + 1) % m];
      for (let c = 0; c < columns; c++) {
        const latA = -ROAD_HALF + (c / columns) * ROAD_HALF * 2;
        const latB = -ROAD_HALF + ((c + 1) / columns) * ROAD_HALF * 2;
        const color = (c + i) % 2 === 0 ? PALETTE.paintWhite : PALETTE.asphaltDark;
        checker.quad(
          { x: smp.x + smp.nx * latA, y: smp.y + 0.028, z: smp.z + smp.nz * latA },
          { x: smp.x + smp.nx * latB, y: smp.y + 0.028, z: smp.z + smp.nz * latB },
          { x: next.x + next.nx * latB, y: next.y + 0.028, z: next.z + next.nz * latB },
          { x: next.x + next.nx * latA, y: next.y + 0.028, z: next.z + next.nz * latA },
          color,
        );
      }
    }
    this.register(checker.toMesh(this.scene, "start-line"), this.material("start-line", { unlit: true }));

    // portique d'arrivée, juste avant la ligne
    const smp = this.samples[m - 4];
    const heading = Math.atan2(smp.tz, smp.tx);
    const gantry = new FacetBuilder();
    const baseY = smp.y;
    for (const side of [-1, 1]) {
      const lat = 12.4 * side;
      gantry
        .place({
          position: { x: smp.x + smp.nx * lat, y: baseY - 0.2, z: smp.z + smp.nz * lat },
        })
        .prism({ radius: 0.7, height: 14.1, segments: 6, topRadius: 0.5 }, PALETTE.barrierPost);
    }
    const mid = { x: smp.x, y: baseY + 14.4, z: smp.z };
    gantry.place({ position: mid, rotationY: -(heading + Math.PI / 2) }).box({ w: 26, h: 1.1, d: 0.9 }, PALETTE.barrierSteel);
    const signNx = Math.cos(heading);
    const signNz = Math.sin(heading);
    gantry
      .place({ position: { x: mid.x + signNx * 0.4, y: mid.y, z: mid.z + signNz * 0.4 }, rotationY: -(heading + Math.PI / 2) })
      .box({ w: 13, h: 1.9, d: 0.35 }, PALETTE.paintWhite);
    gantry.place(null);
    const beam = gantry.toMesh(this.scene, "finish-gantry");
    this.register(beam, this.material("gantry", { specular: 2 }));

    const panel = MeshBuilder.CreatePlane("finish-sign", { width: 12.6, height: 1.75 }, this.scene);
    panel.material = this.labelMaterial("ARRIVÉE", PALETTE.paintYellow);
    panel.parent = this.root;
    panel.position.set(mid.x + signNx * 0.6, mid.y, mid.z + signNz * 0.6);
    panel.rotation.y = Math.PI / 2 - heading;
    panel.freezeWorldMatrix();
    this.created.push(panel);
  }

  // --------------------------------------------------------------- portiques de contrôle

  private readonly gates: Mesh[] = [];
  private readonly gateMaterials: StandardMaterial[] = [];

  private buildCheckpointArch(): void {
    for (let c = 0; c < this.checkpoints.length; c++) {
      const cp = this.checkpoints[c];
      const smp = this.samples[this.indexAtS(cp.s)];
      const heading = Math.atan2(smp.tz, smp.tx);
      const major = c % 4 === 0;
      const fb = new FacetBuilder();
      const pylonColor = major ? PALETTE.barrierPost : PALETTE.barrierSteel.scale(0.8);
      const beaconColor = major ? PALETTE.paintYellow : PALETTE.paintWhite;
      const height = major ? 7.8 : 4.2;
      for (const side of [-1, 1]) {
        const lat = (major ? 11.6 : 10.6) * side;
        const base = {
          x: smp.x + smp.nx * lat,
          y: this.heightFromSample(smp.y, 11.6) - 0.15,
          z: smp.z + smp.nz * lat,
        };
        fb.place({ position: base }).prism(
          { radius: major ? 0.6 : 0.32, height, segments: 6, topRadius: major ? 0.4 : 0.22 },
          pylonColor,
        );
        fb.place({
          position: { x: base.x, y: base.y + height - 0.9, z: base.z },
          rotationY: -(heading + Math.PI / 2),
        }).box({ w: major ? 2.2 : 1.1, h: 1.5, d: major ? 0.5 : 0.3 }, beaconColor);
      }
      if (major) {
        fb.place({ position: { x: smp.x, y: smp.y + height + 0.35, z: smp.z }, rotationY: -(heading + Math.PI / 2) }).box(
          { w: 24, h: 0.8, d: 0.7 },
          PALETTE.barrierSteel,
        );
      }
      fb.place(null);
      const mesh = fb.toMesh(this.scene, `gate-${c}`);
      if (!mesh) continue;
      const mat = new StandardMaterial(`gate-mat-${c}`, this.scene);
      mat.diffuseColor = Color3.White();
      mat.specularColor = new Color3(0.05, 0.05, 0.05);
      mat.emissiveColor = new Color3(0.18, 0.13, 0.05);
      mesh.material = mat;
      mesh.parent = this.root;
      mesh.freezeWorldMatrix();
      this.created.push(mesh);
      this.gates.push(mesh);
      this.gateMaterials.push(mat);
    }
  }

  /**
   * Allume le portique correspondant à l'état de progression :
   * `next` = prochain contrôle (très visible), `pending` = à venir,
   * `passed` = déjà franchi.
   */
  setGateState(index: number, state: "next" | "pending" | "passed"): void {
    const mat = this.gateMaterials[index];
    if (!mat) return;
    if (state === "next") mat.emissiveColor.set(0.85, 0.55, 0.12);
    else if (state === "passed") mat.emissiveColor.set(0.05, 0.22, 0.2);
    else mat.emissiveColor.set(0.16, 0.12, 0.05);
  }

  /** Éteint tous les portiques (hors course). */
  clearGateStates(): void {
    for (let i = 0; i < this.gateMaterials.length; i++) this.setGateState(i, "pending");
  }

  // ---------------------------------------------------------------------- végétation

  private makeFir(): Mesh | null {
    return new FacetBuilder()
      .prism({ radius: 0.34, height: 2.4, segments: 5, topRadius: 0.24 }, PALETTE.trunk)
      .place({ position: { x: 0, y: 1.7, z: 0 } })
      .cone({ radius: 2.8, height: 5.6, segments: 7 }, PALETTE.leafA, PALETTE.leafC)
      .place({ position: { x: 0, y: 4.4, z: 0 } })
      .cone({ radius: 1.9, height: 4.2, segments: 7 }, PALETTE.leafB, PALETTE.leafA)
      .place(null)
      .toMesh(this.scene, "fir");
  }

  private makeBroadleaf(): Mesh | null {
    return new FacetBuilder()
      .prism({ radius: 0.42, height: 3.1, segments: 5, topRadius: 0.3 }, PALETTE.trunk)
      .place({ position: { x: 0, y: 2.6, z: 0 } })
      .cone({ radius: 3.1, height: 2.6, segments: 8 }, PALETTE.leafB, PALETTE.leafC)
      .place({ position: { x: 0, y: 4.1, z: 0 } })
      .cone({ radius: 2.2, height: 2.4, segments: 7 }, PALETTE.leafA, PALETTE.leafB)
      .place(null)
      .toMesh(this.scene, "broadleaf");
  }

  private makeBush(): Mesh | null {
    return new FacetBuilder()
      .cone({ radius: 1.7, height: 1.5, segments: 6 }, PALETTE.leafC, PALETTE.grassDeep)
      .place({ position: { x: 0.7, y: 0, z: 0.4 } })
      .cone({ radius: 1.1, height: 1.1, segments: 5 }, PALETTE.leafB, PALETTE.leafC)
      .place(null)
      .toMesh(this.scene, "bush");
  }

  private makeRock(): Mesh | null {
    return new FacetBuilder()
      .prism({ radius: 1.5, height: 1.2, segments: 6, topRadius: 0.85 }, PALETTE.rock)
      .place(null)
      .toMesh(this.scene, "rock");
  }

  private makeHouse(): Mesh | null {
    return new FacetBuilder()
      .box({ w: 7.5, h: 4.2, d: 8 }, PALETTE.shoulder)
      .place({ position: { x: 0, y: 2.1, z: 0 } })
      .pyramid(10.6, 2.6, PALETTE.curbRed)
      .place(null)
      .toMesh(this.scene, "house");
  }

  private buildProps(): void {
    const rnd = createRandom(20260426);
    const fir = this.makeFir();
    const broadleaf = this.makeBroadleaf();
    const bush = this.makeBush();
    const rock = this.makeRock();
    const house = this.makeHouse();
    for (const source of [fir, broadleaf, bush, rock, house]) if (source) this.hideSource(source);

    const firSpots: PlacementSpec[] = [];
    const broadSpots: PlacementSpec[] = [];
    const bushSpots: PlacementSpec[] = [];
    const rockSpots: PlacementSpec[] = [];
    const houseSpots: PlacementSpec[] = [];

    const push = (list: PlacementSpec[], x: number, z: number, scale: number, yaw: number): void => {
      list.push({ position: new Vector3(x, this.terrainHeight(x, z) - 0.15, z), rotationY: yaw, scale });
    };

    // corridor végétal le long du circuit
    for (let i = 0; i < 460; i++) {
      const s = rnd() * this.totalLength;
      const side = rnd() < 0.5 ? -1 : 1;
      const lat = (17 + rnd() * 95) * side;
      const p = this.positionAt(s, lat);
      const yaw = rnd() * Math.PI * 2;
      const roll = rnd();
      if (roll < 0.42) push(firSpots, p.x, p.z, 0.75 + rnd() * 0.75, yaw);
      else if (roll < 0.74) push(broadSpots, p.x, p.z, 0.7 + rnd() * 0.8, yaw);
      else push(bushSpots, p.x, p.z, 0.7 + rnd() * 0.9, yaw);
    }

    // peuplement diffus sur la plaine
    for (let i = 0; i < 520; i++) {
      const x = (rnd() * 2 - 1) * 590;
      const z = (rnd() * 2 - 1) * 590;
      if (Math.abs(this.distanceToTrack(x, z).lateral) < 34) continue;
      const yaw = rnd() * Math.PI * 2;
      const roll = rnd();
      if (roll < 0.34) push(firSpots, x, z, 0.7 + rnd() * 0.9, yaw);
      else if (roll < 0.66) push(broadSpots, x, z, 0.7 + rnd() * 0.9, yaw);
      else if (roll < 0.9) push(bushSpots, x, z, 0.6 + rnd(), yaw);
      else push(rockSpots, x, z, 0.6 + rnd() * 1.4, yaw);
    }

    // hameau près de la ligne des stands
    for (let i = 0; i < 7; i++) {
      const s = 40 + i * 26;
      const side = i % 2 === 0 ? 1 : -1;
      const p = this.positionAt(s, (34 + rnd() * 22) * side);
      houseSpots.push({
        position: new Vector3(p.x, this.terrainHeight(p.x, p.z) - 0.2, p.z),
        rotationY: Math.PI / 2 - this.headingAt(s) + (rnd() - 0.5) * 0.6,
        scale: 0.85 + rnd() * 0.5,
      });
    }

    if (fir) this.addInstances(fir, firSpots);
    if (broadleaf) this.addInstances(broadleaf, broadSpots);
    if (bush) this.addInstances(bush, bushSpots);
    if (rock) this.addInstances(rock, rockSpots);
    if (house) this.addInstances(house, houseSpots);
  }

  // ---------------------------------------------------------------- nids de poule

  private potholes: Pothole[] = [];
  private potholeDecal: Mesh | null = null;
  private coneSource: Mesh | null = null;
  private coneSourceTall: Mesh | null = null;
  private readonly cones: ConeMarker[] = [];
  private holeLevel = -1;

  /** Densité de nids de poule (0 = aucun … 10 = beaucoup) : régénère tout. */
  setPotholeLevel(level: number): void {
    const want = clamp(Math.round(level), 0, 10);
    if (want === this.holeLevel) return;
    this.holeLevel = want;
    this.clearPotholeVisuals();
    this.potholes = this.generatePotholes();
    this.buildPotholeDecals();
    this.buildConeMarkers();
  }

  /**
   * Effet local d'un nid sous une position : `sink` = enfoncement du sol (m),
   * `rough` = 0 hors d'un nid, 1 au fond (sert au tremblement et à l'accroche),
   * `size` = 1 petit, 2 moyen, 3 gros (0 hors d'un nid).
   */
  potholeAt(x: number, z: number): { sink: number; rough: number; size: number } {
    let sink = 0;
    let rough = 0;
    let size = 0;
    for (const h of this.potholes) {
      const d2 = (h.x - x) ** 2 + (h.z - z) ** 2;
      if (d2 >= h.radius * h.radius) continue;
      const t = 1 - d2 / (h.radius * h.radius);
      const s = h.depth * t * Math.sqrt(t);
      if (s > sink) sink = s;
      if (t > rough) {
        rough = t;
        size = h.cones;
      }
    }
    return { sink, rough, size };
  }

  /** Le nombre de cônes posés près d'un nid (1 petit, 2 moyen, 3 gros). */
  get coneCount(): number {
    return this.cones.length;
  }

  /**
   * Renverse les cônes debout touchés par un cercle (collision joueur).
   * Vrai si au moins un cône a été renversé.
   */
  knockCones(x: number, z: number, radius: number): boolean {
    let hit = false;
    for (const c of this.cones) {
      if (c.down) continue;
      if ((c.x - x) ** 2 + (c.z - z) ** 2 > radius * radius) continue;
      c.down = true;
      c.inst.rotation.set(0, c.yaw, Math.PI * 0.47);
      c.inst.position.y += 0.085;
      hit = true;
    }
    return hit;
  }

  private clearPotholeVisuals(): void {
    for (const c of this.cones) c.inst.dispose();
    this.cones.length = 0;
    if (this.coneSource) this.coneSource.dispose(false, false);
    this.coneSource = null;
    if (this.coneSourceTall) this.coneSourceTall.dispose(false, false);
    this.coneSourceTall = null;
    if (this.potholeDecal) this.potholeDecal.dispose(false, false);
    this.potholeDecal = null;
  }

  /** Nids par niveau : petits nombreux, moyens, gros rares ; hors zone de départ. */
  private generatePotholes(): Pothole[] {
    const rnd = createRandom(0x51ee7);
    const list: Pothole[] = [];
    const sizes: { count: number; radius: [number, number]; depth: number; cones: number }[] = [
      { count: this.holeLevel * 2, radius: [0.7, 1.05], depth: 0.05, cones: 1 },
      { count: Math.round(this.holeLevel * 1.4), radius: [1.25, 1.7], depth: 0.09, cones: 2 },
      { count: this.holeLevel, radius: [2.1, 2.7], depth: 0.14, cones: 3 },
    ];
    const usable = this.totalLength - 120;
    for (const size of sizes) {
      for (let i = 0; i < size.count; i++) {
        for (let attempt = 0; attempt < 80; attempt++) {
          const radius = lerp(size.radius[0], size.radius[1], rnd());
          const s = 60 + rnd() * usable;
          const lateral = (rnd() * 2 - 1) * (ROAD_HALF - radius - 0.8);
          const p = this.positionAt(s, lateral);
          const far = list.every((h) => (h.x - p.x) ** 2 + (h.z - p.z) ** 2 > 484);
          if (far) {
            list.push({ s, lateral, x: p.x, z: p.z, radius, depth: size.depth, cones: size.cones });
            break;
          }
        }
      }
    }
    return list;
  }

  /**
   * Le trou est peint en trois anneaux d'asphalte de plus en plus sombres vers
   * le centre : la chaussée reste une surface plane, l'enfoncement physique est
   * donné par `potholeAt`. Léger relief de teinte + périmètre irrégulier pour
   * casser l'aspect « disque parfait ».
   */
  private buildPotholeDecals(): void {
    if (this.potholes.length === 0) return;
    const fb = new FacetBuilder();
    const SEGMENTS = 11;
    const rings = [
      { f: 1.0, tint: 0.66, y: 0.031 },
      { f: 0.7, tint: 0.42, y: 0.033 },
      { f: 0.42, tint: 0.24, y: 0.035 },
    ];
    this.potholes.forEach((h, hi) => {
      const roadY = this.samples[this.indexAtS(h.s)].y;
      const jitter: number[] = [];
      for (let k = 0; k < SEGMENTS; k++) jitter.push(0.82 + 0.34 * Track.hash(hi * 17 + k));
      const ringVerts = rings.map((ring) =>
        jitter.map((j, k) => {
          const a = (k / SEGMENTS) * Math.PI * 2 + hi;
          const r = h.radius * j * ring.f;
          return { x: h.x + Math.cos(a) * r, y: roadY + ring.y, z: h.z + Math.sin(a) * r };
        }),
      );
      for (let i = 0; i < rings.length - 1; i++) {
        const outer = ringVerts[i];
        const inner = ringVerts[i + 1];
        const color = PALETTE.asphaltDark.scale(rings[i].tint);
        for (let k = 0; k < SEGMENTS; k++) {
          const k2 = (k + 1) % SEGMENTS;
          fb.quad(outer[k], outer[k2], inner[k2], inner[k], color);
        }
      }
      const last = rings.length - 1;
      const floorColor = PALETTE.asphaltDark.scale(rings[last].tint);
      const center = { x: h.x, y: roadY + rings[last].y, z: h.z };
      for (let k = 0; k < SEGMENTS; k++) fb.tri(center, ringVerts[last][k], ringVerts[last][(k + 1) % SEGMENTS], floorColor);
    });
    const mesh = fb.toMesh(this.scene, "potholes");
    if (!mesh) return;
    mesh.material = this.material("potholes", { unlit: true, twoSided: true });
    mesh.parent = this.root;
    mesh.freezeWorldMatrix();
    this.potholeDecal = mesh;
  }

  /** Cône low-poly orange à bandes blanches, posé au bord de chaque nid. */
  private buildConeMarkers(): void {
    if (this.potholes.length === 0) return;
    const rnd = createRandom(0x9e3779b);
    const makeCone = (name: string, base: number, body: number, height: number, tip: number, band1: number, band2: number): Mesh | null =>
      new FacetBuilder()
        .prism({ radius: base, height: base * 0.22, segments: 8 }, PALETTE.coneOrange.scale(0.72))
        .place({ position: { x: 0, y: base * 0.22, z: 0 } })
        .prism({ radius: body, height, segments: 8, topRadius: tip }, PALETTE.coneOrange)
        .place({ position: { x: 0, y: base * 0.22 + band1, z: 0 } })
        .prism({ radius: body - (body - tip) * (band1 / height) + 0.004, height: height * 0.16, segments: 8, topRadius: body - (body - tip) * ((band1 + height * 0.16) / height) + 0.004 }, PALETTE.paintWhite)
        .place({ position: { x: 0, y: base * 0.22 + band2, z: 0 } })
        .prism({ radius: body - (body - tip) * (band2 / height) + 0.004, height: height * 0.13, segments: 8, topRadius: body - (body - tip) * ((band2 + height * 0.13) / height) + 0.004 }, PALETTE.paintWhite)
        .place(null)
        .toMesh(this.scene, name);

    // Cône standard (~0,65 m) pour les petits nids ; grand cône (~1,25 m) de
    // chantier pour les nids moyens et gros, bien visible de loin.
    const source = makeCone("traffic-cone", 0.2, 0.15, 0.6, 0.028, 0.235, 0.4);
    if (!source) return;
    source.material = this.material("cone", { specular: 1.4 });
    source.isVisible = false;
    source.parent = this.root;
    this.coneSource = source;
    const tall = makeCone("traffic-cone-tall", 0.34, 0.26, 1.12, 0.05, 0.42, 0.72);
    if (!tall) return;
    tall.material = source.material;
    tall.isVisible = false;
    tall.parent = this.root;
    this.coneSourceTall = tall;

    this.potholes.forEach((h, hi) => {
      const markerSource = h.cones === 1 ? source : tall;
      const base = Track.hash(hi * 29 + 4) * Math.PI * 2;
      for (let k = 0; k < h.cones; k++) {
        let a = base + (k / h.cones) * Math.PI * 2;
        let x = h.x + Math.cos(a) * (h.radius + 0.55);
        let z = h.z + Math.sin(a) * (h.radius + 0.55);
        if (Math.abs(this.distanceToTrack(x, z).lateral) > ROAD_HALF - 0.35) {
          a += Math.PI;
          x = h.x + Math.cos(a) * (h.radius + 0.55);
          z = h.z + Math.sin(a) * (h.radius + 0.55);
        }
        const inst = markerSource.createInstance(`cone-${hi}-${k}`);
        inst.parent = this.root;
        const yaw = rnd() * Math.PI * 2;
        inst.position.set(x, this.terrainHeight(x, z) + 0.004, z);
        inst.rotation.y = yaw;
        this.cones.push({ inst, x, z, yaw, down: false });
      }
    });
  }

  // ------------------------------------------------------------------------ montagnes

  private buildMountains(): void {
    const fb = new FacetBuilder();
    const SEGMENTS = 72;
    const ridge = (a: number): number =>
      Math.max(
        48,
        128 +
          58 * Math.sin(a * 3 + 1.1) +
          34 * Math.sin(a * 7 + 0.3) +
          19 * Math.sin(a * 13 + 2.7) +
          9 * Math.cos(a * 23 + 0.8),
      );
    const colorAt = (h: number, a: number): Color3 => {
      let c = Color3.Lerp(PALETTE.mountainBase, PALETTE.rock, 0.4);
      c = Color3.Lerp(c, PALETTE.mountainTop, clamp((h - 120) / 110, 0, 1));
      if (h > 172) c = Color3.Lerp(c, PALETTE.snow, clamp((h - 172) / 55, 0, 0.95));
      return c.scale(0.9 + 0.18 * Math.max(0, Math.cos(a - 1.2)));
    };
    const inner = 1180;
    const outer = 1720;
    const base = -26;
    for (let i = 0; i < SEGMENTS; i++) {
      const a0 = (i / SEGMENTS) * Math.PI * 2;
      const a1 = ((i + 1) / SEGMENTS) * Math.PI * 2;
      const h0 = ridge(a0);
      const h1 = ridge(a1);
      fb.quad(
        { x: Math.cos(a0) * inner, y: h0, z: Math.sin(a0) * inner },
        { x: Math.cos(a1) * inner, y: h1, z: Math.sin(a1) * inner },
        { x: Math.cos(a1) * outer, y: base, z: Math.sin(a1) * outer },
        { x: Math.cos(a0) * outer, y: base, z: Math.sin(a0) * outer },
        Color3.Lerp(colorAt(h0, a0), colorAt(h1, a1), 0.5),
      );
    }
    const mesh = fb.toMesh(this.scene, "mountains");
    if (!mesh) return;
    const mat = this.material("mountains");
    mat.fogEnabled = false; // la chaîne reste lisible à l'horizon
    this.register(mesh, mat);
  }

  dispose(): void {
    this.clearPotholeVisuals();
    for (const inst of this.instances) inst.dispose();
    this.instances.length = 0;
    for (const mesh of this.created) mesh.dispose(false, false);
    this.created.length = 0;
    for (const source of this.sources) source.dispose(false, false);
    this.sources.length = 0;
    for (const mat of this.materials.values()) mat.dispose();
    this.materials.clear();
    this.root.dispose();
  }
}

/** Emplacement d'une instance de décor. */
interface PlacementSpec {
  position: Vector3;
  rotationY?: number;
  scale?: number;
  scaleXYZ?: { x: number; y: number };
}

/** Nid de poule sur le revêtement, repéré par son centre et son rayon. */
interface Pothole {
  s: number;
  lateral: number;
  x: number;
  z: number;
  radius: number;
  depth: number;
  /** Nombre de cônes de signalisation (1 petit, 2 moyen, 3 gros). */
  cones: number;
}

/** Cône de signalisation posé au bord d'un nid. */
interface ConeMarker {
  inst: InstancedMesh;
  x: number;
  z: number;
  yaw: number;
  down: boolean;
}

/**
 * Circuit fermé « Les Sept Vals » : tracé généré par code (spline Catmull-Rom
 * fermée), revêtu, bordé de barrières, ponctué de portiques de contrôle et
 * planté d'arbres. Toute la géométrie est en couleurs par sommet.
 */

/** Demi-largeur de la chaussée (m). */
export const ROAD_HALF = 9;
/** Au-delà de cette distance à l'axe, on est « hors piste ». */
export const SHOULDER_HALF = 12.2;
/** Position des barrières de sécurité. */
export const BARRIER_HALF = 13.4;
/** Nombre de portiques de contrôle répartis sur le tour. */
export const CHECKPOINT_COUNT = 16;
/** Distance au-delà de laquelle le relief devient libre (collines, montagnes). */
const FREE_RELIEF = 60;

export interface CircuitPoint {
  x: number;
  z: number;
  /** Repère de départ conseillé (ligne droite des stands). */
  start?: boolean;
}

/**
 * Points directeurs du circuit des Crêtes, tracé dans le sens horaire. Le
 * dernier rejoint le premier : tour d'environ 2,7 km avec une longue ligne
 * droite, un S, un large virage relevé et une épingle.
 */
const CRETES_POINTS: CircuitPoint[] = [
  { x: 0, z: 0, start: true },
  { x: 180, z: -6 },
  { x: 320, z: 14 },
  { x: 430, z: 70 },
  { x: 470, z: 170 },
  { x: 420, z: 250 },
  { x: 310, z: 275 },
  { x: 215, z: 235 },
  { x: 165, z: 150 },
  { x: 80, z: 120 },
  { x: -20, z: 165 },
  { x: -120, z: 250 },
  { x: -235, z: 265 },
  { x: -330, z: 200 },
  { x: -350, z: 90 },
  { x: -300, z: -10 },
  { x: -200, z: -60 },
  { x: -95, z: -45 },
];

/** Dénivelé du tracé (m) : léger, pour rester lisible et jouable. */
const CRETES_ELEVATION: number[] = [
  0, 0, 1.4, 3.2, 5.6, 6.8, 6.0, 4.2, 3.0, 4.6, 7.4, 9.0, 8.2, 5.4, 2.6, 0.8, 0.1, 0,
];

/**
 * Interprétation stylisée du circuit Gilles-Villeneuve (île Notre-Dame,
 * Montréal) : tour d'environ 4,35 km dans le sens horaire, trois longues
 * lignes droites, les chicanes (Senna, treize-cent-trente), l'épingle de
 * l'Éperon et le mur des Champions (SAS 11-12-13) avant la ligne des stands.
 * Le tracé est une adaptation jouable, pas une reproduction au GPS près.
 */
const VILLENEUVE_POINTS: CircuitPoint[] = [
  { x: 0, z: 0, start: true },
  { x: 715, z: -9 },
  { x: 863, z: 109 },
  { x: 873, z: 276 },
  { x: 805, z: 437 },
  { x: 845, z: 540 },
  { x: 736, z: 673 },
  { x: 265, z: 750 },
  { x: -207, z: 790 },
  { x: -495, z: 736 },
  { x: -627, z: 598 },
  { x: -581, z: 495 },
  { x: -644, z: 380 },
  { x: -650, z: 219 },
  { x: -541, z: 109 },
  { x: -380, z: 150 },
  { x: -230, z: 145 },
  { x: -95, z: 60 },
];

/** Plateau montréalais : très peu de dénivelé, deux légères bosses de pont. */
const VILLENEUVE_ELEVATION: number[] = [
  0, 0.2, 0.8, 1.8, 1.2, 0.4, 0.2, 0, 0.3, 1.4, 2.6, 1.6, 0.6, 0.2, 0.4, 1.8, 2.2, 1.2,
];

/** Circuits disponibles dans les réglages. */
export const CIRCUITS: Record<CircuitId, CircuitDef> = {
  cretes: { id: "cretes", label: "Circuit des Crêtes", points: CRETES_POINTS, elevation: CRETES_ELEVATION },
  villeeneuve: {
    id: "villeeneuve",
    label: "Gilles-Villeneuve · Montréal",
    points: VILLENEUVE_POINTS,
    elevation: VILLENEUVE_ELEVATION,
  },
};

/** Échantillon régulier de l'axe. */
interface Sample {
  x: number;
  z: number;
  y: number;
  tx: number;
  tz: number;
  nx: number;
  nz: number;
  s: number;
  curvature: number;
}

export interface TrackQuery {
  /** Abscisse curviligne du point le plus proche. */
  s: number;
  /** Distance signée à l'axe (m). */
  lateral: number;
  /** Cap de la piste au point le plus proche. */
  heading: number;
  /** Roue sur le revêtement. */
  onRoad: boolean;
  /** Sur l'accotement ou au-delà. */
  offTrack: boolean;
  /** Sens de marche inverse. */
  wrongWay: boolean;
}

const STEP = 2.0; // résolution d'échantillonnage de l'axe (m)
const CURVE_SUBDIVISIONS = 26; // subdivisions par segment de la spline

/** Spline Catmull-Rom fermée. */
function catmullRom(p0: CircuitPoint, p1: CircuitPoint, p2: CircuitPoint, p3: CircuitPoint, t: number): { x: number; z: number } {
  const t2 = t * t;
  const t3 = t2 * t;
  const mix = (a: number, b: number, c: number, d: number): number =>
    2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3;
  return {
    x: 0.5 * mix(p0.x, p1.x, p2.x, p3.x),
    z: 0.5 * mix(p0.z, p1.z, p2.z, p3.z),
  };
}
