/**
 * Determinne si les faces des prismes/boites de FacetBuilder sont visibles
 * depuis l'exterieur (sinon le backFaceCulling les rend « transparentes »).
 *
 * Dans la page du jeu (serveur de dev), on construit un prisme et une boite
 * rouges a l'ecart, une camera les regarde, on lit le pixel central du canvas :
 * couleur rouge = face visible ; couleur de fond = face cullee (inversee).
 */
import { existsSync } from "node:fs";
import { chromium } from "playwright-core";

const exe = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].find(existsSync);
const browser = await chromium.launch({
  executablePath: exe,
  headless: true,
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--mute-audio"],
});
const page = await browser.newPage({ viewport: { width: 640, height: 480 } });
page.on("pageerror", (e) => console.log(`  !! pageerror: ${e.message}`));

const result = await (async () => {
  await page.goto("http://127.0.0.1:5173/", { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForFunction(() => window.game?.scene, null, { timeout: 40000 });
  return page.evaluate(async () => {
  const game = window.game;
  const { scene, engine } = game;
  const { FacetBuilder } = await import("/src/game/geometry.ts");
  const { rgb } = await import("/src/game/palette.ts");
  const mat = scene.getMaterialByName("car-trim-mat");
  const red = rgb("#ff0000");
  const sceneClear = scene.clearColor;
  const prevClear = { r: sceneClear.r, g: sceneClear.g, b: sceneClear.b, a: sceneClear.a };
  scene.clearColor.set(0, 0, 0, 1);
  scene.fogMode = 0;

  const probe = (make, label) => {
    const mesh = make(new FacetBuilder(), red).toMesh(scene, `probe-${label}`);
    if (!mesh) return { label, error: "null" };
    mesh.material = mat;
    mesh.position.set(0, 9000, 0);
    mesh.isPickable = false;
    const cam = game.rig.chase;
    const prevPos = cam.position.clone();
    const prevRot = { x: cam.rotation.x, y: cam.rotation.y, z: cam.rotation.z };
    const prevFov = cam.fov;
    const prevMinZ = cam.minZ;
    const prevMaxZ = cam.maxZ;
    const prevMask = cam.layerMask;
    cam.position.set(0, 9000.5, -8);
    cam.rotation.set(Math.atan2(0.5, 8), 0, 0);
    cam.fov = 0.6;
    cam.minZ = 0.05;
    cam.maxZ = 20000;
    cam.layerMask = 0x00000001;
    scene.activeCamera = cam;
    scene.activeCameras = [cam];
    scene.render();
    scene.render();
    // Lecture par canvas 2D (readPixels renvoie null avec SwiftShader ici)
    const canvas = engine.getRenderingCanvas();
    const c2 = document.createElement("canvas");
    c2.width = canvas.width;
    c2.height = canvas.height;
    const ctx = c2.getContext("2d");
    ctx.drawImage(canvas, 0, 0);
    const w = canvas.width;
    const h = canvas.height;
    const d = ctx.getImageData(Math.floor(w / 2), Math.floor(h / 2), 1, 1).data;
    const r = d[0];
    const g = d[1];
    const b = d[2];
    mesh.dispose(false, false);
    cam.position.copyFrom(prevPos);
    cam.rotation.set(prevRot.x, prevRot.y, prevRot.z);
    cam.fov = prevFov;
    cam.minZ = prevMinZ;
    cam.maxZ = prevMaxZ;
    cam.layerMask = prevMask;
    return { label, px: [r, g, b] };
  };

  const prism = probe((fb, c) => fb.prism({ radius: 2, height: 3, segments: 12 }, c), "prisme");
  const box = probe((fb, c) => fb.box({ w: 3, h: 3, d: 3 }, c), "boite");
  const cone = probe((fb, c) => fb.cone({ radius: 2, height: 3, segments: 12 }, c, c), "cone");
  const disc = probe((fb, c) => fb.disc({ rx: 2, ry: 1, segments: 16 }, c, c), "disque");
  scene.clearColor.set(prevClear.r, prevClear.g, prevClear.b, prevClear.a);
  return { prism, box, cone, disc };
  });
})();

console.log(JSON.stringify(result));
await browser.close();
