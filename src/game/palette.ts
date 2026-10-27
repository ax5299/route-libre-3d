import { Color3 } from "@babylonjs/core/Maths/math.color";

/**
 * Identité visuelle « Route Libre 3D » : fin de journée dorée sur un plateau
 * de moyenne montagne. Toutes les couleurs sont définies et conservées en sRGB.
 *
 * Palette maison : aucune référence aux jeux ayant inspiré le projet.
 */

/**
 * Convertit une couleur hexadécimale sRGB en Color3, sans basculer en linéaire.
 *
 * Le prototype n'emploie que des StandardMaterial et laisse chaque matériau
 * appliquer l'image processing (imageProcessingConfiguration.applyByPostProcess
 * = false). Dans ce mode, le shader fait `toLinearSpace` → exposition → tone
 * mapping → `toGammaSpace` : un aller-retour quasi neutre qui suppose la
 * couleur déjà en sRGB. Pré-linéariser ici écrasait toute l'image (bitume et
 * ciel quasi noirs, caisses délavées).
 */
export const rgb = (hex: string): Color3 => {
  const v = hex.replace("#", "");
  return new Color3(
    parseInt(v.slice(0, 2), 16) / 255,
    parseInt(v.slice(2, 4), 16) / 255,
    parseInt(v.slice(4, 6), 16) / 255,
  );
};

/** Mélange deux couleurs (même espace que les entrées). */
export const mix = (a: Color3, b: Color3, t: number): Color3 =>
  Color3.Lerp(a, b, Math.max(0, Math.min(1, t)));

export const shade = (c: Color3, k: number): Color3 => c.scale(k);

export const PALETTE = {
  /** Ciel & lumière */
  skyZenith: rgb("#1f5f9c"),
  skyMiddle: rgb("#7fc3e8"),
  skyHorizon: rgb("#ffd7a5"),
  sunCore: rgb("#fff3d0"),
  sunGlow: rgb("#ffbe6a"),
  cloud: rgb("#fdf3e4"),
  cloudShade: rgb("#d8c6c0"),
  fog: rgb("#cfe0ea"),
  hazeFar: rgb("#b9cede"),

  /** Reliefs & sol */
  grassDeep: rgb("#5d7d48"),
  grassLight: rgb("#8aa860"),
  grassDry: rgb("#b7ac6f"),
  dirt: rgb("#a88865"),
  rock: rgb("#8b8378"),
  rockLight: rgb("#a89f93"),
  snow: rgb("#f3f6f8"),
  mountainBase: rgb("#6f7f86"),
  mountainTop: rgb("#cfd9e0"),

  /** Piste */
  asphalt: rgb("#3a3f47"),
  asphaltDark: rgb("#2f343b"),
  asphaltLight: rgb("#4a5058"),
  paintWhite: rgb("#f3f1ea"),
  paintYellow: rgb("#f2c14e"),
  curbRed: rgb("#d8503c"),
  coneOrange: rgb("#f2681c"),
  shoulder: rgb("#9d8b6e"),
  barrierSteel: rgb("#c9ced4"),
  barrierPost: rgb("#5b6068"),
  barrierRed: rgb("#d8503c"),
  barrierWhite: rgb("#f1f1ee"),

  /** Végétation */
  trunk: rgb("#6d4f38"),
  leafA: rgb("#4f7a45"),
  leafB: rgb("#6b9150"),
  leafC: rgb("#3f6b4c"),

  /** Grenouilles */
  frogGreen: rgb("#4f8f3f"),
  frogDark: rgb("#31612c"),
  frogEye: rgb("#efe9c8"),

  /** Voiture */
  carBody: rgb("#e8672f"),
  carBodyDark: rgb("#a8401a"),
  carTrim: rgb("#22262c"),
  carGlass: rgb("#26404d"),
  carLight: rgb("#fff6df"),
  carTail: rgb("#ff3b30"),
  tire: rgb("#1d1f22"),
  rim: rgb("#c8ccd2"),
} as const;
