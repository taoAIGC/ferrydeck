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
