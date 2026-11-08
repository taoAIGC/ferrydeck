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
    /// 数据目录之外的一份“已知站点”备忘（只有站点名称和地址，没有任何凭据），放在用户目录下的隐藏目录里。
    /// 清理软件会把 `Application Support/<应用名>` 当作卸载残留删掉；这里清理软件扫不到，
    /// 所以数据目录被清空后，下次启动还能知道“以前添加过哪些站点”，据此提示并帮用户恢复站点列表。
    pub ferrydeck_home: PathBuf,
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
            ferrydeck_home: root.join(".ferrydeck"),
        }
    }

    pub fn real() -> Result<Self, String> {
        let h = std::env::var_os("HOME").map(PathBuf::from).ok_or("无法确定用户目录")?;
        Ok(Self::under(&h))
    }
}
