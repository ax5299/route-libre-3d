import { chromium } from "playwright-core";

/**
 * Test décisif : les maillages peints en couleur de sommets (ciel, route, terrain)
 * rendent noir alors que la voiture (couleur de matériau) rend correctement.
 * On compare le rendu avec et sans `useVertexColors`, et on inspecte les attributs
 * du programme shader compilé.
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
await page.waitForTimeout(4000);

const points = [
  ["ciel", 0.5, 0.95],
  ["horizon", 0.5, 0.52],
  ["piste", 0.5, 0.12],
  ["sol", 0.08, 0.14],
];

const readPixels = async () =>
  page.evaluate(
    async (pts) => {
      const engine = window.game.engine;
      const scene = window.game.scene;
      const width = engine.getRenderWidth();
      const height = engine.getRenderHeight();
      const out = {};
      for (const [label, u, v] of pts) {
        scene.render();
        const x = Math.floor(u * (width - 4));
        const y = Math.floor(v * (height - 4));
        const data = new Uint8Array(await engine.readPixels(x, y, 2, 2, true));
        out[label] = "#" + [data[0], data[1], data[2]].map((c) => c.toString(16).padStart(2, "0")).join("");
      }
      return out;
    },
    points,
  );

const info = await page.evaluate(() => {
  const scene = window.game.scene;
  return ["sky-dome", "road", "terrain"].map((name) => {
    const mesh = scene.getMeshByName(name);
    const material = mesh.material;
    const effect = material.getEffect();
    return {
      name,
      useVertexColors: material.useVertexColors,
      disableLighting: material.disableLighting,
      hasVertexColorDefine: effect ? /VERTEXCOLOR/.test(effect.defines) : null,
      attributes: effect ? (effect._attributes || []).join(",") : null,
      vertexDataLength: mesh._vertexData ? mesh._vertexData.length : null,
      bufferKinds: mesh._positions ? "pos" : Object.keys(mesh).filter((k) => /_vertex|_buffer/i.test(k)).join(","),
    };
  });
});
console.log("shader/mesh :", JSON.stringify(info, null, 2));
console.log("couleurs avant :", await readPixels());

await page.evaluate(() => {
  for (const name of ["sky-dome", "road", "terrain"]) {
    const mesh = window.game.scene.getMeshByName(name);
    mesh.material.useVertexColors = false;
    mesh.material.diffuseColor.set(1, 1, 1);
    if (name !== "sky-dome") mesh.material.emissiveColor.set(0.4, 0.4, 0.4);
    else mesh.material.emissiveColor.set(0.2, 0.5, 0.9);
    mesh.material.markAsDirty?.(2048);
  }
});
await page.waitForTimeout(600);
console.log("couleurs sans useVertexColors :", await readPixels());
await page.screenshot({ path: ".smoke/iso-d-novc.png" });
await browser.close();
