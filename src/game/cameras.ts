import {
  Camera,
  Color3,
  FreeCamera,
  Mesh,
  MeshBuilder,
  Scene,
  StandardMaterial,
  TransformNode,
  Vector3,
  VertexBuffer,
  Viewport,
} from "@babylonjs/core";
import type { Track } from "./track";
import type { Car } from "./vehicle";
import { clamp, damp, dampAngle } from "./utils";

/** Calque réservé au mini-circuit (jamais vu par la caméra principale). */
export const MAP_LAYER = 0x00000002;
const MAP_SCALE = 0.02;
const MAP_RANGE = 15;

/** Les deux points de vue proposés. */
export type CameraMode = "chase" | "cockpit";

/** Matière plate, insensible aux lumières et au brouillard. */
function mapMaterial(scene: Scene, name: string, color: Color3): StandardMaterial {
  const material = new StandardMaterial(name, scene);
  material.diffuseColor = Color3.Black();
  material.specularColor = Color3.Black();
  material.emissiveColor = color;
  material.disableLighting = true;
  material.fogEnabled = false;
  return material;
}

/** Ruban schématique du circuit pour le mini-circuit. */
function buildMapPath(scene: Scene, track: Track): Mesh {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const steps = Math.max(64, Math.round(track.totalLength / 9));
  const half = 42;
  const a = new Vector3();
  const b = new Vector3();
  for (let i = 0; i <= steps; i++) {
    const s = (i / steps) * track.totalLength;
    track.positionAt(s, 0, a);
    track.positionAt(s + 4, 0, b);
    let dx = b.x - a.x;
    let dz = b.z - a.z;
    const norm = Math.hypot(dx, dz) || 1;
    dx /= norm;
    dz /= norm;
    positions.push(a.x - dz * half, 0, a.z + dx * half, a.x + dz * half, 0, a.z - dx * half);
    normals.push(0, 1, 0, 0, 1, 0);
    if (i < steps) {
      const k = i * 2;
      indices.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
    }
  }
  const mesh = new Mesh("map-path", scene);
  mesh.setVerticesData(VertexBuffer.PositionKind, positions);
  mesh.setVerticesData(VertexBuffer.NormalKind, normals);
  mesh.setIndices(indices);
  mesh.material = mapMaterial(scene, "map-path-mat", new Color3(0.72, 0.76, 0.84));
  mesh.layerMask = MAP_LAYER;
  mesh.doNotSyncBoundingInfo = true;
  return mesh;
}

/** Pastilles des portiques et de la ligne de départ sur le mini-circuit. */
function buildMapMarkers(scene: Scene, track: Track, parent: TransformNode): Mesh {
  const source = MeshBuilder.CreateCylinder(
    "map-gate",
    { diameter: 96, height: 6, tessellation: 12 },
    scene,
  );
  source.material = mapMaterial(scene, "map-gate-mat", new Color3(0.25, 0.72, 0.85));
  source.layerMask = MAP_LAYER;
  source.parent = parent;
  source.position.set(track.checkpoints[1]?.position.x ?? 0, 60, track.checkpoints[1]?.position.z ?? 0);
  track.checkpoints.forEach((cp, index) => {
    if (index === 1) return;
    const instance = source.createInstance(`map-gate-${index}`);
    instance.position.set(cp.position.x, 60, cp.position.z);
    instance.layerMask = MAP_LAYER;
    instance.parent = parent;
  });
  const finish = MeshBuilder.CreateCylinder("map-finish", { diameter: 150, height: 4, tessellation: 16 }, scene);
  finish.material = mapMaterial(scene, "map-finish-mat", new Color3(0.98, 0.8, 0.2));
  finish.layerMask = MAP_LAYER;
  finish.parent = parent;
  const start = track.checkpoints[0]?.position ?? track.startPos;
  finish.position.set(start.x, 40, start.z);
  return finish;
}

/**
 * Caméras du prototype : poursuite (avec inertie, FOV progressif et tremblements)
 * et cockpit. Un mini-circuit orthographique est rendu dans un coin de l'image.
 */
export class CameraRig {
  readonly chase: FreeCamera;
  readonly cockpit: FreeCamera;
  readonly mini: FreeCamera;
  mode: CameraMode = "chase";

  /** 0,4 = caméra très souple, 2 = caméra collée à la voiture. */
  firmness = 1;

