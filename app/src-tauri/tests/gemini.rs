use std::fs;
use std::path::{Path, PathBuf};

use app_lib::clients::gemini::{self, Params};
use tempfile::TempDir;

const DOTENV: &str = include_str!("fixtures/gemini/dotenv");
const SETTINGS: &str = include_str!("fixtures/gemini/settings.json");

fn p<'a>(key: &'a str, model: Option<&'a str>) -> Params<'a> {
    Params { base_url: "https://relay.example.com", api_key: key, model }
}

fn setup(env: Option<&str>, settings: Option<&str>) -> (TempDir, PathBuf, PathBuf) {
    let t = TempDir::new().unwrap();
    let gd = t.path().join(".gemini");
    let dd = t.path().join("data");
    fs::create_dir_all(&gd).unwrap();
    if let Some(c) = env {
        fs::write(gd.join(".env"), c).unwrap();
    }
    if let Some(c) = settings {
        fs::write(gd.join("settings.json"), c).unwrap();
    }
    (t, gd, dd)
}

fn rd(d: &Path, f: &str) -> String {
    fs::read_to_string(d.join(f)).unwrap()
}

#[test]
fn apply_edits_only_our_lines_and_settings_key() {
    let (_t, gd, dd) = setup(Some(DOTENV), Some(SETTINGS));
    gemini::apply(&gd, &dd, &p("sk-NEW", Some("gemini-3.5-flash"))).unwrap();
    let env = rd(&gd, ".env");
    assert!(env.contains("# 我自己的 Gemini 配置：注释应原样保留"));
    assert!(env.contains("HTTP_PROXY=http://127.0.0.1:7890"));
    assert!(env.contains("SOME_OTHER_VAR=hello world"));
    assert!(env.contains("export GEMINI_API_KEY=sk-NEW"), "应就地替换并保留 export 前缀: {env}");
    assert!(env.contains("GEMINI_MODEL=gemini-3.5-flash") && !env.contains("gemini-2.5-pro"));
    assert!(env.contains("GOOGLE_GEMINI_BASE_URL=https://relay.example.com"));
    assert_eq!(env.matches("GEMINI_API_KEY").count(), 1);

    let s: serde_json::Value = serde_json::from_str(&rd(&gd, "settings.json")).unwrap();
    let o: serde_json::Value = serde_json::from_str(SETTINGS).unwrap();
    assert_eq!(s["security"]["auth"]["selectedType"], "gemini-api-key");
    assert_eq!(s["security"]["auth"]["enforcedType"], "oauth-personal", "同级其他键保留");
    assert_eq!(s["security"]["folderTrust"], true);
    assert_eq!(s["mcpServers"], o["mcpServers"]);
    assert_eq!(s["ui"], o["ui"]);
}

#[test]
fn restore_returns_both_files_to_original_text() {
    let (_t, gd, dd) = setup(Some(DOTENV), Some(SETTINGS));
    gemini::apply(&gd, &dd, &p("sk-NEW", Some("m"))).unwrap();
    gemini::restore(&gd, &dd).unwrap();
    assert_eq!(rd(&gd, ".env"), DOTENV);
    assert_eq!(rd(&gd, "settings.json"), SETTINGS);
    assert!(!gemini::status(&gd, &dd).unwrap().has_backup);
}

#[test]
fn files_we_created_are_removed_on_restore() {
    let (_t, gd, dd) = setup(None, None);
    gemini::apply(&gd, &dd, &p("sk-NEW", None)).unwrap();
    let s = gemini::status(&gd, &dd).unwrap();
    assert!(s.in_use && s.has_key && s.auth_type.as_deref() == Some("gemini-api-key"));
    gemini::restore(&gd, &dd).unwrap();
    assert!(!gd.join(".env").exists());
    assert!(!gd.join("settings.json").exists());
}

#[test]
fn settings_without_security_is_restored_exactly() {
    let orig = "{\n  \"mcpServers\": {}\n}\n"; // 与本机实际情况类似
    let (_t, gd, dd) = setup(None, Some(orig));
    gemini::apply(&gd, &dd, &p("sk-NEW", None)).unwrap();
    gemini::restore(&gd, &dd).unwrap();
    assert_eq!(rd(&gd, "settings.json"), orig);
    assert!(!gd.join(".env").exists());
}

#[test]
fn apply_twice_keeps_first_original() {
    let (_t, gd, dd) = setup(Some(DOTENV), Some(SETTINGS));
    gemini::apply(&gd, &dd, &p("sk-ONE", Some("m1"))).unwrap();
    gemini::apply(&gd, &dd, &p("sk-TWO", None)).unwrap();
    let env = rd(&gd, ".env");
    assert!(env.contains("sk-TWO") && !env.contains("sk-ONE"));
    gemini::restore(&gd, &dd).unwrap();
    assert_eq!(rd(&gd, ".env"), DOTENV);
    assert_eq!(rd(&gd, "settings.json"), SETTINGS);
}

