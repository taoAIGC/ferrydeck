//! new-api 站点适配：账号密码登录（Bearer 访问令牌 + 轮换的刷新 Cookie），分组来自
//! `/api/user/self/groups`，模型和平台由公开的 `/api/pricing` 推断。

use std::collections::BTreeMap;
use std::time::{SystemTime, UNIX_EPOCH};

use reqwest::Method;
use serde_json::{json, Value};
use tokio::sync::Mutex;

use super::http::{message_of, set_cookie_value, unexpected, Http};
use super::{infer_platform, key_name, AccountInfo, GroupInfo, SecretSink};

const REFRESH_COOKIE: &str = "new_api_refresh";

#[derive(Default, Clone)]
struct Session {
    access: String,
    /// 访问令牌过期时间（unix 秒），接近过期就先刷新。
    expires_at: i64,
    refresh_cookie: String,
    user_id: Option<i64>,
}

#[derive(Default, Clone)]
struct SiteInfo {
    quota_per_unit: f64,
    display_type: String,
    usd_rate: f64,
    custom_symbol: String,
    custom_rate: f64,
    top_up_link: Option<String>,
}

pub struct Client {
    http: Http,
    session: Mutex<Option<Session>>,
    info: Mutex<Option<SiteInfo>>,
    sink: SecretSink,
}

fn now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

/// new-api 很多失败是 HTTP 200 + success:false，所以必须看 success 字段。
fn failure(v: &Value) -> Option<String> {
    if v.get("success").and_then(Value::as_bool) == Some(false) {
        return Some(message_of(v).unwrap_or_else(|| "请求失败".into()));
    }
    None
}

/// 把额度格式化成站点设置的显示货币。
pub fn format_balance(quota: f64, info: &SiteInfoPub) -> String {
    let per = if info.quota_per_unit > 0.0 { info.quota_per_unit } else { 500_000.0 };
    let usd = quota / per;
    match info.display_type.as_str() {
        "CNY" => format!("¥{:.2}", usd * if info.usd_rate > 0.0 { info.usd_rate } else { 1.0 }),
        "CUSTOM" => format!("{}{:.2}", if info.custom_symbol.is_empty() { "¤" } else { &info.custom_symbol }, usd * if info.custom_rate > 0.0 { info.custom_rate } else { 1.0 }),
        "TOKENS" => format!("{} tokens", quota as i64),
        _ => format!("${usd:.2}"),
    }
}

pub type SiteInfoPub = PubInfo;

#[derive(Default, Clone)]
pub struct PubInfo {
    pub quota_per_unit: f64,
    pub display_type: String,
    pub usd_rate: f64,
    pub custom_symbol: String,
    pub custom_rate: f64,
}

/// 由公开的 `/api/pricing` 数据整理出 “分组 → 模型列表”。
pub fn models_by_group(pricing: &Value) -> BTreeMap<String, Vec<String>> {
    let mut out: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for m in pricing.get("data").and_then(Value::as_array).into_iter().flatten() {
        let Some(name) = m.get("model_name").and_then(Value::as_str) else { continue };
        for g in m.get("enable_groups").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str) {
            out.entry(g.to_string()).or_default().push(name.to_string());
        }
    }
    out
}

/// 合并 `/api/user/self/groups`（名称、说明、倍率）与模型信息。
pub fn build_groups(self_groups: &Value, models: &BTreeMap<String, Vec<String>>) -> Vec<GroupInfo> {
    let Some(map) = self_groups.get("data").and_then(Value::as_object) else { return vec![] };
    map.iter()
        .map(|(name, v)| {
            let ms = models.get(name).cloned().unwrap_or_default();
            GroupInfo {
                id: name.clone(),
                name: name.clone(),
                description: v.get("desc").and_then(Value::as_str).filter(|s| !s.is_empty()).map(String::from),
                platform: infer_platform(&ms),
                rate_multiplier: v.get("ratio").and_then(Value::as_f64).unwrap_or(1.0),
                models: ms,
            }
        })
        .collect()
}

