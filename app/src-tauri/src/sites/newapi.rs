//! new-api 站点适配：账号密码登录（Bearer 访问令牌 + 轮换的刷新 Cookie），分组来自
//! `/api/user/self/groups`，模型和平台由公开的 `/api/pricing` 推断。

use std::collections::BTreeMap;

use reqwest::Method;
use serde_json::{json, Value};
use tokio::sync::Mutex;

use super::http::{message_of, now, refresh_rejected, retry_later, set_cookie_value, unexpected, Http, EXPIRED};
use crate::usage::{latency_summary, GroupUsage, ModelUsage, PriceEstimate, WINDOW_DAYS};
use super::{infer_platform, is_our_key_name, key_name, AccountInfo, GroupInfo, SecretSink};

const REFRESH_COOKIE: &str = "new_api_refresh";

/// `access` 为空表示手里只有刷新 Cookie、还没换到访问令牌（比如启动时网络不通）。
#[derive(Default, Clone)]
struct Session {
    access: String,
    /// 访问令牌过期时间（unix 秒），接近过期就先刷新。
    expires_at: i64,
    refresh_cookie: String,
    user_id: Option<i64>,
    /// 最近一次成功登录或刷新的时间（unix 秒），用于定期续期。
    refreshed_at: i64,
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
    /// 同一时间只允许一个刷新请求：刷新 Cookie 每次都会轮换，并发刷新时后到的那个会用已作废的 Cookie 把登录弄丢。
    refreshing: Mutex<()>,
    info: Mutex<Option<SiteInfo>>,
    /// `/api/pricing` 的短期缓存（读时间，内容）：批量读各分组成本时每个分组都要用它，没必要请求几十遍。
    pricing_cache: Mutex<Option<(i64, Value)>>,
    /// Key 明文缓存（token id → 明文）。取明文的接口和登录、刷新令牌共用“严格档”限流桶
    /// （默认每 IP 每 20 分钟 20 次），Key 的明文又不会变，所以每把只取一次。
    key_cache: Mutex<std::collections::HashMap<i64, String>>,
    /// 最近 20 分钟里我们向“严格档”接口读取 Key 明文的时间。自己给自己设预算，别把站点的额度用光。
    critical_calls: Mutex<std::collections::VecDeque<i64>>,
    /// 已经为哪些分组创建过 Key、却没能读回来。不再重复创建，免得在站点上堆出一串没用的 Key。
    pending_create: Mutex<std::collections::HashSet<String>>,
    sink: SecretSink,
}

/// 严格档（默认每 IP 每 20 分钟 20 次）里留给读取 Key 的预算；其余额度留给登录和刷新令牌。
const CRITICAL_BUDGET: usize = 12;
const CRITICAL_WINDOW_SECS: i64 = 20 * 60;

/// 一次批量查找最多新取几把 Key 的明文，给登录和刷新令牌留足严格档的额度；剩下的下次再取。
const MAX_KEY_FETCH_PER_SWEEP: usize = 6;

/// new-api 很多失败是 HTTP 200 + success:false，所以必须看 success 字段。
fn failure(v: &Value) -> Option<String> {
    if v.get("success").and_then(Value::as_bool) == Some(false) {
        return Some(message_of(v).unwrap_or_else(|| "请求失败".into()));
    }
    None
}

/// 把额度格式化成站点设置的显示货币。
/// 一次日志最多翻几页（每页 100 条）。
const USAGE_PAGES: usize = 3;

fn info_per_unit(info: &SiteInfo) -> f64 {
    if info.quota_per_unit > 0.0 { info.quota_per_unit } else { 500_000.0 }
}

/// 额度（quota）换成站点显示货币的系数：返回 (货币符号, 每 1 额度值多少)。显示为 TOKENS 时直接按额度算。
fn money_factor(info: &SiteInfo) -> (String, f64) {
    let per = info_per_unit(info);
    match info.display_type.as_str() {
        "CNY" => ("¥".into(), if info.usd_rate > 0.0 { info.usd_rate } else { 1.0 } / per),
        "CUSTOM" => (if info.custom_symbol.is_empty() { "¤".into() } else { info.custom_symbol.clone() }, if info.custom_rate > 0.0 { info.custom_rate } else { 1.0 } / per),
        "TOKENS" => ("额度".into(), 1.0),
        _ => ("$".into(), 1.0 / per),
    }
}

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

/// 这个 Key 是不是本应用为该分组建的。名称里本来就带分组名（`Ferrydeck-<分组名>`，旧版 `desktop-<分组名>`），
/// 所以名称对得上就够了；列表里**如果报告了分组**才要求分组一致。
/// 有的 new-api 版本（比如 pqh.ai）的 Key 列表不返回分组信息（所有 Key 的 group 都是空），要求分组一致就永远匹配不上，
/// 结果每次都当作“还没建过”，反复创建、又找不回来。
fn token_is_ours(t: &Value, g: &GroupInfo) -> bool {
    let name_ok = t.get("name").and_then(Value::as_str).is_some_and(|n| is_our_key_name(n, g));
    let group_ok = match t.get("group").and_then(Value::as_str) {
        Some(tg) if !tg.is_empty() => tg == g.name,
        _ => true,
    };
    name_ok && group_ok
}

