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
async function open(scenario = "", viewport = { width: 1100, height: 680 }, { speedConfirmed = true, tab = "claude" } = {}) {
  const ctx = await browser.newContext({ viewport });
  // 第一次测速前会弹说明框；多数测试不关心它，预先标记为已确认
  if (speedConfirmed) await ctx.addInitScript(() => localStorage.setItem("ferrydeck.speedConfirmed", "1"));
  // 默认选中“Claude”类别 tab（应用会记住上次选的 tab）；传 tab: null 就是第一次使用的状态（“全部”）
  if (tab) await ctx.addInitScript((v) => localStorage.setItem("ferrydeck.category", v), tab);
  const page = await ctx.newPage();
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && page.errors.push(m.text()));
  await page.goto(`${BASE}/?s=${scenario}`);
  return page;
}
const T = (page, id) => page.getByTestId(id);
/** 悬停到某个站点卡片：先把鼠标移开（上一张卡片悬停时的图标条会压在相邻卡片上），免得它挡住目标。 */
const hoverTab = async (page, id) => { await page.mouse.move(0, 0); await page.waitForTimeout(160); await T(page, id).hover(); };
/** 在站点卡片上点右键，选菜单项（console / topup / remove）。 */
const ctx = async (page, id, item) => { await T(page, id).click({ button: "right" }); await T(page, `ctx-${item}`).click(); };
/** 点上游账号的“关联 / ×N?”药丸打开编辑弹窗，选上游站点和分组，提交（更换来源 = 关联）。 */
const linkVia = async (page, upId, { site, group } = {}) => {
  await T(page, `account-rate-${upId}`).first().click();
  await T(page, "add-upstream-dialog").waitFor();
  if (site) await T(page, "au-site").selectOption(site);
  if (group) await T(page, "au-group").selectOption(group);
  await T(page, "au-submit").click();
  await T(page, "add-upstream-result").waitFor();
  await T(page, "au-done").click();
  await T(page, "add-upstream-dialog").waitFor({ state: "detached" });
};
/** 点分组行的“启用”：Claude 类分组能配到 Claude Code 和 Claude Desktop，会弹出小菜单，选一个（默认 Claude Code）；只有一个客户端时直接配置。 */
const enableG = async (page, id, client = "claude") => {
  await T(page, id).click();
  const pick = T(page, `enable-pick-${client}`);
  if ((await page.getByTestId("ctx-menu").count()) > 0) await pick.click();
};
const selectedClient = (page) => page.evaluate(() => document.querySelector(".side-item.selected")?.getAttribute("data-testid"));
const count = (page, sel) => page.locator(sel).count();
const cards = (page) => count(page, '[data-testid^="group-card-"]');
async function done(page) {
  assert.deepEqual(page.errors, [], "页面不应有 JS 错误或控制台错误");
  await page.context().close();
}
/** 走完“添加站点”两步。 */
async function addSite(page, url, { user = "me@example.com", pw = "ok123", name } = {}) {
  // 还没有站点时没有站点 tab（也就没有“＋”），用欢迎页上的按钮
  await T(page, (await count(page, '[data-testid="add-site"]')) ? "add-site" : "empty-sites-add").click();
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
  assert.equal(await T(p, "client-status-claude").textContent(), "未配置");
  assert.equal(await cards(p), 0);
  await p.screenshot({ path: "ui-tests/shots/welcome.png" });
  await done(p);
});