#[test]
fn restore_keeps_what_the_user_changed() {
    let (_t, gd, dd) = setup(Some(DOTENV), Some(SETTINGS));
    gemini::apply(&gd, &dd, &p("sk-NEW", Some("m"))).unwrap();
    let env = rd(&gd, ".env").replace("export GEMINI_API_KEY=sk-NEW", "export GEMINI_API_KEY=user-own") + "NEW_VAR=1\n";
    fs::write(gd.join(".env"), env).unwrap();
    gemini::restore(&gd, &dd).unwrap();
    let after = rd(&gd, ".env");
    assert!(after.contains("GEMINI_API_KEY=user-own"), "用户改过的行不能被覆盖");
    assert!(after.contains("NEW_VAR=1"));
    assert!(!after.contains("GOOGLE_GEMINI_BASE_URL"), "我们新增且未被改动的行应清掉");
    assert!(after.contains("GEMINI_MODEL=gemini-2.5-pro"), "没被用户改的行应还原为原值");
}

#[test]
fn file_without_trailing_newline_and_crlf_free_roundtrip() {
    let orig = "A=1\nB=2"; // 无结尾换行
    let (_t, gd, dd) = setup(Some(orig), None);
    gemini::apply(&gd, &dd, &p("sk-NEW", None)).unwrap();
    assert!(!rd(&gd, ".env").ends_with('\n'));
    gemini::restore(&gd, &dd).unwrap();
    assert_eq!(rd(&gd, ".env"), orig);
}

#[test]
fn invalid_settings_json_blocks_everything_and_leaves_env_untouched() {
    let (_t, gd, dd) = setup(Some(DOTENV), Some("{ broken"));
    assert!(gemini::apply(&gd, &dd, &p("sk-NEW", None)).is_err());
    assert_eq!(rd(&gd, ".env"), DOTENV, ".env 不能在 settings 失败时被改");
    assert_eq!(rd(&gd, "settings.json"), "{ broken");
    assert!(!dd.join("gemini-state.json").exists());
}

#[test]
fn wrongly_typed_security_is_rejected_without_touching_env() {
    let (_t, gd, dd) = setup(Some(DOTENV), Some("{\"security\": 5}"));
    assert!(gemini::apply(&gd, &dd, &p("sk-NEW", None)).is_err());
    assert_eq!(rd(&gd, ".env"), DOTENV);
}

#[test]
fn newline_in_value_is_rejected() {
    let (_t, gd, dd) = setup(Some(DOTENV), None);
    assert!(gemini::apply(&gd, &dd, &p("sk-A\nINJECT=1", None)).is_err());
    assert_eq!(rd(&gd, ".env"), DOTENV);
}

#[test]
fn restore_without_apply_is_an_error() {
    let (_t, gd, dd) = setup(Some(DOTENV), Some(SETTINGS));
    assert!(gemini::restore(&gd, &dd).is_err());
    assert_eq!(rd(&gd, ".env"), DOTENV);
}

#[test]
fn backups_hold_both_originals() {
    let (_t, gd, dd) = setup(Some(DOTENV), Some(SETTINGS));
    gemini::apply(&gd, &dd, &p("sk-NEW", None)).unwrap();
    let mut got: Vec<String> = fs::read_dir(dd.join("backups").join("gemini"))
        .unwrap()
        .map(|e| fs::read_to_string(e.unwrap().path()).unwrap())
        .collect();
    got.sort();
    let mut want = vec![DOTENV.to_string(), SETTINGS.to_string()];
    want.sort();
    assert_eq!(got, want);
}

#[test]
fn detects_conflicts() {
    let t = TempDir::new().unwrap();
    let gd = t.path().join(".gemini");
    fs::create_dir_all(&gd).unwrap();
    fs::write(t.path().join(".zshrc"), "# export GEMINI_API_KEY=x\nexport GOOGLE_GENAI_USE_VERTEXAI=true\n").unwrap();
    fs::write(gd.join(".env"), "GOOGLE_API_KEY=k\n").unwrap();
    let found = gemini::detect_conflicts(t.path(), &gd);
    assert_eq!(found.len(), 2, "{found:?}");
}

#[cfg(unix)]
#[test]
fn permissions_are_preserved() {
    use std::os::unix::fs::PermissionsExt;
    let (_t, gd, dd) = setup(Some(DOTENV), Some(SETTINGS));
    fs::set_permissions(gd.join(".env"), fs::Permissions::from_mode(0o600)).unwrap();
    gemini::apply(&gd, &dd, &p("sk-NEW", None)).unwrap();
    assert_eq!(fs::metadata(gd.join(".env")).unwrap().permissions().mode() & 0o777, 0o600);
}

#[test]
fn switching_group_without_model_does_not_leave_old_model_behind() {
    let (_t, gd, dd) = setup(Some(DOTENV), Some(SETTINGS));
    gemini::apply(&gd, &dd, &p("sk-A", Some("gemini-3.5-flash"))).unwrap();
    gemini::apply(&gd, &dd, &p("sk-B", None)).unwrap();
    assert!(rd(&gd, ".env").contains("GEMINI_MODEL=gemini-2.5-pro"), "应撤回到用户原来的模型");
}
