import type { InputFrame } from "./input";
import { CIRCUIT_LABELS, type CircuitId, type Records, type Settings } from "./settings";
import { clamp, formatLapTime } from "./utils";

/** Écrans superposés au rendu 3D. `game` = aucun écran, HUD visible. */
export type ScreenName = "home" | "commands" | "settings" | "pause" | "finish" | "controller" | "game";

const SCREEN_IDS: Record<Exclude<ScreenName, "game">, string> = {
  controller: "screen-controller",
  home: "screen-home",
  commands: "screen-commands",
  settings: "screen-settings",
  pause: "screen-pause",
  finish: "screen-finish",
};

/** Libellé du curseur de densité des nids de poule. */
const holesLabel = (level: number): string => {
  const n = Math.round(level);
  if (n <= 0) return "Aucun";
  if (n <= 2) return "Un peu";
  if (n <= 4) return "Modéré";
  if (n <= 7) return "Beaucoup";
  return "Énormément";
};

/** Ce que l'interface attend de l'application. */
export interface HudHooks {
  onPlay(): void;
  onResume(): void;
  onRestart(): void;
  onQuit(): void;
  onSettingsChange(settings: Settings): void;
  onResetSettings(): void;
  onResetRecords(): void;
}

export interface FinishData {
  lapTimes: number[];
  totalMs: number;
  bestLapMs: number;
  newRecord: boolean;
}

export interface DiagnosticsInfo {
  fps: number;
  steps: number;
  speed: number;
  surface: string;
  lateral: number;
  distance: number;
  checkpoints: string;
  camera: string;
}

const NODE_IDS = [
  "hud",
  "speed",
  "time",
  "lap",
  "best",
  "total",
  "circuit",
  "toast",
  "wrong",
  "off",
  "countdown",
  "diag",
  "fps",
  "steps",
  "pad",
  "ax",
  "ay",
  "rt",
  "lt",
  "btns",
  "spd",
  "surf",
  "lat",
  "s",
  "cp",
  "cam",
  "barAx",
  "barRt",
  "boot",
  "prompt",
  "record",
  "pauseSub",
  "summary",
  "laps",
] as const;

type NodeId = (typeof NODE_IDS)[number];

const DOM_IDS: Record<NodeId, string> = {
  hud: "hud",
  speed: "hud-speed",
  time: "hud-time",
  lap: "hud-lap",
  best: "hud-best",
  total: "hud-total",
  circuit: "hud-circuit",
  toast: "hud-toast",
  wrong: "hud-wrongway",
  off: "hud-offtrack",
  countdown: "countdown",
  diag: "diag",
  fps: "d-fps",
  steps: "d-steps",
  pad: "d-pad",
  ax: "d-ax",
  ay: "d-ay",
  rt: "d-rt",
  lt: "d-lt",
  btns: "d-btns",
  spd: "d-spd",
  surf: "d-surf",
  lat: "d-lat",
  s: "d-s",
  cp: "d-cp",
  cam: "d-cam",
  barAx: "d-bar-ax",
  barRt: "d-bar-rt",
  boot: "boot",
  prompt: "pad-prompt",
  record: "home-record",
  pauseSub: "pause-sub",
  summary: "finish-summary",
  laps: "finish-laps",
};

/**
 * Toute l'interface DOM : écrans, HUD de course, compte à rebours, messages,
 * réglages et mode diagnostic. Aucun élément n'est créé ici, seulement rempli.
 */
export class Hud {
  screen: ScreenName = "home";

  private readonly n: Record<NodeId, HTMLElement | null>;
  private readonly sliders: Record<string, HTMLInputElement | null> = {};
  private readonly outputs: Record<string, HTMLElement | null> = {};
  private readonly checks: Record<string, HTMLInputElement | null> = {};
  private readonly radios: Record<string, HTMLInputElement[]> = {};
  private toastHandle = 0;
  private lastCountdown = "";
  private returnTo: ScreenName = "home";
  private cleanup: (() => void)[] = [];

