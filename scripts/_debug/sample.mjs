import { chromium } from "playwright-core";

/** Échantillonne des pixels d'une capture PNG servie en statique par Vite. */
const file = process.argv[2] ?? "_sample.png";
const browser = await chromium.launch({
  executablePath: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  headless: true,
});
const page = await browser.newPage();
await page.goto("http://127.0.0.1:5173/", { waitUntil: "domcontentloaded", timeout: 60_000 });
const points = await page.evaluate(
  async ([src, spots]) => {
    const response = await fetch(src);
    const blob = await response.blob();
    const image = await createImageBitmap(blob);
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(image, 0, 0);
    return spots.map(([label, x, y]) => {
      const d = ctx.getImageData(x, y, 1, 1).data;
      return { label, x, y, rgb: [d[0], d[1], d[2]] };
    });
  },
  [`/${file}`, [
    ["ciel haut", 640, 40],
    ["ciel milieu", 300, 90],
    ["ciel droit", 1150, 80],
    ["horizon", 700, 96],
    ["route centre", 640, 300],
    ["route droite", 1050, 260],
    ["herbe gauche", 90, 210],
    ["bitume bas", 300, 560],
    ["caisse voiture", 640, 650],
  ]],
);
console.table(points);
await browser.close();
