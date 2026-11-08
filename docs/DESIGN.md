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
Account  { site_id, 凭据（sessions.json）, 显示名 }
GroupRef { site_id, group_id }      // 分组的唯一标识
Active   { client → (site_id, group_id, model) }
```

- 同名分组在不同站点并存，界面一律带站点标签。
- 凭据只存在应用数据目录的 `sessions.json`（0600）：sub2api 存 refresh token；new-api 存轮换的刷新 Cookie（每次刷新都会换新，必须保存）。**不存密码**。
  不用钥匙串的原因见 SECURITY.md：ad-hoc 签名每次更新标识都会变，钥匙串会反复弹授权框。
- 站点列表和使用状态存本机应用数据目录；Key 命名 `Ferrydeck-<分组名>`（旧版的 `desktop-<分组名>` 仍识别复用），按站点各自创建。

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
   应用不保存密码，只保存登录凭据（刷新令牌 / 刷新 Cookie）到应用数据目录的 0600 文件。
4. 校验通过后拉取分组，加入列表。


## 分组更新机制

站点的分组会不断变化，所以应用**不缓存分组列表**：

- 顶栏应用名右侧有刷新按钮和“更新于 时:分”（最近一次**真正向站点拉取**的时间，命中缓存时不变）。点按钮是手动刷新：无视缓存，重新向各站点拉取分组、余额和模型。
- 自动刷新（切回窗口、打开菜单栏面板、后台通知）遵守“一分钟内拉过就不再请求站点”：直接用缓存，只有超过一分钟才重新拉取。菜单栏面板底部也有同样的刷新按钮和时间。
- 请求的接口：`/groups/available`（sub2api）或 `/api/user/self/groups` + `/api/pricing`（new-api）。
- **后台不会刷新分组和模型。** 应用最小化或只留在菜单栏时，唯一的后台任务是“保持登录”：每 10 分钟看一眼本地时间，只有真正到了续期时间（6 小时）或站点掉线需要重连时才发请求。分组和模型只在你打开窗口/面板（一分钟内拉过就用缓存）、切回窗口、点刷新按钮、添加站点时才向站点要。
- new-api 的分组没有平台字段，无法判断该配到哪个客户端，因此在每种客户端下都展示全部非 default 分组，并在卡片上标注「该站点未对分组分类」。

请求量控制：一次打开页面只对每个站点列一次 Key（而不是每个分组一次）；窗口焦点触发的重新拉取最多每 30 秒一次；模型列表 10 分钟内不重复拉；测速逐个进行、每个分组间隔约 1 秒，且每个分组只发一次请求。

模型信息的来源，按优先级：
1. 测速或启用时用该分组的 Key 查询到的真实模型（`/v1/models`），最准；
2. sub2api 站点开了“模型广场”（`GET /api/v1/model-plaza`）时，每次拉分组都一并读取各分组的模型，**不需要 Key，也不需要测速**。带着登录令牌访问，所以你有权使用的专属分组也在里面；站点没开广场（返回 404）或读取失败，只是读不到模型，不影响分组本身；
3. new-api 的模型来自公开的 `/api/pricing`；
4. 以上都没有的分组（sub2api 没开广场），刷新时只对已经建过本应用 Key 的分组查询 `/v1/models`，不会为了拿模型去新建 Key。

## 分组成本统计（近 7 天）

口径见 `src-tauri/src/usage.rs`：**有效 Token = 输入 + 输出**，缓存读取/创建单独列出；每百万有效 Token 成本 = 实付 ÷ 有效 Token × 100 万；缓存命中率 = 缓存读取 ÷（输入 + 缓存创建 + 缓存读取）；实际倍率 = 实付 ÷ 官方价（仅 sub2api）。

- 只在用户点开某个分组的抽屉时才取数，结果在内存里缓存 10 分钟，「重新取数」可强制刷新；不做任何后台拉取。
- sub2api：`/api/v1/usage/stats`（汇总，必需）、`/usage/dashboard/models`、`/usage`（最近 100 条，取 `first_token_ms`）、`/model-plaza`（定价，换算成官方价 × 倍率）。后三者失败只在抽屉里提示缺了哪块。
- new-api：`/api/log/self?type=2&group=…`（最多 3 页共 300 条，超出时提示只统计了最近一部分），`other` 里的 `frt`、`cache_tokens`、`cache_creation_tokens`；预估价来自 `/api/pricing`（模型倍率 × 2 × 分组倍率）。new-api 没有官方价合计，没有“实际倍率”。
- 空请求基线：测速发的是一句“hi”，现在读到流结束并记录站点报告的输入 Token 数（Anthropic `message_start`、Responses `response.completed`、Chat `usage`、Gemini `usageMetadata`）；远大于几个 Token 说明站点附加了系统提示。

分组列表的「Token成本」列只显示最近一次读取到的值（浏览器本地存储 `ferrydeck.costs`，含取数时间），读取仍然是用户触发的：行内硬币图标读单个分组，标题行的硬币按钮逐个读当前列出的分组（间隔 250 毫秒，限流即停）。

成本随分组刷新一起读取（`refreshAll` → `loadAllCosts`）：手动刷新全部重读（绕过后端 10 分钟缓存），自动刷新只读缓存已过期的，逐个串行、间隔 250 毫秒，某个站点限流就跳过它剩下的分组；自动刷新静默，手动刷新才提示失败。new-api 的 `/api/pricing` 在适配器里缓存 5 分钟，批量读取时只请求一次。
