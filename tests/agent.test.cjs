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
  const IOUtils={getChildren:async p=>fs.readdirSync(p).map(n=>path.join(p,n)),stat:async p=>({type:fs.statSync(p).isDirectory()?"directory":"regular"}),write:async(p,b)=>fs.writeFileSync(p,Buffer.from(b)),exists:async p=>fs.existsSync(p),makeDirectory:async p=>fs.mkdirSync(p,{recursive:true}),writeUTF8:async(p,t)=>fs.writeFileSync(p,t),readUTF8:async p=>fs.readFileSync(p,"utf8"),remove:async p=>fs.rmSync(p,{recursive:true,force:true})};
  const PathUtils={join:(...p)=>path.join(...p),parent:p=>path.dirname(p),filename:p=>path.basename(p)};
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

test("model and reasoning choices reach each CLI as safe tokens only",()=>{
  const c=agent.commandLine("claude",{model:"fable",effort:"xhigh",sessionId:"s1"});
  assert.deepEqual(c.slice(c.indexOf("--effort"),c.indexOf("--effort")+4),["--effort","xhigh","--model","fable"]);
  assert.deepEqual(c.slice(-2),["--resume","s1"]);
  const x=agent.commandLine("codex",{model:"gpt-6-astra",effort:"high"});
  assert.ok(x.join(" ").includes('model_reasoning_effort="high"'));assert.deepEqual(x.slice(x.indexOf("-m"),x.indexOf("-m")+2),["-m","gpt-6-astra"]);
  assert.ok(!agent.commandLine("claude",{model:"x; rm -rf /",effort:"extreme"}).some(a=>a.includes("rm -rf")||a==="extreme"));
  assert.ok(!agent.commandLine("codex",{model:"$(evil)",effort:"\" ; \""}).join(" ").includes("evil"));
  assert.ok(!agent.commandLine("claude").includes("--effort"));
});
test("the codex catalog is read from `codex debug models`, hidden models are dropped and claude lists its aliases",async()=>{
  const catalog={models:[
    {slug:"gpt-b",display_name:"GPT B",visibility:"list",priority:2,default_reasoning_level:"medium",supported_reasoning_levels:[{effort:"low"},{effort:"medium"},{effort:"bogus"}]},
    {slug:"gpt-a",display_name:"GPT A",visibility:"list",priority:1,default_reasoning_level:"low",supported_reasoning_levels:[{effort:"low"},{effort:"xhigh"}]},
    {slug:"hidden",display_name:"Hidden",visibility:"hide",priority:0,supported_reasoning_levels:[]}]};
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),"noctua-agent-test-"));
  const cli=path.join(tmp,"fake-codex");
  fs.writeFileSync(cli,`#!/usr/bin/env node\nif(process.argv[2]==="debug"&&process.argv[3]==="models")console.log(${JSON.stringify(JSON.stringify(catalog))});`,{mode:0o755});
  const rt=agent.create({...shims(tmp),Zotero:{Prefs:{get:key=>key.endsWith("agent.codexPath")?cli:key.endsWith("agent.claudePath")?path.join(tmp,"no-such-claude"):""}},tempBase:tmp,home:tmp,env:{PATH:process.env.PATH},makeId});
  const list=await rt.models("codex");
  assert.deepEqual(list.map(m=>m.id),["gpt-a","gpt-b"]);
  assert.deepEqual(list[1].efforts,["low","medium"]);assert.equal(list[0].defaultEffort,"low");
  assert.deepEqual((await rt.models("claude")).map(m=>m.id),["fable","opus","sonnet","haiku"]);
  assert.deepEqual((await rt.models("claude"))[0].efforts,["low","medium","high","xhigh","max"]);
  await assert.rejects(rt.models("bash"),/Unknown assistant/);
});

