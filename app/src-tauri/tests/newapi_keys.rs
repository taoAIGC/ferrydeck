//! new-api 的 Key 列表与创建：分页要按 total 翻、创建后列表可能延迟出现、找不到时不能反复创建。

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use app_lib::sites::{GroupInfo, Kind, SiteClient};
use serde_json::{json, Value};
use wiremock::matchers::{method, path, query_param};
use wiremock::{Mock, MockServer, Request, ResponseTemplate};

async fn login(s: &MockServer) -> SiteClient {
    Mock::given(method("GET")).and(path("/api/status")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"success": true, "data": {"quota_per_unit": 500000, "quota_display_type": "USD", "turnstile_check": false, "password_login_enabled": true}}))).mount(s).await;
    Mock::given(method("POST")).and(path("/api/user/login")).respond_with(
        ResponseTemplate::new(200).set_body_json(json!({"success": true, "data": {"access_token": "t", "access_expires_at": 4_000_000_000i64, "user": {"id": 2, "username": "u", "quota": 0}}})).insert_header("set-cookie", "new_api_refresh=c1; Path=/"),
    ).mount(s).await;
    let c = SiteClient::new(Kind::Newapi, &s.uri(), Arc::new(|_| {}));
    c.login("u", "p").await.unwrap();
    c
}

fn group(name: &str) -> GroupInfo {
    GroupInfo { id: name.into(), name: name.into(), description: None, platform: "anthropic".into(), rate_multiplier: 1.0, models: vec![] }
}

fn token(id: i64, name: &str, group: &str) -> Value {
    json!({"id": id, "name": name, "group": group, "status": 1, "key": "abcd**********wxyz"})
}

fn create_ok() -> ResponseTemplate {
    ResponseTemplate::new(200).set_body_json(json!({"success": true, "message": ""}))
}

#[tokio::test]
async fn paging_follows_total_even_when_the_site_ignores_the_page_size() {
    let s = MockServer::start().await;
    let c = login(&s).await;
    // 站点无视 page_size，一页只给 10 条；我们要的 Key 在第 3 页（升序排列时就是最老的那批之后）
    for (p, range) in [(1, 1..=10), (2, 11..=20), (3, 21..=25)] {
        let items: Vec<Value> = range.map(|i| token(i, &format!("other-{i}"), "x")).chain(if p == 3 { Some(token(99, "Ferrydeck-Kiro", "Kiro")) } else { None }).collect();
        Mock::given(method("GET")).and(path("/api/token/")).and(query_param("p", p.to_string())).respond_with(ResponseTemplate::new(200).set_body_json(json!({"success": true, "data": {"items": items, "total": 26, "page": p, "page_size": 10}}))).mount(&s).await;
    }
    Mock::given(method("POST")).and(path("/api/token/99/key")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"success": true, "data": {"key": "kiro-secret"}}))).mount(&s).await;
    Mock::given(method("POST")).and(path("/api/token/")).respond_with(ResponseTemplate::new(500)).expect(0).mount(&s).await; // 已经有了就不能再建
    assert_eq!(c.ensure_key(&group("Kiro")).await.unwrap(), ("sk-kiro-secret".to_string(), false));
}

#[tokio::test]
async fn a_key_that_shows_up_late_is_still_found() {
    let s = MockServer::start().await;
    let c = login(&s).await;
    let lists = Arc::new(AtomicUsize::new(0));
    let l2 = lists.clone();
    Mock::given(method("GET")).and(path("/api/token/")).respond_with(move |_: &Request| {
        let n = l2.fetch_add(1, Ordering::SeqCst);
        // 第 1 次是创建前的列表，第 2 次（刚创建完）读不到，第 3 次才出现：站点有读写延迟
        let items: Vec<Value> = if n >= 2 { vec![token(7, "Ferrydeck-Late", "Late")] } else { vec![] };
        ResponseTemplate::new(200).set_body_json(json!({"success": true, "data": {"items": items, "total": items.len()}}))
    }).mount(&s).await;
    Mock::given(method("POST")).and(path("/api/token/")).respond_with(create_ok()).expect(1).mount(&s).await;
    Mock::given(method("POST")).and(path("/api/token/7/key")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"success": true, "data": {"key": "late-secret"}}))).mount(&s).await;
    assert_eq!(c.ensure_key(&group("Late")).await.unwrap(), ("sk-late-secret".to_string(), true));
    assert!(lists.load(Ordering::SeqCst) >= 3);
}