  constructor(
    private readonly hooks: HudHooks,
    public settings: Settings,
    private records: Records,
  ) {
    const n = {} as Record<NodeId, HTMLElement | null>;
    for (const id of NODE_IDS) n[id] = document.getElementById(DOM_IDS[id]);
    this.n = n;

    const field = (id: string): HTMLInputElement | null => document.getElementById(id) as HTMLInputElement | null;
    this.sliders.sens = field("set-sens");
    this.sliders.dz = field("set-dz");
    this.sliders.cam = field("set-cam");
    this.sliders.traffic = field("set-traffic");
    this.sliders.holes = field("set-holes");
    this.sliders.frogs = field("set-frogs");
    this.sliders.vol = field("set-vol");
    this.outputs.sens = document.getElementById("out-sens");
    this.outputs.dz = document.getElementById("out-dz");
    this.outputs.cam = document.getElementById("out-cam");
    this.outputs.traffic = document.getElementById("out-traffic");
    this.outputs.holes = document.getElementById("out-holes");
    this.outputs.frogs = document.getElementById("out-frogs");
    this.outputs.vol = document.getElementById("out-vol");
    this.checks.mute = field("set-mute");
    this.checks.shadows = field("set-shadows");
    this.checks.diag = field("set-diag");
    this.radios.circuit = Array.from(
      document.querySelectorAll<HTMLInputElement>('input[name="set-circuit"]'),
    );

    this.bindActions();
    this.bindSettings();
    this.syncSettings(settings);
    this.setRecords(records);
    this.setScreen("home");
  }

  // ------------------------------------------------------------------ actions

