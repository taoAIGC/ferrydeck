//! 把Ferrydeck里的分组写进 Codex 的 `config.toml`，并能精确撤销。
//!
//! 设计要点：
//! - 只新增 `[model_providers.ferrydeck]` 表，并改 `model_provider` / `model` 两项；其余内容（注释、
//!   插件、MCP 配置、用户自己的 provider）一律保持原样（用 toml_edit 保留格式）。
//! - Key 用 `experimental_bearer_token` 写在该表里，请求只靠它。
//! - Codex 没有任何登录（`auth.json`）时会停在登录页，即使当前 provider 不需要 OpenAI 账号。
//!   所以只在用户既没用 ChatGPT 登录、也没自己配 API Key 时，写一份 API Key 模式的 `auth.json`
//!   让它直接进入；已有的登录一律不动。还原时只撤销我们写的那份。
//! - 首次写入前把整份原文件备份一份，并记录被改项的原值；重复写入不会覆盖这份“原始状态”。
//! - 还原只撤销我们改的项（而不是整文件回滚），所以用户在此期间对配置做的其他修改不会丢。

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use toml_edit::{value, DocumentMut, Item, Table};

pub const PROVIDER_ID: &str = "ferrydeck";
const STATE_FILE: &str = "codex-state.json";

pub use super::common::Error;
use super::common::{backup_file, clear_state, load_state, save_state, write_atomic};

/// 一次写入所需的全部输入。
pub struct Params<'a> {
    pub base_url: &'a str, // 例如 https://relay.example.com/v1
    pub api_key: &'a str,
    pub model: &'a str,
    pub provider_display_name: &'a str,
}

/// 首次写入前的“原始状态”，用于精确还原。
#[derive(Debug, Serialize, Deserialize, Default, Clone, PartialEq)]
struct Original {
    /// 原来的 `model_provider`，None 表示原来没有这一项。
    model_provider: Option<String>,
    model: Option<String>,
    /// 原来是否已经存在 `[model_providers.ferrydeck]`（比如用户手工配过）。
    had_our_table: bool,
    /// 整份原文件的备份位置。
    backup_file: Option<PathBuf>,
}

/// 我们第一次写 `auth.json` 前它的样子。
#[derive(Debug, Serialize, Deserialize, Default, Clone, PartialEq)]
struct AuthOriginal {
    /// 原文件的备份；None 表示原来没有 auth.json。
    backup_file: Option<PathBuf>,
}

#[derive(Debug, Serialize, Deserialize, Default)]
struct State {
    original: Option<Original>,
    /// 我们写过 auth.json 时才有。
    #[serde(default)]
    auth: Option<AuthOriginal>,
}

const AUTH_FILE: &str = "auth.json";
const AUTH_KEY: &str = "OPENAI_API_KEY";

/// auth.json 里是否有 ChatGPT 账号登录。
fn has_chatgpt_login(v: &Value) -> bool {
    v.get("tokens").is_some_and(|t| t.is_object())
}

fn auth_key(v: &Value) -> Option<&str> {
    v.get(AUTH_KEY).and_then(Value::as_str).filter(|k| !k.is_empty())
}

/// 当前 `[model_providers.ferrydeck]` 里的 Key（也就是我们上次写进 auth.json 的那个）。
fn our_token(doc: &DocumentMut) -> Option<String> {
    doc.get("model_providers")?.get(PROVIDER_ID)?.get("experimental_bearer_token")?.as_str().map(String::from)
}

