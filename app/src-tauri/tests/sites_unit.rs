use app_lib::sites::newapi::{build_groups, format_balance, models_by_group, PubInfo};
use app_lib::sites::{default_name, infer_platform, normalize_url, site_id, Kind};
use serde_json::json;

fn ms(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
}

#[test]
fn normalize_url_accepts_common_inputs() {
    assert_eq!(normalize_url("api.example.com").unwrap(), "https://api.example.com");
    assert_eq!(normalize_url("  https://API.Example.com/  ").unwrap(), "https://api.example.com");
    assert_eq!(normalize_url("https://api.example.com/v1/chat?x=1#f").unwrap(), "https://api.example.com", "路径、参数、锚点都去掉");
    assert_eq!(normalize_url("https://api.example.com:8443/x").unwrap(), "https://api.example.com:8443");
    assert_eq!(normalize_url("http://127.0.0.1:3000").unwrap(), "http://127.0.0.1:3000");
    assert_eq!(normalize_url("http://localhost:8080/").unwrap(), "http://localhost:8080");
}

#[test]
fn normalize_url_rejects_unsafe_or_malformed_input() {
    for (bad, why) in [
        ("", "空"),
        ("   ", "空白"),
        ("http://api.example.com", "明文 http 的远程站点"),
        ("ftp://api.example.com", "非 http 协议"),
        ("https://", "没有主机"),
        ("https://user:pass@api.example.com", "带账号密码的地址"),
        ("https://exam ple.com", "含空格"),
        ("https://localhost-not-local", "无点号的主机名"),
        ("javascript:alert(1)", "伪协议"),
    ] {
        assert!(normalize_url(bad).is_err(), "{why}: {bad:?} 应被拒绝");
    }
    assert!(normalize_url("http://api.example.com").unwrap_err().contains("https"));
}

#[test]
fn site_id_is_stable_and_distinct() {
    assert_eq!(site_id("https://a.com"), site_id("https://a.com"));
    assert_ne!(site_id("https://a.com"), site_id("https://b.com"));
    assert_eq!(site_id("https://a.com").len(), 8);
    assert_eq!(default_name("https://api.example.com"), "api.example.com");
    assert_eq!(default_name("http://127.0.0.1:3000"), "127.0.0.1");
    assert_eq!(serde_json::to_value(Kind::Newapi).unwrap(), "newapi");
}

#[test]
fn infer_platform_by_majority_of_model_prefixes() {
    assert_eq!(infer_platform(&ms(&["claude-sonnet-5", "claude-opus-5"])), "anthropic");
    assert_eq!(infer_platform(&ms(&["gpt-5.6-sol", "o3", "o4-mini"])), "openai");
    assert_eq!(infer_platform(&ms(&["gemini-3.5-flash"])), "gemini");
    assert_eq!(infer_platform(&ms(&["grok-4.5", "grok-4.6"])), "grok");
    assert_eq!(infer_platform(&ms(&["claude-a", "gpt-1", "gpt-2"])), "openai", "多数决");
    assert_eq!(infer_platform(&ms(&["deepseek-v4", "qwen-3"])), "unknown", "不认识的厂商");
    assert_eq!(infer_platform(&[]), "unknown");
}

#[test]
fn balance_formatting_follows_the_site_display_setting() {
    let base = PubInfo { quota_per_unit: 500_000.0, display_type: "USD".into(), usd_rate: 7.3, custom_symbol: "".into(), custom_rate: 1.0 };
    assert_eq!(format_balance(21_797_370.0, &base), "$43.59");
    assert_eq!(format_balance(0.0, &base), "$0.00");
    assert_eq!(format_balance(-500_000.0, &base), "$-1.00");
    assert_eq!(format_balance(500_000.0, &PubInfo { display_type: "CNY".into(), ..base.clone() }), "¥7.30");
    assert_eq!(format_balance(1_000_000.0, &PubInfo { display_type: "CUSTOM".into(), custom_symbol: "元".into(), custom_rate: 2.5, ..base.clone() }), "元5.00");
    assert_eq!(format_balance(123.0, &PubInfo { display_type: "TOKENS".into(), ..base.clone() }), "123 tokens");
    assert_eq!(format_balance(500_000.0, &PubInfo { quota_per_unit: 0.0, ..base }), "$1.00", "缺少换算比例时按 new-api 默认 500000");
}

#[test]
fn groups_are_built_from_self_groups_and_pricing() {
    let pricing = json!({"data": [
        {"model_name": "claude-sonnet-5", "enable_groups": ["Kiro", "Official"]},
        {"model_name": "claude-opus-5", "enable_groups": ["Kiro"]},
        {"model_name": "gpt-5.6-sol", "enable_groups": ["GPT"]},
        {"model_name": "orphan-model", "enable_groups": []},
        {"enable_groups": ["Kiro"]},
    ]});
    let by = models_by_group(&pricing);
    assert_eq!(by["Kiro"], ["claude-sonnet-5", "claude-opus-5"]);
    assert!(!by.contains_key("Nothing"));

    let selfg = json!({"data": {
        "Kiro": {"desc": "便宜", "ratio": 0.28},
        "GPT": {"desc": "", "ratio": 0.5},
        "auto": {"desc": "自动", "ratio": 1},
        "NoRatio": {"desc": "x"},
    }});
    let gs = build_groups(&selfg, &by);
    let get = |n: &str| gs.iter().find(|g| g.name == n).unwrap();
    assert_eq!(get("Kiro").platform, "anthropic");
    assert_eq!(get("Kiro").models.len(), 2);
    assert_eq!(get("Kiro").description.as_deref(), Some("便宜"));
    assert_eq!(get("Kiro").rate_multiplier, 0.28);
    assert_eq!(get("GPT").platform, "openai");
    assert_eq!(get("GPT").description, None, "空说明按没有处理");
    assert_eq!(get("auto").platform, "unknown", "没有模型的分组平台未知，界面归入“暂不支持”");
    assert_eq!(get("NoRatio").rate_multiplier, 1.0, "缺倍率默认 1");
    assert_eq!(get("Kiro").id, "Kiro", "new-api 的分组 id 就是名称");
}

#[test]
fn malformed_responses_do_not_panic() {
    assert!(build_groups(&json!({}), &Default::default()).is_empty());
    assert!(build_groups(&json!({"data": []}), &Default::default()).is_empty());
    assert!(build_groups(&json!({"data": "oops"}), &Default::default()).is_empty());
    assert!(models_by_group(&json!(null)).is_empty());
    assert!(models_by_group(&json!({"data": "x"})).is_empty());
}
