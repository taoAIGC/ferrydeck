//! 各客户端写入模块共用的底层工具：原子写、状态文件、备份。

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{de::DeserializeOwned, Serialize};
use serde_json::{Map, Value};

#[derive(Debug)]
pub enum Error {
    Io(std::io::Error),
    Parse(String),
    State(String),
    Verify(String),
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::Io(e) => write!(f, "读写文件失败: {e}"),
            Error::Parse(e) => write!(f, "配置文件无法解析: {e}"),
            Error::State(e) => write!(f, "状态文件异常: {e}"),
            Error::Verify(e) => write!(f, "写入后自检未通过（已自动回滚）: {e}"),
        }
    }
}

impl std::error::Error for Error {}

impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        Error::Io(e)
    }
}

pub fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// 临时文件 + rename，避免写到一半崩溃留下损坏的配置；保留原文件权限。
pub fn write_atomic(path: &Path, content: &str) -> Result<(), Error> {
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(dir)?;
    let tmp = dir.join(format!(".{}.ferrydeck-tmp", path.file_name().and_then(|n| n.to_str()).unwrap_or("f")));
    {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(content.as_bytes())?;
        f.sync_all()?;
    }
    if let Ok(meta) = fs::metadata(path) {
        let _ = fs::set_permissions(&tmp, meta.permissions());
    }
    fs::rename(&tmp, path)?;
    Ok(())
}

pub fn load_state<T: DeserializeOwned + Default>(data_dir: &Path, name: &str) -> Result<T, Error> {
    let p = data_dir.join(name);
    if !p.exists() {
        return Ok(T::default());
    }
    serde_json::from_str(&fs::read_to_string(p)?).map_err(|e| Error::State(e.to_string()))
}

pub fn save_state<T: Serialize>(data_dir: &Path, name: &str, s: &T) -> Result<(), Error> {
    fs::create_dir_all(data_dir)?;
    write_atomic(
        &data_dir.join(name),
        &serde_json::to_string_pretty(s).map_err(|e| Error::State(e.to_string()))?,
    )
}

pub fn clear_state(data_dir: &Path, name: &str) -> Result<(), Error> {
    let p = data_dir.join(name);
    if p.exists() {
        fs::remove_file(p)?;
    }
    Ok(())
}

/// 把整份原文件备份到 `<data_dir>/backups/<client>/<文件名>.<时间戳>`，返回备份路径。
pub fn backup_file(data_dir: &Path, client: &str, src: &Path, text: &str) -> Result<PathBuf, Error> {
    let dir = data_dir.join("backups").join(client);
    fs::create_dir_all(&dir)?;
    let name = src.file_name().and_then(|n| n.to_str()).unwrap_or("file");
    let dest = dir.join(format!("{name}.{}", now_secs()));
    fs::write(&dest, text)?;
    Ok(dest)
}

pub fn parse_root(text: &str) -> Result<Map<String, Value>, Error> {
    if text.trim().is_empty() {
        return Ok(Map::new());
    }
    match serde_json::from_str::<Value>(text).map_err(|e| Error::Parse(e.to_string()))? {
        Value::Object(m) => Ok(m),
        _ => Err(Error::Parse("顶层不是 JSON 对象".into())),
    }
}

/// 记录原文件的缩进和结尾换行，写回时保持一致，避免无谓的格式变动。
pub struct Layout {
    pub indent: String,
    pub trailing_newline: bool,
}

impl Layout {
    pub fn detect(text: &str) -> Self {
        let indent = text
            .lines()
            .skip(1)
            .find(|l| l.starts_with(' ') || l.starts_with('\t'))
            .map(|l| l.chars().take_while(|c| *c == ' ' || *c == '\t').collect::<String>())
            .unwrap_or_else(|| "  ".into());
        Layout { indent, trailing_newline: text.is_empty() || text.ends_with('\n') }
    }

    pub fn render(&self, root: &Map<String, Value>) -> String {
        let fmt = serde_json::ser::PrettyFormatter::with_indent(self.indent.as_bytes());
        let mut buf = Vec::new();
        let mut ser = serde_json::Serializer::with_formatter(&mut buf, fmt);
        Serialize::serialize(root, &mut ser).expect("序列化 JSON 不会失败");
        let mut s = String::from_utf8(buf).expect("JSON 是合法 UTF-8");
        if self.trailing_newline {
            s.push('\n');
        }
        s
    }
}

/// 写入并自检；自检失败则把原文本写回，并返回错误。
pub fn write_checked(
    cfg: &Path,
    old_text: &str,
    root: &Map<String, Value>,
    layout: &Layout,
    check: impl Fn(&Map<String, Value>) -> Result<(), String>,
) -> Result<(), Error> {
    let new_text = layout.render(root);
    write_atomic(cfg, &new_text)?;
    let verdict = fs::read_to_string(cfg)
        .map_err(|e| e.to_string())
        .and_then(|t| parse_root(&t).map_err(|e| e.to_string()))
        .and_then(|after| check(&after));
    if let Err(msg) = verdict {
        if old_text.is_empty() {
            let _ = fs::remove_file(cfg);
        } else {
            let _ = write_atomic(cfg, old_text);
        }
        return Err(Error::Verify(msg));
    }
    Ok(())
}


/// FNV-1a 64 位哈希，用来判断“文件自上次写入后有没有被别人改过”（不是安全用途）。
pub fn fnv(text: &str) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in text.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}
