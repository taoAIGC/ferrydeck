//! 把Ferrydeck里的分组写进 Claude Desktop 的“第三方推理（gateway）”配置。
//!
//! 机制（与本机已有的可用配置一致）：
//! - 配置库目录 `~/Library/Application Support/Claude-3p/configLibrary/`：
//!   每个方案一个 `<id>.json`，`_meta.json` 里登记方案并用 `appliedId` 指定当前启用的方案。
//! - 我们只新增/覆盖自己的方案（固定 id），并把 `appliedId` 指向它；其他工具（如 CC Switch）的方案原样保留。
//! - 还原：把 `appliedId` 改回原值，删掉我们的登记项和方案文件。
//!
//! 说明：Claude Desktop 本体需要用户自己开启“Developer Mode → Third-Party Inference”并重启才会读取这些配置。

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

pub use super::common::Error;
use super::common::{backup_file, clear_state, fnv, load_state, parse_root, save_state, write_atomic, write_checked, Layout};

const STATE_FILE: &str = "claude-desktop-state.json";
/// 我们方案的固定 id（UUID 格式）。固定 id 让重复写入变成“覆盖自己”，不会越写越多。
pub const PROFILE_ID: &str = "b35747a1-0000-4000-8000-000000000001";
pub const PROFILE_NAME: &str = "Ferrydeck";

pub struct Params<'a> {
    pub base_url: &'a str, // https://relay.example.com，不带 /v1，不带结尾斜杠
    pub api_key: &'a str,
    /// 在 Claude Desktop 模型选择器里出现的模型；第一个为默认。
    pub models: &'a [String],
}

#[derive(Debug, Serialize, Deserialize, Default, Clone)]
struct Original {
    applied_id: Option<String>,
    had_meta_file: bool,
    had_entries_key: bool,
    /// 原来是否已有同 id 的登记项 / 方案文件（比如上次写入没清干净）。
    had_our_entry: bool,
    had_profile_file: bool,
    meta_backup: Option<PathBuf>,
    profile_backup: Option<PathBuf>,
}

#[derive(Debug, Serialize, Deserialize, Default)]
struct State {
    original: Option<Original>,
    meta_hash: Option<u64>,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct Status {
    pub dir_exists: bool,
    pub applied_id: Option<String>,
    pub in_use: bool,
    pub base_url: Option<String>,
    pub has_backup: bool,
}

fn lib_dir(claude_3p: &Path) -> PathBuf {
    claude_3p.join("configLibrary")
}

fn profile_json(p: &Params) -> Value {
    // 字段与本机已有的可用方案保持同样的顺序和键名
    let models: Vec<Value> = p.models.iter().map(|m| json!({"name": m, "supports1m": false})).collect();
    json!({
        "disableDeploymentModeChooser": true,
        "inferenceGatewayApiKey": p.api_key,
        "inferenceGatewayAuthScheme": "bearer",
        "inferenceGatewayBaseUrl": p.base_url,
        "inferenceModels": models,
        "inferenceProvider": "gateway",
    })
}

pub fn apply(claude_3p: &Path, data_dir: &Path, p: &Params) -> Result<(), Error> {
    if p.models.is_empty() {
        return Err(Error::Parse("至少需要一个模型".into()));
    }
    if p.base_url.ends_with('/') || p.base_url.contains('\n') || p.api_key.contains('\n') {
        return Err(Error::Parse("地址不能以 / 结尾，值里不能有换行".into()));
    }
    let dir = lib_dir(claude_3p);
    let meta_path = dir.join("_meta.json");
    let prof_path = dir.join(format!("{PROFILE_ID}.json"));
    let meta_text = if meta_path.exists() { fs::read_to_string(&meta_path)? } else { String::new() };
    let prof_text = if prof_path.exists() { fs::read_to_string(&prof_path)? } else { String::new() };
    let mut meta = parse_root(&meta_text)?;
    let layout = Layout::detect(&meta_text);

    let mut state = load_state::<State>(data_dir, STATE_FILE)?;
    if state.original.is_none() {
        let entries = meta.get("entries").and_then(Value::as_array);
        state.original = Some(Original {
            applied_id: meta.get("appliedId").and_then(Value::as_str).map(String::from),
            had_meta_file: meta_path.exists(),
            had_entries_key: entries.is_some(),
            had_our_entry: entries.is_some_and(|a| a.iter().any(|e| e.get("id").and_then(Value::as_str) == Some(PROFILE_ID))),
            had_profile_file: prof_path.exists(),
            meta_backup: if meta_path.exists() { Some(backup_file(data_dir, "claude-desktop", &meta_path, &meta_text)?) } else { None },
            profile_backup: if prof_path.exists() { Some(backup_file(data_dir, "claude-desktop", &prof_path, &prof_text)?) } else { None },
        });
    }

    // 登记我们的方案并设为当前
    let before = meta.clone();
    let entries = meta.entry("entries").or_insert_with(|| Value::Array(vec![]));
    let entries = entries.as_array_mut().ok_or_else(|| Error::Parse("`entries` 不是数组".into()))?;
    let ours = json!({"id": PROFILE_ID, "name": PROFILE_NAME});
    match entries.iter().position(|e| e.get("id").and_then(Value::as_str) == Some(PROFILE_ID)) {
        Some(i) => entries[i] = ours,
        None => entries.push(ours),
    }
    meta.insert("appliedId".into(), Value::String(PROFILE_ID.into()));

    // 先写方案文件（此时还没启用，无副作用），再写 _meta 切换；后者失败则撤回方案文件。
    fs::create_dir_all(&dir)?;
    let prof_new = serde_json::to_string_pretty(&profile_json(p)).map_err(|e| Error::Parse(e.to_string()))? + "\n";
    write_atomic(&prof_path, &prof_new)?;
    #[cfg(unix)]
    {
        // 方案文件里有 API Key，只允许本人读写（与本机其他工具写的同类文件一致）
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&prof_path, fs::Permissions::from_mode(0o600));
    }
    let rollback_profile = || {
        if prof_text.is_empty() && !prof_path.exists() {
            return;
        }
        if prof_text.is_empty() {
            let _ = fs::remove_file(&prof_path);
        } else {
            let _ = write_atomic(&prof_path, &prof_text);
        }
    };
    if fs::read_to_string(&prof_path).map(|t| t != prof_new).unwrap_or(true) {
        rollback_profile();
        return Err(Error::Verify("方案文件写入后内容不一致".into()));
    }
    if let Err(e) = write_checked(&meta_path, &meta_text, &meta, &layout, |after| verify_meta(&before, after)) {
        rollback_profile();
        return Err(e);
    }
    state.meta_hash = fs::read_to_string(&meta_path).ok().map(|t| fnv(&t));
    save_state(data_dir, STATE_FILE, &state)
}

