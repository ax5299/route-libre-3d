import { PadProfiles, readBinding } from "./pad-profile";
import type { VehicleInput } from "./vehicle";
import { clamp } from "./utils";

/** Disposition détectée à partir du nom du périphérique. */
export type PadLayout = "xbox" | "playstation" | "generic";

/** Entrées d'une image : conduite + actions « un coup ». */
export interface InputFrame extends VehicleInput {
  /** Vrai une seule image, juste après l'appui. */
  resetCar: boolean;
  switchCamera: boolean;
  pause: boolean;
  confirm: boolean;
  back: boolean;
  menuUp: boolean;
  menuDown: boolean;
  menuLeft: boolean;
  menuRight: boolean;
  padConnected: boolean;
  /** Manette détectée mais pas encore validée par un appui. */
  padPending: boolean;
  padLayout: PadLayout;
  /** La manette vient de être débranchée (une image). */
  padLost: boolean;
  /** Le joueur vient d'appuyer sur le clavier (une image). */
  keyTap: boolean;
  /** Valeurs brutes pour le mode diagnostic. */
  rawAxisX: number;
  rawAxisY: number;
  rawTriggerLeft: number;
  rawTriggerRight: number;
  rawButtons: string;
}

interface KeyMap {
  accelerate: string[];
  brake: string[];
  left: string[];
  right: string[];
  handbrake: string[];
  camera: string[];
  reset: string[];
  pause: string[];
  confirm: string[];
  back: string[];
}

const KEYS: KeyMap = {
  accelerate: ["ArrowUp", "KeyW"],
  brake: ["ArrowDown", "KeyS"],
  left: ["ArrowLeft", "KeyA"],
  right: ["ArrowRight", "KeyD"],
  handbrake: ["Space", "ShiftLeft"],
  camera: ["KeyC"],
  reset: ["KeyR"],
  pause: ["Escape"],
  confirm: ["Enter", "NumpadEnter"],
  back: ["Backspace"],
};

/** Codes à ne pas laisser remonter à la page (défilement, boutons natifs). */
const SWALLOWED = new Set([
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Space",
  "Enter",
  "NumpadEnter",
  "Backspace",
]);

const DEAD_ZONE_DEFAULT = 0.15;
const SENSITIVITY_DEFAULT = 1;

/** Boutons de la correspondance « standard » (Xbox, DualSense, génériques). */
const BTN_CROSS = 0;
const BTN_CIRCLE = 1;
const BTN_SQUARE = 2;
const BTN_TRIANGLE = 3;
const BTN_START = 9;
const BTN_UP = 12;
const BTN_DOWN = 13;
const BTN_LEFT = 14;
const BTN_RIGHT = 15;

const detectLayout = (id: string): PadLayout => {
  const text = id.toLowerCase();
  if (/(playstation|dualsense|dualshock|wireless controller 5|0268|054c)/.test(text)) return "playstation";
  if (/(xbox|x-input|xinput|standard gamepad|wireless controller)/.test(text)) return "xbox";
  return "generic";
};

/**
 * Clavier + Gamepad API. Toute la conduite passe par des valeurs analogiques
 * (axes et gâchettes), les actions sont des fronts montants.
 */
export class InputManager {
  private readonly pressed = new Set<string>();
  /** Touches pressées depuis le dernier relevé : un appui très bref n'est jamais perdu. */
  private readonly tapBuffer = new Set<string>();
  private padIndex = -1;
  private padLayout: PadLayout = "generic";
  private padActive = false;
  private padWasPresent = false;
  private previousButtons: boolean[] = [];
  private keyTapped = false;

  readonly profiles = new PadProfiles();
  configuring = false;

  get currentPad(): Gamepad | null {
    const pads = navigator.getGamepads?.() ?? [];
    return (this.padIndex >= 0 ? pads[this.padIndex] : null) ?? Array.from(pads).find(p => !!p) ?? null;
  }

  selectPad(index: number): void {
    this.padIndex = index;
    this.padActive = false;
    this.previousButtons = [];
    const pad = this.currentPad;
    this.padLayout = pad ? detectLayout(pad.id) : "generic";
  }

  deadzone = DEAD_ZONE_DEFAULT;
  sensitivity = SENSITIVITY_DEFAULT;

  private readonly frame: InputFrame = {
    throttle: 0,
    brake: 0,
    steer: 0,
    handbrake: false,
    resetCar: false,
    switchCamera: false,
    pause: false,
    confirm: false,
    back: false,
    menuUp: false,
    menuDown: false,
    menuLeft: false,
    menuRight: false,
    padConnected: false,
    padPending: false,
    padLayout: "generic",
    padLost: false,
    keyTap: false,
    rawAxisX: 0,
    rawAxisY: 0,
    rawTriggerLeft: 0,
    rawTriggerRight: 0,
    rawButtons: "—",
  };

