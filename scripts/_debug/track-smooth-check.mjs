/**
 * Fluidité de l'axe : échantillonne headingAt/positionAt le long d'une
 * portion de circuit et mesure le saut maximal (seconde différence).
 * Un axe sans interpolation montre des à-coups à chaque échantillon (2 m).
 * Usage : node scripts/_debug/track-smooth-check.mjs
 */
import { existsSync } from "node:fs";
import { chromium } from "playwright-core";

const URL_PAGE = process.env.SMOKE_URL ?? "http://127.0.0.1:5173/";
const BROWSERS = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];
const executablePath = BROWSERS.find((p) => existsSync(p));
if (!executablePath) {
  console.error("Edge introuvable.");
  process.exit(2);
}
const browser = await chromium.launch({ executablePath, headless: true, args: ["--mute-audio"] });
const page = await browser.newPage();
await page.goto(URL_PAGE, { waitUntil: "domcontentloaded", timeout: 60_000 });
await page.waitForFunction(() => document.getElementById("boot")?.hidden === true, { timeout: 60_000 });

const report = await page.evaluate(() => {
  const track = window.game.track;
  const H = [];
  const P = [];
  for (let s = 60; s < 940; s += 0.1) {
    H.push(track.headingAt(s));
    P.push(track.positionAt(s, 4));
  }
  const unwrap = (list) => {
    const out = [list[0]];
    for (let i = 1; i < list.length; i++) {
      let d = list[i] - list[i - 1];
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      out.push(out[i - 1] + d);
    }
    return out;
  };
  const Hu = unwrap(H);
  let maxHeadingJump = 0;
  let maxPosJump = 0;
  for (let i = 1; i < Hu.length - 1; i++) {
    maxHeadingJump = Math.max(maxHeadingJump, Math.abs(Hu[i + 1] - 2 * Hu[i] + Hu[i - 1]));
    const dx = P[i + 1].x - 2 * P[i].x + P[i - 1].x;
    const dy = P[i + 1].y - 2 * P[i].y + P[i - 1].y;
    const dz = P[i + 1].z - 2 * P[i].z + P[i - 1].z;
    maxPosJump = Math.max(maxPosJump, Math.hypot(dx, dy, dz));
  }
  return { maxHeadingJump, maxPosJump };
});
// Seuil : la courbure naturelle du circuit donne un résidu de ~1e-3 rad sur un
// pas de 0,1 m ; un retour au snap sans interpolation donnerait ~2e-2 (κ×2 m).
const ok = report.maxHeadingJump < 4e-3 && report.maxPosJump < 1.5e-2;
console.log(JSON.stringify(report), ok ? "-> AXE FLUIDE" : "-> À-COUPS DÉTECTÉS");
await browser.close();
process.exit(ok ? 0 : 1);
