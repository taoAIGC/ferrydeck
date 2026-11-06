pub mod clients;
pub mod paths;
pub mod service;
pub mod session_store;
pub mod sites;
pub mod state;
pub mod tray;

use std::sync::Arc;

use tauri::image::Image;
use tauri::menu::{CheckMenuItem, IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, State, Wry};

use paths::Paths;
use service::{Client, GroupView};
use sites::{GroupInfo, Kind, Site};
use state::{AppState, SiteRuntime, SiteView};

const TRAY_ID: &str = "main";
const TRAY_ICON: &[u8] = include_bytes!("../icons/tray.png");

fn to_view(rt: &SiteRuntime, g: GroupInfo) -> GroupView {
    GroupView { clients: service::clients_for(&g.platform), site_id: rt.site.id.clone(), site_name: rt.site.name.clone(), id: g.id, name: g.name, description: g.description, platform: g.platform, rate_multiplier: g.rate_multiplier }
}

/// 一个站点的分组（已隐藏 default）。
async fn site_groups(rt: &SiteRuntime) -> Result<Vec<GroupInfo>, String> {
    Ok(rt.client.groups().await?.into_iter().filter(|g| !service::is_hidden_group(&g.name)).collect())
}

async fn find_group(rt: &SiteRuntime, id: &str) -> Result<GroupInfo, String> {
    site_groups(rt).await?.into_iter().find(|g| g.id == id).ok_or_else(|| "分组不存在或已无权使用".to_string())
}

// ---------- 菜单栏 ----------

fn build_items(app: &AppHandle, entries: &[tray::Entry]) -> tauri::Result<Vec<Box<dyn IsMenuItem<Wry>>>> {
    let mut out: Vec<Box<dyn IsMenuItem<Wry>>> = vec![];
    for e in entries {
        match e {
            tray::Entry::Header(t) => out.push(Box::new(MenuItem::with_id(app, "header", t, false, None::<&str>)?)),
            tray::Entry::Item { id, label, checked, enabled } => {
                if *checked {
                    out.push(Box::new(CheckMenuItem::with_id(app, id, label, *enabled, true, None::<&str>)?));
                } else {
                    out.push(Box::new(MenuItem::with_id(app, id, label, *enabled, None::<&str>)?));
                }
            }
            tray::Entry::Separator => out.push(Box::new(PredefinedMenuItem::separator(app)?)),
            tray::Entry::Submenu { label, items } => {
                let inner = build_items(app, items)?;
                let refs: Vec<&dyn IsMenuItem<Wry>> = inner.iter().map(|b| b.as_ref()).collect();
                out.push(Box::new(Submenu::with_items(app, label, true, &refs)?));
            }
        }
    }
    Ok(out)
}

fn build_menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let st = app.state::<AppState>();
    let groups = st.groups.lock().map(|g| g.clone()).unwrap_or_default();
    let has_sites = st.sites.try_read().map(|s| !s.is_empty()).unwrap_or(true);
    let overview = service::overview(&st.paths);
    let model = tray::build_model(has_sites, &groups, &overview);
    let items = build_items(app, &model)?;
    let refs: Vec<&dyn IsMenuItem<Wry>> = items.iter().map(|b| b.as_ref()).collect();
    Menu::with_items(app, &refs)
}

/// 重建菜单栏菜单。菜单操作必须在主线程执行。
fn refresh_tray(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let (Some(tray), Ok(menu)) = (handle.tray_by_id(TRAY_ID), build_menu(&handle)) {
            let _ = tray.set_menu(Some(menu));
        }
    });
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn handle_menu(app: &AppHandle, id: &str) {
    match tray::parse_action(id) {
        Some(tray::Action::Open) => show_main(app),
        Some(tray::Action::Quit) => app.exit(0),
        Some(tray::Action::Enable { client, site_id, group_id }) => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let st = app.state::<AppState>();
                let res = async {
                    let rt = st.find(&site_id).await?;
                    let g = find_group(&rt, &group_id).await?;
                    service::enable(&rt.client, &rt.site, &st.paths, &g, client, None).await
                }
                .await;
                match res {
                    Ok(_) => {
                        refresh_tray(&app);
                        let _ = app.emit("state-changed", ());
                    }
                    Err(e) => {
                        // 窗口可能是隐藏的，出错时把窗口带出来并显示原因
                        show_main(&app);
                        let _ = app.emit("tray-error", e);
                    }
                }
            });
        }
        None => {}
    }
}

fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let menu = build_menu(app)?;
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(Image::from_bytes(TRAY_ICON)?)
        .icon_as_template(true) // 随浅色/深色菜单栏自动变色
        .tooltip("Ferrydeck")
        .menu(&menu)
        .on_menu_event(|app, ev| handle_menu(app, ev.id().as_ref()))
        .build(app)?;
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
            (AppState::make_runtime(Site { id: id.clone(), kind, name: nm, base_url: base }), true)
        }
    };
    let (acc, secret) = rt.client.login(username.trim(), &password).await?;
    session_store::save(&rt.site.id, &secret);
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
    session_store::clear(&site_id);
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
        let mut guard = st.sites.write().await;
        if guard.is_empty() {
            *guard = saved.into_iter().map(AppState::make_runtime).collect();
        }
    }
    let rts: Vec<Arc<SiteRuntime>> = st.sites.read().await.clone();
    let mut tasks = tokio::task::JoinSet::new();
    for rt in rts {
        tasks.spawn(async move {
            if rt.client.is_logged_in().await {
                return;
            }
            match session_store::load(&rt.site.id) {
                None => rt.set_error(Some("需要重新登录".into())).await,
                Some(secret) => match rt.client.resume(&secret).await {
                    Ok(()) => match rt.client.me().await {
                        Ok(acc) => {
                            *rt.account.lock().await = Some(acc);
                            rt.set_error(None).await;
                        }
                        Err(e) => rt.set_error(Some(e)).await,
                    },
                    Err(e) => rt.set_error(Some(e)).await,
                },
            }
        });
    }
    while tasks.join_next().await.is_some() {}
    refresh_tray(&app);
    Ok(st.views().await)
}

#[tauri::command]
async fn list_sites(st: State<'_, AppState>) -> Result<Vec<SiteView>, String> {
    Ok(st.views().await)
}

/// 刷新所有已连接站点的余额。
#[tauri::command]
async fn refresh_accounts(st: State<'_, AppState>) -> Result<Vec<SiteView>, String> {
    let rts: Vec<Arc<SiteRuntime>> = st.sites.read().await.clone();
    let mut tasks = tokio::task::JoinSet::new();
    for rt in rts {
        tasks.spawn(async move {
            if rt.client.is_logged_in().await {
                match rt.client.me().await {
                    Ok(acc) => {
                        *rt.account.lock().await = Some(acc);
                        rt.set_error(None).await;
                    }
                    Err(e) => rt.set_error(Some(e)).await,
                }
            }
        });
    }
    while tasks.join_next().await.is_some() {}
    Ok(st.views().await)
}

#[derive(serde::Serialize)]
struct GroupsResult {
    groups: Vec<GroupView>,
    sites: Vec<SiteView>,
}

/// 汇总所有已连接站点的分组；某个站点失败只影响它自己。
#[tauri::command]
async fn list_groups(app: AppHandle, st: State<'_, AppState>) -> Result<GroupsResult, String> {
    let rts: Vec<Arc<SiteRuntime>> = st.sites.read().await.clone();
    let mut tasks = tokio::task::JoinSet::new();
    for (i, rt) in rts.iter().cloned().enumerate() {
        tasks.spawn(async move {
            if !rt.client.is_logged_in().await {
                return (i, vec![]);
            }
            match site_groups(&rt).await {
                Ok(gs) => {
                    rt.set_error(None).await;
                    (i, gs.into_iter().map(|g| to_view(&rt, g)).collect())
                }
                Err(e) => {
                    rt.set_error(Some(e)).await;
                    (i, vec![])
                }
            }
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
    refresh_tray(&app);
    Ok(GroupsResult { groups, sites: st.views().await })
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
        if e.contains("登录已过期") || e == "未登录" {
            rt.set_error(Some("登录已过期，请重新登录".into())).await;
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
    let builder = tauri::Builder::default().plugin(tauri_plugin_opener::init()).plugin(tauri_plugin_process::init());
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    let app = builder
        .manage(AppState::new(paths))
        .setup(|app| {
            setup_tray(app.handle())?;
            Ok(())
        })
        // 点窗口关闭按钮只是隐藏，应用继续留在菜单栏；真正退出请用菜单栏里的“退出”或 ⌘Q
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![detect_site, add_site, remove_site, load_sites, list_sites, refresh_accounts, list_groups, overview, enable_group, group_models, topup_url, selftest_mode, selftest_env, selftest_tray, selftest_report])
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
