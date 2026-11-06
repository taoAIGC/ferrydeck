//! 把各站点的登录凭据（刷新令牌 / 刷新 Cookie）放进 macOS 钥匙串，下次启动免登录。
//! 每个站点一条，钥匙串不可用时静默降级为“每次重新登录”。不保存密码。

const SERVICE: &str = "app.ferrydeck.desktop";

/// 自检模式（FERRYDECK_SELFTEST）下不读写钥匙串，避免自检依赖或改动用户真实的登录态。
fn disabled() -> bool {
    std::env::var_os("FERRYDECK_SELFTEST").is_some()
}

fn entry(site_id: &str) -> Option<keyring::Entry> {
    if disabled() {
        return None;
    }
    keyring::Entry::new(SERVICE, &format!("site:{site_id}")).ok()
}

pub fn save(site_id: &str, secret: &str) {
    if let Some(e) = entry(site_id) {
        let _ = e.set_password(secret);
    }
}

pub fn load(site_id: &str) -> Option<String> {
    entry(site_id)?.get_password().ok()
}

pub fn clear(site_id: &str) {
    if let Some(e) = entry(site_id) {
        let _ = e.delete_credential();
    }
}
