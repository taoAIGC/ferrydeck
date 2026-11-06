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
async function open(scenario = "", viewport = { width: 960, height: 680 }) {
  const ctx = await browser.newContext({ viewport });
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
  assert.match(await T(p, "toast").textContent(), /已添加站点「我的 Alpha」/);
  assert.match(await T(p, "site-alpha").textContent(), /我的 Alpha/);
  assert.match(await T(p, "site-alpha").textContent(), /sub2api/);
  assert.equal(await T(p, "site-balance-alpha").textContent(), "余额 $99.78");
  assert.equal(await selectedClient(p), "client-claude");
  assert.equal(await cards(p), 3, "Claude 类分组 3 个");
  assert.equal(await count(p, '[data-testid="unsupported"]'), 0, "不展示不支持的分组");
  assert.equal(await count(p, '[data-testid="chip-all"]'), 0, "只有一个站点时不显示筛选");
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
  assert.equal(await count(p, '[data-testid^="site-"]:not([data-testid^="site-balance"]):not([data-testid^="site-account"]):not([data-testid^="site-error"]):not([data-testid^="site-tag"]):not([data-testid="site-chips"])'), 1, "仍然只有一个站点");
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
  assert.equal(await T(p, "site-balance-alpha").textContent(), "余额 $99.78");
  assert.equal(await T(p, "site-balance-beta").textContent(), "余额 $43.51");
  assert.match(await T(p, "site-beta").textContent(), /new-api/);
  await p.screenshot({ path: "ui-tests/shots/two-sites.png" });
  await done(p);
});

test("站点筛选：只看某个站点，再切回全部；筛选后该站点没有这个客户端的分组时给出说明", async () => {
  const p = await open("sites2");
  await T(p, "group-card-alpha-2").waitFor();
  await T(p, "chip-beta").click();
  assert.equal(await cards(p), 1);
  assert.equal(await count(p, '[data-testid="group-card-beta-Claude 逆向Kiro"]'), 1);
  await T(p, "client-gemini").click();
  assert.match(await T(p, "empty-client").textContent(), /这个站点没有可用于 Gemini CLI 的分组/);
  await T(p, "chip-all").click();
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
  assert.equal(await count(p, '[data-testid="topup-beta"]'), 0, "过期站点不显示去充值");
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
  assert.equal(await T(p, "site-balance-beta").textContent(), "余额 $43.51");
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
  assert.equal(await count(p, '[data-testid="chip-all"]'), 0, "回到单站点，筛选和标签消失");
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
  assert.match(await T(p, "conflict-banner").textContent(), /尚未切换到第三方推理模式/);
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

test("更新：版本号显示；无更新时手动检查提示已是最新", async () => {
  const p = await open("sites1");
  await T(p, "version").waitFor();
  assert.match(await T(p, "version").textContent(), /v0\.3\.0/);
  assert.equal(await count(p, '[data-testid="update-banner"]'), 0);
  await T(p, "check-update").click();
  await waitText(p, "toast", /已经是最新版本/);
  await done(p);
});

test("更新：启动时静默发现新版本并显示横幅，点击后安装并触发重启", async () => {
  const p = await open("sites1,update");
  await T(p, "update-banner").waitFor();
  assert.match(await T(p, "update-banner").textContent(), /发现新版本 0\.3\.0/);
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

test("排序：按倍率升序/降序，顶部栏很矮且不重复产品名", async () => {
  const p = await open("sites2");
  await T(p, "group-card-alpha-2").waitFor();
  const rates = async () => (await p.locator(".card .rate").allTextContents()).map((x) => parseFloat(x.replace("×", "")));
  await T(p, "sort").selectOption("asc");
  let r = await rates();
  assert.deepEqual(r, [...r].sort((a, b) => a - b));
  await T(p, "sort").selectOption("desc");
  r = await rates();
  assert.deepEqual(r, [...r].sort((a, b) => b - a));
  const h = await p.locator("header.topbar").evaluate((e) => e.getBoundingClientRect().height);
  assert.ok(h < 32, `顶部栏高度 ${h}`);
  assert.equal(await count(p, ".logo"), 0);
  await done(p);
});
