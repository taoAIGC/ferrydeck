//! 测速：按客户端走对应协议，只发一次请求，取第一个文本增量的时间；失败时给出站点原话，不换接口重试。

use app_lib::sites::http::{Http, ProbeWire};
use wiremock::matchers::{header, method, path, path_regex};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn sse(lines: &[&str]) -> ResponseTemplate {
    let body: String = lines.iter().map(|l| format!("data: {l}\n\n")).collect();
    ResponseTemplate::new(200).insert_header("content-type", "text/event-stream").set_body_string(body)
}

#[tokio::test]
async fn each_wire_reads_its_own_stream_format() {
    let s = MockServer::start().await;
    Mock::given(method("POST")).and(path("/v1/messages")).and(header("anthropic-version", "2023-06-01")).respond_with(sse(&[r#"{"type":"message_start"}"#, r#"{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}"#])).mount(&s).await;
    Mock::given(method("POST")).and(path("/v1/responses")).respond_with(sse(&[r#"{"type":"response.created"}"#, r#"{"type":"response.output_text.delta","delta":"Hello"}"#])).mount(&s).await;
    Mock::given(method("POST")).and(path("/v1/chat/completions")).respond_with(sse(&[r#"{"choices":[{"delta":{"role":"assistant"}}]}"#, r#"{"choices":[{"delta":{"content":"Yo"}}]}"#, "[DONE]"])).mount(&s).await;
    Mock::given(method("POST")).and(path_regex(r"^/v1beta/models/gemini-3\.5-flash:streamGenerateContent$")).and(header("x-goog-api-key", "sk-x")).respond_with(sse(&[r#"{"candidates":[{"content":{"parts":[{"text":"Hey"}]}}]}"#])).mount(&s).await;
    let h = Http::new(&s.uri());
    for (wire, model, chars) in [(ProbeWire::Anthropic, "claude-sonnet-5-5", 2), (ProbeWire::Responses, "gpt-5.6-sol", 5), (ProbeWire::Chat, "m", 2), (ProbeWire::Gemini, "gemini-3.5-flash", 3)] {
        let p = h.probe("sk-x", model, wire).await.unwrap();
        assert_eq!(p.chars, chars, "{wire:?}");
        assert!(p.first_ms <= p.total_ms);
    }
}

#[tokio::test]
async fn exactly_one_request_is_sent_and_failure_does_not_fall_back_to_another_endpoint() {
    let s = MockServer::start().await;
    // Codex 走 /v1/responses：这个站点没有它，就如实报失败（配到 Codex 里也用不了），不去试别的接口
    Mock::given(method("POST")).and(path("/v1/responses")).respond_with(ResponseTemplate::new(404).set_body_json(serde_json::json!({"error": {"message": "not found"}}))).expect(1).mount(&s).await;
    Mock::given(method("POST")).and(path("/v1/chat/completions")).respond_with(sse(&[r#"{"choices":[{"delta":{"content":"ok"}}]}"#])).expect(0).mount(&s).await;
    assert_eq!(Http::new(&s.uri()).probe("sk-x", "gpt-5.6-sol", ProbeWire::Responses).await.unwrap_err(), "not found");
}

#[tokio::test]
async fn the_request_is_tiny_one_hi_with_a_small_output_limit() {
    let s = MockServer::start().await;
    Mock::given(method("POST")).and(path("/v1/chat/completions")).respond_with(sse(&[r#"{"choices":[{"delta":{"content":"ok"}}]}"#])).mount(&s).await;
    let h = Http::new(&s.uri());
    h.probe("sk-x", "gpt-5.6-sol", ProbeWire::Chat).await.unwrap();
    h.probe("sk-x", "glm-4", ProbeWire::Chat).await.unwrap();
    let reqs = s.received_requests().await.unwrap();
    assert_eq!(reqs.len(), 2);
    let a: serde_json::Value = reqs[0].body_json().unwrap();
    let b: serde_json::Value = reqs[1].body_json().unwrap();
    assert_eq!(a["messages"][0]["content"], "hi");
    assert_eq!(a["max_completion_tokens"], 16, "gpt-5 系列只认 max_completion_tokens");
    assert!(a.get("max_tokens").is_none());
    assert_eq!(b["max_tokens"], 16);
    assert!(b.get("max_completion_tokens").is_none());
}

#[tokio::test]
async fn the_sites_own_error_message_is_reported() {
    let s = MockServer::start().await;
    Mock::given(method("POST")).respond_with(ResponseTemplate::new(403).set_body_json(serde_json::json!({"error": {"message": "余额不足"}}))).mount(&s).await;
    assert_eq!(Http::new(&s.uri()).probe("sk-x", "m", ProbeWire::Chat).await.unwrap_err(), "余额不足");
}

#[tokio::test]
async fn a_cross_origin_redirect_never_receives_the_key() {
    let evil = MockServer::start().await;
    Mock::given(method("POST")).respond_with(sse(&[r#"{"choices":[{"delta":{"content":"leaked"}}]}"#])).expect(0).mount(&evil).await; // 对方一个请求都不该收到
    let site = MockServer::start().await;
    Mock::given(method("POST")).and(path("/v1/messages")).respond_with(ResponseTemplate::new(307).insert_header("location", format!("{}/v1/messages", evil.uri()).as_str())).mount(&site).await;
    let e = Http::new(&site.uri()).probe("sk-secret", "claude-sonnet-5-5", ProbeWire::Anthropic).await.unwrap_err();
    assert!(e.contains("跳转到") && e.contains(&evil.uri()), "{e}");
    assert!(evil.received_requests().await.unwrap().is_empty(), "Key 不能被带到别的来源");
}

#[tokio::test]
async fn a_same_origin_redirect_is_followed() {
    let s = MockServer::start().await;
    Mock::given(method("POST")).and(path("/old")).respond_with(ResponseTemplate::new(307).insert_header("location", "/v1/chat/completions")).mount(&s).await;
    Mock::given(method("POST")).and(path("/v1/chat/completions")).respond_with(sse(&[r#"{"choices":[{"delta":{"content":"ok"}}]}"#])).mount(&s).await;
    let r = Http::new(&s.uri()).send(reqwest::Method::POST, "/old", Some("k"), None, &[], Some(serde_json::json!({}))).await;
    // /old 是 JSON 接口之外的 SSE：这里只验证重定向被跟随（没有变成“会跳转到…”的错误）
    assert!(r.is_ok(), "{:?}", r.err());
}

#[test]
fn input_tokens_are_read_from_each_wire_format() {
    use app_lib::sites::http::usage_input_tokens as f;
    use serde_json::json;
    assert_eq!(f(&json!({"type": "message_start", "message": {"usage": {"input_tokens": 20, "cache_read_input_tokens": 5}}})), Some(25));
    assert_eq!(f(&json!({"type": "response.completed", "response": {"usage": {"input_tokens": 9}}})), Some(9));
    assert_eq!(f(&json!({"usage": {"prompt_tokens": 7}})), Some(7));
    assert_eq!(f(&json!({"usageMetadata": {"promptTokenCount": 3}})), Some(3));
    assert_eq!(f(&json!({"choices": []})), None);
}
