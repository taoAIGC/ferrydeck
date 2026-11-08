import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { octopusWorking } from "./octopus";
import { agoText, startAgoTicker } from "./time";
import { initHover, syncHover } from "./hover";
import type { ClientId, ClientOverview, GroupView, SiteView } from "./types";

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

const CLIENT_ORDER: ClientId[] = ["claude", "claude_desktop", "codex", "gemini"];
const CLIENT_NAME: Record<ClientId, string> = { claude: "Claude Code", claude_desktop: "Claude Desktop", codex: "Codex", gemini: "Gemini CLI" };
/** 标签页上的短名称：四个客户端要在一行里完整显示 */
const TAB_NAME: Record<ClientId, string> = { claude: "Claude Code", claude_desktop: "Desktop", codex: "Codex", gemini: "Gemini" };

const root = document.getElementById("panel")!;
const closed = () => void invoke("panel_close").catch(() => undefined);
const openMain = () => void invoke("panel_open_main").then(closed).catch(() => undefined);
/** 面板里的操作记进诊断日志：用户反馈“点了没反应”时，能看出点击到底有没有传到界面 */
const note = (what: string) => void invoke("panel_note", { what }).catch(() => undefined);

let tab: ClientId = "claude";
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

const active = (c: ClientId) => {
  const o = overview.find((x) => x.client === c);
  return o?.in_use ? o.active : null;
};
const multiSite = () => sites.length > 1;
const gkey = (g: GroupView) => `${g.site_id}\u0001${g.id}`;

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
    loadError = "";
    // 当前客户端没有分组时切到第一个有分组的
    if (!groups.some((g) => g.clients.includes(tab))) {
      tab = CLIENT_ORDER.find((c) => groups.some((g) => g.clients.includes(c))) ?? tab;
    }
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

async function enable(g: GroupView) {
  if (busy) return;
  busy = gkey(g);
  render();
  try {
    await invoke("enable_group", { siteId: g.site_id, groupId: g.id, client: tab, model: null });
    overview = (await invoke("overview")) as ClientOverview[];
    flash(`已把「${g.name}」配置到 ${CLIENT_NAME[tab]}`);
  } catch (e) {
    flash(String(e));
  } finally {
    busy = null;
    render();
  }
}

function render() {
  const prev = root.querySelector(".panel-list");
  if (prev) scrollTop = prev.scrollTop;
  if (sites.length === 0) {
    root.replaceChildren(el("div", { class: "fd-panel" }, el("p", { class: "muted" }, "还没有添加站点。"), el("button", { class: "primary wide", onClick: openMain }, "打开 Ferrydeck")));
    return;
  }
  const tabs = el(
    "div",
    { class: "panel-tabs" },
    ...CLIENT_ORDER.map((c) => el("button", { class: `panel-tab${tab === c ? " on" : ""}`, "data-testid": `panel-tab-${c}`, title: CLIENT_NAME[c], onClick: () => { note(`切换到 ${c}`); tab = c; scrollTop = 0; render(); } }, TAB_NAME[c])),
  );
  const a = active(tab);
  const list = groups.filter((g) => g.clients.includes(tab));
  const rows = list.map((g) => {
    const isActive = !!a && a.site_id === g.site_id && a.group_id === g.id;
    return el(
      "button",
      { class: `panel-row${isActive ? " active" : ""}`, "data-testid": `panel-row-${g.site_id}-${g.id}`, disabled: busy !== null, onClick: () => void enable(g) },
      el("span", { class: "panel-row-main" }, el("span", { class: "panel-row-name" }, g.name), multiSite() ? el("span", { class: "muted small" }, g.site_name) : null),
      el(
        "span",
        { class: "panel-row-side" },
        el("span", { class: "muted small" }, `×${g.rate_multiplier}`),
        // 正在配置这一行：章鱼划腿干活；已在使用：文案；否则是启用图标
        busy === gkey(g) ? el("span", { class: "panel-working" }, octopusWorking(16), el("span", { class: "small muted" }, "配置中…")) : isActive ? el("span", { class: "badge" }, "使用中") : el("span", { class: "panel-power" }, powerIcon()),
      ),
    );
  });
  root.replaceChildren(
    el(
      "div",
      { class: "fd-panel" },
      tabs,
      el("div", { class: "panel-list" }, ...(rows.length > 0 ? rows : [el("p", { class: "muted small" }, loadError ? `加载失败：${loadError}` : `没有可用于 ${CLIENT_NAME[tab]} 的分组。`)])),
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
