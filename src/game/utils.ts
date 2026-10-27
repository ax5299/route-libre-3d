/**
 * Petites fonctions utilitaires : mathématiques de conduite, formatage du
 * chronomètre et accès tolérant au stockage local.
 */

export const clamp = (v: number, min: number, max: number): number =>
  v < min ? min : v > max ? max : v;

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/**
 * Lissage exponentiel indépendant du nombre d'images par seconde.
 * `lambda` est la vitesse de rattrapage (plus grand = plus nerveux).
 */
export const damp = (current: number, target: number, lambda: number, dt: number): number =>
  target + (current - target) * Math.exp(-lambda * dt);

/** Angle le plus court entre a et b, en radians, dans (-PI, PI]. */
export const shortestAngle = (delta: number): number => {
  let d = delta % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d <= -Math.PI) d += Math.PI * 2;
  return d;
};

/** Lissage d'un angle qui peut faire le tour du cercle. */
export const dampAngle = (current: number, target: number, lambda: number, dt: number): number =>
  current + shortestAngle(target - current) * (1 - Math.exp(-lambda * dt));

export const wrap01 = (v: number): number => {
  const w = v % 1;
  return w < 0 ? w + 1 : w;
};

/** 83_250 -> "1:23.254" ; 5_000 -> "0:05.000" */
export const formatLapTime = (ms: number): string => {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const total = Math.floor(ms);
  const minutes = Math.floor(total / 60000);
  const seconds = Math.floor((total % 60000) / 1000);
  const hundredths = Math.floor((total % 1000) / 10);
  return `${minutes}:${String(seconds).padStart(2, "0")}.${String(hundredths).padStart(2, "0")}`;
};

/** Version courte utilisée dans les diagnostics. */
export const formatSeconds = (ms: number): string => (ms / 1000).toFixed(2) + " s";

export const roundTo = (v: number, digits: number): number => {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
};

/** Générateur pseudo-aléatoire déterministe : le décor est identique à chaque lancement. */
export const createRandom = (seed: number): (() => number) => {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
};

/**
 * Accès au localStorage avec repli en mémoire : si le navigateur bloque le
 * stockage (mode privé, cookies désactivés), le jeu reste jouable.
 */
export interface SafeStore {
  read<T>(key: string, fallback: T): T;
  write(key: string, value: unknown): boolean;
  remove(key: string): void;
  readonly available: boolean;
}

export const createSafeStore = (): SafeStore => {
  const memory = new Map<string, string>();
  let available = false;
  try {
    const probe = "__rl3d_probe__";
    window.localStorage.setItem(probe, "1");
    window.localStorage.removeItem(probe);
    available = true;
  } catch {
    available = false;
  }

  return {
    available,
    read<T>(key: string, fallback: T): T {
      const raw = available ? safeGet(key) : memory.get(key);
      if (raw === null || raw === undefined) return fallback;
      try {
        return JSON.parse(raw) as T;
      } catch {
        return fallback;
      }
    },
    write(key: string, value: unknown): boolean {
      const raw = JSON.stringify(value);
      memory.set(key, raw);
      if (!available) return false;
      try {
        window.localStorage.setItem(key, raw);
        return true;
      } catch {
        return false;
      }
    },
    remove(key: string): void {
      memory.delete(key);
      if (!available) return;
      try {
        window.localStorage.removeItem(key);
      } catch {
        /* stockage inaccessible : le repli mémoire suffit */
      }
    },
  };
};

function safeGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
