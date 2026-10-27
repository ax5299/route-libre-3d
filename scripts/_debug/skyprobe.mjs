import { chromium } from "playwright-core";

/** Sonde le dôme céleste (couleurs de sommets, defines) puis teste des couleurs témoins. */
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

const probe = await page.evaluate(() => {
  const scene = window.game.scene;
  const dome = scene.getMeshByName("sky-dome");
  const mat = dome.material;
  const colors = dome.getVerticesData("color");
  const positions = dome.getVerticesData("position");
  const bounds = [0, 0, 0, 0];
  let top = -Infinity;
  let topIndex = 0;
  for (let i = 0; i < colors.length; i += 4) {
    bounds[0] = Math.min(bounds[0], colors[i], colors[i + 1], colors[i + 2]);
    bounds[1] = Math.max(bounds[1], colors[i], colors[i + 1], colors[i + 2]);
    const y = positions[i / 4 * 3 + 1];
    if (y > top) {
      top = y;
      topIndex = i;
    }
  }
  const effect = mat.getActiveEffect ? mat.getActiveEffect() : mat.effect;
  return {
    material: {
      disableLighting: mat.disableLighting,
      useVertexColors: mat.useVertexColors,
      emissive: mat.emissiveColor.asArray().map((v) => +v.toFixed(3)),
      diffuse: mat.diffuseColor.asArray().map((v) => +v.toFixed(3)),
      alpha: mat.alpha,
      backFaceCulling: mat.backFaceCulling,
      sideOrientation: mat.sideOrientation,
      fogEnabled: mat.fogEnabled,
      checkReady: mat.isReady(dome, false),
      needRebuild: mat.needRebuild,
    },
    dome: {
      vertexCount: positions.length / 3,
      colorMin: +bounds[0].toFixed(3),
      colorMax: +bounds[1].toFixed(3),
      topY: Math.round(top),
      topColor: [colors[topIndex], colors[topIndex + 1], colors[topIndex + 2], colors[topIndex + 3]].map((v) => +v.toFixed(3)),
      bottomColor: (() => {
        let low = Infinity;
        let idx = 0;
        for (let i = 0; i < positions.length / 3; i++) {
          if (positions[i * 3 + 1] < low) {
            low = positions[i * 3 + 1];
            idx = i * 4;
          }
        }
        return [colors[idx], colors[idx + 1], colors[idx + 2]].map((v) => +v.toFixed(3));
      })(),
      infiniteDistance: dome.infiniteDistance,
      isBlocked: dome.isBlocked,
      isEnabled: dome.isEnabled(),
      renderingGroupId: dome.renderingGroupId,
      visibility: dome.visibility,
    },
    defines: (effect && effect.getDefines ? String(effect.getDefines()) : "n/a").slice(0, 900),
    clearColor: scene.clearColor.asArray(),
    fogColor: scene.fogColor.asArray().map((v) => +v.toFixed(3)),
  };
});
console.log(JSON.stringify(probe, null, 2));

const paint = (mode) => {
  return page.evaluate((kind) => {
    const scene = window.game.scene;
    const dome = scene.getMeshByName("sky-dome");
    const mat = dome.material;
    if (kind === "green") {
      mat.emissiveColor.set(0, 1, 0);
    } else if (kind === "red-vertices") {
      mat.emissiveColor.set(1, 1, 1);
      const colors = dome.getVerticesData("color");
      for (let i = 0; i < colors.length; i += 4) {
        colors[i] = 1;
        colors[i + 1] = 0.1;
        colors[i + 2] = 0.1;
      }
      dome.setVerticesData("color", colors, true);
      mat.markAllAsDirty();
    } else if (kind === "hidden") {
      dome.isVisible = false;
    }
  }, mode);
};

for (const mode of ["green", "red-vertices", "hidden"]) {
  await paint(mode);
  await page.waitForTimeout(700);
  await page.screenshot({ path: `.smoke/sky-${mode}.png` });
}
await browser.close();
