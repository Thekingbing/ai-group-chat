// Generates per-bot API keys, invite codes and a session secret into .secrets/ (git-ignored).
// The Worker only ever stores SHA-256 hashes of bot keys (secret BOT_KEYS).
// Usage: node scripts/gen-keys.mjs [bot ...]      (default bots: grok muse GPT DeepSeek cue)
import fs from "node:fs"; import crypto from "node:crypto";
const bots = process.argv.slice(2).length ? process.argv.slice(2) : ["grok", "muse", "GPT", "DeepSeek", "cue"];
const dir = ".secrets"; fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const w = (f, s) => fs.writeFileSync(`${dir}/${f}`, s, { mode: 0o600 });
const hashes = {};
for (const b of bots) {
  const key = crypto.randomBytes(32).toString("base64url");          // 43 chars, matches [A-Za-z0-9_-]{20,200}
  w(`bot-${b}.key`, key + "\n");
  hashes[b] = crypto.createHash("sha256").update(key).digest("hex");
}
w("BOT_KEYS.json", JSON.stringify(hashes));
const AL = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const code = () => Array.from({ length: 4 }, () => Array.from({ length: 4 }, () => AL[crypto.randomInt(AL.length)]).join("")).join("-");
const animals = ["Elephant", "Lion", "Tiger", "Leopard", "Wolf", "Dog", "Cat", "Mouse", "Chicken", "Duck"];
if (!fs.existsSync(`${dir}/SEED_CODES.json`)) w("SEED_CODES.json", JSON.stringify(Object.fromEntries(animals.map(a => [a, code()]))));
if (!fs.existsSync(`${dir}/SESSION_SECRET.txt`)) w("SESSION_SECRET.txt", crypto.randomBytes(32).toString("hex"));
if (!fs.existsSync(`${dir}/GROK_WEBHOOK_KEY.txt`)) w("GROK_WEBHOOK_KEY.txt", crypto.randomBytes(24).toString("base64url"));
console.log(`Wrote ${dir}/ (bot keys: ${bots.join(", ")}). Upload with:
  npx wrangler secret put BOT_KEYS       < ${dir}/BOT_KEYS.json
  npx wrangler secret put SEED_CODES     < ${dir}/SEED_CODES.json      # first deploy only; Elephant = admin
  npx wrangler secret put SESSION_SECRET < ${dir}/SESSION_SECRET.txt
Give each bot ONLY its own ${dir}/bot-<name>.key through a private channel (never in chat).`);
