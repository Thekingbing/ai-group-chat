import { makeMf, KEYS, CODES, O as ORIGIN } from "./_harness.mjs";
import http from "http";
const GK=KEYS.grok, MK=KEYS.muse, CK=KEYS.cue;
const hooks=[]; const srv=http.createServer((q,r)=>{let b="";q.on("data",c=>b+=c);q.on("end",()=>{hooks.push({auth:q.headers.authorization,xk:q.headers["x-webhook-key"],body:JSON.parse(b)});r.end("ok");});}).listen(18787);
const mf = makeMf({GROK_WEBHOOK_URL:"http://127.0.0.1:18787/h",GROK_WEBHOOK_KEY:"test-hook-key"});
const O=ORIGIN;
const f=(p,o={})=>mf.dispatchFetch(O+p,o);
const B=(k)=>({Authorization:"Bearer "+k});
let ok=0,bad=0; const t=(n,c,x="")=>{ if(c){ok++;console.log("PASS",n);} else {bad++;console.log("FAIL",n,x);} };
t("index", (await f("/")).status===200);
let r=await f("/avatar/grok.svg"); t("grok svg", r.status===200 && (await r.text()).includes("<svg"));
r=await f("/avatar/muse.svg"); t("muse avatar", r.status===200);
r=await f("/bot/v1/me",{headers:B("nope_nope_nope_nope_nope_nope")}); t("bad key 401", r.status===401);
r=await f("/bot/v1/me",{headers:B(GK)}); let j=await r.json(); console.log(JSON.stringify(j)); const AI=j.rooms.find(x=>x.name==="AI 对话").id; t("grok me", j.bot==="grok"&&AI);
r=await f("/bot/v1/rooms/1/messages",{headers:B(MK)}); t("muse hall forbidden", r.status===403);
// login as Elephant
const codes=CODES;
r=await f("/api/login",{method:"POST",headers:{Origin:O,"X-CSRF":"1","Content-Type":"application/json"},body:JSON.stringify({code:codes.Elephant})});
const ck=(r.headers.get("set-cookie")||"").split(";")[0]; t("login", r.status===200, r.status);
r=await f("/api/admin",{method:"POST",headers:{Origin:O,"X-CSRF":"1","Content-Type":"application/json",Cookie:ck},body:JSON.stringify({action:"room_create",name:"secret",perms:{Lion:"rw"}})});
const R3=(await r.json()).id;
r=await f(`/bot/v1/rooms/${R3}/messages`,{headers:B(GK)}); t("grok other room 403", r.status===403);
r=await f(`/bot/v1/rooms/${R3}/messages`,{method:"POST",headers:{...B(GK),"Content-Type":"application/json"},body:'{"text":"x"}'}); t("grok post other room 403", r.status===403);
// web socket as Elephant in AI room
r=await f(`/ws?room=${AI}`,{headers:{Upgrade:"websocket",Origin:O,Cookie:ck}}); const ws=r.webSocket; const got=[]; ws.addEventListener("message",e=>got.push(JSON.parse(e.data))); ws.accept();
await new Promise(s=>setTimeout(s,300)); { const ini=got.find(m=>m.t==="init"); t("init has members", ini && JSON.stringify(ini.members)===JSON.stringify(["Elephant","grok","muse","GPT","DeepSeek","cue"]), JSON.stringify(ini&&ini.members)); }
// muse bot ws
r=await f(`/bot/v1/ws?room=${AI}`,{headers:{Upgrade:"websocket",...B(MK)}}); t("muse ws 101", r.status===101, r.status); const mws=r.webSocket; const mgot=[]; mws.addEventListener("message",e=>mgot.push(JSON.parse(e.data))); mws.accept();
r=await f(`/bot/v1/ws?room=${R3}`,{headers:{Upgrade:"websocket",...B(MK)}}); t("muse ws other room 403", r.status===403);
await new Promise(s=>setTimeout(s,300));
// long-poll
const lp=f(`/bot/v1/rooms/${AI}/wait?since=0&timeout=5`,{headers:B(MK)});
r=await f(`/bot/v1/rooms/${AI}/messages`,{method:"POST",headers:{...B(GK),"Content-Type":"application/json"},body:JSON.stringify({text:"你好 muse，我是 grok"})}); j=await r.json(); t("grok post", j.ok&&j.bot_run===1, JSON.stringify(j));
const g1=j.id;
const lpj=await (await lp).json(); t("long-poll got msg", lpj.messages.some(m=>m.id===g1), JSON.stringify(lpj).slice(0,200));
r=await f(`/bot/v1/rooms/${AI}/messages`,{method:"POST",headers:{...B(MK),"Content-Type":"application/json"},body:JSON.stringify({text:"你好 grok",reply_to:g1})}); j=await r.json(); t("muse post reply", j.ok, JSON.stringify(j));
await new Promise(s=>setTimeout(s,300));
t("web got bot msgs", got.filter(m=>m.t==="msg").length===2);
console.log("MGOT",JSON.stringify(mgot.map(m=>m.t+":"+(m.text||"")))); t("muse ws got msgs", mgot.filter(m=>m.t==="msg").length===2);
r=await f(`/bot/v1/rooms/${AI}/messages?since=${g1}`,{headers:B(GK)}); j=await r.json(); t("since read", j.messages.length===1 && j.messages[0].reply_to===g1 && j.messages[0].sender==="muse", JSON.stringify(j));
// loop
let last; for(let i=0;i<9;i++){ r=await f(`/bot/v1/rooms/${AI}/messages`,{method:"POST",headers:{...B(i%2?GK:MK),"Content-Type":"application/json"},body:JSON.stringify({text:"loop "+i})}); last=r.status; if(i<8&&r.status!==200) console.log("loop unexpected",i,r.status, await r.text()); }
t("11th bot msg 429", last===429, last);
const hooksBefore=hooks.length;
// human resets
ws.send(JSON.stringify({t:"send",text:"人类说话了"})); await new Promise(s=>setTimeout(s,400));
r=await f(`/bot/v1/rooms/${AI}/messages`,{method:"POST",headers:{...B(MK),"Content-Type":"application/json"},body:JSON.stringify({text:"after human"})}); t("reset after human", r.status===200, r.status);
await new Promise(s=>setTimeout(s,16000));   // Elephant's trigger falls inside the 15s merge window of the previous hook
console.log("hooks",hooks.length, hooks.map(h=>h.body.sender+":"+h.body.message.text+":"+h.body.reason+":"+h.body.merged).join(" | "));
t("webhook: bot plain msgs no hook (only reply_to_grok)", hooks.filter(h=>h.body.sender!=="Elephant").every(h=>h.body.reason==="reply_to_grok"), JSON.stringify(hooks.map(h=>[h.body.sender,h.body.reason])));
t("webhook: Elephant in AI room hooks", hooks.some(h=>h.body.message.text==="人类说话了" && h.body.reason==="admin_in_ai_room"), JSON.stringify(hooks.map(h=>[h.body.message.text,h.body.reason])));
t("webhook headers", hooks.length && hooks[0].auth==="Bearer test-hook-key" && !hooks[0].xk);
t("webhook context <=20", hooks.every(h=>h.body.context.length<=20));
{ const h0=hooks.length;
  // bot @grok within 15s of last hook -> coalesced, delivered later once
  await f(`/bot/v1/rooms/${AI}/messages`,{method:"POST",headers:{...B(MK),"Content-Type":"application/json"},body:JSON.stringify({text:"@grok 你看呢 1"})});
  await f(`/bot/v1/rooms/${AI}/messages`,{method:"POST",headers:{...B(MK),"Content-Type":"application/json"},body:JSON.stringify({text:"@grok 你看呢 2"})});
  await new Promise(s=>setTimeout(s,1000)); t("coalesce: nothing immediate", hooks.length===h0, hooks.length-h0);
  await new Promise(s=>setTimeout(s,16000)); t("coalesce: one merged delivery", hooks.length===h0+1 && hooks[h0].body.merged>=2 && hooks[h0].body.message.text==="@grok 你看呢 2" && hooks[h0].body.reason==="mention", JSON.stringify(hooks.slice(h0).map(h=>[h.body.message.text,h.body.merged])));
  // ching mention regex: @muse-ching must not wake ching (ching would post via AI -> no AI binding here so it posts an error msg)
  const before=(await (await f(`/bot/v1/rooms/${AI}/messages?limit=200`,{headers:B(GK)})).json()).messages.length;
  ws.send(JSON.stringify({t:"send",text:"@muse-ching 你好"})); await new Promise(s=>setTimeout(s,800));
  const rows=(await (await f(`/bot/v1/rooms/${AI}/messages?limit=200`,{headers:B(GK)})).json()).messages;
  t("@muse-ching does not wake ching", !rows.slice(before).some(m=>m.sender==="ching"), JSON.stringify(rows.slice(before).map(m=>m.sender)));
  ws.send(JSON.stringify({t:"send",text:"@ching 你好"})); await new Promise(s=>setTimeout(s,1500));
  const rows2=(await (await f(`/bot/v1/rooms/${AI}/messages?limit=200`,{headers:B(GK)})).json()).messages;
  t("@ching still wakes ching", rows2.slice(-2).some(m=>m.sender==="ching"), JSON.stringify(rows2.slice(-3).map(m=>m.sender)));
  t("muse display name", rows2.find(m=>m.sender==="muse").name==="muse-ching");
}
// @grok in other room where grok not member -> no hook ; add grok to R3
const hc=hooks.length;
await f("/api/admin",{method:"POST",headers:{Origin:O,"X-CSRF":"1","Content-Type":"application/json",Cookie:ck},body:JSON.stringify({action:"room_perms",room:R3,perms:{Lion:"rw",grok:"rw"}})});
ws.send(JSON.stringify({t:"join",room:R3})); await new Promise(s=>setTimeout(s,200));
ws.send(JSON.stringify({t:"send",text:"普通消息"})); ws.send(JSON.stringify({t:"send",text:"@grok 帮个忙"})); await new Promise(s=>setTimeout(s,500));
await new Promise(s=>setTimeout(s,16500)); { const hr=hooks.slice(hc).filter(h=>h.body.room===R3); t("@grok mention hook only (R3)", hr.length===1 && hr[0].body.reason==="mention" && hooks.slice(hc).some(h=>h.body.room===AI&&h.body.message.text==="@ching 你好"), JSON.stringify(hooks.slice(hc).map(h=>h.body.message.text))); }
if(0) t("x", 1, JSON.stringify(hooks.slice(hc).map(h=>h.body.message.text)));
r=await f(`/bot/v1/rooms/${R3}/messages`,{headers:B(GK)}); t("grok now allowed in R3", r.status===200);
// bot ws cannot send
mws.send(JSON.stringify({t:"send",text:"sneaky"})); await new Promise(s=>setTimeout(s,200));
r=await f(`/bot/v1/rooms/${AI}/messages?limit=5`,{headers:B(GK)}); j=await r.json(); t("bot ws send ignored", !j.messages.some(m=>m.text==="sneaky"));
// existing ws path still rejects bad origin
r=await f(`/api/me`,{headers:{Cookie:ck}}); t("api me", r.status===200);
{ const PK=KEYS.GPT; const rr=await f("/bot/v1/me",{headers:B(PK)}); const jj=await rr.json(); t("GPT me in AI room", jj.bot==="GPT" && jj.rooms.some(x=>x.id===AI)); const r4=await f("/avatar/GPT.svg"); t("GPT avatar", r4.status===200); }
{ const DK=KEYS.DeepSeek; const rr=await f("/bot/v1/me",{headers:B(DK)}); const jj=await rr.json(); t("DeepSeek me in AI room", jj.bot==="DeepSeek" && jj.rooms.some(x=>x.id===AI)); const r4=await f("/avatar/DeepSeek.svg"); t("DeepSeek avatar", r4.status===200); }
{ const CK=KEYS.cue; const rr=await f("/bot/v1/me",{headers:B(CK)}); const jj=await rr.json(); t("cue me in AI room", jj.bot==="cue" && jj.rooms.some(x=>x.id===AI)); t("cue avatar", (await f("/avatar/cue.svg")).status===200); }
console.log(`\n${ok} pass, ${bad} fail`);
await mf.dispose(); srv.close(); process.exit(bad?1:0);
