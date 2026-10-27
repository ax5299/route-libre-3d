/**
 * Test de fumée : lance le prototype dans un vrai navigateur (Edge ou Chrome en
 * tête de liste), joue une courte séquence (menu -> compte à rebours -> conduite
 * -> caméra -> pause -> réglages -> retour menu) et vérifie qu'aucune erreur
 * console n'est apparue. Les captures et le rapport sont écrits dans `.smoke/`.
 *
 * Le serveur de développement doit déjà tourner : `npm run dev` puis `npm run smoke`.
 * Variable d'environnement : SMOKE_URL (défaut http://127.0.0.1:5173/).
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "playwright-core";

const URL_PAGE = process.env.SMOKE_URL ?? "http://127.0.0.1:5173/";
const OUT_DIR = ".smoke";
const BROWSERS = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
];

const executablePath = BROWSERS.find((path) => existsSync(path));
if (!executablePath) {
  console.error("Navigateur Chromium (Edge ou Chrome) introuvable sur cette machine.");
  process.exit(2);
}

mkdirSync(OUT_DIR, { recursive: true });
const checks = [];
const logs = [];

const check = (name, expected, actual) => {
  const ok = typeof expected === "function" ? expected(actual) : actual === expected;
  checks.push({ name, ok, expected: String(expected), actual: String(actual) });
  console.log(`${ok ? "  ok  " : " FAIL "} ${name} -> ${String(actual)}`);
};

const browser = await chromium.launch({
  executablePath,
  headless: true,
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--mute-audio"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

page.on("console", (message) => logs.push(`${message.type()}: ${message.text()}`));
page.on("pageerror", (error) =>
  logs.push(`pageerror: ${error.message}\n${(error.stack ?? "").split("\n").slice(0, 4).join("\n")}`),
);
page.on("requestfailed", (request) =>
  logs.push(`requestfailed: ${request.url()} ${request.failure()?.errorText ?? ""}`),
);

const shot = (name) => page.screenshot({ path: `${OUT_DIR}/${name}.png` });
const visible = (selector) =>
  page.evaluate((css) => {
    const node = document.querySelector(css);
    if (!node) return "missing";
    const style = getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return "hidden";
    if (node.hasAttribute("hidden")) return "visible (hidden CSS surchargé)";
    return "visible";
  }, selector);
const text = (selector) =>
  page.evaluate((css) => document.querySelector(css)?.textContent ?? "", selector);
/** Lecture d'une valeur dans l'objet jeu exposé par `src/main.ts` (propriété `game`). */
const fromGame = (path, fallback = null) =>
  page.evaluate(
    ([target, dotted, defaultValue]) => {
      const root = window[target];
      if (!root) return null;
      const value = dotted.split(".").reduce((acc, key) => (acc == null ? acc : acc[key]), root);
      return value == null ? defaultValue : value;
    },
    ["game", path, fallback],
  );

console.log(`-> ${URL_PAGE} (${executablePath})`);
const response = await page.goto(URL_PAGE, { waitUntil: "domcontentloaded", timeout: 60_000 });
console.log(`   statut ${response?.status() ?? "?"} · url ${page.url()} · titre "${await page.title()}"`);
console.log(
  `   #screen-home ${await page.evaluate(() => (document.getElementById("screen-home") ? "présent" : "absent"))}`,
);

// --- démarrage -----------------------------------------------------------------
try {
  await page.waitForFunction(() => document.getElementById("boot")?.hidden === true, { timeout: 60_000 });
  check("écran de chargement masqué", "ok", "ok");
} catch {
  check("écran de chargement masqué", "ok", "timeout");
}
check(
  "moteur créé",
  (value) => value === true,
  await page.evaluate(() => {
    const engine = window.game?.engine;
    return !!engine && typeof engine.getFps === "function";
  }),
);
check("maillages en scène", (value) => Number(value) > 40, await fromGame("scene.meshes.length"));
check(
  "canevas dimensionné",
  (value) => Number(value) > 100,
  await page.evaluate(() => document.getElementById("renderCanvas")?.clientWidth ?? 0),
);
await visible("#screen-home").then((state) => check("menu principal affiché", "visible", state));
await shot("01-menu");

// --- course --------------------------------------------------------------------
await page.click('#screen-home [data-action="play"]');
await page.waitForTimeout(1200);
await visible("#countdown").then((state) => check("compte à rebours visible", "visible", state));
await shot("02-countdown");
// Le compte à rebours avance avec la boucle de rendu : en rendu logiciel
// SwiftShader, il est lent, donc on attend la phase plutôt qu'un délai fixe.
try {
  await page.waitForFunction(() => window.game?.race?.phase === "racing", { timeout: 20_000 });
} catch {
  /* le contrôle suivant rapporte l'échec éventuel */
}
await visible("#hud").then((state) => check("HUD de course visible", "visible", state));
check("phase de course", "racing", await fromGame("race.phase"));
await page.waitForTimeout(1000);
await visible("#countdown").then((state) => check("compte à rebours masqué après GO", "hidden", state));

