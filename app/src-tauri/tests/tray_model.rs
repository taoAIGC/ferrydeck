use app_lib::service::{Active, Client, ClientOverview, GroupView};
use app_lib::tray::{build_model, parse_action, Action, Entry};

fn g(id: i64, name: &str, clients: Vec<Client>) -> GroupView {
    gs("s1", "站点一", id, name, clients)
}

fn gs(site: &str, site_name: &str, id: i64, name: &str, clients: Vec<Client>) -> GroupView {
    GroupView { site_id: site.into(), site_name: site_name.into(), id: id.to_string(), name: name.into(), description: None, platform: "x".into(), rate_multiplier: 0.5, clients, models: vec![], clients_inferred: false, categories: None }
}

fn ov(client: Client, active: Option<(i64, &str)>) -> ClientOverview {
    ClientOverview {
        client,
        dir_exists: true,
        in_use: active.is_some(),
        active: active.map(|(id, n)| Active { site_id: "s1".into(), site_name: "站点一".into(), group_id: id.to_string(), group_name: n.into(), model: None }),
        conflicts: vec![],
        groups_inferred: false,
    }
}

fn labels(m: &[Entry]) -> Vec<String> {
    m.iter()
        .map(|e| match e {
            Entry::Item { label, .. } => label.clone(),
            Entry::Header(t) => format!("#{t}"),
            Entry::Separator => "---".into(),
            Entry::Submenu { label, .. } => format!("> {label}"),
        })
        .collect()
}

#[test]
fn no_sites_shows_only_open_hint_and_quit() {
    let m = build_model(false, &[], &[]);
    assert_eq!(labels(&m), ["打开Ferrydeck", "---", "#还没有添加站点，请打开主窗口添加", "---", "退出Ferrydeck"]);
}

#[test]
fn logged_in_without_groups_yet_shows_loading() {
    let m = build_model(true, &[], &[]);
    assert!(labels(&m).contains(&"#正在加载分组…".to_string()));
}

#[test]
fn submenus_list_matching_groups_and_mark_the_active_one() {
    let groups = vec![g(1, "A", vec![Client::Claude, Client::ClaudeDesktop]), g(2, "B", vec![Client::Claude]), g(3, "C", vec![Client::Codex]), g(4, "Grok", vec![])];
    let overview = vec![ov(Client::Claude, Some((2, "B"))), ov(Client::ClaudeDesktop, None), ov(Client::Codex, None), ov(Client::Gemini, None)];
    let m = build_model(true, &groups, &overview);
    let l = labels(&m);
    assert!(l.contains(&"> Claude Code　· B".to_string()));
    assert!(l.contains(&"> Claude Desktop　· 未配置".to_string()));
    assert!(l.contains(&"> Codex　· 未配置".to_string()));
    assert!(!l.iter().any(|x| x.contains("Gemini")), "没有 Gemini 分组就不显示该项");
    assert!(!l.iter().any(|x| x.contains("Grok")), "不支持的分组不出现在菜单里");

    let Entry::Submenu { items, .. } = m.iter().find(|e| matches!(e, Entry::Submenu { label, .. } if label.starts_with("Claude Code"))).unwrap() else { panic!() };
    let checked: Vec<_> = items.iter().filter_map(|e| match e { Entry::Item { id, checked: true, .. } => Some(id.clone()), _ => None }).collect();
    assert_eq!(checked, ["enable|claude|s1|32"], "只有使用中的分组打勾");
    assert!(!items.iter().any(|e| matches!(e, Entry::Item { id, .. } if id.starts_with("restore"))), "不再提供还原入口");
}

#[test]
fn stale_active_info_is_ignored_when_client_is_no_longer_active() {
    let groups = vec![g(1, "A", vec![Client::Claude])];
    let mut o = ov(Client::Claude, Some((1, "A")));
    o.in_use = false; // 用户手动改掉了配置
    let l = labels(&build_model(true, &groups, &[o]));
    assert!(l.contains(&"> Claude Code　· 未配置".to_string()));
}

#[test]
fn actions_round_trip_with_the_ids_the_menu_produces() {
    let groups = vec![g(12, "A", vec![Client::ClaudeDesktop])];
    let m = build_model(true, &groups, &[]);
    let Entry::Submenu { items, .. } = m.iter().find(|e| matches!(e, Entry::Submenu { .. })).unwrap() else { panic!() };
    let Entry::Item { id, .. } = &items[0] else { panic!() };
    assert_eq!(parse_action(id), Some(Action::Enable { client: Client::ClaudeDesktop, site_id: "s1".into(), group_id: "12".into() }));
    assert_eq!(parse_action("open"), Some(Action::Open));
    assert_eq!(parse_action("quit"), Some(Action::Quit));
    assert_eq!(parse_action("restore|codex"), None, "还原入口已移除");
    for bad in ["", "enable|claude", "enable|claude|s1", "enable|nope|s1|31", "enable|claude|s1|zz", "enable|claude|s1|3", "whatever"] {
        assert_eq!(parse_action(bad), None, "{bad}");
    }
}

#[test]
fn multiple_sites_prefix_the_site_name_and_check_only_the_matching_site() {
    let groups = vec![gs("a", "站点A", 1, "同名分组", vec![Client::Claude]), gs("b", "站点B", 1, "同名分组", vec![Client::Claude])];
    let mut o = ov(Client::Claude, Some((1, "同名分组")));
    o.active.as_mut().unwrap().site_id = "b".into();
    let m = build_model(true, &groups, &[o]);
    let Entry::Submenu { items, .. } = m.iter().find(|e| matches!(e, Entry::Submenu { .. })).unwrap() else { panic!() };
    let l: Vec<_> = items.iter().filter_map(|e| match e { Entry::Item { label, checked, .. } => Some((label.clone(), *checked)), _ => None }).collect();
    assert_eq!(l, [("站点A · 同名分组　×0.5".to_string(), false), ("站点B · 同名分组　×0.5".to_string(), true)], "同名分组只有来自使用中站点的那个打勾");
}

#[test]
fn group_ids_with_special_characters_survive_the_menu_id() {
    for gid in ["Claude 逆向Kiro - 特价", "a|b|c", "含/斜杠", "x"] {
        let mut grp = gs("s1", "站点", 0, "n", vec![Client::Codex]);
        grp.id = gid.to_string();
        let m = build_model(true, &[grp], &[]);
        let Entry::Submenu { items, .. } = m.iter().find(|e| matches!(e, Entry::Submenu { .. })).unwrap() else { panic!() };
        let Entry::Item { id, .. } = &items[0] else { panic!() };
        assert_eq!(parse_action(id), Some(Action::Enable { client: Client::Codex, site_id: "s1".into(), group_id: gid.into() }), "{gid}");
    }
}
