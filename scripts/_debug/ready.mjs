import { chromium } from "playwright-core";

/** Collecte les logs console Babylon et l'état de préparation des shaders des maillages clés. */
const browser = await chromium.launch({
  executablePath: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  headless: true,
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--mute-audio"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const logs = [];
page.on("console", (msg) => logs.push(`[${msg.type()}] ${msg.text().slice(0, 400)}`));
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message.slice(0, 300)}`));

await page.goto("http://127.0.0.1:5173/", { waitUntil: "domcontentloaded", timeout: 60_000 });
await page.waitForFunction(() => document.getElementById("boot")?.hidden === true, { timeout: 60_000 });
await page.click('#screen-home [data-action="play"]');
await page.waitForTimeout(4000);

const state = await page.evaluate(() => {
  const scene = window.game.scene;
  const active = new Set(scene.getActiveMeshes().data.map((m) => m.name));
  const report = ["sky-dome", "terrain", "road", "road-lines", "start-line"].map((name) => {
    const mesh = scene.getMeshByName(name) || scene.meshes.find((m) => m.name.startsWith(name));
    if (!mesh) return { name, missing: true };
    const material = mesh.material;
    return {
      name: mesh.name,
      inActiveList: active.has(mesh.name),
      visible: mesh.isVisible,
      visibility: mesh.visibility,
      enabled: mesh.isEnabled(),
      parent: mesh.parent ? `${mesh.parent.name}:${mesh.parent.isEnabled()}` : "aucun",
      indices: mesh.getTotalIndices(),
      vertices: mesh.getTotalVertices(),
      meshReady: mesh.isReady(),
      materialReady: material ? material.isReady(mesh, false) : null,
      materialClass: material ? material.getClassName() : null,
      alpha: material ? material.alpha : null,
      alphaMode: material ? material.alphaMode : null,
      backFaceCulling: material ? material.backFaceCulling : null,
      twoSidedLighting: material ? material.twoSidedLighting : null,
      needAlphaBlending: material ? material.needAlphaBlending() : null,
      fogEnabled: material ? material.fogEnabled : null,
      bounding: mesh.getBoundingInfo().boundingBox.extendSize.asArray().map((v) => Math.round(v)),
      center: mesh.getBoundingInfo().boundingBox.centerWorld.asArray().map((v) => Math.round(v)),
      billboard: mesh.billboardMode,
      positionsSample: (mesh.getVerticesData("position") || []).slice(0, 6).map((v) => +v.toFixed(2)),
    };
  });
  const cam = scene.activeCameras[0];
  return {
    camera: { name: cam.name, pos: cam.position.asArray().map((v) => +v.toFixed(1)), fov: +cam.fov.toFixed(2), minZ: cam.minZ, maxZ: cam.maxZ },
    activeCount: active.size,
    report,
  };
});
console.log(JSON.stringify(state, null, 2));
console.log("--- console ---");
console.log(logs.slice(0, 40).join("\n") || "(aucun log)");
await browser.close();
