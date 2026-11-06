//! 终端手动测试 Codex 写入。默认操作真实的 ~/.codex，可用 --codex-dir / --data-dir 指向别处。
//!
//!   cargo run -q --example codex_cli -- status
//!   BESTAPI_KEY=sk-xxx cargo run -q --example codex_cli -- apply --model gpt-5.6-sol
//!   cargo run -q --example codex_cli -- restore
use app_lib::clients::codex::{self, Params};
use std::path::PathBuf;

fn arg(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned()
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let home = PathBuf::from(std::env::var("HOME").expect("HOME"));
    let cd = arg(&args, "--codex-dir").map(PathBuf::from).unwrap_or(home.join(".codex"));
    let dd = arg(&args, "--data-dir").map(PathBuf::from).unwrap_or(home.join("Library/Application Support/Ferrydeck"));
    match args.first().map(String::as_str) {
        Some("status") => {
            println!("{:#?}", codex::status(&cd, &dd).unwrap_or_else(|e| die(e)));
            for (f, v) in codex::detect_env_conflicts(&home) {
                println!("⚠ shell 里设置了 {v}（{}），可能覆盖 Codex 配置", f.display());
            }
        }
        Some("apply") => {
            let key = std::env::var("BESTAPI_KEY").unwrap_or_else(|_| die("请用环境变量 BESTAPI_KEY 传入 Key"));
            let model = arg(&args, "--model").unwrap_or_else(|| die("需要 --model"));
            let base = arg(&args, "--base-url").unwrap_or("https://relay.example.com/v1".into());
            codex::apply(&cd, &dd, &Params { base_url: &base, api_key: &key, model: &model, provider_display_name: "Ferrydeck" }).unwrap_or_else(|e| die(e));
            println!("已写入 {}，备份在 {}/backups/codex/", cd.join("config.toml").display(), dd.display());
        }
        Some("restore") => {
            codex::restore(&cd, &dd).unwrap_or_else(|e| die(e));
            println!("已还原");
        }
        _ => die("用法: status | apply --model <模型> | restore"),
    }
}

fn die<T: std::fmt::Display, R>(e: T) -> R {
    eprintln!("错误: {e}");
    std::process::exit(1)
}