/// 日志用：这把 Key 在列表里有哪些字段、分组字段是什么（不含 Key 本身，也不含任何额度和 IP 白名单细节）。
fn describe_token(t: &Value) -> String {
    let fields: Vec<&str> = t.as_object().map(|o| o.keys().map(|k| k.as_str()).filter(|k| *k != "key").collect()).unwrap_or_default();
    let group = match t.get("group") {
        Some(Value::String(g)) if !g.is_empty() => format!("{g:?}"),
        Some(_) => "空".to_string(),
        None => "无该字段".to_string(),
    };
    format!("#{} 分组字段={group} 字段名=[{}]", t.get("id").and_then(Value::as_i64).unwrap_or(-1), fields.join(","))
}

fn token_enabled(t: &Value) -> bool {
    t.get("status").and_then(Value::as_i64).unwrap_or(1) == 1
}

impl Client {
    pub fn new(base: &str, sink: SecretSink) -> Self {
        Client { http: Http::new(base), session: Mutex::new(None), refreshing: Mutex::new(()), info: Mutex::new(None), pricing_cache: Mutex::new(None), key_cache: Mutex::new(Default::default()), critical_calls: Mutex::new(Default::default()), pending_create: Mutex::new(Default::default()), sink }
    }

    pub fn base(&self) -> &str {
        &self.http.base
    }

    pub async fn is_logged_in(&self) -> bool {
        self.session.lock().await.is_some()
    }

    pub async fn logout(&self) {
        self.key_cache.lock().await.clear();
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
        let name = ["display_name", "username", "email"].iter().find_map(|k| user.get(*k).and_then(Value::as_str).filter(|s| !s.trim().is_empty())).unwrap_or(fallback);
        AccountInfo { display: name.to_string(), balance: format_balance(user.get("quota").and_then(Value::as_f64).unwrap_or(0.0), &Self::pub_info(info)) }
    }