impl Client {
    pub fn new(base: &str, sink: SecretSink) -> Self {
        Client { http: Http::new(base), session: Mutex::new(None), info: Mutex::new(None), sink }
    }

    pub fn base(&self) -> &str {
        &self.http.base
    }

    pub async fn is_logged_in(&self) -> bool {
        self.session.lock().await.is_some()
    }

    pub async fn logout(&self) {
        let s = self.session.lock().await.take();
        if let Some(s) = s.filter(|s| !s.refresh_cookie.is_empty()) {
            let _ = self.http.send(Method::POST, "/api/user/auth/logout", None, Some(&format!("{REFRESH_COOKIE}={}", s.refresh_cookie)), &[], Some(json!({}))).await;
        }
    }

    /// 站点公开信息（额度换算、充值链接），也用来提前发现“需要人机验证”之类的限制。
    async fn site_info(&self) -> Result<SiteInfo, String> {
        if let Some(i) = self.info.lock().await.clone() {
            return Ok(i);
        }
        let r = self.http.send(Method::GET, "/api/status", None, None, &[], None).await?;
        let d = r.body.get("data").ok_or_else(|| unexpected(r.status))?;
        if d.get("turnstile_check").and_then(Value::as_bool) == Some(true) {
            return Err("该站点开启了人机验证，暂不支持在应用内登录".into());
        }
        if d.get("password_login_enabled").and_then(Value::as_bool) == Some(false) {
            return Err("该站点没有开启账号密码登录，暂不支持".into());
        }
        let f = |k: &str| d.get(k).and_then(Value::as_f64).unwrap_or(0.0);
        let info = SiteInfo {
            quota_per_unit: f("quota_per_unit"),
            display_type: d.get("quota_display_type").and_then(Value::as_str).unwrap_or("USD").to_string(),
            usd_rate: f("usd_exchange_rate"),
            custom_symbol: d.get("custom_currency_symbol").and_then(Value::as_str).unwrap_or("").to_string(),
            custom_rate: f("custom_currency_exchange_rate"),
            top_up_link: d.get("top_up_link").and_then(Value::as_str).filter(|s| s.starts_with("http")).map(String::from),
        };
        *self.info.lock().await = Some(info.clone());
        Ok(info)
    }

    fn pub_info(i: &SiteInfo) -> PubInfo {
        PubInfo { quota_per_unit: i.quota_per_unit, display_type: i.display_type.clone(), usd_rate: i.usd_rate, custom_symbol: i.custom_symbol.clone(), custom_rate: i.custom_rate }
    }

    fn account_from(&self, user: &Value, info: &SiteInfo, fallback: &str) -> AccountInfo {
        let name = user.get("display_name").and_then(Value::as_str).filter(|s| !s.is_empty()).or_else(|| user.get("username").and_then(Value::as_str)).unwrap_or(fallback);
        AccountInfo { display: name.to_string(), balance: format_balance(user.get("quota").and_then(Value::as_f64).unwrap_or(0.0), &Self::pub_info(info)) }
    }

    pub async fn login(&self, username: &str, password: &str) -> Result<(AccountInfo, String), String> {
        let info = self.site_info().await?;
        let r = self.http.send(Method::POST, "/api/user/login", None, None, &[], Some(json!({"username": username, "password": password}))).await?;
        if let Some(e) = failure(&r.body) {
            return Err(e);
        }
        if !r.status.is_success() {
            return Err(message_of(&r.body).unwrap_or_else(|| format!("登录失败（HTTP {}）", r.status.as_u16())));
        }
        let d = r.body.get("data").ok_or_else(|| unexpected(r.status))?;
        if d.get("require_2fa").and_then(Value::as_bool) == Some(true) {
            return Err("该账号开启了二次验证，暂不支持在应用内登录".into());
        }
        let (Some(access), Some(cookie)) = (d.get("access_token").and_then(Value::as_str), set_cookie_value(&r.headers, REFRESH_COOKIE)) else {
            return Err("该站点的 new-api 版本较旧，暂不支持在应用内登录（需要 rc.45 或更新版本）".into());
        };
        let user = d.get("user").cloned().unwrap_or(Value::Null);
        *self.session.lock().await = Some(Session {
            access: access.to_string(),
            expires_at: d.get("access_expires_at").and_then(Value::as_i64).unwrap_or(now() + 600),
            refresh_cookie: cookie.clone(),
            user_id: user.get("id").and_then(Value::as_i64),
        });
        Ok((self.account_from(&user, &info, username), cookie))
    }

