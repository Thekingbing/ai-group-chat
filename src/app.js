"use strict";
const $ = id => document.getElementById(id);
// keep in sync with BOTS in worker.js (slot -> display name)
const BOTS = {grok:"grok",muse:"muse-ching",GPT:"GPT",DeepSeek:"DeepSeek",cue:"cue"};
const isBot = s => Object.prototype.hasOwnProperty.call(BOTS,s);
// /avatar/<slot>.svg: the Worker serves a user-supplied bitmap (avatars/<slot>.webp|png|jpg) if present, else the SVG
const avatar = s => "/avatar/"+((ZH[s]&&s!=="system")||isBot(s)?s:"ching")+".svg";
const ZH = {Elephant:"象",Lion:"狮",Tiger:"虎",Leopard:"豹",Wolf:"狼",Dog:"狗",Cat:"猫",Mouse:"鼠",Chicken:"鸡",Duck:"鸭",ching:"ching",system:"系统"};
const ORDER = ["Elephant","Lion","Tiger","Leopard","Wolf","Dog","Cat","Mouse","Chicken","Duck"];
let members = [];
let rooms = [], curRoom = 0, curPerm = "", navPush = false;
const hashRoom = () => { const m = location.hash.match(/room=(\d+)/); return m ? +m[1] : 0; };
try { curRoom = hashRoom() || +(localStorage.getItem("room") || 0); } catch { curRoom = hashRoom(); }
const draftKey = r => "draft:" + r;
function saveDraft(){ try{ if(curRoom){ const v=$("text").value; v?localStorage.setItem(draftKey(curRoom),v):localStorage.removeItem(draftKey(curRoom)); } }catch{} }
window.addEventListener("popstate",()=>{ const r=hashRoom(); if(r&&r!==curRoom&&ws&&ws.readyState===1){ saveDraft(); ws.send(JSON.stringify({t:"join",room:r})); } });
let me = null, admin = false, ws = null, retry = 0, replyTo = null, msgIndex = new Map(), lastTyping = 0, tsToken = null, presence = {users:{},mutes:{}};
const COLORS={Elephant:"#9aa7c7",Lion:"#f2c14e",Tiger:"#f39c4a",Leopard:"#d9a35b",Wolf:"#8d99ae",Dog:"#c8a27a",Cat:"#f7b2bd",Mouse:"#bfc8d6",Chicken:"#f6d365",Duck:"#7fc8a9"};
const isOn=s=>!!(presence.users[s]&&presence.users[s].online);
const name = s => s === "ching" ? "ching" : isBot(s) ? BOTS[s] : s + "（" + (ZH[s]||s) + "）";
const fmt = ts => new Date(ts).toLocaleString("zh-CN",{timeZone:"Asia/Shanghai",month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit"});
function toast(t){const e=$("toast");e.textContent=t;e.classList.remove("hidden");clearTimeout(toast.t);toast.t=setTimeout(()=>e.classList.add("hidden"),2600);}
function el(tag,cls,txt){const e=document.createElement(tag);if(cls)e.className=cls;if(txt!=null)e.textContent=txt;return e;}
async function api(path,body,raw){const r=await fetch(path,{method:"POST",credentials:"same-origin",headers:raw?{"X-CSRF":"1","Content-Type":"application/octet-stream"}:{"X-CSRF":"1","Content-Type":"application/json"},body:raw?body:JSON.stringify(body||{})});let j={};try{j=await r.json();}catch{}j._status=r.status;return j;}

// ---------- login ----------
function showLogin(){ $("app").classList.add("hidden"); $("login").classList.remove("hidden"); loadTurnstile(); }
let tsMode = "loading";
function loadTurnstile(){
  if (tsMode !== "loading") return;
  const timer = setTimeout(()=>{ if(tsMode==="loading"){ tsMode="fallback"; $("ts").textContent="人机验证加载较慢，已切换为严格模式，可直接输入邀请码"; } }, 8000);
  window.__tsload = () => { clearTimeout(timer); if(tsMode!=="loading" && tsMode!=="fallback") return; tsMode="ok"; $("ts").textContent="";
    window.turnstile.render("#ts",{sitekey:document.body.dataset.sitekey,callback:t=>{tsToken=t;},"expired-callback":()=>{tsToken=null;},"error-callback":()=>{tsToken=null;}}); };
  const s=document.createElement("script"); s.src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=__tsload"; s.async=true;
  s.onerror=()=>{clearTimeout(timer);tsMode="fallback";$("ts").textContent="人机验证无法加载，已切换为严格模式，可直接输入邀请码";};
  document.head.appendChild(s);
}
$("loginBtn").onclick = async () => {
  const code=$("code").value.trim(); if(!code) return;
  if(tsMode==="ok" && !tsToken){ $("loginErr").textContent="请先完成人机验证"; return; }
  $("loginBtn").disabled=true;
  const r=await api("/api/login",{code,turnstile:tsToken});
  $("loginBtn").disabled=false;
  if(r.ok){ $("code").value=""; $("login").classList.add("hidden"); $("remember").classList.remove("hidden"); } else { $("loginErr").textContent=r.error||"登录失败"; tsToken=null; if(window.turnstile&&tsMode==="ok") try{window.turnstile.reset("#ts");}catch{} }
};
$("code").addEventListener("keydown",e=>{if(e.key==="Enter")$("loginBtn").click();});

document.querySelectorAll("#remember button").forEach(b=>b.onclick=async()=>{ await api("/api/remember",{days:+b.dataset.d}); $("remember").classList.add("hidden"); start(); });
// ---------- chat ----------
async function start(){
  const r=await fetch("/api/me",{credentials:"same-origin"}); if(r.status!==200) return showLogin();
  const j=await r.json(); me=j.slot; admin=j.admin;
  $("login").classList.add("hidden"); $("app").classList.remove("hidden");
  $("meAv").src="/avatar/"+me+".svg"; $("meName").textContent=name(me)+(admin?" · 管理员":"");
  $("adminBtn").classList.toggle("hidden",!admin); $("online").classList.toggle("hidden",!admin);
  connect();
}
function connect(){
  ws=new WebSocket("wss://"+location.host+"/ws"+(curRoom?"?room="+curRoom:""));
  ws.onopen=()=>{retry=0;$("status").classList.add("on");};
  ws.onclose=e=>{$("status").classList.remove("on"); if(e.code===4001){toast("你已被移出群聊");setTimeout(()=>location.reload(),1500);return;}
    fetch("/api/me",{credentials:"same-origin"}).then(r=>{ if(r.status===401) return showLogin(); setTimeout(connect,Math.min(30000,1000*2**retry++)); }).catch(()=>setTimeout(connect,Math.min(30000,1000*2**retry++)));};
  ws.onmessage=e=>{let m;try{m=JSON.parse(e.data);}catch{return;}
    if(m.t==="rooms"){ rooms=m.rooms; renderRooms(); if(admin&&!$("adminPanel").classList.contains("hidden")) renderAdmin(); }
    else if(m.t==="noroom"){ curRoom=0; $("msgs").textContent=""; $("msgs").appendChild(el("div","sys","你暂时没有可进入的房间")); setPerm(""); }
    else if(m.t==="members"){ if(m.room===curRoom) members=m.members||[]; }
    else if(m.t==="grok"){ if(m.room===curRoom) $("grokChip").classList.toggle("hidden",!m.active); }
    else if(m.t==="botsess"){ if(m.room===curRoom&&m.bot==="cue") $("cueChip").classList.toggle("hidden",!m.active); }
    else if(m.t==="init"){ curRoom=m.room; $("grokChip").classList.toggle("hidden",!m.grok); $("cueChip").classList.toggle("hidden",!(m.sess&&m.sess.cue)); members=m.members||[]; mentionClose(); if(!m.members) try{ ws.send(JSON.stringify({t:"members"})); }catch{} setChing(!!m.ching); try{ localStorage.setItem("room",curRoom); $("text").value=localStorage.getItem(draftKey(curRoom))||""; }catch{}
      if(hashRoom()!==curRoom){ const u="#room="+curRoom; if(navPush) history.pushState(null,"",u); else history.replaceState(null,"",u); } navPush=false; setPerm(m.perm); renderRooms(); $("msgs").textContent=""; msgIndex.clear(); hall=new Map(); if(curRoom===1){ m.history.forEach(x=>hall.set(x.id,x)); renderHall(); } else m.history.forEach(x=>addMsg(x)); setQuota(m.quota); scrollEnd(true); }
    else if(m.t==="upd"&&curRoom===1&&m.msg.room===1){ hall.set(m.msg.id,m.msg); renderHall(); }
    else if(m.t==="gone"&&curRoom===1){ hall.delete(m.id); renderHall(); }
    else if(m.t==="msg"&&curRoom===1&&m.room===1){ hall.set(m.id,m); renderHall(); scrollEnd(m.slot===me); }
    else if(m.t==="upd"){ if(m.msg.room!==curRoom) return; const o=document.getElementById("m"+m.msg.id); const n=addMsg(m.msg,true); if(o&&n) o.replaceWith(n); else if(o) o.remove(); }
    else if(m.t==="gone"){ const o=document.getElementById("m"+m.id); if(o) o.remove(); msgIndex.delete(m.id); }
    else if(m.t==="msg"){ if(m.room!==curRoom) return; addMsg(m); scrollEnd(m.slot===me); if(m.slot!==me) typingShow(null); }
    else if(m.t==="presence"){ presence=m; renderOnline(); if(admin&&!$("adminPanel").classList.contains("hidden")) renderAdmin(); }
    else if(m.t==="typing") typingShow(m.slot);
    else if(m.t==="ching"){ if(m.room===curRoom) setChing(m.active); }
    else if(m.t==="toast"){ if(m.room===curRoom) fadeToast(m.text); }
    else if(m.t==="quota") setQuota(m.quota);
    else if(m.t==="err") toast(m.msg);
    else if(m.t==="kicked"){ toast("你已被移出群聊"); }
  };
}
setInterval(()=>{ if(ws&&ws.readyState===1) ws.send('{"t":"ping"}'); }, 25000);
setInterval(()=>{ if(admin&&ws&&ws.readyState===1) ws.send('{"t":"presence"}'); }, 30000);
function setChing(on){ $("chingChip").classList.toggle("hidden",!on); }
function fadeToast(t){ const d=el("div","ctoast"); const av=el("img"); av.src="/avatar/ching.svg"; av.alt=""; d.append(av,el("span",null,t)); $("msgs").appendChild(d); scrollEnd(true); setTimeout(()=>d.classList.add("out"),6000); setTimeout(()=>d.remove(),7000); }
// ---- emoji ----
const EMO={"常用":"😀😂🤣😊🥰😍😘😜🤪😎🥺🥹😭😤😡🤔🙄😴🤤😳🙈😏😇🤗🫣","手势":"👍👎👌✌️🤞🤟👏🙌🙏💪👋🫶🤝👀💯✨🎉🔥","爱心":"❤️🧡💛💚💙💜🤍💕💖💗💘💔💋🌹","动物":"🐶🐱🐭🐰🦊🐻🐼🐨🐯🦁🐷🐸🐵🐔🦆🐧🐣🦄🐳🐘","食物":"🍓🍰🧁🍦🍫🍬🍭🍩🍪🍉🍑🍒🍔🍟🍕🍜🧋☕🍺🍻"};
const split=s=>[...new Intl.Segmenter("zh",{granularity:"grapheme"}).segment(s)].map(x=>x.segment);
function recent(){ try{ return JSON.parse(localStorage.getItem("emoRecent")||"[]"); }catch{ return []; } }
function insertEmo(e){ const t=$("text"); const s=t.selectionStart??t.value.length, en=t.selectionEnd??t.value.length; t.value=t.value.slice(0,s)+e+t.value.slice(en); const p=s+e.length; t.setSelectionRange(p,p);
  const r=[e,...recent().filter(x=>x!==e)].slice(0,16); try{localStorage.setItem("emoRecent",JSON.stringify(r));}catch{} saveDraft(); }
let emoTab="常用";
function renderEmo(){ const p=$("emoPop"); p.textContent=""; const tabs=el("div","etabs"); const names=(recent().length?["最近"]:[]).concat(Object.keys(EMO)); if(!names.includes(emoTab)) emoTab="常用";
  for(const n of names){ const b=el("button",n===emoTab?"cur":null,n); b.onclick=e=>{e.stopPropagation(); emoTab=n; renderEmo();}; tabs.appendChild(b); }
  const g=el("div","egrid"); for(const e of (emoTab==="最近"?recent():split(EMO[emoTab]))){ const b=el("button",null,e); b.onclick=ev=>{ev.stopPropagation(); insertEmo(e);}; g.appendChild(b); }
  p.append(tabs,g); }
$("emoBtn").onclick=e=>{ e.stopPropagation(); const p=$("emoPop"); if(p.classList.contains("hidden")){ renderEmo(); p.classList.remove("hidden"); } else p.classList.add("hidden"); };
$("emoPop").onclick=e=>e.stopPropagation();
document.addEventListener("click",()=>$("emoPop").classList.add("hidden"));
let hall=new Map();
function renderHall(){ const b=$("msgs"), st=b.scrollTop; b.textContent=""; msgIndex.clear(); const all=[...hall.values()];
  all.filter(x=>x.pinned).sort((p,q)=>q.pinned-p.pinned).forEach(x=>addMsg(x)); all.filter(x=>!x.pinned).sort((p,q)=>p.id-q.id).forEach(x=>addMsg(x)); b.scrollTop=st; }
function setPerm(p){ curPerm=p; const ro=p!=="rw"; const hallRO=curRoom===1&&!admin; document.querySelector("footer").classList.toggle("hidden",hallRO); $("hallNote").classList.toggle("hidden",!hallRO); $("app").classList.toggle("hall",curRoom===1); $("sendBtn").textContent=curRoom===1?"发布":"发送"; $("text").disabled=ro; $("sendBtn").disabled=ro; $("imgBtn").disabled=ro; $("emoBtn").disabled=ro; $("emoPop").classList.add("hidden"); $("text").placeholder=ro?(!p?"没有房间":curRoom===1?"大厅仅管理员可发公告":"这个房间你只能看，不能发言"):(curRoom===1&&admin?"发布公告…（回车换行，点“发布”发送）":"说点什么… @ching 召唤她"); }
function renderRooms(){ const r=$("rooms"); r.textContent=""; for(const x of rooms){ const b=el("button",x.id===curRoom?"cur":null,"# "+x.name+(x.perm==="r"?" 👀":"")); b.onclick=()=>{ if(x.id!==curRoom&&ws&&ws.readyState===1){ saveDraft(); navPush=true; ws.send(JSON.stringify({t:"join",room:x.id})); replyTo=null; $("replyBar").classList.add("hidden"); } }; r.appendChild(b);} }
function setQuota(q){ if(q) $("quota").textContent="ching 今日额度 "+Math.max(0,Math.round(100-q.used/q.cap*100))+"%"; }
function scrollEnd(force){ const b=$("msgs"); if(force||b.scrollHeight-b.scrollTop-b.clientHeight<200) b.scrollTop=b.scrollHeight; }
function addMsg(m,ret){
  if(m.slot==="system"){ const d=el("div","sys",m.text+" · "+fmt(m.ts)); d.id="m"+m.id; if(ret) return d; $("msgs").appendChild(d); return; }
  if(m.del&&!admin){ msgIndex.delete(m.id); if(m.del!=="recalled"||m.slot!==me) return null; const d=el("div","sys","你撤回了一条消息 · "+fmt(m.ts)); d.id="m"+m.id; if(ret) return d; $("msgs").appendChild(d); return; }
  if(!m.del) msgIndex.set(m.id,m); else msgIndex.delete(m.id);
  const ann=m.room===1&&m.slot==="Elephant";
  if(ann&&!m.del){ const card=el("div","annc"+(m.pinned?" pinned":"")); card.id="m"+m.id; const hd=el("div","ah"); hd.appendChild(el("span","ai",m.pinned?"📌 置顶 · 📢 公告":"📢 公告")); hd.appendChild(el("span","at",fmt(m.ts)+(m.edited?" · 已编辑 "+fmt(m.edited):""))); card.appendChild(hd);
    if(m.text) card.appendChild(el("div","abody",m.text));
    if(m.img){ const i=el("img","pic"); i.src="/img/"+m.img; i.alt="图片"; i.onclick=e=>{e.stopPropagation();$("viewerImg").src=i.src;$("viewer").classList.remove("hidden");}; card.appendChild(i); }
    if(admin){ const ac=el("div","aacts"); const eb=el("button",null,"修改"); eb.onclick=()=>openEdit(m); const db=el("button","danger","删除"); db.onclick=()=>{ if(confirm("删除这条公告？删除后彻底消失。")) ws.send(JSON.stringify({t:"delete",id:m.id})); }; const pb=el("button",null,m.pinned?"取消置顶":"置顶"); pb.onclick=()=>ws.send(JSON.stringify({t:"pin",id:m.id,on:!m.pinned})); ac.append(pb,eb,db); card.appendChild(ac); }
    if(ret) return card; $("msgs").appendChild(card); return; }
  const row=el("div","m"+(m.slot===me?" me":"")+(m.slot==="ching"?" ching":"")+(isBot(m.slot)?" botm":"")+(ann?" ann":"")+(m.del?" deleted":"")); row.id="m"+m.id;
  const av=el("img","av"); av.src=avatar(m.slot); av.alt="";
  const box=el("div","box"); const meta=el("div","meta",(ann?"📢 公告 · ":"")+name(m.slot)+(isBot(m.slot)?"":" · "+fmt(m.ts))); if(isBot(m.slot)){ meta.appendChild(el("span","bot","BOT")); meta.appendChild(document.createTextNode(" · "+fmt(m.ts))); } if(m.del) meta.appendChild(el("span","tag",m.del==="deleted"?"已删除":"已撤回")); box.appendChild(meta);
  const b=el("div","b");
  if(m.reply&&msgIndex.has(m.reply)){ const q=msgIndex.get(m.reply); b.appendChild(el("div","quote",name(q.slot)+"："+(q.text||"[图片]"))); }
  if(m.text) b.appendChild(document.createTextNode(m.text));
  if(m.img){ const i=el("img","pic"); i.loading="lazy"; i.src="/img/"+m.img; i.alt="图片"; i.onclick=e=>{e.stopPropagation();$("viewerImg").src=i.src;$("viewer").classList.remove("hidden");}; b.appendChild(i); }
  box.appendChild(b);
  const acts=el("div","acts");
  if(!m.del){
    const rb=el("button",null,"回复"); rb.onclick=e=>{e.stopPropagation();row.classList.remove("open");replyTo=m.id;$("replyTxt").textContent="回复 "+name(m.slot)+"："+(m.text||"[图片]");$("replyBar").classList.remove("hidden");$("text").focus();}; if(curPerm==="rw") acts.appendChild(rb);
    if(m.slot===me){ const x=el("button",null,"撤回"); x.onclick=e=>{e.stopPropagation(); if(confirm("撤回这条消息？")) ws.send(JSON.stringify({t:"recall",id:m.id}));}; acts.appendChild(x); }
    if(admin){ const x=el("button","danger","删除"); x.onclick=e=>{e.stopPropagation(); if(confirm("删除这条消息？其他人将看不到。")) ws.send(JSON.stringify({t:"delete",id:m.id}));}; acts.appendChild(x); }
  }
  if(acts.childNodes.length){ box.appendChild(acts); b.onclick=()=>{ document.querySelectorAll(".m.open").forEach(x=>{if(x!==row)x.classList.remove("open");}); row.classList.toggle("open"); }; }
  row.append(av,box); if(ret) return row; $("msgs").appendChild(row);
}
function openEdit(m){ $("editTxt").value=m.text||""; $("editBox").dataset.id=m.id; $("editBox").classList.remove("hidden"); $("backdrop").classList.remove("hidden"); $("editTxt").focus(); }
function closeEdit(){ $("editBox").classList.add("hidden"); if($("adminPanel").classList.contains("hidden")) $("backdrop").classList.add("hidden"); }
$("editCancel").onclick=closeEdit;
$("editSave").onclick=()=>{ const t=$("editTxt").value.trim(); if(!t) return toast("公告不能为空"); ws.send(JSON.stringify({t:"edit",id:+$("editBox").dataset.id,text:t})); closeEdit(); toast("已保存"); };
document.addEventListener("click",e=>{ if(!e.target.closest(".m")) document.querySelectorAll(".m.open").forEach(x=>x.classList.remove("open")); });
$("viewer").onclick=()=>$("viewer").classList.add("hidden");
$("replyX").onclick=()=>{replyTo=null;$("replyBar").classList.add("hidden");};
let typT=null; function typingShow(s){ clearTimeout(typT); $("typing").textContent=s?name(s)+" 正在输入…":""; if(s) typT=setTimeout(()=>$("typing").textContent="",s==="ching"?30000:4000); }
function seenTxt(s){ const u=presence.users[s]; if(!u) return ""; if(u.online) return "在线"+(u.room?" · #"+u.room:""); return u.seen?"最后在线 "+fmt(u.seen):"从未上线"; }
function renderOnline(){ if(!admin) return; const o=$("online"); o.textContent=""; for(const s of ORDER){ const w=el("span","avw"+(isOn(s)?" on":"")+(presence.mutes[s]?" muted":"")); w.style.setProperty("--c",COLORS[s]); const i=el("img"); i.src="/avatar/"+s+".svg"; i.alt=s; w.title=name(s)+" · "+seenTxt(s)+(presence.mutes[s]?" · 禁言中":""); w.appendChild(i); o.appendChild(w);} }
function send(text,img){ if(!ws||ws.readyState!==1){toast("连接中，请稍候");return false;} ws.send(JSON.stringify({t:"send",text,img,reply:replyTo})); replyTo=null; $("replyBar").classList.add("hidden"); return true; }
$("sendBtn").onclick=()=>{ mentionClose(); const t=$("text").value.trim(); if(!t) return; if(send(t,null)){ $("text").value=""; saveDraft(); } };
$("text").addEventListener("input",()=>{ clearTimeout(saveDraft.t); saveDraft.t=setTimeout(saveDraft,400); });
// ---- @ mention autocomplete ----
let mOpen=false, mItems=[], mSel=0, mTok=null;
const mName = s => isBot(s) ? BOTS[s] : s;   // text inserted after @
// room members: server list, plus admin's own perms view, plus a known-bot fallback for the AI room
function roomMemberSet(){ const set=new Set(members); const r=rooms.find(x=>x.id===curRoom);
  if(r&&r.perms){ set.add("Elephant"); for(const k in r.perms) if(r.perms[k]) set.add(k); }
  if(r&&/^AI\s*对话$/.test(r.name||"")){ set.add("Elephant"); for(const k of Object.keys(BOTS)) set.add(k); }
  return set; }
function mentionCands(){ const seen=new Set(), out=[], ms=roomMemberSet(); for(const s of ["ching",...Object.keys(BOTS),...ORDER]){ if(s===me||seen.has(s)) continue; if(s!=="ching"&&!ms.has(s)) continue; seen.add(s); out.push(s); } return out; }
function fuzzy(q,s){ if(!q) return 1; const hay=[mName(s),s,ZH[s]||""].map(x=>x.toLowerCase()); for(const h of hay){ if(h.startsWith(q)) return 3; } for(const h of hay){ if(h.includes(q)) return 2; } for(const h of hay){ let i=0; for(const c of h){ if(c===q[i]) i++; if(i===q.length) return 1; } } return 0; }
function mentionToken(){ const t=$("text"); if(t.selectionStart!==t.selectionEnd) return null; const pos=t.selectionStart, before=t.value.slice(0,pos); const m=before.match(/(^|[^\w@-])@([^\s@]{0,20})$/); return m?{start:pos-m[2].length-1,end:pos,q:m[2].toLowerCase()}:null; }
function mentionClose(){ mOpen=false; mTok=null; const p=$("mentionPop"); if(p){ p.classList.add("hidden"); p.textContent=""; } }
function mentionUpdate(){ if(curRoom===1||curPerm!=="rw"){ return mentionClose(); } const tok=mentionToken(); if(!tok) return mentionClose();
  const sc=mentionCands().map(s=>[s,fuzzy(tok.q,s)]).filter(x=>x[1]>0); sc.sort((a,b)=>b[1]-a[1]); mItems=sc.map(x=>x[0]); if(!mItems.length) return mentionClose();
  if(!mOpen||!mTok||mTok.q!==tok.q) mSel=0; mTok=tok; mOpen=true; mentionRender(); }
function mentionRender(){ const p=$("mentionPop"); p.textContent=""; mItems.forEach((s,i)=>{ const b=el("button","mi"+(i===mSel?" cur":"")); b.type="button"; b.setAttribute("role","option"); b.setAttribute("aria-selected",i===mSel?"true":"false");
    const im=el("img"); im.src=avatar(s); im.alt=""; b.appendChild(im); b.appendChild(el("span","mn",mName(s))); if(isBot(s)) b.appendChild(el("span","bot","BOT")); else if(s==="ching") b.appendChild(el("span","mz","站内 AI")); else if(ZH[s]) b.appendChild(el("span","mz",ZH[s]));
    b.addEventListener("mousedown",e=>e.preventDefault()); b.addEventListener("pointerdown",e=>{ if(e.pointerType==="mouse") e.preventDefault(); });
    b.onclick=e=>{ e.preventDefault(); e.stopPropagation(); mentionPick(i); }; p.appendChild(b); });
  p.classList.remove("hidden"); const c=p.children[mSel]; if(c&&c.scrollIntoView) try{ c.scrollIntoView({block:"nearest"}); }catch{} }
function mentionPick(i){ const tok=mentionToken()||mTok; const s=mItems[i]; if(!tok||!s) return mentionClose(); const t=$("text"), rest=t.value.slice(tok.end), ins="@"+mName(s)+(/^\s/.test(rest)?"":" ");
  t.value=t.value.slice(0,tok.start)+ins+rest; const pos=tok.start+ins.length+(/^\s/.test(rest)?1:0); mentionClose(); t.focus(); try{ t.setSelectionRange(pos,pos); }catch{} saveDraft(); }
$("text").addEventListener("keydown",e=>{ if(!mOpen||e.isComposing) return;
  if(e.key==="ArrowDown"||e.key==="ArrowUp"){ e.preventDefault(); e.stopImmediatePropagation(); mSel=(mSel+(e.key==="ArrowDown"?1:-1)+mItems.length)%mItems.length; mentionRender(); }
  else if(e.key==="Enter"||e.key==="Tab"){ e.preventDefault(); e.stopImmediatePropagation(); mentionPick(mSel); }
  else if(e.key==="Escape"){ e.preventDefault(); e.stopImmediatePropagation(); mentionClose(); } });
$("text").addEventListener("input",mentionUpdate);
$("text").addEventListener("click",mentionUpdate);
$("text").addEventListener("keyup",e=>{ if(e.key==="ArrowLeft"||e.key==="ArrowRight"||e.key==="Home"||e.key==="End") mentionUpdate(); });
$("text").addEventListener("blur",()=>setTimeout(()=>{ if(document.activeElement!==$("text")) mentionClose(); },150));
$("text").addEventListener("keydown",e=>{ if(e.key==="Enter"&&!e.shiftKey&&!e.isComposing&&!(curRoom===1&&admin)){e.preventDefault();$("sendBtn").click();} else if(Date.now()-lastTyping>3000&&ws&&ws.readyState===1){lastTyping=Date.now();ws.send('{"t":"typing"}');} });
$("imgBtn").onclick=()=>$("file").click();
$("file").onchange=async()=>{ const f=$("file").files[0]; $("file").value=""; if(!f) return;
  if(!/^image\/(jpeg|png|gif|webp)$/.test(f.type)){ toast("只能发送图片，不能发视频或其他文件"); return; }
  let blob=f;
  if(f.type!=="image/gif"||f.size>1024*1024){ try{ blob=await compress(f); }catch{ toast("图片处理失败"); return; } }
  if(blob.size>1024*1024){ toast("图片太大（最大 1MB）"); return; }
  toast("上传中…"); const r=await api("/api/upload?room="+curRoom,blob,true);
  if(r.id) send($("text").value.trim(),r.id), $("text").value=""; else toast(r.error||"上传失败");
};
function compress(f){ return new Promise((res,rej)=>{ const u=URL.createObjectURL(f); const im=new Image(); im.onload=()=>{ URL.revokeObjectURL(u); let w=im.naturalWidth,h=im.naturalHeight; const M=1600; if(w>M||h>M){const k=M/Math.max(w,h);w=Math.round(w*k);h=Math.round(h*k);} const c=document.createElement("canvas"); c.width=w;c.height=h; c.getContext("2d").drawImage(im,0,0,w,h);
  let q=0.85; const go=()=>c.toBlob(b=>{ if(!b) return rej(); if(b.size>1024*1024&&q>0.4){q-=0.15;go();} else res(b); },"image/jpeg",q); go(); }; im.onerror=rej; im.src=u; }); }
$("logoutBtn").onclick=async()=>{ try{localStorage.clear();}catch{} await api("/api/logout"); location.reload(); };

// ---------- admin ----------
function closeAdmin(){ $("adminPanel").classList.add("hidden"); $("backdrop").classList.add("hidden"); }
function done(j,ok){ if(j.ok){ closeAdmin(); toast(ok); } else { $("adminMsg").textContent=j.error||"失败"; } }
$("adminBtn").onclick=()=>{ const p=$("adminPanel"); if(!p.classList.contains("hidden")) return closeAdmin(); renderAdmin(); p.classList.remove("hidden"); $("backdrop").classList.remove("hidden"); if(ws&&ws.readyState===1) ws.send('{"t":"presence"}'); };
$("backdrop").onclick=()=>{ closeAdmin(); closeEdit(); };
document.addEventListener("keydown",e=>{ if(e.key==="Escape") closeAdmin(); });
function renderAdmin(){ const p=$("adminPanel"); const st=p.scrollTop; p.textContent=""; const hd=el("div","phead"); hd.appendChild(el("b",null,"管理面板")); const x=el("button","ghost xbtn","×"); x.setAttribute("aria-label","关闭"); x.onclick=closeAdmin; hd.appendChild(x); p.appendChild(hd); requestAnimationFrame(()=>p.scrollTop=st);
  const msg=el("div",null,""); msg.id="adminMsg";
  const mins=el("select"); [[10,"10分钟"],[60,"1小时"],[1440,"1天"],[10080,"7天"]].forEach(([v,t])=>{const o=el("option",null,t);o.value=v;mins.appendChild(o);});
  const r0=el("div","row"); r0.append(el("span",null,"禁言时长"),mins); p.appendChild(r0);
  p.appendChild(el("h4",null,"成员"));
  for(const s of ORDER){ const r=el("div","row"); const w=el("span","avw sm"+(isOn(s)?" on":"")); w.style.setProperty("--c",COLORS[s]); const im=el("img"); im.src="/avatar/"+s+".svg"; im.alt=""; w.appendChild(im); r.appendChild(w);
    const nm=el("span","who"); nm.appendChild(el("div",null,name(s)+(presence.mutes[s]?" 🔇":""))); nm.appendChild(el("small",isOn(s)?"onl":null,seenTxt(s))); r.appendChild(nm);
    const act=(a,label,confirmTxt)=>{ const b=el("button",a==="kick"?null:"ghost",label); b.onclick=async()=>{ if(confirmTxt&&!confirm(confirmTxt)) return; const j=await api("/api/admin",{action:a,slot:s,minutes:+mins.value}); if(j.code) window.prompt("邮件未配置或发送失败。新邀请码只显示这一次，请复制保存：",j.code); done(j,label+" 成功"+(j.emailed===true?"，新码已发邮箱":j.code?"":j.emailed?"，但邮件发送失败":"")); }; return b; };
    if(s!=="Elephant"){ r.appendChild(presence.mutes[s]?act("unmute","解禁"):act("mute","禁言")); r.appendChild(act("kick","踢出","确定把 "+name(s)+" 踢出？旧邀请码会立即注销，新码发到你邮箱。")); }
    r.appendChild(act("regen","换码","确定为 "+name(s)+" 重新生成邀请码？旧码立即失效，"+(s==="Elephant"?"你自己也会被登出。":"对方会被登出。")));
    p.appendChild(r); }
  p.appendChild(msg);
  // ---- rooms ----
  p.appendChild(el("h4",null,"房间管理"));
  const say=done;
  const nr=el("div","row"); const ni=el("input"); ni.placeholder="新房间名"; ni.maxLength=20; const nb=el("button",null,"新建");
  nb.onclick=async()=>{ const j=await api("/api/admin",{action:"room_create",name:ni.value}); say(j,"已新建（默认只有你能进，可再设权限）"); };
  nr.append(ni,nb); p.appendChild(nr);
  for(const x of rooms){
    const box=el("div"); box.appendChild(el("b",null,"# "+x.name));
    const rr=el("div","row"); const ri=el("input"); ri.value=x.name; ri.maxLength=20; const rb=el("button","ghost","改名");
    rb.onclick=async()=>say(await api("/api/admin",{action:"room_rename",room:x.id,name:ri.value}),"已改名");
    rr.append(ri,rb);
    if(x.id!==1){ const db=el("button",null,"删除"); db.onclick=async()=>{ if(confirm("删除房间「"+x.name+"」及其全部消息？")) say(await api("/api/admin",{action:"room_delete",room:x.id}),"已删除"); }; rr.appendChild(db); }
    box.appendChild(rr);
    const g=el("div","perm"); const sels={};
    for(const s of ORDER.concat(Object.keys(BOTS))){ if(s==="Elephant") continue; g.appendChild(el("span",null,name(s)+(isBot(s)?" 🤖":""))); const sel=el("select"); [["rw","可读写"],["r","只读"],["","不可见"]].forEach(([v,t])=>{const o=el("option",null,t);o.value=v;sel.appendChild(o);}); sel.value=(x.perms&&x.perms[s])||""; sels[s]=sel; g.appendChild(sel); }
    const sb=el("button","savebtn","保存"); sb.onclick=async()=>{ const perms={}; for(const s in sels) if(sels[s].value) perms[s]=sels[s].value; say(await api("/api/admin",{action:"room_perms",room:x.id,perms}),"已保存"); };
    box.append(g,sb); p.appendChild(box);
  }
}
start();
