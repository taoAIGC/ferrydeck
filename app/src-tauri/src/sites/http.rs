//! 两种站点共用的 HTTP 请求层：超时、连接失败重试、错误信息中文化。

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use reqwest::header::HeaderMap;
use reqwest::{Client, Method, StatusCode};
use serde_json::Value;

/// 测速用的接口协议：和对应客户端实际使用的接口一致，所以测速失败就说明这个分组配到该客户端也用不了。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProbeWire {
    /// Anthropic `/v1/messages`（Claude Code / Claude Desktop）
    Anthropic,
    /// OpenAI `/v1/responses`（Codex）
    Responses,
    /// Gemini `/v1beta/models/<model>:streamGenerateContent`（Gemini CLI）
    Gemini,
    /// OpenAI 兼容 `/v1/chat/completions`
    Chat,
}

impl ProbeWire {
    pub fn for_client(c: &str) -> Self {
        match c {
            "claude" | "claude_desktop" => ProbeWire::Anthropic,
            "codex" => ProbeWire::Responses,
            "gemini" => ProbeWire::Gemini,
            _ => ProbeWire::Chat,
        }
    }
}

/// 从一条流式事件里取出文本增量，兼容 chat / responses / messages / gemini 四种格式。
fn delta_text(v: &Value) -> &str {
    v.pointer("/choices/0/delta/content")
        .and_then(Value::as_str)
        .or_else(|| (v.get("type").and_then(Value::as_str) == Some("response.output_text.delta")).then(|| v.get("delta").and_then(Value::as_str)).flatten())
        .or_else(|| v.pointer("/delta/text").and_then(Value::as_str))
        .or_else(|| v.pointer("/candidates/0/content/parts/0/text").and_then(Value::as_str))
        .unwrap_or("")
}

