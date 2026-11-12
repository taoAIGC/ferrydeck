export type ClientId = "claude" | "claude_desktop" | "codex" | "gemini";
/** 客户端 tab：四个能一键配置的客户端，加上“其他”（分组的用途不在这四个里，只能归类，不能一键配置） */
export type TabId = ClientId | "other";

/** 侧边栏显示顺序 */
export const CLIENT_ORDER: ClientId[] = ["claude", "claude_desktop", "codex", "gemini"];
export const TAB_ORDER: TabId[] = [...CLIENT_ORDER, "other"];

export type SiteKind = "sub2api" | "newapi";

export interface AccountInfo {
  display: string;
  /** 已按站点设置格式化好的余额，如 "$99.78" */
  balance: string;
}

export interface SiteView {
  id: string;
  kind: SiteKind;
  name: string;
  base_url: string;
  connected: boolean;
  account: AccountInfo | null;
  /** 登录过期、网络问题等原因；没有问题时为 null */
  error: string | null;
  /** 凭据已失效，只能重新登录；为 false 而未连接时是网络等暂时性问题，会自动重试 */
  needs_login: boolean;
  /** 登录时勾选了“我是该站点管理员” */
  is_admin: boolean;
}

export interface DetectedSite {
  base_url: string;
  kind: SiteKind;
  name: string;
}

export interface GroupView {
  site_id: string;
  site_name: string;
  id: string;
  name: string;
  description: string | null;
  platform: string;
  rate_multiplier: number;
  /** 可配置的客户端；空数组表示暂不支持一键配置 */
  clients: TabId[];
  /** 后端给的“其他”标记；前端会把它并进 `clients` */
  other?: boolean;
  /** 分组已自带的模型（sub2api 不提供，前端额外拉取） */
  models: string[];
  /** 站点的分组没有平台分类，`clients` 是按模型推断的 */
  clients_inferred: boolean;
}

export interface GroupsResult {
  groups: GroupView[];
  sites: SiteView[];
  /** 最近一次真正向站点拉取分组的时间（unix 秒，从没拉过为 0）；命中缓存时不变 */
  fetched_at: number;
}

export interface Active {
  site_id: string;
  site_name: string;
  group_id: string;
  group_name: string;
  model: string | null;
}

export interface ClientOverview {
  client: ClientId;
  dir_exists: boolean;
  in_use: boolean;
  active: Active | null;
  conflicts: string[];
  /** 当前用的是按模型推断的分组 */
  groups_inferred: boolean;
}

export interface EnableOutcome {
  client: ClientId;
  key_created: boolean;
  models: string[];
  model: string | null;
  conflicts: string[];
}

export interface ProbeResult {
  first_ms: number;
  total_ms: number;
  /** 站点报告的“hi”这类空请求的输入 token 数；没报告就是 null */
  input_tokens?: number | null;
  model: string;
  models: string[];
}

export interface ModelUsage {
  model: string;
  requests: number;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  cost: number;
  cost_per_m_effective: number | null;
}

export interface PriceEstimate {
  model: string;
  input_per_m: number;
  output_per_m: number;
  cache_read_per_m: number | null;
}

/** 分组近 7 天的成本统计（口径见 src-tauri/src/usage.rs） */
export interface GroupUsage {
  window_days: number;
  currency: string;
  requests: number;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  effective_tokens: number;
  cost: number;
  official_cost: number | null;
  cost_per_m_effective: number | null;
  cache_hit_rate: number | null;
  actual_multiplier: number | null;
  nominal_multiplier: number;
  first_token_median_ms: number | null;
  first_token_p90_ms: number | null;
  first_token_samples: number;
  avg_duration_ms: number | null;
  /** 过去 24 小时的 Token 总量（输入+输出+缓存），站长视角才有 */
  tokens_24h?: number | null;
  tokens_24h_capped?: boolean;
  cost_24h?: number | null;
  official_cost_24h?: number | null;
  sampled: boolean;
  sample_requests: number;
  total_requests: number;
  models: ModelUsage[];
  estimates: PriceEstimate[];
  fetched_at: number;
  notes: string[];
}

