//! 站长：新建下游分组、给下游分组添加上游（在上游站点建 Key → 试一次 → 在自己的站点建上游账号 → 记下关联），以及失败时的回滚。
use app_lib::admin::{load_links, NewGroup};
use app_lib::paths::Paths;
use app_lib::sites::{Kind, Site};
use app_lib::state::AppState;
use app_lib::AddUpstreamOpts;
use serde_json::{json, Value};
use wiremock::matchers::{body_json, body_partial_json, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn login() -> ResponseTemplate {
    ResponseTemplate::new(200).set_body_json(json!({"code": 0, "data": {"access_token": "t", "refresh_token": "r", "user": {"email": "a@b.c", "balance": 1}}}))
}
fn ok(v: Value) -> ResponseTemplate {
    ResponseTemplate::new(200).set_body_json(json!({"code": 0, "data": v}))
}
fn sse() -> ResponseTemplate {
    ResponseTemplate::new(200).insert_header("content-type", "text/event-stream").set_body_string("data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"Hi\"}}\n\n")
}

/// 站长站点：已有一个下游分组 1（anthropic），没有上游账号。
async fn boss(existing_accounts: Value, platform: &str) -> MockServer {
    let s = MockServer::start().await;
    Mock::given(method("POST")).and(path("/api/v1/auth/login")).respond_with(login()).mount(&s).await;
    Mock::given(method("GET")).and(path("/api/v1/admin/groups/all")).respond_with(ok(json!([{"id": 1, "name": "下游", "platform": platform, "rate_multiplier": 1.0, "status": "active"}]))).mount(&s).await;
    Mock::given(method("GET")).and(path("/api/v1/admin/accounts")).respond_with(ok(json!({"total": 0, "items": existing_accounts}))).mount(&s).await;
    s
}

/// 上游站点：分组 7（Kiro，倍率 0.09，anthropic），名下还没有 Key；`probe_ok` 决定用 Key 试一次能不能通。
async fn upstream(probe_ok: bool) -> MockServer {
    let s = MockServer::start().await;
    Mock::given(method("POST")).and(path("/api/v1/auth/login")).respond_with(login()).mount(&s).await;
    Mock::given(method("GET")).and(path("/api/v1/groups/available")).respond_with(ok(json!([{"id": 7, "name": "Kiro", "platform": "anthropic", "rate_multiplier": 0.09, "status": "active"}]))).mount(&s).await;
    // 第一次列 Key 是空的 → 新建；之后列出来就有了（回滚时按名字找到它删掉）
    Mock::given(method("GET")).and(path("/api/v1/keys")).respond_with(ok(json!({"items": []}))).up_to_n_times(1).mount(&s).await;
    Mock::given(method("GET")).and(path("/api/v1/keys")).respond_with(ok(json!({"items": [{"id": 9, "name": "Ferrydeck-Kiro", "key": "sk-UPSTREAM", "group_id": 7, "status": "active"}]}))).mount(&s).await;
    Mock::given(method("POST")).and(path("/api/v1/keys")).respond_with(ok(json!({"id": 9, "name": "Ferrydeck-Kiro", "key": "sk-UPSTREAM", "group_id": 7, "status": "active"}))).mount(&s).await;
    Mock::given(method("GET")).and(path("/v1/models")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"data": [{"id": "claude-sonnet-5-5"}, {"id": "claude-haiku-5-5"}, {"id": "gpt-image-2"}]}))).mount(&s).await;
    if probe_ok {
        Mock::given(method("POST")).and(path("/v1/messages")).respond_with(sse()).mount(&s).await;
    } else {
        Mock::given(method("POST")).and(path("/v1/messages")).respond_with(ResponseTemplate::new(403).set_body_json(json!({"error": {"message": "Insufficient account balance"}}))).mount(&s).await;
    }
    s
}

struct Rig {
    boss_rt: std::sync::Arc<app_lib::state::SiteRuntime>,
    up_rt: std::sync::Arc<app_lib::state::SiteRuntime>,
    dir: tempfile::TempDir,
}

