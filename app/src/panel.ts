import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { octopusWorking } from "./octopus";
import { agoText, startAgoTicker } from "./time";
import { initHover, syncHover } from "./hover";
import { allCategories, categoriesOf as categoriesOfG, clientsOf as clientsOfG } from "./categories";
import type { CategoryId, ClientId, ClientOverview, CustomCategory, GroupView, SiteView } from "./types";

/**
 * 菜单栏面板。点菜单栏图标打开，点屏幕其他位置关闭（由 Rust 端监听）。
 * 关键：选择分组后不关闭窗口，方便连续切换多个客户端的分组。
 */

type Child = Node | string | null | undefined | false;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, unknown> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") e.className = String(v);
    else if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (v === true) e.setAttribute(k, "");
    else e.setAttribute(k, String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) e.append(c);
  return e;
}

const CLIENT_NAME: Record<ClientId, string> = { claude: "Claude Code", claude_desktop: "Claude Desktop", codex: "Codex", gemini: "Gemini CLI" };

const root = document.getElementById("panel")!;
const closed = () => void invoke("panel_close").catch(() => undefined);
const openMain = () => void invoke("panel_open_main").then(closed).catch(() => undefined);
/** 面板里的操作记进诊断日志：用户反馈“点了没反应”时，能看出点击到底有没有传到界面 */
const note = (what: string) => void invoke("panel_note", { what }).catch(() => undefined);

/** 当前类别 tab：和主窗口共用同一份记忆（localStorage 同源时共享），没有就是“全部” */
const TAB_KEY = "ferrydeck.category";
let tab: string = (() => {
  try {
    return localStorage.getItem(TAB_KEY) || "all";
  } catch {
    return "all";
  }
})();
let customCats: CustomCategory[] = [];
/** 主窗口共享的各分组的模型（站点id\u0001分组id → 模型），用来识别类别 */
let sharedModels: Record<string, string[]> = {};
/** 正在选“配置到哪个客户端”的那一行 */
let picking: string | null = null;
let groups: GroupView[] = [];
let sites: SiteView[] = [];
let overview: ClientOverview[] = [];
let busy: string | null = null;
let toast = "";
let loadError = "";
/** 最近一次真正向站点拉取分组的时间（unix 秒） */
let fetchedAt = 0;
let refreshing = false;
/** 重新渲染会替换整个列表，记住滚动位置，避免列表跳动 */
let scrollTop = 0;

const multiSite = () => sites.length > 1;
const gkey = (g: GroupView) => `${g.site_id}\u0001${g.id}`;
const modelsOf = (g: GroupView): string[] => sharedModels[gkey(g)] ?? g.models ?? [];
const categoriesOf = (g: GroupView): CategoryId[] => categoriesOfG(g, modelsOf(g), customCats);
const clientsOf = (g: GroupView): ClientId[] => clientsOfG(g, modelsOf(g), customCats);
/** 这个分组正在被哪些客户端使用 */
const usedBy = (g: GroupView): ClientId[] => overview.filter((o) => o.in_use && o.active && o.active.site_id === g.site_id && o.active.group_id === g.id).map((o) => o.client);

function powerIcon(): Node {
  const t = document.createElement("template");
  t.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v8"/><path d="M6.4 6.8a8 8 0 1 0 11.2 0"/></svg>';
  return t.content.firstChild!;
}

function flash(text: string) {
  toast = text;
  render();
  window.setTimeout(() => {
    if (toast === text) {
      toast = "";
      render();
    }
  }, 4000);
}

/**
 * 刷新面板数据。`maxAge` 秒内向站点拉取过就直接用缓存（面板每次打开都走这条，默认 60 秒）；
 * 用户点面板里的刷新按钮时传 0，一定重新向站点拉取。
 */
let lastRefreshAt = 0;
let inFlight = false;

/**
 * 事件触发的刷新（面板显示、数据变了）：1 秒内最多一次，且上一次没结束就不再发。
 * 面板每次刷新都会重画整个界面，如果有任何地方形成“刷新 → 事件 → 刷新”的循环，
 * 按钮会在按下和松开之间被换掉，点什么都没反应。这道防线保证即使有人写出循环，也最多每秒一次，不会狂刷。
 */
