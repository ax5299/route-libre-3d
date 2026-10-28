/**
 * Verifie la hauteur ECran du portique d'arrivee par rapport aux affichages HUD.
 *
 * Pour chaque distance avant la ligne, on teleporte la voiture, on recale la
 * camera, puis on projette le bas de la bache « ARRIVEE » et le point de fuite
 * lointain de la piste. Objectif : en vue poursuite, le bas de la bache doit
 * rester au-dessus du point de fuite (ne pas barrer la piste) et descendre au
 * plus bas a la hauteur du bandeau HUD superieur.
 *
 * Serveur de dev requis : `npm run dev` puis
 * `node scripts/_debug/gantry-check.mjs` (SMOKE_URL pour changer d'URL).
 */
import { existsSync } from "node:fs";
import { chromium } from "playwright-core";

const URL_PAGE = process.env.SMOKE_URL ?? "http://127.0.0.1:5173/";
const DISTANCES = [60, 100, 160, 250];
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

const browser = await chromium.launch({
  executablePath,
  headless: true,
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--mute-audio"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on("pageerror", (error) => console.log(`  !! pageerror: ${error.message}`));

const measure = (distance, mode) =>
  page.evaluate(
    ([d, view]) => {
      const game = window.game;
      const { scene, car, rig } = game;
      const sign = scene.getMeshByName("finish-sign");
      if (!sign) return { error: "finish-sign absent" };
      const Vec = car.position.constructor;
      const heading = Math.PI / 2 - sign.rotation.y;
      const cx = sign.absolutePosition.x;
      const cz = sign.absolutePosition.z;
      const bannerBottomY = sign.absolutePosition.y - sign.scaling.y * 0.875;
      car.placeAt(new Vec(cx - Math.cos(heading) * d, car.position.y, cz - Math.sin(heading) * d), heading);
      if (view === "cockpit" && rig.mode !== "cockpit") rig.toggle();
      if (view === "chase" && rig.mode !== "chase") rig.toggle();
      rig.applyTo(scene, false);
      const camera = scene.activeCamera;
      const engine = scene.getEngine();
      // Repose la caméra dans l'état d'équilibre RÉEL de la conduite (le reset
      // de grille utilise un pitch plat qui ne représente pas la vue de course).
      const fx = Math.cos(heading);
      const fz = Math.sin(heading);
      if (view === "chase") {
        // ratio vitesse 1 : distance 8,3 m derrière le focus (3,4 m devant la
        // caisse), œil à +2,8 m, fov 0,98
        camera.position.set(car.position.x - fx * 4.9, car.position.y + 3.85, car.position.z - fz * 4.9);
        camera.rotation.set(Math.atan2(2.8, 8.3), Math.atan2(fx, fz), 0);
        camera.fov = 0.98;
      } else {
        camera.position.set(car.position.x + fx * 0.2, car.position.y + 1.3, car.position.z + fz * 0.2);
        camera.rotation.set(Math.atan2(1.3 - 0.98, 14), Math.atan2(fx, fz), 0);
        camera.fov = 1.02;
      }
      scene.render();
      const w = engine.getRenderWidth();
      const h = engine.getRenderHeight();
      const aspect = w / h;
      // Projection manuelle (le bundle tree-shaké n'expose pas Vector3.project)
      const cy = Math.cos(camera.rotation.y);
      const sy = Math.sin(camera.rotation.y);
      const cp = Math.cos(camera.rotation.x);
      const sp = Math.sin(camera.rotation.x);
      const f = { x: sy * cp, y: -sp, z: cy * cp };
      const r = { x: cy, y: 0, z: -sy };
      const u = { x: f.y * r.z - f.z * r.y, y: f.z * r.x - f.x * r.z, z: f.x * r.y - f.y * r.x };
      const tanY = Math.tan(camera.fov / 2);
      const tanX = tanY * aspect;
      const project = (x, y, z) => {
        const vx = x - camera.position.x;
        const vy = y - camera.position.y;
        const vz = z - camera.position.z;
        const zc = vx * f.x + vy * f.y + vz * f.z;
        if (zc <= 0.01) return { x: NaN, y: -999 };
        const xc = vx * r.x + vy * r.y + vz * r.z;
        const yc = vx * u.x + vy * u.y + vz * u.z;
        return { x: 50 + (xc / (zc * tanX)) * 50, y: 50 - (yc / (zc * tanY)) * 50 };
      };
      const banner = project(cx, bannerBottomY, cz);
      const fwd = car.forward(new Vec());
      const roadFar = project(car.position.x + fwd.x * 220, car.position.y, car.position.z + fwd.z * 220);
      const hudTop = document.querySelector(".hud-top");
      const hud = hudTop ? (hudTop.getBoundingClientRect().bottom / window.innerHeight) * 100 : null;
      return { banner, roadFar, hud };
    },
    [distance, mode],
  );

try {
  await page.goto(URL_PAGE, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForFunction(() => window.game?.race, null, { timeout: 40000 });
  await page.click('#screen-home [data-action="play"]');
  await page.waitForFunction(() => window.game.race.phase === "racing", null, { timeout: 15000 });

  const rows = [];
  for (const mode of ["chase", "cockpit"]) {
    for (const d of DISTANCES) {
      const r = await measure(d, mode);
      if (r.error) {
        console.log(`  !! ${mode} ${d} m: ${r.error}`);
        continue;
      }
      rows.push({ mode, d, ...r });
      console.log(
        `  ${mode}  ${String(d).padStart(3)} m  bache bas: ${r.banner.y.toFixed(1)}%  ` +
          `fuite piste: ${r.roadFar.y.toFixed(1)}%  HUD bas: ${r.hud === null ? "?" : r.hud.toFixed(1)}%` +
          `${r.banner.y < 0 ? "  (hors ecran haut)" : ""}`,
      );
    }
  }

  const chase = rows.filter((r) => r.mode === "chase" && r.hud !== null);
  let pass = chase.length > 0;
  for (const r of chase) {
    // ≤ 160 m : la bache doit tenir dans la bande HUD ; au-delà (très loin,
    // la perspective impose sa place) : elle doit juste rester au-dessus du
    // point de fuite de la piste.
    const ok = r.d <= 160 ? r.banner.y < 0 || r.banner.y <= r.hud + 2 : r.banner.y <= r.roadFar.y;
    if (!ok) pass = false;
    const cible = r.d <= 160 ? `HUD ${r.hud.toFixed(1)}%+2` : `fuite ${r.roadFar.y.toFixed(1)}%`;
    console.log(`${ok ? "  ok  " : " FAIL"} poursuite ${r.d} m : bas bache ${r.banner.y.toFixed(1)}% <= ${cible}`);
  }
  await browser.close();
  console.log(pass ? "PORTIQUE OK" : "PORTIQUE ENCORE TROP BAS");
  process.exit(pass ? 0 : 1);
} catch (error) {
  console.error(error);
  await browser.close();
  process.exit(2);
}