/** 站长视角：一个上游账号 / 渠道（不含任何凭据） */
export interface Upstream {
  id: string;
  name: string;
  platform: string;
  kind: string;
  /** active 运行中 / paused 已暂停 / error 站点判定异常 */
  status: "active" | "paused" | "error";
  /** 站点上的原始“状态”：active / inactive / error */
  account_status: string;
  /** 状态和调度都对，但站点自动暂时摘除了它：原因和恢复时间 */
  blocked?: string | null;
  /** 站点上的“调度”开关（sub2api 才有）。能被调用到要“状态 = active 且 调度 = 开启” */
  schedulable: boolean | null;
  error: string | null;
  host: string | null;
  /** 它服务的下游分组 id */
  groups: string[];
  models: number;
  model_names: string[];
  /** 上游账号自己的计费倍率（sub2api）；new-api 的渠道没有 */
  rate_multiplier: number | null;
  priority: number | null;
}

/** 站长视角：对外的分组 */
export interface Downstream {
  id: string;
  name: string;
  description: string | null;
  platform: string;
  rate_multiplier: number;
  status: string;
  editable: boolean;
}

export interface AdminOverview {
  upstreams: Upstream[];
  downstreams: Downstream[];
  fetched_at: number;
}

/** 上游站点里的一个分组（让站长选“这个上游账号用的是哪个分组”） */
export interface GroupChoice {
  id: string;
  name: string;
  rate: number;
}

/** 一个上游账号和“上游站点里的分组”的关联（站点的管理接口不返回上游的 Key，所以由站长选一次） */
export interface UpstreamLink {
  upstream_id: string;
  host: string;
  site_id: string | null;
  site_name: string | null;
  group_id: string | null;
  group: string | null;
  /** 关联分组当前的倍率（实时读取） */
  rate: number | null;
  /** 还没关联时按账号名称里的倍率给出的推荐 */
  suggested: GroupChoice | null;
  candidates: GroupChoice[];
  note: string | null;
}

export interface LinkReport {
  links: UpstreamLink[];
  /** 这些上游的站点还没在应用里添加账号 */
  missing_hosts: string[];
}

/** 站长：新建下游分组 */
export interface NewGroup {
  name: string;
  description?: string;
  platform?: string;
  rate_multiplier: number;
}

/** 站长：给下游分组添加上游后的结果 */
export interface AddedUpstream {
  upstream_id: string;
  name: string;
  key_created: boolean;
  models: number;
  probe_ms: number;
  paused: boolean;
}

/** “sayhi”测试的结果：模型的回复文字和延迟 */
export interface SayHi {
  model: string;
  reply: string;
  first_ms: number;
  total_ms: number;
  input_tokens: number | null;
}

/** 基于上游分组创建下游分组后的结果 */
export interface CreatedDownstream {
  group_id: string;
  added: AddedUpstream;
}

/** 一个上游分组底下挂着的下游分组（站长的站点、分组名、倍率） */
export interface DownstreamRef {
  up_site_id: string;
  up_group_id: string;
  site_id: string;
  site_name: string;
  group_id: string;
  group_name: string;
  rate: number;
}

export interface GroupEdit {
  name?: string;
  description?: string;
  platform?: string;
  rate_multiplier?: number;
}

/** 数据目录被清理软件等外力清空时，以前添加过的站点（只有名称和地址，没有凭据） */
export interface DataLoss {
  sites: { name: string; base_url: string }[];
}

export interface UpdateInfo {
  version: string;
  notes: string | null;
}

export interface Backend {
  appVersion(): Promise<string>;
  /** 有新版本返回信息，已是最新返回 null；检查失败会抛错 */
  checkUpdate(): Promise<UpdateInfo | null>;
  /** 下载并安装已发现的新版本，完成后自动重启 */
  installUpdate(): Promise<void>;