    pub async fn login(&self, username: &str, password: &str) -> Result<(AccountInfo, String), String> {
        let info = self.site_info().await?;
        let _g = self.refreshing.lock().await; // 别让同时进行的刷新用旧 Cookie 覆盖新登录
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
            refreshed_at: now(),
        });
        Ok((self.account_from(&user, &info, username), cookie))
    }

    /// 用保存的刷新 Cookie 恢复登录。站点明确拒绝时清掉登录状态；网络等暂时性问题则保留 Cookie，之后自动重试。
    pub async fn resume(&self, cookie: &str) -> Result<(), String> {
        let _g = self.refreshing.lock().await;
        if self.session.lock().await.as_ref().is_some_and(|s| !s.access.is_empty()) {
            return Ok(()); // 别处已经恢复好了
        }
        *self.session.lock().await = Some(Session { refresh_cookie: cookie.to_string(), ..Default::default() });
        self.refresh_locked().await
    }

    /// 用刷新 Cookie 换新的访问令牌。`seen` 是调用方拿到的 Cookie；排队期间别人已经刷新过（Cookie 变了）就直接用新的。
    async fn refresh(&self, seen: &str) -> Result<(), String> {
        let _g = self.refreshing.lock().await;
        match self.session.lock().await.as_ref() {
            None => return Err(EXPIRED.into()),
            Some(s) if s.refresh_cookie != seen && !s.access.is_empty() => return Ok(()),
            Some(_) => {}
        }
        self.refresh_locked().await
    }

    /// 已持有 `refreshing` 锁时调用。服务器每次都会轮换 Cookie，必须保存新值。
    async fn refresh_locked(&self) -> Result<(), String> {
        let cur = self.session.lock().await.clone().ok_or(EXPIRED)?;
        let r = self.http.send(Method::POST, "/api/user/auth/refresh", None, Some(&format!("{REFRESH_COOKIE}={}", cur.refresh_cookie)), &[], Some(json!({}))).await.map_err(|e| retry_later(&e))?;
        let d = r.body.get("data").unwrap_or(&Value::Null);
        let Some(access) = d.get("access_token").and_then(Value::as_str).filter(|a| !a.is_empty() && r.status.is_success() && failure(&r.body).is_none()) else {
            if refresh_rejected(r.status, &r.body) {
                *self.session.lock().await = None;
                return Err(EXPIRED.into());
            }
            return Err(retry_later(&format!("HTTP {}", r.status.as_u16())));
        };
        let cookie = set_cookie_value(&r.headers, REFRESH_COOKIE).unwrap_or(cur.refresh_cookie);
        *self.session.lock().await = Some(Session {
            access: access.to_string(),
            expires_at: d.get("access_expires_at").and_then(Value::as_i64).unwrap_or(now() + 600),
            refresh_cookie: cookie.clone(),
            user_id: d.pointer("/user/id").and_then(Value::as_i64).or(cur.user_id),
            refreshed_at: now(),
        });
        (self.sink)(cookie);
        Ok(())
    }

    /// 距上次成功刷新超过 `max_age` 秒就主动刷新一次，让刷新 Cookie 不断续期。没登录时什么都不做。
    pub async fn keep_alive(&self, max_age: i64) -> Result<(), String> {
        let seen = match self.session.lock().await.as_ref() {
            Some(s) if s.access.is_empty() || now() - s.refreshed_at >= max_age => s.refresh_cookie.clone(),
            _ => return Ok(()),
        };
        crate::applog::log("keepalive", &format!("{} 登录凭据该续期了，现在续期", self.http.base));
        self.refresh(&seen).await
    }

    /// 带登录态的请求。令牌快过期时先刷新；遇到 401 刷新一次再重试。返回完整响应体。
    async fn call(&self, m: Method, path: &str, body: Option<Value>) -> Result<Value, String> {
        {
            let s = self.session.lock().await.clone().ok_or("未登录")?;
            if s.access.is_empty() || s.expires_at - now() < 30 {
                self.refresh(&s.refresh_cookie).await?;
            }
        }
        for attempt in 0..2 {
            let s = self.session.lock().await.clone().ok_or("未登录")?;
            let extra: Vec<(&str, String)> = s.user_id.map(|u| vec![("New-Api-User", u.to_string())]).unwrap_or_default();
            let r = self.http.send(m.clone(), path, Some(&s.access), None, &extra, body.clone()).await?;
            if r.status.as_u16() == 401 && attempt == 0 {
                self.refresh(&s.refresh_cookie).await?;
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

    /// 列出所有 Key。同时带 `page_size` 和 `size`（不同版本认的参数名不同），并按返回的 `total` 翻页：
    /// 不能靠“一页不满 100 条就是最后一页”判断，否则站点实际一页只给 10 条时，只会看到 10 个 Key。
    async fn list_tokens(&self) -> Result<Vec<Value>, String> {
        let mut all: Vec<Value> = vec![];
        for page in 1..=50 {
            let v = self.call(Method::GET, &format!("/api/token/?p={page}&page_size=100&size=100"), None).await?;
            let items = v.pointer("/data/items").and_then(Value::as_array).cloned().unwrap_or_default();
            let total = v.pointer("/data/total").and_then(Value::as_u64).map(|t| t as usize);
            let n = items.len();
            // 站点不认分页参数、每页都返回同一批时，别无限翻下去
            if page > 1 && !items.is_empty() && items.iter().all(|t| all.contains(t)) {
                break;
            }
            all.extend(items);
            let done = match total {
                Some(t) => all.len() >= t,
                None => n < 100,
            };
            if n == 0 || done {
                break;
            }
        }
        Ok(all)
    }

    /// 列表里的 Key 是脱敏的，明文要单独取；返回值没有 `sk-` 前缀。
    /// 还有预算就返回 Ok；用完了就返回“站点限流保护”提示（界面会据此停止对这个站点的批量操作）。
    async fn critical_check(&self) -> Result<(), String> {
        let mut q = self.critical_calls.lock().await;
        let t = now();
        while q.front().is_some_and(|x| t - x >= CRITICAL_WINDOW_SECS) {
            q.pop_front();
        }
        if q.len() >= CRITICAL_BUDGET {
            let wait = q.front().map(|x| x + CRITICAL_WINDOW_SECS - t).unwrap_or(60).max(1);
            let msg = format!("站点限流保护：20 分钟内读取 Key 已达 {CRITICAL_BUDGET} 次，为避免登录和续期被站点限流，请 {} 后再试", super::http::wait_text(wait));
            crate::applog::log("key_budget", &format!("{} {msg}", self.http.base));
            return Err(msg);
        }
        Ok(())
    }

    async fn critical_note(&self) {
        self.critical_calls.lock().await.push_back(now());
    }

    async fn full_key(&self, id: i64) -> Result<String, String> {
        if let Some(k) = self.key_cache.lock().await.get(&id) {
            return Ok(k.clone());
        }
        self.critical_check().await?;
        self.critical_note().await;
        let v = self.call(Method::POST, &format!("/api/token/{id}/key"), Some(json!({}))).await?;
        let k = v.pointer("/data/key").and_then(Value::as_str).or_else(|| v.get("data").and_then(Value::as_str)).ok_or("取 Key 明文失败")?;
        let k = if k.starts_with("sk-") { k.to_string() } else { format!("sk-{k}") };
        self.key_cache.lock().await.insert(id, k.clone());
        Ok(k)
    }

    /// 一次列出所有 Key，返回各分组已有的本应用 Key 明文。不会新建。
    /// 列表里的 Key 是脱敏的，只对“确实有 Key 的分组”各取一次明文。
    pub async fn existing_keys(&self, groups: &[GroupInfo]) -> Result<Vec<(usize, String)>, String> {
        let tokens = self.list_tokens().await?;
        let mut out = vec![];
        let mut fetched = 0;
        for (i, g) in groups.iter().enumerate() {
            let found = tokens.iter().find(|t| token_is_ours(t, g) && token_enabled(t));
            if let Some(id) = found.and_then(|t| t.get("id").and_then(Value::as_i64)) {
                let cached = self.key_cache.lock().await.contains_key(&id);
                if !cached {
                    if fetched >= MAX_KEY_FETCH_PER_SWEEP {
                        continue; // 这次取够了，留给下一次
                    }
                    fetched += 1;
                }
                match self.full_key(id).await {
                    Ok(k) => out.push((i, k)),
                    Err(e) if super::http::is_rate_limited(&e) => break, // 预算或站点限流：把已经拿到的返回，剩下的下次再说
                    Err(e) => return Err(e),
                }
            }
        }
        Ok(out)
    }

    pub async fn ensure_key(&self, group: &GroupInfo) -> Result<(String, bool), String> {
        let name = key_name(group);
        let usable = |t: &Value| token_is_ours(t, group) && token_enabled(t);
        let before = self.list_tokens().await?;
        if let Some(t) = before.iter().find(|t| usable(t)) {
            if let Some(id) = t.get("id").and_then(Value::as_i64) {
                if !self.key_cache.lock().await.contains_key(&id) {
                    crate::applog::log("key_reuse", &format!("{} 分组={} 复用已有 Key：{}", self.http.base, group.name, describe_token(t)));
                }
                return Ok((self.full_key(id).await?, false));
            }
        }
        let known: Vec<i64> = before.iter().filter_map(|t| t.get("id").and_then(Value::as_i64)).collect();
        // 上次已经为这个分组创建过、却没读回来：不要再建一把，让用户去站点上看看
        if self.pending_create.lock().await.contains(&group.name) {
            return Err(format!("上次已经为分组「{}」创建过 Key（{name}），但没能在列表里读到它，不再重复创建；请到站点的令牌页面看看它是否存在", group.name));
        }
        // 新建之后马上要读一次明文：预算不够就别建，免得在站点上留下一把读不出来的 Key
        self.critical_check().await?;
        crate::applog::log("key_create", &format!("{} 为分组 {} 创建 Key {}", self.http.base, group.name, name));
        self.call(
            Method::POST,
            "/api/token/",
            Some(json!({"name": name, "group": group.name, "remain_quota": 0, "unlimited_quota": true, "expired_time": -1, "model_limits_enabled": false, "model_limits": "", "allow_ips": "", "cross_group_retry": false})),
        )
        .await?;
        // 创建接口不返回 id，重新列出找新增的那条（状态不限：只要名称和分组对得上就是它）。
        // 站点可能有读写延迟，找不到就隔一会儿再找，最多三次。
        let ours = |t: &Value| token_is_ours(t, group);
        let mut tokens = vec![];
        let mut found: Option<i64> = None;
        for attempt in 0..3 {
            if attempt > 0 {
                tokio::time::sleep(std::time::Duration::from_millis(700)).await;
            }
            tokens = self.list_tokens().await?;
            found = tokens.iter().filter(|t| ours(t) && t.get("id").and_then(Value::as_i64).is_some_and(|i| !known.contains(&i))).filter_map(|t| t.get("id").and_then(Value::as_i64)).max();
            if found.is_some() {
                break;
            }
        }
        let Some(id) = found else {
            self.pending_create.lock().await.insert(group.name.clone());
            // 把站点实际返回了什么记下来（只有 id、名称、分组、状态，不含 Key），方便弄清为什么对不上
            let mut recent: Vec<&Value> = tokens.iter().collect();
            recent.sort_by_key(|t| std::cmp::Reverse(t.get("id").and_then(Value::as_i64).unwrap_or(0)));
            let brief: Vec<String> = recent
                .iter()
                .take(6)
                .map(|t| format!("#{} {:?} group={:?} status={}", t.get("id").and_then(Value::as_i64).unwrap_or(-1), t.get("name").and_then(Value::as_str).unwrap_or(""), t.get("group").and_then(Value::as_str).unwrap_or(""), t.get("status").and_then(Value::as_i64).unwrap_or(-1)))
                .collect();
            crate::applog::log("key_lookup_fail", &format!("{} 分组={} 想找的名称={name} 列表共 {} 条（创建前 {} 条）；最新 6 条：{}", self.http.base, group.name, tokens.len(), before.len(), brief.join(" | ")));
            return Err("创建 Key 后没有找到它".into());
        };
        if let Some(t) = tokens.iter().find(|t| t.get("id").and_then(Value::as_i64) == Some(id)) {
            crate::applog::log("key_created", &format!("{} 分组={} 已创建并找到：{}", self.http.base, group.name, describe_token(t)));
        }
        let key = self.full_key(id).await?;
        self.pending_create.lock().await.remove(&group.name);
        Ok((key, true))
    }

    async fn cached_pricing(&self) -> Value {
        if let Some((at, v)) = self.pricing_cache.lock().await.as_ref() {
            if now() - at < 300 {
                return v.clone();
            }
        }
        let v = self.http.send(Method::GET, "/api/pricing", None, None, &[], None).await.map(|r| r.body).unwrap_or(Value::Null);
        if !v.is_null() {
            *self.pricing_cache.lock().await = Some((now(), v.clone()));
        }
        v
    }

    /// 翻页读取消费类日志（最多 `USAGE_PAGES` 页，每页 100 条）。`path` 是 `/api/log/self`（自己的）或 `/api/log/`（管理员看全站的），`filter` 是 `group=…` / `channel=…`。
    async fn fetch_logs(&self, path: &str, filter: &str, start: i64, end: i64) -> Result<(Vec<Value>, Option<i64>), String> {
        let mut logs: Vec<Value> = vec![];
        let mut total: Option<i64> = None;
        for page in 1..=USAGE_PAGES {
            let v = self.call(Method::GET, &format!("{path}?p={page}&page_size=100&type=2&{filter}&start_timestamp={start}&end_timestamp={end}"), None).await?;
            let items = v.pointer("/data/items").and_then(Value::as_array).cloned().unwrap_or_default();
            total = v.pointer("/data/total").and_then(Value::as_i64).or(total);
            let n = items.len();
            logs.extend(items);
            if n < 100 || total.is_some_and(|t| logs.len() as i64 >= t) {
                break;
            }
        }
        Ok((logs, total))
    }

    /// 近 7 天这个分组的成本统计，来自“我的使用日志”（`/api/log/self`，只读消费类记录，最多翻 3 页共 300 条）。
    /// new-api 没有官方价合计，所以没有“实际倍率”；预估价格由 `/api/pricing` 的模型倍率 × 分组倍率算出。
    pub async fn group_usage(&self, group: &GroupInfo) -> Result<GroupUsage, String> {
        let info = self.site_info().await?;
        let (symbol, factor) = money_factor(&info);
        let mut u = GroupUsage { window_days: WINDOW_DAYS, currency: symbol, nominal_multiplier: group.rate_multiplier, fetched_at: now(), ..Default::default() };
        let end = now();
        let start = end - WINDOW_DAYS as i64 * 86_400;
        let enc: String = group.name.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect();
        let (logs, total) = self.fetch_logs("/api/log/self", &format!("group={enc}"), start, end).await?;
        fold_logs(&mut u, &logs, total, factor);

        // 预估价格：模型倍率 × 2 = 每百万输入 token 的美元价，再乘分组倍率
        let pricing = self.cached_pricing().await;
        for m in pricing.get("data").and_then(Value::as_array).into_iter().flatten() {
            let (Some(name), Some(ratio)) = (m.get("model_name").and_then(Value::as_str), m.get("model_ratio").and_then(Value::as_f64)) else { continue };
            let in_group = m.get("enable_groups").and_then(Value::as_array).is_some_and(|g| g.iter().any(|x| x.as_str() == Some(group.name.as_str())));
            if !in_group || m.get("quota_type").and_then(Value::as_i64).unwrap_or(0) != 0 || !crate::service::is_chat_model(name) {
                continue;
            }
            let usd_in = ratio * 2.0 * group.rate_multiplier;
            let comp = m.get("completion_ratio").and_then(Value::as_f64).unwrap_or(1.0);
            let unit = factor * info_per_unit(&info);
            u.estimates.push(PriceEstimate { model: name.to_string(), input_per_m: usd_in * unit, output_per_m: usd_in * comp * unit, cache_read_per_m: m.get("cache_ratio").and_then(Value::as_f64).map(|c| usd_in * c * unit) });
        }
        if u.sampled {
            u.notes.push(format!("窗口内共 {} 条记录，只统计了最近 {} 条", u.total_requests, u.requests));
        }
        u.finish();
        Ok(u)
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

    pub async fn models_result(&self, key: &str) -> Result<Vec<String>, String> {
        self.http.models_for_key_result(key).await
    }

    pub async fn topup_url(&self) -> String {
        match self.site_info().await {
            Ok(i) => i.top_up_link.unwrap_or_else(|| format!("{}/console/topup", self.http.base)),
            Err(_) => format!("{}/console/topup", self.http.base),
        }
    }
}

/* ---------- 日志汇总 ---------- */

/// 把一批消费日志累加进 `u`（token、缓存、花费、首字时延、按模型）。`factor` 是额度换成显示货币的系数。
fn fold_logs(u: &mut GroupUsage, logs: &[Value], total: Option<i64>, factor: f64) {
    let mut by_model: BTreeMap<String, ModelUsage> = BTreeMap::new();
    let mut frt: Vec<u64> = vec![];
    let (mut dur_sum, mut dur_n) = (0.0, 0u32);
    for l in logs {
        let i = |k: &str| l.get(k).and_then(Value::as_i64).unwrap_or(0);
        // `other` 在不同版本里可能是 JSON 字符串，也可能直接是对象
        let other = match l.get("other") {
            Some(Value::String(s)) => serde_json::from_str::<Value>(s).unwrap_or(Value::Null),
            Some(v) => v.clone(),
            None => Value::Null,
        };
        let oi = |k: &str| other.get(k).and_then(Value::as_i64).unwrap_or(0);
        let (cr, cc) = (oi("cache_tokens"), oi("cache_creation_tokens"));
        // `usage_semantic` 说明 prompt_tokens 的口径：anthropic = 不含缓存；其余（OpenAI 等）= 已含缓存读取，要扣掉才是真正的新输入
        let semantic = other.get("usage_semantic").and_then(Value::as_str).unwrap_or("");
        let prompt = i("prompt_tokens");
        let inp = if semantic.is_empty() || semantic == "anthropic" { prompt } else { (prompt - cr).max(0) };
        let (out, cost) = (i("completion_tokens"), i("quota") as f64 * factor);
        u.input_tokens += inp;
        u.output_tokens += out;
        u.cache_read_tokens += cr;
        u.cache_creation_tokens += cc;
        u.cost += cost;
        if let Some(f) = other.get("frt").and_then(Value::as_i64).filter(|f| *f > 0) {
            frt.push(f as u64);
        }
        let t = i("use_time");
        if t > 0 {
            dur_sum += t as f64 * 1000.0;
            dur_n += 1;
        }
        let m = by_model.entry(l.get("model_name").and_then(Value::as_str).unwrap_or("?").to_string()).or_default();
        m.model = l.get("model_name").and_then(Value::as_str).unwrap_or("?").to_string();
        m.requests += 1;
        m.input_tokens += inp;
        m.output_tokens += out;
        m.cache_read_tokens += cr;
        m.cache_creation_tokens += cc;
        m.cost += cost;
    }
    // 过去 24 小时的 Token 量：日志按时间倒序，翻满了而最旧的一条还在 24 小时内，说明真实值更大
    let cutoff = now() - 86_400;
    let at = |l: &Value| l.get("created_at").and_then(Value::as_i64).unwrap_or(0);
    let tok = |l: &Value| {
        let other = match l.get("other") {
            Some(Value::String(s)) => serde_json::from_str::<Value>(s).unwrap_or(Value::Null),
            Some(v) => v.clone(),
            None => Value::Null,
        };
        let o = |k: &str| other.get(k).and_then(Value::as_i64).unwrap_or(0);
        let i = |k: &str| l.get(k).and_then(Value::as_i64).unwrap_or(0);
        i("prompt_tokens") + i("completion_tokens") + o("cache_creation_tokens") + if other.get("usage_semantic").and_then(Value::as_str).is_some_and(|s| s != "anthropic" && !s.is_empty()) { 0 } else { o("cache_tokens") }
    };
    u.tokens_24h = Some(logs.iter().filter(|l| at(l) >= cutoff).map(tok).sum());
    u.cost_24h = Some(logs.iter().filter(|l| at(l) >= cutoff).map(|l| l.get("quota").and_then(Value::as_i64).unwrap_or(0) as f64 * factor).sum());
    u.tokens_24h_capped = total.is_some_and(|t| t > logs.len() as i64) && logs.iter().map(at).min().is_some_and(|m| m >= cutoff);
    u.requests = logs.len() as i64;
    u.sample_requests = logs.len();
    u.total_requests = total.unwrap_or(u.requests).max(u.requests);
    u.sampled = u.total_requests > u.requests;
    u.avg_duration_ms = (dur_n > 0).then(|| dur_sum / dur_n as f64);
    (u.first_token_median_ms, u.first_token_p90_ms, u.first_token_samples) = latency_summary(frt);
    u.models = by_model.into_values().collect();

}

// ---------- 站长：上下游一体管理 ----------

/// 一个渠道整理成 `Upstream`。渠道里的 `key` 等凭据一律不取。
fn parse_channel(c: &Value) -> Option<crate::admin::Upstream> {
    let id = c.get("id").and_then(Value::as_i64)?.to_string();
    let status_n = c.get("status").and_then(Value::as_i64).unwrap_or(1);
    let (status, error) = match status_n {
        1 => ("active", None),
        2 => ("paused", None),
        _ => ("error", Some("被系统自动禁用（上游连续失败或额度用完）".to_string())),
    };
    let csv = |k: &str| -> Vec<String> { c.get(k).and_then(Value::as_str).unwrap_or("").split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect() };
    Some(crate::admin::Upstream {
        id,
        name: c.get("name").and_then(Value::as_str).unwrap_or("").trim().to_string(),
        // 渠道本身没有“平台”：按它支持的模型推断（claude → anthropic …），推断不出就留空
        platform: Some(infer_platform(&csv("models"))).filter(|p| p != "unknown").unwrap_or_default(),
        kind: c.get("type").and_then(Value::as_i64).map(|t| t.to_string()).unwrap_or_default(),
        status: status.into(),
        account_status: match status_n { 1 => "active", 2 => "inactive", _ => "error" }.into(),
        schedulable: None,
        error,
        host: c.get("base_url").and_then(Value::as_str).filter(|s| !s.is_empty()).and_then(crate::admin::host_of),
        groups: csv("group"),
        models: csv("models").len(),
        model_names: csv("models"),
        rate_multiplier: None,
        priority: c.get("priority").and_then(Value::as_i64),
    })
}

/// `/api/option/` 里取某个 JSON 对象型设置（GroupRatio、UserUsableGroups）。
fn option_object(opts: &Value, key: &str) -> serde_json::Map<String, Value> {
    opts.get("data")
        .and_then(Value::as_array)
        .and_then(|a| a.iter().find(|o| o.get("key").and_then(Value::as_str) == Some(key)))
        .and_then(|o| o.get("value").and_then(Value::as_str))
        .and_then(|s| serde_json::from_str::<Value>(s).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default()
}

impl Client {
    /// 当前登录的账号是不是管理员（渠道管理只有管理员能看）。
    pub async fn admin_probe(&self) -> Result<(), String> {
        self.call(Method::GET, "/api/channel/?p=1&page_size=1", None).await.map(|_| ()).map_err(|e| if e.contains("权限") || e.contains("无权") || e.to_lowercase().contains("permission") || e.to_lowercase().contains("unauthorized") { "该账号不是这个站点的管理员".to_string() } else { e })
    }

    pub async fn admin_overview(&self) -> Result<crate::admin::AdminOverview, String> {
        let mut upstreams = vec![];
        for page in 1..=30 {
            let v = self.call(Method::GET, &format!("/api/channel/?p={page}&page_size=100"), None).await?;
            let items = v.pointer("/data/items").and_then(Value::as_array).cloned().unwrap_or_default();
            let n = items.len();
            let total = v.pointer("/data/total").and_then(Value::as_u64).map(|t| t as usize);
            upstreams.extend(items.iter().filter_map(parse_channel));
            if n < 100 || total.is_some_and(|t| upstreams.len() >= t) {
                break;
            }
        }
        // 分组的倍率和备注在系统设置里（只有超级管理员能读）；读不到就只列出渠道里出现过的分组名，并标为不可编辑
        let (ratios, descs, editable) = match self.call(Method::GET, "/api/option/", None).await {
            Ok(opts) => (option_object(&opts, "GroupRatio"), option_object(&opts, "UserUsableGroups"), true),
            Err(_) => (Default::default(), Default::default(), false),
        };
        let mut names: Vec<String> = ratios.keys().cloned().collect();
        for g in upstreams.iter().flat_map(|u| u.groups.iter()) {
            if !names.contains(g) {
                names.push(g.clone());
            }
        }
        names.sort();
        let downstreams = names
            .into_iter()
            .map(|n| crate::admin::Downstream {
                description: descs.get(&n).and_then(Value::as_str).filter(|s| !s.is_empty()).map(String::from),
                // 分组的类别：由它来源的渠道支持的模型推断
                platform: Some(infer_platform(&upstreams.iter().filter(|u| u.groups.contains(&n)).flat_map(|u| u.model_names.clone()).collect::<Vec<_>>())).filter(|p| p != "unknown").unwrap_or_default(),
                rate_multiplier: ratios.get(&n).and_then(Value::as_f64).unwrap_or(1.0),
                status: "active".into(),
                editable,
                id: n.clone(),
                name: n,
            })
            .collect();
        Ok(crate::admin::AdminOverview { upstreams, downstreams, fetched_at: now() })
    }

    /// 暂停 / 恢复一个渠道。优先用专门的状态接口 `POST /api/channel/{id}/status`（api.aicompare.club 这个版本上实测可用，
    /// 而它的 `PUT /api/channel/` 无论怎么传都返回 “Invalid parameters”）；站点没有这个接口（404）时，退回
    /// “读出完整渠道、改状态、整条写回”：只发一个字段会让站点按残缺的记录重建能力表。
    pub async fn admin_set_paused(&self, id: &str, paused: bool) -> Result<(), String> {
        let status = if paused { 2 } else { 1 };
        match self.call(Method::POST, &format!("/api/channel/{id}/status"), Some(json!({ "status": status }))).await {
            Ok(_) => return Ok(()),
            Err(e) if e.contains("404") || e.contains("Invalid URL") => {}
            Err(e) => return Err(e),
        }
        let v = self.call(Method::GET, &format!("/api/channel/{id}"), None).await?;
        let mut ch = v.get("data").cloned().ok_or("读不到这个渠道")?;
        ch["status"] = json!(status);
        self.call(Method::PUT, "/api/channel/", Some(ch)).await.map(|_| ())
    }

    pub async fn admin_remove_upstream(&self, id: &str) -> Result<(), String> {
        self.call(Method::DELETE, &format!("/api/channel/{id}"), None).await.map(|_| ())
    }

    /// 改分组的倍率和备注（new-api 的分组名就是它的标识，已有的 Key、用户、渠道都按名字引用，所以不支持改名；也没有“分类”）。
    pub async fn admin_update_group(&self, id: &str, edit: &crate::admin::GroupEdit) -> Result<(), String> {
        edit.validate()?;
        if edit.name.as_deref().is_some_and(|n| n.trim() != id) {
            return Err("new-api 的分组名就是分组的标识，改名会让已有的 Key 和渠道对不上，请在站点后台处理".into());
        }
        let opts = self.call(Method::GET, "/api/option/", None).await.map_err(|e| format!("读不到分组设置（需要超级管理员）：{e}"))?;
        let mut put = |key: &'static str, field: Value| {
            let mut m = option_object(&opts, key);
            m.insert(id.to_string(), field);
            (key, Value::Object(m).to_string())
        };
        let mut writes = vec![];
        if let Some(r) = edit.rate_multiplier {
            writes.push(put("GroupRatio", json!(r)));
        }
        if let Some(d) = &edit.description {
            writes.push(put("UserUsableGroups", json!(d)));
        }
        for (key, value) in writes {
            self.call(Method::PUT, "/api/option/", Some(json!({ "key": key, "value": value }))).await?;
        }
        Ok(())
    }
}

impl Client {
    /// 站长视角的近 7 天用量：读管理员能看的全站消费日志（`/api/log/`），`scope` 为 `group`（按分组名）或 `account`（按渠道 id）。
    /// 注意：new-api 的日志里只有“用户付了多少额度”，没有“上游收了你多少”，所以渠道的花费是它带来的收入，不是上游成本。
    pub async fn admin_usage(&self, scope: &str, id: &str) -> Result<GroupUsage, String> {
        let info = self.site_info().await?;
        let (symbol, factor) = money_factor(&info);
        let mut u = GroupUsage { window_days: WINDOW_DAYS, currency: symbol, fetched_at: now(), ..Default::default() };
        let end = now();
        let start = end - WINDOW_DAYS as i64 * 86_400;
        let filter = if scope == "account" {
            id.parse::<i64>().map_err(|_| "id 不正确".to_string())?;
            format!("channel={id}")
        } else {
            let enc: String = id.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect();
            format!("group={enc}")
        };
        let (logs, total) = self.fetch_logs("/api/log/", &filter, start, end).await?;
        fold_logs(&mut u, &logs, total, factor);
        if u.sampled {
            u.notes.push(format!("窗口内共 {} 条记录，只统计了最近 {} 条", u.total_requests, u.requests));
        }
        u.finish();
        Ok(u)
    }
}

impl Client {
    /// 新建下游分组：在系统设置里加上分组倍率和备注（需要超级管理员）。new-api 的分组名就是 id。
    pub async fn admin_create_group(&self, g: &crate::admin::NewGroup) -> Result<String, String> {
        g.validate()?;
        let name = g.name.trim().to_string();
        let opts = self.call(Method::GET, "/api/option/", None).await.map_err(|e| format!("读不到分组设置（需要超级管理员）：{e}"))?;
        let mut ratios = option_object(&opts, "GroupRatio");
        if ratios.contains_key(&name) {
            return Err(format!("已经有一个叫「{name}」的分组"));
        }
        ratios.insert(name.clone(), json!(g.rate_multiplier));
        self.call(Method::PUT, "/api/option/", Some(json!({ "key": "GroupRatio", "value": Value::Object(ratios).to_string() }))).await?;
        if let Some(d) = g.description.as_ref().filter(|d| !d.trim().is_empty()) {
            let mut descs = option_object(&opts, "UserUsableGroups");
            descs.insert(name.clone(), json!(d.trim()));
            self.call(Method::PUT, "/api/option/", Some(json!({ "key": "UserUsableGroups", "value": Value::Object(descs).to_string() }))).await?;
        }
        Ok(name)
    }

    /// 新建渠道并绑定到下游分组。new-api 的创建接口不返回 id，所以创建后按名称在列表里找最新的一个。
    pub async fn admin_create_upstream(&self, u: &crate::admin::NewUpstream) -> Result<String, String> {
        let channel = json!({
            "name": u.name, "type": crate::admin::channel_type(&u.platform), "key": u.api_key, "base_url": u.base_url.trim_end_matches('/'),
            "models": u.models.join(","), "group": u.group_ids.join(","), "priority": 0, "weight": 0, "status": 1,
        });
        self.call(Method::POST, "/api/channel/", Some(json!({ "mode": "single", "channel": channel }))).await?;
        let mut best: Option<i64> = None;
        for page in 1..=30 {
            let v = self.call(Method::GET, &format!("/api/channel/?p={page}&page_size=100"), None).await?;
            let items = v.pointer("/data/items").and_then(Value::as_array).cloned().unwrap_or_default();
            let n = items.len();
            for c in &items {
                if c.get("name").and_then(Value::as_str).map(str::trim) == Some(u.name.trim()) {
                    let id = c.get("id").and_then(Value::as_i64).unwrap_or(0);
                    best = Some(best.map_or(id, |b| b.max(id)));
                }
            }
            if n < 100 {
                break;
            }
        }
        best.map(|i| i.to_string()).ok_or_else(|| "渠道创建后在列表里找不到它".to_string())
    }
}

impl Client {
    /// 删除下游分组：从分组倍率和备注设置里去掉它（需要超级管理员）。渠道里绑着它的不会被改。
    pub async fn admin_remove_group(&self, id: &str) -> Result<(), String> {
        let opts = self.call(Method::GET, "/api/option/", None).await.map_err(|e| format!("读不到分组设置（需要超级管理员）：{e}"))?;
        let mut ratios = option_object(&opts, "GroupRatio");
        if ratios.remove(id).is_none() {
            return Err(format!("设置里没有分组「{id}」"));
        }
        self.call(Method::PUT, "/api/option/", Some(json!({ "key": "GroupRatio", "value": Value::Object(ratios).to_string() }))).await?;
        let mut descs = option_object(&opts, "UserUsableGroups");
        if descs.remove(id).is_some() {
            self.call(Method::PUT, "/api/option/", Some(json!({ "key": "UserUsableGroups", "value": Value::Object(descs).to_string() }))).await?;
        }
        Ok(())
    }

    /// 更换渠道的来源：这个版本的渠道更新接口不可靠（`PUT /api/channel/` 实测一律 Invalid parameters），
    /// 所以不在原渠道上改，而是由调用方新建渠道、成功后再删旧的。这里不提供就地更新。
    pub async fn admin_update_upstream_source(&self, _id: &str, _u: &crate::admin::NewUpstream) -> Result<(), String> {
        Err("new-api 站点不支持就地更换来源".into())
    }
}

impl Client {
    /// new-api 的渠道只有一个开关（启用 / 停用）：`active` = 启用，`inactive` = 手动停用。
    pub async fn admin_set_account_status(&self, id: &str, status: &str) -> Result<(), String> {
        match status {
            "active" => self.admin_set_paused(id, false).await,
            "inactive" => self.admin_set_paused(id, true).await,
            _ => Err("状态只能是 active 或 inactive".into()),
        }
    }
}
