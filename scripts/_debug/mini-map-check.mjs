/**
 * Vérifie le plan du circuit (canvas DOM) : tracé, portiques, arrivée,
 * trace de progression orange et triangle de la voiture qui se déplace.
 * Comptage de pixels via getImageData (rendu déterministe, pas de caméra 3D).
 * Usage : node scripts/_debug/mini-map-check.mjs
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
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto(URL_PAGE, { waitUntil: "domcontentloaded", timeout: 60_000 });
await page.waitForFunction(() => document.getElementById("boot")?.hidden === true, { timeout: 60_000 });
await page.click('#screen-home [data-action="play"]');
await page.waitForFunction(() => window.game?.race?.phase === "racing", { timeout: 60_000 });

const probe = () =>
  page.evaluate(() => {
    const cv = document.getElementById("hud-map");
    const style = getComputedStyle(cv);
    const ctx = cv.getContext("2d");
    const img = ctx.getImageData(0, 0, cv.width, cv.height).data;
    let gray = 0;
    let orange = 0;
    let cyan = 0;
    let yellow = 0;
    let red = 0;
    let rx = 0;
    let ry = 0;
    for (let i = 0; i < img.length; i += 4) {
      const r = img[i];
      const g = img[i + 1];
      const b = img[i + 2];
      const a = img[i + 3];
      if (a < 120) continue;
      if (r > 200 && g >= 75 && g <= 170 && b < 90) orange += 1;
      else if (r > 200 && g < 70 && b < 110) {
        red += 1;
        const px = (i / 4) % cv.width;
        const py = Math.floor(i / 4 / cv.width);
        rx += px;
        ry += py;
      } else if (r < 120 && g > 130 && b > 170) cyan += 1;
      else if (r > 200 && g > 160 && b < 130) yellow += 1;
      else if (Math.abs(r - 150) < 45 && Math.abs(g - 158) < 45 && Math.abs(b - 172) < 45) gray += 1;
    }
    return {
      trailLen: (window.game?.minimap?.trail?.length ?? -1) ?? -1,
      visible: style.display !== "none" && cv.clientWidth > 100,
      rect: { w: cv.clientWidth, h: cv.clientHeight, right: innerWidth - cv.getBoundingClientRect().right, top: cv.getBoundingClientRect().top },
      gray,
      orange,
      cyan,
      yellow,
      car: red > 12 ? { x: +(rx / red).toFixed(1), y: +(ry / red).toFixed(1), px: red } : null,
    };
  });

const a = await probe();
await page.keyboard.down("ArrowUp");
await page.waitForTimeout(8000);
await page.keyboard.up("ArrowUp");
const b = await probe();

const ok =
  a.visible &&
  a.rect.right < 30 &&
  a.rect.top < 30 &&
  b.gray > 800 &&
  b.cyan > 40 &&
  b.yellow > 60 &&
  b.car !== null &&
  a.car !== null &&
  b.orange > 80 &&
  (Math.abs(b.car.x - a.car.x) > 8 || Math.abs(b.car.y - a.car.y) > 8);
console.log(JSON.stringify({ avant: a, apres: b }));
console.log(ok ? "PLAN OK (coin haut droit, tracé+portiques+trace+voiture mobile)" : "PLAN KO");
await browser.close();
process.exit(ok ? 0 : 1);
