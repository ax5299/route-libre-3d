/**
 * Controle du sens de braquage : le jeu doit tourner DU cote demande.
 *
 * On lance une course, on prend de la vitesse en ligne droite, puis on maintient
 * une direction et on mesure quatre choses pendant l'appui :
 *   - `dh`     variation du cap (negative = tourne a droite, convention du projet :
 *              avant = (cos h, sin h), normale gauche = (-sin h, cos h)) ;
 *   - `lat`    deplacement lateral de la trajectoire dans le repere de la voiture
 *              (positif = vers la gauche de la voiture) ;
 *   - `rudder` angle applique aux roues avant (+ = a droite) ;
 *   - `roll`   roulis de caisse (positif = caisse inclinee a gauche, c'est-a-dire
 *              vers l'exterieur d'un virage a droite).
 *
 * Le serveur de developpement doit tourner : `npm run dev` puis
 * `node scripts/_debug/steer-check.mjs` (SMOKE_URL pour changer d'URL).
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "playwright-core";

const URL_PAGE = process.env.SMOKE_URL ?? "http://127.0.0.1:5173/";
const OUT_DIR = ".smoke";
const TURN_MS = Number(process.env.TURN_MS ?? 1500);
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
const check = (name, ok, actual) => {
  checks.push({ name, ok, actual });
  console.log(`${ok ? "  ok  " : " FAIL "} ${name} -> ${actual}`);
};

const browser = await chromium.launch({
  executablePath,
  headless: true,
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--mute-audio"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on("console", (message) => logs.push(`${message.type()}: ${message.text()}`));
page.on("pageerror", (error) => logs.push(`pageerror: ${error.message}`));

const shot = (name) => page.screenshot({ path: `${OUT_DIR}/${name}.png` });
const TAU = Math.PI * 2;
const wrap = (angle) => {
  let value = (angle + Math.PI) % TAU;
  if (value < 0) value += TAU;
  return value - Math.PI;
};

const probe = () =>
  page.evaluate(() => {
    const game = window.game;
    const car = game?.car;
    if (!car) return null;
    const p = car.position;
    return {
      phase: game.race?.phase ?? null,
      heading: car.heading,
      x: p.x,
      z: p.z,
      kmh: Number(car.readout.speedKmh.toFixed(1)),
      rudder: car.hubs[0] ? Number(car.hubs[0].rotation.y.toFixed(4)) : null,
      steer: Number(car.steer.toFixed(4)),
      roll: Number(car.bodyNode.rotation.z.toFixed(4)),
      meshYaw: Number(car.root.rotation.y.toFixed(4)),
      onRoad: car.readout.onRoad,
      slip: Number(car.readout.slip.toFixed(3)),
    };
  });

/** Attend une voiture lancee, sur la route et a peu pres a plat. */
const steady = async (speed) => {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const now = await probe();
    if (now && now.kmh >= speed && now.onRoad && Math.abs(now.roll) < 0.02) return now;
    await page.waitForTimeout(250);
  }
  return probe();
};

console.log(`-> ${URL_PAGE}`);
await page.goto(URL_PAGE, { waitUntil: "domcontentloaded", timeout: 60_000 });
await page.waitForFunction(() => document.getElementById("boot")?.hidden === true, { timeout: 60_000 });
await page.click('#screen-home [data-action="play"]');
await page.waitForFunction(() => window.game?.race?.phase === "racing", { timeout: 40_000 });
check("course lancee", true, await page.evaluate(() => window.game.race.phase));

await page.keyboard.down("ArrowUp");
const start = await steady(55);
check("vitesse atteinte", (start?.kmh ?? 0) >= 45, `${start?.kmh} km/h`);

/**
 * Maintient `key` pendant TURN_MS et juge le resultat. `side` : +1 = a droite,
 * -1 = a gauche.
 */
const drive = async (label, key, side) => {
  const before = await steady(50);
  await page.keyboard.down(key);
  // Echantillon court : sur 400 ms le cap n'a pas encore beaucoup tourne, la
  // mesure de trajectoire reste donc parlante.
  await page.waitForTimeout(Math.min(400, TURN_MS));
  const early = await probe();
  await page.waitForTimeout(Math.max(0, TURN_MS - 400));
  const peak = await probe();
  await shot(`steer-${label}`);
  await page.keyboard.up(key);
  await page.waitForTimeout(250);

  const dh = wrap(peak.heading - before.heading);
  const dhEarly = wrap(early.heading - before.heading);
  const dx = early.x - before.x;
  const dz = early.z - before.z;
  // Normale gauche de l'ancien cap : deplacement positif = parti sur la gauche.
  const lat = dx * -Math.sin(before.heading) + dz * Math.cos(before.heading);
  const meshOk = Math.abs(wrap(peak.meshYaw - (Math.PI / 2 - peak.heading))) < 1e-3;

  console.log(
    `   ${label}: dh=${dh.toFixed(4)} rad (dh400=${dhEarly.toFixed(4)})  lat400=${lat.toFixed(2)} m  rudder=${peak.rudder}  roll=${peak.roll}  ${peak.kmh} km/h`,
  );
  check(`${label} : le cap tourne du bon cote`, dh * side < -0.002 && dhEarly * side < 0, `${dh.toFixed(4)}`);
  // `lat` est porte par la normale gauche : un virage a droite (side = +1) le rend
  // negatif (la voiture s'est deplacee vers sa droite).
  check(`${label} : la trajectoire part du bon cote`, lat * side < -0.02, lat.toFixed(2));
  check(`${label} : roues avant tournees du bon cote`, Math.sign(peak.rudder) === side, `${peak.rudder}`);
  check(`${label} : caisse inclinee vers l'exterieur`, Math.sign(peak.roll) === side, `${peak.roll}`);
  check(`${label} : orientation du maillage fidele au cap`, meshOk, `${peak.meshYaw}`);
  return { before, early, peak, dh, dhEarly, lat };
};

const right = await drive("droite", "ArrowRight", +1);
await page.keyboard.press("KeyR");
const left = await drive("gauche", "ArrowLeft", -1);

await page.keyboard.up("ArrowUp");
const fps = await page.evaluate(() => window.game?.engine?.getFps?.() ?? null);
console.log(`   fps (SwiftShader) : ${typeof fps === "number" ? fps.toFixed(1) : "n/a"}`);

await shot("steer-end");
const failed = checks.filter((entry) => !entry.ok);
writeFileSync(
  `${OUT_DIR}/steer-check.json`,
  `${JSON.stringify({ url: page.url(), turnMs: TURN_MS, checks, right, left, logs }, null, 2)}\n`,
);
await browser.close();
console.log(failed.length === 0 ? "\nSENS DE DIRECTION OK" : `\n${failed.length} CONTROLES EN ECHEC`);
process.exit(failed.length === 0 ? 0 : 1);