async fn rig(b: &MockServer, u: &MockServer) -> Rig {
    let dir = tempfile::tempdir().unwrap();
    let p = Paths::under(dir.path());
    let boss_rt = AppState::make_runtime(&p, Site { id: "boss".into(), kind: Kind::Sub2api, name: "Boss".into(), base_url: b.uri(), is_admin: true });
    let up_rt = AppState::make_runtime(&p, Site { id: "up".into(), kind: Kind::Sub2api, name: "上游一号".into(), base_url: u.uri(), is_admin: false });
    boss_rt.client.login("boss", "pw").await.unwrap();
    up_rt.client.login("me", "pw").await.unwrap();
    Rig { boss_rt, up_rt, dir }
}

fn opts(paused: bool) -> AddUpstreamOpts {
    AddUpstreamOpts { name: None, paused, allow_duplicate: false, test_model: None }
}

#[tokio::test]
async fn adding_an_upstream_creates_the_key_probes_it_creates_the_account_pauses_it_and_remembers_the_link() {
    let u = upstream(true).await;
    let b = boss(json!([]), "anthropic").await;
    // 创建上游账号：地址、Key、模型映射、下游分组、账号倍率（= 上游分组倍率）都要对
    Mock::given(method("POST")).and(path("/api/v1/admin/accounts")).and(body_partial_json(json!({
        "name": "上游一号-Kiro", "platform": "anthropic", "type": "apikey", "group_ids": [1], "rate_multiplier": 0.09,
        "credentials": {"base_url": u.uri(), "api_key": "sk-UPSTREAM", "model_mapping": {"claude-sonnet-5-5": "claude-sonnet-5-5", "claude-haiku-5-5": "claude-haiku-5-5"}}
    }))).respond_with(ok(json!({"id": 50}))).expect(1).mount(&b).await;
    // 默认先暂停
    Mock::given(method("POST")).and(path("/api/v1/admin/accounts/50/schedulable")).and(body_json(json!({"schedulable": false}))).respond_with(ok(json!({}))).expect(1).mount(&b).await;
    Mock::given(method("DELETE")).and(path("/api/v1/keys/9")).respond_with(ok(json!({}))).expect(0).mount(&u).await;
    let r = rig(&b, &u).await;
    let added = app_lib::add_upstream(&r.boss_rt, &r.up_rt, "1", "7", &opts(true), r.dir.path()).await.unwrap();
    assert_eq!((added.upstream_id.as_str(), added.name.as_str(), added.key_created, added.models, added.paused), ("50", "上游一号-Kiro", true, 2, true), "图片模型不算");
    assert!(!format!("{added:?}").contains("sk-"), "返回给界面的数据里没有 Key");
    // 关联已经记下：之后读上游分组当前的倍率
    let links = load_links(r.dir.path());
    assert_eq!(links["boss"]["50"], ("up".to_string(), "7".to_string()));
}

#[tokio::test]
async fn when_the_probe_fails_the_new_key_is_removed_and_no_account_is_created() {
    let u = upstream(false).await;
    let b = boss(json!([]), "anthropic").await;
    Mock::given(method("POST")).and(path("/api/v1/admin/accounts")).respond_with(ok(json!({"id": 50}))).expect(0).mount(&b).await;
    Mock::given(method("DELETE")).and(path("/api/v1/keys/9")).respond_with(ok(json!({}))).expect(1).mount(&u).await;
    let r = rig(&b, &u).await;
    let e = app_lib::add_upstream(&r.boss_rt, &r.up_rt, "1", "7", &opts(true), r.dir.path()).await.unwrap_err();
    assert!(e.contains("没通") && e.contains("Insufficient account balance"), "把上游的原话告诉站长: {e}");
    assert!(load_links(r.dir.path()).is_empty(), "没成功就不记关联");
}

#[tokio::test]
async fn when_creating_the_account_fails_the_new_key_is_removed() {
    let u = upstream(true).await;
    let b = boss(json!([]), "anthropic").await;
    Mock::given(method("POST")).and(path("/api/v1/admin/accounts")).respond_with(ResponseTemplate::new(400).set_body_json(json!({"code": 400, "message": "bad request"}))).mount(&b).await;
    Mock::given(method("DELETE")).and(path("/api/v1/keys/9")).respond_with(ok(json!({}))).expect(1).mount(&u).await;
    let r = rig(&b, &u).await;
    let e = app_lib::add_upstream(&r.boss_rt, &r.up_rt, "1", "7", &opts(true), r.dir.path()).await.unwrap_err();
    assert!(e.contains("创建上游账号失败") && e.contains("bad request"), "{e}");
}

