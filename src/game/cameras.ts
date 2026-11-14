import { FreeCamera, Scene, Vector3 } from "@babylonjs/core";
import type { Car } from "./vehicle";
import { clamp, damp, dampAngle } from "./utils";

/** Les deux points de vue proposés. */
export type CameraMode = "chase" | "cockpit";

/**
 * Caméras du prototype : poursuite (avec inertie, FOV progressif et tremblements)
 * et cockpit. Le plan du circuit est un canvas DOM (`minimap.ts`), plus une
 * caméra de rendu dédiée.
 */
export class CameraRig {
  readonly chase: FreeCamera;
  readonly cockpit: FreeCamera;
  mode: CameraMode = "chase";

  /** 0,4 = caméra très souple, 2 = caméra collée à la voiture. */
  firmness = 1;

  private readonly eye = new Vector3();
  private readonly focus = new Vector3();
  private readonly forward = new Vector3();
  private focusYaw = 0;
  private anchorY = 0;
  private shake = 0;

  constructor(scene: Scene) {
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
    this.anchorY = position.y;
    this.focusYaw = car.heading;
    this.shake = 0;
    this.chase.position.set(
      position.x - Math.cos(car.heading) * 6.3,
      position.y + 2.1,
      position.z - Math.sin(car.heading) * 6.3,
    );
    this.chase.rotation.set(0.16, Math.atan2(Math.cos(car.heading), Math.sin(car.heading)), 0);
    this.chase.fov = 0.8;
    this.cockpit.position.set(position.x + this.forward.x * 0.2, position.y + 1.3, position.z + this.forward.z * 0.2);
    this.cockpit.rotation.set(0, Math.atan2(Math.cos(car.heading), Math.sin(car.heading)), 0);
  }

  /** Branche la caméra active sur la scène (à appeler après un changement). */
  applyTo(scene: Scene): void {
    scene.activeCamera = this.active;
    scene.activeCameras = [this.active];
  }

  /** Suit la voiture : à appeler juste après `car.update`. */
  update(car: Car, dt: number): void {
    const speed = Math.abs(car.forwardVelocity);
    const ratio = clamp(speed / 62, 0, 1);
    const position = car.renderPos;
    const slip = car.readout.slip;

    // --- poursuite ----------------------------------------------------------
    // La caméra est ancrée géométriquement derrière la caisse (cap lissé) et
    // NON derrière un point d'intérêt amorti : avec un amorti, la distance
    // caméra/caisse valait ~2 m à l'arrêt (la caméra entrait dans la malle,
    // le plan near tronçonnait la caisse → image qui grossit puis clignote)
    // et ~9 m à pleine vitesse. La distance reste ici toujours supérieure à
    // la demi-longueur de la voiture, avec un zoom de vitesse volontaire.
    const first = this.focus.x === 0 && this.focus.z === 0;
    const rate = 4.2 + 9 * this.firmness;
    this.focusYaw = first ? car.heading : dampAngle(this.focusYaw, car.heading, 2.6 + 5 * this.firmness, dt);
    this.forward.set(Math.cos(this.focusYaw), 0, Math.sin(this.focusYaw));
    this.anchorY = first ? position.y : damp(this.anchorY, position.y, rate * 1.4, dt);

    const back = 6.3 + ratio * 1.7;
    const height = 2.1 + ratio * 0.7;
    this.shake = damp(this.shake, 0, 7, dt);
    if (car.readout.impact > this.shake) this.shake = car.readout.impact;
    const time = performance.now() * 0.01;
    const tremor = this.shake * 0.11;
    const yawCos = Math.cos(this.focusYaw);
    const yawSin = Math.sin(this.focusYaw);
    this.eye.x = position.x - yawCos * back + Math.sin(time * 2.7) * tremor;
    this.eye.z = position.z - yawSin * back + Math.cos(time * 3.3) * tremor;
    this.eye.y = this.anchorY + height + Math.sin(time * 4.1) * tremor * 0.6;

    // Point visé 4,2 m devant la caisse ; seul le Y est amorti (bosses du sol)
    // afin que le cadrage ne tressaute pas, sans jamais décaler la distance.
    this.focus.x = position.x + yawCos * 4.2;
    this.focus.z = position.z + yawSin * 4.2;
    this.focus.y = first ? position.y + 1.05 : damp(this.focus.y, position.y + 1.05, rate * 1.4, dt);

    const dx = this.focus.x - this.eye.x;
    const dz = this.focus.z - this.eye.z;
    const horizontal = Math.hypot(dx, dz) || 0.001;
    this.chase.position.copyFrom(this.eye);
    this.chase.rotation.set(
      Math.atan2(this.eye.y - this.focus.y, horizontal),
      Math.atan2(dx, dz),
      damp(this.chase.rotation.z, -slip * 0.22, 6, dt),
    );
    this.chase.fov = damp(this.chase.fov, 0.82 + ratio * 0.16 + Math.abs(slip) * 0.22, 4, dt);

    // --- cockpit -------------------------------------------------------------
    // La caisse étant dessinée à la position/cap interpolés (blendRender),
    // la caméra cockpit lit les mêmes valeurs : sinon l'habitacle oscille
    // d'un demi-pas physique devant la caméra à chaque image. Le toit et le
    // pare-brise étant masqués en cockpit, la caméra peut monter à 1,3 sans
    // que le capot traverse le plan near.
    const carPos = car.renderPos;
    const cf = this.forward.set(Math.cos(car.renderHeading), 0, Math.sin(car.renderHeading));
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
  }

  dispose(): void {
    this.chase.dispose();
    this.cockpit.dispose();
  }
}
