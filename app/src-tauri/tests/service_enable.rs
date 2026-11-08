//! 整条链路（离线）：模拟站点 → 建 Key → 写入各客户端配置 → 记录使用中的分组。全部写在临时目录。
use std::fs;
use std::sync::Arc;

use app_lib::paths::Paths;
use app_lib::service::{self, Client};
use app_lib::sites::{GroupInfo, Kind, Site, SiteClient};
use serde_json::{json, Value};
use tempfile::TempDir;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

/// 一个最小的 new-api 站点：登录、一个分组、能建 Key、能列模型。
async fn fake_newapi(models: &[&str]) -> MockServer {
    let s = MockServer::start().await;
    let hdr = "new_api_refresh=c1; Path=/";
    Mock::given(method("GET")).and(path("/api/status")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"success": true, "data": {"quota_per_unit": 500000, "turnstile_check": false, "password_login_enabled": true}}))).mount(&s).await;
    Mock::given(method("POST")).and(path("/api/user/login")).respond_with(ResponseTemplate::new(200).insert_header("set-cookie", hdr).set_body_json(json!({"success": true, "data": {"access_token": "t", "access_expires_at": 4000000000i64, "user": {"id": 1, "username": "u", "quota": 0}}}))).mount(&s).await;
    Mock::given(method("GET")).and(path("/api/token/")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"success": true, "data": {"items": [{"id": 4, "name": "desktop-G", "group": "G", "status": 1}]}}))).mount(&s).await;
    Mock::given(method("POST")).and(path("/api/token/4/key")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"success": true, "data": {"key": "SECRETKEY"}}))).mount(&s).await;
    let list: Vec<Value> = models.iter().map(|m| json!({"id": m})).collect();
    Mock::given(method("GET")).and(path("/v1/models")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"data": list}))).mount(&s).await;
    s
}

fn grp(platform: &str, models: &[&str]) -> GroupInfo {
    GroupInfo { id: "G".into(), name: "G".into(), description: None, platform: platform.into(), rate_multiplier: 1.0, models: models.iter().map(|s| s.to_string()).collect() }
}

async fn connect(s: &MockServer) -> (SiteClient, Site) {
    let c = SiteClient::new(Kind::Newapi, &s.uri(), Arc::new(|_| {}));
    c.login("u", "p").await.unwrap();
    let site = Site { id: "site1".into(), kind: Kind::Newapi, name: "我的站点".into(), base_url: s.uri() };
    (c, site)
}

#[tokio::test]
async fn enabling_an_anthropic_group_writes_claude_code_and_records_the_site() {
    let s = fake_newapi(&["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5"]).await;
    let (c, site) = connect(&s).await;
    let root = TempDir::new().unwrap();
    let paths = Paths::under(root.path());
    let out = service::enable(&c, &site, &paths, &grp("anthropic", &[]), Client::Claude, None).await.unwrap();
    assert_eq!(out.model.as_deref(), Some("claude-sonnet-5-5"));
    assert!(!out.key_created, "站点里已有这把 Key，应复用");

    let cfg: Value = serde_json::from_str(&fs::read_to_string(paths.claude.join("settings.json")).unwrap()).unwrap();
    assert_eq!(cfg["env"]["ANTHROPIC_BASE_URL"], s.uri().as_str());
    assert_eq!(cfg["env"]["ANTHROPIC_AUTH_TOKEN"], "sk-SECRETKEY");
    assert_eq!(cfg["env"]["ANTHROPIC_MODEL"], "claude-sonnet-5-5");

    let ov = service::overview(&paths);
    let me = ov.iter().find(|o| o.client == Client::Claude).unwrap();
    let act = me.active.as_ref().unwrap();
    assert!(me.in_use);
    assert_eq!((act.site_id.as_str(), act.site_name.as_str(), act.group_id.as_str()), ("site1", "我的站点", "G"));
}

#[tokio::test]
async fn codex_and_claude_desktop_and_gemini_get_the_sites_address_and_key() {
    let s = fake_newapi(&["gpt-5.6-sol", "gpt-6-sol"]).await;
    let (c, site) = connect(&s).await;
    let root = TempDir::new().unwrap();
    let paths = Paths::under(root.path());
    service::enable(&c, &site, &paths, &grp("openai", &[]), Client::Codex, None).await.unwrap();
    let toml = fs::read_to_string(paths.codex.join("config.toml")).unwrap();
    assert!(toml.contains(&format!("base_url = \"{}/v1\"", s.uri())) && toml.contains("sk-SECRETKEY") && toml.contains("gpt-5.6-sol"));

    let s2 = fake_newapi(&["claude-sonnet-5-5"]).await;
    let (c2, site2) = connect(&s2).await;
    service::enable(&c2, &site2, &paths, &grp("anthropic", &[]), Client::ClaudeDesktop, None).await.unwrap();
    let lib = paths.claude_desktop.join("configLibrary");
    let prof: Value = serde_json::from_str(&fs::read_to_string(lib.join("b35747a1-0000-4000-8000-000000000001.json")).unwrap()).unwrap();
    assert_eq!((prof["inferenceGatewayBaseUrl"].as_str(), prof["inferenceGatewayApiKey"].as_str()), (Some(s2.uri().as_str()), Some("sk-SECRETKEY")));

    let s3 = fake_newapi(&["gemini-3.5-flash"]).await;
    let (c3, site3) = connect(&s3).await;
    service::enable(&c3, &site3, &paths, &grp("gemini", &[]), Client::Gemini, None).await.unwrap();
    let env = fs::read_to_string(paths.gemini.join(".env")).unwrap();
    assert!(env.contains("GEMINI_API_KEY=sk-SECRETKEY") && env.contains(&format!("GOOGLE_GEMINI_BASE_URL={}", s3.uri())));
}