pub struct Http {
    pub base: String,
    client: Client,
    /// 被站点 429 限流的接口 → 解封时间（unix 秒）。冷却期内不再向该接口发请求：
    /// 限流窗口里继续敲只会让情况更糟，也浪费用户的额度。
    cooldown: std::sync::Mutex<std::collections::HashMap<String, i64>>,
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

pub fn now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

/// 刷新凭据被站点明确拒绝时的提示。界面靠其中的“登录已过期”判断要不要让用户重新登录。
pub const EXPIRED: &str = "登录已过期，请重新登录";

/// 刷新失败时，站点是否“明确拒绝了这份凭据”（只有这种情况才需要重新登录）。
/// 401 一定算；400/403 只有返回的是 JSON 才算（HTML 多半是 Cloudflare 等防护页、
/// 公共 Wi-Fi 的认证页，与凭据无关）；2xx 但 JSON 里明确写着失败也算。
/// 其他情况（429、5xx、网关错误、内容不像站点接口）都当作暂时性问题，保留凭据稍后重试。
pub fn refresh_rejected(status: StatusCode, body: &Value) -> bool {
    match status.as_u16() {
        401 => true,
        400 | 403 => body.is_object(),
        200..=299 => body.get("success").and_then(Value::as_bool) == Some(false) || body.get("code").and_then(Value::as_i64).is_some_and(|c| c != 0),
        _ => false,
    }
}

/// 暂时没能刷新登录状态（网络、站点故障、限流）时的提示。凭据保留，之后会自动重试。
pub fn retry_later(reason: &str) -> String {
    if is_rate_limited(reason) {
        return reason.to_string(); // 限流提示本身已经说明了该等多久
    }
    format!("暂时无法连接站点（{reason}），稍后会自动重试")
}

/// “N 秒” / “N 分钟”。
pub fn wait_text(secs: i64) -> String {
    if secs >= 90 {
        format!("{} 分钟", (secs + 59) / 60)
    } else {
        format!("{secs} 秒")
    }
}

/// 站点返回 429 时的提示（带需要等待的时间）。
pub fn rate_limited_message(secs: i64) -> String {
    format!("站点限流了（429），请 {}后再试", wait_text(secs))
}

/// 这个错误是否是站点限流（429）。界面据此停止批量操作，避免越打越被限。
pub fn is_rate_limited(e: &str) -> bool {
    e.contains("站点限流")
}

/// 429 时站点会通过 Retry-After 告诉我们要等几秒（new-api 就是这样）；没有就保守等 60 秒。
fn retry_after_secs(headers: &HeaderMap) -> i64 {
    headers.get("retry-after").and_then(|v| v.to_str().ok()).and_then(|v| v.trim().parse::<i64>().ok()).unwrap_or(60).clamp(5, 1200)
}

/// 把路径归一成“接口”：去掉查询串，数字段换成 :id（/api/token/9/key → /api/token/:id/key）。
fn endpoint_key(path: &str) -> String {
    path.split('?').next().unwrap_or(path).split('/').map(|s| if !s.is_empty() && s.chars().all(|c| c.is_ascii_digit()) { ":id" } else { s }).collect::<Vec<_>>().join("/")
}

pub fn message_of(v: &Value) -> Option<String> {
    v.get("message").and_then(Value::as_str).filter(|s| !s.is_empty()).map(localize)
}

/// 重定向只在同一个来源（协议 + 域名 + 端口）内跟随。
/// 否则站点（或中间人）把 API 地址重定向到别的域名时，请求头里的 `x-api-key` 等自定义头会被一并带过去，
/// 等于把用户的 Key 送给了第三方（reqwest 只会自动去掉 Authorization 和 Cookie）。
pub fn same_origin_redirects() -> reqwest::redirect::Policy {
    reqwest::redirect::Policy::custom(|attempt| {
        let same = attempt.previous().last().is_some_and(|p| p.origin() == attempt.url().origin());
        if same && attempt.previous().len() < 5 {
            attempt.follow()
        } else {
            attempt.stop()
        }
    })
}

/// 对方让我们跳到别处时的提示：不跟随，请用户直接用最终地址。
fn redirect_notice(headers: &HeaderMap) -> String {
    let to = headers.get("location").and_then(|v| v.to_str().ok()).unwrap_or("另一个地址");
    format!("该地址会跳转到 {to}，请直接用跳转后的地址添加站点")
}

impl Http {
    pub fn new(base: &str) -> Self {
        let mut b = Client::builder().timeout(Duration::from_secs(30)).redirect(same_origin_redirects()).user_agent(concat!("Ferrydeck/", env!("CARGO_PKG_VERSION")));
        // 本机地址不走系统代理（否则会被代理软件拦截）；其他站点遵循系统代理设置
        if is_loopback(base) {
            b = b.no_proxy();
        }
        let client = b.build().expect("构建 HTTP 客户端失败");
        Http { base: base.trim_end_matches('/').to_string(), client, cooldown: Default::default() }
    }

    fn cooldown_left(&self, key: &str) -> i64 {
        self.cooldown.lock().ok().and_then(|m| m.get(key).copied()).map(|until| until - now()).unwrap_or(0)
    }

    fn start_cooldown(&self, key: &str, secs: i64) {
        crate::applog::log("rate_limited", &format!("{} {key} 被限流，冷却 {secs} 秒", self.base));
        if let Ok(mut m) = self.cooldown.lock() {
            m.insert(key.to_string(), now() + secs);
        }
    }

