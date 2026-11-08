pub mod applog;
pub mod clients;
pub mod paths;
pub mod service;
pub mod session_store;
pub mod sites;
pub mod state;
pub mod tray;
pub mod usage;

use std::sync::Arc;

use tauri::image::Image;
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, State};

use paths::Paths;
use service::{Client, GroupView};
use sites::{GroupInfo, Kind, Site};
use state::{AppState, SiteRuntime, SiteView};

const TRAY_ID: &str = "main";
const TRAY_ICON: &[u8] = include_bytes!("../icons/tray.png");

fn to_view(rt: &SiteRuntime, g: GroupInfo) -> GroupView {
    // new-api 的分组没有平台字段，无法判断该配到哪个客户端：每种客户端下都展示，界面会加灰色说明
    let inferred = rt.site.kind == Kind::Newapi;
    GroupView {
        clients: if inferred { vec![service::Client::Claude, service::Client::ClaudeDesktop, service::Client::Codex, service::Client::Gemini] } else { service::clients_for(&g.platform) },
        site_id: rt.site.id.clone(),
        site_name: rt.site.name.clone(),
        id: g.id,
        name: g.name,
        description: g.description,
        platform: g.platform,
        rate_multiplier: g.rate_multiplier,
        models: g.models,
        clients_inferred: inferred,
    }
}

/// 一个站点的分组（已隐藏 default）。成功时记下来，供拉取失败时兜底。
pub async fn site_groups(rt: &SiteRuntime) -> Result<Vec<GroupInfo>, String> {
    let gs: Vec<GroupInfo> = rt.client.groups().await?.into_iter().filter(|g| !service::is_hidden_group(&g.name)).collect();
    *rt.last_groups.lock().await = Some(gs.clone());
    rt.last_groups_at.store(sites::http::now(), std::sync::atomic::Ordering::Relaxed);
    Ok(gs)
}

/// 界面用的分组：拉取失败时，只要不是登录失效，就继续用上一次成功的结果。
/// 返回 (分组, 错误)：有兜底数据时错误仍会记下，但分组不会消失。
/// `max_age` 秒内拉到过就直接用缓存，不再向站点发请求（0 表示一定重新拉）。
pub async fn site_groups_or_cached(rt: &SiteRuntime, max_age: i64) -> (Vec<GroupInfo>, Option<String>) {
    if max_age > 0 && sites::http::now() - rt.last_groups_at.load(std::sync::atomic::Ordering::Relaxed) < max_age {
        if let Some(gs) = rt.last_groups.lock().await.clone() {
            return (gs, None);
        }
    }
    if !rt.client.is_logged_in().await {
        // 登录还在恢复中（启动、网络刚恢复）：先显示上次的；确实需要重新登录时才清空
        let expired = rt.error.lock().await.as_deref().is_some_and(sites::is_expired);
        return (if expired { vec![] } else { rt.last_groups.lock().await.clone().unwrap_or_default() }, None);
    }
    match site_groups(rt).await {
        Ok(gs) => (gs, None),
        Err(e) if sites::is_expired(&e) => {
            *rt.last_groups.lock().await = None;
            (vec![], Some(e))
        }
        Err(e) => {
            applog::log("groups_fail", &format!("{} ({}) 拉取分组失败，继续显示上一次的：{e}", rt.site.name, rt.site.base_url));
            (rt.last_groups.lock().await.clone().unwrap_or_default(), Some(e))
        }
    }
}

async fn find_group(rt: &SiteRuntime, id: &str) -> Result<GroupInfo, String> {
    site_groups(rt).await?.into_iter().find(|g| g.id == id).ok_or_else(|| "分组不存在或已无权使用".to_string())
}

// ---------- 菜单栏 ----------

