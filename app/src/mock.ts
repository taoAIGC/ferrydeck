import type { AccountInfo, Backend, ClientId, ClientOverview, DetectedSite, EnableOutcome, GroupView, SiteKind, SiteView } from "./types";

/**
 * 浏览器里（没有 Tauri）使用的模拟后端，用于开发和界面自动化测试。
 * 用 URL 参数 ?s=xxx 切换场景，可组合：?s=sites2,enable-fail
 *   sites1       启动时已有 1 个站点（Alpha，sub2api）   sites2  启动时已有 2 个站点（Alpha + Beta，new-api）
 *   expired      Beta 登录已过期（需重新登录）           slow    所有请求延迟 1.2 秒
 *   enable-fail  启用总是失败      empty  站点没有任何分组      conflict  Claude Code 存在配置冲突
 *   nodir        本机没有客户端配置目录   desktop-off  Claude Desktop 尚未切换到第三方模式
 *   expire-on-enable  启用时发现站点登录已过期
 *   ratelimit    Alpha 测速时返回 429（站点限流）
 *   plaza        站点开了“模型广场”：sub2api 的分组一加载就带着模型（不用测速）
 *   keyfail      Alpha 创建 Key 后读不回来（对应 pqh.ai 的情况）
 *   probefail    Alpha 的分组 2/4/12 测速分别因余额不足/无可用账号/模型无渠道而失败
 *   dataloss     启动时没有站点，但记录里以前有 Alpha 和 Beta（数据目录被清理软件删了）
 *   offline      Beta 暂时连不上（网络问题，凭据还在）；点“重试”后恢复
 *   update / update-fail / check-fail   更新相关
 * 模拟站点地址：alpha.example.com(sub2api) beta.example.com(new-api) gamma.example.com(new-api)；
 *   captcha.example.com 需要人机验证；其他地址识别失败。密码 ok123 正确。
 */
const scenarios = new Set((new URLSearchParams(location.search).get("s") ?? "").split(",").filter(Boolean));
const has = (s: string) => scenarios.has(s);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const delay = () => sleep(has("slow") ? 1200 : 80);

type MockGroup = Omit<GroupView, "site_id" | "site_name" | "models" | "clients_inferred"> & { models?: string[]; clients_inferred?: boolean };
function g(id: string, name: string, platform: string, rate: number, description: string | null): MockGroup {
  const clients = ({ anthropic: ["claude", "claude_desktop"], openai: ["codex"], gemini: ["gemini"] } as Record<string, ClientId[]>)[platform] ?? [];
  return { id, name, description, platform, rate_multiplier: rate, clients };
}

const SITE_DEFS: Record<string, { name: string; kind: SiteKind; balance: string; groups: MockGroup[] }> = {
  "https://alpha.example.com": {
    name: "Alpha",
    kind: "sub2api",
    balance: "$99.78",
    groups: [
      g("2", "Claude 官方系列高速", "anthropic", 2.5, "官方直连，速度最快"),
      g("4", "Claude 逆向Kiro", "anthropic", 0.28, "性价比高，适合日常编码"),
      g("12", "Claude 逆向Kiro - 特价", "anthropic", 0.12, null),
      g("9", "GPT 福利", "openai", 0.05, "福利价"),
      g("13", "Gemini - Vertex", "gemini", 1.9, "Google Vertex 官方"),
      g("17", "Grok", "grok", 0.8, null),
    ],
  },
  "https://beta.example.com": {
    name: "Beta",
    kind: "newapi",
    balance: "$43.51",
    groups: [
      // 与 Alpha 同名的分组：验证同名分组并存、互不干扰
      g("Claude 逆向Kiro", "Claude 逆向Kiro", "anthropic", 0.3, "Beta 的 Kiro"),
      g("GPT Pro", "GPT Pro", "openai", 0.258, "GPT PRO 账号"),
    ],
  },
  "https://gamma.example.com": { name: "Gamma", kind: "newapi", balance: "¥12.30", groups: [g("G1", "Gamma 分组", "anthropic", 1, null)] },
};

