import { invoke } from "@tauri-apps/api/core";
import { backend, isMock } from "./backend";
import { CLIENTS, CLIENT_ORDER, KIND_LABEL, type ClientId, type ClientOverview, type DetectedSite, type GroupView, type SiteView, type UpdateInfo } from "./types";

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

const state = {
  view: "boot" as "boot" | "main",
  sites: [] as SiteView[],
  groups: [] as GroupView[],
  overview: [] as ClientOverview[],
  selected: "claude" as ClientId,
  siteFilter: "all",
  sort: "default" as "default" | "asc" | "desc",
  busyGroup: null as string | null,
  models: {} as Record<string, string[]>,
  loading: false,
  loadError: null as string | null,
  toast: null as Toast,
  dialog: null as AddDialog | RemoveDialog | null,
  version: "",
  update: null as UpdateInfo | null,
  updating: false,
  checking: false,
  lastAccountRefresh: 0,
};

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

async function refreshAll() {
  // 没有站点就没有东西可加载，直接显示欢迎页
  state.loading = state.sites.length > 0;
  state.loadError = null;
  render();
  try {
    const [r, overview] = await Promise.all([backend.listGroups(), backend.overview()]);
    state.groups = r.groups;
    state.sites = r.sites;
    state.overview = overview;
    pickClient();
  } catch (e) {
    state.loadError = errText(e);
  } finally {
    state.loading = false;
    render();
  }
  void loadActiveModels();
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
    state.sites = await backend.refreshAccounts();
    render();
  } catch {
    /* 静默 */
  }
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
    await refreshAll();
    const first = CLIENT_ORDER.find((c) => state.groups.some((g) => g.site_id === site.id && g.clients.includes(c)));
    if (first && !existed) state.selected = first;
    showToast("ok", existed ? `站点「${site.name}」已重新登录` : `已添加站点「${site.name}」`);
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

function viewHeader(): HTMLElement {
  return el(
    "header",
    { class: "topbar" },
    el("span", { class: "tag", "data-testid": "version" }, state.version ? `v${state.version}` : ""),
    el("div", { class: "account" }, el("button", { class: "ghost tiny", "data-testid": "check-update", disabled: state.checking || state.updating, onClick: () => void checkForUpdate(false) }, state.checking ? "检查中…" : "检查更新")),
  );
}

