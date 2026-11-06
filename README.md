# Ferrydeck

把多个中转站（**new-api / sub2api**）的账号和分组聚合在一起：选一个分组，自动写入本机的
**Claude Code / Claude Desktop / Codex / Gemini CLI** 配置，不用再手动申请 Key、改配置文件。

目前支持 **macOS**（Apple 芯片和 Intel）。

![主界面（模拟数据）](docs/screenshots/main.png)

## 功能

- 添加多个站点，自动识别 new-api / sub2api，用站点的账号密码登录；所有站点的分组合并显示，同名分组并存、可按站点筛选
- 点“启用”：自动为该分组创建（或复用）一把名为 `desktop-<分组名>` 的专用 Key，并写进对应客户端的配置
- 每个站点独立显示余额，有“去充值”入口；某个站点登录过期只影响它自己
- 关闭窗口后常驻菜单栏，点图标可直接切换分组
- 写入配置前自动备份；写入后自检，不对就自动回滚；只改自己管的项，其他内容原样保留
- 应用内自动更新（签名校验）

## 隐私与安全

- **密码不会被保存**，只在登录那一刻发给你填写的站点；登录后的刷新凭据存在 macOS 钥匙串里
- 应用只连接**你添加的站点**和**更新地址**，没有统计、没有遥测
- 站点必须是 https（本机地址除外）；开启了人机验证、2FA、或关闭了密码登录的站点暂不支持
- 为每个分组创建的 Key 会明文写进客户端自己的配置文件（客户端工作所必需），请注意这些文件的访问权限

详见 [SECURITY.md](SECURITY.md)。

## 安装

