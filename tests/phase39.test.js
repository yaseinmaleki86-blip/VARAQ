'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {mkdtempSync,rmSync,writeFileSync,readFileSync,existsSync,statSync,readdirSync}=require('node:fs');
const path=require('node:path'),os=require('node:os'),net=require('node:net');
const {spawn,spawnSync}=require('node:child_process');
const {DatabaseSync}=require('node:sqlite');
const {verifyBackup}=require('../lib/backup-integrity');
const root=path.resolve(__dirname,'..');
const {allowUnsafeRequest,acceptableOrigin}=require('../lib/http-guard');
async function serve(t){
 const dir=mkdtempSync(path.join(os.tmpdir(),'varaq39-'));
 const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
 const base=`http://127.0.0.1:${port}`;
 const env={...process.env,HOST:'127.0.0.1',PORT:String(port),DATA_DIR:dir,VARAQ_CURATED_SEED:'1'};delete env.PUBLIC_URL;
 const child=spawn(process.execPath,['server.js'],{cwd:root,env,stdio:['ignore','pipe','pipe']});
 let logs='';child.stdout.on('data',b=>logs+=b);child.stderr.on('data',b=>logs+=b);
 let ready=false;
 for(let i=0;i<150;i++){
  if(child.exitCode!==null)throw Error('Server failed '+logs);
  try{const r=await fetch(base+'/health');if(r.ok){ready=true;break;}}catch{}
  await new Promise(r=>setTimeout(r,50));
 }
 if(!ready)throw Error('Server not ready: '+logs);
 t.after(async()=>{child.kill('SIGTERM');await new Promise(r=>child.exitCode!==null||child.signalCode?r():child.once('exit',r));rmSync(dir,{recursive:true,force:true});});
 return {dir,base,env};
}
test('3.9 hardens public/admin POSTs against cross-site browser requests',async t=>{
 const s=await serve(t);
 let r=await fetch(s.base+'/login',{method:'POST',headers:{origin:'https://evil.example','content-type':'application/x-www-form-urlencoded'},body:'username=admin&password=bad'});
 assert.equal(r.status,403);
 r=await fetch(s.base+'/login',{method:'POST',headers:{'sec-fetch-site':'cross-site','content-type':'application/x-www-form-urlencoded'},body:'username=admin&password=bad'});
 assert.equal(r.status,403);
 r=await fetch(s.base+'/login',{method:'POST',headers:{origin:s.base,'content-type':'application/x-www-form-urlencoded'},body:'username=admin&password=bad'});
 assert.equal(r.status,200);
 assert.match(await r.text(),/نام کاربری یا رمز عبور اشتباه است/);
 assert.equal(acceptableOrigin('https://evil.example','https://varaq.example'),false);
 assert.equal(allowUnsafeRequest({method:'GET',headers:{origin:'https://evil.example'}},'https://varaq.example'),true);
 assert.equal(allowUnsafeRequest({method:'POST',headers:{origin:'null'}},'https://varaq.example'),false);
});
test('3.9 invalid cookie does not return 500; secure response policies and health version preserved',async t=>{
 const s=await serve(t);
 let r=await fetch(s.base+'/health',{headers:{cookie:'varaq_sid=%ZZ; unrelated=123'}});
 assert.equal(r.status,200);assert.equal((await r.json()).version,'8.6.0');
 assert.equal(r.headers.get('x-content-type-options'),'nosniff');
 r=await fetch(s.base+'/panel',{headers:{cookie:'varaq_sid=%ZZ'}});
 assert.equal(r.status,200);assert.match(await r.text(),/ورود/);
 r=await fetch(s.base+'/login',{method:'POST',headers:{origin:'https://bad.example'},body:'any'});
 assert.equal(r.status,403);
});
test('3.9 verified backup restores to a NEW folder; tampering and overwrite are rejected',async t=>{
 const s=await serve(t);
 const run=(file,...args)=>spawnSync(process.execPath,[file,...args],{cwd:root,env:s.env,encoding:'utf8',timeout:30000});
 const output=run('backup.js');assert.equal(output.status,0,output.stderr+'\n'+output.stdout);
 const base=path.join(s.dir,'backups');const names=readdirSync(base);assert.equal(names.length,1);
 const backup=path.join(base,names[0]);const checked=verifyBackup(backup);assert.equal(checked.sqlite.ok,true);
 const restore=path.join(s.dir,'recovered');
 let result=run('restore-backup.js',backup,restore);assert.equal(result.status,0,result.stderr+'\n'+result.stdout);
 assert.equal(existsSync(path.join(restore,'varaq.sqlite')),true);
 const original=new DatabaseSync(path.join(s.dir,'varaq.sqlite'),{readOnly:true});
 const recovered=new DatabaseSync(path.join(restore,'varaq.sqlite'),{readOnly:true});
 try{
  assert.equal(recovered.prepare('SELECT COUNT(*) n FROM books').get().n,original.prepare('SELECT COUNT(*) n FROM books').get().n);
  assert.equal(recovered.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
 }finally{original.close();recovered.close();}
 result=run('restore-backup.js',backup,restore);assert.notEqual(result.status,0);
 const file=path.join(backup,'varaq.sqlite');const contents=readFileSync(file);contents[100]^=1;writeFileSync(file,contents);
 assert.throws(()=>verifyBackup(backup),/عدم تطابق/);
 result=run('restore-backup.js',backup,path.join(s.dir,'tamper-out'));assert.notEqual(result.status,0);
});
test('3.9 preflight separates informational preview from sales; no automatic sale activation',async t=>{
 const s=await serve(t);
 const env={...s.env,PUBLIC_URL:'https://varaq.example'};
 let run=spawnSync(process.execPath,['preflight.js','--json'],{cwd:root,env,encoding:'utf8'});
 assert.equal(run.status,0,run.stderr);let report=JSON.parse(run.stdout);
 assert.equal(report.readyForInformationPreview,false);
 assert.equal(report.readyForPublicSales,false);
 assert.equal(report.paymentEnabled,false);
 assert.equal(report.checks.find(x=>x.id==='owner_credentials').ok,false);
 assert.equal(report.checks.find(x=>x.id==='verified_backup').ok,false);
 assert.equal(report.checks.find(x=>x.id==='catalog_preview').ok,true);
 run=spawnSync(process.execPath,['preflight.js','--strict-preview','--json'],{cwd:root,env,encoding:'utf8'});assert.equal(run.status,1);
 run=spawnSync(process.execPath,['preflight.js','--strict-sales','--json'],{cwd:root,env,encoding:'utf8'});assert.equal(run.status,1);
});

test('3.9 self-declared review plus valid backup can pass preview gate but never the sales gate',async t=>{
 const s=await serve(t);
 const db=new DatabaseSync(path.join(s.dir,'varaq.sqlite'));
 try{db.prepare("UPDATE users SET must_change_password=0 WHERE role='owner'").run();}finally{db.close();}
 const backed=spawnSync(process.execPath,['backup.js'],{cwd:root,env:s.env,encoding:'utf8',timeout:30000});
 assert.equal(backed.status,0,backed.stderr);
 const env={...s.env,PUBLIC_URL:'https://varaq.example',VARAQ_LEGAL_REVIEWED:'1',VARAQ_MEDIA_RIGHTS_REVIEWED:'1',VARAQ_BROWSER_QA_APPROVED:'1',VARAQ_PUBLIC_INDEX:'1'};
 const result=spawnSync(process.execPath,['preflight.js','--json','--strict-preview'],{cwd:root,env,encoding:'utf8'});
 assert.equal(result.status,0,result.stderr+'\n'+result.stdout);
 const report=JSON.parse(result.stdout);
 assert.equal(report.readyForInformationPreview,true);assert.equal(report.readyForPublicSales,false);
 assert.equal(report.checks.find(c=>c.id==='verified_backup').ok,true);
 assert.equal(report.checks.find(c=>c.id==='payment_provider').ok,false);
});
