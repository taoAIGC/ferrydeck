use std::fs;
use std::path::{Path, PathBuf};

use app_lib::clients::claude::{self, Params};
use tempfile::TempDir;

const FIXTURE: &str = include_str!("fixtures/claude_settings.json");

fn p<'a>(key: &'a str, model: Option<&'a str>) -> Params<'a> {
    Params { base_url: "https://relay.example.com", api_key: key, model }
}

fn setup(content: Option<&str>) -> (TempDir, PathBuf, PathBuf) {
    let t = TempDir::new().unwrap();
    let cd = t.path().join(".claude");
    let dd = t.path().join("data");
    fs::create_dir_all(&cd).unwrap();
    if let Some(c) = content {
        fs::write(cd.join("settings.json"), c).unwrap();
    }
    (t, cd, dd)
}

fn read(d: &Path) -> String {
    fs::read_to_string(d.join("settings.json")).unwrap()
}

fn json(s: &str) -> serde_json::Value {
    serde_json::from_str(s).unwrap()
}

#[test]
fn apply_replaces_ours_and_keeps_everything_else() {
    let (_t, cd, dd) = setup(Some(FIXTURE));
    claude::apply(&cd, &dd, &p("sk-NEW", None)).unwrap();
    let after = read(&cd);
    let (a, o) = (json(&after), json(FIXTURE));
    assert_eq!(a["env"]["ANTHROPIC_BASE_URL"], "https://relay.example.com");
    assert_eq!(a["env"]["ANTHROPIC_AUTH_TOKEN"], "sk-NEW");
    assert_eq!(a["model"], "opus", "用户自己的顶层 model 永远不动");
    assert!(a["env"].get("ANTHROPIC_MODEL").is_none(), "未指定模型时不写 ANTHROPIC_MODEL");
    for k in ["includeCoAuthoredBy", "permissions", "tui", "autoMode"] {
        assert_eq!(a[k], o[k], "{k} 必须原样保留");
    }
    assert_eq!(a["env"]["API_TIMEOUT_MS"], o["env"]["API_TIMEOUT_MS"]);
    assert_eq!(a["env"]["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"], "1");
    assert!(after.contains("~/项目/**"), "中文内容不能被转义或丢失");
    // 键的顺序不变
    let keys: Vec<_> = a.as_object().unwrap().keys().cloned().collect();
    assert_eq!(keys, ["env", "includeCoAuthoredBy", "permissions", "tui", "autoMode", "model"]);
    let ek: Vec<_> = a["env"].as_object().unwrap().keys().cloned().collect();
    assert_eq!(ek, ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "API_TIMEOUT_MS", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"]);
}

#[test]
fn restore_returns_file_to_original_text() {
    let (_t, cd, dd) = setup(Some(FIXTURE));
    claude::apply(&cd, &dd, &p("sk-NEW", Some("claude-sonnet-4-6"))).unwrap();
    let a = json(&read(&cd));
    assert_eq!(a["env"]["ANTHROPIC_MODEL"], "claude-sonnet-4-6");
    assert_eq!(a["model"], "opus");
    claude::restore(&cd, &dd).unwrap();
    assert_eq!(read(&cd), FIXTURE, "还原后应与原文件逐字一致");
    assert!(!claude::status(&cd, &dd).unwrap().has_backup);
}

#[test]
fn original_without_our_keys_is_restored_exactly() {
    let orig = "{\n  \"permissions\": {\n    \"allow\": []\n  },\n  \"tui\": \"fullscreen\"\n}\n";
    let (_t, cd, dd) = setup(Some(orig));
    claude::apply(&cd, &dd, &p("sk-NEW", Some("m"))).unwrap();
    assert!(read(&cd).contains("ANTHROPIC_AUTH_TOKEN"));
    claude::restore(&cd, &dd).unwrap();
    assert_eq!(read(&cd), orig);
}

#[test]
fn apply_twice_keeps_first_original() {
    let (_t, cd, dd) = setup(Some(FIXTURE));
    claude::apply(&cd, &dd, &p("sk-ONE", Some("m1"))).unwrap();
    claude::apply(&cd, &dd, &p("sk-TWO", Some("m2"))).unwrap();
    let mid = read(&cd);
    assert!(mid.contains("sk-TWO") && !mid.contains("sk-ONE") && !mid.contains("sk-FAKE-OLD-TOKEN"));
    claude::restore(&cd, &dd).unwrap();
    assert_eq!(read(&cd), FIXTURE);
}

#[test]
fn restore_does_not_override_values_the_user_changed() {
    let (_t, cd, dd) = setup(Some(FIXTURE));
    claude::apply(&cd, &dd, &p("sk-NEW", Some("claude-sonnet-4-6"))).unwrap();
    // 用户随后自己改了 token 和 model，还新增了设置
    let edited = read(&cd).replace("sk-NEW", "sk-USER-OWN").replace("claude-sonnet-4-6", "my-model");
    let mut v = json(&edited);
    v["theme"] = "dark".into();
    fs::write(cd.join("settings.json"), serde_json::to_string_pretty(&v).unwrap()).unwrap();

    claude::restore(&cd, &dd).unwrap();
    let a = json(&read(&cd));
    assert_eq!(a["env"]["ANTHROPIC_AUTH_TOKEN"], "sk-USER-OWN", "用户改过的值不能被覆盖");
    assert_eq!(a["env"]["ANTHROPIC_MODEL"], "my-model");
    assert_eq!(a["env"]["ANTHROPIC_BASE_URL"], "https://example.invalid", "没被用户改过的项应还原");
    assert_eq!(a["theme"], "dark", "用户新增的内容必须保留");
}

#[test]
fn indent_and_trailing_newline_are_preserved() {
    let four = "{\n    \"tui\": \"x\"\n}"; // 4 空格、无结尾换行
    let (_t, cd, dd) = setup(Some(four));
    claude::apply(&cd, &dd, &p("sk-NEW", None)).unwrap();
    let after = read(&cd);
    assert!(after.contains("\n    \"tui\""), "应沿用 4 空格缩进: {after}");
    assert!(!after.ends_with('\n'));
    claude::restore(&cd, &dd).unwrap();
    assert_eq!(read(&cd), four);
}

#[test]
fn missing_or_empty_file_works() {
    for init in [None, Some(""), Some("{}")] {
        let (_t, cd, dd) = setup(init);
        claude::apply(&cd, &dd, &p("sk-NEW", Some("m"))).unwrap();
        let s = claude::status(&cd, &dd).unwrap();
        assert!(s.in_use && s.has_token, "{init:?}");
        claude::restore(&cd, &dd).unwrap();
        let after = read(&cd);
        assert!(!after.contains("ferrydeck") && !after.contains("ANTHROPIC"), "{init:?}: {after}");
    }
}

#[test]
fn invalid_json_is_rejected_and_left_untouched() {
    for bad in ["{ \"a\": ", "[1,2,3]", "model = x"] {
        let (_t, cd, dd) = setup(Some(bad));
        assert!(claude::apply(&cd, &dd, &p("sk-NEW", None)).is_err(), "{bad}");
        assert_eq!(read(&cd), bad);
        assert!(!dd.join("claude-state.json").exists(), "解析失败时不应留下状态记录");
    }
}

#[test]
fn env_that_is_not_an_object_is_rejected() {
    let (_t, cd, dd) = setup(Some("{\"env\": \"oops\"}"));
    assert!(claude::apply(&cd, &dd, &p("sk-NEW", None)).is_err());
    assert_eq!(read(&cd), "{\"env\": \"oops\"}");
}

#[test]
fn restore_without_apply_is_an_error() {
    let (_t, cd, dd) = setup(Some(FIXTURE));
    assert!(claude::restore(&cd, &dd).is_err());
    assert_eq!(read(&cd), FIXTURE);
}

#[test]
fn backup_holds_the_original_file() {
    let (_t, cd, dd) = setup(Some(FIXTURE));
    claude::apply(&cd, &dd, &p("sk-NEW", None)).unwrap();
    let b: Vec<_> = fs::read_dir(dd.join("backups").join("claude")).unwrap().collect();
    assert_eq!(b.len(), 1);
    assert_eq!(fs::read_to_string(b[0].as_ref().unwrap().path()).unwrap(), FIXTURE);
}

#[cfg(unix)]
#[test]
fn file_permissions_are_preserved() {
    use std::os::unix::fs::PermissionsExt;
    let (_t, cd, dd) = setup(Some(FIXTURE));
    fs::set_permissions(cd.join("settings.json"), fs::Permissions::from_mode(0o600)).unwrap();
    claude::apply(&cd, &dd, &p("sk-NEW", None)).unwrap();
    assert_eq!(fs::metadata(cd.join("settings.json")).unwrap().permissions().mode() & 0o777, 0o600);
}

#[test]
fn detects_conflicts_from_shell_local_settings_and_api_key() {
    let t = TempDir::new().unwrap();
    let cd = t.path().join(".claude");
    fs::create_dir_all(&cd).unwrap();
    fs::write(t.path().join(".zshrc"), "# export ANTHROPIC_API_KEY=x\nexport ANTHROPIC_BASE_URL=https://a\nexport PATH=/x\n").unwrap();
    fs::write(cd.join("settings.local.json"), "{\"env\":{\"ANTHROPIC_AUTH_TOKEN\":\"t\"}}").unwrap();
    fs::write(cd.join("settings.json"), "{\"env\":{\"ANTHROPIC_API_KEY\":\"k\"}}").unwrap();
    let found = claude::detect_conflicts(t.path(), &cd);
    assert_eq!(found.len(), 3, "{found:?}");
    assert!(found.iter().any(|s| s.contains(".zshrc") && s.contains("ANTHROPIC_BASE_URL")));
    assert!(found.iter().any(|s| s.contains("settings.local.json")));
    assert!(found.iter().any(|s| s.contains("env.ANTHROPIC_API_KEY")));
}

#[test]
fn switching_group_without_model_does_not_leave_old_model_behind() {
    let (_t, cd, dd) = setup(Some(FIXTURE));
    claude::apply(&cd, &dd, &p("sk-A", Some("grok-4.5"))).unwrap();
    claude::apply(&cd, &dd, &p("sk-B", None)).unwrap();
    assert!(json(&read(&cd))["env"].get("ANTHROPIC_MODEL").is_none(), "上一个分组的模型必须撤回");
    claude::restore(&cd, &dd).unwrap();
    assert_eq!(read(&cd), FIXTURE);
}

#[test]
fn compact_arrays_are_restored_byte_for_byte() {
    let orig = "{\n  \"permissions\": {\n    \"allow\": [\"Bash(ls:*)\", \"Read(**)\"]\n  },\n  \"tui\": \"x\"\n}\n";
    let (_t, cd, dd) = setup(Some(orig));
    claude::apply(&cd, &dd, &p("sk-NEW", None)).unwrap();
    claude::restore(&cd, &dd).unwrap();
    assert_eq!(read(&cd), orig, "未被他人改动时，应把备份原文逐字写回（包括一行写完的数组）");
}
