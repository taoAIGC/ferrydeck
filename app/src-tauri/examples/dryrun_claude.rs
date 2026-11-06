//! 用法: cargo run --example dryrun_claude -- <真实 settings.json 路径>
//! 只在临时目录里演练 apply/restore，不修改原文件，输出不含任何值。
use app_lib::clients::claude::{self, Params};
use std::fs;

fn main() {
    let src = std::env::args().nth(1).expect("需要 settings.json 路径");
    let original = fs::read_to_string(&src).unwrap();
    let tmp = std::env::temp_dir().join(format!("ferrydeck-dryrun-claude-{}", std::process::id()));
    let (cd, dd) = (tmp.join(".claude"), tmp.join("data"));
    fs::create_dir_all(&cd).unwrap();
    fs::write(cd.join("settings.json"), &original).unwrap();

    claude::apply(&cd, &dd, &Params { base_url: "https://relay.example.com", api_key: "sk-DRYRUN-NOT-REAL", model: Some("claude-sonnet-4-6") }).unwrap();
    let after = fs::read_to_string(cd.join("settings.json")).unwrap();
    let (o, a): (serde_json::Value, serde_json::Value) = (serde_json::from_str(&original).unwrap(), serde_json::from_str(&after).unwrap());
    println!("== 状态: {:?}", claude::status(&cd, &dd).unwrap());
    println!("== 行数 原 {} -> 写入后 {}", original.lines().count(), after.lines().count());
    let mut diff = vec![];
    for (k, v) in a.as_object().unwrap() {
        if k == "env" {
            for (ek, ev) in v.as_object().unwrap() {
                if o["env"].get(ek) != Some(ev) { diff.push(format!("env.{ek}")); }
            }
        } else if o.get(k) != Some(v) { diff.push(k.clone()); }
    }
    println!("== 内容有变化的键（仅键名）: {diff:?}");
    println!("== 顶层键顺序不变: {}", o.as_object().unwrap().keys().eq(a.as_object().unwrap().keys().filter(|k| o.get(k.as_str()).is_some())));
    claude::restore(&cd, &dd).unwrap();
    let restored = fs::read_to_string(cd.join("settings.json")).unwrap();
    println!("== 还原后与原文件逐字一致: {}", restored == original);
    println!("== 冲突检测: {:?}", claude::detect_conflicts(&std::path::PathBuf::from(std::env::var("HOME").unwrap()), &cd).len());
    let _ = fs::remove_dir_all(&tmp);
}
