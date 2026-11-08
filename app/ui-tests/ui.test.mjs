// 界面自动化测试：用 Playwright 驱动本机 Chrome，访问 vite 开发服务器（模拟后端）。
// 运行：npm run test:ui
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chromium } from "playwright-core";

const PORT = 1431;
const BASE = `http://localhost:${PORT}`;
let server, browser;

before(async () => {
  server = spawn("npx", ["vite", "--port", String(PORT), "--strictPort"], { stdio: "pipe" });
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error("vite 启动超时")), 20000);
    server.stdout.on("data", (d) => String(d).includes("Local") && (clearTimeout(t), res()));
    server.on("exit", () => rej(new Error("vite 提前退出")));
  });
  browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
});
after(async () => {
  await browser?.close();
  server?.kill();
});

/** 打开一个干净页面，并收集页面错误/控制台错误。 */
async function open(scenario = "", viewport = { width: 960, height: 680 }, { speedConfirmed = true } = {}) {
  const ctx = await browser.newContext({ viewport });
  // 第一次测速前会弹说明框；多数测试不关心它，预先标记为已确认
  if (speedConfirmed) await ctx.addInitScript(() => localStorage.setItem("ferrydeck.speedConfirmed", "1"));
  const page = await ctx.newPage();
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && page.errors.push(m.text()));
  await page.goto(`${BASE}/?s=${scenario}`);
  return page;
}
const T = (page, id) => page.getByTestId(id);
const selectedClient = (page) => page.evaluate(() => document.querySelector(".side-item.selected")?.getAttribute("data-testid"));
const count = (page, sel) => page.locator(sel).count();
const cards = (page) => count(page, '[data-testid^="group-card-"]');
async function done(page) {
  assert.deepEqual(page.errors, [], "页面不应有 JS 错误或控制台错误");
  await page.context().close();
}
/** 走完“添加站点”两步。 */
async function addSite(page, url, { user = "me@example.com", pw = "ok123", name } = {}) {
  await T(page, "add-site").click();
  await T(page, "add-url").fill(url);
  await T(page, "add-submit").click();
  await T(page, "add-username").waitFor();
  if (name !== undefined) await T(page, "add-name").fill(name);
  await T(page, "add-username").fill(user);
  await T(page, "add-password").fill(pw);
  await T(page, "add-submit").click();
}
const waitText = (page, id, re) => page.waitForFunction(([i, src]) => new RegExp(src).test(document.querySelector(`[data-testid="${i}"]`)?.textContent ?? ""), [id, re.source]);

// ---------- 空状态与添加站点 ----------

test("首次启动没有站点：显示欢迎页和添加入口，客户端显示暂无分组", async () => {
  const p = await open();
  await T(p, "empty-sites").waitFor();
  assert.match(await T(p, "empty-sites").textContent(), /还没有添加站点/);
  assert.match(await T(p, "empty-sites").textContent(), /new-api 和 sub2api/);
  assert.equal(await count(p, '[data-testid^="site-"][data-testid$="-x"]'), 0);
  assert.equal(await T(p, "client-status-claude").textContent(), "暂无可用分组");
  assert.equal(await cards(p), 0);
  await p.screenshot({ path: "ui-tests/shots/welcome.png" });
  await done(p);
});

test("添加站点第一步：空地址、未知地址、明文 http、需要人机验证都给出明确提示，且停留在第一步", async () => {
  const p = await open();
  await T(p, "empty-sites-add").click();
  await T(p, "add-submit").click();
  assert.equal(await T(p, "add-error").textContent(), "请输入站点地址");
  for (const [url, re] of [
    ["unknown.example.org", /无法识别该站点类型/],
    ["http://alpha.example.com", /只支持 https/],
    ["captcha.example.com", /人机验证/],
  ]) {
    await T(p, "add-url").fill(url);
    await T(p, "add-submit").click();
    await p.waitForFunction((src) => new RegExp(src).test(document.querySelector('[data-testid="add-error"]')?.textContent ?? ""), re.source);
    assert.equal(await T(p, "add-url").count(), 1, `${url} 应停留在地址步骤`);
    assert.equal(await T(p, "add-submit").textContent(), "下一步");
  }
  await done(p);
});

test("识别站点类型：sub2api 用“邮箱”，new-api 用“用户名”；返回上一步保留地址", async () => {
  const p = await open();
  await T(p, "empty-sites-add").click();
  await T(p, "add-url").fill("alpha.example.com");
  await T(p, "add-submit").click();
  await T(p, "add-detected").waitFor();
  assert.match(await T(p, "add-detected").textContent(), /https:\/\/alpha\.example\.com.*sub2api/);
  assert.equal(await p.locator('label[for="add-username"]').textContent(), "邮箱");
  assert.equal(await T(p, "add-name").inputValue(), "alpha.example.com", "名称默认取域名");
  await T(p, "add-back").click();
  assert.equal(await T(p, "add-url").inputValue(), "alpha.example.com");
  await T(p, "add-url").fill("beta.example.com");
  await T(p, "add-submit").click();
  await T(p, "add-detected").waitFor();
  assert.match(await T(p, "add-detected").textContent(), /new-api/);
  assert.equal(await p.locator('label[for="add-username"]').textContent(), "用户名");
  await T(p, "add-cancel").click();
  assert.equal(await count(p, '[data-testid="add-dialog"]'), 0);
  await done(p);
});

test("登录失败：显示中文错误，对话框保留，账号保留、密码清空；登录中按钮禁用", async () => {
  const p = await open("slow");
  await addSite(p, "alpha.example.com", { pw: "wrong" });
  assert.equal(await T(p, "add-submit").textContent(), "登录中…");
  assert.equal(await T(p, "add-submit").isDisabled(), true);
  await p.waitForFunction(() => document.querySelector('[data-testid="add-error"]')?.textContent);
  assert.equal(await T(p, "add-error").textContent(), "账号或密码不正确");
  assert.equal(await T(p, "add-username").inputValue(), "me@example.com");
  assert.equal(await T(p, "add-password").inputValue(), "");
  assert.equal(await T(p, "add-submit").isDisabled(), false);
  await T(p, "add-username").fill("");
  await T(p, "add-password").fill("x");
  await T(p, "add-submit").click();
  assert.equal(await T(p, "add-error").textContent(), "请输入账号和密码");
  await done(p);
});

test("添加成功：对话框关闭、站点卡和余额出现、分组列表显示、自动切到有分组的客户端", async () => {
  const p = await open();
  await addSite(p, "alpha.example.com", { name: "我的 Alpha" });
  await T(p, "group-card-alpha-2").waitFor();
  assert.equal(await count(p, '[data-testid="add-dialog"]'), 0);
  await waitText(p, "toast", /已添加站点「我的 Alpha」/);
  assert.match(await T(p, "site-alpha").textContent(), /我的 Alpha/);
  assert.doesNotMatch(await T(p, "site-alpha").textContent(), /sub2api|new-api/, "不再显示站点类型（第 4 项）");
  assert.equal(await T(p, "site-balance-alpha").textContent(), "$99.78", "余额前不再有“余额”二字（第 6 项）");
  assert.equal(await selectedClient(p), "client-claude");
  assert.equal(await cards(p), 3, "Claude 类分组 3 个");
  assert.equal(await count(p, '[data-testid="unsupported"]'), 0, "不展示不支持的分组");
  assert.equal(await count(p, '[data-testid="site-filter"]'), 0, "只有一个站点时不显示站点筛选");
  assert.equal(await count(p, '[data-testid^="site-tag-"]'), 0, "只有一个站点时不显示站点标签");
  assert.equal(await count(p, '[data-testid="empty-sites"]'), 0);
  await p.screenshot({ path: "ui-tests/shots/one-site.png" });
  await done(p);
});

test("对话框里按回车可以提交；重复添加同一站点视为重新登录", async () => {
  const p = await open("sites1");
  await T(p, "group-card-alpha-2").waitFor();
  await T(p, "add-site").click();
  await T(p, "add-url").fill("alpha.example.com");
  await T(p, "add-url").press("Enter");
  await T(p, "add-username").waitFor();
  await T(p, "add-username").fill("a@b.c");
  await T(p, "add-password").fill("ok123");
  await T(p, "add-password").press("Enter");
  await waitText(p, "toast", /已重新登录/);
  // 站点卡上新增了“站点名称按钮”和图标按钮，这里只数站点卡本身
  assert.equal(await count(p, '.site-card'), 1, "仍然只有一个站点");
  await done(p);
});

// ---------- 多站点 ----------

test("两个站点：分组合并显示，同名分组并存并带站点标签，出现站点筛选", async () => {
  const p = await open("sites2");
  await T(p, "group-card-alpha-2").waitFor();
  assert.equal(await cards(p), 4, "Alpha 3 个 + Beta 1 个 Claude 分组");
  assert.equal(await T(p, "site-tag-alpha-4").textContent(), "Alpha");
  assert.equal(await T(p, "site-tag-beta-Claude 逆向Kiro").textContent(), "Beta");
  assert.match(await T(p, "group-card-alpha-4").textContent(), /Claude 逆向Kiro/);
  assert.match(await T(p, "group-card-beta-Claude 逆向Kiro").textContent(), /Claude 逆向Kiro/, "同名分组两个站点各一份");
  assert.equal(await T(p, "site-balance-alpha").textContent(), "$99.78");
  assert.equal(await T(p, "site-balance-beta").textContent(), "$43.51");
  assert.doesNotMatch(await T(p, "site-beta").textContent(), /new-api|sub2api/, "不显示站点类型（第 4 项）");
  await p.screenshot({ path: "ui-tests/shots/two-sites.png" });
  await done(p);
});

test("站点筛选：只看某个站点，再切回全部；筛选后该站点没有这个客户端的分组时给出说明", async () => {
  const p = await open("sites2");
  await T(p, "group-card-alpha-2").waitFor();
  await T(p, "site-filter").selectOption("beta");
  assert.equal(await cards(p), 1);
  assert.equal(await count(p, '[data-testid="group-card-beta-Claude 逆向Kiro"]'), 1);
  await T(p, "client-gemini").click();
  assert.match(await T(p, "empty-client").textContent(), /这个站点没有可用于 Gemini CLI 的分组/);
  await T(p, "site-filter").selectOption("all");
  assert.equal(await cards(p), 1, "Gemini 只有 Alpha 的一个分组");
  await T(p, "client-codex").click();
  assert.equal(await cards(p), 2, "Codex：Alpha 的 GPT 福利 + Beta 的 GPT Pro");
  await done(p);
});