/// 让 Codex 不停在登录页。`prev` 是本次写入前我们表里的 Key，用来认出“这份 auth.json 是我们写的”。
fn ensure_auth(codex_dir: &Path, data_dir: &Path, state: &mut State, prev: Option<&str>, key: &str) -> Result<(), Error> {
    let path = codex_dir.join(AUTH_FILE);
    let text = fs::read_to_string(&path).ok();
    let root = match text.as_deref().map(serde_json::from_str::<Value>) {
        Some(Ok(v)) if v.is_object() => Some(v),
        Some(_) => return Ok(()), // 看不懂的文件不碰
        None => None,
    };
    if root.as_ref().is_some_and(has_chatgpt_login) {
        return Ok(()); // 用户用 ChatGPT 登录了，Codex 会直接进入
    }
    let current = root.as_ref().and_then(auth_key);
    let ours = state.auth.is_some() && current.is_some() && current == prev;
    if current.is_some() && !ours {
        return Ok(()); // 用户自己配了 API Key 登录
    }
    if !ours {
        let backup_file = text.as_deref().map(|t| backup_file(data_dir, "codex", &path, t)).transpose()?;
        state.auth = Some(AuthOriginal { backup_file });
        save_state(data_dir, STATE_FILE, state)?;
    }
    let mut obj = root.and_then(|v| v.as_object().cloned()).unwrap_or_default();
    obj.insert(AUTH_KEY.into(), Value::String(key.into()));
    if obj.get("auth_mode").and_then(Value::as_str).is_some_and(|m| m != "apikey") {
        obj.remove("auth_mode"); // 残留的 chatgpt 模式标记会让 Codex 继续要求登录
    }
    let is_new = text.is_none();
    write_atomic(&path, &(serde_json::to_string_pretty(&Value::Object(obj)).unwrap_or_default() + "\n"))?;
    #[cfg(unix)]
    if is_new {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600)); // 含 Key，只给自己读
    }
    #[cfg(not(unix))]
    let _ = is_new;
    Ok(())
}

/// 撤销我们写的 auth.json：仍是我们那份时恢复原文件（原来没有就删掉）；用户已换成自己的登录就不动。
fn restore_auth(codex_dir: &Path, orig: &AuthOriginal, ours: Option<&str>) -> Result<(), Error> {
    let path = codex_dir.join(AUTH_FILE);
    let Some(v) = fs::read_to_string(&path).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()) else {
        return Ok(());
    };
    if has_chatgpt_login(&v) || ours.is_none() || auth_key(&v) != ours {
        return Ok(());
    }
    match orig.backup_file.as_ref().and_then(|b| fs::read_to_string(b).ok()) {
        Some(t) => write_atomic(&path, &t),
        None => Ok(fs::remove_file(&path)?),
    }
}

#[derive(Debug, Serialize, PartialEq)]
pub struct Status {
    pub config_exists: bool,
    pub active_provider: Option<String>,
    pub active_model: Option<String>,
    pub in_use: bool,
    pub our_base_url: Option<String>,
    pub has_backup: bool,
}

/// `codex_dir`：Codex 配置目录（通常 `~/.codex`）。`data_dir`：本应用保存备份和状态的目录。
pub fn apply(codex_dir: &Path, data_dir: &Path, p: &Params) -> Result<(), Error> {
    let cfg = codex_dir.join("config.toml");
    let text = if cfg.exists() { fs::read_to_string(&cfg)? } else { String::new() };
    let mut doc: DocumentMut = text.parse().map_err(|e: toml_edit::TomlError| Error::Parse(e.to_string()))?;

    let mut state = load_state::<State>(data_dir, STATE_FILE)?;
    if state.original.is_none() {
        // 首次写入：记录原值并备份整份原文件。
        let backup_file = if cfg.exists() {
            Some(backup_file(data_dir, "codex", &cfg, &text)?)
        } else {
            None
        };
        state.original = Some(Original {
            model_provider: doc.get("model_provider").and_then(|i| i.as_str()).map(String::from),
            model: doc.get("model").and_then(|i| i.as_str()).map(String::from),
            had_our_table: doc
                .get("model_providers")
                .and_then(|i| i.as_table_like())
                .map(|t| t.contains_key(PROVIDER_ID))
                .unwrap_or(false),
            backup_file,
        });
        save_state(data_dir, STATE_FILE, &state)?;
    }

    doc["model_provider"] = value(PROVIDER_ID);
    doc["model"] = value(p.model);
    let prev_token = our_token(&doc);

    if doc.get("model_providers").is_none() {
        let mut t = Table::new();
        t.set_implicit(true);
        doc["model_providers"] = Item::Table(t);
    }
    let providers = doc["model_providers"]
        .as_table_like_mut()
        .ok_or_else(|| Error::Parse("model_providers 不是表".into()))?;
    let mut t = Table::new();
    t["name"] = value(p.provider_display_name);
    t["base_url"] = value(p.base_url);
    t["wire_api"] = value("responses");
    t["requires_openai_auth"] = value(false);
    t["experimental_bearer_token"] = value(p.api_key);
    providers.insert(PROVIDER_ID, Item::Table(t));

    write_atomic(&cfg, &doc.to_string())?;
    ensure_auth(codex_dir, data_dir, &mut state, prev_token.as_deref(), p.api_key)
}