/// 菜单栏现在是自绘面板（点图标打开），不再挂原生菜单：这里通知面板“数据变了，刷新一下”。
/// 只能在**改变了数据**的操作之后调用（加/删站点、启用分组…）；读取类命令（如 list_groups）里绝不能调用，
/// 否则面板刷新 → 读取命令 → 发事件 → 面板再刷新，会无限循环。
fn refresh_tray(app: &AppHandle) {
    let _ = app.emit("panel-shown", ());
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// 菜单栏面板：一个无边框小窗口，点图标显示在图标下方；点屏幕其他位置自动收起。
/// 用窗口而不是原生菜单，是因为原生菜单点一下就会关掉，没法连续切换多个分组。
const PANEL_ID: &str = "panel";
const PANEL_W: f64 = 380.0;
const PANEL_H: f64 = 420.0;

fn panel_visible(app: &AppHandle) -> bool {
    app.get_webview_window(PANEL_ID).is_some_and(|w| w.is_visible().unwrap_or(false))
}

fn hide_panel(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(PANEL_ID) {
        let _ = w.hide();
    }
}

/// 在菜单栏图标下方显示面板。`anchor` 是图标的物理坐标（左上角）与缩放比例。
fn show_panel(app: &AppHandle, x: f64, y_top: f64, scale: f64) {
    let Some(w) = app.get_webview_window(PANEL_ID) else { return };
    let wpx = PANEL_W * scale;
    let x = (x - wpx / 2.0).max(8.0);
    let _ = w.set_position(tauri::PhysicalPosition::new(x as i32, y_top as i32 + 4));
    let _ = w.show();
    let _ = w.set_focus();
    let _ = app.emit("panel-shown", ());
    start_outside_watch(app.clone());
}

/// 面板打开后监听“点击了其他位置”：面板失去焦点、或鼠标在面板外按下，就收起。
/// 点击菜单栏图标本身时鼠标位置在图标的矩形里，不算外部点击（交给点击事件去切换）。
fn start_outside_watch(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        // 等面板真正拿到焦点，避免刚显示就被判定为失焦
        tokio::time::sleep(std::time::Duration::from_millis(180)).await;
        let mut lost_ticks = 0;
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(80)).await;
            let Some(w) = app.get_webview_window(PANEL_ID) else { return };
            if !w.is_visible().unwrap_or(false) {
                return;
            }
            let focused = w.is_focused().unwrap_or(true);
            if focused {
                lost_ticks = 0;
                continue;
            }
            // 失焦再等几拍，避免点菜单栏图标时先失焦又切回来造成闪烁
            lost_ticks += 1;
            if lost_ticks >= 2 {
                break;
            }
        }
        // 鼠标在菜单栏图标上方时，是用户在切换面板，不收起
        if let (Some(icon), Ok(pos)) = (app.tray_by_id(TRAY_ID), app.cursor_position()) {
            if let Ok(Some(tauri::Rect { position: tauri::Position::Physical(p), size: tauri::Size::Physical(sz), .. })) = icon.rect() {
                let (px, py, pw, ph) = (p.x as f64, p.y as f64, sz.width as f64, sz.height as f64);
                if pos.x >= px && pos.x <= px + pw && pos.y >= py && pos.y <= py + ph {
                    return;
                }
            }
        }
        hide_panel(&app);
    });
}

fn toggle_panel(app: &AppHandle, x: f64, y_top: f64, scale: f64) {
    if panel_visible(app) {
        hide_panel(app);
    } else {
        show_panel(app, x, y_top, scale);
    }
}

#[tauri::command]
fn panel_close(app: AppHandle) {
    hide_panel(&app);
}

#[tauri::command]
fn panel_open_main(app: AppHandle) {
    hide_panel(&app);
    show_main(&app);
}

/// 面板里的用户操作记一行日志（只有一句人话，不含任何密钥）。
#[tauri::command]
fn panel_note(what: String) {
    applog::log("panel", &what);
}

#[tauri::command]
fn panel_quit(app: AppHandle) {
    app.exit(0);
}

fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(Image::from_bytes(TRAY_ICON)?)
        .icon_as_template(true) // 随浅色/深色菜单栏自动变色
        .tooltip("Ferrydeck")
        // 没有原生菜单，左键点击要能触发我们自己的面板（默认值 true 只在有菜单时有意义）
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            let app = tray.app_handle();
            match event {
                tauri::tray::TrayIconEvent::Click { rect, button: tauri::tray::MouseButton::Left, button_state: tauri::tray::MouseButtonState::Up, .. } => {
                    let scale = app.get_webview_window("main").and_then(|w| w.scale_factor().ok()).unwrap_or(1.0);
                    if let (tauri::Position::Physical(p), tauri::Size::Physical(sz)) = (rect.position, rect.size) {
                        // 图标在屏幕顶部，面板从图标下沿展开
                        toggle_panel(app, p.x as f64 + sz.width as f64 / 2.0, p.y as f64 + sz.height as f64, scale);
                    }
                }
                // 右键：直接打开主窗口，保留一个不依赖面板的入口
                tauri::tray::TrayIconEvent::Click { button: tauri::tray::MouseButton::Right, button_state: tauri::tray::MouseButtonState::Up, .. } => show_main(app),
                _ => {}
            }
        })
        .build(app)?;
    Ok(())
}

