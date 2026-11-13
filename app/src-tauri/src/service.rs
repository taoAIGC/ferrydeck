//! 把“选一个分组 → 自动准备 Key → 写进对应客户端”串起来。

use std::collections::BTreeMap;
use std::fs;

use serde::{Deserialize, Serialize};

use crate::sites::{GroupInfo, Site, SiteClient};
use crate::clients::{claude, claude_desktop, codex, gemini};
use crate::paths::Paths;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, PartialOrd, Ord)]
#[serde(rename_all = "lowercase")]
pub enum Client {
    Claude,
    #[serde(rename = "claude_desktop")]
    ClaudeDesktop,
    Codex,
    Gemini,
}

impl Client {
    pub fn parse(s: &str) -> Result<Self, String> {
        match s {
            "claude" => Ok(Client::Claude),
            "claude_desktop" => Ok(Client::ClaudeDesktop),
            "codex" => Ok(Client::Codex),
            "gemini" => Ok(Client::Gemini),
            _ => Err(format!("未知客户端: {s}")),
        }
    }
    pub fn id(self) -> &'static str {
        match self {
            Client::Claude => "claude",
            Client::ClaudeDesktop => "claude_desktop",
            Client::Codex => "codex",
            Client::Gemini => "gemini",
        }
    }
}

/// 分组平台 → 可配置的客户端。Anthropic 分组既能配 Claude Code，也能配 Claude Desktop；Grok 等暂不支持。
/// 界面里客户端的固定顺序。
pub const CLIENTS_ORDER: [Client; 4] = [Client::Claude, Client::ClaudeDesktop, Client::Codex, Client::Gemini];

/// 分组的模型类别：界面上的 tab 和“类别”列按它分。只有前三类对应能一键配置的客户端。
pub const CATEGORIES: [&str; 10] = ["claude", "openai", "gemini", "deepseek", "cn", "image", "video", "audio", "embed", "other"];

/// 类别 → 可以配置到哪些客户端（没有对应客户端的类别返回空）。
pub fn clients_for_category(c: &str) -> Vec<Client> {
    match c {
        "claude" => vec![Client::Claude, Client::ClaudeDesktop],
        "openai" => vec![Client::Codex],
        "gemini" => vec![Client::Gemini],
        _ => vec![],
    }
}

/// 兼容旧版本保存的“客户端”设置：客户端 id 换算成类别，类别原样保留，认不出的丢掉。去重并按 `CATEGORIES` 排序。
pub fn normalize_categories(list: &[String]) -> Vec<String> {
    let mut out: Vec<&'static str> = vec![];
    let mut custom: Vec<String> = vec![];
    for x in list {
        let c = match x.as_str() {
            "claude" | "claude_desktop" => "claude",
            "codex" => "openai",
            "gemini" => "gemini",
            other => match CATEGORIES.iter().find(|c| **c == other) {
                Some(c) => *c,
                None => {
                    // 自定义类别（id 以 c_ 开头）原样保留，排在内置类别后面
                    if other.starts_with("c_") && !custom.contains(&other.to_string()) {
                        custom.push(other.to_string());
                    }
                    continue;
                }
            },
        };
        if !out.contains(&c) {
            out.push(c);
        }
    }
    let mut v: Vec<String> = CATEGORIES.iter().filter(|c| out.contains(c)).map(|c| c.to_string()).collect();
    v.extend(custom);
    v
}

/// 一组类别可以配置到哪些客户端（按界面固定顺序）。
pub fn clients_for_categories(cats: &[String]) -> Vec<Client> {
    let all: Vec<Client> = cats.iter().flat_map(|c| clients_for_category(c)).collect();
    CLIENTS_ORDER.iter().copied().filter(|c| all.contains(c)).collect()
}

