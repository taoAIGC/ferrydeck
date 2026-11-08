use std::fs;
use std::path::Path;

use app_lib::clients::codex::{self, Params};
use tempfile::TempDir;

const FIXTURE: &str = include_str!("fixtures/codex_config.toml");

fn params<'a>(key: &'a str, model: &'a str) -> Params<'a> {
    Params { base_url: "https://relay.example.com/v1", api_key: key, model, provider_display_name: "BestAPI" }
}

fn setup(content: Option<&str>) -> (TempDir, std::path::PathBuf, std::path::PathBuf) {
    let t = TempDir::new().unwrap();
    let codex_dir = t.path().join(".codex");
    let data_dir = t.path().join("data");
    fs::create_dir_all(&codex_dir).unwrap();
    if let Some(c) = content {
        fs::write(codex_dir.join("config.toml"), c).unwrap();
    }
    (t, codex_dir, data_dir)
}

fn read(dir: &Path) -> String {
    fs::read_to_string(dir.join("config.toml")).unwrap()
}

#[test]
fn apply_sets_provider_and_keeps_everything_else() {
    let (_t, cd, dd) = setup(Some(FIXTURE));
    codex::apply(&cd, &dd, &params("sk-NEW", "gpt-5.6-terra")).unwrap();
    let after = read(&cd);

    assert!(after.contains("model_provider = \"ferrydeck\""));
    assert!(after.contains("model = \"gpt-5.6-terra\""));
    assert!(after.contains("[model_providers.ferrydeck]"));
    assert!(after.contains("base_url = \"https://relay.example.com/v1\""));
    assert!(after.contains("experimental_bearer_token = \"sk-NEW\""));
    assert!(after.contains("requires_openai_auth = false"));
    // 原有内容完整保留
    assert!(after.contains("# 用户自己的注释：应当原样保留"));
    assert!(after.contains("[model_providers.custom]"));
    assert!(after.contains("sk-FAKE-FIXTURE-KEY"));
    assert!(after.contains("[mcp_servers.node_repl.env]"));
    assert!(after.contains("[plugins.\"browser@openai-bundled\"]"));
    assert!(after.contains("preferred_auth_method = \"api-key\""));
    assert!(after.contains("[shell_environment_policy.set]"));
    // 不应再有旧的当前 provider/model
    assert!(!after.contains("model_provider = \"custom\""));
    assert!(!after.contains("model = \"gpt-5.6-sol\""));
}

#[test]
fn restore_returns_file_to_original_text() {
    let (_t, cd, dd) = setup(Some(FIXTURE));
    codex::apply(&cd, &dd, &params("sk-NEW", "gpt-5.6-terra")).unwrap();
    codex::restore(&cd, &dd).unwrap();
    assert_eq!(read(&cd), FIXTURE, "还原后应与原文件逐字一致");
    assert!(!codex::status(&cd, &dd).unwrap().has_backup);
}

#[test]
fn apply_twice_keeps_first_original_and_single_table() {
    let (_t, cd, dd) = setup(Some(FIXTURE));
    codex::apply(&cd, &dd, &params("sk-ONE", "gpt-5.6-sol")).unwrap();
    codex::apply(&cd, &dd, &params("sk-TWO", "gpt-6-sol")).unwrap();
    let mid = read(&cd);
    assert_eq!(mid.matches("[model_providers.ferrydeck]").count(), 1);
    assert!(mid.contains("sk-TWO") && !mid.contains("sk-ONE"));
    assert!(mid.contains("model = \"gpt-6-sol\""));

    codex::restore(&cd, &dd).unwrap();
    assert_eq!(read(&cd), FIXTURE, "两次写入后还原，仍应回到最初状态而不是第一次写入后的状态");
}

