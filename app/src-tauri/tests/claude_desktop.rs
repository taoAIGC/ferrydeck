use std::fs;
use std::path::{Path, PathBuf};

use app_lib::clients::claude_desktop::{self as cd, Params, PROFILE_ID};
use tempfile::TempDir;

const META: &str = include_str!("fixtures/claude_desktop/_meta.json");
const OTHER: &str = include_str!("fixtures/claude_desktop/other_profile.json");
const OTHER_ID: &str = "00000000-0000-4000-8000-000000157210";

fn models(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
}

fn setup(meta: Option<&str>) -> (TempDir, PathBuf, PathBuf) {
    let t = TempDir::new().unwrap();
    let c3p = t.path().join("Claude-3p");
    let dd = t.path().join("data");
    if let Some(m) = meta {
        fs::create_dir_all(c3p.join("configLibrary")).unwrap();
        fs::write(c3p.join("configLibrary/_meta.json"), m).unwrap();
        fs::write(c3p.join(format!("configLibrary/{OTHER_ID}.json")), OTHER).unwrap();
    }
    (t, c3p, dd)
}

fn rd(c3p: &Path, f: &str) -> String {
    fs::read_to_string(c3p.join("configLibrary").join(f)).unwrap()
}

fn json(s: &str) -> serde_json::Value {
    serde_json::from_str(s).unwrap()
}

