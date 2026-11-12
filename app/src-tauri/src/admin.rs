//! 站长视角：把一个中转站的“上游”和“下游”放在一起管理。
//!
//! - **上游**：站点自己接入的上游账号（sub2api 的 `accounts`，new-api 的 `channels`）。一个上游可以同时服务多个下游分组。
//! - **下游**：对外售卖的分组。
//!
//! 这里只放界面用的数据结构；上游的凭据（API Key、OAuth 令牌）**永远不会**出现在这些结构里：站点的列表接口会把它们一起返回，
//! 适配器解析时只取名称、状态、地址的主机名这些元数据，其余一律丢弃。

use serde::{Deserialize, Serialize};

/// 一个上游账号 / 渠道。
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct Upstream {
    pub id: String,
    pub name: String,
    pub platform: String,
    /// 账号类型（apikey / oauth …）；new-api 是渠道类型编号。
    pub kind: String,
    /// `active`（运行中）/ `paused`（已暂停，可恢复）/ `error`（站点判定异常或被自动禁用）。
    pub status: String,
    /// 站点上这个账号的原始“状态”：`active` / `inactive` / `error`（new-api：渠道启用 / 手动停用 / 被系统自动禁用）。
    pub account_status: String,
    /// 站点上这个账号的“调度”开关（sub2api 才有；new-api 的渠道没有这个概念）。能被用户调用到要“状态 = active 且 调度 = 开启”。
    pub schedulable: Option<bool>,
    /// 状态和调度都对，但站点自动把它暂时摘除了（上游限流 / 过载 / 临时不可调度 / 过期自动暂停）：写明原因和恢复时间；没有就是 None。
    pub blocked: Option<String>,
    pub error: Option<String>,
    /// 上游地址的主机名（不含路径和 Key），用来区分同名账号。
    pub host: Option<String>,
    /// 它服务的下游分组 id。
    pub groups: Vec<String>,
    pub models: usize,
    /// 上游支持的模型名（只取名字）。
    pub model_names: Vec<String>,
    /// 上游账号自己的计费倍率（sub2api 的账号倍率：你付给上游的价 = 官方价 × 它）；new-api 的渠道没有这个概念。
    pub rate_multiplier: Option<f64>,
    pub priority: Option<i64>,
}

