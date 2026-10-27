import { chromium } from "playwright-core";
const browser = await chromium.launch({
  executablePath: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  headless: true,
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage();
page.on("console", (m) => console.log("CONSOLE", m.type(), m.text().slice(0, 300)));
page.on("pageerror", (e) => console.log("PAGEERROR", e.message.slice(0, 400)));
page.on("requestfailed", (r) => console.log("REQFAIL", r.url().slice(0, 160), r.failure()?.errorText));
const response = await page.goto("http://127.0.0.1:5173/", { waitUntil: "domcontentloaded", timeout: 60000 });
console.log("STATUS", response?.status(), "URL", page.url());
const html = await page.evaluate(() => document.documentElement.outerHTML.slice(0, 300));
console.log("DOM", html.replace(/\s+/g, " "));
await page.waitForTimeout(8000);
console.log("AFTER 8s:", await page.evaluate(() => document.body?.innerText?.slice(0, 200) || "no body"));
console.log("BOOT hidden?", await page.evaluate(() => document.getElementById("boot")?.hidden));
console.log("game?", await page.evaluate(() => typeof window.game));
await page.screenshot({ path: ".smoke/debug.png" });
await browser.close();