#[tokio::test]
async fn if_pausing_fails_the_account_is_removed_too() {
    let u = upstream(true).await;
    let b = boss(json!([]), "anthropic").await;
    Mock::given(method("POST")).and(path("/api/v1/admin/accounts")).respond_with(ok(json!({"id": 50}))).mount(&b).await;
    Mock::given(method("POST")).and(path("/api/v1/admin/accounts/50/schedulable")).respond_with(ResponseTemplate::new(500)).mount(&b).await;
    Mock::given(method("DELETE")).and(path("/api/v1/admin/accounts/50")).respond_with(ok(json!({}))).expect(1).mount(&b).await;
    Mock::given(method("DELETE")).and(path("/api/v1/keys/9")).respond_with(ok(json!({}))).expect(1).mount(&u).await;
    let r = rig(&b, &u).await;
    let e = app_lib::add_upstream(&r.boss_rt, &r.up_rt, "1", "7", &opts(true), r.dir.path()).await.unwrap_err();
    assert!(e.contains("已撤销"), "{e}");
}

#[tokio::test]
async fn mismatched_platform_duplicate_name_and_repeat_adds_are_refused_before_touching_anything() {
    let u = upstream(true).await;
    // 下游是 openai 类、上游分组是 anthropic 类
    let b = boss(json!([]), "openai").await;
    let r = rig(&b, &u).await;
    let e = app_lib::add_upstream(&r.boss_rt, &r.up_rt, "1", "7", &opts(true), r.dir.path()).await.unwrap_err();
    assert!(e.contains("混在一起"), "{e}");
    // 同名上游账号已存在
    let b2 = boss(json!([{"id": 3, "name": "上游一号-Kiro", "platform": "anthropic", "credentials": {}}]), "anthropic").await;
    let r2 = rig(&b2, &u).await;
    let e = app_lib::add_upstream(&r2.boss_rt, &r2.up_rt, "1", "7", &opts(true), r2.dir.path()).await.unwrap_err();
    assert!(e.contains("同名") || e.contains("已经有一个叫"), "{e}");
    // 已经添加过这个上游分组（关联记录里有，账号还在）
    let b3 = boss(json!([{"id": 3, "name": "别名", "platform": "anthropic", "credentials": {}}]), "anthropic").await;
    let r3 = rig(&b3, &u).await;
    let mut saved = app_lib::admin::SavedLinks::default();
    saved.entry("boss".into()).or_default().insert("3".into(), ("up".into(), "7".into()));
    app_lib::admin::save_links(r3.dir.path(), &saved).unwrap();
    let e = app_lib::add_upstream(&r3.boss_rt, &r3.up_rt, "1", "7", &opts(true), r3.dir.path()).await.unwrap_err();
    assert!(e.contains("已经添加过") && e.contains("别名"), "{e}");
}

#[tokio::test]
async fn creating_a_downstream_group_checks_the_input_and_refuses_duplicates() {
    let b = MockServer::start().await;
    Mock::given(method("POST")).and(path("/api/v1/auth/login")).respond_with(login()).mount(&b).await;
    Mock::given(method("GET")).and(path("/api/v1/admin/groups/all")).respond_with(ok(json!([{"id": 1, "name": "已有", "platform": "anthropic"}]))).mount(&b).await;
    Mock::given(method("POST")).and(path("/api/v1/admin/groups")).and(body_json(json!({"name": "新分组", "description": "备注", "platform": "openai", "rate_multiplier": 0.5}))).respond_with(ok(json!({"id": 8}))).expect(1).mount(&b).await;
    let dir = tempfile::tempdir().unwrap();
    let rt = AppState::make_runtime(&Paths::under(dir.path()), Site { id: "boss".into(), kind: Kind::Sub2api, name: "Boss".into(), base_url: b.uri(), is_admin: true });
    rt.client.login("boss", "pw").await.unwrap();
    let g = |name: &str, platform: Option<&str>, rate: f64| NewGroup { name: name.into(), description: Some("备注".into()), platform: platform.map(String::from), rate_multiplier: rate };
    assert_eq!(rt.client.admin_create_group(&g(" 新分组 ", Some("openai"), 0.5)).await.unwrap(), "8");
    assert!(rt.client.admin_create_group(&g("已有", Some("openai"), 1.0)).await.unwrap_err().contains("已经有一个叫"));
    assert!(rt.client.admin_create_group(&g("x", None, 1.0)).await.unwrap_err().contains("分类"), "sub2api 必须选分类");
    assert!(rt.client.admin_create_group(&g("x", Some("openai"), 0.0)).await.is_err());
}

