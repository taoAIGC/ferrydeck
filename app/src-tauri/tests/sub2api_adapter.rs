use std::sync::{Arc, Mutex};

use app_lib::sites::{check_supported, detect, is_expired, GroupInfo, Kind, SiteClient};
use serde_json::{json, Value};
use wiremock::matchers::{body_json, header, method, path, query_param};
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
    let limited = c3.login("a", "b").await.unwrap_err();
    assert!(app_lib::sites::http::is_rate_limited(&limited) && limited.contains("60 秒"), "限流提示要带上要等多久: {limited}");
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
    Mock::given(method("POST")).and(path("/api/v1/keys")).and(body_json(json!({"name": "Ferrydeck-B", "group_id": 3}))).respond_with(ResponseTemplate::new(200).set_body_json(json!({"code": 0, "data": {"id": 5, "name": "Ferrydeck-B", "key": "sk-created", "group_id": 3, "status": "active"}}))).expect(1).mount(&s).await;
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

// ---------- 登录保持 ----------

fn refreshed(access: &str, refresh: &str) -> ResponseTemplate {
    ResponseTemplate::new(200).set_body_json(json!({"code": 0, "data": {"access_token": access, "refresh_token": refresh}}))
}

/// 模拟“刷新令牌只能用一次”的站点：ref1 只认第一次，之后再用就 401。
async fn mount_one_time_refresh(s: &MockServer, delay_ms: u64) {
    Mock::given(method("POST")).and(path("/api/v1/auth/refresh")).and(body_json(json!({"refresh_token": "ref1"}))).respond_with(refreshed("acc2", "ref2").set_delay(std::time::Duration::from_millis(delay_ms))).up_to_n_times(1).expect(1).mount(s).await;
    Mock::given(method("POST")).and(path("/api/v1/auth/refresh")).respond_with(ResponseTemplate::new(401)).with_priority(10).mount(s).await;
}

#[tokio::test]
async fn concurrent_401s_share_one_refresh_so_a_one_time_token_is_not_burned_twice() {
    let s = MockServer::start().await;
    Mock::given(method("POST")).and(path("/api/v1/auth/login")).respond_with(ResponseTemplate::new(200).set_body_json(login_ok())).mount(&s).await;
    for p in ["/api/v1/auth/me", "/api/v1/groups/available"] {
        Mock::given(method("GET")).and(path(p)).and(header("authorization", "Bearer acc1")).respond_with(ResponseTemplate::new(401)).mount(&s).await;
    }
    Mock::given(method("GET")).and(path("/api/v1/auth/me")).and(header("authorization", "Bearer acc2")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"code": 0, "data": {"email": "a@b.c", "balance": 1}}))).mount(&s).await;
    Mock::given(method("GET")).and(path("/api/v1/groups/available")).and(header("authorization", "Bearer acc2")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"code": 0, "data": []}))).mount(&s).await;
    mount_one_time_refresh(&s, 200).await;
    let (c, saved) = client(&s);
    c.login("a@b.c", "pw").await.unwrap();
    let (me, groups) = tokio::join!(c.me(), c.groups());
    assert!(me.is_ok() && groups.is_ok(), "{me:?} {groups:?}");
    assert_eq!(*saved.lock().unwrap(), ["ref2"]);
}

#[tokio::test]
async fn concurrent_resumes_at_startup_refresh_only_once() {
    let s = MockServer::start().await;
    mount_one_time_refresh(&s, 200).await;
    let (c, saved) = client(&s);
    let (a, b) = tokio::join!(c.resume("ref1"), c.resume("ref1"));
    assert!(a.is_ok() && b.is_ok(), "{a:?} {b:?}");
    assert_eq!(*saved.lock().unwrap(), ["ref2"]);
}

