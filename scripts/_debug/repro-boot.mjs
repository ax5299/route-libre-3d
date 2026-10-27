/**
 * Diagnostic de démarrage : compare l'ouverture de la page en file:// (double-clic
 * sur index.html) et via le serveur de dev (http://127.0.0.1:5173/).
 * Utilisé pour comprendre l'écran bloqué sur "Préparation du circuit…".
 */
import { existsSync, mkdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";

const ROOT = process.cwd();
const BROWSERS = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
];
const executablePath = BROWSERS.find((p) => existsSync(p));
if (!executablePath) {
  console.error("Navigateur Chromium introuvable.");
  process.exit(2);
}
mkdirSync(".smoke", { recursive: true });

const targets = [
  { name: "file-src", url: pathToFileURL(`${ROOT}/index.html`).href },
  { name: "file-dist", url: pathToFileURL(`${ROOT}/dist/index.html`).href },
  { name: "dev", url: process.env.SMOKE_URL ?? "http://127.0.0.1:5173/", wait: 30_000 },
];

const browser = await chromium.launch({
  executablePath,
  headless: true,
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--mute-audio"],
});

for (const target of targets) {
  const page = await browser.newPage({ viewport: { width: 1000, height: 620 } });
  const logs = [];
  page.on("console", (m) => logs.push(`${m.type()}: ${m.text()}`.slice(0, 220)));
  page.on("pageerror", (e) => logs.push(`pageerror: ${String(e.message).slice(0, 220)}`));
  page.on("requestfailed", (r) =>
    logs.push(`requestfailed: ${r.url().slice(0, 120)} :: ${r.failure()?.errorText ?? "?"}`),
  );
  console.log(`\n===== ${target.name} :: ${target.url}`);
  try {
    const res = await page.goto(target.url, { waitUntil: "load", timeout: 30_000 });
    console.log(`   statut=${res?.status() ?? "n/a"}`);
  } catch (error) {
    console.log(`   goto KO: ${String(error).slice(0, 200)}`);
  }
  await page.waitForTimeout(target.wait ?? 9000);
  const state = await page.evaluate(() => {
    const boot = document.getElementById("boot");
    const canvas = document.getElementById("renderCanvas");
    const home = document.getElementById("screen-home");
    const cssRules = [...document.styleSheets].reduce((n, s) => {
      try {
        return n + (s.cssRules?.length ?? 0);
      } catch {
        return n + -1;
      }
    }, 0);
    return {
      bootHidden: boot?.hidden ?? null,
      bootText: boot?.textContent?.trim().slice(0, 140) ?? null,
      guard: !!document.getElementById("boot-guard"),
      alertClass: boot?.classList.contains("alert") ?? null,
      homeVisible: home ? !home.hasAttribute("hidden") : null,
      canvasW: canvas?.width ?? null,
      hasGame: typeof window.game !== "undefined",
      styleSheets: document.styleSheets.length,
      cssRules,
      bodyFont: getComputedStyle(document.body).fontFamily.slice(0, 60),
      viteClient: !!document.querySelector('script[src*="@vite/client"]'),
      scripts: [...document.querySelectorAll("script[src]")].map((s) => s.getAttribute("src")).slice(0, 4),
    };
  });
  console.log("   etat:", JSON.stringify(state));
  console.log(`   logs (${logs.length}):`);
  for (const line of logs.slice(0, 8)) console.log("     " + line);
  await page.screenshot({ path: `.smoke/repro-${target.name}.png` });
  await page.close();
}

await browser.close();
