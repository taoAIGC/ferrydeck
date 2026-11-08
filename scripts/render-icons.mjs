// 把 app/src-tauri/icons/source/ 里的 SVG 渲染成 PNG（用本机 Chrome，透明背景）。
// 用法：node scripts/render-icons.mjs，然后 cd app && npx tauri icon src-tauri/icons/source/icon-1024.png
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { chromium } = createRequire(join(root, "app/package.json"))("playwright-core");
const src = join(root, "app/src-tauri/icons/source");
const jobs = [
  ["icon.svg", 1024, join(src, "icon-1024.png")],
  ["tray.svg", 88, join(root, "app/src-tauri/icons/tray.png")],
];
const browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
for (const [file, size, out] of jobs) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(`<html><body style="margin:0;background:transparent">${readFileSync(join(src, file), "utf8")}</body></html>`);
  await page.locator("svg").screenshot({ path: out, omitBackground: true });
  await page.close();
  console.log("wrote", out);
}
await browser.close();
