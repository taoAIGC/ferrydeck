//! 把Ferrydeck里的分组写进 Codex 的 `config.toml`，并能精确撤销。
//!
//! 设计要点：
//! - 只新增 `[model_providers.ferrydeck]` 表，并改 `model_provider` / `model` 两项；其余内容（注释、
//!   插件、MCP 配置、用户自己的 provider）一律保持原样（用 toml_edit 保留格式）。
//! - Key 用 `experimental_bearer_token` 写在该表里，不碰 `auth.json`，不影响用户的 ChatGPT 登录。
//! - 首次写入前把整份原文件备份一份，并记录被改项的原值；重复写入不会覆盖这份“原始状态”。
//! - 还原只撤销我们改的项（而不是整文件回滚），所以用户在此期间对配置做的其他修改不会丢。

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
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

#[derive(Debug, Serialize, Deserialize, Default)]
struct State {
    original: Option<Original>,
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

    write_atomic(&cfg, &doc.to_string())
}

/// 精确撤销：把 `model_provider` / `model` 改回原值，删除我们加的 provider 表。
pub fn restore(codex_dir: &Path, data_dir: &Path) -> Result<(), Error> {
    let state = load_state::<State>(data_dir, STATE_FILE)?;
    let orig = state.original.ok_or_else(|| Error::State("没有可还原的记录（尚未写入过）".into()))?;
    let cfg = codex_dir.join("config.toml");

    if !cfg.exists() {
        // 用户把文件删了，无从还原；仅清理状态。
        clear_state(data_dir, STATE_FILE)?;
        return Ok(());
    }
    let text = fs::read_to_string(&cfg)?;
    let mut doc: DocumentMut = text.parse().map_err(|e: toml_edit::TomlError| Error::Parse(e.to_string()))?;

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