test("跨站点切换：同名分组互不混淆，启用另一个站点的分组后旧卡恢复", async () => {
  const p = await open("sites2");
  await T(p, "enable-alpha-4").click();
  await p.waitForFunction(() => document.querySelector('[data-testid="group-card-alpha-4"]')?.textContent.includes("使用中"));
  const toast = await T(p, "toast").textContent();
  assert.match(toast, /已把「Claude 逆向Kiro」（Alpha）配置到 Claude Code/);
  assert.equal(await T(p, "client-status-claude").textContent(), "Alpha · Claude 逆向Kiro", "多站点时状态里带站点名");
  assert.equal(await T(p, "enable-beta-Claude 逆向Kiro").getAttribute("aria-label"), "启用", "Beta 的同名分组不应被当成使用中");

  await T(p, "enable-beta-Claude 逆向Kiro").click();
  await p.waitForFunction(() => document.querySelector('[data-testid="group-card-beta-Claude 逆向Kiro"]')?.textContent.includes("使用中"));
  assert.equal(await T(p, "enable-alpha-4").getAttribute("aria-label"), "启用", "Alpha 的卡片恢复可启用");
  assert.equal(await p.locator("text=使用中").count(), 1, "同一客户端同时只有一个使用中");
  assert.equal(await T(p, "client-status-claude").textContent(), "Beta · Claude 逆向Kiro");
  await done(p);
});

test("同一个分组配到 Claude Code 和 Claude Desktop 互不影响", async () => {
  const p = await open("sites1");
  await T(p, "enable-alpha-12").click();
  await p.waitForFunction(() => document.querySelector('[data-testid="client-status-claude"]')?.textContent === "Claude 逆向Kiro - 特价");
  assert.equal(await T(p, "client-status-claude_desktop").textContent(), "");
  await T(p, "client-claude_desktop").click();
  assert.equal(await selectedClient(p), "client-claude_desktop");
  assert.equal(await T(p, "enable-alpha-12").getAttribute("aria-label"), "启用");
  await T(p, "enable-alpha-2").click();
  await p.waitForFunction(() => document.querySelector('[data-testid="client-status-claude_desktop"]')?.textContent === "Claude 官方系列高速");
  assert.match(await T(p, "toast").textContent(), /完全退出（⌘Q）并重新打开 Claude Desktop/);
  assert.equal(await T(p, "client-status-claude").textContent(), "Claude 逆向Kiro - 特价");
  await done(p);
});

test("启用与模型切换：专用 Key 只在第一次创建；下拉框切换模型", async () => {
  const p = await open("sites1");
  await T(p, "enable-alpha-4").click();
  await waitText(p, "toast", /专用 Key/);
  await T(p, "model-select-alpha-4").waitFor();
  await p.waitForFunction(() => document.querySelector('[data-testid="model-select-alpha-4"]').options.length > 1);
  assert.deepEqual(await T(p, "model-select-alpha-4").locator("option").allTextContents(), ["claude-sonnet-5-5", "claude-sonnet-5", "claude-opus-5-5", "claude-haiku-5-5"]);
  await T(p, "model-select-alpha-4").selectOption("claude-opus-5-5");
  await waitText(p, "toast", /已切换模型为 claude-opus-5-5/);
  assert.equal(await T(p, "model-select-alpha-4").inputValue(), "claude-opus-5-5");
  assert.doesNotMatch(await T(p, "toast").textContent(), /专用 Key/);
  await done(p);
});

test("启用过程中：按钮显示“配置中…”，其他启用按钮被禁用，防止并发", async () => {
  const p = await open("sites1,slow");
  await T(p, "enable-alpha-2").waitFor();
  await T(p, "enable-alpha-2").click();
  assert.equal(await T(p, "enable-alpha-2").textContent(), "配置中…");
  assert.equal(await T(p, "enable-alpha-4").isDisabled(), true);
  await p.waitForFunction(() => document.querySelector('[data-testid="group-card-alpha-2"]')?.textContent.includes("使用中"));
  await done(p);
});

test("启用失败：显示错误，按钮恢复，没有变成使用中", async () => {
  const p = await open("sites1,enable-fail");
  await T(p, "enable-alpha-12").click();
  await T(p, "toast").waitFor();
  assert.match(await T(p, "toast").textContent(), /配置失败：无法连接到服务器，请检查网络/);
  assert.equal(await T(p, "enable-alpha-12").getAttribute("aria-label"), "启用");
  assert.equal(await T(p, "enable-alpha-12").isDisabled(), false);
  assert.equal(await T(p, "client-status-claude").textContent(), "");
  await done(p);
});

test("启用时发现登录已过期：提示去重新登录，站点卡变红，分组消失", async () => {
  const p = await open("sites1,expire-on-enable");
  await T(p, "enable-alpha-12").click();
  await waitText(p, "toast", /站点「Alpha」登录已过期/);
  await T(p, "relogin-alpha").waitFor();
  assert.match(await T(p, "site-error-alpha").textContent(), /登录已过期/);
  assert.equal(await cards(p), 0);
  assert.match(await T(p, "empty").textContent(), /有站点需要重新登录/);
  await done(p);
});

// ---------- 站点管理 ----------

test("登录过期的站点：红色提示、只有重新登录和移除；它的分组不显示，其他站点正常", async () => {
  const p = await open("sites2,expired");
  await T(p, "group-card-alpha-2").waitFor();
  await T(p, "site-error-beta").waitFor();
  assert.match(await T(p, "site-error-beta").textContent(), /登录已过期/);
  assert.equal(await count(p, '[data-testid="retry-beta"]'), 0, "登录失效只能重新登录，没有重试");
  assert.equal(await count(p, '[data-testid="topup-beta"]'), 1, "不管登录状态如何，充值和移除两个图标都有（悬停时显示）");
  assert.equal(await count(p, '[data-testid="topup-alpha"]'), 1);
  assert.equal(await cards(p), 3, "只剩 Alpha 的分组");
  assert.equal(await count(p, '[data-testid^="group-card-beta-"]'), 0);
  await T(p, "relogin-beta").click();
  assert.equal(await T(p, "add-detected").isVisible(), true, "直接进入登录步骤");
  assert.equal(await count(p, '[data-testid="add-name"]'), 0, "重新登录不改名称");
  assert.equal(await count(p, '[data-testid="add-back"]'), 0);
  assert.equal(await p.locator('label[for="add-username"]').textContent(), "用户名");
  await T(p, "add-username").fill("demo");
  await T(p, "add-password").fill("ok123");
  await T(p, "add-submit").click();
  await T(p, "group-card-beta-Claude 逆向Kiro").waitFor();
  assert.match(await T(p, "toast").textContent(), /站点「Beta」已重新登录/);
  assert.equal(await count(p, '[data-testid="relogin-beta"]'), 0);
  assert.equal(await T(p, "site-balance-beta").textContent(), "$43.51");
  await done(p);
});

test("暂时连不上的站点（网络问题）：提示会自动重试，有重试按钮；重试后恢复，不用重新登录", async () => {
  const p = await open("sites2,offline");
  await T(p, "group-card-alpha-2").waitFor();
  await T(p, "retry-beta").waitFor();
  assert.match(await T(p, "site-error-beta").textContent(), /稍后会自动重试/);
  assert.doesNotMatch(await T(p, "site-error-beta").textContent(), /登录已过期/);
  assert.equal(await count(p, '[data-testid="relogin-beta"]'), 1, "也保留重新登录入口");
  assert.equal(await count(p, '[data-testid="retry-alpha"]'), 0, "正常站点没有重试按钮");
  assert.equal(await count(p, '[data-testid^="group-card-beta-"]'), 0);
  await T(p, "retry-beta").click();
  await T(p, "group-card-beta-Claude 逆向Kiro").waitFor();
  assert.equal(await T(p, "site-balance-beta").textContent(), "$43.51");
  assert.equal(await count(p, '[data-testid="retry-beta"]'), 0);
  assert.equal(await count(p, '[data-testid="relogin-beta"]'), 0);
  await done(p);
});

test("移除站点：先确认；取消不动；确认后站点和它的分组消失，使用中的状态清掉", async () => {
  const p = await open("sites2");
  await T(p, "enable-beta-Claude 逆向Kiro").click();
  await p.waitForFunction(() => document.querySelector('[data-testid="client-status-claude"]')?.textContent === "Beta · Claude 逆向Kiro");
  await T(p, "remove-beta").click();
  assert.match(await T(p, "remove-dialog").textContent(), /移除站点「Beta」/);
  assert.match(await T(p, "remove-dialog").textContent(), /不会被删除/);
  await T(p, "remove-cancel").click();
  assert.equal(await count(p, '[data-testid="remove-dialog"]'), 0);
  assert.equal(await count(p, '[data-testid="site-beta"]'), 1);
  await T(p, "remove-beta").click();
  await T(p, "remove-confirm").click();
  await waitText(p, "toast", /已移除站点「Beta」/);
  assert.equal(await count(p, '[data-testid="site-beta"]'), 0);
  assert.equal(await count(p, '[data-testid^="group-card-beta-"]'), 0);
  assert.equal(await T(p, "client-status-claude").textContent(), "");
  assert.equal(await count(p, '[data-testid="site-filter"]'), 0, "回到单站点，筛选和标签消失");
  assert.equal(await count(p, '[data-testid^="site-tag-"]'), 0);
  await done(p);
});

test("移除最后一个站点：回到欢迎页", async () => {
  const p = await open("sites1");
  await T(p, "remove-alpha").click();
  await T(p, "remove-confirm").click();
  await T(p, "empty-sites").waitFor();
  assert.equal(await cards(p), 0);
  await done(p);
});

test("去充值：sub2api 打开 /purchase，new-api 打开 /console/topup，页面不跳转", async () => {
  const p = await open("sites2");
  await T(p, "topup-alpha").waitFor();
  assert.equal(await T(p, "site-alpha").locator('[data-testid="topup-alpha"]').count(), 1, "按钮在 Alpha 的站点卡里，紧挨着它的余额");
  assert.equal(await T(p, "site-beta").locator('[data-testid="topup-beta"]').count(), 1);
  await T(p, "topup-alpha").click();
  await T(p, "topup-beta").click();
  await p.waitForFunction(() => (window.__opened ?? []).length === 2);
  assert.deepEqual(await p.evaluate(() => window.__opened), ["https://alpha.example.com/purchase", "https://beta.example.com/console/topup"]);
  assert.ok(p.url().startsWith(BASE));
  await done(p);
});

// ---------- 其他状态 ----------

test("站点没有任何分组：显示空状态说明", async () => {
  const p = await open("sites1,empty");
  await T(p, "empty").waitFor();
  assert.match(await T(p, "empty").textContent(), /没有可用分组/);
  assert.equal(await cards(p), 0);
  await done(p);
});