function viewSiteCard(s: SiteView): HTMLElement {
  return el(
    "div",
    { class: `site-card${s.connected ? "" : " bad"}`, "data-testid": `site-${s.id}` },
    el("div", { class: "site-top" }, el("span", { class: `dot${s.connected ? " on" : " err"}` }), el("span", { class: "site-name", title: s.base_url }, s.name), el("span", { class: "tag" }, KIND_LABEL[s.kind])),
    s.connected
      ? el("div", { class: "site-sub" }, el("span", { class: "muted small", "data-testid": `site-account-${s.id}` }, s.account?.display ?? ""), el("span", { class: "balance", "data-testid": `site-balance-${s.id}` }, s.account ? `余额 ${s.account.balance}` : ""))
      : el("div", { class: "site-err", "data-testid": `site-error-${s.id}` }, s.error ?? "需要重新登录"),
    el(
      "div",
      { class: "site-actions" },
      s.connected && el("button", { class: "topup", "data-testid": `topup-${s.id}`, onClick: () => void topup(s) }, "去充值"),
      !s.connected && el("button", { class: "primary small-btn", "data-testid": `relogin-${s.id}`, onClick: () => openAdd(s) }, "重新登录"),
      el("button", { class: "ghost small-btn", "data-testid": `remove-${s.id}`, onClick: () => { state.dialog = { type: "remove", site: s, busy: false }; render(); } }, "移除"),
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
      { class: `side-item${state.selected === c ? " selected" : ""}`, "data-testid": `client-${c}`, onClick: () => { state.selected = c; render(); } },
      el("span", { class: `dot${a ? " on" : ""}` }),
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
    el("button", { class: "add-site", "data-testid": "add-site", onClick: () => openAdd() }, "＋ 添加站点"),
  );
}

function groupCard(g: GroupView, o: ClientOverview | undefined): HTMLElement {
  const k = gkey(g);
  const a = o?.in_use ? o.active : null;
  const isActive = !!a && a.site_id === g.site_id && a.group_id === g.id;
  const busy = state.busyGroup === k;
  const models = state.models[k] ?? [];
  const current = a?.model ?? null;
  const tid = `${g.site_id}-${g.id}`;
  const control = isActive
    ? el(
        "div",
        { class: "active-row" },
        el("span", { class: "badge" }, "使用中"),
        el(
          "select",
          {
            class: "model-select",
            "data-testid": `model-select-${tid}`,
            disabled: state.busyGroup !== null,
            title: "切换模型",
            onChange: (e: Event) => void enable(g, (e.target as HTMLSelectElement).value),
          },
          ...(models.length > 0 ? models : current ? [current] : []).map((m) => el("option", { value: m, selected: m === current }, m)),
        ),
      )
    : el("button", { class: `primary enable-btn${busy ? " busy" : ""}`, "aria-label": "启用", title: "启用", "data-testid": `enable-${tid}`, disabled: state.busyGroup !== null, onClick: () => void enable(g) }, busy ? "配置中…" : powerIcon());
  return el(
    "div",
    { class: `card${isActive ? " active" : ""}`, "data-testid": `group-card-${tid}` },
    el("div", { class: "card-main" }, el("h3", {}, g.name, multiSite() ? el("span", { class: "site-tag", "data-testid": `site-tag-${tid}` }, g.site_name) : null), el("p", { class: "desc" }, g.description ?? "")),
    el("span", { class: "rate", title: "计费倍率" }, `×${g.rate_multiplier}`),
    el("div", { class: "card-action" }, control),
  );
}

function viewMain(): HTMLElement {
  const c = state.selected;
  const o = ov(c);
  const groups = state.groups.filter((g) => g.clients.includes(c) && (state.siteFilter === "all" || g.site_id === state.siteFilter));
  if (state.sort !== "default") groups.sort((a, b) => (state.sort === "asc" ? a.rate_multiplier - b.rate_multiplier : b.rate_multiplier - a.rate_multiplier));
  const body: Child[] = [];

  if (state.sites.length === 0) {
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
    const needLogin = state.sites.some((s) => !s.connected);
    body.push(el("div", { class: "panel", "data-testid": "empty" }, el("p", {}, needLogin ? "有站点需要重新登录，请在左侧处理。" : "你的账号暂时没有可用分组。"), !needLogin && el("p", { class: "muted" }, "请到站点上查看账号状态，或联系站点管理员开通。")));
  } else if (groups.length === 0) {
    body.push(el("div", { class: "panel", "data-testid": "empty-client" }, state.siteFilter === "all" ? `没有可用于 ${CLIENTS[c].name} 的分组。` : `这个站点没有可用于 ${CLIENTS[c].name} 的分组。`));
  } else {
    body.push(el("div", { class: "list", "data-testid": "group-list" }, ...groups.map((g) => groupCard(g, o))));
  }

  return el(
    "div",
    { class: "main-wrap" },
    viewSidebar(),
    el(
      "section",
      { class: "content" },
      state.groups.length > 0 &&
        el(
          "div",
          { class: "filter-row" },
          el(
            "div",
            { class: "chips", "data-testid": "site-chips" },
            ...(multiSite()
              ? [
                  el("button", { class: `chip${state.siteFilter === "all" ? " on" : ""}`, "data-testid": "chip-all", onClick: () => { state.siteFilter = "all"; render(); } }, "全部站点"),
                  ...state.sites.map((s) => el("button", { class: `chip${state.siteFilter === s.id ? " on" : ""}`, "data-testid": `chip-${s.id}`, onClick: () => { state.siteFilter = s.id; render(); } }, s.name)),
                ]
              : []),
          ),
          el(
            "label",
            { class: "sort muted small" },
            "排序 ",
            (() => {
              const sel = el("select", { "data-testid": "sort", onChange: (e: Event) => { state.sort = (e.target as HTMLSelectElement).value as typeof state.sort; render(); } },
                el("option", { value: "default" }, "默认"), el("option", { value: "asc" }, "倍率从低到高"), el("option", { value: "desc" }, "倍率从高到低"));
              sel.value = state.sort;
              return sel;
            })(),
          ),
        ),
      o && o.conflicts.length > 0 &&
        el(
          "div",
          { class: "banner warn", "data-testid": "conflict-banner" },
          el("strong", {}, "检测到下列设置可能会覆盖配置，导致不生效："),
          el("ul", {}, ...o.conflicts.map((x) => el("li", {}, x))),
          el("span", { class: "small" }, "请删除或注释掉这些设置，然后重新打开终端。"),
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
  if (d.type === "remove") {
    return el(
      "div",
      { class: "modal-mask", "data-testid": "remove-dialog" },
      el(
        "div",
        { class: "modal", role: "dialog" },
        el("h3", {}, `移除站点「${d.site.name}」？`),
        el("p", { class: "muted" }, "只会从应用里移除并退出登录。站点上的账号、已创建的 desktop- 开头的 Key，以及已经写入客户端的配置都不会被删除。"),
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
            el("p", { class: "muted small" }, "填你平时登录的那个中转站网址。支持 new-api 和 sub2api。"),
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
            el("p", { class: "muted small" }, "密码只用于登录这个站点，不会保存；应用只保存登录凭据到系统钥匙串。"),
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

function render() {
  const focusId = (document.activeElement as HTMLElement | null)?.id;
  const sel = document.activeElement instanceof HTMLInputElement ? document.activeElement.selectionStart : null;
  const page = state.view === "boot" ? el("div", { class: "boot muted", "data-testid": "boot" }, "正在启动…") : el("div", { class: "app" }, viewHeader(), viewUpdateBanner(), viewMain());
  root.replaceChildren(page, viewDialog() ?? "", viewToast() ?? "", isMock ? el("div", { class: "mock-tag" }, "模拟后端") : "");
  if (focusId) {
    const f = document.getElementById(focusId);
    f?.focus();
    if (f instanceof HTMLInputElement && sel !== null && sel !== undefined) f.setSelectionRange(sel, sel);
  }
}

/** 菜单栏里切换分组后，窗口里的状态同步刷新；菜单栏操作失败时在窗口里显示原因。 */
async function listenTrayEvents() {
  if (isMock) return;
  const { listen } = await import("@tauri-apps/api/event");
  await listen("state-changed", () => void refreshOverview().then(render));
  await listen<string>("tray-error", (e) => void handleError(new Error(e.payload), "配置失败："));
}

async function boot() {
  render();
  void listenTrayEvents();
  window.addEventListener("focus", () => void refreshBalances());
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
  state.view = "main";
  void checkForUpdate(true);
  await refreshAll();
}

void boot();
