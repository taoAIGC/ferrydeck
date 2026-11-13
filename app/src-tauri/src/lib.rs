pub mod admin;
pub mod applog;
pub mod clients;
pub mod overrides;
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
    let mut inferred = rt.site.kind == Kind::Newapi;
    let mut clients = if inferred { vec![service::Client::Claude, service::Client::ClaudeDesktop, service::Client::Codex, service::Client::Gemini] } else { service::clients_for(&g.platform) };
    // 用户手动设置过“支持哪些客户端”就以它为准
    let mut categories = None;
    if let Some(list) = overrides::load(&rt.data_dir).get(&overrides::key(&rt.site.id, &g.id)) {
        let cats = service::normalize_categories(list);
        clients = service::clients_for_categories(&cats);
        categories = Some(cats);
        inferred = false;
    }
    GroupView {
        clients,
        site_id: rt.site.id.clone(),
        site_name: rt.site.name.clone(),
        id: g.id,
        name: g.name,
        description: g.description,
        platform: g.platform,
        rate_multiplier: g.rate_multiplier,
        models: g.models,
        clients_inferred: inferred,
        categories,
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
async fn add_site(app: AppHandle, st: State<'_, AppState>, base_url: String, name: Option<String>, username: String, password: String, is_admin: Option<bool>) -> Result<SiteView, String> {
    let base = sites::normalize_url(&base_url)?;
    let id = sites::site_id(&base);
    let existing = st.sites.read().await.iter().find(|r| r.site.id == id).cloned();
    let (rt, is_new) = match existing {
        Some(r) => (r, false),
        None => {
            let kind = sites::detect(&base).await?;
            sites::check_supported(&base, kind).await?;
            let nm = name.map(|n| n.trim().to_string()).filter(|n| !n.is_empty()).unwrap_or_else(|| sites::default_name(&base));
            (AppState::make_runtime(&st.paths, Site { id: id.clone(), kind, name: nm, base_url: base, is_admin: false }), true)
        }
    };
    let (acc, secret) = rt.client.login(username.trim(), &password).await?;
    session_store::save(&st.paths.data, &rt.site.id, &secret);
    *rt.account.lock().await = Some(acc);
    rt.set_error(None).await;
    // 勾选了“我是该站点管理员”才记录；重新登录时没勾选也不会把已有的管理员身份清掉
    if let Some(true) = is_admin {
        // 勾选了就实际试一下管理接口：普通账号会被站点拒绝，这时不开启管理员模式（站点照常添加）
        match rt.client.admin_probe().await {
            Ok(()) => rt.admin.store(true, std::sync::atomic::Ordering::Relaxed),
            Err(e) => applog::log("admin_probe_fail", &format!("{} ({}) {e}", rt.site.name, rt.site.base_url)),
        }
    }
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
    let ov = overrides::load(&st.paths.data).get(&overrides::key(&site_id, &group_id)).map(|l| service::clients_for_categories(&service::normalize_categories(l)));
    let out = service::enable_with(&rt.client, &rt.site, &st.paths, &g, Client::parse(&client)?, model, ov.as_deref()).await;
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

// ---------- 站长：我的中转站 ----------

/// 只有登录时声明并验证过管理员身份的站点才能走管理接口。
async fn admin_site(st: &State<'_, AppState>, site_id: &str) -> Result<Arc<SiteRuntime>, String> {
    let rt = st.find(site_id).await?;
    if !rt.admin.load(std::sync::atomic::Ordering::Relaxed) {
        return Err("这个站点没有开启管理员模式".into());
    }
    Ok(rt)
}

#[tauri::command]
async fn admin_overview(st: State<'_, AppState>, site_id: String) -> Result<admin::AdminOverview, String> {
    let rt = admin_site(&st, &site_id).await?;
    rt.client.admin_overview().await.inspect_err(|e| applog::log("admin_fail", &format!("{} overview {e}", rt.site.name)))
}

/// 站长：每个上游账号在上游站点里的分组关联和**当前**倍率（见 `admin::UpstreamLink`）。
#[tauri::command]
async fn admin_links(st: State<'_, AppState>, site_id: String) -> Result<admin::LinkReport, String> {
    let rt = admin_site(&st, &site_id).await?;
    let sites = st.sites.read().await.clone();
    links_for(&rt, &sites, &admin::load_links(&st.paths.data)).await
}

/// `admin_links` 的实现（单独成函数，方便测试）：`rt` 是站长的站点，`sites` 是应用里所有已添加的站点，`saved` 是本机保存的关联。
pub async fn links_for(rt: &Arc<SiteRuntime>, sites: &[Arc<SiteRuntime>], saved: &admin::SavedLinks) -> Result<admin::LinkReport, String> {
    let overview = rt.client.admin_overview().await?;
    let by_host: std::collections::HashMap<String, Arc<SiteRuntime>> = sites.iter().filter(|r| r.site.id != rt.site.id).filter_map(|r| Some((admin::host_of(&r.site.base_url)?.to_lowercase(), r.clone()))).collect();
    let mine = saved.get(&rt.site.id);
    let mut groups_of: std::collections::HashMap<String, Vec<admin::GroupChoice>> = Default::default();
    let mut report = admin::LinkReport::default();
    for u in &overview.upstreams {
        let Some(host) = u.host.clone() else { continue };
        let Some(urt) = by_host.get(&host.to_lowercase()) else {
            if !report.missing_hosts.contains(&host) {
                report.missing_hosts.push(host);
            }
            continue;
        };
        if !groups_of.contains_key(&urt.site.id) {
            let (gs, err) = site_groups_or_cached(urt, 60).await;
            if let Some(e) = err.filter(|_| gs.is_empty()) {
                applog::log("admin_links_fail", &format!("{} -> {} {e}", rt.site.name, urt.site.name));
            }
            groups_of.insert(urt.site.id.clone(), gs.into_iter().map(|g| admin::GroupChoice { id: g.id, name: g.name, rate: g.rate_multiplier }).collect());
        }
        let candidates = groups_of[&urt.site.id].clone();
        let mut link = admin::UpstreamLink { upstream_id: u.id.clone(), host, site_id: Some(urt.site.id.clone()), site_name: Some(urt.site.name.clone()), candidates: candidates.clone(), ..Default::default() };
        match mine.and_then(|m| m.get(&u.id)).filter(|(sid, _)| *sid == urt.site.id) {
            Some((_, gid)) => match candidates.iter().find(|c| &c.id == gid) {
                Some(c) => {
                    link.group_id = Some(c.id.clone());
                    link.group = Some(c.name.clone());
                    link.rate = Some(c.rate);
                }
                None => link.note = Some(format!("之前关联的分组在「{}」里已经找不到了，请重新选择", urt.site.name)),
            },
            None => link.suggested = admin::suggest(&u.name, &candidates),
        }
        if candidates.is_empty() && link.note.is_none() {
            link.note = Some(format!("读不到「{}」的分组（需要重新登录，或这个账号下没有可用分组）", urt.site.name));
        }
        report.links.push(link);
    }
    report.missing_hosts.sort();
    Ok(report)
}

/// 站长：把某个上游账号关联到上游站点里的一个分组（`group_id` 为空表示取消关联）。只保存在本机。
#[tauri::command]
async fn admin_set_link(st: State<'_, AppState>, site_id: String, upstream_id: String, link_site_id: Option<String>, group_id: Option<String>) -> Result<(), String> {
    admin_site(&st, &site_id).await?;
    let mut saved = admin::load_links(&st.paths.data);
    let m = saved.entry(site_id).or_default();
    match (link_site_id, group_id) {
        (Some(s), Some(g)) => {
            m.insert(upstream_id, (s, g));
        }
        _ => {
            m.remove(&upstream_id);
        }
    }
    admin::save_links(&st.paths.data, &saved)
}

/// 站长：新建下游分组。
#[tauri::command]
async fn admin_create_group(st: State<'_, AppState>, site_id: String, group: admin::NewGroup) -> Result<String, String> {
    let rt = admin_site(&st, &site_id).await?;
    applog::log("admin_op", &format!("{} CREATE group name={:?} rate={} platform={:?}", rt.site.name, group.name, group.rate_multiplier, group.platform));
    let id = rt.client.admin_create_group(&group).await?;
    rt.last_groups_at.store(0, std::sync::atomic::Ordering::Relaxed);
    Ok(id)
}

pub struct AddUpstreamOpts {
    /// 上游账号 / 渠道的名称；空则用“上游站点名-分组名”。
    pub name: Option<String>,
    /// 创建后先暂停（默认不暂停：调度默认开启，创建完就参与调度；传 true 才先暂停）。
    pub paused: bool,
    /// 这个上游分组已经被添加过时，允许再添加一次：两个上游账号会共用同一把上游 Key，用户会互相占用它的并发和额度。
    pub allow_duplicate: bool,
    /// 试一次 “hi” 用哪个模型；没指定就挑一个便宜的。
    pub test_model: Option<String>,
}

/// 选试 “hi” 的模型：指定了就必须是这个上游分组里有的；没指定挑便宜的。
fn pick_test_model(models: &[String], wanted: &Option<String>) -> Result<String, String> {
    match wanted.as_deref().map(str::trim).filter(|m| !m.is_empty()) {
        Some(m) if models.iter().any(|x| x == m) => Ok(m.to_string()),
        Some(m) => Err(format!("上游分组里没有模型「{m}」")),
        None => cheap_model(models).ok_or_else(|| "上游分组下没有可用模型".to_string()),
    }
}

/// 挑一个便宜的聊天模型用来试一次（优先 haiku / mini / flash / lite 这类）。
fn cheap_model(models: &[String]) -> Option<String> {
    let chat: Vec<&String> = models.iter().filter(|m| service::is_chat_model(m)).collect();
    ["haiku", "mini", "flash-lite", "flash", "lite", "luna"].iter().find_map(|k| chat.iter().find(|m| m.to_lowercase().contains(k)).map(|m| m.to_string())).or_else(|| chat.first().map(|m| m.to_string()))
}

/// 站长：给下游分组添加一个上游。流程（任何一步失败都撤销已经做的）：
/// 1. 在上游站点为这个分组创建（或复用）一把专用 Key；2. 读这把 Key 的模型；3. 用它在上游站点发一句“hi”，证明链路是通的；
/// 4. 在站长的站点创建上游账号 / 渠道并绑定下游分组（默认调度开启，不暂停）；5. 记下“这个上游账号 ↔ 上游分组”的关联。
/// Key 只在内存里从上游站点传到站长的站点，不显示、不写日志、不落盘。
pub async fn add_upstream(rt: &Arc<SiteRuntime>, urt: &Arc<SiteRuntime>, downstream_id: &str, upstream_group_id: &str, opts: &AddUpstreamOpts, data_dir: &std::path::Path) -> Result<admin::AddedUpstream, String> {
    let overview = rt.client.admin_overview().await?;
    let ds = overview.downstreams.iter().find(|d| d.id == downstream_id).ok_or("下游分组不存在")?;
    let (groups, _) = site_groups_or_cached(urt, 60).await;
    let g = groups.into_iter().find(|g| g.id == upstream_group_id).ok_or("上游站点里找不到这个分组（或这个账号无权使用它）")?;
    // 类别：下游和上游都明确、又不一样，混在一起会出问题
    let known = |p: &str| !p.is_empty() && p != "unknown";
    if known(&ds.platform) && known(&g.platform) && ds.platform != g.platform {
        return Err(format!("下游分组是「{}」类，上游分组是「{}」类，混在一起会出问题", ds.platform, g.platform));
    }
    let platform = if known(&ds.platform) { ds.platform.clone() } else if known(&g.platform) { g.platform.clone() } else { String::new() };
    if platform.is_empty() && rt.site.kind == Kind::Sub2api {
        return Err("判断不出类别，请先给下游分组设置分类".into());
    }
    // 已经添加过：同一个上游分组、对应的上游账号还在，就不重复创建
    let saved = admin::load_links(data_dir);
    if let Some(prev) = saved.get(&rt.site.id).into_iter().flatten().filter(|(_, (sid, gid))| *sid == urt.site.id && *gid == g.id).find_map(|(uid, _)| overview.upstreams.iter().find(|u| &u.id == uid)) {
        if !opts.allow_duplicate {
            return Err(format!("这个上游分组已经添加过（上游账号「{}」）：再添加一次会和它共用同一把上游 Key，两边的用户会互相占用它的并发和额度，需要确认后才能继续", prev.name));
        }
    }
    let name = opts.name.clone().map(|n| n.trim().to_string()).filter(|n| !n.is_empty()).unwrap_or_else(|| format!("{}-{}", urt.site.name, g.name));
    if overview.upstreams.iter().any(|u| u.name.trim() == name) {
        return Err(format!("已经有一个叫「{name}」的上游账号，换个名称"));
    }

    let (key, created) = urt.client.ensure_key(&g).await.map_err(|e| format!("在上游站点创建 Key 失败：{e}"))?;
    applog::log("admin_op", &format!("{} add_upstream group={} <- {} / {} (key {})", rt.site.name, ds.name, urt.site.name, g.name, if created { "新建" } else { "复用" }));
    let key_label = sites::key_name(&g);
    let rollback = |why: String| {
        let (urt, key_label) = (urt.clone(), key_label.clone());
        async move {
            if created {
                let _ = urt.client.delete_key_named(&key_label).await; // 撤销刚创建的 Key，不在上游站点留垃圾
            }
            why
        }
    };
    let models: Vec<String> = match urt.client.models_result(&key).await {
        Ok(ms) => ms.into_iter().filter(|m| service::is_chat_model(m)).collect(),
        Err(e) => return Err(rollback(format!("读取上游分组的模型失败：{e}")).await),
    };
    let model = match pick_test_model(&models, &opts.test_model) {
        Ok(m) => m,
        Err(e) => return Err(rollback(e).await),
    };
    let wire = match platform.as_str() {
        "anthropic" => sites::http::ProbeWire::Anthropic,
        "openai" => sites::http::ProbeWire::Responses,
        "gemini" => sites::http::ProbeWire::Gemini,
        _ => sites::http::ProbeWire::Chat,
    };
    let probe = match urt.client.probe(&key, &model, wire).await {
        Ok(p) => p,
        Err(e) => return Err(rollback(format!("用这把 Key 在上游站点试了一次，没通：{e}")).await),
    };
    let new = admin::NewUpstream { name: name.clone(), platform: platform.clone(), base_url: urt.site.base_url.clone(), api_key: key, models: models.clone(), group_ids: vec![ds.id.clone()], rate_multiplier: (rt.site.kind == Kind::Sub2api).then_some(g.rate_multiplier) };
    let id = match rt.client.admin_create_upstream(&new).await {
        Ok(id) => id,
        Err(e) => return Err(rollback(format!("在你的站点创建上游账号失败：{e}")).await),
    };
    if opts.paused {
        if let Err(e) = rt.client.admin_set_paused(&id, true).await {
            let _ = rt.client.admin_remove_upstream(&id).await;
            return Err(rollback(format!("创建后没能先暂停，已撤销：{e}")).await);
        }
    }
    let mut saved = admin::load_links(data_dir);
    saved.entry(rt.site.id.clone()).or_default().insert(id.clone(), (urt.site.id.clone(), g.id.clone()));
    let _ = admin::save_links(data_dir, &saved);
    Ok(admin::AddedUpstream { upstream_id: id, name, key_created: created, models: models.len(), probe_ms: probe.first_ms, paused: opts.paused })
}

#[tauri::command]
async fn admin_add_upstream(st: State<'_, AppState>, site_id: String, downstream_id: String, upstream_site_id: String, upstream_group_id: String, name: Option<String>, paused: Option<bool>, allow_duplicate: Option<bool>, test_model: Option<String>) -> Result<admin::AddedUpstream, String> {
    let rt = admin_site(&st, &site_id).await?;
    if upstream_site_id == site_id {
        return Err("不能把自己的站点当作上游".into());
    }
    let urt = st.find(&upstream_site_id).await?;
    if !urt.client.is_logged_in().await {
        return Err(format!("上游站点「{}」需要先重新登录", urt.site.name));
    }
    add_upstream(&rt, &urt, &downstream_id, &upstream_group_id, &AddUpstreamOpts { name, paused: paused.unwrap_or(false), allow_duplicate: allow_duplicate.unwrap_or(false), test_model }, &st.paths.data).await
}

/// 用户自定义的模型类别（名称 + 模型名关键词）。
#[tauri::command]
fn get_custom_categories(st: State<'_, AppState>) -> Vec<overrides::CustomCategory> {
    overrides::load_custom(&st.paths.data)
}

/// 保存自定义类别（整个列表一起提交）。删掉的类别，也从各分组手动设置的类别里去掉。
#[tauri::command]
fn save_custom_categories(st: State<'_, AppState>, categories: Vec<overrides::CustomCategory>) -> Result<Vec<overrides::CustomCategory>, String> {
    let names: Vec<&str> = vec!["全部", "Claude", "OpenAI", "Gemini", "DeepSeek", "国产文本", "图像", "视频", "音频", "嵌入与重排", "其他"];
    let cleaned = overrides::clean_custom(categories, &names)?;
    overrides::save_custom(&st.paths.data, &cleaned)?;
    let mut o = overrides::load(&st.paths.data);
    let before = o.clone();
    for list in o.values_mut() {
        list.retain(|x| !x.starts_with("c_") || cleaned.iter().any(|c| &c.id == x));
    }
    o.retain(|_, l| !l.is_empty());
    if o != before {
        overrides::save(&st.paths.data, &o)?;
    }
    Ok(cleaned)
}

/// 手动设置某个分组的模型类别（多选，见 `service::CATEGORIES`）；列表为空表示恢复成自动识别。
/// 也接受旧版本的客户端 id（换算成类别）。类别决定它出现在哪个 tab，以及能一键配置到哪些客户端。
#[tauri::command]
async fn set_group_clients(st: State<'_, AppState>, site_id: String, group_id: String, clients: Vec<String>) -> Result<(), String> {
    st.find(&site_id).await?;
    for c in &clients {
        if !service::CATEGORIES.contains(&c.as_str()) && !c.starts_with("c_") && Client::parse(c).is_err() {
            return Err(format!("未知类别: {c}"));
        }
    }
    let parsed = service::normalize_categories(&clients);
    let mut o = overrides::load(&st.paths.data);
    let k = overrides::key(&site_id, &group_id);
    if parsed.is_empty() {
        o.remove(&k);
    } else {
        o.insert(k, parsed);
    }
    overrides::save(&st.paths.data, &o)?;
    Ok(())
}

#[derive(serde::Serialize)]
struct SayHi {
    model: String,
    reply: String,
    first_ms: u64,
    total_ms: u64,
    input_tokens: Option<u64>,
}

/// “sayhi”测试：用这个分组的 Key，对选定的模型说一句 hi，返回模型的回复和延迟，看效果。和测速不同，这里回复的文字也要给用户看。
#[tauri::command]
async fn say_hi(st: State<'_, AppState>, site_id: String, group_id: String, model: Option<String>, client: Option<String>) -> Result<SayHi, String> {
    let rt = st.find(&site_id).await?;
    let cached = rt.last_groups.lock().await.as_ref().and_then(|gs| gs.iter().find(|g| g.id == group_id).cloned());
    let g = match cached {
        Some(g) => g,
        None => find_group(&rt, &group_id).await?,
    };
    let (key, created) = rt.client.ensure_key(&g).await.map_err(|e| format!("读取这个分组的 Key 失败：{e}"))?;
    if created {
        applog::log("key_create", &format!("{} ({}) group={} [{}] 已为该分组创建专用 Key", rt.site.name, rt.site.base_url, g.name, g.id));
    }
    let target = client.as_deref().and_then(|c| service::Client::parse(c).ok()).unwrap_or(service::Client::Claude);
    let mut models: Vec<String> = rt.client.models(&key).await.into_iter().filter(|m| service::is_chat_model(m)).collect();
    if models.is_empty() {
        models = g.models.iter().filter(|m| service::is_chat_model(m)).cloned().collect();
    }
    let chosen = model.filter(|m| models.is_empty() || models.contains(m)).or_else(|| service::default_model(target, &models)).ok_or("该分组没有可用模型")?;
    let wire = sites::http::ProbeWire::for_client(target.id());
    let who = format!("{} ({}) group={} [{}]", rt.site.name, rt.site.base_url, g.name, g.id);
    match rt.client.probe_with(&key, &chosen, wire, 80).await {
        Ok(p) => {
            applog::log("sayhi_ok", &format!("{who} model={chosen} first={}ms total={}ms", p.first_ms, p.total_ms));
            Ok(SayHi { model: chosen, reply: p.text, first_ms: p.first_ms, total_ms: p.total_ms, input_tokens: p.input_tokens })
        }
        Err(e) => {
            applog::log("sayhi_fail", &format!("{who} model={chosen} error={e}"));
            Err(e)
        }
    }
}

/// 站长：基于上游分组创建下游分组：在选定的中转站新建下游分组，再把这个上游分组添加为它的上游（流程和回滚见 `add_upstream`）。
/// 分组已创建而添加上游失败时，分组会留着（应用不删分组），错误里会说明，可以在“我的中转站”里重试添加。
#[derive(serde::Serialize)]
struct CreatedDownstream {
    group_id: String,
    added: admin::AddedUpstream,
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn admin_create_downstream(st: State<'_, AppState>, site_id: String, upstream_site_id: String, upstream_group_id: String, name: String, platform: Option<String>, rate: f64, description: Option<String>, paused: Option<bool>, test_model: Option<String>) -> Result<CreatedDownstream, String> {
    let rt = admin_site(&st, &site_id).await?;
    if upstream_site_id == site_id {
        return Err("不能把自己的站点当作上游".into());
    }
    let urt = st.find(&upstream_site_id).await?;
    if !urt.client.is_logged_in().await {
        return Err(format!("上游站点「{}」需要先重新登录", urt.site.name));
    }
    let group = admin::NewGroup { name: name.clone(), description, platform, rate_multiplier: rate };
    group.validate()?;
    applog::log("admin_op", &format!("{} CREATE downstream {:?} from {} / {}", rt.site.name, name, urt.site.name, upstream_group_id));
    let group_id = rt.client.admin_create_group(&group).await?;
    rt.last_groups_at.store(0, std::sync::atomic::Ordering::Relaxed);
    let added = add_upstream(&rt, &urt, &group_id, &upstream_group_id, &AddUpstreamOpts { name: None, paused: paused.unwrap_or(false), allow_duplicate: true, test_model }, &st.paths.data)
        .await
        .map_err(|e| format!("下游分组「{}」已经创建，但添加上游失败：{e}。可以到“我的中转站”里重试添加上游", name.trim()))?;
    Ok(CreatedDownstream { group_id, added })
}

/// 一个上游分组底下挂着哪些下游分组（用来在分组列表里显示“下游：站点 · 分组 · 倍率”）。
#[derive(serde::Serialize, Clone)]
struct DownstreamRef {
    up_site_id: String,
    up_group_id: String,
    site_id: String,
    site_name: String,
    group_id: String,
    group_name: String,
    rate: f64,
}

#[tauri::command]
async fn admin_downstreams(st: State<'_, AppState>) -> Result<Vec<DownstreamRef>, String> {
    let saved = admin::load_links(&st.paths.data);
    let sites = st.sites.read().await.clone();
    let mut out = vec![];
    for rt in sites.iter().filter(|r| r.admin.load(std::sync::atomic::Ordering::Relaxed)) {
        let Some(mine) = saved.get(&rt.site.id).filter(|m| !m.is_empty()) else { continue };
        let Ok(ov) = rt.client.admin_overview().await else { continue };
        for (uid, (up_site, up_group)) in mine {
            let Some(u) = ov.upstreams.iter().find(|u| &u.id == uid) else { continue };
            for gid in &u.groups {
                if let Some(d) = ov.downstreams.iter().find(|d| &d.id == gid) {
                    out.push(DownstreamRef { up_site_id: up_site.clone(), up_group_id: up_group.clone(), site_id: rt.site.id.clone(), site_name: rt.site.name.clone(), group_id: d.id.clone(), group_name: d.name.clone(), rate: d.rate_multiplier });
                }
            }
        }
    }
    Ok(out)
}


/// 站长：更换一个上游账号的来源（它用的是哪个上游站点的哪个分组）。流程和 `add_upstream` 一样先建 Key、读模型、试一次；
/// 通了之后：sub2api 就地更新账号的地址、Key、模型（账号 id、名称、状态、绑定的下游分组都不变）；new-api 的渠道更新接口不可靠，
/// 改成新建一个渠道（绑定同样的下游分组、保持同样的暂停状态）、成功后删旧的。任何一步失败都撤销新建的 Key / 渠道，旧的原样保留。
pub async fn replace_upstream(rt: &Arc<SiteRuntime>, urt: &Arc<SiteRuntime>, upstream_id: &str, upstream_group_id: &str, name: Option<String>, test_model: Option<String>, data_dir: &std::path::Path) -> Result<admin::AddedUpstream, String> {
    let overview = rt.client.admin_overview().await?;
    let old = overview.upstreams.iter().find(|u| u.id == upstream_id).ok_or("上游账号不存在")?.clone();
    let (groups, _) = site_groups_or_cached(urt, 60).await;
    let g = groups.into_iter().find(|g| g.id == upstream_group_id).ok_or("上游站点里找不到这个分组（或这个账号无权使用它）")?;
    let known = |p: &str| !p.is_empty() && p != "unknown";
    for d in overview.downstreams.iter().filter(|d| old.groups.contains(&d.id)) {
        if known(&d.platform) && known(&g.platform) && d.platform != g.platform {
            return Err(format!("它服务的下游分组「{}」是「{}」类，新的上游分组是「{}」类，混在一起会出问题", d.name, d.platform, g.platform));
        }
    }
    let platform = if known(&old.platform) { old.platform.clone() } else if known(&g.platform) { g.platform.clone() } else { String::new() };
    if platform.is_empty() && rt.site.kind == Kind::Sub2api {
        return Err("判断不出类别，没法更换".into());
    }
    let new_name = name.map(|n| n.trim().to_string()).filter(|n| !n.is_empty()).unwrap_or_else(|| old.name.clone());
    if new_name != old.name && overview.upstreams.iter().any(|u| u.name.trim() == new_name) {
        return Err(format!("已经有一个叫「{new_name}」的上游账号，换个名称"));
    }
    let (key, created) = urt.client.ensure_key(&g).await.map_err(|e| format!("在上游站点创建 Key 失败：{e}"))?;
    applog::log("admin_op", &format!("{} replace_upstream {} -> {} / {} (key {})", rt.site.name, old.name, urt.site.name, g.name, if created { "新建" } else { "复用" }));
    let key_label = sites::key_name(&g);
    let rollback = |why: String| {
        let (urt, key_label) = (urt.clone(), key_label.clone());
        async move {
            if created {
                let _ = urt.client.delete_key_named(&key_label).await;
            }
            why
        }
    };
    let models: Vec<String> = match urt.client.models_result(&key).await {
        Ok(ms) => ms.into_iter().filter(|m| service::is_chat_model(m)).collect(),
        Err(e) => return Err(rollback(format!("读取上游分组的模型失败：{e}")).await),
    };
    let model = match pick_test_model(&models, &test_model) {
        Ok(m) => m,
        Err(e) => return Err(rollback(e).await),
    };
    let wire = match platform.as_str() {
        "anthropic" => sites::http::ProbeWire::Anthropic,
        "openai" => sites::http::ProbeWire::Responses,
        "gemini" => sites::http::ProbeWire::Gemini,
        _ => sites::http::ProbeWire::Chat,
    };
    let probe = match urt.client.probe(&key, &model, wire).await {
        Ok(p) => p,
        Err(e) => return Err(rollback(format!("用这把 Key 在上游站点试了一次，没通：{e}")).await),
    };
    let new = admin::NewUpstream { name: new_name.clone(), platform: platform.clone(), base_url: urt.site.base_url.clone(), api_key: key, models: models.clone(), group_ids: old.groups.clone(), rate_multiplier: (rt.site.kind == Kind::Sub2api).then_some(g.rate_multiplier) };
    let final_id = if rt.site.kind == Kind::Sub2api {
        if let Err(e) = rt.client.admin_update_upstream_source(&old.id, &new).await {
            return Err(rollback(format!("更新上游账号失败：{e}")).await);
        }
        old.id.clone()
    } else {
        let id = match rt.client.admin_create_upstream(&new).await {
            Ok(id) => id,
            Err(e) => return Err(rollback(format!("在你的站点创建新渠道失败：{e}")).await),
        };
        if old.status == "paused" {
            if let Err(e) = rt.client.admin_set_paused(&id, true).await {
                let _ = rt.client.admin_remove_upstream(&id).await;
                return Err(rollback(format!("新渠道没能保持暂停状态，已撤销：{e}")).await);
            }
        }
        if let Err(e) = rt.client.admin_remove_upstream(&old.id).await {
            let _ = rt.client.admin_remove_upstream(&id).await;
            return Err(rollback(format!("删除旧渠道失败，已撤销新渠道，旧的原样保留：{e}")).await);
        }
        id
    };
    let mut saved = admin::load_links(data_dir);
    let m = saved.entry(rt.site.id.clone()).or_default();
    m.remove(&old.id);
    m.insert(final_id.clone(), (urt.site.id.clone(), g.id.clone()));
    let _ = admin::save_links(data_dir, &saved);
    Ok(admin::AddedUpstream { upstream_id: final_id, name: if rt.site.kind == Kind::Sub2api { old.name } else { new_name }, key_created: created, models: models.len(), probe_ms: probe.first_ms, paused: old.status == "paused" })
}

#[tauri::command]
async fn admin_replace_upstream(st: State<'_, AppState>, site_id: String, upstream_id: String, upstream_site_id: String, upstream_group_id: String, name: Option<String>, test_model: Option<String>) -> Result<admin::AddedUpstream, String> {
    let rt = admin_site(&st, &site_id).await?;
    if upstream_site_id == site_id {
        return Err("不能把自己的站点当作上游".into());
    }
    let urt = st.find(&upstream_site_id).await?;
    if !urt.client.is_logged_in().await {
        return Err(format!("上游站点「{}」需要先重新登录", urt.site.name));
    }
    replace_upstream(&rt, &urt, &upstream_id, &upstream_group_id, name, test_model, &st.paths.data).await
}

/// 站长：快速修改上游账号的“状态”和“调度”（sub2api 两个都有；new-api 的渠道只有一个启用 / 停用开关）。
/// 能被用户调用到要“状态 = active 且 调度 = 开启”：只改其中一个时另一个不动。
#[tauri::command]
async fn admin_set_account_state(st: State<'_, AppState>, site_id: String, upstream_id: String, status: Option<String>, schedulable: Option<bool>) -> Result<(), String> {
    let rt = admin_site(&st, &site_id).await?;
    if status.is_none() && schedulable.is_none() {
        return Err("没有要修改的内容".into());
    }
    applog::log("admin_op", &format!("{} upstream={} status={:?} schedulable={:?}", rt.site.name, upstream_id, status, schedulable));
    if let Some(sv) = &status {
        rt.client.admin_set_account_status(&upstream_id, sv).await?;
    }
    if let Some(sc) = schedulable {
        if rt.site.kind != Kind::Sub2api {
            return Err("这个站点的渠道没有“调度”开关，只有“状态”".into());
        }
        rt.client.admin_set_paused(&upstream_id, !sc).await?;
    }
    Ok(())
}

/// 站长：删除下游分组。站点拒绝时（比如分组下还有用户的 Key）把原话返回。绑在它上面的上游账号不会被删，只是不再服务任何分组。
#[tauri::command]
async fn admin_remove_group(st: State<'_, AppState>, site_id: String, group_id: String) -> Result<(), String> {
    let rt = admin_site(&st, &site_id).await?;
    applog::log("admin_op", &format!("{} REMOVE group={}", rt.site.name, group_id));
    rt.client.admin_remove_group(&group_id).await?;
    rt.last_groups_at.store(0, std::sync::atomic::Ordering::Relaxed);
    Ok(())
}

/// 站长视角：某个下游分组（`scope = "group"`）或上游账号（`"account"`）近 7 天的用量。10 分钟缓存，`force` 忽略缓存。
#[tauri::command]
async fn admin_usage(st: State<'_, AppState>, site_id: String, scope: String, id: String, force: Option<bool>) -> Result<usage::GroupUsage, String> {
    let rt = admin_site(&st, &site_id).await?;
    let key = format!("admin:{scope}:{id}");
    if !force.unwrap_or(false) {
        if let Some(u) = rt.usage_cache.lock().unwrap().get(&key) {
            if sites::http::now() - u.fetched_at < USAGE_TTL_SECS {
                return Ok(u.clone());
            }
        }
    }
    let u = rt.client.admin_usage(&scope, &id).await.inspect_err(|e| applog::log("admin_fail", &format!("{} usage {scope}={id} {e}", rt.site.name)))?;
    rt.usage_cache.lock().unwrap().insert(key, u.clone());
    Ok(u)
}

#[tauri::command]
async fn admin_set_paused(st: State<'_, AppState>, site_id: String, upstream_id: String, paused: bool) -> Result<(), String> {
    let rt = admin_site(&st, &site_id).await?;
    applog::log("admin_op", &format!("{} upstream={} paused={paused}", rt.site.name, upstream_id));
    rt.client.admin_set_paused(&upstream_id, paused).await
}

#[tauri::command]
async fn admin_remove_upstream(st: State<'_, AppState>, site_id: String, upstream_id: String) -> Result<(), String> {
    let rt = admin_site(&st, &site_id).await?;
    applog::log("admin_op", &format!("{} upstream={} REMOVE", rt.site.name, upstream_id));
    rt.client.admin_remove_upstream(&upstream_id).await
}

#[tauri::command]
async fn admin_update_group(st: State<'_, AppState>, site_id: String, group_id: String, edit: admin::GroupEdit) -> Result<(), String> {
    let rt = admin_site(&st, &site_id).await?;
    // 日志只记改了哪些字段和倍率，不记备注内容
    applog::log("admin_op", &format!("{} group={} edit name={:?} rate={:?} platform={:?} description={}", rt.site.name, group_id, edit.name, edit.rate_multiplier, edit.platform, edit.description.is_some()));
    rt.client.admin_update_group(&group_id, &edit).await?;
    // 名称 / 倍率变了：下次打开让分组列表重新向站点拉一遍
    rt.last_groups_at.store(0, std::sync::atomic::Ordering::Relaxed);
    Ok(())
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
    let listed = rt.client.models_result(&key).await;
    let why = listed.as_ref().err().cloned();
    let mut models: Vec<String> = listed.unwrap_or_default().into_iter().filter(|m| service::is_chat_model(m)).collect();
    if models.is_empty() {
        models = g.models.iter().filter(|m| service::is_chat_model(m)).cloned().collect();
    }
    let chosen = match model.filter(|m| models.is_empty() || models.contains(m)).or_else(|| service::default_model(target, &models)) {
        Some(m) => m,
        None => {
            // 站点明确拒绝了（余额不足等）就把它的原话告诉用户，而不是笼统地说“没有可用模型”
            let msg = match &why {
                Some(e) => format!("读取该分组的模型失败：{e}"),
                None => "该分组没有可用模型，无法测速".to_string(),
            };
            applog::log("probe_fail", &format!("{who} step=model error={msg}"));
            return Err(msg);
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
        .invoke_handler(tauri::generate_handler![detect_site, add_site, remove_site, load_sites, list_sites, refresh_accounts, list_groups, overview, enable_group, group_models, group_models_map, probe_group, group_usage, admin_overview, admin_replace_upstream, admin_set_account_state, admin_remove_group, set_group_clients, get_custom_categories, save_custom_categories, say_hi, admin_create_downstream, admin_downstreams, admin_links, admin_set_link, admin_create_group, admin_add_upstream, admin_usage, admin_set_paused, admin_remove_upstream, admin_update_group, topup_url, selftest_mode, selftest_env, selftest_tray, selftest_report, data_loss, restore_sites, dismiss_data_loss, panel_close, panel_open_main, panel_note, panel_quit])
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