test("配置冲突与客户端缺失：警告只出现在对应客户端", async () => {
  const p = await open("sites1,conflict,nodir,desktop-off");
  await T(p, "conflict-banner").waitFor();
  assert.match(await T(p, "conflict-banner").textContent(), /ANTHROPIC_BASE_URL/);
  assert.match(await T(p, "client-claude").textContent(), /⚠/);
  assert.match(await T(p, "nodir-banner").textContent(), /没有检测到 Claude Code/);
  await T(p, "client-claude_desktop").click();
  assert.match(await T(p, "conflict-banner").textContent(), /还没有切换到第三方推理模式/);
  await T(p, "client-codex").click();
  assert.equal(await count(p, '[data-testid="conflict-banner"]'), 0);
  await T(p, "client-claude").click();
  await T(p, "enable-alpha-12").click();
  await p.waitForFunction(() => document.querySelector('[data-testid="group-card-alpha-12"]')?.textContent.includes("使用中"));
  await done(p);
});

test("加载分组期间：侧边栏显示“加载中…”，不会误导为“暂无可用分组”", async () => {
  const p = await open("sites1,slow");
  await T(p, "loading").waitFor();
  assert.equal(await T(p, "client-status-claude").textContent(), "加载中…");
  await T(p, "group-card-alpha-2").waitFor();
  assert.equal(await T(p, "client-status-claude").textContent(), "");
  await done(p);
});

test("分组上方没有标题区，界面上没有还原入口，也没有账号/退出登录", async () => {
  const p = await open("sites2");
  await T(p, "group-card-alpha-2").waitFor();
  assert.equal(await p.locator("h2").count(), 0);
  const text = await p.locator("body").textContent();
  assert.doesNotMatch(text, /选择一个分组，自动写入|还原|退出登录/);
  await done(p);
});

// ---------- 更新 ----------

test("更新：顶栏有 GitHub 主页和检查更新（不再显示版本号）；无更新时手动检查提示已是最新", async () => {
  const p = await open("sites1");
  await T(p, "github-link").waitFor();
  assert.equal(await T(p, "github-link").textContent(), "GitHub 主页");
  assert.equal(await count(p, '[data-testid="version"]'), 0, "顶栏不再显示版本号（第 9 项）");
  assert.equal(await count(p, '[data-testid="update-banner"]'), 0);
  await T(p, "check-update").click();
  await waitText(p, "toast", /已经是最新版本/);
  await done(p);
});

test("更新：启动时静默发现新版本并显示横幅，点击后安装并触发重启", async () => {
  const p = await open("sites1,update");
  await T(p, "update-banner").waitFor();
  assert.match(await T(p, "update-banner").textContent(), /发现新版本 0\.4\.0/);
  assert.equal(await count(p, '[data-testid="toast"]'), 0, "静默检查不应弹提示");
  await T(p, "install-update").click();
  await p.waitForFunction(() => window.__relaunched === true);
  await done(p);
});

test("更新：安装失败给出错误，按钮恢复可重试", async () => {
  const p = await open("sites1,update-fail");
  await T(p, "install-update").click();
  await T(p, "toast").waitFor();
  assert.match(await T(p, "toast").textContent(), /下载更新失败/);
  assert.equal(await T(p, "install-update").textContent(), "立即更新");
  assert.equal(await T(p, "install-update").isDisabled(), false);
  await done(p);
});

test("更新：检查失败时，启动静默不打扰，手动检查才提示", async () => {
  const p = await open("sites1,check-fail");
  await T(p, "check-update").waitFor();
  await p.waitForTimeout(500);
  assert.equal(await count(p, '[data-testid="toast"]'), 0);
  await T(p, "check-update").click();
  await waitText(p, "toast", /检查更新失败/);
  await done(p);
});

// ---------- 布局 ----------

test("分组以横向列表展示：每行一个，名称、倍率、按钮在同一行", async () => {
  const p = await open("sites1");
  await T(p, "group-card-alpha-2").waitFor();
  const boxes = await p.locator('[data-testid^="group-card-"]').evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return { top: Math.round(r.top), left: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) }; }));
  assert.equal(boxes.length, 3);
  assert.ok(boxes.every((b) => b.left === boxes[0].left && b.w === boxes[0].w), "单列且同宽");
  assert.ok(boxes.every((b, i) => i === 0 || b.top > boxes[i - 1].top));
  assert.ok(boxes.every((b) => b.h < 100), `每行应较矮，实际 ${boxes.map((b) => b.h)}`);
  const row = await T(p, "group-card-alpha-2").evaluate((e) => { const c = e.getBoundingClientRect(); const mid = c.top + c.height / 2; const inRow = (s) => { const r = e.querySelector(s).getBoundingClientRect(); return r.top < mid && r.bottom > mid; }; return { name: inRow("h3"), rate: inRow(".rate"), btn: inRow("button") }; });
  assert.deepEqual(row, { name: true, rate: true, btn: true });
  await done(p);
});

test("最小窗口 820×560：两个站点、使用中的卡片、站点卡都不溢出", async () => {
  const p = await open("sites2", { width: 820, height: 560 });
  await T(p, "group-card-alpha-2").waitFor();
  await T(p, "enable-beta-Claude 逆向Kiro").click();
  await p.waitForFunction(() => document.querySelector('[data-testid="group-card-beta-Claude 逆向Kiro"]')?.textContent.includes("使用中"));
  const { sw, cw } = await p.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  assert.ok(sw <= cw, `不应有横向滚动: ${sw} > ${cw}`);
  const over = await p.evaluate(() => [...document.querySelectorAll(".card, .site-card")].filter((c) => c.scrollWidth > c.clientWidth + 1).length);
  assert.equal(over, 0, "卡片内容不应溢出");
  await p.screenshot({ path: "ui-tests/shots/min.png" });
  await done(p);
});

test("键盘可达：添加站点对话框里 Tab 依次聚焦账号、密码、按钮", async () => {
  const p = await open();
  await T(p, "empty-sites-add").click();
  assert.equal(await p.evaluate(() => document.activeElement?.id), "add-url", "对话框打开后焦点在地址框");
  await T(p, "add-url").fill("alpha.example.com");
  await T(p, "add-url").press("Enter");
  await T(p, "add-username").waitFor();
  await p.waitForFunction(() => document.activeElement?.id === "add-username");
  await p.keyboard.press("Tab");
  assert.equal(await p.evaluate(() => document.activeElement?.id), "add-password");
  await done(p);
});

test("排序：点“倍率”列标题升序/降序/恢复默认，并记住选择；没有排序下拉框；顶栏不重复产品名", async () => {
  const p = await open("sites2");
  await T(p, "group-card-alpha-2").waitFor();
  assert.equal(await count(p, '[data-testid="sort"]'), 0, "去掉了排序下拉框");
  assert.equal(await T(p, "list-head").isVisible(), true);
  assert.match(await T(p, "list-head").textContent(), /首字时延.*倍率.*模型/);
  const rates = async () => (await p.locator(".card .rate").allTextContents()).map((x) => parseFloat(x.replace("×", "")));
  await T(p, "sort-rate").click();
  let r = await rates();
  assert.deepEqual(r, [...r].sort((a, b) => a - b), "第一次点：升序");
  await T(p, "sort-rate").click();
  r = await rates();
  assert.deepEqual(r, [...r].sort((a, b) => b - a), "第二次点：降序");
  assert.equal(await p.evaluate(() => [localStorage.getItem("ferrydeck.sort"), localStorage.getItem("ferrydeck.sortCol")].join()), "desc,rate", "记住排序");
  await p.reload();
  await T(p, "group-card-alpha-2").waitFor();
  r = await rates();
  assert.deepEqual(r, [...r].sort((a, b) => b - a), "重新打开后仍是降序");
  const h = await p.locator("header.topbar").evaluate((e) => e.getBoundingClientRect().height);
  assert.ok(h < 32, `顶部栏高度 ${h}`);
  assert.equal(await T(p, "brand").textContent(), "Ferrydeck", "红绿灯右侧显示应用名称");
  assert.equal(await p.locator('[data-testid="brand"] img').getAttribute("src"), "/icon-64.png", "和应用图标");
  const brandX = await T(p, "brand").evaluate((e) => e.getBoundingClientRect().left);
  assert.ok(brandX >= 70, `名称要避开左侧的红绿灯: ${brandX}`);
  await done(p);
});

test("时延排序：测速后点“时延”列按首字延迟升序，没测过的排最后；使用中的卡片不加绿框", async () => {
  const p = await open("sites2");
  await T(p, "group-card-alpha-2").waitFor();
  await T(p, "speed-test").click();
  await p.waitForFunction(() => document.querySelectorAll('[data-testid^="speed-"]:not([data-testid="speed-test"])').length >= 4);
  await T(p, "sort-speed").click();
  const secs = (await p.locator('[data-testid^="speed-"]:not([data-testid="speed-test"])').allTextContents()).map((x) => parseFloat(x));
  assert.deepEqual(secs, [...secs].sort((a, b) => a - b));
  await T(p, "enable-alpha-2").click();
  await p.waitForFunction(() => document.querySelector('[data-testid="group-card-alpha-2"]')?.textContent.includes("使用中"));
  const border = await T(p, "group-card-alpha-2").evaluate((e) => getComputedStyle(e).boxShadow);
  assert.equal(border, "none", "使用中只靠文案提示，不加绿色外框");
  await done(p);
});

test("测速中：时延列显示旋转的章鱼，出结果后换成秒数；添加站点按钮只显示＋", async () => {
  const p = await open("sites1");
  await T(p, "group-card-alpha-2").waitFor();
  assert.equal((await T(p, "add-site").textContent()).trim(), "＋");
  assert.equal(await T(p, "add-site").getAttribute("title"), "添加站点");
  await T(p, "speed-test").click();
  // 每次渲染都会替换 DOM，直接在页面里取最新节点判断动画
  await p.waitForFunction(() => {
    const e = document.querySelector('[data-testid="probing-alpha-2"]');
    return e && getComputedStyle(e).animationName === "octo-spin";
  });
  await T(p, "speed-alpha-2").waitFor();
  assert.equal(await count(p, '[data-testid="probing-alpha-2"]'), 0, "出结果后章鱼消失");
  assert.match(await T(p, "speed-alpha-2").textContent(), /^\d+\.\d{2}s$/);
  await done(p);
});

test("第一次测速前先说明会做什么（逐个、每个一条 hi、会建专用 Key），取消不发请求，确认后不再询问", async () => {
  const p = await open("sites1", { width: 960, height: 680 }, { speedConfirmed: false });
  await T(p, "group-card-alpha-2").waitFor();
  await T(p, "speed-test").click();
  await T(p, "speed-confirm-dialog").waitFor();
  const text = await T(p, "speed-confirm-dialog").textContent();
  assert.match(text, /逐个/);
  assert.match(text, /“hi”/);
  assert.match(text, /Ferrydeck-分组名/);
  await T(p, "speed-cancel").click();
  assert.equal(await count(p, '[data-testid^="probing-"]'), 0);
  assert.equal(await count(p, '[data-testid^="speed-alpha"]'), 0, "取消后没有任何测速结果");
  await T(p, "speed-test").click();
  await T(p, "speed-start").click();
  await T(p, "speed-alpha-2").waitFor();
  await p.waitForFunction(() => !document.querySelector('[data-testid="speed-test"]')?.textContent.includes("停止"));
  await T(p, "speed-test").click();
  assert.equal(await count(p, '[data-testid="speed-confirm-dialog"]'), 0, "确认过一次之后不再询问");
  await done(p);
});