pub fn restore(claude_3p: &Path, data_dir: &Path) -> Result<(), Error> {
    let state = load_state::<State>(data_dir, STATE_FILE)?;
    let orig = state.original.clone().ok_or_else(|| Error::State("没有可还原的记录（尚未写入过）".into()))?;
    let dir = lib_dir(claude_3p);
    let meta_path = dir.join("_meta.json");
    let prof_path = dir.join(format!("{PROFILE_ID}.json"));

    // 方案文件：原来没有就删；原来有（极少见）就写回备份
    match (&orig.profile_backup, prof_path.exists()) {
        (Some(b), _) if b.exists() => write_atomic(&prof_path, &fs::read_to_string(b)?)?,
        (_, true) if !orig.had_profile_file => fs::remove_file(&prof_path)?,
        _ => {}
    }

    if meta_path.exists() {
        let text = fs::read_to_string(&meta_path)?;
        // _meta.json 自写入后没人动过：逐字写回备份（或删除我们新建的文件）
        if state.meta_hash == Some(fnv(&text)) {
            match orig.meta_backup.as_ref().filter(|b| b.exists()) {
                Some(b) => write_atomic(&meta_path, &fs::read_to_string(b)?)?,
                None if !orig.had_meta_file => fs::remove_file(&meta_path)?,
                None => {}
            }
            return clear_state(data_dir, STATE_FILE);
        }
        let mut meta = parse_root(&text)?;
        let layout = Layout::detect(&text);
        // 只有 appliedId 仍指向我们，才改回去；用户已切到别的方案就不动
        if meta.get("appliedId").and_then(Value::as_str) == Some(PROFILE_ID) {
            match &orig.applied_id {
                Some(id) => {
                    meta.insert("appliedId".into(), Value::String(id.clone()));
                }
                None => {
                    meta.shift_remove("appliedId");
                }
            }
        }
        if !orig.had_our_entry {
            if let Some(a) = meta.get_mut("entries").and_then(Value::as_array_mut) {
                a.retain(|e| e.get("id").and_then(Value::as_str) != Some(PROFILE_ID));
            }
            if !orig.had_entries_key && meta.get("entries").and_then(Value::as_array).is_some_and(|a| a.is_empty()) {
                meta.shift_remove("entries");
            }
        }
        if !orig.had_meta_file && meta.is_empty() {
            fs::remove_file(&meta_path)?;
        } else {
            write_checked(&meta_path, &text, &meta, &layout, |_| Ok(()))?;
        }
    }
    clear_state(data_dir, STATE_FILE)
}

