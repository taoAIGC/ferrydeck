use std::sync::{Arc, Mutex};

use app_lib::sites::{check_supported, detect, GroupInfo, Kind, SiteClient};
use serde_json::{json, Value};
use wiremock::matchers::{body_json, header, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn client(s: &MockServer) -> (SiteClient, Arc<Mutex<Vec<String>>>) {
    let saved = Arc::new(Mutex::new(vec![]));
    let s2 = saved.clone();
    (SiteClient::new(Kind::Sub2api, &s.uri(), Arc::new(move |v| s2.lock().unwrap().push(v))), saved)
}

fn login_ok() -> Value {
    json!({"code": 0, "data": {"access_token": "acc1", "refresh_token": "ref1", "user": {"email": "a@b.c", "balance": 12.345}}})
}

fn group(id: &str, name: &str) -> GroupInfo {
    GroupInfo { id: id.into(), name: name.into(), description: None, platform: "anthropic".into(), rate_multiplier: 1.0, models: vec![] }
}

#[tokio::test]
async fn login_returns_account_and_refresh_token() {
    let s = MockServer::start().await;
    Mock::given(method("POST")).and(path("/api/v1/auth/login")).and(body_json(json!({"email": "a@b.c", "password": "pw"}))).respond_with(ResponseTemplate::new(200).set_body_json(login_ok())).mount(&s).await;
    let (c, _) = client(&s);
    let (acc, secret) = c.login("a@b.c", "pw").await.unwrap();
    assert_eq!((acc.display.as_str(), acc.balance.as_str(), secret.as_str()), ("a@b.c", "$12.35", "ref1"));
}

#[tokio::test]
async fn login_errors_are_readable() {
    let s = MockServer::start().await;
    Mock::given(method("POST")).and(path("/api/v1/auth/login")).respond_with(ResponseTemplate::new(401).set_body_json(json!({"message": "invalid email or password"}))).mount(&s).await;
    let (c, _) = client(&s);
    assert_eq!(c.login("a", "b").await.unwrap_err(), "账号或密码不正确");

    let s2 = MockServer::start().await;
    Mock::given(method("POST")).and(path("/api/v1/auth/login")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"code": 0, "data": {"requires_2fa": true}}))).mount(&s2).await;
    let (c2, _) = client(&s2);
    assert!(c2.login("a", "b").await.unwrap_err().contains("二次验证"));

    let s3 = MockServer::start().await;
    Mock::given(method("POST")).and(path("/api/v1/auth/login")).respond_with(ResponseTemplate::new(429)).mount(&s3).await;
    let (c3, _) = client(&s3);
    assert_eq!(c3.login("a", "b").await.unwrap_err(), "尝试次数过多，请稍后再试");
}

#[tokio::test]
async fn a_401_refreshes_once_persists_the_rotated_token_and_retries() {
    let s = MockServer::start().await;
    Mock::given(method("POST")).and(path("/api/v1/auth/login")).respond_with(ResponseTemplate::new(200).set_body_json(login_ok())).mount(&s).await;
    Mock::given(method("GET")).and(path("/api/v1/auth/me")).and(header("authorization", "Bearer acc1")).respond_with(ResponseTemplate::new(401)).expect(1).mount(&s).await;
    Mock::given(method("POST")).and(path("/api/v1/auth/refresh")).and(body_json(json!({"refresh_token": "ref1"}))).respond_with(ResponseTemplate::new(200).set_body_json(json!({"code": 0, "data": {"access_token": "acc2", "refresh_token": "ref2"}}))).expect(1).mount(&s).await;
    Mock::given(method("GET")).and(path("/api/v1/auth/me")).and(header("authorization", "Bearer acc2")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"code": 0, "data": {"email": "a@b.c", "balance": 1}}))).expect(1).mount(&s).await;
    let (c, saved) = client(&s);
    c.login("a@b.c", "pw").await.unwrap();
    assert_eq!(c.me().await.unwrap().balance, "$1.00");
    assert_eq!(*saved.lock().unwrap(), ["ref2"], "轮换后的刷新令牌必须交给调用方保存");
}

