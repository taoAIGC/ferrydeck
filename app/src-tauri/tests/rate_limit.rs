//! 站点返回 429（限流）时的行为：读 Retry-After、冷却期内不再发请求、只冷却被限流的那个接口；
//! new-api 的 Key 明文只取一次（取明文的接口和登录、刷新令牌共用“严格档”限流桶）。

use std::sync::{Arc, Mutex};

use app_lib::sites::http::{is_rate_limited, Http, ProbeWire};
use app_lib::sites::{GroupInfo, Kind, SiteClient};
use reqwest::Method;
use serde_json::{json, Value};
use wiremock::matchers::{method, path, path_regex};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn limited(secs: &str) -> ResponseTemplate {
    ResponseTemplate::new(429).insert_header("retry-after", secs)
}

#[tokio::test]
async fn a_429_reads_retry_after_and_pauses_only_that_endpoint() {
    let s = MockServer::start().await;
    Mock::given(method("POST")).and(path("/api/user/auth/refresh")).respond_with(limited("30")).expect(1).mount(&s).await; // 冷却期内只会真正打到站点一次
    Mock::given(method("GET")).and(path("/api/status")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"success": true}))).expect(2).mount(&s).await;
    let h = Http::new(&s.uri());
    let e = h.send(Method::POST, "/api/user/auth/refresh", None, None, &[], Some(json!({}))).await.err().unwrap();
    assert!(is_rate_limited(&e) && e.contains("30 秒"), "{e}");
    // 马上再来：不发请求，直接告诉用户还要等多久
    let again = h.send(Method::POST, "/api/user/auth/refresh", None, None, &[], Some(json!({}))).await.err().unwrap();
    assert!(is_rate_limited(&again), "{again}");
    // 别的接口不受影响
    assert!(h.send(Method::GET, "/api/status", None, None, &[], None).await.is_ok());
    assert!(h.send(Method::GET, "/api/status", None, None, &[], None).await.is_ok());
}

#[tokio::test]
async fn retry_after_is_bounded_and_defaults_when_missing() {
    let s = MockServer::start().await;
    Mock::given(method("GET")).and(path("/a")).respond_with(limited("999999")).mount(&s).await;
    Mock::given(method("GET")).and(path("/b")).respond_with(ResponseTemplate::new(429)).mount(&s).await;
    let h = Http::new(&s.uri());
    let a = h.send(Method::GET, "/a", None, None, &[], None).await.err().unwrap();
    assert!(a.contains("20 分钟"), "最长只冷却 20 分钟: {a}");
    let b = h.send(Method::GET, "/b", None, None, &[], None).await.err().unwrap();
    assert!(b.contains("60 秒"), "没有 Retry-After 就保守等 60 秒: {b}");
}

#[tokio::test]
async fn ids_in_the_path_share_one_cooldown() {
    let s = MockServer::start().await;
    Mock::given(method("POST")).respond_with(limited("40")).expect(1).mount(&s).await;
    let h = Http::new(&s.uri());
    assert!(h.send(Method::POST, "/api/token/9/key", None, None, &[], None).await.is_err());
    // 换一个 token id 也是同一个接口，限流窗口还没过，不要再去敲
    assert!(is_rate_limited(&h.send(Method::POST, "/api/token/10/key", None, None, &[], None).await.err().unwrap()));
}

#[tokio::test]
async fn a_429_from_the_model_endpoint_is_reported_with_the_wait_time() {
    let s = MockServer::start().await;
    Mock::given(method("POST")).respond_with(limited("12")).mount(&s).await;
    let e = Http::new(&s.uri()).probe("sk-x", "m", ProbeWire::Chat).await.unwrap_err();
    assert!(is_rate_limited(&e) && e.contains("12 秒"), "{e}");
}

// ---------- new-api：Key 明文只取一次 ----------

fn newapi(s: &MockServer) -> SiteClient {
    SiteClient::new(Kind::Newapi, &s.uri(), Arc::new(|_| {}))
}

async fn login(s: &MockServer) -> SiteClient {
    Mock::given(method("GET")).and(path("/api/status")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"success": true, "data": {"quota_per_unit": 500000, "quota_display_type": "USD", "turnstile_check": false, "password_login_enabled": true}}))).mount(s).await;
    Mock::given(method("POST")).and(path("/api/user/login")).respond_with(
        ResponseTemplate::new(200).set_body_json(json!({"success": true, "data": {"access_token": "t", "access_expires_at": 4_000_000_000i64, "user": {"id": 2, "username": "u", "quota": 0}}})).insert_header("set-cookie", "new_api_refresh=c1; Path=/"),
    ).mount(s).await;
    let c = newapi(s);
    c.login("u", "p").await.unwrap();
    c
}

fn group(name: &str) -> GroupInfo {
    GroupInfo { id: name.into(), name: name.into(), description: None, platform: "anthropic".into(), rate_multiplier: 1.0, models: vec![] }
}

#[tokio::test]
async fn the_plaintext_key_is_fetched_once_even_if_asked_for_many_times() {
    let s = MockServer::start().await;
    let c = login(&s).await;
    Mock::given(method("GET")).and(path("/api/token/")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"success": true, "data": {"items": [{"id": 9, "name": "Ferrydeck-Kiro", "group": "Kiro", "status": 1}]}}))).mount(&s).await;
    Mock::given(method("POST")).and(path("/api/token/9/key")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"success": true, "data": {"key": "secret"}}))).expect(1).mount(&s).await; // 严格档接口：只能打一次
    for _ in 0..5 {
        assert_eq!(c.ensure_key(&group("Kiro")).await.unwrap(), ("sk-secret".to_string(), false));
    }
    assert_eq!(c.existing_keys(&[group("Kiro")]).await.unwrap(), vec![(0, "sk-secret".to_string())]);
}

