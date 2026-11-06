//! new-api 适配器的离线测试：用本地模拟服务器重现各种真实站点的行为。
use std::sync::{Arc, Mutex};

use app_lib::sites::{GroupInfo, Kind, SiteClient};
use serde_json::{json, Value};
use wiremock::matchers::{body_json, header, method, path, path_regex};
use wiremock::{Mock, MockServer, ResponseTemplate};

type Saved = Arc<Mutex<Vec<String>>>;

fn client(server: &MockServer) -> (SiteClient, Saved) {
    let saved: Saved = Arc::new(Mutex::new(vec![]));
    let s2 = saved.clone();
    (SiteClient::new(Kind::Newapi, &server.uri(), Arc::new(move |v| s2.lock().unwrap().push(v))), saved)
}

fn status_ok() -> Value {
    json!({"success": true, "data": {"quota_per_unit": 500000, "quota_display_type": "USD", "turnstile_check": false, "password_login_enabled": true, "top_up_link": null}})
}

fn far() -> i64 {
    4_000_000_000
}

fn login_ok(access: &str, expires: i64) -> Value {
    json!({"success": true, "data": {"access_token": access, "access_expires_at": expires, "user": {"id": 2, "username": "test", "display_name": "测试", "quota": 1_000_000}}})
}

async fn mount_status(s: &MockServer, body: Value) {
    Mock::given(method("GET")).and(path("/api/status")).respond_with(ResponseTemplate::new(200).set_body_json(body)).mount(s).await;
}

async fn mount_login(s: &MockServer, access: &str, expires: i64, cookie: &str) {
    Mock::given(method("POST"))
        .and(path("/api/user/login"))
        .respond_with(ResponseTemplate::new(200).set_body_json(login_ok(access, expires)).insert_header("set-cookie", format!("new_api_refresh={cookie}; Path=/; HttpOnly").as_str()))
        .mount(s)
        .await;
}

fn group(name: &str) -> GroupInfo {
    GroupInfo { id: name.into(), name: name.into(), description: None, platform: "anthropic".into(), rate_multiplier: 1.0, models: vec![] }
}

#[tokio::test]
async fn login_returns_account_and_refresh_cookie_as_secret() {
    let s = MockServer::start().await;
    mount_status(&s, status_ok()).await;
    mount_login(&s, "tok1", far(), "cookie-1").await;
    let (c, saved) = client(&s);
    let (acc, secret) = c.login("test", "pw").await.unwrap();
    assert_eq!(acc.display, "测试");
    assert_eq!(acc.balance, "$2.00");
    assert_eq!(secret, "cookie-1");
    assert!(c.is_logged_in().await);
    assert!(saved.lock().unwrap().is_empty(), "登录本身不触发轮换回调，由调用方保存返回的凭据");
}

#[tokio::test]
async fn wrong_password_is_reported_in_chinese_even_though_http_is_200() {
    let s = MockServer::start().await;
    mount_status(&s, status_ok()).await;
    Mock::given(method("POST")).and(path("/api/user/login")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"success": false, "message": "Username or password is incorrect, or user has been banned"}))).mount(&s).await;
    let (c, _) = client(&s);
    assert_eq!(c.login("test", "bad").await.unwrap_err(), "账号或密码不正确，或账号已被禁用");
    assert!(!c.is_logged_in().await);
}

#[tokio::test]
async fn sites_with_captcha_or_without_password_login_are_rejected_before_any_login_request() {
    for (patch, expect) in [(json!({"turnstile_check": true}), "人机验证"), (json!({"password_login_enabled": false}), "没有开启账号密码登录")] {
        let s = MockServer::start().await;
        let mut st = status_ok();
        st["data"].as_object_mut().unwrap().extend(patch.as_object().unwrap().clone());
        mount_status(&s, st).await;
        Mock::given(method("POST")).and(path("/api/user/login")).respond_with(ResponseTemplate::new(200)).expect(0).mount(&s).await;
        let (c, _) = client(&s);
        let e = c.login("u", "p").await.unwrap_err();
        assert!(e.contains(expect), "{e}");
    }
}

