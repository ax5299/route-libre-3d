import { chromium } from "playwright-core";

/** Caméra levée vers le ciel + état de la fenêtre de rendu (barres noires éventuelles). */
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
await page.waitForFunction(() => window.game?.race?.phase === "racing", { timeout: 30_000 });
await page.waitForTimeout(600);

const info = await page.evaluate(() => {
  const scene = window.game.scene;
  const engine = window.game.scene.getEngine();
  const canvas = document.getElementById("renderCanvas");
  const cameras = (scene.activeCameras ?? [scene.activeCamera]).map((cam) => ({
    name: cam.name,
    viewport: cam.viewport ? [cam.viewport.x, cam.viewport.y, cam.viewport.width, cam.viewport.height] : null,
    layerMask: cam.layerMask,
    fov: +cam.fov.toFixed(3),
  }));
  // On lève la caméra principale pour voir le dôme.
  const main = (scene.activeCameras ?? [scene.activeCamera])[0];
  main.rotation.x = -0.55;
  return {
    cameras,
    render: {
      width: engine.getRenderWidth(),
      height: engine.getRenderHeight(),
      canvasClient: [canvas.clientWidth, canvas.clientHeight],
      canvasAttr: [canvas.width, canvas.height],
      hardwareScaling: engine.getHardwareScalingLevel(),
      devicePixelRatio: window.devicePixelRatio,
      cssSize: [canvas.getBoundingClientRect().width, canvas.getBoundingClientRect().height],
    },
  };
});
console.log(JSON.stringify(info, null, 2));
await page.waitForTimeout(900);
await page.screenshot({ path: ".smoke/sky-up.png" });
await browser.close();
