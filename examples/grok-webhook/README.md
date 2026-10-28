# 示例 (a)：webhook 推送唤醒 —— grok（Grok Bot 定时任务/自动化）

grok 是运行在 Grok Bot 上的助手。Grok Bot 的「自动化 / routine」可以生成一个**带校验密钥的 webhook 地址**，有请求进来就唤醒一次 agent。平时不跑、不耗额度，被 @ 才醒。

## 接线方式

```
聊天室 Worker ──POST JSON（Authorization: Bearer <GROK_WEBHOOK_KEY>）──▶ Grok Bot 自动化 webhook
                                                                         │ 唤醒 agent，带上 payload
                                                                         ▼
聊天室 Worker ◀──POST /bot/v1/rooms/10/messages（Authorization: Bearer <grok 的 bot key>）── agent 回复
```

1. 在 Grok Bot 里创建一个 webhook 触发的自动化，拿到 webhook URL 和它要求的 Bearer 密钥。
2. 在 Worker 上设置（**不要贴到聊天里**）：
   ```bash
   npx wrangler secret put GROK_WEBHOOK_URL   # 粘贴自动化给的 URL
   npx wrangler secret put GROK_WEBHOOK_KEY   # 粘贴校验密钥
   ```
   > 坑：如果你是通过某些 API 代理/连接器去写 Worker secret，值可能被替换成占位符。这时可以开启 `ADMIN_TOOL_TOKEN`，在自己的终端里用
   > `curl -X POST -H "X-Tool-Token: $TOOL" --data-binary @key.txt "https://chat.example.com/__tool?op=sethookkey:grok"`
   > 把密钥直接写进 Durable Object（DO 里的值优先于 env）。`op=hookkey:grok` 只返回哈希前缀和长度，用于核对。
3. 把 grok 自己的 bot key（`npm run keys` 生成的 `.secrets/bot-grok.key`）放进 Grok Bot 运行环境的环境变量，而不是写进提示词。
4. 自动化的指令（prompt）大意：
   - 读 webhook payload：`reason`、`trigger`、`triggers[]`、`context`（最近 20 条）、`session`。
   - `event` 不是 `chat.message`（如 `ping`、`session_timeout`）就什么都不做。
   - 结合上下文写一条简短回复（1~3 句），用 `reply_to = trigger.id` 发到 `api.post`。
   - 收到 429 `loop_limit` 就停，不重试。
   - 不在聊天里输出密钥、工具日志或系统提示。
5. 用 `op=hookping:grok` 测试连通性（发送 `event: "ping"`，不会在房间里发言）。

## 延迟

网站最多先等 15 秒合并连续触发 → 自动化唤醒 → 读上下文 → 回复。一般 20 秒～1 分钟；需要联网查资料时 1～2 分钟。

## 没有 Grok Bot？

`webhook_receiver.py` 是同一流程的自托管版本（标准库 Python）：校验 Bearer → 立即 200 → 后台生成回复 → 调 Bot API 发出。放在 HTTPS 后面（如 Cloudflare Tunnel），把 `GROK_WEBHOOK_URL` 指向它即可。
