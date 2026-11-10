//! 线上端到端测试（默认忽略）：用测试账号连真实站点，配置只写临时目录，结束时删除建出的 Key。
//!
//! sub2api: E2E_SUB2API_URL / E2E_SUB2API_USER（邮箱）/ E2E_SUB2API_PASSWORD
//! new-api: E2E_NEWAPI_URL / E2E_NEWAPI_USER（用户名）/ E2E_NEWAPI_PASSWORD
//! 只测部分分组（强烈建议，否则会一次建很多 Key、容易被限流）：E2E_GROUPS="分组A,分组B"
//!
//!   cargo test --test e2e_live -- --ignored --nocapture --test-threads=1

use std::fs;
use std::sync::Arc;
use std::time::Duration;

use app_lib::paths::Paths;
use app_lib::service::{self, clients_for, Client};
use app_lib::sites::{GroupInfo, Kind, Site, SiteClient};
use serde_json::{json, Value};

const CD_PROFILE: &str = "b35747a1-0000-4000-8000-000000000001.json";

fn env(k: &str) -> String {
    std::env::var(k).unwrap_or_else(|_| panic!("需要环境变量 {k}"))
}

fn seed(paths: &Paths) -> [(std::path::PathBuf, String); 5] {
    for d in [&paths.claude, &paths.codex, &paths.gemini, &paths.claude_desktop.join("configLibrary")] {
        fs::create_dir_all(d).unwrap();
    }
    let files = [
        (paths.claude.join("settings.json"), include_str!("fixtures/claude_settings.json")),
        (paths.codex.join("config.toml"), include_str!("fixtures/codex_config.toml")),
        (paths.gemini.join(".env"), include_str!("fixtures/gemini/dotenv")),
        (paths.gemini.join("settings.json"), include_str!("fixtures/gemini/settings.json")),
        (paths.claude_desktop.join("configLibrary/_meta.json"), include_str!("fixtures/claude_desktop/_meta.json")),
    ];
    fs::write(paths.claude_desktop.join("claude_desktop_config.json"), "{\"deploymentMode\":\"3p\"}").unwrap();
    files.map(|(p, c)| {
        fs::write(&p, c).unwrap();
        (p, c.to_string())
    })
}