/// 预先创建面板窗口（隐藏），点图标时直接显示，避免首次打开卡顿。
fn build_panel(app: &AppHandle) -> tauri::Result<()> {
    let w = tauri::WebviewWindowBuilder::new(app, PANEL_ID, tauri::WebviewUrl::App("panel.html".into()))
        .title("Ferrydeck")
        .inner_size(PANEL_W, PANEL_H)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .visible(false)
        .skip_taskbar(true)
        .shadow(true)
        .build()?;
    let _ = w;
    Ok(())
}

// ---------- 命令 ----------

#[derive(serde::Serialize)]
struct DetectedSite {
    base_url: String,
    kind: Kind,
    name: String,
}

/// 校验地址、识别站点类型。给“添加站点”第一步用。
#[tauri::command]
async fn detect_site(base_url: String) -> Result<DetectedSite, String> {
    let base = sites::normalize_url(&base_url)?;
    let kind = sites::detect(&base).await?;
    sites::check_supported(&base, kind).await?;
    Ok(DetectedSite { name: sites::default_name(&base), base_url: base, kind })
}

/// 添加站点并登录；已存在的站点则重新登录。
#[tauri::command]
async fn add_site(app: AppHandle, st: State<'_, AppState>, base_url: String, name: Option<String>, username: String, password: String) -> Result<SiteView, String> {
    let base = sites::normalize_url(&base_url)?;
    let id = sites::site_id(&base);
    let existing = st.sites.read().await.iter().find(|r| r.site.id == id).cloned();
    let (rt, is_new) = match existing {
        Some(r) => (r, false),
        None => {
            let kind = sites::detect(&base).await?;
            sites::check_supported(&base, kind).await?;
            let nm = name.map(|n| n.trim().to_string()).filter(|n| !n.is_empty()).unwrap_or_else(|| sites::default_name(&base));
            (AppState::make_runtime(&st.paths, Site { id: id.clone(), kind, name: nm, base_url: base }), true)
        }
    };
    let (acc, secret) = rt.client.login(username.trim(), &password).await?;
    session_store::save(&st.paths.data, &rt.site.id, &secret);
    *rt.account.lock().await = Some(acc);
    rt.set_error(None).await;
    if is_new {
        st.sites.write().await.push(rt.clone());
    }
    st.persist_sites().await?;
    refresh_tray(&app);
    Ok(rt.view().await)
}

#[tauri::command]
async fn remove_site(app: AppHandle, st: State<'_, AppState>, site_id: String) -> Result<(), String> {
    let rt = st.find(&site_id).await?;
    rt.client.logout().await;
    session_store::clear(&st.paths.data, &site_id);
    st.sites.write().await.retain(|r| r.site.id != site_id);
    if let Ok(mut g) = st.groups.lock() {
        g.retain(|x| x.site_id != site_id);
    }
    st.persist_sites().await?;
    refresh_tray(&app);
    Ok(())
}

/// 启动时调用：读出已保存的站点，并行用保存的凭据恢复登录。登录失败的站点仍保留，提示重新登录。
#[tauri::command]
async fn load_sites(app: AppHandle, st: State<'_, AppState>) -> Result<Vec<SiteView>, String> {
    if st.sites.read().await.is_empty() {
        let saved = sites::load_sites(&st.paths.data);
        if !saved.is_empty() {
            // 老版本升级上来的用户还没有备忘：补一份
            let _ = sites::save_known_sites(&st.paths.ferrydeck_home, &saved);
        }
        let mut guard = st.sites.write().await;
        if guard.is_empty() {
            *guard = saved.into_iter().map(|s| AppState::make_runtime(&st.paths, s)).collect();
        }
    }
    let rts: Vec<Arc<SiteRuntime>> = st.sites.read().await.clone();
    let mut tasks = tokio::task::JoinSet::new();
    for rt in rts {
        tasks.spawn(async move {
            if rt.client.is_logged_in().await && rt.account.lock().await.is_some() {
                return;
            }
            rt.reconnect().await;
        });
    }
    while tasks.join_next().await.is_some() {}
    refresh_tray(&app);
    Ok(st.views().await)
}