function refreshFromEvent() {
  if (inFlight || Date.now() - lastRefreshAt < 1000) return;
  void refresh();
}

async function refresh(maxAge = 60) {
  inFlight = true;
  lastRefreshAt = Date.now();
  try {
    const r = (await invoke("list_groups", { maxAgeSecs: maxAge })) as { groups: GroupView[]; sites: SiteView[]; fetched_at: number };
    groups = r.groups;
    sites = r.sites;
    fetchedAt = r.fetched_at;
    overview = (await invoke("overview")) as ClientOverview[];
    // 类别要用的两样东西：自定义类别、主窗口读到的各分组的模型（都不向站点发请求）
    customCats = ((await invoke("get_custom_categories").catch(() => [])) as CustomCategory[]) ?? [];
    sharedModels = ((await invoke("cached_models").catch(() => ({}))) as Record<string, string[]>) ?? {};
    loadError = "";
    // 当前类别里已经没有分组了：回到“全部”
    if (tab !== "all" && !groups.some((g) => categoriesOf(g).includes(tab))) tab = "all";
  } catch (e) {
    loadError = String(e);
  } finally {
    inFlight = false;
  }
  render();
}

async function manualRefresh() {
  if (refreshing) return;
  refreshing = true;
  render();
  try {
    await refresh(0); // 手动：无视缓存
  } finally {
    refreshing = false;
    render();
  }
}

/** 面板里的手动刷新只重新拉分组列表（不拉余额和模型）。 */
const PANEL_REFRESH_TIP = ["手动刷新：重新向每个站点获取分组列表", "（名称、倍率、可用于哪些客户端）", "不会创建 Key，也不会测速。", "打开面板时，一分钟内拉过就直接用缓存。"].join("\n");

function refreshIcon(): Node {
  const t = document.createElement("template");
  t.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 4v5h-5"/></svg>';
  return t.content.firstChild!;
}

async function enable(g: GroupView, client: ClientId) {
  if (busy) return;
  busy = gkey(g);
  picking = null;
  render();
  try {
    await invoke("enable_group", { siteId: g.site_id, groupId: g.id, client, model: null });
    overview = (await invoke("overview")) as ClientOverview[];
    flash(`已把「${g.name}」配置到 ${CLIENT_NAME[client]}`);
  } catch (e) {
    flash(String(e));
  } finally {
    busy = null;
    render();
  }
}

/** 点一行：还能配到的客户端只有一个就直接配；有两个（Claude 类：Claude Code / Claude Desktop）就在这一行下面展开选择。 */
function rowClick(g: GroupView) {
  const used = usedBy(g);
  const free = clientsOf(g).filter((c) => !used.includes(c));
  if (free.length === 0) return;
  if (free.length === 1) return void enable(g, free[0]);
  picking = picking === gkey(g) ? null : gkey(g);
  render();
}

