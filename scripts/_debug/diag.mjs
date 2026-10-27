import { chromium } from "playwright-core";

/** Diagnostic : identifie le maillage sous chaque point d'échantillon et l'effet des réglages. */
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

// Lecture synchrone des pixels via readPixels + picking CPU pour identifier le maillage concerné.
const readAll = async (label) =>
  page.evaluate(
    async (tag) => {
      const engine = window.game.engine;
      const scene = window.game.scene;
      const w = engine.getRenderWidth();
      const h = engine.getRenderHeight();
      const spots = [
        ["ciel-haut", 0.5, 0.95],
        ["ciel-bas", 0.5, 0.6],
        ["horizon", 0.5, 0.5],
        ["piste-proche", 0.5, 0.1],
        ["sol-gauche", 0.08, 0.2],
      ];
      const out = { tag, fog: [scene.fogColor.r, scene.fogColor.g, scene.fogColor.b].map((v) => +v.toFixed(2)) };
      for (const [name, u, v] of spots) {
        scene.render();
        const x = Math.floor(u * (w - 2));
        const y = Math.floor(v * (h - 2));
        const buf = new Uint8Array(8);
        let hex = "?";
        try {
          const promise = engine.readPixels(x, y, 1, 1, true);
          if (promise && promise.then) hex = "#" + [...new Uint8Array(await promise)].slice(0, 3).map((c) => c.toString(16).padStart(2, "0")).join("");
          else {
            engine.readPixels(x, y, 1, 1, true, (b) => {
              buf.set(new Uint8Array(b, 0, 8));
            });
            hex = "#" + [...buf.slice(0, 3)].map((c) => c.toString(16).padStart(2, "0")).join("");
          }
        } catch (error) {
          hex = "err " + String(error).slice(0, 40);
        }
        const picked = scene.pick(x, h - y, (m) => m.isVisible !== false && m.isEnabled());
        out[name] = { hex, mesh: picked && picked.hit ? picked.pickedMesh.name : "rien", dist: picked && picked.hit ? Math.round(picked.distance) : null };
      }
      return out;
    },
    label,
  );

console.log(JSON.stringify(await readAll("reference"), null, 2));
await page.evaluate(() => {
  window.game.scene.fogEnabled = false;
});
console.log(JSON.stringify(await readAll("brouillard coupe"), null, 2));
await page.evaluate(() => {
  window.game.scene.imageProcessingConfiguration.toneMappingEnabled = false;
  window.game.scene.imageProcessingConfiguration.exposure = 3;
});
console.log(JSON.stringify(await readAll("sans tonemapping expo 3"), null, 2));
await page.evaluate(() => {
  for (const light of window.game.scene.lights) light.intensity = 0;
  window.game.scene.imageProcessingConfiguration.exposure = 1;
});
console.log(JSON.stringify(await readAll("sans lumiere"), null, 2));
await page.screenshot({ path: ".smoke/iso-e-diag.png" });
await browser.close();