test("paper mode exports page-marked text, metadata and highlights, and reads the paper with read-only tools",async()=>{
  const files=agent.exportPaper({title:"LeWM",authors:["Maes","LeCun"],year:"2026",doi:"10.1/x",text:"Page one text\fPage two text",
    annotations:[{page:"2",type:"highlight",text:"key claim",comment:"check"}]});
  assert.match(files["paper.txt"],/\[Page 1\]\nPage one text\n\n\[Page 2\]\nPage two text/);
  assert.match(files["context.txt"],/Title: LeWM[\s\S]*Authors: Maes; LeCun[\s\S]*DOI: 10\.1\/x/);
  assert.match(files["annotations.txt"],/p\.2 \[highlight\] "key claim" — comment: check/);
  assert.ok(!("annotations.txt" in agent.exportPaper({text:"x"})));
  const long=agent.exportPaper({text:"a".repeat(agent.MAX_PAPER_CHARS+10)});assert.match(long["paper.txt"],/Text truncated/);
  const prompt=agent.buildPaperPrompt("What is the main claim?",[],true);
  assert.match(prompt,/read-only/);assert.match(prompt,/annotations\.txt/);assert.match(prompt,/What is the main claim\?$/);
  const ro=agent.commandLine("claude",{readOnly:true});
  assert.equal(ro[ro.indexOf("--tools")+1],"Read,Glob,Grep");assert.ok(!ro.join(" ").includes("Edit"));
  assert.ok(agent.commandLine("codex",{readOnly:true}).join(" ").includes('sandbox_mode="read-only"'));
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),"noctua-agent-test-"));
  const cli=fakeCli(tmp,`
    const text=fs.readFileSync("paper.txt","utf8"),ctx=fs.readFileSync("context.txt","utf8");
    const tools=process.argv[process.argv.indexOf("--tools")+1];
    console.log(JSON.stringify({type:"result",subtype:"success",result:"tools="+tools+";page2="+text.includes("[Page 2]")+";meta="+ctx.includes("LeWM")+";prompt="+input.includes("reading assistant")+";noNote="+!fs.existsSync("note.tex"),session_id:"p1"}));`);
  const rt=agent.create({...shims(tmp),Zotero:{Prefs:{get:key=>key.endsWith("agent.claudePath")?cli:""}},tempBase:tmp,home:tmp,env:{PATH:process.env.PATH},makeId});
  const result=await rt.run({provider:"claude",sessionKey:"paper-1",message:"summarize",mode:"paper",paper:async()=>({title:"LeWM",text:"one\ftwo"})}).promise;
  assert.equal(result.reply,"tools=Read,Glob,Grep;page2=true;meta=true;prompt=true;noNote=true");
  assert.equal(result.proposal,null);
  await rt.cleanup("paper-1");
});

test("installed skills are discovered per provider, parsed, and only real ones are injected into the prompt",async()=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),"noctua-skills-"));
  const skill=(dir,name,description,body)=>{fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,"SKILL.md"),`---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`);};
  skill(path.join(home,".claude","skills","grill-me"),"grill-me","Ask hard questions.","Interrogate the plan.");
  skill(path.join(home,".claude","plugins","synced","a","skills","plan-change"),"plan-change","Plan a change.","Make a plan.");
  skill(path.join(home,".agents","skills","shared-tool"),"shared-tool","Shared helper.","Do shared things.");
  skill(path.join(home,".codex","skills","codex-only"),"codex-only","Only for Codex.","Codex body.");
  fs.mkdirSync(path.join(home,".claude","skills","grill-me","references","nested"),{recursive:true});
  skill(path.join(home,".claude","skills","grill-me","references","nested"),"not-a-skill","Resource, not a skill.","x");
  const rt=agent.create({...shims(home),Zotero:{Prefs:{get:key=>key.endsWith("agent.claudePath")?path.join(home,"fake"):""}},tempBase:home,home,env:{PATH:process.env.PATH},makeId});
  assert.deepEqual((await rt.skills("claude")).map(s=>s.name),["grill-me","plan-change","shared-tool"]);
  assert.deepEqual((await rt.skills("codex")).map(s=>s.name),["codex-only","shared-tool"]);
  assert.equal((await rt.skills("claude"))[0].description,"Ask hard questions.");
  await assert.rejects(rt.skills("bash"),/Unknown assistant/);
  const parsed=agent.parseSkill("---\nname: x\ndescription: \"quoted\"\n---\nBody here\n");
  assert.deepEqual([parsed.name,parsed.description,parsed.body.trim()],["x","quoted","Body here"]);
  assert.equal(agent.parseSkill("no front matter").body,"no front matter");
  const prompt=agent.buildPrompt("Do it",[],[{name:"grill-me",body:"Interrogate the plan."}]);
  assert.match(prompt,/### Skill: grill-me\nInterrogate the plan\./);assert.ok(prompt.indexOf("Skill: grill-me")<prompt.indexOf("Request:"));
  assert.match(agent.buildPaperPrompt("Q",[],false,[{name:"s",body:"B"}]),/### Skill: s/);
  assert.ok(!/Skill:/.test(agent.buildPrompt("Do it")));
  const cli=fakeCli(home,`
    const sawSkill=input.includes("### Skill: grill-me")&&input.includes("Interrogate the plan.");
    const sawFake=input.includes("not-a-skill")||input.includes("../etc");
    console.log(JSON.stringify({type:"result",subtype:"success",result:"skill="+sawSkill+" fake="+sawFake,session_id:"s"}));`);
  const rt2=agent.create({...shims(home),Zotero:{Prefs:{get:key=>key.endsWith("agent.claudePath")?cli:""}},tempBase:home,home,env:{PATH:process.env.PATH},makeId});
  const result=await rt2.run({provider:"claude",sessionKey:"sk",message:"go",doc:doc(),context:{},skills:["grill-me","not-a-skill","../etc/passwd"]}).promise;
  assert.equal(result.reply,"skill=true fake=false");
  await rt2.cleanup("sk");
});