#[tokio::test]
async fn one_sweep_fetches_at_most_a_handful_of_new_plaintext_keys() {
    let s = MockServer::start().await;
    let c = login(&s).await;
    let items: Vec<Value> = (1..=12).map(|i| json!({"id": i, "name": format!("Ferrydeck-G{i}"), "group": format!("G{i}"), "status": 1})).collect();
    Mock::given(method("GET")).and(path("/api/token/")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"success": true, "data": {"items": items}}))).mount(&s).await;
    let fetched = Arc::new(Mutex::new(0));
    let f2 = fetched.clone();
    Mock::given(method("POST")).respond_with(move |_: &wiremock::Request| {
        *f2.lock().unwrap() += 1;
        ResponseTemplate::new(200).set_body_json(json!({"success": true, "data": {"key": "k"}}))
    }).mount(&s).await;
    let groups: Vec<GroupInfo> = (1..=12).map(|i| group(&format!("G{i}"))).collect();
    let found = c.existing_keys(&groups).await.unwrap();
    assert_eq!(found.len(), 6, "一次最多新取 6 把，给登录和刷新令牌留额度");
    assert_eq!(*fetched.lock().unwrap(), 6);
    // 下一次接着取剩下的，已经取过的不会重复请求
    let found2 = c.existing_keys(&groups).await.unwrap();
    assert_eq!(found2.len(), 12);
    assert_eq!(*fetched.lock().unwrap(), 12);
}

// ---------- new-api：自己给读取 Key 设预算 ----------

async fn many_tokens(s: &MockServer, n: usize) {
    let items: Vec<Value> = (1..=n).map(|i| json!({"id": i, "name": format!("Ferrydeck-G{i}"), "group": format!("G{i}"), "status": 1})).collect();
    Mock::given(method("GET")).and(path("/api/token/")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"success": true, "data": {"items": items}}))).mount(s).await;
}

#[tokio::test]
async fn reading_keys_stops_at_the_budget_so_login_and_refresh_keep_their_share() {
    let s = MockServer::start().await;
    let c = login(&s).await;
    many_tokens(&s, 20).await;
    let fetched = Arc::new(Mutex::new(0usize));
    let f2 = fetched.clone();
    Mock::given(method("POST")).respond_with(move |_: &wiremock::Request| {
        *f2.lock().unwrap() += 1;
        ResponseTemplate::new(200).set_body_json(json!({"success": true, "data": {"key": "k"}}))
    }).mount(&s).await;
    let mut ok = 0;
    let mut last_err = String::new();
    for i in 1..=20 {
        match c.ensure_key(&group(&format!("G{i}"))).await {
            Ok(_) => ok += 1,
            Err(e) => last_err = e,
        }
    }
    assert_eq!(ok, 12, "20 分钟内最多读 12 把 Key，剩下 8 次留给登录和刷新令牌");
    assert_eq!(*fetched.lock().unwrap(), 12, "站点的严格档接口只被请求了 12 次");
    assert!(is_rate_limited(&last_err) && last_err.contains("站点限流保护"), "{last_err}");
    // 已经读过的 Key 有缓存，再要不花预算
    assert!(c.ensure_key(&group("G1")).await.is_ok());
    assert_eq!(*fetched.lock().unwrap(), 12);
}

#[tokio::test]
async fn no_key_is_created_when_it_could_not_be_read_back() {
    let s = MockServer::start().await;
    let c = login(&s).await;
    many_tokens(&s, 12).await;
    Mock::given(method("POST")).and(path_regex(r"^/api/token/\d+/key$")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"success": true, "data": {"key": "k"}}))).mount(&s).await;
    // 先把 12 次预算用完
    for i in 1..=12 {
        c.ensure_key(&group(&format!("G{i}"))).await.unwrap();
    }
    // 现在要为一个还没有 Key 的分组建 Key：建完还得读一次明文，预算不够，所以连建都不该去建
    Mock::given(method("POST")).and(path("/api/token/")).respond_with(ResponseTemplate::new(200)).expect(0).mount(&s).await;
    let e = c.ensure_key(&group("Brand New")).await.unwrap_err();
    assert!(is_rate_limited(&e), "{e}");
}

#[tokio::test]
async fn short_retry_after_on_the_log_endpoint_waits_and_retries_instead_of_failing() {
    // new-api 的日志接口 2~3 秒才放行一次，429 时 Retry-After 只有 1~2 秒：应该等一下再发，而不是让整个成本读取失败
    let s = MockServer::start().await;
    Mock::given(method("GET")).and(path("/api/log/self")).respond_with(limited("1")).up_to_n_times(1).mount(&s).await;
    Mock::given(method("GET")).and(path("/api/log/self")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"success": true}))).mount(&s).await;
    let h = Http::new(&s.uri());
    let r = h.send(Method::GET, "/api/log/self?p=1", None, None, &[], None).await;
    assert!(r.is_ok(), "{:?}", r.err());
}