#[test]
fn restore_does_not_override_user_switching_away() {
    let (_t, cd, dd) = setup(Some(FIXTURE));
    codex::apply(&cd, &dd, &params("sk-NEW", "gpt-5.6-terra")).unwrap();
    // 用户在此期间自己切到了别的 provider，并加了新设置
    let edited = read(&cd)
        .replace("model_provider = \"ferrydeck\"", "model_provider = \"openai\"")
        + "\n[extra]\nuser_added = true\n";
    fs::write(cd.join("config.toml"), edited).unwrap();

    codex::restore(&cd, &dd).unwrap();
    let after = read(&cd);
    assert!(after.contains("model_provider = \"openai\""), "不应覆盖用户已做的选择");
    assert!(!after.contains("[model_providers.ferrydeck]"), "我们的表必须被清掉");
    assert!(after.contains("user_added = true"), "用户新增的内容必须保留");
}

#[test]
fn works_when_config_missing_and_when_no_model_keys() {
    let (_t, cd, dd) = setup(None);
    codex::apply(&cd, &dd, &params("sk-NEW", "gpt-5.6-sol")).unwrap();
    let s = codex::status(&cd, &dd).unwrap();
    assert!(s.in_use && s.active_model.as_deref() == Some("gpt-5.6-sol"));
    codex::restore(&cd, &dd).unwrap();
    let after = read(&cd);
    assert!(!after.contains("ferrydeck") && !after.contains("model_provider") && !after.contains("model ="));

    let (_t2, cd2, dd2) = setup(Some("[desktop]\nfollowUpQueueMode = \"queue\"\n"));
    codex::apply(&cd2, &dd2, &params("sk-NEW", "gpt-5.6-sol")).unwrap();
    codex::restore(&cd2, &dd2).unwrap();
    assert_eq!(read(&cd2), "[desktop]\nfollowUpQueueMode = \"queue\"\n");
}

#[test]
fn restore_without_apply_is_an_error() {
    let (_t, cd, dd) = setup(Some(FIXTURE));
    assert!(codex::restore(&cd, &dd).is_err());
    assert_eq!(read(&cd), FIXTURE);
}

#[test]
fn invalid_toml_is_rejected_and_left_untouched() {
    let bad = "model = = broken\n[[[";
    let (_t, cd, dd) = setup(Some(bad));
    assert!(codex::apply(&cd, &dd, &params("sk-NEW", "m")).is_err());
    assert_eq!(read(&cd), bad);
    assert!(!dd.join("codex-state.json").exists(), "解析失败时不应留下状态记录");
}

#[test]
fn backup_holds_the_original_file() {
    let (_t, cd, dd) = setup(Some(FIXTURE));
    codex::apply(&cd, &dd, &params("sk-NEW", "m")).unwrap();
    let backups: Vec<_> = fs::read_dir(dd.join("backups").join("codex")).unwrap().collect();
    assert_eq!(backups.len(), 1);
    assert_eq!(fs::read_to_string(backups[0].as_ref().unwrap().path()).unwrap(), FIXTURE);
}

#[cfg(unix)]
#[test]
fn file_permissions_are_preserved() {
    use std::os::unix::fs::PermissionsExt;
    let (_t, cd, dd) = setup(Some(FIXTURE));
    fs::set_permissions(cd.join("config.toml"), fs::Permissions::from_mode(0o600)).unwrap();
    codex::apply(&cd, &dd, &params("sk-NEW", "m")).unwrap();
    let mode = fs::metadata(cd.join("config.toml")).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o600);
}

#[test]
fn detects_shell_env_conflicts() {
    let t = TempDir::new().unwrap();
    fs::write(t.path().join(".zshrc"), "# export OPENAI_API_KEY=x\nexport OPENAI_BASE_URL=https://a/v1\nexport PATH=/x\n").unwrap();
    let found = codex::detect_env_conflicts(t.path());
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].1, "OPENAI_BASE_URL");
}

// ---------- auth.json：避免 Codex 停在登录页 ----------

fn auth(dir: &Path) -> Option<serde_json::Value> {
    fs::read_to_string(dir.join("auth.json")).ok().map(|t| serde_json::from_str(&t).unwrap())
}

