//! 终端手动测试 Claude Code 写入。默认操作真实的 ~/.claude，可用 --claude-dir / --data-dir 指向别处。
//! 注意：不要在正在使用的 Claude Code 会话里对真实目录执行 apply，请在单独终端并先自行备份。
//!
//!   cargo run -q --example claude_cli -- status
//!   BESTAPI_KEY=sk-xxx cargo run -q --example claude_cli -- apply [--model <模型>]
//!   cargo run -q --example claude_cli -- restore
use app_lib::clients::claude::{self, Params};
use std::path::PathBuf;

fn arg(a: &[String], n: &str) -> Option<String> {
    a.iter().position(|x| x == n).and_then(|i| a.get(i + 1)).cloned()
}

fn die<T: std::fmt::Display, R>(e: T) -> R {
    eprintln!("错误: {e}");
    std::process::exit(1)
}

fn main() {
    let a: Vec<String> = std::env::args().skip(1).collect();
    let home = PathBuf::from(std::env::var("HOME").expect("HOME"));
    let cd = arg(&a, "--claude-dir").map(PathBuf::from).unwrap_or(home.join(".claude"));
    let dd = arg(&a, "--data-dir").map(PathBuf::from).unwrap_or(home.join("Library/Application Support/Ferrydeck"));
    match a.first().map(String::as_str) {
        Some("status") => {
            println!("{:#?}", claude::status(&cd, &dd).unwrap_or_else(|e| die(e)));
            for c in claude::detect_conflicts(&home, &cd) {
                println!("⚠ 可能覆盖配置: {c}");
            }
        }
        Some("apply") => {
            let key = std::env::var("BESTAPI_KEY").unwrap_or_else(|_| die("请用环境变量 BESTAPI_KEY 传入 Key"));
            let base = arg(&a, "--base-url").unwrap_or("https://relay.example.com".into());
            let model = arg(&a, "--model");
            claude::apply(&cd, &dd, &Params { base_url: &base, api_key: &key, model: model.as_deref() }).unwrap_or_else(|e| die(e));
            println!("已写入 {}，备份在 {}/backups/claude/", cd.join("settings.json").display(), dd.display());
        }
        Some("restore") => {
            claude::restore(&cd, &dd).unwrap_or_else(|e| die(e));
            println!("已还原");
        }
        _ => die("用法: status | apply [--model <模型>] | restore"),
    }
}