test("测速是逐个进行的：任何时刻最多只有一个分组在测；测速中点按钮可以停止", async () => {
  const p = await open("sites2,slow");
  await T(p, "group-card-alpha-2").waitFor();
  await p.evaluate(() => {
    window.__maxProbing = 0;
    new MutationObserver(() => {
      window.__maxProbing = Math.max(window.__maxProbing, document.querySelectorAll('[data-testid^="probing-"]').length);
    }).observe(document.body, { childList: true, subtree: true });
  });
  await T(p, "speed-test").click();
  await p.waitForFunction(() => document.querySelector('[data-testid^="probing-"]'));
  assert.match(await T(p, "speed-test").textContent(), /1\/4.*停止|0\/4.*停止/, "显示进度和“停止”");
  await T(p, "speed-test").click(); // 停止
  await p.waitForFunction(() => !document.querySelector('[data-testid="speed-test"]')?.textContent.includes("停"));
  const results = await count(p, '[data-testid^="speed-"]:not([data-testid="speed-test"])');
  assert.ok(results < 4, `停止后剩下的分组不再测速：${results}`);
  assert.ok((await p.evaluate(() => window.__maxProbing)) <= 1, "同一时间只测一个分组");
  await done(p);
});

test("配置中：按钮里出现章鱼，五条腿在划动，完成后恢复", async () => {
  const p = await open("sites1,slow");
  await T(p, "enable-alpha-2").click();
  await T(p, "octo-working").waitFor();
  assert.match(await T(p, "enable-alpha-2").textContent(), /配置中…/);
  await p.waitForFunction(() => {
    const leg = document.querySelector('[data-testid="octo-working"] .octo-leg');
    return leg && getComputedStyle(leg).animationName === "octo-leg";
  });
  assert.equal(await p.locator('[data-testid="octo-working"] .octo-leg').count(), 5);
  await p.waitForFunction(() => document.querySelector('[data-testid="group-card-alpha-2"]')?.textContent.includes("使用中"));
  assert.equal(await count(p, '[data-testid="octo-working"]'), 0, "配置完成后章鱼消失");
  await done(p);
});

test("测速时某个站点 429 限流：只停掉它剩下的分组并提示，其他站点继续测", async () => {
  const p = await open("sites2,ratelimit");
  await T(p, "group-card-alpha-2").waitFor();
  await T(p, "speed-test").click();
  await p.waitForFunction(() => !document.querySelector('[data-testid="speed-test"]')?.textContent.includes("停止"));
  assert.match(await T(p, "toast").textContent(), /限流了，已停止对它的测速/);
  // Alpha 的第一个分组触发限流，其余的直接跳过（没有再去敲站点）
  assert.match(await T(p, "speed-alpha-2").getAttribute("data-tip"), /站点限流了/);
  assert.match(await T(p, "speed-alpha-4").getAttribute("data-tip"), /已跳过/);
  // Beta 不受影响，照常测完
  assert.match(await T(p, "speed-beta-Claude 逆向Kiro").textContent(), /^\d+\.\d{2}s$/);
  await done(p);
});

test("顶栏：应用名右侧有刷新按钮和“更新于 时:分”；没有站点时不显示", async () => {
  const none = await open();
  await T(none, "brand").waitFor();
  assert.equal(await count(none, '[data-testid="refresh"]'), 0, "还没有站点时没有刷新按钮");
  await done(none);

  const p = await open("sites1");
  await T(p, "group-card-alpha-2").waitFor();
  assert.equal(await T(p, "refresh").isVisible(), true);
  assert.match(await T(p, "refresh-time").textContent(), /^(刚刚刷新|\d+秒前刷新)$/);
  assert.match(await T(p, "refresh-time").getAttribute("data-tip"), /最近一次向站点拉取分组/);
  // 刷新按钮在应用名右边，而不是在右上角的链接那一侧
  const [brandRight, refreshLeft, linkLeft] = await Promise.all([
    T(p, "brand").evaluate((e) => e.getBoundingClientRect().right),
    T(p, "refresh").evaluate((e) => e.getBoundingClientRect().left),
    T(p, "github-link").evaluate((e) => e.getBoundingClientRect().left),
  ]);
  assert.ok(refreshLeft >= brandRight - 1 && refreshLeft < linkLeft, `位置不对: ${brandRight} ${refreshLeft} ${linkLeft}`);
  await done(p);
});

test("手动刷新：无视缓存重新向站点拉取，刷新中按钮转动并禁用，完成后时间更新", async () => {
  const p = await open("sites1,slow");
  await T(p, "group-card-alpha-2").waitFor();
  const calls = () => p.evaluate(() => window.__listGroupsCalls);
  assert.equal(await calls(), 1, "启动时拉了一次");
  await p.evaluate(() => { const real = Date.now; Date.now = () => real() + 10_000; }); // 才过 10 秒，缓存本来还有效
  await T(p, "refresh").click();
  await p.waitForFunction(() => document.querySelector('[data-testid="refresh-time"]')?.textContent === "刷新中…");
  assert.equal(await T(p, "refresh").isDisabled(), true, "刷新中不能重复点");
  assert.equal(await p.evaluate(() => document.querySelector('[data-testid="refresh"]').classList.contains("spinning")), true);
  await p.waitForFunction(() => /刷新$/.test(document.querySelector('[data-testid="refresh-time"]')?.textContent ?? ""));
  assert.equal(await calls(), 2, "手动刷新一定重新拉取，哪怕一分钟内刚拉过");
  assert.equal(await T(p, "refresh").isDisabled(), false);
  await done(p);
});

test("自动刷新（切回窗口）：一分钟内拉过就不再请求站点，超过一分钟才重新拉", async () => {
  const p = await open("sites1");
  await T(p, "group-card-alpha-2").waitFor();
  const calls = () => p.evaluate(() => window.__listGroupsCalls);
  const shiftClock = (ms) => p.evaluate((d) => { const real = Date.now; Date.now = () => real() + d; }, ms);
  assert.equal(await calls(), 1);
  await shiftClock(35_000); // 过了前端 30 秒节流，但还在 1 分钟之内
  await p.evaluate(() => window.dispatchEvent(new Event("focus")));
  await p.waitForTimeout(400);
  assert.equal(await calls(), 1, "1 分钟内拉过：不请求站点");
  await shiftClock(90_000); // 现在距上次拉取已经超过 1 分钟
  await p.evaluate(() => window.dispatchEvent(new Event("focus")));
  await p.waitForFunction(() => window.__listGroupsCalls === 2);
  await done(p);
});

test("测速失败：时延列显示失败原因的短标签（余额不足/无可用账号/模型不可用），悬停看站点原话，结束后汇总", async () => {
  const p = await open("sites1,probefail");
  await T(p, "group-card-alpha-2").waitFor();
  await T(p, "speed-test").click();
  await p.waitForFunction(() => !document.querySelector('[data-testid="speed-test"]')?.textContent.includes("停止"));
  assert.equal(await T(p, "speed-alpha-2").textContent(), "余额不足");
  assert.equal(await T(p, "speed-alpha-4").textContent(), "无可用账号");
  assert.equal(await T(p, "speed-alpha-12").textContent(), "模型不可用");
  assert.match(await T(p, "speed-alpha-2").getAttribute("data-tip"), /Insufficient account balance/, "悬停能看到站点的原话");
  const toast = await T(p, "toast").textContent();
  assert.match(toast, /3\/3 个分组测速失败/);
  assert.match(toast, /余额不足 1/);
  assert.match(toast, /无可用账号 1/);
  assert.match(toast, /站点上游的问题/);
  await done(p);
});

test("数据被清理软件删除后：明确提示原因和以前的站点，可一键恢复站点列表（需重新登录）", async () => {
  const p = await open("dataloss");
  await T(p, "data-loss").waitFor();
  const text = await T(p, "data-loss").textContent();
  assert.match(text, /数据被清除了/);
  assert.match(text, /Alpha、Beta/, "列出以前的站点");
  assert.match(text, /腾讯柠檬/);
  assert.match(text, /不受影响/, "说明客户端自己的配置没丢");
  assert.equal(await count(p, '[data-testid="empty-sites"]'), 0, "不再显示“还没有添加站点”的欢迎页");
  await T(p, "restore-sites").click();
  await T(p, "relogin-alpha").waitFor();
  await T(p, "relogin-beta").waitFor();
  assert.match(await T(p, "toast").textContent(), /已恢复 2 个站点/);
  assert.equal(await count(p, '[data-testid="data-loss"]'), 0);
  await done(p);
});

test("数据被清理软件删除后选择“忽略，重新开始”：回到普通欢迎页，不再提示", async () => {
  const p = await open("dataloss");
  await T(p, "data-loss").waitFor();
  await T(p, "dismiss-loss").click();
  await T(p, "empty-sites").waitFor();
  assert.equal(await count(p, '[data-testid="data-loss"]'), 0);
  await done(p);
});

test("正常启动（没有数据丢失）不会看到丢失提示", async () => {
  const p = await open();
  await T(p, "empty-sites").waitFor();
  assert.equal(await count(p, '[data-testid="data-loss"]'), 0);
  await done(p);
});

test("下拉框展开期间不会被重绘替换：窗口获得焦点触发刷新后，选中的站点立即生效", async () => {
  const p = await open("sites2");
  await T(p, "group-card-alpha-2").waitFor();
  // 用户点开站点下拉框（焦点在 select 上）
  await T(p, "site-filter").focus();
  await p.evaluate(() => { window.__sel = document.querySelector('[data-testid="site-filter"]'); });
  // 同时窗口获得焦点，触发余额/分组刷新（过去会把下拉框整个换掉）
  await p.evaluate(() => { const real = Date.now; Date.now = () => real() + 120_000; });
  await p.evaluate(() => window.dispatchEvent(new Event("focus")));
  await p.waitForFunction(() => window.__listGroupsCalls >= 2);
  await p.waitForTimeout(500);
  assert.equal(await p.evaluate(() => document.contains(window.__sel)), true, "刷新没有替换正在用的下拉框");
  // 此时选中某个站点：第一次就要生效，并且下拉框显示的就是它
  await T(p, "site-filter").selectOption("beta");
  assert.equal(await cards(p), 1, "第一次选择就完成了筛选");
  assert.equal(await T(p, "site-filter").inputValue(), "beta", "下拉框显示的是选中的站点，不是“全部站点”");
  // 选完之后被推迟的重绘已补上：刷新时间等内容是最新的
  assert.match(await T(p, "refresh-time").textContent(), /刷新$/);
  await done(p);
});