/// 数据目录被清理软件等外力清空时给界面的信息：以前添加过哪些站点。
#[derive(serde::Serialize)]
struct DataLoss {
    sites: Vec<DataLossSite>,
}
#[derive(serde::Serialize)]
struct DataLossSite {
    name: String,
    base_url: String,
}

/// 启动时调用：没有站点、但备忘里记着以前有，就返回以前的站点（用来提示和恢复）。
#[tauri::command]
async fn data_loss(st: State<'_, AppState>) -> Result<Option<DataLoss>, String> {
    if !st.sites.read().await.is_empty() {
        return Ok(None);
    }
    Ok(sites::detect_data_loss(&st.paths.data, &st.paths.ferrydeck_home).map(|v| DataLoss { sites: v.into_iter().map(|s| DataLossSite { name: s.name, base_url: s.base_url }).collect() }))
}

/// 按备忘恢复站点列表（不含凭据：恢复后每个站点都需要重新登录）。
#[tauri::command]
async fn restore_sites(st: State<'_, AppState>) -> Result<(), String> {
    let known = sites::load_known_sites(&st.paths.ferrydeck_home);
    if known.is_empty() {
        return Err("没有可恢复的站点记录".into());
    }
    sites::save_sites(&st.paths.data, &known)
}

/// 用户选择“忽略，重新开始”：清空备忘，不再提示。
#[tauri::command]
async fn dismiss_data_loss(st: State<'_, AppState>) -> Result<(), String> {
    sites::save_known_sites(&st.paths.ferrydeck_home, &[])
}

#[tauri::command]
async fn list_sites(st: State<'_, AppState>) -> Result<Vec<SiteView>, String> {
    Ok(st.views().await)
}

/// 刷新所有站点的余额；之前因网络等原因没连上的站点顺便重试。
#[tauri::command]
async fn refresh_accounts(st: State<'_, AppState>) -> Result<Vec<SiteView>, String> {
    reconnect_all(&st).await;
    Ok(st.views().await)
}

async fn reconnect_all(st: &AppState) {
    let rts: Vec<Arc<SiteRuntime>> = st.sites.read().await.clone();
    let mut tasks = tokio::task::JoinSet::new();
    for rt in rts {
        tasks.spawn(async move { rt.reconnect().await });
    }
    while tasks.join_next().await.is_some() {}
}

/// 后台只做一件事：保持登录。多久检查一次、距上次续期多久就主动续一次。
/// 站点的刷新凭据通常几天到几周才过期，定期续期能让“滚动续期”的站点一直保持登录。
/// 检查本身只是看本地时间，**只有真正到了续期时间、或者站点掉线需要重连时才会发请求**。
const KEEPALIVE_CHECK: std::time::Duration = std::time::Duration::from_secs(10 * 60);
const KEEPALIVE_MAX_AGE: i64 = 6 * 3600;

/// 后台任务：保持各站点的登录（续期 / 掉线重连）。
///
/// **不会在后台刷新分组和模型。** 分组和模型只在这些时候才向站点要：你打开窗口或面板（一分钟内拉过就用缓存）、
/// 切回窗口、点刷新按钮、添加站点。应用最小化或只留在菜单栏时，不会为了刷新分组去打扰站点。
fn spawn_keepalive(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut tick = tokio::time::interval(KEEPALIVE_CHECK);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        tick.tick().await; // 第一次立即触发，跳过（启动时界面会自己加载）
        loop {
            tick.tick().await;
            let st = app.state::<AppState>();
            let before = serde_json::to_value(st.views().await).ok();
            let rts: Vec<Arc<SiteRuntime>> = st.sites.read().await.clone();
            let mut tasks = tokio::task::JoinSet::new();
            for rt in rts {
                tasks.spawn(async move {
                    if rt.account.lock().await.is_none() || !rt.client.is_logged_in().await {
                        // 掉线了（网络刚恢复、启动时没连上）：重连一次；登录确实失效的 reconnect 内部会直接跳过
                        applog::log("keepalive", &format!("{} ({}) 当前没有连上，尝试重新连接", rt.site.name, rt.site.base_url));
                        rt.reconnect().await;
                    } else if let Err(e) = rt.client.keep_alive(KEEPALIVE_MAX_AGE).await {
                        rt.set_error(Some(e)).await;
                    }
                });
            }
            while tasks.join_next().await.is_some() {}
            // 站点的连接状态变了（连上了、或登录确实失效了）才通知界面；界面收到后按一分钟缓存规则处理
            if serde_json::to_value(st.views().await).ok() != before {
                refresh_tray(&app);
                let _ = app.emit("sites-changed", ());
            }
        }
    });
}