/// 精确撤销：把 `model_provider` / `model` 改回原值，删除我们加的 provider 表，撤销我们写的 auth.json。
pub fn restore(codex_dir: &Path, data_dir: &Path) -> Result<(), Error> {
    let state = load_state::<State>(data_dir, STATE_FILE)?;
    let orig = state.original.clone().ok_or_else(|| Error::State("没有可还原的记录（尚未写入过）".into()))?;
    let cfg = codex_dir.join("config.toml");

    if !cfg.exists() {
        // 用户把文件删了，无从还原；仅清理状态。
        clear_state(data_dir, STATE_FILE)?;
        return Ok(());
    }
    let text = fs::read_to_string(&cfg)?;
    let mut doc: DocumentMut = text.parse().map_err(|e: toml_edit::TomlError| Error::Parse(e.to_string()))?;
    let ours = our_token(&doc);

    // 只在“当前仍指向我们的 provider”时才还原这两项；用户若已自行切走，就不要覆盖他的选择。
    if doc.get("model_provider").and_then(|i| i.as_str()) == Some(PROVIDER_ID) {
        match &orig.model_provider {
            Some(v) => doc["model_provider"] = value(v.as_str()),
            None => {
                doc.remove("model_provider");
            }
        }
        match &orig.model {
            Some(v) => doc["model"] = value(v.as_str()),
            None => {
                doc.remove("model");
            }
        }
    }
    if !orig.had_our_table {
        let mut now_empty = false;
        if let Some(t) = doc.get_mut("model_providers").and_then(|i| i.as_table_like_mut()) {
            t.remove(PROVIDER_ID);
            now_empty = t.is_empty();
        }
        if now_empty {
            doc.remove("model_providers");
        }
    }

    write_atomic(&cfg, &doc.to_string())?;
    if let Some(a) = &state.auth {
        restore_auth(codex_dir, a, ours.as_deref())?;
    }
    clear_state(data_dir, STATE_FILE)
}

pub fn status(codex_dir: &Path, data_dir: &Path) -> Result<Status, Error> {
    let cfg = codex_dir.join("config.toml");
    let has_backup = load_state::<State>(data_dir, STATE_FILE)?.original.is_some();
    if !cfg.exists() {
        return Ok(Status {
            config_exists: false,
            active_provider: None,
            active_model: None,
            in_use: false,
            our_base_url: None,
            has_backup,
        });
    }
    let doc: DocumentMut = fs::read_to_string(&cfg)?
        .parse()
        .map_err(|e: toml_edit::TomlError| Error::Parse(e.to_string()))?;
    let active_provider = doc.get("model_provider").and_then(|i| i.as_str()).map(String::from);
    let base_url = doc
        .get("model_providers")
        .and_then(|i| i.get(PROVIDER_ID))
        .and_then(|i| i.get("base_url"))
        .and_then(|i| i.as_str())
        .map(String::from);
    Ok(Status {
        config_exists: true,
        in_use: active_provider.as_deref() == Some(PROVIDER_ID),
        active_provider,
        active_model: doc.get("model").and_then(|i| i.as_str()).map(String::from),
        our_base_url: base_url,
        has_backup,
    })
}

/// 扫描 shell 配置里会覆盖 Codex 行为的环境变量，返回发现的 (文件, 变量名)。
pub fn detect_env_conflicts(home: &Path) -> Vec<(PathBuf, String)> {
    const FILES: [&str; 5] = [".zshrc", ".zprofile", ".zshenv", ".bash_profile", ".bashrc"];
    const VARS: [&str; 2] = ["OPENAI_API_KEY", "OPENAI_BASE_URL"];
    let mut out = vec![];
    for f in FILES {
        let path = home.join(f);
        if let Ok(s) = fs::read_to_string(&path) {
            for line in s.lines() {
                let l = line.trim_start();
                if l.starts_with('#') {
                    continue;
                }
                for v in VARS {
                    if l.contains(&format!("{v}=")) && (l.starts_with("export ") || l.starts_with(v)) {
                        out.push((path.clone(), v.to_string()));
                    }
                }
            }
        }
    }
    out
}

