//! new-api 适配器的离线测试：用本地模拟服务器重现各种真实站点的行为。
use std::sync::{Arc, Mutex};

use app_lib::sites::{is_expired, GroupInfo, Kind, SiteClient};
use serde_json::{json, Value};
use wiremock::matchers::{body_json, header, method, path, path_regex, query_param};
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
    Mock::given(method("POST")).and(path("/api/token/")).and(body_json(json!({"name": "Ferrydeck-A B", "group": "A B", "remain_quota": 0, "unlimited_quota": true, "expired_time": -1, "model_limits_enabled": false, "model_limits": "", "allow_ips": "", "cross_group_retry": false}))).respond_with(ResponseTemplate::new(200).set_body_json(json!({"success": true}))).expect(1).mount(&s).await;
    Mock::given(method("GET")).and(path("/api/token/")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"success": true, "data": {"items": [{"id": 3, "name": "Ferrydeck-A B", "group": "A B", "status": 1}]}}))).mount(&s).await;
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

// ---------- 登录保持 ----------

fn refreshed(access: &str, cookie: &str) -> ResponseTemplate {
    ResponseTemplate::new(200).set_body_json(login_ok(access, far())).insert_header("set-cookie", format!("new_api_refresh={cookie}; Path=/; HttpOnly").as_str())
}

/// new-api 的刷新 Cookie 每次都轮换：c1 只认第一次，之后再用就被拒绝。
async fn mount_rotating_refresh(s: &MockServer) {
    Mock::given(method("POST")).and(path("/api/user/auth/refresh")).and(header("cookie", "new_api_refresh=c1")).respond_with(refreshed("good", "c2").set_delay(std::time::Duration::from_millis(200))).up_to_n_times(1).expect(1).mount(s).await;
    Mock::given(method("POST")).and(path("/api/user/auth/refresh")).respond_with(ResponseTemplate::new(401)).with_priority(10).mount(s).await;
}

#[tokio::test]
async fn concurrent_calls_with_an_expiring_token_rotate_the_cookie_only_once() {
    let s = MockServer::start().await;
    mount_status(&s, status_ok()).await;
    mount_login(&s, "stale", 1, "c1").await; // 登录时就快过期，两个请求都会先去刷新
    mount_rotating_refresh(&s).await;
    Mock::given(method("GET")).and(path("/api/user/self")).and(header("authorization", "Bearer good")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"success": true, "data": {"username": "u", "quota": 0}}))).mount(&s).await;
    Mock::given(method("GET")).and(path("/api/user/self/groups")).and(header("authorization", "Bearer good")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"success": true, "data": {}}))).mount(&s).await;
    Mock::given(method("GET")).and(path("/api/pricing")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"success": true, "data": []}))).mount(&s).await;
    let (c, saved) = client(&s);
    c.login("u", "p").await.unwrap();
    let (me, groups) = tokio::join!(c.me(), c.groups());
    assert!(me.is_ok() && groups.is_ok(), "{me:?} {groups:?}");
    assert_eq!(*saved.lock().unwrap(), ["c2"]);
}

#[tokio::test]
async fn concurrent_resumes_at_startup_rotate_the_cookie_only_once() {
    let s = MockServer::start().await;
    mount_rotating_refresh(&s).await;
    let (c, saved) = client(&s);
    let (a, b) = tokio::join!(c.resume("c1"), c.resume("c1"));
    assert!(a.is_ok() && b.is_ok(), "{a:?} {b:?}");
    assert_eq!(*saved.lock().unwrap(), ["c2"]);
}