#[tokio::test]
async fn two_factor_and_old_versions_get_clear_messages() {
    let s = MockServer::start().await;
    mount_status(&s, status_ok()).await;
    Mock::given(method("POST")).and(path("/api/user/login")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"success": true, "data": {"require_2fa": true}}))).mount(&s).await;
    let (c, _) = client(&s);
    assert!(c.login("u", "p").await.unwrap_err().contains("二次验证"));

    let s2 = MockServer::start().await;
    mount_status(&s2, status_ok()).await;
    // 旧版本：只有 Cookie 会话，没有 access_token / 刷新 Cookie
    Mock::given(method("POST")).and(path("/api/user/login")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"success": true, "data": {"id": 2, "username": "u"}}))).mount(&s2).await;
    let (c2, _) = client(&s2);
    assert!(c2.login("u", "p").await.unwrap_err().contains("版本较旧"));
    assert!(!c2.is_logged_in().await);
}

#[tokio::test]
async fn resume_sends_the_saved_cookie_and_persists_the_rotated_one() {
    let s = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/user/auth/refresh"))
        .and(header("cookie", "new_api_refresh=old-cookie"))
        .respond_with(ResponseTemplate::new(200).set_body_json(login_ok("fresh", far())).insert_header("set-cookie", "new_api_refresh=new-cookie; Path=/"))
        .expect(1)
        .mount(&s)
        .await;
    let (c, saved) = client(&s);
    c.resume("old-cookie").await.unwrap();
    assert!(c.is_logged_in().await);
    assert_eq!(*saved.lock().unwrap(), ["new-cookie"], "轮换后的新 Cookie 必须交给调用方保存");
}

#[tokio::test]
async fn resume_failure_leaves_the_client_logged_out() {
    let s = MockServer::start().await;
    Mock::given(method("POST")).and(path("/api/user/auth/refresh")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"success": false, "message": "expired"}))).mount(&s).await;
    let (c, saved) = client(&s);
    assert_eq!(c.resume("dead").await.unwrap_err(), "登录已过期，请重新登录");
    assert!(!c.is_logged_in().await);
    assert!(saved.lock().unwrap().is_empty());
}

#[tokio::test]
async fn expired_access_token_is_refreshed_before_the_call() {
    let s = MockServer::start().await;
    mount_status(&s, status_ok()).await;
    mount_login(&s, "stale", 1, "c1").await; // 登录时就已过期
    Mock::given(method("POST")).and(path("/api/user/auth/refresh")).and(header("cookie", "new_api_refresh=c1")).respond_with(ResponseTemplate::new(200).set_body_json(login_ok("good", far())).insert_header("set-cookie", "new_api_refresh=c2")).expect(1).mount(&s).await;
    Mock::given(method("GET")).and(path("/api/user/self")).and(header("authorization", "Bearer good")).and(header("new-api-user", "2")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"success": true, "data": {"username": "u", "quota": 500000}}))).expect(1).mount(&s).await;
    let (c, saved) = client(&s);
    c.login("u", "p").await.unwrap();
    assert_eq!(c.me().await.unwrap().balance, "$1.00");
    assert_eq!(*saved.lock().unwrap(), ["c2"]);
}

#[tokio::test]
async fn a_401_triggers_one_refresh_and_a_retry() {
    let s = MockServer::start().await;
    mount_status(&s, status_ok()).await;
    mount_login(&s, "tok-old", far(), "c1").await;
    Mock::given(method("GET")).and(path("/api/user/self")).and(header("authorization", "Bearer tok-old")).respond_with(ResponseTemplate::new(401).set_body_json(json!({"code": "AUTH_UNAUTHORIZED"}))).expect(1).mount(&s).await;
    Mock::given(method("POST")).and(path("/api/user/auth/refresh")).respond_with(ResponseTemplate::new(200).set_body_json(login_ok("tok-new", far())).insert_header("set-cookie", "new_api_refresh=c2")).expect(1).mount(&s).await;
    Mock::given(method("GET")).and(path("/api/user/self")).and(header("authorization", "Bearer tok-new")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"success": true, "data": {"username": "u", "quota": 0}}))).expect(1).mount(&s).await;
    let (c, saved) = client(&s);
    c.login("u", "p").await.unwrap();
    assert!(c.me().await.is_ok());
    assert_eq!(*saved.lock().unwrap(), ["c2"]);
}