test("测速时站点的 Key 创建后读不回来：只停掉这个站点，不再对它的其他分组继续创建 Key", async () => {
  const p = await open("sites2,keyfail");
  await T(p, "group-card-alpha-2").waitFor();
  await T(p, "speed-test").click();
  await p.waitForFunction(() => !document.querySelector('[data-testid="speed-test"]')?.textContent.includes("停止"));
  assert.equal(await T(p, "speed-alpha-2").textContent(), "Key 异常");
  assert.match(await T(p, "speed-alpha-4").getAttribute("data-tip"), /已跳过/, "同站点其余分组直接跳过");
  assert.equal(await T(p, "speed-alpha-4").textContent(), "已跳过");
  assert.match(await T(p, "speed-beta-Claude 逆向Kiro").textContent(), /^\d+\.\d{2}s$/, "别的站点照常测");
  const toast = await T(p, "toast").textContent();
  assert.match(toast, /Key 创建或读取出现异常，已停止对它的测速/);
  assert.match(toast, /ferrydeck\.log/);
  await done(p);
});

// ---------- 主窗口：红框、智能体切换时清筛选、模型列对齐 ----------

test("有问题的站点卡片外框不是红色（只用红字提示原因）", async () => {
  const p = await open("sites2,expired");
  await T(p, "site-error-beta").waitFor();
  const color = (id) => T(p, id).evaluate((e) => getComputedStyle(e).borderTopColor);
  assert.equal(await color("site-beta"), await color("site-alpha"), "出错的站点卡和正常的站点卡外框同色");
  await done(p);
});

test("切换智能体时清掉模型筛选，不会把 Claude 的筛选带到 Codex", async () => {
  const p = await open("sites2");
  await T(p, "group-card-alpha-2").waitFor();
  await T(p, "speed-test").click(); // 测速会拉到各分组的真实模型，模型筛选才有选项
  await p.waitForFunction(() => !document.querySelector('[data-testid="speed-test"]')?.textContent.includes("停止"));
  await T(p, "model-filter").selectOption("claude-sonnet-5");
  assert.equal(await T(p, "model-filter").inputValue(), "claude-sonnet-5");
  await T(p, "client-codex").click();
  assert.equal(await T(p, "model-filter").inputValue(), "", "切到 Codex 后筛选已清除");
  assert.equal(await count(p, '[data-testid="empty-client"]'), 0, "不会因为沿用旧筛选而显示“没有提供…的分组”");
  await T(p, "client-claude").click();
  assert.equal(await T(p, "model-filter").inputValue(), "", "切回来也不会残留");
  await done(p);
});

test("模型列：标题里的下拉和每一行的模型数量左边缘对齐，标题的箭头紧贴文字", async () => {
  const p = await open("sites2");
  await T(p, "group-card-alpha-2").waitFor();
  await T(p, "speed-test").click();
  await p.waitForFunction(() => !document.querySelector('[data-testid="speed-test"]')?.textContent.includes("停止"));
  await p.waitForFunction(() => document.querySelectorAll('[data-testid^="row-models-"]').length >= 3);
  const rights = await p.evaluate(() => {
    const head = document.querySelector('[data-testid="model-filter"]').getBoundingClientRect();
    const rows = [...document.querySelectorAll('[data-testid^="row-models-"]')].map((e) => e.getBoundingClientRect());
    return { head: { left: head.left, right: head.right }, rows: rows.map((r) => ({ left: r.left, right: r.right })) };
  });
  for (const r of rights.rows) {
    assert.ok(Math.abs(r.left - rights.head.left) <= 1, `行的左边缘 ${r.left} 和标题的 ${rights.head.left} 对不上`);
  }
  // 标题的下拉框按内容收缩：箭头紧贴“模型”两个字，不被推到整列的最右边
  const headW = await T(p, "model-filter").evaluate((e) => e.getBoundingClientRect().width);
  assert.ok(headW < 70, `标题下拉框应紧贴文字，实际宽度 ${headW}`);
  // 其余各列（时延、倍率、操作）的右边缘也和标题对齐
  const edges = await p.evaluate(() => {
    const right = (e) => Math.round(e.getBoundingClientRect().right);
    const head = document.querySelector('[data-testid="list-head"]');
    const row = document.querySelector('[data-testid="group-card-alpha-2"]');
    return ["cell-speed", "cell-rate", "card-action"].map((c) => [c, right(head.querySelector("." + c)), right(row.querySelector("." + c))]);
  });
  for (const [c, h, r] of edges) assert.ok(Math.abs(h - r) <= 1, `${c}：标题 ${h} 和行 ${r} 对不上`);
  await done(p);
});

// ---------- 菜单栏面板（用模拟的 Tauri 环境直接加载 panel.html）----------

async function openPanel({ emitOnList = false, active = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 380, height: 420 } });
  await ctx.addInitScript(({ emitOnList: emitOnListFlag, active: activeFlag }) => {
    const handlers = {};
    window.__calls = [];
    window.__listArgs = [];
    window.__listCount = 0;
    let nextId = 1;
    const emit = (ev) => (handlers[ev] || []).forEach((id) => window["_" + id]({ event: ev, id: 0, payload: null }));
    window.__emit = emit;
    const site = (id, name) => ({ id, kind: "sub2api", name, base_url: `https://${id}.example.com`, connected: true, account: { display: "me", balance: "$1" }, error: null, needs_login: false });
    const grp = (site_id, id, name, clients) => ({ site_id, site_name: site_id, id, name, description: null, platform: "x", rate_multiplier: 1, clients, models: [], clients_inferred: false });
    window.__TAURI_INTERNALS__ = {
      transformCallback(cb) { const id = nextId++; window["_" + id] = cb; return id; },
      async invoke(cmd, args) {
        window.__calls.push(cmd);
        if (cmd === "plugin:event|listen") { (handlers[args.event] ||= []).push(args.handler); return nextId++; }
        if (cmd === "plugin:event|unlisten") return null;
        if (cmd === "list_groups") {
          window.__listCount++;
          window.__listArgs.push(args);
          // 模拟旧版后端的缺陷：每次读取分组都顺手发一个“刷新”事件（面板收到后又来读取，形成循环）
          if (emitOnListFlag) setTimeout(() => emit("panel-shown"), 0);
          return { groups: [grp("alpha", "1", "Claude 分组", ["claude", "claude_desktop"]), grp("alpha", "2", "GPT 分组", ["codex"])], sites: [site("alpha", "Alpha")], fetched_at: Math.floor(Date.now() / 1000) };
        }
        if (cmd === "overview") return ["claude", "claude_desktop", "codex", "gemini"].map((client) => (activeFlag && client === "claude" ? { client, dir_exists: true, in_use: true, active: { site_id: "alpha", site_name: "Alpha", group_id: "1", group_name: "Claude 分组", model: null }, conflicts: [], groups_inferred: false } : { client, dir_exists: true, in_use: false, active: null, conflicts: [], groups_inferred: false }));
        return null;
      },
    };
  }, { emitOnList, active });
  const page = await ctx.newPage();
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(String(e)));
  await page.goto(`${BASE}/panel.html`);
  return page;
}

test("菜单栏面板：切换标签、打开主窗口、退出都有响应", async () => {
  const p = await openPanel();
  await T(p, "panel-tab-codex").waitFor();
  assert.equal(await count(p, '[data-testid^="panel-row-"]'), 1, "Claude 标签下只有 Claude 的分组");
  await T(p, "panel-tab-codex").click();
  assert.match(await T(p, "panel-tab-codex").getAttribute("class"), /\bon\b/, "点击后标签切换了");
  assert.equal(await count(p, '[data-testid="panel-row-alpha-2"]'), 1, "显示的是 Codex 的分组");
  await T(p, "panel-open-main").click();
  await T(p, "panel-quit").click();
  const calls = await p.evaluate(() => window.__calls);
  for (const c of ["panel_open_main", "panel_quit", "panel_note"]) assert.ok(calls.includes(c), `应当调用了 ${c}: ${calls}`);
  assert.deepEqual(p.errors, []);
  await p.context().close();
});

test("菜单栏面板：即使后端每次读取都发刷新事件，也不会无限循环刷新（否则按钮根本点不中）", async () => {
  const p = await openPanel({ emitOnList: true });
  await T(p, "panel-tab-codex").waitFor();
  await p.waitForTimeout(2600);
  const n = await p.evaluate(() => window.__listCount);
  assert.ok(n <= 4, `2.6 秒内读取了 ${n} 次分组，说明在循环刷新`);
  // 按钮在这段时间里没有被反复换掉：点击能落到
  await T(p, "panel-tab-gemini").click();
  assert.match(await T(p, "panel-tab-gemini").getAttribute("class"), /\bon\b/);
  await p.context().close();
});

test("菜单栏面板：打开用一分钟内的缓存，点刷新才强制向站点拉取", async () => {
  const p = await openPanel();
  await T(p, "panel-refresh").waitFor();
  assert.equal(await p.evaluate(() => window.__listArgs[0].maxAgeSecs), 60, "打开面板：允许用一分钟内的缓存");
  await T(p, "panel-refresh").click();
  await p.waitForFunction(() => window.__listArgs.length >= 2);
  assert.equal(await p.evaluate(() => window.__listArgs.at(-1).maxAgeSecs), 0, "手动刷新：不用缓存");
  await p.context().close();
});

test("刷新时间用“N秒前 / N分钟前 / N小时前刷新”的写法，并且自己会更新", async () => {
  const p = await open("sites1");
  await T(p, "group-card-alpha-2").waitFor();
  assert.match(await T(p, "refresh-time").textContent(), /^(刚刚刷新|\d+秒前刷新)$/);
  const shift = (ms) => p.evaluate((d) => { const real = Date.now; Date.now = () => real() + d; }, ms);
  await shift(40_000);
  await p.waitForFunction(() => /^(4\d|3\d)秒前刷新$/.test(document.querySelector('[data-testid="refresh-time"]').textContent), null, { timeout: 12_000 });
  await shift(130_000);
  await p.waitForFunction(() => /^[23]分钟前刷新$/.test(document.querySelector('[data-testid="refresh-time"]').textContent), null, { timeout: 12_000 });
  await shift(2 * 3600_000);
  await p.waitForFunction(() => /^2小时前刷新$/.test(document.querySelector('[data-testid="refresh-time"]').textContent), null, { timeout: 12_000 });
  assert.match(await T(p, "refresh-time").getAttribute("data-tip"), /最近一次向站点拉取分组.*小时前刷新/);
  await done(p);
});