test("添加站点第一步：空地址、未知地址、需要人机验证都给出明确提示，且停留在第一步；http 站点不拒绝，只提示明文传输", async () => {
  const p = await open();
  await T(p, "empty-sites-add").click();
  await T(p, "add-submit").click();
  assert.equal(await T(p, "add-error").textContent(), "请输入站点地址");
  for (const [url, re] of [
    ["unknown.example.org", /无法识别该站点类型/],
    ["captcha.example.com", /人机验证/],
  ]) {
    await T(p, "add-url").fill(url);
    await T(p, "add-submit").click();
    await p.waitForFunction((src) => new RegExp(src).test(document.querySelector('[data-testid="add-error"]')?.textContent ?? ""), re.source);
    assert.equal(await T(p, "add-url").count(), 1, `${url} 应停留在地址步骤`);
    assert.equal(await T(p, "add-submit").textContent(), "下一步");
  }
  // http 站点：不再被拒绝；输入 http:// 开头时提示账号密码会明文传输
  await T(p, "add-url").fill("https://alpha.example.com");
  assert.equal(await T(p, "add-http-warn").isVisible(), false, "https 不提示");
  await T(p, "add-url").fill("http://173.231.49.42:3200");
  assert.equal(await T(p, "add-http-warn").isVisible(), true);
  assert.match(await T(p, "add-http-warn").textContent(), /明文传输/);
  await T(p, "add-submit").click();
  await p.waitForFunction(() => /无法识别该站点类型/.test(document.querySelector('[data-testid="add-error"]')?.textContent ?? ""));
  assert.doesNotMatch(await T(p, "add-error").textContent(), /只支持 https/, "不再因为是 http 就拒绝");
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

test("添加成功：对话框关闭、站点卡和余额出现、分组列表显示，默认是“全部”tab", async () => {
  const p = await open("", undefined, { tab: null });
  await addSite(p, "alpha.example.com", { name: "我的 Alpha" });
  await T(p, "group-card-alpha-2").waitFor();
  assert.equal(await count(p, '[data-testid="add-dialog"]'), 0);
  await waitText(p, "toast", /已添加站点「我的 Alpha」/);
  assert.match(await T(p, "site-alpha").textContent(), /我的 Alpha/);
  assert.doesNotMatch(await T(p, "site-alpha").textContent(), /sub2api|new-api/, "不再显示站点类型（第 4 项）");
  assert.equal(await T(p, "site-balance-alpha").textContent(), "$99.78", "余额前不再有“余额”二字（第 6 项）");
  assert.equal(await selectedClient(p), "cat-all", "默认是“全部”tab");
  assert.equal(await cards(p), 6, "Alpha 的 6 个分组都列出来");
  await T(p, "cat-claude").click();
  assert.equal(await cards(p), 3, "Claude 类分组 3 个");
  assert.equal(await count(p, '[data-testid="unsupported"]'), 0, "不展示不支持的分组");
  assert.equal(await count(p, '[data-testid="site-tab-all"]'), 0, "只有一个站点时不显示“全部站点”");
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
  assert.equal(await count(p, '.site-tab:not(.add)'), 1, "仍然只有一个站点");
  await done(p);
});

// ---------- 多站点 ----------

test("两个站点：分组合并显示，同名分组并存并带站点标签，出现站点筛选", async () => {
  const p = await open("sites2");
  await T(p, "group-card-alpha-2").waitFor();
  await T(p, "cat-claude").click();
  assert.equal(await cards(p), 4, "Alpha 3 个 + Beta 1 个 Claude 类分组");
  await T(p, "cat-all").click();
  assert.equal(await cards(p), 8, "全部：Alpha 6 个 + Beta 2 个");
  await T(p, "cat-claude").click();
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
  await T(p, "site-name-beta").click();
  await T(p, "cat-all").click();
  assert.equal(await cards(p), 2, "“全部”里 Beta 有两个分组");
  await T(p, "cat-claude").click();
  assert.equal(await cards(p), 1);
  assert.equal(await count(p, '[data-testid="group-card-beta-Claude 逆向Kiro"]'), 1);
  await T(p, "cat-gemini").click();
  assert.match(await T(p, "empty-client").textContent(), /没有Gemini类的分组/);
  await p.mouse.move(0, 0);
  await T(p, "site-tab-all").click();
  assert.equal(await cards(p), 1, "Gemini 只有 Alpha 的一个分组");
  await T(p, "cat-openai").click();
  assert.equal(await cards(p), 2, "Codex：Alpha 的 GPT 福利 + Beta 的 GPT Pro");
  await done(p);
});

test("跨站点切换：同名分组互不混淆，启用另一个站点的分组后旧卡恢复", async () => {
  const p = await open("sites2");
  await enableG(p, "enable-alpha-4");
  await p.waitForFunction(() => document.querySelector('[data-testid="group-card-alpha-4"]')?.textContent.includes("使用中"));
  const toast = await T(p, "toast").textContent();
  assert.match(toast, /已把「Claude 逆向Kiro」（Alpha）配置到 Claude Code/);
  assert.equal(await T(p, "client-status-claude").textContent(), "Alpha · Claude 逆向Kiro", "多站点时状态里带站点名");
  assert.equal(await T(p, "enable-beta-Claude 逆向Kiro").getAttribute("aria-label"), "启用", "Beta 的同名分组不应被当成使用中");

  await enableG(p, "enable-beta-Claude 逆向Kiro");
  await p.waitForFunction(() => document.querySelector('[data-testid="group-card-beta-Claude 逆向Kiro"]')?.textContent.includes("使用中"));
  assert.equal(await T(p, "enable-alpha-4").getAttribute("aria-label"), "启用", "Alpha 的卡片恢复可启用");
  assert.equal(await p.locator("text=使用中").count(), 1, "同一客户端同时只有一个使用中");
  assert.equal(await T(p, "client-status-claude").textContent(), "Beta · Claude 逆向Kiro");
  await done(p);
});

test("同一个分组配到 Claude Code 和 Claude Desktop 互不影响：配了一个，还能配另一个", async () => {
  const p = await open("sites1");
  await T(p, "cat-claude").click();
  await T(p, "enable-alpha-12").click();
  assert.equal(await count(p, '[data-testid="enable-pick-claude"]'), 1, "Claude 类分组：弹出小菜单选客户端");
  assert.equal(await count(p, '[data-testid="enable-pick-claude_desktop"]'), 1);
  await T(p, "enable-pick-claude").click();
  await p.waitForFunction(() => document.querySelector('[data-testid="client-status-claude"]')?.textContent === "Claude 逆向Kiro - 特价");
  assert.equal(await T(p, "client-status-claude_desktop").textContent(), "未配置");
  // 只被 Claude Code 使用：行上是“使用中 ▾”，还能配到 Claude Desktop；菜单里不再列 Claude Code
  assert.match(await T(p, "enable-alpha-12").textContent(), /使用中/);
  await T(p, "enable-alpha-12").click(); // 只剩 Claude Desktop 没配：直接配置，不再弹菜单
  await p.waitForFunction(() => document.querySelector('[data-testid="client-status-claude_desktop"]')?.textContent === "Claude 逆向Kiro - 特价");
  assert.match(await T(p, "toast").textContent(), /完全退出（⌘Q）并重新打开 Claude Desktop/);
  assert.equal(await T(p, "client-status-claude").textContent(), "Claude 逆向Kiro - 特价");
  assert.equal(await count(p, '[data-testid="enable-alpha-12"]'), 0, "两个客户端都在用：只剩“使用中”");
  assert.equal(await count(p, '[data-testid="inuse-alpha-12"]'), 1);
  await done(p);
});

test("启用与模型切换：专用 Key 只在第一次创建；下拉框切换模型", async () => {
  const p = await open("sites1");
  await enableG(p, "enable-alpha-4");
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
  await enableG(p, "enable-alpha-2");
  assert.equal(await T(p, "enable-alpha-2").textContent(), "配置中…");
  assert.equal(await T(p, "enable-alpha-4").isDisabled(), true);
  await p.waitForFunction(() => document.querySelector('[data-testid="group-card-alpha-2"]')?.textContent.includes("使用中"));
  await done(p);
});

test("启用失败：显示错误，按钮恢复，没有变成使用中", async () => {
  const p = await open("sites1,enable-fail");
  await enableG(p, "enable-alpha-12");
  await T(p, "toast").waitFor();
  assert.match(await T(p, "toast").textContent(), /配置失败：无法连接到服务器，请检查网络/);
  assert.equal(await T(p, "enable-alpha-12").getAttribute("aria-label"), "启用");
  assert.equal(await T(p, "enable-alpha-12").isDisabled(), false);
  assert.equal(await T(p, "client-status-claude").textContent(), "未配置");
  await done(p);
});

test("启用时发现登录已过期：提示去重新登录，站点卡变红，分组消失", async () => {
  const p = await open("sites1,expire-on-enable");
  await enableG(p, "enable-alpha-12");
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
  await T(p, "site-beta").click({ button: "right" });
  assert.equal(await count(p, `[data-testid="ctx-topup"]`), 1, "不管登录状态如何，右键都有控制台、充值、删除");
  await p.keyboard.press("Escape");
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
  await enableG(p, "enable-beta-Claude 逆向Kiro");
  await p.waitForFunction(() => document.querySelector('[data-testid="client-status-claude"]')?.textContent === "Beta · Claude 逆向Kiro");
  await ctx(p, "site-beta", "remove");
  assert.match(await T(p, "remove-dialog").textContent(), /移除站点「Beta」/);
  assert.match(await T(p, "remove-dialog").textContent(), /不会被删除/);
  await T(p, "remove-cancel").click();
  assert.equal(await count(p, '[data-testid="remove-dialog"]'), 0);
  assert.equal(await count(p, '[data-testid="site-beta"]'), 1);
  await ctx(p, "site-beta", "remove");
  await T(p, "remove-confirm").click();
  await waitText(p, "toast", /已移除站点「Beta」/);
  assert.equal(await count(p, '[data-testid="site-beta"]'), 0);
  assert.equal(await count(p, '[data-testid^="group-card-beta-"]'), 0);
  assert.equal(await T(p, "client-status-claude").textContent(), "未配置");
  assert.equal(await count(p, '[data-testid="site-tab-all"]'), 0, "回到单站点，“全部站点”tab 消失");
  assert.equal(await count(p, '[data-testid^="site-tag-"]'), 0);
  await done(p);
});

test("移除最后一个站点：回到欢迎页", async () => {
  const p = await open("sites1");
  await ctx(p, "site-alpha", "remove");
  await T(p, "remove-confirm").click();
  await T(p, "empty-sites").waitFor();
  assert.equal(await cards(p), 0);
  await done(p);
});

test("去充值：sub2api 打开 /purchase，new-api 打开 /console/topup，页面不跳转", async () => {
  const p = await open("sites2");
  await ctx(p, "site-alpha", "topup");
  await ctx(p, "site-beta", "topup");
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
  assert.equal(await T(p, "client-codex").textContent().then((x) => x.includes("⚠")), false, "没有冲突的客户端不标");
  await T(p, "client-claude").hover();
  await p.waitForFunction(() => /没有检测到配置目录/.test(document.getElementById("fd-tip")?.textContent ?? ""));
  assert.match(await T(p, "conflict-banner-claude_desktop").textContent(), /还没有切换到第三方推理模式/);
  assert.equal(await count(p, '[data-testid="conflict-banner-codex"]'), 0);
  await enableG(p, "enable-alpha-12");
  await p.waitForFunction(() => document.querySelector('[data-testid="group-card-alpha-12"]')?.textContent.includes("使用中"));
  await done(p);
});

test("加载分组期间：侧边栏显示“加载中…”，不会误导为“暂无可用分组”", async () => {
  const p = await open("sites1,slow");
  await T(p, "loading").waitFor();
  assert.equal(await T(p, "client-status-claude").textContent(), "加载中…");
  await T(p, "group-card-alpha-2").waitFor();
  assert.equal(await T(p, "client-status-claude").textContent(), "未配置");
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
  assert.match(await T(p, "update-banner").textContent(), /发现新版本 0\.6\.0/);
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

test("最小窗口 1100×560：两个站点、使用中的卡片、站点卡都不溢出", async () => {
  const p = await open("sites2", { width: 1100, height: 560 });
  await T(p, "group-card-alpha-2").waitFor();
  await enableG(p, "enable-beta-Claude 逆向Kiro");
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
  await enableG(p, "enable-alpha-2");
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
  await enableG(p, "enable-alpha-2");
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

test("下拉框展开期间不会被重绘替换：窗口获得焦点触发刷新后，选中的模型立即生效", async () => {
  const p = await open("sites2,plaza");
  await T(p, "group-card-alpha-2").waitFor();
  // 用户点开模型下拉框（焦点在 select 上）
  await T(p, "model-filter").focus();
  await p.evaluate(() => { window.__sel = document.querySelector('[data-testid="model-filter"]'); });
  // 同时窗口获得焦点，触发余额/分组刷新（过去会把下拉框整个换掉）
  await p.evaluate(() => { const real = Date.now; Date.now = () => real() + 120_000; });
  await p.evaluate(() => window.dispatchEvent(new Event("focus")));
  await p.waitForFunction(() => window.__listGroupsCalls >= 2);
  await p.waitForTimeout(500);
  assert.equal(await p.evaluate(() => document.contains(window.__sel)), true, "刷新没有替换正在用的下拉框");
  // 此时选中某个模型：第一次就要生效，并且下拉框显示的就是它
  await T(p, "model-filter").selectOption("claude-opus-5-5");
  assert.ok((await cards(p)) < 4, "第一次选择就完成了筛选");
  assert.equal(await T(p, "model-filter").inputValue(), "claude-opus-5-5", "下拉框显示的是选中的模型");
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
  await T(p, "cat-openai").click();
  assert.equal(await T(p, "model-filter").inputValue(), "", "切到 Codex 后筛选已清除");
  assert.equal(await count(p, '[data-testid="empty-client"]'), 0, "不会因为沿用旧筛选而显示“没有提供…的分组”");
  await T(p, "cat-claude").click();
  assert.equal(await T(p, "model-filter").inputValue(), "", "切回来也不会残留");
  await done(p);
});

test("模型列：标题里的下拉和每一行的模型数量居中对齐，标题的箭头紧贴文字", async () => {
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
    assert.ok(Math.abs((r.left + r.right) / 2 - (rights.head.left + rights.head.right) / 2) <= 1.5, `行的中心 ${(r.left + r.right) / 2} 和标题的 ${(rights.head.left + rights.head.right) / 2} 对不上`);
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

test("站点卡没有悬停图标，右键出菜单；分组行的启用图标悬停才显示，“使用中”一直显示", async () => {
  const p = await open("sites2,expired");
  await T(p, "group-card-alpha-2").waitFor();
  // 打开页面时在后台读成本，每读到一个就会重绘一次：等它读完再测悬停，免得节点中途被换掉
  await p.waitForFunction(() => !document.querySelector('[data-testid="cost-progress"]'));
  assert.equal(await count(p, ".site-tab .site-icons"), 0, "站点卡上不再有悬停图标");
  await T(p, "site-alpha").click({ button: "right" });
  assert.deepEqual(await p.locator('[data-testid="ctx-menu"] button').allTextContents(), ["控制台", "充值", "删除"]);
  await p.keyboard.press("Escape");
  assert.equal(await count(p, '[data-testid="ctx-menu"]'), 0, "Esc 关闭");
  // 登录失效的站点也一样
  await T(p, "site-beta").click({ button: "right" });
  assert.equal(await count(p, '[data-testid="ctx-remove"]'), 1);
  await p.mouse.click(5, 5);
  assert.equal(await count(p, '[data-testid="ctx-menu"]'), 0, "点别处关闭");
  // 分组行
  const enableOpacity = () => T(p, "enable-alpha-2").evaluate((e) => getComputedStyle(e).opacity);
  await p.mouse.move(2, 2);
  await p.waitForFunction(() => getComputedStyle(document.querySelector('[data-testid="enable-alpha-2"]')).opacity === "0");
  await T(p, "group-card-alpha-2").hover();
  await p.waitForFunction(() => getComputedStyle(document.querySelector('[data-testid="enable-alpha-2"]')).opacity === "1");
  await enableG(p, "enable-alpha-2");
  await p.waitForFunction(() => document.querySelector('[data-testid="group-card-alpha-2"]')?.textContent.includes("使用中"));
  await p.mouse.move(2, 2);
  assert.equal(await T(p, "group-card-alpha-2").locator(".badge").isVisible(), true, "“使用中”不需要悬停");
  assert.match(await T(p, "group-card-alpha-2").locator(".badge").textContent(), /使用中/, "已启用的行显示“使用中”（还能配到另一个客户端时带 ▾）");
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
    await p.waitForFunction((t) => getComputedStyle(document.querySelector(`[data-testid="${t}"]`)).opacity === "0", id, { timeout: 5000 }).catch(() => {});
    await p.waitForTimeout(100); // 重绘中途节点会被换掉：等一下再取
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
  assert.match(text, /自动识别|归在“其他”/);
  assert.doesNotMatch(text, /用起来会失败|卡片上会标注|建议：先看/, "只保留第一条说明");
  assert.equal(await p.evaluate(() => document.activeElement?.getAttribute("data-testid")), "unclassified-ok", "“确定”默认聚焦，回车即可关闭");
  assert.match(await T(p, "toast").textContent(), /已添加站点/, "添加成功的提示仍然在");
  await T(p, "unclassified-ok").click();
  assert.equal(await count(p, '[data-testid="unclassified-dialog"]'), 0, "点确定后关闭");
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
  assert.doesNotMatch(text, /填你平时登录的那个中转站网址/, "这句提示已去掉");
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
  assert.match(await T(p, "row-models-alpha-2").textContent(), /\d+ 个模型/, "没测速，模型列也显示模型数量而不是“—”");
  assert.equal(await T(p, "row-models-alpha-2").evaluate((e) => e.tagName), "SPAN", "不是按钮：不用点，悬停就提示");
  await T(p, "row-models-alpha-2").hover();
  await p.waitForFunction(() => (document.getElementById("fd-tip")?.textContent ?? "").includes("claude-"));
  const tip = await p.evaluate(() => document.getElementById("fd-tip").textContent);
  assert.ok(tip.split("\n").length >= 2 && tip.split("\n").every((l) => l.trim() && !l.includes(" ")), `提示里每行一个模型: ${JSON.stringify(tip)}`);
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
const listedModels = (p) =>
  p.evaluate(() => [...new Set([...document.querySelectorAll('[data-testid^="row-models-"]')].flatMap((e) => (e.dataset.tip ?? "").split("\n").filter(Boolean)))].sort());
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
  await T(p, "site-name-beta").click();
  assert.deepEqual(await check("只看 Beta"), ["beta-only-model", "claude-sonnet-5-5"], "Beta 的分组只有这两个模型，Alpha 的模型不该出现");
  await T(p, "site-name-alpha").click();
  const alpha = await check("只看 Alpha");
  assert.ok(!alpha.includes("beta-only-model"), "Beta 独有的模型不该出现在 Alpha 的候选项里");
  await p.mouse.move(0, 0);
  await T(p, "site-tab-all").click();
  await T(p, "cat-openai").click();
  await check("Codex 标签");
  await done(p);
});

test("选中的模型换了站点筛选后不在候选项里：筛选条件一并清掉，列表不会被看不见的条件过滤成空", async () => {
  const p = await open("sites2,plaza");
  await T(p, "group-card-alpha-2").waitFor();
  await T(p, "model-filter").selectOption("claude-opus-5-5"); // Alpha 独有
  assert.equal(await count(p, '[data-testid^="group-card-beta-"]'), 0, "Beta 没有这个模型，被筛掉");
  await T(p, "site-name-beta").click();
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
  await p.waitForFunction(() => window.__toasts.some((t) => /分组、模型和成本都已读取/.test(t)));
  const seq = await p.evaluate(() => window.__toasts);
  const at = (re) => seq.findIndex((t) => re.test(t));
  assert.ok(at(/开始刷新分组/) >= 0, `缺少“开始刷新分组”: ${seq}`);
  assert.ok(at(/开始刷新模型列表/) > at(/开始刷新分组/), `“开始刷新模型列表”要在“开始刷新分组”之后: ${seq}`);
  assert.ok(at(/已添加站点「beta\.example\.com」，分组、模型和成本都已读取/) > at(/开始刷新模型列表/), `最后是完成提示: ${seq}`);
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
  assert.ok(box && Math.abs(box.x + box.width - 1100) < 2, "抽屉贴在窗口右侧");
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
  await q.waitForFunction(() => document.querySelector('[data-testid="cost-val-alpha-2"]')?.textContent === "读取失败");
  await T(q, "cost-val-alpha-2").hover();
  await q.waitForFunction(() => /成本读取失败：站点限流了/.test(document.getElementById("fd-tip")?.textContent ?? ""));
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
  const listed = await cards(p);
  await p.waitForFunction(([n, k]) => window.__usageCalls.length >= n + k, [first, listed]);
  await p.waitForTimeout(500);
  assert.ok((await p.evaluate(() => window.__usageCalls.length)) < first * 2, "手动刷新只重读当前列出的分组，不是所有站点的所有分组");
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
  assert.match(await T(p, "cache-val-alpha-2").textContent(), /^(—|读取中…)$/, "还没同步到：读取中或 —");
  await p.waitForFunction(() => document.querySelector('[data-testid="cache-val-alpha-2"]')?.textContent === "32.0%" && ![...document.querySelectorAll('[data-testid^="cache-val-"]')].some((e) => ["—", "读取中…"].includes(e.textContent) && e.closest(".card").querySelector('[data-testid^="cost-val-"]').textContent !== "无用量"));
  await T(p, "sort-cache").hover();
  await p.waitForFunction(() => /缓存读取/.test(document.getElementById("fd-tip")?.textContent ?? ""));
  await T(p, "sort-cache").click();
  const vals = await p.evaluate(() => [...document.querySelectorAll('[data-testid^="cache-val-"]')].map((e) => e.textContent));
  const nums = vals.filter((v) => v.endsWith("%")).map(parseFloat);
  assert.deepEqual(nums, [...nums].sort((a, b) => a - b), "升序");
  assert.match(vals.at(-1), /^(—|无有效统计)$/, "没有数据的排最后");
  await done(p);
});

test("分组备注不再占位：行里不显示，鼠标放到分组名称上才提示", async () => {
  const p = await open("sites1");
  await T(p, "group-card-alpha-2").waitFor();
  assert.equal(await count(p, ".card .desc"), 0, "行里没有备注文字");
  const withDesc = await p.evaluate(() => [...document.querySelectorAll('[data-testid^="name-"]')].find((e) => e.dataset.tip)?.getAttribute("data-testid"));
  assert.ok(withDesc, "有备注的分组名称带提示");
  await T(p, withDesc).hover();
  await p.waitForFunction(() => (document.getElementById("fd-tip")?.textContent ?? "").length > 0);
  await done(p);
});

test("列表 UI 规范：数据列等宽并居中，倍率 / Token成本 / 缓存命中率 / 模型数量是同样高度和字号的药丸，间距统一", async () => {
  const p = await open("sites1,realfrt,plaza");
  await p.waitForFunction(() => document.querySelector('[data-testid="cache-val-alpha-2"]')?.classList.contains("pill"));
  const m = await p.evaluate(() => {
    const row = document.querySelector('[data-testid="group-card-alpha-2"]');
    const box = (s) => { const e = row.querySelector(s); const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return { w: Math.round(r.width), h: Math.round(r.height), fs: cs.fontSize, fw: cs.fontWeight, color: cs.color, cx: Math.round(r.left + r.width / 2) }; };
    const cols = [".cell-speed", ".cell-rate", ".cell-cost", ".cell-cache"].map((c) => box(c).w);
    const pills = [".rate", '[data-testid^="cost-val-"]', '[data-testid^="cache-val-"]', '[data-testid^="row-models-"]'].map(box);
    const head = document.querySelector('[data-testid="list-head"]');
    const headCx = [".cell-speed", ".cell-rate", ".cell-cost", ".cell-cache"].map((c) => { const r = head.querySelector(c + " button").getBoundingClientRect(); return Math.round(r.left + r.width / 2); });
    const rowCx = [".cell-speed", ".cell-rate", ".cell-cost", ".cell-cache"].map((c) => box(c).cx);
    return { cols, pills, headCx, rowCx };
  });
  assert.equal(new Set(m.cols).size, 1, `四个数据列等宽: ${m.cols}`);
  for (const k of ["h", "fs", "fw", "color"]) assert.equal(new Set(m.pills.map((x) => x[k])).size, 1, `药丸的 ${k} 一致: ${JSON.stringify(m.pills)}`);
  m.headCx.forEach((x, i) => assert.ok(Math.abs(x - m.rowCx[i]) <= 1, `第 ${i} 列标题和内容居中对齐: ${m.headCx} / ${m.rowCx}`));
  await done(p);
});

test("读取成本时顶栏有进度，没读到的格子显示“读取中…”，读完消失", async () => {
  const p = await open("sites1,slow");
  await T(p, "cost-progress").waitFor();
  assert.match(await T(p, "cost-progress").textContent(), /读取成本 \d+\/\d+/);
  assert.match(await T(p, "cost-val-alpha-2").textContent(), /^(读取中…|\$)/);
  await T(p, "cost-progress").waitFor({ state: "detached", timeout: 60000 });
  await done(p);
});

test("左侧是站点列表（名称 + 余额），客户端 tab 在内容区顶部；悬停出现打开 / 充值 / 移除，点击切换筛选", async () => {
  const p = await open("sites2");
  await T(p, "group-card-alpha-2").waitFor();
  const titles = await p.locator(".sidebar .side-title").allTextContents();
  assert.deepEqual(titles, ["上游站点"], "左侧只有“上游站点”（没有管理员站点时没有“我的中转站”）");
  assert.equal(await count(p, ".sidebar [data-testid^='client-'], .sidebar [data-testid^='cat-']"), 0, "类别 tab 和客户端状态不在左侧");
  assert.equal(await p.evaluate(() => !!document.querySelector('.sidebar [data-testid="site-tabs"] [data-testid="site-alpha"]')), true, "站点在左侧");
  assert.equal(await p.evaluate(() => document.querySelectorAll('.content [data-testid="client-tabs"] [data-testid^="cat-"]').length > 0 && !document.querySelector('.content [data-testid="site-tabs"]')), true, "类别 tab 在右侧内容区顶部");
  assert.deepEqual(await p.locator('[data-testid="client-tabs"] .side-name').allTextContents(), ["全部", "Claude", "OpenAI", "Gemini", "其他"], "有分组的类别才出现（模拟数据里 Grok 归“其他”）");
  assert.deepEqual(await p.locator('[data-testid="client-status-row"] .chip-name').allTextContents(), ["Claude Code", "Claude Desktop", "Codex", "Gemini CLI"], "四个客户端各自在用哪个分组，只读");
  assert.equal(await count(p, '[data-testid^="site-account-"]'), 0, "不显示用户名");
  assert.equal(await T(p, "site-balance-alpha").textContent(), "$99.78");
  assert.deepEqual(await p.locator('[data-testid="site-tabs"] .site-tab').evaluateAll((es) => es.map((e) => e.querySelector(".tab-name")?.textContent ?? "+")), ["全部站点", "Alpha", "Beta", "+"]);
  assert.match(await T(p, "site-tab-all").getAttribute("class"), /\bon\b/);
  await T(p, "site-name-beta").click();
  assert.match(await T(p, "site-beta").getAttribute("class"), /\bon\b/);
  assert.equal(await cards(p), 1);
  await T(p, "site-alpha").click({ button: "right" });
  await T(p, "ctx-remove").click();
  await T(p, "remove-dialog").waitFor();
  assert.match(await T(p, "site-beta").getAttribute("class"), /\bon\b/, "右键不触发切换");
  await done(p);
});

test("分组列表五列是同一种药丸样式：首字时延、倍率、Token成本、缓存命中率、模型数量", async () => {
  const p = await open("sites1,realfrt,plaza");
  await p.waitForFunction(() => document.querySelector('[data-testid="cache-val-alpha-2"]')?.classList.contains("pill") && document.querySelector('[data-testid="speed-alpha-2"]'));
  const m = await p.evaluate(() => {
    const row = document.querySelector('[data-testid="group-card-alpha-2"]');
    return ['[data-testid^="speed-"]', ".rate", '[data-testid^="cost-val-"]', '[data-testid^="cache-val-"]', '[data-testid^="row-models-"]'].map((s) => { const e = row.querySelector(s); const cs = getComputedStyle(e); return [cs.height, cs.fontSize, cs.fontWeight, cs.color, cs.backgroundColor, cs.borderRadius].join("|"); });
  });
  assert.equal(new Set(m).size, 1, `五列的高度/字号/字重/颜色/底色/圆角一致: ${JSON.stringify(m)}`);
  await done(p);
});

test("缓存命中率：近 7 天调用少于 100 次显示“无有效统计”，提示里说明原因；标题提示补充了说明", async () => {
  const p = await open("sites1,fewcalls");
  await T(p, "group-card-alpha-2").waitFor();
  await p.waitForFunction(() => document.querySelector('[data-testid="cache-val-alpha-2"]')?.textContent === "无有效统计");
  assert.equal(await count(p, '[data-testid^="cache-val-"].pill'), 0, "没有任何一行展示不准的百分比");
  await T(p, "cache-val-alpha-2").hover();
  await p.waitForFunction(() => /如果调用量少于100次，效果不准确，则不展示/.test(document.getElementById("fd-tip")?.textContent ?? ""));
  await T(p, "sort-cache").hover();
  await p.waitForFunction(() => /缓存读取 ÷.*点击排序；如果调用量少于100次，效果不准确，则不展示/.test(document.getElementById("fd-tip")?.textContent ?? ""));
  await done(p);

  // 调用量够了：照常展示，并且单元格的提示里也有这句补充
  const q = await open("sites1");
  await q.waitForFunction(() => document.querySelector('[data-testid="cache-val-alpha-2"]')?.textContent === "32.0%");
  await T(q, "cache-val-alpha-2").hover();
  await q.waitForFunction(() => /如果调用量少于100次/.test(document.getElementById("fd-tip")?.textContent ?? ""));
  await done(q);
});

test("登录页：只写“所有数据保存在本地”；勾选“我是该站点管理员”先弹说明，确认后才勾上并随登录提交", async () => {
  const p = await open("sites1");
  await T(p, "group-card-alpha-2").waitFor();
  await T(p, "add-site").click();
  await T(p, "add-url").fill("beta.example.com");
  await T(p, "add-submit").click();
  await T(p, "add-username").waitFor();
  const text = await T(p, "add-dialog").textContent();
  assert.ok(text.includes("所有数据保存在本地"), "有“所有数据保存在本地”");
  assert.ok(!text.includes("密码只用于登录"), "旧的长说明已去掉");
  assert.equal(await T(p, "add-admin").isChecked(), false, "默认不勾选");
  // 勾选 → 弹说明；取消 → 仍是未勾选
  await T(p, "add-admin").click({ force: true });
  await T(p, "admin-notice").waitFor();
  assert.match(await T(p, "admin-notice").textContent(), /该模式支持监控上下游可用性及成本变化，务必在站点中再次添加使用到的上游站点账号/);
  await T(p, "admin-notice-cancel").click();
  await T(p, "admin-notice").waitFor({ state: "detached" });
  assert.equal(await T(p, "add-admin").isChecked(), false);
  // 再勾选 → 我知道了 → 勾上
  await T(p, "add-admin").click({ force: true });
  await T(p, "admin-notice-ok").click();
  await T(p, "admin-notice").waitFor({ state: "detached" });
  assert.equal(await T(p, "add-admin").isChecked(), true);
  await T(p, "add-username").fill("me@example.com");
  await T(p, "add-password").fill("ok123");
  await T(p, "add-submit").click();
  await p.waitForFunction(() => window.__addArgs?.length > 0);
  assert.equal(await p.evaluate(() => window.__addArgs.at(-1).isAdmin), true, "管理员身份随登录提交");
  await done(p);
});

// ---------- 我的中转站（站长：上下游一体管理）----------

const opsLog = (p) => p.evaluate(() => window.__adminOps ?? []);

test("没有管理员站点时没有“我的中转站”；有时出现在客户端和站点之间，点卡片进入视图：每个下游分组一个色块，缩进的是来源上游", async () => {
  const p0 = await open("sites1");
  await T(p0, "group-card-alpha-2").waitFor();
  assert.equal(await count(p0, '[data-testid^="operator-"]'), 0, "普通站点不显示");
  await done(p0);

  const p = await open("sites1,admin");
  await T(p, "operator-alpha").waitFor();
  const order = await p.evaluate(() => { const t = [...document.querySelectorAll(".sidebar .side-title")].map((e) => e.textContent); const y = (s) => document.querySelector(s).getBoundingClientRect().top; return { t, op: y('[data-testid="operator-alpha"]'), site: y('[data-testid="site-tabs"]') }; });
  assert.deepEqual(order.t, ["我的中转站", "上游站点"]);
  assert.ok(order.op < order.site, "“我的中转站”在“上游站点”上面，两种站点都在左侧");
  await T(p, "operator-alpha").click();
  await T(p, "op-list").waitFor();
  assert.equal(await count(p, '[data-testid^="down-block-"]'), 4, "每个下游分组一个色块");
  assert.equal(await T(p, "up-status-u1").first().textContent(), "运行中");
  assert.equal(await T(p, "up-status-u2").first().textContent(), "已暂停");
  assert.equal(await T(p, "up-status-u3").textContent(), "异常");
  // 色块里：先是下游分组，下面缩进的是它来源的上游；同一个上游服务多个分组时在每个色块里各出现一次
  assert.equal(await count(p, '[data-testid="down-block-4"] .up-row'), 2, "分组 4 来自 u1、u2");
  assert.equal(await count(p, '[data-testid="down-block-12"] .up-row'), 2, "分组 12 来自 u2、u3");
  assert.equal(await count(p, '[data-testid="down-block-2"] .up-row'), 1);
  assert.equal(await count(p, '[data-testid="down-block-99"] .up-row'), 0, "没有上游的分组");
  assert.match(await T(p, "down-block-99").textContent(), /没有来源的上游/);
  assert.equal(await count(p, '[data-testid="up-u1"]'), 2, "u1 同时服务分组 2 和 4，出现两次");
  const first = await p.evaluate(() => document.querySelector('[data-testid="down-block-4"]').firstElementChild.className.includes("down-row"));
  assert.equal(first, true, "下游分组在色块最上面");
  const indent = await p.evaluate(() => { const d = document.querySelector('[data-testid="down-block-4"] .down-row').getBoundingClientRect().left; const u = document.querySelector('[data-testid="down-block-4"] .up-row').getBoundingClientRect().left; return u - d; });
  assert.ok(indent >= 12, `上游缩进在下游下面: ${indent}`);
  const hues = await p.evaluate(() => [...document.querySelectorAll('[data-testid^="down-block-"]')].map((e) => e.style.getPropertyValue("--h")));
  assert.equal(new Set(hues).size, hues.length, `每个色块颜色不同: ${hues}`);
  // 列定义不变：同样的列标题
  const heads = await p.locator('[data-testid="op-list-head"] .col-head').allTextContents();
  assert.deepEqual(heads, ["下游分组 / 来源上游", "首字时延", "倍率", "平均成本", "缓存命中率", "24h流水", "模型"]);
  // 没有启动按钮
  assert.equal(await count(p, ".enable-btn"), 0);
  // 切回客户端
  // 点左侧上游站点的卡片：回到普通分组列表（并且中转站管理视图里没有客户端 tab）
  assert.equal(await count(p, '[data-testid="client-tabs"]'), 0, "中转站管理视图里不显示客户端 tab");
  await T(p, "site-name-alpha").click();
  await T(p, "group-list").waitFor();
  await done(p);
});

test("上游行悬停出现编辑 / 移除（编辑在原来暂停的位置，没有暂停按钮）；下游行悬停出现编辑；平时隐藏", async () => {
  const p = await open("sites1,admin");
  await T(p, "operator-alpha").click();
  await T(p, "down-block-2").waitFor();
  await p.waitForFunction(() => !document.querySelector('[data-testid="op-progress"]')); // 读用量时每读到一个就重绘，节点会被换掉：等它读完
  const op = (id) => T(p, id).first().evaluate((e) => getComputedStyle(e).opacity);
  assert.equal(await op("up-edit-u1"), "0");
  assert.equal(await count(p, '[data-testid^="up-pause-"], [data-testid^="up-resume-"]'), 0, "没有暂停 / 恢复按钮");
  assert.equal(await T(p, "down-edit-4").first().evaluate((e) => getComputedStyle(e).opacity), "0");
  await T(p, "down-block-2").locator('[data-testid="up-u1"]').hover();
  await p.waitForFunction(() => getComputedStyle(document.querySelector('[data-testid="down-block-2"] [data-testid="up-edit-u1"]')).opacity === "1");
  await p.waitForFunction(() => getComputedStyle(document.querySelector('[data-testid="down-block-2"] [data-testid="up-remove-u1"]')).opacity === "1");
  await T(p, "down-block-4").locator('[data-testid="down-4"]').hover();
  await p.waitForFunction(() => getComputedStyle(document.querySelector('[data-testid="down-block-4"] [data-testid="down-edit-4"]')).opacity === "1");
  await done(p);
});

test("移除上游：弹窗列出受影响的下游，不再要输入名称，直接确认；确认后它的色块消失", async () => {
  const p = await open("sites1,admin");
  await T(p, "operator-alpha").click();
  await T(p, "up-remove-u3").click({ force: true });
  await T(p, "up-remove-dialog").waitFor();
  assert.equal(await count(p, '[data-testid="up-typed"]'), 0, "没有“输入上游名称”的输入框");
  assert.match(await T(p, "up-remove-dialog").textContent(), /它服务的 \d+ 个下游分组/);
  assert.equal(await T(p, "up-confirm").isDisabled(), false, "可以直接确认");
  await T(p, "up-confirm").click();
  await T(p, "up-u3").waitFor({ state: "detached" });
  assert.deepEqual(await opsLog(p), ["remove:u3"]);
  await done(p);
});

test("编辑下游分组：两步确认，变更清单里写明涨价 / 降价；没改动或倍率非法不能提交", async () => {
  const p = await open("sites1,admin");
  await T(p, "operator-alpha").click();
  await T(p, "down-edit-4").click({ force: true });
  await T(p, "group-edit-dialog").waitFor();
  assert.equal(await T(p, "ge-name").inputValue(), "Claude 逆向Kiro");
  assert.equal(await T(p, "ge-rate").inputValue(), "0.28");
  assert.equal(await count(p, '[data-testid="ge-platform"]'), 1, "sub2api 有分类");
  // 没改任何东西
  await T(p, "ge-submit").click();
  assert.match(await T(p, "ge-error").textContent(), /没有修改任何内容/);
  // 倍率非法
  await T(p, "ge-rate").fill("abc");
  await T(p, "ge-submit").click();
  assert.match(await T(p, "ge-error").textContent(), /倍率必须是大于 0 的数字/);
  // 降价
  await T(p, "ge-rate").fill("0.14");
  await T(p, "ge-desc").fill("新的备注");
  await T(p, "ge-submit").click();
  const sum = await T(p, "ge-summary").textContent();
  assert.match(sum, /倍率：×0\.28 → ×0\.14（降价 50%/);
  assert.match(sum, /备注：性价比高，适合日常编码 → 新的备注/);
  assert.deepEqual(await opsLog(p), [], "确认前不会发请求");
  await T(p, "ge-back").click();
  assert.equal(await T(p, "ge-rate").inputValue(), "0.14", "返回后保留已填内容");
  await T(p, "ge-submit").click();
  await T(p, "ge-submit").click();
  await T(p, "group-edit-dialog").waitFor({ state: "detached" });
  const ops = await opsLog(p);
  assert.equal(ops.length, 1);
  assert.deepEqual(JSON.parse(ops[0].replace(/^edit:4:/, "")), { description: "新的备注", rate_multiplier: 0.14 }, "只提交改过的字段");
  await p.waitForFunction(() => document.querySelector('[data-testid="group-rate-4"]')?.textContent === "×0.14"); // 保存后重新读取站点数据
  await done(p);
});

test("编辑分组：涨价有提醒；站点拒绝时错误留在弹窗里可修改重试", async () => {
  const p = await open("sites1,admin,adminedit-fail");
  await T(p, "operator-alpha").click();
  await T(p, "down-edit-2").click({ force: true });
  await T(p, "ge-rate").fill("5");
  await T(p, "ge-submit").click();
  assert.match(await T(p, "ge-summary").textContent(), /涨价 100%，之后立刻按新价扣用户的钱/);
  await T(p, "ge-submit").click();
  await p.waitForFunction(() => /站点拒绝了这次修改/.test(document.querySelector('[data-testid="ge-error"]')?.textContent ?? ""));
  assert.equal(await count(p, '[data-testid="group-edit-dialog"]'), 1, "弹窗还在");
  assert.deepEqual(await opsLog(p), []);
  await done(p);
});

test("new-api 站点的分组编辑：名称不能改，没有分类；读取失败有重试", async () => {
  const p = await open("sites2,admin");
  await T(p, "operator-beta").click();
  await T(p, "down-edit-GPT Pro").click({ force: true });
  await T(p, "group-edit-dialog").waitFor();
  assert.equal(await T(p, "ge-name").isDisabled(), true);
  assert.equal(await count(p, '[data-testid="ge-platform"]'), 0);
  await done(p);

  const q = await open("sites1,admin,adminfail");
  await T(q, "operator-alpha").click();
  assert.match(await T(q, "op-error").textContent(), /读取失败：站点限流了/);
  await done(q);
});

test("站长视角：上游行只显示名称、状态和站点，不显示客户端类型和“服务几个分组”", async () => {
  const p = await open("sites1,admin");
  await T(p, "operator-alpha").click();
  await T(p, "up-u1").first().waitFor();
  const row = T(p, "down-block-2").locator('[data-testid="up-u1"]');
  const text = await row.locator(".card-main").textContent();
  assert.ok(text.includes("官方账号池") && text.includes("运行中"), text);
  assert.ok(!text.includes("api.up-one.com"), "站点名称不再显示在账号旁边");
  assert.ok(!text.includes("anthropic"), "不显示客户端类型");
  assert.ok(!/服务\s*\d+\s*个/.test(text), "不显示“服务 N 个下游分组”");
  assert.equal(await row.locator(".card-main .site-tag").count(), 0, "没有站点标签");
  // 名称右边是一个“编辑”图标，鼠标放上去能看到它现在用的是哪个站点的 Key
  assert.equal(await row.locator('[data-testid="up-edit-u1"]').count(), 1);
  assert.match(await row.locator('[data-testid="up-edit-u1"]').getAttribute("data-tip"), /现在用的是 api\.up-one\.com 的 Key/, "提示里写明它现在用的是哪个站点的 Key");
  await done(p);
});

test("站长视角：上游和下游行都显示首字时延 / 倍率 / Token成本 / 缓存命中率 / 模型；读取时有进度和“读取中…”", async () => {
  const p = await open("sites1,admin,slow");
  await T(p, "operator-alpha").click();
  await T(p, "op-progress").waitFor();
  assert.match(await T(p, "op-progress").textContent(), /读取用量 \d+\/\d+/);
  assert.equal(await count(p, '[data-testid="op-reload"]'), 0, "没有单独的“重新读取”，统一用顶部刷新");
  assert.match(await T(p, "group-cost-2").or(T(p, "group-cost-2")).first().textContent(), /读取中…|\$/);
  await T(p, "op-progress").waitFor({ state: "detached", timeout: 60000 });
  // 下游分组 2：用户实付口径
  assert.equal(await T(p, "group-speed-2").textContent(), "0.90s");
  assert.equal(await T(p, "group-cost-2").textContent(), "$2.50");
  assert.equal(await T(p, "group-cache-2").textContent(), "33.0%");
  assert.equal(await T(p, "group-models-2").textContent(), "3 个模型", "下游的模型 = 来源上游支持的模型并集");
  // 上游 u1：成本口径是付给上游的（mock 里 1.5），倍率是账号倍率
  assert.equal(await T(p, "account-speed-u1").first().textContent(), "0.70s");
  assert.equal(await T(p, "account-cost-u1").first().textContent(), "关联", "没关联上游分组就没有真实账单，不估算");
  assert.equal(await T(p, "account-rate-u1").first().textContent(), "×0.09?", "未关联：按名称推荐的分组倍率");
  assert.equal(await T(p, "account-cache-u1").first().textContent(), "33.0%");
  assert.equal(await T(p, "account-models-u1").first().textContent(), "3 个模型");
  // 没用量的上游：无用量；调用少于 100 次的分组：缓存无有效统计
  assert.equal(await T(p, "account-cost-u3").textContent(), "未关联");
  assert.equal(await T(p, "group-cache-12").textContent(), "无有效统计");
  assert.equal(await T(p, "group-cost-99").textContent(), "无用量");
  await done(p);
});

test("站长视角：10 分钟内读过的用量不重复请求，点重新读取全部重读；读取失败时提示", async () => {
  const p = await open("sites1,admin");
  await T(p, "operator-alpha").click();
  await p.waitForFunction(() => document.querySelector('[data-testid="group-cost-2"]')?.textContent === "$2.50");
  await p.waitForFunction(() => !document.querySelector('[data-testid="op-progress"]'));
  const first = await p.evaluate(() => window.__adminUsageCalls.length);
  assert.equal(first, 7, "4 个下游分组 + 3 个上游账号");
  await T(p, "site-name-alpha").click();
  await T(p, "operator-alpha").click();
  await p.waitForTimeout(600);
  assert.equal(await p.evaluate(() => window.__adminUsageCalls.length), first, "没过期就不重复读");
  await T(p, "refresh").click();
  await p.waitForFunction((n) => window.__adminUsageCalls.length >= n * 2, first);
  await done(p);
  const q = await open("sites1,admin,adminusage-fail");
  await T(q, "operator-alpha").click();
  await T(q, "toast").waitFor();
  assert.match(await T(q, "toast").textContent(), /部分用量没有读到：站点限流了/);
  const failedCell = q.locator('.muted.fail:has-text("读取失败")').first();
  await failedCell.waitFor();
  await failedCell.hover();
  await q.waitForFunction(() => /读取失败：站点限流了.*点顶部刷新重试/.test(document.getElementById("fd-tip")?.textContent ?? ""));
  await done(q);
});

test("站长视角：去掉说明文字；按客户端分 tab，每个 tab 旁边一个点（红点 + 有问题的分组数，没问题是绿点）", async () => {
  const p = await open("sites1,admin");
  await T(p, "operator-alpha").click();
  await T(p, "op-tabs").waitFor();
  const page = await T(p, "op-list").evaluate(() => document.querySelector(".content").textContent);
  assert.ok(!page.includes("每个色块是一个下游分组"), "说明文字去掉了");
  assert.ok(!/个上游账号 · \d+ 个下游分组/.test(page), "汇总行去掉了");
  assert.deepEqual(await p.locator(".op-tab").evaluateAll((es) => es.map((e) => e.firstChild.textContent)), ["全部", "Claude", "OpenAI"]);
  // 分组 12 没有运行中的上游（一个暂停、一个异常），分组 99 没有上游 → 各算一个问题
  assert.equal(await T(p, "op-n-all").textContent(), "2");
  assert.equal(await T(p, "op-n-anthropic").textContent(), "1");
  assert.equal(await T(p, "op-n-openai").textContent(), "1");
  assert.equal(await T(p, "op-dot-all").getAttribute("class"), "tab-dot bad");
  await T(p, "op-dot-anthropic").hover();
  await p.waitForFunction(() => /1 个分组有问题[\s\S]*Claude 逆向Kiro - 特价 —— 没有运行中的上游/.test(document.getElementById("fd-tip")?.textContent ?? ""));
  // 切 tab：只显示这个客户端的分组
  await T(p, "op-tab-openai").click();
  assert.equal(await count(p, '[data-testid^="down-block-"]'), 1);
  assert.equal(await count(p, '[data-testid="down-block-99"]'), 1);
  await T(p, "op-tab-anthropic").click();
  assert.equal(await count(p, '[data-testid^="down-block-"]'), 3);
  // 恢复暂停的 u2 后，分组 12 有运行中的上游了，但还有一个异常的上游 u3：仍是问题，原因变成“上游异常”
  await T(p, "up-edit-u2").first().click({ force: true });
  await T(p, "au-nav-state").click();
  await T(p, "st-sched-on").click();
  await p.waitForFunction(() => /这个上游能被用户调用到/.test(document.querySelector('[data-testid="st-now"]')?.textContent ?? ""));
  await T(p, "st-close").click();
  await p.waitForFunction(() => [...document.querySelectorAll('[data-testid="up-status-u2"]')].every((e) => e.textContent === "运行中"));
  assert.equal(await T(p, "op-n-anthropic").textContent(), "1");
  await T(p, "op-dot-anthropic").hover();
  await p.waitForFunction(() => /上游「异常账号」异常/.test(document.getElementById("fd-tip")?.textContent ?? ""));
  // 把异常的上游移除后，Claude 下没有问题了：绿点，数字消失
  await T(p, "up-remove-u3").click({ force: true });
  await T(p, "up-confirm").click();
  await p.waitForFunction(() => document.querySelector('[data-testid="op-n-anthropic"]') === null);
  assert.equal(await T(p, "op-dot-anthropic").getAttribute("class"), "tab-dot ok");
  assert.equal(await T(p, "op-n-all").textContent(), "1", "全部里还剩没有上游的分组 99");
  await done(p);
});

test("站长视角：分组和上游行都有“24h流水”列：下游 +收入，上游 -成本；翻满记录的显示 ≥；左侧不再有“上游站点”区域", async () => {
  const p = await open("sites1,admin");
  await T(p, "operator-alpha").click();
  await p.waitForFunction(() => /^\+/.test(document.querySelector('[data-testid="group-tokens-2"]')?.textContent ?? ""));
  await p.waitForFunction(() => !document.querySelector('[data-testid="op-progress"]'));
  console.log("FLOW", await T(p, "group-tokens-2").textContent(), await T(p, "group-tokens-4").textContent(), await T(p, "account-tokens-u1").first().textContent());
  assert.match(await T(p, "group-tokens-4").textContent(), /^\+≥/, "只统计了一部分");
  assert.equal(await T(p, "account-tokens-u1").first().textContent(), "关联", "上游成本只读真实账单：没关联上游分组就没有");
  await T(p, "group-tokens-2").hover();
  await p.waitForFunction(() => /过去 24 小时用户为这个分组支付的钱.*Token 25\.90M/.test(document.getElementById("fd-tip")?.textContent ?? ""));
  await done(p);
});

test("站长视角：没添加账号的上游站点在顶部提示，点“添加”打开添加站点并填好地址", async () => {
  const p = await open("sites1,admin");
  await T(p, "operator-alpha").click();
  await T(p, "op-missing").waitFor();
  assert.match(await T(p, "op-missing").textContent(), /这些上游站点还没有添加你的账号：.*api\.up-two\.com/);
  await T(p, "op-add-api.up-two.com").click();
  await T(p, "add-dialog").waitFor();
  assert.equal(await T(p, "add-url").inputValue(), "api.up-two.com", "地址已填好");
  await done(p).catch(() => {});
  const q = await open("sites1,admin,alllinked");
  await T(q, "operator-alpha").click();
  await T(q, "account-rate-u1").first().waitFor();
  assert.equal(await count(q, '[data-testid="op-missing"]'), 0, "都添加过了就不提示");
  await done(q);
});

test("站长视角：上游账号关联到上游站点的分组后，倍率读那个分组当前的倍率，成本按真实倍率算；可更换、取消", async () => {
  const p = await open("sites2,admin");
  await T(p, "operator-alpha").click();
  await T(p, "account-rate-u1").first().waitFor();
  await p.waitForFunction(() => !document.querySelector('[data-testid="op-progress"]'));
  // u1：名称“官方账号池 0.09”，上游站点里恰好有一个倍率 0.09 的分组 → 推荐（虚线 + 问号），成本先按官方价口径
  assert.equal(await T(p, "account-rate-u1").first().textContent(), "×0.09?");
  assert.match(await T(p, "account-rate-u1").first().getAttribute("class"), /hint/);
  assert.equal(await T(p, "account-cost-u1").first().textContent(), "关联");
  // u2：名称里的 0.35 在上游站点没有对应分组 → 没推荐，显示“关联”
  assert.equal(await T(p, "account-rate-u2").first().textContent(), "关联");
  // 点“×0.09?”：不再有单独的关联弹窗，打开编辑（更换来源）弹窗，默认选中推荐的分组
  await T(p, "account-rate-u1").first().click();
  await T(p, "add-upstream-dialog").waitFor();
  assert.equal(await count(p, '[data-testid="link-dialog"]'), 0);
  assert.equal(await T(p, "au-site").inputValue(), "beta", "上游站点是已登录的 Beta");
  await T(p, "au-group").selectOption("Claude 逆向Kiro");
  await T(p, "au-submit").click();
  await T(p, "add-upstream-result").waitFor();
  await T(p, "au-done").click();
  await p.waitForFunction(() => document.querySelector('[data-testid="account-rate-u1"]')?.textContent === "×0.3");
  assert.match(await T(p, "account-rate-u1").first().getAttribute("class"), /linked/);
  assert.match((await opsLog(p)).at(-1), /^replace:u1:beta:Claude 逆向Kiro:/);
  // 成本 = 上游站点自己记的真实账单（mock 里这个分组每百万 $2.00，24 小时扣 $3.00），不是估算
  await p.waitForFunction(() => document.querySelector('[data-testid="account-cost-u1"]')?.textContent === "$2.00");
  assert.equal(await T(p, "account-tokens-u1").first().textContent(), "-$3.00");
  await T(p, "account-cost-u1").first().hover();
  await p.waitForFunction(() => /真实账单.*实际被扣的钱.*不是估算/.test(document.getElementById("fd-tip")?.textContent ?? ""));
  // 已经关联好的倍率：点击没有任何反应
  const nOps = (await opsLog(p)).length;
  await T(p, "account-rate-u1").first().click();
  assert.equal(await count(p, '[data-testid="add-upstream-dialog"]'), 0, "已关联的倍率不可点");
  assert.equal((await opsLog(p)).length, nOps);
  assert.equal(await T(p, "account-rate-u1").first().evaluate((e) => e.tagName), "SPAN");
  // u2（没有推荐，显示“关联”）：同样打开编辑弹窗，选“正价”
  await linkVia(p, "u2", { site: "beta", group: "Claude 逆向Kiro" });
  await p.waitForFunction(() => document.querySelector('[data-testid="account-rate-u2"]')?.textContent === "×0.3");
  await done(p);
});

test("管理的中转站卡片：右键只有“控制台、删除”", async () => {
  const p = await open("sites1,admin");
  await T(p, "operator-alpha").click({ button: "right" });
  assert.deepEqual(await p.locator('[data-testid="ctx-menu"] button').allTextContents(), ["控制台", "删除"]);
  await T(p, "ctx-console").click();
  await p.waitForFunction(() => (window.__opened ?? []).length === 1);
  await T(p, "operator-alpha").click({ button: "right" });
  await T(p, "ctx-remove").click();
  await T(p, "remove-dialog").waitFor();
  await done(p);
});

test("站点 tab：点站点名称只切换筛选，不打开网页；右键“控制台”才打开站点控制台", async () => {
  const p = await open("sites2");
  await T(p, "group-card-alpha-2").waitFor();
  await T(p, "site-name-beta").click();
  assert.deepEqual(await p.evaluate(() => window.__opened ?? []), [], "点站点名称不打开网页");
  assert.match(await T(p, "site-beta").getAttribute("class"), /\bon\b/, "只是切换了筛选");
  await ctx(p, "site-alpha", "console");
  await p.waitForFunction(() => (window.__opened ?? []).length === 1);
  await ctx(p, "site-beta", "console");
  await p.waitForFunction(() => (window.__opened ?? []).length === 2);
  assert.deepEqual(await p.evaluate(() => window.__opened), ["https://alpha.example.com", "https://beta.example.com/console"]);
  assert.match(await T(p, "site-beta").getAttribute("class"), /\bon\b/, "右键不触发切换");
  await done(p);
});

test("站长：给下游分组添加上游——选上游站点和分组，预览步骤，创建后显示结果，可以启用；新上游出现在色块里", async () => {
  const p = await open("sites2,admin");
  await T(p, "operator-alpha").click();
  await T(p, "down-addup-4").waitFor();
  await T(p, "down-addup-4").click({ force: true });
  await T(p, "add-upstream-dialog").waitFor();
  assert.match(await T(p, "add-upstream-dialog").textContent(), /给「Claude 逆向Kiro」添加上游/);
  // 上游站点里没有站长自己的站点
  assert.deepEqual(await T(p, "au-site").locator("option").allTextContents(), ["Beta"]);
  assert.match(await T(p, "au-group").locator("option").first().textContent(), /· ×/, "分组旁边显示倍率");
  const name = await T(p, "au-name").inputValue();
  assert.match(name, /^Beta-/, `名称默认“站点名-分组名”: ${name}`);
  assert.equal(await count(p, '[data-testid="au-paused"]'), 0, "没有“先暂停”选项；上游创建后默认调度开启");
  const preview = await T(p, "au-preview").textContent();
  assert.match(preview, /创建（或复用）一把专用 Key.*发一句“hi”试一次/);
  assert.match(preview, /直接启用，马上参与调度/);
  assert.match(preview, /任何一步失败都会撤销/);
  assert.deepEqual(await opsLog(p), [], "点创建之前不会做任何事");
  await T(p, "au-name").fill("我的上游 A");
  await T(p, "au-submit").click();
  await T(p, "add-upstream-result").waitFor();
  const res = await T(p, "add-upstream-result").textContent();
  assert.match(res, /上游账号「我的上游 A」已创建，绑定到下游分组「Claude 逆向Kiro」/);
  assert.match(res, /读到 4 个可用模型/);
  assert.match(res, /首字时延 0\.82s，链路是通的/);
  assert.match(res, /已经启用，正在参与调度/);
  assert.equal((await opsLog(p)).length, 1);
  assert.match((await opsLog(p))[0], /^add-upstream:4:beta:Claude 逆向Kiro:false$/);
  // 启用
  assert.equal(await count(p, '[data-testid="au-resume"]'), 0, "不需要再点“启用”");
  await T(p, "au-done").click();
  await T(p, "add-upstream-dialog").waitFor({ state: "detached" });
  // 新上游出现在这个下游分组的色块里
  await p.waitForFunction(() => document.querySelector('[data-testid="down-block-4"]')?.textContent?.includes("我的上游 A"));
  await done(p);
});

test("站长：添加上游失败（比如上游余额不足）时，错误留在对话框里；没有其他站点时引导先添加上游站点", async () => {
  const p = await open("sites2,admin,addfail");
  await T(p, "operator-alpha").click();
  await T(p, "down-addup-4").click({ force: true });
  await T(p, "au-submit").click();
  await p.waitForFunction(() => /没通：Insufficient account balance/.test(document.querySelector('[data-testid="au-error"]')?.textContent ?? ""));
  assert.equal(await count(p, '[data-testid="add-upstream-result"]'), 0);
  assert.equal(await T(p, "au-submit").isDisabled(), false, "可以改了重试");
  await done(p);
  const q = await open("sites1,admin");
  await T(q, "operator-alpha").click();
  await T(q, "down-addup-4").click({ force: true });
  assert.match(await T(q, "add-upstream-dialog").textContent(), /还没有可以当上游的站点/);
  assert.equal(await count(q, '[data-testid="au-submit"]'), 0);
  await T(q, "au-add-site").click();
  await T(q, "add-dialog").waitFor();
  await done(q);
});

test("站长：新建下游分组——填名称、备注、分类、倍率，创建后直接打开“添加上游”；new-api 没有分类", async () => {
  const p = await open("sites2,admin");
  await T(p, "operator-alpha").click();
  await T(p, "op-new-group").click();
  await T(p, "create-group-dialog").waitFor();
  await T(p, "cg-submit").click();
  assert.equal(await T(p, "cg-error").textContent(), "名称不能为空");
  await T(p, "cg-name").fill("新的下游");
  await T(p, "cg-rate").fill("abc");
  await T(p, "cg-submit").click();
  assert.match(await T(p, "cg-error").textContent(), /倍率必须是大于 0 的数字/);
  await T(p, "cg-desc").fill("备注一下");
  await T(p, "cg-platform").selectOption("openai");
  await T(p, "cg-rate").fill("0.6");
  await T(p, "cg-submit").click();
  await T(p, "add-upstream-dialog").waitFor();
  assert.match(await T(p, "add-upstream-dialog").textContent(), /给「新的下游」添加上游/);
  assert.deepEqual(await opsLog(p), ["create-group:新的下游:openai:0.6"]);
  await T(p, "au-cancel").click();
  await p.waitForFunction(() => document.querySelector('[data-testid="down-block-n5"]'));
  await done(p);
  const q = await open("sites2,admin");
  await T(q, "operator-beta").click();
  await T(q, "op-new-group").click();
  assert.equal(await count(q, '[data-testid="cg-platform"]'), 0, "new-api 没有分类");
  await done(q);
  const r = await open("sites2,admin,createfail");
  await T(r, "operator-alpha").click();
  await T(r, "op-new-group").click();
  await T(r, "cg-name").fill("重名");
  await T(r, "cg-submit").click();
  await r.waitForFunction(() => /已经有一个叫/.test(document.querySelector('[data-testid="cg-error"]')?.textContent ?? ""));
  assert.equal(await count(r, '[data-testid="create-group-dialog"]'), 1, "错误留在对话框里");
  await done(r);
});

// ---------- 分组行的“···”菜单：sayhi 测试 / 修改分组 / 创建下游 ----------

test("启用按钮右边有“···”，悬停后换成三个图标（sayhi / 修改分组 / 创建下游），启用按钮不会消失", async () => {
  const p = await open("sites1,admin");
  await T(p, "group-card-alpha-2").waitFor();
  await p.waitForFunction(() => !document.body.textContent.includes("读取中…")); // 后台读成本会频繁重绘，等它读完再操作
  assert.equal(await T(p, "more-alpha-2").locator(".more-dots").evaluate((e) => getComputedStyle(e).opacity), "0", "平时隐藏");
  await T(p, "group-card-alpha-2").hover();
  await p.waitForFunction(() => getComputedStyle(document.querySelector('[data-testid="more-alpha-2"] .more-dots')).opacity === "1");
  // “···”在启用按钮右边
  const xs = await p.evaluate(() => ["enable-alpha-2", "more-alpha-2"].map((id) => document.querySelector(`[data-testid="${id}"]`).getBoundingClientRect().left));
  assert.ok(xs[0] < xs[1], `启用在左，···在右: ${xs}`);
  assert.equal(await T(p, "sayhi-alpha-2").isVisible(), false, "没悬停到“···”上时三个图标不显示");
  await T(p, "more-alpha-2").hover();
  await p.waitForFunction(() => getComputedStyle(document.querySelector('[data-testid="sayhi-alpha-2"]').closest(".more-icons")).display === "flex");
  const ix = await p.evaluate(() => ["sayhi", "makedown"].map((k) => document.querySelector(`[data-testid="${k}-alpha-2"]`).getBoundingClientRect().left));
  assert.ok(ix[0] < ix[1], `顺序：sayhi | 创建下游，实际 ${ix}`);
  assert.equal(await count(p, '[data-testid^="editclients-"]'), 0, "不再有“修改分组”图标，改在“客户端”列里修改");
  assert.equal(await T(p, "enable-alpha-2").evaluate((e) => getComputedStyle(e).opacity), "1", "行还在悬停状态，启用按钮没消失");
  await done(p);
});

test("sayhi 测试：选模型说 hi，看到回复和延迟；可以换模型再测；失败时显示站点原话", async () => {
  const p = await open("sites1,plaza");
  await T(p, "group-card-alpha-2").waitFor();
  await p.waitForFunction(() => !document.body.textContent.includes("读取中…")); // 后台读成本会频繁重绘，等它读完再操作
  await T(p, "more-alpha-2").hover();
  await T(p, "sayhi-alpha-2").click();
  await T(p, "sayhi-dialog").waitFor();
  assert.ok((await T(p, "sh-model").locator("option").count()) >= 2, "列出这个分组的模型");
  await T(p, "sh-model").selectOption("claude-opus-5-5");
  await T(p, "sh-send").click();
  await T(p, "sayhi-result-0").waitFor();
  const r = await T(p, "sayhi-result-0").textContent();
  assert.match(r, /claude-opus-5-5/);
  assert.match(r, /首字 0\.64s/);
  assert.match(r, /总耗时 1\.18s/);
  assert.match(r, /你好！有什么我可以帮你的吗？/);
  assert.match((await opsLog(p))[0], /^sayhi:alpha:2:claude-opus-5-5:claude$/, "按当前客户端的协议发");
  await T(p, "sh-model").selectOption("claude-sonnet-5-5");
  await T(p, "sh-send").click();
  await p.waitForFunction(() => document.querySelector('[data-testid="sayhi-result-1"]'));
  assert.match(await T(p, "sayhi-result-0").textContent(), /claude-sonnet-5-5/, "新的结果在最前面");
  await T(p, "sh-close").click();
  await T(p, "sayhi-dialog").waitFor({ state: "detached" });
  await done(p);
  const q = await open("sites1,plaza,sayhifail");
  await T(q, "more-alpha-2").hover();
  await T(q, "sayhi-alpha-2").click();
  await T(q, "sh-send").click();
  await q.waitForFunction(() => /Insufficient account balance/.test(document.querySelector('[data-testid="sh-error"]')?.textContent ?? ""));
  await done(q);
});

test("修改分组支持的客户端：多选保存后分组出现在对应客户端下；恢复默认；至少选一个", async () => {
  const p = await open("sites1");
  await T(p, "group-card-alpha-2").waitFor();
  await p.waitForFunction(() => !document.body.textContent.includes("读取中…")); // 后台读成本会频繁重绘，等它读完再操作
  assert.equal(await count(p, '[data-testid="group-card-alpha-2"]'), 1);
  await T(p, "cat-openai").click();
  assert.equal(await count(p, '[data-testid="group-card-alpha-2"]'), 0, "Claude 类分组默认不在 Codex 下");
  await T(p, "cat-claude").click();
  // 类别列：药丸显示分组的模型类别（自动识别的是虚线），点开多选下拉，关闭时保存
  assert.match(await T(p, "clients-alpha-2").textContent(), /Claude/);
  assert.match(await T(p, "clients-alpha-2").getAttribute("class"), /auto/, "没手动设置过：虚线，表示是自动识别的");
  await T(p, "clients-alpha-2").click();
  await T(p, "clients-picker").waitFor();
  assert.equal(await T(p, "ec-claude").isChecked(), true);
  assert.equal(await T(p, "ec-openai").isChecked(), false);
  assert.equal(await count(p, '[data-testid="ec-deepseek"], [data-testid="ec-video"], [data-testid="ec-audio"], [data-testid="ec-other"]'), 4, "有 DeepSeek / 视频 / 音频 / 其他 等类别");
  await T(p, "ec-openai").click();
  await T(p, "ec-video").click();
  assert.deepEqual(await opsLog(p), [], "还没关闭下拉，不保存");
  await p.keyboard.press("Escape");
  await T(p, "clients-picker").waitFor({ state: "detached" });
  await p.waitForFunction(() => /^clients:alpha:2:claude,openai,video$/.test((window.__adminOps ?? []).at(-1) ?? ""));
  await p.waitForFunction(() => !/auto/.test(document.querySelector('[data-testid="clients-alpha-2"]')?.className ?? "auto")); // 手动设置后是实线
  await T(p, "cat-openai").click();
  await T(p, "group-card-alpha-2").waitFor();
  await T(p, "cat-video").click();
  await T(p, "group-card-alpha-2").waitFor();
  assert.equal(await count(p, '[data-testid="enable-alpha-2"]'), 1, "含 Claude / OpenAI 类，仍可一键配置");
  // 全部取消 = 恢复自动识别；点别处也会关闭并保存
  await T(p, "cat-all").click();
  await T(p, "clients-alpha-2").click();
  for (const c of ["claude", "openai", "video"]) await T(p, `ec-${c}`).click();
  await p.mouse.click(5, 5);
  await T(p, "clients-picker").waitFor({ state: "detached" });
  await p.waitForFunction(() => /^clients:alpha:2:-$/.test((window.__adminOps ?? []).at(-1) ?? ""));
  await T(p, "cat-openai").click();
  await p.waitForFunction(() => !document.querySelector('[data-testid="group-card-alpha-2"]'));
  await done(p);
});

test("创建下游：选中转站，名称 / 类型默认复用上游分组，填倍率和备注；创建后上游分组底部显示下游的站点、分组、倍率", async () => {
  const p = await open("sites2,admin");
  await T(p, "group-card-alpha-2").waitFor();
  await p.waitForFunction(() => !document.body.textContent.includes("读取中…")); // 后台读成本会频繁重绘，等它读完再操作
  // alpha 的分组做上游、beta 当中转站（alpha 自己不能当自己的中转站）
  await T(p, "more-alpha-2").hover();
  await T(p, "makedown-alpha-2").click();
  await T(p, "makedown-dialog").waitFor();
  assert.deepEqual(await T(p, "md-site").locator("option").allTextContents(), ["Beta"], "只列别的中转站");
  assert.equal(await T(p, "md-name").inputValue(), "Claude 官方系列高速", "名称默认用上游分组的");
  assert.equal(await count(p, '[data-testid="md-platform"]'), 0, "new-api 中转站没有客户端类型");
  assert.equal(await T(p, "md-rate").inputValue(), "2.5", "倍率默认是上游的");
  assert.equal(await count(p, '[data-testid="md-paused"]'), 0, "没有“先暂停”选项；上游创建后默认调度开启");
  await T(p, "md-name").fill("我的下游");
  await T(p, "md-rate").fill("abc");
  await T(p, "md-submit").click();
  assert.match(await T(p, "md-error").textContent(), /倍率必须是大于 0 的数字/);
  await T(p, "md-rate").fill("3.5");
  await T(p, "md-desc").fill("测试勿用");
  await T(p, "md-submit").click();
  await T(p, "makedown-result").waitFor();
  assert.match(await T(p, "makedown-result").textContent(), /创建了下游分组「我的下游」（×3\.5）/);
  assert.match(await T(p, "makedown-result").textContent(), /上游已经启用，正在参与调度/);
  assert.equal((await opsLog(p)).at(-1), "create-downstream:beta:alpha:2:我的下游:-:3.5:测试勿用:false");
  await T(p, "md-done").click();
  // 上游分组底部显示下游
  await p.waitForFunction(() => document.querySelector('[data-testid="downs-alpha-2"]'));
  const line = await T(p, "downs-alpha-2").textContent();
  assert.match(line, /Beta/);
  assert.match(line, /我的下游/);
  assert.match(line, /×3\.5/);
  // 在分组名和“该站点未对分组分类”之下（卡片底部）
  const pos = await p.evaluate(() => { const c = document.querySelector('[data-testid="group-card-alpha-2"]'); return { h3: c.querySelector("h3").getBoundingClientRect().bottom, downs: c.querySelector('[data-testid="downs-alpha-2"]').getBoundingClientRect().top }; });
  assert.ok(pos.downs >= pos.h3, "下游在分组名下面");
  await done(p);
});

test("创建下游：没有别的中转站时引导去添加；创建失败时错误留在对话框里", async () => {
  const p = await open("sites1,admin");
  await T(p, "group-card-alpha-2").waitFor();
  await p.waitForFunction(() => !document.body.textContent.includes("读取中…")); // 后台读成本会频繁重绘，等它读完再操作
  await T(p, "more-alpha-2").hover();
  await T(p, "makedown-alpha-2").click();
  assert.match(await T(p, "makedown-dialog").textContent(), /还没有你的中转站/);
  await T(p, "md-add-site").click();
  await T(p, "add-dialog").waitFor();
  await done(p);
  const q = await open("sites2,admin,downfail");
  await T(q, "group-card-alpha-2").waitFor();
  await q.waitForFunction(() => !document.body.textContent.includes("读取中…")); // 后台读成本会频繁重绘，等它读完再操作
  await T(q, "more-alpha-2").hover();
  await T(q, "makedown-alpha-2").click();
  await T(q, "md-submit").click();
  await q.waitForFunction(() => /已经创建，但添加上游失败.*Insufficient account balance/.test(document.querySelector('[data-testid="md-error"]')?.textContent ?? ""));
  assert.equal(await count(q, '[data-testid="makedown-result"]'), 0);
  await done(q);
});


test("左侧导航同一时间只有一张卡片处于激活；在中转站管理里点上游站点卡片能切回去；中转站卡片上有红点 + 异常数量", async () => {
  const p = await open("sites2,admin");
  await T(p, "operator-alpha").waitFor();
  const active = () => p.evaluate(() => [...document.querySelectorAll(".sidebar .side-item.selected, .sidebar .site-tab.on")].map((e) => e.getAttribute("data-testid")));
  assert.deepEqual(await active(), ["site-tab-all"], "普通视图：只有“全部站点”激活");
  // 中转站卡片上的红点和数量（概览一读到就有，不用点进去）
  await p.waitForFunction(() => document.querySelector('[data-testid="operator-n-alpha"]'));
  assert.equal(await T(p, "operator-n-alpha").textContent(), "2", "mock 里 alpha 有 2 个有问题的分组");
  assert.equal(await T(p, "operator-dot-alpha").getAttribute("class"), "tab-dot bad");
  await T(p, "operator-alpha").click();
  await T(p, "op-list").waitFor();
  assert.deepEqual(await active(), ["operator-alpha"], "进了中转站：只有它激活，上游站点里没有高亮的");
  assert.equal(await count(p, '[data-testid="client-tabs"]'), 0);
  // 再点上游站点的卡片：切回分组列表，筛选到这个站点，并且只有这张卡片激活
  await T(p, "site-name-beta").click();
  await T(p, "group-list").waitFor();
  assert.deepEqual(await active(), ["site-beta"]);
  assert.equal(await cards(p), 1, "按这个站点筛选");
  // 点“全部站点”也一样
  await T(p, "operator-alpha").click();
  await T(p, "op-list").waitFor();
  await p.mouse.move(0, 0);
  await T(p, "site-tab-all").click();
  await T(p, "group-list").waitFor();
  assert.deepEqual(await active(), ["site-tab-all"]);
  // 正常的站点是绿点（beta 在 mock 里只有一个有上游的分组）
  assert.equal(await count(p, '[data-testid="operator-n-beta"]'), 0);
  assert.equal(await T(p, "operator-dot-beta").getAttribute("class"), "tab-dot ok");
  await done(p);
});

test("检查更新的左边显示当前版本号", async () => {
  const p = await open("sites1");
  await T(p, "app-version").waitFor();
  assert.equal(await T(p, "app-version").textContent(), "v0.5.4");
  const xs = await p.evaluate(() => ["app-version", "check-update"].map((id) => document.querySelector(`[data-testid="${id}"]`).getBoundingClientRect().left));
  assert.ok(xs[0] < xs[1], `版本号在“检查更新”左边: ${xs}`);
  await done(p);
});

// ---------- 站长：排序 / 删除下游分组 / 更换上游来源 / 重复添加提示 / 预测倍率可点 ----------

test("中转站列表：默认按 24h流水 从高到低；每一列标题都能排序，没有数据的排最后", async () => {
  const p = await open("sites1,admin");
  await T(p, "operator-alpha").click();
  await p.waitForFunction(() => !document.querySelector('[data-testid="op-progress"]') && document.querySelector('[data-testid="group-tokens-2"]'));
  const order = () => p.evaluate(() => [...document.querySelectorAll('[data-testid^="down-block-"]')].map((e) => e.getAttribute("data-testid").replace("down-block-", "")));
  assert.match(await T(p, "op-sort-tokens").getAttribute("class"), /\bon\b/, "默认按 24h流水 排序");
  // mock 里 24h Token：分组 2 = 25.9M，4 = 340K，12 = 340K，99 = 没有（无用量）→ 2 最前，99 最后
  const o1 = await order();
  assert.equal(o1[0], "2");
  assert.equal(o1.at(-1), "99");
  // 再点一次：升序，没有数据的仍在最后
  await T(p, "op-sort-tokens").click();
  const o2 = await order();
  assert.equal(o2.at(-1), "99", "没有数据的始终排最后");
  assert.equal(o2[0] !== "2", true, "升序时 25.9M 的不在最前");
  // 按名称排序：升序
  await T(p, "op-sort-name").click();
  const names = await p.locator('[data-testid^="down-name-"]').allTextContents();
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)), "按名称升序");
  // 按倍率降序：2.5(分组 2)最前
  await T(p, "op-sort-rate").click();
  assert.equal((await order())[0], "2");
  // 每个标题都是可点的排序按钮
  assert.deepEqual(await p.locator('[data-testid="op-list-head"] button.sortable').count(), 7);
  await done(p);
});

test("删除下游分组：弹窗列出绑在它上面的上游（不会被删），确认后分组消失；站点拒绝时错误留在弹窗里", async () => {
  const p = await open("sites1,admin");
  await T(p, "operator-alpha").click();
  await T(p, "down-remove-12").waitFor();
  await T(p, "down-remove-12").click({ force: true });
  await T(p, "remove-group-dialog").waitFor();
  assert.match(await T(p, "remove-group-dialog").textContent(), /删除下游分组「Claude 逆向Kiro - 特价」/);
  assert.match(await T(p, "rg-ups").textContent(), /不会被删除，只是不再服务这个分组/);
  assert.deepEqual(await opsLog(p), [], "确认前不会删");
  await T(p, "rg-confirm").click();
  await T(p, "down-block-12").waitFor({ state: "detached" });
  assert.deepEqual(await opsLog(p), ["remove-group:12"]);
  await done(p);
  const q = await open("sites1,admin,rmgroupfail");
  await T(q, "operator-alpha").click();
  await T(q, "down-remove-12").click({ force: true });
  await T(q, "rg-confirm").click();
  await q.waitForFunction(() => /该分组下还有用户的 Key，不能删除/.test(document.querySelector('[data-testid="rg-error"]')?.textContent ?? ""));
  assert.equal(await count(q, '[data-testid="remove-group-dialog"]'), 1);
  await done(q);
});

test("上游行的编辑图标：打开添加上游的弹窗（复用），改它的上游分组来源；名称不变、状态不变", async () => {
  const p = await open("sites2,admin");
  await T(p, "operator-alpha").click();
  await T(p, "up-edit-u1").first().waitFor();
  await T(p, "up-edit-u1").first().click();
  await T(p, "add-upstream-dialog").waitFor();
  assert.match(await T(p, "add-upstream-dialog").textContent(), /更换「官方账号池 0\.09」的上游分组来源/);
  assert.equal(await T(p, "au-name").isDisabled(), true, "sub2api：更换来源时名称不变");
  assert.equal(await count(p, '[data-testid="au-paused"]'), 0, "不问先暂停：保持原来的状态");
  assert.match(await T(p, "au-preview").textContent(), /就地改成新的来源/);
  await T(p, "au-submit").click();
  await T(p, "add-upstream-result").waitFor();
  assert.match(await T(p, "add-upstream-result").textContent(), /来源已改为「Beta」/);
  assert.match((await opsLog(p)).at(-1), /^replace:u1:beta:/);
  assert.equal(await count(p, '[data-testid="au-resume"]'), 0);
  await T(p, "au-done").click();
  await done(p);
  const q = await open("sites2,admin,replacefail");
  await T(q, "operator-alpha").click();
  await T(q, "up-edit-u1").first().click();
  await T(q, "au-submit").click();
  await q.waitForFunction(() => /没通：Insufficient account balance/.test(document.querySelector('[data-testid="au-error"]')?.textContent ?? ""));
  await done(q);
});

test("同一个上游分组再添加一次：提示会共用同一把上游 Key、会顶掉先到的用户，勾选确认后才能继续", async () => {
  const p = await open("sites2,admin");
  await T(p, "operator-alpha").click();
  await T(p, "account-rate-u1").first().waitFor();
  await p.waitForFunction(() => !document.querySelector('[data-testid="op-progress"]'));
  // 把上游账号 u1 关联到 Beta 的“Claude 逆向Kiro”分组（它正在用这个分组的 Key）
  await linkVia(p, "u1", { site: "beta", group: "Claude 逆向Kiro" });
  await p.waitForFunction(() => document.querySelector('[data-testid="account-rate-u1"]')?.textContent === "×0.3");
  // 再给别的下游分组添加同一个上游分组：弹出警告
  await p.waitForFunction(() => !document.querySelector('[data-testid="op-progress"]'));
  await T(p, "down-addup-12").click({ force: true });
  await T(p, "au-dup").waitFor();
  await p.waitForTimeout(400); // 等后台的重新读取（loadAdmin）把对话框重绘完
  assert.match(await T(p, "au-dup").textContent(), /已经被上游账号「官方账号池 0\.09」使用.*共用同一把上游 Key.*顶掉/);
  assert.match(await T(p, "au-name").inputValue(), /\(2\)$/, "默认名称加 (2) 避免重名");
  // 没勾选确认：不让继续
  await T(p, "au-submit").click();
  assert.match(await T(p, "au-error").textContent(), /请先勾选“我知道会共用同一把上游 Key，仍然添加”/);
  assert.equal((await opsLog(p)).filter((o) => o.startsWith("add-upstream")).length, 0);
  await T(p, "au-dup-ok").check();
  await T(p, "au-submit").click();
  await T(p, "add-upstream-result").waitFor();
  assert.match((await opsLog(p)).at(-1), /^add-upstream:12:beta:Claude 逆向Kiro:false$/);
  await done(p);
});

test("预测的上游倍率（虚线）可以点：站点还没添加就打开添加站点并填好地址；提示文案是新的", async () => {
  const p = await open("sites1,admin,hint");
  await T(p, "operator-alpha").click();
  await T(p, "account-rate-u3").first().waitFor();
  assert.equal(await T(p, "account-rate-u3").first().textContent(), "×0.7");
  assert.equal(await T(p, "account-rate-u3").first().getAttribute("data-tip"), "按账号名称末尾的数字推测的上游倍率，仅供参考,可关联真实上游的分组，实现倍率监控");
  await T(p, "account-rate-u3").first().click();
  await T(p, "add-dialog").waitFor();
  assert.equal(await T(p, "add-url").inputValue(), "api.up-three.com", "地址已填好");
  await done(p);
});

test("添加上游站点的账号后，中转站顶部“还没有添加你的账号”的提示去掉那个站点；再次登录已有站点会提示替换", async () => {
  const p = await open("sites1,admin");
  await T(p, "operator-alpha").click();
  await T(p, "op-missing").waitFor();
  await T(p, "site-name-alpha").click(); // 回到普通视图
  await T(p, "add-site").click();
  await T(p, "add-url").fill("alpha.example.com");
  await T(p, "add-submit").click();
  await T(p, "add-username").waitFor();
  assert.match(await T(p, "add-replace-warn").textContent(), /这个站点已经添加过.*再次登录会替换掉它.*顶掉/);
  assert.equal(await T(p, "add-submit").textContent(), "替换并登录");
  await done(p);
});

test("对话框比窗口高时自己滚动，底部的按钮始终在窗口里能点到", async () => {
  const p = await open("sites2,admin", { width: 1100, height: 520 });
  await T(p, "operator-alpha").click();
  await T(p, "down-addup-12").click({ force: true });
  await T(p, "add-upstream-dialog").waitFor();
  const g = await p.evaluate(() => { const m = document.querySelector(".modal").getBoundingClientRect(); const b = document.querySelector('[data-testid="au-submit"]').getBoundingClientRect(); return { modalBottom: m.bottom, btnBottom: b.bottom, vh: innerHeight }; });
  assert.ok(g.modalBottom <= g.vh, `对话框不超出窗口: ${g.modalBottom} > ${g.vh}`);
  assert.ok(g.btnBottom <= g.vh, `创建按钮在窗口里: ${g.btnBottom} > ${g.vh}`);
  await T(p, "au-submit").click();
  await T(p, "add-upstream-result").waitFor();
  await done(p);
});

// ---------- 更换来源弹窗的左侧导航、测试模型、上游行 sayhi、列名 ----------

test("“平均成本”：列表和中转站的列标题都叫“平均成本”，不再叫“Token成本”", async () => {
  const p = await open("sites1,admin");
  await T(p, "group-card-alpha-2").waitFor();
  assert.match(await T(p, "sort-cost").textContent(), /^平均成本/);
  await T(p, "operator-alpha").click();
  await T(p, "op-sort-cost").waitFor();
  assert.match(await T(p, "op-sort-cost").textContent(), /^平均成本/);
  assert.ok(!(await p.locator(".content").textContent()).includes("Token成本"), "页面上不再出现“Token成本”");
  await done(p);
});

test("更换来源的弹窗：左侧导航“上游调整 / 账号状态”，账号状态里快速改“状态”和“调度”，并提示两个都对用户才能调用通", async () => {
  const p = await open("sites2,admin");
  await T(p, "operator-alpha").click();
  await T(p, "up-edit-u2").first().click();
  await T(p, "add-upstream-dialog").waitFor();
  assert.match(await T(p, "au-nav-source").getAttribute("class"), /\bon\b/, "默认是“上游调整”");
  assert.equal(await T(p, "au-site").count(), 1, "上游调整里是现在的设置");
  await T(p, "au-nav-state").click();
  assert.match(await T(p, "st-hint").textContent(), /按 sub2api 的规则.*状态 = 启用、调度 = 开启、没有被站点自动暂时摘除/);
  assert.equal(await count(p, '[data-testid^="st-status-"]'), 3, "sub2api 的账号状态有三种：启用 / 停用 / 异常");
  assert.deepEqual(await p.locator('.segs').first().locator("button").allTextContents(), ["启用", "停用", "异常"]);
  assert.match(await T(p, "au-nav-state").getAttribute("class"), /\bbad\b/, "现在调用不通：左侧“账号状态”标红");
  // u2：状态启用但调度关闭 → 现在调用不通
  assert.match(await T(p, "st-now").textContent(), /不会被调用到.*调度是“关闭”/);
  await T(p, "st-sched-on").click();
  await p.waitForFunction(() => /这个上游能被用户调用到/.test(document.querySelector('[data-testid="st-now"]')?.textContent ?? ""));
  assert.equal((await opsLog(p)).at(-1), "state:u2:-:true");
  assert.doesNotMatch(await T(p, "au-nav-state").getAttribute("class"), /\bbad\b/, "恢复后不再标红");
  // 状态改成停用 → 又不通了，并且调度不动
  await T(p, "st-status-inactive").click();
  await p.waitForFunction(() => /状态是“停用”/.test(document.querySelector('[data-testid="st-now"]')?.textContent ?? ""));
  assert.equal((await opsLog(p)).at(-1), "state:u2:inactive:-");
  // 手动标为异常：和被系统自动标记一样
  await T(p, "st-status-error").click();
  await p.waitForFunction(() => /状态是“异常”/.test(document.querySelector('[data-testid="st-now"]')?.textContent ?? ""));
  assert.equal((await opsLog(p)).at(-1), "state:u2:error:-");
  await T(p, "st-status-active").click();
  await p.waitForFunction(() => /这个上游能被用户调用到/.test(document.querySelector('[data-testid="st-now"]')?.textContent ?? ""));
  await T(p, "st-close").click();
  await T(p, "add-upstream-dialog").waitFor({ state: "detached" });
  await done(p);
  // new-api 的渠道只有“状态”一个开关，没有“调度”
  const q = await open("sites2,admin");
  await T(q, "operator-beta").click();
  await T(q, "up-edit-7").first().click();
  await T(q, "au-nav-state").click();
  assert.equal(await count(q, '[data-testid="st-sched-on"]'), 0, "没有调度开关");
  assert.equal(await count(q, '[data-testid="st-status-active"]'), 1);
  assert.match(await T(q, "st-hint").textContent(), /只有一个开关/);
  await done(q);
});

test("上游分组下面的“测试模型”：列出该分组的模型，选哪个就用哪个测；默认自动；添加和更换都有", async () => {
  const p = await open("sites2,admin,plaza");
  await T(p, "operator-alpha").click();
  await T(p, "down-addup-4").click({ force: true });
  await T(p, "au-model").waitFor();
  const opts = await T(p, "au-model").locator("option").allTextContents();
  assert.equal(opts[0], "自动（挑一个便宜的）");
  assert.ok(opts.length >= 2, `列出该分组的模型: ${opts}`);
  await T(p, "au-model").selectOption(opts[1]);
  await T(p, "au-submit").click();
  await T(p, "add-upstream-result").waitFor();
  assert.match((await opsLog(p)).at(-1), new RegExp(`:model=${opts[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`), "按选的模型测");
  await T(p, "au-done").click();
  // 换分组时重置回“自动”
  await T(p, "down-addup-12").click({ force: true });
  await T(p, "au-model").waitFor();
  assert.equal(await T(p, "au-model").inputValue(), "");
  await done(p);
});

test("上游账号右边有 sayhi 测试图标：关联了上游分组就复用 sayhi 弹窗测那个分组；没关联时提示先关联", async () => {
  const p = await open("sites2,admin,plaza");
  await T(p, "operator-alpha").click();
  await T(p, "up-sayhi-u3").first().waitFor();
  // u3 没有关联信息：提示
  await T(p, "up-sayhi-u3").first().click({ force: true });
  await T(p, "toast").waitFor();
  assert.match(await T(p, "toast").textContent(), /先关联这个上游账号用的上游分组/);
  // u1 有关联（mock 里关联到 Beta 的分组）：打开 sayhi 弹窗
  await p.waitForFunction(() => !document.querySelector('[data-testid="op-progress"]'));
  await linkVia(p, "u1", { site: "beta", group: "Claude 逆向Kiro" });
  await p.waitForFunction(() => document.querySelector('[data-testid="account-rate-u1"]')?.textContent === "×0.3");
  await T(p, "up-sayhi-u1").first().click({ force: true });
  await T(p, "sayhi-dialog").waitFor();
  assert.match(await T(p, "sayhi-dialog").textContent(), /sayhi 测试 · Claude 逆向Kiro/);
  await T(p, "sh-send").click();
  await T(p, "sayhi-result-0").waitFor();
  assert.match(await T(p, "sayhi-result-0").textContent(), /你好！/);
  await done(p);
});

test("添加站点的第一步不再写“填你平时登录的那个中转站网址”", async () => {
  const p = await open();
  await T(p, "empty-sites-add").click();
  await T(p, "add-url").waitFor();
  assert.ok(!(await p.locator(".modal").innerText()).includes("填你平时登录的那个中转站网址"));
  await done(p);
});

test("上游账号没关联时：成本和 24h流水也显示可点的“关联”，和倍率列一样打开编辑弹窗", async () => {
  const p = await open("sites2,admin");
  await T(p, "operator-alpha").click();
  await T(p, "account-cost-u1").first().waitFor();
  await p.waitForFunction(() => !document.querySelector('[data-testid="op-progress"]') && document.querySelector('[data-testid="account-rate-u1"]')?.textContent === "×0.09?"); // 关联信息读到后才有“关联”按钮
  for (const what of ["cost", "tokens"]) {
    const b = T(p, `account-${what}-u1`).first();
    assert.equal(await b.textContent(), "关联");
    assert.equal(await b.evaluate((e) => e.tagName), "BUTTON");
    assert.match(await b.getAttribute("class"), /hint/, "虚线样式，和倍率列一致");
  }
  await T(p, "account-tokens-u1").first().click();
  await T(p, "add-upstream-dialog").waitFor();
  assert.match(await T(p, "add-upstream-dialog").textContent(), /更换「官方账号池 0\.09」的上游分组来源/);
  await done(p);
});

test("账号状态：被站点自动摘除（限流 / 过载 / 临时不可调度）时，左侧“账号状态”标红并写明原因和恢复时间", async () => {
  const p = await open("sites2,admin,blocked");
  await T(p, "operator-alpha").click();
  await T(p, "up-edit-u1").first().click();
  await T(p, "add-upstream-dialog").waitFor();
  assert.match(await T(p, "au-nav-state").getAttribute("class"), /\bbad\b/);
  await T(p, "au-nav-state").click();
  assert.match(await T(p, "st-now").textContent(), /不会被调用到.*站点自动暂时摘除了它：触发了上游限流（429），约 5 分钟后自动恢复/);
  assert.match(await p.locator(".state-note").last().textContent().catch(() => ""), /|/);
  await done(p);
});

test("基于上游分组创建下游：除了新建，也可以选择已有的下游分组，把上游加到它下面", async () => {
  const p = await open("sites2,admin");
  await T(p, "group-card-alpha-2").waitFor();
  await p.waitForFunction(() => !document.body.textContent.includes("读取中…"));
  await T(p, "more-alpha-2").hover();
  await T(p, "makedown-alpha-2").click();
  await T(p, "makedown-dialog").waitFor();
  assert.match(await T(p, "md-mode-new").getAttribute("class"), /\bon\b/, "默认是新建");
  await T(p, "md-mode-existing").click();
  assert.equal(await count(p, '[data-testid="md-name"]'), 0, "选已有分组时不用填名称 / 倍率 / 备注");
  assert.equal(await count(p, '[data-testid="md-rate"]'), 0);
  await p.waitForFunction(() => document.querySelectorAll('[data-testid="md-existing"] option').length > 1);
  await T(p, "md-submit").click();
  assert.match(await T(p, "md-error").textContent(), /请选择一个已有的下游分组/);
  const opts = await T(p, "md-existing").locator("option").allTextContents();
  assert.ok(opts.length > 1, `列出已有的下游分组: ${opts}`);
  const target = await T(p, "md-existing").locator("option").nth(1).getAttribute("value");
  await T(p, "md-existing").selectOption(target);
  await T(p, "md-submit").click();
  await T(p, "makedown-result").waitFor();
  assert.match(await T(p, "makedown-result").textContent(), /已有的下游分组.*下添加了上游/);
  assert.match((await opsLog(p)).at(-1), new RegExp(`^add-upstream:${target}:alpha:2:`), "走的是添加上游，不是新建分组");
  await done(p);
});

test("类别 tab：按模型名自动识别 DeepSeek / 视频 / 音频等；一个分组可以属于多类；没有对应客户端的显示“不可配置”", async () => {
  const p = await open("sites1,media", undefined, { tab: "all" });
  await T(p, "group-card-alpha-31").waitFor();
  assert.deepEqual(await p.locator('[data-testid="client-tabs"] .side-name').allTextContents(), ["全部", "Claude", "OpenAI", "Gemini", "DeepSeek", "视频", "音频", "其他"]);
  await T(p, "cat-deepseek").click();
  assert.deepEqual(await p.locator('[data-testid^="group-card-"]').evaluateAll((es) => es.map((e) => e.getAttribute("data-testid")).sort()), ["group-card-alpha-31", "group-card-alpha-34"], "DeepSeek 官方 + 混合分组（混合分组同时属于多类）");
  await T(p, "cat-claude").click();
  assert.equal(await count(p, '[data-testid="group-card-alpha-34"]'), 1, "混合分组也在 Claude 里");
  await T(p, "cat-video").click();
  assert.equal(await cards(p), 1);
  assert.equal(await T(p, "noconfig-alpha-32").textContent(), "不可配置");
  assert.equal(await count(p, '[data-testid="enable-alpha-32"]'), 0, "视频分组没有启用按钮");
  await T(p, "cat-audio").click();
  assert.equal(await T(p, "noconfig-alpha-33").textContent(), "不可配置");
  await T(p, "cat-other").click();
  await T(p, "group-card-alpha-17").waitFor();
  assert.equal(await T(p, "clients-alpha-17").getAttribute("class").then((c) => /auto/.test(c)), true);
  await T(p, "clients-alpha-17").click();
  for (const c of ["claude", "openai", "gemini", "deepseek", "cn", "image", "video", "audio", "embed", "other"]) assert.equal(await count(p, `[data-testid="ec-${c}"]`), 1);
  await p.keyboard.press("Escape");
  assert.deepEqual(await opsLog(p), [], "什么都没改就不保存");
  await done(p);
});

test("添加上游后，上游默认不暂停（调度开启，直接参与调度）", async () => {
  const p = await open("sites2,admin,plaza");
  await T(p, "operator-alpha").click();
  await T(p, "down-addup-4").click({ force: true });
  await T(p, "au-submit").click();
  await T(p, "add-upstream-result").waitFor();
  assert.match((await opsLog(p)).at(-1), /^add-upstream:.*:false/, "paused = false");
  assert.match(await T(p, "add-upstream-result").textContent(), /已经启用，正在参与调度/);
  assert.equal(await count(p, '[data-testid="au-resume"]'), 0, "不需要再点“启用”");
  await done(p);
});

test("自定义类别：起名字 + 写模型名关键词，匹配的分组自动归进来；也可手动勾选；删除后分组不丢", async () => {
  const p = await open("sites1,media", undefined, { tab: "all" });
  await T(p, "group-card-alpha-32").waitFor();
  await T(p, "manage-categories").click();
  await T(p, "categories-dialog").waitFor();
  await T(p, "cc-add").click();
  await T(p, "cc-name-0").fill("视频生成");
  await T(p, "cc-keywords-0").fill("Seedance，veo");
  await T(p, "cc-save").click();
  await T(p, "categories-dialog").waitFor({ state: "detached" });
  assert.match((await opsLog(p)).at(-1), /^custom-categories:视频生成=seedance\|veo$/, "关键词小写去重");
  // 新 tab 出现，匹配到“Seedance 视频”分组（模型名含 seedance / veo）
  const tab = p.locator('[data-testid^="cat-c_"]').first();
  await tab.waitFor();
  assert.match(await tab.textContent(), /视频生成/);
  await tab.click();
  assert.deepEqual(await p.locator('[data-testid^="group-card-"]').evaluateAll((es) => es.map((e) => e.getAttribute("data-testid"))), ["group-card-alpha-32"]);
  // 手动再把“DeepSeek 官方”勾进这一类
  await T(p, "cat-all").click();
  await T(p, "clients-alpha-31").click();
  await p.locator('[data-testid="clients-picker"] label', { hasText: "视频生成" }).locator("input").click();
  await p.keyboard.press("Escape");
  await p.waitForFunction(() => /^clients:alpha:31:.*c_/.test((window.__adminOps ?? []).at(-1) ?? ""));
  await p.locator('[data-testid^="cat-c_"]').first().click();
  await p.waitForFunction(() => document.querySelectorAll('[data-testid^="group-card-"]').length === 2);
  // 名称重复 / 和内置同名：保存失败并提示
  await T(p, "manage-categories").click();
  await T(p, "cc-add").click();
  await T(p, "cc-name-1").fill("视频");
  await T(p, "cc-save").click();
  await p.waitForFunction(() => /已经有名为「视频」的类别/.test(document.querySelector('[data-testid="cc-error"]')?.textContent ?? ""));
  // 删除：分组还在，回到“全部”
  await T(p, "cc-remove-1").click();
  await T(p, "cc-remove-0").click();
  await T(p, "cc-save").click();
  await T(p, "categories-dialog").waitFor({ state: "detached" });
  assert.equal(await count(p, '[data-testid^="cat-c_"]'), 0);
  assert.equal(await count(p, '[data-testid="group-card-alpha-32"]'), 1, "分组没被删");
  await done(p);
});
