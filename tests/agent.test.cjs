"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const os=require("node:os");
const path=require("node:path");
const {spawn}=require("node:child_process");
const agent=require("../lib/agent.js");
const doc=()=>({title:"Paper notes",preamble:"\\newcommand{\\R}{\\mathbb{R}}",blocks:[
  {id:"t1",type:"text",src:"Intro text"},{id:"d1",type:"ink",strokes:[]},{id:"t2",type:"text",src:"Second\nline",beside:true},{id:"i1",type:"image",data:"data:image/png;base64,AA",caption:"Fig"}]});
let n=0;const makeId=()=>"new"+(++n);
const parse=(files,d=doc())=>agent.parseNote({...agent.exportNote(d),...files},d,makeId);
test("export lists blocks as markers and never includes drawing or image data",()=>{
  const files=agent.exportNote(doc(),{paperTitle:"A Paper",authors:["Ada Lovelace"]});
  assert.equal(files["note.tex"],"%%% block t1 text\nIntro text\n%%% block d1 drawing\n%%% block t2 text\nSecond\nline\n%%% block i1 image caption: Fig\n");
  assert.doesNotMatch(files["note.tex"],/base64|strokes/);
  assert.match(files["context.txt"],/A Paper[\s\S]*Ada Lovelace/);
});
test("an untouched export parses to no changes and keeps every original block object",()=>{
  const d=doc(),p=agent.parseNote(agent.exportNote(d),d,makeId);
  assert.deepEqual(p.changes,[]);assert.deepEqual(p.blocks,d.blocks);assert.equal(p.blocks[2].beside,true);
});
test("modified, added and removed text blocks are reported; drawings and images are preserved",()=>{
  const files=agent.exportNote(doc());
  const p=parse({"note.tex":files["note.tex"].replace("Intro text","Better intro").replace("%%% block t2 text\nSecond\nline\n","%%% block new text\nInserted $x$\n")});
  assert.deepEqual(p.changes.map(c=>c.kind).sort(),["added","modified","removed"]);
  assert.equal(p.blocks[0].src,"Better intro");assert.equal(p.blocks.find(b=>b.src==="Inserted $x$").id.startsWith("new"),true);
  assert.equal(p.blocks.some(b=>b.id==="t2"),false);assert.ok(p.blocks.find(b=>b.id==="d1")&&p.blocks.find(b=>b.id==="i1"));
});
test("deleted drawing markers are restored in place and edits to drawing placeholders are ignored",()=>{
  const removed=parse({"note.tex":"%%% block t1 text\nIntro text\n%%% block t2 text\nSecond\nline\n%%% block i1 image caption: Fig\n"});
  assert.deepEqual(removed.blocks.map(b=>b.id),["t1","d1","t2","i1"]);
  const hacked=parse({"note.tex":agent.exportNote(doc())["note.tex"].replace("%%% block d1 drawing","%%% block d1 drawing\nHACKED")});
  assert.deepEqual(hacked.blocks.find(b=>b.id==="d1"),{id:"d1",type:"ink",strokes:[]});assert.deepEqual(hacked.changes,[]);
});
test("title, preamble and reordering are surfaced; damaged files are rejected",()=>{
  const p=parse({"title.txt":"New title\nignored\n","preamble.tex":"\\newcommand{\\N}{\\mathbb{N}}\n"});
  assert.equal(p.title,"New title");assert.deepEqual(p.changes.map(c=>c.kind).sort(),["preamble","title"]);
  const swapped=parse({"note.tex":"%%% block t2 text\nSecond\nline\n%%% block d1 drawing\n%%% block t1 text\nIntro text\n%%% block i1 image caption: Fig\n"});
  assert.ok(swapped.changes.some(c=>c.kind==="moved"));
  assert.throws(()=>parse({"note.tex":"just rewritten prose"}),/without block markers/);
  assert.throws(()=>agent.parseNote({},doc(),makeId),/removed note\.tex/);
});
test("claude and codex command lines restrict tools, resume sessions and read the prompt from stdin",()=>{
  const first=agent.commandLine("claude"),again=agent.commandLine("claude",{sessionId:"s1",model:"opus"});
  assert.deepEqual(first.slice(first.indexOf("--tools"),first.indexOf("--tools")+2),["--tools","Read,Edit,Write,Glob,Grep"]);
  assert.ok(first.includes("--setting-sources")&&first.includes("--strict-mcp-config"));assert.ok(!first.includes("Bash"));
  assert.deepEqual(again.slice(-4),["--model","opus","--resume","s1"]);
  const cx=agent.commandLine("codex"),cr=agent.commandLine("codex",{sessionId:"abc"});
  assert.equal(cx.at(-1),"-");assert.ok(cx.join(" ").includes('sandbox_mode="workspace-write"'));
  assert.deepEqual(cr.slice(0,2),["exec","resume"]);assert.deepEqual(cr.slice(-2),["abc","-"]);
  assert.throws(()=>agent.commandLine("bash"),/Unknown assistant/);
});
test("event parsers read replies, sessions, progress and failures for both CLIs",()=>{
  const c={};
  assert.equal(agent.parseEvent("claude",JSON.stringify({type:"assistant",session_id:"s",message:{content:[{type:"tool_use",name:"Edit"}]}}),c),"Editing the note…");
  agent.parseEvent("claude",JSON.stringify({type:"assistant",message:{content:[{type:"text",text:"hi"}]}}),c);
  agent.parseEvent("claude",JSON.stringify({type:"result",subtype:"success",result:"final"}),c);
  assert.deepEqual([c.sessionId,c.reply,c.done],["s","final",true]);
  const bad={};agent.parseEvent("claude",JSON.stringify({type:"result",subtype:"error_max_turns",is_error:true,result:"boom"}),bad);assert.equal(bad.error,"boom");
  const x={};
  agent.parseEvent("codex",JSON.stringify({type:"thread.started",thread_id:"th"}),x);
  assert.equal(agent.parseEvent("codex",JSON.stringify({type:"item.started",item:{type:"file_change"}}),x),"Editing the note…");
  agent.parseEvent("codex",JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"done"}}),x);
  agent.parseEvent("codex",JSON.stringify({type:"turn.completed"}),x);
  assert.deepEqual([x.sessionId,x.reply,x.done],["th","done",true]);
  const f={};agent.parseEvent("codex",JSON.stringify({type:"turn.failed",error:{message:"nope"}}),f);assert.equal(f.error,"nope");
  assert.equal(agent.parseEvent("codex","not json",{}),null);
});
// A Subprocess/IOUtils/PathUtils shim over node so the real runtime runs against a fake CLI.
function shims(tmp) {
  const Subprocess={async call({command,arguments:args,workdir,environment}){
    const child=spawn(command,args,{cwd:workdir,env:{...process.env,...environment}});
    let ended=false;const exit=new Promise(r=>child.on("close",code=>{ended=true;r({exitCode:code??1});}));
    const queue=[];let waiter=null,done=false;
    const push=v=>{if(waiter){waiter(v);waiter=null;}else queue.push(v);};
    child.stdout.on("data",d=>push(d.toString()));child.stderr.on("data",d=>push(d.toString()));child.on("close",()=>{done=true;push("");});
    return {stdin:{write:async v=>{child.stdin.write(v);},close:async()=>{child.stdin.end();}},
      stdout:{readString:()=>queue.length?Promise.resolve(queue.shift()):done?Promise.resolve(""):new Promise(r=>{waiter=r;})},
      wait:()=>exit,kill:()=>child.kill("SIGKILL")};}};
  const IOUtils={write:async(p,b)=>fs.writeFileSync(p,Buffer.from(b)),exists:async p=>fs.existsSync(p),makeDirectory:async p=>fs.mkdirSync(p,{recursive:true}),writeUTF8:async(p,t)=>fs.writeFileSync(p,t),readUTF8:async p=>fs.readFileSync(p,"utf8"),remove:async p=>fs.rmSync(p,{recursive:true,force:true})};
  const PathUtils={join:(...p)=>path.join(...p),parent:p=>path.dirname(p)};
  return {Subprocess,IOUtils,PathUtils};
}
function fakeCli(tmp,body) {
  const file=path.join(tmp,"fake-claude");
  fs.writeFileSync(file,`#!/usr/bin/env node\nconst fs=require("fs");let input="";process.stdin.on("data",d=>input+=d).on("end",()=>{${body}});\n`,{mode:0o755});
  return file;
}
test("the runtime pipes the prompt, streams events, resumes the session and returns a proposal",async()=>{
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),"noctua-agent-test-"));
  const cli=fakeCli(tmp,`
    const resumed=process.argv.includes("--resume");
    let t=fs.readFileSync("note.tex","utf8").replace("Intro text","Edited by "+(resumed?"resume":"first")+": "+(input.includes("Request:")?"ok":"no prompt"));
    fs.writeFileSync("note.tex",t);
    console.log(JSON.stringify({type:"system",session_id:"sess-1"}));
    console.log(JSON.stringify({type:"assistant",message:{content:[{type:"tool_use",name:"Edit"}]}}));
    console.log(JSON.stringify({type:"result",subtype:"success",result:"All set",session_id:"sess-1"}));`);
  const rt=agent.create({...shims(tmp),Zotero:{Prefs:{get:key=>key.endsWith("agent.claudePath")?cli:""}},tempBase:tmp,home:tmp,env:{PATH:process.env.PATH},makeId});
  const seen=[];
  const first=await rt.run({provider:"claude",sessionKey:"tab1",message:"improve intro",doc:doc(),context:{},onProgress:s=>seen.push(s)}).promise;
  assert.equal(first.reply,"All set");assert.deepEqual(seen,["Editing the note…"]);
  assert.equal(first.proposal.blocks[0].src,"Edited by first: ok");assert.equal(first.proposal.changes[0].kind,"modified");
  const second=await rt.run({provider:"claude",sessionKey:"tab1",message:"again",doc:first.proposal,context:{}}).promise;
  assert.match(second.proposal.blocks[0].src,/Edited by first/);
  const providers=await rt.providers();assert.equal(providers.find(p=>p.id==="claude").path,cli);
  await rt.cleanup("tab1");assert.equal(fs.readdirSync(tmp).some(n=>n.startsWith("noctua-agent-tab1")),false);
});
test("the runtime reports missing CLIs, sign-in errors and cancellation",async()=>{
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),"noctua-agent-test-"));
  const make=cli=>agent.create({...shims(tmp),Zotero:{Prefs:{get:key=>key.endsWith("agent.claudePath")?cli:""}},tempBase:tmp,home:tmp,env:{PATH:process.env.PATH},makeId});
  await assert.rejects(make(path.join(tmp,"missing")).run({provider:"claude",sessionKey:"a",message:"x",doc:doc(),context:{}}).promise,/CLI not found/);
  const login=fakeCli(tmp,`console.log(JSON.stringify({type:"result",subtype:"error",is_error:true,result:"Please run /login"}));process.exit(1);`);
  await assert.rejects(make(login).run({provider:"claude",sessionKey:"b",message:"x",doc:doc(),context:{}}).promise,/not signed in/);
  const slow=fakeCli(tmp,`setTimeout(()=>{},30000);`);
  const job=make(slow).run({provider:"claude",sessionKey:"c",message:"x",doc:doc(),context:{}});
  setTimeout(()=>job.cancel(),300);
  await assert.rejects(job.promise,{code:"NOCTUA_CANCELLED"});
});

