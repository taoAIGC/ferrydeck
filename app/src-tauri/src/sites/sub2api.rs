//! sub2api 站点适配：邮箱 + 密码登录，Key 绑定分组，Key 明文可重复读取。

use reqwest::Method;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::Mutex;

use super::http::{message_of, unexpected, Http};
use super::{key_name, AccountInfo, GroupInfo, SecretSink};

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

struct Tokens {
    access: String,
    refresh: String,
}

pub struct Client {
    http: Http,
    tokens: Mutex<Option<Tokens>>,
    sink: SecretSink,
}

fn money(v: &Value) -> String {
    format!("${:.2}", v.as_f64().unwrap_or(0.0))
}

impl Client {
    pub fn new(base: &str, sink: SecretSink) -> Self {
        Client { http: Http::new(base), tokens: Mutex::new(None), sink }
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
        let r = self.http.send(Method::POST, "/api/v1/auth/login", None, None, &[], Some(json!({"email": email, "password": password}))).await?;
        if !r.status.is_success() {
            return Err(match r.status.as_u16() {
                401 | 400 | 422 => message_of(&r.body).unwrap_or_else(|| "邮箱或密码不正确".into()),
                429 => "尝试次数过多，请稍后再试".into(),
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
        *self.tokens.lock().await = Some(Tokens { access: a.into(), refresh: rf.into() });
        let acc = AccountInfo { display: d.pointer("/user/email").and_then(Value::as_str).unwrap_or(email).into(), balance: money(d.pointer("/user/balance").unwrap_or(&Value::Null)) };
        Ok((acc, rf.into()))
    }

    pub async fn resume(&self, refresh: &str) -> Result<(), String> {
        *self.tokens.lock().await = Some(Tokens { access: String::new(), refresh: refresh.into() });
        self.refresh().await.map_err(|e| {
            // 恢复失败就当没登录，避免留下半截状态
            if let Ok(mut t) = self.tokens.try_lock() {
                *t = None;
            }
            e
        })
    }

    async fn refresh(&self) -> Result<(), String> {
        let refresh = self.tokens.lock().await.as_ref().map(|t| t.refresh.clone()).ok_or("未登录")?;
        let r = self.http.send(Method::POST, "/api/v1/auth/refresh", None, None, &[], Some(json!({"refresh_token": refresh}))).await?;
        let d = r.body.get("data").unwrap_or(&r.body);
        match (r.status.is_success(), d.get("access_token").and_then(Value::as_str)) {
            (true, Some(a)) => {
                let rf = d.get("refresh_token").and_then(Value::as_str).unwrap_or(&refresh).to_string();
                *self.tokens.lock().await = Some(Tokens { access: a.into(), refresh: rf.clone() });
                (self.sink)(rf); // 令牌可能轮换，及时持久化
                Ok(())
            }
            _ => Err("登录已过期，请重新登录".into()),
        }
    }

    /// 带登录态的请求；遇到 401 自动刷新一次再重试。返回 `data` 字段。
    async fn call(&self, m: Method, path: &str, body: Option<Value>) -> Result<Value, String> {
        for attempt in 0..2 {
            let access = self.tokens.lock().await.as_ref().map(|t| t.access.clone()).ok_or("未登录")?;
            let r = self.http.send(m.clone(), path, Some(&access), None, &[], body.clone()).await?;
            if r.status.as_u16() == 401 && attempt == 0 {
                self.refresh().await?;
                continue;
            }
            if r.status.is_success() {
                return Ok(r.body.get("data").cloned().unwrap_or(r.body));
            }
            return Err(message_of(&r.body).unwrap_or_else(|| format!("请求失败（HTTP {}）", r.status.as_u16())));
        }
        Err("登录已过期，请重新登录".into())
    }

    pub async fn me(&self) -> Result<AccountInfo, String> {
        let d = self.call(Method::GET, "/api/v1/auth/me", None).await?;
        Ok(AccountInfo { display: d.get("email").and_then(Value::as_str).unwrap_or("").into(), balance: money(d.get("balance").unwrap_or(&Value::Null)) })
    }

    pub async fn groups(&self) -> Result<Vec<GroupInfo>, String> {
        let d = self.call(Method::GET, "/api/v1/groups/available", None).await?;
        let arr = if d.is_array() { d } else { d.get("items").cloned().unwrap_or(Value::Array(vec![])) };
        let raw: Vec<RawGroup> = serde_json::from_value(arr).map_err(|e| format!("分组数据格式异常: {e}"))?;
        Ok(raw
            .into_iter()
            .filter(|g| g.status.is_empty() || g.status == "active")
            .map(|g| GroupInfo { id: g.id.to_string(), name: g.name, description: g.description, platform: g.platform, rate_multiplier: g.rate_multiplier, models: vec![] })
            .collect())
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

    pub async fn ensure_key(&self, group: &GroupInfo) -> Result<(String, bool), String> {
        let gid: i64 = group.id.parse().map_err(|_| "分组 id 不正确".to_string())?;
        let name = key_name(group);
        if let Some(k) = self.keys().await?.into_iter().find(|k| k.name == name && k.group_id == Some(gid) && (k.status.is_empty() || k.status == "active")) {
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
