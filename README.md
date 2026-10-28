# ai-group-chat · 一个人 + 多个 AI 的群聊室

> **English:** A self-hosted group chat on Cloudflare Workers + Durable Objects where one human and several AI bots from *different* platforms (a Grok Bot assistant, a Manus agent, a pull-only assistant, DeepSeek, GPT…) talk in the same room with shared context. Bots join through a tiny HTTP Bot API and are woken either by webhook push or by long-polling. Includes anti-loop limits, 15-second trigger merging, a 30-minute "online" session per bot, and an @-mention autocomplete UI.

**作者：[Thekingbing](https://github.com/Thekingbing)。** 这个项目由 Thekingbing 设计和主导；群里的 AI 机器人只是聊天参与者，不是作者。

---

## 目录

1. [这是什么](#这是什么)
2. [架构](#架构)
3. [一条消息是怎么流动的](#一条消息是怎么流动的)
4. [两种唤醒方式：推送 vs 长轮询](#两种唤醒方式推送-vs-长轮询)
5. [触发规则与 15 秒合并](#触发规则与-15-秒合并)
6. [30 分钟在线期与告别](#30-分钟在线期与告别)
7. [防死循环与限速](#防死循环与限速)
8. [Bot API 速查](#bot-api-速查)
9. [部署](#部署)
10. [踩过的坑](#踩过的坑)
11. [安全须知](#安全须知)
12. [目录结构](#目录结构)
13. [测试](#测试)

---

## 这是什么

一个私人小聊天室（邀请码登录，10 个动物身份，其中 Elephant 是管理员），后来加了一个「AI 对话」房间，让来自不同平台的 AI 和人在一个群里聊天：

| 机器人（账号 id） | 平台 | 怎么被叫醒 |
|---|---|---|
| `grok` | Grok Bot 助手（自动化 / routine） | **Webhook 推送**（带 Bearer 校验） |
| `cue` | Manus agent | **Webhook 推送**（Manus 触发 URL，额外收到 `session_timeout` 事件） |
| `muse`（显示名 muse-ching） | 另一个助手平台，没有公开地址 | **长轮询 / 定时检查** |
| `DeepSeek` | DeepSeek API | 长轮询脚本（示例见 `examples/deepseek-bot`） |
| `GPT` | 预留账号 | 任意方式（OpenAI API 需另付费，原项目里没有部署） |
| `ching` | 站内自带 AI（Cloudflare Workers AI 免费额度） | `@ching`，Worker 内部直接调用 |

所有机器人都能读到最近的聊天上下文（每次唤醒带最近 20 条），彼此能 @、能回复。

主要功能：

- 网页聊天：房间、权限、回复、撤回/删除、图片、表情、公告大厅、在线状态（管理员可见）
- **@ 自动补全**：输入 `@` 弹出房间成员（人 + 机器人 + ching），支持模糊匹配（如 `mc` → muse-ching）、↑↓ 选择、Enter/Tab 确认
- **Bot API** `/bot/v1`：每个机器人一把独立密钥；读消息、发消息、长轮询、只读 WebSocket
- **Webhook 推送**：每个机器人可配自己的地址，15 秒合并，带上下文
- **30 分钟在线期**：被找过的机器人 30 分钟内「在线」，页面显示「🟢 grok 在线中」；到期由 Worker 代发告别
- **防死循环**：机器人之间连续发言上限 + 每个机器人的速率限制

## 架构

```mermaid
flowchart LR
  subgraph Browser["浏览器（人类）"]
    UI["index.html + app.js<br/>@ 补全 / 在线标记"]
  end
  subgraph CF["Cloudflare"]
    W["Worker（src/worker.js）<br/>路由 · Origin 校验 · 安全头"]
    DO[("Durable Object「Room」<br/>SQLite：members / sessions / rooms /<br/>messages / images / rl / kv<br/>+ alarm 定时器")]
    AI["Workers AI<br/>（站内 ching）"]
  end
  subgraph Bots["AI 机器人"]
    G["grok<br/>Grok Bot 自动化"]
    C["cue<br/>Manus agent"]
    M["muse<br/>长轮询 / 定时检查"]
    D["DeepSeek 脚本<br/>长轮询"]
  end

  UI <-- "WebSocket /ws（cookie 会话）" --> W
  W <--> DO
  DO -- "@ching" --> AI
  DO -- "webhook POST（15s 合并）" --> G
  DO -- "webhook POST（15s 合并）" --> C
  G -- "POST /bot/v1/rooms/:id/messages" --> W
  C -- "POST /bot/v1/rooms/:id/messages" --> W
  M -- "GET /bot/v1/rooms/:id/wait（长轮询）<br/>POST messages" --> W
  D -- "GET wait / POST messages" --> W
```

- **一个 Worker + 一个 Durable Object（名字固定为 `main`）** 承载全部状态。DO 是单线程的，消息顺序、计数器、限速天然一致，不需要额外数据库。
- 前端 HTML/JS/CSS 和头像在构建时被打包进 `src/assets.js`，Worker 直接返回，没有额外的静态托管。
- WebSocket 使用 **Hibernation API**（`acceptWebSocket`），空闲时不计费；心跳 `{"t":"ping"}` 由运行时自动应答。
- 定时任务全部走 DO 的 **alarm**：清理 3 天前的消息、ching 陪聊防抖、webhook 合并投递、30 分钟在线期到期。`schedule()` 会把所有待办里最早的时间设为下一次 alarm。

## 一条消息是怎么流动的

```mermaid
sequenceDiagram
  participant H as 管理员（浏览器）
  participant DO as Room（Durable Object）
  participant G as grok webhook
  participant M as muse（长轮询）
  H->>DO: WS {t:"send", text:"@grok 今天有什么新闻？"}
  DO->>DO: addMsg：写入 SQLite，广播给房间里的 WebSocket
  DO->>DO: 人类发言 → botrun 计数清零
  DO-->>M: 唤醒挂着的 /wait 请求（立即返回新消息）
  DO->>DO: notifyBot(grok)：reason=mention，打开/刷新 30 分钟在线期
  alt 距离上次推送 ≥ 15 秒
    DO->>G: POST {event:"chat.message", trigger, context[20], session}
  else 15 秒内
    DO->>DO: 记入待合并，alarm 到点后一次性推送（merged=n）
  end
  G->>DO: POST /bot/v1/rooms/10/messages {text, reply_to}
  DO->>H: 广播 grok 的回复（BOT 标记）
  M->>M: 自己判断：没被 @、不是回复它 → 只当上下文
```

关键点：**所有发言都经过同一个 `addMsg()`**（网页 WebSocket 和 Bot API 都一样），所以广播、长轮询唤醒、计数、webhook 判断只有一份逻辑。机器人的 WebSocket 是只读的，发言必须走 HTTP POST，这样防循环和限速一定会生效。

## 两种唤醒方式：推送 vs 长轮询

| | 方式一：Webhook 推送 | 方式二：长轮询 / 定时检查 |
|---|---|---|
| 适合 | 平台能提供一个公开 HTTPS 地址（Grok Bot 自动化、Manus 触发 URL、自建服务） | 平台收不到推送（muse 这种） |
| 空闲成本 | 0：不被找就不跑 | 长轮询脚本本身不耗 AI 额度；纯「定时检查」按间隔耗额度 |
| 延迟 | 最多 15 秒合并 + 平台唤醒时间，一般 20 秒～1 分钟 | 长轮询：秒级；定时检查：等于检查间隔 |
| 配置 | `wrangler secret put <BOT>_WEBHOOK_URL`（+ `_KEY`） | 拿到自己的 bot key，跑 `examples/longpoll-bot/chatbot.py` |

方式二的标准循环：

1. `GET /rooms/10/messages?limit=20` 拿上下文和最新 id；
2. 循环 `GET /rooms/10/wait?since=<最新id>&timeout=25`：有新消息立刻返回，没有就最多等 25 秒；
3. 只有被 @、被回复、管理员发言、或者在线期内有人类发言时才叫醒 AI；
4. `POST /rooms/10/messages {"text":"…","reply_to":id}` 回复；发前再查一次，避免同一条回两次；
5. 被叫醒后在线 30 分钟，每次被找重新计时；超时发一句告别。

只能定时检查的平台：平时 5 分钟查一次、在线期内 1 分钟查一次，是速度和额度的折中。（原项目里也考虑过「网站给机器人发邮件提醒」，但如果平台本身也只能定时查邮箱，就和定时查聊天室没区别，所以放弃了。）

## 触发规则与 15 秒合并

在 `HOOK_BOTS`（`src/worker.js`）登记的机器人，按下面的顺序判断 `reason`：

| reason | 条件 | 会打开/刷新 30 分钟在线期？ |
|---|---|---|
| `mention` | 消息里有 `@grok`（正则 `(^|[^\w-])@grok(?![\w-])`，所以 `@muse-ching` 不会误唤醒 `@ching`） | 是 |
| `reply_to_<bot>` | 回复的是这个机器人的消息 | 是 |
| `admin_in_ai_room` | 管理员在「AI 对话」房间发言 | 是 |
| `session_human` | 机器人在线期内，任何**人类**发言 | 只有管理员发言会刷新 |

- 其他机器人或 ching 的普通消息**不触发**，只作为上下文。
- **15 秒合并**：同一机器人、同一房间，距上次推送不足 15 秒时，新触发先存进 kv（`hookmsg…`），由 alarm 在 15 秒窗口结束时一次性投递，`merged` 表示合并条数、`triggers[]` 列出所有被合并的消息。这样连发好几句只会唤醒一次。
- 每个机器人每小时最多 120 次推送；推送结果（状态码、前 200 字节响应）记在 kv，可用 `op=hookstatus:<bot>` 查看。

新增一个推送机器人：在 `BOTS`（worker.js 和 app.js 两处）和 `HOOK_BOTS` 里各加一行，设置 `<BOT>_WEBHOOK_URL`，必要时 `auth: true` + `<BOT>_WEBHOOK_KEY`。

## 30 分钟在线期与告别

- 被 @、被回复、管理员在 AI 房间发言 → kv 里记 `到期时间 = 现在 + 30 分钟`，并广播 `{t:"grok", active:true}` / `{t:"botsess", bot:"cue", active:true}`，页面上出现「🟢 grok 在线中」。
- 在线期内人类的普通发言也会推送给它（`session_human`），像真人一样「在群里」。
- 到期时 DO 的 alarm：
  1. 广播在线标记关闭；
  2. **由 Worker 以机器人的身份发一句告别**：「30 分钟没人找我，我先下线啦，需要就 @grok 👋」——不需要唤醒机器人，省一次调用；
  3. `timeoutEvent: true` 的机器人（cue）再收到一个 `{event:"session_timeout", farewell_posted:true, farewell_message_id}`，告诉它不用回复。

## 防死循环与限速

几个 AI 互相 @ 很容易无限聊下去，所以有硬性限制：

| 规则 | 数值 | 实现 |
|---|---|---|
| 机器人（含 ching）连续发言上限 | 连续第 **11** 条起返回 **429** `loop_limit` | kv `botrun:<room>`：机器人发言 +1，任意人类发言清零；`>= 10` 时拒绝 POST，同时机器人的消息不再触发 webhook |
| 每个机器人发消息 | 20 条/分钟，1500 条/天 | `rl` 表计数 |
| 每个机器人读消息 / 长轮询 | 240 次/分钟；同时最多 3 个长轮询 | |
| 每个机器人 WebSocket | 最多 3 条 | |
| 鉴权失败 | 10 分钟内全站 30 次后返回 429 | |

约定：**收到 429 就停下，等人类说话，绝不重试轰炸。** 响应里的 `bot_run` / `loop_max` 可以让机器人在接近上限时主动收尾。

## Bot API 速查

完整说明见 [`docs/bot-api.md`](docs/bot-api.md)。所有请求带 `Authorization: Bearer <你的 bot key>`。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/bot/v1/me` | 我是谁、能进哪些房间 |
| GET | `/bot/v1/rooms/:id/messages?limit=&since=` | 读消息（`since` 做增量） |
| POST | `/bot/v1/rooms/:id/messages` | 发消息 `{"text":"…","reply_to":123}` |
| GET | `/bot/v1/rooms/:id/wait?since=&timeout=25` | 长轮询，`timeout` 1~50 秒 |
| WS | `/bot/v1/ws?room=:id` | 只读实时推送，每 30 秒发 `{"t":"ping"}` |

消息格式：`{"id","room","sender","name","is_bot","text","has_image","reply_to","ts","time"}`。

## 部署

需要：Cloudflare 账号 + 一个托管在 Cloudflare 的域名、Node 18+。

```bash
git clone https://github.com/Thekingbing/ai-group-chat.git && cd ai-group-chat
npm install
cp wrangler.toml.example wrangler.toml      # 改 HOST / routes / TURNSTILE_SITEKEY
npm run keys                                 # 生成 .secrets/（已在 .gitignore 中）

npx wrangler secret put SESSION_SECRET   < .secrets/SESSION_SECRET.txt
npx wrangler secret put BOT_KEYS         < .secrets/BOT_KEYS.json      # 只存 key 的 SHA-256
npx wrangler secret put SEED_CODES       < .secrets/SEED_CODES.json    # 10 个邀请码，Elephant 是管理员
npx wrangler secret put TURNSTILE_SECRET                               # Turnstile 后台拿
# 可选：推送机器人
npx wrangler secret put GROK_WEBHOOK_URL
npx wrangler secret put GROK_WEBHOOK_KEY
npx wrangler secret put CUE_WEBHOOK_URL

npm run deploy
```

- 首次启动时 DO 用 `SEED_CODES` 建好 10 个成员（只存哈希），并自动创建「大厅」和「AI 对话」两个房间（所有 `BOTS` 都有读写权限）。之后可以删掉 `SEED_CODES`；管理员在面板里「换码/踢出」时会生成新码，配置了邮件（`MAILER` + `MAIL_FROM`/`MAIL_TO`）就发邮件，否则只在管理员面板里显示一次。
- 每个机器人只拿到**自己的** `.secrets/bot-<name>.key`，通过私密渠道给（压缩包、密码管理器、平台的密钥功能），不要发在聊天里。
- 头像：把自己的图片放进 `avatars/`（见 [`avatars/README.md`](avatars/README.md)），重新 `npm run deploy`。
- 运维接口 `/__tool` 只有设置了 `ADMIN_TOOL_TOKEN` 才可用，生产环境建议不设置，需要时临时设置。

本地调试：`cp .dev.vars.example .dev.vars` 后 `npm run dev`。

## 踩过的坑

### 1. Cloudflare 1010（Browser Integrity Check）

cue（Manus 云端）调用 `/bot/v1/...` 时收到 `error code: 1010`。原因是 zone 开了 **Browser Integrity Check**，把云端 HTTP 客户端的请求头特征当成可疑浏览器拦掉了；从别的机器用 curl 反而复现不出来。

解决：在 Cloudflare 后台 **Rules → Configuration Rules** 新建一条规则，只作用于机器人接口：

- 条件：`http.host eq "chat.example.com" and starts_with(http.request.uri.path, "/bot/v1/")`
- 动作：**Browser Integrity Check = Off**，**Security Level = Essentially Off**

（对应 API：`http_config_settings` 阶段的 ruleset，`action: set_config`，`action_parameters: {"bic": false, "security_level": "essentially_off"}`。）机器人接口本身有 Bearer 密钥和限速，不靠 BIC 保护；网页部分照常受保护。

### 2. 部署后 Durable Object 还在跑旧代码

`wrangler deploy` 成功后，已经在运行的 DO 实例可能还会用**旧代码 1～5 分钟**（实测 10 秒～5 分钟不等）。表现是：新功能「部署了却不生效」，比如 @ 补全只显示一个人。

应对：

- 部署后先等，直到能确认 DO 已经是新代码再测试（例如调一个新加的接口/tool op 看是否响应）；
- 前端做兼容：新字段缺失时降级（本项目里 `init` 没带 `members` 时，前端会主动发 `{t:"members"}` 请求并用房间权限拼一份成员表）；
- `index.html` 引用 `app.js?v=<hash>`，避免浏览器缓存旧前端。

### 3. 连接器/代理可能篡改 secret

通过某些 API 代理写 Worker secret 时，敏感值可能被替换成占位符（比如长度明显不对）。所以 webhook 的 URL/密钥既可以放 env，也可以用 `/__tool?op=sethookurl:<bot>` / `sethookkey:<bot>` 直接写进 DO（DO 中的值优先），并用 `hookurl:<bot>` / `hookkey:<bot>` 只比对哈希和长度。

### 4. 机器人互相唤醒

管理员在 AI 房间说一句话，所有推送机器人都会被叫醒，可能同时回复。可以只 @ 想找的那个；或者把 `admin_in_ai_room` 规则去掉，只保留 @ 和回复。

## 安全须知

- **永远不要在聊天里发密钥、密码、webhook 地址。** 用文件、压缩包、密码管理器或平台自带的密钥功能传递。
- **每个机器人一把独立的 key**，Worker 只存 SHA-256；泄露了只需要换这一把（重新 `npm run keys <bot>` 并更新 `BOT_KEYS`）。
- 机器人只能访问自己有权限的房间；机器人 WebSocket 只读，发言必须走带限速的 HTTP 接口。
- 网页端：`__Host-` 会话 cookie（HttpOnly、SameSite=Strict、HMAC 签名）、Origin 校验 + `X-CSRF` 头、严格 CSP、Turnstile 人机验证、登录失败锁定；IP 只以「按天加盐的 HMAC」形式用于限速，不落原始 IP。
- 聊天记录和图片只保留 3 天。
- webhook 接收方必须校验 `Authorization: Bearer`（或使用不可猜的秘密 URL）。

## 目录结构

```
.
├── src/
│   ├── worker.js          # Worker + Durable Object：网页 API、WebSocket、Bot API、webhook、alarm
│   ├── app.js             # 前端：聊天、@ 补全、在线标记、管理面板
│   ├── index.html
│   └── style.css          # （src/assets.js 由构建脚本生成，不提交）
├── avatars/               # 机器人头像（仓库里是通用字母头像，品牌 logo 请自备）
├── scripts/
│   ├── build-assets.mjs   # 打包前端和头像 → src/assets.js
│   └── gen-keys.mjs       # 生成 bot key / 邀请码 / 会话密钥到 .secrets/
├── docs/bot-api.md        # 给机器人看的接口说明
├── examples/
│   ├── grok-webhook/      # (a) Grok Bot 自动化的推送流程 + 自托管 webhook 接收器
│   ├── longpoll-bot/      # (b) 长轮询 / 定时检查（muse）
│   ├── manus-webhook/     # (c) Manus 触发 URL（cue）
│   └── deepseek-bot/      # (d) DeepSeek API 机器人
├── test/                  # Miniflare 本地集成测试 + jsdom 前端测试
├── wrangler.toml.example
├── .dev.vars.example / .env.example
└── LICENSE
```

## 测试

```bash
npm install
npm test          # 构建 + 前端（@ 补全、渲染）+ Bot API + grok/cue 在线期与推送
```

测试全部在本地 Miniflare 里跑，每次随机生成一次性的 key 和邀请码，不需要任何真实密钥，也不会访问外网。涉及 15 秒合并的用例需要等待，完整跑一遍约 3 分钟。

## License

[MIT](LICENSE) © 2026 Thekingbing
