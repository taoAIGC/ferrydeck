# 设计说明：多中转站聚合

在现有桌面应用基础上，支持用户绑定多个中转站账号（new-api / sub2api），把所有站点的分组放在一起切换。
体验与现在一致：选分组 → 自动写入 Claude Code / Claude Desktop / Codex / Gemini CLI。

## 已定的决定

- **不设默认站点**。首次启动是空状态，引导用户添加站点。
- **sub2api**：邮箱 + 密码登录（现有实现）。
- **new-api**：账号密码登录（与 sub2api 体验一致）。开启了人机验证、2FA 或关闭密码登录的站点暂不支持。系统访问令牌方式评估过但未采用。

## 已核实的 new-api 事实（v1.0.0-rc.45）

- `GET /api/status`（无需登录）返回 `version`、`quota_per_unit`（500000）、`display_in_currency`、
  `quota_display_type`、`top_up_link`、`usd_exchange_rate`。可用来**识别站点类型**和**换算余额**。
- 登录 `POST /api/user/login` 返回约 15 分钟有效的 Bearer 访问令牌，同时下发刷新 Cookie `new_api_refresh`；续期用 `POST /api/user/auth/refresh`。接口调用带 `Authorization: Bearer` 与 `New-Api-User: <用户 id>`。
- 管理接口：`/api/user/self`（余额）、`/api/user/self/groups`（可用分组）、`/api/token/`（GET 列表 / POST 创建，带 `group`）、
  `/api/token/:id/key`（POST，取令牌**明文**，列表里的 Key 是脱敏的）。
- **rc.45 引入了带权限范围（scopes）的访问令牌**：`/api/user/access_tokens`，只在创建时显示一次明文，库里只存哈希；
  同时保留旧的整体访问令牌（`/api/user/access_tokens/legacy`）。含 `group:read`、`user:read`、`billing:read`、`log:read` 等范围。
  **建 Key 需要哪个范围我还没验证**，要用真实令牌测（见下）。
- 老版本的 new-api 只有旧式令牌；站点版本不同，接口可能有差异，必须做“失败即降级、给清楚提示”。

## 架构

### 适配器接口（每种系统一份实现）

```
SiteAdapter:
  detect(base_url)            识别类型与版本
  verify(credential)          校验凭据，返回账号信息（邮箱/用户名、余额）
  groups()                    可用分组：id、名称、平台（anthropic/openai/gemini…）、倍率
  ensure_key(group)           找到或创建该分组的专用 Key，返回明文
  models(key)                 该 Key 能用的模型
  balance()                   余额，统一换算成显示用的金额
  topup_url()                 充值页地址
```

- `Sub2apiAdapter`：沿用现有 `api.rs`。
- `NewApiAdapter`：新增。分组的“平台”在 new-api 里没有字段，需要由模型列表推断（含 claude → anthropic，gpt → openai，gemini → gemini）。

### 数据模型

```
Site     { id, kind(sub2api|newapi), name, base_url }
Account  { site_id, 凭据（钥匙串）, 显示名 }
GroupRef { site_id, group_id }      // 分组的唯一标识
Active   { client → (site_id, group_id, model) }
```

- 同名分组在不同站点并存，界面一律带站点标签。
- 凭据只存钥匙串：sub2api 存 refresh token；new-api 存轮换的刷新 Cookie（每次刷新都会换新，必须保存）。**不存密码**。
- 站点列表和使用状态存本机应用数据目录；Key 命名 `desktop-<分组名>`，按站点各自创建。

### 写入层

每个客户端同一时刻只指向一个（站点，分组），所以写入层与站点无关：切换站点就是覆盖同一组固定的配置项。

- Codex：固定使用 `[model_providers.ferrydeck]` 这一个 provider。
- Claude Desktop：固定使用一个方案 id，在 `_meta.json` 里登记并设为当前。
- “用户原始配置”**全局只记录一份**：第一次写入前记录，之后无论切到哪个站点，都不会把我们写过的内容当成“原始”。
- 每个站点的使用状态（哪个客户端正在用哪个站点的哪个分组）单独记在 `active.json`。

## 界面

- 顶部或侧栏：站点切换/筛选（默认“全部”），旁边“添加站点”。
- 分组行：名称、站点标签、倍率、该站点余额/状态、启用按钮。
- 某个站点离线或凭据失效：该站点标红并提示重新登录，其他站点不受影响。
- 每个站点各有“去充值”（用站点的充值地址：sub2api 为 `/purchase`，new-api 取 `/api/status` 的 `top_up_link`，没有就打开站点首页）。
- 菜单栏的分组切换按站点分组。

## 添加站点流程

1. 输入站点地址（强制 HTTPS，明文 HTTP 仅允许本机地址并提示风险）。
2. 自动识别类型与版本，显示给用户确认。
3. 账号密码登录（sub2api 用邮箱，new-api 用用户名）。开启了人机验证、2FA、或关闭了密码登录的站点会在这一步提示暂不支持。
   应用不保存密码，只保存登录凭据（刷新令牌 / 刷新 Cookie）到系统钥匙串。
4. 校验通过后拉取分组，加入列表。
