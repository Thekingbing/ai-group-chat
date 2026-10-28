// Shared local test harness: runs the Worker + Durable Object in Miniflare with throwaway keys.
// No real secrets are needed — every key/code here is generated fresh for each run.
import { Miniflare } from "miniflare";
import fs from "node:fs"; import path from "node:path"; import crypto from "node:crypto";
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
export const HOST = "chat.example.com", O = "https://" + HOST;
const rnd = n => crypto.randomBytes(n).toString("base64url");
const sha = s => crypto.createHash("sha256").update(s).digest("hex");
// throwaway bot keys
export const KEYS = Object.fromEntries(["grok", "muse", "GPT", "DeepSeek", "cue"].map(b => [b, "test_" + b + "_" + rnd(24)]));
// throwaway invite codes for the 10 animal slots (format XXXX-XXXX-XXXX-XXXX)
const AL = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const code = () => Array.from({ length: 4 }, () => Array.from({ length: 4 }, () => AL[crypto.randomInt(AL.length)]).join("")).join("-");
export const CODES = Object.fromEntries(["Elephant", "Lion", "Tiger", "Leopard", "Wolf", "Dog", "Cat", "Mouse", "Chicken", "Duck"].map(a => [a, code()]));
const normCode = c => c.toUpperCase().replace(/[^A-Z0-9]/g, "");
export function makeMf(extra = {}) {
  const src = fs.readFileSync(path.join(root, "src/worker.js"), "utf8").replace('import { EmailMessage } from "cloudflare:email";', "class EmailMessage{}");
  if (!fs.existsSync(path.join(root, "src/assets.js"))) throw new Error("run `npm run build` first");
  return new Miniflare({
    modules: [{ type: "ESModule", path: "worker.js", contents: src }, { type: "ESModule", path: "assets.js", contents: fs.readFileSync(path.join(root, "src/assets.js"), "utf8") }],
    compatibilityDate: "2025-09-01", durableObjects: { ROOM: { className: "Room", useSQLite: true } },
    bindings: { HOST, TURNSTILE_SITEKEY: "x", SESSION_SECRET: rnd(32), SEED_CODES: JSON.stringify(CODES),
      BOT_KEYS: JSON.stringify(Object.fromEntries(Object.entries(KEYS).map(([b, k]) => [b, sha(k)]))), ...extra },
  });
}
void normCode;