await page.keyboard.down("ArrowUp");
await page.waitForTimeout(2600);
await text("#hud-speed").then((value) => check("vitesse après accélération", (v) => Number(v) > 40, value));
await shot("03-chase");

const activeCameraName = () =>
  page.evaluate(() => {
    const scene = window.game?.scene;
    if (!scene) return null;
    const cam = (scene.activeCameras && scene.activeCameras[0]) || scene.activeCamera;
    return cam ? cam.name : null;
  });
await page.keyboard.press("KeyC");
await page.waitForTimeout(600);
check("caméra cockpit", "cockpit", await fromGame("rig.mode"));
check("caméra cockpit branchée", "cockpit", await activeCameraName());
await shot("04-cockpit");
await page.keyboard.press("KeyC");
await page.waitForTimeout(400);
check("retour caméra poursuite", "chase", await activeCameraName());
await page.keyboard.press("KeyR");
await page.waitForTimeout(400);
check("voiture pilotée", (value) => typeof value === "number", await fromGame("car.readout.speedKmh"));
await page.keyboard.up("ArrowUp");

// --- pause et réglages ---------------------------------------------------------
await page.keyboard.press("Escape");
await page.waitForTimeout(400);
await visible("#screen-pause").then((state) => check("écran de pause affiché", "visible", state));
check("menus actifs en pause", true, await fromGame("hud.inMenus"));
await shot("05-pause");

await page.click('#screen-pause [data-action="settings"]');
await page.waitForTimeout(300);
await page.fill("#set-dz", "0.3");
await page.dispatchEvent("#set-dz", "input");
await page.fill("#set-cam", "1.6");
await page.dispatchEvent("#set-cam", "input");
await page.click("#set-shadows");
await page.waitForTimeout(300);
check("zone morte appliquée", (value) => Number(value) === 0.3, await fromGame("input.deadzone"));
check("fermeté caméra appliquée", (value) => Number(value) === 1.6, await fromGame("rig.firmness"));
check(
  "réglages persistés",
  true,
  await page.evaluate(
    () => JSON.parse(localStorage.getItem("route-libre-3d:settings:v1") ?? "{}").deadzone === 0.3,
  ),
);
await shot("06-settings");

// --- reprise puis retour au menu ----------------------------------------------
await page.click('#screen-settings [data-action="back"]');
await page.waitForTimeout(250);
await page.click('#screen-pause [data-action="resume"]');
await page.waitForTimeout(400);
check("course reprise", "racing", await fromGame("race.phase"));
await page.keyboard.down("ArrowUp");
await page.waitForTimeout(1600);
await page.keyboard.up("ArrowUp");
check("temps de course compté", (value) => Number(value) > 2000, await fromGame("race.totalMs"));
await shot("07-racing");

await page.keyboard.press("Escape");
await page.waitForTimeout(300);
await page.click('#screen-pause [data-action="quit"]');
await page.waitForTimeout(500);
await visible("#screen-home").then((state) => check("retour au menu principal", "visible", state));
check("menus actifs après sortie", true, await fromGame("hud.inMenus"));

// --- rapport -------------------------------------------------------------------
const fps = await page.evaluate(() => {
  const engine = window.game?.engine;
  return engine ? engine.getFps() : null;
});
const frames = await page.evaluate(() => window.game?.engine.frameId ?? 0);
console.log(`   fps (rendu logiciel SwiftShader) : ${typeof fps === "number" ? fps.toFixed(1) : "n/a"}`);
check("boucle de rendu vivante", (value) => Number(value) > 60, frames);

const errors = logs.filter(
  (line) => line.startsWith("error:") || line.startsWith("pageerror") || line.startsWith("requestfailed"),
);
const failures = checks.filter((entry) => !entry.ok);
writeFileSync(
  `${OUT_DIR}/report.json`,
  JSON.stringify(
    { url: URL_PAGE, browser: executablePath, fps, checks, errors, logs, ok: failures.length === 0 && errors.length === 0 },
    null,
    2,
  ),
);
await browser.close();

console.log(`\n${checks.length - failures.length}/${checks.length} contrôles réussis, ${errors.length} erreur(s) console.`);
for (const failure of failures) console.log(`FAIL: ${failure.name} (attendu ${failure.expected}, obtenu ${failure.actual})`);
for (const error of errors.slice(0, 12)) console.log(`ERR : ${error}`);
process.exit(failures.length === 0 && errors.length === 0 ? 0 : 1);