#[tokio::test]
async fn network_and_site_troubles_keep_the_login_and_it_recovers_without_relogin() {
    // 站点故障、限流、Cloudflare 等防护页（HTML）、内容不像接口：都不是凭据的问题
    for bad in [ResponseTemplate::new(503), ResponseTemplate::new(502).set_body_string("<html>Bad gateway</html>"), ResponseTemplate::new(403).set_body_string("<html>Just a moment...</html>"), ResponseTemplate::new(200).set_body_string("<html>portal</html>")] {
        let s = MockServer::start().await;
        Mock::given(method("POST")).and(path("/api/v1/auth/refresh")).respond_with(bad).up_to_n_times(1).mount(&s).await;
        Mock::given(method("POST")).and(path("/api/v1/auth/refresh")).and(body_json(json!({"refresh_token": "ref1"}))).respond_with(refreshed("acc2", "ref2")).with_priority(10).mount(&s).await;
        Mock::given(method("GET")).and(path("/api/v1/auth/me")).and(header("authorization", "Bearer acc2")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"code": 0, "data": {"email": "a@b.c", "balance": 1}}))).mount(&s).await;
        let (c, saved) = client(&s);
        let e = c.resume("ref1").await.unwrap_err();
        assert!(e.contains("稍后会自动重试") && !is_expired(&e), "{e}");
        assert!(c.is_logged_in().await, "暂时性问题不能丢掉凭据");
        assert_eq!(c.me().await.unwrap().balance, "$1.00", "恢复后直接可用，不用重新登录");
        assert_eq!(*saved.lock().unwrap(), ["ref2"]);
    }
}

#[tokio::test]
async fn an_unreachable_site_keeps_the_login() {
    let c = SiteClient::new(Kind::Sub2api, "http://127.0.0.1:1", Arc::new(|_| {}));
    let e = c.resume("ref1").await.unwrap_err();
    assert!(e.contains("稍后会自动重试") && !is_expired(&e), "{e}");
    assert!(c.is_logged_in().await);
}

#[tokio::test]
async fn an_explicit_rejection_logs_out() {
    for bad in [ResponseTemplate::new(401), ResponseTemplate::new(403).set_body_json(json!({"code": 403, "message": "token revoked"})), ResponseTemplate::new(400).set_body_json(json!({"code": 400, "message": "invalid refresh token"})), ResponseTemplate::new(200).set_body_json(json!({"code": 1001, "message": "invalid refresh token"}))] {
        let s = MockServer::start().await;
        Mock::given(method("POST")).and(path("/api/v1/auth/refresh")).respond_with(bad).mount(&s).await;
        let (c, saved) = client(&s);
        assert_eq!(c.resume("dead").await.unwrap_err(), "登录已过期，请重新登录");
        assert!(!c.is_logged_in().await);
        assert!(saved.lock().unwrap().is_empty());
    }
}

#[tokio::test]
async fn keep_alive_refreshes_only_when_the_last_refresh_is_old_enough() {
    let s = MockServer::start().await;
    Mock::given(method("POST")).and(path("/api/v1/auth/login")).respond_with(ResponseTemplate::new(200).set_body_json(login_ok())).mount(&s).await;
    Mock::given(method("POST")).and(path("/api/v1/auth/refresh")).and(body_json(json!({"refresh_token": "ref1"}))).respond_with(refreshed("acc2", "ref2")).expect(1).mount(&s).await;
    let (c, saved) = client(&s);
    c.keep_alive(0).await.unwrap(); // 没登录：什么都不做
    c.login("a@b.c", "pw").await.unwrap();
    c.keep_alive(3600).await.unwrap(); // 刚登录：不刷新
    assert!(saved.lock().unwrap().is_empty());
    c.keep_alive(0).await.unwrap();
    assert_eq!(*saved.lock().unwrap(), ["ref2"]);
}

#[tokio::test]
async fn existing_keys_lists_once_for_all_groups_and_never_creates() {
    let s = MockServer::start().await;
    Mock::given(method("POST")).and(path("/api/v1/auth/login")).respond_with(ResponseTemplate::new(200).set_body_json(login_ok())).mount(&s).await;
    Mock::given(method("GET")).and(path("/api/v1/keys")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"code": 0, "data": {"items": [
        {"id": 1, "name": "Ferrydeck-A", "key": "sk-a", "group_id": 2, "status": "active"},
        {"id": 2, "name": "desktop-B", "key": "sk-b-legacy", "group_id": 3, "status": "active"},
        {"id": 3, "name": "Ferrydeck-C", "key": "sk-c-disabled", "group_id": 4, "status": "inactive"},
    ]}}))).expect(1).mount(&s).await; // 三个分组，只列一次
    Mock::given(method("POST")).and(path("/api/v1/keys")).respond_with(ResponseTemplate::new(500)).expect(0).mount(&s).await; // 绝不新建
    let (c, _) = client(&s);
    c.login("a@b.c", "pw").await.unwrap();
    let groups = [group("2", "A"), group("3", "B"), group("4", "C"), group("5", "D")];
    let found = c.existing_keys(&groups).await.unwrap();
    assert_eq!(found, vec![(0, "sk-a".to_string()), (1, "sk-b-legacy".to_string())], "旧版 desktop- 命名的 Key 也要认；停用的和没建过的不返回");
}