#[tokio::test]
async fn when_the_new_key_never_appears_it_is_not_created_again_and_the_site_state_is_logged() {
    let s = MockServer::start().await;
    let c = login(&s).await;
    Mock::given(method("GET")).and(path("/api/token/")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"success": true, "data": {"items": [token(1, "something", "other")], "total": 1}}))).mount(&s).await;
    Mock::given(method("POST")).and(path("/api/token/")).respond_with(create_ok()).expect(1).mount(&s).await; // 只会真正建一次
    let first = c.ensure_key(&group("Ghost")).await.unwrap_err();
    assert_eq!(first, "创建 Key 后没有找到它");
    let again = c.ensure_key(&group("Ghost")).await.unwrap_err();
    assert!(again.contains("不再重复创建") && again.contains("Ghost"), "{again}");
    // 别的分组不受影响（仍然会尝试创建）
    Mock::given(method("POST")).and(path("/api/token/")).respond_with(create_ok()).expect(0..).mount(&s).await;
}

// ---------- pqh.ai 的情况：Key 列表里所有 Key 的 group 都是空 ----------

fn token_no_group(id: i64, name: &str) -> Value {
    json!({"id": id, "name": name, "group": "", "status": 1, "key": "abcd**********wxyz"})
}

#[tokio::test]
async fn a_list_that_never_reports_the_group_still_finds_the_key_we_just_created() {
    let s = MockServer::start().await;
    let c = login(&s).await;
    let lists = Arc::new(AtomicUsize::new(0));
    let l2 = lists.clone();
    // 和日志里一模一样：创建前 3 条，创建后 4 条，新建的那条名称对、group 是空、状态正常
    Mock::given(method("GET")).and(path("/api/token/")).respond_with(move |_: &Request| {
        let n = l2.fetch_add(1, Ordering::SeqCst);
        let mut items = vec![token_no_group(5912, "gemini4 argon"), token_no_group(5909, "Kiro 企业分组"), token_no_group(5890, "Xcode 1")];
        if n >= 1 {
            items.insert(0, token_no_group(5996, "Ferrydeck-AWSB企业专供"));
        }
        ResponseTemplate::new(200).set_body_json(json!({"success": true, "data": {"items": items, "total": items.len()}}))
    }).mount(&s).await;
    Mock::given(method("POST")).and(path("/api/token/")).respond_with(create_ok()).expect(1).mount(&s).await;
    Mock::given(method("POST")).and(path("/api/token/5996/key")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"success": true, "data": {"key": "awsb-secret"}}))).mount(&s).await;
    assert_eq!(c.ensure_key(&group("AWSB企业专供")).await.unwrap(), ("sk-awsb-secret".to_string(), true));
}

#[tokio::test]
async fn a_key_we_created_before_is_reused_not_created_again_even_if_the_list_has_no_group() {
    let s = MockServer::start().await;
    let c = login(&s).await;
    Mock::given(method("GET")).and(path("/api/token/")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"success": true, "data": {"items": [token_no_group(5996, "Ferrydeck-AWSB企业专供"), token_no_group(5912, "gemini4 argon")], "total": 2}}))).mount(&s).await;
    Mock::given(method("POST")).and(path("/api/token/5996/key")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"success": true, "data": {"key": "awsb-secret"}}))).mount(&s).await;
    Mock::given(method("POST")).and(path("/api/token/")).respond_with(ResponseTemplate::new(500)).expect(0).mount(&s).await; // 已经有了，绝不再建
    assert_eq!(c.ensure_key(&group("AWSB企业专供")).await.unwrap(), ("sk-awsb-secret".to_string(), false));
    // 旧版本留下的 desktop- 命名的 Key 也一样认
    Mock::given(method("GET")).and(path("/api/token/")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"success": true, "data": {"items": [token_no_group(5001, "desktop-Old")], "total": 1}}))).mount(&s).await;
}

#[tokio::test]
async fn when_the_list_does_report_a_group_it_must_still_match() {
    let s = MockServer::start().await;
    let c = login(&s).await;
    // 名称对、但列表明确说这把 Key 属于别的分组：不能用，要为当前分组另建
    let lists = Arc::new(AtomicUsize::new(0));
    let l2 = lists.clone();
    Mock::given(method("GET")).and(path("/api/token/")).respond_with(move |_: &Request| {
        let n = l2.fetch_add(1, Ordering::SeqCst);
        let mut items = vec![token(1, "Ferrydeck-Kiro", "SomethingElse")];
        if n >= 1 {
            items.push(token(2, "Ferrydeck-Kiro", "Kiro"));
        }
        ResponseTemplate::new(200).set_body_json(json!({"success": true, "data": {"items": items, "total": items.len()}}))
    }).mount(&s).await;
    Mock::given(method("POST")).and(path("/api/token/")).respond_with(create_ok()).expect(1).mount(&s).await;
    Mock::given(method("POST")).and(path("/api/token/2/key")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"success": true, "data": {"key": "right"}}))).mount(&s).await;
    assert_eq!(c.ensure_key(&group("Kiro")).await.unwrap(), ("sk-right".to_string(), true), "用的是 id=2 那把（分组对的）");
}
