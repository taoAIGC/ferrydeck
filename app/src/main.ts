import { invoke } from "@tauri-apps/api/core";
import { octopusSpinner, octopusWorking } from "./octopus";
import { agoText, fullTime, startAgoTicker } from "./time";
import { initHover, syncHover } from "./hover";
import { backend, isMock } from "./backend";
import { CLIENTS, CLIENT_ORDER, KIND_LABEL, type ClientId, type ClientOverview, type DataLoss, type DetectedSite, type GroupUsage, type GroupView, type SiteView, type UpdateInfo } from "./types";

type Toast = { kind: "ok" | "err" | "info"; text: string } | null;

interface AddDialog {
  type: "add";
  step: "url" | "login";
  url: string;
  detected: DetectedSite | null;
  name: string;
  username: string;
  password: string;
  error: string;
  busy: boolean;
  /** 重新登录已有站点时不为空 */
  relogin: SiteView | null;
}
interface RemoveDialog {
  type: "remove";
  site: SiteView;
  busy: boolean;
}
/** 新添加的站点没有给分组分类：告诉用户这对使用体验有什么影响，点“确定”关闭 */
interface UnclassifiedNotice {
  type: "unclassified";
  siteName: string;
}
/** 再次测速时：有的分组已经有结果了，问用户是只测没结果的，还是全部重测 */
interface SpeedScopeDialog {
  type: "speed-scope";
  total: number;
  done: number;
  missing: number;
}
/** 第一次测速前的说明：会为分组创建专用 Key、会发请求 */
interface SpeedConfirmDialog {
  type: "speed-confirm";
  count: number;
}

/** 排序规则记住上次的选择：列（时延/倍率）+ 方向。 */
const SORT_KEY = "ferrydeck.sort";
const SORT_COL_KEY = "ferrydeck.sortCol";
function loadSort(): "default" | "asc" | "desc" {
  const v = localStorage.getItem(SORT_KEY);
  return v === "asc" || v === "desc" ? v : "default";
}
type SortCol = "speed" | "rate" | "cost" | "cache";
function loadSortCol(): SortCol {
  const v = localStorage.getItem(SORT_COL_KEY);
  return v === "speed" || v === "cost" || v === "cache" ? v : "rate";
}

/** 每个分组最近一次取到的“百万有效 Token 平均成本”（点开成本抽屉或点标题上的按钮时取到），记住，下次打开直接显示。 */
const COSTS_KEY = "ferrydeck.costs";
type CostEntry = { perM: number | null; currency: string; at: number; /** 真实首字时延（中位数，毫秒）和样本数 */ frt?: number | null; frtN?: number; /** 缓存命中率 0~1 */ cache?: number | null };
function loadCosts(): Record<string, CostEntry> {
  try {
    return JSON.parse(localStorage.getItem(COSTS_KEY) ?? "{}") as Record<string, CostEntry>;
  } catch {
    return {};
  }
}
function rememberCost(g: { site_id: string; id: string }, u: GroupUsage) {
  state.costs[gkey(g)] = { perM: u.cost_per_m_effective, currency: u.currency, at: u.fetched_at, frt: u.first_token_median_ms, frtN: u.first_token_samples, cache: u.cache_hit_rate };
  try {
    localStorage.setItem(COSTS_KEY, JSON.stringify(state.costs));
  } catch {
    /* 无法写入就只在本次运行里有效 */
  }
}

const state = {
  view: "boot" as "boot" | "main",
  sites: [] as SiteView[],
  groups: [] as GroupView[],
  overview: [] as ClientOverview[],
  selected: "claude" as ClientId,
  siteFilter: "all",
  sort: loadSort(),
  sortCol: loadSortCol(),
  costs: loadCosts(),
  /** 正在批量获取成本：已完成 / 总数 */
  costLoading: null as null | { done: number; total: number },
  busyGroup: null as string | null,
  models: {} as Record<string, string[]>,
  loading: false,
  loadError: null as string | null,
  toast: null as Toast,
  /** 右侧成本抽屉；`entered` 记录滑入动画是否已经播过（重绘不要重播） */
  drawer: null as null | { siteId: string; groupId: string; name: string; siteName: string; status: "loading" | "ready" | "error"; models?: string[]; data?: GroupUsage; error?: string; entered: boolean },
  dialog: null as AddDialog | RemoveDialog | SpeedConfirmDialog | SpeedScopeDialog | UnclassifiedNotice | null,
  /** 测速进度和“停止”标志 */
  testDone: 0,
  testTotal: 0,
  testCancel: false,
  lastGroupsRefresh: 0,
  lastModelsLoad: 0,
  /** 最近一次真正向站点拉取分组的时间（unix 秒，0 = 还没拉过）；顶栏显示它 */
  fetchedAt: 0,
  /** 手动刷新进行中 */
  refreshing: false,
  /** 数据目录被清理软件等清空：以前添加过哪些站点（没有则 null） */
  dataLoss: null as DataLoss | null,
  version: "",
  update: null as UpdateInfo | null,
  updating: false,
  checking: false,
  retrying: false,
  lastAccountRefresh: 0,
  /** 按模型筛选：空表示不筛选 */
  modelFilter: "",
  /** 各分组的真实可用模型（打开页面时按需拉取，key 同 state.models） */
  allModels: {} as Record<string, string[]>,
  /** 各分组的测速结果（毫秒） */
  speeds: {} as Record<string, { first: number; total: number; model: string; input?: number | null } | { error: string }>,
  testing: false,
  /** 正在测速的分组（时延列显示旋转的章鱼） */
  probing: new Set<string>(),
};

function saveSort(v: "default" | "asc" | "desc", col: SortCol | null = null) {
  state.sort = v;
  if (col) state.sortCol = col;
  try {
    localStorage.setItem(SORT_KEY, v);
    localStorage.setItem(SORT_COL_KEY, state.sortCol);
  } catch {
    /* 隐私模式等无法写入，忽略 */
  }
}

const root = document.getElementById("app")!;
let toastTimer: number | undefined;

// ---------- 小工具 ----------

type Child = Node | string | null | undefined | false;
function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, unknown> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") e.className = String(v);
    else if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (k === "value") (e as unknown as HTMLInputElement).value = String(v);
    else if (v === true) e.setAttribute(k, "");
    else e.setAttribute(k, String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) e.append(c);
  return e;
}

const isAuthError = (m: string) => m.includes("登录已过期") || m === "未登录";
const gkey = (g: { site_id: string; id: string }) => `${g.site_id}\u0001${g.id}`;
const ov = (c: ClientId) => state.overview.find((o) => o.client === c);
const multiSite = () => state.sites.length > 1;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function showToast(kind: "ok" | "err" | "info", text: string) {
  state.toast = { kind, text };
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    state.toast = null;
    render();
  }, kind === "err" ? 9000 : 5000);
  render();
}

/** 统一处理后端错误：登录过期时提示去重新登录并刷新站点状态，其余弹提示。 */
async function handleError(e: unknown, prefix = "", site?: { name: string }) {
  const msg = errText(e);
  if (isAuthError(msg)) {
    showToast("err", `${site ? `站点「${site.name}」` : "站点"}登录已过期，请在左侧点“重新登录”`);
    await refreshAll();
    return;
  }
  showToast("err", prefix + msg);
}

// ---------- 数据 ----------

function pickClient() {
  if (!state.groups.some((g) => g.clients.includes(state.selected))) {
    const first = CLIENT_ORDER.find((c) => state.groups.some((g) => g.clients.includes(c)));
    if (first) state.selected = first;
  }
  if (state.siteFilter !== "all" && !state.sites.some((s) => s.id === state.siteFilter)) state.siteFilter = "all";
}

/** 自动刷新（切回窗口、后台通知）：一分钟内拉过就直接用缓存，不再向站点发请求。 */
const AUTO_MAX_AGE_SECS = 60;

/**
 * 重新加载分组。`maxAgeSecs` 秒内拉过就用缓存；默认 0 = 一定向站点重新拉（手动刷新、登录、移除站点等明确的操作）。
 */
async function refreshAll(maxAgeSecs = 0, opts: { models?: boolean; forceCosts?: boolean } = {}) {
  state.lastGroupsRefresh = Date.now();
  // 没有站点就没有东西可加载，直接显示欢迎页
  state.loading = state.sites.length > 0;
  state.loadError = null;
  render();
  try {
    const [r, overview] = await Promise.all([backend.listGroups(maxAgeSecs), backend.overview()]);
    state.groups = r.groups;
    state.sites = r.sites;
    state.fetchedAt = r.fetched_at;
    state.overview = overview;
    pickClient();
  } catch (e) {
    state.loadError = errText(e);
  } finally {
    state.loading = false;
    render();
  }
  void loadActiveModels();
  if (opts.models !== false) void loadAllModels();
  void loadAllCosts(opts.forceCosts ?? false);
}

/** 数据被误删后：按记录恢复站点列表，每个站点都要重新登录（凭据已经没了）。 */
async function restoreSites() {
  const n = state.dataLoss?.sites.length ?? 0;
  try {
    await backend.restoreSites();
    state.sites = await backend.loadSites();
    state.dataLoss = null;
    await refreshAll();
    showToast("ok", `已恢复 ${n} 个站点，请在左侧逐个点“重新登录”`);
  } catch (e) {
    showToast("err", `恢复失败：${errText(e)}`);
  }
}