#[tokio::test]
async fn resume_with_a_dead_token_fails_cleanly() {
    let s = MockServer::start().await;
    Mock::given(method("POST")).and(path("/api/v1/auth/refresh")).respond_with(ResponseTemplate::new(401)).mount(&s).await;
    let (c, _) = client(&s);
    assert_eq!(c.resume("dead").await.unwrap_err(), "登录已过期，请重新登录");
    assert!(!c.is_logged_in().await);
}

#[tokio::test]
async fn groups_skip_inactive_ones_and_use_numeric_ids_as_strings() {
    let s = MockServer::start().await;
    Mock::given(method("POST")).and(path("/api/v1/auth/login")).respond_with(ResponseTemplate::new(200).set_body_json(login_ok())).mount(&s).await;
    Mock::given(method("GET")).and(path("/api/v1/groups/available")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"code": 0, "data": [
        {"id": 2, "name": "A", "platform": "anthropic", "rate_multiplier": 2.5, "status": "active", "description": "d"},
        {"id": 3, "name": "B", "platform": "openai", "status": "disabled"},
    ]}))).mount(&s).await;
    let (c, _) = client(&s);
    c.login("a", "b").await.unwrap();
    let g = c.groups().await.unwrap();
    assert_eq!(g.len(), 1);
    assert_eq!((g[0].id.as_str(), g[0].rate_multiplier, g[0].description.as_deref()), ("2", 2.5, Some("d")));
}

#[tokio::test]
async fn ensure_key_reuses_a_matching_key_and_creates_otherwise() {
    let s = MockServer::start().await;
    Mock::given(method("POST")).and(path("/api/v1/auth/login")).respond_with(ResponseTemplate::new(200).set_body_json(login_ok())).mount(&s).await;
    Mock::given(method("GET")).and(path("/api/v1/keys")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"code": 0, "data": {"items": [
        {"id": 1, "name": "desktop-A", "key": "sk-existing", "group_id": 2, "status": "active"},
        {"id": 2, "name": "desktop-B", "key": "sk-wrong-group", "group_id": 99, "status": "active"},
    ]}}))).mount(&s).await;
    Mock::given(method("POST")).and(path("/api/v1/keys")).and(body_json(json!({"name": "desktop-B", "group_id": 3}))).respond_with(ResponseTemplate::new(200).set_body_json(json!({"code": 0, "data": {"id": 5, "name": "desktop-B", "key": "sk-created", "group_id": 3, "status": "active"}}))).expect(1).mount(&s).await;
    let (c, _) = client(&s);
    c.login("a", "b").await.unwrap();
    assert_eq!(c.ensure_key(&group("2", "A")).await.unwrap(), ("sk-existing".to_string(), false));
    assert_eq!(c.ensure_key(&group("3", "B")).await.unwrap(), ("sk-created".to_string(), true));
    assert!(c.ensure_key(&group("not-a-number", "X")).await.is_err());
}

#[tokio::test]
async fn topup_points_at_the_purchase_page() {
    let s = MockServer::start().await;
    let (c, _) = client(&s);
    assert_eq!(c.topup_url().await, format!("{}/purchase", s.uri()));
}

#[tokio::test]
async fn detect_tells_the_two_systems_apart() {
    let sub = MockServer::start().await;
    Mock::given(method("GET")).and(path("/api/v1/settings/public")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"code": 0, "data": {"turnstile_enabled": false}}))).mount(&sub).await;
    assert_eq!(detect(&sub.uri()).await.unwrap(), Kind::Sub2api);
    check_supported(&sub.uri(), Kind::Sub2api).await.unwrap();

    let na = MockServer::start().await;
    Mock::given(method("GET")).and(path("/api/status")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"success": true, "data": {"version": "rc.45"}}))).mount(&na).await;
    assert_eq!(detect(&na.uri()).await.unwrap(), Kind::Newapi);

    let other = MockServer::start().await; // 什么都不认识的站点：全部 404
    assert!(detect(&other.uri()).await.unwrap_err().contains("无法识别"));
    assert!(detect("http://127.0.0.1:1").await.unwrap_err().contains("无法连接"));
}

#[tokio::test]
async fn sub2api_with_turnstile_is_flagged_unsupported() {
    let s = MockServer::start().await;
    Mock::given(method("GET")).and(path("/api/v1/settings/public")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"code": 0, "data": {"turnstile_enabled": true}}))).mount(&s).await;
    assert!(check_supported(&s.uri(), Kind::Sub2api).await.unwrap_err().contains("人机验证"));
}
