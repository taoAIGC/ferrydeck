//! sub2api 站点适配：邮箱 + 密码登录，Key 绑定分组，Key 明文可重复读取。

use reqwest::Method;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::Mutex;

use super::http::{message_of, now, refresh_rejected, retry_later, unexpected, Http, EXPIRED};
use super::{is_our_key_name, key_name, AccountInfo, GroupInfo, SecretSink};
use crate::usage::{latency_summary, GroupUsage, ModelUsage, PriceEstimate, WINDOW_DAYS};

#[derive(Debug, Deserialize)]
struct RawGroup {
    id: i64,
    name: String,
    #[serde(default)]
    description: Option<String>,
    platform: String,
    #[serde(default)]
    rate_multiplier: f64,
    #[serde(default)]
    status: String,
}

#[derive(Debug, Deserialize)]
struct RawKey {
    id: i64,
    name: String,
    key: String,
    #[serde(default)]
    group_id: Option<i64>,
    #[serde(default)]
    status: String,
}

/// `access` 为空表示手里只有刷新令牌、还没换到访问令牌（比如启动时网络不通）。
struct Tokens {
    access: String,
    refresh: String,
    /// 最近一次成功登录或刷新的时间（unix 秒），用于定期续期。
    refreshed_at: i64,
}

/// 账号名：优先邮箱，没有就用用户名（有的站点只返回其一，两种都可能为空）。
fn display_name(user: &Value, fallback: &str) -> String {
    ["email", "username", "name"]
        .iter()
        .find_map(|k| user.get(*k).and_then(Value::as_str).filter(|s| !s.trim().is_empty()))
        .unwrap_or(fallback)
        .to_string()
}

pub struct Client {
    http: Http,
    tokens: Mutex<Option<Tokens>>,
    /// 同一时间只允许一个刷新请求：刷新令牌可能是一次性的，并发刷新会让后到的那个把登录弄丢。
    refreshing: Mutex<()>,
    /// 模型广场读不到的情况是否已经记过日志
    plaza_logged: std::sync::atomic::AtomicBool,
    sink: SecretSink,
}

fn money(v: &Value) -> String {
    format!("${:.2}", v.as_f64().unwrap_or(0.0))
}

impl Client {
    pub fn new(base: &str, sink: SecretSink) -> Self {
        Client { http: Http::new(base), tokens: Mutex::new(None), refreshing: Mutex::new(()), plaza_logged: Default::default(), sink }
    }

    pub fn base(&self) -> &str {
        &self.http.base
    }

    pub async fn is_logged_in(&self) -> bool {
        self.tokens.lock().await.is_some()
    }

    pub async fn logout(&self) {
        *self.tokens.lock().await = None;
    }

    pub async fn login(&self, email: &str, password: &str) -> Result<(AccountInfo, String), String> {
        let _g = self.refreshing.lock().await; // 别让同时进行的刷新用旧令牌覆盖新登录
        let r =self.http.send(Method::POST, "/api/v1/auth/login", None, None, &[], Some(json!({"email": email, "password": password}))).await?;
        if !r.status.is_success() {
            return Err(match r.status.as_u16() {
                401 | 400 | 422 => message_of(&r.body).unwrap_or_else(|| "邮箱或密码不正确".into()),
                c => message_of(&r.body).unwrap_or_else(|| format!("登录失败（HTTP {c}）")),
            });
        }
        if r.body.is_null() {
            return Err(unexpected(r.status));
        }
        let d = r.body.get("data").unwrap_or(&r.body);
        let (Some(a), Some(rf)) = (d.get("access_token").and_then(Value::as_str), d.get("refresh_token").and_then(Value::as_str)) else {
            return Err("该账号开启了二次验证，暂不支持在应用内登录，请先在网站上关闭，或等待后续版本".into());
        };
        *self.tokens.lock().await = Some(Tokens { access: a.into(), refresh: rf.into(), refreshed_at: now() });
        let acc =AccountInfo { display: d.pointer("/user/email").and_then(Value::as_str).unwrap_or(email).into(), balance: money(d.pointer("/user/balance").unwrap_or(&Value::Null)) };
        Ok((acc, rf.into()))
    }

