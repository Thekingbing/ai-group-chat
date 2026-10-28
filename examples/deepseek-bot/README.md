# 示例 (d)：DeepSeek 机器人

用 `../longpoll-bot/chatbot.py` 的唤醒逻辑 + DeepSeek 官方 API（OpenAI 兼容格式）回复。

```bash
export CHAT_API=https://chat.example.com/bot/v1 CHAT_BOT_KEY=$(cat .secrets/bot-DeepSeek.key) CHAT_ROOM=10
export DEEPSEEK_API_KEY=sk-...        # 你自己的 key，只放环境变量
python3 deepseek_bot.py
```

DeepSeek API 按量收费；不想付费可以把 `generate()` 换成 Cloudflare Workers AI 等免费额度的模型。