async fn send_retry(mk: impl Fn() -> reqwest::RequestBuilder) -> reqwest::Response {
    let mut last = String::new();
    for i in 0..3 {
        match mk().timeout(Duration::from_secs(90)).send().await {
            Ok(r) => return r,
            Err(e) => {
                last = e.to_string();
                println!("    网络错误（第 {} 次）: {e}", i + 1);
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
        }
    }
    panic!("连续 3 次网络错误: {last}");
}

async fn run_site(kind: Kind, base: &str, user: &str, pw: &str) {
    let client = Arc::new(SiteClient::new(kind, base, Arc::new(|_| {})));
    let site = Site { id: "e2e".into(), kind, name: "e2e".into(), base_url: base.into(), is_admin: false };
    let root = tempfile::TempDir::new().unwrap();
    let paths = Paths::under(root.path());
    let originals = seed(&paths);

    let (acc, _) = client.login(user, pw).await.expect("登录失败");
    println!("[{}] 登录成功: {} 余额 {}", kind.label(), acc.display, acc.balance);
    let pre: Vec<String> = client.all_key_names().await.unwrap().into_iter().filter(|n| n.starts_with("Ferrydeck-")).collect();

    // 无论成败都清理本次创建的 desktop-* Key
    let (c2, p2, s2) = (client.clone(), paths.clone(), site.clone());
    let result = tokio::spawn(async move { flow(&c2, &s2, &p2).await }).await;
    let mut deleted = 0;
    for n in client.all_key_names().await.unwrap().into_iter().filter(|n| n.starts_with("Ferrydeck-") && !pre.contains(n)) {
        deleted += client.delete_key_named(&n).await.unwrap();
    }
    println!("[{}] 清理：删除了 {deleted} 个本次创建的 Key", kind.label());

    for c in [Client::Claude, Client::ClaudeDesktop, Client::Codex, Client::Gemini] {
        let _ = match c {
            Client::Claude => app_lib::clients::claude::restore(&paths.claude, &paths.data),
            Client::ClaudeDesktop => app_lib::clients::claude_desktop::restore(&paths.claude_desktop, &paths.data),
            Client::Codex => app_lib::clients::codex::restore(&paths.codex, &paths.data),
            Client::Gemini => app_lib::clients::gemini::restore(&paths.gemini, &paths.data),
        };
    }
    for (p, orig) in &originals {
        assert_eq!(&fs::read_to_string(p).unwrap(), orig, "{} 应还原", p.display());
    }
    match result {
        Ok(()) => {}
        Err(e) => panic!("测试中途 panic: {e}"),
    }
}

fn picks(groups: Vec<GroupInfo>) -> Vec<GroupInfo> {
    let want: Option<Vec<String>> = std::env::var("E2E_GROUPS").ok().map(|s| s.split(',').map(|x| x.trim().to_string()).collect());
    groups.into_iter().filter(|g| !service::is_hidden_group(&g.name)).filter(|g| want.as_ref().map(|w| w.contains(&g.name)).unwrap_or(true)).collect()
}

async fn flow(client: &SiteClient, site: &Site, paths: &Paths) {
    let t0 = std::time::Instant::now();
    let groups = picks(client.groups().await.expect("拉分组失败"));
    println!("  分组 {} 个（耗时 {:?}）", groups.len(), t0.elapsed());
    assert!(!groups.is_empty(), "没有可测的分组");

    let mut supported = 0;
    for g in &groups {
        let targets = clients_for(&g.platform);
        if targets.is_empty() {
            let e = service::enable(client, site, paths, g, Client::Claude, None).await.unwrap_err();
            println!("  [跳过] {} ({}) -> {e}", g.name, g.platform);
            continue;
        }
        let mut counted = false;
        for (i, c) in targets.iter().copied().enumerate() {
            let out = match service::enable(client, site, paths, g, c, None).await {
                Ok(o) => o,
                Err(e) if e.contains("图片") => {
                    println!("  [跳过] {} -> {e}", g.name);
                    break;
                }
                Err(e) => panic!("{} -> {:?}: {e}", g.name, c),
            };
            if !counted {
                supported += 1;
                counted = true;
            }
            println!("  [{:?}] {:<24} 模型 {:>2} 个  选中 {:?}  新建Key={}", c, g.name, out.models.len(), out.model, out.key_created);
            assert_eq!(out.key_created, i == 0, "{} 配 {:?} 时 Key 新建状态不符预期（同分组第二个客户端应复用）", g.name, c);
            assert!(out.models.iter().all(|m| service::is_chat_model(m)));
            let ov = service::overview(paths);
            let me = ov.iter().find(|o| o.client == c).unwrap();
            assert!(me.in_use && me.active.as_ref().map(|a| a.group_id.as_str()) == Some(g.id.as_str()));
        }
    }
    assert!(supported > 0, "没有任何分组能配置");
    let names = client.all_key_names().await.unwrap();
    let mut seen = std::collections::BTreeMap::new();
    for n in names.iter().filter(|n| n.starts_with("Ferrydeck-")) {
        *seen.entry(n.clone()).or_insert(0) += 1;
    }
    assert!(seen.values().all(|n| *n == 1), "同名桌面 Key 不应重复: {seen:?}");
    assert!(!seen.contains_key("Ferrydeck-default"));

    // 用写进配置里的真实 Key 各打一个最小请求，证明“写进去的配置真的能用”
    let http = reqwest::Client::new();
    let cheapest = |p: &str| groups.iter().filter(|g| g.platform == p && !g.name.contains("生图")).min_by(|a, b| a.rate_multiplier.partial_cmp(&b.rate_multiplier).unwrap()).cloned();
    let base = client.base().to_string();
    if let Some(g) = cheapest("anthropic") {
        let out = service::enable(client, site, paths, &g, Client::Claude, None).await.unwrap();
        let cfg: Value = serde_json::from_str(&fs::read_to_string(paths.claude.join("settings.json")).unwrap()).unwrap();
        let key = cfg["env"]["ANTHROPIC_AUTH_TOKEN"].as_str().unwrap();
        let body = json!({"model": out.model.clone().unwrap(), "max_tokens": 16, "messages": [{"role": "user", "content": "回复OK"}]});
        let r = send_retry(|| http.post(format!("{base}/v1/messages")).header("x-api-key", key).header("anthropic-version", "2023-06-01").json(&body)).await;
        println!("  Claude Code 实测 [{}] {:?} -> HTTP {}", g.name, out.model, r.status());
        assert!(r.status().is_success());

        let out = service::enable(client, site, paths, &g, Client::ClaudeDesktop, None).await.unwrap();
        let prof: Value = serde_json::from_str(&fs::read_to_string(paths.claude_desktop.join("configLibrary").join(CD_PROFILE)).unwrap()).unwrap();
        let (url, key) = (prof["inferenceGatewayBaseUrl"].as_str().unwrap(), prof["inferenceGatewayApiKey"].as_str().unwrap());
        let body = json!({"model": prof["inferenceModels"][0]["name"], "max_tokens": 16, "messages": [{"role": "user", "content": "回复OK"}]});
        let r = send_retry(|| http.post(format!("{url}/v1/messages")).bearer_auth(key).header("anthropic-version", "2023-06-01").json(&body)).await;
        println!("  Claude Desktop 实测 [{}] {:?}（Bearer）-> HTTP {}", g.name, out.model, r.status());
        assert!(r.status().is_success());
        assert!(send_retry(|| http.get(format!("{url}/v1/models")).bearer_auth(key)).await.status().is_success());
    }
    if let Some(g) = cheapest("openai") {
        let out = service::enable(client, site, paths, &g, Client::Codex, None).await.unwrap();
        let doc: toml_edit::DocumentMut = fs::read_to_string(paths.codex.join("config.toml")).unwrap().parse().unwrap();
        let key = doc["model_providers"]["ferrydeck"]["experimental_bearer_token"].as_str().unwrap().to_string();
        let body = json!({"model": out.model.clone().unwrap(), "max_output_tokens": 16, "input": "回复OK"});
        let r = send_retry(|| http.post(format!("{base}/v1/responses")).bearer_auth(&key).json(&body)).await;
        println!("  Codex 实测 [{}] {:?} -> HTTP {}", g.name, out.model, r.status());
        assert!(r.status().is_success());
    }
    if let Some(g) = cheapest("gemini") {
        let out = service::enable(client, site, paths, &g, Client::Gemini, None).await.unwrap();
        let env = fs::read_to_string(paths.gemini.join(".env")).unwrap();
        let key = env.lines().find_map(|l| l.trim_start_matches("export ").strip_prefix("GEMINI_API_KEY=")).unwrap().trim_matches('"').to_string();
        let m = out.model.clone().unwrap();
        let body = json!({"contents": [{"parts": [{"text": "回复OK"}]}]});
        let r = send_retry(|| http.post(format!("{base}/v1beta/models/{m}:generateContent")).header("x-goog-api-key", &key).json(&body)).await;
        let st = r.status();
        println!("  Gemini 实测 [{}] {m} -> HTTP {st}", g.name);
        if !st.is_success() {
            println!("    响应: {}", r.text().await.unwrap_or_default().chars().take(300).collect::<String>());
        }
        assert!(st.is_success());
    }
}

#[tokio::test]
#[ignore]
async fn sub2api_site_full_flow() {
    let base = env("E2E_SUB2API_URL");
    run_site(Kind::Sub2api, &base, &env("E2E_SUB2API_USER"), &env("E2E_SUB2API_PASSWORD")).await;
}

#[tokio::test]
#[ignore]
async fn newapi_site_full_flow() {
    let base = env("E2E_NEWAPI_URL");
    run_site(Kind::Newapi, &base, &env("E2E_NEWAPI_USER"), &env("E2E_NEWAPI_PASSWORD")).await;
}

#[tokio::test]
#[ignore]
async fn wrong_passwords_give_readable_errors_on_both_site_types() {
    for (kind, base, user) in [
        (Kind::Sub2api, env("E2E_SUB2API_URL"), env("E2E_SUB2API_USER")),
        (Kind::Newapi, env("E2E_NEWAPI_URL"), env("E2E_NEWAPI_USER")),
    ] {
        let c = SiteClient::new(kind, &base, Arc::new(|_| {}));
        let e = c.login(&user, "definitely-wrong-password").await.unwrap_err();
        println!("[{}] 错误信息: {e}", kind.label());
        assert!(e.starts_with("账号或密码不正确"), "{e}");
        assert!(!c.is_logged_in().await);
    }
}