#[tokio::test]
async fn newapi_creates_groups_in_the_options_and_channels_with_the_right_type() {
    let s = MockServer::start().await;
    Mock::given(method("GET")).and(path("/api/status")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"success": true, "data": {"quota_per_unit": 500000, "quota_display_type": "USD"}}))).mount(&s).await;
    Mock::given(method("POST")).and(path("/api/user/login")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"success": true, "data": {"access_token": "t", "access_expires_at": 4_000_000_000i64, "user": {"id": 1, "username": "root", "quota": 1}}})).insert_header("set-cookie", "new_api_refresh=c; Path=/; HttpOnly")).mount(&s).await;
    Mock::given(method("GET")).and(path("/api/option/")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"success": true, "data": [{"key": "GroupRatio", "value": "{\"default\":1}"}, {"key": "UserUsableGroups", "value": "{}"}]}))).mount(&s).await;
    Mock::given(method("PUT")).and(path("/api/option/")).and(body_json(json!({"key": "GroupRatio", "value": "{\"default\":1,\"新分组\":0.5}"}))).respond_with(ResponseTemplate::new(200).set_body_json(json!({"success": true}))).expect(1).mount(&s).await;
    Mock::given(method("PUT")).and(path("/api/option/")).and(body_json(json!({"key": "UserUsableGroups", "value": "{\"新分组\":\"备注\"}"}))).respond_with(ResponseTemplate::new(200).set_body_json(json!({"success": true}))).expect(1).mount(&s).await;
    Mock::given(method("POST")).and(path("/api/channel/")).and(body_partial_json(json!({"mode": "single", "channel": {"name": "渠道X", "type": 14, "key": "sk-K", "base_url": "https://up.example.com", "models": "m1,m2", "group": "新分组"}}))).respond_with(ResponseTemplate::new(200).set_body_json(json!({"success": true}))).expect(1).mount(&s).await;
    Mock::given(method("GET")).and(path("/api/channel/")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"success": true, "data": {"total": 2, "items": [{"id": 4, "name": "渠道X"}, {"id": 9, "name": "渠道X"}, {"id": 5, "name": "别的"}]}}))).mount(&s).await;
    let dir = tempfile::tempdir().unwrap();
    let rt = AppState::make_runtime(&Paths::under(dir.path()), Site { id: "n".into(), kind: Kind::Newapi, name: "N".into(), base_url: s.uri(), is_admin: true });
    rt.client.login("root", "pw").await.unwrap();
    let g = NewGroup { name: "新分组".into(), description: Some("备注".into()), platform: Some("anthropic".into()), rate_multiplier: 0.5 };
    assert_eq!(rt.client.admin_create_group(&g).await.unwrap(), "新分组");
    let up = app_lib::admin::NewUpstream { name: "渠道X".into(), platform: "anthropic".into(), base_url: "https://up.example.com/".into(), api_key: "sk-K".into(), models: vec!["m1".into(), "m2".into()], group_ids: vec!["新分组".into()], rate_multiplier: None };
    assert_eq!(rt.client.admin_create_upstream(&up).await.unwrap(), "9", "同名的取最新（id 最大）的");
}

