'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const net=require('node:net');
const {spawn}=require('node:child_process');const {DatabaseSync}=require('node:sqlite');
const bibliography=require('../lib/bibliography');const audit=require('../lib/catalog-audit');
async function start(t,seed=true,providedDir){
 const dir=providedDir||fs.mkdtempSync(path.join(os.tmpdir(),'varaq-v21-'));
 const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
 const p=spawn(process.execPath,['server.js'],{cwd:path.join(__dirname,'..'),env:{...process.env,VARAQ_CURATED_SEED:seed?'1':'0',DATA_DIR:dir,PORT:String(port),HOST:'127.0.0.1',PUBLIC_URL:''},stdio:['ignore','pipe','pipe']});
 let logs='';await new Promise((ok,reject)=>{const timeout=setTimeout(()=>reject(Error('startup timeout '+logs)),15000);p.stdout.on('data',d=>{logs+=d.toString();if(logs.includes('PAYMENT: DISABLED')){clearTimeout(timeout);ok();}});p.stderr.on('data',d=>logs+=d);p.on('exit',code=>reject(Error(`startup exited ${code}: ${logs}`)));});
 t.after(()=>{p.kill('SIGINT');if(!providedDir)fs.rmSync(dir,{force:true,recursive:true});});
 return {dir,base:`http://127.0.0.1:${port}`};
}
test('v2.1: added sourced editions are valid, idempotent, and do not pretend to be licensed covers',async t=>{
 const s=await start(t);const db=new DatabaseSync(path.join(s.dir,'varaq.sqlite'));
 assert.equal(db.prepare('SELECT COUNT(*) n FROM books').get().n,1000);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM edition_sources').get().n,128);
 assert.equal(db.prepare('SELECT COUNT(DISTINCT book_id) n FROM editions e JOIN edition_sources s ON s.edition_id=e.id').get().n,71);
 for(const e of bibliography.NEW_SEED){assert.ok(bibliography.isbnValid(e.isbn));let row=db.prepare('SELECT e.isbn,e.book_id,s.source_url FROM editions e JOIN edition_sources s ON s.edition_id=e.id WHERE e.isbn=?').get(e.isbn);assert.equal(row.book_id,e.id);assert.equal(row.source_url,e.source_url);}
 assert.equal(audit.summary(audit.rows(db)).licensedCover,0);
 const n=db.prepare('SELECT COUNT(*) n FROM editions').get().n;
 bibliography.migrate(db);assert.equal(db.prepare('SELECT COUNT(*) n FROM editions').get().n,n);
 db.close();const h=await(await fetch(s.base+'/health')).json();assert.equal(h.version,'8.6.0');assert.equal(h.payment_enabled,false);
});
test('v2.1: audit page and CSV require authenticated central owner',async t=>{
 const s=await start(t);
 for(const route of ['/panel/edition-audit','/panel/edition-audit.csv']){
  const r=await fetch(s.base+route,{redirect:'manual'});assert.equal(r.status,303);assert.equal(r.headers.get('location'),'/login');
 }
 const db=new DatabaseSync(path.join(s.dir,'varaq.sqlite'));
 const rows=audit.rows(db);assert.equal(rows.length,1000);
 assert.equal(audit.filterRows(rows,'needs_source').length,929);
 assert.equal(audit.filterRows(rows,'ready').length,0);
 const csv=audit.exportCsv(rows);assert.equal(csv.split('\n').length,1002);assert.match(csv,/سووشون/);
 assert.doesNotMatch(csv,/=HYPERLINK/);
 db.close();
});
test('v2.1: CSV sanitizer avoids Excel formula evaluation',()=>{
 const row=[{id:99,title:'=HYPERLINK("https://evil")',author:'-10',category:'test',sourced:0,licensedCover:0}];
 const csv=audit.exportCsv(row);assert.match(csv,/'=HYPERLINK/);assert.match(csv,/'-10/);
});

test('v2.1: owner can open audit and download 200 rows after required password change',async t=>{
 const s=await start(t);
 const post=(p,form,c='')=>fetch(s.base+p,{method:'POST',redirect:'manual',headers:{'Content-Type':'application/x-www-form-urlencoded',cookie:c},body:new URLSearchParams(form)});
 const get=(p,c='')=>fetch(s.base+p,{redirect:'manual',headers:{cookie:c}});
 let r=await post('/login',{username:'admin',password:'ad123456789'});let cookie=r.headers.get('set-cookie').split(';')[0];
 assert.equal((await get('/panel/edition-audit',cookie)).headers.get('location'),'/panel/account');
 let a=await(await get('/panel/account',cookie)).text();const csrf=a.match(/name="csrf" value="([^"]+)"/)[1];
 r=await post('/panel/account',{csrf,username:'admin',old_password:'ad123456789',new_password:'NewPasswordForTest123456',confirm_password:'NewPasswordForTest123456'},cookie);assert.equal(r.status,303);
 r=await post('/login',{username:'admin',password:'NewPasswordForTest123456'});cookie=r.headers.get('set-cookie').split(';')[0];
 r=await get('/panel/edition-audit?status=needs_cover',cookie);assert.equal(r.status,200);const page=await r.text();assert.match(page,/۱۲۸/);assert.match(page,/کنترل چاپ‌ها و جلدها/);
 r=await get('/panel/edition-audit.csv',cookie);assert.equal(r.status,200);assert.match(r.headers.get('content-type'),/text\/csv/);assert.match(await r.text(),/سووشون/);
});
