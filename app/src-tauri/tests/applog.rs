//! 诊断日志：写得出来、能滚动、绝不带密钥。

use std::fs;

use app_lib::applog::{redact, write_line};
use tempfile::TempDir;

#[test]
fn secrets_never_reach_the_log() {
    for (input, must_not_contain) in [
        ("key=sk-abcdef1234567890XYZ failed", "abcdef1234567890"),
        ("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig end", "eyJhbGci"),
        ("cookie new_api_refresh=Xk39sdkj2lsd0fj; Path=/", "Xk39sdkj2lsd0fj"),
        ("x-api-key: sk-live-ABCDEFGHIJKL", "ABCDEFGHIJKL"),
        ("https://x.com/v1?api_key=hunter2hunter2&a=1", "hunter2hunter2"),
        ("upstream said: invalid key sk-proj-0123456789abcdef", "0123456789abcdef"),
    ] {
        let out = redact(input);
        assert!(!out.contains(must_not_contain), "{input} -> {out}");
        assert!(out.contains("***"), "{out}");
    }
}

#[test]
fn ordinary_text_is_left_alone() {
    let s = "分组 GPT pro 下模型 gpt-5.6-sol 的可用渠道不存在 status=503 error=No available accounts";
    assert_eq!(redact(s), s);
    assert_eq!(redact("task-list sk- short"), "task-list sk- short", "太短的 sk- 不是密钥");
}

#[test]
fn lines_are_appended_with_timestamp_kind_and_one_line_each() {
    let t = TempDir::new().unwrap();
    write_line(t.path(), "probe_fail", "bestapi.io group=A\nerror=余额不足 key=sk-secretsecret123");
    write_line(t.path(), "probe_ok", "bestapi.io group=B first=440ms");
    let text = fs::read_to_string(t.path().join("ferrydeck.log")).unwrap();
    let lines: Vec<&str> = text.lines().collect();
    assert_eq!(lines.len(), 2, "换行被压平，每条一行: {text}");
    assert!(lines[0].contains("probe_fail") && lines[0].contains("余额不足") && !lines[0].contains("secretsecret123"));
    assert!(regex_like_timestamp(lines[0]), "{}", lines[0]);
}

fn regex_like_timestamp(l: &str) -> bool {
    let b = l.as_bytes();
    b.len() > 20 && b[4] == b'-' && b[7] == b'-' && b[10] == b' ' && b[13] == b':' && b[16] == b':' && b[19] == b'Z'
}

#[test]
fn the_log_rolls_over_instead_of_growing_forever() {
    let t = TempDir::new().unwrap();
    let big = "x".repeat(2000);
    for _ in 0..300 {
        write_line(t.path(), "probe_ok", &big); // ≈ 600 KB，超过 512 KB 会滚动
    }
    assert!(t.path().join("ferrydeck.log.1").exists(), "旧日志被滚动保存");
    let cur = fs::metadata(t.path().join("ferrydeck.log")).unwrap().len();
    let old = fs::metadata(t.path().join("ferrydeck.log.1")).unwrap().len();
    assert!(cur + old < 1_300_000, "总量有上限: {cur} + {old}");
}

#[cfg(unix)]
#[test]
fn the_log_is_private() {
    use std::os::unix::fs::PermissionsExt;
    let t = TempDir::new().unwrap();
    write_line(t.path(), "probe_ok", "x");
    assert_eq!(fs::metadata(t.path().join("ferrydeck.log")).unwrap().permissions().mode() & 0o777, 0o600);
}
