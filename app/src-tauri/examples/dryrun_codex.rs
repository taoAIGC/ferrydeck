//! 用法: cargo run --example dryrun_codex -- <真实 config.toml 路径>
//! 只在临时目录里演练 apply/restore，不修改原文件。
use app_lib::clients::codex::{self, Params};
use std::fs;

fn main() {
    let src = std::env::args().nth(1).expect("需要 config.toml 路径");
    let original = fs::read_to_string(&src).unwrap();
    let tmp = std::env::temp_dir().join(format!("ferrydeck-dryrun-{}", std::process::id()));
    let (cd, dd) = (tmp.join(".codex"), tmp.join("data"));
    fs::create_dir_all(&cd).unwrap();
    fs::write(cd.join("config.toml"), &original).unwrap();

    codex::apply(&cd, &dd, &Params { base_url: "https://relay.example.com/v1", api_key: "sk-DRYRUN-NOT-REAL", model: "gpt-5.6-sol", provider_display_name: "BestAPI" }).unwrap();
    let after = fs::read_to_string(cd.join("config.toml")).unwrap();
    println!("== 状态: {:?}", codex::status(&cd, &dd).unwrap());
    let (o, a): (Vec<_>, Vec<_>) = (original.lines().collect(), after.lines().collect());
    println!("== 行数 原 {} -> 写入后 {}", o.len(), a.len());
    println!("== 写入后新增的行:");
    for l in a.iter().filter(|l| !o.contains(l)) { println!("  + {l}"); }
    println!("== 写入后消失的行:");
    for l in o.iter().filter(|l| !a.contains(l)) { println!("  - {}", l.split("experimental_bearer_token").next().unwrap()); }

    codex::restore(&cd, &dd).unwrap();
    let restored = fs::read_to_string(cd.join("config.toml")).unwrap();
    println!("== 还原后与原文件逐字一致: {}", restored == original);
    let _ = fs::remove_dir_all(&tmp);
}