/** 数据被误删后：用户选择不恢复，清掉记录，不再提示。 */
async function dismissLoss() {
  try {
    await backend.dismissDataLoss();
  } catch {
    /* 清不掉也不影响使用 */
  }
  state.dataLoss = null;
  render();
}

/** 手动刷新：用户点了顶栏的刷新按钮。无视缓存，重新向各站点拉取分组、余额，并重拉模型。 */
async function manualRefresh() {
  if (state.refreshing || state.loading) return;
  state.refreshing = true;
  render();
  try {
    state.lastModelsLoad = 0; // 手动刷新也重新拉模型
    try {
      state.sites = await backend.refreshAccounts();
    } catch {
      /* 余额拉不到不影响分组 */
    }
    state.lastAccountRefresh = Date.now();
    await refreshAll(0, { forceCosts: true });
  } finally {
    state.refreshing = false;
    render();
  }
}

/** 为各分组拉取真实可用模型（只用已经建过的 Key），供“按模型筛选”使用。 */
async function loadAllModels() {
  if (state.sites.length === 0) return;
  // 模型列表变化很慢：10 分钟内不重复拉取（加/删站点会清零，立刻重拉）
  if (Date.now() - state.lastModelsLoad < 10 * 60_000) return;
  state.lastModelsLoad = Date.now();
  try {
    const map = await backend.groupModelsMap();
    state.allModels = { ...state.allModels, ...map };
    render();
  } catch {
    /* 拿不到就只用分组自带的信息 */
  }
}

async function refreshOverview() {
  try {
    state.overview = await backend.overview();
  } catch (e) {
    await handleError(e);
  }
}

/** 给“使用中”的卡片按需加载模型列表。 */
async function loadActiveModels() {
  for (const o of state.overview) {
    const a = o.active;
    if (!o.in_use || !a) continue;
    const k = gkey({ site_id: a.site_id, id: a.group_id });
    if (state.models[k]) continue;
    try {
      state.models[k] = await backend.groupModels(a.site_id, a.group_id);
      render();
    } catch {
      /* 模型列表加载失败不影响使用，下拉框保持只显示当前模型 */
    }
  }
}

async function enable(g: GroupView, model?: string | null) {
  const client = state.selected;
  if (state.busyGroup !== null || !g.clients.includes(client)) return;
  state.busyGroup = gkey(g);
  render();
  try {
    const out = await backend.enableGroup(g.site_id, g.id, client, model ?? null);
    state.models[gkey(g)] = out.models;
    await refreshOverview();
    const c = CLIENTS[out.client];
    if (model) showToast("ok", `已切换模型为 ${out.model}`);
    else showToast("ok", `已把「${g.name}」${multiSite() ? `（${g.site_name}）` : ""}配置到 ${c.name}${out.key_created ? "，并为该分组创建了专用 Key" : ""}。${c.restartHint}。`);
  } catch (e) {
    await handleError(e, "配置失败：", { name: g.site_name });
  } finally {
    state.busyGroup = null;
    render();
  }
}

async function topup(site: SiteView) {
  try {
    await backend.openUrl(await backend.topupUrl(site.id));
  } catch (e) {
    showToast("err", `无法打开充值页：${errText(e)}`);
  }
}

/** 窗口重新获得焦点时刷新余额（用户可能刚在浏览器里充完值）。 */
async function refreshBalances() {
  if (state.view !== "main" || state.sites.length === 0 || Date.now() - state.lastAccountRefresh < 30_000) return;
  state.lastAccountRefresh = Date.now();
  try {
    const before = state.sites.filter((s) => s.connected).length;
    state.sites = await backend.refreshAccounts();
    // 之前没连上的站点这次连上了：把它的分组也加载出来
    if (state.sites.filter((s) => s.connected).length !== before) return void (await refreshAll());
    render();
  } catch {
    /* 静默 */
  }
}

/** 手动重试网络等原因暂时没连上的站点。 */
async function retrySites() {
  state.retrying = true;
  render();
  try {
    state.lastAccountRefresh = Date.now();
    state.sites = await backend.refreshAccounts();
    const failed = state.sites.find((s) => !s.connected && !s.needs_login);
    if (failed) showToast("err", `站点「${failed.name}」仍然连不上：${failed.error ?? "请检查网络"}`);
  } catch (e) {
    await handleError(e);
  } finally {
    state.retrying = false;
  }
  await refreshAll();
}

// ---------- 站点对话框 ----------

function openAdd(relogin: SiteView | null = null) {
  state.dialog = {
    type: "add",
    step: relogin ? "login" : "url",
    url: "",
    detected: relogin ? { base_url: relogin.base_url, kind: relogin.kind, name: relogin.name } : null,
    name: relogin?.name ?? "",
    username: "",
    password: "",
    error: "",
    busy: false,
    relogin,
  };
  render();
  document.getElementById(relogin ? "add-username" : "add-url")?.focus();
}

async function submitUrl() {
  const d = state.dialog;
  if (!d || d.type !== "add" || d.busy) return;
  if (!d.url.trim()) {
    d.error = "请输入站点地址";
    return render();
  }
  d.busy = true;
  d.error = "";
  render();
  try {
    d.detected = await backend.detectSite(d.url);
    d.name = d.detected.name;
    d.step = "login";
  } catch (e) {
    d.error = errText(e);
  } finally {
    d.busy = false;
    render();
    document.getElementById(d.step === "login" ? "add-username" : "add-url")?.focus();
  }
}

async function submitLogin() {
  const d = state.dialog;
  if (!d || d.type !== "add" || d.busy || !d.detected) return;
  if (!d.username.trim() || !d.password) {
    d.error = "请输入账号和密码";
    return render();
  }
  d.busy = true;
  d.error = "";
  render();
  try {
    const site = await backend.addSite({ baseUrl: d.detected.base_url, name: d.relogin ? undefined : d.name, username: d.username.trim(), password: d.password });
    const existed = state.sites.some((s) => s.id === site.id);
    state.sites = existed ? state.sites.map((s) => (s.id === site.id ? site : s)) : [...state.sites, site];
    state.dialog = null;
    state.models = {};
    state.lastModelsLoad = 0;
    if (existed) {
      await refreshAll();
      showToast("ok", `站点「${site.name}」已重新登录`);
    } else {
      // 新增站点：用提示条把进度说出来，用户不用对着空白等
      showToast("info", "开始刷新分组…");
      await refreshAll(0, { models: false });
      const first = CLIENT_ORDER.find((c) => state.groups.some((g) => g.site_id === site.id && g.clients.includes(c)));
      if (first) state.selected = first;
      render();
      showToast("info", "开始刷新模型列表…");
      await loadAllModels();
      state.loadError
        ? showToast("err", `已添加站点「${site.name}」，但刷新分组失败：${state.loadError}`)
        : showToast("ok", `已添加站点「${site.name}」，分组和模型已刷新`);
    }
    // 新加的站点没有给分组分类（new-api 没有“平台”字段）：弹窗说明对使用体验的影响
    if (!existed && (site.kind === "newapi" || state.groups.some((g) => g.site_id === site.id && g.clients_inferred))) {
      state.dialog = { type: "unclassified", siteName: site.name };
      render();
    }
  } catch (e) {
    d.password = "";
    d.error = errText(e);
    d.busy = false;
    render();
    document.getElementById("add-password")?.focus();
  }
}

async function confirmRemove() {
  const d = state.dialog;
  if (!d || d.type !== "remove" || d.busy) return;
  d.busy = true;
  render();
  try {
    await backend.removeSite(d.site.id);
    const name = d.site.name;
    state.dialog = null;
    state.models = {};
    state.lastModelsLoad = 0;
    await refreshAll();
    showToast("ok", `已移除站点「${name}」`);
  } catch (e) {
    state.dialog = null;
    showToast("err", `移除失败：${errText(e)}`);
  }
}

// ---------- 更新 ----------

/** 检查更新。静默模式（启动时）失败不打扰用户；手动检查会给出结果提示。 */
async function checkForUpdate(silent: boolean) {
  if (state.checking || state.updating) return;
  state.checking = true;
  render();
  try {
    state.update = await backend.checkUpdate();
    if (!silent) showToast(state.update ? "info" : "ok", state.update ? `发现新版本 ${state.update.version}` : "已经是最新版本");
  } catch (e) {
    if (!silent) showToast("err", `检查更新失败：${errText(e)}`);
  } finally {
    state.checking = false;
    render();
  }
}

async function installUpdate() {
  if (state.updating) return;
  state.updating = true;
  render();
  try {
    await backend.installUpdate(); // 成功后应用会自动重启
  } catch (e) {
    showToast("err", errText(e));
  } finally {
    state.updating = false;
    render();
  }
}

// ---------- 视图 ----------

function powerIcon(): Node {
  const t = document.createElement("template");
  t.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v8"/><path d="M6.4 6.8a8 8 0 1 0 11.2 0"/></svg>';
  return t.content.firstChild!;
}

const GITHUB_URL = "https://github.com/taoAIGC/ferrydeck";

