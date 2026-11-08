//! 登录凭据的本地保存：0600 文件的读写、覆盖、删除。

use std::fs;

use app_lib::session_store;
use tempfile::TempDir;

fn data() -> (TempDir, std::path::PathBuf) {
    let t = TempDir::new().unwrap();
    let d = t.path().join("Application Support/Ferrydeck");
    (t, d)
}

#[test]
fn save_load_and_clear_roundtrip() {
    let (_t, dir) = data();
    assert_eq!(session_store::load(&dir, "site1"), None);
    session_store::save(&dir, "site1", "ref1");
    session_store::save(&dir, "site2", "cookie2");
    assert_eq!(session_store::load(&dir, "site1").as_deref(), Some("ref1"));
    assert_eq!(session_store::load(&dir, "site2").as_deref(), Some("cookie2"));
    // 令牌轮换后覆盖同一个站点，不影响其他站点
    session_store::save(&dir, "site1", "ref1-rotated");
    assert_eq!(session_store::load(&dir, "site1").as_deref(), Some("ref1-rotated"));
    assert_eq!(session_store::load(&dir, "site2").as_deref(), Some("cookie2"));
    session_store::clear(&dir, "site1");
    assert_eq!(session_store::load(&dir, "site1"), None);
    assert_eq!(session_store::load(&dir, "site2").as_deref(), Some("cookie2"));
}

#[cfg(unix)]
#[test]
fn the_file_is_only_readable_by_the_owner() {
    use std::os::unix::fs::PermissionsExt;
    let (_t, dir) = data();
    session_store::save(&dir, "site1", "secret");
    let path = dir.join("sessions.json");
    let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o600, "文件里有刷新令牌，只能自己读写");
    assert!(!dir.join(".sessions.json.tmp").exists(), "临时文件不应留下");
}

#[test]
fn a_corrupt_file_does_not_break_login() {
    let (_t, dir) = data();
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("sessions.json"), "不是 JSON").unwrap();
    assert_eq!(session_store::load(&dir, "site1"), None);
    session_store::save(&dir, "site1", "ref1"); // 覆盖成合法内容
    assert_eq!(session_store::load(&dir, "site1").as_deref(), Some("ref1"));
}
