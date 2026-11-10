//! 站长视角（上下游一体管理）：用模拟站点验证两种站点的读取、暂停、移除、改分组。
use std::sync::Arc;

use app_lib::admin::GroupEdit;
use app_lib::sites::{Kind, SiteClient};
use serde_json::{json, Value};
use wiremock::matchers::{body_json, method, path, query_param};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn now_secs() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64
}

fn rfc(secs: i64) -> String {
    format!("{}T{:02}:{:02}:{:02}Z", app_lib::admin::ymd(secs), secs.rem_euclid(86_400) / 3600, secs.rem_euclid(3600) / 60, secs.rem_euclid(60))
}

fn client(kind: Kind, s: &MockServer) -> SiteClient {
    SiteClient::new(kind, &s.uri(), Arc::new(|_| {}))
}

async fn sub_login(s: &MockServer) {
    Mock::given(method("POST")).and(path("/api/v1/auth/login")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"code": 0, "data": {"access_token": "adm", "refresh_token": "r", "user": {"email": "boss@x.com", "balance": 1}}}))).mount(s).await;
}

async fn new_login(s: &MockServer) {
    Mock::given(method("GET")).and(path("/api/status")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"success": true, "data": {"quota_per_unit": 500000, "quota_display_type": "USD"}}))).mount(s).await;
    Mock::given(method("POST")).and(path("/api/user/login")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"success": true, "data": {"access_token": "adm", "access_expires_at": 4_000_000_000i64, "user": {"id": 1, "username": "root", "quota": 1}}})).insert_header("set-cookie", "new_api_refresh=c; Path=/; HttpOnly")).mount(s).await;
}

#[tokio::test]
async fn sub2api_overview_lists_upstreams_with_their_groups_and_never_leaks_credentials() {
    let s = MockServer::start().await;
    sub_login(&s).await;
    Mock::given(method("GET")).and(path("/api/v1/admin/groups/all")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"code": 0, "data": [
        {"id": 1, "name": "官转", "description": "高速", "platform": "anthropic", "rate_multiplier": 1.2, "status": "active"},
        {"id": 2, "name": "特价", "platform": "anthropic", "rate_multiplier": 0.5, "status": "active"}]}))).mount(&s).await;
    Mock::given(method("GET")).and(path("/api/v1/admin/accounts")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"code": 0, "data": {"total": 3, "items": [
        {"id": 10, "name": "up-a", "platform": "anthropic", "type": "apikey", "status": "active", "schedulable": true, "group_ids": [1, 2], "priority": 50,
         "credentials": {"base_url": "https://up.example.com/v1?key=sk-SECRET", "api_key": "sk-SECRET", "model_mapping": {"a": "a", "b": "b"}}},
        {"id": 11, "name": "up-b", "platform": "anthropic", "type": "oauth", "status": "active", "schedulable": false, "groups": [{"id": 2}], "credentials": {"access_token": "TOKEN-SECRET"}},
        {"id": 12, "name": "up-c", "platform": "anthropic", "type": "apikey", "status": "error", "error_message": "401 invalid key", "group_ids": []}]}}))).mount(&s).await;
    let c = client(Kind::Sub2api, &s);
    c.login("boss@x.com", "pw").await.unwrap();
    c.admin_probe().await.unwrap();
    let o = c.admin_overview().await.unwrap();
    assert_eq!(o.downstreams.len(), 2);
    assert_eq!((o.downstreams[0].name.as_str(), o.downstreams[0].rate_multiplier, o.downstreams[0].editable), ("官转", 1.2, true));
    let st: Vec<_> = o.upstreams.iter().map(|u| (u.id.as_str(), u.status.as_str(), u.groups.clone())).collect();
    assert_eq!(st, [("10", "active", vec!["1".to_string(), "2".into()]), ("11", "paused", vec!["2".to_string()]), ("12", "error", vec![])]);
    assert_eq!(o.upstreams[0].host.as_deref(), Some("up.example.com"));
    assert_eq!(o.upstreams[0].models, 2);
    assert_eq!(o.upstreams[2].error.as_deref(), Some("401 invalid key"));
    let dump = format!("{o:?}");
    assert!(!dump.contains("SECRET"), "凭据不能出现在返回的数据里: {dump}");
}

