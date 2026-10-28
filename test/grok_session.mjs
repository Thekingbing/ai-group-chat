import { makeMf, KEYS, CODES, O as ORIGIN } from "./_harness.mjs";
import http from "http";
const GK=KEYS.grok, MK=KEYS.muse, CK=KEYS.cue;
const hooks=[]; const srv=http.createServer((q,r)=>{let b="";q.on("data",c=>b+=c);q.on("end",()=>{hooks.push(JSON.parse(b));r.end("ok");});}).listen(18788);
const mf = makeMf({ADMIN_TOOL_TOKEN:"tooltok",GROK_WEBHOOK_URL:"http://127.0.0.1:18788/h",GROK_WEBHOOK_KEY:"test-hook-key"});
const O=ORIGIN, f=(p,o={})=>mf.dispatchFetch(O+p,o), B=k=>({Authorization:"Bearer "+k}), sl=ms=>new Promise(r=>setTimeout(r,ms));
let ok=0,bad=0; const t=(n,c,x="")=>{ if(c){ok++;console.log("PASS",n);} else {bad++;console.log("FAIL",n,x);} };
const tool=async op=>(await (await f("/__tool?op="+encodeURIComponent(op),{method:"POST",headers:{"X-Tool-Token":"tooltok"}})).json()).r;
const codes=CODES;
async function login(slot){ const r=await f("/api/login",{method:"POST",headers:{Origin:O,"X-CSRF":"1","Content-Type":"application/json"},body:JSON.stringify({code:codes[slot]})}); return (r.headers.get("set-cookie")||"").split(";")[0]; }
const ck=await login("Elephant"), lk=await login("Lion");
let r=await f("/api/admin",{method:"POST",headers:{Origin:O,"X-CSRF":"1","Content-Type":"application/json",Cookie:ck},body:JSON.stringify({action:"room_create",name:"r3",perms:{Lion:"rw",grok:"rw",muse:"rw"}})});
const R3=(await r.json()).id, AI=2;
async function sock(cookie,room){ const r=await f(`/ws?room=${room}`,{headers:{Upgrade:"websocket",Origin:O,Cookie:cookie}}); const w=r.webSocket; const got=[]; w.addEventListener("message",e=>got.push(JSON.parse(e.data))); w.accept(); await sl(200); return {w,got,send:o=>w.send(JSON.stringify(o))}; }
const L=await sock(lk,R3), E=await sock(ck,R3);
const post=async(k,room,text,reply_to)=>(await (await f(`/bot/v1/rooms/${room}/messages`,{method:"POST",headers:{...B(k),"Content-Type":"application/json"},body:JSON.stringify({text,reply_to})})).json());
L.send({t:"send",text:"普通聊天，没有会话"}); await sl(400);
t("no session: human plain no hook", hooks.length===0);
t("no session: grok inactive", (await tool("grokexp:"+R3)).active===false);
L.send({t:"send",text:"@grok 你好"}); await sl(500);
t("@grok -> hook mention", hooks.length===1 && hooks[0].reason==="mention", JSON.stringify(hooks.map(h=>h.reason)));
const h0=hooks[0]; t("body complete", h0.room===R3 && h0.trigger.text==="@grok 你好" && h0.trigger.sender==="Lion" && h0.trigger.id>0 && h0.message.id===h0.trigger.id && Array.isArray(h0.context) && h0.context.length>=2 && h0.context.length<=20 && h0.session.active===true && h0.session.reason==="mention" && /T/.test(h0.session.expires_at), JSON.stringify(h0).slice(0,400));
t("session ~30min", Math.abs(h0.session.expires_ts-Date.now()-30*60e3)<5000);
t("web chip event", L.got.some(m=>m.t==="grok"&&m.active===true));
const g=await post(GK,R3,"我在，说吧"); t("grok post no hook", hooks.length===1);
await post(MK,R3,"muse 普通发言"); await sl(300); t("bot plain in session no hook", hooks.length===1);
L.send({t:"send",text:"会话里普通发言"}); await sl(500);
t("human in session -> coalesced (none immediate)", hooks.length===1);
await sl(15500); t("coalesced session_human delivered", hooks.length===2 && hooks[1].reason==="session_human" && hooks[1].trigger.text==="会话里普通发言", JSON.stringify(hooks.slice(1).map(h=>[h.reason,h.trigger.text])));
await sl(15200);
await post(MK,R3,"回复 grok",g.id); await sl(500);
t("bot reply_to grok -> hook", hooks.length===3 && hooks[2].reason==="reply_to_grok", JSON.stringify(hooks.slice(2).map(h=>[h.reason,h.trigger.text])));
// AI room: Elephant always triggers (no session needed), bots plain don't
await sl(15200);
const EA=await sock(ck,AI); EA.send({t:"send",text:"站长在 AI 房间说话"}); await sl(500);
t("Elephant in AI room -> hook", hooks.length===4 && hooks[3].reason==="admin_in_ai_room" && hooks[3].session.active===true);
await post(MK,AI,"muse 在 AI 房间普通发言"); await sl(300); t("bot plain AI room no hook", hooks.length===4);
// expiry farewell
const hc=hooks.length; await tool("grokexp:"+R3+",600"); await sl(2500);
const msgs=(await (await f(`/bot/v1/rooms/${R3}/messages?limit=5`,{headers:B(GK)})).json()).messages;
t("farewell posted by grok", msgs.at(-1).sender==="grok" && msgs.at(-1).text.includes("30 分钟"), JSON.stringify(msgs.at(-1)));
t("no webhook for farewell", hooks.length===hc);
t("chip off event", L.got.some(m=>m.t==="grok"&&m.active===false));
t("session inactive after", (await tool("grokexp:"+R3)).active===false);
L.send({t:"send",text:"会话结束后普通发言"}); await sl(16000); t("after expiry human plain no hook", hooks.length===hc, hooks.length-hc);
// init carries grok flag
L.send({t:"send",text:"@grok 再来"}); await sl(300); const L2=await sock(lk,R3); const ini=L2.got.find(m=>m.t==="init"); t("init grok flag", !ini || ini.grok===true, JSON.stringify(ini&&ini.grok));
console.log(`\n${ok} pass, ${bad} fail`); await mf.dispose(); srv.close(); process.exit(bad?1:0);