    /// 用保存的刷新令牌恢复登录。站点明确拒绝时清掉登录状态；网络等暂时性问题则保留令牌，之后自动重试。
    pub async fn resume(&self, refresh: &str) -> Result<(), String> {
        let _g = self.refreshing.lock().await;
        if self.tokens.lock().await.as_ref().is_some_and(|t| !t.access.is_empty()) {
            return Ok(()); // 别处已经恢复好了
        }
        *self.tokens.lock().await = Some(Tokens { access: String::new(), refresh: refresh.into(), refreshed_at: 0 });
        self.refresh_locked().await
    }

    /// 刷新访问令牌。`seen` 是调用方拿到的刷新令牌；排队期间别人已经刷新过（令牌变了）就直接用新的，不再重复刷新。
    async fn refresh(&self, seen: &str) -> Result<(), String> {
        let _g = self.refreshing.lock().await;
        match self.tokens.lock().await.as_ref() {
            None => return Err(EXPIRED.into()),
            Some(t) if t.refresh != seen && !t.access.is_empty() => return Ok(()),
            Some(_) => {}
        }
        self.refresh_locked().await
    }

    /// 已持有 `refreshing` 锁时调用。
    async fn refresh_locked(&self) -> Result<(), String> {
        let refresh = self.tokens.lock().await.as_ref().map(|t| t.refresh.clone()).ok_or(EXPIRED)?;
        let r = self.http.send(Method::POST, "/api/v1/auth/refresh", None, None, &[], Some(json!({"refresh_token": refresh}))).await.map_err(|e| retry_later(&e))?;
        let d = r.body.get("data").unwrap_or(&r.body);
        if let (true, Some(a)) = (r.status.is_success(), d.get("access_token").and_then(Value::as_str).filter(|a| !a.is_empty())) {
            let rf = d.get("refresh_token").and_then(Value::as_str).filter(|s| !s.is_empty()).unwrap_or(&refresh).to_string();
            *self.tokens.lock().await = Some(Tokens { access: a.into(), refresh: rf.clone(), refreshed_at: now() });
            (self.sink)(rf); // 令牌可能轮换，及时持久化
            return Ok(());
        }
        if refresh_rejected(r.status, &r.body) {
            *self.tokens.lock().await = None;
            return Err(EXPIRED.into());
        }
        Err(retry_later(&format!("HTTP {}", r.status.as_u16())))
    }

    /// 距上次成功刷新超过 `max_age` 秒就主动刷新一次，让会轮换的刷新令牌不断续期。没登录时什么都不做。
    pub async fn keep_alive(&self, max_age: i64) -> Result<(), String> {
        let seen = match self.tokens.lock().await.as_ref() {
            Some(t) if t.access.is_empty() || now() - t.refreshed_at >= max_age => t.refresh.clone(),
            _ => return Ok(()),
        };
        crate::applog::log("keepalive", &format!("{} 登录凭据该续期了，现在续期", self.http.base));
        self.refresh(&seen).await
    }

    /// 带登录态的请求；还没有访问令牌就先刷新，遇到 401 自动刷新一次再重试。返回 `data` 字段。
    async fn call(&self, m: Method, path: &str, body: Option<Value>) -> Result<Value, String> {
        for attempt in 0..2 {
            let (access, seen) = self.tokens.lock().await.as_ref().map(|t| (t.access.clone(), t.refresh.clone())).ok_or("未登录")?;
            if access.is_empty() {
                self.refresh(&seen).await?;
                continue;
            }
            let r = self.http.send(m.clone(), path, Some(&access), None, &[], body.clone()).await?;
            if r.status.as_u16() == 401 && attempt == 0 {
                self.refresh(&seen).await?;
                continue;
            }
            if r.status.is_success() {
                return Ok(r.body.get("data").cloned().unwrap_or(r.body));
            }
            return Err(message_of(&r.body).unwrap_or_else(|| format!("请求失败（HTTP {}）", r.status.as_u16())));
        }
        Err(EXPIRED.into())
    }

