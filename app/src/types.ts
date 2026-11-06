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
}

export interface GroupsResult {
  groups: GroupView[];
  sites: SiteView[];
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
}

export interface EnableOutcome {
  client: ClientId;
  key_created: boolean;
  models: string[];
  model: string | null;
  conflicts: string[];
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
  refreshAccounts(): Promise<SiteView[]>;
  listGroups(): Promise<GroupsResult>;
  overview(): Promise<ClientOverview[]>;
  enableGroup(siteId: string, groupId: string, client: ClientId, model?: string | null): Promise<EnableOutcome>;
  groupModels(siteId: string, groupId: string): Promise<string[]>;
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