#[tokio::test]
async fn switching_between_two_sites_overwrites_cleanly_and_updates_the_active_record() {
    let a = fake_newapi(&["claude-sonnet-5-5"]).await;
    let b = fake_newapi(&["claude-opus-5-5"]).await;
    let (ca, sa) = connect(&a).await;
    let (cb, mut sb) = connect(&b).await;
    sb.id = "site2".into();
    sb.name = "另一个站".into();
    let root = TempDir::new().unwrap();
    let paths = Paths::under(root.path());
    let original = "{\n  \"permissions\": {\n    \"allow\": []\n  }\n}\n";
    fs::create_dir_all(&paths.claude).unwrap();
    fs::write(paths.claude.join("settings.json"), original).unwrap();

    service::enable(&ca, &sa, &paths, &grp("anthropic", &[]), Client::Claude, None).await.unwrap();
    service::enable(&cb, &sb, &paths, &grp("anthropic", &[]), Client::Claude, None).await.unwrap();
    let cfg: Value = serde_json::from_str(&fs::read_to_string(paths.claude.join("settings.json")).unwrap()).unwrap();
    assert_eq!(cfg["env"]["ANTHROPIC_BASE_URL"], b.uri().as_str(), "后一次启用的站点生效");
    assert_eq!(cfg["env"]["ANTHROPIC_MODEL"], "claude-opus-5-5");
    assert_eq!(cfg["permissions"]["allow"], json!([]), "用户原有配置保留");
    let ov = service::overview(&paths);
    assert_eq!(ov.iter().find(|o| o.client == Client::Claude).unwrap().active.as_ref().unwrap().site_id, "site2");
    // 第一个站点写进去的内容不会被当成“用户原始配置”：回到最初状态应是 original
    app_lib::clients::claude::restore(&paths.claude, &paths.data).unwrap();
    assert_eq!(fs::read_to_string(paths.claude.join("settings.json")).unwrap(), original);
}

#[tokio::test]
async fn image_only_groups_are_refused_without_touching_any_config() {
    // new-api 的分组没有平台分类，每种客户端下都展示（第 13 项），所以这里只验证“没有对话模型”时拒绝
    let s2 = fake_newapi(&["gpt-image-2", "gpt-image-2.5"]).await;
    let (c2, site2) = connect(&s2).await;
    let root = TempDir::new().unwrap();
    let paths = Paths::under(root.path());
    let e2 = service::enable(&c2, &site2, &paths, &grp("openai", &[]), Client::Codex, None).await.unwrap_err();
    assert!(e2.contains("图片"), "{e2}");

    let e3 = service::enable(&c2, &site2, &paths, &grp("openai", &[]), Client::Claude, None).await.unwrap_err();
    assert!(e3.contains("图片"), "{e3}");
    assert!(!paths.claude.exists() && !paths.codex.exists(), "被拒绝时不应写任何文件");
}

#[tokio::test]
async fn the_default_group_cannot_be_enabled_even_if_asked_directly() {
    let s = fake_newapi(&["claude-sonnet-5-5"]).await;
    let (c, site) = connect(&s).await;
    let root = TempDir::new().unwrap();
    let mut g = grp("anthropic", &[]);
    g.name = "default".into();
    let e = service::enable(&c, &site, &Paths::under(root.path()), &g, Client::Claude, None).await.unwrap_err();
    assert!(e.contains("不存在"), "{e}");
}

#[tokio::test]
async fn group_models_uses_site_provided_models_without_creating_a_key() {
    let s = MockServer::start().await; // 没有任何 mock：任何请求都会 404，若触发了 Key 相关请求就会失败
    let c = SiteClient::new(Kind::Newapi, &s.uri(), Arc::new(|_| {}));
    let g = grp("anthropic", &["claude-sonnet-5", "gpt-image-2"]);
    assert_eq!(service::group_models(&c, &g).await.unwrap(), ["claude-sonnet-5"], "不需要登录，也过滤掉图片模型");
}

#[tokio::test]
async fn a_requested_model_the_group_does_not_have_is_rejected() {
    let s = fake_newapi(&["claude-sonnet-5-5"]).await;
    let (c, site) = connect(&s).await;
    let root = TempDir::new().unwrap();
    let e = service::enable(&c, &site, &Paths::under(root.path()), &grp("anthropic", &[]), Client::Claude, Some("nope".into())).await.unwrap_err();
    assert_eq!(e, "该分组没有模型 nope");
}
