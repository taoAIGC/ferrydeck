//! 本地诊断日志：`~/.ferrydeck/logs/ferrydeck.log`。
//!
//! 记录测速结果、Key 的创建、站点限流、拉取分组失败等，方便排查“为什么某个站点测速失败”。
//! 只写站点地址、分组名、模型、状态码和站点返回的错误原话，**绝不写 Key、令牌、Cookie、密码**
//! （写入前还会再过一遍脱敏）。超过 512 KB 自动滚动成 `ferrydeck.log.1`，总共最多约 1 MB。
//! 放在 `~/.ferrydeck` 而不是 `Application Support`，是为了不被清理软件当作“卸载残留”一起删掉。

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

const FILE: &str = "ferrydeck.log";
const MAX_BYTES: u64 = 512 * 1024;

static DIR: OnceLock<PathBuf> = OnceLock::new();
static WRITE_LOCK: Mutex<()> = Mutex::new(());

/// 应用启动时调用一次，指定日志目录。没调用（比如单元测试）时 `log` 什么都不做。
pub fn init(dir: PathBuf) {
    let _ = DIR.set(dir);
}

/// 记一条日志：`kind` 是事件类别（probe / key_create / rate_limited…），`msg` 是人能读的细节。
pub fn log(kind: &str, msg: &str) {
    if let Some(dir) = DIR.get() {
        write_line(dir, kind, msg);
    }
}

/// 指定目录写一条（测试用）。
pub fn write_line(dir: &Path, kind: &str, msg: &str) {
    let line = format!("{} {:<12} {}\n", utc_stamp(now_secs()), kind, redact(msg).replace('\n', " "));
    let Ok(_g) = WRITE_LOCK.lock() else { return };
    if fs::create_dir_all(dir).is_err() {
        return;
    }
    let path = dir.join(FILE);
    if fs::metadata(&path).map(|m| m.len() > MAX_BYTES).unwrap_or(false) {
        let _ = fs::rename(&path, dir.join(format!("{FILE}.1"))); // 只保留一份旧的
    }
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&path) {
        let _ = f.write_all(line.as_bytes());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = f.set_permissions(fs::Permissions::from_mode(0o600));
        }
    }
}

/// 抹掉可能出现在文本里的密钥：`sk-…`、`Bearer …`、`new_api_refresh=…`、`api_key=…`/`"key":"…"`。
pub fn redact(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let b: Vec<char> = s.chars().collect();
    let mut i = 0;
    let starts = |i: usize, pat: &str| pat.chars().enumerate().all(|(k, c)| b.get(i + k) == Some(&c));
    let secret = |c: char| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | '+' | '/' | '=');
    while i < b.len() {
        let prefix = ["sk-", "Bearer ", "bearer ", "new_api_refresh=", "api_key=", "apikey=", "token=", "x-api-key: ", "x-goog-api-key: "].iter().find(|p| starts(i, p));
        if let Some(p) = prefix {
            let plen = p.chars().count();
            let mut j = i + plen;
            while j < b.len() && secret(b[j]) {
                j += 1;
            }
            // 太短的不当作密钥（比如单独一个 "sk-"）
            if j - (i + plen) >= 6 || **p != *"sk-" {
                out.push_str(p);
                out.push_str("***");
                i = j;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    out
}

fn now_secs() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

/// 形如 `2026-11-07 15:14:34Z`（UTC；中国大陆本地时间加 8 小时）。
fn utc_stamp(secs: i64) -> String {
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (h, m, s) = (rem / 3600, rem % 3600 / 60, rem % 60);
    // Howard Hinnant 的 civil_from_days
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mo = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if mo <= 2 { 1 } else { 0 };
    format!("{y:04}-{mo:02}-{d:02} {h:02}:{m:02}:{s:02}Z")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stamp_matches_known_dates() {
        assert_eq!(utc_stamp(0), "1970-01-01 00:00:00Z");
        assert_eq!(utc_stamp(1_794_064_474), "2026-11-07 15:14:34Z");
        assert_eq!(utc_stamp(951_827_696), "2000-02-29 12:34:56Z");
    }
}
