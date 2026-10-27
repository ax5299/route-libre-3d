import { clamp, createSafeStore } from "./utils";

/**
 * Réglages persistants et records locaux.
 * Le stockage peut être refusé par le navigateur : on retombe alors sur une
 * sauvegarde en mémoire, le jeu reste pleinement jouable.
 */

export type CircuitId = "cretes" | "villeeneuve";

/** Noms affichés des circuits (partagés HUD / piste). */
export const CIRCUIT_LABELS: Record<CircuitId, string> = {
  cretes: "Circuit des Crêtes",
  villeeneuve: "Gilles-Villeneuve · Montréal",
};

export interface Settings {
  /** Circuit chargé au démarrage (rechargement de page au changement). */
  circuit: CircuitId;
  /** Multiplicateur appliqué à la commande de direction (0.1 … 2). */
  steeringSensitivity: number;
  /** Zone morte du stick gauche (0 … 0.40), 0.15 par défaut. */
  deadzone: number;
  /** Fermeté du suivi de caméra (0.4 … 2). */
  cameraFirmness: number;
  /** Nombre de voitures de trafic (0 … 24). */
  trafficCount: number;
  /** Densité de nids de poule : 0 = aucun, 10 = beaucoup. */
  potholesLevel: number;
  /** Nombre de grenouilles qui traversent la piste (0 … 24). */
  frogCount: number;
  /** Volume général, 0 … 1. */
  volume: number;
  muted: boolean;
  shadows: boolean;
  diagnostics: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  circuit: "cretes",
  steeringSensitivity: 0.8,
  deadzone: 0.15,
  cameraFirmness: 1,
  trafficCount: 6,
  potholesLevel: 4,
  frogCount: 6,
  volume: 0.6,
  muted: false,
  shadows: true,
  diagnostics: false,
};

export interface Records {
  /** Meilleur tour en millisecondes. */
  bestLapMs: number;
  /** Meilleur cumul sur la distance de la course. */
  bestTotalMs: number;
  lapsCompleted: number;
  runs: number;
}

export const EMPTY_RECORDS: Records = {
  bestLapMs: 0,
  bestTotalMs: 0,
  lapsCompleted: 0,
  runs: 0,
};

const SETTINGS_KEY = "route-libre-3d:settings:v1";
const RECORDS_KEY = "route-libre-3d:records:v1";

const store = createSafeStore();

const num = (value: unknown, fallback: number, min: number, max: number): number =>
  typeof value === "number" && Number.isFinite(value) ? clamp(value, min, max) : fallback;

const bool = (value: unknown, fallback: boolean): boolean =>
  typeof value === "boolean" ? value : fallback;

/** Charge les réglages en s'assurant qu'ils sont dans les bornes admises. */
export function loadSettings(): Settings {
  const raw = store.read<Partial<Settings>>(SETTINGS_KEY, {});
  return {
    circuit: raw.circuit === "villeeneuve" ? "villeeneuve" : "cretes",
    steeringSensitivity: num(raw.steeringSensitivity, DEFAULT_SETTINGS.steeringSensitivity, 0.1, 2),
    deadzone: num(raw.deadzone, DEFAULT_SETTINGS.deadzone, 0, 0.4),
    cameraFirmness: num(raw.cameraFirmness, DEFAULT_SETTINGS.cameraFirmness, 0.4, 2),
    trafficCount: num(raw.trafficCount, DEFAULT_SETTINGS.trafficCount, 0, 24),
    potholesLevel: num(raw.potholesLevel, DEFAULT_SETTINGS.potholesLevel, 0, 10),
    frogCount: num(raw.frogCount, DEFAULT_SETTINGS.frogCount, 0, 24),
    volume: num(raw.volume, DEFAULT_SETTINGS.volume, 0, 1),
    muted: bool(raw.muted, DEFAULT_SETTINGS.muted),
    shadows: bool(raw.shadows, DEFAULT_SETTINGS.shadows),
    diagnostics: bool(raw.diagnostics, DEFAULT_SETTINGS.diagnostics),
  };
}

export function saveSettings(settings: Settings): boolean {
  return store.write(SETTINGS_KEY, settings);
}

export function loadRecords(): Records {
  const raw = store.read<Partial<Records>>(RECORDS_KEY, {});
  return {
    bestLapMs: num(raw.bestLapMs, EMPTY_RECORDS.bestLapMs, 0, 86_400_000),
    bestTotalMs: num(raw.bestTotalMs, EMPTY_RECORDS.bestTotalMs, 0, 86_400_000),
    lapsCompleted: num(raw.lapsCompleted, EMPTY_RECORDS.lapsCompleted, 0, 1_000_000),
    runs: num(raw.runs, EMPTY_RECORDS.runs, 0, 1_000_000),
  };
}

export function saveRecords(records: Records): boolean {
  return store.write(RECORDS_KEY, records);
}

export function clearRecords(): void {
  store.remove(RECORDS_KEY);
}

/** Le stockage est-il réellement disponible ? (affiché dans le menu) */
export const storageAvailable = store.available;
