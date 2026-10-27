import { chromium } from "playwright-core";

/** Caméra témoin placée dehors pour juger la géométrie + matrices monde des maillages. */
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

const info = await page.evaluate(() => {
  const scene = window.game.scene;
  const round = (a) => a.map((v) => +v.toFixed(2));
  const lines = ["road", "terrain", "sky-dome"].map((name) => {
    const mesh = scene.getMeshByName(name);
    const box = mesh.getBoundingInfo().boundingBox;
    return {
      name,
      scaling: round(mesh.scaling.asArray()),
      position: round(mesh.position.asArray()),
      world: round(mesh.getWorldMatrix().asArray()),
      minWorld: round(box.minimumWorld.asArray()),
      maxWorld: round(box.maximumWorld.asArray()),
      parentChain: (() => {
        const chain = [];
        let node = mesh.parent;
        while (node) {
          chain.push(`${node.name}[${node.scaling.asArray().map((v) => +v.toFixed(3)).join(",")}|${node.position.asArray().map((v) => Math.round(v)).join(",")}]`);
          node = node.parent;
        }
        return chain.join(" <- ");
      })(),
    };
  });
  return {
    lines,
    car: window.game.car && window.game.car.position ? round(window.game.car.position.asArray()) : null,
    chase: {
      pos: round(scene.activeCameras[0].position.asArray()),
      rotation: round(scene.activeCameras[0].rotation.asArray()),
      fov: +scene.activeCameras[0].fov.toFixed(3),
      minZ: scene.activeCameras[0].minZ,
      maxZ: scene.activeCameras[0].maxZ,
    },
  };
});
console.log(JSON.stringify(info, null, 2));

await page.evaluate(() => {
  const scene = window.game.scene;
  const reference = scene.activeCameras ? scene.activeCameras[0] : scene.activeCamera;
  const Ctor = reference.constructor;
  const cam = new Ctor("witness", reference.position.clone());
  cam.position.set(-70, 30, -110);
  cam.setTarget(reference.position.clone().set(0, 2, 0));
  cam.minZ = 0.1;
  cam.maxZ = 4000;
  cam.fov = 0.8;
  cam.layerMask = 0x00000001;
  if (window.game.rig) window.game.rig.applyTo = () => {};
  scene.activeCameras = null;
  scene.activeCamera = cam;
  cam.attach();
});
await page.waitForTimeout(800);
await page.screenshot({ path: ".smoke/witness.png" });
await browser.close();
