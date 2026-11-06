//! 锁定“Rust 返回的 JSON”与前端 `src/types.ts` 的字段约定。改动任何一边都必须同步另一边。
use app_lib::sites::AccountInfo;
use app_lib::paths::Paths;
use app_lib::service::{self, Active, Client, ClientOverview, EnableOutcome, GroupView};
use serde_json::{json, Value};

fn keys(v: &Value) -> Vec<String> {
    let mut k: Vec<String> = v.as_object().unwrap().keys().cloned().collect();
    k.sort();
    k
}

#[test]
fn group_view_matches_frontend_type() {
    let g = GroupView { site_id: "s".into(), site_name: "S".into(), id: "1".into(), name: "n".into(), description: None, platform: "anthropic".into(), rate_multiplier: 0.5, clients: vec![Client::Claude, Client::ClaudeDesktop] };
    let v = serde_json::to_value(&g).unwrap();
    assert_eq!(keys(&v), ["clients", "description", "id", "name", "platform", "rate_multiplier", "site_id", "site_name"]);
    assert_eq!(v["clients"], json!(["claude", "claude_desktop"]));
    assert_eq!(v["description"], Value::Null);
    let none = serde_json::to_value(GroupView { clients: vec![], ..g }).unwrap();
    assert_eq!(none["clients"], json!([]), "不支持的分组 clients 必须是空数组");
}

#[test]
fn enable_outcome_and_overview_match_frontend_types() {
    let o = EnableOutcome { client: Client::Codex, key_created: true, models: vec!["m".into()], model: Some("m".into()), conflicts: vec![] };
    let v = serde_json::to_value(&o).unwrap();
    assert_eq!(keys(&v), ["client", "conflicts", "key_created", "model", "models"]);
    assert_eq!(v["client"], "codex");

    let ov = ClientOverview { client: Client::Gemini, dir_exists: true, in_use: true, active: Some(Active { site_id: "s".into(), site_name: "S".into(), group_id: "3".into(), group_name: "g".into(), model: None }), conflicts: vec![] };
    let v = serde_json::to_value(&ov).unwrap();
    assert_eq!(keys(&v), ["active", "client", "conflicts", "dir_exists", "in_use"]);
    assert_eq!(keys(&v["active"]), ["group_id", "group_name", "model", "site_id", "site_name"]);
    assert_eq!(v["client"], "gemini");
}

#[test]
fn account_matches_frontend_type() {
    let v = serde_json::to_value(AccountInfo { display: "a@b.c".into(), balance: "$1.50".into() }).unwrap();
    assert_eq!(keys(&v), ["balance", "display"]);
}

#[test]
fn client_ids_round_trip_with_what_the_frontend_sends() {
    for (s, c) in [("claude", Client::Claude), ("claude_desktop", Client::ClaudeDesktop), ("codex", Client::Codex), ("gemini", Client::Gemini)] {
        assert_eq!(Client::parse(s).unwrap(), c);
        assert_eq!(c.id(), s);
        assert_eq!(serde_json::to_value(c).unwrap(), json!(s));
    }
    assert!(Client::parse("grok").is_err());
}

#[test]
fn platform_to_client_mapping() {
    assert_eq!(service::clients_for("anthropic"), vec![Client::Claude, Client::ClaudeDesktop]);
    assert_eq!(service::clients_for("openai"), vec![Client::Codex]);
    assert_eq!(service::clients_for("gemini"), vec![Client::Gemini]);
    assert!(service::clients_for("grok").is_empty());
}

#[test]
fn default_group_is_hidden_but_similar_names_are_not() {
    assert!(service::is_hidden_group("default") && service::is_hidden_group(" Default "));
    assert!(!service::is_hidden_group("Claude default") && !service::is_hidden_group("default-plus"));
}

#[test]
fn overview_on_empty_home_reports_nothing_active() {
    let t = tempfile::TempDir::new().unwrap();
    let ov = service::overview(&Paths::under(t.path()));
    assert_eq!(ov.len(), 4);
    assert!(ov.iter().all(|o| !o.in_use && o.active.is_none() && !o.dir_exists));
}

#[test]
fn default_model_prefers_known_and_skips_image_models() {
    let m = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    assert_eq!(service::default_model(Client::Codex, &m(&["gpt-6-sol", "gpt-5.6-sol"])).as_deref(), Some("gpt-5.6-sol"));
    assert_eq!(service::default_model(Client::Claude, &m(&["x-model"])).as_deref(), Some("x-model"));
    assert_eq!(service::default_model(Client::ClaudeDesktop, &m(&["claude-opus-5-5", "claude-sonnet-5"])).as_deref(), Some("claude-sonnet-5"));
    assert_eq!(service::default_model(Client::Gemini, &m(&["gemini-nano-banana-2.1", "gemini-9"])).as_deref(), Some("gemini-9"));
    assert_eq!(service::default_model(Client::Codex, &[]), None);
    assert!(!service::is_chat_model("gpt-image-2") && service::is_chat_model("gpt-5.6-sol"));
}
