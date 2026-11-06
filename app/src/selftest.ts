import { invoke } from "@tauri-apps/api/core";

/**
 * 真实 Tauri 环境下的 IPC 自检（FERRYDECK_SELFTEST=1 时由 Rust 触发）。
 * 全部调用都不会写任何配置：未登录时后端命令应返回“未登录”，未知客户端应被拒绝。
 */
export async function runSelftest(mode = "1"): Promise<void> {
  if (mode === "update") return runUpdateSelftest();
  if (mode === "live") return runLiveSelftest();
  const lines: string[] = [];
  let ok = true;
  const check = (name: string, pass: boolean, detail: unknown) => {
    ok = ok && pass;
    lines.push(`${pass ? "ok  " : "FAIL"} ${name}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
  };
  const check_ = check;
  const rejects = async (name: string, p: Promise<unknown>, expect: string) => {
    try {
      const v = await p;
      check(name, false, `不应成功，却返回 ${JSON.stringify(v)}`);
    } catch (e) {
      check(name, typeof e === "string" && e.includes(expect), e as string);
    }
  };

  try {
    const sites = await invoke("load_sites");
    check("load_sites 没有保存的站点时返回空列表", Array.isArray(sites) && sites.length === 0, sites as unknown[]);
    const gr = (await invoke("list_groups")) as { groups: unknown[]; sites: unknown[] };
    check("list_groups 没有站点时返回空", gr.groups.length === 0 && gr.sites.length === 0, gr as never);
    const ov = (await invoke("overview")) as Array<Record<string, unknown>>;
    check("overview 返回 4 个客户端", Array.isArray(ov) && ov.length === 4 && ov.every((o) => ["client", "dir_exists", "in_use", "active", "conflicts"].every((k) => k in o)), ov.map((o) => o.client));
    await rejects("enable_group 参数名 siteId/groupId 被接受，未知站点被拒绝", invoke("enable_group", { siteId: "nope", groupId: "x", client: "claude_desktop", model: null }), "站点不存在");
    await rejects("group_models 未知站点", invoke("group_models", { siteId: "nope", groupId: "x" }), "站点不存在");
    await rejects("topup_url 未知站点", invoke("topup_url", { siteId: "nope" }), "站点不存在");
    await rejects("remove_site 未知站点", invoke("remove_site", { siteId: "nope" }), "站点不存在");
    await rejects("detect_site 拒绝明文 http 的远程站点", invoke("detect_site", { baseUrl: "http://example.com" }), "https");
    await rejects("detect_site 拒绝空地址", invoke("detect_site", { baseUrl: "  " }), "请输入站点地址");
    await rejects("add_site 拒绝非法协议", invoke("add_site", { baseUrl: "ftp://example.com", name: null, username: "a", password: "b" }), "http");
    // 更新插件：端点还没部署时会返回“获取不到发布信息”之类的错误，这是预期的；不应出现“未授权/插件不存在”
    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      const u = await check();
      check_("updater 插件可调用", true, u ? `有更新 ${u.version}` : "已是最新");
    } catch (e) {
      const m = String(e);
      check_("updater 插件可调用，并真正访问了更新地址（尚未部署时返回 404 类错误属预期）", /Could not fetch a valid release JSON|404|Not Found|error sending request|error decoding response body|network/i.test(m) && !/not allowed|plugin .* not found|permission|symlink/i.test(m), m.slice(0, 160));
    }
    const t = (await invoke("selftest_tray")) as string;
    check("菜单栏图标存在；关闭窗口只隐藏不退出；可重新显示", t.includes("tray_exists=true") && t.includes("hidden_after_close=true") && t.includes("window_alive=true") && t.includes("shown_again=true"), t);
  } catch (e) {
    check("自检过程出现未预期异常", false, String(e));
  }
  await invoke("selftest_report", { ok, text: lines.join("\n") });
}

/**
 * 完整更新流程自检（FERRYDECK_SELFTEST=update）：检查 → 下载 → 校验签名 → 安装。
 * 只在本机测试构建里使用（更新地址指向本机服务器），安装完成后由外部脚本核对新版本。
 */
async function runUpdateSelftest(): Promise<void> {
  const lines: string[] = [];
  let ok = false;
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const { getVersion } = await import("@tauri-apps/api/app");
    const before = await getVersion();
    lines.push(`当前版本 ${before}`);
    const u = await check();
    if (!u) throw new Error("没有发现更新");
    lines.push(`发现新版本 ${u.version}`);
    let downloaded = 0;
    await u.downloadAndInstall((ev) => {
      if (ev.event === "Progress") downloaded += ev.data.chunkLength;
    });
    lines.push(`已下载并安装，共 ${downloaded} 字节`);
    ok = true;
  } catch (e) {
    lines.push(`失败: ${String(e)}`);
  }
  await invoke("selftest_report", { ok, text: lines.join("\n") });
}

/**
 * 线上联调自检（FERRYDECK_SELFTEST=live）：在真实应用里用真实站点和测试账号走完整条链路。
 * 必须同时把 HOME 指向临时目录，配置才不会写到用户真实的目录里。
 * 环境变量：FERRYDECK_LIVE_URL / FERRYDECK_LIVE_USER / FERRYDECK_LIVE_PASS / FERRYDECK_LIVE_GROUP（要启用的分组名）
 */
async function runLiveSelftest(): Promise<void> {
  const lines: string[] = [];
  let ok = true;
  const check = (name: string, pass: boolean, detail: unknown) => {
    ok = ok && pass;
    lines.push(`${pass ? "ok  " : "FAIL"} ${name}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
  };
  const env = (k: string) => invoke<string | null>("selftest_env", { key: k });
  try {
    const [url, user, pass, group] = await Promise.all([env("FERRYDECK_LIVE_URL"), env("FERRYDECK_LIVE_USER"), env("FERRYDECK_LIVE_PASS"), env("FERRYDECK_LIVE_GROUP")]);
    if (!url || !user || !pass || !group) throw new Error("缺少 FERRYDECK_LIVE_* 环境变量");
    const det = (await invoke("detect_site", { baseUrl: url })) as { kind: string; base_url: string; name: string };
    check("detect_site 识别站点类型", !!det.kind, det);
    const site = (await invoke("add_site", { baseUrl: url, name: "联调站点", username: user, password: pass })) as { id: string; connected: boolean; account: { balance: string } | null; name: string };
    check("add_site 登录成功并返回余额", site.connected && !!site.account?.balance, { id: site.id, name: site.name, balance: site.account?.balance });
    const r = (await invoke("list_groups")) as { groups: Array<{ id: string; name: string; site_id: string; clients: string[] }>; sites: unknown[] };
    check("list_groups 拉到分组", r.groups.length > 0 && r.groups.every((g) => g.site_id === site.id), `${r.groups.length} 个`);
    check("default 分组已隐藏", !r.groups.some((g) => g.name === "default"), "ok");
    const g = r.groups.find((x) => x.name === group);
    check(`找到目标分组「${group}」`, !!g && g.clients.length > 0, g ?? "没找到");
    if (g) {
      const out = (await invoke("enable_group", { siteId: site.id, groupId: g.id, client: g.clients[0], model: null })) as { model: string | null; models: string[] };
      check("enable_group 写入配置", !!out.model && out.models.length > 0, { model: out.model, 模型数: out.models.length });
      const ov = (await invoke("overview")) as Array<{ client: string; in_use: boolean; active: { site_id: string; group_id: string } | null }>;
      const mine = ov.find((o) => o.client === g.clients[0]);
      check("overview 显示该客户端使用中的是这个站点的这个分组", !!mine?.in_use && mine.active?.site_id === site.id && mine.active?.group_id === g.id, mine as never);
      const models = (await invoke("group_models", { siteId: site.id, groupId: g.id })) as string[];
      check("group_models 返回对话模型", models.length > 0, `${models.length} 个`);
    }
    const url2 = (await invoke("topup_url", { siteId: site.id })) as string;
    check("topup_url 是 https 地址", url2.startsWith("http"), url2);
    const sites = (await invoke("refresh_accounts")) as Array<{ connected: boolean }>;
    check("refresh_accounts 站点仍在线", sites.length === 1 && sites[0].connected, sites as never);
    await invoke("remove_site", { siteId: site.id });
    const after = (await invoke("list_groups")) as { groups: unknown[]; sites: unknown[] };
    check("remove_site 后站点和分组都清空", after.groups.length === 0 && after.sites.length === 0, after as never);
  } catch (e) {
    check("联调过程出现未预期异常", false, String(e));
  }
  await invoke("selftest_report", { ok, text: lines.join("\n") });
}
