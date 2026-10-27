import { chromium } from "playwright-core";

/** Rend chaque maillage suspect isolément pour vérifier s'il est réellement dessiné. */
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
  return ["road", "terrain", "sky-dome", "road-lines"].map((name) => {
    const mesh = window.game.scene.getMeshByName(name);
    const indices = mesh.getIndices();
    let max = 0;
    for (let i = 0; i < indices.length; i += 1) if (indices[i] > max) max = indices[i];
    const colors = mesh.getVerticesData("color");
    const normals = mesh.getVerticesData("normal");
    return {
      name,
      indexType: indices.constructor.name,
      indexCount: indices.length,
      maxIndex: max,
      vertexCount: mesh.getTotalVertices(),
      hasNormals: !!normals,
      normalSample: normals ? normals.slice(0, 6) : null,
      colorSample: colors ? colors.slice(0, 8) : null,
      material: mesh.material.name,
      shadows: mesh.receiveShadows,
    };
  });
});
console.log(JSON.stringify(stats, null, 2));

const solo = async (name) => {
  await page.evaluate((target) => {
    for (const mesh of window.game.scene.meshes) mesh.isVisible = mesh.name === target;
    const mesh = window.game.scene.getMeshByName(target);
    if (mesh) {
      mesh.isVisible = true;
      mesh.material.emissiveColor.set(1, 0, 0);
      mesh.alwaysSelectAsActiveMesh = true;
    }
  }, name);
  await page.waitForTimeout(350);
  await page.screenshot({ path: `.smoke/solo-${name}.png` });
};
await page.evaluate(() => {
  for (const mesh of window.game.scene.meshes) mesh.isVisible = false;
});
await solo("road");
await solo("terrain");
await browser.close();
