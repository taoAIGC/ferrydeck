//! 多站点支持：把 sub2api 和 new-api 两种中转站统一成同一套接口。

pub mod http;
pub mod newapi;
pub mod sub2api;

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::clients::common::{fnv, load_state, save_state};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Sub2api,
    Newapi,
}

impl Kind {
    pub fn label(self) -> &'static str {
        match self {
            Kind::Sub2api => "sub2api",
            Kind::Newapi => "new-api",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Site {
    pub id: String,
    pub kind: Kind,
    pub name: String,
    pub base_url: String,
}

/// 统一后的分组。`id` 在站点内唯一（sub2api 是数字转字符串，new-api 直接用分组名）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct GroupInfo {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    /// anthropic / openai / gemini / grok / unknown
    pub platform: String,
    pub rate_multiplier: f64,
    /// 站点能直接告知的模型列表；为空表示需要用 Key 才能查到。
    pub models: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct AccountInfo {
    /// 显示用的账号名（邮箱或用户名）。
    pub display: String,
    /// 已按站点设置格式化好的余额，如 "$99.78"、"¥12.30"。
    pub balance: String,
}

/// 凭据被刷新（令牌轮换）时的回调，调用方负责持久化到钥匙串。
pub type SecretSink = Arc<dyn Fn(String) + Send + Sync>;

pub enum SiteClient {
    Sub2api(sub2api::Client),
    NewApi(newapi::Client),
}

impl SiteClient {
    pub fn new(kind: Kind, base_url: &str, sink: SecretSink) -> Self {
        match kind {
            Kind::Sub2api => SiteClient::Sub2api(sub2api::Client::new(base_url, sink)),
            Kind::Newapi => SiteClient::NewApi(newapi::Client::new(base_url, sink)),
        }
    }

    pub fn base(&self) -> &str {
        match self {
            SiteClient::Sub2api(c) => c.base(),
            SiteClient::NewApi(c) => c.base(),
        }
    }

    /// 账号密码登录。返回账号信息和需要持久化的凭据。
    pub async fn login(&self, user: &str, password: &str) -> Result<(AccountInfo, String), String> {
        match self {
            SiteClient::Sub2api(c) => c.login(user, password).await,
            SiteClient::NewApi(c) => c.login(user, password).await,
        }
    }

    /// 用保存的凭据恢复登录。
    pub async fn resume(&self, secret: &str) -> Result<(), String> {
        match self {
            SiteClient::Sub2api(c) => c.resume(secret).await,
            SiteClient::NewApi(c) => c.resume(secret).await,
        }
    }

    pub async fn is_logged_in(&self) -> bool {
        match self {
            SiteClient::Sub2api(c) => c.is_logged_in().await,
            SiteClient::NewApi(c) => c.is_logged_in().await,
        }
    }

    pub async fn logout(&self) {
        match self {
            SiteClient::Sub2api(c) => c.logout().await,
            SiteClient::NewApi(c) => c.logout().await,
        }
    }

    pub async fn me(&self) -> Result<AccountInfo, String> {
        match self {
            SiteClient::Sub2api(c) => c.me().await,
            SiteClient::NewApi(c) => c.me().await,
        }
    }

    pub async fn groups(&self) -> Result<Vec<GroupInfo>, String> {
        match self {
            SiteClient::Sub2api(c) => c.groups().await,
            SiteClient::NewApi(c) => c.groups().await,
        }
    }

    /// 找到该分组的桌面专用 Key，没有就创建。返回 (明文 Key, 是否新建)。
    pub async fn ensure_key(&self, group: &GroupInfo) -> Result<(String, bool), String> {
        match self {
            SiteClient::Sub2api(c) => c.ensure_key(group).await,
            SiteClient::NewApi(c) => c.ensure_key(group).await,
        }
    }

    pub async fn models(&self, key: &str) -> Vec<String> {
        match self {
            SiteClient::Sub2api(c) => c.models(key).await,
            SiteClient::NewApi(c) => c.models(key).await,
        }
    }

    /// 删除指定名称的 Key（端到端测试清理用）。
    pub async fn delete_key_named(&self, name: &str) -> Result<usize, String> {
        match self {
            SiteClient::Sub2api(c) => c.delete_key_named(name).await,
            SiteClient::NewApi(c) => c.delete_key_named(name).await,
        }
    }

    pub async fn all_key_names(&self) -> Result<Vec<String>, String> {
        match self {
            SiteClient::Sub2api(c) => c.all_key_names().await,
            SiteClient::NewApi(c) => c.all_key_names().await,
        }
    }

    pub async fn topup_url(&self) -> String {
        match self {
            SiteClient::Sub2api(c) => c.topup_url(),
            SiteClient::NewApi(c) => c.topup_url().await,
        }
    }
}

pub fn key_name(group: &GroupInfo) -> String {
    format!("desktop-{}", group.name)
}

// ---------- 地址与站点识别 ----------

/// 规范化用户输入的站点地址：补全协议、去掉结尾斜杠和路径；非本机地址必须是 https。
pub fn normalize_url(input: &str) -> Result<String, String> {
    let s = input.trim();
    if s.is_empty() {
        return Err("请输入站点地址".into());
    }
    let with_scheme = if s.contains("://") { s.to_string() } else { format!("https://{s}") };
    let (scheme, rest) = with_scheme.split_once("://").ok_or("站点地址格式不正确")?;
    let scheme = scheme.to_ascii_lowercase();
    if scheme != "http" && scheme != "https" {
        return Err("站点地址必须以 http:// 或 https:// 开头".into());
    }
    let host_port = rest.split(['/', '?', '#']).next().unwrap_or("");
    if host_port.is_empty() || host_port.contains(' ') || host_port.contains('@') {
        return Err("站点地址格式不正确".into());
    }
    let host = host_port.rsplit_once(':').map(|(h, p)| if p.chars().all(|c| c.is_ascii_digit()) { h } else { host_port }).unwrap_or(host_port);
    let is_local = matches!(host, "localhost" | "127.0.0.1" | "[::1]");
    if scheme == "http" && !is_local {
        return Err("出于安全考虑，只支持 https 站点（本机地址除外）".into());
    }
    if !is_local && !host.contains('.') {
        return Err("站点地址格式不正确".into());
    }
    Ok(format!("{scheme}://{}", host_port.to_ascii_lowercase()))
}

pub fn site_id(base_url: &str) -> String {
    format!("{:08x}", fnv(base_url) & 0xffff_ffff)
}

/// 默认的站点名称：取域名。
pub fn default_name(base_url: &str) -> String {
    base_url.split("://").nth(1).unwrap_or(base_url).split(':').next().unwrap_or(base_url).to_string()
}

fn probe_client(base_url: &str) -> reqwest::Client {
    let mut b = reqwest::Client::builder().timeout(Duration::from_secs(15)).user_agent(concat!("Ferrydeck/", env!("CARGO_PKG_VERSION")));
    if http::is_loopback(base_url) {
        b = b.no_proxy(); // 本机地址不走系统代理
    }
    b.build().expect("构建 HTTP 客户端失败")
}

/// 识别站点类型：sub2api 有 `/api/v1/settings/public`，new-api 有 `/api/status`。
pub async fn detect(base_url: &str) -> Result<Kind, String> {
    let http = probe_client(base_url);
    let get = |path: &str| {
        let rq = http.get(format!("{base_url}{path}"));
        async move { rq.send().await.map_err(|e| if e.is_timeout() { "连接超时，请检查地址和网络".to_string() } else { "无法连接到该站点，请检查地址和网络".to_string() }) }
    };
    let r = get("/api/v1/settings/public").await?;
    if r.status().is_success() {
        if let Ok(v) = r.json::<Value>().await {
            if v.get("code").is_some() && v.get("data").is_some() {
                return Ok(Kind::Sub2api);
            }
        }
    }
    let r = get("/api/status").await?;
    if r.status().is_success() {
        if let Ok(v) = r.json::<Value>().await {
            if v.get("success").and_then(Value::as_bool) == Some(true) && v.get("data").is_some() {
                return Ok(Kind::Newapi);
            }
        }
    }
    Err("无法识别该站点类型，目前支持 new-api 和 sub2api".into())
}

/// 预检站点是否支持在应用内登录（开启了人机验证、或关闭了密码登录的站点没法用）。
pub async fn check_supported(base_url: &str, kind: Kind) -> Result<(), String> {
    let http = probe_client(base_url);
    match kind {
        Kind::Newapi => {
            let v: Value = http.get(format!("{base_url}/api/status")).send().await.map_err(|_| "无法连接到该站点".to_string())?.json().await.unwrap_or(Value::Null);
            let d = v.get("data").unwrap_or(&Value::Null);
            if d.get("turnstile_check").and_then(Value::as_bool) == Some(true) {
                return Err("该站点开启了人机验证，暂不支持在应用内登录".into());
            }
            if d.get("password_login_enabled").and_then(Value::as_bool) == Some(false) {
                return Err("该站点没有开启账号密码登录，暂不支持".into());
            }
        }
        Kind::Sub2api => {
            let v: Value = http.get(format!("{base_url}/api/v1/settings/public")).send().await.map_err(|_| "无法连接到该站点".to_string())?.json().await.unwrap_or(Value::Null);
            if v.pointer("/data/turnstile_enabled").and_then(Value::as_bool) == Some(true) {
                return Err("该站点开启了人机验证，暂不支持在应用内登录".into());
            }
        }
    }
    Ok(())
}

// ---------- 站点列表（保存在应用数据目录） ----------

const SITES_FILE: &str = "sites.json";

#[derive(Debug, Default, Serialize, Deserialize)]
struct SiteFile {
    sites: Vec<Site>,
}

pub fn load_sites(data_dir: &Path) -> Vec<Site> {
    load_state::<SiteFile>(data_dir, SITES_FILE).map(|f| f.sites).unwrap_or_default()
}

pub fn save_sites(data_dir: &Path, sites: &[Site]) -> Result<(), String> {
    save_state(data_dir, SITES_FILE, &SiteFile { sites: sites.to_vec() }).map_err(|e| e.to_string())
}

/// 平台推断：根据模型名判断分组主要提供哪个厂商的模型（new-api 的分组没有平台字段）。
pub fn infer_platform(models: &[String]) -> String {
    let mut count = [("anthropic", 0usize), ("openai", 0), ("gemini", 0), ("grok", 0)];
    for m in models {
        let l = m.to_ascii_lowercase();
        let k = if l.starts_with("claude") {
            0
        } else if l.starts_with("gpt") || l.starts_with("o1") || l.starts_with("o3") || l.starts_with("o4") || l.starts_with("chatgpt") || l.starts_with("codex") {
            1
        } else if l.starts_with("gemini") {
            2
        } else if l.starts_with("grok") {
            3
        } else {
            continue;
        };
        count[k].1 += 1;
    }
    count.iter().max_by_key(|c| c.1).filter(|c| c.1 > 0).map(|c| c.0.to_string()).unwrap_or_else(|| "unknown".into())
}
