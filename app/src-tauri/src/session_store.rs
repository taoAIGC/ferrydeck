//! 把各站点的登录凭据（刷新令牌 / 刷新 Cookie）存在应用自己的数据目录里，下次启动免登录。
//! 每个站点一条；**不保存密码**。
//!
//! 为什么不用 macOS 钥匙串：本项目没有 Apple 开发者证书、是 ad-hoc 签名，每次更新后代码签名标识都会变，
//! 钥匙串因此每次都会要求重新授权（还会要求输入登录密码）。而应用为分组创建的 API Key 本来就以明文写在
//! 各客户端的配置文件里，所以用权限 0600 的文件保存刷新令牌，安全性上并没有实质降低，体验却稳定得多。

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value};

const FILE: &str = "sessions.json";

/// 自检模式（FERRYDECK_SELFTEST）下不读写，避免自检依赖或改动用户真实的登录态。
fn disabled() -> bool {
    std::env::var_os("FERRYDECK_SELFTEST").is_some()
}

fn file(data_dir: &Path) -> PathBuf {
    data_dir.join(FILE)
}

fn read_all(data_dir: &Path) -> Map<String, Value> {
    fs::read_to_string(file(data_dir))
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default()
}

/// 原子写入，并收紧到只有自己能读（文件里有刷新令牌）。
fn write_all(data_dir: &Path, m: &Map<String, Value>) {
    if fs::create_dir_all(data_dir).is_err() {
        return;
    }
    let Ok(text) = serde_json::to_string_pretty(&Value::Object(m.clone())) else {
        return;
    };
    let tmp = data_dir.join(".sessions.json.tmp");
    if fs::write(&tmp, text).is_err() {
        return;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600));
    }
    let _ = fs::rename(&tmp, file(data_dir));
}

pub fn save(data_dir: &Path, site_id: &str, secret: &str) {
    if disabled() {
        return;
    }
    let mut m = read_all(data_dir);
    m.insert(site_id.to_string(), Value::String(secret.to_string()));
    write_all(data_dir, &m);
}

pub fn load(data_dir: &Path, site_id: &str) -> Option<String> {
    if disabled() {
        return None;
    }
    read_all(data_dir).get(site_id)?.as_str().map(String::from)
}

pub fn clear(data_dir: &Path, site_id: &str) {
    if disabled() {
        return;
    }
    let mut m = read_all(data_dir);
    if m.remove(site_id).is_some() {
        write_all(data_dir, &m);
    }
}
