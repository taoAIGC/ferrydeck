//! 站长 / 用户对分组的“支持哪些客户端”的手动设置：覆盖站点给的平台分类（new-api 没有分类，sub2api 的分类也可能不合你的用法）。
//! 只保存在本机 `group_clients.json`，不含任何凭据。

use std::collections::BTreeMap;
use std::path::Path;

/// `站点 id \u{1}分组 id` -> 客户端 id 列表（`claude` / `claude_desktop` / `codex` / `gemini`）。
pub type ClientOverrides = BTreeMap<String, Vec<String>>;

pub fn key(site_id: &str, group_id: &str) -> String {
    format!("{site_id}\u{1}{group_id}")
}

pub fn load(data_dir: &Path) -> ClientOverrides {
    std::fs::read_to_string(data_dir.join("group_clients.json")).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

pub fn save(data_dir: &Path, o: &ClientOverrides) -> Result<(), String> {
    let _ = std::fs::create_dir_all(data_dir);
    std::fs::write(data_dir.join("group_clients.json"), serde_json::to_string_pretty(o).map_err(|e| e.to_string())?).map_err(|e| format!("保存失败: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overrides_round_trip_and_missing_file_is_empty() {
        let d = tempfile::tempdir().unwrap();
        assert!(load(d.path()).is_empty());
        let mut o = ClientOverrides::new();
        o.insert(key("s", "g"), vec!["claude".into(), "codex".into()]);
        save(d.path(), &o).unwrap();
        assert_eq!(load(d.path()), o);
    }
}
