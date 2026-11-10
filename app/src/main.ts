import { invoke } from "@tauri-apps/api/core";
import { octopusSpinner, octopusWorking } from "./octopus";
import { agoText, fullTime, startAgoTicker } from "./time";
import { initHover, syncHover } from "./hover";
import { backend, isMock } from "./backend";
import { CLIENTS, CLIENT_ORDER, KIND_LABEL, type CreatedDownstream, type DownstreamRef, type SayHi, type AddedUpstream, type AdminOverview, type LinkReport, type UpstreamLink, type Downstream, type GroupEdit, type SiteKind, type Upstream, type ClientId, type ClientOverview, type DataLoss, type DetectedSite, type GroupUsage, type GroupView, type SiteView, type UpdateInfo } from "./types";

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
  /** 勾选了“我是该站点管理员” */
  isAdmin: boolean;
  /** 正在显示“管理员模式”的说明（勾选时弹出，确认后才算勾选） */
  adminNotice: boolean;
  /** 重新登录已有站点时不为空 */
  relogin: SiteView | null;
}
interface RemoveDialog {
  type: "remove";
  site: SiteView;
  busy: boolean;
}
/** 新添加的站点没有给分组分类：告诉用户这对使用体验有什么影响，点“确定”关闭 */
/** 站长：暂停 / 移除上游前的二次确认 */
interface AdminConfirmDialog {
  type: "admin-pause" | "admin-remove";
  siteId: string;
  up: Upstream;
  /** 移除时要输入上游名称才能确认 */
  typed: string;
  busy: boolean;
  error: string;
}

/** “sayhi”测试：选一个模型说一句 hi，看回复和延迟 */
interface SayHiDialog {
  type: "sayhi";
  g: GroupView;
  models: string[];
  model: string;
  /** 按哪个客户端的协议发（默认当前客户端；这个分组不支持它时用分组支持的第一个） */
  client: ClientId;
  busy: boolean;
  error: string;
  /** 这次打开以来的测试结果，新的在前 */
  results: (SayHi & { client: ClientId })[];
}

/** 修改分组支持的客户端（多选） */
interface EditClientsDialog {
  type: "edit-clients";
  g: GroupView;
  selected: ClientId[];
  busy: boolean;
  error: string;
}

/** 基于上游分组创建下游分组：选中转站，填名称、客户端类型、倍率、备注 */
interface MakeDownstreamDialog {
  type: "make-downstream";
  g: GroupView;
  siteId: string;
  name: string;
  platform: string;
  rate: string;
  description: string;
  paused: boolean;
  testModel: string;
  busy: boolean;
  error: string;
  done: CreatedDownstream | null;
}

/** 站长：新建下游分组 */
interface AdminCreateGroupDialog {
  type: "admin-create-group";
  siteId: string;
  kind: SiteKind;
  name: string;
  description: string;
  platform: string;
  rate: string;
  busy: boolean;
  error: string;
}

/** 站长：给下游分组添加上游（在上游站点自动建 Key，再在自己的站点创建上游账号 / 渠道并绑定） */
interface AdminAddUpstreamDialog {
  type: "admin-add-upstream";
  siteId: string;
  down: Downstream;
  upSiteId: string;
  groupId: string;
  name: string;
  /** 站长手动改过名称就不再跟着选择自动变 */
  nameEdited: boolean;
  paused: boolean;
  busy: boolean;
  error: string;
  done: AddedUpstream | null;
  /** 更换来源模式：不是新增，而是改这个已有上游账号用的是哪个上游站点的哪个分组 */
  replace: Upstream | null;
  /** 这个上游分组已经被添加过，站长确认了“共用同一把 Key 也要添加” */
  dupOk: boolean;
  /** 试 “hi” 用的模型；空 = 自动挑便宜的 */
  testModel: string;
  /** 更换来源的弹窗左侧导航：上游调整 / 账号状态 */
  tab: "source" | "state";
}

/** 站长：删除下游分组 */
interface AdminRemoveGroupDialog {
  type: "admin-remove-group";
  siteId: string;
  g: Downstream;
  /** 绑在它上面的上游账号（删除分组不会删它们，只是不再服务任何分组） */
  ups: Upstream[];
  busy: boolean;
  error: string;
}

/** 站长：编辑下游分组。第一步填写，第二步看变更清单再确认。 */
interface GroupEditDialog {
  type: "group-edit";
  siteId: string;
  kind: SiteKind;
  g: Downstream;
  name: string;
  description: string;
  platform: string;
  rate: string;
  step: "form" | "confirm";
  busy: boolean;
  error: string;
}

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