#[tokio::test]
async fn site_troubles_keep_the_login_and_it_recovers_without_relogin() {
    for bad in [ResponseTemplate::new(502), ResponseTemplate::new(403).set_body_string("<html>Just a moment...</html>"), ResponseTemplate::new(200).set_body_string("<html>portal</html>")] {
        let s = MockServer::start().await;
        mount_status(&s, status_ok()).await;
        Mock::given(method("POST")).and(path("/api/user/auth/refresh")).respond_with(bad).up_to_n_times(1).mount(&s).await;
        Mock::given(method("POST")).and(path("/api/user/auth/refresh")).and(header("cookie", "new_api_refresh=c1")).respond_with(refreshed("good", "c2")).with_priority(10).mount(&s).await;
        Mock::given(method("GET")).and(path("/api/user/self")).and(header("authorization", "Bearer good")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"success": true, "data": {"username": "u", "quota": 500000}}))).mount(&s).await;
        let (c, saved) = client(&s);
        let e = c.resume("c1").await.unwrap_err();
        assert!(e.contains("稍后会自动重试") && !is_expired(&e), "{e}");
        assert!(c.is_logged_in().await, "暂时性问题不能丢掉凭据");
        assert_eq!(c.me().await.unwrap().balance, "$1.00");
        assert_eq!(*saved.lock().unwrap(), ["c2"]);
    }
}

#[tokio::test]
async fn keep_alive_rotates_the_cookie_when_the_last_refresh_is_old_enough() {
    let s = MockServer::start().await;
    mount_status(&s, status_ok()).await;
    mount_login(&s, "t", far(), "c1").await;
    Mock::given(method("POST")).and(path("/api/user/auth/refresh")).and(header("cookie", "new_api_refresh=c1")).respond_with(refreshed("good", "c2")).expect(1).mount(&s).await;
    let (c, saved) = client(&s);
    c.login("u", "p").await.unwrap();
    c.keep_alive(3600).await.unwrap();
    assert!(saved.lock().unwrap().is_empty());
    c.keep_alive(0).await.unwrap();
    assert_eq!(*saved.lock().unwrap(), ["c2"]);
}

#[tokio::test]
async fn existing_keys_lists_once_and_only_fetches_plaintext_for_groups_that_have_a_key() {
    let s = MockServer::start().await;
    mount_status(&s, status_ok()).await;
    mount_login(&s, "t", far(), "c1").await;
    Mock::given(method("GET")).and(path("/api/token/")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"success": true, "data": {"items": [
        {"id": 9, "name": "Ferrydeck-Kiro", "group": "Kiro", "status": 1},
        {"id": 8, "name": "desktop-Old", "group": "Old", "status": 1},
        {"id": 7, "name": "Ferrydeck-Off", "group": "Off", "status": 2},
    ]}}))).expect(1).mount(&s).await;
    Mock::given(method("POST")).and(path("/api/token/9/key")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"success": true, "data": {"key": "kiro-secret"}}))).expect(1).mount(&s).await;
    Mock::given(method("POST")).and(path("/api/token/8/key")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"success": true, "data": {"key": "old-secret"}}))).expect(1).mount(&s).await;
    Mock::given(method("POST")).and(path("/api/token/")).respond_with(ResponseTemplate::new(500)).expect(0).mount(&s).await; // 绝不新建
    let (c, _) = client(&s);
    c.login("u", "p").await.unwrap();
    let groups = [group("Kiro"), group("Old"), group("Off"), group("None")];
    let found = c.existing_keys(&groups).await.unwrap();
    assert_eq!(found, vec![(0, "sk-kiro-secret".to_string()), (1, "sk-old-secret".to_string())]);
}

