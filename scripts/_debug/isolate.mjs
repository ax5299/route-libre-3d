import { chromium } from "playwright-core";

/** Isole la cause du rendu noir : état des buffers de couleurs et captures ciblées. */
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
await page.waitForTimeout(4000);

const stats = await page.evaluate(() => {
  const scene = window.game.scene;
  const stat = (name) => {
    const mesh = scene.getMeshByName(name);
    if (!mesh) return { name, missing: true };
    const colors = mesh.getVerticesData("color");
    const positions = mesh.getVerticesData("position");
    let summary = null;
    if (colors && colors.length > 3) {
      const lo = [1, 1, 1, 1];
      const hi = [0, 0, 0, 0];
      for (let i = 0; i < colors.length; i += 4) {
        for (let c = 0; c < 4; c += 1) {
          lo[c] = Math.min(lo[c], colors[i + c]);
          hi[c] = Math.max(hi[c], colors[i + c]);
        }
      }
      const round = (a) => a.map((v) => +v.toFixed(3));
      summary = { count: colors.length / 4, lo: round(lo), hi: round(hi), first: round([...colors.slice(0, 4)]) };
      if (positions) {
        let top = 0;
        for (let i = 4; i < colors.length; i += 4) if (positions[i] > positions[top]) top = i;
        summary.topVertex = [+positions[top].toFixed(1), +positions[top + 1].toFixed(1), +positions[top + 2].toFixed(1)]
          .concat([...colors.slice(top, top + 4)].map((v) => +v.toFixed(3)));
      }
    }
    return {
      name,
      enabled: mesh.isEnabled(),
      visible: mesh.isVisible,
      layerMask: mesh.layerMask,
      colorCount: colors ? colors.length : 0,
      positionCount: positions ? positions.length : 0,
      summary,
    };
  };
  return {
    autoClear: scene.autoClear,
    clearColor: [scene.clearColor.r, scene.clearColor.g, scene.clearColor.b, scene.clearColor.a].map((v) => +v.toFixed(2)),
    cameras: (scene.activeCameras || [scene.activeCamera]).map((cam) => ({
      name: cam.name,
      mask: cam.layerMask,
      viewport: [cam.viewport.x, cam.viewport.y, cam.viewport.width, cam.viewport.height].map((v) => +v.toFixed(3)),
      autoClear: cam.autoClear,
    })),
    engine: {
      width: window.game.engine.getRenderWidth(),
      height: window.game.engine.getRenderHeight(),
      caps: { srgb: !!window.game.engine.getCaps().isSubTex2DArraySupported },
    },
    meshes: ["sky-dome", "terrain", "road", "road-lines"].map(stat),
  };
});
console.log(JSON.stringify(stats, null, 2));

await page.screenshot({ path: ".smoke/iso-a-full.png" });
await page.evaluate(() => {
  const sky = window.game.scene.getMeshByName("sky-dome");
  if (sky) sky.isVisible = false;
});
await page.waitForTimeout(400);
await page.screenshot({ path: ".smoke/iso-b-nosky.png" });
await page.evaluate(() => {
  const terrain = window.game.scene.getMeshByName("terrain");
  if (terrain) terrain.isVisible = false;
});
await page.waitForTimeout(400);
await page.screenshot({ path: ".smoke/iso-c-nosky-terrain.png" });
await browser.close();