//! 站点的“管理员”标记：随站点列表保存，旧版本的记录里没有这个字段时按“不是管理员”处理。
use app_lib::sites::{Kind, Site};

#[test]
fn old_records_without_is_admin_load_as_not_admin() {
    let s: Site = serde_json::from_str(r#"{"id":"a","kind":"sub2api","name":"A","base_url":"https://a.example.com"}"#).unwrap();
    assert!(!s.is_admin);
}

#[test]
fn the_admin_flag_round_trips() {
    let s = Site { id: "a".into(), kind: Kind::Newapi, name: "A".into(), base_url: "https://a.example.com".into(), is_admin: true };
    let back: Site = serde_json::from_str(&serde_json::to_string(&s).unwrap()).unwrap();
    assert!(back.is_admin);
}