test("Claude's model list comes from the account's own cache, with per-model reasoning limits",async()=>{
  const cache={modelAccessCache:[
    {apiName:"claude-3-opus-20240229",entitled:true},{apiName:"claude-fable-5-1",entitled:true},{apiName:"claude-fable-5",entitled:true},
    {apiName:"claude-opus-4-1-20250805-claude-ai",entitled:true},{apiName:"claude-opus-5-5",entitled:true},{apiName:"claude-opus-5",entitled:true},
    {apiName:"claude-sonnet-5-5",entitled:true,maxEffortLevel:"medium"},{apiName:"claude-haiku-5-5",entitled:true},
    {apiName:"claude-secret-9",entitled:false},{apiName:"bad name; rm",entitled:true}]};
  const list=agent.parseClaudeModels(cache);
  assert.deepEqual(list.map(m=>m.id),["claude-fable-5-1","claude-fable-5","claude-opus-5-5","claude-opus-5","claude-opus-4-1-20250805-claude-ai","claude-opus-3-opus-20240229".replace("claude-opus-3-opus","claude-3-opus"),"claude-sonnet-5-5","claude-haiku-5-5"].filter(Boolean));
  assert.equal(list.find(m=>m.id==="claude-opus-5-5").label,"Claude Opus 5.5");
  assert.equal(list.find(m=>m.id==="claude-fable-5-1").label,"Claude Fable 5.1");
  assert.deepEqual(list.find(m=>m.id==="claude-sonnet-5-5").efforts,["low","medium"]);
  assert.deepEqual(list.find(m=>m.id==="claude-opus-5-5").efforts,["low","medium","high","xhigh","max"]);
  assert.deepEqual(agent.parseClaudeModels({}),[]);
  const home=fs.mkdtempSync(path.join(os.tmpdir(),"noctua-claude-home-"));
  fs.writeFileSync(path.join(home,".claude.json"),JSON.stringify(cache));
  const rt=agent.create({...shims(home),Zotero:{Prefs:{get:key=>key.endsWith("agent.claudePath")?path.join(home,"no-such-claude"):""}},tempBase:home,home,env:{PATH:process.env.PATH},makeId});
  assert.equal((await rt.models("claude"))[0].id,"claude-fable-5-1");
});
test("Codex Fast mode is read from the model catalog and sent as an explicit service tier",()=>{
  const list=agent.parseCodexModels({models:[
    {slug:"a",display_name:"A",visibility:"list",priority:1,supported_reasoning_levels:[{effort:"high"},{effort:"ultra"}],service_tiers:[{id:"priority",name:"Fast",description:"2x speed, increased usage"}]},
    {slug:"b",display_name:"B",visibility:"list",priority:2,supported_reasoning_levels:[{effort:"low"}],service_tiers:[]}]});
  assert.equal(list[0].fast,true);assert.equal(list[0].fastNote,"2x speed, increased usage");assert.equal(list[1].fast,false);
  assert.deepEqual(list[0].efforts,["high","ultra"]);
  const on=agent.commandLine("codex",{fast:true}).join(" "),off=agent.commandLine("codex",{fast:false}).join(" "),unset=agent.commandLine("codex").join(" ");
  assert.ok(on.includes('service_tier="priority"'));assert.ok(off.includes('service_tier="default"'));assert.ok(!unset.includes("service_tier"));
  assert.ok(!agent.commandLine("claude",{fast:true}).join(" ").includes("service_tier"));
});