#[tokio::test]
async fn sub2api_pause_remove_and_edit_hit_the_right_endpoints() {
    let s = MockServer::start().await;
    sub_login(&s).await;
    let ok = || ResponseTemplate::new(200).set_body_json(json!({"code": 0, "data": {}}));
    Mock::given(method("POST")).and(path("/api/v1/admin/accounts/10/schedulable")).and(body_json(json!({"schedulable": false}))).respond_with(ok()).expect(1).mount(&s).await;
    Mock::given(method("POST")).and(path("/api/v1/admin/accounts/10/schedulable")).and(body_json(json!({"schedulable": true}))).respond_with(ok()).expect(1).mount(&s).await;
    Mock::given(method("DELETE")).and(path("/api/v1/admin/accounts/11")).respond_with(ok()).expect(1).mount(&s).await;
    Mock::given(method("PUT")).and(path("/api/v1/admin/groups/1")).and(body_json(json!({"name": "新名字", "description": "备注", "rate_multiplier": 0.8}))).respond_with(ok()).expect(1).mount(&s).await;
    let c = client(Kind::Sub2api, &s);
    c.login("boss@x.com", "pw").await.unwrap();
    c.admin_set_paused("10", true).await.unwrap();
    c.admin_set_paused("10", false).await.unwrap();
    c.admin_remove_upstream("11").await.unwrap();
    c.admin_update_group("1", &GroupEdit { name: Some(" 新名字 ".into()), description: Some("备注".into()), rate_multiplier: Some(0.8), platform: None }).await.unwrap();
    // 本地校验挡在发请求之前
    assert!(c.admin_update_group("1", &GroupEdit { rate_multiplier: Some(-1.0), ..Default::default() }).await.is_err());
}

#[tokio::test]
async fn a_non_admin_account_is_told_so() {
    let s = MockServer::start().await;
    sub_login(&s).await;
    Mock::given(method("GET")).and(path("/api/v1/admin/groups/all")).respond_with(ResponseTemplate::new(403).set_body_json(json!({"code": 403, "message": "Admin access required"}))).mount(&s).await;
    let c = client(Kind::Sub2api, &s);
    c.login("u@x.com", "pw").await.unwrap();
    assert_eq!(c.admin_probe().await.unwrap_err(), "该账号不是这个站点的管理员");

    let n = MockServer::start().await;
    new_login(&n).await;
    Mock::given(method("GET")).and(path("/api/channel/")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"success": false, "message": "无权进行此操作，权限不足"}))).mount(&n).await;
    let c2 = client(Kind::Newapi, &n);
    c2.login("u", "pw").await.unwrap();
    assert_eq!(c2.admin_probe().await.unwrap_err(), "该账号不是这个站点的管理员");
}

fn channels_body() -> Value {
    json!({"success": true, "data": {"total": 3, "items": [
        {"id": 1, "name": " ch-a ", "type": 14, "status": 1, "group": "default,vip", "models": "m1,m2,m3", "base_url": "https://up.example.com/", "key": "sk-SECRET", "priority": 10},
        {"id": 2, "name": "ch-b", "type": 1, "status": 2, "group": "vip", "models": "m1", "key": "sk-SECRET2"},
        {"id": 3, "name": "ch-c", "type": 1, "status": 3, "group": "", "models": ""}]}})
}