#[tokio::test]
async fn adding_the_same_upstream_group_twice_needs_explicit_permission() {
    let u = upstream(true).await;
    let b = boss(json!([{"id": 3, "name": "已有账号", "platform": "anthropic", "credentials": {}}]), "anthropic").await;
    Mock::given(method("POST")).and(path("/api/v1/admin/accounts")).respond_with(ok(json!({"id": 51}))).expect(1).mount(&b).await;
    Mock::given(method("POST")).and(path("/api/v1/admin/accounts/51/schedulable")).respond_with(ok(json!({}))).mount(&b).await;
    let r = rig(&b, &u).await;
    let mut saved = app_lib::admin::SavedLinks::default();
    saved.entry("boss".into()).or_default().insert("3".into(), ("up".into(), "7".into()));
    app_lib::admin::save_links(r.dir.path(), &saved).unwrap();
    let e = app_lib::add_upstream(&r.boss_rt, &r.up_rt, "1", "7", &opts(true), r.dir.path()).await.unwrap_err();
    assert!(e.contains("已经添加过") && e.contains("共用同一把上游 Key"), "{e}");
    // 明确允许后可以再添加一次（共用同一把上游 Key）
    let added = app_lib::add_upstream(&r.boss_rt, &r.up_rt, "1", "7", &AddUpstreamOpts { name: Some("第二个".into()), paused: true, allow_duplicate: true, test_model: None }, r.dir.path()).await.unwrap();
    assert_eq!(added.upstream_id, "51");
    assert_eq!(load_links(r.dir.path())["boss"]["51"], ("up".to_string(), "7".to_string()));
}

#[tokio::test]
async fn replacing_the_source_of_a_sub2api_upstream_updates_the_account_in_place_and_keeps_its_groups() {
    let u = upstream(true).await;
    let b = boss(json!([{"id": 3, "name": "旧账号", "platform": "anthropic", "status": "active", "group_ids": [1], "credentials": {"base_url": "https://old.example.com"}}]), "anthropic").await;
    Mock::given(method("PUT")).and(path("/api/v1/admin/accounts/3")).and(body_partial_json(json!({"rate_multiplier": 0.09, "credentials": {"base_url": u.uri(), "api_key": "sk-UPSTREAM", "model_mapping": {"claude-sonnet-5-5": "claude-sonnet-5-5"}}}))).respond_with(ok(json!({}))).expect(1).mount(&b).await;
    Mock::given(method("POST")).and(path("/api/v1/admin/accounts")).respond_with(ok(json!({"id": 99}))).expect(0).mount(&b).await;
    let r = rig(&b, &u).await;
    let mut saved = app_lib::admin::SavedLinks::default();
    saved.entry("boss".into()).or_default().insert("3".into(), ("old".into(), "1".into()));
    app_lib::admin::save_links(r.dir.path(), &saved).unwrap();
    let a = app_lib::replace_upstream(&r.boss_rt, &r.up_rt, "3", "7", None, None, r.dir.path()).await.unwrap();
    assert_eq!((a.upstream_id.as_str(), a.name.as_str(), a.paused), ("3", "旧账号", false), "账号 id、名称、状态都不变");
    assert_eq!(load_links(r.dir.path())["boss"]["3"], ("up".to_string(), "7".to_string()), "关联改成新的来源");
}

#[tokio::test]
async fn replacing_fails_cleanly_when_the_new_source_does_not_work_and_the_old_one_stays() {
    let u = upstream(false).await;
    let b = boss(json!([{"id": 3, "name": "旧账号", "platform": "anthropic", "status": "active", "group_ids": [1], "credentials": {}}]), "anthropic").await;
    Mock::given(method("PUT")).and(path("/api/v1/admin/accounts/3")).respond_with(ok(json!({}))).expect(0).mount(&b).await;
    Mock::given(method("DELETE")).and(path("/api/v1/keys/9")).respond_with(ok(json!({}))).expect(1).mount(&u).await;
    let r = rig(&b, &u).await;
    let e = app_lib::replace_upstream(&r.boss_rt, &r.up_rt, "3", "7", None, None, r.dir.path()).await.unwrap_err();
    assert!(e.contains("没通"), "{e}");
}

