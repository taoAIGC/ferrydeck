//! 菜单栏（状态栏）图标：关闭窗口后应用继续留在顶部，点图标可打开主窗口或直接切换分组。

use serde::Serialize;

use crate::service::{Client, ClientOverview, GroupView};

/// 菜单项的 id 约定：`enable|<client>|<site_id>|<group_id 的十六进制>`、`open`、`quit`。
pub const ID_OPEN: &str = "open";
pub const ID_QUIT: &str = "quit";

#[derive(Debug, Clone, PartialEq, Serialize)]
pub enum Entry {
    /// 顶部灰色说明行（不可点）。
    Header(String),
    Item { id: String, label: String, checked: bool, enabled: bool },
    Separator,
    Submenu { label: String, items: Vec<Entry> },
}

pub fn client_name(c: Client) -> &'static str {
    match c {
        Client::Claude => "Claude Code",
        Client::ClaudeDesktop => "Claude Desktop",
        Client::Codex => "Codex",
        Client::Gemini => "Gemini CLI",
    }
}

const ORDER: [Client; 4] = [Client::Claude, Client::ClaudeDesktop, Client::Codex, Client::Gemini];

/// 分组 id 可能含 `|` 等字符（new-api 直接用分组名），编码成十六进制放进菜单项 id。
pub fn hex_encode(s: &str) -> String {
    s.bytes().map(|b| format!("{b:02x}")).collect()
}

pub fn hex_decode(s: &str) -> Option<String> {
    if s.len() % 2 != 0 || !s.is_ascii() {
        return None;
    }
    let bytes: Option<Vec<u8>> = (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok()).collect();
    String::from_utf8(bytes?).ok()
}

/// 由是否有站点、分组和各客户端使用情况生成菜单。多个站点时分组名前带站点名。
pub fn build_model(has_sites: bool, groups: &[GroupView], overview: &[ClientOverview]) -> Vec<Entry> {
    let mut out = vec![Entry::Item { id: ID_OPEN.into(), label: "打开Ferrydeck".into(), checked: false, enabled: true }, Entry::Separator];
    let multi = groups.iter().map(|g| g.site_id.as_str()).collect::<std::collections::BTreeSet<_>>().len() > 1;
    if !has_sites {
        out.push(Entry::Header("还没有添加站点，请打开主窗口添加".into()));
    } else if groups.is_empty() {
        out.push(Entry::Header("正在加载分组…".into()));
    } else {
        for c in ORDER {
            let list: Vec<&GroupView> = groups.iter().filter(|g| g.clients.contains(&c)).collect();
            if list.is_empty() {
                continue;
            }
            let active = overview.iter().find(|o| o.client == c).and_then(|o| if o.in_use { o.active.as_ref() } else { None });
            let label = match active {
                Some(a) => format!("{}　· {}", client_name(c), a.group_name),
                None => format!("{}　· 未配置", client_name(c)),
            };
            let items: Vec<Entry> = list
                .iter()
                .map(|g| Entry::Item {
                    id: format!("enable|{}|{}|{}", c.id(), g.site_id, hex_encode(&g.id)),
                    label: if multi { format!("{} · {}　×{}", g.site_name, g.name, g.rate_multiplier) } else { format!("{}　×{}", g.name, g.rate_multiplier) },
                    checked: active.is_some_and(|a| a.site_id == g.site_id && a.group_id == g.id),
                    enabled: true,
                })
                .collect();
            out.push(Entry::Submenu { label, items });
        }
    }
    out.push(Entry::Separator);
    out.push(Entry::Item { id: ID_QUIT.into(), label: "退出Ferrydeck".into(), checked: false, enabled: true });
    out
}

/// 解析点击的菜单项 id。
#[derive(Debug, PartialEq)]
pub enum Action {
    Open,
    Quit,
    Enable { client: Client, site_id: String, group_id: String },
}

pub fn parse_action(id: &str) -> Option<Action> {
    let parts: Vec<&str> = id.split('|').collect();
    match parts.as_slice() {
        ["open"] => Some(Action::Open),
        ["quit"] => Some(Action::Quit),
        ["enable", c, site, g] => Some(Action::Enable { client: Client::parse(c).ok()?, site_id: site.to_string(), group_id: hex_decode(g)? }),
        _ => None,
    }
}
