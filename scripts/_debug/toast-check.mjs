/**
 * Verifie que la boite de message HUD (toast « Portique 3/15 ») est a la meme
 * hauteur que les affichages du haut (bande de chips).
 */
import { existsSync } from "node:fs";
import { chromium } from "playwright-core";

const exe = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
].find(existsSync);
const browser = await chromium.launch({
  executablePath: exe,
  headless: true,
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--mute-audio"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
try {
  await page.goto("http://127.0.0.1:5173/", { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForFunction(() => window.game?.hud, null, { timeout: 40000 });
  await page.click('#screen-home [data-action="play"]');
  await page.waitForFunction(() => window.game.race.phase === "racing", null, { timeout: 15000 });
  const r = await page.evaluate(() => {
    window.game.hud.toast("Portique 3/15 · 0:42,11", 60000);
    const t = document.getElementById("hud-toast").getBoundingClientRect();
    const b = document.querySelector(".hud-top").getBoundingClientRect();
    const total = document.getElementById("hud-total").closest(".chip").getBoundingClientRect();
    return { t, b, total, vh: window.innerHeight };
  });
  const pct = (v) => ((v / r.vh) * 100).toFixed(1);
  console.log(`toast: x ${r.t.left.toFixed(0)}..${r.t.right.toFixed(0)}  y ${pct(r.t.top)}%..${pct(r.t.bottom)}%`);
  console.log(`chip Total: x ${r.total.left.toFixed(0)}..${r.total.right.toFixed(0)}  bande HUD: ${pct(r.b.top)}%..${pct(r.b.bottom)}%`);
  const align = r.t.top >= r.b.top - 2 && r.t.bottom <= r.b.bottom + 2;
  const aDroiteDeTotal = r.t.left >= r.total.right - 2;
  const ok = align && aDroiteDeTotal;
  console.log(`${align ? "ok  " : "FAIL"} boite dans la bande HUD`);
  console.log(`${aDroiteDeTotal ? "ok  " : "FAIL"} boite a droite de la chip Total`);
  await browser.close();
  process.exit(ok ? 0 : 1);
} catch (error) {
  console.error(error);
  await browser.close();
  process.exit(2);
}