    pub async fn resume(&self, cookie: &str) -> Result<(), String> {
        *self.session.lock().await = Some(Session { refresh_cookie: cookie.to_string(), ..Default::default() });
        match self.refresh().await {
            Ok(()) => Ok(()),
            Err(e) => {
                *self.session.lock().await = None;
                Err(e)
            }
        }
    }

    /// 用刷新 Cookie 换新的访问令牌；服务器每次都会轮换 Cookie，必须保存新值。
    async fn refresh(&self) -> Result<(), String> {
        let cur = self.session.lock().await.clone().ok_or("未登录")?;
        let r = self.http.send(Method::POST, "/api/user/auth/refresh", None, Some(&format!("{REFRESH_COOKIE}={}", cur.refresh_cookie)), &[], Some(json!({}))).await?;
        let d = r.body.get("data").unwrap_or(&Value::Null);
        let Some(access) = d.get("access_token").and_then(Value::as_str).filter(|_| r.status.is_success() && failure(&r.body).is_none()) else {
            return Err("登录已过期，请重新登录".into());
        };
        let cookie = set_cookie_value(&r.headers, REFRESH_COOKIE).unwrap_or(cur.refresh_cookie);
        *self.session.lock().await = Some(Session {
            access: access.to_string(),
            expires_at: d.get("access_expires_at").and_then(Value::as_i64).unwrap_or(now() + 600),
            refresh_cookie: cookie.clone(),
            user_id: d.pointer("/user/id").and_then(Value::as_i64).or(cur.user_id),
        });
        (self.sink)(cookie);
        Ok(())
    }

    /// 带登录态的请求。令牌快过期时先刷新；遇到 401 刷新一次再重试。返回完整响应体。
    async fn call(&self, m: Method, path: &str, body: Option<Value>) -> Result<Value, String> {
        {
            let s = self.session.lock().await.clone().ok_or("未登录")?;
            if s.access.is_empty() || s.expires_at - now() < 30 {
                self.refresh().await?;
            }
        }
        for attempt in 0..2 {
            let s = self.session.lock().await.clone().ok_or("未登录")?;
            let extra: Vec<(&str, String)> = s.user_id.map(|u| vec![("New-Api-User", u.to_string())]).unwrap_or_default();
            let r = self.http.send(m.clone(), path, Some(&s.access), None, &extra, body.clone()).await?;
            if r.status.as_u16() == 401 && attempt == 0 {
                self.refresh().await?;
                continue;
            }
            if let Some(e) = failure(&r.body) {
                return Err(e);
            }
            if !r.status.is_success() {
                return Err(message_of(&r.body).unwrap_or_else(|| format!("请求失败（HTTP {}）", r.status.as_u16())));
            }
            return Ok(r.body);
        }
        Err("登录已过期，请重新登录".into())
    }

    pub async fn me(&self) -> Result<AccountInfo, String> {
        let info = self.site_info().await?;
        let v = self.call(Method::GET, "/api/user/self", None).await?;
        Ok(self.account_from(v.get("data").unwrap_or(&Value::Null), &info, ""))
    }

