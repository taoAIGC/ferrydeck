//! 站长：把上游账号关联到上游站点里的分组，读它当前的倍率。
use app_lib::admin::{load_links, save_links, SavedLinks};
use app_lib::paths::Paths;
use app_lib::sites::{Kind, Site};
use app_lib::state::AppState;
use serde_json::json;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn login() -> ResponseTemplate {
    ResponseTemplate::new(200).set_body_json(json!({"code": 0, "data": {"access_token": "t", "refresh_token": "r", "user": {"email": "a@b.c", "balance": 1}}}))
}

/// 站长站点：三个上游账号，地址分别是 up1（应用里已添加）、up2（没添加）。
async fn boss(up1_host: &str) -> MockServer {
    let s = MockServer::start().await;
    Mock::given(method("POST")).and(path("/api/v1/auth/login")).respond_with(login()).mount(&s).await;
    Mock::given(method("GET")).and(path("/api/v1/admin/groups/all")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"code": 0, "data": []}))).mount(&s).await;
    Mock::given(method("GET")).and(path("/api/v1/admin/accounts")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"code": 0, "data": {"total": 4, "items": [
        {"id": 1, "name": "Kiro 特价 0.09", "credentials": {"base_url": format!("http://{up1_host}/v1")}},
        {"id": 2, "name": "别的上游 0.5", "credentials": {"base_url": "https://up2.example.com"}},
        {"id": 3, "name": "没写倍率", "credentials": {"base_url": format!("http://{up1_host}")}},
        {"id": 4, "name": "oauth", "credentials": {}}]}}))).mount(&s).await;
    s
}

/// 上游站点：两个分组，倍率 0.09 和 0.5。
async fn upstream() -> MockServer {
    let s = MockServer::start().await;
    Mock::given(method("POST")).and(path("/api/v1/auth/login")).respond_with(login()).mount(&s).await;
    Mock::given(method("GET")).and(path("/api/v1/groups/available")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"code": 0, "data": [
        {"id": 7, "name": "Kiro-特价", "platform": "anthropic", "rate_multiplier": 0.09, "status": "active"},
        {"id": 8, "name": "Kiro-正价", "platform": "anthropic", "rate_multiplier": 0.5, "status": "active"}]}))).mount(&s).await;
    s
}

#[tokio::test]
async fn links_use_saved_choices_suggest_by_name_rate_and_report_sites_without_an_account() {
    let up = upstream().await;
    let b = boss(up.uri().trim_start_matches("http://")).await;
    let t = tempfile::tempdir().unwrap();
    let p = Paths::under(t.path());
    let boss_rt = AppState::make_runtime(&p, Site { id: "boss".into(), kind: Kind::Sub2api, name: "Boss".into(), base_url: b.uri(), is_admin: true });
    let up_rt = AppState::make_runtime(&p, Site { id: "up".into(), kind: Kind::Sub2api, name: "上游一号".into(), base_url: up.uri(), is_admin: false });
    boss_rt.client.login("boss", "pw").await.unwrap();
    up_rt.client.login("me", "pw").await.unwrap();
    let sites = [boss_rt.clone(), up_rt.clone()];

    // 还没关联：账号 1 名称里写了 0.09，推荐倍率相同的唯一分组；账号 3 没写，不推荐；up2 没添加账号
    let r = app_lib::links_for(&boss_rt, &sites, &SavedLinks::default()).await.unwrap();
    let by = |r: &app_lib::admin::LinkReport, id: &str| r.links.iter().find(|l| l.upstream_id == id).cloned();
    let l1 = by(&r, "1").unwrap();
    assert_eq!((l1.group_id.clone(), l1.rate), (None, None));
    assert_eq!(l1.suggested.as_ref().map(|s| (s.id.as_str(), s.rate)), Some(("7", 0.09)));
    assert_eq!(l1.candidates.len(), 2);
    assert!(by(&r, "3").unwrap().suggested.is_none());
    assert!(by(&r, "2").is_none(), "没添加账号的上游站点没有 link");
    assert!(by(&r, "4").is_none(), "没有地址的账号不处理");
    assert_eq!(r.missing_hosts, ["up2.example.com"]);

    // 站长选了分组 8：以后读到的是它**当前的**倍率 0.5（不是名称里的 0.09）
    let mut saved = SavedLinks::default();
    saved.entry("boss".into()).or_default().insert("1".into(), ("up".into(), "8".into()));
    save_links(t.path(), &saved).unwrap();
    assert_eq!(load_links(t.path()), saved, "保存后能读回来");
    let r2 = app_lib::links_for(&boss_rt, &sites, &load_links(t.path())).await.unwrap();
    let l1 = by(&r2, "1").unwrap();
    assert_eq!((l1.group.as_deref(), l1.rate, l1.suggested.is_none()), (Some("Kiro-正价"), Some(0.5), true));

    // 关联的分组被删了：给出提示，不再显示旧倍率
    let mut gone = SavedLinks::default();
    gone.entry("boss".into()).or_default().insert("1".into(), ("up".into(), "999".into()));
    let r3 = app_lib::links_for(&boss_rt, &sites, &gone).await.unwrap();
    let l1 = by(&r3, "1").unwrap();
    assert!(l1.rate.is_none() && l1.note.as_deref().unwrap().contains("已经找不到了"), "{l1:?}");
}