const MODELS: Record<ClientId, string[]> = {
  claude: ["claude-sonnet-5-5", "claude-sonnet-5", "claude-opus-5-5", "claude-haiku-5-5"],
  claude_desktop: ["claude-sonnet-5-5", "claude-sonnet-5", "claude-opus-5-5", "claude-haiku-5-5"],
  codex: ["gpt-5.6-sol", "gpt-6-sol", "gpt-6.1-sol", "gpt-5.6-terra"],
  gemini: ["gemini-3.5-flash", "gemini-2.5-pro"],
};

const siteId = (url: string) => new URL(url).hostname.split(".")[0];

export function createMockBackend(): Backend {
  const urls: string[] = [];
  const connected = new Map<string, boolean>();
  if (has("sites1") || has("sites2")) urls.push("https://alpha.example.com");
  if (has("sites2")) urls.push("https://beta.example.com");
  urls.forEach((u) => connected.set(u, !(has("expired") && u.includes("beta"))));
  // 网络等暂时性问题：凭据还在，重试后能恢复
  const offline = new Set(has("offline") ? urls.filter((u) => u.includes("beta")) : []);
  // 数据丢失场景：启动时没有站点，但“记录”里有 Alpha 和 Beta
  let lossPending = has("dataloss");
  let lastFetch = 0;
  let fetchCalls = 0;
  const customNames = new Map<string, string>();
  const active: Partial<Record<ClientId, { site_id: string; site_name: string; group_id: string; group_name: string; model: string | null }>> = {};
  const created = new Set<string>();
  let appliedOpened: string[] = [];

  const view = (url: string): SiteView => {
    const d = SITE_DEFS[url];
    const ok = (connected.get(url) ?? false) && !offline.has(url);
    return {
      id: siteId(url),
      kind: d.kind,
      name: customNames.get(url) ?? d.name,
      base_url: url,
      connected: ok,
      account: ok ? ({ display: d.kind === "sub2api" ? "demo@example.com" : "demo", balance: d.balance } as AccountInfo) : null,
      error: ok ? null : offline.has(url) ? "暂时无法连接站点（请求超时，请检查网络），稍后会自动重试" : "登录已过期，请重新登录",
      needs_login: !ok && !offline.has(url),
    };
  };
  const urlOf = (id: string) => urls.find((u) => siteId(u) === id);
  const normalize = (raw: string) => {
    let s = raw.trim();
    if (!s) throw new Error("请输入站点地址");
    if (!s.includes("://")) s = "https://" + s;
    const host = s.split("://")[1].split("/")[0].toLowerCase();
    if (s.startsWith("http://") && !host.startsWith("localhost") && !host.startsWith("127.0.0.1")) throw new Error("出于安全考虑，只支持 https 站点（本机地址除外）");
    return "https://" + host;
  };

  return {
    async appVersion() {
      return "0.4.0";
    },
    async checkUpdate() {
      await delay();
      if (has("check-fail")) throw new Error("无法获取更新信息，请稍后再试");
      return has("update") || has("update-fail") ? { version: "0.4.0", notes: "新增多站点支持" } : null;
    },
    async installUpdate() {
      await sleep(has("slow") ? 1500 : 300);
      if (has("update-fail")) throw new Error("下载更新失败，请检查网络后重试");
      (window as unknown as { __relaunched?: boolean }).__relaunched = true;
    },

    async loadSites() {
      await delay();
      return urls.map(view);
    },
    async dataLoss() {
      await delay();
      return lossPending ? { sites: [{ name: "Alpha", base_url: "https://alpha.example.com" }, { name: "Beta", base_url: "https://beta.example.com" }] } : null;
    },
    async restoreSites() {
      await delay();
      for (const u of ["https://alpha.example.com", "https://beta.example.com"]) {
        if (!urls.includes(u)) urls.push(u);
        connected.set(u, false); // 没有凭据：需要重新登录
      }
      lossPending = false;
    },
    async dismissDataLoss() {
      await delay();
      lossPending = false;
    },
    async detectSite(url): Promise<DetectedSite> {
      await delay();
      const base = normalize(url);
      if (base.includes("captcha.example.com")) throw new Error("该站点开启了人机验证，暂不支持在应用内登录");
      const d = SITE_DEFS[base];
      if (!d) throw new Error("无法识别该站点类型，目前支持 new-api 和 sub2api");
      return { base_url: base, kind: d.kind, name: base.split("://")[1] };
    },
    async addSite({ baseUrl, name, username, password }) {
      await delay();
      const base = normalize(baseUrl);
      const d = SITE_DEFS[base];
      if (!d) throw new Error("无法识别该站点类型，目前支持 new-api 和 sub2api");
      if (!username.trim() || password !== "ok123") throw new Error(d.kind === "newapi" ? "账号或密码不正确，或账号已被禁用" : "账号或密码不正确");
      if (!urls.includes(base)) urls.push(base);
      connected.set(base, true);
      if (name?.trim()) customNames.set(base, name.trim());
      return view(base);
    },
    async removeSite(id) {
      await delay();
      const u = urlOf(id);
      if (!u) throw new Error("站点不存在");
      urls.splice(urls.indexOf(u), 1);
      for (const c of Object.keys(active) as ClientId[]) if (active[c]?.site_id === id) delete active[c];
    },
    async groupModelsMap() {
      await delay();
      return {} as Record<string, string[]>;
    },
    async groupUsage(siteId, groupId) {
      ((window as unknown as { __usageCalls?: string[] }).__usageCalls ??= []).push(`${siteId}/${groupId}`);
      await sleep(has("slow") ? 1200 : 300);
      if (has("usagefail")) throw new Error("站点限流了（429），请 30 秒后再试");
      const base = { window_days: 7, currency: "$", nominal_multiplier: 1, sampled: false, sample_requests: 0, fetched_at: Math.floor(Date.now() / 1000), models: [], estimates: [], notes: [] as string[] };
      if (has("nousage") || groupId === "4") {
        return { ...base, requests: 0, input_tokens: 0, output_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 0, effective_tokens: 0, cost: 0, official_cost: null, cost_per_m_effective: null, cache_hit_rate: null, actual_multiplier: null, first_token_median_ms: null, first_token_p90_ms: null, first_token_samples: 0, avg_duration_ms: null, total_requests: 0 };
      }
      void siteId;
      return {
        ...base, requests: 120, total_requests: 120, input_tokens: 600_000, output_tokens: 400_000, cache_creation_tokens: 100_000, cache_read_tokens: 300_000, effective_tokens: 1_000_000,
        cost: 2, official_cost: 4, cost_per_m_effective: 2 + (Number(groupId) || 0) / 10, cache_hit_rate: 0.3 + (Number(groupId) || 0) / 100, actual_multiplier: 0.5, first_token_median_ms: has("realfrt") ? 820 : null, first_token_p90_ms: has("realfrt") ? 2100 : null, first_token_samples: has("realfrt") ? 40 : 0, avg_duration_ms: 3200,
        models: [{ model: "claude-sonnet-5-5", requests: 100, input_tokens: 500_000, output_tokens: 300_000, cache_creation_tokens: 90_000, cache_read_tokens: 250_000, cost: 1.8, cost_per_m_effective: 2.25 }, { model: "claude-haiku-5-5", requests: 20, input_tokens: 100_000, output_tokens: 100_000, cache_creation_tokens: 10_000, cache_read_tokens: 50_000, cost: 0.2, cost_per_m_effective: 1 }],
        estimates: [{ model: "claude-sonnet-5-5", input_per_m: 1.5, output_per_m: 7.5, cache_read_per_m: 0.15 }],
      };
    },
    async probeGroup(siteId, groupId) {
      // 测试用：记录实际向“站点”发了几次、发给哪个站点
      const w = window as unknown as { __probeSites?: string[] };
      (w.__probeSites ??= []).push(siteId);
      await sleep(has("slow") ? 1200 : 400);
      if (has("ratelimit") && siteId === "alpha") throw new Error("站点限流了（429），请 30 秒后再试");
      if (has("keyfail") && siteId === "alpha") throw new Error("创建 Key 后没有找到它");
      if (has("probefail") && siteId === "alpha") {
        // 对应 bestapi.io 后台里真实出现过的几种上游失败
        if (groupId === "2") throw new Error("Insufficient account balance");
        if (groupId === "4") throw new Error("No available accounts: no available accounts");
        if (groupId === "12") throw new Error("分组 CCMAXcode（限制claude code） 下模型 claude-sonnet-5-5 的可用渠道不存在（retry）");
      }
      const v = view(urlOf(siteId)!);
      const ms = 300 + ((groupId.length * 137) % 900);
      return { first_ms: ms, total_ms: ms + 700, input_tokens: 24, model: "claude-sonnet-5-5", models: v ? ["claude-sonnet-5-5", "claude-sonnet-5"] : [] };
    },
    async refreshAccounts() {
      await delay();
      offline.clear(); // 网络恢复了
      return urls.map(view);
    },
    async listGroups(maxAgeSecs = 0) {
      await delay();
      // 和真实后端一致：maxAge 秒内拉过就用缓存（时间不变）；手动刷新（0）一定重新拉
      const nowS = Math.floor(Date.now() / 1000);
      if (!(maxAgeSecs > 0 && lastFetch > 0 && nowS - lastFetch < maxAgeSecs)) {
        lastFetch = nowS;
        (window as unknown as { __listGroupsCalls: number }).__listGroupsCalls = ++fetchCalls;
      }
      const groups: GroupView[] = [];
      for (const u of urls) {
        if (!connected.get(u) || offline.has(u)) continue;
        const v = view(u);
        if (!has("empty")) groups.push(...SITE_DEFS[u].groups.map((x) => ({ ...x, models: x.models ?? (has("plaza") ? (SITE_DEFS[u].kind === "sub2api" ? (x.clients.length > 0 ? MODELS[x.clients[0]] : []) : ["beta-only-model", "claude-sonnet-5-5"]) : []), clients_inferred: x.clients_inferred ?? SITE_DEFS[u].kind === "newapi", site_id: v.id, site_name: v.name })));
      }
      return { groups, sites: urls.map(view), fetched_at: lastFetch };
    },
    async overview(): Promise<ClientOverview[]> {
      return (["claude", "claude_desktop", "codex", "gemini"] as ClientId[]).map((c) => ({
        client: c,
        dir_exists: !has("nodir"),
        in_use: !!active[c],
        active: active[c] ?? null,
        groups_inferred: has("unclassified"),
        conflicts:
          has("conflict") && c === "claude"
            ? ["/Users/me/.zshrc: ANTHROPIC_BASE_URL", "/Users/me/.claude/settings.local.json: env.ANTHROPIC_AUTH_TOKEN"]
            : has("desktop-off") && c === "claude_desktop"
              ? ["Claude Desktop 还没有切换到第三方推理模式（当前：未设置）：请在 Claude Desktop 里进入 开发者 → 配置第三方推理，然后完全退出（⌘Q）再打开"]
              : [],
      }));
    },
    async enableGroup(siteIdArg, groupId, client, model): Promise<EnableOutcome> {
      await delay();
      if (has("enable-fail")) throw new Error("无法连接到服务器，请检查网络");
      const u = urlOf(siteIdArg);
      if (!u) throw new Error("站点不存在");
      if (has("expire-on-enable")) connected.set(u, false);
      if (!connected.get(u)) throw new Error("登录已过期，请重新登录");
      const grp = SITE_DEFS[u].groups.find((x) => x.id === groupId);
      if (!grp) throw new Error("分组不存在或已无权使用");
      if (grp.clients.length === 0) throw new Error(`「${grp.name}」暂不支持一键配置（平台：${grp.platform}）`);
      if (!grp.clients.includes(client)) throw new Error(`「${grp.name}」不能配置到 ${client}`);
      const models = MODELS[client];
      const chosen = model ?? models[0];
      if (!models.includes(chosen)) throw new Error(`该分组没有模型 ${chosen}`);
      const k = `${siteIdArg}:${groupId}`;
      const key_created = !created.has(k);
      created.add(k);
      active[client] = { site_id: siteIdArg, site_name: view(u).name, group_id: groupId, group_name: grp.name, model: chosen };
      return { client, key_created, models, model: chosen, conflicts: [] };
    },
    async groupModels(siteIdArg, groupId) {
      await delay();
      const u = urlOf(siteIdArg);
      const grp = u && SITE_DEFS[u].groups.find((x) => x.id === groupId);
      return grp && grp.clients.length > 0 ? MODELS[grp.clients[0]] : [];
    },
    async topupUrl(id) {
      const u = urlOf(id);
      if (!u) throw new Error("站点不存在");
      return SITE_DEFS[u].kind === "sub2api" ? `${u}/purchase` : `${u}/console/topup`;
    },
    async openUrl(url) {
      appliedOpened = [...appliedOpened, url];
      (window as unknown as { __opened?: string[] }).__opened = appliedOpened;
    },
  };
}
