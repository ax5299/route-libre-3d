import { chromium } from "playwright-core";

/** Test décisif : culling désactivé sur route + terrain, capture sans le dôme. */
const browser = await chromium.launch({
  executablePath: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  headless: true,
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--mute-audio"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on("pageerror", (e) => console.log("PAGEERROR", e.message.slice(0, 300)));
await page.goto("http://127.0.0.1:5173/", { waitUntil: "domcontentloaded", timeout: 60_000 });
await page.waitForFunction(() => document.getElementById("boot")?.hidden === true, { timeout: 60_000 });
await page.click('#screen-home [data-action="play"]');
await page.waitForTimeout(3500);

await page.evaluate(() => {
  const scene = window.game.scene;
  scene.getMeshByName("sky-dome").isVisible = false;
  const mats = new Set();
  for (const name of ["road", "terrain", "road-lines", "mountains", "start-line"]) {
    const mesh = scene.getMeshByName(name);
    if (mesh && mesh.material) {
      mesh.material.backFaceCulling = false;
      mats.add(mesh.material.name);
    }
  }
  return [...mats];
});
await page.waitForTimeout(1200);
await page.screenshot({ path: ".smoke/cull-off.png" });
await browser.close();
