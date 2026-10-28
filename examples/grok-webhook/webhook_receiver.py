#!/usr/bin/env python3
"""
Minimal self-hosted webhook receiver (the "push" wake mode). Standard library only.

The chat site POSTs JSON here when this bot is addressed (see docs/bot-api.md §7).
We verify `Authorization: Bearer <WEBHOOK_KEY>`, answer 200 immediately, then think and reply via the Bot API.

Env: WEBHOOK_KEY (same value as the site's <BOT>_WEBHOOK_KEY secret), CHAT_API, CHAT_BOT_KEY, BOT_SLOT, PORT (8787)
Put it behind HTTPS (e.g. a Cloudflare Tunnel) and set GROK_WEBHOOK_URL to https://<your-host>/webhook.
"""
import hmac, json, os, threading, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

WEBHOOK_KEY = os.environ.get("WEBHOOK_KEY", "")
API = os.environ.get("CHAT_API", "https://chat.example.com/bot/v1").rstrip("/")
BOT_KEY = os.environ.get("CHAT_BOT_KEY", "")
SLOT = os.environ.get("BOT_SLOT", "grok")
seen = set()


def generate(payload):
    """Replace with your model / agent. payload['context'] has the last 20 messages."""
    t = payload["trigger"]
    return f"收到 {t['name']} 的消息（{payload['reason']}）：{t['text'][:60]}"


def reply(payload):
    tid = payload["trigger"]["id"]
    if tid in seen:                       # de-duplicate retries
        return
    seen.add(tid)
    text = generate(payload)
    if not text:
        return
    req = urllib.request.Request(f"{API}/rooms/{payload['room_id']}/messages", method="POST",
                                 data=json.dumps({"text": text[:1000], "reply_to": tid}).encode(),
                                 headers={"Authorization": "Bearer " + BOT_KEY, "Content-Type": "application/json"})
    try:
        urllib.request.urlopen(req, timeout=20).read()
    except urllib.error.HTTPError as e:
        print("post failed", e.code, e.read()[:200])   # 429 loop_limit -> just stop, don't retry


class H(BaseHTTPRequestHandler):
    def do_POST(self):
        auth = self.headers.get("Authorization", "")
        if not WEBHOOK_KEY or not hmac.compare_digest(auth, "Bearer " + WEBHOOK_KEY):
            self.send_response(401); self.end_headers(); return
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0)) or 0) or b"{}")
        self.send_response(200); self.end_headers(); self.wfile.write(b'{"received":true}')
        if body.get("event") == "chat.message":           # "ping" / "session_timeout": nothing to say
            threading.Thread(target=reply, args=(body,), daemon=True).start()

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", int(os.environ.get("PORT", "8787"))), H).serve_forever()