// ---------- 模型广场：刷新时就带上各分组的模型 ----------

fn plaza_body() -> Value {
    json!({"code": 0, "data": {"description": "", "groups": [
        {"id": 2, "name": "A", "models": [{"name": "claude-sonnet-5-5", "platform": "anthropic"}, {"name": "claude-opus-5-5"}]},
        {"id": 9, "name": "Not mine", "models": [{"name": "grok-4.5"}]},
    ]}})
}

async fn mount_groups(s: &MockServer) {
    Mock::given(method("POST")).and(path("/api/v1/auth/login")).respond_with(ResponseTemplate::new(200).set_body_json(login_ok())).mount(s).await;
    Mock::given(method("GET")).and(path("/api/v1/groups/available")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"code": 0, "data": [
        {"id": 2, "name": "A", "platform": "anthropic", "rate_multiplier": 1.0, "status": "active"},
        {"id": 3, "name": "B", "platform": "openai", "rate_multiplier": 1.0, "status": "active"},
    ]}))).mount(s).await;
}

#[tokio::test]
async fn groups_come_with_their_models_from_the_model_plaza_using_the_logged_in_identity() {
    let s = MockServer::start().await;
    mount_groups(&s).await;
    // 必须带登录令牌：专属分组只有登录后才在广场里
    Mock::given(method("GET")).and(path("/api/v1/model-plaza")).and(header("authorization", "Bearer acc1")).respond_with(ResponseTemplate::new(200).set_body_json(plaza_body())).expect(1).mount(&s).await;
    let (c, _) = client(&s);
    c.login("a@b.c", "pw").await.unwrap();
    let g = c.groups().await.unwrap();
    assert_eq!(g.len(), 2);
    assert_eq!(g[0].models, ["claude-sonnet-5-5", "claude-opus-5-5"], "分组 A 的模型来自广场");
    assert!(g[1].models.is_empty(), "广场里没有分组 B：留空，之后靠 Key 查询");
}

#[tokio::test]
async fn a_site_without_a_model_plaza_still_lists_its_groups() {
    let s = MockServer::start().await;
    mount_groups(&s).await;
    Mock::given(method("GET")).and(path("/api/v1/model-plaza")).respond_with(ResponseTemplate::new(404).set_body_json(json!({"code": 404, "message": "Model plaza is not enabled"}))).mount(&s).await;
    let (c, _) = client(&s);
    c.login("a@b.c", "pw").await.unwrap();
    let g = c.groups().await.unwrap();
    assert_eq!(g.iter().map(|x| x.name.as_str()).collect::<Vec<_>>(), ["A", "B"], "广场没开不影响分组");
    assert!(g.iter().all(|x| x.models.is_empty()));
}

#[tokio::test]
async fn a_broken_model_plaza_does_not_break_the_group_list() {
    let s = MockServer::start().await;
    mount_groups(&s).await;
    Mock::given(method("GET")).and(path("/api/v1/model-plaza")).respond_with(ResponseTemplate::new(200).set_body_string("<html>oops</html>")).mount(&s).await;
    let (c, _) = client(&s);
    c.login("a@b.c", "pw").await.unwrap();
    assert_eq!(c.groups().await.unwrap().len(), 2);
}

async fn mount_usage(s: &MockServer) {
    Mock::given(method("POST")).and(path("/api/v1/auth/login")).respond_with(ResponseTemplate::new(200).set_body_json(login_ok())).mount(s).await;
    Mock::given(method("GET")).and(path("/api/v1/usage/stats")).and(query_param("group_id", "2")).and(query_param("period", "week")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"code": 0, "data": {
        "total_requests": 10, "total_input_tokens": 600000, "total_output_tokens": 400000,
        "total_cache_creation_tokens": 100000, "total_cache_read_tokens": 300000,
        "total_cost": 4.0, "total_actual_cost": 2.0, "average_duration_ms": 1500.0}}))).expect(1).mount(s).await;
}

