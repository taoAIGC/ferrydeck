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

/// 用户自定义的模型类别：id 以 `c_` 开头，`keywords` 是模型名里包含的关键词（小写、任一命中就归进这一类）。
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct CustomCategory {
    pub id: String,
    pub name: String,
    pub keywords: Vec<String>,
}

pub fn load_custom(data_dir: &Path) -> Vec<CustomCategory> {
    std::fs::read_to_string(data_dir.join("custom_categories.json")).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

pub fn save_custom(data_dir: &Path, list: &[CustomCategory]) -> Result<(), String> {
    let _ = std::fs::create_dir_all(data_dir);
    std::fs::write(data_dir.join("custom_categories.json"), serde_json::to_string_pretty(list).map_err(|e| e.to_string())?).map_err(|e| format!("保存失败: {e}"))
}

/// 整理用户提交的自定义类别：名称必填且不重名（也不能和内置类别同名），最多 20 个，关键词转小写去空去重；没有 id 的补一个。
pub fn clean_custom(input: Vec<CustomCategory>, builtin_names: &[&str]) -> Result<Vec<CustomCategory>, String> {
    if input.len() > 20 {
        return Err("自定义类别最多 20 个".into());
    }
    let mut out: Vec<CustomCategory> = vec![];
    for (i, c) in input.into_iter().enumerate() {
        let name = c.name.trim().to_string();
        if name.is_empty() {
            return Err("类别名称不能为空".into());
        }
        if name.chars().count() > 12 {
            return Err(format!("类别名称「{name}」太长，最多 12 个字"));
        }
        if builtin_names.contains(&name.as_str()) || out.iter().any(|o| o.name == name) {
            return Err(format!("已经有名为「{name}」的类别"));
        }
        let mut keywords: Vec<String> = vec![];
        for k in c.keywords {
            let k = k.trim().to_lowercase();
            if !k.is_empty() && !keywords.contains(&k) {
                keywords.push(k);
            }
        }
        let id = if c.id.starts_with("c_") && !out.iter().any(|o| o.id == c.id) { c.id } else { format!("c_{}_{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0), i) };
        out.push(CustomCategory { id, name, keywords });
    }
    Ok(out)
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

    #[test]
    fn custom_categories_are_cleaned_and_round_trip() {
        let d = tempfile::tempdir().unwrap();
        assert!(load_custom(d.path()).is_empty());
        let ok = clean_custom(vec![CustomCategory { id: "".into(), name: " 我的视频 ".into(), keywords: vec![" Seedance ".into(), "seedance".into(), "".into(), "VEO".into()] }], &["视频"]).unwrap();
        assert_eq!(ok[0].name, "我的视频");
        assert_eq!(ok[0].keywords, vec!["seedance".to_string(), "veo".to_string()]);
        assert!(ok[0].id.starts_with("c_"));
        save_custom(d.path(), &ok).unwrap();
        assert_eq!(load_custom(d.path()), ok);
        assert!(clean_custom(vec![CustomCategory { id: "".into(), name: "视频".into(), keywords: vec![] }], &["视频"]).is_err(), "不能和内置类别同名");
        assert!(clean_custom(vec![CustomCategory { id: "".into(), name: "".into(), keywords: vec![] }], &[]).is_err());
    }
}