  /** 启动时调用：读出已保存的站点并恢复登录 */
  loadSites(): Promise<SiteView[]>;
  /** 校验地址并识别站点类型 */
  detectSite(url: string): Promise<DetectedSite>;
  /** 添加站点并登录；已存在则重新登录 */
  addSite(args: { baseUrl: string; name?: string; username: string; password: string; isAdmin?: boolean }): Promise<SiteView>;
  removeSite(siteId: string): Promise<void>;
  /** 启动时：没有站点但记录里以前有，返回以前的站点；否则 null */
  dataLoss(): Promise<DataLoss | null>;
  /** 按记录恢复站点列表（不含凭据，恢复后每个站点要重新登录） */
  restoreSites(): Promise<void>;
  /** 用户选择“忽略，重新开始”：清掉记录，不再提示 */
  dismissDataLoss(): Promise<void>;
  refreshAccounts(): Promise<SiteView[]>;
  /** maxAgeSecs：这么多秒内拉过就直接用缓存；不传或 0 表示一定向站点重新拉（手动刷新） */
  listGroups(maxAgeSecs?: number): Promise<GroupsResult>;
  overview(): Promise<ClientOverview[]>;
  enableGroup(siteId: string, groupId: string, client: ClientId, model?: string | null): Promise<EnableOutcome>;
  groupModels(siteId: string, groupId: string): Promise<string[]>;
  /** 为所有分组拉取真实可用模型（只用已存在的 Key） */
  groupModelsMap(): Promise<Record<string, string[]>>;
  /** 测速并返回该分组真实可用的模型 */
  probeGroup(siteId: string, groupId: string, model?: string | null, client?: ClientId): Promise<ProbeResult>;
  groupUsage(siteId: string, groupId: string, force?: boolean): Promise<GroupUsage>;
  adminOverview(siteId: string): Promise<AdminOverview>;
  /** 站长视角的近 7 天用量：scope = group（下游分组，花费 = 用户实付）/ account（上游账号，花费 = 付给上游的成本） */
  adminUsage(siteId: string, scope: "group" | "account", id: string, force?: boolean): Promise<GroupUsage>;
  adminCreateGroup(siteId: string, group: NewGroup): Promise<string>;
  adminAddUpstream(siteId: string, downstreamId: string, upstreamSiteId: string, upstreamGroupId: string, name?: string, paused?: boolean, allowDuplicate?: boolean, testModel?: string): Promise<AddedUpstream>;
  adminReplaceUpstream(siteId: string, upstreamId: string, upstreamSiteId: string, upstreamGroupId: string, name?: string, testModel?: string): Promise<AddedUpstream>;
  adminSetAccountState(siteId: string, upstreamId: string, status?: "active" | "inactive" | "error", schedulable?: boolean): Promise<void>;
  adminRemoveGroup(siteId: string, groupId: string): Promise<void>;
  setGroupClients(siteId: string, groupId: string, clients: TabId[]): Promise<void>;
  sayHi(siteId: string, groupId: string, model?: string | null, client?: ClientId): Promise<SayHi>;
  adminCreateDownstream(siteId: string, upstreamSiteId: string, upstreamGroupId: string, name: string, platform: string | undefined, rate: number, description: string | undefined, paused: boolean, testModel?: string): Promise<CreatedDownstream>;
  adminDownstreams(): Promise<DownstreamRef[]>;
  adminLinks(siteId: string): Promise<LinkReport>;
  adminSetLink(siteId: string, upstreamId: string, linkSiteId: string | null, groupId: string | null): Promise<void>;
  adminSetPaused(siteId: string, upstreamId: string, paused: boolean): Promise<void>;
  adminRemoveUpstream(siteId: string, upstreamId: string): Promise<void>;
  adminUpdateGroup(siteId: string, groupId: string, edit: GroupEdit): Promise<void>;
  topupUrl(siteId: string): Promise<string>;
  openUrl(url: string): Promise<void>;
}

export const CLIENTS: Record<TabId, { name: string; restartHint: string }> = {
  other: { name: "其他", restartHint: "" },
  claude: { name: "Claude Code", restartHint: "请重新打开终端里的 claude 后生效" },
  claude_desktop: { name: "Claude Desktop", restartHint: "请完全退出（⌘Q）并重新打开 Claude Desktop 后生效" },
  codex: { name: "Codex", restartHint: "请重新打开终端里的 codex 后生效" },
  gemini: { name: "Gemini CLI", restartHint: "请重新打开终端里的 gemini 后生效" },
};

export const KIND_LABEL: Record<SiteKind, string> = { sub2api: "sub2api", newapi: "new-api" };