#[tokio::test]
async fn newapi_overview_maps_channels_and_reads_group_settings() {
    let s = MockServer::start().await;
    new_login(&s).await;
    Mock::given(method("GET")).and(path("/api/channel/")).respond_with(ResponseTemplate::new(200).set_body_json(channels_body())).mount(&s).await;
    Mock::given(method("GET")).and(path("/api/option/")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"success": true, "data": [
        {"key": "GroupRatio", "value": "{\"default\":1,\"vip\":0.6}"},
        {"key": "UserUsableGroups", "value": "{\"vip\":\"贵宾分组\"}"}]}))).mount(&s).await;
    let c = client(Kind::Newapi, &s);
    c.login("root", "pw").await.unwrap();
    let o = c.admin_overview().await.unwrap();
    let st: Vec<_> = o.upstreams.iter().map(|u| (u.name.as_str(), u.status.as_str(), u.groups.len(), u.models)).collect();
    assert_eq!(st, [("ch-a", "active", 2, 3), ("ch-b", "paused", 1, 1), ("ch-c", "error", 0, 0)]);
    assert_eq!(o.upstreams[0].host.as_deref(), Some("up.example.com"));
    let g: Vec<_> = o.downstreams.iter().map(|d| (d.name.as_str(), d.rate_multiplier, d.description.clone(), d.editable)).collect();
    assert_eq!(g, [("default", 1.0, None, true), ("vip", 0.6, Some("贵宾分组".to_string()), true)]);
    assert!(!format!("{o:?}").contains("SECRET"), "渠道的 Key 不能出现在返回的数据里");
}

#[tokio::test]
async fn newapi_without_option_access_lists_groups_from_channels_as_read_only() {
    let s = MockServer::start().await;
    new_login(&s).await;
    Mock::given(method("GET")).and(path("/api/channel/")).respond_with(ResponseTemplate::new(200).set_body_json(channels_body())).mount(&s).await;
    Mock::given(method("GET")).and(path("/api/option/")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"success": false, "message": "无权进行此操作，权限不足"}))).mount(&s).await;
    let c = client(Kind::Newapi, &s);
    c.login("admin", "pw").await.unwrap();
    let o = c.admin_overview().await.unwrap();
    assert_eq!(o.downstreams.iter().map(|d| d.name.as_str()).collect::<Vec<_>>(), ["default", "vip"]);
    assert!(o.downstreams.iter().all(|d| !d.editable), "没有超级管理员权限时不能编辑");
}

#[tokio::test]
async fn newapi_pause_writes_back_the_whole_channel_and_edit_updates_the_option_objects() {
    let s = MockServer::start().await;
    new_login(&s).await;
    // 先走专门的状态接口；7 号渠道这个站点没有该接口（404）→ 退回整条写回
    Mock::given(method("POST")).and(path("/api/channel/7/status")).respond_with(ResponseTemplate::new(404).set_body_json(json!({"error": {"message": "Invalid URL (POST /api/channel/7/status)"}}))).expect(1).mount(&s).await;
    Mock::given(method("POST")).and(path("/api/channel/8/status")).and(body_json(json!({"status": 1}))).respond_with(ResponseTemplate::new(200).set_body_json(json!({"success": true}))).expect(1).mount(&s).await;
    Mock::given(method("GET")).and(path("/api/channel/7")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"success": true, "data": {"id": 7, "name": "x", "status": 1, "group": "vip", "models": "m"}}))).mount(&s).await;
    Mock::given(method("PUT")).and(path("/api/channel/")).and(body_json(json!({"id": 7, "name": "x", "status": 2, "group": "vip", "models": "m"}))).respond_with(ResponseTemplate::new(200).set_body_json(json!({"success": true}))).expect(1).mount(&s).await;
    Mock::given(method("DELETE")).and(path("/api/channel/8")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"success": true}))).expect(1).mount(&s).await;
    Mock::given(method("GET")).and(path("/api/option/")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"success": true, "data": [
        {"key": "GroupRatio", "value": "{\"default\":1,\"vip\":0.6}"}, {"key": "UserUsableGroups", "value": "{\"vip\":\"旧备注\"}"}]}))).mount(&s).await;
    Mock::given(method("PUT")).and(path("/api/option/")).and(body_json(json!({"key": "GroupRatio", "value": "{\"default\":1,\"vip\":0.9}"}))).respond_with(ResponseTemplate::new(200).set_body_json(json!({"success": true}))).expect(1).mount(&s).await;
    Mock::given(method("PUT")).and(path("/api/option/")).and(body_json(json!({"key": "UserUsableGroups", "value": "{\"vip\":\"新备注\"}"}))).respond_with(ResponseTemplate::new(200).set_body_json(json!({"success": true}))).expect(1).mount(&s).await;
    let c = client(Kind::Newapi, &s);
    c.login("root", "pw").await.unwrap();
    c.admin_set_paused("7", true).await.unwrap();
    c.admin_set_paused("8", false).await.unwrap();
    c.admin_remove_upstream("8").await.unwrap();
    c.admin_update_group("vip", &GroupEdit { rate_multiplier: Some(0.9), description: Some("新备注".into()), ..Default::default() }).await.unwrap();
    let rename = c.admin_update_group("vip", &GroupEdit { name: Some("vip2".into()), ..Default::default() }).await.unwrap_err();
    assert!(rename.contains("不支持") || rename.contains("标识"), "{rename}");
    let _ = query_param("p", "1");
}