/** 顶栏与系统标题栏合并：和红绿灯同一高度，左边是图标和名称，右边是「GitHub 主页」「检查更新」，整条可拖动窗口。 */
function viewHeader(): HTMLElement {
  return el(
    "header",
    { class: "topbar", "data-tauri-drag-region": true },
    // 红绿灯按钮右侧：应用图标 + 名称（标题栏是 Overlay 样式，系统不再显示窗口标题），再右边是刷新按钮和最近拉取时间
    el(
      "div",
      { class: "topbar-left", "data-tauri-drag-region": true },
      el(
        "div",
        { class: "brand-wrap", "data-testid": "brand", "data-tauri-drag-region": true },
        el("img", { class: "brand-mark", src: "/icon-64.png", alt: "", "data-tauri-drag-region": true }),
        el("span", { class: "brand-name", "data-tauri-drag-region": true }, "Ferrydeck"),
      ),
      state.sites.length > 0 &&
        el(
          "div",
          { class: "refresh-wrap", "data-tauri-drag-region": true },
          el(
            "button",
            {
              class: `icon-btn refresh-btn${state.refreshing ? " spinning" : ""}`,
              "data-tip": REFRESH_TIP,
              "aria-label": "刷新",
              "data-testid": "refresh",
              disabled: state.refreshing || state.loading,
              onClick: () => void manualRefresh(),
            },
            refreshIcon(),
          ),
          el("span", { class: "refresh-time", "data-testid": "refresh-time", "data-tip": fetchedTitle(), "data-tip-tpl": fetchedTitleTpl(), "data-ago": state.refreshing ? "" : state.fetchedAt > 0 ? String(state.fetchedAt) : "", "data-tauri-drag-region": true }, state.refreshing ? "刷新中…" : agoText(state.fetchedAt)),
          el(
          "button",
          {
            class: `icon-btn${state.testing ? " testing" : ""}`,
            "data-tip": state.testing ? "点击停止测速" : "测速：逐个分组各发一条 “hi”，看首字延迟，同时拉取真实可用模型",
            "aria-label": state.testing ? "停止测速" : "测速",
            "data-testid": "speed-test",
            onClick: onSpeedButton,
          },
          state.testing ? el("span", { class: "small muted" }, state.testCancel ? "停止中…" : `${state.testDone}/${state.testTotal} 停止`) : gaugeIcon(),
        )
        ),
    ),
    el(
      "div",
      { class: "account" },
      el("button", { class: "link", "data-testid": "github-link", onClick: () => void openUrl(GITHUB_URL) }, "GitHub 主页"),
      el("button", { class: "link", "data-testid": "check-update", disabled: state.checking || state.updating, onClick: () => void checkForUpdate(false) }, state.checking ? "检查中…" : "检查更新"),
    ),
  );
}

/** 鼠标停在刷新按钮上时的说明：写明手动刷新到底会向站点要什么、不会做什么。 */
const REFRESH_TIP = [
  "手动刷新：重新向每个站点获取最新信息",
  "• 账号名称和余额（登录过期的会先尝试续期）",
  "• 分组列表：名称、说明、倍率、可用于哪些客户端",
  "• 各分组的可用模型（站点有“模型广场”就直接读取；没有的，只读取已建过专用 Key 的分组）",
  "不会创建 Key，也不会测速。",
  "切回窗口时的自动刷新，一分钟内拉过就不再重复请求。",
].join("\n");

function refreshIcon(): Node {
  const t = document.createElement("template");
  t.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 4v5h-5"/></svg>';
  return t.content.firstChild!;
}

/** 鼠标悬停提示：完整时间 + 多久之前 + 提示点按钮手动刷新 */
function fetchedTitleTpl(): string {
  if (state.fetchedAt <= 0) return "";
  return `最近一次向站点拉取分组：${fullTime(state.fetchedAt)}（{ago}）\n点击左侧按钮手动刷新`;
}

function fetchedTitle(): string {
  if (state.fetchedAt <= 0) return "还没有拉取过分组";
  return fetchedTitleTpl().replace("{ago}", agoText(state.fetchedAt));
}

async function openUrl(url: string) {
  try {
    await backend.openUrl(url);
  } catch (e) {
    showToast("err", `无法打开链接：${errText(e)}`);
  }
}

function briefcaseIcon(): Node {
  const t = document.createElement("template");
  t.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="7" width="18" height="13" rx="2.5"/><path d="M8.5 7V5.5A1.5 1.5 0 0 1 10 4h4a1.5 1.5 0 0 1 1.5 1.5V7"/><path d="M3 12.5h18"/></svg>';
  return t.content.firstChild!;
}

function trashIcon(): Node {
  const t = document.createElement("template");
  t.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16"/><path d="M9 7V5h6v2"/><path d="M6 7l1 13h10l1-13"/><path d="M10 11v5M14 11v5"/></svg>';
  return t.content.firstChild!;
}

function gaugeIcon(): Node {
  const t = document.createElement("template");
  t.innerHTML = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 18a9 9 0 1 1 15 0"/><path d="M12 14l3.5-4.5"/><circle cx="12" cy="14" r="1.6"/></svg>';
  return t.content.firstChild!;
}

/** 站点卡：点站名在浏览器里打开站点；充值/移除是图标按钮，无背景色。 */
function viewSiteCard(s: SiteView): HTMLElement {
  return el(
    "div",
    { class: `site-card${s.connected ? "" : " bad"}`, "data-testid": `site-${s.id}` },
    el(
      "div",
      { class: "site-top" },
      el("button", { class: "site-name", title: `在浏览器中打开 ${s.base_url}`, "data-testid": `site-name-${s.id}`, onClick: () => void openUrl(s.base_url) }, s.name),
      el(
        "div",
        { class: "site-icons" },
        el("button", { class: "icon-btn", title: "去充值", "aria-label": "去充值", "data-testid": `topup-${s.id}`, onClick: () => void topup(s) }, briefcaseIcon()),
        el("button", { class: "icon-btn danger", title: "移除站点", "aria-label": "移除", "data-testid": `remove-${s.id}`, onClick: () => { state.dialog = { type: "remove", site: s, busy: false }; render(); } }, trashIcon()),
      ),
    ),
    s.connected
      ? el(
          "div",
          { class: "site-sub" },
          el("span", { class: "muted small", "data-testid": `site-account-${s.id}` }, s.account?.display ?? ""),
          el("span", { class: "balance", "data-testid": `site-balance-${s.id}` }, s.account?.balance ?? ""),
        )
      : el("div", { class: "site-err", "data-testid": `site-error-${s.id}` }, s.error ?? (s.needs_login ? "需要重新登录" : "正在连接…")),
    !s.connected &&
      el(
        "div",
        { class: "site-actions" },
        !s.needs_login && el("button", { class: "primary small-btn", "data-testid": `retry-${s.id}`, disabled: state.retrying, onClick: () => void retrySites() }, state.retrying ? "重试中…" : "重试"),
        el("button", { class: `${s.needs_login ? "primary" : "ghost"} small-btn`, "data-testid": `relogin-${s.id}`, onClick: () => openAdd(s) }, "重新登录"),
      ),
  );
}

function viewSidebar(): HTMLElement {
  const clients = CLIENT_ORDER.map((c) => {
    const o = ov(c);
    const count = state.groups.filter((g) => g.clients.includes(c)).length;
    const a = o?.in_use ? o.active : null;
    return el(
      "button",
      { class: `side-item${state.selected === c ? " selected" : ""}`, "data-testid": `client-${c}`, onClick: () => { state.selected = c; state.modelFilter = ""; render(true); } },
      el(
        "span",
        { class: "side-text" },
        el("span", { class: "side-name" }, CLIENTS[c].name, o && o.conflicts.length > 0 ? el("span", { class: "warn-mark", title: "存在可能覆盖配置的设置" }, " ⚠") : null),
        el("span", { class: "side-sub", "data-testid": `client-status-${c}` }, a ? (multiSite() ? `${a.site_name} · ${a.group_name}` : a.group_name) : state.loading && state.groups.length === 0 ? "加载中…" : count === 0 ? "暂无可用分组" : ""),
      ),
    );
  });
  return el(
    "nav",
    { class: "sidebar" },
    ...clients,
    el("div", { class: "side-title sites-title" }, "站点"),
    ...state.sites.map(viewSiteCard),
    el("button", { class: "add-site", "data-testid": "add-site", title: "添加站点", "aria-label": "添加站点", onClick: () => openAdd() }, "＋"),
  );
}

/** 某个分组已知的模型：站点自带的优先，其次是按需拉取的。 */
function modelsOf(g: GroupView): string[] {
  return state.allModels[gkey(g)] ?? state.models[gkey(g)] ?? g.models ?? [];
}

/**
 * 把测速失败的原因归成一个短标签放在时延列里，原文放在鼠标悬停提示里。
 * 失败几乎都是站点那边的问题（分组没绑账号、上游账号没余额或被拒绝），光写“测速失败”看不出该找谁。
 */
function failLabel(msg: string): string {
  const m = msg.toLowerCase();
  if (msg.startsWith("已跳过")) return "已跳过";
  if (msg.includes("站点限流")) return "限流";
  if (/创建 Key|不再重复创建/.test(msg)) return "Key 异常";
  if (/insufficient|balance|quota|余额|额度/.test(m)) return "余额不足";
  if (/no available|temporarily unavailable|没有可用|无可用/.test(m)) return "无可用账号";
  if (/可用渠道不存在|model.*(not found|not support|unavailable)|不支持.*模型|没有模型/.test(m)) return "模型不可用";
  if (/forbidden|拒绝/.test(m)) return "上游拒绝";
  if (/超时|timeout/.test(m)) return "超时";
  if (msg.includes("无法连接")) return "连不上";
  return "失败";
}

