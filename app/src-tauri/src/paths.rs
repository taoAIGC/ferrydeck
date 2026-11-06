//! 各客户端配置目录与本应用数据目录。测试时用 `under()` 指到临时目录，绝不碰真实配置。

use std::path::{Path, PathBuf};

#[derive(Clone, Debug)]
pub struct Paths {
    pub home: PathBuf,
    pub claude: PathBuf,
    pub codex: PathBuf,
    pub gemini: PathBuf,
    /// Claude Desktop 第三方推理模式的数据目录（`Claude-3p`）。
    pub claude_desktop: PathBuf,
    pub data: PathBuf,
}

impl Paths {
    pub fn under(root: &Path) -> Self {
        Paths {
            home: root.to_path_buf(),
            claude: root.join(".claude"),
            codex: root.join(".codex"),
            gemini: root.join(".gemini"),
            claude_desktop: root.join("Library/Application Support/Claude-3p"),
            data: root.join("Library/Application Support/Ferrydeck"),
        }
    }

    pub fn real() -> Result<Self, String> {
        let h = std::env::var_os("HOME").map(PathBuf::from).ok_or("无法确定用户目录")?;
        Ok(Self::under(&h))
    }
}
