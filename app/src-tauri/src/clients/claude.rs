//! 把Ferrydeck里的分组写进 Claude Code 的 `~/.claude/settings.json`，并能精确撤销。
//!
//! 设计要点：
//! - 只管三项 env：`ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN`，以及可选的 `ANTHROPIC_MODEL`（与站点文档一致，
//!   且优先于用户 settings 里的顶层 `model`，所以不去动用户自己的 `model`）。其余键的内容、顺序、缩进都原样保留。
//! - 首次写入前备份整份原文件，并记录这三项的原值；重复写入不会覆盖“原始状态”。
//! - 写完立刻重新读取自检（合法 JSON、我们的值在、其他内容没变），不通过就自动回滚到写入前。
//! - 还原只撤销我们写的值：若某项已被用户改成别的值，就不去覆盖用户的选择。

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub use super::common::Error;
use super::common::{backup_file, clear_state, fnv, load_state, parse_root, save_state, write_checked, Layout};

const STATE_FILE: &str = "claude-state.json";
const K_BASE: &str = "ANTHROPIC_BASE_URL";
const K_TOKEN: &str = "ANTHROPIC_AUTH_TOKEN";
const K_MODEL: &str = "ANTHROPIC_MODEL";

pub struct Params<'a> {
    pub base_url: &'a str, // 例如 https://relay.example.com（Claude Code 会自己拼 /v1/messages）
    pub api_key: &'a str,
    pub model: Option<&'a str>,
}

#[derive(Debug, Serialize, Deserialize, Default, Clone, PartialEq)]
struct Original {
    base_url: Option<String>,
    token: Option<String>,
    model: Option<String>,
    /// 原文件里是否已经有 `env` 对象（没有的话，还原时要把空 env 一并删掉）。
    had_env: bool,
    backup_file: Option<PathBuf>,
}

/// 我们最近一次写入的值，还原时用来判断“当前值是不是还是我们写的”。
#[derive(Debug, Serialize, Deserialize, Default, Clone)]
struct Written {
    base_url: String,
    token: String,
    model: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Default)]