#[tokio::test]
async fn refresh_that_keeps_failing_gives_a_relogin_prompt_instead_of_looping() {
    let s = MockServer::start().await;
    mount_status(&s, status_ok()).await;
    mount_login(&s, "t", far(), "c1").await;
    Mock::given(method("GET")).and(path("/api/user/self")).respond_with(ResponseTemplate::new(401)).mount(&s).await;
    Mock::given(method("POST")).and(path("/api/user/auth/refresh")).respond_with(ResponseTemplate::new(401)).expect(1).mount(&s).await;
    let (c, _) = client(&s);
    c.login("u", "p").await.unwrap();
    assert_eq!(c.me().await.unwrap_err(), "登录已过期，请重新登录");
}

#[tokio::test]
async fn existing_desktop_key_is_reused_and_prefixed_with_sk() {
    let s = MockServer::start().await;
    mount_status(&s, status_ok()).await;
    mount_login(&s, "t", far(), "c").await;
    Mock::given(method("GET")).and(path("/api/token/")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"success": true, "data": {"items": [
        {"id": 5, "name": "my-own-key", "group": "Kiro", "status": 1, "key": "abcd**********wxyz"},
        {"id": 9, "name": "desktop-Kiro", "group": "Kiro", "status": 1, "key": "abcd**********wxyz"},
    ]}}))).mount(&s).await;
    Mock::given(method("POST")).and(path("/api/token/9/key")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"success": true, "data": {"key": "FULLKEY123"}}))).expect(1).mount(&s).await;
    Mock::given(method("POST")).and(path("/api/token/")).respond_with(ResponseTemplate::new(200)).expect(0).mount(&s).await;
    let (c, _) = client(&s);
    c.login("u", "p").await.unwrap();
    assert_eq!(c.ensure_key(&group("Kiro")).await.unwrap(), ("sk-FULLKEY123".to_string(), false));
}

#[tokio::test]
async fn key_with_the_right_name_but_wrong_group_or_disabled_is_not_reused() {
    let s = MockServer::start().await;
    mount_status(&s, status_ok()).await;
    mount_login(&s, "t", far(), "c").await;
    Mock::given(method("GET")).and(path("/api/token/")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"success": true, "data": {"items": [
        {"id": 5, "name": "desktop-Kiro", "group": "Other", "status": 1},
        {"id": 6, "name": "desktop-Kiro", "group": "Kiro", "status": 2},
    ]}}))).up_to_n_times(1).mount(&s).await;
    Mock::given(method("POST")).and(path("/api/token/")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"success": true, "message": ""}))).expect(1).mount(&s).await;
    Mock::given(method("GET")).and(path("/api/token/")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"success": true, "data": {"items": [
        {"id": 5, "name": "desktop-Kiro", "group": "Other", "status": 1},
        {"id": 6, "name": "desktop-Kiro", "group": "Kiro", "status": 2},
        {"id": 7, "name": "desktop-Kiro", "group": "Kiro", "status": 1},
    ]}}))).mount(&s).await;
    Mock::given(method("POST")).and(path("/api/token/7/key")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"success": true, "data": {"key": "NEW"}}))).expect(1).mount(&s).await;
    let (c, _) = client(&s);
    c.login("u", "p").await.unwrap();
    assert_eq!(c.ensure_key(&group("Kiro")).await.unwrap(), ("sk-NEW".to_string(), true));
}

#[tokio::test]
async fn create_request_carries_the_group_and_unlimited_quota() {
    let s = MockServer::start().await;
    mount_status(&s, status_ok()).await;
    mount_login(&s, "t", far(), "c").await;
    Mock::given(method("GET")).and(path("/api/token/")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"success": true, "data": {"items": []}}))).up_to_n_times(1).mount(&s).await;
    Mock::given(method("POST")).and(path("/api/token/")).and(body_json(json!({"name": "desktop-A B", "group": "A B", "remain_quota": 0, "unlimited_quota": true, "expired_time": -1, "model_limits_enabled": false, "model_limits": "", "allow_ips": "", "cross_group_retry": false}))).respond_with(ResponseTemplate::new(200).set_body_json(json!({"success": true}))).expect(1).mount(&s).await;
    Mock::given(method("GET")).and(path("/api/token/")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"success": true, "data": {"items": [{"id": 3, "name": "desktop-A B", "group": "A B", "status": 1}]}}))).mount(&s).await;
    Mock::given(method("POST")).and(path_regex(r"^/api/token/3/key$")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"success": true, "data": {"key": "k"}}))).mount(&s).await;
    let (c, _) = client(&s);
    c.login("u", "p").await.unwrap();
    assert!(c.ensure_key(&group("A B")).await.unwrap().1);
}