#[test]
fn without_any_login_an_api_key_auth_is_written_and_restore_removes_it() {
    let (_t, cd, dd) = setup(Some(FIXTURE));
    codex::apply(&cd, &dd, &params("sk-NEW", "m")).unwrap();
    assert_eq!(auth(&cd).unwrap()["OPENAI_API_KEY"], "sk-NEW");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(fs::metadata(cd.join("auth.json")).unwrap().permissions().mode() & 0o777, 0o600, "含 Key 的文件只给自己读");
    }
    codex::apply(&cd, &dd, &params("sk-OTHER", "m")).unwrap(); // 切换分组：跟着换成新 Key
    assert_eq!(auth(&cd).unwrap()["OPENAI_API_KEY"], "sk-OTHER");
    codex::restore(&cd, &dd).unwrap();
    assert!(!cd.join("auth.json").exists(), "原来没有 auth.json，还原后也不应留下");
    assert_eq!(read(&cd), FIXTURE);
}

#[test]
fn a_chatgpt_login_is_never_touched() {
    let (_t, cd, dd) = setup(Some(FIXTURE));
    let original = r#"{"OPENAI_API_KEY": null, "tokens": {"id_token": "x", "access_token": "y", "refresh_token": "z"}, "last_refresh": "2026-01-01T00:00:00Z"}"#;
    fs::write(cd.join("auth.json"), original).unwrap();
    codex::apply(&cd, &dd, &params("sk-NEW", "m")).unwrap();
    codex::restore(&cd, &dd).unwrap();
    assert_eq!(fs::read_to_string(cd.join("auth.json")).unwrap(), original);
}

#[test]
fn a_users_own_api_key_is_never_touched() {
    let (_t, cd, dd) = setup(Some(FIXTURE));
    let original = r#"{"OPENAI_API_KEY": "sk-USER"}"#;
    fs::write(cd.join("auth.json"), original).unwrap();
    codex::apply(&cd, &dd, &params("sk-NEW", "m")).unwrap();
    codex::apply(&cd, &dd, &params("sk-OTHER", "m")).unwrap();
    codex::restore(&cd, &dd).unwrap();
    assert_eq!(fs::read_to_string(cd.join("auth.json")).unwrap(), original);
}

#[test]
fn a_logged_out_auth_file_is_filled_and_restored_exactly() {
    let (_t, cd, dd) = setup(Some(FIXTURE));
    // 退出 ChatGPT 登录后留下的样子：没有 tokens，还带着 chatgpt 模式标记
    let original = "{\n  \"OPENAI_API_KEY\": null,\n  \"auth_mode\": \"chatgpt\",\n  \"tokens\": null\n}\n";
    fs::write(cd.join("auth.json"), original).unwrap();
    codex::apply(&cd, &dd, &params("sk-NEW", "m")).unwrap();
    let a = auth(&cd).unwrap();
    assert_eq!(a["OPENAI_API_KEY"], "sk-NEW");
    assert!(a.get("auth_mode").is_none(), "残留的 chatgpt 模式会让 Codex 继续要求登录");
    codex::restore(&cd, &dd).unwrap();
    assert_eq!(fs::read_to_string(cd.join("auth.json")).unwrap(), original);
}

#[test]
fn logging_in_to_chatgpt_meanwhile_survives_restore() {
    let (_t, cd, dd) = setup(Some(FIXTURE));
    codex::apply(&cd, &dd, &params("sk-NEW", "m")).unwrap();
    let mine = r#"{"tokens": {"access_token": "y"}}"#;
    fs::write(cd.join("auth.json"), mine).unwrap(); // 用户之后在 Codex 里用 ChatGPT 登录了
    codex::apply(&cd, &dd, &params("sk-OTHER", "m")).unwrap();
    codex::restore(&cd, &dd).unwrap();
    assert_eq!(fs::read_to_string(cd.join("auth.json")).unwrap(), mine);
}

#[test]
fn an_unreadable_auth_file_is_left_alone() {
    let (_t, cd, dd) = setup(Some(FIXTURE));
    fs::write(cd.join("auth.json"), "not json").unwrap();
    codex::apply(&cd, &dd, &params("sk-NEW", "m")).unwrap();
    codex::restore(&cd, &dd).unwrap();
    assert_eq!(fs::read_to_string(cd.join("auth.json")).unwrap(), "not json");
}