#[tokio::test]
async fn group_usage_derives_cost_cache_and_latency_from_the_usage_endpoints() {
    let s = MockServer::start().await;
    mount_usage(&s).await;
    Mock::given(method("GET")).and(path("/api/v1/usage/dashboard/models")).and(query_param("group_id", "2")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"code": 0, "data": {"models": [
        {"model": "small", "requests": 1, "input_tokens": 100, "output_tokens": 100, "actual_cost": 0.1},
        {"model": "big", "requests": 9, "input_tokens": 500000, "output_tokens": 300000, "cache_read_tokens": 5, "actual_cost": 1.9},
    ]}}))).mount(&s).await;
    Mock::given(method("GET")).and(path("/api/v1/usage")).and(query_param("group_id", "2")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"code": 0, "data": {"items": [
        {"first_token_ms": 900}, {"first_token_ms": 100}, {"first_token_ms": null}, {"first_token_ms": 500}, {"first_token_ms": 300}, {"first_token_ms": 700}]}}))).mount(&s).await;
    Mock::given(method("GET")).and(path("/api/v1/model-plaza")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"code": 0, "data": {"groups": [
        {"id": 2, "name": "A", "rate_multiplier": 0.5, "user_rate_multiplier": 0.4, "models": [
            {"name": "claude-sonnet-5-5", "pricing": {"billing_mode": "token", "input_price": 0.000003, "output_price": 0.000015, "cache_read_price": 0.0000003}},
            {"name": "image-gen", "pricing": {"billing_mode": "image"}}]}]}}))).mount(&s).await;
    let (c, _) = client(&s);
    c.login("a@b.c", "pw").await.unwrap();
    let mut g = group("2", "A");
    g.rate_multiplier = 0.5;
    let u = c.group_usage(&g).await.unwrap();
    assert_eq!((u.requests, u.effective_tokens, u.cost, u.official_cost), (10, 1_000_000, 2.0, Some(4.0)));
    assert_eq!((u.cost_per_m_effective, u.cache_hit_rate, u.actual_multiplier), (Some(2.0), Some(0.3), Some(0.5)));
    assert_eq!((u.first_token_median_ms, u.first_token_p90_ms, u.first_token_samples), (Some(500), Some(900), 5));
    assert_eq!(u.models[0].model, "big", "花得多的在前");
    assert_eq!(u.estimates.len(), 1, "只收按 token 计费的对话模型");
    let e = &u.estimates[0];
    assert!((e.input_per_m - 1.2).abs() < 1e-9 && (e.output_per_m - 6.0).abs() < 1e-9, "用专属倍率 0.4: {e:?}");
    assert!(u.notes.is_empty(), "{:?}", u.notes);
}

#[tokio::test]
async fn group_usage_survives_the_optional_endpoints_failing_but_not_the_summary() {
    let s = MockServer::start().await;
    mount_usage(&s).await;
    Mock::given(method("GET")).and(path("/api/v1/usage/dashboard/models")).respond_with(ResponseTemplate::new(500)).mount(&s).await;
    Mock::given(method("GET")).and(path("/api/v1/usage")).respond_with(ResponseTemplate::new(500)).mount(&s).await;
    Mock::given(method("GET")).and(path("/api/v1/model-plaza")).respond_with(ResponseTemplate::new(404)).mount(&s).await;
    let (c, _) = client(&s);
    c.login("a@b.c", "pw").await.unwrap();
    let u = c.group_usage(&group("2", "A")).await.unwrap();
    assert_eq!(u.cost_per_m_effective, Some(2.0));
    assert!(u.models.is_empty() && u.estimates.is_empty() && u.first_token_median_ms.is_none());
    assert_eq!(u.notes.len(), 2, "两处缺失要告诉用户: {:?}", u.notes);

    let s2 = MockServer::start().await;
    Mock::given(method("POST")).and(path("/api/v1/auth/login")).respond_with(ResponseTemplate::new(200).set_body_json(login_ok())).mount(&s2).await;
    Mock::given(method("GET")).and(path("/api/v1/usage/stats")).respond_with(ResponseTemplate::new(500)).mount(&s2).await;
    let (c2, _) = client(&s2);
    c2.login("a@b.c", "pw").await.unwrap();
    assert!(c2.group_usage(&group("2", "A")).await.is_err());
}