const SPEED_CONFIRMED_KEY = "ferrydeck.speedConfirmed";
/** 两次测速请求之间的间隔：逐个分组来，别把站点打出 429。模拟后端里缩短，免得测试等太久。 */
const PROBE_GAP_MS = isMock ? 120 : 1000;
const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 这个分组是否已经“有结果”：测出了时延，或者站点明确回答了失败（余额不足、没有可用账号、上游拒绝、模型不可用）。
 * 没测过、被跳过、被限流、超时、连不上这些“没得到站点回答”的，不算有结果。
 */
function hasResult(g: GroupView): boolean {
  const sp = state.speeds[gkey(g)];
  if (!sp) return false;
  if (!("error" in sp)) return true;
  return ["余额不足", "无可用账号", "上游拒绝", "模型不可用"].includes(failLabel(sp.error));
}

/** 测速按钮：测速中再点一次就是“停止”；第一次用之前先说明会做什么；再次测速时问范围。 */
function onSpeedButton() {
  if (state.testing) {
    state.testCancel = true;
    render();
    return;
  }
  const list = speedTargets();
  if (list.length === 0) return;
  if (localStorage.getItem(SPEED_CONFIRMED_KEY) !== "1") {
    state.dialog = { type: "speed-confirm", count: list.length };
    render();
    return;
  }
  startSpeed();
}

/** 决定测哪些：全新的直接测；已经有一部分结果时，让用户选“只测没结果的（默认）”还是“全部重测”，减轻站点压力。 */
function startSpeed() {
  const list = speedTargets();
  if (list.length === 0) return;
  const missing = list.filter((g) => !hasResult(g)).length;
  const done = list.length - missing;
  if (done === 0) {
    void runSpeedTest(list);
    return;
  }
  state.dialog = { type: "speed-scope", total: list.length, done, missing };
  render();
}

/** 当前客户端、当前站点筛选下列出的分组。 */
function speedTargets(): GroupView[] {
  const c = state.selected;
  return state.groups.filter((g) => g.clients.includes(c) && (state.siteFilter === "all" || g.site_id === state.siteFilter));
}

/**
 * 测速：对当前列出的分组**逐个**发一条最小的 "hi"（每个分组只测一个模型、只测一次），
 * 记录首字延迟，并并入真实可用模型。分组之间留出间隔，随时可以点按钮停止。
 */
async function runSpeedTest(list: GroupView[]) {
  if (state.testing) return;
  const c = state.selected;
  if (list.length === 0) return;
  state.testing = true;
  state.testCancel = false;
  state.testDone = 0;
  state.testTotal = list.length;
  for (const g of list) delete state.speeds[gkey(g)]; // 清掉旧结果，轮到谁谁才显示章鱼
  const limited = new Map<string, string>(); // 被限流的站点 → 提示
  render();
  try {
    for (let i = 0; i < list.length && !state.testCancel; i++) {
      const g = list[i];
      const k = gkey(g);
      // 这个站点刚刚限流了：它剩下的分组直接跳过，继续敲只会越限越久
      if (limited.has(g.site_id)) {
        state.speeds[k] = { error: `已跳过：${limited.get(g.site_id)}` };
        state.testDone = i + 1;
        continue;
      }
      state.probing.add(k);
      render();
      try {
        const r = await backend.probeGroup(g.site_id, g.id, null, c);
        state.speeds[k] = { first: r.first_ms, total: r.total_ms, model: r.model, input: r.input_tokens ?? null };
        if (r.models.length > 0) state.allModels[k] = r.models;
      } catch (e) {
        const msg = errText(e);
        state.speeds[k] = { error: msg };
        // 站点限流、或者这个站点的 Key 创建/读取出了问题：继续对它的其他分组测只会不断创建没用的 Key 或加重限流
        if (msg.includes("站点限流") || /创建 Key|不再重复创建/.test(msg)) limited.set(g.site_id, msg);
      } finally {
        state.probing.delete(k);
        state.testDone = i + 1;
      }
      render();
      if (i < list.length - 1 && !state.testCancel) await sleepMs(PROBE_GAP_MS + Math.random() * 400); // 加一点随机，别像机器一样整点打
    }
  } finally {
    state.testing = false;
    state.testCancel = false;
    state.probing.clear();
    render();
    if (limited.size > 0) {
      const names = [...limited.keys()].map((id) => state.sites.find((s) => s.id === id)?.name ?? id).join("、");
      const first = [...limited.values()][0];
      showToast("err", first.includes("站点限流") ? `${names} 限流了，已停止对它的测速。${first}` : `${names} 的 Key 创建或读取出现异常，已停止对它的测速：${first}。诊断日志里有详细情况（~/.ferrydeck/logs/ferrydeck.log）。`);
    } else {
      // 汇总失败原因，让用户一眼看出是站点那边的问题，而不是 Ferrydeck 坏了
      const counts = new Map<string, number>();
      for (const g of list) {
        const sp = state.speeds[gkey(g)];
        if (sp && "error" in sp) counts.set(failLabel(sp.error), (counts.get(failLabel(sp.error)) ?? 0) + 1);
      }
      const failed = [...counts.values()].reduce((a, b) => a + b, 0);
      if (failed > 0 && !state.testCancel) {
        const detail = [...counts].map(([k, n]) => `${k} ${n}`).join("、");
        showToast("err", `${failed}/${list.length} 个分组测速失败（${detail}）。这是站点上游的问题（没绑账号、账号没余额或被拒绝），鼠标悬停在结果上可看站点的原话，可联系站点管理员。`);
      }
    }
  }
}

function groupCard(g: GroupView, o: ClientOverview | undefined): HTMLElement {
  const k = gkey(g);
  const a = o?.in_use ? o.active : null;
  const isActive = !!a && a.site_id === g.site_id && a.group_id === g.id;
  const busy = state.busyGroup === k;
  const models = state.models[k] ?? [];
  const current = a?.model ?? null;
  const tid = `${g.site_id}-${g.id}`;
  const sp = state.speeds[k];
  // 操作列：使用中只显示文案，否则是启用按钮
  const control = isActive
    ? el("span", { class: "badge" }, "使用中")
    : el("button", { class: `enable-btn${busy ? " busy" : ""}`, "aria-label": "启用", title: "启用", "data-testid": `enable-${tid}`, disabled: state.busyGroup !== null, onClick: () => void enable(g) }, ...(busy ? [octopusWorking(), "配置中…"] : [powerIcon()]));
  // 站点用量记录里的真实首字时延（中位数）比本地测速更准，有就用它，没有才显示本地测速的结果
  const real = state.costs[k];
  const realFrt = real?.frt ?? null;
  const speedText = realFrt !== null ? `${(realFrt / 1000).toFixed(2)}s` : !sp ? null : "error" in sp ? failLabel(sp.error) : `${(sp.first / 1000).toFixed(2)}s`;
  // 模型列（第 6 项）：使用中的分组可直接切换模型；其他分组下拉查看该分组的模型
  const modelList = isActive && models.length > 0 ? models : modelsOf(g);
  const modelCell = isActive
    ? el(
        "select",
        {
          class: "row-models",
          "data-testid": `model-select-${tid}`,
          disabled: state.busyGroup !== null,
          title: "切换模型",
          onChange: (e: Event) => { const t = e.target as HTMLSelectElement; t.blur(); void enable(g, t.value); },
        },
        ...(modelList.length > 0 ? modelList : current ? [current] : []).map((m) => el("option", { value: m, selected: m === current }, m)),
      )
    : modelList.length
      ? el("button", { class: "model-count", "data-testid": `row-models-${tid}`, "data-tip": "点击查看该分组的模型列表", onClick: () => openModels(g, modelList) }, `${modelList.length} 个模型`)
      : el("span", { class: "muted small", "data-testid": `row-models-${tid}`, title: "测速后可看到该分组的模型" }, "—");
  return el(
    "div",
    { class: `card${isActive ? " active" : ""}`, "data-testid": `group-card-${tid}` },
    el(
      "div",
      { class: "card-main" },
      el("h3", {}, g.name, multiSite() ? el("span", { class: "site-tag", "data-testid": `site-tag-${tid}` }, g.site_name) : null),
      g.clients_inferred && el("span", { class: "unclassified", "data-testid": `unclassified-${tid}` }, "该站点未对分组分类"),
      el("p", { class: "desc" }, g.description ?? ""),
    ),
    el("div", { class: "cell-speed" }, state.probing.has(k) ? octopusSpinner(tid) : speedText ? el("span", { class: `speed${realFrt === null && "error" in sp! ? " bad" : ""}`, "data-tip": realFrt !== null ? `真实首字时延（近 7 天 ${real!.frtN} 个请求的中位数，来自站点的使用记录）` : "error" in sp! ? `测速失败：${sp!.error}` : `本地测速的首字延迟（模型 ${sp!.model}）${sp!.input != null ? `；发一句“hi”站点计 ${sp!.input} 个输入 Token` : ""}`, "data-testid": `speed-${tid}` }, speedText) : el("span", { class: "muted small" }, "—")),
    el("div", { class: "cell-rate" }, el("span", { class: "rate", title: "计费倍率" }, `×${g.rate_multiplier}`)),
    el("div", { class: "cell-cost" }, costCell(g, tid)),
    el("div", { class: "cell-cache" }, cacheCell(g, tid)),
    el("div", { class: "cell-models" }, modelCell),
    el("div", { class: "card-action" }, control),
  );
}