从 [Releases](https://github.com/taoAIGC/ferrydeck/releases) 页面下载，或使用安装脚本：

```bash
curl -fsSL https://github.com/taoAIGC/ferrydeck/releases/latest/download/install.sh | sh
```

安装脚本会校验 SHA-256，且用 curl 下载的文件不会被系统打上“隔离”标记，不会弹“未识别的开发者”。
直接下载 dmg 的话，由于没有 Apple 开发者签名，首次打开需要在 系统设置 → 隐私与安全性 里点“仍要打开”。

## 支持的客户端与写入内容

| 客户端 | 文件 | 内容 |
|---|---|---|
| Claude Code | `~/.claude/settings.json` | `env.ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` / 可选 `ANTHROPIC_MODEL` |
| Claude Desktop | `~/Library/Application Support/Claude-3p/configLibrary/` | 一个固定 id 的方案文件，在 `_meta.json` 登记并设为当前 |
| Codex | `~/.codex/config.toml` | `[model_providers.ferrydeck]`，`model_provider` / `model`（不碰 `auth.json`） |
| Gemini CLI | `~/.gemini/.env` + `settings.json` | `GEMINI_API_KEY` / `GOOGLE_GEMINI_BASE_URL` / 可选 `GEMINI_MODEL`，`security.auth.selectedType` |

> Claude Desktop 需要你先在它里面开启开发者模式并进入第三方推理模式，写入的配置才会生效。
> 其写入格式是照已有的可用方案文件确定的，**尚未在真实的 Claude Desktop 里验证过**，欢迎反馈。

写入的共同保证与站点适配细节见 [docs/DESIGN.md](docs/DESIGN.md)。

## 站点适配

| | sub2api | new-api（需 v1.0.0-rc.45 或更新） |
|---|---|---|
| 登录 | 邮箱 + 密码 | 用户名 + 密码，返回约 15 分钟的 Bearer 令牌 + 轮换的刷新 Cookie |
| 分组 | 接口直接给出平台 | 没有平台字段，由公开的 `/api/pricing` 按模型推断 |
| 建 Key | 返回明文 | 列表里是脱敏的，需再取一次明文 |
| 失败形态 | HTTP 状态码 | 常是 HTTP 200 + `success:false` |

其他版本的 new-api 可能接口不同，遇到不支持的情况会给出明确提示。

## 开发

需要 Node.js 20+、Rust（stable）、macOS。

```bash
cd app && npm install
npm run tauri dev        # 开发运行
```

### 测试

```bash
# 界面自动化测试：用本机 Chrome 驱动，使用内置的模拟后端，不碰真实配置
cd app && npm run test:ui

# Rust 测试：全部离线。用本地模拟服务器重现两种站点的各种行为，所有配置写入都在临时目录
cd app/src-tauri && cargo test

# 真实 Tauri 应用里的自检（前后端通信、菜单栏图标、关窗口不退出）
cd app && FERRYDECK_SELFTEST=1 npm run tauri dev
```

可选：用你自己的站点和测试账号做线上端到端测试（默认忽略；配置仍只写临时目录，结束时删除建出的 Key）：

```bash
E2E_SUB2API_URL=https://… E2E_SUB2API_USER=… E2E_SUB2API_PASSWORD=… \
E2E_NEWAPI_URL=https://… E2E_NEWAPI_USER=… E2E_NEWAPI_PASSWORD=… \
E2E_GROUPS="分组A,分组B" \
  cargo test --test e2e_live -- --ignored --nocapture --test-threads=1
```

> 务必设置 `E2E_GROUPS`，否则会一次性为所有分组建 Key，容易被站点限流。
> 浏览器里直接 `npm run dev` 会使用模拟后端，可用 `?s=sites2,expired` 等参数切换场景（见 `app/src/mock.ts` 顶部）。

### 目录

```
app/
  src/                    前端：main.ts 界面，mock.ts 模拟后端
  src-tauri/src/
    sites/                站点适配：sub2api.rs / newapi.rs / http.rs（共用请求层）/ mod.rs
    clients/              各客户端的写入：claude / claude_desktop / codex / gemini / common
    service.rs            “分组 → Key → 写入客户端配置”
    state.rs              已添加的站点及登录会话
    tray.rs               菜单栏菜单内容
    session_store.rs      登录凭据存钥匙串
  src-tauri/tests/        Rust 测试
  ui-tests/               界面自动化测试
scripts/                  install.sh / release.sh / deploy.sh
docs/                     设计说明、截图
```

## 构建与发布（自己发布时必读）

**Fork 后发布自己的版本，必须替换以下三样，否则你的用户会从别人的地址收到更新：**

1. 生成你自己的更新签名密钥：`npm run tauri signer generate -- -w ~/.tauri/my-updater.key`，
   把公钥填进 `app/src-tauri/tauri.conf.json` 的 `plugins.updater.pubkey`。**私钥务必备份，丢了就无法再给已安装用户推更新。**
2. 把 `plugins.updater.endpoints` 改成你自己的下载站地址。
3. 复制 `scripts/release.env.example` 为 `.release.env`（已被 `.gitignore` 忽略），填入你的下载站和服务器信息。

```bash
cd app
export TAURI_SIGNING_PRIVATE_KEY=~/.tauri/my-updater.key       # 私钥文件路径或内容
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
npm run tauri build -- --target universal-apple-darwin          # 同时支持 Intel 与 Apple 芯片
cd .. && scripts/release.sh "更新说明"                            # 生成 release/desktop/，并检查更新地址与下载站是否一致
scripts/deploy.sh            # 演练，只显示会上传什么
scripts/deploy.sh --yes      # 真正上传并检查线上
```

发版时同时修改 `tauri.conf.json`、`Cargo.toml`、`package.json` 的 version，且必须比线上的更大。
下载站需要能以静态文件方式提供 `/desktop/*`，Caddy 示例见 `scripts/caddy-desktop.snippet`。

本项目没有 Apple 开发者账号，使用免费的 ad-hoc 签名、不做公证，因此推荐用安装脚本分发。

## 免责声明

本项目是独立的第三方工具，与 Anthropic、OpenAI、Google 及任何中转站运营方均无关联。
“Claude”“Codex”“Gemini”等名称归其各自所有者，这里仅用于说明兼容的软件。
本工具会修改你本机上这些客户端的配置文件；虽然写入前会备份并在出错时回滚，仍建议重要配置自行留一份。
使用任何中转站服务时，请遵守该站点以及上游服务商的使用条款。

## 许可证

[MIT](LICENSE)