#[tokio::test]
async fn removing_a_downstream_group_hits_the_right_endpoints_on_both_kinds_of_site() {
    let b = MockServer::start().await;
    Mock::given(method("POST")).and(path("/api/v1/auth/login")).respond_with(login()).mount(&b).await;
    Mock::given(method("DELETE")).and(path("/api/v1/admin/groups/26")).respond_with(ok(json!({}))).expect(1).mount(&b).await;
    let dir = tempfile::tempdir().unwrap();
    let rt = AppState::make_runtime(&Paths::under(dir.path()), Site { id: "boss".into(), kind: Kind::Sub2api, name: "Boss".into(), base_url: b.uri(), is_admin: true });
    rt.client.login("boss", "pw").await.unwrap();
    rt.client.admin_remove_group("26").await.unwrap();
    assert!(rt.client.admin_remove_group("x; y").await.is_err());

    let s = MockServer::start().await;
    Mock::given(method("GET")).and(path("/api/status")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"success": true, "data": {"quota_per_unit": 500000, "quota_display_type": "USD"}}))).mount(&s).await;
    Mock::given(method("POST")).and(path("/api/user/login")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"success": true, "data": {"access_token": "t", "access_expires_at": 4_000_000_000i64, "user": {"id": 1, "username": "root", "quota": 1}}})).insert_header("set-cookie", "new_api_refresh=c; Path=/; HttpOnly")).mount(&s).await;
    Mock::given(method("GET")).and(path("/api/option/")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"success": true, "data": [{"key": "GroupRatio", "value": "{\"default\":1,\"测试\":10}"}, {"key": "UserUsableGroups", "value": "{\"测试\":\"备注\"}"}]}))).mount(&s).await;
    Mock::given(method("PUT")).and(path("/api/option/")).and(body_json(json!({"key": "GroupRatio", "value": "{\"default\":1}"}))).respond_with(ResponseTemplate::new(200).set_body_json(json!({"success": true}))).expect(1).mount(&s).await;
    Mock::given(method("PUT")).and(path("/api/option/")).and(body_json(json!({"key": "UserUsableGroups", "value": "{}"}))).respond_with(ResponseTemplate::new(200).set_body_json(json!({"success": true}))).expect(1).mount(&s).await;
    let n = AppState::make_runtime(&Paths::under(dir.path()), Site { id: "n".into(), kind: Kind::Newapi, name: "N".into(), base_url: s.uri(), is_admin: true });
    n.client.login("root", "pw").await.unwrap();
    n.client.admin_remove_group("测试").await.unwrap();
    assert!(n.client.admin_remove_group("不存在").await.unwrap_err().contains("没有分组"));
}

#[tokio::test]
async fn the_chosen_test_model_is_the_one_used_for_the_hi_and_an_unknown_one_is_refused_and_rolled_back() {
    let u = upstream(true).await;
    let b = boss(json!([]), "anthropic").await;
    Mock::given(method("POST")).and(path("/api/v1/admin/accounts")).respond_with(ok(json!({"id": 60}))).mount(&b).await;
    Mock::given(method("POST")).and(path("/api/v1/admin/accounts/60/schedulable")).respond_with(ok(json!({}))).mount(&b).await;
    let r = rig(&b, &u).await;
    // 指定了模型：用它发 hi（默认会挑便宜的 haiku）
    app_lib::add_upstream(&r.boss_rt, &r.up_rt, "1", "7", &AddUpstreamOpts { name: None, paused: true, allow_duplicate: false, test_model: Some("claude-sonnet-5-5".into()) }, r.dir.path()).await.unwrap();
    let reqs = u.received_requests().await.unwrap();
    let hi = reqs.iter().find(|q| q.url.path() == "/v1/messages").expect("发过 hi");
    let body: serde_json::Value = serde_json::from_slice(&hi.body).unwrap();
    assert_eq!(body["model"], "claude-sonnet-5-5");

    // 指定的模型这个上游分组里没有：拒绝，并撤销刚建的 Key，不动站长的站点
    let u2 = upstream(true).await;
    let b2 = boss(json!([]), "anthropic").await;
    Mock::given(method("POST")).and(path("/api/v1/admin/accounts")).respond_with(ok(json!({"id": 61}))).expect(0).mount(&b2).await;
    Mock::given(method("DELETE")).and(path("/api/v1/keys/9")).respond_with(ok(json!({}))).expect(1).mount(&u2).await;
    let r2 = rig(&b2, &u2).await;
    let e = app_lib::add_upstream(&r2.boss_rt, &r2.up_rt, "1", "7", &AddUpstreamOpts { name: None, paused: true, allow_duplicate: false, test_model: Some("no-such-model".into()) }, r2.dir.path()).await.unwrap_err();
    assert!(e.contains("没有模型「no-such-model」"), "{e}");
}
