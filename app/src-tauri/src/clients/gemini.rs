//! 把Ferrydeck里的分组写进 Gemini CLI：`~/.gemini/.env` 与 `~/.gemini/settings.json`。
//!
//! - `.env`：只管 `GEMINI_API_KEY`、`GOOGLE_GEMINI_BASE_URL`，以及可选的 `GEMINI_MODEL`。
//!   原有的注释、空行、其他变量、`export ` 前缀都原样保留；已有的同名行就地替换。
//! - `settings.json`：只设 `security.auth.selectedType = "gemini-api-key"`，让 CLI 走 API Key 登录。
//! - 首次写入前备份两个文件并记录原值；两个文件要么都写成功，要么都回到写入前。
//! - 还原只撤销我们写的行/值；用户之后自己改过的不覆盖。

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub use super::common::Error;
use super::common::{backup_file, clear_state, fnv, load_state, parse_root, save_state, write_atomic, write_checked, Layout};

const STATE_FILE: &str = "gemini-state.json";
const K_KEY: &str = "GEMINI_API_KEY";
const K_BASE: &str = "GOOGLE_GEMINI_BASE_URL";
const K_MODEL: &str = "GEMINI_MODEL";
const AUTH_TYPE: &str = "gemini-api-key";

pub struct Params<'a> {
    pub base_url: &'a str, // https://relay.example.com（CLI 自己补 /v1beta）
    pub api_key: &'a str,
    pub model: Option<&'a str>,
}

#[derive(Debug, Serialize, Deserialize, Default, Clone)]
struct Original {
    /// 每个受管变量原来的整行文本（含 export 前缀、引号）；None 表示原来没有。
    env_lines: BTreeMap<String, Option<String>>,
    had_env_file: bool,
    selected_type: Option<Value>,
    had_settings_file: bool,
    had_security: bool,
    had_auth: bool,
    backups: Vec<PathBuf>,
    settings_backup: Option<PathBuf>,
}

#[derive(Debug, Serialize, Deserialize, Default, Clone)]
struct Written {
    /// 我们写下的整行文本，还原时用来判断“这一行是不是还是我们写的”。
    env_lines: BTreeMap<String, String>,
}