#[derive(serde::Serialize)]
struct GroupsResult {
    groups: Vec<GroupView>,
    sites: Vec<SiteView>,
    /// 最近一次真正向站点拉取分组的时间（unix 秒，取各站点里最近的一次；从没拉过为 0）。
    /// 命中缓存时它不会变，界面据此显示“更新于 …”。
    fetched_at: i64,
}

/// 汇总所有已连接站点的分组；某个站点失败只影响它自己。
#[tauri::command]
async fn list_groups(st: State<'_, AppState>, max_age_secs: Option<i64>) -> Result<GroupsResult, String> {
    let max_age = max_age_secs.unwrap_or(0).clamp(0, 300);
    let rts: Vec<Arc<SiteRuntime>> = st.sites.read().await.clone();
    let mut tasks = tokio::task::JoinSet::new();
    for (i, rt) in rts.iter().cloned().enumerate() {
        tasks.spawn(async move {
            let was_logged_in = rt.client.is_logged_in().await;
            let (gs, err) = site_groups_or_cached(&rt, max_age).await;
            if was_logged_in {
                rt.set_error(err).await;
            }
            (i, gs.into_iter().map(|g| to_view(&rt, g)).collect::<Vec<_>>())
        });
    }
    let mut parts: Vec<(usize, Vec<GroupView>)> = vec![];
    while let Some(r) = tasks.join_next().await {
        if let Ok(p) = r {
            parts.push(p);
        }
    }
    parts.sort_by_key(|p| p.0); // 保持站点的添加顺序
    let groups: Vec<GroupView> = parts.into_iter().flat_map(|p| p.1).collect();
    if let Ok(mut g) = st.groups.lock() {
        *g = groups.clone();
    }
    // 注意：这里绝不能再发“数据变了”的事件（以前调用 refresh_tray 会给面板发 panel-shown，
    // 面板收到后又来调用本命令，形成无限刷新循环：面板被不停重画，按钮根本点不中）。读取分组是只读操作。
    let fetched_at = st.sites.read().await.iter().map(|r| r.last_groups_at.load(std::sync::atomic::Ordering::Relaxed)).max().unwrap_or(0);
    Ok(GroupsResult { groups, sites: st.views().await, fetched_at })
}

#[tauri::command]
fn overview(st: State<'_, AppState>) -> Vec<service::ClientOverview> {
    service::overview(&st.paths)
}

#[tauri::command]
async fn enable_group(app: AppHandle, st: State<'_, AppState>, site_id: String, group_id: String, client: String, model: Option<String>) -> Result<service::EnableOutcome, String> {
    let rt = st.find(&site_id).await?;
    let g = find_group(&rt, &group_id).await?;
    let out = service::enable(&rt.client, &rt.site, &st.paths, &g, Client::parse(&client)?, model).await;
    if let Err(e) = &out {
        if sites::is_expired(e) {
            rt.set_error(Some(sites::http::EXPIRED.into())).await;
        }
    }
    let out = out?;
    refresh_tray(&app);
    Ok(out)
}

#[tauri::command]
async fn group_models(st: State<'_, AppState>, site_id: String, group_id: String) -> Result<Vec<String>, String> {
    let rt = st.find(&site_id).await?;
    let g = find_group(&rt, &group_id).await?;
    service::group_models(&rt.client, &g).await
}

