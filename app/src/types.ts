export type ClientId = "claude" | "claude_desktop" | "codex" | "gemini";

/** 侧边栏显示顺序 */
export const CLIENT_ORDER: ClientId[] = ["claude", "claude_desktop", "codex", "gemini"];

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
  clients: ClientId[];
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
  sampled: boolean;
  sample_requests: number;
  total_requests: number;
  models: ModelUsage[];
  estimates: PriceEstimate[];
  fetched_at: number;
  notes: string[];
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
  addSite(args: { baseUrl: string; name?: string; username: string; password: string }): Promise<SiteView>;
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
  topupUrl(siteId: string): Promise<string>;
  openUrl(url: string): Promise<void>;
}

export const CLIENTS: Record<ClientId, { name: string; restartHint: string }> = {
  claude: { name: "Claude Code", restartHint: "请重新打开终端里的 claude 后生效" },
  claude_desktop: { name: "Claude Desktop", restartHint: "请完全退出（⌘Q）并重新打开 Claude Desktop 后生效" },
  codex: { name: "Codex", restartHint: "请重新打开终端里的 codex 后生效" },
  gemini: { name: "Gemini CLI", restartHint: "请重新打开终端里的 gemini 后生效" },
};

export const KIND_LABEL: Record<SiteKind, string> = { sub2api: "sub2api", newapi: "new-api" };