pub fn status(claude_3p: &Path, data_dir: &Path) -> Result<Status, Error> {
    let state = load_state::<State>(data_dir, STATE_FILE)?;
    let dir = lib_dir(claude_3p);
    let meta = dir.join("_meta.json");
    let applied_id = if meta.exists() { parse_root(&fs::read_to_string(&meta)?)?.get("appliedId").and_then(Value::as_str).map(String::from) } else { None };
    let prof = dir.join(format!("{PROFILE_ID}.json"));
    let base_url = if prof.exists() {
        parse_root(&fs::read_to_string(&prof)?).ok().and_then(|m| m.get("inferenceGatewayBaseUrl").and_then(Value::as_str).map(String::from))
    } else {
        None
    };
    Ok(Status {
        dir_exists: claude_3p.exists(),
        in_use: applied_id.as_deref() == Some(PROFILE_ID) && prof.exists(),
        applied_id,
        base_url,
        has_backup: state.original.is_some(),
    })
}

/// 可能导致不生效的情况：没切到第三方模式、没有 Claude-3p 目录。
pub fn detect_conflicts(claude_3p: &Path) -> Vec<String> {
    let mut out = vec![];
    if !claude_3p.exists() {
        out.push("还没有检测到 Claude Desktop 的第三方模式配置目录：请在 Claude Desktop 里打开 帮助 → 故障排除 → 启用开发者模式，再进入 开发者 → 配置第三方推理，然后重启".to_string());
        return out;
    }
    let cfg = claude_3p.join("claude_desktop_config.json");
    // 只有读到了文件、且明确写着别的模式时才提示；文件正被 Claude Desktop 改写（读到半截）时不误报
    let Some(root) = fs::read_to_string(&cfg).ok().and_then(|t| parse_root(&t).ok()) else { return out };
    match root.get("deploymentMode").and_then(Value::as_str) {
        Some("3p") => {}
        other => out.push(format!(
            "Claude Desktop 还没有切换到第三方推理模式（当前：{}）：请在 Claude Desktop 里进入 开发者 → 配置第三方推理，然后完全退出（⌘Q）再打开",
            other.unwrap_or("未设置")
        )),
    }
    out
}

fn verify_meta(before: &Map<String, Value>, after: &Map<String, Value>) -> Result<(), String> {
    if after.get("appliedId").and_then(Value::as_str) != Some(PROFILE_ID) {
        return Err("appliedId 没有写入".into());
    }
    let ours = after.get("entries").and_then(Value::as_array).map(|a| a.iter().filter(|e| e.get("id").and_then(Value::as_str) == Some(PROFILE_ID)).count());
    if ours != Some(1) {
        return Err("我们的登记项应恰好一条".into());
    }
    let strip = |m: &Map<String, Value>| {
        let mut m = m.clone();
        m.shift_remove("appliedId");
        if let Some(a) = m.get_mut("entries").and_then(Value::as_array_mut) {
            a.retain(|e| e.get("id").and_then(Value::as_str) != Some(PROFILE_ID));
            if a.is_empty() {
                m.shift_remove("entries");
            }
        }
        m
    };
    if strip(before) != strip(after) {
        return Err("其他方案的登记项在写入过程中发生了变化".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn m(s: &str) -> Map<String, Value> {
        parse_root(s).unwrap()
    }

    #[test]
    fn verify_meta_accepts_a_correct_result() {
        let before = m(r#"{"appliedId":"x","entries":[{"id":"x","name":"X"}]}"#);
        let after = m(&format!(r#"{{"appliedId":"{PROFILE_ID}","entries":[{{"id":"x","name":"X"}},{{"id":"{PROFILE_ID}","name":"BestAPI"}}]}}"#));
        assert!(verify_meta(&before, &after).is_ok());
    }

    #[test]
    fn verify_meta_rejects_missing_or_duplicated_entry_or_collateral_changes() {
        let before = m(r#"{"appliedId":"x","entries":[{"id":"x","name":"X"}]}"#);
        let not_applied = m(&format!(r#"{{"appliedId":"x","entries":[{{"id":"{PROFILE_ID}","name":"B"}}]}}"#));
        assert!(verify_meta(&before, &not_applied).is_err());
        let dup = m(&format!(r#"{{"appliedId":"{PROFILE_ID}","entries":[{{"id":"{PROFILE_ID}"}},{{"id":"{PROFILE_ID}"}}]}}"#));
        assert!(verify_meta(&before, &dup).is_err());
        let lost_other = m(&format!(r#"{{"appliedId":"{PROFILE_ID}","entries":[{{"id":"{PROFILE_ID}"}}]}}"#));
        assert!(verify_meta(&before, &lost_other).is_err(), "别的工具的登记项被弄丢必须报错");
    }
}