#[derive(Debug, Serialize, Deserialize, Default)]
struct State {
    original: Option<Original>,
    written: Option<Written>,
    settings_hash: Option<u64>,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct Status {
    pub env_exists: bool,
    pub base_url: Option<String>,
    pub model: Option<String>,
    pub has_key: bool,
    pub auth_type: Option<String>,
    pub in_use: bool,
    pub has_backup: bool,
}

pub fn apply(gemini_dir: &Path, data_dir: &Path, p: &Params) -> Result<(), Error> {
    for v in [p.base_url, p.api_key] {
        if v.contains('\n') || v.contains('\r') {
            return Err(Error::Parse("值里不能包含换行".into()));
        }
    }
    let env_path = gemini_dir.join(".env");
    let set_path = gemini_dir.join("settings.json");
    let env_text = if env_path.exists() { fs::read_to_string(&env_path)? } else { String::new() };
    let set_text = if set_path.exists() { fs::read_to_string(&set_path)? } else { String::new() };
    // 两个文件都先解析，任何一个有问题就在动手前报错。
    let mut root = parse_root(&set_text)?;
    let layout = Layout::detect(&set_text);
    let mut env = EnvFile::parse(&env_text);

    let mut state = load_state::<State>(data_dir, STATE_FILE)?;
    if state.original.is_none() {
        let mut backups = vec![];
        if env_path.exists() {
            backups.push(backup_file(data_dir, "gemini", &env_path, &env_text)?);
        }
        let mut settings_backup = None;
        if set_path.exists() {
            let b = backup_file(data_dir, "gemini", &set_path, &set_text)?;
            backups.push(b.clone());
            settings_backup = Some(b);
        }
        let sec = root.get("security").and_then(Value::as_object);
        let auth = sec.and_then(|s| s.get("auth")).and_then(Value::as_object);
        let mut env_lines = BTreeMap::new();
        for k in [K_KEY, K_BASE, K_MODEL] {
            env_lines.insert(k.to_string(), env.find(k).map(|i| env.lines[i].clone()));
        }
        state.original = Some(Original {
            env_lines,
            had_env_file: env_path.exists(),
            selected_type: auth.and_then(|a| a.get("selectedType")).cloned(),
            had_settings_file: set_path.exists(),
            had_security: sec.is_some(),
            had_auth: auth.is_some(),
            backups,
            settings_backup,
        });
    }

    // 本次不指定模型：若 GEMINI_MODEL 仍是上次我们写的，先撤回原值，避免上一个分组的模型残留。
    if p.model.is_none() {
        let prev = state.written.as_ref().and_then(|w| w.env_lines.get(K_MODEL)).cloned();
        let orig_line = state.original.as_ref().and_then(|o| o.env_lines.get(K_MODEL)).cloned().flatten();
        if let (Some(prev), Some(i)) = (prev, env.find(K_MODEL)) {
            if env.lines[i] == prev {
                match orig_line {
                    Some(l) => env.lines[i] = l,
                    None => {
                        env.lines.remove(i);
                    }
                }
            }
        }
    }
    // 组装新的 .env 文本
    let mut written = Written::default();
    let mut set = |k: &str, v: &str| {
        let line = env.set(k, v);
        written.env_lines.insert(k.to_string(), line);
    };
    set(K_KEY, p.api_key);
    set(K_BASE, p.base_url);
    if let Some(m) = p.model {
        set(K_MODEL, m);
    }
    state.written = Some(written);
    let new_env = env.render();

    // 组装新的 settings.json
    let before = root.clone();
    let sec = root.entry("security").or_insert_with(|| Value::Object(Map::new()));
    let sec = sec.as_object_mut().ok_or_else(|| Error::Parse("`security` 不是对象".into()))?;
    let auth = sec.entry("auth").or_insert_with(|| Value::Object(Map::new()));
    let auth = auth.as_object_mut().ok_or_else(|| Error::Parse("`security.auth` 不是对象".into()))?;
    auth.insert("selectedType".into(), Value::String(AUTH_TYPE.into()));

    // 先写 .env（带自检），再写 settings.json；后者失败则把 .env 也退回写入前。
    let env_existed = env_path.exists();
    let rollback_env = || {
        if env_existed {
            let _ = write_atomic(&env_path, &env_text);
        } else {
            let _ = fs::remove_file(&env_path);
        }
    };
    write_atomic(&env_path, &new_env)?;
    if fs::read_to_string(&env_path).map(|t| t != new_env).unwrap_or(true) {
        rollback_env();
        return Err(Error::Verify(".env 写入后内容不一致".into()));
    }
    if let Err(e) = write_checked(&set_path, &set_text, &root, &layout, |after| verify_settings(&before, after)) {
        rollback_env();
        return Err(e);
    }
    state.settings_hash = fs::read_to_string(&set_path).ok().map(|t| fnv(&t));
    save_state(data_dir, STATE_FILE, &state)
}

pub fn restore(gemini_dir: &Path, data_dir: &Path) -> Result<(), Error> {
    let state = load_state::<State>(data_dir, STATE_FILE)?;
    let orig = state.original.ok_or_else(|| Error::State("没有可还原的记录（尚未写入过）".into()))?;
    let written = state.written.unwrap_or_default();
    let env_path = gemini_dir.join(".env");
    let set_path = gemini_dir.join("settings.json");

    // .env
    if env_path.exists() {
        let mut env = EnvFile::parse(&fs::read_to_string(&env_path)?);
        for (k, original) in &orig.env_lines {
            let Some(w) = written.env_lines.get(k) else { continue };
            let Some(i) = env.find(k) else { continue };
            if env.lines[i] != *w {
                continue; // 用户已改成别的，不覆盖
            }
            match original {
                Some(line) => env.lines[i] = line.clone(),
                None => {
                    env.lines.remove(i);
                }
            }
        }
        let text = env.render();
        if !orig.had_env_file && text.trim().is_empty() {
            fs::remove_file(&env_path)?;
        } else {
            write_atomic(&env_path, &text)?;
        }
    }

    // settings.json
    if set_path.exists() {
        let text = fs::read_to_string(&set_path)?;
        // 文件自上次写入后没人动过：逐字写回备份的原文。
        if state.settings_hash == Some(fnv(&text)) {
            if let Some(b) = orig.settings_backup.as_ref().filter(|b| b.exists()) {
                write_atomic(&set_path, &fs::read_to_string(b)?)?;
                return clear_state(data_dir, STATE_FILE);
            }
        }
        let mut root = parse_root(&text)?;
        let layout = Layout::detect(&text);
        let mut touched = false;
        if let Some(auth) = root.get_mut("security").and_then(Value::as_object_mut).and_then(|s| s.get_mut("auth")).and_then(Value::as_object_mut) {
            if auth.get("selectedType").and_then(Value::as_str) == Some(AUTH_TYPE) {
                match &orig.selected_type {
                    Some(v) => {
                        auth.insert("selectedType".into(), v.clone());
                    }
                    None => {
                        auth.shift_remove("selectedType");
                    }
                }
                touched = true;
            }
        }
        if touched {
            prune_empty(&mut root, &orig);
            if !orig.had_settings_file && root.is_empty() {
                fs::remove_file(&set_path)?;
            } else {
                write_checked(&set_path, &text, &root, &layout, |_| Ok(()))?;
            }
        }
    }
    clear_state(data_dir, STATE_FILE)
}

pub fn status(gemini_dir: &Path, data_dir: &Path) -> Result<Status, Error> {
    let state = load_state::<State>(data_dir, STATE_FILE)?;
    let env_path = gemini_dir.join(".env");
    let env = EnvFile::parse(&if env_path.exists() { fs::read_to_string(&env_path)? } else { String::new() });
    let val = |k: &str| env.find(k).map(|i| EnvFile::value_of(&env.lines[i]));
    let set_path = gemini_dir.join("settings.json");
    let auth_type = if set_path.exists() {
        parse_root(&fs::read_to_string(&set_path)?)?
            .get("security")
            .and_then(|s| s.get("auth"))
            .and_then(|a| a.get("selectedType"))
            .and_then(Value::as_str)
            .map(String::from)
    } else {
        None
    };
    let base_url = val(K_BASE);
    let in_use = match (&base_url, &state.written) {
        (Some(b), Some(w)) => w.env_lines.get(K_BASE).map(|l| EnvFile::value_of(l)) == Some(b.clone()),
        _ => false,
    };
    Ok(Status {
        env_exists: env_path.exists(),
        has_key: val(K_KEY).is_some(),
        model: val(K_MODEL),
        base_url,
        auth_type,
        in_use,
        has_backup: state.original.is_some(),
    })
}

/// 会盖过 `~/.gemini/.env` 的来源：shell 里的变量，以及切到 Vertex 的开关。
pub fn detect_conflicts(home: &Path, gemini_dir: &Path) -> Vec<String> {
    const FILES: [&str; 5] = [".zshrc", ".zprofile", ".zshenv", ".bash_profile", ".bashrc"];
    const VARS: [&str; 5] = ["GEMINI_API_KEY", "GOOGLE_GEMINI_BASE_URL", "GOOGLE_API_KEY", "GOOGLE_GENAI_USE_VERTEXAI", "GOOGLE_GENAI_USE_GCA"];
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
    if let Ok(s) = fs::read_to_string(gemini_dir.join(".env")) {
        let env = EnvFile::parse(&s);
        for v in ["GOOGLE_API_KEY", "GOOGLE_GENAI_USE_VERTEXAI", "GOOGLE_GENAI_USE_GCA"] {
            if env.find(v).is_some() {
                out.push(format!("{}: {v}", gemini_dir.join(".env").display()));
            }
        }
    }
    out
}

// ---------- 内部工具 ----------

/// 把我们新建的、现在已经空了的 security/auth 对象清掉，让文件回到原样。
fn prune_empty(root: &mut Map<String, Value>, orig: &Original) {
    let auth_empty = root
        .get("security")
        .and_then(|s| s.get("auth"))
        .and_then(Value::as_object)
        .is_some_and(|a| a.is_empty());
    if auth_empty && !orig.had_auth {
        if let Some(sec) = root.get_mut("security").and_then(Value::as_object_mut) {
            sec.shift_remove("auth");
        }
    }
    let sec_empty = root.get("security").and_then(Value::as_object).is_some_and(|s| s.is_empty());
    if sec_empty && !orig.had_security {
        root.shift_remove("security");
    }
}

fn verify_settings(before: &Map<String, Value>, after: &Map<String, Value>) -> Result<(), String> {
    let t = after
        .get("security")
        .and_then(|s| s.get("auth"))
        .and_then(|a| a.get("selectedType"))
        .and_then(Value::as_str);
    if t != Some(AUTH_TYPE) {
        return Err("selectedType 没有写入".into());
    }
    let strip = |m: &Map<String, Value>| {
        let mut m = m.clone();
        if let Some(sec) = m.get_mut("security").and_then(Value::as_object_mut) {
            if let Some(a) = sec.get_mut("auth").and_then(Value::as_object_mut) {
                a.shift_remove("selectedType");
                if a.is_empty() {
                    sec.shift_remove("auth");
                }
            }
            if sec.is_empty() {
                m.shift_remove("security");
            }
        }
        m
    };
    if strip(before) != strip(after) {
        return Err("settings.json 其他内容在写入过程中发生了变化".into());
    }
    Ok(())
}

/// 逐行保存 .env，写回时原样拼接，只动我们管的行。
struct EnvFile {
    lines: Vec<String>,
    trailing_newline: bool,
}

impl EnvFile {
    fn parse(text: &str) -> Self {
        let trailing_newline = text.is_empty() || text.ends_with('\n');
        let lines = if text.is_empty() { vec![] } else { text.lines().map(String::from).collect() };
        EnvFile { lines, trailing_newline }
    }

