//! 两种站点共用的 HTTP 请求层：超时、连接失败重试、错误信息中文化。

use std::time::Duration;

use reqwest::header::HeaderMap;
use reqwest::{Client, Method, StatusCode};
use serde_json::Value;

pub struct Http {
    pub base: String,
    client: Client,
}

pub struct Resp {
    pub status: StatusCode,
    pub body: Value,
    pub headers: HeaderMap,
}

/// 服务器的英文提示翻译成中文；没有对应翻译的原样返回。
pub fn localize(m: &str) -> String {
    let l = m.to_lowercase();
    let t = if l.contains("username or password is incorrect") {
        "账号或密码不正确，或账号已被禁用"
    } else if l.contains("invalid email or password") || l.contains("invalid credentials") || l.contains("incorrect password") {
        "账号或密码不正确"
    } else if l.contains("too many") || l.contains("rate limit") {
        "尝试次数过多，请稍后再试"
    } else if l.contains("disabled") || l.contains("banned") {
        "账号已被禁用，请联系站点管理员"
    } else {
        return m.to_string();
    };
    t.to_string()
}

pub fn is_loopback(url: &str) -> bool {
    let host = url.split("://").nth(1).unwrap_or(url).split(['/', ':']).next().unwrap_or("");
    matches!(host, "localhost" | "127.0.0.1" | "[::1]")
}

/// 对方返回的不是预期的 JSON 时给出的提示（通常是地址填错了）。
pub fn unexpected(status: StatusCode) -> String {
    format!("该地址返回了意外的内容（HTTP {}），请确认站点地址是否正确", status.as_u16())
}

pub fn message_of(v: &Value) -> Option<String> {
    v.get("message").and_then(Value::as_str).filter(|s| !s.is_empty()).map(localize)
}

impl Http {
    pub fn new(base: &str) -> Self {
        let mut b = Client::builder().timeout(Duration::from_secs(30)).user_agent(concat!("Ferrydeck/", env!("CARGO_PKG_VERSION")));
        // 本机地址不走系统代理（否则会被代理软件拦截）；其他站点遵循系统代理设置
        if is_loopback(base) {
            b = b.no_proxy();
        }
        let client = b.build().expect("构建 HTTP 客户端失败");
        Http { base: base.trim_end_matches('/').to_string(), client }
    }

    /// 发请求。`cookie` 形如 `name=value`。网络抖动重试一次：GET 总是安全；其他方法只在“请求没发出去”时重试。
    pub async fn send(&self, m: Method, path: &str, bearer: Option<&str>, cookie: Option<&str>, extra: &[(&str, String)], body: Option<Value>) -> Result<Resp, String> {
        let idempotent = m == Method::GET;
        let mut last = String::new();
        for attempt in 0..2 {
            let mut rq = self.client.request(m.clone(), format!("{}{}", self.base, path));
            if let Some(b) = bearer {
                rq = rq.bearer_auth(b);
            }
            if let Some(c) = cookie {
                rq = rq.header("Cookie", c);
            }
            for (k, v) in extra {
                rq = rq.header(*k, v);
            }
            if let Some(b) = &body {
                rq = rq.json(b);
            }
            match rq.send().await {
                Ok(resp) => {
                    let status = resp.status();
                    let headers = resp.headers().clone();
                    let body = resp.json::<Value>().await.unwrap_or(Value::Null);
                    return Ok(Resp { status, body, headers });
                }
                Err(e) if attempt == 0 && !e.is_timeout() && (e.is_connect() || (idempotent && e.is_request())) => {
                    tokio::time::sleep(Duration::from_millis(600)).await;
                    last = e.to_string();
                }
                Err(e) => {
                    return Err(if e.is_timeout() {
                        "请求超时，请检查网络".to_string()
                    } else if e.is_connect() {
                        "无法连接到服务器，请检查网络".to_string()
                    } else {
                        format!("网络错误: {e}")
                    })
                }
            }
        }
        Err(format!("无法连接到服务器，请检查网络（{last}）"))
    }

    /// 查询某个 Key 能用的模型：OpenAI 风格 `/v1/models`，失败再试 Gemini 风格。
    pub async fn models_for_key(&self, key: &str) -> Vec<String> {
        if let Ok(r) = self.send(Method::GET, "/v1/models", Some(key), None, &[], None).await {
            if r.status.is_success() {
                let ids: Vec<String> = r.body.get("data").and_then(Value::as_array).map(|a| a.iter().filter_map(|m| m.get("id").and_then(Value::as_str).map(String::from)).collect()).unwrap_or_default();
                if !ids.is_empty() {
                    return ids;
                }
            }
        }
        if let Ok(r) = self.send(Method::GET, "/v1beta/models", None, None, &[("x-goog-api-key", key.to_string())], None).await {
            if r.status.is_success() {
                return r.body.get("models").and_then(Value::as_array).map(|a| a.iter().filter_map(|m| m.get("name").and_then(Value::as_str).map(|n| n.trim_start_matches("models/").to_string())).collect()).unwrap_or_default();
            }
        }
        vec![]
    }
}

/// 从响应头里取某个 Set-Cookie 的值。
pub fn set_cookie_value(headers: &HeaderMap, name: &str) -> Option<String> {
    headers.get_all("set-cookie").iter().filter_map(|v| v.to_str().ok()).find_map(|c| {
        let first = c.split(';').next()?;
        let (k, v) = first.split_once('=')?;
        (k.trim() == name && !v.is_empty()).then(|| v.to_string())
    })
}