    pub async fn groups(&self) -> Result<Vec<GroupInfo>, String> {
        let selfg = self.call(Method::GET, "/api/user/self/groups", None).await?;
        // 模型信息来自公开接口；拿不到时分组仍然可见，只是平台无法判断
        let pricing = self.http.send(Method::GET, "/api/pricing", None, None, &[], None).await.map(|r| r.body).unwrap_or(Value::Null);
        Ok(build_groups(&selfg, &models_by_group(&pricing)))
    }

    async fn list_tokens(&self) -> Result<Vec<Value>, String> {
        let mut all = vec![];
        for page in 1..=20 {
            let v = self.call(Method::GET, &format!("/api/token/?p={page}&size=100"), None).await?;
            let items = v.pointer("/data/items").and_then(Value::as_array).cloned().unwrap_or_default();
            let n = items.len();
            all.extend(items);
            if n < 100 {
                break;
            }
        }
        Ok(all)
    }

    /// 列表里的 Key 是脱敏的，明文要单独取；返回值没有 `sk-` 前缀。
    async fn full_key(&self, id: i64) -> Result<String, String> {
        let v = self.call(Method::POST, &format!("/api/token/{id}/key"), Some(json!({}))).await?;
        let k = v.pointer("/data/key").and_then(Value::as_str).or_else(|| v.get("data").and_then(Value::as_str)).ok_or("取 Key 明文失败")?;
        Ok(if k.starts_with("sk-") { k.to_string() } else { format!("sk-{k}") })
    }

    pub async fn ensure_key(&self, group: &GroupInfo) -> Result<(String, bool), String> {
        let name = key_name(group);
        let usable = |t: &Value| t.get("name").and_then(Value::as_str) == Some(name.as_str()) && t.get("group").and_then(Value::as_str) == Some(group.name.as_str()) && t.get("status").and_then(Value::as_i64).unwrap_or(1) == 1;
        let before = self.list_tokens().await?;
        if let Some(id) = before.iter().find(|t| usable(t)).and_then(|t| t.get("id").and_then(Value::as_i64)) {
            return Ok((self.full_key(id).await?, false));
        }
        let known: Vec<i64> = before.iter().filter_map(|t| t.get("id").and_then(Value::as_i64)).collect();
        self.call(
            Method::POST,
            "/api/token/",
            Some(json!({"name": name, "group": group.name, "remain_quota": 0, "unlimited_quota": true, "expired_time": -1, "model_limits_enabled": false, "model_limits": "", "allow_ips": "", "cross_group_retry": false})),
        )
        .await?;
        // 创建接口不返回 id，重新列出找新增的那条
        let id = self
            .list_tokens()
            .await?
            .iter()
            .find(|t| usable(t) && t.get("id").and_then(Value::as_i64).is_some_and(|i| !known.contains(&i)))
            .and_then(|t| t.get("id").and_then(Value::as_i64))
            .ok_or("创建 Key 后没有找到它")?;
        Ok((self.full_key(id).await?, true))
    }

    pub async fn delete_key_named(&self, name: &str) -> Result<usize, String> {
        let mut n = 0;
        for id in self.list_tokens().await?.iter().filter(|t| t.get("name").and_then(Value::as_str) == Some(name)).filter_map(|t| t.get("id").and_then(Value::as_i64)) {
            self.call(Method::DELETE, &format!("/api/token/{id}"), None).await?;
            n += 1;
        }
        Ok(n)
    }

    pub async fn all_key_names(&self) -> Result<Vec<String>, String> {
        Ok(self.list_tokens().await?.iter().filter_map(|t| t.get("name").and_then(Value::as_str).map(String::from)).collect())
    }

    pub async fn models(&self, key: &str) -> Vec<String> {
        self.http.models_for_key(key).await
    }

    pub async fn topup_url(&self) -> String {
        match self.site_info().await {
            Ok(i) => i.top_up_link.unwrap_or_else(|| format!("{}/console/topup", self.http.base)),
            Err(_) => format!("{}/console/topup", self.http.base),
        }
    }
}