#[tokio::test]
async fn sub2api_admin_usage_costs_users_paid_for_a_group_and_the_upstream_cost_for_an_account() {
    let s = MockServer::start().await;
    sub_login(&s).await;
    let stats = json!({"code": 0, "data": {"total_requests": 10, "total_input_tokens": 600000, "total_output_tokens": 400000, "total_cache_creation_tokens": 100000, "total_cache_read_tokens": 300000, "total_cost": 4.0, "total_actual_cost": 1.0, "total_account_cost": 3.0, "average_duration_ms": 1000.0}});
    Mock::given(method("GET")).and(path("/api/v1/admin/usage/stats")).and(query_param("group_id", "21")).respond_with(ResponseTemplate::new(200).set_body_json(stats.clone())).expect(1).mount(&s).await;
    Mock::given(method("GET")).and(path("/api/v1/admin/usage/stats")).and(query_param("account_id", "25")).respond_with(ResponseTemplate::new(200).set_body_json(stats)).expect(1).mount(&s).await;
    Mock::given(method("GET")).and(path("/api/v1/admin/usage")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"code": 0, "data": {"items": [
        {"first_token_ms": 900, "created_at": rfc(now_secs() - 60), "input_tokens": 100, "output_tokens": 50, "cache_creation_tokens": 10, "cache_read_tokens": 40},
        {"first_token_ms": 300, "created_at": rfc(now_secs() - 3600), "input_tokens": 1000, "output_tokens": 0, "cache_creation_tokens": 0, "cache_read_tokens": 0},
        {"first_token_ms": 0, "created_at": rfc(now_secs() - 3 * 86_400), "input_tokens": 999999, "output_tokens": 0, "cache_creation_tokens": 0, "cache_read_tokens": 0}]}}))).mount(&s).await;
    let c = client(Kind::Sub2api, &s);
    c.login("boss@x.com", "pw").await.unwrap();
    let g = c.admin_usage("group", "21").await.unwrap();
    assert_eq!((g.cost, g.cost_per_m_effective, g.cache_hit_rate), (1.0, Some(1.0), Some(0.3)), "下游：所有用户实付");
    assert_eq!(g.first_token_median_ms, Some(300));
    assert_eq!((g.tokens_24h, g.tokens_24h_capped), (Some(1200), false), "只累加 24 小时内的记录：100+50+10+40+1000");
    let a = c.admin_usage("account", "25").await.unwrap();
    assert_eq!((a.cost, a.cost_per_m_effective), (3.0, Some(3.0)), "上游：你付给上游的成本");
    assert_eq!(a.actual_multiplier, Some(0.75));
    assert!(c.admin_usage("group", "21; drop").await.is_err(), "id 必须是数字");
}

