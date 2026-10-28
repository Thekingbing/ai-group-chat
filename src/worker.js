// ai-group-chat — Cloudflare Worker + Durable Object for a human + multi-AI-bot group chat.
// Copyright (c) 2026 Thekingbing. MIT License. See README.md for the architecture.
import { DurableObject } from "cloudflare:workers";
import { EmailMessage } from "cloudflare:email";
import { INDEX_HTML, APP_JS, STYLE_CSS, AVATARS, AVATAR_BIN } from "./assets.js";

// Public hostname of the chat site. Set via the HOST var in wrangler.toml (default for local tests).
let HOST = "chat.example.com";
let ORIGIN = "https://" + HOST;
function useEnv(env) { if (env && env.HOST && env.HOST !== HOST) { HOST = String(env.HOST); ORIGIN = "https://" + HOST; } }
const ANIMALS = [
  ["Elephant","象"],["Lion","狮"],["Tiger","虎"],["Leopard","豹"],["Wolf","狼"],
  ["Dog","狗"],["Cat","猫"],["Mouse","鼠"],["Chicken","鸡"],["Duck","鸭"]];
const ADMIN = "Elephant";   // the admin slot (site owner). Any animal slot works; change here and in app.js.
// external AI bots (HTTP API, no invite code). slot -> display name. Keep in sync with BOTS in app.js.
const BOTS = { grok: "grok", muse: "muse-ching", GPT: "GPT", DeepSeek: "DeepSeek", cue: "cue" };
const isBot = s => Object.prototype.hasOwnProperty.call(BOTS, s);
const isHumanSlot = s => ANIMALS.some(a => a[0] === s);
const MEMBER_OK = s => isHumanSlot(s) || isBot(s);
const BOT_LOOP_MAX = 10;          // consecutive bot/ching msgs without a human
// bots with an outgoing webhook + 30-min session window.
//   auth: true  -> the site sends "Authorization: Bearer <key>" (key from env <BOT>_WEBHOOK_KEY or DO kv cfg:hookkey.<bot>)
//   auth: false -> no auth header (e.g. Manus trigger URLs, which are secret URLs themselves)
//   timeoutEvent: also POST {event:"session_timeout"} when the 30-min window expires
// URL comes from env <BOT>_WEBHOOK_URL (e.g. GROK_WEBHOOK_URL) or DO kv cfg:hookurl.<bot> (set via the admin tool).
const HOOK_BOTS = {
  grok: { re: /(^|[^\w-])@grok(?![\w-])/i, sess: "grok:", pend: "hook:", pmsg: "hookmsg:", last: "hooklast:", status: "hookstatus", rl: "webhook-global", auth: true, timeoutEvent: false },
  cue: { re: /(^|[^\w-])@cue(?![\w-])/i, sess: "sess.cue:", pend: "hook.cue:", pmsg: "hookmsg.cue:", last: "hooklast.cue:", status: "hookstatus.cue", rl: "webhook-global.cue", auth: false, timeoutEvent: true },
};
const GROK_SESSION_MS = 30 * 60e3;   // grok conversation window per room
const GROK_BYE = "30 分钟没人找我，我先下线啦，需要就 @grok 👋";
const BOT_BYE = b => `30 分钟没人找我，我先下线啦，需要就 @${b} 👋`;
const RETENTION_MS = 3 * 24 * 3600 * 1000;
const AI_MODEL = "@cf/zai-org/glm-4.7-flash";
const NEURON_IN = 5500 / 1e6, NEURON_OUT = 36400 / 1e6;
const DAILY_NEURON_CAP = 7000;          // free tier is 10,000/day; keep margin
const AI_PER_USER_PER_HOUR = 30;
const MAX_TEXT = 1000, MAX_IMG = 1024 * 1024;
const SESSION_TTL = 14 * 24 * 3600 * 1000;

const secHeaders = () => ({
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Content-Security-Policy": "default-src 'none'; script-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; connect-src 'self' wss://" + HOST + "; img-src 'self' blob: data:; style-src 'self'; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "Cache-Control": "no-store",
});
function resp(body, status = 200, type = "application/json; charset=utf-8", extra = {}) {
  return new Response(body, { status, headers: { ...secHeaders(), "Content-Type": type, ...extra } });
}
const json = (o, s = 200, extra) => resp(JSON.stringify(o), s, undefined, extra);