test("站点卡的充值/移除图标平时隐藏，悬停到卡片上才显示；分组行的启用图标同理，“使用中”一直显示", async () => {
  const p = await open("sites2,expired");
  await T(p, "group-card-alpha-2").waitFor();
  const opacity = (id) => T(p, id).evaluate((e) => getComputedStyle(e.closest(".site-icons") ?? e).opacity);
  assert.equal(await opacity("topup-alpha"), "0", "默认隐藏");
  assert.equal(await opacity("remove-alpha"), "0");
  await T(p, "site-alpha").hover();
  await p.waitForFunction(() => getComputedStyle(document.querySelector('[data-testid="topup-alpha"]').closest(".site-icons")).opacity === "1");
  assert.equal(await opacity("remove-alpha"), "1");
  // 登录失效的站点也同样有这两个图标
  await T(p, "site-beta").hover();
  await p.waitForFunction(() => getComputedStyle(document.querySelector('[data-testid="topup-beta"]').closest(".site-icons")).opacity === "1");
  assert.equal(await count(p, '[data-testid="remove-beta"]'), 1);
  // 分组行
  const enableOpacity = () => T(p, "enable-alpha-2").evaluate((e) => getComputedStyle(e).opacity);
  await p.mouse.move(2, 2);
  await p.waitForFunction(() => getComputedStyle(document.querySelector('[data-testid="enable-alpha-2"]')).opacity === "0");
  await T(p, "group-card-alpha-2").hover();
  await p.waitForFunction(() => getComputedStyle(document.querySelector('[data-testid="enable-alpha-2"]')).opacity === "1");
  await T(p, "enable-alpha-2").click();
  await p.waitForFunction(() => document.querySelector('[data-testid="group-card-alpha-2"]')?.textContent.includes("使用中"));
  await p.mouse.move(2, 2);
  assert.equal(await T(p, "group-card-alpha-2").locator(".badge").isVisible(), true, "“使用中”不需要悬停");
  assert.equal(await enableOpacity().catch(() => "gone"), "gone", "已启用的行不再有启用按钮");
  await done(p);
});

// ---------- 再次测速时问范围 ----------

const probeSites = (p) => p.evaluate(() => window.__probeSites ?? []);
const waitTestDone = (p) => p.waitForFunction(() => !document.querySelector('[data-testid="speed-test"]')?.textContent.includes("停止"));

test("再次测速：全部分组都已有结果时，先问要不要全部重测，取消就不发任何请求", async () => {
  const p = await open("sites1");
  await T(p, "group-card-alpha-2").waitFor();
  await T(p, "speed-test").click();
  await waitTestDone(p);
  assert.equal((await probeSites(p)).length, 3, "第一次：三个分组各测一次");
  await T(p, "speed-test").click();
  await T(p, "speed-scope-dialog").waitFor();
  assert.match(await T(p, "speed-scope-dialog").textContent(), /都已经有测速结果/);
  assert.equal(await count(p, '[data-testid="speed-scope-missing"]'), 0, "没有“还没结果”的分组，就不提供只测它们的选项");
  await T(p, "speed-scope-cancel").click();
  assert.equal((await probeSites(p)).length, 3, "取消：没有再发请求");
  await T(p, "speed-test").click();
  await T(p, "speed-scope-all").click();
  await waitTestDone(p);
  assert.equal((await probeSites(p)).length, 6, "选全部重测：又测了三个");
  await done(p);
});

test("再次测速：有的分组没有结果（被限流跳过）时，默认只测没结果的，选“全部”才连已有结果的一起重测", async () => {
  const p = await open("sites2,ratelimit");
  await T(p, "group-card-alpha-2").waitFor();
  await T(p, "speed-test").click();
  await waitTestDone(p);
  // 第一次：Alpha 第一个分组被限流、其余两个跳过；Beta 测出了结果
  assert.deepEqual(await probeSites(p), ["alpha", "beta"]);
  await T(p, "speed-test").click();
  await T(p, "speed-scope-dialog").waitFor();
  const text = await T(p, "speed-scope-dialog").textContent();
  assert.match(text, /1 个已经有结果，3 个还没有结果/);
  assert.match(text, /默认只测还没有结果的分组/);
  assert.equal(await T(p, "speed-scope-missing").textContent(), "只测没有结果的 3 个（推荐）");
  assert.equal(await p.evaluate(() => document.activeElement?.getAttribute("data-testid")), "speed-scope-missing", "默认选中的是“只测没结果的”");
  await T(p, "speed-scope-missing").click();
  await waitTestDone(p);
  // 只重新碰了 Alpha（它仍然限流）；已经有结果的 Beta 没有被再测
  assert.deepEqual(await probeSites(p), ["alpha", "beta", "alpha"]);
  await T(p, "speed-test").click();
  await T(p, "speed-scope-all").click();
  await waitTestDone(p);
  assert.deepEqual(await probeSites(p), ["alpha", "beta", "alpha", "alpha", "beta"], "全部重测：Beta 也重测了");
  await done(p);
});

test("站点明确回答的失败（余额不足、无可用账号、模型不可用）也算有结果，再次测速不会白白重试", async () => {
  const p = await open("sites1,probefail");
  await T(p, "group-card-alpha-2").waitFor();
  await T(p, "speed-test").click();
  await waitTestDone(p);
  await T(p, "speed-test").click();
  await T(p, "speed-scope-dialog").waitFor();
  assert.match(await T(p, "speed-scope-dialog").textContent(), /都已经有测速结果/);
  await done(p);
});

test("第一次点测速弹出说明，确认后直接开始（没有结果可言，不再问范围）", async () => {
  const p = await open("sites1", { width: 960, height: 680 }, { speedConfirmed: false });
  await T(p, "group-card-alpha-2").waitFor();
  await T(p, "speed-test").click();
  await T(p, "speed-start").click();
  await waitTestDone(p);
  assert.equal(await count(p, '[data-testid="speed-scope-dialog"]'), 0);
  assert.equal((await probeSites(p)).length, 3);
  await done(p);
});

// ---------- 测速时的滚动、悬停、提示 ----------

test("测速过程中向下滚动列表，列表不会被弹回顶部", async () => {
  const p = await open("sites2", { width: 960, height: 300 });
  await T(p, "group-card-alpha-2").waitFor();
  assert.ok(await p.evaluate(() => { const c = document.querySelector(".content"); return c.scrollHeight > c.clientHeight + 40; }), "窗口够矮，列表需要滚动");
  // 先开始测速（按钮在列表顶部），再在测速进行中向下滚动——和用户的操作顺序一致
  await T(p, "speed-test").click();
  await p.waitForFunction(() => document.querySelector('[data-testid^="probing-"]'));
  await p.evaluate(() => { document.querySelector(".content").scrollTop = 60; });
  // 在页面里每 40ms 记一次滚动位置的最小值
  await p.evaluate(() => { window.__minScroll = 1e9; setInterval(() => { window.__minScroll = Math.min(window.__minScroll, document.querySelector(".content")?.scrollTop ?? 0); }, 40); });
  await waitTestDone(p);
  await p.waitForTimeout(150);
  const min = await p.evaluate(() => window.__minScroll);
  assert.ok(min >= 55, `测速的每次重绘都不能把滚动位置重置：最小 ${min}`);
  await done(p);
});

test("鼠标移走后启动图标一定消失；界面重绘后悬停状态也按鼠标当前位置重算", async () => {
  const p = await open("sites2");
  await T(p, "group-card-alpha-2").waitFor();
  const op = (id) => T(p, id).evaluate((e) => getComputedStyle(e).opacity);
  await T(p, "group-card-alpha-2").hover();
  await p.waitForFunction(() => document.querySelector('[data-testid="group-card-alpha-2"]').classList.contains("is-hover"));
  // 鼠标不动，界面重绘（比如切回窗口触发的刷新）：新节点也应当是悬停状态
  await p.evaluate(() => { const real = Date.now; Date.now = () => real() + 120_000; });
  await p.evaluate(() => window.dispatchEvent(new Event("focus")));
  await p.waitForFunction(() => window.__listGroupsCalls >= 2);
  await p.waitForTimeout(300);
  assert.equal(await p.evaluate(() => document.querySelector('[data-testid="group-card-alpha-2"]').classList.contains("is-hover")), true, "重绘后仍在鼠标下面的那张卡还是悬停");
  // 鼠标移到别处：所有行的启动图标都消失，不残留
  await p.mouse.move(2, 2);
  await p.waitForFunction(() => document.querySelectorAll(".card.is-hover, .site-card.is-hover").length === 0);
  for (const id of ["enable-alpha-2", "enable-alpha-4", "enable-alpha-12"]) {
    await p.waitForFunction((t) => getComputedStyle(document.querySelector(`[data-testid="${t}"]`)).opacity === "0", id, { timeout: 2000 }).catch(() => {});
    assert.equal(await op(id), "0", `${id} 不应残留`);
  }
  // 连着扫过三行，也只有鼠标当前所在的那一行显示
  await T(p, "group-card-alpha-2").hover();
  await T(p, "group-card-alpha-4").hover();
  await p.waitForFunction(() => document.querySelectorAll(".card.is-hover").length === 1 && document.querySelector('[data-testid="group-card-alpha-4"]').classList.contains("is-hover"));
  await done(p);
});

test("测速结果的提示几乎立即出现（不用等系统 title 的一两秒），移开就消失", async () => {
  const p = await open("sites2,keyfail");
  await T(p, "group-card-alpha-2").waitFor();
  await T(p, "speed-test").click();
  await waitTestDone(p);
  await T(p, "speed-alpha-4").hover(); // “已跳过”
  const t0 = Date.now();
  await p.waitForFunction(() => { const t = document.getElementById("fd-tip"); return t && getComputedStyle(t).display === "block" && /已跳过/.test(t.textContent); }, null, { timeout: 1500 });
  assert.ok(Date.now() - t0 < 700, `提示出现用了 ${Date.now() - t0} ms`);
  const box = await p.evaluate(() => { const r = document.getElementById("fd-tip").getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom, innerWidth, innerHeight]; });
  assert.ok(box[0] >= 0 && box[2] <= box[4] && box[1] >= 0 && box[3] <= box[5], `提示要完整在窗口里: ${box}`);
  await p.mouse.move(2, 2);
  await p.waitForFunction(() => getComputedStyle(document.getElementById("fd-tip")).display === "none");
  // 失败原因（站点的原话）同样即时可见
  await T(p, "speed-alpha-2").hover();
  await p.waitForFunction(() => /创建 Key 后没有找到它/.test(document.getElementById("fd-tip").textContent), null, { timeout: 1500 });
  await done(p);
});

// ---------- 悬停才显示的图标与刷新提示 ----------