pub fn clients_for(platform: &str) -> Vec<Client> {
    match platform {
        "anthropic" => vec![Client::Claude, Client::ClaudeDesktop],
        "openai" => vec![Client::Codex],
        "gemini" => vec![Client::Gemini],
        _ => vec![],
    }
}

/// 系统自带的 default 分组不展示给用户。
pub fn is_hidden_group(name: &str) -> bool {
    name.trim().eq_ignore_ascii_case("default")
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Active {
    pub site_id: String,
    pub site_name: String,
    pub group_id: String,
    pub group_name: String,
    pub model: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct EnableOutcome {
    pub client: Client,
    pub key_created: bool,
    pub models: Vec<String>,
    pub model: Option<String>,
    pub conflicts: Vec<String>,
}

/// 测速结果，附带该分组实测可用的模型。
#[derive(Debug, Serialize)]
pub struct ProbeResult {
    pub first_ms: u64,
    pub total_ms: u64,
    pub input_tokens: Option<u64>,
    pub model: String,
    pub models: Vec<String>,
}

/// 给界面展示用的分组信息。
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct GroupView {
    pub site_id: String,
    pub site_name: String,
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub platform: String,
    pub rate_multiplier: f64,
    /// 可配置的客户端；为空表示暂不支持一键配置。
    pub clients: Vec<Client>,
    /// 分组已自带的模型（sub2api 不提供，前端会额外拉取）。
    pub models: Vec<String>,
    /// 这个站点的分组没有平台分类，`clients` 是按模型推断出来的。
    pub clients_inferred: bool,
    /// 用户手动设置过的模型类别（见 `CATEGORIES`）；没设置过是 None，界面按平台和模型名自动识别。
    pub categories: Option<Vec<String>>,
}

#[derive(Debug, Serialize)]
pub struct ClientOverview {
    pub client: Client,
    /// 本机是否有该客户端的配置目录（没有只是提示，仍可写入）。
    pub dir_exists: bool,
    pub in_use: bool,
    pub active: Option<Active>,
    pub conflicts: Vec<String>,
    /// 当前使用的是否为“按模型推断”的分组（与分组无关，只是让界面能解释为什么分组会出现在多个客户端下）。
    pub groups_inferred: bool,
}

fn active_path(p: &Paths) -> std::path::PathBuf {
    p.data.join("active.json")
}

fn load_active(p: &Paths) -> BTreeMap<Client, Active> {
    fs::read_to_string(active_path(p)).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

fn save_active(p: &Paths, m: &BTreeMap<Client, Active>) -> Result<(), String> {
    fs::create_dir_all(&p.data).map_err(|e| e.to_string())?;
    fs::write(active_path(p), serde_json::to_string_pretty(m).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

/// 对话类模型（排除图片、向量、语音等），写进编程客户端的只应是这些。
pub fn is_chat_model(m: &str) -> bool {
    !["image", "nano-banana", "embed", "tts", "whisper", "dall-e", "moderation", "rerank"].iter().any(|k| m.contains(k))
}

/// 没指定模型时的默认选择：优先常用模型，否则取列表第一个。
pub fn default_model(client: Client, models: &[String]) -> Option<String> {
    let prefs: &[&str] = match client {
        Client::Claude | Client::ClaudeDesktop => &["claude-sonnet-5-5", "claude-sonnet-5", "claude-sonnet-4-6", "claude-opus-5-5", "claude-opus-5", "claude-haiku-5-5", "claude-haiku-4-5"],
        Client::Codex => &["gpt-5.6-sol", "gpt-6-sol", "gpt-6.1-sol", "gpt-5.6-terra", "gpt-6-astra"],
        Client::Gemini => &["gemini-3.5-flash", "gemini-3.1-pro-preview", "gemini-2.5-pro", "gemini-2.5-flash"],
    };
    prefs
        .iter()
        .find(|p| models.iter().any(|m| m == *p))
        .map(|s| s.to_string())
        .or_else(|| models.iter().find(|m| is_chat_model(m)).cloned())
}

/// 该分组可用于编程客户端的对话模型。站点能直接告知时不创建 Key；否则用该分组的 Key 查询。
pub async fn group_models(client: &SiteClient, group: &GroupInfo) -> Result<Vec<String>, String> {
    if !group.models.is_empty() {
        return Ok(group.models.iter().filter(|m| is_chat_model(m)).cloned().collect());
    }
    let (key, _) = client.ensure_key(group).await?;
    Ok(client.models(&key).await.into_iter().filter(|m| is_chat_model(m)).collect())
}

pub async fn enable(client: &SiteClient, site: &Site, paths: &Paths, group: &GroupInfo, target: Client, model: Option<String>) -> Result<EnableOutcome, String> {
    enable_with(client, site, paths, group, target, model, None).await
}

/// 同 `enable`；`allowed_override` 是用户手动设置的“这个分组支持哪些客户端”，有就不再按平台判断。
pub async fn enable_with(client: &SiteClient, site: &Site, paths: &Paths, group: &GroupInfo, target: Client, model: Option<String>, allowed_override: Option<&[Client]>) -> Result<EnableOutcome, String> {
    if is_hidden_group(&group.name) {
        return Err("分组不存在或已无权使用".into());
    }
    // new-api 的分组没有平台字段，无法判断该配到哪个客户端，允许配到任意客户端
    let allowed = match allowed_override {
        Some(o) => o.to_vec(),
        None if site.kind == crate::sites::Kind::Newapi => vec![Client::Claude, Client::ClaudeDesktop, Client::Codex, Client::Gemini],
        None => clients_for(&group.platform),
    };
    if !allowed.contains(&target) {
        return Err(if clients_for(&group.platform).is_empty() {
            format!("「{}」暂不支持一键配置（平台：{}）", group.name, group.platform)
        } else {
            format!("「{}」不能配置到 {}", group.name, target.id())
        });
    }
    let who = format!("{} ({}) group={} [{}] client={}", site.name, site.base_url, group.name, group.id, target.id());
    let (key, created) = match client.ensure_key(group).await {
        Ok(v) => v,
        Err(e) => {
            crate::applog::log("enable_fail", &format!("{who} step=key error={e}"));
            return Err(e);
        }
    };
    if created {
        crate::applog::log("key_create", &format!("{who} 已为该分组创建专用 Key"));
    }
    let mut all = client.models(&key).await;
    if all.is_empty() {
        all = group.models.clone();
    }
    let models: Vec<String> = all.iter().filter(|m| is_chat_model(m)).cloned().collect();
    if !all.is_empty() && models.is_empty() {
        return Err(format!("「{}」只提供图片等非对话模型，不适合配置到编程客户端", group.name));
    }
    let chosen = match model {
        Some(m) if models.is_empty() || models.contains(&m) => Some(m),
        Some(m) => return Err(format!("该分组没有模型 {m}")),
        None => default_model(target, &models),
    };
    let base = client.base();
    match target {
        Client::Claude => claude::apply(&paths.claude, &paths.data, &claude::Params { base_url: base, api_key: &key, model: chosen.as_deref() }).map_err(|e| e.to_string())?,
        Client::ClaudeDesktop => {
            let first = chosen.clone().ok_or("该分组没有可用模型，无法配置 Claude Desktop")?;
            // 选中的模型排第一，其余对话模型跟在后面供在 Claude Desktop 里切换
            let mut list = vec![first.clone()];
            list.extend(models.iter().filter(|m| **m != first).take(14).cloned());
            claude_desktop::apply(&paths.claude_desktop, &paths.data, &claude_desktop::Params { base_url: base, api_key: &key, models: &list }).map_err(|e| e.to_string())?
        }
        Client::Codex => {
            let m = chosen.as_deref().ok_or("该分组没有可用模型，无法配置 Codex")?;
            codex::apply(&paths.codex, &paths.data, &codex::Params { base_url: &format!("{base}/v1"), api_key: &key, model: m, provider_display_name: "Ferrydeck" }).map_err(|e| e.to_string())?
        }
        Client::Gemini => gemini::apply(&paths.gemini, &paths.data, &gemini::Params { base_url: base, api_key: &key, model: chosen.as_deref() }).map_err(|e| e.to_string())?,
    }
    let mut act = load_active(paths);
    act.insert(target, Active { site_id: site.id.clone(), site_name: site.name.clone(), group_id: group.id.clone(), group_name: group.name.clone(), model: chosen.clone() });
    save_active(paths, &act)?;
    crate::applog::log("enable_ok", &format!("{who} model={}", chosen.as_deref().unwrap_or("-")));
    Ok(EnableOutcome { client: target, key_created: created, models, model: chosen, conflicts: conflicts(paths, target) })
}

pub fn restore(paths: &Paths, client: Client) -> Result<(), String> {
    match client {
        Client::Claude => claude::restore(&paths.claude, &paths.data),
        Client::ClaudeDesktop => claude_desktop::restore(&paths.claude_desktop, &paths.data),
        Client::Codex => codex::restore(&paths.codex, &paths.data),
        Client::Gemini => gemini::restore(&paths.gemini, &paths.data),
    }
    .map_err(|e| e.to_string())?;
    let mut act = load_active(paths);
    act.remove(&client);
    save_active(paths, &act)
}

pub fn conflicts(paths: &Paths, client: Client) -> Vec<String> {
    match client {
        Client::Claude => claude::detect_conflicts(&paths.home, &paths.claude),
        Client::ClaudeDesktop => claude_desktop::detect_conflicts(&paths.claude_desktop),
        Client::Codex => codex::detect_env_conflicts(&paths.home).into_iter().map(|(f, v)| format!("{}: {v}", f.display())).collect(),
        Client::Gemini => gemini::detect_conflicts(&paths.home, &paths.gemini),
    }
}

pub fn overview(paths: &Paths) -> Vec<ClientOverview> {
    let act = load_active(paths);
    [Client::Claude, Client::ClaudeDesktop, Client::Codex, Client::Gemini]
        .into_iter()
        .map(|c| {
            let (dir, on) = match c {
                Client::Claude => (&paths.claude, claude::status(&paths.claude, &paths.data).map(|s| s.in_use)),
                Client::ClaudeDesktop => (&paths.claude_desktop, claude_desktop::status(&paths.claude_desktop, &paths.data).map(|s| s.in_use)),
                Client::Codex => (&paths.codex, codex::status(&paths.codex, &paths.data).map(|s| s.in_use)),
                Client::Gemini => (&paths.gemini, gemini::status(&paths.gemini, &paths.data).map(|s| s.in_use)),
            };
            let on = on.unwrap_or(false);
            ClientOverview { client: c, dir_exists: dir.exists(), in_use: on, active: if on { act.get(&c).cloned() } else { None }, conflicts: conflicts(paths, c), groups_inferred: false }
        })
        .collect()
}

#[cfg(test)]
mod category_tests {
    use super::*;

    #[test]
    fn legacy_client_ids_become_categories() {
        let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        assert_eq!(normalize_categories(&s(&["claude_desktop", "codex", "claude", "other", "nope"])), s(&["claude", "openai", "other"]));
        assert_eq!(normalize_categories(&s(&["video", "deepseek"])), s(&["deepseek", "video"]));
        assert!(normalize_categories(&s(&[])).is_empty());
    }

    #[test]
    fn only_claude_openai_gemini_categories_have_clients() {
        let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        assert_eq!(clients_for_categories(&s(&["claude", "openai"])), vec![Client::Claude, Client::ClaudeDesktop, Client::Codex]);
        assert!(clients_for_categories(&s(&["deepseek", "video", "audio", "other"])).is_empty());
    }
}