#[test]
fn apply_registers_our_profile_and_keeps_other_tools_entries() {
    let (_t, c3p, dd) = setup(Some(META));
    let ms = models(&["claude-sonnet-5-5", "claude-opus-5-5"]);
    cd::apply(&c3p, &dd, &Params { base_url: "https://relay.example.com", api_key: "sk-NEW", models: &ms }).unwrap();

    let meta = json(&rd(&c3p, "_meta.json"));
    assert_eq!(meta["appliedId"], PROFILE_ID);
    let entries = meta["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0], json(r#"{"id":"00000000-0000-4000-8000-000000157210","name":"CC Switch"}"#), "别的工具的登记项必须原样保留且顺序不变");
    assert_eq!(entries[1]["name"], "Ferrydeck");

    let p = json(&rd(&c3p, &format!("{PROFILE_ID}.json")));
    assert_eq!(p["inferenceProvider"], "gateway");
    assert_eq!(p["inferenceGatewayBaseUrl"], "https://relay.example.com");
    assert_eq!(p["inferenceGatewayApiKey"], "sk-NEW");
    assert_eq!(p["inferenceGatewayAuthScheme"], "bearer");
    assert_eq!(p["disableDeploymentModeChooser"], true);
    let names: Vec<_> = p["inferenceModels"].as_array().unwrap().iter().map(|m| m["name"].as_str().unwrap().to_string()).collect();
    assert_eq!(names, ["claude-sonnet-5-5", "claude-opus-5-5"], "第一个模型为默认");
    // 字段名与本机现有可用方案完全一致
    let keys: Vec<_> = p.as_object().unwrap().keys().cloned().collect();
    let other_keys: Vec<_> = json(OTHER).as_object().unwrap().keys().cloned().collect();
    assert_eq!(keys, other_keys);
    // 别的工具的方案文件没被碰
    assert_eq!(rd(&c3p, &format!("{OTHER_ID}.json")), OTHER);
}

#[test]
fn restore_gives_back_meta_byte_for_byte_and_removes_our_profile() {
    let (_t, c3p, dd) = setup(Some(META));
    let ms = models(&["m"]);
    cd::apply(&c3p, &dd, &Params { base_url: "https://relay.example.com", api_key: "sk-NEW", models: &ms }).unwrap();
    cd::restore(&c3p, &dd).unwrap();
    assert_eq!(rd(&c3p, "_meta.json"), META);
    assert!(!c3p.join(format!("configLibrary/{PROFILE_ID}.json")).exists());
    assert_eq!(rd(&c3p, &format!("{OTHER_ID}.json")), OTHER);
    assert!(!cd::status(&c3p, &dd).unwrap().has_backup);
}

#[test]
fn apply_twice_overwrites_itself_and_restore_still_returns_to_original() {
    let (_t, c3p, dd) = setup(Some(META));
    cd::apply(&c3p, &dd, &Params { base_url: "https://relay.example.com", api_key: "sk-ONE", models: &models(&["a"]) }).unwrap();
    cd::apply(&c3p, &dd, &Params { base_url: "https://relay.example.com", api_key: "sk-TWO", models: &models(&["b", "c"]) }).unwrap();
    let meta = json(&rd(&c3p, "_meta.json"));
    assert_eq!(meta["entries"].as_array().unwrap().iter().filter(|e| e["id"] == PROFILE_ID).count(), 1);
    let p = rd(&c3p, &format!("{PROFILE_ID}.json"));
    assert!(p.contains("sk-TWO") && !p.contains("sk-ONE"));
    cd::restore(&c3p, &dd).unwrap();
    assert_eq!(rd(&c3p, "_meta.json"), META);
}

#[test]
fn restore_does_not_override_user_switching_to_another_profile() {
    let (_t, c3p, dd) = setup(Some(META));
    cd::apply(&c3p, &dd, &Params { base_url: "https://relay.example.com", api_key: "sk-NEW", models: &models(&["m"]) }).unwrap();
    // 用户之后在别的工具里切到了另一个方案，还新增了一项
    let mut meta = json(&rd(&c3p, "_meta.json"));
    meta["appliedId"] = "user-chosen-id".into();
    meta["entries"].as_array_mut().unwrap().push(json(r#"{"id":"user-chosen-id","name":"Mine"}"#));
    fs::write(c3p.join("configLibrary/_meta.json"), serde_json::to_string_pretty(&meta).unwrap()).unwrap();

    cd::restore(&c3p, &dd).unwrap();
    let after = json(&rd(&c3p, "_meta.json"));
    assert_eq!(after["appliedId"], "user-chosen-id", "用户自己的选择不能被覆盖");
    assert!(after["entries"].as_array().unwrap().iter().all(|e| e["id"] != PROFILE_ID), "我们的登记项必须清掉");
    assert!(after["entries"].as_array().unwrap().iter().any(|e| e["id"] == "user-chosen-id"));
    assert!(!c3p.join(format!("configLibrary/{PROFILE_ID}.json")).exists());
}

#[test]
fn works_when_nothing_exists_and_cleans_up_what_it_created() {
    let (_t, c3p, dd) = setup(None);
    cd::apply(&c3p, &dd, &Params { base_url: "https://relay.example.com", api_key: "sk-NEW", models: &models(&["m"]) }).unwrap();
    let s = cd::status(&c3p, &dd).unwrap();
    assert!(s.in_use && s.base_url.as_deref() == Some("https://relay.example.com"));
    cd::restore(&c3p, &dd).unwrap();
    assert!(!c3p.join("configLibrary/_meta.json").exists(), "我们新建的 _meta.json 应被删除");
    assert!(!c3p.join(format!("configLibrary/{PROFILE_ID}.json")).exists());
    assert!(!cd::status(&c3p, &dd).unwrap().in_use);
}

#[test]
fn meta_without_applied_id_is_restored_without_inventing_one() {
    let orig = "{\n  \"entries\": []\n}\n";
    let (_t, c3p, dd) = setup(Some(orig));
    cd::apply(&c3p, &dd, &Params { base_url: "https://relay.example.com", api_key: "k", models: &models(&["m"]) }).unwrap();
    cd::restore(&c3p, &dd).unwrap();
    assert_eq!(rd(&c3p, "_meta.json"), orig);
}

#[test]
fn bad_input_is_rejected_before_anything_is_written() {
    // meta 不是合法 JSON
    let (_t, c3p, dd) = setup(Some("{ broken"));
    assert!(cd::apply(&c3p, &dd, &Params { base_url: "https://relay.example.com", api_key: "k", models: &models(&["m"]) }).is_err());
    assert_eq!(rd(&c3p, "_meta.json"), "{ broken");
    assert!(!c3p.join(format!("configLibrary/{PROFILE_ID}.json")).exists(), "失败时不应留下方案文件");
    assert!(!dd.join("claude-desktop-state.json").exists());
    // entries 不是数组
    let (_t2, c2, d2) = setup(Some("{\"entries\": 5}"));
    assert!(cd::apply(&c2, &d2, &Params { base_url: "https://relay.example.com", api_key: "k", models: &models(&["m"]) }).is_err());
    assert!(!c2.join(format!("configLibrary/{PROFILE_ID}.json")).exists());
    // 空模型、结尾斜杠、换行
    let (_t3, c3, d3) = setup(Some(META));
    assert!(cd::apply(&c3, &d3, &Params { base_url: "https://relay.example.com", api_key: "k", models: &[] }).is_err());
    assert!(cd::apply(&c3, &d3, &Params { base_url: "https://relay.example.com/", api_key: "k", models: &models(&["m"]) }).is_err());
    assert!(cd::apply(&c3, &d3, &Params { base_url: "https://relay.example.com", api_key: "k\nX", models: &models(&["m"]) }).is_err());
    assert_eq!(rd(&c3, "_meta.json"), META);
}

#[test]
fn restore_without_apply_is_an_error() {
    let (_t, c3p, dd) = setup(Some(META));
    assert!(cd::restore(&c3p, &dd).is_err());
    assert_eq!(rd(&c3p, "_meta.json"), META);
}

#[test]
fn backups_hold_the_original_meta() {
    let (_t, c3p, dd) = setup(Some(META));
    cd::apply(&c3p, &dd, &Params { base_url: "https://relay.example.com", api_key: "k", models: &models(&["m"]) }).unwrap();
    let b: Vec<_> = fs::read_dir(dd.join("backups/claude-desktop")).unwrap().collect();
    assert_eq!(b.len(), 1);
    assert_eq!(fs::read_to_string(b[0].as_ref().unwrap().path()).unwrap(), META);
}

#[cfg(unix)]
#[test]
fn profile_with_api_key_is_private_to_the_user() {
    use std::os::unix::fs::PermissionsExt;
    let (_t, c3p, dd) = setup(Some(META));
    cd::apply(&c3p, &dd, &Params { base_url: "https://relay.example.com", api_key: "sk-SECRET", models: &models(&["m"]) }).unwrap();
    let mode = fs::metadata(c3p.join(format!("configLibrary/{PROFILE_ID}.json"))).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o600, "含 API Key 的方案文件不应被其他用户读取");
}

#[test]
fn conflicts_explain_missing_third_party_mode() {
    let t = TempDir::new().unwrap();
    let c3p = t.path().join("Claude-3p");
    let missing = cd::detect_conflicts(&c3p);
    assert_eq!(missing.len(), 1);
    assert!(missing[0].contains("开发者模式"));

    fs::create_dir_all(&c3p).unwrap();
    fs::write(c3p.join("claude_desktop_config.json"), r#"{"deploymentMode":"1p"}"#).unwrap();
    assert!(cd::detect_conflicts(&c3p)[0].contains("还没有切换到第三方推理模式"));

    fs::write(c3p.join("claude_desktop_config.json"), r#"{"deploymentMode":"3p"}"#).unwrap();
    assert!(cd::detect_conflicts(&c3p).is_empty());
}
