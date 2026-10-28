/** Correspondances personnalisées, indépendantes du nom commercial de la manette. */
export const PAD_ACTIONS = ["left", "right", "throttle", "brake", "handbrake", "camera", "reset", "pause", "confirm", "back"] as const;
export type PadAction = typeof PAD_ACTIONS[number];
export interface PadBinding {
  kind: "axis" | "button";
  index: number;
  rest: number;
  end: number;
}
export type PadProfile = Record<PadAction, PadBinding | null>;
const PREFIX = "route-libre-pad-v1:";

export function padKey(pad: Gamepad): string {
  return `${pad.id}|${pad.mapping}|${pad.axes.length}|${pad.buttons.length}`;
}

export function readBinding(pad: Gamepad, binding: PadBinding | null): number {
  if (!binding) return 0;
  const raw = binding.kind === "axis" ? pad.axes[binding.index] : pad.buttons[binding.index]?.value;
  if (raw === undefined || !Number.isFinite(raw)) return 0;
  return Math.max(0, Math.min(1, (raw - binding.rest) / (binding.end - binding.rest)));
}

export function validProfile(value: unknown): value is PadProfile {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return PAD_ACTIONS.every((action, index) => {
    const item = candidate[action];
    if (item === null) return index >= 4;
    if (!item || typeof item !== "object") return false;
    const b = item as PadBinding;
    return (b.kind === "axis" || b.kind === "button") && Number.isInteger(b.index) && b.index >= 0 && b.index < 128
      && Number.isFinite(b.rest) && Number.isFinite(b.end) && Math.abs(b.rest) <= 1 && Math.abs(b.end) <= 1
      && Math.abs(b.end - b.rest) >= 0.5;
  });
}

export class PadProfiles {
  private readonly cache = new Map<string, PadProfile | null>();
  get(pad: Gamepad): PadProfile | null {
    const key = padKey(pad);
    if (!this.cache.has(key)) {
      let profile: PadProfile | null = null;
      try {
        const saved: unknown = JSON.parse(localStorage.getItem(PREFIX + key) ?? "null");
        if (validProfile(saved)) profile = saved;
      } catch { /* Le jeu reste utilisable sans stockage. */ }
      this.cache.set(key, profile);
    }
    return this.cache.get(key) ?? null;
  }
  save(pad: Gamepad, profile: PadProfile): boolean {
    if (!validProfile(profile)) throw new Error("Profil manette incomplet");
    this.cache.set(padKey(pad), profile);
    try { localStorage.setItem(PREFIX + padKey(pad), JSON.stringify(profile)); return true; }
    catch { return false; }
  }
  reset(pad: Gamepad): boolean {
    this.cache.set(padKey(pad), null);
    try { localStorage.removeItem(PREFIX + padKey(pad)); return true; }
    catch { return false; }
  }
}
