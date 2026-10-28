#!/usr/bin/env python3
"""
Long-poll bot runner for the chat site's Bot API (/bot/v1) — for bots WITHOUT a public webhook URL
(this is how "muse" joins the room). Python 3.9+, standard library only.

Wake rules (same as the site's webhook rules):
  * someone writes @<BOT_NAME> (or @<BOT_SLOT>)
  * someone replies to one of this bot's messages
  * the admin speaks in the room
  * while this bot's 30-minute "online" session is active: any human message
Other bots' plain messages are only context. 30 min without being addressed -> short farewell, back to "wait for @".

Env: CHAT_API, CHAT_BOT_KEY, CHAT_ROOM, BOT_SLOT, BOT_NAME, ADMIN_SLOT (default Elephant)

Usage:
  python3 chatbot.py              # run forever (long-poll, ~instant)
  python3 chatbot.py --once       # one check then exit (for cron / scheduled tasks), state in .chatbot-state.json
Plug your model in by passing generate=... to run(), see ../deepseek-bot/deepseek_bot.py.
"""
import json, os, re, sys, time, urllib.request, urllib.error

API = os.environ.get("CHAT_API", "https://chat.example.com/bot/v1").rstrip("/")
KEY = os.environ.get("CHAT_BOT_KEY", "")
ROOM = int(os.environ.get("CHAT_ROOM", "10"))
SLOT = os.environ.get("BOT_SLOT", "muse")
NAME = os.environ.get("BOT_NAME", SLOT)
ADMIN = os.environ.get("ADMIN_SLOT", "Elephant")
SESSION_S = 30 * 60
STATE = os.environ.get("STATE_FILE", ".chatbot-state.json")
BYE = f"30 分钟没人找我，我先下线啦，需要就 @{NAME} 👋"


class Stop(Exception):
    """429 loop_limit / rate limit: stop and wait for a human. Never retry-bomb."""


def call(method, path, body=None, timeout=40):
    req = urllib.request.Request(API + path, method=method,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Authorization": "Bearer " + KEY, "Content-Type": "application/json",
                                          "User-Agent": "chat-longpoll-bot/1"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        try:
            j = json.load(e)
        except Exception:
            j = {"error": str(e)}
        if e.code == 429:
            raise Stop(j.get("error", "429"))
        raise RuntimeError(f"{e.code} {j}")


def mention_re(*names):
    alts = "|".join(re.escape(n) for n in names if n)
    return re.compile(rf"(^|[^\w-])@({alts})(?![\w-])", re.I)


AT_ME = mention_re(NAME, SLOT)


def load_state():
    try:
        return json.load(open(STATE))
    except Exception:
        return {"since": 0, "until": 0, "mine": [], "answered": []}


def save_state(st):
    st["mine"] = st["mine"][-200:]; st["answered"] = st["answered"][-200:]
    json.dump(st, open(STATE, "w"))


def wake_reason(m, st, now):
    if m["sender"] == SLOT:
        return None
    if AT_ME.search(m.get("text") or ""):
        return "mention"
    if m.get("reply_to") and m["reply_to"] in st["mine"]:
        return "reply_to_me"
    if m["sender"] == ADMIN:
        return "admin"
    if st["until"] > now and not m.get("is_bot"):
        return "session_human"
    return None


def post(st, text, reply_to=None):
    # dedupe guard: never answer the same trigger twice (matters for --once / cron runs that overlap)
    if reply_to and reply_to in st["answered"]:
        return None
    r = call("POST", f"/rooms/{ROOM}/messages", {"text": text[:1000], "reply_to": reply_to})
    st["mine"].append(r["id"])
    if reply_to:
        st["answered"].append(reply_to)
    st["since"] = max(st["since"], r["id"])
    return r


def handle(batch, st, generate):
    now = time.time()
    trig = [(m, wake_reason(m, st, now)) for m in batch]
    trig = [(m, r) for m, r in trig if r]
    for m in batch:
        if m["sender"] == SLOT:
            st["mine"].append(m["id"])
    if not trig:
        return
    m, reason = trig[-1]                      # answer the latest trigger once (merge bursts)
    st["until"] = now + SESSION_S             # open / refresh the 30-min online window
    ctx = call("GET", f"/rooms/{ROOM}/messages?limit=20")["messages"]
    if ctx and ctx[-1]["id"] != m["id"] and ctx[-1]["sender"] == SLOT:
        return                                # someone (maybe us in another run) already answered after it
    text = generate(ctx, m, reason)
    if text:
        time.sleep(2)                         # leave a gap so bots don't talk over each other
        post(st, text, m["id"])


def check_timeout(st):
    if st["until"] and st["until"] <= time.time():
        st["until"] = 0
        try:
            post(st, BYE)
        except Stop:
            pass


def echo_generate(ctx, msg, reason):
    """Placeholder model: replace with a real LLM call."""
    return f"收到（{reason}）：{(msg.get('text') or '')[:60]}"


def run(generate=echo_generate, once=False):
    if not KEY:
        sys.exit("CHAT_BOT_KEY is not set")
    st = load_state()
    if not st["since"]:                       # start from "now": don't answer old history
        last = call("GET", f"/rooms/{ROOM}/messages?limit=1")
        st["since"] = last.get("last_id", 0)
    while True:
        try:
            r = call("GET", f"/rooms/{ROOM}/wait?since={st['since']}&timeout={1 if once else 25}", timeout=60)
            batch = r.get("messages", [])
            if batch:
                st["since"] = r["last_id"]
                handle(batch, st, generate)
            check_timeout(st)
        except Stop as e:
            print("stopped by server limit:", e, "- waiting for a human", file=sys.stderr)
            if once:
                break
            time.sleep(60)
        except Exception as e:
            print("error:", e, file=sys.stderr)
            if once:
                break
            time.sleep(5)
        finally:
            save_state(st)
        if once:
            break


if __name__ == "__main__":
    run(once="--once" in sys.argv)
