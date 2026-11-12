// 生成 README 里的示意图（模拟数据，不含任何真实站点信息）。运行：npm run shots
import { spawn } from "node:child_process";
import { chromium } from "playwright-core";

const PORT = 1432;
const BASE = `http://localhost:${PORT}`;
const OUT = new URL("../../docs/screenshots/", import.meta.url).pathname;
const T = (page, id) => page.getByTestId(id);

const server = spawn("npx", ["vite", "--port", String(PORT), "--strictPort"], { stdio: "pipe" });
await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error("vite 启动超时")), 20000);
  server.stdout.on("data", (d) => String(d).includes("Local") && (clearTimeout(t), res()));
});
const browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });

async function shot(name, scenario, viewport, steps) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2 });
  await ctx.addInitScript(() => localStorage.setItem("ferrydeck.speedConfirmed", "1"));
  const page = await ctx.newPage();
  await page.goto(`${BASE}/?s=${scenario}`);
  await steps(page);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}${name}.png` });
  await ctx.close();
  console.log("写入", `${name}.png`);
}
const settled = (p) => p.waitForFunction(() => !document.body.textContent.includes("读取中…") && !document.querySelector('[data-testid="op-progress"]') && !document.querySelector('[data-testid="cost-progress"]'));

try {
  await shot("main", "sites2,realfrt,plaza", { width: 1180, height: 700 }, async (p) => {
    await T(p, "group-card-alpha-2").waitFor();
    await settled(p);
    await p.mouse.move(2, 2);
  });
  await shot("operator", "sites1,admin,plaza", { width: 1180, height: 760 }, async (p) => {
    await T(p, "operator-alpha").click();
    await T(p, "down-block-2").waitFor();
    await settled(p);
    await p.mouse.move(2, 2);
  });
  await shot("context-menu", "sites2", { width: 1180, height: 520 }, async (p) => {
    await T(p, "group-card-alpha-2").waitFor();
    await settled(p);
    await T(p, "site-alpha").click({ button: "right" });
  });
  await shot("account-state", "sites2,admin,blocked", { width: 1180, height: 760 }, async (p) => {
    await T(p, "operator-alpha").click();
    await T(p, "up-edit-u1").first().waitFor();
    await settled(p);
    await T(p, "up-edit-u1").first().click({ force: true });
    await T(p, "au-nav-state").click();
    await p.mouse.move(1100, 700); // 移开鼠标，不要留着悬停提示
  });
  await shot("welcome", "", { width: 960, height: 680 }, async (p) => {
    await T(p, "empty-sites").waitFor();
  });
} finally {
  await browser.close();
  server.kill();
}