    pub async fn me(&self) -> Result<AccountInfo, String> {
        let d = self.call(Method::GET, "/api/v1/auth/me", None).await?;
        Ok(AccountInfo { display: display_name(&d, ""), balance: money(d.get("balance").unwrap_or(&Value::Null)) })
    }

    pub async fn groups(&self) -> Result<Vec<GroupInfo>, String> {
        let d = self.call(Method::GET, "/api/v1/groups/available", None).await?;
        let arr = if d.is_array() { d } else { d.get("items").cloned().unwrap_or(Value::Array(vec![])) };
        let raw: Vec<RawGroup> = serde_json::from_value(arr).map_err(|e| format!("分组数据格式异常: {e}"))?;
        // 模型：站点开了“模型广场”就直接读（不需要 Key，也不需要测速）；没开就留空，之后靠已建好的 Key 查询
        let plaza = self.plaza_models().await;
        Ok(raw
            .into_iter()
            .filter(|g| g.status.is_empty() || g.status == "active")
            .map(|g| {
                let models = plaza.get(&g.id).cloned().unwrap_or_default();
                GroupInfo { id: g.id.to_string(), name: g.name, description: g.description, platform: g.platform, rate_multiplier: g.rate_multiplier, models }
            })
            .collect())
    }

    /// 读“模型广场”（`GET /api/v1/model-plaza`），得到 分组 id → 模型名列表。
    /// 带着登录令牌访问，所以连你有权使用的**专属分组**也在里面（匿名只能看到公开分组）。
    /// 这个功能由站点管理员开关，关闭时返回 404；任何失败都当作“没有”，不影响分组本身。
    /// 读模型广场的原始数据；读不到（站点没开、出错）返回 None，同一个站点只记一次日志。
    async fn plaza_raw(&self) -> Option<Value> {
        match self.call(Method::GET, "/api/v1/model-plaza", None).await {
            Ok(d) => Some(d),
            Err(e) => {
                if !self.plaza_logged.swap(true, std::sync::atomic::Ordering::Relaxed) {
                    crate::applog::log("plaza", &format!("{} 没有读到模型广场（站点可能没开启），分组的模型改由已建好的 Key 查询：{e}", self.http.base));
                }
                None
            }
        }
    }

