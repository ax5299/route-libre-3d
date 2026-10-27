import { chromium } from "playwright-core";

/** Compare le rendu avec/sans réception d'ombres, et avec forceBackFacesOnly désactivé. */
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
await page.waitForFunction(() => window.game?.race?.phase === "racing", { timeout: 30_000 });
await page.waitForTimeout(800);

const dump = async (tag) => {
  await page.screenshot({ path: `.smoke/lights-${tag}.png` });
  console.log(tag, JSON.stringify(await page.evaluate(() => `ok`)));
};

await dump("baseline");

await page.evaluate(() => {
  for (const mesh of window.game.shadowReceivers) mesh.receiveShadows = false;
});
await page.waitForTimeout(700);
await dump("noshadow");

await page.evaluate(() => {
  const shadow = window.game.shadow;
  shadow.forceBackFacesOnly = false;
  for (const mesh of window.game.shadowReceivers) mesh.receiveShadows = true;
});
await page.waitForTimeout(700);
await dump("backfaces-off");

await page.evaluate(() => {
  const scene = window.game.scene;
  scene.imageProcessingConfiguration.toneMappingEnabled = false;
});
await page.waitForTimeout(700);
await dump("no-tonemap");

await page.evaluate(() => {
  const scene = window.game.scene;
  scene.imageProcessingConfiguration.toneMappingEnabled = true;
  scene.imageProcessingConfiguration.toneMappingType = 1; // ACES
  scene.imageProcessingConfiguration.exposure = 1.6;
});
await page.waitForTimeout(700);
await dump("aces");
await browser.close();