function costCell(g: GroupView, tid: string): HTMLElement {
  const c = state.costs[gkey(g)];
  if (!c) return el("span", { class: "muted small", "data-tip": "还没读取过成本：点分组行右侧的硬币图标，或标题上的硬币按钮", "data-testid": `cost-val-${tid}` }, "—");
  const when = `取数于 ${fullTime(c.at)}`;
  if (c.perM === null) return el("span", { class: "muted small", "data-tip": `近 7 天没有用量；${when}`, "data-testid": `cost-val-${tid}` }, "无用量");
  return el("span", { class: "rate", "data-tip": `每百万有效 Token 的平均成本；${when}`, "data-testid": `cost-val-${tid}`, onClick: () => void openCost(g) }, money(c.currency, c.perM));
}

function cacheCell(g: GroupView, tid: string): HTMLElement {
  const c = state.costs[gkey(g)];
  const r = c?.cache ?? null;
  if (r === null) return el("span", { class: "muted small", "data-tip": c ? "近 7 天没有可统计的输入" : "还没读取过：点刷新按钮会一并读取", "data-testid": `cache-val-${tid}` }, "—");
  return el("span", { class: "cache-rate", "data-tip": `缓存命中率：缓存读取 ÷（输入 + 缓存创建 + 缓存读取）；取数于 ${fullTime(c!.at)}`, "data-testid": `cache-val-${tid}` }, pct(r));
}

const COST_FRESH_MS = 10 * 60_000;

/**
 * 逐个读取分组的成本（串行、间隔 250 毫秒；站点限流就停下，已读到的保留）。
 * - `scope: "listed"`：用户点标题行的硬币按钮，只读当前列出的分组，忽略“刚读过”的判断；
 * - `scope: "all"`：随“刷新分组”一起读所有站点的所有分组。手动刷新（`force`）全部重读；自动刷新只读 10 分钟内没读过的，
 *   这样切回窗口、打开面板触发的自动刷新不会反复敲站点。
 */
async function readCosts(scope: "listed" | "all", force: boolean, quiet: boolean) {
  if (state.costLoading) return;
  const pool = scope === "listed" ? speedTargets() : state.groups;
  const seen = new Set<string>();
  const list = pool.filter((g) => {
    const k = gkey(g);
    if (seen.has(k)) return false;
    seen.add(k);
    return force || scope === "listed" || !state.costs[k] || Date.now() / 1000 - state.costs[k].at > COST_FRESH_MS / 1000;
  });
  if (list.length === 0) return;
  state.costLoading = { done: 0, total: list.length };
  render();
  let failed = "";
  const limited = new Set<string>();
  try {
    for (const g of list) {
      if (!limited.has(g.site_id)) {
        try {
          rememberCost(g, await backend.groupUsage(g.site_id, g.id, force));
        } catch (e) {
          failed = e instanceof Error ? e.message : String(e);
          if (failed.includes("站点限流")) limited.add(g.site_id); // 这个站点剩下的分组不再请求
        }
      }
      state.costLoading = { ...state.costLoading, done: state.costLoading.done + 1 };
      render();
      await new Promise((r) => setTimeout(r, 250));
    }
  } finally {
    state.costLoading = null;
    render();
  }
  if (failed && !quiet) showToast("err", `部分分组的成本没有读到：${failed}`);
}

/** 随刷新一起读成本：手动刷新全部重读并提示失败；自动刷新静默，只补过期的。 */
const loadAllCosts = (force: boolean) => (state.sites.length > 0 ? readCosts("all", force, !force) : Promise.resolve());

// ---------- 成本抽屉 ----------

async function openCost(g: GroupView, force = false) {
  const d = { siteId: g.site_id, groupId: g.id, name: g.name, siteName: g.site_name, status: "loading" as const, entered: state.drawer?.entered ?? false };
  state.drawer = d;
  render();
  try {
    const data = await backend.groupUsage(g.site_id, g.id, force);
    if (state.drawer !== d) return; // 用户已经关掉或换了别的分组
    rememberCost(g, data);
    state.drawer = { ...d, status: "ready", data };
  } catch (e) {
    if (state.drawer !== d) return;
    state.drawer = { ...d, status: "error", error: e instanceof Error ? e.message : String(e) };
  }
  render();
}

/** 右侧抽屉里展示该分组的模型列表。 */
function openModels(g: GroupView, models: string[]) {
  state.drawer = { siteId: g.site_id, groupId: g.id, name: g.name, siteName: g.site_name, status: "ready", models, entered: state.drawer?.entered ?? false };
  render();
}

function closeDrawer() {
  state.drawer = null;
  render();
}

const fmtInt = (n: number) => n.toLocaleString("en-US");
const fmtTok = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n));
const money = (cur: string, v: number | null | undefined, digits = 2) => (v === null || v === undefined ? "—" : `${cur}${v.toFixed(v !== 0 && Math.abs(v) < 0.01 ? 4 : digits)}`);
const pct = (v: number | null) => (v === null ? "—" : `${(v * 100).toFixed(1)}%`);
const secs = (ms: number | null) => (ms === null ? "—" : `${(ms / 1000).toFixed(2)}s`);

function viewDrawer(): HTMLElement | null {
  const d = state.drawer;
  if (!d) return null;
  const animate = !d.entered;
  d.entered = true;
  const stat = (label: string, value: string, tip?: string, id?: string) =>
    el("div", { class: "stat", ...(tip ? { "data-tip": tip } : {}) }, el("span", { class: "stat-label" }, label), el("span", { class: "stat-value", ...(id ? { "data-testid": id } : {}) }, value));
  let body: HTMLElement;
  if (d.models) {
    body = el("div", { class: "drawer-body", "data-testid": "drawer-models" }, el("p", { class: "muted small" }, `共 ${d.models.length} 个模型`), el("ul", { class: "model-list" }, ...d.models.map((m) => el("li", {}, m))));
  } else if (d.status === "loading") {
    body = el("div", { class: "drawer-state muted", "data-testid": "drawer-loading" }, octopusSpinner("drawer"), "正在读取近 7 天的用量…");
  } else if (d.status === "error") {
    body = el("div", { class: "drawer-state", "data-testid": "drawer-error" }, el("p", { class: "error" }, `读取失败：${d.error}`), el("button", { onClick: () => void openCost({ site_id: d.siteId, id: d.groupId, name: d.name, site_name: d.siteName } as GroupView, true) }, "重试"));
  } else {
    const u = d.data!;
    const c = u.currency;
    if (u.requests === 0 && u.effective_tokens === 0) {
      body = el("div", { class: "drawer-state muted", "data-testid": "drawer-empty" }, `近 ${u.window_days} 天没有使用过这个分组，暂无成本数据。`);
    } else {
      body = el(
        "div",
        { class: "drawer-body" },
        el("div", { class: "hero" }, el("span", { class: "hero-value", "data-testid": "cost-per-m" }, money(c, u.cost_per_m_effective)), el("span", { class: "hero-label" }, "每百万有效 Token 的实付成本"), el("span", { class: "hero-sub" }, "有效 Token = 输入 + 输出；缓存单独列出，不计入")),
        el(
          "div",
          { class: "stats" },
          stat("实付总额", money(c, u.cost), "近 7 天在这个分组上实际扣的钱", "cost-total"),
          stat("请求数", fmtInt(u.total_requests)),
          stat("有效 Token", `${fmtTok(u.effective_tokens)}（入 ${fmtTok(u.input_tokens)} / 出 ${fmtTok(u.output_tokens)}）`),
          stat("缓存", `创建 ${fmtTok(u.cache_creation_tokens)} / 读取 ${fmtTok(u.cache_read_tokens)}`, "缓存 Token 单独统计，不计入有效 Token"),
          stat("缓存命中率", pct(u.cache_hit_rate), "缓存读取 ÷（输入 + 缓存创建 + 缓存读取）", "cache-rate"),
          stat("实际倍率", u.actual_multiplier === null ? "—" : `×${u.actual_multiplier.toFixed(2)}（标称 ×${u.nominal_multiplier}）`, "实付 ÷ 官方价；越低越划算"),
          stat("真实首字时延", u.first_token_median_ms === null ? "—" : `中位 ${secs(u.first_token_median_ms)} · P90 ${secs(u.first_token_p90_ms)}`, `来自最近 ${u.first_token_samples} 个流式请求的记录`, "real-frt"),
          stat("平均耗时", secs(u.avg_duration_ms)),
          (() => {
            const sp = state.speeds[gkey({ site_id: d.siteId, id: d.groupId })];
            return sp && "first" in sp && sp.input != null ? stat("空请求基线", `${sp.input} Token`, "最近一次测速时，只发一句“hi”站点报告的输入 Token 数；远大于几个 Token 说明站点会附加系统提示", "baseline") : null;
          })(),
        ),
        u.sampled ? el("p", { class: "muted small" }, `仅统计了最近 ${fmtInt(u.sample_requests)} 条请求（窗口内共 ${fmtInt(u.total_requests)} 条）`) : null,
        u.models.length
          ? el(
              "div",
              { class: "drawer-section" },
              el("h4", {}, "按模型"),
              el("table", { class: "mtable", "data-testid": "model-table" }, el("thead", {}, el("tr", {}, ...["模型", "请求", "实付", "每百万"].map((h) => el("th", {}, h)))), el("tbody", {}, ...u.models.map((m) => el("tr", {}, el("td", { title: m.model }, m.model), el("td", {}, fmtInt(m.requests)), el("td", {}, money(c, m.cost)), el("td", {}, money(c, m.cost_per_m_effective)))))),
            )
          : null,
        u.estimates.length
          ? el(
              "div",
              { class: "drawer-section" },
              el("h4", {}, "预估价格（官方价 × 倍率，每百万 Token）"),
              el("table", { class: "mtable", "data-testid": "estimate-table" }, el("thead", {}, el("tr", {}, ...["模型", "输入", "输出", "缓存读"].map((h) => el("th", {}, h)))), el("tbody", {}, ...u.estimates.map((e) => el("tr", {}, el("td", { title: e.model }, e.model), el("td", {}, money(c, e.input_per_m)), el("td", {}, money(c, e.output_per_m)), el("td", {}, money(c, e.cache_read_per_m)))))),
            )
          : null,
        ...u.notes.map((n) => el("p", { class: "muted small", "data-testid": "drawer-note" }, n)),
        el("div", { class: "drawer-foot" }, el("span", { class: "muted small" }, `取数于 ${fullTime(u.fetched_at)}`), el("button", { class: "linklike", "data-testid": "drawer-refresh", onClick: () => void openCost({ site_id: d.siteId, id: d.groupId, name: d.name, site_name: d.siteName } as GroupView, true) }, "重新取数")),
      );
    }
  }
  return el(
    "div",
    { class: `drawer-mask${animate ? " enter" : ""}`, "data-testid": "cost-drawer", onClick: (e: Event) => { if (e.target === e.currentTarget) closeDrawer(); } },
    el("aside", { class: "drawer", role: "dialog", "aria-label": d.models ? "模型列表" : "成本详情" }, el("header", { class: "drawer-head" }, el("div", {}, el("h3", {}, d.name), el("span", { class: "muted small" }, d.models ? `${d.siteName} · 可用模型` : `${d.siteName} · 近 7 天`)), el("button", { class: "icon-btn", "aria-label": "关闭", "data-testid": "drawer-close", onClick: closeDrawer }, "✕")), body),
  );
}

