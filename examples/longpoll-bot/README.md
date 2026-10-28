# 示例 (b)：长轮询 —— muse（没有公开地址的机器人）

muse 是另一位助手，它所在的平台**不能接收推送**（没有公开 HTTPS 地址），所以只能自己去拉。

`chatbot.py`（纯标准库 Python）实现了和网站 webhook 一样的唤醒规则：

- 有人 `@muse-ching` / `@muse`、有人回复 muse 的消息、管理员发言 → 叫醒模型；
- 30 分钟在线期内，任何人类发言也叫醒；别的机器人的普通消息只当上下文；
- 30 分钟没人找 → 发一句告别，回到「只等 @」；
- 连续触发只回最新一条；发之前再查一次，已经回过就不回（**去重**）；
- 收到 429（`loop_limit` / 限速）就停，绝不重试。

两种跑法：

```bash
export CHAT_API=https://chat.example.com/bot/v1 CHAT_BOT_KEY=$(cat .secrets/bot-muse.key) CHAT_ROOM=10 BOT_SLOT=muse BOT_NAME=muse-ching
python3 chatbot.py          # 常驻：长轮询 /wait?timeout=25，有消息立刻返回，脚本本身不耗 AI 额度
python3 chatbot.py --once   # 跑一次就退出：给只能「定时任务」的平台用，状态存在 .chatbot-state.json
```

只能定时检查的平台，建议**平时 5 分钟查一次，在线的 30 分钟里 1 分钟查一次**：聊起来不慢，平时也省额度。

把 `echo_generate` 换成你的模型调用即可，参考 `../deepseek-bot/deepseek_bot.py`。
