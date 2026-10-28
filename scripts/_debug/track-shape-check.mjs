/** Contrôles numériques du circuit Gilles-Villeneuve redessiné. */
import { existsSync } from "node:fs";
import { chromium } from "playwright-core";

const URL_PAGE = process.env.SMOKE_URL ?? "http://127.0.0.1:5173/";
const BROWSERS = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];
const executablePath = BROWSERS.find((p) => existsSync(p));
const browser = await chromium.launch({ executablePath, headless: true, args: ["--mute-audio"] });
const page = await browser.newPage();
await page.goto(URL_PAGE, { waitUntil: "domcontentloaded", timeout: 60_000 });
await page.waitForFunction(() => document.getElementById("boot")?.hidden === true, { timeout: 60_000 });
const r = await page.evaluate(() => {
  const t = window.game.track;
  let minX = 1e9;
  let maxX = -1e9;
  let minZ = 1e9;
  let maxZ = -1e9;
  let minR = 1e9;
  let minRX = 0;
  let minRZ = 0;
  const s = t.samples;
  for (let i = 0; i < s.length; i++) {
    minX = Math.min(minX, s[i].x);
    maxX = Math.max(maxX, s[i].x);
    minZ = Math.min(minZ, s[i].z);
    maxZ = Math.max(maxZ, s[i].z);
    const a = s[(i - 4 + s.length) % s.length];
    const b = s[i];
    const c = s[(i + 4) % s.length];
    const d1 = Math.hypot(b.x - a.x, b.z - a.z);
    const d2 = Math.hypot(c.x - b.x, c.z - b.z);
    const cross = (b.x - a.x) * (c.z - b.z) - (b.z - a.z) * (c.x - b.x);
    const chord = d1 + d2;
    if (chord > 1) {
      const rr = (d1 * d2 * chord) / (2 * Math.abs(cross) || 1e-9);
      if (rr < minR && Number.isFinite(rr)) {
        minR = rr;
        minRX = b.x;
        minRZ = b.z;
      }
    }
  }
  return {
    nom: t.circuit.label,
    tour: Math.round(t.totalLength),
    bbox: { dx: Math.round(maxX - minX), dz: Math.round(maxZ - minZ) },
    rayonMini: Math.round(minR),
    au: [Math.round(minRX), Math.round(minRZ)],
    ouest: Math.round(minX) < -900,
    portiques: t.checkpoints.length,
  };
});
const ok = r.tour > 3800 && r.tour < 4900 && r.bbox.dx > r.bbox.dz * 1.8 && r.ouest && r.rayonMini > 20;
console.log(JSON.stringify(r));
console.log(ok ? "FORME OK (île allongée E-O, épingle ouest, tour réaliste)" : "FORME KO");
await browser.close();
process.exit(ok ? 0 : 1);