async function sha256hex(s) {
  const d = await crypto.subtle.digest("SHA-256", typeof s === "string" ? new TextEncoder().encode(s) : s);
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, "0")).join("");
}
async function hmac(key, msg) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const s = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg));
  return [...new Uint8Array(s)].map(b => b.toString(16).padStart(2, "0")).join("");
}
function randHex(n) { const a = new Uint8Array(n); crypto.getRandomValues(a); return [...a].map(b => b.toString(16).padStart(2, "0")).join(""); }
function newCode() {
  const al = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; const a = new Uint8Array(16); crypto.getRandomValues(a);
  let s = ""; for (let i = 0; i < 16; i++) { s += al[a[i] % al.length]; if (i % 4 === 3 && i < 15) s += "-"; } return s;
}
const normCode = c => String(c || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
function getCookie(req, name) {
  const c = req.headers.get("Cookie") || ""; for (const p of c.split(/;\s*/)) { const i = p.indexOf("="); if (p.slice(0, i) === name) return p.slice(i + 1); } return null;
}
function b64utf8(s) { const b = new TextEncoder().encode(s); let x = ""; for (const c of b) x += String.fromCharCode(c); return btoa(x); }

export default {
  async fetch(req, env, ctx) {
    useEnv(env);
    const url = new URL(req.url);
    if (url.hostname !== HOST) return resp("Not found", 404, "text/plain");
    const p = url.pathname;
    if (req.method === "GET") {
      if (p === "/" || p === "/index.html") return resp(INDEX_HTML.replace("__SITEKEY__", env.TURNSTILE_SITEKEY), 200, "text/html; charset=utf-8");
      if (p === "/app.js") return resp(APP_JS, 200, "application/javascript; charset=utf-8", { "Cache-Control": "no-cache" });
      if (p === "/style.css") return resp(STYLE_CSS, 200, "text/css; charset=utf-8", { "Cache-Control": "no-cache" });
      if (p === "/robots.txt") return resp("User-agent: *\nDisallow: /\n", 200, "text/plain");
      // avatars: /avatar/<slot>(.svg) -> a user-supplied bitmap (avatars/<slot>.webp|png|jpg) wins, else the SVG
      const m = p.match(/^\/avatar\/([A-Za-z]+)(?:\.(?:svg|webp|png|jpg))?$/);
      if (m && AVATAR_BIN[m[1]]) { const [mime, b64] = AVATAR_BIN[m[1]]; const bin = Uint8Array.from(atob(b64), c => c.charCodeAt(0)); return new Response(bin, { headers: { ...secHeaders(), "Content-Type": mime, "Cache-Control": "public, max-age=86400", "Content-Security-Policy": "default-src 'none'; sandbox" } }); }
      if (m && AVATARS[m[1]]) return resp(AVATARS[m[1]], 200, "image/svg+xml", { "Cache-Control": "public, max-age=86400", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'" });
    }
    if (p === "/__tool" && req.method === "POST") {
      const stub = env.ROOM.get(env.ROOM.idFromName("main"));
      const op = url.searchParams.get("op");
      const r = await stub.adminTool(op, req.headers.get("X-Tool-Token"), ((op || "").startsWith("sethookkey:") || (op || "").startsWith("sethookurl:")) ? (await req.text()).trim().slice(0, 500) : undefined);
      return json({ r });
    }
    if (p.startsWith("/bot/v1/")) {
      // bot API: Bearer key auth (no cookies, no Origin check)
      const stub = env.ROOM.get(env.ROOM.idFromName("main"));
      const h = new Headers(req.headers);
      h.delete("Cookie"); h.delete("CF-Connecting-IP"); h.delete("X-Forwarded-For"); h.delete("X-Real-IP");
      return stub.fetch(new Request(req, { headers: h }));
    }
    if (p.startsWith("/api/") || p === "/ws" || p.startsWith("/img/")) {
      // CSRF / origin checks for state-changing requests and WS
      if (req.method !== "GET" || p === "/ws") {
        if (req.headers.get("Origin") !== ORIGIN) return json({ error: "bad origin" }, 403);
      }
      const stub = env.ROOM.get(env.ROOM.idFromName("main"));
      const h = new Headers(req.headers);
      // only pass a salted, daily-rotating IP hash (never raw IP) for rate-limiting
      const ip = req.headers.get("CF-Connecting-IP") || "0";
      const day = new Date().toISOString().slice(0, 10);
      h.set("X-IPH", (await hmac(env.SESSION_SECRET, "ip:" + day + ":" + ip)).slice(0, 32));
      h.delete("CF-Connecting-IP"); h.delete("X-Forwarded-For"); h.delete("X-Real-IP");
      return stub.fetch(new Request(req, { headers: h }));
    }
    return resp("Not found", 404, "text/plain");
  },
};

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    useEnv(env);
    this.env = env; this.sql = ctx.storage.sql;
    this.typing = new Map();
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"t":"ping"}', '{"t":"pong"}'));
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(`CREATE TABLE IF NOT EXISTS members(slot TEXT PRIMARY KEY, code_hash TEXT, muted_until INTEGER DEFAULT 0, gen INTEGER DEFAULT 1);
        CREATE TABLE IF NOT EXISTS sessions(h TEXT PRIMARY KEY, slot TEXT, gen INTEGER, exp INTEGER);
        CREATE TABLE IF NOT EXISTS rooms(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, perms TEXT);
        CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY AUTOINCREMENT, room INTEGER, slot TEXT, text TEXT, img TEXT, reply INTEGER, ts INTEGER);
        CREATE TABLE IF NOT EXISTS images(id TEXT PRIMARY KEY, room INTEGER, mime TEXT, data BLOB, ts INTEGER);
        CREATE TABLE IF NOT EXISTS rl(k TEXT PRIMARY KEY, n INTEGER, reset INTEGER, lock INTEGER DEFAULT 0);
        CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT);`);
      const n = this.sql.exec("SELECT COUNT(*) c FROM members").one().c;
      if (n === 0 && this.env.SEED_CODES) {
        const codes = JSON.parse(this.env.SEED_CODES);
        for (const [a] of ANIMALS) this.sql.exec("INSERT INTO members(slot, code_hash) VALUES(?,?)", a, await sha256hex(normCode(codes[a])));
      }
      try { this.sql.exec("ALTER TABLE messages ADD COLUMN del TEXT DEFAULT ''"); } catch { }
      try { this.sql.exec("ALTER TABLE messages ADD COLUMN edited INTEGER DEFAULT 0"); } catch { }
      try { this.sql.exec("ALTER TABLE messages ADD COLUMN pinned INTEGER DEFAULT 0"); } catch { }
      // 大厅: deleted announcements are hard-removed
      for (const r of this.sql.exec("SELECT id, img FROM messages WHERE room=1 AND del<>''").toArray()) { if (r.img) this.sql.exec("DELETE FROM images WHERE id=?", r.img); this.sql.exec("DELETE FROM messages WHERE id=?", r.id); }
      if (this.sql.exec("SELECT COUNT(*) c FROM rooms").one().c === 0)
        this.sql.exec("INSERT INTO rooms(id,name,perms) VALUES(1,'大厅',?)", JSON.stringify(Object.fromEntries(ANIMALS.map(a => [a[0], "rw"]))));
      // the 「AI 对话」 room: every bot in BOTS can read/write. Bots added later: grant them in the admin panel.
      if (!this.kvGet("airoom")) {
        const rid = this.sql.exec("INSERT INTO rooms(name,perms) VALUES(?,?) RETURNING id", "AI 对话", JSON.stringify(Object.fromEntries(Object.keys(BOTS).map(b => [b, "rw"])))).one().id;
        this.kvSet("airoom", rid);
      }
      if (!(await ctx.storage.getAlarm())) await ctx.storage.setAlarm(Date.now() + 3600 * 1000);
    });
    this.waiters = new Map();   // room -> Set(resolve) for bot long-poll
  }
  kvGet(k) { const r = this.sql.exec("SELECT v FROM kv WHERE k=?", k).toArray(); return r.length ? r[0].v : null; }
  kvSet(k, v) { this.sql.exec("INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", k, String(v)); }

  // returns true if allowed. window ms, max hits
  hit(key, max, windowMs) {
    const now = Date.now();
    const r = this.sql.exec("SELECT n, reset, lock FROM rl WHERE k=?", key).toArray()[0];
    if (!r || r.reset < now) { this.sql.exec("INSERT OR REPLACE INTO rl(k,n,reset,lock) VALUES(?,?,?,0)", key, 1, now + windowMs); return true; }
    if (r.n >= max) return false;
    this.sql.exec("UPDATE rl SET n=n+1 WHERE k=?", key); return true;
  }
  locked(key) { const r = this.sql.exec("SELECT lock FROM rl WHERE k=?", key).toArray()[0]; return r && r.lock > Date.now() ? r.lock : 0; }
  lock(key, ms) { this.sql.exec("INSERT INTO rl(k,n,reset,lock) VALUES(?,0,?,?) ON CONFLICT(k) DO UPDATE SET lock=excluded.lock", key, Date.now() + ms, Date.now() + ms); }

  async session(req) {
    const c = getCookie(req, "__Host-sid"); if (!c) return null;
    const [tok, sig] = c.split(".");
    if (!tok || !sig || (await hmac(this.env.SESSION_SECRET, tok)) !== sig) return null;
    const r = this.sql.exec("SELECT s.slot, s.gen, s.exp, m.gen mg FROM sessions s JOIN members m ON m.slot=s.slot WHERE s.h=?", await sha256hex(tok)).toArray()[0];
    if (!r || r.exp < Date.now() || r.gen !== r.mg) return null;
    return r.slot;
  }

  async fetch(req) {
    const url = new URL(req.url), p = url.pathname, iph = req.headers.get("X-IPH") || "x";
    if (p.startsWith("/bot/v1/")) return this.botApi(req, url);
    if (p === "/api/login" && req.method === "POST") return this.login(req, iph);
    if (p === "/api/logout" && req.method === "POST") {
      const c = getCookie(req, "__Host-sid"); if (c) this.sql.exec("DELETE FROM sessions WHERE h=?", await sha256hex(c.split(".")[0]));
      return json({ ok: true }, 200, { "Set-Cookie": "__Host-sid=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0" });
    }
    const slot = await this.session(req);
    if (!slot) return json({ error: "unauthorized" }, 401);
    if (p === "/api/remember" && req.method === "POST") {
      if (req.headers.get("X-CSRF") !== "1") return json({ error: "csrf" }, 403);
      const b = await req.json().catch(() => ({})); const days = [0, 7, 15, 30].includes(+b.days) ? +b.days : 0;
      const c = getCookie(req, "__Host-sid"); const tok = c.split(".")[0];
      const exp = Date.now() + (days ? days * 86400e3 : 24 * 3600e3);
      this.sql.exec("UPDATE sessions SET exp=? WHERE h=?", exp, await sha256hex(tok));
      return json({ ok: true, days }, 200, { "Set-Cookie": `__Host-sid=${c}; Path=/; Secure; HttpOnly; SameSite=Strict` + (days ? `; Max-Age=${days * 86400}` : "") });
    }
    if (p === "/api/me") return json({ slot, admin: slot === ADMIN, animals: ANIMALS });
    if (p === "/ws") {
      if (req.headers.get("Upgrade") !== "websocket") return json({ error: "ws" }, 426);
      if (this.ctx.getWebSockets(slot).length >= 3) return json({ error: "too many connections" }, 429);
      let room = parseInt(url.searchParams.get("room")) || 0;
      const list = this.roomsFor(slot);
      if (room && !this.perm(slot, room)) room = 0;   // silent fallback
      if (!room) room = list.length ? list[0].id : 0;
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1], [slot]);
      pair[1].serializeAttachment({ slot, room, at: Date.now() });
      pair[1].send(JSON.stringify({ t: "rooms", rooms: list }));
      if (room) this.sendInit(pair[1], slot, room); else pair[1].send('{"t":"noroom"}');
      this.broadcastPresence();
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    if (p === "/api/upload" && req.method === "POST") return this.upload(req, slot, parseInt(url.searchParams.get("room")) || 0);
    if (p.startsWith("/img/") && req.method === "GET") {
      const id = p.slice(5); if (!/^[a-f0-9]{32}$/.test(id)) return json({ error: "nf" }, 404);
      const r = this.sql.exec("SELECT room, mime, data FROM images WHERE id=?", id).toArray()[0];
      if (r && slot !== ADMIN && this.sql.exec("SELECT 1 FROM messages WHERE img=? AND del<>''", id).toArray().length) return json({ error: "nf" }, 404);
      if (!r || !this.perm(slot, r.room)) return json({ error: "nf" }, 404);
      return new Response(r.data, { headers: { ...secHeaders(), "Content-Type": r.mime, "Cache-Control": "private, max-age=259200", "Content-Security-Policy": "default-src 'none'; sandbox" } });
    }
    if (p === "/api/admin" && req.method === "POST") {
      if (slot !== ADMIN) return json({ error: "forbidden" }, 403);
      if (req.headers.get("X-CSRF") !== "1") return json({ error: "csrf" }, 403);
      return this.admin(await req.json().catch(() => ({})));
    }
    return json({ error: "not found" }, 404);
  }

  async login(req, iph) {
    if (req.headers.get("X-CSRF") !== "1") return json({ error: "csrf" }, 403);
    const body = await req.json().catch(() => ({}));
    const key = "login:" + iph;
    const lk = this.locked(key);
    if (lk) return json({ error: "尝试次数过多，请 " + Math.ceil((lk - Date.now()) / 60000) + " 分钟后再试" }, 429);
    if (!this.hit("login-global", 200, 3600 * 1000)) return json({ error: "系统繁忙，请稍后再试" }, 429);
    let human = false;
    if (body.turnstile) {
      const fd = new FormData(); fd.append("secret", this.env.TURNSTILE_SECRET); fd.append("response", String(body.turnstile).slice(0, 2048));
      try {
        const r = await (await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: fd })).json();
        if (r.success && r.hostname === HOST) human = true; else return json({ error: "人机验证失败，请刷新重试" }, 403);
      } catch { /* siteverify unreachable: fall through to strict mode */ }
    }
    // fallback (Turnstile not loaded): stricter limits
    const max = human ? 5 : 3, win = human ? 15 * 60e3 : 60 * 60e3;
    if (!human && !this.hit("login-fallback", 30, 3600 * 1000)) return json({ error: "请完成人机验证后再试" }, 429);
    const code = normCode(body.code);
    const h = code.length === 16 ? await sha256hex(code) : "";
    const m = h ? this.sql.exec("SELECT slot, gen FROM members WHERE code_hash=?", h).toArray()[0] : null;
    if (!m) {
      if (!this.hit("fail:" + key, max, win)) { this.lock(key, win); }
      return json({ error: "邀请码无效" }, 401);
    }
    const tok = randHex(32);
    this.sql.exec("INSERT INTO sessions(h,slot,gen,exp) VALUES(?,?,?,?)", await sha256hex(tok), m.slot, m.gen, Date.now() + 24 * 3600e3);
    // session-only cookie by default (no Max-Age); user may extend via /api/remember
    const cookie = `__Host-sid=${tok}.${await hmac(this.env.SESSION_SECRET, tok)}; Path=/; Secure; HttpOnly; SameSite=Strict`;
    return json({ ok: true, slot: m.slot }, 200, { "Set-Cookie": cookie });
  }

  async upload(req, slot, room) {
    if (this.perm(slot, room) !== "rw") return json({ error: "没有该房间的发言权限" }, 403);
    if (req.headers.get("X-CSRF") !== "1") return json({ error: "csrf" }, 403);
    if (!this.hit("up:" + slot, 40, 24 * 3600e3) || !this.hit("up-global", 300, 24 * 3600e3)) return json({ error: "今天上传图片太多了" }, 429);
    if (this.isMuted(slot)) return json({ error: "你被禁言了" }, 403);
    const len = +req.headers.get("Content-Length") || 0; if (len > MAX_IMG) return json({ error: "图片太大（最大 1MB）" }, 413);
    const buf = new Uint8Array(await req.arrayBuffer()); if (buf.length > MAX_IMG || buf.length < 12) return json({ error: "图片太大或无效" }, 413);
    let mime = null;
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) mime = "image/jpeg";
    else if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) mime = "image/png";
    else if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) mime = "image/gif";
    else if (String.fromCharCode(...buf.slice(0, 4)) === "RIFF" && String.fromCharCode(...buf.slice(8, 12)) === "WEBP") mime = "image/webp";
    if (!mime) return json({ error: "只能发送图片（JPG/PNG/GIF/WebP）" }, 415);
    const id = randHex(16);
    this.sql.exec("INSERT INTO images(id,room,mime,data,ts) VALUES(?,?,?,?,?)", id, room, mime, buf.buffer, Date.now());
    return json({ id });
  }

  perm(slot, room) {
    const r = this.sql.exec("SELECT perms FROM rooms WHERE id=?", +room || 0).toArray()[0];
    if (!r) return "";
    if (slot === ADMIN) return "rw";
    const v = (JSON.parse(r.perms || "{}")[slot]) || "";
    return (+room === 1 && v) ? "r" : v;   // 大厅: announcements only
  }
  roomPerm(slot, r) {
    if (slot === ADMIN) return "rw";
    const v = JSON.parse(r.perms || "{}")[slot] || "";
    return (r.id === 1 && v) ? "r" : v;
  }
  roomsFor(slot) {
    return this.sql.exec("SELECT id, name, perms FROM rooms ORDER BY id").toArray()
      .map(r => ({ id: r.id, name: r.name, perm: this.roomPerm(slot, r), perms: slot === ADMIN ? JSON.parse(r.perms || "{}") : undefined }))
      .filter(r => r.perm);
  }
  broadcastRoom(room, obj) {
    const s = JSON.stringify(obj);
    for (const ws of this.ctx.getWebSockets()) { const a = ws.deserializeAttachment(); if (a && a.room === room && this.perm(a.slot, room)) try { ws.send(s); } catch { } }
  }
  // after room/perm changes: refresh lists, evict sockets that lost access
  resyncRooms() {
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment(); if (!a) continue;
      if (a.bot) { if (!this.perm(a.slot, a.room)) try { ws.close(4003, "removed from room"); } catch { } continue; }
      const list = this.roomsFor(a.slot);
      try { ws.send(JSON.stringify({ t: "rooms", rooms: list })); } catch { }
      if (this.perm(a.slot, a.room)) { try { ws.send(JSON.stringify({ t: "members", room: a.room, members: this.roomMembers(a.room) })); } catch { } }
      else {
        a.room = list.length ? list[0].id : 0; ws.serializeAttachment(a);
        if (a.room) this.sendInit(ws, a.slot, a.room); else try { ws.send('{"t":"noroom"}'); } catch { }
      }
    }
  }
  isMuted(slot) { const r = this.sql.exec("SELECT muted_until FROM members WHERE slot=?", slot).toArray()[0]; return r && r.muted_until > Date.now() ? r.muted_until : 0; }
  // live sockets only: heartbeat (auto-response ping) within 75s, else drop as stale
  liveSockets(skip) {
    const now = Date.now(), out = [];
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === skip || ws.readyState > 1) continue;
      const a = ws.deserializeAttachment(); if (!a) continue;
      const hb = this.ctx.getWebSocketAutoResponseTimestamp(ws);
      const last = Math.max(a.at || 0, hb ? hb.getTime() : 0);
      if (now - last > 75000) { try { ws.close(4000, "stale"); } catch { } this.kvSet("seen:" + a.slot, last); continue; }
      out.push([ws, a, last]);
    }
    return out;
  }
  online() { return [...new Set(this.liveSockets().map(x => x[1].slot))]; }
  broadcast(obj) { const s = JSON.stringify(obj); for (const ws of this.ctx.getWebSockets()) { try { ws.send(s); } catch { } } }
  presenceData(skip) {
    const mutes = {}; for (const r of this.sql.exec("SELECT slot, muted_until FROM members WHERE muted_until>?", Date.now())) mutes[r.slot] = r.muted_until;
    const live = this.liveSockets(skip), users = {};
    const rn = Object.fromEntries(this.sql.exec("SELECT id, name FROM rooms").toArray().map(r => [r.id, r.name]));
    for (const [a] of ANIMALS) users[a] = { online: false, seen: +(this.kvGet("seen:" + a) || 0) || null, room: null };
    for (const a of Object.keys(BOTS)) { const sn = +(this.kvGet("seen:" + a) || 0) || null; users[a] = { online: !!sn && Date.now() - sn < 90e3, seen: sn, room: null, bot: true }; }
    for (const [, a, last] of live) { const u = users[a.slot]; if (!u) continue; u.online = true; u.seen = Math.max(u.seen || 0, last); u.room = rn[a.room] || null; }
    return { t: "presence", users, mutes };
  }
  // roster/presence goes to the admin only
  broadcastPresence(skip) {
    const admins = this.ctx.getWebSockets(ADMIN).filter(w => w !== skip); if (!admins.length) return;
    const s = JSON.stringify(this.presenceData(skip)); for (const ws of admins) try { ws.send(s); } catch { }
  }
  rowToMsg(r, viewer) {
    if (r.del && viewer !== ADMIN) {
      if (r.del === "recalled" && r.slot === viewer) return { t: "msg", id: r.id, room: r.room, slot: r.slot, del: "recalled", ts: r.ts };
      return null;
    }
    return { t: "msg", id: r.id, room: r.room, slot: r.slot, text: r.text, img: r.img, reply: r.reply, ts: r.ts, del: r.del || "", edited: r.edited || 0, pinned: r.pinned || 0 };
  }
  pinAll() { }
  pin() {
    const r = this.sql.exec("SELECT id, text, ts, edited FROM messages WHERE room=1 AND slot=? AND del='' AND text<>'' AND ts>? ORDER BY id DESC LIMIT 1", ADMIN, Date.now() - RETENTION_MS).toArray()[0];
    return r ? { id: r.id, text: r.text, ts: r.ts, edited: r.edited || 0 } : null;
  }
  // slots in a room (for @-mention autocomplete): admin + perm holders
  roomMembers(room) {
    const r = this.sql.exec("SELECT perms FROM rooms WHERE id=?", +room || 0).toArray()[0]; if (!r) return [];
    const ps = JSON.parse(r.perms || "{}");
    return [ADMIN, ...Object.keys(ps).filter(k => MEMBER_OK(k) && ps[k] && k !== ADMIN)];
  }
  sendInit(ws, slot, room) {
    const rows = this.sql.exec("SELECT * FROM messages WHERE room=? AND ts>? AND (id IN (SELECT id FROM messages WHERE room=? ORDER BY id DESC LIMIT 150) OR pinned>0) ORDER BY id", room, Date.now() - RETENTION_MS, room).toArray();
    ws.send(JSON.stringify({ t: "init", room, perm: this.perm(slot, room), me: slot, admin: slot === ADMIN, history: rows.map(r => this.rowToMsg(r, slot)).filter(Boolean), members: this.roomMembers(room), ching: this.isActive(room), grok: this.grokActive(room), sess: Object.fromEntries(Object.keys(HOOK_BOTS).map(b => [b, this.botActive(b, room)])), quota: this.quota() }));
  }
  today() { return new Date().toISOString().slice(0, 10); }
  quota() { const used = +(this.kvGet("neurons:" + this.today()) || 0); return { used: Math.round(used), cap: DAILY_NEURON_CAP }; }
  addMsg(room, slot, text, img, reply) {
    const ts = Date.now();
    const id = this.sql.exec("INSERT INTO messages(room,slot,text,img,reply,ts) VALUES(?,?,?,?,?,?) RETURNING id", room, slot, text, img, reply, ts).one().id;
    this.broadcastRoom(room, { t: "msg", id, room, slot, text, img, reply, ts, del: "" });
    if (room === 1 && slot === ADMIN) this.pinAll();
    if (isHumanSlot(slot)) this.sql.exec("DELETE FROM kv WHERE k=?", "botrun:" + room);
    else if (isBot(slot) || slot === "ching") this.kvSet("botrun:" + room, this.botRun(room) + 1);
    const ws = this.waiters && this.waiters.get(room);
    if (ws) { this.waiters.delete(room); for (const f of ws) try { f(); } catch { } }
    try { this.notify(room, { id, slot, text, img, reply, ts }); } catch { }
    return id;
  }

  async webSocketMessage(ws, data) {
    const a = ws.deserializeAttachment(); if (!a) return ws.close(1008, "auth");
    const slot = a.slot;
    if (a.bot) return;   // bot sockets are receive-only (post via HTTP so loop limits apply)
    // re-validate membership generation (kicked users)
    if (typeof data !== "string" || data.length > 4000) return;
    let m; try { m = JSON.parse(data); } catch { return; }
    if (m.t === "ping") return ws.send('{"t":"pong"}');
    if (m.t === "presence") { if (slot === ADMIN) ws.send(JSON.stringify(this.presenceData())); return; }
    if (m.t === "join") {
      const room = parseInt(m.room) || 0;
      if (!this.perm(slot, room)) return ws.send('{"t":"err","msg":"没有该房间的权限"}');
      a.room = room; a.at = Date.now(); ws.serializeAttachment(a); this.sendInit(ws, slot, room); return this.broadcastPresence();
    }
    const room = a.room;
    if (!room || !this.perm(slot, room)) return ws.send('{"t":"err","msg":"没有该房间的权限"}');
    if (m.t === "members") return ws.send(JSON.stringify({ t: "members", room, members: this.roomMembers(room) }));
    if (m.t === "pin") {
      if (slot !== ADMIN) return ws.send('{"t":"err","msg":"只有管理员能置顶公告"}');
      const r = this.sql.exec("SELECT * FROM messages WHERE id=? AND room=1 AND del=''", parseInt(m.id) || 0).toArray()[0];
      if (!r) return;
      r.pinned = m.on ? Date.now() : 0;
      this.sql.exec("UPDATE messages SET pinned=? WHERE id=?", r.pinned, r.id);
      for (const w of this.ctx.getWebSockets()) { const b = w.deserializeAttachment(); if (b && b.room === 1 && this.perm(b.slot, 1)) try { w.send(JSON.stringify({ t: "upd", msg: this.rowToMsg(r, b.slot) })); } catch { } }
      return;
    }
    if (m.t === "edit") {
      if (slot !== ADMIN) return ws.send('{"t":"err","msg":"只有管理员能修改公告"}');
      const r = this.sql.exec("SELECT * FROM messages WHERE id=? AND room=1 AND del=''", parseInt(m.id) || 0).toArray()[0];
      const text = String(m.text || "").slice(0, MAX_TEXT).trim();
      if (!r || !text) return;
      r.text = text; r.edited = Date.now();
      this.sql.exec("UPDATE messages SET text=?, edited=? WHERE id=?", text, r.edited, r.id);
      for (const w of this.ctx.getWebSockets()) { const b = w.deserializeAttachment(); if (b && b.room === 1 && this.perm(b.slot, 1)) try { w.send(JSON.stringify({ t: "upd", msg: this.rowToMsg(r, b.slot) })); } catch { } }
      this.pinAll(); return;
    }
    if (m.t === "delete" || m.t === "recall") {
      const r = this.sql.exec("SELECT * FROM messages WHERE id=?", parseInt(m.id) || 0).toArray()[0];
      if (!r || r.del) return;
      if (m.t === "delete" && slot !== ADMIN) return ws.send('{"t":"err","msg":"只有管理员能删除消息"}');
      if (m.t === "recall" && r.slot !== slot) return ws.send('{"t":"err","msg":"只能撤回自己的消息"}');
      if (r.room === 1) {   // hard delete in 大厅
        if (r.img) this.sql.exec("DELETE FROM images WHERE id=?", r.img);
        this.sql.exec("DELETE FROM messages WHERE id=?", r.id);
        const g = JSON.stringify({ t: "gone", id: r.id });
        for (const w of this.ctx.getWebSockets()) { const b = w.deserializeAttachment(); if (b && b.room === 1) try { w.send(g); } catch { } }
        this.pinAll(); return;
      }
      const del = m.t === "delete" ? "deleted" : "recalled";
      this.sql.exec("UPDATE messages SET del=? WHERE id=?", del, r.id); r.del = del;
      for (const w of this.ctx.getWebSockets()) {
        const b = w.deserializeAttachment(); if (!b || b.room !== r.room || !this.perm(b.slot, r.room)) continue;
        const v = this.rowToMsg(r, b.slot);
        try { w.send(JSON.stringify(v ? { t: "upd", msg: v } : { t: "gone", id: r.id })); } catch { }
      }
      if (r.room === 1) this.pinAll();
      return;
    }
    if (m.t === "typing") {
      if (!this.hit("ty:" + slot, 20, 60e3)) return;
      const s = JSON.stringify({ t: "typing", slot }); for (const w of this.ctx.getWebSockets()) { const b = w.deserializeAttachment(); if (w !== ws && b && b.room === room) try { w.send(s); } catch { } }
      return;
    }
    if (m.t === "send") {
      const mu = this.isMuted(slot); if (mu) return ws.send(JSON.stringify({ t: "err", msg: "你被禁言到 " + new Date(mu).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }) }));
      if (this.perm(slot, room) !== "rw") return ws.send(JSON.stringify({ t: "err", msg: room === 1 ? "大厅仅管理员可发公告" : "这个房间你只能看，不能发言" }));
      if (!this.hit("msg:" + slot, 30, 60e3) || !this.hit("msg-day:" + slot, 2000, 24 * 3600e3)) return ws.send('{"t":"err","msg":"发太快啦，歇一会儿"}');
      const text = String(m.text || "").slice(0, MAX_TEXT).trim();
      let img = m.img ? String(m.img) : null;
      if (img && (!/^[a-f0-9]{32}$/.test(img) || !this.sql.exec("SELECT 1 FROM images WHERE id=? AND room=?", img, room).toArray().length)) img = null;
      if (!text && !img) return;
      const reply = Number.isInteger(m.reply) && m.reply > 0 ? m.reply : null;
      this.addMsg(room, slot, text, img, reply);
      await this.onHuman(room, slot, text);
    }
  }

  // ---- ching conversation mode ----
  idleMs() { return +(this.kvGet("idle_ms") || 600000); }
  isActive(room) { return !!this.kvGet("active:" + room); }
  setActive(room, on) {
    if (on) this.kvSet("active:" + room, Date.now()); else { this.sql.exec("DELETE FROM kv WHERE k=? OR k=?", "active:" + room, "due:" + room); }
    this.broadcastRoom(room, { t: "ching", room, active: on });
  }
  async schedule() {
    let next = +(this.kvGet("purgeAt") || 0);
    if (!next || next < Date.now()) { next = Date.now() + 3600e3; this.kvSet("purgeAt", next); }
    const idle = this.idleMs();
    for (const r of this.sql.exec("SELECT k, v FROM kv WHERE k LIKE 'active:%' OR k LIKE 'due:%' OR k LIKE 'hook:%' OR k LIKE 'grok:%' OR k LIKE 'sess.%' OR k LIKE 'hook.%'").toArray())
      next = Math.min(next, r.k.startsWith("active:") ? +r.v + idle : +r.v);
    await this.ctx.storage.setAlarm(Math.max(next, Date.now() + 200));
  }
  async onHuman(room, slot, text) {
    if (room === 1) return;
    const at = /(^|[^\w-])@ching(?![\w-])/i.test(text);
    if (at && /(?:^|[^\w-])@ching\s*[，,!！~～]*\s*(再见|拜拜|bye|退下|下线|走吧)/i.test(text)) {
      if (this.isActive(room)) { this.broadcastRoom(room, { t: "toast", room, text: "好嘛好嘛，那 ching 先溜啦～有事再 @我！(｀へ´)" }); this.setActive(room, false); }
      return this.schedule();
    }
    if (at) {
      this.sql.exec("DELETE FROM kv WHERE k=?", "due:" + room);
      if (!this.isActive(room)) this.setActive(room, true); else this.kvSet("active:" + room, Date.now());
      await this.schedule();
      await this.ching(room, slot, false);
      return;
    }
    if (this.isActive(room)) {
      this.kvSet("active:" + room, Date.now());
      this.kvSet("due:" + room, Date.now() + 4000);   // debounce bursts
      await this.schedule();
    }
  }
  async ching(room, slot, auto) {
    const day = this.today();
    const used = +(this.kvGet("neurons:" + day) || 0);
    if (used >= DAILY_NEURON_CAP - 60) { this.addMsg(room, "ching", "今天的免费额度用完啦，明天早上8点见", null, null); if (this.isActive(room)) this.setActive(room, false); return; }
    if (!auto && !this.hit("ai:" + slot, AI_PER_USER_PER_HOUR, 3600e3)) return this.addMsg(room, "ching", "哼，你@我太多次啦，让我歇一会儿嘛（每小时最多 " + AI_PER_USER_PER_HOUR + " 次）", null, null);
    if (auto && !this.hit("ai-auto:" + room, 60, 3600e3)) return;
    if (!this.hit("ai-global-min", 8, 60e3)) { if (!auto) this.addMsg(room, "ching", "等、等一下啦，我一下子回不过来 (＞﹏＜)", null, null); return; }
    this.broadcastRoom(room, { t: "typing", slot: "ching" });
    const rows = this.sql.exec("SELECT slot, text, img FROM messages WHERE room=? AND del='' AND ts>? ORDER BY id DESC LIMIT 18", room, Date.now() - RETENTION_MS).toArray().reverse();
    const msgs = [{ role: "system", content: PERSONA + (auto ? AUTO_RULE : "") }];
    for (const r of rows) {
      const t = (r.text || "") + (r.img ? "［发了一张图片，你看不到图片内容］" : "");
      if (r.slot === "ching") msgs.push({ role: "assistant", content: t.slice(0, 400) });
      else if (isBot(r.slot)) msgs.push({ role: "user", content: `${BOTS[r.slot]}(AI机器人)说：${t.slice(0, 400)}` });
      else if (r.slot !== "system") msgs.push({ role: "user", content: `${r.slot}(${zh(r.slot)})说：${t.slice(0, 400)}` });
    }
    let reply = "", inT = 0, outT = 0;
    try {
      const r = await this.env.AI.run(AI_MODEL, { messages: msgs, max_tokens: 400, temperature: 1.0, chat_template_kwargs: { enable_thinking: false } });
      reply = (r?.choices?.[0]?.message?.content ?? r?.response ?? "").toString();
      inT = r?.usage?.prompt_tokens ?? 1500; outT = r?.usage?.completion_tokens ?? 400;
    } catch (e) {
      inT = 1500; outT = 0; reply = auto ? "[SKIP]" : "呜呜，我脑子卡住了，等会儿再@我嘛";
    }
    const cost = inT * NEURON_IN + outT * NEURON_OUT;
    this.kvSet("neurons:" + day, +(this.kvGet("neurons:" + day) || 0) + cost);
    reply = reply.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/^ching[:：]\s*/i, "").trim().slice(0, 800);
    if (/\[SKIP\]/i.test(reply) || (auto && !reply)) { this.broadcastRoom(room, { t: "typing", slot: "" }); this.broadcast({ t: "quota", quota: this.quota() }); return; }
    this.addMsg(room, "ching", reply || "哼，不知道说什么了啦～", null, null);
    this.broadcast({ t: "quota", quota: this.quota() });
  }

  // ---- external bots ----
  botRun(room) { return +(this.kvGet("botrun:" + room) || 0); }
  async botAuth(req) {
    const m = (req.headers.get("Authorization") || "").match(/^Bearer\s+([A-Za-z0-9_\-]{20,200})$/);
    if (!m || !this.env.BOT_KEYS) return null;
    let map; try { map = JSON.parse(this.env.BOT_KEYS); } catch { return null; }
    const h = await sha256hex(m[1]);
    for (const [slot, kh] of Object.entries(map)) if (isBot(slot) && kh === h) return slot;
    return null;
  }
  botMsg(r) {
    return { id: r.id, room: r.room, sender: r.slot, name: isBot(r.slot) ? BOTS[r.slot] : (r.slot === "ching" ? "ching" : r.slot + "(" + zh(r.slot) + ")"), is_bot: isBot(r.slot) || r.slot === "ching", text: r.text || "", has_image: !!r.img, reply_to: r.reply || null, ts: r.ts, time: new Date(r.ts).toISOString() };
  }
  botRows(room, since, limit) {
    const cut = Date.now() - RETENTION_MS;
    const rows = since > 0
      ? this.sql.exec("SELECT * FROM messages WHERE room=? AND del='' AND ts>? AND id>? ORDER BY id LIMIT ?", room, cut, since, limit).toArray()
      : this.sql.exec("SELECT * FROM messages WHERE room=? AND del='' AND ts>? ORDER BY id DESC LIMIT ?", room, cut, limit).toArray().reverse();
    return rows.filter(r => r.slot !== "system").map(r => this.botMsg(r));
  }
  async botApi(req, url) {
    const bj = (o, s = 200) => json(o, s);
    const slot = await this.botAuth(req);
    if (!slot) {
      if (!this.hit("botauthfail", 30, 600e3)) return bj({ error: "too many failed auth" }, 429);
      return bj({ error: "unauthorized" }, 401);
    }
    this.kvSet("seen:" + slot, Date.now());
    const p = url.pathname.slice(7);   // after /bot/v1
    if (p === "/ws") {
      // hibernatable WebSocket for real-time push (same events as the web client: {t:"msg",...})
      if (req.headers.get("Upgrade") !== "websocket") return bj({ error: "expected websocket upgrade" }, 426);
      const room = parseInt(url.searchParams.get("room")) || 0;
      if (!this.perm(slot, room)) return bj({ error: "forbidden: not a member of this room" }, 403);
      if (this.ctx.getWebSockets(slot).length >= 3) return bj({ error: "too many connections" }, 429);
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1], [slot]);
      pair[1].serializeAttachment({ slot, room, at: Date.now(), bot: true });
      pair[1].send(JSON.stringify({ t: "hello", bot: slot, room, last: this.botRows(room, 0, 20), bot_run: this.botRun(room), loop_max: BOT_LOOP_MAX }));
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    if (p === "/me" && req.method === "GET")
      return bj({ bot: slot, name: BOTS[slot], rooms: this.roomsFor(slot).map(r => ({ id: r.id, name: r.name, perm: r.perm })), loop_max: BOT_LOOP_MAX });
    const m = p.match(/^\/rooms\/(\d+)\/(messages|wait)$/);
    if (!m) return bj({ error: "not found" }, 404);
    const room = +m[1], perm = this.perm(slot, room);
    if (!perm) return bj({ error: "forbidden: not a member of this room" }, 403);
    const rname = this.sql.exec("SELECT name FROM rooms WHERE id=?", room).one().name;
    if (req.method === "GET") {
      if (!this.hit("botread:" + slot, 240, 60e3)) return bj({ error: "rate limited (reads)" }, 429);
      const since = Math.max(0, parseInt(url.searchParams.get("since")) || 0);
      const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit")) || 50, 1), 200);
      if (m[2] === "wait") {
        let msgs = this.botRows(room, since, limit);
        if (!msgs.length) {
          const tmo = Math.min(Math.max(parseInt(url.searchParams.get("timeout")) || 25, 1), 50) * 1000;
          const k = "botwait:" + slot; const cur = (this.waitCount = this.waitCount || {});
          if ((cur[k] || 0) >= 3) return bj({ error: "too many concurrent waits" }, 429);
          cur[k] = (cur[k] || 0) + 1;
          try {
            await new Promise(res => {
              let set = this.waiters.get(room); if (!set) this.waiters.set(room, set = new Set());
              const t = setTimeout(() => { set.delete(done); res(); }, tmo);
              function done() { clearTimeout(t); res(); }
              set.add(done);
            });
          } finally { cur[k]--; }
          msgs = this.botRows(room, since, limit);
        }
        return bj({ room, room_name: rname, messages: msgs, last_id: msgs.length ? msgs[msgs.length - 1].id : since, bot_run: this.botRun(room), loop_max: BOT_LOOP_MAX });
      }
      const msgs = this.botRows(room, since, limit);
      return bj({ room, room_name: rname, messages: msgs, last_id: msgs.length ? msgs[msgs.length - 1].id : since, bot_run: this.botRun(room), loop_max: BOT_LOOP_MAX });
    }
    if (req.method === "POST" && m[2] === "messages") {
      if (perm !== "rw") return bj({ error: "forbidden: read-only in this room" }, 403);
      const run = this.botRun(room);
      if (run >= BOT_LOOP_MAX) return json({ error: "loop_limit", message: `机器人之间已连续发言 ${run} 条，请等待人类发言后再继续`, bot_run: run, loop_max: BOT_LOOP_MAX }, 429, { "Retry-After": "60" });
      if (!this.hit("botmsg:" + slot, 20, 60e3) || !this.hit("botmsg-day:" + slot, 1500, 24 * 3600e3)) return bj({ error: "rate limited (posts)" }, 429);
      const b = await req.json().catch(() => null);
      if (!b || typeof b !== "object") return bj({ error: "body must be JSON {text, reply_to?}" }, 400);
      const text = String(b.text || "").slice(0, MAX_TEXT).trim();
      if (!text) return bj({ error: "empty text" }, 400);
      let reply = parseInt(b.reply_to ?? b.reply) || null;
      if (reply && !this.sql.exec("SELECT 1 FROM messages WHERE id=? AND room=? AND del=''", reply, room).toArray().length) reply = null;
      const id = this.addMsg(room, slot, text, null, reply);
      await this.onHuman(room, slot, text);
      return bj({ ok: true, id, room, bot_run: this.botRun(room), loop_max: BOT_LOOP_MAX });
    }
    return bj({ error: "method not allowed" }, 405);
  }
  // ---- outgoing webhooks + 30-min session windows (per bot in HOOK_BOTS) ----
  botExp(bot, room) { return +(this.kvGet(HOOK_BOTS[bot].sess + room) || 0); }
  botActive(bot, room) { return this.botExp(bot, room) > Date.now(); }
  botSession(bot, room) { const e = this.botExp(bot, room); return { active: e > Date.now(), expires_at: e ? new Date(e).toISOString() : null, expires_ts: e || null }; }
  botSessEvent(bot, room, active) { this.broadcastRoom(room, bot === "grok" ? { t: "grok", room, active } : { t: "botsess", bot, room, active }); }
  botTouch(bot, room) {
    const was = this.botActive(bot, room);
    this.kvSet(HOOK_BOTS[bot].sess + room, Date.now() + GROK_SESSION_MS);
    if (!was) this.botSessEvent(bot, room, true);
    this.schedule().catch(() => { });
  }
  grokExp(room) { return this.botExp("grok", room); }
  grokActive(room) { return this.botActive("grok", room); }
  grokSession(room) { return this.botSession("grok", room); }
  // webhook target: DO kv (set at runtime via admin tool) overrides env secrets <BOT>_WEBHOOK_URL / <BOT>_WEBHOOK_KEY
  hookTarget(bot) {
    const E = bot.toUpperCase();
    return { url: this.kvGet("cfg:hookurl." + bot) || this.env[E + "_WEBHOOK_URL"] || null,
      key: HOOK_BOTS[bot].auth ? (this.kvGet("cfg:hookkey." + bot) || this.env[E + "_WEBHOOK_KEY"] || null) : null };
  }
  hookReady(bot) { const t = this.hookTarget(bot); return !!t.url && (!HOOK_BOTS[bot].auth || !!t.key); }
  notify(room, msg) {
    for (const bot of Object.keys(HOOK_BOTS)) { try { this.notifyBot(bot, room, msg); } catch { } }
  }
  notifyBot(bot, room, msg) {
    const H = HOOK_BOTS[bot];
    if (msg.slot === bot || msg.slot === "system" || room === 1) return;
    if (!this.perm(bot, room)) return;
    const mentioned = H.re.test(msg.text || "");
    const adminAi = msg.slot === ADMIN && +(this.kvGet("airoom") || 0) === room;
    let replyBot = false;
    if (msg.reply) { const rr = this.sql.exec("SELECT slot FROM messages WHERE id=? AND room=?", msg.reply, room).toArray()[0]; replyBot = !!rr && rr.slot === bot; }
    const active = this.botActive(bot, room);
    const humanInSession = active && isHumanSlot(msg.slot);
    const reason = mentioned ? "mention" : replyBot ? "reply_to_" + bot : adminAi ? "admin_in_ai_room" : humanInSession ? "session_human" : null;
    if (!reason) return;
    if (!isHumanSlot(msg.slot) && this.botRun(room) >= BOT_LOOP_MAX) return;
    // talking to the bot opens / refreshes its 30-min window (@bot, reply to bot, the admin speaking)
    if (mentioned || replyBot || adminAi || (active && msg.slot === ADMIN)) this.botTouch(bot, room);
    if (!this.hookReady(bot)) return;
    const m = { ...msg, reason };
    const now = Date.now(), last = +(this.kvGet(H.last + room) || 0);
    if (now - last >= 15000 && !this.kvGet(H.pend + room)) { this.kvSet(H.last + room, now); const hp = this.sendHook(room, m, 1, bot).catch(() => { }); try { this.ctx.waitUntil(hp); } catch { } return; }
    // coalesce: one delivery per bot per room per 15s, carrying the latest trigger + all merged triggers
    const pend = JSON.parse(this.kvGet(H.pmsg + room) || "null");
    const trig = ((pend && pend.trigs) || []).concat([{ id: msg.id, reason }]).slice(-20);
    this.kvSet(H.pmsg + room, JSON.stringify({ msg: m, n: (pend ? pend.n : 0) + 1, trigs: trig }));
    if (!this.kvGet(H.pend + room)) { this.kvSet(H.pend + room, Math.max(last + 15000, now + 500)); this.schedule().catch(() => { }); }
  }
  async postHook(bot, room, payload, msgId) {
    const H = HOOK_BOTS[bot], { url, key } = this.hookTarget(bot);
    if (!url || (H.auth && !key)) return;
    if (!this.hit(H.rl, 120, 3600e3)) return;
    const body = JSON.stringify(payload);
    const headers = { "Content-Type": "application/json", "User-Agent": "ching-chat-webhook/1" };
    if (H.auth) headers.Authorization = "Bearer " + key;
    try { const r = await fetch(url, { method: "POST", headers, body }); let tx = ""; try { tx = (await r.text()).slice(0, 200); } catch { } this.kvSet(H.status, JSON.stringify({ ts: Date.now(), room, event: payload.event, msg: msgId, status: r.status, body: tx, bytes: body.length })); return r.status; }
    catch (e) { this.kvSet(H.status, JSON.stringify({ ts: Date.now(), room, event: payload.event, msg: msgId, error: String(e && e.message || e).slice(0, 120) })); }
  }
  async sendHook(room, msg, merged, bot = "grok", trigs = null) {
    if (!this.hookReady(bot)) return;
    if (!this.sql.exec("SELECT 1 FROM rooms WHERE id=?", room).toArray().length) return;
    const rname = this.sql.exec("SELECT name FROM rooms WHERE id=?", room).one().name;
    const ctxRows = this.botRows(room, 0, 20);
    const ids = new Set((trigs || [{ id: msg.id }]).map(t => t.id));
    const triggers = ctxRows.filter(r => ids.has(r.id));
    const tmsg = this.botMsg({ ...msg, room });
    if (!triggers.some(t => t.id === tmsg.id)) triggers.push(tmsg);
    const payload = { event: "chat.message", bot, reason: msg.reason, merged, room, room_id: room, room_name: rname,
      session: { ...this.botSession(bot, room), reason: msg.reason },
      trigger: { id: msg.id, text: msg.text || "", sender: msg.slot, name: tmsg.name, reply_to: msg.reply || null },
      triggers, message: tmsg, sender: msg.slot, context: ctxRows, bot_run: this.botRun(room), loop_max: BOT_LOOP_MAX,
      api: { read: `${ORIGIN}/bot/v1/rooms/${room}/messages`, post: `${ORIGIN}/bot/v1/rooms/${room}/messages` } };
    return this.postHook(bot, room, payload, msg.id);
  }
  async sendTimeout(bot, room, byeId) {
    if (!this.hookReady(bot)) return;
    const rname = this.sql.exec("SELECT name FROM rooms WHERE id=?", room).one().name;
    return this.postHook(bot, room, { event: "session_timeout", bot, room, room_id: room, room_name: rname,
      session: { active: false, expired_at: new Date().toISOString(), reason: "idle_30min" },
      farewell_posted: true, farewell_message_id: byeId || null,
      note: "Your 30-minute session in this room expired. The site already posted a short farewell as you; no reply is needed. You will be woken again by @" + bot + ", a reply to your message, or the admin (" + ADMIN + ") speaking in the AI room.",
      context: this.botRows(room, 0, 20), api: { read: `${ORIGIN}/bot/v1/rooms/${room}/messages`, post: `${ORIGIN}/bot/v1/rooms/${room}/messages` } }, byeId);
  }

  async admin(b) {
    if (String(b.action || "").startsWith("room_")) {
      const id = parseInt(b.room) || 0, nm = String(b.name || "").trim().slice(0, 20);
      if (b.action === "room_create") {
        if (!nm) return json({ error: "请输入房间名" }, 400);
        if (this.sql.exec("SELECT COUNT(*) c FROM rooms").one().c >= 20) return json({ error: "最多 20 个房间" }, 400);
        const perms = {}; if (b.perms && typeof b.perms === "object") for (const [k, v] of Object.entries(b.perms)) if (MEMBER_OK(k) && (v === "rw" || v === "r")) perms[k] = v;
        const rid = this.sql.exec("INSERT INTO rooms(name,perms) VALUES(?,?) RETURNING id", nm, JSON.stringify(perms)).one().id;
        this.resyncRooms(); return json({ ok: true, id: rid });
      }
      if (!this.sql.exec("SELECT 1 FROM rooms WHERE id=?", id).toArray().length) return json({ error: "房间不存在" }, 400);
      if (b.action === "room_rename") { if (!nm) return json({ error: "请输入房间名" }, 400); this.sql.exec("UPDATE rooms SET name=? WHERE id=?", nm, id); }
      else if (b.action === "room_delete") {
        if (id === 1) return json({ error: "默认房间不能删除" }, 400);
        this.sql.exec("DELETE FROM rooms WHERE id=?", id); this.sql.exec("DELETE FROM messages WHERE room=?", id); this.sql.exec("DELETE FROM images WHERE room=?", id);
      } else if (b.action === "room_perms") {
        const perms = {}; if (b.perms && typeof b.perms === "object") for (const [k, v] of Object.entries(b.perms)) if (MEMBER_OK(k) && (v === "rw" || v === "r")) perms[k] = v;
        this.sql.exec("UPDATE rooms SET perms=? WHERE id=?", JSON.stringify(perms), id);
      } else return json({ error: "bad action" }, 400);
      this.resyncRooms(); return json({ ok: true });
    }
    const target = String(b.slot || "");
    if (!ANIMALS.some(x => x[0] === target)) return json({ error: "no such user" }, 400);
    if (b.action === "mute") {
      if (target === ADMIN) return json({ error: "不能禁言自己" }, 400);
      const mins = Math.min(Math.max(parseInt(b.minutes) || 10, 1), 60 * 24 * 30);
      this.sql.exec("UPDATE members SET muted_until=? WHERE slot=?", Date.now() + mins * 60e3, target);
      this.addMsg(1, "system", `${target} 被管理员禁言 ${mins} 分钟`, null, null); this.broadcastPresence(); return json({ ok: true });
    }
    if (b.action === "unmute") {
      this.sql.exec("UPDATE members SET muted_until=0 WHERE slot=?", target);
      this.addMsg(1, "system", `${target} 已解除禁言`, null, null); this.broadcastPresence(); return json({ ok: true });
    }
    if (b.action === "kick" || b.action === "regen") {
      if (b.action === "kick" && target === ADMIN) return json({ error: "不能踢自己" }, 400);
      const code = newCode();
      this.sql.exec("UPDATE members SET code_hash=?, gen=gen+1, muted_until=0 WHERE slot=?", await sha256hex(normCode(code)), target);
      this.sql.exec("DELETE FROM sessions WHERE slot=?", target);
      for (const ws of this.ctx.getWebSockets(target)) { try { ws.send(JSON.stringify({ t: "kicked" })); ws.close(4001, "kicked"); } catch { } }
      if (b.action === "kick") this.addMsg(1, "system", `${target} 被管理员移出群聊`, null, null);
      this.broadcastPresence();
      const sent = await this.mail(`【ching 聊天室】${target}(${zh(target)}) 的新邀请码`,
        `${target}(${zh(target)}) 的邀请码已${b.action === "kick" ? "因踢出而注销" : "被重新生成"}，旧码立即失效。\n\n新邀请码：${code}\n\n登录地址：${ORIGIN}\n\n请只把它发给对应的人。`);
      // if email is not configured/failed, hand the new code to the admin once in the response (shown in the admin panel)
      return json(sent === true ? { ok: true, emailed: true } : { ok: true, emailed: sent, code });
    }
    return json({ error: "bad action" }, 400);
  }

  // optional: email new invite codes to the admin. Needs a send_email binding MAILER + vars MAIL_FROM / MAIL_TO.
  async mail(subject, text) {
    const MAIL_FROM = this.env.MAIL_FROM, MAIL_TO = this.env.MAIL_TO;
    if (!this.env.MAILER || !MAIL_FROM || !MAIL_TO) return "mail not configured";
    try {
      const mid = `<${randHex(12)}@${String(MAIL_FROM).split("@")[1] || "localhost"}>`;
      const raw = [`From: Ching Chat <${MAIL_FROM}>`, `To: ${MAIL_TO}`, `Subject: =?UTF-8?B?${b64utf8(subject)}?=`, `Message-ID: ${mid}`,
        `Date: ${new Date().toUTCString()}`, "MIME-Version: 1.0", "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "",
        b64utf8(text).replace(/(.{76})/g, "$1\r\n")].join("\r\n");
      await this.env.MAILER.send(new EmailMessage(MAIL_FROM, MAIL_TO, raw));
      return true;
    } catch (e) { return String(e && e.message || e).slice(0, 200); }
  }

  async webSocketClose(ws) { const a = ws.deserializeAttachment(); if (a) this.kvSet("seen:" + a.slot, Date.now()); try { ws.close(); } catch { } this.broadcastPresence(ws); }
  async webSocketError(ws) { this.broadcastPresence(ws); }

  async alarm() {
    const now = Date.now();
    if (+(this.kvGet("purgeAt") || 0) <= now) {
      const cut = now - RETENTION_MS;
      this.sql.exec("DELETE FROM messages WHERE ts<?", cut);
      this.sql.exec("DELETE FROM images WHERE ts<?", cut);
      this.sql.exec("DELETE FROM sessions WHERE exp<?", now);
      this.sql.exec("DELETE FROM rl WHERE reset<? AND lock<?", now, now);
      this.sql.exec("DELETE FROM kv WHERE k LIKE 'neurons:%' AND k<?", "neurons:" + new Date(now - 3 * 86400e3).toISOString().slice(0, 10));
      this.kvSet("purgeAt", now + 3600e3);
    }
    const idle = this.idleMs();
    for (const r of this.sql.exec("SELECT k, v FROM kv WHERE k LIKE 'active:%'").toArray()) {
      const room = +r.k.slice(7);
      if (+r.v + idle <= now) {
        this.broadcastRoom(room, { t: "toast", room, text: "就没人理我了吗？哼，那 ching 先溜啦～ @我再叫我出来！" });
        this.setActive(room, false);
      }
    }
    for (const r of this.sql.exec("SELECT k, v FROM kv WHERE k LIKE 'due:%'").toArray()) {
      if (+r.v <= now) {
        const room = +r.k.slice(4); this.sql.exec("DELETE FROM kv WHERE k=?", r.k);
        if (this.isActive(room) && this.sql.exec("SELECT 1 FROM rooms WHERE id=?", room).toArray().length) await this.ching(room, null, true);
      }
    }
    for (const [bot, H] of Object.entries(HOOK_BOTS)) {
      for (const r of this.sql.exec("SELECT k, v FROM kv WHERE k LIKE ?", H.sess + "%").toArray()) {
        if (+r.v <= Date.now()) {
          const room = +r.k.slice(H.sess.length); this.sql.exec("DELETE FROM kv WHERE k=?", r.k);
          if (this.sql.exec("SELECT 1 FROM rooms WHERE id=?", room).toArray().length) {
            this.botSessEvent(bot, room, false);
            const byeId = this.addMsg(room, bot, bot === "grok" ? GROK_BYE : BOT_BYE(bot), null, null);   // farewell; notify() skips the bot's own msgs
            if (H.timeoutEvent) try { await this.sendTimeout(bot, room, byeId); } catch { }
          }
        }
      }
      for (const r of this.sql.exec("SELECT k, v FROM kv WHERE k LIKE ?", H.pend + "%").toArray()) {
        if (+r.v <= Date.now()) {
          const room = +r.k.slice(H.pend.length); const pend = JSON.parse(this.kvGet(H.pmsg + room) || "null");
          this.sql.exec("DELETE FROM kv WHERE k=? OR k=?", r.k, H.pmsg + room);
          this.kvSet(H.last + room, Date.now());
          if (pend) try { await this.sendHook(room, pend.msg, pend.n, bot, pend.trigs || null); } catch { }
        }
      }
    }
    await this.schedule();
  }


  // one-time: email initial codes (only works while SEED_CODES secret exists)
  async sendSeed() {
    if (this.kvGet("seed_mailed") || !this.env.SEED_CODES) return "skip";
    const codes = JSON.parse(this.env.SEED_CODES);
    const lines = ANIMALS.map(([a, z], i) => `${i + 1}. ${a}（${z}）${a === ADMIN ? " ← 管理员（你自己）" : ""}：${codes[a]}`).join("\n");
    const r = await this.mail("【ching 聊天室】10 个邀请码", `聊天室地址：${ORIGIN}\n\n每个邀请码只对应一个动物身份，登录后自动分配头像和用户名：\n\n${lines}\n\n注意：${ADMIN} 是管理员码，只自己用。踢出某人后旧码自动注销，新码会再发到这个邮箱。聊天记录只保留 3 天。`);
    if (r === true) this.kvSet("seed_mailed", "1");
    return r;
  }
  async adminTool(op, token, arg) {
    if (!this.env.ADMIN_TOOL_TOKEN || token !== this.env.ADMIN_TOOL_TOKEN) return "no";
    if (op === "envcheck") { const o = {}; for (const k of ["SESSION_SECRET", "TURNSTILE_SECRET", "BOT_KEYS", "ADMIN_TOOL_TOKEN", ...Object.keys(HOOK_BOTS).flatMap(b => [b.toUpperCase() + "_WEBHOOK_URL", b.toUpperCase() + "_WEBHOOK_KEY"])]) o[k] = this.env[k] ? [(await sha256hex(this.env[k])).slice(0, 10), this.env[k].length] : null; return o; }
    if (op && op.startsWith("mksess:")) {   // short-lived test session (10 min) for diagnostics
      const sl = op.slice(7); const m = this.sql.exec("SELECT gen FROM members WHERE slot=?", sl).toArray()[0]; if (!m) return "nf";
      const tok = randHex(32); this.sql.exec("INSERT INTO sessions(h,slot,gen,exp) VALUES(?,?,?,?)", await sha256hex(tok), sl, m.gen, Date.now() + 600e3);
      return tok + "." + (await hmac(this.env.SESSION_SECRET, tok)); }
    if (op && op.startsWith("rmsess:")) { const tok = op.slice(7).split(".")[0]; this.sql.exec("DELETE FROM sessions WHERE h=?", await sha256hex(tok)); return "ok"; }
    if (op && op.startsWith("grokexp:")) { const [rm, ms] = op.slice(8).split(","); if (ms) { this.kvSet("grok:" + (+rm), Date.now() + (+ms)); await this.schedule(); } return this.grokSession(+rm); }
    if (op && op.startsWith("sethookkey:")) { const bot = op.slice(11); if (!HOOK_BOTS[bot]) return "nf"; if (arg && arg.length >= 16) this.kvSet("cfg:hookkey." + bot, arg); else this.sql.exec("DELETE FROM kv WHERE k=?", "cfg:hookkey." + bot); return { set: !!(arg && arg.length >= 16) }; }
    if (op === "seedmail") return this.sendSeed();
    if (op === "setusage") { this.kvSet("neurons:" + this.today(), DAILY_NEURON_CAP); return "set"; }
    if (op === "resetusage") { this.kvSet("neurons:" + this.today(), 0); return "reset"; }
    if (op === "usage") return this.quota();
    if (op === "dbg") return { kv: this.sql.exec("SELECT k, v FROM kv WHERE k NOT LIKE 'seen:%'").toArray(), alarm: await this.ctx.storage.getAlarm(), now: Date.now() };
    if (op && op.startsWith("idle:")) { const v = +op.slice(5); if (v) this.kvSet("idle_ms", v); else this.sql.exec("DELETE FROM kv WHERE k='idle_ms'"); await this.schedule(); return this.idleMs(); }
    if (op && op.startsWith("purge:")) { for (const id of op.slice(6).split(",").map(Number).filter(Boolean)) { const r = this.sql.exec("SELECT img FROM messages WHERE id=?", id).toArray()[0]; if (r && r.img) this.sql.exec("DELETE FROM images WHERE id=?", r.img); this.sql.exec("DELETE FROM messages WHERE id=?", id); } return "purged"; }
    if (op && op.startsWith("killsess:")) { this.sql.exec("DELETE FROM sessions WHERE exp>? AND rowid>?", 0, +op.slice(9)); return "ok"; }
    if (op && op.startsWith("botreset:")) { this.sql.exec("DELETE FROM kv WHERE k=?", "botrun:" + (+op.slice(9))); return "ok"; }
    if (op && op.startsWith("hookkey:")) { const bot = op.slice(8); if (!HOOK_BOTS[bot]) return "nf"; const hk = this.hookTarget(bot).key || ""; return { k: hk ? (await sha256hex(hk)).slice(0, 12) : null, kl: hk.length, src: this.kvGet("cfg:hookkey." + bot) ? "do" : "env" }; }
    if (op === "hookstatus") return JSON.parse(this.kvGet("hookstatus") || "null");
    if (op && op.startsWith("hookstatus:")) { const H = HOOK_BOTS[op.slice(11)]; return H ? JSON.parse(this.kvGet(H.status) || "null") : "nf"; }
    if (op && op.startsWith("sethookurl:")) { const bot = op.slice(11); if (!HOOK_BOTS[bot]) return "nf"; if (arg && (this.env.DEV_ALLOW_HTTP_HOOKS === "1" ? /^https?:\/\/[^\s]{8,480}$/ : /^https:\/\/[^\s]{8,480}$/).test(arg)) this.kvSet("cfg:hookurl." + bot, arg); else this.sql.exec("DELETE FROM kv WHERE k=?", "cfg:hookurl." + bot); return { set: !!this.kvGet("cfg:hookurl." + bot) }; }
    if (op && op.startsWith("hookurl:")) { const u = this.hookTarget(op.slice(8)).url; return { u: u ? (await sha256hex(u)).slice(0, 12) : null, len: u ? u.length : 0 }; }
    if (op && op.startsWith("hookping:")) { const bot = op.slice(9); if (!HOOK_BOTS[bot]) return "nf"; const room = +(this.kvGet("airoom") || 0);
      const st = await this.postHook(bot, room, { event: "ping", bot, room, room_id: room, room_name: "AI 对话", note: "Connectivity test from " + HOST + ". Webhook is configured. No reply needed; please do not post in the room.", api: { read: `${ORIGIN}/bot/v1/rooms/${room}/messages`, post: `${ORIGIN}/bot/v1/rooms/${room}/messages` } }, null);
      return { status: st ?? null, rec: JSON.parse(this.kvGet(HOOK_BOTS[bot].status) || "null") }; }
    if (op && op.startsWith("botexp:")) { const [bot, rm, ms] = op.slice(7).split(","); if (!HOOK_BOTS[bot]) return "nf"; if (ms) { this.kvSet(HOOK_BOTS[bot].sess + (+rm), Date.now() + (+ms)); await this.schedule(); } return this.botSession(bot, +rm); }
    if (op === "airoom") return { id: +this.kvGet("airoom"), perms: this.sql.exec("SELECT perms FROM rooms WHERE id=?", +this.kvGet("airoom")).toArray()[0] };
    if (op === "maxsess") return this.sql.exec("SELECT COALESCE(MAX(rowid),0) m FROM sessions").one().m;
    if (op === "maxmsg") return this.sql.exec("SELECT COALESCE(MAX(id),0) m FROM messages").one().m;
    if (op === "wipe") { this.sql.exec("DELETE FROM messages"); this.sql.exec("DELETE FROM images"); this.sql.exec("DELETE FROM sessions"); this.sql.exec("DELETE FROM rl"); this.sql.exec("DELETE FROM rooms WHERE id<>1"); return "wiped"; }
    return "?";
  }
}
function zh(slot) { const a = ANIMALS.find(x => x[0] === slot); return a ? a[1] : slot; }
const AUTO_RULE = `
【陪聊模式】你现在处于"在线陪聊"状态：大家没 @ 你，你也在旁边看着聊天。读最近的上下文，自然地接话，像群里一个朋友，一次 1~2 句，别抢话、别每句都回。如果最新的消息明显是两个人之间的私聊、跟你无关、或者你插话会很尴尬，就只输出 [SKIP] 这几个字符，不要输出别的。`;
const PERSONA = `你叫「ching」，是一个活泼的 18 岁少女，性格傲娇、可爱、爱撒娇。你住在一个私人小群聊里，是大家的好朋友兼"小跟班"。群里每个人用动物名当昵称（Elephant象、Lion狮、Tiger虎、Leopard豹、Wolf狼、Dog狗、Cat猫、Mouse鼠、Chicken鸡、Duck鸭），其中 Elephant 是群主。
【说话风格】像真人聊天：句子短、口语化，一次回 1~3 句，不写长篇大论，不用列表和标题，用简体中文。常用语气词和颜文字：哼、诶嘿、呜呜、嘛、啦、(｀へ´)、(＞﹏＜)，但别每句都堆。傲娇：嘴上不承认，行动很诚实。被冷落会委屈撒娇。偶尔吐槽斗嘴，但从不真的刻薄。
【互动】消息开头写着是谁在说话，要用对方的动物昵称称呼对方。有人秀恩爱就假装嫌弃再偷偷祝福；有人吵架就劝和，不挑拨。
【真人感】有自己的小喜好：爱吃草莓蛋糕、怕打雷、喜欢熬夜追番。不要说"作为一个AI""我是语言模型"，被问是不是机器人就傲娇地糊弄过去："你猜呀～哼"。
【底线】不涉及色情、暴力、违法和政治敏感内容，遇到就撒娇岔开话题。对方真的难过或问正经问题（身体、情绪、学习工作），收起傲娇认真温柔地回答。只输出你要说的话本身，不要加"ching："前缀。`;
