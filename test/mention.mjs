import { JSDOM } from "jsdom"; import fs from "fs";
const html=fs.readFileSync(new URL("../src/index.html",import.meta.url),"utf8"), js=fs.readFileSync(new URL("../src/app.js",import.meta.url),"utf8");
let ok=0,bad=0; const t=(n,c,x="")=>{ if(c){ok++;console.log("PASS",n);} else {bad++;console.log("FAIL",n,x);} };
async function setup(me,admin,room,perm,members){
  const dom=new JSDOM(html,{url:"https://chat.example.com/#room="+room,runScripts:"outside-only",pretendToBeVisual:true}); const w=dom.window; let sock; const sent=[];
  w.fetch=async()=>({status:200,json:async()=>({slot:me,admin})}); w.confirm=()=>true;
  w.WebSocket=class{constructor(){sock=this;this.readyState=1;setTimeout(()=>{this.onopen&&this.onopen();},0);}send(d){sent.push(JSON.parse(d));}};
  w.requestAnimationFrame=f=>f(); w.eval(js); await new Promise(r=>setTimeout(r,50));
  sock.onmessage({data:JSON.stringify({t:"rooms",rooms:[{id:1,name:"大厅",perm:admin?"rw":"r"},{id:10,name:"AI 对话",perm:"rw"},{id:4,name:"x",perm:"rw"}]})});
  sock.onmessage({data:JSON.stringify({t:"init",room,perm,history:[],members,quota:{used:0,cap:7000}})});
  const d=w.document, ta=d.getElementById("text"), pop=d.getElementById("mentionPop");
  const type=(v,pos)=>{ ta.value=v; const p=pos??v.length; ta.focus(); ta.setSelectionRange(p,p); ta.dispatchEvent(new w.Event("input",{bubbles:true})); };
  const key=(k,o={})=>{ const e=new w.KeyboardEvent("keydown",{key:k,bubbles:true,cancelable:true,...o}); ta.dispatchEvent(e); return e; };
  const items=()=>[...pop.querySelectorAll(".mi")].map(b=>b.querySelector(".mn").textContent+(b.querySelector(".bot")?"[BOT]":""));
  const open=()=>!pop.classList.contains("hidden");
  return {w,d,ta,pop,type,key,items,open,sent,sock};
}
const AIM=["Elephant","grok","muse","GPT","DeepSeek","cue","Lion"];
{ const s=await setup("Elephant",true,10,"rw",AIM);
  s.type("@"); t("@ opens", s.open()); const it=s.items(); console.log(JSON.stringify(it));
  t("list = ching + 5 bots + Lion, no self", JSON.stringify(it)===JSON.stringify(["ching","grok[BOT]","muse-ching[BOT]","GPT[BOT]","DeepSeek[BOT]","cue[BOT]","Lion"]));
  t("avatars", [...s.pop.querySelectorAll(".mi img")].map(i=>i.getAttribute("src")).join()==="/avatar/ching.svg,/avatar/grok.svg,/avatar/muse.svg,/avatar/GPT.svg,/avatar/DeepSeek.svg,/avatar/cue.svg,/avatar/Lion.svg");
  s.type("你好 @DE"); t("filter case-insensitive", JSON.stringify(s.items())===JSON.stringify(["DeepSeek[BOT]"]), JSON.stringify(s.items()));
  s.type("@ch"); t("prefix first ch -> ching then muse-ching", s.items()[0]==="ching" && s.items().includes("muse-ching[BOT]"), JSON.stringify(s.items()));
  s.type("@mc"); t("fuzzy subsequence mc -> muse-ching", s.items().includes("muse-ching[BOT]"), JSON.stringify(s.items()));
  s.type("@狮"); t("chinese alias", JSON.stringify(s.items())===JSON.stringify(["Lion"]));
  s.type("@zzz"); t("no match closes", !s.open());
  s.type("a@b"); t("email-like no popup", !s.open());
  // keyboard
  s.type("hi @g"); const e1=s.key("ArrowDown"); t("arrow prevented", e1.defaultPrevented);
  const sel=s.pop.querySelector(".mi.cur .mn").textContent; s.key("Enter");
  t("enter picks (no send)", s.ta.value==="hi @"+sel+" " && !s.sent.some(m=>m.t==="send"), s.ta.value+" | "+sel);
  t("caret after", s.ta.selectionStart===s.ta.value.length);
  s.type("@gr"); s.key("Tab"); t("tab picks", s.ta.value==="@grok ");
  s.type("x @mu y",5); t("mid-text token", s.open()); s.key("Enter"); t("mid-text replace", s.ta.value==="x @muse-ching y" && s.ta.selectionStart===14, JSON.stringify(s.ta.value));
  s.type("@"); s.key("Escape"); t("esc closes", !s.open()); s.key("Enter"); t("enter after esc sends", s.sent.some(m=>m.t==="send"&&m.text==="@"));
  // click
  s.type("@cu"); const b=s.pop.querySelector(".mi"); const md=new s.w.MouseEvent("mousedown",{bubbles:true,cancelable:true}); b.dispatchEvent(md); t("mousedown prevented (keeps focus)", md.defaultPrevented); b.click();
  t("click picks", s.ta.value==="@cue ");
  // members update
}
{ const s=await setup("Lion",false,4,"rw",["Elephant","Lion"]); s.sock.onmessage({data:JSON.stringify({t:"members",room:4,members:["Elephant","Lion","grok"]})}); s.type("@"); t("members update", JSON.stringify(s.items())===JSON.stringify(["ching","grok[BOT]","Elephant"]), JSON.stringify(s.items())); }
{ const s=await setup("Elephant",true,10,"rw",undefined); s.type("@"); t("fallback: AI room w/o server members", JSON.stringify(s.items())===JSON.stringify(["ching","grok[BOT]","muse-ching[BOT]","GPT[BOT]","DeepSeek[BOT]","cue[BOT]"]), JSON.stringify(s.items())); t("requests members when missing", s.sent.some(m=>m.t==="members")); }
{ const s=await setup("Elephant",true,1,"rw",["Elephant","Lion","Tiger"]); s.type("@"); t("hall: no popup (admin)", !s.open()); }
{ const s=await setup("Lion",false,4,"rw",["Elephant","Lion","Tiger"]); s.type("@"); t("normal room member list", JSON.stringify(s.items())===JSON.stringify(["ching","Elephant","Tiger"]), JSON.stringify(s.items())); }
{ const s=await setup("Lion",false,4,"r",["Elephant","Lion"]); s.type("@"); t("read-only no popup", !s.open()); }
console.log(`\n${ok} pass, ${bad} fail`); process.exit(bad?1:0);
