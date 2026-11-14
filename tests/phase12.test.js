'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const net=require('node:net');
const {spawn,spawnSync}=require('node:child_process');
const {DatabaseSync}=require('node:sqlite');
const ROOT=path.join(__dirname,'..');
const temp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'varaq-v12-'));
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function freePort(){return await new Promise((resolve,reject)=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const port=s.address().port;s.close(()=>resolve(port));});s.on('error',reject);});}
async function launch(storage,extra={}){
 const port=await freePort();let output='';
 const cp=spawn(process.execPath,['server.js'],{cwd:ROOT,env:{...process.env,DATA_DIR:storage,HOST:'127.0.0.1',PORT:String(port),PUBLIC_URL:'',...extra},stdio:['ignore','pipe','pipe']});
 cp.stdout.on('data',x=>output+=x.toString());cp.stderr.on('data',x=>output+=x.toString());
 for(let i=0;i<100;i++){if(output.includes('PAYMENT: DISABLED'))return {cp,port,url:`http://127.0.0.1:${port}`,output:()=>output};if(cp.exitCode!=null)throw Error('server exited '+output);await pause(90);}
 cp.kill();throw Error('server timeout '+output);
}
function cli(file,args=[],env={}){return spawnSync(process.execPath,[file,...args],{cwd:ROOT,encoding:'utf8',env:{...process.env,...env},timeout:25000});}
function dbStatus(file){const db=new DatabaseSync(file,{readOnly:true});try{return db.prepare('SELECT COUNT(*) AS n FROM books').get().n;}finally{db.close();}}
test('v1.2: verified backups restore to NEW directory, preserve data and reject tampering',async t=>{
 const dir=temp();t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const storage=path.join(dir,'storage');const s=await launch(storage);t.after(()=>s.cp.kill('SIGINT'));
 // Add a representative private file and a cover to verify media checksums.
 fs.mkdirSync(path.join(storage,'covers'),{recursive:true});fs.writeFileSync(path.join(storage,'covers','test.jpg'),Buffer.from('private-data-sample'));
 fs.mkdirSync(path.join(storage,'store-documents'),{recursive:true});fs.writeFileSync(path.join(storage,'store-documents','document.pdf'),Buffer.from('%PDF- sample'));
 const liveDb=new DatabaseSync(path.join(storage,'varaq.sqlite'));liveDb.prepare('INSERT INTO stores(name,slug,city,active) VALUES(?,?,?,?)').run('کتاب‌فروشی نمونه بکاپ','backup-store','یزد',0);liveDb.close();
 const backup=cli('backup.js',[],{DATA_DIR:storage});assert.equal(backup.status,0,backup.stderr);assert.match(backup.stdout,/VERIFIED BACKUP/);
 const loc=backup.stdout.match(/VERIFIED BACKUP: ([^\n]+)/)?.[1];assert.ok(loc);
 let verification=cli('verify-backup.js',[loc]);assert.equal(verification.status,0,verification.stderr);
 const recovered=path.join(dir,'recovered-storage');let restore=cli('restore-backup.js',[loc,recovered]);assert.equal(restore.status,0,restore.stderr);
 assert.equal(dbStatus(path.join(recovered,'varaq.sqlite')),1000);
 const db=new DatabaseSync(path.join(recovered,'varaq.sqlite'),{readOnly:true});assert.equal(db.prepare("SELECT count(*) AS n FROM stores WHERE slug='backup-store'").get().n,1);db.close();
 assert.equal(fs.readFileSync(path.join(recovered,'covers','test.jpg'),'utf8'),'private-data-sample');
 assert.equal(fs.readFileSync(path.join(recovered,'store-documents','document.pdf'),'utf8'),'%PDF- sample');
 restore=cli('restore-backup.js',[loc,storage]);assert.notEqual(restore.status,0,'never replace active/existing storage');
 const originalBooks=dbStatus(path.join(storage,'varaq.sqlite'));assert.equal(originalBooks,1000);
 fs.appendFileSync(path.join(loc,'covers','test.jpg'),'corruption');verification=cli('verify-backup.js',[loc]);assert.notEqual(verification.status,0);assert.match(verification.stderr,/FAILED/);
 restore=cli('restore-backup.js',[loc,path.join(dir,'should-not-appear')]);assert.notEqual(restore.status,0);assert.equal(fs.existsSync(path.join(dir,'should-not-appear')),false);
});
test('v1.2: headers, noindex on private areas, public SEO, and no payment',async t=>{
 const dir=temp();t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const s=await launch(path.join(dir,'storage'),{PUBLIC_URL:'https://books.example.test',VARAQ_PUBLIC_INDEX:'1',VARAQ_LEGAL_REVIEWED:'1',VARAQ_MEDIA_RIGHTS_REVIEWED:'1',VARAQ_BROWSER_QA_APPROVED:'1'});t.after(()=>s.cp.kill('SIGINT'));
 let r=await fetch(s.url+'/login');let h=await r.text();assert.equal(r.status,200);assert.match(h,/noindex,nofollow/);assert.match(r.headers.get('x-robots-tag'),/noindex/);assert.equal(r.headers.get('strict-transport-security'),'max-age=31536000');assert.match(r.headers.get('content-security-policy'),/frame-ancestors 'none'/);
 r=await fetch(s.url+'/');h=await r.text();assert.doesNotMatch(h,/<meta name="robots"/);assert.equal(r.headers.get('x-robots-tag'),null);
 r=await fetch(s.url+'/panel');assert.match(r.headers.get('x-robots-tag'),/noindex/);
 r=await fetch(s.url+'/assets/style.css');assert.equal(r.status,200);assert.ok(r.headers.get('etag'));
 r=await fetch(s.url+'/health');assert.equal((await r.json()).payment_enabled,false);
 r=await fetch(s.url+'/',{method:'PUT'});assert.equal(r.status,405);
 const badPublic=cli('server.js',[],{DATA_DIR:path.join(dir,'invalid'),PUBLIC_URL:'http://example.test'});assert.notEqual(badPublic.status,0);assert.match(badPublic.stderr,/require HTTPS/i);
});
test('v1.2: read-only quality audit keeps content unchanged',async t=>{
 const dir=temp();t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const s=await launch(path.join(dir,'storage'));t.after(()=>s.cp.kill('SIGINT'));
 const dbFile=path.join(dir,'storage','varaq.sqlite');
 const before=dbStatus(dbFile);const result=cli('quality-report.js',['--json'],{DATA_DIR:path.join(dir,'storage')});assert.equal(result.status,0,result.stderr);
 const report=JSON.parse(result.stdout);assert.equal(report.books,1000);assert.equal(report.isReadOnly,true);assert.equal(report.paymentEnabled,false);assert.ok(report.missingPublisher>=0);assert.equal(dbStatus(dbFile),before);
});
test('v1.2: HTTP HEAD returns metadata without response body',async t=>{
 const dir=temp();t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const s=await launch(path.join(dir,'storage'));t.after(()=>s.cp.kill('SIGINT'));
 const head=await fetch(s.url+'/books',{method:'HEAD'});
 assert.equal(head.status,200);assert.match(head.headers.get('content-type'),/text\/html/);
 assert.equal((await head.text()).length,0);
});
