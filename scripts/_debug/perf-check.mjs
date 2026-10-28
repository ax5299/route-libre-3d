/**
 * Mesure la charge en vue de course : fps, meshes actifs, matériaux, triangles.
 * Compare trafic 24 vs trafic 0 pour isoler le coût du trafic.
 * Usage : node scripts/_debug/perf-check.mjs   (serveur de dev requis)
 */
import { existsSync } from "node:fs";
import { chromium } from "playwright-core";

const URL_PAGE = process.env.SMOKE_URL ?? "http://127.0.0.1:5173/";
const BROWSERS = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
];
const executablePath = BROWSERS.find((path) => existsSync(path));
if (!executablePath) {
  console.error("Navigateur Chromium introuvable.");
  process.exit(2);
}

const browser = await chromium.launch({
  executablePath,
  headless: true,
  args: ["--mute-audio"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on("pageerror", (e) => console.log("pageerror:", e.message));
await page.goto(URL_PAGE, { waitUntil: "domcontentloaded", timeout: 60_000 });
await page.waitForFunction(() => document.getElementById("boot")?.hidden === true, { timeout: 60_000 });
await page.click('#screen-home [data-action="play"]');
await page.waitForFunction(() => window.game?.race?.phase === "racing", { timeout: 60_000 });
await page.keyboard.down("ArrowUp");
await page.waitForTimeout(3000);

const measure = () =>
  page.evaluate(() => {
    const g = window.game;
    return {
      fps: Math.round(g.engine.getFps()),
      meshesActifs: g.scene.getActiveMeshes().length,
      materiaux: g.scene.materials.length,
      voituresTrafic: g.traffic.list.length,
    };
  });

const avec24 = await measure();
await page.evaluate(() => {
  const g = window.game;
  g.traffic.setCount(0);
});
await page.waitForTimeout(2000);
const sansTrafic = await measure();
await page.keyboard.up("ArrowUp");
console.log(JSON.stringify({ avecTrafic: avec24, sansTrafic }, null, 1));
await browser.close();