test("a note assistant can read the paper it belongs to, without that text ever becoming part of the proposal",async()=>{
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),"noctua-agent-test-"));
  const cli=fakeCli(tmp,`
    const paper=fs.existsSync("paper.txt")?fs.readFileSync("paper.txt","utf8"):"";
    const ann=fs.existsSync("annotations.txt");
    const note=fs.readFileSync("note.tex","utf8");
    fs.writeFileSync("paper.txt","TAMPERED");  // a stray edit must not reach the note
    const saw="paper="+paper.includes("[Page 2]")+" annotations="+ann+" prompt="+input.includes("paper.txt: the full text")+" ctx="+fs.readFileSync("context.txt","utf8").includes("Paper:")+" note="+note.includes("Intro text");
    console.log(JSON.stringify({type:"result",subtype:"success",result:saw,session_id:"n1"}));`);
  const rt=agent.create({...shims(tmp),Zotero:{Prefs:{get:key=>key.endsWith("agent.claudePath")?cli:""}},tempBase:tmp,home:tmp,env:{PATH:process.env.PATH},makeId});
  const ctx={paperTitle:"LeWM",authors:["Maes"]};
  const withPaper=await rt.run({provider:"claude",sessionKey:"np",message:"use the paper",doc:doc(),context:ctx,
    paper:async()=>({title:"LeWM",text:"one\ftwo",annotations:[{page:"1",type:"highlight",text:"x"}]})}).promise;
  assert.equal(withPaper.reply,"paper=true annotations=true prompt=true ctx=true note=true");
  assert.equal(withPaper.proposal.changes.length,0);
  const broken=await rt.run({provider:"claude",sessionKey:"np2",message:"hi",doc:doc(),context:ctx,paper:async()=>{throw new Error("no PDF");}}).promise;
  assert.equal(broken.reply,"paper=false annotations=false prompt=false ctx=true note=true");
  const none=await rt.run({provider:"claude",sessionKey:"np3",message:"hi",doc:doc(),context:ctx}).promise;
  assert.equal(none.reply,"paper=false annotations=false prompt=false ctx=true note=true");
  await rt.cleanup();
});

test("a Node-script `codex` is replaced by the native binary it wraps, which is what actually runs",async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"noctua-codex-"));
  const pkg=path.join(root,"lib","node_modules","@openai","codex");
  const native=path.join(pkg,"node_modules","@openai","codex-darwin-arm64","vendor","aarch64-apple-darwin","bin");
  fs.mkdirSync(path.join(pkg,"bin"),{recursive:true});fs.mkdirSync(native,{recursive:true});fs.mkdirSync(path.join(root,"bin"));
  const wrapper=path.join(pkg,"bin","codex.js");
  fs.writeFileSync(wrapper,"#!/usr/bin/env node\nconsole.error('wrapper must not run');process.exit(9);\n",{mode:0o755});
  fs.symlinkSync(wrapper,path.join(root,"bin","codex"));
  const catalog={models:[{slug:"native-ok",display_name:"Native OK",visibility:"list",priority:1,supported_reasoning_levels:[{effort:"low"}],service_tiers:[{id:"priority",name:"Fast"}]}]};
  fs.writeFileSync(path.join(native,"codex"),`#!/usr/bin/env node\nif(process.argv[2]==="debug")console.log(${JSON.stringify(JSON.stringify(catalog))});`,{mode:0o755});
  const rt=agent.create({...shims(root),realpath:p=>fs.realpathSync(p),Zotero:{Prefs:{get:key=>key.endsWith("agent.codexPath")?path.join(root,"bin","codex"):""}},tempBase:root,home:root,env:{PATH:process.env.PATH},makeId});
  const list=await rt.models("codex");
  assert.deepEqual(list.map(m=>[m.id,m.fast]),[["native-ok",true]]);
  // A plain binary (already native) is used as is.
  const solo=path.join(root,"bin","solo");fs.writeFileSync(solo,`#!/usr/bin/env node\nconsole.log(${JSON.stringify(JSON.stringify(catalog))});`,{mode:0o755});
  const rt2=agent.create({...shims(root),realpath:p=>fs.realpathSync(p),Zotero:{Prefs:{get:key=>key.endsWith("agent.codexPath")?solo:""}},tempBase:root,home:root,env:{PATH:process.env.PATH},makeId});
  assert.equal((await rt2.models("codex"))[0].id,"native-ok");
});

