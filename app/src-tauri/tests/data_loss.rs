//! 数据目录被清理软件误删后的检测与恢复：只有“以前有站点、现在没了”才提示；
//! 用户自己把站点移除光、或者从来没添加过，都不能误报。

use std::fs;

use app_lib::paths::Paths;
use app_lib::sites::{self, Kind, Site};
use app_lib::state::AppState;
use tempfile::TempDir;

fn site(id: &str, name: &str, url: &str, kind: Kind) -> Site {
    Site { id: id.into(), kind, name: name.into(), base_url: url.into() }
}

#[tokio::test]
async fn deleting_the_data_dir_is_detected_and_the_site_list_can_be_restored() {
    let t = TempDir::new().unwrap();
    let paths = Paths::under(t.path());
    let state = AppState::new(paths.clone());
    let a = site("a1", "bestapi.io", "https://bestapi.io", Kind::Sub2api);
    let b = site("b2", "antnext", "https://www.antnext.net", Kind::Newapi);
    state.sites.write().await.push(AppState::make_runtime(&paths, a.clone()));
    state.sites.write().await.push(AppState::make_runtime(&paths, b.clone()));
    state.persist_sites().await.unwrap();
    assert!(sites::detect_data_loss(&paths.data, &paths.ferrydeck_home).is_none(), "数据都在，不提示");

    // 清理软件把 Application Support/Ferrydeck 整个删了；用户目录下的备忘不在它的清理范围里
    fs::remove_dir_all(&paths.data).unwrap();
    assert!(paths.ferrydeck_home.join("known-sites.json").exists());
    let lost = sites::detect_data_loss(&paths.data, &paths.ferrydeck_home).expect("应当提示数据丢失");
    assert_eq!(lost, vec![a.clone(), b.clone()]);

    // 恢复：写回站点列表（没有任何凭据），之后检测不再报丢失
    sites::save_sites(&paths.data, &lost).unwrap();
    assert_eq!(sites::load_sites(&paths.data), vec![a, b]);
    assert!(sites::detect_data_loss(&paths.data, &paths.ferrydeck_home).is_none());
}

#[tokio::test]
async fn no_false_alarm_when_nothing_was_ever_added_or_the_user_removed_everything() {
    let t = TempDir::new().unwrap();
    let paths = Paths::under(t.path());
    assert!(sites::detect_data_loss(&paths.data, &paths.ferrydeck_home).is_none(), "全新安装不提示");

    let state = AppState::new(paths.clone());
    let a = site("a1", "bestapi.io", "https://bestapi.io", Kind::Sub2api);
    state.sites.write().await.push(AppState::make_runtime(&paths, a));
    state.persist_sites().await.unwrap();
    // 用户自己把站点全部移除：备忘同步清空
    state.sites.write().await.clear();
    state.persist_sites().await.unwrap();
    fs::remove_dir_all(&paths.data).unwrap(); // 即使之后数据目录也没了
    assert!(sites::detect_data_loss(&paths.data, &paths.ferrydeck_home).is_none(), "自己移除光了不算丢失");
}

#[test]
fn the_marker_holds_names_and_urls_but_no_credentials() {
    let t = TempDir::new().unwrap();
    let paths = Paths::under(t.path());
    sites::save_known_sites(&paths.ferrydeck_home, &[site("a1", "bestapi.io", "https://bestapi.io", Kind::Sub2api)]).unwrap();
    let text = fs::read_to_string(paths.ferrydeck_home.join("known-sites.json")).unwrap();
    for k in ["token", "cookie", "password", "secret", "key"] {
        assert!(!text.to_lowercase().contains(k), "备忘里不应出现 {k}: {text}");
    }
    assert!(text.contains("https://bestapi.io"));
}

#[test]
fn a_corrupt_marker_does_not_cause_a_false_alarm() {
    let t = TempDir::new().unwrap();
    let paths = Paths::under(t.path());
    fs::create_dir_all(&paths.ferrydeck_home).unwrap();
    fs::write(paths.ferrydeck_home.join("known-sites.json"), "不是 JSON").unwrap();
    assert!(sites::detect_data_loss(&paths.data, &paths.ferrydeck_home).is_none());
}