const ADMIN_USAGE_KEY = "ferrydeck.adminUsage";
function loadAdminUsageCache(): Record<string, CostEntry> {
  try {
    return JSON.parse(localStorage.getItem(ADMIN_USAGE_KEY) ?? "{}") as Record<string, CostEntry>;
  } catch {
    return {};
  }
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
/** 调用量少于这个数，缓存命中率没有统计意义，不展示 */
const MIN_CACHE_REQUESTS = 100;
const CACHE_NOTE = "如果调用量少于100次，效果不准确，则不展示";
/** 列表里展示的缓存命中率：调用量不足、或还没读取过的没有值 */
const cacheShown = (c: CostEntry | undefined): number | null => (c && (c.reqs ?? 0) >= MIN_CACHE_REQUESTS ? (c.cache ?? null) : null);
type CostEntry = { /** 24 小时流水：c24 = 用户实付，o24 = 官方价口径 */ c24?: number | null; o24?: number | null; perM: number | null; /** 官方价口径的每百万有效 Token 成本（站长视角：乘上游真实倍率才是付给上游的钱） */ offM?: number | null; currency: string; at: number; /** 真实首字时延（中位数，毫秒）和样本数 */ frt?: number | null; frtN?: number; /** 缓存命中率 0~1 */ cache?: number | null; /** 近 7 天的调用次数：太少时缓存命中率不准，列表里不展示 */ reqs?: number; /** 过去 24 小时的 Token 量（站长视角）；capped 表示只统计了一部分 */ t24?: number | null; t24cap?: boolean };
type BillEntry = { perM: number | null; c24: number | null; c24cap: boolean; t24: number | null; currency: string; at: number; reqs: number; siteName: string; group: string };
function loadCosts(): Record<string, CostEntry> {
  try {
    return JSON.parse(localStorage.getItem(COSTS_KEY) ?? "{}") as Record<string, CostEntry>;
  } catch {
    return {};
  }
}
function rememberCost(g: { site_id: string; id: string }, u: GroupUsage) {
  state.costs[gkey(g)] = { perM: u.cost_per_m_effective, currency: u.currency, at: u.fetched_at, frt: u.first_token_median_ms, frtN: u.first_token_samples, cache: u.cache_hit_rate, reqs: u.total_requests };
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
  costLoading: null as null | { done: number; total: number; pending: Set<string> },
  busyGroup: null as string | null,
  models: {} as Record<string, string[]>,
  loading: false,
  loadError: null as string | null,
  toast: null as Toast,
  /** 右侧成本抽屉；`entered` 记录滑入动画是否已经播过（重绘不要重播） */
  drawer: null as null | { siteId: string; groupId: string; name: string; siteName: string; status: "loading" | "ready" | "error"; data?: GroupUsage; error?: string; entered: boolean },
  dialog: null as AdminRemoveGroupDialog | SayHiDialog | EditClientsDialog | MakeDownstreamDialog | AdminCreateGroupDialog | AdminAddUpstreamDialog | AdminConfirmDialog | GroupEditDialog | AddDialog | RemoveDialog | SpeedConfirmDialog | SpeedScopeDialog | UnclassifiedNotice | null,
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
  /** 左侧选中的“我的中转站”（站点 id）；为 null 时显示客户端的分组列表 */
  operator: null as string | null,
  /** 各管理员站点的上下游数据（只读元数据，不含任何凭据） */
  admin: {} as Record<string, { status: "loading" | "ready" | "error"; data?: AdminOverview; error?: string }>,
  /** 站长视角里每个下游分组 / 上游账号近 7 天的用量（键：`站点|group或account|id`），记在本机，下次打开直接显示 */
  adminUsage: loadAdminUsageCache(),
  /** 各管理员站点的“上游账号 ↔ 上游站点分组”关联（含当前倍率）和还没添加账号的上游站点 */
  adminLinks: {} as Record<string, LinkReport | undefined>,
  /** 上游账号的真实账单：读的是上游站点自己的用量记录（你在那个站点登录账号下，关联的那个分组实际扣的钱），不是估算 */
  adminBill: {} as Record<string, BillEntry | undefined>,
  billPending: new Set<string>(),
  /** 每个上游分组底下挂着的下游分组（键：上游站点 + 分组）：在分组列表里显示“下游：站点 · 分组 · 倍率” */
  downstreamRefs: {} as Record<string, DownstreamRef[]>,
  /** 我的中转站列表的排序：默认按过去 24 小时 Token 量从高到低（越重要越靠前） */
  opSort: { col: "tokens", dir: "desc" } as { col: "name" | "speed" | "rate" | "cost" | "cache" | "tokens" | "models"; dir: "asc" | "desc" },
  /** 我的中转站里选中的客户端 tab（按站点）；默认 all */
  opTab: {} as Record<string, string>,
  /** 正在读取用量的进度（按站点） */
  adminLoading: {} as Record<string, { done: number; total: number; pending: Set<string> }>,
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
async function refreshAll(maxAgeSecs = 0, opts: { models?: boolean; forceCosts?: boolean; costs?: boolean } = {}) {
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
  if (opts.costs !== false) void loadAllCosts(opts.forceCosts ?? false);
  void loadDownstreamRefs();
  for (const x of state.sites.filter((y) => y.is_admin && y.connected)) void loadAdminLight(x.id);
}

/** 站长站点里记着的“上游分组 → 下游分组”，只在有站长站点时才读。 */
async function loadDownstreamRefs() {
  if (!state.sites.some((x) => x.is_admin)) {
    if (Object.keys(state.downstreamRefs).length) { state.downstreamRefs = {}; render(); }
    return;
  }
  try {
    const refs = await backend.adminDownstreams();
    const m: Record<string, DownstreamRef[]> = {};
    for (const r of refs) (m[gkey({ site_id: r.up_site_id, id: r.up_group_id })] ??= []).push(r);
    state.downstreamRefs = m;
    render();
  } catch {
    /* 读不到就不显示，不影响分组列表 */
  }
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
    // 正在看“我的中转站”：管理数据（上下游列表、关联）和每个分组 / 上游的用量、真实账单也一起重读（忽略缓存）；没打开的中转站不读，减轻服务器压力
    if (state.operator) void loadAdmin(state.operator, true);
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

function openAdd(relogin: SiteView | null = null, prefillUrl = "") {
  state.dialog = {
    type: "add",
    step: relogin ? "login" : "url",
    url: prefillUrl,
    detected: relogin ? { base_url: relogin.base_url, kind: relogin.kind, name: relogin.name } : null,
    name: relogin?.name ?? "",
    username: "",
    password: "",
    error: "",
    busy: false,
    isAdmin: relogin?.is_admin ?? false,
    adminNotice: false,
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
    const site = await backend.addSite({ baseUrl: d.detected.base_url, name: d.relogin ? undefined : d.name, username: d.username.trim(), password: d.password, isAdmin: d.isAdmin });
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
      await refreshAll(0, { models: false, costs: false });
      const first = CLIENT_ORDER.find((c) => state.groups.some((g) => g.site_id === site.id && g.clients.includes(c)));
      if (first) state.selected = first;
      render();
      showToast("info", "开始刷新模型列表…");
      await loadAllModels();
      if (!state.loadError) {
        // 成本、缓存命中率和真实首字时延要逐个分组读，站点慢的话要一两分钟：把进度一直摆在提示条里，别让人干等
        await readCosts("all", false, true, (d, t) => showToast("info", `正在读取各分组近 7 天的成本、缓存命中率和真实首字时延 ${d}/${t}（站点较慢时需要一两分钟，列表会边读边更新）`));
      }
      state.loadError
        ? showToast("err", `已添加站点「${site.name}」，但刷新分组失败：${state.loadError}`)
        : showToast("ok", `已添加站点「${site.name}」，分组、模型和成本都已读取`);
    }
    for (const x of state.sites.filter((y) => y.is_admin)) void loadAdminLinks(x.id); // 添加了新站点：中转站里“还没添加账号”的提示要去掉它
    if (d.isAdmin && !site.is_admin) {
      showToast("err", `已添加站点「${site.name}」，但该账号不是这个站点的管理员（站点拒绝了管理接口），没有开启“我的中转站”`);
    } else if (site.is_admin) {
      openOperator(site.id); // 管理员站点：直接打开它的上下游
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
          state.costLoading ? el("span", { class: "cost-progress", "data-testid": "cost-progress", "data-tip": "正在读取各分组近 7 天的成本、缓存命中率和真实首字时延（读到一个就更新一个）" }, `读取成本 ${state.costLoading.done}/${state.costLoading.total}`) : null,
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
      state.version ? el("span", { class: "app-version", "data-testid": "app-version", "data-tip": "当前版本" }, `v${state.version}`) : null,
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
  "• 正在看“我的中转站”时，也会重读它的上下游列表、关联，以及每个分组和上游的用量与真实账单（忽略缓存）",
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

/**
 * 分组列表顶部的站点 tab：全部站点 + 每个站点（名称和余额）。点击切换，筛选下面的分组；右键站点 tab 出现“控制台 / 充值 / 删除”；
 * 最后的“＋”添加站点。站点连不上或要重新登录时，tab 下面有一条提示，带“重试 / 重新登录”。
 */
/** 站点的控制台地址：new-api 是 /console，sub2api 打开站点首页（登录后会自己跳到面板）。 */
const consoleUrl = (s: SiteView) => (s.kind === "newapi" ? `${s.base_url}/console` : s.base_url);

/** 右键菜单（挂在 body 上，界面重绘不会把它清掉）：点别处、按 Esc、滚动、窗口失焦都会收起。 */
let ctxMenuEl: HTMLDivElement | null = null;
function closeCtxMenu() {
  ctxMenuEl?.remove();
  ctxMenuEl = null;
}
function showCtxMenu(x: number, y: number, items: { label: string; testid: string; danger?: boolean; run: () => void }[]) {
  closeCtxMenu();
  const m = document.createElement("div");
  m.className = "ctx-menu";
  m.setAttribute("role", "menu");
  m.setAttribute("data-testid", "ctx-menu");
  for (const it of items) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `ctx-item${it.danger ? " danger" : ""}`;
    b.setAttribute("role", "menuitem");
    b.setAttribute("data-testid", it.testid);
    b.textContent = it.label;
    b.addEventListener("click", () => {
      closeCtxMenu();
      it.run();
    });
    m.append(b);
  }
  document.body.append(m);
  m.style.left = `${Math.max(4, Math.min(x, window.innerWidth - m.offsetWidth - 4))}px`;
  m.style.top = `${Math.max(4, Math.min(y, window.innerHeight - m.offsetHeight - 4))}px`;
  ctxMenuEl = m;
}
document.addEventListener("mousedown", (e) => { if (ctxMenuEl && !ctxMenuEl.contains(e.target as Node)) closeCtxMenu(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeCtxMenu(); });
window.addEventListener("blur", closeCtxMenu);
document.addEventListener("scroll", closeCtxMenu, { capture: true, passive: true });

/** 站点卡片上的右键菜单：上游站点 = 控制台 / 充值 / 删除；你管理的中转站 = 控制台 / 删除。 */
function siteMenu(e: MouseEvent, s: SiteView, admin: boolean) {
  e.preventDefault();
  e.stopPropagation();
  showCtxMenu(e.clientX, e.clientY, [
    { label: "控制台", testid: "ctx-console", run: () => void openUrl(consoleUrl(s)) },
    ...(admin ? [] : [{ label: "充值", testid: "ctx-topup", run: () => void topup(s) }]),
    { label: "删除", testid: "ctx-remove", danger: true, run: () => { state.dialog = { type: "remove", site: s, busy: false }; render(); } },
  ]);
}

function viewSiteTabs(): HTMLElement {
  const tabs: Child[] = [
    // 只有一个站点时“全部站点”没有意义，不显示
    state.sites.length > 1 && el("button", { class: `site-tab${state.operator === null && state.siteFilter === "all" ? " on" : ""}`, "data-testid": "site-tab-all", onClick: () => { state.siteFilter = "all"; state.operator = null; render(true); } }, el("span", { class: "tab-name" }, "全部站点")),
    ...state.sites.map((s) =>
      el(
        "div",
        { class: `site-tab${state.operator === null && state.siteFilter === s.id ? " on" : ""}${s.connected ? "" : " bad"}`, "data-testid": `site-${s.id}`, role: "button", tabindex: "0", title: `${s.base_url}${s.account?.display ? `（账号 ${s.account.display}）` : ""}\n右键：控制台、充值、删除`, onClick: () => { state.siteFilter = s.id; state.operator = null; render(true); }, onContextmenu: (e: Event) => siteMenu(e as MouseEvent, s, false) },
        el("span", { class: "tab-name", "data-testid": `site-name-${s.id}` }, s.name),
        el(
          "span",
          { class: "tab-end" },
          s.connected ? el("span", { class: "tab-balance", "data-testid": `site-balance-${s.id}` }, s.account?.balance ?? "") : el("span", { class: "tab-warn", "data-tip": s.error ?? "需要重新登录" }, "!"),
        ),
    ),
    ),
    el("button", { class: "site-tab add", "data-testid": "add-site", title: "添加站点", "aria-label": "添加站点", onClick: () => openAdd() }, "＋"),
  ];
  return el("div", { class: "site-tabs", "data-testid": "site-tabs" }, ...tabs);
}

/** 连不上 / 需要重新登录的站点：内容区顶部一条提示，带“重试 / 重新登录”；选中某个站点时只显示它的。 */
function viewSiteProblems(): HTMLElement | null {
  const shown = state.sites.filter((s) => !s.connected && (state.siteFilter === "all" || state.siteFilter === s.id));
  if (shown.length === 0) return null;
  return el(
    "div",
    { class: "site-problems" },
    ...shown.map((s) =>
      el(
        "div",
        { class: "banner warn site-problem", "data-testid": `site-problem-${s.id}` },
        el("strong", {}, s.name),
        el("span", { "data-testid": `site-error-${s.id}` }, s.error ?? (s.needs_login ? "需要重新登录" : "正在连接…")),
        el(
          "span",
          { class: "site-actions" },
          !s.needs_login && el("button", { class: "primary small-btn", "data-testid": `retry-${s.id}`, disabled: state.retrying, onClick: () => void retrySites() }, state.retrying ? "重试中…" : "重试"),
          el("button", { class: `${s.needs_login ? "primary" : "ghost"} small-btn`, "data-testid": `relogin-${s.id}`, onClick: () => openAdd(s) }, "重新登录"),
        ),
      ),
    ),
  );
}

/** 内容区顶部的客户端 tab（Claude Code / Claude Desktop / Codex / Gemini CLI），每个 tab 下面一行小字是正在使用的分组。 */
function viewClientTabs(): HTMLElement {
  return el(
    "div",
    { class: "client-tabs", "data-testid": "client-tabs" },
    ...CLIENT_ORDER.map((c) => {
      const o = ov(c);
      const count = state.groups.filter((g) => g.clients.includes(c)).length;
      const a = o?.in_use ? o.active : null;
      return el(
        "button",
        { class: `side-item${state.operator === null && state.selected === c ? " selected" : ""}`, "data-testid": `client-${c}`, onClick: () => { state.selected = c; state.operator = null; state.modelFilter = ""; render(true); } },
        el(
          "span",
          { class: "side-text" },
          el("span", { class: "side-name" }, CLIENTS[c].name, o && o.conflicts.length > 0 ? el("span", { class: "warn-mark", title: "存在可能覆盖配置的设置" }, " ⚠") : null),
          el("span", { class: "side-sub", "data-testid": `client-status-${c}` }, a ? (multiSite() ? `${a.site_name} · ${a.group_name}` : a.group_name) : state.loading && state.groups.length === 0 ? "加载中…" : count === 0 ? "暂无可用分组" : ""),
        ),
      );
    }),
  );
}

/** 左侧是两种站点：站长自己的“我的中转站”，和你登录了账号的“上游站点”。 */
function viewSidebar(): HTMLElement {
  const adminSites = state.sites.filter((x) => x.is_admin);
  return el(
    "nav",
    { class: "sidebar" },
    ...(adminSites.length > 0
      ? [
          el("div", { class: "side-title" }, "我的中转站"),
          ...adminSites.map((x) => {
            const a = state.admin[x.id]?.data;
            return el(
              "button",
              { class: `side-item operator-item${state.operator === x.id ? " selected" : ""}`, "data-testid": `operator-${x.id}`, title: "右键：控制台、删除", onClick: () => openOperator(x.id), onContextmenu: (e: Event) => siteMenu(e as MouseEvent, x, true) },
              el("span", { class: "side-text" }, el("span", { class: "side-name" }, x.name), el("span", { class: "side-sub", "data-testid": `operator-sub-${x.id}` }, a ? `${a.upstreams.length} 个上游 · ${a.downstreams.length} 个分组` : x.connected ? "上下游管理" : "未连接")),
              (() => {
                // 异常数量：和中转站里 tab 上的一样，红点 + 数量（没有问题是绿点）
                if (!a) return null;
                const n = adminProblems(a).size;
                return el("span", { class: "op-badge", "data-testid": `operator-badge-${x.id}`, "data-tip": n ? `${n} 个分组有问题：${[...adminProblems(a)].map(([id, why]) => `\n${a.downstreams.find((g) => g.id === id)?.name ?? id} —— ${why}`).join("")}` : "所有分组都正常" }, el("span", { class: `tab-dot ${n ? "bad" : "ok"}`, "data-testid": `operator-dot-${x.id}` }), n ? el("span", { class: "tab-n", "data-testid": `operator-n-${x.id}` }, String(n)) : null);
              })(),
            );
          }),
        ]
      : []),
    el("div", { class: `side-title${adminSites.length > 0 ? " sites-title" : ""}`, "data-testid": "upstream-title" }, "上游站点"),
    viewSiteTabs(),
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

function bubbleIcon(): Node {
  const t = document.createElement("template");
  t.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/><path d="M8.5 12h.01M12 12h.01M15.5 12h.01"/></svg>';
  return t.content.firstChild!;
}
function slidersIcon(): Node {
  const t = document.createElement("template");
  t.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/></svg>';
  return t.content.firstChild!;
}
function branchIcon(): Node {
  const t = document.createElement("template");
  t.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="12" r="2"/><path d="M6 7v10M6 12h6a4 4 0 0 0 4-0"/></svg>';
  return t.content.firstChild!;
}

/** 启用按钮右边的“…”：悬停后换成三个图标——sayhi 测试、修改分组支持的客户端、基于它创建下游分组。 */
function moreMenu(g: GroupView, tid: string): HTMLElement {
  return el(
    "span",
    { class: "more", "data-testid": `more-${tid}` },
    el("span", { class: "more-dots", "aria-hidden": "true" }, "···"),
    el(
      "span",
      { class: "more-icons" },
      el("button", { class: "act-btn", "aria-label": "sayhi 测试", "data-tip": "sayhi 测试：选一个模型说一句 hi，看回复效果和延迟", "data-testid": `sayhi-${tid}`, onClick: () => openSayHi(g) }, bubbleIcon()),
      el("button", { class: "act-btn", "aria-label": "修改分组", "data-tip": "修改这个分组支持的客户端类型（可多选）", "data-testid": `editclients-${tid}`, onClick: () => openEditClients(g) }, slidersIcon()),
      el("button", { class: "act-btn", "aria-label": "创建下游", "data-tip": "基于这个分组，在你的中转站创建下游分组", "data-testid": `makedown-${tid}`, onClick: () => openMakeDownstream(g) }, branchIcon()),
    ),
  );
}

function openSayHi(g: GroupView) {
  const models = modelsOf(g).filter((m) => !/image|embed|tts|whisper|rerank/.test(m));
  state.dialog = { type: "sayhi", g, models, model: models[0] ?? "", client: g.clients.includes(state.selected) ? state.selected : (g.clients[0] ?? state.selected), busy: false, error: "", results: [] };
  render();
}

async function runSayHi(d: SayHiDialog) {
  d.busy = true;
  d.error = "";
  render();
  try {
    const r = await backend.sayHi(d.g.site_id, d.g.id, d.model || null, d.client);
    d.results = [{ ...r, client: d.client }, ...d.results];
    if (!d.models.includes(r.model)) d.models = [r.model, ...d.models];
  } catch (e) {
    d.error = errText(e);
  }
  d.busy = false;
  render();
}

function openEditClients(g: GroupView) {
  state.dialog = { type: "edit-clients", g, selected: [...g.clients], busy: false, error: "" };
  render();
}

async function saveClients(d: EditClientsDialog, clients: ClientId[]) {
  d.busy = true;
  d.error = "";
  render();
  try {
    await backend.setGroupClients(d.g.site_id, d.g.id, clients);
    state.dialog = null;
    showToast("ok", clients.length ? `已把「${d.g.name}」设为支持：${clients.map((c) => CLIENTS[c].name).join("、")}` : `「${d.g.name}」已恢复成站点给的默认分类`);
    await refreshAll(300, { models: false, costs: false });
  } catch (e) {
    d.busy = false;
    d.error = errText(e);
    render();
  }
}

function openMakeDownstream(g: GroupView) {
  const first = state.sites.find((x) => x.is_admin && x.id !== g.site_id && x.connected);
  const known = ["anthropic", "openai", "gemini", "grok", "antigravity"].includes(g.platform);
  state.dialog = { type: "make-downstream", g, siteId: first?.id ?? "", name: g.name, platform: known ? g.platform : "anthropic", rate: String(g.rate_multiplier), description: "", paused: true, testModel: "", busy: false, error: "", done: null };
  render();
}

async function submitMakeDownstream(d: MakeDownstreamDialog) {
  const rate = Number(d.rate);
  const own = state.sites.find((x) => x.id === d.siteId);
  if (!d.siteId) { d.error = "请选择中转站"; render(); return; }
  if (!d.name.trim()) { d.error = "名称不能为空"; render(); return; }
  if (d.rate.trim() === "" || !Number.isFinite(rate) || rate <= 0) { d.error = "倍率必须是大于 0 的数字"; render(); return; }
  d.busy = true;
  d.error = "";
  render();
  try {
    d.done = await backend.adminCreateDownstream(d.siteId, d.g.site_id, d.g.id, d.name.trim(), own?.kind === "sub2api" ? d.platform : undefined, rate, d.description.trim() || undefined, true, d.testModel || undefined);
    d.busy = false;
    render();
    void loadDownstreamRefs(); // 上游分组底下马上出现这个下游
    void loadAdmin(d.siteId);
  } catch (e) {
    d.busy = false;
    d.error = errText(e);
    render();
    void loadAdmin(d.siteId); // 分组可能已经创建了
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
      ? el("span", { class: "pill", "data-testid": `row-models-${tid}`, "data-tip": modelTip(modelList), "data-tip-mono": "1" }, `${modelList.length} 个模型`)
      : el("span", { class: "muted small", "data-testid": `row-models-${tid}`, title: "测速后可看到该分组的模型" }, "—");
  return el(
    "div",
    { class: `card${isActive ? " active" : ""}`, "data-testid": `group-card-${tid}` },
    el(
      "div",
      { class: "card-main" },
      el("h3", g.description ? { "data-tip": g.description, "data-testid": `name-${tid}` } : { "data-testid": `name-${tid}` }, g.name, multiSite() ? el("span", { class: "site-tag", "data-testid": `site-tag-${tid}` }, g.site_name) : null),
      g.clients_inferred && el("span", { class: "unclassified", "data-testid": `unclassified-${tid}` }, "该站点未对分组分类"),
      ...((state.downstreamRefs[k] ?? []).length ? [el("div", { class: "downstream-lines", "data-testid": `downs-${tid}` }, ...state.downstreamRefs[k].map((r) => el("span", { class: "down-chip", "data-tip": `下游分组：${r.site_name} 里的「${r.group_name}」，倍率 ×${r.rate}`, "data-testid": `down-ref-${tid}-${r.group_id}` }, "↳ ", el("span", { class: "chip-site" }, r.site_name), " · ", r.group_name, " ", el("span", { class: "chip-rate" }, `×${r.rate}`))))] : []),
    ),
    el("div", { class: "cell-speed" }, state.probing.has(k) ? octopusSpinner(tid) : speedText ? el("span", { class: `pill speed${realFrt === null && "error" in sp! ? " bad" : ""}`, "data-tip": realFrt !== null ? `真实首字时延（近 7 天 ${real!.frtN} 个请求的中位数，来自站点的使用记录）` : "error" in sp! ? `测速失败：${sp!.error}` : `本地测速的首字延迟（模型 ${sp!.model}）${sp!.input != null ? `；发一句“hi”站点计 ${sp!.input} 个输入 Token` : ""}`, "data-testid": `speed-${tid}` }, speedText) : el("span", { class: "muted small" }, "—")),
    el("div", { class: "cell-rate" }, el("span", { class: "rate", title: "计费倍率" }, `×${g.rate_multiplier}`)),
    el("div", { class: "cell-cost" }, costCell(g, tid)),
    el("div", { class: "cell-cache" }, cacheCell(g, tid)),
    el("div", { class: "cell-models" }, modelCell),
    el("div", { class: "card-action" }, control, moreMenu(g, tid)),
  );
}

function costCell(g: GroupView, tid: string): HTMLElement {
  const c = state.costs[gkey(g)];
  if (!c) {
    const reading = state.costLoading?.pending.has(gkey(g));
    return el("span", { class: `muted small ${reading ? "reading" : "empty"}`, "data-tip": reading ? "正在读取…" : "还没读取到成本：点顶部的刷新按钮会一并读取", "data-testid": `cost-val-${tid}` }, reading ? "读取中…" : "—");
  }
  const when = `取数于 ${fullTime(c.at)}`;
  if (c.perM === null) return el("span", { class: "muted small", "data-tip": `近 7 天没有用量；${when}`, "data-testid": `cost-val-${tid}` }, "无用量");
  return el("span", { class: "rate", "data-tip": `每百万有效 Token 的平均成本；${when}`, "data-testid": `cost-val-${tid}`, onClick: () => void openCost(g) }, money(c.currency, c.perM));
}

/** 模型列表的悬停提示：每行一个模型，太多只列前面一部分。 */
function modelTip(list: string[]): string {
  const max = 40;
  return list.length > max ? [...list.slice(0, max), `…共 ${list.length} 个`].join("\n") : list.join("\n");
}

function cacheCell(g: GroupView, tid: string): HTMLElement {
  const c = state.costs[gkey(g)];
  const r = cacheShown(c);
  const base = "缓存命中率：缓存读取 ÷（输入 + 缓存创建 + 缓存读取）";
  if (r === null) {
    const reading = !c && state.costLoading?.pending.has(gkey(g));
    // 读到了但调用量不够 100 次：明确说“无有效统计”，不给一个不准的数
    if (c && c.reqs !== undefined && c.reqs < MIN_CACHE_REQUESTS) return el("span", { class: "muted small empty", "data-tip": `${base}；近 7 天只有 ${c.reqs} 次调用。${CACHE_NOTE}`, "data-testid": `cache-val-${tid}` }, "无有效统计");
    return el("span", { class: `muted small ${reading ? "reading" : "empty"}`, "data-tip": reading ? "正在读取…" : c ? "近 7 天没有可统计的输入" : "还没读取到：点顶部的刷新按钮会一并读取", "data-testid": `cache-val-${tid}` }, reading ? "读取中…" : "—");
  }
  return el("span", { class: "pill cache-rate", "data-tip": `${base}；取数于 ${fullTime(c!.at)}；${CACHE_NOTE}`, "data-testid": `cache-val-${tid}` }, pct(r));
}

const COST_FRESH_MS = 10 * 60_000;

/**
 * 逐个读取分组的成本（串行、间隔 250 毫秒；站点限流就停下，已读到的保留）。
 * - `scope: "listed"`：用户点标题行的硬币按钮，只读当前列出的分组，忽略“刚读过”的判断；
 * - `scope: "all"`：随“刷新分组”一起读所有站点的所有分组。手动刷新（`force`）全部重读；自动刷新只读 10 分钟内没读过的，
 *   这样切回窗口、打开面板触发的自动刷新不会反复敲站点。
 */
async function readCosts(scope: "listed" | "all", force: boolean, quiet: boolean, onProgress?: (done: number, total: number) => void) {
  if (state.costLoading) return;
  const pool = scope === "listed" ? speedTargets() : state.groups;
  const seen = new Set<string>();
  const list = pool.filter((g) => {
    const k = gkey(g);
    if (seen.has(k)) return false;
    seen.add(k);
    return force || !state.costs[k] || Date.now() / 1000 - state.costs[k].at > COST_FRESH_MS / 1000;
  });
  if (list.length === 0) return;
  state.costLoading = { done: 0, total: list.length, pending: new Set(list.map(gkey)) };
  onProgress?.(0, list.length);
  render();
  let failed = "";
  const limited = new Set<string>();
  // 有的站点很慢（一次用量请求要 1~6 秒），几十个分组串行要好几分钟：同时读 3 个。
  // 站点的“重”接口是每分钟 60 次，3 个并行远没到。
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const g = list[next++];
      if (!limited.has(g.site_id)) {
        try {
          rememberCost(g, await backend.groupUsage(g.site_id, g.id, force));
        } catch (e) {
          failed = e instanceof Error ? e.message : String(e);
          if (failed.includes("站点限流")) limited.add(g.site_id); // 这个站点剩下的分组不再请求
        }
      }
      const cl = state.costLoading!;
      cl.pending.delete(gkey(g));
      state.costLoading = { ...cl, done: cl.done + 1 };
      onProgress?.(cl.done + 1, list.length);
      render();
      await new Promise((r) => setTimeout(r, 150));
    }
  };
  try {
    await Promise.all([worker(), worker(), worker()]);
  } finally {
    state.costLoading = null;
    render();
  }
  if (failed && !quiet) showToast("err", `部分分组的成本没有读到：${failed}`);
}

/** 随刷新一起读成本：手动刷新只重读当前列出的分组并提示失败；自动刷新静默，只补过期的（所有分组）。 */
const loadAllCosts = (force: boolean) => (state.sites.length > 0 ? readCosts(force ? "listed" : "all", force, !force) : Promise.resolve());

// ---------- 我的中转站（站长：上下游一体管理）----------

const PLATFORM_CHOICES = ["anthropic", "openai", "gemini", "antigravity"];
const BLOCK_HUES = [212, 152, 32, 282, 342, 182];

function openOperator(siteId: string) {
  state.operator = siteId;
  render(true);
  void loadAdmin(siteId); // 左侧卡片上的数量只读了概览；点进来再把用量和关联也读上（用量有 10 分钟缓存，不会重复请求）
}

async function loadAdmin(siteId: string, force = false) {
  const keep = state.admin[siteId]?.data;
  state.admin[siteId] = { status: "loading", data: keep };
  render();
  try {
    state.admin[siteId] = { status: "ready", data: await backend.adminOverview(siteId) };
  } catch (e) {
    state.admin[siteId] = { status: "error", error: errText(e), data: keep };
  }
  render();
  if (state.admin[siteId].status === "ready") {
    void loadAdminUsage(siteId, force);
    void loadAdminLinks(siteId);
  }
}

async function loadAdminLinks(siteId: string) {
  try {
    state.adminLinks[siteId] = await backend.adminLinks(siteId);
  } catch {
    /* 读不到关联不影响其他内容：倍率退回显示站点里的账号倍率 */
  }
  render();
  void loadBills(siteId, false);
}

/** 读每个已关联上游分组的真实账单（上游站点自己记的扣费）。同一个上游分组只读一次；10 分钟内读过的不重读。 */
async function loadBills(siteId: string, force: boolean) {
  const rep = state.adminLinks[siteId];
  const data = state.admin[siteId]?.data;
  if (!rep || !data) return;
  const byGroup = new Map<string, BillEntry | null>();
  const todo = rep.links.filter((l) => l.site_id && l.group_id && data.upstreams.some((u) => u.id === l.upstream_id));
  for (const l of todo) {
    const k = adminKey(siteId, "account", l.upstream_id);
    const cached = state.adminBill[k];
    if (!force && cached && Date.now() / 1000 - cached.at < COST_FRESH_MS / 1000) continue;
    state.billPending.add(k);
  }
  render();
  for (const l of todo) {
    const k = adminKey(siteId, "account", l.upstream_id);
    if (!state.billPending.has(k)) continue;
    const gk = `${l.site_id}|${l.group_id}`;
    try {
      if (!byGroup.has(gk)) {
        const u = await backend.groupUsage(l.site_id!, l.group_id!, force);
        byGroup.set(gk, { perM: u.cost_per_m_effective, c24: u.cost_24h ?? null, c24cap: u.tokens_24h_capped ?? false, t24: u.tokens_24h ?? null, currency: u.currency, at: u.fetched_at, reqs: u.total_requests, siteName: l.site_name ?? "", group: l.group ?? "" });
      }
      state.adminBill[k] = byGroup.get(gk)!;
    } catch {
      delete state.adminBill[k]; // 读不到就不显示（不退回估算）
    }
    state.billPending.delete(k);
    render();
  }
}

const adminKey = (siteId: string, scope: "group" | "account", id: string) => `${siteId}|${scope}|${id}`;

/**
 * 读取站长视角里每个下游分组和上游账号近 7 天的用量（首字时延、成本、缓存命中率），3 路并行；
 * 读到一个就更新一个，顶部显示进度。10 分钟内读过的不重复请求，`force`（点顶部刷新）全部重读；某个站点限流就停下。
 */
async function loadAdminUsage(siteId: string, force: boolean) {
  const data = state.admin[siteId]?.data;
  if (!data || state.adminLoading[siteId]) return;
  const all = [...data.downstreams.map((x) => ["group", x.id] as const), ...data.upstreams.map((x) => ["account", x.id] as const)];
  const list = all.filter(([sc, id]) => {
    const e = state.adminUsage[adminKey(siteId, sc, id)];
    return force || !e || Date.now() / 1000 - e.at > COST_FRESH_MS / 1000;
  });
  if (list.length === 0) return;
  state.adminLoading[siteId] = { done: 0, total: list.length, pending: new Set(list.map(([sc, id]) => adminKey(siteId, sc, id))) };
  render();
  let failed = "";
  let stop = false;
  let next = 0;
  const worker = async () => {
    while (next < list.length && !stop) {
      const [sc, id] = list[next++];
      const k = adminKey(siteId, sc, id);
      try {
        const u = await backend.adminUsage(siteId, sc, id, force);
        state.adminUsage[k] = { perM: u.cost_per_m_effective, offM: u.official_cost != null && u.effective_tokens > 0 ? (u.official_cost / u.effective_tokens) * 1e6 : null, currency: u.currency, at: u.fetched_at, frt: u.first_token_median_ms, frtN: u.first_token_samples, cache: u.cache_hit_rate, reqs: u.total_requests, t24: u.tokens_24h ?? null, t24cap: u.tokens_24h_capped ?? false, c24: u.cost_24h ?? null, o24: u.official_cost_24h ?? null };
      } catch (e) {
        failed = errText(e);
        if (failed.includes("站点限流")) stop = true;
      }
      const l = state.adminLoading[siteId];
      l.pending.delete(k);
      state.adminLoading[siteId] = { ...l, done: l.done + 1 };
      render();
      await new Promise((r) => setTimeout(r, 150));
    }
  };
  try {
    await Promise.all([worker(), worker(), worker()]);
  } finally {
    delete state.adminLoading[siteId];
    try {
      localStorage.setItem(ADMIN_USAGE_KEY, JSON.stringify(state.adminUsage));
    } catch {
      /* 无法写入就只在本次运行里有效 */
    }
    render();
  }
  void loadBills(siteId, force);
  if (failed) showToast("err", `部分用量没有读到：${failed}`);
}

function pencilIcon(): Node {
  const t = document.createElement("template");
  t.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20l1-4L16.5 4.5a2 2 0 0 1 3 3L8 19z"/><path d="M14 7l3 3"/></svg>';
  return t.content.firstChild!;
}

const PLATFORM_ORDER = ["anthropic", "openai", "gemini", "grok", "antigravity"];
const PLATFORM_LABEL: Record<string, string> = { anthropic: "Claude", openai: "OpenAI", gemini: "Gemini", grok: "Grok", antigravity: "Antigravity", other: "其他" };
const platformLabel = (p: string) => PLATFORM_LABEL[p] ?? p;

/**
 * 上游账号名称末尾写的倍率（如“Claude lingxu 特价 0.09”“pqh-Gemini-4a 0.72”）。
 * sub2api 的“账号倍率”默认是 1，站长通常没去改它，真实的上游价格系数只写在名称里；站点本身并不记录上游的真实倍率。
 */
/** 24 小时流水（金额，正数）：下游分组 = 用户实付；上游账号 = 上游站点自己记的真实扣费（没关联上游分组就没有，不估算）。 */
function flow24(scope: "group" | "account", e: CostEntry | undefined, bill: BillEntry | undefined): number | null {
  return scope === "group" ? (e?.c24 ?? null) : (bill?.c24 ?? null);
}

function nameRate(name: string): number | null {
  const m = name.trim().match(/(?:^|[\s\-_])(\d+(?:\.\d+)?)$/);
  const v = m ? Number(m[1]) : NaN;
  return Number.isFinite(v) && v > 0 && v <= 20 ? v : null;
}

const STATUS_TEXT = { active: "运行中", paused: "已暂停", error: "异常" } as const;

/** 暂停 / 移除这个上游，会让哪些下游分组失去它；其中没有别的运行中上游的，会直接无法使用。 */
function impactOf(data: AdminOverview, up: Upstream): { name: string; alone: boolean }[] {
  return up.groups.map((gid) => {
    const d = data.downstreams.find((x) => x.id === gid);
    const others = data.upstreams.filter((u) => u.id !== up.id && u.status === "active" && u.groups.includes(gid)).length;
    return { name: d?.name ?? gid, alone: others === 0 };
  });
}

function plusIcon(): Node {
  const t = document.createElement("template");
  t.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
  return t.content.firstChild!;
}

function openCreateGroup(siteId: string) {
  const kind = state.sites.find((x) => x.id === siteId)?.kind ?? "sub2api";
  state.dialog = { type: "admin-create-group", siteId, kind, name: "", description: "", platform: "anthropic", rate: "1", busy: false, error: "" };
  render();
  document.getElementById("cg-name")?.focus();
}

async function submitCreateGroup(d: AdminCreateGroupDialog) {
  const rate = Number(d.rate);
  if (!d.name.trim()) { d.error = "名称不能为空"; render(); return; }
  if (d.rate.trim() === "" || !Number.isFinite(rate) || rate <= 0) { d.error = "倍率必须是大于 0 的数字"; render(); return; }
  d.busy = true;
  d.error = "";
  render();
  try {
    const id = await backend.adminCreateGroup(d.siteId, { name: d.name.trim(), description: d.description.trim() || undefined, platform: d.kind === "sub2api" ? d.platform : undefined, rate_multiplier: rate });
    showToast("ok", `已创建下游分组「${d.name.trim()}」，接着给它添加上游`);
    await loadAdmin(d.siteId);
    const down = state.admin[d.siteId]?.data?.downstreams.find((x) => x.id === id);
    if (down) openAddUpstream(d.siteId, down);
    else state.dialog = null;
    render();
  } catch (e) {
    d.busy = false;
    d.error = errText(e);
    render();
  }
}

/** 可以当上游的站点：应用里已添加的、不是这个站长站点自己的。 */
const upstreamSites = (siteId: string) => state.sites.filter((x) => x.id !== siteId);
/** 某个站点里你能用的分组（用来选“上游分组”）。 */
const groupsOfSite = (sid: string) => state.groups.filter((g) => g.site_id === sid).sort((a, b) => a.name.localeCompare(b.name));

/** 某个站点某个分组支持的模型（已知的，聊天类）。 */
function modelsForGroup(siteId: string, groupId: string): string[] {
  const gv = state.groups.find((x) => x.site_id === siteId && x.id === groupId);
  return gv ? modelsOf(gv).filter((m) => !/image|embed|tts|whisper|rerank/.test(m)) : [];
}

/** 账号状态页：点一下立即把“状态”或“调度”改到站点上，再重新读一次。 */
async function setAccountState(d: AdminAddUpstreamDialog, change: { status?: "active" | "inactive"; schedulable?: boolean }) {
  if (!d.replace) return;
  d.busy = true;
  d.error = "";
  render(true);
  try {
    await backend.adminSetAccountState(d.siteId, d.replace.id, change.status, change.schedulable);
    await loadAdmin(d.siteId);
  } catch (e) {
    d.error = errText(e);
  }
  d.busy = false;
  render(true);
}

/** 编辑上游账号：和“给下游分组添加上游”同一个弹窗（更换它的上游分组来源，左侧还有“账号状态”可以快速改状态 / 调度）。 */
function editUpstream(siteId: string, u: Upstream) {
  const dn = state.admin[siteId]?.data?.downstreams.find((g) => u.groups.includes(g.id)) ?? { id: "", name: "", description: null, platform: u.platform, rate_multiplier: 1, status: "active", editable: false };
  openAddUpstream(siteId, dn, u);
}

function openAddUpstream(siteId: string, down: Downstream, replace: Upstream | null = null) {
  // 更换来源时先选中它现在对应的上游站点和分组（关联里记着的）
  const cur = replace ? state.adminLinks[siteId]?.links.find((l) => l.upstream_id === replace.id) : undefined;
  const first = (cur?.site_id ? upstreamSites(siteId).find((x) => x.id === cur.site_id && x.connected) : undefined) ?? upstreamSites(siteId).find((x) => x.connected);
  // 已关联的用关联的分组；还没关联但有推荐（名称里的倍率对得上）的，预选推荐的
  const gid = cur?.group_id && first?.id === cur.site_id ? cur.group_id : cur?.suggested && first?.id === cur.site_id ? cur.suggested.id : first ? (groupsOfSite(first.id)[0]?.id ?? "") : "";
  const d: AdminAddUpstreamDialog = { type: "admin-add-upstream", siteId, down, upSiteId: first?.id ?? "", groupId: gid, name: replace?.name ?? "", nameEdited: !!replace, paused: true, busy: false, error: "", done: null, replace, dupOk: false, testModel: "", tab: "source" };
  defaultUpstreamName(d);
  state.dialog = d;
  render();
}

/** 这个上游分组是不是已经有别的上游账号在用（关联里记着）：再添加会和它共用同一把上游 Key。 */
function upstreamDuplicate(d: AdminAddUpstreamDialog): string | null {
  const l = state.adminLinks[d.siteId]?.links.find((x) => x.site_id === d.upSiteId && x.group_id === d.groupId && x.upstream_id !== d.replace?.id);
  if (!l) return null;
  return state.admin[d.siteId]?.data?.upstreams.find((u) => u.id === l.upstream_id)?.name ?? l.upstream_id;
}

function defaultUpstreamName(d: AdminAddUpstreamDialog) {
  if (d.nameEdited) return;
  const site = state.sites.find((x) => x.id === d.upSiteId);
  const g = state.groups.find((x) => x.site_id === d.upSiteId && x.id === d.groupId);
  d.name = site && g ? `${site.name}-${g.name}${upstreamDuplicate(d) ? " (2)" : ""}` : "";
}

async function submitAddUpstream(d: AdminAddUpstreamDialog) {
  if (!d.upSiteId || !d.groupId) { d.error = "请选择上游站点和分组"; render(); return; }
  if (!d.name.trim()) { d.error = "名称不能为空"; render(); return; }
  if (!d.replace && upstreamDuplicate(d) && !d.dupOk) { d.error = "请先勾选“我知道会共用同一把上游 Key，仍然添加”"; render(); return; }
  d.busy = true;
  d.error = "";
  render();
  try {
    d.done = d.replace
      ? await backend.adminReplaceUpstream(d.siteId, d.replace.id, d.upSiteId, d.groupId, d.name.trim() === d.replace.name ? undefined : d.name.trim(), d.testModel || undefined)
      : await backend.adminAddUpstream(d.siteId, d.down.id, d.upSiteId, d.groupId, d.name.trim(), true, d.dupOk, d.testModel || undefined);
    d.busy = false;
    render();
    void loadAdmin(d.siteId); // 新上游和关联马上出现在列表里（对话框保持打开，显示结果）
  } catch (e) {
    d.busy = false;
    d.error = errText(e);
    render();
  }
}

async function resumeAdded(d: AdminAddUpstreamDialog) {
  if (!d.done) return;
  d.busy = true;
  render();
  try {
    await backend.adminSetPaused(d.siteId, d.done.upstream_id, false);
    d.done = { ...d.done, paused: false };
    showToast("ok", `已启用上游「${d.done.name}」`);
    void loadAdmin(d.siteId);
  } catch (e) {
    d.error = `启用失败：${errText(e)}`;
  }
  d.busy = false;
  render();
}

function askRemoveGroup(siteId: string, g: Downstream) {
  const ups = state.admin[siteId]?.data?.upstreams.filter((u) => u.groups.includes(g.id)) ?? [];
  state.dialog = { type: "admin-remove-group", siteId, g, ups, busy: false, error: "" };
  render();
}

async function submitRemoveGroup(d: AdminRemoveGroupDialog) {
  d.busy = true;
  d.error = "";
  render();
  try {
    await backend.adminRemoveGroup(d.siteId, d.g.id);
    state.dialog = null;
    showToast("ok", `已删除下游分组「${d.g.name}」`);
    await loadAdmin(d.siteId);
    void loadDownstreamRefs();
  } catch (e) {
    d.busy = false;
    d.error = errText(e);
    render();
  }
}

function askRemove(siteId: string, up: Upstream) {
  state.dialog = { type: "admin-remove", siteId, up, typed: "", busy: false, error: "" };
  render();
}

function openGroupEdit(siteId: string, g: Downstream) {
  const kind = state.sites.find((x) => x.id === siteId)?.kind ?? "sub2api";
  state.dialog = { type: "group-edit", siteId, kind, g, name: g.name, description: g.description ?? "", platform: g.platform, rate: String(g.rate_multiplier), step: "form", busy: false, error: "" };
  render();
  document.getElementById("ge-name")?.focus();
}

/** 表单里改了什么（和原值比），没改的字段不发给站点。 */
function groupDiff(d: GroupEditDialog): GroupEdit {
  const e: GroupEdit = {};
  if (d.name.trim() !== d.g.name) e.name = d.name.trim();
  if (d.description.trim() !== (d.g.description ?? "")) e.description = d.description.trim();
  if (d.kind === "sub2api" && d.platform !== d.g.platform) e.platform = d.platform;
  const r = Number(d.rate);
  if (d.rate.trim() !== "" && r !== d.g.rate_multiplier) e.rate_multiplier = r;
  return e;
}
function groupProblem(d: GroupEditDialog): string {
  if (!d.name.trim()) return "名称不能为空";
  const r = Number(d.rate);
  if (d.rate.trim() === "" || !Number.isFinite(r) || r <= 0) return "倍率必须是大于 0 的数字";
  return "";
}

async function submitGroupEdit(d: GroupEditDialog) {
  d.busy = true;
  d.error = "";
  render();
  try {
    await backend.adminUpdateGroup(d.siteId, d.g.id, groupDiff(d));
    state.dialog = null;
    showToast("ok", `已修改分组「${d.g.name}」`);
    await loadAdmin(d.siteId);
    void refreshAll(0, { models: false, costs: false }); // 名称 / 倍率变了，普通分组列表也要更新
  } catch (e) {
    d.busy = false;
    d.error = errText(e);
    render();
  }
}

async function submitUpstreamOp(d: AdminConfirmDialog) {
  d.busy = true;
  d.error = "";
  render();
  try {
    if (d.type === "admin-pause") await backend.adminSetPaused(d.siteId, d.up.id, true);
    else await backend.adminRemoveUpstream(d.siteId, d.up.id);
    state.dialog = null;
    showToast("ok", d.type === "admin-pause" ? `已暂停上游「${d.up.name}」，随时可以恢复` : `已移除上游「${d.up.name}」`);
    await loadAdmin(d.siteId);
  } catch (e) {
    d.busy = false;
    d.error = errText(e);
    render();
  }
}

/** 有问题的下游分组（id → 说明）：没有来源上游、没有运行中的上游，或来源里有状态异常的上游。 */
function adminProblems(d: AdminOverview): Map<string, string> {
  const m = new Map<string, string>();
  for (const x of d.downstreams) {
    const ups = d.upstreams.filter((u) => u.groups.includes(x.id));
    const bad = ups.find((u) => u.status === "error");
    if (ups.length === 0) m.set(x.id, "没有来源的上游");
    else if (!ups.some((u) => u.status === "active")) m.set(x.id, "没有运行中的上游");
    else if (bad) m.set(x.id, `上游「${bad.name}」异常`);
  }
  return m;
}

/** 站长站点的概览（轻量：只读上下游列表，不读用量和关联），让左侧卡片上的红点数量不用点进去也有。 */
async function loadAdminLight(siteId: string) {
  if (state.admin[siteId]?.data || state.admin[siteId]?.status === "loading") return;
  try {
    state.admin[siteId] = { status: "ready", data: await backend.adminOverview(siteId) };
    render();
  } catch {
    /* 读不到就不显示数量 */
  }
}

function viewOperator(siteId: string): HTMLElement {
  const site = state.sites.find((x) => x.id === siteId)!;
  const a = state.admin[siteId];
  const data = a?.data;
  const head = el(
    "div",
    { class: "op-head" },
    el("div", {}, el("h2", {}, site.name)),
    el(
      "div",
      { class: "op-actions" },
      state.adminLoading[siteId] ? el("span", { class: "cost-progress", "data-testid": "op-progress", "data-tip": "正在读取每个下游分组和上游账号近 7 天的用量（首字时延、成本、缓存命中率），读到一个就更新一个" }, `读取用量 ${state.adminLoading[siteId].done}/${state.adminLoading[siteId].total}`) : null,
      el("button", { class: "ghost", "data-testid": "op-new-group", onClick: () => openCreateGroup(siteId) }, "新建下游分组"),
    ),
  );
  if (!a || (a.status === "loading" && !data)) return el("div", {}, head, el("div", { class: "panel muted", "data-testid": "op-loading" }, "正在读取上下游…"));
  if (a.status === "error" && !data) return el("div", {}, head, el("div", { class: "panel error-panel", "data-testid": "op-error" }, el("p", {}, `读取失败：${a.error}`), el("button", { class: "primary", onClick: () => void loadAdmin(siteId) }, "重试")));
  const d = data!;
  const byId = new Map(d.downstreams.map((x) => [x.id, x]));
  // 各列都能点标题排序（再点一次反向）；默认按 24h Token 从高到低
  type OpCol = typeof state.opSort.col;
  const sortBtn = (col: OpCol, label: string, tip?: string) => {
    const on = state.opSort.col === col;
    const t = document.createElement("template");
    t.innerHTML = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="${on ? "on" : ""} ${on && state.opSort.dir === "desc" ? "desc" : "asc"}"><path d="M12 5v14"/><path d="M6.5 12.5 12 19l5.5-6.5"/></svg>`;
    return el(
      "button",
      {
        class: `col-head sortable${on ? " on" : ""}`,
        "data-testid": `op-sort-${col}`,
        ...(tip ? { "data-tip": tip } : {}),
        onClick: () => {
          state.opSort = on ? { col, dir: state.opSort.dir === "desc" ? "asc" : "desc" } : { col, dir: col === "name" ? "asc" : "desc" };
          render(true);
        },
      },
      label,
      t.content.firstChild!,
    );
  };
  const listHead = el(
    "div",
    { class: "card list-head", "data-testid": "op-list-head" },
    el("div", { class: "card-main" }, sortBtn("name", "下游分组 / 来源上游")),
    el("div", { class: "cell-speed" }, sortBtn("speed", "首字时延")),
    el("div", { class: "cell-rate" }, sortBtn("rate", "倍率")),
    el("div", { class: "cell-cost" }, sortBtn("cost", "平均成本")),
    el("div", { class: "cell-cache" }, sortBtn("cache", "缓存命中率")),
    el("div", { class: "cell-tokens" }, sortBtn("tokens", "24h流水", "过去 24 小时的流水，看每个分组的盈利：下游分组显示 + 用户付给你的钱，上游账号显示 - 你付给上游的真实成本（上游站点自己记的扣费，需先关联上游分组）；默认按金额从大到小排序")),
    el("div", { class: "cell-models" }, sortBtn("models", "模型")),
    el("div", { class: "card-action two" }),
  );
  const loading = state.adminLoading[siteId];
  // 一行里的五个数据列（首字时延、倍率、Token成本、缓存命中率、模型），下游分组和上游账号共用同一套：读不到的显示 —，正在读的显示“读取中…”
  const metricCells = (scope: "group" | "account", id: string, rate: number | null, models: string[], rateHint: number | null = null, linkInfo: { link: UpstreamLink; open: () => void } | null = null, hintHost: string | null = null): HTMLElement[] => {
    const k = adminKey(siteId, scope, id);
    const e = state.adminUsage[k];
    const pending = loading?.pending.has(k) ?? false;
    const dash = (what: string, txt = "—") => el("span", { class: `muted small ${pending ? "reading" : "empty"}`, "data-testid": `${scope}-${what}-${id}` }, pending ? "读取中…" : txt);
    const costTip = scope === "group" ? "近 7 天所有用户为这个分组实际支付 ÷ 有效 Token（输入+输出）× 100 万，是你的收入口径" : state.sites.find((x) => x.id === siteId)?.kind === "newapi" ? "近 7 天经过这个渠道的调用，用户支付的额度 ÷ 有效 Token × 100 万。new-api 不记录上游收了你多少，这不是上游成本" : "近 7 天这个上游账号的成本（官方价 × 账号倍率）÷ 有效 Token（输入+输出）× 100 万，是你付给上游的成本";
    const frt = e?.frt ?? null;
    const cache = cacheShown(e);
    const bill = scope === "account" ? state.adminBill[k] : undefined;
    const billPending = scope === "account" && state.billPending.has(k);
    return [
      el("div", { class: "cell-speed" }, frt !== null ? el("span", { class: "pill", "data-tip": `真实首字时延（近 7 天 ${e!.frtN} 个请求的中位数，来自站点的使用记录）`, "data-testid": `${scope}-speed-${id}` }, `${(frt / 1000).toFixed(2)}s`) : dash("speed")),
      el(
        "div",
        { class: "cell-rate" },
        linkInfo
          ? (() => {
              const l = linkInfo.link;
              // 已经关联好的确定倍率：只是显示，不可点（要换来源去右边的编辑）
              if (l.rate !== null) return el("span", { class: "rate linked", "data-tip": `上游站点「${l.site_name}」的分组「${l.group}」当前的倍率（实时读取）。要更换来源，点右边的编辑图标`, "data-testid": `${scope}-rate-${id}` }, `×${l.rate}`);
              if (l.suggested) return el("button", { class: "rate hint", "data-tip": `推荐关联「${l.site_name}」的分组「${l.suggested.name}」（×${l.suggested.rate}）：账号名称里的倍率和它相同。点击打开编辑，确认或另选`, "data-testid": `${scope}-rate-${id}`, onClick: linkInfo.open }, `×${l.suggested.rate}?`);
              return el("button", { class: "rate hint", "data-tip": l.note ?? `点击打开编辑，选择这个上游账号用的是「${l.site_name}」里的哪个分组，就能读到真实倍率`, "data-testid": `${scope}-rate-${id}`, onClick: linkInfo.open }, "关联");
            })()
          : rateHint !== null
          ? el("button", { class: "rate hint", "data-tip": "按账号名称末尾的数字推测的上游倍率，仅供参考,可关联真实上游的分组，实现倍率监控", "data-testid": `${scope}-rate-${id}`, onClick: () => (hintHost ? openAdd(null, hintHost) : undefined) }, `×${rateHint}`)
          : rate !== null
            ? el("span", { class: "rate", "data-tip": scope === "account" ? "站点里这个上游账号的计费倍率设置：你付给上游的价 = 官方价 × 它。如果和实际不符，请在站点后台把账号倍率改成上游的真实倍率" : "这个分组的计费倍率", "data-testid": `${scope}-rate-${id}` }, `×${rate}`)
            : dash("rate"),
      ),
      el(
        "div",
        { class: "cell-cost" },
        // 上游账号：真实账单 = 上游站点自己记的扣费（关联的那个分组，近 7 天实付 ÷ 有效 Token × 100 万）；没关联就没有，不估算
        scope === "account"
          ? bill && bill.perM !== null
            ? el("span", { class: "rate", "data-tip": `真实账单：你在上游站点「${bill.siteName}」的分组「${bill.group}」近 7 天实际被扣的钱 ÷ 有效 Token（输入+输出）× 100 万。来自上游站点自己的用量记录，不是估算；如果你的账号在这个分组里还有别的 Key 在用，这里也包含它们；取数于 ${fullTime(bill.at)}`, "data-testid": `${scope}-cost-${id}` }, money(bill.currency, bill.perM))
            : billPending
              ? dash("cost")
              : dash("cost", linkInfo?.link.group_id ? "无用量" : "未关联")
          : e && e.perM !== null
            ? el("span", { class: "rate", "data-tip": `${costTip}；取数于 ${fullTime(e.at)}`, "data-testid": `${scope}-cost-${id}` }, money(e.currency, e.perM))
            : dash("cost", e ? "无用量" : "—"),
      ),
      el(
        "div",
        { class: "cell-cache" },
        cache !== null
          ? el("span", { class: "pill", "data-tip": CACHE_NOTE, "data-testid": `${scope}-cache-${id}` }, pct(cache))
          : dash("cache", e && e.reqs !== undefined && e.reqs < MIN_CACHE_REQUESTS ? "无有效统计" : "—"),
      ),
      el(
        "div",
        { class: "cell-tokens" },
        (() => {
          const fl = flow24(scope, e, bill);
          if (fl === null) return billPending ? dash("tokens") : dash("tokens", scope === "account" && !bill ? "未关联" : "—");
          const t24 = scope === "group" ? e?.t24 : bill?.t24;
          const cap = scope === "group" ? e?.t24cap : bill?.c24cap;
          const tokens = t24 != null ? `Token ${cap ? "≥" : ""}${fmtTok(t24)}（输入+输出+缓存）` : "";
          const note = cap ? "；记录太多，只统计了最近的一部分，实际更大" : "";
          const cur = scope === "group" ? e!.currency : bill!.currency;
          const tip = scope === "group" ? `过去 24 小时用户为这个分组支付的钱（你的收入）；${tokens}${note}` : `真实账单：过去 24 小时你在上游站点「${bill!.siteName}」的分组「${bill!.group}」实际被扣的钱（你付给上游的成本）；${tokens}${note}`;
          return el("span", { class: `pill flow ${scope === "group" ? "in" : "out"}`, "data-tip": tip, "data-testid": `${scope}-tokens-${id}` }, `${scope === "group" ? "+" : "-"}${cap ? "≥" : ""}${money(cur, fl)}`);
        })(),
      ),
      el("div", { class: "cell-models" }, models.length ? el("span", { class: "pill", "data-tip": modelTip(models), "data-tip-mono": "1", "data-testid": `${scope}-models-${id}` }, `${models.length} 个模型`) : dash("models")),
    ];
  };
  const upsOf = (gid: string) => d.upstreams.filter((u) => u.groups.includes(gid));
  const downRow = (x: Downstream): HTMLElement => {
    // 下游分组的模型 = 它来源的各个上游支持的模型的并集
    const models = [...new Set(upsOf(x.id).flatMap((u) => u.model_names))].sort();
    return el(
      "div",
      { class: "card down-row", "data-testid": `down-${x.id}` },
      el("div", { class: "card-main" }, el("h3", { ...(x.description ? { "data-tip": x.description } : {}), "data-testid": `down-name-${x.id}` }, x.name)),
      ...metricCells("group", x.id, x.rate_multiplier, models),
      el(
        "div",
        { class: "card-action two" },
        el("button", { class: "act-btn", "aria-label": "添加上游", "data-tip": "给这个下游分组添加上游：自动在上游站点建 Key，并在你的站点创建上游账号", "data-testid": `down-addup-${x.id}`, onClick: () => openAddUpstream(siteId, x) }, plusIcon()),
        el("button", { class: "act-btn danger", "aria-label": "删除分组", "data-tip": "删除这个下游分组（绑在上面的上游账号不会被删）", "data-testid": `down-remove-${x.id}`, onClick: () => askRemoveGroup(siteId, x) }, trashIcon()),
        el("button", { class: "act-btn", "aria-label": "编辑分组", "data-tip": x.editable ? "编辑名称、备注、分类、倍率" : "当前账号没有修改分组的权限（new-api 的分组设置只有超级管理员能改）", "data-testid": `down-edit-${x.id}`, disabled: !x.editable, onClick: () => openGroupEdit(siteId, x) }, pencilIcon()),
      ),
    );
  };
  // 上游行：名称 + 状态 + 它的站点（地址主机名）；不显示客户端类型，也不写“服务几个分组”
  const upRow = (u: Upstream): HTMLElement =>
    el(
      "div",
      { class: `card up-row st-${u.status}`, "data-testid": `up-${u.id}` },
      el("div", { class: "card-main" }, el("h3", {}, u.name, el("span", { class: `up-status s-${u.status}`, "data-testid": `up-status-${u.id}`, ...(u.error ? { "data-tip": u.error } : {}) }, u.status === "error" && failLabel(u.error ?? "") !== "失败" ? `异常 · ${failLabel(u.error ?? "")}` : STATUS_TEXT[u.status]))),
      ...metricCells("account", u.id, u.rate_multiplier, u.model_names, u.rate_multiplier === null || u.rate_multiplier === 1 ? nameRate(u.name) : null, (() => {
        const l = state.adminLinks[siteId]?.links.find((x) => x.upstream_id === u.id);
        return l && l.site_id ? { link: l, open: () => editUpstream(siteId, u) } : null;
      })(), u.host),
      el(
        "div",
        { class: "card-action two" },
        el("button", { class: "act-btn", "aria-label": "sayhi 测试", "data-tip": "sayhi 测试：用这个上游关联的上游分组，选一个模型说一句 hi，看回复和延迟（要先关联上游分组：点倍率格子）", "data-testid": `up-sayhi-${u.id}`, onClick: () => {
          const l = state.adminLinks[siteId]?.links.find((x) => x.upstream_id === u.id);
          if (!l?.site_id || !l.group_id) { showToast("err", "先关联这个上游账号用的上游分组（点它的倍率格子），才能 sayhi 测试"); return; }
          const gv = state.groups.find((g) => g.site_id === l.site_id && g.id === l.group_id);
          if (!gv) { showToast("err", `在应用里找不到上游站点「${l.site_name}」的分组「${l.group}」，先刷新一下`); return; }
          openSayHi(gv);
        } }, bubbleIcon()),
        el("button", { class: "act-btn", "aria-label": "编辑上游", "data-tip": `编辑这个上游账号：更换它用的是哪个上游站点的哪个分组（现在用的是 ${u.host ?? "未知站点"} 的 Key），或快速修改它的状态、调度`, "data-testid": `up-edit-${u.id}`, onClick: () => editUpstream(siteId, u) }, pencilIcon()),
        el("button", { class: "act-btn danger", "aria-label": "移除", "data-tip": "移除这个上游账号（不可恢复）", "data-testid": `up-remove-${u.id}`, onClick: () => askRemove(siteId, u) }, trashIcon()),
      ),
    );
  // 以下游分组为主：每个下游分组一个色块，块里缩进的是它来源的上游账号；同一个上游服务多个分组时，在每个色块里各出现一次
  // 客户端 tab（按分组的平台分类，参考 sub2api）：每个 tab 旁边一个点，有问题的分组就是红点 + 数量，没问题是绿点
  const tabKey = (platform: string) => platform || "other";
  const problems = adminProblems(d); // 下游分组 id -> 问题说明
  const keys = [...new Set([...d.downstreams.map((x) => tabKey(x.platform)), ...d.upstreams.map((u) => tabKey(u.platform))])];
  keys.sort((p, q) => (PLATFORM_ORDER.indexOf(p) + 1 || 99) - (PLATFORM_ORDER.indexOf(q) + 1 || 99));
  const cur = state.opTab[siteId] && keys.includes(state.opTab[siteId]) ? state.opTab[siteId] : "all";
  const inTab = (platform: string) => cur === "all" || tabKey(platform) === cur;
  const tabBtn = (key: string, label: string) => {
    const groups = d.downstreams.filter((x) => key === "all" || tabKey(x.platform) === key);
    const bad = groups.filter((x) => problems.has(x.id));
    return el(
      "button",
      { class: `op-tab${cur === key ? " on" : ""}`, "data-testid": `op-tab-${key}`, onClick: () => { state.opTab[siteId] = key; render(true); } },
      label,
      el("span", { class: `tab-dot ${bad.length ? "bad" : "ok"}`, "data-testid": `op-dot-${key}`, "data-tip": bad.length ? `${bad.length} 个分组有问题：\n${bad.map((x) => `${x.name} —— ${problems.get(x.id)}`).join("\n")}` : "这里的分组都正常" }),
      bad.length ? el("span", { class: "tab-n", "data-testid": `op-n-${key}` }, String(bad.length)) : null,
    );
  };
  const tabs = el("div", { class: "op-tabs", "data-testid": "op-tabs" }, tabBtn("all", "全部"), ...keys.map((k) => tabBtn(k, platformLabel(k))));
  // 排序：色块按下游分组的值排，块里的上游账号按它们自己的值排；没有数据的排最后
  const sortVal = (scope: "group" | "account", id: string, name: string, rate: number | null, modelCount: number): number | string | null => {
    const e = state.adminUsage[adminKey(siteId, scope, id)];
    switch (state.opSort.col) {
      case "name": return name;
      case "speed": return e?.frt ?? null;
      case "rate": return rate;
      case "cost": return scope === "account" ? (state.adminBill[adminKey(siteId, scope, id)]?.perM ?? null) : (e?.perM ?? null);
      case "cache": return cacheShown(e);
      case "tokens": return flow24(scope, e, scope === "account" ? state.adminBill[adminKey(siteId, scope, id)] : undefined);
      default: return modelCount;
    }
  };
  const cmp = (a: number | string | null, b: number | string | null) => {
    if (a === null && b === null) return 0;
    if (a === null) return 1;
    if (b === null) return -1;
    const r = typeof a === "string" || typeof b === "string" ? String(a).localeCompare(String(b)) : a - b;
    return state.opSort.dir === "asc" ? r : -r;
  };
  const modelsOfDown = (x: Downstream) => new Set(upsOf(x.id).flatMap((u) => u.model_names)).size;
  const sortedDowns = d.downstreams.filter((x) => inTab(x.platform)).sort((a, b) => cmp(sortVal("group", a.id, a.name, a.rate_multiplier, modelsOfDown(a)), sortVal("group", b.id, b.name, b.rate_multiplier, modelsOfDown(b))));
  const sortUps = (list: Upstream[]) => [...list].sort((a, b) => cmp(sortVal("account", a.id, a.name, a.rate_multiplier, a.model_names.length), sortVal("account", b.id, b.name, b.rate_multiplier, b.model_names.length)));
  const blocks = sortedDowns.map((x, i) => {
    const ups = sortUps(upsOf(x.id));
    return el("div", { class: "op-block", style: `--h:${BLOCK_HUES[i % BLOCK_HUES.length]}`, "data-testid": `down-block-${x.id}` }, downRow(x), ...(ups.length ? ups.map(upRow) : [el("p", { class: "muted small op-empty" }, "这个分组没有来源的上游（调用会失败，需要在站点后台给它加上游）")]));
  });
  const orphans = d.upstreams.filter((u) => u.groups.every((gid) => !byId.has(gid)) && inTab(u.platform));
  if (orphans.length) blocks.push(el("div", { class: "op-block orphan", "data-testid": "up-block-orphan" }, el("p", { class: "muted small op-empty" }, "没有服务任何下游分组的上游账号"), ...sortUps(orphans).map(upRow)));
  return el(
    "div",
    {},
    head,
    tabs,
    state.adminLinks[siteId]?.missing_hosts.length
      ? el(
          "div",
          { class: "banner info op-missing", "data-testid": "op-missing" },
          el("strong", {}, "这些上游站点还没有添加你的账号："),
          ...state.adminLinks[siteId]!.missing_hosts.map((h) => el("span", { class: "missing-host" }, el("span", { class: "site-tag" }, h), el("button", { class: "ghost small-btn", "data-testid": `op-add-${h}`, onClick: () => openAdd(null, h) }, "添加"))),
          el("span", { class: "muted small" }, "把你在上游站点的账号添加进来，就能读到上游账号用的分组的真实倍率和余额；添加后回到这里给每个上游账号选一次分组。"),
        )
      : null,
    a.status === "error" ? el("div", { class: "banner warn", "data-testid": "op-stale" }, `刷新失败，下面是之前读到的数据：${a.error}`) : null,
    el("div", { class: "list op-list", "data-testid": "op-list" }, listHead, ...(blocks.length ? blocks : [el("div", { class: "panel", "data-testid": "op-empty" }, "这个站点还没有上游账号和分组。")])),
  );
}

const isMenuDialog = (d: { type: string }): d is SayHiDialog | EditClientsDialog | MakeDownstreamDialog => d.type === "sayhi" || d.type === "edit-clients" || d.type === "make-downstream";

/** 分组行“…”菜单里的三个对话框：sayhi 测试、修改支持的客户端、创建下游分组。 */
function viewMenuDialog(d: SayHiDialog | EditClientsDialog | MakeDownstreamDialog): HTMLElement {
  const close = () => {
    if (d.busy) return;
    state.dialog = null;
    render();
  };
  if (d.type === "sayhi") {
    return el(
      "div",
      { class: "modal-mask", "data-testid": "sayhi-dialog" },
      el(
        "div",
        { class: "modal wide", role: "dialog" },
        el("h3", {}, `sayhi 测试 · ${d.g.name}`),
        el("p", { class: "muted small" }, `用这个分组的 Key，通过 ${CLIENTS[d.client].name} 的协议对选定的模型说一句“hi”，看它怎么回和多快。每点一次发一次请求，会消耗极少量额度。`),
        el(
          "div",
          { class: "form" },
          el("label", { for: "sh-model" }, "模型"),
          d.models.length
            ? el("select", { id: "sh-model", "data-testid": "sh-model", disabled: d.busy, onChange: (e: Event) => (d.model = (e.target as HTMLSelectElement).value) }, ...d.models.map((m) => el("option", { value: m, selected: m === d.model }, m)))
            : el("p", { class: "muted small" }, "还不知道这个分组有哪些模型：直接发送，会用默认模型。"),
        ),
        d.results.length
          ? el(
              "div",
              { class: "sayhi-results", "data-testid": "sayhi-results" },
              ...d.results.map((r, i) =>
                el(
                  "div",
                  { class: "sayhi-item", "data-testid": `sayhi-result-${i}` },
                  el("div", { class: "sayhi-meta" }, el("span", { class: "mono" }, r.model), el("span", { class: "pill" }, `首字 ${(r.first_ms / 1000).toFixed(2)}s`), el("span", { class: "pill" }, `总耗时 ${(r.total_ms / 1000).toFixed(2)}s`), r.input_tokens != null ? el("span", { class: "muted small" }, `输入 ${r.input_tokens} Token`) : null),
                  el("div", { class: "sayhi-reply" }, r.reply || "（没有文字回复）"),
                ),
              ),
            )
          : null,
        el("div", { class: "error", role: "alert", "data-testid": "sh-error" }, d.error),
        el("div", { class: "modal-actions" }, el("button", { type: "button", class: "ghost", "data-testid": "sh-close", onClick: close }, "关闭"), el("button", { type: "button", class: "primary", "data-testid": "sh-send", disabled: d.busy, onClick: () => void runSayHi(d) }, d.busy ? "发送中…" : d.results.length ? "再说一次" : "说 hi")),
      ),
    );
  }
  if (d.type === "edit-clients") {
    const all: ClientId[] = CLIENT_ORDER;
    return el(
      "div",
      { class: "modal-mask", "data-testid": "clients-dialog" },
      el(
        "div",
        { class: "modal wide", role: "dialog" },
        el("h3", {}, `修改分组 · ${d.g.name}`),
        el("p", { class: "muted small" }, "这个分组可以配置到哪些客户端（可多选）。只影响应用里它出现在哪些客户端下、能不能一键配置；站点上的分组不会变。"),
        el(
          "div",
          { class: "form" },
          ...all.map((c) => el("label", { class: "check-row" }, el("input", { type: "checkbox", checked: d.selected.includes(c), disabled: d.busy, "data-testid": `ec-${c}`, onChange: (e: Event) => { d.selected = (e.target as HTMLInputElement).checked ? [...d.selected, c] : d.selected.filter((x) => x !== c); } }), CLIENTS[c].name)),
        ),
        el("div", { class: "error", role: "alert", "data-testid": "ec-error" }, d.error),
        el(
          "div",
          { class: "modal-actions" },
          el("button", { type: "button", class: "ghost", "data-testid": "ec-reset", disabled: d.busy, onClick: () => void saveClients(d, []) }, "恢复默认"),
          el("button", { type: "button", class: "ghost", "data-testid": "ec-cancel", disabled: d.busy, onClick: close }, "取消"),
          el("button", { type: "button", class: "primary", "data-testid": "ec-save", disabled: d.busy, onClick: () => { if (d.selected.length === 0) { d.error = "至少选一个客户端（想用站点给的默认分类，点“恢复默认”）"; render(); } else void saveClients(d, CLIENT_ORDER.filter((c) => d.selected.includes(c))); } }, d.busy ? "保存中…" : "保存"),
        ),
      ),
    );
  }
  // make-downstream
  const admins = state.sites.filter((x) => x.is_admin && x.id !== d.g.site_id);
  const own = state.sites.find((x) => x.id === d.siteId);
  if (d.done) {
    const r = d.done.added;
    return el(
      "div",
      { class: "modal-mask", "data-testid": "makedown-dialog" },
      el(
        "div",
        { class: "modal wide", role: "dialog" },
        el("h3", {}, "已创建下游分组"),
        el("ul", { class: "diff-list", "data-testid": "makedown-result" }, el("li", {}, `在「${own?.name ?? ""}」创建了下游分组「${d.name.trim()}」（×${d.rate}）`), el("li", {}, `把「${d.g.site_name}」的「${d.g.name}」添加为它的上游：${r.key_created ? "新建了" : "复用了"}专用 Key，读到 ${r.models} 个模型，试一次首字 ${(r.probe_ms / 1000).toFixed(2)}s，链路是通的`), el("li", {}, r.paused ? "上游现在是暂停状态，不会接收用户请求：确认没问题后到“我的中转站”里点“恢复”启用" : "上游已经启用，正在参与调度"), el("li", {}, "上游分组底下已经显示这个下游分组")),
        el("div", { class: "modal-actions" }, el("button", { type: "button", class: "primary", "data-testid": "md-done", onClick: close }, "完成")),
      ),
    );
  }
  return el(
    "div",
    { class: "modal-mask", "data-testid": "makedown-dialog" },
    el(
      "form",
      { class: "modal wide", role: "dialog", onSubmit: (ev: Event) => { ev.preventDefault(); if (!d.busy && admins.length) void submitMakeDownstream(d); } },
      el("h3", {}, `基于「${d.g.name}」创建下游分组`),
      admins.length === 0
        ? el("div", { class: "form" }, el("p", {}, "还没有你的中转站：登录站点时勾选“我是该站点管理员”，才能在它上面创建下游分组。"), el("button", { type: "button", class: "primary", "data-testid": "md-add-site", onClick: () => { state.dialog = null; openAdd(); } }, "添加我的中转站"))
        : el(
            "div",
            { class: "form" },
            el("label", { for: "md-site" }, "中转站（在哪个站点创建下游分组）"),
            el("select", { id: "md-site", "data-testid": "md-site", disabled: d.busy, onChange: (e: Event) => { d.siteId = (e.target as HTMLSelectElement).value; render(true); } }, ...admins.map((x) => el("option", { value: x.id, selected: x.id === d.siteId, disabled: !x.connected }, x.connected ? x.name : `${x.name}（未连接）`))),
            el("label", { for: "md-model" }, "测试模型（用它发一句“hi”试上游分组）"),
            (() => {
              const ms = modelsForGroup(d.g.site_id, d.g.id);
              return el("select", { id: "md-model", "data-testid": "md-model", disabled: d.busy, onChange: (e: Event) => (d.testModel = (e.target as HTMLSelectElement).value) }, el("option", { value: "" }, ms.length ? "自动（挑一个便宜的）" : "自动（还不知道这个分组有哪些模型）"), ...ms.map((m) => el("option", { value: m, selected: m === d.testModel }, m)));
            })(),
            el("label", { for: "md-name" }, "下游分组名称"),
            el("input", { id: "md-name", type: "text", value: d.name, disabled: d.busy, "data-testid": "md-name", onInput: (e: Event) => (d.name = (e.target as HTMLInputElement).value) }),
            own?.kind === "sub2api"
              ? el("div", { class: "form" }, el("label", { for: "md-platform" }, "客户端类型（默认和上游分组一致，之后添加的上游必须是同一类）"), el("select", { id: "md-platform", "data-testid": "md-platform", disabled: d.busy, onChange: (e: Event) => (d.platform = (e.target as HTMLSelectElement).value) }, ...PLATFORM_CHOICES.map((p) => el("option", { value: p, selected: p === d.platform }, platformLabel(p)))))
              : el("p", { class: "muted small" }, "new-api 的分组没有“客户端类型”这个设置。"),
            el("label", { for: "md-rate" }, `下游倍率（上游分组是 ×${d.g.rate_multiplier}，加上你的利润）`),
            el("input", { id: "md-rate", type: "text", inputmode: "decimal", value: d.rate, disabled: d.busy, "data-testid": "md-rate", onInput: (e: Event) => (d.rate = (e.target as HTMLInputElement).value) }),
            el("label", { for: "md-desc" }, "备注"),
            el("input", { id: "md-desc", type: "text", value: d.description, disabled: d.busy, "data-testid": "md-desc", onInput: (e: Event) => (d.description = (e.target as HTMLInputElement).value) }),
            el("p", { class: "muted small" }, `点“创建”后：在中转站创建下游分组 → 在「${d.g.site_name}」为「${d.g.name}」创建（或复用）专用 Key 并发一句“hi”试一次 → 在中转站创建上游账号并绑定到这个下游分组。任何一步失败会撤销上游的部分；下游分组一旦创建会保留。`),
          ),
      el("div", { class: "error", role: "alert", "data-testid": "md-error" }, d.error),
      el("div", { class: "modal-actions" }, el("button", { type: "button", class: "ghost", "data-testid": "md-cancel", disabled: d.busy, onClick: close }, "取消"), admins.length ? el("button", { type: "submit", class: "primary", "data-testid": "md-submit", disabled: d.busy }, d.busy ? "创建中…（要建 Key 并试一次，稍等）" : "创建") : null),
    ),
  );
}

const isAdminDialog = (d: { type: string }): d is AdminRemoveGroupDialog | AdminCreateGroupDialog | AdminAddUpstreamDialog | AdminConfirmDialog | GroupEditDialog => ["admin-pause", "admin-remove", "group-edit", "admin-create-group", "admin-add-upstream", "admin-remove-group"].includes(d.type);

function viewAdminDialog(d: AdminRemoveGroupDialog | AdminCreateGroupDialog | AdminAddUpstreamDialog | AdminConfirmDialog | GroupEditDialog): HTMLElement {
  const close = () => {
    if (d.busy) return;
    state.dialog = null;
    render();
  };
  if (d.type === "admin-create-group") {
    return el(
      "div",
      { class: "modal-mask", "data-testid": "create-group-dialog" },
      el(
        "form",
        { class: "modal wide", role: "dialog", onSubmit: (ev: Event) => { ev.preventDefault(); if (!d.busy) void submitCreateGroup(d); } },
        el("h3", {}, "新建下游分组"),
        el(
          "div",
          { class: "form" },
          el("label", { for: "cg-name" }, "名称（用户看到的分组名）"),
          el("input", { id: "cg-name", type: "text", value: d.name, disabled: d.busy, "data-testid": "cg-name", onInput: (e: Event) => (d.name = (e.target as HTMLInputElement).value) }),
          el("label", { for: "cg-desc" }, "备注"),
          el("input", { id: "cg-desc", type: "text", value: d.description, disabled: d.busy, "data-testid": "cg-desc", onInput: (e: Event) => (d.description = (e.target as HTMLInputElement).value) }),
          d.kind === "sub2api"
            ? el("div", { class: "form" }, el("label", { for: "cg-platform" }, "分类（决定适用于哪个客户端，之后添加的上游必须是同一类）"), el("select", { id: "cg-platform", "data-testid": "cg-platform", onChange: (e: Event) => (d.platform = (e.target as HTMLSelectElement).value) }, ...PLATFORM_CHOICES.map((p) => el("option", { value: p, selected: p === d.platform }, platformLabel(p)))))
            : el("p", { class: "muted small" }, "new-api 的分组没有“分类”这个设置。"),
          el("label", { for: "cg-rate" }, "下游倍率"),
          el("input", { id: "cg-rate", type: "text", inputmode: "decimal", value: d.rate, disabled: d.busy, "data-testid": "cg-rate", onInput: (e: Event) => (d.rate = (e.target as HTMLInputElement).value) }),
        ),
        el("div", { class: "error", role: "alert", "data-testid": "cg-error" }, d.error),
        el("div", { class: "modal-actions" }, el("button", { type: "button", class: "ghost", "data-testid": "cg-cancel", disabled: d.busy, onClick: close }, "取消"), el("button", { type: "submit", class: "primary", "data-testid": "cg-submit", disabled: d.busy }, d.busy ? "创建中…" : "创建并添加上游")),
      ),
    );
  }
  if (d.type === "admin-add-upstream") {
    const ups = upstreamSites(d.siteId);
    const okSites = ups.filter((x) => x.connected);
    const gs = groupsOfSite(d.upSiteId);
    const site = state.sites.find((x) => x.id === d.upSiteId);
    const g = gs.find((x) => x.id === d.groupId);
    const own = state.sites.find((x) => x.id === d.siteId);
    if (d.done) {
      const r = d.done;
      return el(
        "div",
        { class: "modal-mask", "data-testid": "add-upstream-dialog" },
        el(
          "div",
          { class: "modal wide", role: "dialog" },
          el("h3", {}, d.replace ? "已更换上游来源" : "已添加上游"),
          el("ul", { class: "diff-list", "data-testid": "add-upstream-result" }, el("li", {}, d.replace ? `上游账号「${r.name}」的来源已改为「${site?.name ?? ""}」的分组「${g?.name ?? ""}」（名称、状态、绑定的下游分组都没变）` : `上游账号「${r.name}」已创建，绑定到下游分组「${d.down.name}」`), el("li", {}, `${r.key_created ? "在上游站点新建了" : "复用了上游站点已有的"}专用 Key，读到 ${r.models} 个可用模型`), el("li", {}, `用这把 Key 在上游站点发了一句“hi”，首字时延 ${(r.probe_ms / 1000).toFixed(2)}s，链路是通的`), el("li", {}, r.paused ? (d.replace ? "它是暂停状态，不会接收用户请求" : "现在是暂停状态，不会接收用户请求：确认没问题后点“启用”才参与调度") : "已经启用，正在参与调度"), el("li", {}, `已记下关联：倍率和成本读「${site?.name ?? ""}」分组「${g?.name ?? ""}」当前的倍率`)),
          el("div", { class: "error", role: "alert", "data-testid": "au-error" }, d.error),
          el("div", { class: "modal-actions" }, r.paused && !d.replace ? el("button", { type: "button", class: "primary", "data-testid": "au-resume", disabled: d.busy, onClick: () => void resumeAdded(d) }, d.busy ? "启用中…" : "启用") : null, el("button", { type: "button", class: r.paused && !d.replace ? "ghost" : "primary", "data-testid": "au-done", onClick: close }, "完成")),
        ),
      );
    }
    // 左侧的“账号状态”页：快速修改 sub2api 账号的“状态”和“调度”（new-api 的渠道只有一个启用 / 停用开关）
    const statePane = () => {
      const up = state.admin[d.siteId]?.data?.upstreams.find((u) => u.id === d.replace!.id) ?? d.replace!;
      const sub = own?.kind === "sub2api";
      const active = up.account_status === "active";
      const sched = up.schedulable !== false;
      const callable = active && sched;
      const seg = (label: string, on: boolean, id: string, act: () => void) => el("button", { type: "button", class: `seg${on ? " on" : ""}`, "data-testid": id, disabled: d.busy, onClick: act }, label);
      return [
        el("h3", {}, `账号状态 · ${up.name}`),
        el("p", { class: "muted small", "data-testid": "st-hint" }, sub ? "这两个设置要同时是：状态 = 启用、调度 = 开启，用户才能调用通；任何一个不对，这个上游都不会接到用户请求。点一下立即生效。" : "这个站点的渠道只有一个开关：状态 = 启用，用户才能调用通。点一下立即生效。"),
        el("div", { class: "form" }, el("label", {}, "状态"), el("div", { class: "segs" }, seg("启用", active, "st-status-active", () => void setAccountState(d, { status: "active" })), seg("停用", up.account_status === "inactive", "st-status-inactive", () => void setAccountState(d, { status: "inactive" })))),
        sub ? el("div", { class: "form" }, el("label", {}, "调度"), el("div", { class: "segs" }, seg("开启", sched, "st-sched-on", () => void setAccountState(d, { schedulable: true })), seg("关闭", !sched, "st-sched-off", () => void setAccountState(d, { schedulable: false })))) : null,
        el(
          "p",
          { class: callable ? "ok-line" : "bad-line", "data-testid": "st-now" },
          callable ? "现在：✓ 这个上游能被用户调用到" : up.account_status === "error" ? "现在：✕ 站点把这个账号标为异常（状态 error），先到站点排查原因，改这里的开关解决不了" : `现在：✕ 不会被调用到——${!active ? "状态不是“启用”" : ""}${!active && !sched ? "，" : ""}${!sched ? "调度是“关闭”" : ""}`,
        ),
        el("div", { class: "error", role: "alert", "data-testid": "st-error" }, d.error),
        el("div", { class: "modal-actions" }, el("button", { type: "button", class: "primary", "data-testid": "st-close", onClick: close }, "关闭")),
      ];
    };
    const sourcePane = () => [
        el("h3", {}, d.replace ? `更换「${d.replace.name}」的上游分组来源` : `给「${d.down.name}」添加上游`),
        okSites.length === 0
          ? el("div", { class: "form" }, el("p", {}, "还没有可以当上游的站点：先把你在上游站点的账号添加到应用里（站点 tab 末尾的“＋”），再回来添加。"), el("button", { type: "button", class: "primary", "data-testid": "au-add-site", onClick: () => { state.dialog = null; openAdd(); } }, "添加上游站点的账号"))
          : el(
              "div",
              { class: "form" },
              el("label", { for: "au-site" }, "上游站点（你已登录账号的站点）"),
              el("select", { id: "au-site", "data-testid": "au-site", disabled: d.busy, onChange: (e: Event) => { d.upSiteId = (e.target as HTMLSelectElement).value; d.groupId = groupsOfSite(d.upSiteId)[0]?.id ?? ""; d.testModel = ""; defaultUpstreamName(d); render(true); } }, ...ups.map((x) => el("option", { value: x.id, selected: x.id === d.upSiteId, disabled: !x.connected }, x.connected ? x.name : `${x.name}（未连接）`))),
              el("label", { for: "au-group" }, "上游分组"),
              el("select", { id: "au-group", "data-testid": "au-group", disabled: d.busy, onChange: (e: Event) => { d.groupId = (e.target as HTMLSelectElement).value; d.testModel = ""; defaultUpstreamName(d); render(true); } }, ...(gs.length ? gs : []).map((x) => el("option", { value: x.id, selected: x.id === d.groupId }, `${x.name} · ×${x.rate_multiplier}`))),
              (() => {
                // 测试模型：列出这个上游分组支持的模型，选哪个就用哪个发 “hi” 试；不选就自动挑一个便宜的
                const ms = modelsForGroup(d.upSiteId, d.groupId);
                return el(
                  "div",
                  { class: "form" },
                  el("label", { for: "au-model" }, "测试模型（用它发一句“hi”试这个上游分组）"),
                  el("select", { id: "au-model", "data-testid": "au-model", disabled: d.busy, onChange: (e: Event) => (d.testModel = (e.target as HTMLSelectElement).value) }, el("option", { value: "" }, "自动（挑一个便宜的）"), ...ms.map((m) => el("option", { value: m, selected: m === d.testModel }, m))),
                  ms.length === 0 ? el("p", { class: "muted small" }, "还不知道这个分组有哪些模型（这个站点没开模型广场、也还没用它的 Key 读取过）：先自动挑选。") : null,
                );
              })(),
              gs.length === 0 ? el("p", { class: "muted small" }, "这个站点下你的账号没有可用分组。") : null,
              el("label", { for: "au-name" }, "上游账号名称（在你的站点里显示的名字）"),
              el("input", { id: "au-name", type: "text", value: d.name, disabled: d.busy || (!!d.replace && own?.kind === "sub2api"), "data-testid": "au-name", onInput: (e: Event) => { d.name = (e.target as HTMLInputElement).value; d.nameEdited = true; } }),
              d.replace && own?.kind === "sub2api" ? el("p", { class: "muted small" }, "更换来源时名称不变。") : null,
              (() => {
                const dup = d.replace ? null : upstreamDuplicate(d);
                return dup
                  ? el(
                      "div",
                      { class: "banner warn", "data-testid": "au-dup" },
                      el("p", {}, `这个上游分组已经被上游账号「${dup}」使用。再添加一次，两个账号会共用同一把上游 Key：两边的用户会互相占用它的并发和额度（先到先得，后面的会被顶掉）。`),
                      el("label", { class: "check-row" }, el("input", { type: "checkbox", checked: d.dupOk, disabled: d.busy, "data-testid": "au-dup-ok", onChange: (e: Event) => (d.dupOk = (e.target as HTMLInputElement).checked) }), "我知道会共用同一把上游 Key，仍然添加"),
                    )
                  : null;
              })(),
              el(
                "div",
                { class: "muted small", "data-testid": "au-preview" },
                el("p", {}, d.replace ? "点“更换”后将依次：" : "点“创建”后将依次："),
                d.replace
                  ? el("ol", { class: "diff-list" }, el("li", {}, `在「${site?.name ?? ""}」为分组「${g?.name ?? ""}」创建（或复用）一把专用 Key，读它的模型，并用它发一句“hi”试一次；`), el("li", {}, own?.kind === "sub2api" ? `把「${d.replace.name}」的地址、Key、模型就地改成新的来源（账号 id、名称、状态、绑定的下游分组都不变）；` : `在「${own?.name ?? ""}」新建一个渠道（同样的下游分组、同样的暂停状态），成功后再删掉旧渠道；`), el("li", {}, "记下新的关联，以后倍率和成本读新上游分组当前的倍率。"))
                  : el("ol", { class: "diff-list" }, el("li", {}, `在「${site?.name ?? ""}」为分组「${g?.name ?? ""}」创建（或复用）一把专用 Key，读它的模型，并用它发一句“hi”试一次；`), el("li", {}, `在「${own?.name ?? ""}」创建上游账号，填好地址、Key、模型，绑定到下游分组「${d.down.name}」；`), el("li", {}, d.paused ? "先把它暂停，不参与调度；" : "直接启用，马上参与调度；"), el("li", {}, "记下关联，以后倍率和成本读上游分组当前的倍率。")),
                el("p", {}, "任何一步失败都会撤销已经做的（包括刚建的 Key）。Key 只在内存里传递，不显示也不写日志。"),
              ),
            ),
        el("div", { class: "error", role: "alert", "data-testid": "au-error" }, d.error),
        el("div", { class: "modal-actions" }, el("button", { type: "button", class: "ghost", "data-testid": "au-cancel", disabled: d.busy, onClick: close }, "取消"), okSites.length ? el("button", { type: "submit", class: "primary", "data-testid": "au-submit", disabled: d.busy || !d.groupId }, d.busy ? "处理中…（要在上游站点建 Key 并试一次，稍等）" : d.replace ? "更换" : "创建") : null),
    ];
    return el(
      "div",
      { class: "modal-mask", "data-testid": "add-upstream-dialog" },
      el(
        "form",
        { class: `modal wide${d.replace ? " with-nav" : ""}`, role: "dialog", onSubmit: (ev: Event) => { ev.preventDefault(); if (!d.busy && okSites.length && d.tab === "source") void submitAddUpstream(d); } },
        ...(d.replace
          ? [
              el("div", { class: "modal-nav" }, el("button", { type: "button", class: `nav-item${d.tab === "source" ? " on" : ""}`, "data-testid": "au-nav-source", onClick: () => { d.tab = "source"; d.error = ""; render(true); } }, "上游调整"), el("button", { type: "button", class: `nav-item${d.tab === "state" ? " on" : ""}`, "data-testid": "au-nav-state", onClick: () => { d.tab = "state"; d.error = ""; render(true); } }, "账号状态")),
              el("div", { class: "modal-pane" }, ...(d.tab === "state" ? statePane() : sourcePane())),
            ]
          : sourcePane()),
      ),
    );
  }
  if (d.type === "group-edit") {
    const diff = groupDiff(d);
    const rate = Number(d.rate);
    const summary: string[] = [];
    if (diff.name !== undefined) summary.push(`名称：${d.g.name} → ${diff.name}（用户会立刻看到新名称）`);
    if (diff.description !== undefined) summary.push(`备注：${d.g.description ?? "（空）"} → ${diff.description || "（空）"}`);
    if (diff.platform !== undefined) summary.push(`分类：${d.g.platform || "（空）"} → ${diff.platform}`);
    if (diff.rate_multiplier !== undefined) {
      const cut = rate < d.g.rate_multiplier;
      summary.push(`倍率：×${d.g.rate_multiplier} → ×${rate}（${cut ? `降价 ${Math.round((1 - rate / d.g.rate_multiplier) * 100)}%，之后每个请求少收这么多钱` : `涨价 ${Math.round((rate / d.g.rate_multiplier - 1) * 100)}%，之后立刻按新价扣用户的钱`}）`);
    }
    const form = d.step === "form";
    return el(
      "div",
      { class: "modal-mask", "data-testid": "group-edit-dialog" },
      el(
        "form",
        {
          class: "modal wide",
          role: "dialog",
          onSubmit: (ev: Event) => {
            ev.preventDefault();
            if (d.busy) return;
            if (form) {
              // 输入框里的内容不触发重绘，所以提交时现算，不能用渲染时的旧值
              const now = groupProblem(d);
              if (now) { d.error = now; render(); return; }
              if (Object.keys(groupDiff(d)).length === 0) { d.error = "没有修改任何内容"; render(); return; }
              d.error = "";
              d.step = "confirm";
              render();
            } else void submitGroupEdit(d);
          },
        },
        el("h3", {}, form ? `编辑分组「${d.g.name}」` : "确认修改"),
        form
          ? el(
              "div",
              { class: "form" },
              el("label", { for: "ge-name" }, "名称"),
              el("input", { id: "ge-name", type: "text", value: d.name, disabled: d.kind === "newapi", "data-testid": "ge-name", onInput: (e: Event) => (d.name = (e.target as HTMLInputElement).value) }),
              d.kind === "newapi" ? el("p", { class: "muted small" }, "new-api 的分组名就是分组的标识，已有的 Key、用户和渠道都按名字引用，改名会让它们对不上，请在站点后台处理。") : null,
              el("label", { for: "ge-desc" }, "备注"),
              el("input", { id: "ge-desc", type: "text", value: d.description, "data-testid": "ge-desc", onInput: (e: Event) => (d.description = (e.target as HTMLInputElement).value) }),
              d.kind === "sub2api"
                ? el(
                    "div",
                    { class: "form" },
                    el("label", { for: "ge-platform" }, "分类（决定适用于哪个客户端）"),
                    el("select", { id: "ge-platform", "data-testid": "ge-platform", onChange: (e: Event) => (d.platform = (e.target as HTMLSelectElement).value) }, ...[...new Set([d.g.platform, ...PLATFORM_CHOICES, ...(state.admin[d.siteId]?.data?.downstreams.map((x) => x.platform) ?? [])].filter(Boolean))].map((p) => el("option", { value: p, selected: p === d.platform }, p))),
                  )
                : el("p", { class: "muted small" }, "new-api 的分组没有“分类”这个设置。"),
              el("label", { for: "ge-rate" }, "下游倍率"),
              el("input", { id: "ge-rate", type: "text", inputmode: "decimal", value: d.rate, "data-testid": "ge-rate", onInput: (e: Event) => (d.rate = (e.target as HTMLInputElement).value) }),
            )
          : el("div", { class: "form" }, el("p", { class: "muted" }, "将向站点提交下面的修改："), el("ul", { class: "diff-list", "data-testid": "ge-summary" }, ...summary.map((t) => el("li", {}, t)))),
        el("div", { class: "error", role: "alert", "data-testid": "ge-error" }, d.error),
        el(
          "div",
          { class: "modal-actions" },
          !form && el("button", { type: "button", class: "ghost", "data-testid": "ge-back", disabled: d.busy, onClick: () => { d.step = "form"; d.error = ""; render(); } }, "返回修改"),
          el("button", { type: "button", class: "ghost", "data-testid": "ge-cancel", disabled: d.busy, onClick: close }, "取消"),
          el("button", { type: "submit", class: "primary", "data-testid": "ge-submit", disabled: d.busy }, form ? "下一步" : d.busy ? "保存中…" : "确认修改"),
        ),
      ),
    );
  }
  if (d.type === "admin-remove-group") {
    return el(
      "div",
      { class: "modal-mask", "data-testid": "remove-group-dialog" },
      el(
        "div",
        { class: "modal wide", role: "alertdialog" },
        el("h3", {}, `删除下游分组「${d.g.name}」？`),
        el("p", { class: "muted" }, "删除后用户看不到、也用不了这个分组，不可恢复。站点上这个分组下如果还有用户的 Key、订阅，站点可能会拒绝删除，会把它的原话告诉你。"),
        d.ups.length
          ? el("div", { "data-testid": "rg-ups" }, el("p", { class: "small" }, `绑在它上面的 ${d.ups.length} 个上游账号不会被删除，只是不再服务这个分组：`), el("ul", { class: "diff-list" }, ...d.ups.map((u) => el("li", {}, u.name))))
          : el("p", { class: "muted small" }, "它没有绑定任何上游账号。"),
        el("div", { class: "error", role: "alert", "data-testid": "rg-error" }, d.error),
        el("div", { class: "modal-actions" }, el("button", { class: "ghost", "data-testid": "rg-cancel", disabled: d.busy, onClick: close }, "取消"), el("button", { class: "primary danger", "data-testid": "rg-confirm", disabled: d.busy, onClick: () => void submitRemoveGroup(d) }, d.busy ? "删除中…" : "确认删除")),
      ),
    );
  }
  // 暂停 / 移除上游
  const data = state.admin[d.siteId]?.data;
  const impact = data ? impactOf(data, d.up) : [];
  const remove = d.type === "admin-remove";
  const nameOk = true;
  return el(
    "div",
    { class: "modal-mask", "data-testid": remove ? "up-remove-dialog" : "up-pause-dialog" },
    el(
      "div",
      { class: "modal wide", role: "alertdialog" },
      el("h3", {}, remove ? `移除上游「${d.up.name}」？` : `暂停上游「${d.up.name}」？`),
      el("p", { class: "muted" }, remove ? "移除后这个上游账号会从站点删除，不可恢复；站点上保存的它的密钥也随之删除，需要时只能重新添加。" : "暂停后它不再参与调度，随时可以恢复，不会删除任何配置。"),
      impact.length
        ? el(
            "div",
            { "data-testid": "impact" },
            el("p", { class: "small" }, `它服务的 ${impact.length} 个下游分组：`),
            el("ul", { class: "diff-list" }, ...impact.map((x) => el("li", { class: x.alone ? "bad" : "" }, x.alone ? `${x.name} —— 没有其他运行中的上游，${remove ? "移除" : "暂停"}后这个分组将无法使用` : `${x.name} —— 还有其他上游，不受影响`))),
          )
        : el("p", { class: "muted small" }, "它没有服务任何下游分组。"),
      el("div", { class: "error", role: "alert", "data-testid": "up-error" }, d.error),
      el(
        "div",
        { class: "modal-actions" },
        el("button", { class: "ghost", "data-testid": "up-cancel", disabled: d.busy, onClick: close }, "取消"),
        el("button", { class: `primary${remove ? " danger" : ""}`, "data-testid": "up-confirm", disabled: d.busy || !nameOk, onClick: () => void submitUpstreamOp(d) }, d.busy ? "处理中…" : remove ? "确认移除" : "确认暂停"),
      ),
    ),
  );
}

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
  if (d.status === "loading") {
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
    el("aside", { class: "drawer", role: "dialog", "aria-label": "成本详情" }, el("header", { class: "drawer-head" }, el("div", {}, el("h3", {}, d.name), el("span", { class: "muted small" }, `${d.siteName} · 近 7 天`)), el("button", { class: "icon-btn", "aria-label": "关闭", "data-testid": "drawer-close", onClick: closeDrawer }, "✕")), body),
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
  const siteCell = el("span", { class: "col-head" }, "分组");
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
    el("div", { class: "cell-cost" }, sortHeader("cost", "平均成本", "百万有效Token的平均成本（近 7 天实付 ÷ 输入+输出 Token）；点击排序")),
    el("div", { class: "cell-cache" }, sortHeader("cache", "缓存命中率", `缓存读取 ÷（输入 + 缓存创建 + 缓存读取），近 7 天；越高越省钱；点击排序；${CACHE_NOTE}`)),
    el("div", { class: "cell-models" }, modelCell),
    el("div", { class: "card-action" }), // 这一列在每个分组行里放“启用”图标，标题行留空保持对齐
  );
}

function viewMain(): HTMLElement {
  if (state.operator && !state.sites.some((x) => x.id === state.operator && x.is_admin)) state.operator = null; // 站点被移除或不再是管理员
  if (state.operator) return el("div", { class: "main-wrap" }, viewSidebar(), el("section", { class: "content" }, viewOperator(state.operator)));
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
        const val = (g: GroupView) => (state.sortCol === "cost" ? (state.costs[gkey(g)]?.perM ?? null) : cacheShown(state.costs[gkey(g)]));
        const x = val(a), y = val(b);
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
      viewClientTabs(),
      viewSiteProblems(),
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

let urlWarnEl: HTMLElement | null = null;

function viewDialog(): HTMLElement | null {
  const d = state.dialog;
  if (!d) return null;
  const close = () => {
    state.dialog = null;
    render();
  };
  if (isMenuDialog(d)) return viewMenuDialog(d);
  if (isAdminDialog(d)) return viewAdminDialog(d);
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
          ),
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
  const addMask = el(
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
            el("input", { id: "add-url", type: "text", placeholder: "例如 api.example.com", value: d.url, disabled: d.busy, autocomplete: "off", "data-testid": "add-url", onInput: (e: Event) => { d.url = (e.target as HTMLInputElement).value; if (urlWarnEl) urlWarnEl.style.display = /^http:\/\//i.test(d.url.trim()) ? "block" : "none"; } }),
            (() => {
              // 输入时不重绘整个对话框，所以这里直接切换提示的显示
              const warn = el("p", { class: "http-warn", "data-testid": "add-http-warn", style: `display:${/^http:\/\//i.test(d.url.trim()) ? "block" : "none"}` }, "这个站点用的是 http：你的账号密码和 Key 会明文传输，只在你信任的网络里使用。");
              urlWarnEl = warn;
              return warn;
            })(),
          )
        : el(
            "div",
            { class: "form" },
            el("div", { class: "site-found", "data-testid": "add-detected" }, el("span", { class: "site-name" }, det?.base_url ?? ""), el("span", { class: "tag" }, det ? KIND_LABEL[det.kind] : "")),
            (() => {
              const exist = d.relogin ? undefined : state.sites.find((x) => x.base_url === det?.base_url);
              return exist
                ? el("div", { class: "banner warn", "data-testid": "add-replace-warn" }, `这个站点已经添加过（当前账号：${exist.account?.display ?? "未知"}）。再次登录会替换掉它，原来的账号会被顶掉（退出登录），之后用的是新登录的账号。`)
                : null;
            })(),
            !d.relogin && el("label", { for: "add-name" }, "站点名称"),
            !d.relogin && el("input", { id: "add-name", type: "text", value: d.name, disabled: d.busy, autocomplete: "off", "data-testid": "add-name", onInput: (e: Event) => (d.name = (e.target as HTMLInputElement).value) }),
            el("label", { for: "add-username" }, accountLabel),
            el("input", { id: "add-username", type: "text", value: d.username, disabled: d.busy, autocomplete: "username", "data-testid": "add-username", onInput: (e: Event) => (d.username = (e.target as HTMLInputElement).value) }),
            el("label", { for: "add-password" }, "密码"),
            el("input", { id: "add-password", type: "password", value: d.password, disabled: d.busy, autocomplete: "current-password", "data-testid": "add-password", onInput: (e: Event) => (d.password = (e.target as HTMLInputElement).value) }),
            el(
              "label",
              { class: "check-row", "data-testid": "add-admin-row" },
              el("input", {
                type: "checkbox",
                id: "add-admin",
                checked: d.isAdmin,
                disabled: d.busy,
                "data-testid": "add-admin",
                onChange: (e: Event) => {
                  const on = (e.target as HTMLInputElement).checked;
                  d.isAdmin = false;
                  d.adminNotice = on; // 先说明，用户点“我知道了”才真正勾上
                  render();
                },
              }),
              "我是该站点管理员",
            ),
            el("p", { class: "muted small" }, "所有数据保存在本地"),
          ),
      el("div", { class: "error", role: "alert", "data-testid": "add-error" }, d.error),
      el(
        "div",
        { class: "modal-actions" },
        !inUrl && !d.relogin && el("button", { type: "button", class: "ghost", "data-testid": "add-back", disabled: d.busy, onClick: () => { d.step = "url"; d.error = ""; render(); } }, "返回"),
        el("button", { type: "button", class: "ghost", "data-testid": "add-cancel", disabled: d.busy, onClick: close }, "取消"),
        el("button", { type: "submit", class: "primary", "data-testid": "add-submit", disabled: d.busy }, inUrl ? (d.busy ? "检查中…" : "下一步") : d.busy ? "登录中…" : d.relogin ? "登录" : state.sites.some((x) => x.base_url === det?.base_url) ? "替换并登录" : "登录并添加"),
      ),
    ),
  );
  if (!d.adminNotice) return addMask;
  const ack = () => {
    d.isAdmin = true;
    d.adminNotice = false;
    render();
  };
  const cancel = () => {
    d.isAdmin = false;
    d.adminNotice = false;
    render();
  };
  return el(
    "div",
    { class: "dialog-stack" },
    addMask,
    el(
      "div",
      { class: "modal-mask nested", "data-testid": "admin-notice" },
      el(
        "div",
        { class: "modal", role: "alertdialog" },
        el("h3", {}, "管理员模式"),
        el("p", {}, "该模式支持监控上下游可用性及成本变化，务必在站点中再次添加使用到的上游站点账号"),
        el("div", { class: "modal-actions" }, el("button", { type: "button", class: "ghost", "data-testid": "admin-notice-cancel", onClick: cancel }, "取消"), el("button", { type: "button", class: "primary", autofocus: true, "data-testid": "admin-notice-ok", onClick: ack }, "我知道了")),
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