test("Claude's recommended order comes from the CLI's own initialize answer, headline aliases first",async()=>{
  const models=[
    {value:"default",resolvedModel:"claude-sonnet-5-5",displayName:"Default (recommended)",supportedEffortLevels:["low","medium","high","xhigh","max"]},
    {value:"opus",resolvedModel:"claude-opus-5-5",displayName:"Opus 5.5",supportsFastMode:true,supportedEffortLevels:["low","medium","high","xhigh","max"]},
    {value:"sonnet",displayName:"Sonnet 5.5",supportedEffortLevels:["low","medium"]},
    {value:"fable",displayName:"Fable 5.1",supportedEffortLevels:["low","medium","high","xhigh","max"]},
    {value:"haiku",displayName:"Haiku 5.5"},
    {value:"claude-opus-4-6",displayName:"Opus 4.6",supportedEffortLevels:["low","medium","high","max","bogus"]},
    {value:"claude-haiku-4-5-20251001",displayName:"Haiku 4.5"},
    {value:"bad name; rm",displayName:"x"}];
  const list=agent.parseClaudeInit(models);
  assert.deepEqual(list.map(m=>m.id),["opus","sonnet","fable","haiku","claude-opus-4-6","claude-haiku-4-5-20251001"]);
  assert.deepEqual(list.map(m=>m.older),[false,false,false,false,true,true]);
  assert.equal(list[0].label,"Claude Opus 5.5");assert.deepEqual(list[1].efforts,["low","medium"]);
  assert.deepEqual(list[4].efforts,["low","medium","high","max"]);assert.equal(list[5].effortless,true);
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),"noctua-agent-test-"));
  const cli=path.join(tmp,"fake-claude");
  fs.writeFileSync(cli,`#!/usr/bin/env node
let input="";process.stdin.on("data",d=>{input+=d;if(input.includes("\\n")){
  const request=JSON.parse(input.split("\\n")[0]);
  console.log("not json noise");
  console.log(JSON.stringify({type:"control_response",response:{subtype:"success",request_id:request.request_id,response:{models:${JSON.stringify(models)}}}}));
  setTimeout(()=>{},60000);}});`,{mode:0o755});
  const rt=agent.create({...shims(tmp),Zotero:{Prefs:{get:key=>key.endsWith("agent.claudePath")?cli:""}},tempBase:tmp,home:tmp,env:{PATH:process.env.PATH},makeId});
  const started=Date.now(),fromCli=await rt.models("claude");
  assert.deepEqual(fromCli.map(m=>m.id).slice(0,4),["opus","sonnet","fable","haiku"]);
  assert.ok(Date.now()-started<8000,"the CLI process must be stopped as soon as it has answered");
  const codex=agent.parseCodexModels({models:[{slug:"new",display_name:"New",visibility:"list",priority:1,description:"Latest workhorse"},{slug:"old",display_name:"Old",visibility:"list",priority:2,description:"Older generation workhorse model."}]});
  assert.deepEqual(codex.map(m=>m.older),[false,true]);
});