#[tokio::test]
async fn failure_messages_from_the_site_reach_the_user() {
    let s = MockServer::start().await;
    mount_status(&s, status_ok()).await;
    mount_login(&s, "t", far(), "c").await;
    Mock::given(method("GET")).and(path("/api/token/")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"success": true, "data": {"items": []}}))).mount(&s).await;
    Mock::given(method("POST")).and(path("/api/token/")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"success": false, "message": "token quota limit reached"}))).mount(&s).await;
    let (c, _) = client(&s);
    c.login("u", "p").await.unwrap();
    assert_eq!(c.ensure_key(&group("Kiro")).await.unwrap_err(), "token quota limit reached");
}

#[tokio::test]
async fn groups_combine_self_groups_with_public_pricing_and_tolerate_missing_pricing() {
    let s = MockServer::start().await;
    mount_status(&s, status_ok()).await;
    mount_login(&s, "t", far(), "c").await;
    Mock::given(method("GET")).and(path("/api/user/self/groups")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"success": true, "data": {"Kiro": {"desc": "d", "ratio": 0.3}}}))).mount(&s).await;
    Mock::given(method("GET")).and(path("/api/pricing")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"data": [{"model_name": "claude-sonnet-5", "enable_groups": ["Kiro"]}]}))).up_to_n_times(1).mount(&s).await;
    let (c, _) = client(&s);
    c.login("u", "p").await.unwrap();
    let g = c.groups().await.unwrap();
    assert_eq!((g[0].platform.as_str(), g[0].models.len()), ("anthropic", 1));
    // pricing 之后不再可用：分组仍然返回，只是平台未知
    Mock::given(method("GET")).and(path("/api/pricing")).respond_with(ResponseTemplate::new(500)).mount(&s).await;
    let g2 = c.groups().await.unwrap();
    assert_eq!((g2.len(), g2[0].platform.as_str()), (1, "unknown"));
}

#[tokio::test]
async fn topup_url_prefers_the_site_setting_and_falls_back_to_the_console_page() {
    let s = MockServer::start().await;
    let mut st = status_ok();
    st["data"]["top_up_link"] = json!("https://pay.example.com/buy");
    mount_status(&s, st).await;
    let (c, _) = client(&s);
    assert_eq!(c.topup_url().await, "https://pay.example.com/buy");

    let s2 = MockServer::start().await;
    mount_status(&s2, status_ok()).await;
    let (c2, _) = client(&s2);
    assert_eq!(c2.topup_url().await, format!("{}/console/topup", s2.uri()));
}

#[tokio::test]
async fn logout_clears_the_session_and_tells_the_server() {
    let s = MockServer::start().await;
    mount_status(&s, status_ok()).await;
    mount_login(&s, "t", far(), "c1").await;
    Mock::given(method("POST")).and(path("/api/user/auth/logout")).and(header("cookie", "new_api_refresh=c1")).respond_with(ResponseTemplate::new(200)).expect(1).mount(&s).await;
    let (c, _) = client(&s);
    c.login("u", "p").await.unwrap();
    c.logout().await;
    assert!(!c.is_logged_in().await);
    assert_eq!(c.me().await.unwrap_err(), "未登录");
}

#[tokio::test]
async fn unreachable_site_gives_a_network_error_not_a_panic() {
    let c = SiteClient::new(Kind::Newapi, "http://127.0.0.1:1", Arc::new(|_| {}));
    let e = c.login("u", "p").await.unwrap_err();
    assert!(e.contains("无法连接") || e.contains("网络"), "{e}");
}

#[tokio::test]
async fn a_non_newapi_address_gets_an_actionable_message() {
    let s = MockServer::start().await;
    Mock::given(method("GET")).and(path("/api/status")).respond_with(ResponseTemplate::new(200).set_body_string("<html>hello</html>")).mount(&s).await;
    let (c, _) = client(&s);
    let e = c.login("u", "p").await.unwrap_err();
    assert!(e.contains("意外的内容") && e.contains("确认站点地址"), "{e}");
}