  private readonly canvas: HTMLCanvasElement;
  private readonly mapRoot: TransformNode;
  private readonly mapPath: Mesh;
  private readonly mapMarkers: Mesh;
  private readonly mapCar: Mesh;
  private readonly eye = new Vector3();
  private readonly focus = new Vector3();
  private readonly forward = new Vector3();
  private focusYaw = 0;
  private shake = 0;

  constructor(scene: Scene, canvas: HTMLCanvasElement, track: Track) {
    this.canvas = canvas;
    this.chase = new FreeCamera("chase", new Vector3(0, 4, -8), scene);
    this.chase.minZ = 0.25;
    this.chase.maxZ = 2400;
    this.chase.fov = 0.85;
    this.chase.inertia = 0;
    this.chase.layerMask = 0x00000001;

    this.cockpit = new FreeCamera("cockpit", new Vector3(0, 1.1, 0), scene);
    this.cockpit.minZ = 0.08;
    this.cockpit.maxZ = 2400;
    this.cockpit.fov = 0.98;
    this.cockpit.inertia = 0;
    this.cockpit.layerMask = 0x00000001;

    this.mapRoot = new TransformNode("map-root", scene);
    this.mapRoot.scaling.setAll(MAP_SCALE);
    this.mapPath = buildMapPath(scene, track);
    this.mapPath.parent = this.mapRoot;
    this.mapMarkers = buildMapMarkers(scene, track, this.mapRoot);

    this.mapCar = MeshBuilder.CreateCylinder("map-car", { diameter: 84, height: 12, tessellation: 3 }, scene);
    this.mapCar.material = mapMaterial(scene, "map-car-mat", new Color3(1, 0.3, 0.12));
    this.mapCar.layerMask = MAP_LAYER;
    this.mapCar.parent = this.mapRoot;

    this.mini = new FreeCamera("mini", new Vector3(0, 240, 0), scene);
    this.mini.mode = Camera.ORTHOGRAPHIC_CAMERA;
    this.mini.orthoLeft = -MAP_RANGE;
    this.mini.orthoRight = MAP_RANGE;
    this.mini.orthoTop = MAP_RANGE;
    this.mini.orthoBottom = -MAP_RANGE;
    this.mini.minZ = 1;
    this.mini.maxZ = 900;
    this.mini.layerMask = MAP_LAYER;
    this.mini.rotation.set(Math.PI / 2, 0, 0);
    this.resize();
  }

  /** Caméra en service. */
  get active(): FreeCamera {
    return this.mode === "chase" ? this.chase : this.cockpit;
  }

  /** Bascule poursuite / cockpit et renvoie le nouveau mode. */
  toggle(): CameraMode {
    this.mode = this.mode === "chase" ? "cockpit" : "chase";
    return this.mode;
  }

  /** Recale immédiatement la caméra sur la voiture (remise sur la grille). */
  reset(car: Car): void {
    car.forward(this.forward);
    const position = car.position;
    this.focus.set(position.x, position.y + 1.05, position.z);
    this.focusYaw = car.heading;
    this.shake = 0;
    this.chase.position.set(
      position.x - Math.cos(car.heading) * 6.6,
      position.y + 2.5,
      position.z - Math.sin(car.heading) * 6.6,
    );
    this.chase.rotation.set(0.16, Math.atan2(Math.cos(car.heading), Math.sin(car.heading)), 0);
    this.chase.fov = 0.8;
    this.cockpit.position.set(position.x + this.forward.x * 0.2, position.y + 1.3, position.z + this.forward.z * 0.2);
    this.cockpit.rotation.set(0, Math.atan2(Math.cos(car.heading), Math.sin(car.heading)), 0);
  }

  /** Branche les caméras actives sur la scène (à appeler après un changement). */
  applyTo(scene: Scene, mapVisible: boolean): void {
    scene.activeCamera = this.active;
    scene.activeCameras = mapVisible ? [this.active, this.mini] : [this.active];
  }

  /** Place le mini-circuit dans un coin, carré quelle que soit la fenêtre. */
  resize(): void {
    const width = this.canvas.width || 1;
    const height = this.canvas.height || 1;
    const side = clamp(208 / Math.max(width, height), 0.08, 0.3);
    this.mini.viewport = new Viewport(0.018, 0.018, side, side * (width / height));
  }

