//! 分组列表的缓存规则：一分钟内拉过就不再向站点要；用户手动拉取（max_age=0）一定重新拉；
//! 拉取失败时继续显示上一次的分组，并且“最近拉取时间”不被刷新。

use std::sync::atomic::Ordering;

use app_lib::paths::Paths;
use app_lib::sites::{Kind, Site};
use app_lib::state::{AppState, SiteRuntime};
use app_lib::{site_groups_or_cached};
use serde_json::json;
use tempfile::TempDir;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

async fn setup(groups_mock_times: Option<u64>) -> (MockServer, std::sync::Arc<SiteRuntime>, TempDir) {
    let s = MockServer::start().await;
    Mock::given(method("POST")).and(path("/api/v1/auth/login")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"code": 0, "data": {"access_token": "a", "refresh_token": "r", "user": {"email": "a@b.c", "balance": 1}}}))).mount(&s).await;
    let m = Mock::given(method("GET")).and(path("/api/v1/groups/available")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"code": 0, "data": [
        {"id": 2, "name": "A", "platform": "anthropic", "rate_multiplier": 1.0, "status": "active"},
    ]})));
    match groups_mock_times {
        Some(n) => m.expect(n).mount(&s).await,
        None => m.mount(&s).await,
    }
    let t = TempDir::new().unwrap();
    let rt = AppState::make_runtime(&Paths::under(t.path()), Site { id: "s1".into(), kind: Kind::Sub2api, name: "S".into(), base_url: s.uri() });
    rt.client.login("a@b.c", "pw").await.unwrap();
    (s, rt, t)
}

#[tokio::test]
async fn within_the_max_age_the_site_is_not_asked_again() {
    let (_s, rt, _t) = setup(Some(1)).await; // 站点的分组接口只会被真正请求 1 次
    let (first, e1) = site_groups_or_cached(&rt, 60).await;
    assert_eq!((first.len(), e1), (1, None));
    let at = rt.last_groups_at.load(Ordering::Relaxed);
    assert!(at > 0, "拉过之后要记下时间");
    for _ in 0..5 {
        let (again, e) = site_groups_or_cached(&rt, 60).await; // 打开面板：一分钟内直接用缓存
        assert_eq!((again.len(), e), (1, None));
    }
    assert_eq!(rt.last_groups_at.load(Ordering::Relaxed), at, "命中缓存不改变“最近拉取时间”");
}

#[tokio::test]
async fn a_manual_pull_always_goes_to_the_site() {
    let (_s, rt, _t) = setup(Some(3)).await;
    site_groups_or_cached(&rt, 60).await; // 1 次真实请求
    site_groups_or_cached(&rt, 0).await; // 用户点刷新：max_age=0，必须重新拉
    site_groups_or_cached(&rt, 0).await;
}

#[tokio::test]
async fn a_stale_cache_is_refreshed() {
    let (_s, rt, _t) = setup(Some(2)).await;
    site_groups_or_cached(&rt, 60).await;
    // 把“最近拉取时间”拨到两分钟前，缓存就过期了
    rt.last_groups_at.store(app_lib::sites::http::now() - 120, Ordering::Relaxed);
    site_groups_or_cached(&rt, 60).await;
    assert!(app_lib::sites::http::now() - rt.last_groups_at.load(Ordering::Relaxed) < 5, "重新拉取后时间更新");
}

#[tokio::test]
async fn a_failed_pull_keeps_the_old_groups_and_the_old_timestamp() {
    let s = MockServer::start().await;
    Mock::given(method("POST")).and(path("/api/v1/auth/login")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"code": 0, "data": {"access_token": "a", "refresh_token": "r", "user": {"email": "a@b.c", "balance": 1}}}))).mount(&s).await;
    Mock::given(method("GET")).and(path("/api/v1/groups/available")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"code": 0, "data": [{"id": 2, "name": "A", "platform": "anthropic", "rate_multiplier": 1.0, "status": "active"}]}))).up_to_n_times(1).mount(&s).await;
    Mock::given(method("GET")).and(path("/api/v1/groups/available")).respond_with(ResponseTemplate::new(503)).with_priority(10).mount(&s).await;
    let t = TempDir::new().unwrap();
    let rt = AppState::make_runtime(&Paths::under(t.path()), Site { id: "s1".into(), kind: Kind::Sub2api, name: "S".into(), base_url: s.uri() });
    rt.client.login("a@b.c", "pw").await.unwrap();
    site_groups_or_cached(&rt, 0).await;
    let at = rt.last_groups_at.load(Ordering::Relaxed);
    let (groups, err) = site_groups_or_cached(&rt, 0).await; // 手动刷新，但站点这次出错
    assert_eq!(groups.len(), 1, "出错时继续显示上一次的分组");
    assert!(err.is_some());
    assert_eq!(rt.last_groups_at.load(Ordering::Relaxed), at, "没拉成功，“最近拉取时间”不能更新");
}
