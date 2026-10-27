import { chromium } from "playwright-core";

/**
 * Lit directement les pixels du framebuffer WebGL (readPixels) pour connaître la
 * couleur réellement produite par le rendu, indépendamment de la capture d'écran.
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

const samples = await page.evaluate(async () => {
  const engine = window.game.engine;
  const scene = window.game.scene;
  const width = engine.getRenderWidth();
  const height = engine.getRenderHeight();
  const hex = (data, offset) =>
    "#" + [data[offset], data[offset + 1], data[offset + 2]].map((v) => v.toString(16).padStart(2, "0")).join("");

  const read = async (u, v) => {
    scene.render();
    const x = Math.floor(u * (width - 4));
    const y = Math.floor(v * (height - 4)); // origine GL en bas à gauche
    let data;
    try {
      data = new Uint8Array(await engine.readPixels(x, y, 2, 2, true));
    } catch {
      let out;
      engine.readPixels(x, y, 2, 2, true, (buffer) => (out = buffer));
      data = new Uint8Array(out);
    }
    return { xy: `${x},${y}`, hex: hex(data, 0) };
  };

  return {
    size: `${width}x${height}`,
    preserveDrawingBuffer: !!engine._creationOptions?.preserveDrawingBuffer,
    sky: await read(0.5, 0.95),
    skyLow: await read(0.5, 0.62),
    horizon: await read(0.5, 0.52),
    roadNear: await read(0.5, 0.08),
    roadMid: await read(0.42, 0.3),
    groundLeft: await read(0.08, 0.14),
    groundRight: await read(0.92, 0.2),
  };
});
console.log(JSON.stringify(samples, null, 2));
await browser.close();
