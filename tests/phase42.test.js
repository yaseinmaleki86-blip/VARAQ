'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net');
const {spawn}=require('node:child_process');
const root=path.join(__dirname,'..');
function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
async function port(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
async function site(t){
 const data=fs.mkdtempSync(path.join(os.tmpdir(),'varaq42-'));
 const p=await port();const base=`http://127.0.0.1:${p}`;
 const child=spawn(process.execPath,['server.js'],{cwd:root,env:{...process.env,DATA_DIR:data,PORT:String(p),HOST:'127.0.0.1',VARAQ_CURATED_SEED:'1'},stdio:'ignore'});
 t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){child.kill();await Promise.race([new Promise(r=>child.once('exit',r)),sleep(3000)]);}fs.rmSync(data,{recursive:true,force:true});});
 for(let i=0;i<150;i++){try{const r=await fetch(base+'/health');if(r.ok)return {data,base,child,p};}catch{}await sleep(40);}
 throw Error('VARAQ did not start');
}
test('4.2 reading sheet is printable, source-aware, and noindexed',async t=>{
 const s=await site(t);
 let r=await fetch(s.base+'/book/book-001/sheet');assert.equal(r.status,200);
 const html=await r.text();assert.match(html,/برگه اطلاعات کتاب/);
 assert.match(html,/برگه اطلاعات و چاپ کتاب|چاپ \/ ذخیره PDF/);
 assert.match(html,/ثبت داده به معنی تأیید صحت/);
 assert.match(html,/noindex,nofollow/);
 assert.doesNotMatch(html,/class="cta add-cart"/);
 r=await fetch(s.base+'/book/not-real/sheet');assert.equal(r.status,404);
 r=await fetch(s.base+'/book/book-001');assert.equal(r.status,200);assert.match(await r.text(),/book-sheet-link/);
});
test('4.2 STOP_ALL authenticates owner process and preserves files',async t=>{
 const s=await site(t);
 const runDir=path.join(s.data,'runtime');const records=fs.readdirSync(runDir).filter(x=>/^server-\d+\.json$/.test(x));assert.equal(records.length,1);
 const info=JSON.parse(fs.readFileSync(path.join(runDir,records[0]),'utf8'));
 assert.equal(info.app,'VARAQ');assert.equal(info.pid,s.child.pid);
 let resp=await fetch(s.base+'/__varaq_local/stop',{method:'POST',headers:{'x-varaq-stop-token':'a'.repeat(64)}});
 assert.equal(resp.status,404);
 assert.equal((await fetch(s.base+'/health')).status,200);
 const proc=spawn(process.execPath,['stop-all.js'],{cwd:root,env:{...process.env,DATA_DIR:s.data},stdio:['ignore','pipe','pipe']});
 let stderr='';proc.stderr.on('data',chunk=>stderr+=chunk);
 const code=await new Promise(r=>proc.on('exit',r));assert.equal(code,0,stderr);
 for(let i=0;i<60&&s.child.exitCode===null&&s.child.signalCode===null;i++)await sleep(50);
 assert.ok(s.child.exitCode!==null||s.child.signalCode!==null,'server still running after stop request');
 assert.ok(fs.existsSync(path.join(s.data,'varaq.sqlite')),'database was removed');
 assert.equal(fs.existsSync(path.join(runDir,records[0])),false,'control file was left behind');
 const cleanup=spawn(process.execPath,['clean-temp.js'],{cwd:root,env:{...process.env,DATA_DIR:s.data},stdio:'ignore'});
 assert.equal(await new Promise(r=>cleanup.on('exit',r)),0);
 assert.ok(fs.existsSync(path.join(s.data,'varaq.sqlite')),'cleanup deleted database');
});
