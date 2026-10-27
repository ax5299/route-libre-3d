import { readFileSync } from "node:fs";
import { chromium } from "playwright-core";

/**
 * Échantillonne des pixels d'une capture d'écran PNG (décodage via un canvas 2D
 * dans le navigateur) pour juger objectivement les couleurs rendues.
 * Usage : node scripts/pixels.mjs [.smoke/probe-before.png]
 */
const file = process.argv[2] ?? ".smoke/probe-before.png";
const data = readFileSync(file).toString("base64");

const browser = await chromium.launch({
  executablePath: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  headless: true,
});
const page = await browser.newPage();
await page.goto("about:blank");

const points = [
  ["ciel en haut", 0.5, 0.06],
  ["ciel au-dessus de l'horizon", 0.5, 0.4],
  ["horizon", 0.5, 0.5],
  ["piste devant la voiture", 0.5, 0.92],
  ["piste à mi-distance", 0.35, 0.68],
  ["sol hors piste (gauche)", 0.08, 0.86],
  ["sol hors piste (droite)", 0.92, 0.8],
  ["lointain", 0.8, 0.52],
];

const samples = await page.evaluate(
  async ([b64, pts]) => {
    const image = new Image();
    image.src = `data:image/png;base64,${b64}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(image, 0, 0);
    return pts.map(([label, u, v]) => {
      const x = Math.round(u * (canvas.width - 1));
      const y = Math.round(v * (canvas.height - 1));
      const [r, g, b] = ctx.getImageData(x, y, 1, 1).data;
      const hex = "#" + [r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("");
      return { label, xy: `${x},${y}`, hex };
    });
  },
  [data, points],
);

console.log(`${file} — échantillons :`);
for (const sample of samples) {
  console.log(`  ${sample.label.padEnd(30)} ${sample.xy.padStart(9)}  ${sample.hex}`);
}
await browser.close();