#[tokio::test]
async fn newapi_admin_usage_reads_the_site_wide_log_filtered_by_group_or_channel() {
    let s = MockServer::start().await;
    new_login(&s).await;
    let logs = json!({"success": true, "data": {"total": 2, "items": [
        {"model_name": "m", "created_at": now_secs() - 10, "prompt_tokens": 1000, "completion_tokens": 500, "quota": 500000, "use_time": 2, "other": "{\"frt\": 400}"},
        {"model_name": "m", "created_at": now_secs() - 20, "prompt_tokens": 1000, "completion_tokens": 500, "quota": 500000, "use_time": 2, "other": "{\"frt\": 800}"}]}});
    Mock::given(method("GET")).and(path("/api/log/")).and(query_param("channel", "7")).and(query_param("type", "2")).respond_with(ResponseTemplate::new(200).set_body_json(logs.clone())).expect(1).mount(&s).await;
    Mock::given(method("GET")).and(path("/api/log/")).and(query_param("group", "vip 组")).respond_with(ResponseTemplate::new(200).set_body_json(logs)).expect(1).mount(&s).await;
    let c = client(Kind::Newapi, &s);
    c.login("root", "pw").await.unwrap();
    let a = c.admin_usage("account", "7").await.unwrap();
    assert_eq!((a.requests, a.cost, a.first_token_median_ms), (2, 2.0, Some(400)));
    assert_eq!((a.tokens_24h, a.tokens_24h_capped), (Some(3000), false));
    let g = c.admin_usage("group", "vip 组").await.unwrap();
    assert_eq!(g.requests, 2);
}

#[tokio::test]
async fn account_status_is_set_through_the_account_update_on_sub2api_and_the_status_endpoint_on_newapi() {
    let s = MockServer::start().await;
    sub_login(&s).await;
    Mock::given(method("PUT")).and(path("/api/v1/admin/accounts/10")).and(body_json(json!({"status": "inactive"}))).respond_with(ResponseTemplate::new(200).set_body_json(json!({"code": 0, "data": {}}))).expect(1).mount(&s).await;
    Mock::given(method("PUT")).and(path("/api/v1/admin/accounts/10")).and(body_json(json!({"status": "active"}))).respond_with(ResponseTemplate::new(200).set_body_json(json!({"code": 0, "data": {}}))).expect(1).mount(&s).await;
    let c = client(Kind::Sub2api, &s);
    c.login("boss@x.com", "pw").await.unwrap();
    c.admin_set_account_status("10", "inactive").await.unwrap();
    c.admin_set_account_status("10", "active").await.unwrap();
    assert!(c.admin_set_account_status("10", "weird").await.is_err());
    assert!(c.admin_set_account_status("x; y", "active").await.is_err());

    let n = MockServer::start().await;
    new_login(&n).await;
    Mock::given(method("POST")).and(path("/api/channel/7/status")).and(body_json(json!({"status": 2}))).respond_with(ResponseTemplate::new(200).set_body_json(json!({"success": true}))).expect(1).mount(&n).await;
    let c2 = client(Kind::Newapi, &n);
    c2.login("root", "pw").await.unwrap();
    c2.admin_set_account_status("7", "inactive").await.unwrap();
}

#[tokio::test]
async fn the_overview_reports_the_raw_status_and_the_schedulable_flag() {
    let s = MockServer::start().await;
    sub_login(&s).await;
    Mock::given(method("GET")).and(path("/api/v1/admin/groups/all")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"code": 0, "data": []}))).mount(&s).await;
    Mock::given(method("GET")).and(path("/api/v1/admin/accounts")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"code": 0, "data": {"total": 2, "items": [
        {"id": 1, "name": "a", "status": "active", "schedulable": false, "group_ids": [], "credentials": {}},
        {"id": 2, "name": "b", "status": "inactive", "schedulable": true, "group_ids": [], "credentials": {}}]}}))).mount(&s).await;
    let c = client(Kind::Sub2api, &s);
    c.login("boss@x.com", "pw").await.unwrap();
    let o = c.admin_overview().await.unwrap();
    assert_eq!((o.upstreams[0].account_status.as_str(), o.upstreams[0].schedulable, o.upstreams[0].status.as_str()), ("active", Some(false), "paused"));
    assert_eq!((o.upstreams[1].account_status.as_str(), o.upstreams[1].schedulable, o.upstreams[1].status.as_str()), ("inactive", Some(true), "paused"));
}