/// 为每个分组拉取真实可用模型（只用本应用已建好的 Key，不会新建）。返回 {"站点id\u0001分组id": [模型]}。
#[tauri::command]
async fn group_models_map(st: State<'_, AppState>) -> Result<std::collections::BTreeMap<String, Vec<String>>, String> {
    // 站点之间并发，站点内部顺序进行：同一站点的刷新有锁，并发也没有收益，还更容易触发站点限流
    let rts: Vec<Arc<SiteRuntime>> = st.sites.read().await.clone();
    let mut tasks = tokio::task::JoinSet::new();
    for rt in rts {
        tasks.spawn(async move {
            if !rt.client.is_logged_in().await {
                return vec![];
            }
            let (gs, _) = site_groups_or_cached(&rt, 120).await; // 刚拉过分组就不要再拉一遍
            // 站点已经给了模型列表的分组不用再查
            let todo: Vec<GroupInfo> = gs.into_iter().filter(|g| g.models.is_empty()).collect();
            // 整个站点只列一次 Key（不新建）；只对已经有 Key 的分组查询模型
            let Ok(found) = rt.client.existing_keys(&todo).await else { return vec![] };
            let mut out = vec![];
            for (n, (i, key)) in found.into_iter().enumerate() {
                if n > 0 {
                    tokio::time::sleep(std::time::Duration::from_millis(300)).await; // 对站点温柔一点
                }
                let models: Vec<String> = rt.client.models(&key).await.into_iter().filter(|m| service::is_chat_model(m)).collect();
                if !models.is_empty() {
                    out.push((format!("{}\u{1}{}", rt.site.id, todo[i].id), models));
                }
            }
            out
        });
    }
    let mut map = std::collections::BTreeMap::new();
    while let Some(r) = tasks.join_next().await {
        if let Ok(v) = r {
            map.extend(v);
        }
    }
    Ok(map)
}

/// 分组成本统计缓存多久（秒）。
const USAGE_TTL_SECS: i64 = 600;

/// 近 7 天该分组的成本统计。`force` 为真时忽略缓存（用户点了“刷新”）。
#[tauri::command]
async fn group_usage(st: State<'_, AppState>, site_id: String, group_id: String, force: Option<bool>) -> Result<usage::GroupUsage, String> {
    let rt = st.find(&site_id).await?;
    if !force.unwrap_or(false) {
        if let Some(u) = rt.usage_cache.lock().unwrap().get(&group_id) {
            if sites::http::now() - u.fetched_at < USAGE_TTL_SECS {
                return Ok(u.clone());
            }
        }
    }
    let cached = rt.last_groups.lock().await.as_ref().and_then(|gs| gs.iter().find(|g| g.id == group_id).cloned());
    let g = match cached {
        Some(g) => g,
        None => find_group(&rt, &group_id).await?,
    };
    let u = rt.client.group_usage(&g).await.inspect_err(|e| applog::log("usage_fail", &format!("{} group={} error={e}", rt.site.name, g.name)))?;
    rt.usage_cache.lock().unwrap().insert(group_id, u.clone());
    Ok(u)
}

/// 测速并拉取该分组的真实可用模型：发一个最小的流式请求，返回首字延迟与总耗时。
#[tauri::command]
async fn probe_group(st: State<'_, AppState>, site_id: String, group_id: String, model: Option<String>, client: Option<String>) -> Result<service::ProbeResult, String> {
    let target = client.as_deref().and_then(|c| service::Client::parse(c).ok()).unwrap_or(service::Client::Claude);
    let rt = st.find(&site_id).await?;
    // 测速是一批一个接一个的请求：分组信息直接用最近拉到的，不要每个分组都重新拉一遍分组列表
    let cached = rt.last_groups.lock().await.as_ref().and_then(|gs| gs.iter().find(|g| g.id == group_id).cloned());
    let g = match cached {
        Some(g) => g,
        None => find_group(&rt, &group_id).await?,
    };
    let started = std::time::Instant::now();
    let who = format!("{} ({}) group={} [{}]", rt.site.name, rt.site.base_url, g.name, g.id);
    let (key, created) = match rt.client.ensure_key(&g).await {
        Ok(v) => v,
        Err(e) => {
            applog::log("probe_fail", &format!("{who} step=key error={e}"));
            return Err(e);
        }
    };
    if created {
        applog::log("key_create", &format!("{who} 已为该分组创建专用 Key"));
    }
    let mut models: Vec<String> = rt.client.models(&key).await.into_iter().filter(|m| service::is_chat_model(m)).collect();
    if models.is_empty() {
        models = g.models.iter().filter(|m| service::is_chat_model(m)).cloned().collect();
    }
    let chosen = match model.filter(|m| models.is_empty() || models.contains(m)).or_else(|| service::default_model(target, &models)) {
        Some(m) => m,
        None => {
            applog::log("probe_fail", &format!("{who} step=model error=该分组没有可用模型（/v1/models 返回 {} 个）", models.len()));
            return Err("该分组没有可用模型，无法测速".into());
        }
    };
    let wire = sites::http::ProbeWire::for_client(target.id());
    let probe = match rt.client.probe(&key, &chosen, wire).await {
        Ok(p) => p,
        Err(e) => {
            applog::log("probe_fail", &format!("{who} client={} wire={wire:?} model={chosen} models={} error={e} ({} ms)", target.id(), models.len(), started.elapsed().as_millis()));
            return Err(e);
        }
    };
    applog::log("probe_ok", &format!("{who} client={} wire={wire:?} model={chosen} first={}ms total={}ms", target.id(), probe.first_ms, probe.total_ms));
    Ok(service::ProbeResult { first_ms: probe.first_ms, total_ms: probe.total_ms, input_tokens: probe.input_tokens, model: chosen, models })
}

