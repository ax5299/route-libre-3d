import { chromium } from "playwright-core";

/**
 * Compare le bobinage géométrique des triangles (règle de la main droite) aux
 * normales stockées : Babylon est handed-gauche et considère les faces horaires
 * comme avant. Un désaccord massif explique une surface invisibles (back-face culling).
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
await page.waitForTimeout(3500);

const result = await page.evaluate(() => {
  const scene = window.game.scene;
  const check = (mesh) => {
    const pos = mesh.getVerticesData("position");
    const nor = mesh.getVerticesData("normal");
    const idx = mesh.getIndices();
    if (!pos || !nor || !idx) return { name: mesh.name, skipped: true };
    let agree = 0;
    let disagree = 0;
    const limit = Math.min(idx.length, 60000);
    for (let t = 0; t + 2 < limit; t += 3) {
      const a = idx[t] * 3;
      const b = idx[t + 1] * 3;
      const c = idx[t + 2] * 3;
      const ux = pos[b] - pos[a];
      const uy = pos[b + 1] - pos[a + 1];
      const uz = pos[b + 2] - pos[a + 2];
      const vx = pos[c] - pos[a];
      const vy = pos[c + 1] - pos[a + 1];
      const vz = pos[c + 2] - pos[a + 2];
      const cx = uy * vz - uz * vy;
      const cy = uz * vx - ux * vz;
      const cz = ux * vy - uy * vx;
      const dot = cx * nor[a] + cy * nor[a + 1] + cz * nor[a + 2];
      if (dot > 0) agree += 1;
      else if (dot < 0) disagree += 1;
    }
    return { name: mesh.name, agree, disagree, verdict: agree > disagree ? "main droite (= CCW)" : "main gauche (= CW, attendu Babylon)" };
  };
  const interesting = scene.meshes.filter((m) => /^(road|terrain|road-lines|sky-dome|barrier|mountain|start|gate|arch)/i.test(m.name) && m.getIndices());
  const seen = new Set();
  const list = [];
  for (const mesh of interesting) {
    const key = mesh.name.replace(/-\d+$/, "");
    if (seen.has(key)) continue;
    seen.add(key);
    list.push(check(mesh));
    if (list.length >= 10) break;
  }
  return list;
});
console.table(result);
await browser.close();