  constructor(private readonly target: Window | HTMLElement = window) {
    window.addEventListener("keydown", this.onKeyDown, { passive: false });
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.onBlur);
    window.addEventListener("gamepadconnected", this.onConnected);
    window.addEventListener("gamepaddisconnected", this.onDisconnected);
  }

  dispose(): void {
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("blur", this.onBlur);
    window.removeEventListener("gamepadconnected", this.onConnected);
    window.removeEventListener("gamepaddisconnected", this.onDisconnected);
  }

  /** Cible du focus clavier (le canvas, pour garder les événements). */
  get focusTarget(): HTMLElement | Window {
    return this.target;
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.repeat) return;
    // Dans l'assistant, laisser la souris et le clavier piloter les vrais contrôles HTML.
    if (this.configuring && event.code !== "Escape") return;
    if (SWALLOWED.has(event.code) && !(event.target instanceof HTMLInputElement)) {
      event.preventDefault();
    }
    this.pressed.add(event.code);
    this.tapBuffer.add(event.code);
    this.keyTapped = true;
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    this.pressed.delete(event.code);
  };

  private readonly onBlur = (): void => {
    this.pressed.clear();
  };

  private readonly onConnected = (event: Event): void => {
    const pad = (event as GamepadEvent).gamepad;
    if (!pad) return;
    this.padIndex = pad.index;
    this.padLayout = detectLayout(pad.id ?? "");
    this.padActive = false;
    this.padWasPresent = true;
    this.previousButtons = [];
  };

  private readonly onDisconnected = (): void => {
    this.padIndex = -1;
    this.padActive = false;
    this.previousButtons = [];
  };

  private held(list: readonly string[]): boolean {
    for (const code of list) if (this.pressed.has(code)) return true;
    return false;
  }

  private tapped(list: readonly string[]): boolean {
    for (const code of list) if (this.tapBuffer.has(code)) return true;
    return false;
  }

  private shaped(value: number): number {
    const dz = clamp(this.deadzone, 0, 0.6);
    const absolute = Math.abs(value);
    if (absolute <= dz) return 0;
    return Math.sign(value) * clamp((absolute - dz) / (1 - dz), 0, 1);
  }

  private navLatch = false;

  private readPad(present: Gamepad): {
    throttle: number;
    brake: number;
    steer: number;
    axisX: number;
    axisY: number;
    handbrake: boolean;
    edges: boolean[];
    any: boolean;
    names: string[];
  } {
    const buttons = present.buttons;
    const custom = this.profiles.get(present);
    const pressedNow: boolean[] = [];
    for (let i = 0; i < buttons.length; i++) pressedNow.push(!!buttons[i] && buttons[i].pressed);
    if (custom) {
      const actions = { [BTN_CROSS]: "confirm", [BTN_CIRCLE]: "back", [BTN_TRIANGLE]: "camera", [BTN_START]: "pause", 16: "reset" } as const;
      for (const [index, action] of Object.entries(actions)) pressedNow[Number(index)] = readBinding(present, custom[action]) > 0.5;
      // Une manette générique ne doit pas déclencher une navigation standard par hasard.
      for (const index of [BTN_UP, BTN_DOWN, BTN_LEFT, BTN_RIGHT]) pressedNow[index] = false;
    }
    const edges: boolean[] = [];
    for (let i = 0; i < pressedNow.length; i++) {
      edges.push(pressedNow[i] && !this.previousButtons[i]);
    }
    this.previousButtons = pressedNow;

    const axis = (i: number): number => (present.axes[i] !== undefined ? present.axes[i] : 0);
    const trigger = (i: number): number => {
      const button = buttons[i];
      if (button && typeof button.value === "number") return clamp(button.value, 0, 1);
      return clamp(axis(i), 0, 1);
    };
    const profile = this.profiles.get(present);
    const mapped = (action: keyof NonNullable<typeof profile>): number => readBinding(present, profile?.[action] ?? null);
    const axisX = this.shaped(profile ? mapped("right") - mapped("left") : axis(0));
    const axisY = this.shaped(axis(1));
    const names: string[] = [];
    for (let i = 0; i < buttons.length; i++) if (buttons[i].pressed) names.push(String(i));

    return {
      throttle: profile ? mapped("throttle") : trigger(7),
      brake: profile ? mapped("brake") : trigger(6),
      steer: axisX * this.sensitivity,
      axisX,
      axisY,
      handbrake: profile ? mapped("handbrake") > 0.5 : pressedNow[BTN_SQUARE] ?? false,
      edges,
      any: buttons.some(b => b.pressed) || present.axes.some(v => Math.abs(v) > 0.2),
      names,
    };
  }

  /** À appeler une fois par image, avant la simulation. */
  update(menusActive: boolean): InputFrame {
    const f = this.frame;
    const pads = typeof navigator.getGamepads === "function" ? navigator.getGamepads() : [];
    let pad: Gamepad | null = null;
    if (this.padIndex >= 0) pad = pads[this.padIndex] ?? null;
    if (!pad) {
      for (const candidate of pads) {
        if (candidate) {
          pad = candidate;
          this.padIndex = candidate.index;
          this.padLayout = detectLayout(candidate.id ?? "");
          break;
        }
      }
    }

    const present = !!pad;
    f.padLost = this.padWasPresent && !present;
    if (present) this.padWasPresent = true;
    if (f.padLost) this.padWasPresent = false;
    f.padConnected = present;
    f.padLayout = this.padLayout;

    let padThrottle = 0;
    let padBrake = 0;
    let padSteer = 0;
    let padHand = false;
    let edges: boolean[] = [];
    let axisX = 0;
    let axisY = 0;
    let rawLeft = 0;
    let rawRight = 0;
    let names: string[] = [];

    if (pad) {
      const read = this.readPad(pad);
      axisX = read.axisX;
      axisY = read.axisY;
      edges = read.edges;
      names = read.names;
      rawLeft = read.brake;
      rawRight = read.throttle;
      if (this.padActive) {
        padThrottle = read.throttle;
        padBrake = read.brake;
        padSteer = read.steer;
        padHand = read.handbrake;
      } else if (read.any) {
        // premier appui : la manette est validée, mais ce coup-ci est ignoré
        this.padActive = true;
        edges = [];
      }
    } else {
      this.previousButtons = [];
    }

    f.padPending = present && !this.padActive;

    // --- conduite : clavier et manette se-additionnent ---------------------
    const keySteer = ((this.held(KEYS.right) ? 1 : 0) - (this.held(KEYS.left) ? 1 : 0)) * this.sensitivity;
    f.throttle = clamp(Math.max(this.held(KEYS.accelerate) ? 1 : 0, padThrottle), 0, 1);
    f.brake = clamp(Math.max(this.held(KEYS.brake) ? 1 : 0, padBrake), 0, 1);
    f.steer = clamp(keySteer + padSteer, -1, 1);
    f.handbrake = this.held(KEYS.handbrake) || padHand;

    // --- actions -----------------------------------------------------------
    const edge = (index: number): boolean => this.padActive && !!edges[index];
    f.resetCar = this.tapped(KEYS.reset) || edge(pad && this.profiles.get(pad) ? 16 : BTN_CIRCLE);
    f.switchCamera = this.tapped(KEYS.camera) || edge(BTN_TRIANGLE);
    f.pause = this.tapped(KEYS.pause) || edge(BTN_START);
    f.confirm = this.tapped(KEYS.confirm) || edge(BTN_CROSS);
    f.back = this.tapped(KEYS.back) || edge(BTN_CIRCLE);

    // navigation dans les menus : croix directionnelle, stick, flèches
    const navLatchRelease = 0.35;
    let up = this.tapped(KEYS.accelerate) || edge(BTN_UP);
    let down = this.tapped(KEYS.brake) || edge(BTN_DOWN);
    let left = this.tapped(KEYS.left) || edge(BTN_LEFT);
    let right = this.tapped(KEYS.right) || edge(BTN_RIGHT);
    if (menusActive && (Math.abs(axisX) > 0.6 || Math.abs(axisY) > 0.6)) {
      if (!this.navLatch) {
        this.navLatch = true;
        if (axisY < -0.6) up = true;
        if (axisY > 0.6) down = true;
        if (axisX < -0.6) left = true;
        if (axisX > 0.6) right = true;
      }
    } else if (Math.abs(axisX) < navLatchRelease && Math.abs(axisY) < navLatchRelease) {
      this.navLatch = false;
    }
    f.menuUp = up;
    f.menuDown = down;
    f.menuLeft = left;
    f.menuRight = right;

    // --- diagnostic ---------------------------------------------------------
    f.rawAxisX = axisX;
    f.rawAxisY = axisY;
    f.rawTriggerLeft = rawLeft;
    f.rawTriggerRight = rawRight;
    f.rawButtons = names.length > 0 ? names.join(" ") : "—";
    f.keyTap = this.keyTapped;

    if (this.configuring) {
      f.throttle = f.brake = f.steer = 0;
      f.handbrake = f.resetCar = f.switchCamera = f.confirm = f.back = false;
      f.menuUp = f.menuDown = f.menuLeft = f.menuRight = false;
      f.pause = this.tapped(KEYS.pause);
    }
    this.keyTapped = false;
    this.tapBuffer.clear();
    return f;
  }

  /** La manette a été validée par un appui. */
  get padReady(): boolean {
    return this.padActive;
  }
}