#[tauri::command]
async fn topup_url(st: State<'_, AppState>, site_id: String) -> Result<String, String> {
    Ok(st.find(&site_id).await?.client.topup_url().await)
}

/// 自检模式：只有设置了环境变量 FERRYDECK_SELFTEST 才启用（值为 "update" 时走完整更新流程自检）。
#[tauri::command]
fn selftest_mode() -> Option<String> {
    std::env::var("FERRYDECK_SELFTEST").ok()
}

/// 自检模式下读取 FERRYDECK_LIVE_* 环境变量（线上联调用的账号），其他变量一律不给。
#[tauri::command]
fn selftest_env(key: String) -> Option<String> {
    if std::env::var_os("FERRYDECK_SELFTEST").is_none() || !key.starts_with("FERRYDECK_LIVE_") {
        return None;
    }
    std::env::var(key).ok()
}

/// 自检：菜单栏图标存在；点关闭按钮后窗口被隐藏而不是退出；之后能重新显示。
#[tauri::command]
async fn selftest_tray(app: AppHandle) -> Result<String, String> {
    let exists = app.tray_by_id(TRAY_ID).is_some();
    let w = app.get_webview_window("main").ok_or("找不到主窗口")?;
    w.close().map_err(|e| e.to_string())?;
    tokio::time::sleep(std::time::Duration::from_millis(400)).await;
    let hidden = !w.is_visible().map_err(|e| e.to_string())?;
    let alive = app.get_webview_window("main").is_some();
    show_main(&app);
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    let shown_again = w.is_visible().map_err(|e| e.to_string())?;
    Ok(format!("tray_exists={exists} hidden_after_close={hidden} window_alive={alive} shown_again={shown_again}"))
}

#[tauri::command]
fn selftest_report(ok: bool, text: String) {
    println!("SELFTEST {}\n{}", if ok { "PASS" } else { "FAIL" }, text);
    std::process::exit(if ok { 0 } else { 1 });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let paths = Paths::real().expect("无法确定用户目录");
    applog::init(paths.ferrydeck_home.join("logs"));
    applog::log("app_start", &format!("Ferrydeck {}", env!("CARGO_PKG_VERSION")));
    let builder = tauri::Builder::default().plugin(tauri_plugin_opener::init()).plugin(tauri_plugin_process::init());
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    let app = builder
        .manage(AppState::new(paths))
        .setup(|app| {
            build_panel(app.handle())?;
            setup_tray(app.handle())?;
            spawn_keepalive(app.handle().clone());
            Ok(())
        })
        // 点窗口关闭按钮只是隐藏，应用继续留在菜单栏；真正退出请用菜单栏里的“退出”或 ⌘Q
        .on_window_event(|window, event| {
            // 面板被点到关闭（Esc 等）时只隐藏
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![detect_site, add_site, remove_site, load_sites, list_sites, refresh_accounts, list_groups, overview, enable_group, group_models, group_models_map, probe_group, group_usage, topup_url, selftest_mode, selftest_env, selftest_tray, selftest_report, data_loss, restore_sites, dismiss_data_loss, panel_close, panel_open_main, panel_note, panel_quit])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app, event| {
        // 点 Dock 图标时把隐藏的窗口重新带出来
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Reopen { .. } = event {
            show_main(app);
        }
        #[cfg(not(target_os = "macos"))]
        let _ = (app, event);
    });
}
