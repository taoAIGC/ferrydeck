import type { AccountInfo, Backend, ClientId, TabId, ClientOverview, DetectedSite, EnableOutcome, GroupView, SiteKind, SiteView } from "./types";

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

const MODELS: Record<TabId, string[]> = {
  other: [],
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
      is_admin: admins.has(url),
    };
  };
  const admins = new Set<string>(has("admin") ? ["https://alpha.example.com", ...(has("sites2") ? ["https://beta.example.com"] : [])] : []);
  // 站长视角的模拟数据（按站点地址保存，操作会真的改它）
  const linkChoice = new Map<string, string>();
  const addedSources = new Set<string>();
  const clientOverrides = new Map<string, TabId[]>();
  const downRefs: import("./types").DownstreamRef[] = [];
  const adminData = new Map<string, import("./types").AdminOverview>();
  const adminOf = (url: string) => {
    if (!adminData.has(url)) {
      const alpha = SITE_DEFS[url].kind === "sub2api";
      adminData.set(url, {
        fetched_at: Math.floor(Date.now() / 1000),
        downstreams: alpha
          ? [
              { id: "2", name: "Claude 官方系列高速", description: "官方直连，速度最快", platform: "anthropic", rate_multiplier: 2.5, status: "active", editable: true },
              { id: "4", name: "Claude 逆向Kiro", description: "性价比高，适合日常编码", platform: "anthropic", rate_multiplier: 0.28, status: "active", editable: true },
              { id: "12", name: "Claude 逆向Kiro - 特价", description: null, platform: "anthropic", rate_multiplier: 0.12, status: "active", editable: true },
              { id: "99", name: "未绑定的分组", description: null, platform: "openai", rate_multiplier: 1, status: "active", editable: true },
            ]
          : [{ id: "GPT Pro", name: "GPT Pro", description: "GPT PRO 账号", platform: "", rate_multiplier: 0.258, status: "active", editable: true }],
        upstreams: alpha
          ? [
              { id: "u1", name: "官方账号池 0.09", platform: "anthropic", kind: "apikey", status: "active", account_status: "active", schedulable: true, blocked: has("blocked") ? "触发了上游限流（429），约 5 分钟后自动恢复" : null, error: null, host: "api.up-one.com", groups: ["2", "4"], models: 12, model_names: ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5"], rate_multiplier: 1, priority: 50 },
              { id: "u2", name: "备用上游 0.35", platform: "anthropic", kind: "apikey", status: "paused", account_status: "active", schedulable: false, error: null, host: "api.up-two.com", groups: ["4", "12"], models: 8, model_names: ["claude-sonnet-5-5", "claude-sonnet-5"], rate_multiplier: 0.5, priority: 60 },
              { id: "u3", name: has("hint") ? "异常账号 0.7" : "异常账号", platform: "anthropic", kind: "oauth", status: "error", account_status: "error", schedulable: true, error: "401 invalid key", host: has("hint") ? "api.up-three.com" : null, groups: ["12"], models: 3, model_names: ["claude-haiku-5-5"], rate_multiplier: null, priority: null },
            ]
          : [{ id: "7", name: "渠道 A", platform: "", kind: "14", status: "active", account_status: "active", schedulable: null, error: null, host: "up.example.com", groups: ["GPT Pro"], models: 5, model_names: ["gpt-5.6-sol", "gpt-6-sol"], rate_multiplier: null, priority: 10 }],
      });
    }
    return adminData.get(url)!;
  };
  const urlOf = (id: string) => urls.find((u) => siteId(u) === id);
  const normalize = (raw: string) => {
    let s = raw.trim();
    if (!s) throw new Error("请输入站点地址");
    if (!s.includes("://")) s = "https://" + s;
    const host = s.split("://")[1].split("/")[0].toLowerCase();
    return (s.startsWith("http://") ? "http://" : "https://") + host;
  };

  return {
    async appVersion() {
      return "0.5.3";
    },
    async checkUpdate() {
      await delay();
      if (has("check-fail")) throw new Error("无法获取更新信息，请稍后再试");
      return has("update") || has("update-fail") ? { version: "0.6.0", notes: "新增多站点支持" } : null;
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
    async addSite({ baseUrl, name, username, password, isAdmin }) {
      await delay();
      const base = normalize(baseUrl);
      const d = SITE_DEFS[base];
      if (!d) throw new Error("无法识别该站点类型，目前支持 new-api 和 sub2api");
      if (!username.trim() || password !== "ok123") throw new Error(d.kind === "newapi" ? "账号或密码不正确，或账号已被禁用" : "账号或密码不正确");
      if (!urls.includes(base)) urls.push(base);
      connected.set(base, true);
      if (name?.trim()) customNames.set(base, name.trim());
      if (isAdmin) admins.add(base);
      ((window as unknown as { __addArgs?: unknown[] }).__addArgs ??= []).push({ baseUrl: base, isAdmin: !!isAdmin });
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
        ...base, requests: has("fewcalls") ? 30 : 120, total_requests: has("fewcalls") ? 30 : 120, input_tokens: 600_000, output_tokens: 400_000, cache_creation_tokens: 100_000, cache_read_tokens: 300_000, effective_tokens: 1_000_000,
        tokens_24h: 500_000, cost_24h: 3, cost: 2, official_cost: 4, cost_per_m_effective: 2 + (Number(groupId) || 0) / 10, cache_hit_rate: 0.3 + (Number(groupId) || 0) / 100, actual_multiplier: 0.5, first_token_median_ms: has("realfrt") ? 820 : null, first_token_p90_ms: has("realfrt") ? 2100 : null, first_token_samples: has("realfrt") ? 40 : 0, avg_duration_ms: 3200,
        models: [{ model: "claude-sonnet-5-5", requests: 100, input_tokens: 500_000, output_tokens: 300_000, cache_creation_tokens: 90_000, cache_read_tokens: 250_000, cost: 1.8, cost_per_m_effective: 2.25 }, { model: "claude-haiku-5-5", requests: 20, input_tokens: 100_000, output_tokens: 100_000, cache_creation_tokens: 10_000, cache_read_tokens: 50_000, cost: 0.2, cost_per_m_effective: 1 }],
        estimates: [{ model: "claude-sonnet-5-5", input_per_m: 1.5, output_per_m: 7.5, cache_read_per_m: 0.15 }],
      };
    },
    async adminOverview(siteId) {
      await delay();
      const u = urlOf(siteId);
      if (!u || !admins.has(u)) throw new Error("这个站点没有开启管理员模式");
      if (has("adminfail")) throw new Error("站点限流了（429），请 30 秒后再试");
      return JSON.parse(JSON.stringify(adminOf(u)));
    },
    async adminUsage(siteId, scope, id) {
      await sleep(has("slow") ? 900 : 200);
      ((window as unknown as { __adminUsageCalls?: string[] }).__adminUsageCalls ??= []).push(`${siteId}/${scope}/${id}`);
      if (has("adminusage-fail")) throw new Error("站点限流了（429），请 30 秒后再试");
      const base = { window_days: 7, currency: "$", nominal_multiplier: 1, sampled: false, sample_requests: 0, fetched_at: Math.floor(Date.now() / 1000), models: [], estimates: [], notes: [] as string[] };
      if (id === "99" || id === "u3") return { ...base, requests: 0, total_requests: 0, input_tokens: 0, output_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 0, effective_tokens: 0, cost: 0, official_cost: null, cost_per_m_effective: null, cache_hit_rate: null, actual_multiplier: null, first_token_median_ms: null, first_token_p90_ms: null, first_token_samples: 0, avg_duration_ms: null };
      const up = scope === "account";
      return { ...base, requests: id === "12" ? 30 : 400, total_requests: id === "12" ? 30 : 400, input_tokens: 600_000, output_tokens: 400_000, cache_creation_tokens: 0, cache_read_tokens: 300_000, effective_tokens: 1_000_000, cost: up ? 1.5 : 2.5, official_cost: 5, cost_per_m_effective: up ? 1.5 : 2.5, cache_hit_rate: 0.33, actual_multiplier: 0.5, tokens_24h: id === "2" ? 25_900_000 : id === "u1" ? 1_200_000 : 340_000, tokens_24h_capped: id === "4", cost_24h: (id === "2" ? 25_900_000 : id === "u1" ? 1_200_000 : 340_000) / 1e6 * 5, official_cost_24h: (id === "2" ? 25_900_000 : id === "u1" ? 1_200_000 : 340_000) / 1e6 * 10, first_token_median_ms: up ? 700 : 900, first_token_p90_ms: 1500, first_token_samples: 20, avg_duration_ms: 2000 };
    },
    async adminCreateGroup(siteId, group) {
      await delay();
      if (has("createfail")) throw new Error("已经有一个叫「" + group.name + "」的分组");
      const d = adminOf(urlOf(siteId)!);
      const id = `n${d.downstreams.length + 1}`;
      d.downstreams.push({ id, name: group.name, description: group.description ?? null, platform: group.platform ?? "", rate_multiplier: group.rate_multiplier, status: "active", editable: true });
      ((window as unknown as { __adminOps?: string[] }).__adminOps ??= []).push(`create-group:${group.name}:${group.platform ?? "-"}:${group.rate_multiplier}`);
      return id;
    },
    async adminAddUpstream(siteId, downstreamId, upstreamSiteId, upstreamGroupId, name, paused, allowDuplicate, testModel) {
      await sleep(has("slow") ? 900 : 300);
      const dupKey = `${upstreamSiteId}|${upstreamGroupId}`;
      if (addedSources.has(dupKey) && !allowDuplicate) throw new Error("这个上游分组已经添加过（上游账号「x」）：再添加一次会和它共用同一把上游 Key，两边的用户会互相占用它的并发和额度，需要确认后才能继续");
      addedSources.add(dupKey);
      if (has("addfail")) throw new Error("用这把 Key 在上游站点试了一次，没通：Insufficient account balance");
      const d = adminOf(urlOf(siteId)!);
      const up = { id: `a${d.upstreams.length + 1}`, name: name || `${upstreamSiteId}-${upstreamGroupId}`, platform: "anthropic", kind: "apikey", status: (paused ?? false ? "paused" : "active") as "paused" | "active", account_status: "active", schedulable: !(paused ?? false), error: null, host: `${upstreamSiteId}.example.com`, groups: [downstreamId], models: 4, model_names: ["claude-sonnet-5-5", "claude-haiku-5-5"], rate_multiplier: 0.28, priority: 50 };
      d.upstreams.push(up);
      ((window as unknown as { __adminOps?: string[] }).__adminOps ??= []).push(`add-upstream:${downstreamId}:${upstreamSiteId}:${upstreamGroupId}:${paused ?? false}${testModel ? `:model=${testModel}` : ""}`);
      return { upstream_id: up.id, name: up.name, key_created: true, models: 4, probe_ms: 820, paused: paused ?? false };
    },
    async setGroupClients(siteId, groupId, clients) {
      await delay();
      if (clients.length) clientOverrides.set(`${siteId}|${groupId}`, clients);
      else clientOverrides.delete(`${siteId}|${groupId}`);
      ((window as unknown as { __adminOps?: string[] }).__adminOps ??= []).push(`clients:${siteId}:${groupId}:${clients.join(",") || "-"}`);
    },
    async sayHi(siteId, groupId, model, client) {
      await sleep(has("slow") ? 900 : 250);
      void siteId;
      ((window as unknown as { __adminOps?: string[] }).__adminOps ??= []).push(`sayhi:${siteId}:${groupId}:${model ?? "-"}:${client ?? "-"}`);
      if (has("sayhifail")) throw new Error("Insufficient account balance");
      return { model: model ?? "claude-sonnet-5-5", reply: "你好！有什么我可以帮你的吗？", first_ms: 640, total_ms: 1180, input_tokens: 9 };
    },
    async adminCreateDownstream(siteId, upstreamSiteId, upstreamGroupId, name, platform, rate, description, paused, testModel) {
      await sleep(has("slow") ? 900 : 300);
      if (has("downfail")) throw new Error("下游分组「" + name + "」已经创建，但添加上游失败：用这把 Key 在上游站点试了一次，没通：Insufficient account balance");
      const url = urlOf(siteId)!;
      const d = adminOf(url);
      const id = `m${d.downstreams.length + 1}`;
      d.downstreams.push({ id, name, description: description ?? null, platform: platform ?? "", rate_multiplier: rate, status: "active", editable: true });
      const upId = `a${d.upstreams.length + 1}`;
      d.upstreams.push({ id: upId, name: `${upstreamSiteId}-${upstreamGroupId}`, platform: platform ?? "", kind: "apikey", status: paused ? "paused" : "active", account_status: "active", schedulable: !paused, error: null, host: `${upstreamSiteId}.example.com`, groups: [id], models: 4, model_names: ["claude-sonnet-5-5"], rate_multiplier: 0.28, priority: 50 });
      downRefs.push({ up_site_id: upstreamSiteId, up_group_id: upstreamGroupId, site_id: siteId, site_name: SITE_DEFS[url].name, group_id: id, group_name: name, rate });
      ((window as unknown as { __adminOps?: string[] }).__adminOps ??= []).push(`create-downstream:${siteId}:${upstreamSiteId}:${upstreamGroupId}:${name}:${platform ?? "-"}:${rate}:${description ?? ""}:${paused}${testModel ? `:model=${testModel}` : ""}`);
      return { group_id: id, added: { upstream_id: upId, name: `${upstreamSiteId}-${upstreamGroupId}`, key_created: true, models: 4, probe_ms: 820, paused } };
    },
    async adminDownstreams() {
      await delay();
      return downRefs.map((r) => ({ ...r }));
    },
    async adminReplaceUpstream(siteId, upstreamId, upstreamSiteId, upstreamGroupId, name, testModel) {
      await sleep(has("slow") ? 900 : 300);
      if (has("replacefail")) throw new Error("用这把 Key 在上游站点试了一次，没通：Insufficient account balance");
      const up = adminOf(urlOf(siteId)!).upstreams.find((x) => x.id === upstreamId);
      if (!up) throw new Error("上游账号不存在");
      up.host = `${upstreamSiteId}.example.com`;
      up.models = 6;
      if (name) up.name = name;
      linkChoice.set(upstreamId, upstreamGroupId);
      ((window as unknown as { __adminOps?: string[] }).__adminOps ??= []).push(`replace:${upstreamId}:${upstreamSiteId}:${upstreamGroupId}:${name ?? "-"}${testModel ? `:model=${testModel}` : ""}`);
      return { upstream_id: upstreamId, name: up.name, key_created: false, models: 6, probe_ms: 700, paused: up.status === "paused" };
    },
    async adminSetAccountState(siteId, upstreamId, status, schedulable) {
      await delay();
      const up = adminOf(urlOf(siteId)!).upstreams.find((x) => x.id === upstreamId);
      if (!up) throw new Error("上游不存在");
      if (status) up.account_status = status;
      if (schedulable !== undefined) up.schedulable = schedulable;
      up.status = up.account_status === "error" ? "error" : up.account_status === "inactive" || up.schedulable === false ? "paused" : "active";
      ((window as unknown as { __adminOps?: string[] }).__adminOps ??= []).push(`state:${upstreamId}:${status ?? "-"}:${schedulable === undefined ? "-" : schedulable}`);
    },
    async adminRemoveGroup(siteId, groupId) {
      await delay();
      if (has("rmgroupfail")) throw new Error("该分组下还有用户的 Key，不能删除");
      const d = adminOf(urlOf(siteId)!);
      d.downstreams = d.downstreams.filter((x) => x.id !== groupId);
      d.upstreams.forEach((u) => (u.groups = u.groups.filter((g) => g !== groupId)));
      ((window as unknown as { __adminOps?: string[] }).__adminOps ??= []).push(`remove-group:${groupId}`);
    },
    async adminLinks(siteId) {
      await delay();
      if (!admins.has(urlOf(siteId)!)) throw new Error("这个站点没有开启管理员模式");
      const choices = [{ id: "g1", name: "Kiro-特价", rate: 0.09 }, { id: "g2", name: "Kiro-正价", rate: 0.5 }, { id: "g3", name: "GPT-Pro", rate: 0.26 }, { id: "Claude 逆向Kiro", name: "Claude 逆向Kiro", rate: 0.3 }, { id: "GPT Pro", name: "GPT Pro", rate: 0.258 }];
      const mk = (id: string, host: string, name: string) => {
        const sel = linkChoice.get(id);
        const g = choices.find((c) => c.id === sel);
        const hint = name.match(/(\d+(?:\.\d+)?)$/);
        const sug = !g && hint ? choices.filter((c) => c.rate === Number(hint[1])) : [];
        return { upstream_id: id, host, site_id: "beta", site_name: "Beta", group_id: g?.id ?? null, group: g?.name ?? null, rate: g?.rate ?? null, suggested: sug.length === 1 ? sug[0] : null, candidates: choices, note: null };
      };
      return { links: [mk("u1", "api.up-one.com", "官方账号池 0.09"), mk("u2", "api.up-one.com", "备用上游 0.35")], missing_hosts: has("alllinked") ? [] : ["api.up-two.com"] };
    },
    async adminSetLink(siteId, upstreamId, linkSiteId, groupId) {
      await delay();
      void siteId;
      if (groupId && linkSiteId) linkChoice.set(upstreamId, groupId);
      else linkChoice.delete(upstreamId);
      ((window as unknown as { __adminOps?: string[] }).__adminOps ??= []).push(`link:${upstreamId}:${groupId ?? "-"}`);
    },
    async adminSetPaused(siteId, upstreamId, paused) {
      await delay();
      const up = adminOf(urlOf(siteId)!).upstreams.find((x) => x.id === upstreamId);
      if (!up) throw new Error("上游不存在");
      up.status = paused ? "paused" : "active";
      ((window as unknown as { __adminOps?: string[] }).__adminOps ??= []).push(`${paused ? "pause" : "resume"}:${upstreamId}`);
    },
    async adminRemoveUpstream(siteId, upstreamId) {
      await delay();
      const d = adminOf(urlOf(siteId)!);
      d.upstreams = d.upstreams.filter((x) => x.id !== upstreamId);
      ((window as unknown as { __adminOps?: string[] }).__adminOps ??= []).push(`remove:${upstreamId}`);
    },
    async adminUpdateGroup(siteId, groupId, edit) {
      await delay();
      if (has("adminedit-fail")) throw new Error("站点拒绝了这次修改");
      const gr = adminOf(urlOf(siteId)!).downstreams.find((x) => x.id === groupId);
      if (!gr) throw new Error("分组不存在");
      if (edit.name !== undefined) gr.name = edit.name;
      if (edit.description !== undefined) gr.description = edit.description || null;
      if (edit.platform !== undefined) gr.platform = edit.platform;
      if (edit.rate_multiplier !== undefined) gr.rate_multiplier = edit.rate_multiplier;
      ((window as unknown as { __adminOps?: string[] }).__adminOps ??= []).push(`edit:${groupId}:${JSON.stringify(edit)}`);
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
        if (!has("empty")) groups.push(...SITE_DEFS[u].groups.map((x) => ({ ...x, models: x.models ?? (has("plaza") ? (SITE_DEFS[u].kind === "sub2api" ? (x.clients.length > 0 ? MODELS[x.clients[0]] : []) : ["beta-only-model", "claude-sonnet-5-5"]) : []), clients_inferred: x.clients_inferred ?? SITE_DEFS[u].kind === "newapi", site_id: v.id, site_name: v.name, clients: clientOverrides.get(`${v.id}|${x.id}`) ?? x.clients })));
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