#[tokio::test]
async fn group_usage_sums_the_consumption_log_with_cache_and_first_token_from_other() {
    let s = MockServer::start().await;
    mount_status(&s, status_ok()).await;
    mount_login(&s, "t", far(), "c").await;
    // other 既可能是 JSON 字符串，也可能是对象
    Mock::given(method("GET")).and(path("/api/log/self")).and(query_param("group", "Kiro")).and(query_param("type", "2")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"success": true, "data": {"total": 4, "items": [
        {"model_name": "claude-sonnet-5", "prompt_tokens": 1000, "completion_tokens": 500, "quota": 500000, "use_time": 3, "other": "{\"frt\": 400, \"cache_tokens\": 800, \"cache_creation_tokens\": 100}"},
        {"model_name": "claude-sonnet-5", "prompt_tokens": 1000, "completion_tokens": 500, "quota": 500000, "use_time": 1, "other": {"frt": 800, "cache_tokens": 0}},
        {"model_name": "gpt", "prompt_tokens": 1000, "completion_tokens": 0, "quota": 0, "other": "{\"usage_semantic\":\"openai\",\"cache_tokens\":600}"},
        {"model_name": "haiku", "prompt_tokens": 0, "completion_tokens": 0, "quota": 0, "use_time": 0, "other": "not json"},
    ]}}))).expect(1).mount(&s).await;
    Mock::given(method("GET")).and(path("/api/pricing")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"data": [
        {"model_name": "claude-sonnet-5", "enable_groups": ["Kiro"], "quota_type": 0, "model_ratio": 1.5, "completion_ratio": 5.0},
        {"model_name": "claude-other", "enable_groups": ["Else"], "quota_type": 0, "model_ratio": 1.0}]}))).mount(&s).await;
    let (c, _) = client(&s);
    c.login("u", "p").await.unwrap();
    let mut g = group("Kiro");
    g.rate_multiplier = 0.5;
    let u = c.group_usage(&g).await.unwrap();
    assert_eq!((u.currency.as_str(), u.requests, u.total_requests, u.sampled), ("$", 4, 4, false));
    assert_eq!((u.input_tokens, u.output_tokens, u.cache_read_tokens, u.cache_creation_tokens), (2400, 1000, 1400, 100));
    assert!((u.cost - 2.0).abs() < 1e-9, "两条各 1 美元: {}", u.cost);
    assert_eq!(u.cost_per_m_effective.map(|v| v.round()), Some(588.0));
    assert_eq!((u.first_token_median_ms, u.first_token_samples), (Some(400), 2));
    assert_eq!(u.models.len(), 3);
    assert_eq!(u.estimates.len(), 1, "只算这个分组里的按量计费模型");
    let e = &u.estimates[0];
    assert!((e.input_per_m - 1.5).abs() < 1e-9 && (e.output_per_m - 7.5).abs() < 1e-9, "{e:?}");
}

#[tokio::test]
async fn group_usage_reports_when_the_log_is_only_a_sample_and_fails_if_the_log_fails() {
    let s = MockServer::start().await;
    mount_status(&s, status_ok()).await;
    mount_login(&s, "t", far(), "c").await;
    let items: Vec<Value> = (0..100).map(|_| json!({"model_name": "m", "prompt_tokens": 10, "completion_tokens": 10, "quota": 500})).collect();
    Mock::given(method("GET")).and(path("/api/log/self")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"success": true, "data": {"total": 1000, "items": items}}))).expect(3).mount(&s).await;
    Mock::given(method("GET")).and(path("/api/pricing")).respond_with(ResponseTemplate::new(500)).mount(&s).await;
    let (c, _) = client(&s);
    c.login("u", "p").await.unwrap();
    let u = c.group_usage(&group("Kiro")).await.unwrap();
    assert_eq!((u.requests, u.total_requests, u.sampled), (300, 1000, true), "最多翻 3 页");
    assert!(u.notes.iter().any(|n| n.contains("1000")), "{:?}", u.notes);

    let s2 = MockServer::start().await;
    mount_status(&s2, status_ok()).await;
    mount_login(&s2, "t", far(), "c").await;
    Mock::given(method("GET")).and(path("/api/log/self")).respond_with(ResponseTemplate::new(500)).mount(&s2).await;
    let (c2, _) = client(&s2);
    c2.login("u", "p").await.unwrap();
    assert!(c2.group_usage(&group("Kiro")).await.is_err());
}
