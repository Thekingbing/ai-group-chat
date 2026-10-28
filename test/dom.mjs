import { JSDOM } from "jsdom"; import fs from "fs";
const html=fs.readFileSync(new URL("../src/index.html",import.meta.url),"utf8"), js=fs.readFileSync(new URL("../src/app.js",import.meta.url),"utf8");
async function run(me,admin,history){
  const dom=new JSDOM(html,{url:"https://chat.example.com/#room=4",runScripts:"outside-only"}); const w=dom.window; let sock;
  w.fetch=async()=>({status:200,json:async()=>({slot:me,admin})}); w.confirm=()=>true;
  w.WebSocket=class{constructor(){sock=this;this.readyState=1;setTimeout(()=>{this.onopen&&this.onopen();},0);}send(){}};
  w.requestAnimationFrame=f=>f(); w.eval(js); await new Promise(r=>setTimeout(r,50));
  sock.onmessage({data:JSON.stringify({t:"rooms",rooms:[{id:1,name:"大厅",perm:"r"},{id:4,name:"newboy",perm:"rw"}]})});
  sock.onmessage({data:JSON.stringify({t:"init",room:4,perm:"rw",history,quota:{used:0,cap:7000}})});
  sock.onmessage({data:JSON.stringify({t:"msg",id:30,room:4,slot:me,text:"live mine",ts:Date.now(),del:""})});
  const rows=[...w.document.querySelectorAll("#msgs > *")].map(e=>e.id+(e.classList.contains("me")?"(right)":"")+(e.classList.contains("deleted")?"(del)":"")+":"+e.textContent.slice(0,40));
  console.log(me,JSON.stringify(rows));
}
const ts=Date.now()-1e5;
await run("Elephant",true,[{id:18,room:4,slot:"Tiger",text:"你好你好",del:"deleted",ts},{id:19,room:4,slot:"Elephant",text:"你好",del:"",ts},{id:20,room:4,slot:"Tiger",text:"rec",del:"recalled",ts}]);
await run("Tiger",false,[{id:19,room:4,slot:"Elephant",text:"你好",del:"",ts},{id:20,room:4,slot:"Tiger",del:"recalled",ts},{id:21,room:4,slot:"Tiger",text:"mine",del:"",ts}]);
process.exit(0);