struct State {
    original: Option<Original>,
    written: Option<Written>,
    /// 我们最近一次写出的整份文件的哈希；还原时若文件没被改过，就逐字写回备份。
    written_hash: Option<u64>,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct Status {
    pub config_exists: bool,
    pub base_url: Option<String>,
    pub model: Option<String>,
    pub has_token: bool,
    /// 当前 base_url 是否指向我们写入的地址。
    pub in_use: bool,
    pub has_backup: bool,
}

pub fn apply(claude_dir: &Path, data_dir: &Path, p: &Params) -> Result<(), Error> {
    let cfg = claude_dir.join("settings.json");
    let text = if cfg.exists() { fs::read_to_string(&cfg)? } else { String::new() };
    let mut root = parse_root(&text)?;
    let layout = Layout::detect(&text);

    let mut state = load_state::<State>(data_dir, STATE_FILE)?;
    if state.original.is_none() {
        let env = root.get("env").and_then(Value::as_object);
        let get = |k: &str| env.and_then(|e| e.get(k)).and_then(Value::as_str).map(String::from);
        let backup = if cfg.exists() { Some(backup_file(data_dir, "claude", &cfg, &text)?) } else { None };
        state.original = Some(Original {
            base_url: get(K_BASE),
            token: get(K_TOKEN),
            model: get(K_MODEL),
            had_env: env.is_some(),
            backup_file: backup,
        });
    }
    // 本次不指定 model：若 ANTHROPIC_MODEL 仍是上次我们写的，先撤回原值，避免上一个分组的模型残留。
    if p.model.is_none() {
        if let (Some(w), Some(o)) = (state.written.as_ref().and_then(|w| w.model.as_deref()), state.original.as_ref()) {
            if let Some(env) = root.get_mut("env").and_then(Value::as_object_mut) {
                revert_key(env, K_MODEL, w, o.model.as_deref());
            }
        }
    }
    state.written = Some(Written {
        base_url: p.base_url.to_string(),
        token: p.api_key.to_string(),
        model: p.model.map(String::from),
    });
    // 先写自检通过的配置，再落盘状态，避免“状态说写过了但文件没写成”。
    let before = root.clone();

    let env = root.entry("env").or_insert_with(|| Value::Object(Map::new()));
    let env = env.as_object_mut().ok_or_else(|| Error::Parse("`env` 不是对象".into()))?;
    env.insert(K_BASE.into(), Value::String(p.base_url.into()));
    env.insert(K_TOKEN.into(), Value::String(p.api_key.into()));
    if let Some(m) = p.model {
        env.insert(K_MODEL.into(), Value::String(m.into()));
    }

    write_checked(&cfg, &text, &root, &layout, |after| {
        verify_applied(&before, after, p)
    })?;
    state.written_hash = fs::read_to_string(&cfg).ok().map(|t| fnv(&t));
    save_state(data_dir, STATE_FILE, &state)
}

pub fn restore(claude_dir: &Path, data_dir: &Path) -> Result<(), Error> {
    let state = load_state::<State>(data_dir, STATE_FILE)?;
    let orig = state.original.clone().ok_or_else(|| Error::State("没有可还原的记录（尚未写入过）".into()))?;
    let written = state.written.unwrap_or_default();
    let cfg = claude_dir.join("settings.json");
    if !cfg.exists() {
        return clear_state(data_dir, STATE_FILE);
    }
    let text = fs::read_to_string(&cfg)?;
    // 文件自上次写入后没人动过：直接把备份的原文逐字写回，格式也完全一致。
    if state.written_hash == Some(fnv(&text)) {
        if let Some(b) = orig.backup_file.as_ref().filter(|b| b.exists()) {
            super::common::write_atomic(&cfg, &fs::read_to_string(b)?)?;
            return clear_state(data_dir, STATE_FILE);
        }
    }
    let mut root = parse_root(&text)?;
    let layout = Layout::detect(&text);

    if let Some(env) = root.get_mut("env").and_then(Value::as_object_mut) {
        revert_key(env, K_BASE, &written.base_url, orig.base_url.as_deref());
        revert_key(env, K_TOKEN, &written.token, orig.token.as_deref());
        if let Some(w) = written.model.as_deref() {
            revert_key(env, K_MODEL, w, orig.model.as_deref());
        }
    }
    if !orig.had_env && root.get("env").and_then(Value::as_object).is_some_and(|e| e.is_empty()) {
        root.shift_remove("env");
    }

    write_checked(&cfg, &text, &root, &layout, |_| Ok(()))?;
    clear_state(data_dir, STATE_FILE)
}

pub fn status(claude_dir: &Path, data_dir: &Path) -> Result<Status, Error> {
    let state = load_state::<State>(data_dir, STATE_FILE)?;
    let has_backup = state.original.is_some();
    let cfg = claude_dir.join("settings.json");
    if !cfg.exists() {
        return Ok(Status { config_exists: false, base_url: None, model: None, has_token: false, in_use: false, has_backup });
    }
    let root = parse_root(&fs::read_to_string(&cfg)?)?;
    let env = root.get("env").and_then(Value::as_object);
    let base_url = env.and_then(|e| e.get(K_BASE)).and_then(Value::as_str).map(String::from);
    let in_use = match (&base_url, &state.written) {
        (Some(b), Some(w)) => *b == w.base_url,
        _ => false,
    };
    Ok(Status {
        config_exists: true,
        has_token: env.is_some_and(|e| e.contains_key(K_TOKEN)),
        model: env.and_then(|e| e.get(K_MODEL)).and_then(Value::as_str).map(String::from),
        base_url,
        in_use,
        has_backup,
    })
}

/// 会覆盖 settings.json 的其他来源：shell 环境变量、`settings.local.json` 里的 env。
pub fn detect_conflicts(home: &Path, claude_dir: &Path) -> Vec<String> {
    const FILES: [&str; 5] = [".zshrc", ".zprofile", ".zshenv", ".bash_profile", ".bashrc"];
    const VARS: [&str; 3] = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"];
    let mut out = vec![];
    for f in FILES {
        let path = home.join(f);
        let Ok(s) = fs::read_to_string(&path) else { continue };
        for line in s.lines() {
            let l = line.trim_start();
            if l.starts_with('#') {
                continue;
            }
            for v in VARS {
                if l.contains(&format!("{v}=")) && (l.starts_with("export ") || l.starts_with(v)) {
                    out.push(format!("{}: {v}", path.display()));
                }
            }
        }
    }
    let local = claude_dir.join("settings.local.json");
    if let Ok(s) = fs::read_to_string(&local) {
        if let Ok(root) = parse_root(&s) {
            if let Some(env) = root.get("env").and_then(Value::as_object) {
                for v in VARS {
                    if env.contains_key(v) {
                        out.push(format!("{}: env.{v}", local.display()));
                    }
                }
            }
        }
    }
    // settings.json 自己的 ANTHROPIC_API_KEY 会与 AUTH_TOKEN 并存，Claude Code 优先用 API_KEY。
    if let Ok(s) = fs::read_to_string(claude_dir.join("settings.json")) {
        if let Ok(root) = parse_root(&s) {
            if root.get("env").and_then(Value::as_object).is_some_and(|e| e.contains_key("ANTHROPIC_API_KEY")) {
                out.push(format!("{}: env.ANTHROPIC_API_KEY", claude_dir.join("settings.json").display()));
            }
        }
    }
    out
}

// ---------- 内部工具 ----------

/// 只有“当前值仍是我们写的”才还原；原来没有这项就删除，原来有就改回原值。
fn revert_key(env: &mut Map<String, Value>, key: &str, written: &str, original: Option<&str>) {
    if env.get(key).and_then(Value::as_str) != Some(written) {
        return;
    }
    match original {
        Some(v) => {
            env.insert(key.into(), Value::String(v.into()));
        }
        None => {
            env.shift_remove(key);
        }
    }
}

/// 写入后检查：我们的值在；除我们管的三项外，其他内容与写入前完全一致。
fn verify_applied(before: &Map<String, Value>, after: &Map<String, Value>, p: &Params) -> Result<(), String> {
    let env = after.get("env").and_then(Value::as_object).ok_or("缺少 env")?;
    if env.get(K_BASE).and_then(Value::as_str) != Some(p.base_url) {
        return Err("ANTHROPIC_BASE_URL 没有写入".into());
    }
    if env.get(K_TOKEN).and_then(Value::as_str) != Some(p.api_key) {
        return Err("ANTHROPIC_AUTH_TOKEN 没有写入".into());
    }
    if let Some(m) = p.model {
        if env.get(K_MODEL).and_then(Value::as_str) != Some(m) {
            return Err("ANTHROPIC_MODEL 没有写入".into());
        }
    }
    let strip = |m: &Map<String, Value>| {
        let mut m = m.clone();
        if let Some(e) = m.get_mut("env").and_then(Value::as_object_mut) {
            e.shift_remove(K_BASE);
            e.shift_remove(K_TOKEN);
            e.shift_remove(K_MODEL);
            if e.is_empty() {
                m.shift_remove("env");
            }
        }
        m
    };
    let (b, a) = (strip(before), strip(after));
    if b != a {
        return Err("其他配置项在写入过程中发生了变化".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failed_self_check_rolls_back_to_previous_content() {
        let dir = tempfile::TempDir::new().unwrap();
        let cfg = dir.path().join("settings.json");
        let old = "{\n  \"keep\": 1\n}\n";
        fs::write(&cfg, old).unwrap();
        let mut root = parse_root(old).unwrap();
        root.insert("env".into(), serde_json::json!({"x": 1}));
        let err = write_checked(&cfg, old, &root, &Layout::detect(old), |_| Err("模拟自检失败".into())).unwrap_err();
        assert!(matches!(err, Error::Verify(_)));
        assert_eq!(fs::read_to_string(&cfg).unwrap(), old, "自检失败必须把原内容写回");
    }

    #[test]
    fn failed_self_check_on_new_file_removes_it() {
        let dir = tempfile::TempDir::new().unwrap();
        let cfg = dir.path().join("settings.json");
        let root = Map::new();
        assert!(write_checked(&cfg, "", &root, &Layout::detect(""), |_| Err("x".into())).is_err());
        assert!(!cfg.exists());
    }

    #[test]
    fn verify_catches_unrelated_changes() {
        let before = parse_root("{\"a\":1,\"env\":{}}").unwrap();
        let after = parse_root("{\"a\":2,\"env\":{\"ANTHROPIC_BASE_URL\":\"u\",\"ANTHROPIC_AUTH_TOKEN\":\"k\"}}").unwrap();
        let p = Params { base_url: "u", api_key: "k", model: None };
        assert!(verify_applied(&before, &after, &p).is_err());
    }
}
