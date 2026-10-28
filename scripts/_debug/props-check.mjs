/** Compte les instances de décor posées sur la chaussée. */
import { existsSync } from "node:fs";
import { chromium } from "playwright-core";

const B = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];
const exe = B.find((p) => existsSync(p));
const browser = await chromium.launch({ executablePath: exe, headless: true, args: ["--mute-audio"] });
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
page.on("pageerror", (e) => console.log("PAGEERROR", e.message.slice(0, 200)));
await page.goto(process.env.SMOKE_URL ?? "http://127.0.0.1:5173/", { waitUntil: "domcontentloaded", timeout: 60_000 });
await page.waitForFunction(() => window.game?.scene, null, { timeout: 60_000 });

const res = await page.evaluate(() => {
  const g = window.game;
  const t = g.track;
  const roadHalf = t.roadHalf ?? 9;
  const shoulderHalf = t.shoulderHalf ?? 12.2;
  const bad = [];
  let onShoulder = 0;
  let count = 0;
  for (const src of g.scene.meshes) {
    if (!src.instances || !src.instances.length) continue;
    for (const m of src.instances) {
      if (!/fir-|broadleaf-|bush-|rock-|house-/.test(m.name)) continue;
      const p = m.getAbsolutePosition();
      if (!p) continue;
      count++;
      let best = Infinity;
      for (let i = 0; i < t.samples.length; i++) {
        const s = t.samples[i];
        const d = (s.x - p.x) ** 2 + (s.z - p.z) ** 2;
        if (d < best) best = d;
      }
      const d = Math.sqrt(best);
      if (d < roadHalf) bad.push({ n: m.name, d: +d.toFixed(1), x: Math.round(p.x), z: Math.round(p.z) });
      else if (d < shoulderHalf) onShoulder++;
    }
  }
  bad.sort((a, b) => a.d - b.d);
  return { total: count, surChaussee: bad.length, surAccotement: onShoulder, pires: bad.slice(0, 12) };
});
console.log(JSON.stringify(res, null, 2));
console.log(res.surChaussee === 0 ? "DECOR OK (aucun arbre sur la chaussée)" : "DECOR KO");
await browser.close();
process.exit(res.surChaussee === 0 ? 0 : 1);