function render() {
  const prev = root.querySelector(".panel-list");
  if (prev) scrollTop = prev.scrollTop;
  if (sites.length === 0) {
    root.replaceChildren(el("div", { class: "fd-panel" }, el("p", { class: "muted" }, "还没有添加站点。"), el("button", { class: "primary wide", onClick: openMain }, "打开 Ferrydeck")));
    return;
  }
  const count = (c: string) => groups.filter((g) => categoriesOf(g).includes(c)).length;
  const tabOf = (id: string, name: string, n: number) =>
    el("button", { class: `panel-tab${tab === id ? " on" : ""}`, "data-testid": `panel-tab-${id}`, title: `${name}（${n} 个分组）`, onClick: () => { note(`切换到 ${id}`); tab = id; picking = null; scrollTop = 0; try { localStorage.setItem(TAB_KEY, id); } catch { /* 记不住就算了 */ } render(); } }, name);
  const tabs = el("div", { class: "panel-tabs" }, tabOf("all", "全部", groups.length), ...allCategories(customCats).filter((c) => count(c.id) > 0).map((c) => tabOf(c.id, c.name, count(c.id))));
  const list = groups.filter((g) => tab === "all" || categoriesOf(g).includes(tab));
  const rows = list.flatMap((g) => {
    const used = usedBy(g);
    const cl = clientsOf(g);
    const free = cl.filter((c) => !used.includes(c));
    const isActive = used.length > 0 && free.length === 0;
    const partial = used.length > 0 && free.length > 0;
    const row = el(
      "button",
      { class: `panel-row${used.length ? " active" : ""}`, "data-testid": `panel-row-${g.site_id}-${g.id}`, disabled: busy !== null || cl.length === 0, onClick: () => rowClick(g) },
      el("span", { class: "panel-row-main" }, el("span", { class: "panel-row-name" }, g.name), multiSite() ? el("span", { class: "muted small" }, g.site_name) : null),
      el(
        "span",
        { class: "panel-row-side" },
        el("span", { class: "muted small" }, `×${g.rate_multiplier}`),
        // 正在配置这一行：章鱼划腿干活；已在使用：文案；没有对应客户端的类别（视频、音频…）：不可配置；否则是启用图标
        busy === gkey(g)
          ? el("span", { class: "panel-working" }, octopusWorking(16), el("span", { class: "small muted" }, "配置中…"))
          : isActive
            ? el("span", { class: "badge", title: `正在被 ${used.map((c) => CLIENT_NAME[c]).join("、")} 使用` }, "使用中")
            : cl.length === 0
              ? el("span", { class: "muted small", title: "这个分组的模型类别没有对应的一键配置客户端，请到主窗口查看" }, "不可配置")
              : partial
                ? el("span", { class: "badge partial", title: `正在被 ${used.map((c) => CLIENT_NAME[c]).join("、")} 使用；点击还可以配置到 ${free.map((c) => CLIENT_NAME[c]).join("、")}` }, "使用中 ▾")
                : el("span", { class: "panel-power" }, powerIcon()),
      ),
    );
    if (picking !== gkey(g) || free.length < 2) return [row];
    return [row, el("div", { class: "panel-pick", "data-testid": `panel-pick-${g.site_id}-${g.id}` }, ...free.map((c) => el("button", { class: "ghost small-btn", "data-testid": `panel-pick-${c}`, onClick: () => void enable(g, c) }, `配置到 ${CLIENT_NAME[c]}`)))];
  });
  root.replaceChildren(
    el(
      "div",
      { class: "fd-panel" },
      tabs,
      el("div", { class: "panel-list" }, ...(rows.length > 0 ? rows : [el("p", { class: "muted small" }, loadError ? `加载失败：${loadError}` : "没有可用的分组。")])),
      el(
        "div",
        { class: "panel-foot" },
        el(
          "div",
          { class: "panel-refresh" },
          el("button", { class: `icon-btn refresh-btn${refreshing ? " spinning" : ""}`, "data-tip": PANEL_REFRESH_TIP, "aria-label": "刷新", "data-testid": "panel-refresh", disabled: refreshing, onClick: () => void manualRefresh() }, refreshIcon()),
          el("span", { class: "refresh-time", "data-testid": "panel-refresh-time", "data-ago": refreshing ? "" : fetchedAt > 0 ? String(fetchedAt) : "" }, refreshing ? "刷新中…" : agoText(fetchedAt)),
        ),
        el("button", { class: "ghost small-btn", "data-testid": "panel-open-main", onClick: () => { note("打开主窗口"); openMain(); } }, "打开主窗口"),
        el("button", { class: "ghost small-btn", "data-testid": "panel-quit", onClick: () => { note("退出"); void invoke("panel_quit"); } }, "退出"),
      ),
      toast ? el("div", { class: "panel-toast", "data-testid": "panel-toast" }, toast) : null,
    ),
  );
  const listEl = root.querySelector(".panel-list");
  if (listEl) listEl.scrollTop = scrollTop;
  syncHover(); // 节点换新了：按鼠标当前位置重新算哪一行处于悬停、该不该显示启动图标和提示
}

async function boot() {
  render();
  startAgoTicker();
  initHover();
  // 先加载数据：事件监听失败也不能让面板空着
  await refresh();
  try {
    // 每次显示面板都重新拉一遍：站点分组可能在变化
    await listen("panel-shown", refreshFromEvent);
    await listen("state-changed", refreshFromEvent);
  } catch {
    window.addEventListener("focus", refreshFromEvent);
  }
}

void boot();
