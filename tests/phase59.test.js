'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const {spawn,spawnSync}=require('node:child_process');
const {DatabaseSync}=require('node:sqlite');
const smoke=require('../lib/public-smoke');
const ROOT=path.resolve(__dirname,'..');
async function freePort(){const sock=net.createServer();await new Promise(ok=>sock.listen(0,'127.0.0.1',ok));const port=sock.address().port;await new Promise(ok=>sock.close(ok));return port;}
async function launch(t,{publicMode=true,indexed=false}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'varaq59-'));
 const port=await freePort(),base=`http://127.0.0.1:${port}`;
 const env={...process.env,PORT:String(port),HOST:'127.0.0.1',DATA_DIR:dir,VARAQ_CURATED_SEED:'1',PUBLIC_URL:publicMode?base:''};
 for(const k of ['VARAQ_PUBLIC_INDEX','VARAQ_LEGAL_REVIEWED','VARAQ_MEDIA_RIGHTS_REVIEWED','VARAQ_BROWSER_QA_APPROVED'])delete env[k];
 if(indexed)for(const k of ['VARAQ_PUBLIC_INDEX','VARAQ_LEGAL_REVIEWED','VARAQ_MEDIA_RIGHTS_REVIEWED','VARAQ_BROWSER_QA_APPROVED'])env[k]='1';
 let err='';const proc=spawn(process.execPath,['server.js'],{cwd:ROOT,env,stdio:['ignore','pipe','pipe']});
 proc.stderr.on('data',x=>err+=x);
 t.after(async()=>{if(proc.exitCode===null){proc.kill('SIGTERM');await Promise.race([new Promise(ok=>proc.once('exit',ok)),new Promise(ok=>setTimeout(ok,3000))]);}fs.rmSync(dir,{recursive:true,force:true});});
 for(let i=0;i<130;i++){try{if((await fetch(base+'/health')).ok)return {base,dir,env};}catch{}await new Promise(ok=>setTimeout(ok,65));}
 throw Error('Cannot launch '+err);
}
test('5.9 live safety smoke passes only in public read-only with indexing locked, without creating orders',async t=>{
 const s=await launch(t);
 const report=await smoke.run({url:s.base});
 assert.equal(report.passed,true,JSON.stringify(report.checks.filter(x=>!x.ok)));
 assert.equal(report.indexingExpected,false);
 assert.equal(report.checks.length>=14,true);
 const cli=spawnSync(process.execPath,['release-smoke.js','--url',s.base,'--json'],{cwd:ROOT,encoding:'utf8',timeout:30000});
 assert.equal(cli.status,0,cli.stderr);assert.equal(JSON.parse(cli.stdout).passed,true);
 const db=new DatabaseSync(path.join(s.dir,'varaq.sqlite'),{readOnly:true});
 try{assert.equal(db.prepare('SELECT COUNT(*) n FROM demo_orders').get().n,0);}
 finally{db.close();}
});
test('5.9 smoke stops before POST against local demo mode, returns nonzero',async t=>{
 const s=await launch(t,{publicMode:false});
 const report=await smoke.run({url:s.base});
 assert.equal(report.passed,false);assert.equal(report.aborted,true);
 assert.equal(report.checks.length,1);
 const cli=spawnSync(process.execPath,['release-smoke.js','--url',s.base,'--json'],{cwd:ROOT,encoding:'utf8',timeout:30000});
 assert.equal(cli.status,1);assert.equal(JSON.parse(cli.stdout).aborted,true);
});
test('5.9 smoke can explicitly validate opt-in indexed preview, but will not mistake index status',async t=>{
 const s=await launch(t,{indexed:true});
 const indexed=await smoke.run({url:s.base,indexing:true});
 assert.equal(indexed.passed,true,JSON.stringify(indexed.checks.filter(x=>!x.ok)));
 const locked=await smoke.run({url:s.base,indexing:false});
 assert.equal(locked.passed,false);assert.ok(locked.checks.some(c=>c.id==='indexing_locked'&&!c.ok));
});
test('5.9 smoke URL validation prevents credentials and path injection',()=>{
 for(const url of ['http://x.example/a','https://user:secret@example.com/','file:///tmp/p','https://x.example/?a=1','http://x.example/#z']){
  assert.throws(()=>smoke.parseOrigin(url));
 }
 assert.equal(smoke.parseOrigin('http://127.0.0.1:3030'),'http://127.0.0.1:3030');
});