test("菜单栏面板：分组的启用图标平时隐藏，鼠标移到那一行才显示，移走就消失；“使用中”一直显示", async () => {
  const p = await openPanel({ active: true });
  await T(p, "panel-tab-claude").waitFor();
  // 在 Claude 标签下再放一个未启用的分组：用 Codex 标签里的那个未启用分组来验证
  await T(p, "panel-tab-codex").click();
  const power = () => p.evaluate(() => getComputedStyle(document.querySelector('[data-testid="panel-row-alpha-2"] .panel-power')).opacity);
  await p.mouse.move(2, 2);
  await p.waitForFunction(() => getComputedStyle(document.querySelector('[data-testid="panel-row-alpha-2"] .panel-power')).opacity === "0");
  assert.equal(await power(), "0", "默认不显示启用图标");
  await T(p, "panel-row-alpha-2").hover();
  await p.waitForFunction(() => getComputedStyle(document.querySelector('[data-testid="panel-row-alpha-2"] .panel-power')).opacity === "1");
  await p.mouse.move(2, 2);
  await p.waitForFunction(() => getComputedStyle(document.querySelector('[data-testid="panel-row-alpha-2"] .panel-power')).opacity === "0");
  // 正在使用的分组：文案一直在，没有启用图标
  await T(p, "panel-tab-claude").click();
  assert.equal(await T(p, "panel-row-alpha-1").locator(".badge").isVisible(), true);
  assert.equal(await T(p, "panel-row-alpha-1").locator(".badge").textContent(), "使用中");
  assert.equal(await T(p, "panel-row-alpha-1").locator(".panel-power").count(), 0);
  assert.deepEqual(p.errors, []);
  await p.context().close();
});

test("鼠标停在刷新按钮上，立刻说明刷新会获取什么（主窗口和菜单栏面板各有说明）", async () => {
  const p = await open("sites1");
  await T(p, "group-card-alpha-2").waitFor();
  await T(p, "refresh").hover();
  const t0 = Date.now();
  await p.waitForFunction(() => { const t = document.getElementById("fd-tip"); return t && getComputedStyle(t).display === "block" && /手动刷新/.test(t.textContent); }, null, { timeout: 1500 });
  assert.ok(Date.now() - t0 < 700, `提示出现用了 ${Date.now() - t0} ms`);
  const tip = await p.evaluate(() => document.getElementById("fd-tip").textContent);
  for (const part of ["账号名称和余额", "分组列表", "可用模型", "不会创建 Key", "不会测速", "一分钟内"]) assert.ok(tip.includes(part), `提示里应当有“${part}”: ${tip}`);
  // 刷新时间也有说明
  await T(p, "refresh-time").hover();
  await p.waitForFunction(() => /最近一次向站点拉取分组/.test(document.getElementById("fd-tip").textContent), null, { timeout: 1500 });
  await done(p);

  const panel = await openPanel();
  await T(panel, "panel-refresh").waitFor();
  await T(panel, "panel-refresh").hover();
  await panel.waitForFunction(() => { const t = document.getElementById("fd-tip"); return t && getComputedStyle(t).display === "block" && /分组列表/.test(t.textContent); }, null, { timeout: 1500 });
  const ptip = await panel.evaluate(() => document.getElementById("fd-tip").textContent);
  for (const part of ["分组列表", "不会创建 Key", "不会测速", "一分钟内"]) assert.ok(ptip.includes(part), `面板提示里应当有“${part}”: ${ptip}`);
  await panel.context().close();
});

test("添加没有对分组分类的站点（new-api）后弹窗说明对体验的影响，点确定关闭；普通站点、重新登录不弹", async () => {
  const p = await open("sites1");
  await T(p, "group-card-alpha-2").waitFor();
  // 添加 new-api 站点 Beta
  await addSite(p, "beta.example.com");
  await T(p, "unclassified-dialog").waitFor();
  const text = await T(p, "unclassified-dialog").textContent();
  assert.match(text, /该站点没有对分组分类/);
  assert.match(text, /「beta\.example\.com」/, "说明是哪个站点（添加时用的站点名）");
  assert.match(text, /每一种客户端下都列出来/);
  assert.match(text, /未对分组分类/);
  assert.match(text, /用起来会失败/);
  assert.match(text, /模型.*测速/);
  assert.equal(await p.evaluate(() => document.activeElement?.getAttribute("data-testid")), "unclassified-ok", "“确定”默认聚焦，回车即可关闭");
  assert.match(await T(p, "toast").textContent(), /已添加站点/, "添加成功的提示仍然在");
  await T(p, "unclassified-ok").click();
  assert.equal(await count(p, '[data-testid="unclassified-dialog"]'), 0, "点确定后关闭");
  // 站点已添加，分组列表里这个站点的分组带着“未分类”标注
  assert.equal(await count(p, '[data-testid^="unclassified-beta-"]') > 0, true);
  await done(p);

  // 添加 sub2api 站点（分组有分类）：不弹
  const q = await open();
  await addSite(q, "alpha.example.com");
  await T(q, "group-card-alpha-2").waitFor();
  assert.equal(await count(q, '[data-testid="unclassified-dialog"]'), 0, "有分类的站点不需要提示");
  await done(q);

  // 已有的 new-api 站点重新登录：不弹
  const r = await open("sites2,expired");
  await T(r, "relogin-beta").waitFor();
  await T(r, "relogin-beta").click();
  await T(r, "add-username").fill("demo");
  await T(r, "add-password").fill("ok123");
  await T(r, "add-submit").click();
  await T(r, "group-card-beta-Claude 逆向Kiro").waitFor();
  assert.equal(await count(r, '[data-testid="unclassified-dialog"]'), 0, "重新登录不是新增站点，不再提示");
  await done(r);
});

// ---------- 添加站点对话框的文案、遮罩；刷新时就带上模型 ----------

test("添加站点对话框：提示里不再有“支持 new-api 和 sub2api”；遮罩足够暗，后面的页面不会和对话框抢眼", async () => {
  const p = await open();
  await T(p, "empty-sites-add").click();
  await T(p, "add-url").waitFor();
  const text = await p.locator(".modal").innerText();
  assert.match(text, /填你平时登录的那个中转站网址。/);
  assert.doesNotMatch(text, /支持 new-api 和 sub2api/);
  const mask = await p.evaluate(() => { const c = getComputedStyle(document.querySelector(".modal-mask")); return { bg: c.backgroundColor, blur: c.backdropFilter || c.webkitBackdropFilter }; });
  const alpha = Number((mask.bg.match(/rgba?\([^)]*?,\s*([\d.]+)\)/) ?? [])[1] ?? 1);
  assert.ok(alpha >= 0.65, `遮罩不透明度 ${alpha}`);
  assert.match(mask.blur, /blur/, "后面的页面模糊处理");
  await done(p);
});

test("站点有模型广场时，刷新就带上各分组的模型：不用测速，模型列和模型筛选立刻可用", async () => {
  const p = await open("sites1,plaza");
  await T(p, "group-card-alpha-2").waitFor();
  assert.equal(await T(p, "row-models-alpha-2").evaluate((e) => e.tagName), "BUTTON", "没测速，模型列也显示模型数量而不是“—”");
  assert.match(await T(p, "row-models-alpha-2").textContent(), /\d+ 个模型/);
  await T(p, "row-models-alpha-2").click();
  await T(p, "drawer-models").waitFor();
  assert.ok((await count(p, ".model-list li")) >= 1, "抽屉里列出模型");
  await p.keyboard.press("Escape");
  await T(p, "cost-drawer").waitFor({ state: "detached" });
  assert.equal(await T(p, "model-filter").isDisabled(), false, "模型筛选可用");
  const options = await T(p, "model-filter").locator("option").allTextContents();
  assert.ok(options.includes("claude-sonnet-5-5"), `筛选里有模型: ${options}`);
  await T(p, "model-filter").selectOption("claude-opus-5-5");
  assert.ok((await cards(p)) >= 1);
  assert.equal(await count(p, '[data-testid="speed-alpha-2"]'), 0, "没有任何测速结果");
  // 刷新按钮的说明里写明了模型的来源
  await T(p, "refresh").hover();
  await p.waitForFunction(() => /模型广场/.test(document.getElementById("fd-tip")?.textContent ?? ""), null, { timeout: 1500 });
  await done(p);

  // 没有模型广场的站点：刷新前后都是“—”，要靠测速或已建的 Key
  const q = await open("sites1");
  await T(q, "group-card-alpha-2").waitFor();
  assert.equal(await T(q, "row-models-alpha-2").evaluate((e) => e.tagName), "SPAN");
  await done(q);
});

// ---------- 模型候选项、测速按钮位置、添加站点的进度提示 ----------

/** 当前列表里每个分组行的模型下拉里的模型合起来（去重）——模型筛选的候选项应当恰好等于它。 */
const listedModels = async (p) => {
  // 模型列表在抽屉里：逐行点开收集
  const ids = await p.evaluate(() => [...document.querySelectorAll('[data-testid^="row-models-"]')].map((e) => e.getAttribute("data-testid")));
  const out = new Set();
  for (const id of ids) {
    await T(p, id).click();
    for (const m of await p.locator(".model-list li").allTextContents()) out.add(m);
    await p.keyboard.press("Escape");
    await T(p, "cost-drawer").waitFor({ state: "detached" });
  }
  return [...out].sort();
};
const filterOptions = (p) => p.evaluate(() => [...document.querySelector('[data-testid="model-filter"]').options].map((o) => o.value).filter(Boolean));

test("模型下拉的候选项恰好是当前列出的分组的模型（去重），不出现无关的模型；换站点筛选时跟着变", async () => {
  const p = await open("sites2,plaza");
  await T(p, "group-card-alpha-2").waitFor();
  const check = async (label) => {
    const opts = await filterOptions(p);
    assert.deepEqual(opts, await listedModels(p), `${label}：候选项应当等于当前列出分组的模型并集`);
    assert.equal(new Set(opts).size, opts.length, `${label}：不重复`);
    assert.deepEqual(opts, [...opts].sort(), `${label}：有序`);
    return opts;
  };
  const all = await check("全部站点");
  assert.ok(all.includes("beta-only-model") && all.includes("claude-opus-5-5"));
  await T(p, "site-filter").selectOption("beta");
  assert.deepEqual(await check("只看 Beta"), ["beta-only-model", "claude-sonnet-5-5"], "Beta 的分组只有这两个模型，Alpha 的模型不该出现");
  await T(p, "site-filter").selectOption("alpha");
  const alpha = await check("只看 Alpha");
  assert.ok(!alpha.includes("beta-only-model"), "Beta 独有的模型不该出现在 Alpha 的候选项里");
  await T(p, "site-filter").selectOption("all");
  await T(p, "client-codex").click();
  await check("Codex 标签");
  await done(p);
});