test("attachments get safe unique names, enforce limits and are written beside the note",async()=>{
  const b64=Buffer.from("hello").toString("base64");
  const names=agent.attachmentNames([{name:"../../etc/passwd",data:b64},{name:"a b.png",type:"image/png",data:b64},{name:"a b.png",data:b64},{name:".hidden",data:b64}]);
  assert.deepEqual(names.map(n=>n.name),["passwd","a b.png","a b-2.png","hidden"]);
  assert.equal(names[1].path,"attachments/a b.png");
  assert.throws(()=>agent.attachmentNames(Array.from({length:9},()=>({name:"x",data:b64}))),/at most 8/);
  assert.throws(()=>agent.attachmentNames([{name:"big",data:"A".repeat(15*1024*1024)}]),/10 MB/);
  assert.match(agent.buildPrompt("hi",names),/attachments\/a b\.png \(image\/png\)/);
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),"noctua-agent-test-"));
  const cli=fakeCli(tmp,`
    const ok=fs.readFileSync("attachments/note.txt","utf8")==="hello"&&input.includes("attachments/note.txt");
    let t=fs.readFileSync("note.tex","utf8").replace("Intro text",ok?"saw attachment":"missing");fs.writeFileSync("note.tex",t);
    console.log(JSON.stringify({type:"result",subtype:"success",result:"done",session_id:"s"}));`);
  const rt=agent.create({...shims(tmp),Zotero:{Prefs:{get:key=>key.endsWith("agent.claudePath")?cli:""}},tempBase:tmp,home:tmp,env:{PATH:process.env.PATH},makeId});
  const result=await rt.run({provider:"claude",sessionKey:"att",message:"read it",doc:doc(),context:{},attachments:[{name:"note.txt",type:"text/plain",data:b64}]}).promise;
  assert.equal(result.proposal.blocks[0].src,"saw attachment");
  await rt.cleanup("att");
});