    fn render(&self) -> String {
        if self.lines.is_empty() {
            return String::new();
        }
        let mut s = self.lines.join("\n");
        if self.trailing_newline {
            s.push('\n');
        }
        s
    }

    fn key_of(line: &str) -> Option<&str> {
        let l = line.trim_start();
        if l.starts_with('#') {
            return None;
        }
        let l = l.strip_prefix("export ").map(str::trim_start).unwrap_or(l);
        l.split_once('=').map(|(k, _)| k.trim())
    }

    fn find(&self, key: &str) -> Option<usize> {
        // 同名多行时 dotenv 以最后一行为准，我们也改最后一行。
        self.lines.iter().rposition(|l| Self::key_of(l) == Some(key))
    }

    /// 取出一行的值（去掉首尾引号）。
    fn value_of(line: &str) -> String {
        let v = line.split_once('=').map(|(_, v)| v.trim()).unwrap_or("");
        let v = v.trim_matches(|c| c == '"' || c == '\'');
        v.to_string()
    }

    /// 设置变量，返回写下的整行。已有同名行就地替换并保留 `export ` 前缀。
    fn set(&mut self, key: &str, value: &str) -> String {
        let quoted = if value.chars().any(|c| c.is_whitespace() || c == '#' || c == '"' || c == '\'') {
            format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
        } else {
            value.to_string()
        };
        match self.find(key) {
            Some(i) => {
                let had_export = self.lines[i].trim_start().starts_with("export ");
                let indent: String = self.lines[i].chars().take_while(|c| c.is_whitespace()).collect();
                let line = format!("{indent}{}{key}={quoted}", if had_export { "export " } else { "" });
                self.lines[i] = line.clone();
                line
            }
            None => {
                let line = format!("{key}={quoted}");
                self.lines.push(line.clone());
                if self.lines.len() == 1 {
                    self.trailing_newline = true;
                }
                line
            }
        }
    }
}
