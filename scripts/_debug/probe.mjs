import { chromium } from "playwright-core";

/**
 * Sonde de diagnostic visuel : démarre une course, relève l'état de la scène
 * (éclairage, ombres, defines des shaders) puis capture avant/après désactivation
 * des ombres pour isoler la cause d'un rendu trop sombre.
 */
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
await page.waitForTimeout(4500);

const report = await page.evaluate(() => {
  const g = window.game;
  const scene = g.scene;
  const cam = scene.activeCamera;
  const ipc = scene.imageProcessingConfiguration;
  const map = g.shadow.getShadowMap();
  const num = (c) => (c ? [+c.r.toFixed(3), +c.g.toFixed(3), +c.b.toFixed(3)] : null);
  const pick = /road|ground|grass|asphalt|sky|terrain|dirt|track/i;
  const meshes = scene.meshes
    .filter((m) => pick.test(m.name) && m.isEnabled())
    .slice(0, 10)
    .map((m) => {
      const material = m.material;
      const effect = material && material.getEffect ? material.getEffect() : null;
      return {
        name: m.name,
        recv: m.receiveShadows,
        vtxColor: m.isVerticesDataPresent("color"),
        mat: material ? material.name : null,
        diffuse: material ? num(material.diffuseColor) : null,
        emissive: material ? num(material.emissiveColor) : null,
        defines: effect ? (effect.defines || "").replace(/\s+/g, " ").slice(0, 220) : "aucun effect",
      };
    });
  return {
    ipc: { applyByPostProcess: ipc.applyByPostProcess, enabled: ipc.isEnabled, tone: ipc.toneMappingEnabled, exposure: ipc.exposure },
    clear: [scene.clearColor.r, scene.clearColor.g, scene.clearColor.b].map((v) => +v.toFixed(2)),
    fog: { mode: scene.fogMode, density: scene.fogDensity },
    camera: { minZ: cam.minZ, maxZ: cam.maxZ, layerMask: cam.layerMask, type: cam.getClassName() },
    lights: scene.lights.map((l) => ({ n: l.name, i: l.intensity, d: num(l.diffuse) })),
    shadow: {
      refresh: map ? map.refreshRate : null,
      casters: map && map.renderList ? map.renderList.length : null,
      darkness: g.shadow.darkness,
      ready: map ? map.isReady : null,
      receivers: g.shadowReceivers.length,
    },
    activeMeshes: scene.getActiveMeshes().length,
    totalMeshes: scene.meshes.length,
    meshes,
  };
});
console.log(JSON.stringify(report, null, 2));

await page.screenshot({ path: ".smoke/probe-before.png" });

// Sans ombres sur les receveurs : si l'image s'éclaircit, l'ombre map est en cause.
await page.evaluate(() => {
  for (const mesh of window.game.shadowReceivers) mesh.receiveShadows = false;
});
await page.waitForTimeout(700);
await page.screenshot({ path: ".smoke/probe-noshadow.png" });

await browser.close();