    async fn plaza_models(&self) -> std::collections::HashMap<i64, Vec<String>> {
        let Some(d) = self.plaza_raw().await else { return Default::default() };
        d.get("groups")
            .and_then(Value::as_array)
            .map(|gs| {
                gs.iter()
                    .filter_map(|g| {
                        let id = g.get("id").and_then(Value::as_i64)?;
                        let names: Vec<String> = g.get("models").and_then(Value::as_array)?.iter().filter_map(|m| m.get("name").and_then(Value::as_str)).map(String::from).collect();
                        Some((id, names))
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    /// 近 7 天这个分组的成本统计。一共 4 个请求（汇总、按模型、最近请求的首字时延、模型广场定价），
    /// 只有“汇总”失败才算整体失败，其余是锦上添花：拿不到就少一块，并在 `notes` 里说明。
    pub async fn group_usage(&self, group: &GroupInfo) -> Result<GroupUsage, String> {
        let gid: i64 = group.id.parse().map_err(|_| "分组 id 不正确".to_string())?;
        let mut u = GroupUsage { window_days: WINDOW_DAYS, currency: "$".into(), nominal_multiplier: group.rate_multiplier, fetched_at: now(), ..Default::default() };

        // 1) 汇总（缓存 token 在这里单独给出）
        let s = self.call(Method::GET, &format!("/api/v1/usage/stats?group_id={gid}&period=week"), None).await?;
        let n = |k: &str| s.get(k).and_then(Value::as_i64).unwrap_or(0);
        let f = |k: &str| s.get(k).and_then(Value::as_f64).unwrap_or(0.0);
        u.requests = n("total_requests");
        u.total_requests = u.requests;
        u.input_tokens = n("total_input_tokens");
        u.output_tokens = n("total_output_tokens");
        u.cache_creation_tokens = n("total_cache_creation_tokens");
        u.cache_read_tokens = n("total_cache_read_tokens");
        u.cost = f("total_actual_cost");
        u.official_cost = Some(f("total_cost"));
        u.avg_duration_ms = s.get("average_duration_ms").and_then(Value::as_f64).filter(|v| *v > 0.0);

        // 2) 按模型
        match self.call(Method::GET, &format!("/api/v1/usage/dashboard/models?group_id={gid}&period=week"), None).await {
            Ok(d) => {
                u.models = d
                    .get("models")
                    .and_then(Value::as_array)
                    .map(|a| {
                        a.iter()
                            .filter_map(|m| {
                                Some(ModelUsage {
                                    model: m.get("model").and_then(Value::as_str)?.to_string(),
                                    requests: m.get("requests").and_then(Value::as_i64).unwrap_or(0),
                                    input_tokens: m.get("input_tokens").and_then(Value::as_i64).unwrap_or(0),
                                    output_tokens: m.get("output_tokens").and_then(Value::as_i64).unwrap_or(0),
                                    cache_creation_tokens: m.get("cache_creation_tokens").and_then(Value::as_i64).unwrap_or(0),
                                    cache_read_tokens: m.get("cache_read_tokens").and_then(Value::as_i64).unwrap_or(0),
                                    cost: m.get("actual_cost").and_then(Value::as_f64).unwrap_or(0.0),
                                    cost_per_m_effective: None,
                                })
                            })
                            .collect()
                    })
                    .unwrap_or_default();
            }
            Err(e) => u.notes.push(format!("没有拿到按模型的统计：{e}")),
        }

        // 3) 最近的请求：取真实的首字时延（只有流式请求才有）
        if u.requests > 0 {
            match self.call(Method::GET, &format!("/api/v1/usage?group_id={gid}&page=1&page_size=100&sort_by=created_at&sort_order=desc"), None).await {
                Ok(d) => {
                    let samples: Vec<u64> = d
                        .get("items")
                        .and_then(Value::as_array)
                        .map(|a| a.iter().filter_map(|r| r.get("first_token_ms").and_then(Value::as_i64)).filter(|ms| *ms > 0).map(|ms| ms as u64).collect())
                        .unwrap_or_default();
                    (u.first_token_median_ms, u.first_token_p90_ms, u.first_token_samples) = latency_summary(samples);
                }
                Err(e) => u.notes.push(format!("没有拿到真实首字时延：{e}")),
            }
        }

        // 4) 模型广场里的定价，换算成“官方价 × 倍率”的预估（没开广场就没有，不算错误）
        if let Some(plaza) = self.plaza_raw().await {
            u.estimates = plaza_estimates(&plaza, gid, group.rate_multiplier);
        }

        u.finish();
        Ok(u)
    }

    async fn keys(&self) -> Result<Vec<RawKey>, String> {
        let mut all = vec![];
        for page in 1..=20 {
            let d = self.call(Method::GET, &format!("/api/v1/keys?page={page}&page_size=100"), None).await?;
            let items: Vec<RawKey> = serde_json::from_value(d.get("items").cloned().unwrap_or(Value::Array(vec![]))).map_err(|e| format!("Key 数据格式异常: {e}"))?;
            let n = items.len();
            all.extend(items);
            if n < 100 {
                break;
            }
        }
        Ok(all)
    }

    /// 一次列出所有 Key，返回各分组已有的本应用 Key 明文（sub2api 的列表里就带明文）。不会新建。
    /// 返回 (分组在入参里的下标, Key)。每个站点只发一次请求，而不是每个分组一次。
    pub async fn existing_keys(&self, groups: &[GroupInfo]) -> Result<Vec<(usize, String)>, String> {
        let keys = self.keys().await?;
        Ok(groups
            .iter()
            .enumerate()
            .filter_map(|(i, g)| {
                let gid: i64 = g.id.parse().ok()?;
                keys.iter().find(|k| is_our_key_name(&k.name, g) && k.group_id == Some(gid) && (k.status.is_empty() || k.status == "active")).map(|k| (i, k.key.clone()))
            })
            .collect())
    }

    pub async fn ensure_key(&self, group: &GroupInfo) -> Result<(String, bool), String> {
        let gid: i64 = group.id.parse().map_err(|_| "分组 id 不正确".to_string())?;
        let name = key_name(group);
        if let Some(k) = self.keys().await?.into_iter().find(|k| is_our_key_name(&k.name, group) && k.group_id == Some(gid) && (k.status.is_empty() || k.status == "active")) {
            return Ok((k.key, false));
        }
        let d = self.call(Method::POST, "/api/v1/keys", Some(json!({"name": name, "group_id": gid}))).await?;
        let k: RawKey = serde_json::from_value(d).map_err(|e| format!("创建 Key 的返回格式异常: {e}"))?;
        Ok((k.key, true))
    }

    /// 删除（测试清理用）。
    pub async fn delete_key_named(&self, name: &str) -> Result<usize, String> {
        let mut n = 0;
        for k in self.keys().await?.into_iter().filter(|k| k.name == name) {
            self.call(Method::DELETE, &format!("/api/v1/keys/{}", k.id), None).await?;
            n += 1;
        }
        Ok(n)
    }

    pub async fn all_key_names(&self) -> Result<Vec<String>, String> {
        Ok(self.keys().await?.into_iter().map(|k| k.name).collect())
    }

    pub async fn models(&self, key: &str) -> Vec<String> {
        self.http.models_for_key(key).await
    }

    pub fn topup_url(&self) -> String {
        format!("{}/purchase", self.http.base)
    }
}

/// 由模型广场里这个分组的定价算预估：官方价（每 token）× 100 万 × 倍率。
/// 倍率优先用你个人的专属倍率（`user_rate_multiplier`），没有就用分组标称倍率。只收按 token 计费的对话模型。
fn plaza_estimates(plaza: &Value, group_id: i64, fallback_multiplier: f64) -> Vec<PriceEstimate> {
    let Some(g) = plaza.get("groups").and_then(Value::as_array).and_then(|gs| gs.iter().find(|g| g.get("id").and_then(Value::as_i64) == Some(group_id))) else { return vec![] };
    let mult = g.get("user_rate_multiplier").and_then(Value::as_f64).or_else(|| g.get("rate_multiplier").and_then(Value::as_f64)).unwrap_or(fallback_multiplier);
    g.get("models")
        .and_then(Value::as_array)
        .map(|ms| {
            ms.iter()
                .filter_map(|m| {
                    let name = m.get("name").and_then(Value::as_str)?;
                    let p = m.get("pricing")?;
                    if p.get("billing_mode").and_then(Value::as_str).is_some_and(|b| b != "token") || !crate::service::is_chat_model(name) {
                        return None;
                    }
                    let per_m = |k: &str| p.get(k).and_then(Value::as_f64).map(|v| v * 1_000_000.0 * mult);
                    Some(PriceEstimate { model: name.to_string(), input_per_m: per_m("input_price")?, output_per_m: per_m("output_price")?, cache_read_per_m: per_m("cache_read_price") })
                })
                .collect()
        })
        .unwrap_or_default()
}