/// 一个对外的分组。
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct Downstream {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub platform: String,
    pub rate_multiplier: f64,
    pub status: String,
    /// 站点没给当前账号修改倍率 / 备注的权限（new-api 的分组设置只有超级管理员能改）时为 false。
    pub editable: bool,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct AdminOverview {
    pub upstreams: Vec<Upstream>,
    pub downstreams: Vec<Downstream>,
    pub fetched_at: i64,
}

/// 上游站点里的一个分组（用来让站长选“这个上游账号用的是哪个分组”）。
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct GroupChoice {
    pub id: String,
    pub name: String,
    pub rate: f64,
}

/// 一个上游账号和“上游站点里的分组”的关联。
///
/// 站点的管理接口**不会**返回上游账号的 API Key（只说有没有），所以没法自动按 Key 对上号：由站长在应用里选一次
/// “这个上游账号用的是你在上游站点登录的账号下的哪个分组”，应用记在本机，之后每次直接读上游站点那个分组**当前的**倍率。
/// 账号名称里写了倍率时（如“Kiro 特价 0.09”），会按倍率相同的唯一分组给出推荐。
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct UpstreamLink {
    pub upstream_id: String,
    pub host: String,
    /// 地址对应的、应用里已添加的上游站点。
    pub site_id: Option<String>,
    pub site_name: Option<String>,
    /// 已经关联的分组和它现在的倍率。
    pub group_id: Option<String>,
    pub group: Option<String>,
    pub rate: Option<f64>,
    /// 还没关联时的推荐（按账号名称里的倍率）。
    pub suggested: Option<GroupChoice>,
    /// 这个上游站点里你能选的分组。
    pub candidates: Vec<GroupChoice>,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct LinkReport {
    pub links: Vec<UpstreamLink>,
    /// 这些上游的站点还没有在应用里添加账号：提示站长把上游站点的账号填进来。
    pub missing_hosts: Vec<String>,
}

/// 账号名称末尾写的倍率（“Claude lingxu 特价 0.09” → 0.09）。
pub fn name_rate(name: &str) -> Option<f64> {
    let last = name.trim().rsplit(|c: char| c.is_whitespace() || c == '-' || c == '_').next()?;
    if last.is_empty() || !last.chars().all(|c| c.is_ascii_digit() || c == '.') || last.matches('.').count() > 1 || last.starts_with('.') || last.ends_with('.') {
        return None;
    }
    let v: f64 = last.parse().ok()?;
    (v > 0.0 && v <= 20.0).then_some(v)
}

/// 只保留字母和汉字（小写），用来比较名称：去掉空格、符号、数字（数字单独当倍率看）。
fn core(s: &str) -> Vec<char> {
    s.chars().filter(|c| c.is_alphabetic()).flat_map(|c| c.to_lowercase()).collect()
}

/// 两个名称的最长公共子串长度（字符数）。
fn common_len(a: &[char], b: &[char]) -> usize {
    let mut best = 0;
    let mut prev = vec![0usize; b.len() + 1];
    for i in 1..=a.len() {
        let mut cur = vec![0usize; b.len() + 1];
        for j in 1..=b.len() {
            if a[i - 1] == b[j - 1] {
                cur[j] = prev[j - 1] + 1;
                best = best.max(cur[j]);
            }
        }
        prev = cur;
    }
    best
}

/// 给上游账号推荐它用的上游分组：先看账号名称里写的倍率（“…特价 0.09”），再看名称和分组名有多像（最长公共片段）。
/// - 名称里有倍率：只在倍率相同的分组里选；名称和分组名最像的唯一一个胜出，只有一个倍率相同的分组就直接选它；
/// - 名称里没有倍率：名称和分组名有至少 3 个字符的公共片段，且最像的分组唯一时才推荐。
/// 只是推荐，要站长确认；有并列、没把握时宁可不推荐。
pub fn suggest(name: &str, candidates: &[GroupChoice]) -> Option<GroupChoice> {
    let account = core(name);
    let pick = |pool: Vec<&GroupChoice>, min_common: usize| -> Option<GroupChoice> {
        let scored: Vec<(usize, &GroupChoice)> = pool.into_iter().map(|c| (common_len(&account, &core(&c.name)), c)).collect();
        let top = scored.iter().map(|(n, _)| *n).max()?;
        if top < min_common {
            return None;
        }
        let mut best = scored.iter().filter(|(n, _)| *n == top);
        let first = best.next()?.1;
        best.next().is_none().then(|| first.clone())
    };
    match name_rate(name) {
        Some(r) => {
            let same: Vec<&GroupChoice> = candidates.iter().filter(|c| (c.rate - r).abs() < 1e-9).collect();
            if same.len() == 1 {
                return Some(same[0].clone());
            }
            pick(same, 1)
        }
        None => pick(candidates.iter().collect(), 3),
    }
}

/// 新建下游分组。
#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
pub struct NewGroup {
    pub name: String,
    pub description: Option<String>,
    /// sub2api 必填（anthropic / openai / gemini …）；new-api 没有这个设置。
    pub platform: Option<String>,
    pub rate_multiplier: f64,
}

impl NewGroup {
    pub fn validate(&self) -> Result<(), String> {
        if self.name.trim().is_empty() {
            return Err("名称不能为空".into());
        }
        if !self.rate_multiplier.is_finite() || self.rate_multiplier <= 0.0 {
            return Err("倍率必须是大于 0 的数字".into());
        }
        Ok(())
    }
}

/// 在站长的站点里新建一个上游账号 / 渠道。`api_key` 是刚在上游站点创建的 Key：只在内存里传递，`Debug` 里打码，不写日志。
#[derive(Clone, Default)]
pub struct NewUpstream {
    pub name: String,
    pub platform: String,
    /// 上游站点的地址（不带 /v1）。
    pub base_url: String,
    pub api_key: String,
    pub models: Vec<String>,
    /// 要绑定的下游分组 id。
    pub group_ids: Vec<String>,
    pub rate_multiplier: Option<f64>,
}

impl std::fmt::Debug for NewUpstream {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NewUpstream").field("name", &self.name).field("platform", &self.platform).field("base_url", &self.base_url).field("api_key", &"***").field("models", &self.models.len()).field("group_ids", &self.group_ids).finish()
    }
}

/// new-api 渠道类型编号（和站点的迁移脚本一致）：1 OpenAI、14 Anthropic、24 Gemini、48 xAI；认不出的按 OpenAI 兼容处理。
pub fn channel_type(platform: &str) -> i64 {
    match platform {
        "anthropic" => 14,
        "gemini" => 24,
        "grok" => 48,
        _ => 1,
    }
}

/// sub2api 对 grok 的 base_url 约定带 /v1，其它平台不带。
pub fn sub2api_base_url(platform: &str, base: &str) -> String {
    let b = base.trim_end_matches('/');
    if platform == "grok" && !b.ends_with("/v1") {
        format!("{b}/v1")
    } else {
        b.to_string()
    }
}

/// 应用在站长站点里新建上游后的结果。
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct AddedUpstream {
    pub upstream_id: String,
    pub name: String,
    /// 在上游站点是否新创建了 Key（false = 复用已有的）。
    pub key_created: bool,
    pub models: usize,
    /// 用这把 Key 在上游站点发一句“hi”的首字时延（毫秒）：证明这条链路是通的。
    pub probe_ms: u64,
    /// 创建后是否先暂停了。
    pub paused: bool,
}

/// 本机保存的关联：站长站点 id -> 上游账号 id -> (上游站点 id, 分组 id)。不含任何凭据。
pub type SavedLinks = std::collections::BTreeMap<String, std::collections::BTreeMap<String, (String, String)>>;

pub fn load_links(data_dir: &std::path::Path) -> SavedLinks {
    std::fs::read_to_string(data_dir.join("admin_links.json")).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

pub fn save_links(data_dir: &std::path::Path, links: &SavedLinks) -> Result<(), String> {
    let _ = std::fs::create_dir_all(data_dir);
    std::fs::write(data_dir.join("admin_links.json"), serde_json::to_string_pretty(links).map_err(|e| e.to_string())?).map_err(|e| format!("保存关联失败: {e}"))
}

/// 下游分组的修改。没填的字段不改。
#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
pub struct GroupEdit {
    pub name: Option<String>,
    pub description: Option<String>,
    pub platform: Option<String>,
    pub rate_multiplier: Option<f64>,
}

impl GroupEdit {
    pub fn is_empty(&self) -> bool {
        self.name.is_none() && self.description.is_none() && self.platform.is_none() && self.rate_multiplier.is_none()
    }

    /// 倍率必须是正数、不能是 NaN / 无穷：写到站点上之前先在本地挡掉。
    pub fn validate(&self) -> Result<(), String> {
        if self.is_empty() {
            return Err("没有要修改的内容".into());
        }
        if let Some(r) = self.rate_multiplier {
            if !r.is_finite() || r <= 0.0 {
                return Err("倍率必须是大于 0 的数字".into());
            }
        }
        if self.name.as_deref().is_some_and(|n| n.trim().is_empty()) {
            return Err("名称不能为空".into());
        }
        Ok(())
    }
}

/// unix 秒 → `YYYY-MM-DD`（UTC）。站点的管理端统计按日期筛选。
pub fn ymd(unix_secs: i64) -> String {
    let z = unix_secs.div_euclid(86_400) + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}")
}

/// 解析 RFC 3339 时间（`2026-11-07T15:35:38.51909+08:00` / `…Z`）为 unix 秒；格式不对返回 None。
pub fn parse_rfc3339(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() < 19 || b[4] != b'-' || b[7] != b'-' || !(b[10] == b'T' || b[10] == b' ') || b[13] != b':' || b[16] != b':' {
        return None;
    }
    let n = |r: std::ops::Range<usize>| s.get(r)?.parse::<i64>().ok();
    let (y, mo, d, h, mi, se) = (n(0..4)?, n(5..7)?, n(8..10)?, n(11..13)?, n(14..16)?, n(17..19)?);
    // 小数秒忽略；然后是 Z 或 ±HH:MM
    let mut i = 19;
    if b.get(i) == Some(&b'.') {
        i += 1;
        while b.get(i).is_some_and(u8::is_ascii_digit) {
            i += 1;
        }
    }
    let off = match b.get(i) {
        Some(b'Z') | None => 0,
        Some(&sign @ (b'+' | b'-')) => {
            let hh = s.get(i + 1..i + 3)?.parse::<i64>().ok()?;
            let mm = s.get(i + 4..i + 6)?.parse::<i64>().ok()?;
            (hh * 3600 + mm * 60) * if sign == b'+' { 1 } else { -1 }
        }
        _ => return None,
    };
    // days_from_civil
    let yy = if mo <= 2 { y - 1 } else { y };
    let era = yy.div_euclid(400);
    let yoe = yy - era * 400;
    let doy = (153 * (if mo > 2 { mo - 3 } else { mo + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(days * 86_400 + h * 3600 + mi * 60 + se - off)
}

/// 只留地址里的主机名；解析不了就没有。
pub fn host_of(url: &str) -> Option<String> {
    let rest = url.split("://").nth(1).unwrap_or(url);
    let host = rest.split(['/', '?', '#']).next()?.rsplit('@').next()?;
    (!host.is_empty()).then(|| host.to_string())
}

/// 站点给的错误原文常带一长串请求编号（`(request id: …)`），整理成能放进提示的一句话：去掉请求编号、压缩空白、最多 200 个字。
pub fn tidy_error(e: &str) -> String {
    let mut out = String::new();
    let mut rest = e;
    while let Some(i) = rest.find("(request id:") {
        out.push_str(&rest[..i]);
        rest = match rest[i..].find(')') {
            Some(j) => &rest[i + j + 1..],
            None => "",
        };
    }
    out.push_str(rest);
    let s = out.split_whitespace().collect::<Vec<_>>().join(" ");
    if s.chars().count() > 200 { format!("{}…", s.chars().take(200).collect::<String>()) } else { s }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_never_carries_path_or_credentials() {
        assert_eq!(host_of("https://api.up.com/v1?key=sk-secret"), Some("api.up.com".into()));
        assert_eq!(host_of("https://user:pw@up.example.com:8443/x"), Some("up.example.com:8443".into()));
        assert_eq!(host_of(""), None);
    }

    #[test]
    fn rate_is_read_from_the_end_of_the_name() {
        assert_eq!(name_rate("Claude lingxu 特价 0.09"), Some(0.09));
        assert_eq!(name_rate("pqh-Gemini-4a 0.72"), Some(0.72));
        assert_eq!(name_rate("巨像 CCmax 0注入 禁止蒸馏   1"), Some(1.0));
        assert_eq!(name_rate("GPT Pro"), None);
        assert_eq!(name_rate("账号 1.2.3"), None);
        assert_eq!(name_rate("账号 0"), None);
        assert_eq!(name_rate("账号 99"), None, "大于 20 不是倍率");
    }

    fn g(id: &str, name: &str, r: f64) -> GroupChoice {
        GroupChoice { id: id.into(), name: name.into(), rate: r }
    }

    #[test]
    fn suggestion_uses_the_rate_in_the_name_then_how_alike_the_names_are() {
        // 名称里有倍率，且只有一个分组倍率相同
        assert_eq!(suggest("x 0.09", &[g("a", "A", 0.5), g("b", "B", 0.09)]).map(|c| c.id), Some("b".into()));
        // 倍率相同的有两个：名称更像的胜出
        let two = [g("a", "Kiro-低价-高缓", 0.09), g("b", "Codex-pro", 0.09)];
        assert_eq!(suggest("Claude kiro 特价 0.09", &two).map(|c| c.id), Some("a".into()));
        // 倍率相同的有两个、名称也分不出来：不推荐
        assert_eq!(suggest("账号 0.09", &[g("a", "甲组", 0.09), g("b", "乙组", 0.09)]), None);
        // 名称里没有倍率：按名称和分组名的相似度
        let cs = [g("1", "kiro企业分组", 0.28), g("2", "GPT PRO", 0.25), g("3", "Gemini", 0.4)];
        assert_eq!(suggest("pqh-kiro企业", &cs).map(|c| c.id), Some("1".into()));
        assert_eq!(suggest("GPT Pro", &cs).map(|c| c.id), Some("2".into()));
        // 太不像（公共片段不足 3 个字符）不乱推荐
        assert_eq!(suggest("AB", &cs), None);
        assert_eq!(suggest("完全无关的名字", &cs), None);
    }

    #[test]
    fn new_upstream_debug_never_shows_the_key() {
        let u = NewUpstream { name: "n".into(), api_key: "sk-SECRET".into(), ..Default::default() };
        assert!(!format!("{u:?}").contains("SECRET"));
    }

    #[test]
    fn channel_types_and_base_urls_follow_the_sites_conventions() {
        assert_eq!((channel_type("anthropic"), channel_type("openai"), channel_type("gemini"), channel_type("grok"), channel_type("unknown")), (14, 1, 24, 48, 1));
        assert_eq!(sub2api_base_url("grok", "https://up.com/"), "https://up.com/v1");
        assert_eq!(sub2api_base_url("grok", "https://up.com/v1"), "https://up.com/v1");
        assert_eq!(sub2api_base_url("anthropic", "https://up.com/"), "https://up.com");
    }

    #[test]
    fn new_groups_are_validated() {
        assert!(NewGroup { name: " ".into(), rate_multiplier: 1.0, ..Default::default() }.validate().is_err());
        assert!(NewGroup { name: "a".into(), rate_multiplier: 0.0, ..Default::default() }.validate().is_err());
        assert!(NewGroup { name: "a".into(), rate_multiplier: 0.5, ..Default::default() }.validate().is_ok());
    }

    #[test]
    fn ymd_matches_known_dates() {
        assert_eq!(ymd(0), "1970-01-01");
        assert_eq!(ymd(951_782_400), "2000-02-29");
        assert_eq!(ymd(1_794_098_562), "2026-11-08");
        assert_eq!(ymd(-86_400), "1969-12-31");
    }

    #[test]
    fn rfc3339_parses_offsets_and_fractions() {
        assert_eq!(parse_rfc3339("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_rfc3339("1970-01-01T08:00:00+08:00"), Some(0));
        assert_eq!(parse_rfc3339("2000-02-29T00:00:00.123456Z"), Some(951_782_400));
        assert_eq!(parse_rfc3339("2026-11-07T15:35:38.51909+08:00"), Some(ymd_to_secs_check()));
        assert_eq!(parse_rfc3339("nope"), None);
    }

    fn ymd_to_secs_check() -> i64 {
        // 2026-11-07 07:35:38 UTC
        parse_rfc3339("2026-11-07T07:35:38Z").unwrap()
    }

    #[test]
    fn tidy_error_drops_request_ids_and_caps_length() {
        assert_eq!(tidy_error("Access forbidden (403): 无权访问 VT-Gemini 分组 (request id: 2026110514)  "), "Access forbidden (403): 无权访问 VT-Gemini 分组");
        assert_eq!(tidy_error("a (request id: 1) b (request id: 2)"), "a b");
        assert_eq!(tidy_error(&"x".repeat(300)).chars().count(), 201);
    }

    #[test]
    fn edits_are_validated_before_touching_the_site() {
        assert!(GroupEdit::default().validate().is_err());
        assert!(GroupEdit { rate_multiplier: Some(0.0), ..Default::default() }.validate().is_err());
        assert!(GroupEdit { rate_multiplier: Some(f64::NAN), ..Default::default() }.validate().is_err());
        assert!(GroupEdit { name: Some("  ".into()), ..Default::default() }.validate().is_err());
        assert!(GroupEdit { rate_multiplier: Some(0.5), ..Default::default() }.validate().is_ok());
    }
}