  /** Suit la voiture : à appeler juste après `car.update`. */
  update(car: Car, dt: number, options: { mapVisible: boolean }): void {
    const speed = Math.abs(car.forwardVelocity);
    const ratio = clamp(speed / 62, 0, 1);
    const position = car.renderPos;
    this.forward.set(Math.cos(car.renderHeading), 0, Math.sin(car.renderHeading));
    const slip = car.readout.slip;

    // --- poursuite ----------------------------------------------------------
    const rate = 4.2 + 9 * this.firmness;
    const first = this.focus.x === 0 && this.focus.z === 0;
    this.focus.x = damp(first ? position.x : this.focus.x, position.x + this.forward.x * 3.4, rate, dt);
    this.focus.z = damp(first ? position.z : this.focus.z, position.z + this.forward.z * 3.4, rate, dt);
    this.focus.y = damp(first ? position.y : this.focus.y, position.y + 1.05, rate * 1.4, dt);
    const yawTarget = first ? car.heading : this.focusYaw;
    this.focusYaw = first ? car.heading : dampAngle(yawTarget, car.heading, 2.6 + 5 * this.firmness, dt);

    const distance = 5.5 + ratio * 2.8;
    const height = 2.05 + ratio * 0.75;
    this.shake = damp(this.shake, 0, 7, dt);
    if (car.readout.impact > this.shake) this.shake = car.readout.impact;
    const time = performance.now() * 0.01;
    const tremor = this.shake * 0.42;
    const yawCos = Math.cos(this.focusYaw);
    const yawSin = Math.sin(this.focusYaw);
    this.eye.x = this.focus.x - yawCos * distance + Math.sin(time * 2.7) * tremor;
    this.eye.z = this.focus.z - yawSin * distance + Math.cos(time * 3.3) * tremor;
    this.eye.y = this.focus.y + height + Math.sin(time * 4.1) * tremor * 0.6;

    const dx = this.focus.x - this.eye.x;
    const dz = this.focus.z - this.eye.z;
    const horizontal = Math.hypot(dx, dz) || 0.001;
    this.chase.position.copyFrom(this.eye);
    this.chase.rotation.set(
      Math.atan2(this.eye.y - this.focus.y, horizontal),
      Math.atan2(dx, dz),
      damp(this.chase.rotation.z, -slip * 0.22, 6, dt),
    );
    this.chase.fov = damp(this.chase.fov, 0.76 + ratio * 0.22 + Math.abs(slip) * 0.25, 4, dt);

    // --- cockpit -------------------------------------------------------------
    // Rigueur avec la caisse : le modèle se dessine à la position/cap discrets
    // (pas physique 120 Hz), la caméra doit lire les mêmes valeurs, sinon le capot
    // oscille de quelques millimètres dans l'image à chaque pas → clignotement.
    // Le toit/pare-brise étant masqués en cockpit, la caméra peut monter à 1,3 :
    // le capot occupe moins le bas de l'image et ne traverse plus le plan near.
    const carPos = car.position;
    const cf = this.forward.set(Math.cos(car.heading), 0, Math.sin(car.heading));
    this.cockpit.position.set(carPos.x + cf.x * 0.2, carPos.y + 1.3, carPos.z + cf.z * 0.2);
    const look = 14;
    const cdx = cf.x * look;
    const cdz = cf.z * look;
    this.cockpit.rotation.set(
      Math.atan2(this.cockpit.position.y - (carPos.y + 0.98), Math.hypot(cdx, cdz) || 0.001),
      Math.atan2(cdx, cdz),
      damp(this.cockpit.rotation.z, -slip * 0.3, 7, dt),
    );
    this.cockpit.fov = damp(this.cockpit.fov, 0.94 + ratio * 0.16, 4, dt);

    // --- mini-circuit ---------------------------------------------------------
    this.mapRoot.setEnabled(options.mapVisible);
    if (options.mapVisible) {
      this.mapCar.position.set(position.x, 140, position.z);
      this.mapCar.rotation.y = Math.PI / 2 - car.heading;
      this.mini.position.set(position.x * MAP_SCALE, 240, position.z * MAP_SCALE);
    }
  }

  dispose(): void {
    this.mapCar.dispose();
    this.mapMarkers.dispose();
    this.mapMarkers.material?.dispose();
    this.mapPath.dispose();
    this.mapPath.material?.dispose();
    this.mapCar.material?.dispose();
    this.mapRoot.dispose();
    this.chase.dispose();
    this.cockpit.dispose();
    this.mini.dispose();
  }
}