    /// 发请求。`cookie` 形如 `name=value`。网络抖动重试一次：GET 总是安全；其他方法只在“请求没发出去”时重试。
    pub async fn send(&self, m: Method, path: &str, bearer: Option<&str>, cookie: Option<&str>, extra: &[(&str, String)], body: Option<Value>) -> Result<Resp, String> {
        let idempotent = m == Method::GET;
        let ep = endpoint_key(path);
        let left = self.cooldown_left(&ep);
        if left > 0 {
            return Err(rate_limited_message(left)); // 还在冷却：不发请求
        }
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
                    if status.is_redirection() {
                        return Err(redirect_notice(&headers));
                    }
                    if status.as_u16() == 429 {
                        let secs = retry_after_secs(&headers);
                        self.start_cooldown(&ep, secs);
                        return Err(rate_limited_message(secs));
                    }
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

    /// 测速：用该分组的 Key 发**一次**最小的流式请求（一条 "hi"、一个模型），返回首字延迟。
    /// 只发一次、不换接口重试：测的就是客户端实际要走的那条路，失败就把站点的原话告诉用户。
    /// 限制输出长度（最多 16 个 token），读到流结束，这样能拿到站点报告的输入 token 数（“hi”本身只有几个 token，
    /// 多出来的部分是站点悄悄加的系统提示，用来衡量空请求的基线开销）。费用可以忽略。
    pub async fn probe(&self, key: &str, model: &str, wire: ProbeWire) -> Result<super::Probe, String> {
        self.probe_with(key, model, wire, 16).await
    }

    pub async fn probe_with(&self, key: &str, model: &str, wire: ProbeWire, max_tokens: u32) -> Result<super::Probe, String> {
        let started = std::time::Instant::now();
        let msgs = serde_json::json!([{ "role": "user", "content": "hi" }]);
        let (path, body) = match wire {
            ProbeWire::Anthropic => ("/v1/messages".to_string(), serde_json::json!({ "model": model, "messages": msgs, "max_tokens": max_tokens, "stream": true })),
            ProbeWire::Responses => ("/v1/responses".to_string(), serde_json::json!({ "model": model, "input": msgs, "max_output_tokens": max_tokens, "stream": true })),
            ProbeWire::Gemini => (
                format!("/v1beta/models/{model}:streamGenerateContent?alt=sse"),
                // 思考型模型会先“想”一会儿，留得太小会一个字都不输出
                serde_json::json!({ "contents": [{ "role": "user", "parts": [{ "text": "hi" }] }], "generationConfig": { "maxOutputTokens": max_tokens.max(64) } }),
            ),
            ProbeWire::Chat => {
                // gpt-5 / o 系列只认 max_completion_tokens，其他模型认 max_tokens
                let new_style = model.starts_with("gpt-5") || (model.starts_with('o') && model.chars().nth(1).is_some_and(|c| c.is_ascii_digit()));
                let limit = if new_style { "max_completion_tokens" } else { "max_tokens" };
                ("/v1/chat/completions".to_string(), serde_json::json!({ "model": model, "messages": msgs, limit: max_tokens, "stream": true }))
            }
        };
        let mut rq = self.client.post(format!("{}{}", self.base, path)).bearer_auth(key).json(&body);
        match wire {
            ProbeWire::Anthropic => rq = rq.header("x-api-key", key).header("anthropic-version", "2023-06-01"),
            ProbeWire::Gemini => rq = rq.header("x-goog-api-key", key),
            _ => {}
        }
        let mut resp = rq.send().await.map_err(|e| if e.is_timeout() { "请求超时，请检查网络".to_string() } else { "无法连接到服务器，请检查网络".to_string() })?;
        if resp.status().is_redirection() {
            return Err(redirect_notice(resp.headers()));
        }
        if resp.status().as_u16() == 429 {
            return Err(rate_limited_message(retry_after_secs(resp.headers())));
        }
        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let text = resp.text().await.unwrap_or_default();
            let v = serde_json::from_str::<Value>(&text).ok();
            let msg = v.as_ref().and_then(|v| message_of(v).or_else(|| v.pointer("/error/message").and_then(Value::as_str).map(String::from)));
            return Err(msg.unwrap_or_else(|| format!("站点返回 HTTP {status}")));
        }
        let mut first: Option<u64> = None;
        let mut chars = 0usize;
        let mut reply = String::new();
        let mut input_tokens: Option<u64> = None;
        let mut buf = String::new();
        while let Some(chunk) = resp.chunk().await.map_err(|e| if e.is_timeout() { "等待回复超时".to_string() } else { format!("网络错误: {e}") })? {
            buf.push_str(&String::from_utf8_lossy(&chunk));
            while let Some(i) = buf.find('\n') {
                let line: String = buf.drain(..=i).collect();
                let Some(data) = line.trim().strip_prefix("data:") else { continue };
                let data = data.trim();
                if data.is_empty() || data == "[DONE]" {
                    continue;
                }
                let Ok(v) = serde_json::from_str::<Value>(data) else { continue };
                if let Some(n) = usage_input_tokens(&v) {
                    input_tokens = Some(input_tokens.map_or(n, |o: u64| o.max(n)));
                }
                let text = delta_text(&v);
                if !text.is_empty() {
                    chars += text.chars().count();
                    if reply.chars().count() < 400 {
                        reply.push_str(&text);
                    }
                    first.get_or_insert(started.elapsed().as_millis() as u64);
                }
            }
        }
        let first_ms = first.ok_or("没有收到任何回复内容（该模型可能不支持流式输出）")?;
        Ok(super::Probe { first_ms, total_ms: started.elapsed().as_millis() as u64, chars, input_tokens, text: reply })
    }