  private bindActions(): void {
    const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>("button[data-action]"));
    const run = (action: string): void => {
      switch (action) {
        case "play":
          this.hooks.onPlay();
          break;
        case "resume":
          this.hooks.onResume();
          break;
        case "restart":
          this.hooks.onRestart();
          break;
        case "quit":
          this.hooks.onQuit();
          break;
        case "commands":
          this.returnTo = this.screen === "pause" ? "pause" : "home";
          this.setScreen("commands");
          break;
        case "controller":
          this.returnTo = this.screen === "pause" ? "pause" : "home";
          this.setScreen("controller");
          break;
        case "settings":
          this.returnTo = this.screen === "pause" ? "pause" : "home";
          this.setScreen("settings");
          break;
        case "back":
          this.setScreen(this.returnTo);
          break;
        case "reset-settings":
          this.hooks.onResetSettings();
          break;
        case "reset-records":
          this.hooks.onResetRecords();
          break;
        default:
          break;
      }
    };
    for (const button of buttons) {
      const action = button.dataset.action ?? "";
      const handler = (event: Event): void => {
        event.preventDefault();
        run(action);
      };
      button.addEventListener("click", handler);
      this.cleanup.push(() => button.removeEventListener("click", handler));
    }
  }

  // ------------------------------------------------------------------ réglages

  private bindSettings(): void {
    const apply = (): void => {
      const s = this.settings;
      const read = (input: HTMLInputElement | null, fallback: number): number => {
        if (!input) return fallback;
        const value = Number(input.value);
        return Number.isFinite(value) ? value : fallback;
      };
      s.steeringSensitivity = read(this.sliders.sens, s.steeringSensitivity);
      s.deadzone = read(this.sliders.dz, s.deadzone);
      s.cameraFirmness = read(this.sliders.cam, s.cameraFirmness);
      s.trafficCount = clamp(Math.round(read(this.sliders.traffic, s.trafficCount)), 0, 24);
      s.potholesLevel = clamp(Math.round(read(this.sliders.holes, s.potholesLevel)), 0, 10);
      s.frogCount = clamp(Math.round(read(this.sliders.frogs, s.frogCount)), 0, 24);
      s.volume = clamp(read(this.sliders.vol, s.volume * 100) / 100, 0, 1);
      if (this.checks.mute) s.muted = this.checks.mute.checked;
      if (this.checks.shadows) s.shadows = this.checks.shadows.checked;
      if (this.checks.diag) s.diagnostics = this.checks.diag.checked;
      const circuit = this.radios.circuit.find((r) => r.checked)?.value;
      if (circuit === "cretes" || circuit === "villeeneuve") s.circuit = circuit as CircuitId;
      this.syncOutputs();
      this.updateDiagnosticVisibility();
      this.hooks.onSettingsChange(s);
    };
    const inputs = [
      ...Object.values(this.sliders),
      ...Object.values(this.checks),
      ...this.radios.circuit,
    ];
    for (const input of inputs) {
      if (!input) continue;
      const handler = (): void => apply();
      input.addEventListener("input", handler);
      input.addEventListener("change", handler);
      this.cleanup.push(() => {
        input.removeEventListener("input", handler);
        input.removeEventListener("change", handler);
      });
    }
  }

  /** Reflète l'objet réglages dans les champs du formulaire. */
  syncSettings(settings: Settings): void {
    this.settings = settings;
    if (this.sliders.sens) this.sliders.sens.value = String(settings.steeringSensitivity);
    if (this.sliders.dz) this.sliders.dz.value = String(settings.deadzone);
    if (this.sliders.cam) this.sliders.cam.value = String(settings.cameraFirmness);
    if (this.sliders.traffic) this.sliders.traffic.value = String(settings.trafficCount);
    if (this.sliders.holes) this.sliders.holes.value = String(settings.potholesLevel);
    if (this.sliders.frogs) this.sliders.frogs.value = String(settings.frogCount);
    if (this.sliders.vol) this.sliders.vol.value = String(Math.round(settings.volume * 100));
    if (this.checks.mute) this.checks.mute.checked = settings.muted;
    if (this.checks.shadows) this.checks.shadows.checked = settings.shadows;
    if (this.checks.diag) this.checks.diag.checked = settings.diagnostics;
    for (const radio of this.radios.circuit) radio.checked = radio.value === settings.circuit;
    const tagline = document.getElementById("tagline-track");
    if (tagline) tagline.textContent = `Contre-la-montre · ${CIRCUIT_LABELS[settings.circuit]}`;
    if (this.n.circuit) this.n.circuit.textContent = CIRCUIT_LABELS[settings.circuit].split(" · ")[0];
    this.syncOutputs();
    this.updateDiagnosticVisibility();
  }

  private syncOutputs(): void {
    const s = this.settings;
    if (this.outputs.sens) this.outputs.sens.textContent = s.steeringSensitivity.toFixed(2);
    if (this.outputs.dz) this.outputs.dz.textContent = s.deadzone.toFixed(2);
    if (this.outputs.cam) this.outputs.cam.textContent = s.cameraFirmness.toFixed(2);
    if (this.outputs.traffic) this.outputs.traffic.textContent = String(Math.round(s.trafficCount));
    if (this.outputs.holes) this.outputs.holes.textContent = holesLabel(s.potholesLevel);
    if (this.outputs.frogs) this.outputs.frogs.textContent = s.frogCount <= 0 ? "Aucune" : String(Math.round(s.frogCount));
    if (this.outputs.vol) this.outputs.vol.textContent = String(Math.round(s.volume * 100));
  }

  private updateDiagnosticVisibility(): void {
    const diag = this.n.diag;
    if (diag) diag.hidden = this.screen !== "game" || !this.settings.diagnostics;
  }

  // -------------------------------------------------------------------- écrans

  setScreen(name: ScreenName): void {
    this.screen = name;
    for (const key of Object.keys(SCREEN_IDS) as Exclude<ScreenName, "game">[]) {
      const element = document.getElementById(SCREEN_IDS[key]);
      if (element) element.hidden = key !== name;
    }
    if (this.n.hud) this.n.hud.hidden = name !== "game";
    this.updateDiagnosticVisibility();
    if (name === "game") {
      const active = document.activeElement;
      if (active instanceof HTMLElement) active.blur();
      this.setCountdown(null);
      this.setPadPrompt(false);
    } else {
      this.setWrongWay(false);
      this.setOffTrack(false);
      const screen = document.getElementById(SCREEN_IDS[name]);
      screen?.querySelector<HTMLElement>(".btn")?.focus();
    }
  }

  /** Écran courant (sert aussi à savoir si la conduite est bloquée). */
  get inMenus(): boolean {
    return this.screen !== "game";
  }

  setPadPrompt(visible: boolean): void {
    if (this.n.prompt) this.n.prompt.hidden = !visible;
  }

  /** Navigation à la manette dans l'écran affiché. */
  navigate(frame: InputFrame): void {
    const screenName = this.screen === "game" ? null : this.screen;
    if (!screenName) return;
    const screen = document.getElementById(SCREEN_IDS[screenName]);
    if (!screen) return;
    const items = Array.from(
      screen.querySelectorAll<HTMLElement>(".btn, input[type=range], input[type=checkbox], input[type=radio]"),
    );
    if (items.length === 0) return;
    const current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    let index = current ? items.indexOf(current) : -1;
    if (frame.menuDown) index = (index + 1 + items.length) % items.length;
    if (frame.menuUp) index = (index - 1 + items.length) % items.length;
    if (index >= 0 && items[index] !== current) items[index]?.focus();
    const focused = document.activeElement;
    if (focused instanceof HTMLInputElement && focused.type === "range") {
      const step = Number(focused.step) || 0.1;
      const min = Number(focused.min) || 0;
      const max = Number(focused.max) || 1;
      let value = Number(focused.value);
      if (frame.menuRight) value = clamp(value + step, min, max);
      if (frame.menuLeft) value = clamp(value - step, min, max);
      if (focused.value !== String(value)) {
        focused.value = String(value);
        focused.dispatchEvent(new Event("input", { bubbles: true }));
      }
    }
    if (frame.confirm) {
      if (focused instanceof HTMLElement) focused.click();
      else items[0]?.click();
    }
  }

  // --------------------------------------------------------------- HUD de course

  private set(id: NodeId, value: string): void {
    const element = this.n[id];
    if (element && element.textContent !== value) element.textContent = value;
  }

  private show(id: NodeId, visible: boolean): void {
    const element = this.n[id];
    if (element && element.hidden === visible) element.hidden = !visible;
  }

  setSpeed(kmh: number): void {
    this.set("speed", String(Math.max(0, Math.round(kmh))));
  }

  setLap(lap: number, total: number): void {
    this.set("lap", `${Math.min(lap, total)} / ${total}`);
  }

  setTimes(lapMs: number, totalMs: number, bestMs: number | null): void {
    this.set("time", lapMs > 0 ? formatLapTime(lapMs) : "—");
    this.set("total", formatLapTime(totalMs));
    this.set("best", bestMs && bestMs > 0 ? formatLapTime(bestMs) : "—");
  }

  /** Affiche « 3 », « 2 », « 1 », « GO ! » ou rien. */
  setCountdown(label: string | null): void {
    const element = this.n.countdown;
    if (!element) return;
    if (label === null) {
      element.hidden = true;
      this.lastCountdown = "";
      return;
    }
    if (label === this.lastCountdown) return;
    this.lastCountdown = label;
    element.textContent = label;
    element.hidden = false;
    element.classList.remove("pop");
    void element.offsetWidth;
    element.classList.add("pop");
  }

  /** Message temporisé (checkpoints, pénalités, infos diverses). */
  toast(text: string, duration = 1700): void {
    const element = this.n.toast;
    if (!element) return;
    window.clearTimeout(this.toastHandle);
    if (!text) {
      element.hidden = true;
      return;
    }
    element.textContent = text;
    element.hidden = false;
    this.toastHandle = window.setTimeout(() => {
      element.hidden = true;
    }, duration);
  }

  setWrongWay(active: boolean): void {
    this.show("wrong", active);
  }

  setOffTrack(active: boolean): void {
    this.show("off", active);
  }

  setPauseInfo(text: string): void {
    this.set("pauseSub", text);
  }

  setRecords(records: Records): void {
    this.records = records;
    const best = this.n.record;
    if (best) {
      best.textContent =
        records.bestLapMs > 0
          ? `Meilleur tour : ${formatLapTime(records.bestLapMs)}`
          : "Aucun record pour l’instant.";
    }
    const hudBest = this.n.best;
    if (hudBest) hudBest.textContent = records.bestLapMs > 0 ? formatLapTime(records.bestLapMs) : "—";
  }

  /** Écran de fin : récapitulatif + liste des tours. */
  showFinish(data: FinishData): void {
    const summary = this.n.summary;
    if (summary) {
      const parts = [`Temps total ${formatLapTime(data.totalMs)}`];
      if (data.bestLapMs > 0) parts.push(`meilleur tour ${formatLapTime(data.bestLapMs)}`);
      if (data.newRecord) parts.push("nouveau record !");
      summary.textContent = parts.join(" · ");
    }
    const list = this.n.laps;
    if (list) {
      list.textContent = "";
      data.lapTimes.forEach((lap, index) => {
        const item = document.createElement("li");
        const label = document.createElement("span");
        label.textContent = `Tour ${index + 1}`;
        const value = document.createElement("b");
        value.textContent = formatLapTime(lap);
        item.append(label, value);
        if (lap === data.bestLapMs) item.classList.add("best");
        list.append(item);
      });
    }
    this.setScreen("finish");
  }

  // ------------------------------------------------------------------ diagnostic

  diagnostics(info: DiagnosticsInfo, frame: InputFrame): void {
    if (!this.settings.diagnostics || this.screen !== "game") return;
    this.set("fps", info.fps.toFixed(0));
    this.set("steps", String(info.steps));
    this.set("pad", frame.padConnected ? frame.padLayout : "aucune");
    this.set("ax", frame.rawAxisX.toFixed(2));
    this.set("ay", frame.rawAxisY.toFixed(2));
    this.set("rt", frame.rawTriggerRight.toFixed(2));
    this.set("lt", frame.rawTriggerLeft.toFixed(2));
    this.set("btns", frame.rawButtons || "—");
    this.set("spd", `${(info.speed * 3.6).toFixed(1)} km/h`);
    this.set("surf", info.surface);
    this.set("lat", `${info.lateral.toFixed(2)} m`);
    this.set("s", `${(info.distance / 1000).toFixed(2)} km`);
    this.set("cp", info.checkpoints);
    this.set("cam", info.camera);
    const barAx = this.n.barAx;
    const barRt = this.n.barRt;
    if (barAx) barAx.style.width = `${Math.round(clamp(Math.abs(frame.rawAxisX), 0, 1) * 100)}%`;
    if (barRt) barRt.style.width = `${Math.round(clamp(frame.rawTriggerRight, 0, 1) * 100)}%`;
  }

  /** Le HUD expose les meilleurs temps chargés au démarrage. */
  get lastRecords(): Records {
    return this.records;
  }

  /** Éphémère : message collant (erreur de sauvegarde, chargement). */
  setNotice(text: string | null): void {
    const boot = this.n.boot;
    if (!boot) return;
    boot.hidden = text === null;
    if (text !== null) {
      boot.classList.remove("done");
      boot.textContent = text;
    }
  }

  /** Revenir à l'écran parent (Échap au clavier, bouton B à la manette). */
  goBack(): void {
    this.setScreen(this.returnTo);
  }

  /** Ouvre l'écran pause en se souvenant comment en sortir. */
  openPause(info: string): void {
    this.returnTo = "game";
    this.setPauseInfo(info);
    this.setScreen("pause");
  }

  bootDone(): void {
    const boot = this.n.boot;
    if (!boot) return;
    boot.classList.add("done");
    boot.hidden = true;
  }

  dispose(): void {
    window.clearTimeout(this.toastHandle);
    for (const off of this.cleanup) off();
    this.cleanup = [];
  }
}