test("选中的模型换了站点筛选后不在候选项里：筛选条件一并清掉，列表不会被看不见的条件过滤成空", async () => {
  const p = await open("sites2,plaza");
  await T(p, "group-card-alpha-2").waitFor();
  await T(p, "model-filter").selectOption("claude-opus-5-5"); // Alpha 独有
  assert.equal(await count(p, '[data-testid^="group-card-beta-"]'), 0, "Beta 没有这个模型，被筛掉");
  await T(p, "site-filter").selectOption("beta");
  assert.equal(await T(p, "model-filter").inputValue(), "", "下拉框回到“模型”");
  assert.ok((await count(p, '[data-testid^="group-card-beta-"]')) >= 1, "Beta 的分组还在列表里，没有被残留的筛选过滤掉");
  assert.equal(await count(p, '[data-testid="empty-client"]'), 0);
  await done(p);
});

test("添加站点后用提示条说明进度：开始刷新分组 → 开始刷新模型列表 → 完成", async () => {
  const p = await open("sites1");
  await T(p, "group-card-alpha-2").waitFor();
  await p.evaluate(() => {
    window.__toasts = [];
    new MutationObserver(() => {
      const t = document.querySelector('[data-testid="toast"]')?.textContent;
      if (t && window.__toasts.at(-1) !== t) window.__toasts.push(t);
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
  });
  await addSite(p, "beta.example.com");
  await p.waitForFunction(() => window.__toasts.some((t) => /分组和模型已刷新/.test(t)));
  const seq = await p.evaluate(() => window.__toasts);
  const at = (re) => seq.findIndex((t) => re.test(t));
  assert.ok(at(/开始刷新分组/) >= 0, `缺少“开始刷新分组”: ${seq}`);
  assert.ok(at(/开始刷新模型列表/) > at(/开始刷新分组/), `“开始刷新模型列表”要在“开始刷新分组”之后: ${seq}`);
  assert.ok(at(/已添加站点「beta\.example\.com」，分组和模型已刷新/) > at(/开始刷新模型列表/), `最后是完成提示: ${seq}`);
  await done(p);
});

test("点 Token成本 的数字，右侧抽屉滑出并展示成本、缓存命中率、真实首字时延；行里没有硬币图标", async () => {
  const p = await open("sites1,realfrt");
  await T(p, "group-card-alpha-2").waitFor();
  assert.equal(await count(p, ".cost-btn, [data-testid=cost-fetch]"), 0, "没有成本图标和按钮");
  await p.waitForFunction(() => document.querySelector('[data-testid="cost-val-alpha-2"]')?.textContent?.startsWith("$"));
  await T(p, "cost-val-alpha-2").click();
  await T(p, "cost-per-m").waitFor();
  assert.equal(await T(p, "cost-per-m").textContent(), "$2.20");
  assert.equal(await T(p, "cache-rate").textContent(), "32.0%");
  assert.match(await T(p, "real-frt").textContent(), /中位 0\.82s · P90 2\.10s/);
  assert.equal(await count(p, '[data-testid="model-table"] tbody tr'), 2);
  assert.equal(await count(p, '[data-testid="estimate-table"] tbody tr'), 1);
  const box = await p.locator(".drawer").boundingBox();
  assert.ok(box && Math.abs(box.x + box.width - 960) < 2, "抽屉贴在窗口右侧");
  await done(p);
});

test("倍率和Token成本的文字是正文白色，不是蓝色", async () => {
  const p = await open("sites1");
  await p.waitForFunction(() => document.querySelector('[data-testid="cost-val-alpha-2"]')?.textContent?.startsWith("$"));
  const colors = await p.evaluate(() => {
    const c = (e) => getComputedStyle(e).color;
    return { rate: c(document.querySelector('[data-testid="group-card-alpha-2"] .rate')), cost: c(document.querySelector('[data-testid="cost-val-alpha-2"]')), text: c(document.querySelector(".card h3")) };
  });
  assert.equal(colors.rate, colors.text);
  assert.equal(colors.cost, colors.text);
  await done(p);
});

test("成本抽屉：Esc、关闭按钮、点遮罩都能关；没有用量时给出说明；失败时可重试", async () => {
  const p = await open("sites1");
  await p.waitForFunction(() => document.querySelector('[data-testid="cost-val-alpha-4"]')?.textContent === "无用量");
  await T(p, "cost-val-alpha-2").click();
  await T(p, "cost-per-m").waitFor();
  await p.keyboard.press("Escape");
  await T(p, "cost-drawer").waitFor({ state: "detached" });
  await T(p, "cost-val-alpha-2").click();
  await T(p, "drawer-close").click();
  await T(p, "cost-drawer").waitFor({ state: "detached" });
  await T(p, "cost-val-alpha-2").click();
  await T(p, "cost-per-m").waitFor();
  await p.mouse.click(20, 300);
  await T(p, "cost-drawer").waitFor({ state: "detached" });
  await done(p);
  // 读取失败：列表里没有数字，列表的“—”点不开；抽屉的失败状态由重新取数覆盖
  const q = await open("sites1,usagefail");
  await T(q, "group-card-alpha-2").waitFor();
  assert.equal(await T(q, "cost-val-alpha-2").textContent(), "—");
  await done(q);
});

test("测速后，成本抽屉里显示空请求基线（发一句 hi 站点计的输入 Token）", async () => {
  const p = await open("sites1");
  await T(p, "group-card-alpha-2").waitFor();
  await T(p, "speed-test").click();
  await T(p, "speed-alpha-2").waitFor();
  await p.waitForFunction(() => document.querySelector('[data-testid="cost-val-alpha-2"]')?.textContent?.startsWith("$"));
  await T(p, "cost-val-alpha-2").click();
  assert.equal(await T(p, "baseline").textContent(), "24 Token");
  await done(p);
});

test("Token成本列：标题提示口径，刷新读到后显示百万有效Token成本，可按成本排序，无数据的排最后", async () => {
  const p = await open("sites1");
  await T(p, "group-card-alpha-2").waitFor();
  await T(p, "sort-cost").hover();
  await p.waitForFunction(() => document.getElementById("fd-tip")?.textContent?.includes("百万有效Token的平均成本"));
  await p.waitForFunction(() => document.querySelector('[data-testid="cost-val-alpha-2"]')?.textContent === "$2.20" && document.querySelector('[data-testid="cost-val-alpha-4"]')?.textContent === "无用量" && ![...document.querySelectorAll('[data-testid^="cost-val-"]')].some((e) => e.textContent === "—"));
  await T(p, "sort-cost").click();
  const order = () => p.evaluate(() => [...document.querySelectorAll('[data-testid^="cost-val-"]')].map((e) => e.textContent));
  const asc = (await order()).filter((t) => t.startsWith("$")).map((t) => Number(t.slice(1)));
  assert.deepEqual(asc, [...asc].sort((a, b) => a - b), "升序");
  assert.equal((await order()).at(-1), "无用量", "无数据的排最后");
  await T(p, "sort-cost").click();
  const desc = (await order()).filter((t) => t.startsWith("$")).map((t) => Number(t.slice(1)));
  assert.deepEqual(desc, [...desc].sort((a, b) => b - a), "降序");
  await done(p);
});

test("刷新后列表里的 Token成本 还在（记在本机）", async () => {
  const p = await open("sites1");
  await p.waitForFunction(() => document.querySelector('[data-testid="cost-val-alpha-2"]')?.textContent === "$2.20");
  await p.reload();
  await T(p, "cost-val-alpha-2").waitFor();
  assert.equal(await T(p, "cost-val-alpha-2").textContent(), "$2.20");
  await done(p);
});

test("刷新时一并读取成本：手动刷新全部重读，自动刷新只补过期的，不会反复敲站点", async () => {
  const p = await open("sites1");
  await T(p, "group-card-alpha-2").waitFor();
  await p.waitForFunction(() => document.querySelector('[data-testid="cost-val-alpha-2"]')?.textContent?.startsWith("$"));
  // 等打开页面时的那一轮读取完成：请求数连续 1.2 秒不再增加（慢机器上这一轮会更久）
  let first = -1;
  for (let stable = 0; stable < 4; ) {
    await p.waitForTimeout(300);
    const n = await p.evaluate(() => window.__usageCalls.length);
    stable = n === first ? stable + 1 : 0;
    first = n;
  }
  assert.ok(first > 0, "打开页面时读取成本");
  await p.evaluate(() => window.dispatchEvent(new Event("focus")));
  await p.waitForTimeout(800);
  assert.equal(await p.evaluate(() => window.__usageCalls.length), first, "自动刷新不重复读取");
  await T(p, "refresh").click();
  await p.waitForFunction((n) => window.__usageCalls.length >= n * 2, first);
  await done(p);
});

test("真实首字时延读到后，替换本地测速得到的首字时延", async () => {
  const p = await open("sites1,realfrt");
  await T(p, "group-card-alpha-2").waitFor();
  await p.waitForFunction(() => document.querySelector('[data-testid="speed-alpha-2"]')?.textContent === "0.82s");
  await T(p, "speed-test").click();
  await p.waitForFunction(() => !document.querySelector('[data-testid="speed-test"]')?.textContent.includes("停止"));
  assert.equal(await T(p, "speed-alpha-2").textContent(), "0.82s", "测速之后仍显示真实值");
  await T(p, "speed-alpha-2").hover();
  await p.waitForFunction(() => /真实首字时延/.test(document.getElementById("fd-tip")?.textContent ?? ""));
  await done(p);
});

test("测速按钮在标题栏（刷新时间右边），不在列表标题行里", async () => {
  const p = await open("sites1");
  await T(p, "group-card-alpha-2").waitFor();
  assert.equal(await p.evaluate(() => !!document.querySelector('.topbar [data-testid="speed-test"]') && !document.querySelector('[data-testid="list-head"] [data-testid="speed-test"]')), true);
  await done(p);
});

test("缓存命中率列：来自同步到的用量数据，标题提示口径，可排序，没有数据显示 —", async () => {
  const p = await open("sites1");
  await T(p, "group-card-alpha-2").waitFor();
  assert.equal(await T(p, "cache-val-alpha-2").textContent(), "—", "还没同步到就是 —");
  await p.waitForFunction(() => document.querySelector('[data-testid="cache-val-alpha-2"]')?.textContent === "32.0%" && ![...document.querySelectorAll('[data-testid^="cache-val-"]')].some((e) => e.textContent === "—" && e.closest(".card").querySelector('[data-testid^="cost-val-"]').textContent !== "无用量"));
  await T(p, "sort-cache").hover();
  await p.waitForFunction(() => /缓存读取/.test(document.getElementById("fd-tip")?.textContent ?? ""));
  await T(p, "sort-cache").click();
  const vals = await p.evaluate(() => [...document.querySelectorAll('[data-testid^="cache-val-"]')].map((e) => e.textContent));
  const nums = vals.filter((v) => v.endsWith("%")).map(parseFloat);
  assert.deepEqual(nums, [...nums].sort((a, b) => a - b), "升序");
  assert.equal(vals.at(-1), "—", "没有数据的排最后");
  await done(p);
});