    /// 查询某个 Key 能用的模型：OpenAI 风格 `/v1/models`，失败再试 Gemini 风格。
    pub async fn models_for_key(&self, key: &str) -> Vec<String> {
        self.models_for_key_result(key).await.unwrap_or_default()
    }

    /// 同上，但读不到时带上站点的原话（比如余额不足时 `/v1/models` 会直接返回 403），好告诉用户为什么没有模型。
    pub async fn models_for_key_result(&self, key: &str) -> Result<Vec<String>, String> {
        let mut why: Option<String> = None;
        if let Ok(r) = self.send(Method::GET, "/v1/models", Some(key), None, &[], None).await {
            if !r.status.is_success() {
                why = message_of(&r.body).or_else(|| r.body.pointer("/error/message").and_then(Value::as_str).map(String::from)).or_else(|| Some(format!("站点返回 HTTP {}", r.status.as_u16())));
            }
            if r.status.is_success() {
                let ids: Vec<String> = r.body.get("data").and_then(Value::as_array).map(|a| a.iter().filter_map(|m| m.get("id").and_then(Value::as_str).map(String::from)).collect()).unwrap_or_default();
                if !ids.is_empty() {
                    return Ok(ids);
                }
            }
        }
        if let Ok(r) = self.send(Method::GET, "/v1beta/models", None, None, &[("x-goog-api-key", key.to_string())], None).await {
            if r.status.is_success() {
                let ms: Vec<String> = r.body.get("models").and_then(Value::as_array).map(|a| a.iter().filter_map(|m| m.get("name").and_then(Value::as_str).map(|n| n.trim_start_matches("models/").to_string())).collect()).unwrap_or_default();
                if !ms.is_empty() {
                    return Ok(ms);
                }
            }
        }
        match why {
            Some(e) => Err(e),
            None => Ok(vec![]),
        }
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

/// 流式事件里站点报告的输入 token 数（各接口格式不同）；没有就返回 None。
pub fn usage_input_tokens(v: &Value) -> Option<u64> {
    let n = |p: &str| v.pointer(p).and_then(Value::as_u64);
    // Anthropic：message_start 里的 usage；输入含缓存创建 / 读取时一并算上
    if let Some(u) = v.pointer("/message/usage") {
        let g = |k: &str| u.get(k).and_then(Value::as_u64).unwrap_or(0);
        return u.get("input_tokens").and_then(Value::as_u64).map(|i| i + g("cache_creation_input_tokens") + g("cache_read_input_tokens"));
    }
    // Responses：response.completed；Chat：末尾的 usage；Gemini：usageMetadata
    n("/response/usage/input_tokens").or_else(|| n("/usage/prompt_tokens")).or_else(|| n("/usage/input_tokens")).or_else(|| n("/usageMetadata/promptTokenCount"))
}