/** 列标题：时延、倍率可点排序；模型列说明来源（第 1、2、3、6 项）。 */
function sortIcon(col: SortCol): Node {
  const t = document.createElement("template");
  const on = state.sort !== "default" && state.sortCol === col;
  const dir = on && state.sort === "desc" ? "desc" : "asc";
  t.innerHTML = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="${on ? "on" : ""} ${dir}"><path d="M12 5v14"/><path d="M6.5 12.5 12 19l5.5-6.5"/></svg>`;
  return t.content.firstChild!;
}

function sortHeader(col: SortCol, label: string, tip?: string): HTMLElement {
  const on = state.sort !== "default" && state.sortCol === col;
  return el(
    "button",
    {
      class: `col-head sortable${on ? " on" : ""}`,
      "data-testid": `sort-${col}`,
      ...(tip ? { "data-tip": tip } : { title: `${label}：点击切换升序 / 降序 / 默认` }),
      onClick: () => {
        // 同一个列：升序 → 降序 → 默认；换列：从升序开始
        const next = !on ? "asc" : state.sort === "asc" ? "desc" : "default";
        saveSort(next, next === "default" ? null : col);
        render();
      },
    },
    label,
    sortIcon(col),
  );
}

/** 列标题行：站点筛选、时延排序、倍率排序、模型筛选、测速按钮都在这一行，与卡片各列对齐。 */
function viewListHead(available: string[]): HTMLElement {
  const siteCell = multiSite()
    ? (() => {
        const sel = el(
          "select",
          { class: "head-select", "data-testid": "site-filter", title: "只看某个站点的分组", onChange: (e: Event) => { state.siteFilter = (e.target as HTMLSelectElement).value; render(true); } },
          el("option", { value: "all" }, "全部站点"),
          ...state.sites.map((s) => el("option", { value: s.id }, s.name)),
        );
        sel.value = state.siteFilter;
        return sel;
      })()
    : el("span", { class: "col-head" }, "站点");
  const all = available;
  const modelCell = (() => {
    const sel = el(
      "select",
      { class: "head-select", "data-testid": "model-filter", title: all.length ? "只看提供某个模型的分组" : "测速后可按模型筛选", disabled: all.length === 0, onChange: (e: Event) => { state.modelFilter = (e.target as HTMLSelectElement).value; render(true); } },
      el("option", { value: "" }, "模型"),
      ...all.map((m) => el("option", { value: m }, m)),
    );
    sel.value = all.includes(state.modelFilter) ? state.modelFilter : "";
    // 下拉框默认按最长的选项撑宽，箭头会离文字很远：按当前显示的文字收缩，箭头紧贴文字
    const ctx = document.createElement("canvas").getContext("2d");
    if (ctx) {
      ctx.font = '600 12px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
      sel.style.width = `${Math.ceil(ctx.measureText(sel.value || "模型").width) + 18}px`;
    }
    return sel;
  })();
  return el(
    "div",
    { class: "card list-head", "data-testid": "list-head" },
    el("div", { class: "card-main" }, siteCell),
    // 测速按钮放在“首字时延”标题的左边：测速测的就是这一列
    el(
      "div",
      { class: "cell-speed" },
      sortHeader("speed", "首字时延"),
    ),
    el("div", { class: "cell-rate" }, sortHeader("rate", "倍率")),
    el("div", { class: "cell-cost" }, sortHeader("cost", "Token成本", "百万有效Token的平均成本（近 7 天实付 ÷ 输入+输出 Token）；点击排序")),
    el("div", { class: "cell-cache" }, sortHeader("cache", "缓存命中率", "缓存读取 ÷（输入 + 缓存创建 + 缓存读取），近 7 天；越高越省钱；点击排序")),
    el("div", { class: "cell-models" }, modelCell),
    el("div", { class: "card-action" }), // 这一列在每个分组行里放“启用”图标，标题行留空保持对齐
  );
}

function viewMain(): HTMLElement {
  const c = state.selected;
  const o = ov(c);
  // 当前列出的分组（客户端 + 站点筛选）；模型下拉的候选项只取这些分组的模型，去重，不出现无关的模型
  const listed = state.groups.filter((g) => g.clients.includes(c) && (state.siteFilter === "all" || g.site_id === state.siteFilter));
  const availableModels = [...new Set(listed.flatMap(modelsOf))].sort();
  // 选中的模型已经不在候选项里（比如换了站点筛选）：筛选条件一并清掉，不能让下拉框显示空白、列表却还在被看不见的条件过滤
  if (state.modelFilter && !availableModels.includes(state.modelFilter)) state.modelFilter = "";
  const groups = listed.filter((g) => !state.modelFilter || modelsOf(g).includes(state.modelFilter));
  if (state.sort !== "default") {
    const sign = state.sort === "asc" ? 1 : -1;
    // 时延：没测过或测速失败的排在最后（不受升降序影响）
    const speedOf = (g: GroupView) => {
      const real = state.costs[gkey(g)]?.frt ?? null;
      if (real !== null) return real;
      const sp = state.speeds[gkey(g)];
      return sp && !("error" in sp) ? sp.first : null;
    };
    groups.sort((a, b) => {
      if (state.sortCol === "rate") return sign * (a.rate_multiplier - b.rate_multiplier);
      if (state.sortCol === "cost" || state.sortCol === "cache") {
        // 没取过成本、或近 7 天没有用量的排在最后（不受升降序影响）
        const f = state.sortCol === "cost" ? "perM" : "cache";
        const x = state.costs[gkey(a)]?.[f] ?? null, y = state.costs[gkey(b)]?.[f] ?? null;
        if (x === null && y === null) return 0;
        if (x === null) return 1;
        if (y === null) return -1;
        return sign * (x - y);
      }
      const x = speedOf(a), y = speedOf(b);
      if (x === null && y === null) return 0;
      if (x === null) return 1;
      if (y === null) return -1;
      return sign * (x - y);
    });
  }
  const body: Child[] = [];

  if (state.sites.length === 0 && state.dataLoss) {
    const dl = state.dataLoss;
    body.push(
      el(
        "div",
        { class: "panel welcome loss", "data-testid": "data-loss" },
        el("h2", {}, "Ferrydeck 的数据被清除了"),
        el("p", {}, `之前添加过 ${dl.sites.length} 个站点：${dl.sites.map((x) => x.name).join("、")}。`),
        el("p", { class: "muted small" }, "常见原因：清理软件（如腾讯柠檬）把 ~/Library/Application Support/Ferrydeck 当作“卸载残留”删掉了，通常发生在重装或更新应用之后。站点列表、登录凭据和原始配置备份已无法找回；Claude Code、Codex 等客户端自己的配置不受影响，仍然可用。"),
        el("p", { class: "muted small" }, "建议在清理软件里把 Ferrydeck 加入白名单，避免再次发生。"),
        el(
          "div",
          { class: "modal-actions", style: "justify-content:flex-start" },
          el("button", { class: "primary", "data-testid": "restore-sites", onClick: () => void restoreSites() }, "恢复站点列表（需要重新登录）"),
          el("button", { class: "ghost", "data-testid": "dismiss-loss", onClick: () => void dismissLoss() }, "忽略，重新开始"),
        ),
      ),
    );
  } else if (state.sites.length === 0) {
    body.push(
      el(
        "div",
        { class: "panel welcome", "data-testid": "empty-sites" },
        el("h2", {}, "还没有添加站点"),
        el("p", { class: "muted" }, "添加你在中转站的账号后，这里会列出它的所有分组，选一个就能自动配置到 Claude Code、Claude Desktop、Codex、Gemini CLI。"),
        el("p", { class: "muted small" }, "目前支持 new-api 和 sub2api 站点，用你在站点上的账号密码登录即可。"),
        el("button", { class: "primary", "data-testid": "empty-sites-add", onClick: () => openAdd() }, "添加站点"),
      ),
    );
  } else if (state.loadError) {
    body.push(el("div", { class: "panel error-panel", "data-testid": "load-error" }, el("p", {}, `加载失败：${state.loadError}`), el("button", { class: "primary", "data-testid": "retry", onClick: () => void refreshAll() }, "重试")));
  } else if (state.loading && state.groups.length === 0) {
    body.push(el("div", { class: "panel muted", "data-testid": "loading" }, "正在加载分组…"));
  } else if (state.groups.length === 0) {
    const needLogin = state.sites.some((s) => !s.connected && s.needs_login);
    const offline = state.sites.some((s) => !s.connected && !s.needs_login);
    body.push(el("div", { class: "panel", "data-testid": "empty" }, el("p", {}, needLogin ? "有站点需要重新登录，请在左侧处理。" : offline ? "有站点暂时连不上，会自动重试，也可以在左侧点“重试”。" : "你的账号暂时没有可用分组。"), !needLogin && !offline && el("p", { class: "muted" }, "请到站点上查看账号状态，或联系站点管理员开通。")));
  } else {
    // 标题行始终显示：筛选后没有分组时，用户仍能在这里改回筛选条件
    // 还在加载、或筛选的站点还在连接中：显示“加载中”，不要先说“没有分组”
    const pendingSite = state.siteFilter !== "all" && state.sites.some((x) => x.id === state.siteFilter && !x.connected && !x.needs_login);
    const empty = state.loading || pendingSite
      ? el("div", { class: "panel muted", "data-testid": "loading" }, "正在加载分组…")
      : el("div", { class: "panel", "data-testid": "empty-client" }, state.modelFilter ? `没有提供 ${state.modelFilter} 的分组。` : state.siteFilter === "all" ? `没有可用于 ${CLIENTS[c].name} 的分组。` : `这个站点没有可用于 ${CLIENTS[c].name} 的分组。`);
    body.push(el("div", { class: "list", "data-testid": "group-list" }, viewListHead(availableModels), ...(groups.length ? groups.map((g) => groupCard(g, o)) : [empty])));
  }

  return el(
    "div",
    { class: "main-wrap" },
    viewSidebar(),
    el(
      "section",
      { class: "content" },
      o && o.conflicts.length > 0 &&
        el(
          "div",
          { class: "banner warn", "data-testid": "conflict-banner" },
          // Claude Desktop 的问题是“还没进入第三方模式”，不是终端里有覆盖配置，文案要分开
          el("strong", {}, c === "claude_desktop" ? "Claude Desktop 需要先完成设置，配置才会生效：" : "检测到下列设置可能会覆盖配置，导致不生效："),
          el("ul", {}, ...o.conflicts.map((x) => el("li", {}, x))),
          c !== "claude_desktop" && el("span", { class: "small" }, "请删除或注释掉这些设置，然后重新打开终端。"),
        ),
      o && !o.dir_exists && el("div", { class: "banner info", "data-testid": "nodir-banner" }, `没有检测到 ${CLIENTS[c].name} 的配置目录，可能还没安装；仍可先写入，安装后即可使用。`),
      ...body,
      el("p", { class: "footnote muted small" }, "写入前会自动备份你原来的配置。"),
    ),
  );
}

function viewUpdateBanner(): HTMLElement | "" {
  const u = state.update;
  if (!u) return "";
  return el(
    "div",
    { class: "update-bar", "data-testid": "update-banner" },
    el("span", {}, `发现新版本 ${u.version}`, u.notes ? el("span", { class: "muted small" }, `　${u.notes}`) : null),
    el("button", { class: "primary", "data-testid": "install-update", disabled: state.updating, onClick: () => void installUpdate() }, state.updating ? "正在更新…" : "立即更新"),
  );
}

function viewDialog(): HTMLElement | null {
  const d = state.dialog;
  if (!d) return null;
  const close = () => {
    state.dialog = null;
    render();
  };
  if (d.type === "unclassified") {
    return el(
      "div",
      { class: "modal-mask", "data-testid": "unclassified-dialog" },
      el(
        "div",
        { class: "modal", role: "dialog" },
        el("h3", {}, "该站点没有对分组分类"),
        el(
          "div",
          { class: "muted", style: "display:flex;flex-direction:column;gap:8px" },
          el("p", {}, `「${d.siteName}」没有给分组标注适用的客户端（Claude、Codex、Gemini），Ferrydeck 没法判断每个分组该配给谁。这会影响使用体验：`),
          el(
            "ul",
            { style: "margin:0;padding-left:20px;display:flex;flex-direction:column;gap:4px" },
            el("li", {}, "这个站点的全部分组会在每一种客户端下都列出来，列表比较长，其中不少并不适用于当前客户端；"),
            el("li", {}, "这些分组的卡片上会标注“该站点未对分组分类”；"),
            el("li", {}, "把分组配给不合适的客户端不会报错，但用起来会失败（比如把只提供 GPT 模型的分组配给 Claude Code）。"),
          ),
          el("p", {}, "建议：先看分组的「模型」列，或用标题里的「模型」下拉按模型筛选；拿不准时点「测速」，能出结果的分组才是真的能用。"),
        ),
        el("div", { class: "modal-actions" }, el("button", { class: "primary", "data-testid": "unclassified-ok", autofocus: true, onClick: close }, "确定")),
      ),
    );
  }
  if (d.type === "speed-scope") {
    const all = () => { state.dialog = null; void runSpeedTest(speedTargets()); };
    const onlyMissing = () => { state.dialog = null; void runSpeedTest(speedTargets().filter((g) => !hasResult(g))); };
    return el(
      "div",
      { class: "modal-mask", "data-testid": "speed-scope-dialog" },
      el(
        "div",
        { class: "modal", role: "dialog" },
        d.missing === 0 ? el("h3", {}, "这些分组都已经有测速结果了") : el("h3", {}, "再次测速"),
        el(
          "div",
          { class: "muted", style: "display:flex;flex-direction:column;gap:6px" },
          d.missing === 0
            ? el("p", {}, `当前列出的 ${d.total} 个分组都已经有结果。要重新测速全部分组吗？会再次向站点发请求。`)
            : el("p", {}, `当前列出 ${d.total} 个分组：${d.done} 个已经有结果，${d.missing} 个还没有结果（没测过、被跳过，或当时没得到站点的回答）。`),
          d.missing === 0 ? null : el("p", {}, "默认只测还没有结果的分组，可以减少对站点的压力。"),
        ),
        el(
          "div",
          { class: "modal-actions" },
          el("button", { class: "ghost", "data-testid": "speed-scope-cancel", onClick: close }, "取消"),
          el("button", { class: d.missing === 0 ? "primary" : "ghost", "data-testid": "speed-scope-all", onClick: all }, `全部重新测速（${d.total} 个）`),
          d.missing === 0 ? null : el("button", { class: "primary", "data-testid": "speed-scope-missing", autofocus: true, onClick: onlyMissing }, `只测没有结果的 ${d.missing} 个（推荐）`),
        ),
      ),
    );
  }
  if (d.type === "speed-confirm") {
    return el(
      "div",
      { class: "modal-mask", "data-testid": "speed-confirm-dialog" },
      el(
        "div",
        { class: "modal", role: "dialog" },
        el("h3", {}, "开始测速？"),
        el(
          "div",
          { class: "muted", style: "display:flex;flex-direction:column;gap:6px" },
          el("p", {}, `会对当前列出的 ${d.count} 个分组逐个测试（间隔约 1 秒），每个分组只发一条 “hi”、只测一个模型一次，收到第一个字就断开，费用可以忽略。`),
          el("p", {}, "如果某个分组还没有专用 Key，会在站点上为它创建一把 Ferrydeck-分组名（可随时在站点上删除）。"),
          el("p", {}, "有些站点（如 new-api）限制读取 Key 的频率，每 20 分钟最多处理约 12 个还没读过 Key 的分组，超出的会提示稍后再测，避免把你的登录额度用光。"),
          el("p", {}, "测速中可以随时点按钮停止；每一步都记在 ~/.ferrydeck/logs/ferrydeck.log（不含密钥），排查失败原因可以看它。"),
        ),
        el(
          "div",
          { class: "modal-actions" },
          el("button", { class: "ghost", "data-testid": "speed-cancel", onClick: close }, "取消"),
          el("button", { class: "primary", "data-testid": "speed-start", onClick: () => { localStorage.setItem(SPEED_CONFIRMED_KEY, "1"); state.dialog = null; startSpeed(); } }, "开始测速"),
        ),
      ),
    );
  }
  if (d.type === "remove") {
    return el(
      "div",
      { class: "modal-mask", "data-testid": "remove-dialog" },
      el(
        "div",
        { class: "modal", role: "dialog" },
        el("h3", {}, `移除站点「${d.site.name}」？`),
        el("p", { class: "muted" }, "只会从应用里移除并退出登录。站点上的账号、已创建的 Ferrydeck- 开头的 Key，以及已经写入客户端的配置都不会被删除。"),
        el("div", { class: "modal-actions" }, el("button", { class: "ghost", "data-testid": "remove-cancel", disabled: d.busy, onClick: close }, "取消"), el("button", { class: "primary danger", "data-testid": "remove-confirm", disabled: d.busy, onClick: () => void confirmRemove() }, d.busy ? "移除中…" : "确认移除")),
      ),
    );
  }
  const inUrl = d.step === "url";
  const det = d.detected;
  const accountLabel = det?.kind === "newapi" ? "用户名" : "邮箱";
  return el(
    "div",
    { class: "modal-mask", "data-testid": "add-dialog" },
    el(
      "form",
      {
        class: "modal wide",
        role: "dialog",
        onSubmit: (ev: Event) => {
          ev.preventDefault();
          void (inUrl ? submitUrl() : submitLogin());
        },
      },
      el("h3", {}, d.relogin ? `重新登录「${d.relogin.name}」` : "添加站点"),
      inUrl
        ? el(
            "div",
            { class: "form" },
            el("label", { for: "add-url" }, "站点地址"),
            el("input", { id: "add-url", type: "text", placeholder: "例如 api.example.com", value: d.url, disabled: d.busy, autocomplete: "off", "data-testid": "add-url", onInput: (e: Event) => (d.url = (e.target as HTMLInputElement).value) }),
            el("p", { class: "muted small" }, "填你平时登录的那个中转站网址。"),
          )
        : el(
            "div",
            { class: "form" },
            el("div", { class: "site-found", "data-testid": "add-detected" }, el("span", { class: "site-name" }, det?.base_url ?? ""), el("span", { class: "tag" }, det ? KIND_LABEL[det.kind] : "")),
            !d.relogin && el("label", { for: "add-name" }, "站点名称"),
            !d.relogin && el("input", { id: "add-name", type: "text", value: d.name, disabled: d.busy, autocomplete: "off", "data-testid": "add-name", onInput: (e: Event) => (d.name = (e.target as HTMLInputElement).value) }),
            el("label", { for: "add-username" }, accountLabel),
            el("input", { id: "add-username", type: "text", value: d.username, disabled: d.busy, autocomplete: "username", "data-testid": "add-username", onInput: (e: Event) => (d.username = (e.target as HTMLInputElement).value) }),
            el("label", { for: "add-password" }, "密码"),
            el("input", { id: "add-password", type: "password", value: d.password, disabled: d.busy, autocomplete: "current-password", "data-testid": "add-password", onInput: (e: Event) => (d.password = (e.target as HTMLInputElement).value) }),
            el("p", { class: "muted small" }, "密码只用于登录这个站点，不会保存；应用只把登录凭据保存在本应用数据目录里（只有你自己能读）。"),
          ),
      el("div", { class: "error", role: "alert", "data-testid": "add-error" }, d.error),
      el(
        "div",
        { class: "modal-actions" },
        !inUrl && !d.relogin && el("button", { type: "button", class: "ghost", "data-testid": "add-back", disabled: d.busy, onClick: () => { d.step = "url"; d.error = ""; render(); } }, "返回"),
        el("button", { type: "button", class: "ghost", "data-testid": "add-cancel", disabled: d.busy, onClick: close }, "取消"),
        el("button", { type: "submit", class: "primary", "data-testid": "add-submit", disabled: d.busy }, inUrl ? (d.busy ? "检查中…" : "下一步") : d.busy ? "登录中…" : d.relogin ? "登录" : "登录并添加"),
      ),
    ),
  );
}

function viewToast(): HTMLElement | null {
  if (!state.toast) return null;
  return el("div", { class: `toast ${state.toast.kind}`, role: "status", "data-testid": "toast" }, state.toast.text);
}

// ---- 下拉框期间不重绘 ----
// render() 会把整个页面的节点换成新的。原生下拉菜单展开时如果被换掉（比如窗口刚获得焦点触发的刷新、
// 测速进度、提示条消失），用户选的那一项就落在已被丢弃的旧节点上，表现为“点了没反应、第二次才生效”。
// 所以有下拉框获得焦点时先把重绘记下来，选完 / 失焦 / 按 Esc 后再补上。
let renderDeferred = false;
let deferTimer: number | undefined;

function selectBusy(): boolean {
  const a = document.activeElement;
  return a instanceof HTMLSelectElement && root.contains(a);
}

function flushRender() {
  if (!renderDeferred) return;
  window.clearTimeout(deferTimer);
  render(true);
}

document.addEventListener("focusout", (e) => {
  if (e.target instanceof HTMLSelectElement) window.setTimeout(flushRender, 0);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && state.drawer && !state.dialog) closeDrawer();
  if (e.key === "Escape" && selectBusy()) window.setTimeout(flushRender, 50);
});

/** `force`：用户刚选完一项（下拉菜单已收起）时必须立刻重绘。 */
function render(force = false) {
  if (!force && selectBusy()) {
    renderDeferred = true;
    window.clearTimeout(deferTimer);
    deferTimer = window.setTimeout(flushRender, 15_000); // 兜底：焦点一直停在下拉框上也别永远不更新
    return;
  }
  renderDeferred = false;
  const focusId = (document.activeElement as HTMLElement | null)?.id;
  const sel = document.activeElement instanceof HTMLInputElement ? document.activeElement.selectionStart : null;
  // 整页重绘会把滚动容器换成新节点，滚动位置会回到顶部（测速时每测完一个就重绘一次，向下滑动的列表会不停被弹回去）。
  // 所以重绘前记下各滚动容器的位置，重绘后放回去。
  const scrolls = ["content", "sidebar"].map((c) => [c, document.querySelector<HTMLElement>(`.${c}`)?.scrollTop ?? 0] as const);
  const page = state.view === "boot" ? el("div", { class: "boot muted", "data-testid": "boot" }, "正在启动…") : el("div", { class: "app" }, viewHeader(), viewUpdateBanner(), viewMain());
  root.replaceChildren(page, viewDrawer() ?? "", viewDialog() ?? "", viewToast() ?? "", isMock ? el("div", { class: "mock-tag" }, "模拟后端") : "");
  for (const [c, top] of scrolls) {
    const e = document.querySelector<HTMLElement>(`.${c}`);
    if (e && top > 0) e.scrollTop = top;
  }
  if (focusId) {
    const f = document.getElementById(focusId);
    f?.focus();
    if (f instanceof HTMLInputElement && sel !== null && sel !== undefined) f.setSelectionRange(sel, sel);
  } else {
    // 对话框里标了 autofocus 的默认按钮：动态插入的元素浏览器不会自动聚焦，这里手动聚焦，回车就是默认选项
    document.querySelector<HTMLElement>(".modal [autofocus]")?.focus();
  }
  syncHover(); // 节点换新了：按鼠标当前位置重新算哪张卡处于悬停、该不该显示快速提示
}

/** 菜单栏里切换分组后，窗口里的状态同步刷新；菜单栏操作失败时在窗口里显示原因。 */
async function listenTrayEvents() {
  if (isMock) return;
  const { listen } = await import("@tauri-apps/api/event");
  await listen("state-changed", () => void refreshOverview().then(() => render()));
  // 后台续期或自动重连后站点状态变了（连上了、或登录确实失效了）
  await listen("sites-changed", () => void refreshAll(AUTO_MAX_AGE_SECS));
  await listen<string>("tray-error", (e) => void handleError(new Error(e.payload), "配置失败："));
}

async function boot() {
  render();
  void listenTrayEvents();
  startAgoTicker();
  initHover();
  // 切回窗口时重新拉一次分组：站点上的分组可能已经变了（第 14 项）
  // 但别太勤：切来切去的窗口焦点最多每 30 秒触发一次重新拉取，避免对站点连续发请求
  window.addEventListener("focus", () => {
    void refreshBalances();
    if (Date.now() - state.lastGroupsRefresh > 30_000) void refreshAll(AUTO_MAX_AGE_SECS);
  });
  backend.appVersion().then((v) => { state.version = v; render(); }).catch(() => undefined);
  if (!isMock) {
    const mode = await invoke<string | null>("selftest_mode").catch(() => null);
    if (mode) return (await import("./selftest")).runSelftest(mode);
  }
  try {
    state.sites = await backend.loadSites();
  } catch {
    state.sites = [];
  }
  // 没有站点时，看看是不是数据被清理软件误删了（以前有、现在没了）
  if (state.sites.length === 0) state.dataLoss = await backend.dataLoss().catch(() => null);
  state.view = "main";
  void checkForUpdate(true);
  await refreshAll();
}

void boot();
