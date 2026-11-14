'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const {DatabaseSync}=require('node:sqlite');const {spawn}=require('node:child_process');
const pdf=require('../lib/pdf-store'),covers=require('../lib/cover-completion');
const ROOT=path.resolve(__dirname,'..');
const samplePdf=Buffer.from('%PDF-1.4\n1 0 obj\n<</Type/Catalog/Pages 2 0 R>>\nendobj\n2 0 obj\n<</Type/Pages/Count 0/Kids[]>>\nendobj\ntrailer\n<</Root 1 0 R>>\n%%EOF\n');
function setupDb(){const db=new DatabaseSync(':memory:');db.exec("PRAGMA foreign_keys=ON; CREATE TABLE stores(id INTEGER PRIMARY KEY,name TEXT,active INTEGER);CREATE TABLE users(id INTEGER PRIMARY KEY); CREATE TABLE books(id INTEGER PRIMARY KEY,slug TEXT,title TEXT,author TEXT,description TEXT,publisher TEXT,isbn TEXT,category TEXT);CREATE TABLE editions(id INTEGER PRIMARY KEY,book_id INTEGER,verified INTEGER,isbn TEXT);CREATE TABLE edition_sources(id INTEGER PRIMARY KEY,edition_id INTEGER);CREATE TABLE book_covers(book_id INTEGER);CREATE TABLE edition_cover_assets(edition_id INTEGER);INSERT INTO stores VALUES(1,'اول',1),(2,'دوم',1);INSERT INTO users VALUES(1),(2),(3);INSERT INTO books VALUES(1,'test','کتاب تست','نویسنده','','','','عمومی');");pdf.migrate(db);pdf.migrate(db);return db;}
const owner={id:1,role:'owner'},a={id:2,role:'seller',store_id:1,staff_permission:'manager'},b={id:3,role:'seller',store_id:2,staff_permission:'manager'};
const fields={store_id:1,book_id:1,title:'نسخه دیجیتال تست',description:'توضیح کتاب دیجیتال',price:'45000',rights_holder:'ناشر مجاز',rights_basis:'قرارداد رسمی فروش دیجیتال',rights_evidence:'شماره قرارداد معتبر 1406/01',licensed:'1',original_name:'book.pdf'};
test('4.4 PDF validation, tenant isolation, moderation and private integrity',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'varaq44-unit-'));t.after(()=>fs.rmSync(dir,{force:true,recursive:true}));const db=setupDb();t.after(()=>db.close());
 assert.throws(()=>pdf.validatePdf(Buffer.from('not pdf')),/PDF/);
 assert.throws(()=>pdf.create(db,dir,a,{...fields,licensed:'0'},samplePdf),/تأیید/);
 // Seller's posted store_id is ignored; tenancy comes from the session.
 assert.equal(pdf.rows(db,b).length,0);
 const id=pdf.create(db,dir,a,{...fields,store_id:2},samplePdf);
 assert.equal(pdf.rows(db,a).length,1);assert.equal(pdf.rows(db,b).length,0);assert.equal(pdf.publicRows(db).length,0);
 assert.equal(pdf.privateDownload(db,dir,b,id),null);
 assert.ok(pdf.privateDownload(db,dir,a,id));
 assert.throws(()=>pdf.setStatus(db,b,id,'approved'),/فروشگاه/);
 assert.throws(()=>pdf.setStatus(db,a,id,'approved'),/مدیریت YM/);
 pdf.setStatus(db,a,id,'pending');pdf.setStatus(db,owner,id,'approved');
 assert.equal(pdf.publicRows(db).length,1);
 assert.throws(()=>pdf.setStatus(db,a,id,'pending'),/مرحله|فعلی/);
 fs.appendFileSync(pdf.privateDownload(db,dir,owner,id).full,'BAD');assert.equal(pdf.privateDownload(db,dir,owner,id),null);
});
test('4.4 cover completion never fabricates records and CSV is spreadsheet safe',()=>{
 const db=setupDb();try{const data=covers.rows(db);assert.equal(data.length,1);assert.ok(data[0].missing.includes('جلد مجاز'));assert.ok(data[0].missing.includes('معرفی'));assert.equal(covers.stats(data).withRealCover,0);
 db.prepare('UPDATE books SET title=? WHERE id=1').run('=2+5');assert.match(covers.csv(covers.rows(db)),/"'=2\+5"/);}finally{db.close();}
});
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function serve(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'varaq44-http-'));const sock=net.createServer();await new Promise(r=>sock.listen(0,'127.0.0.1',r));const port=sock.address().port;await new Promise(r=>sock.close(r));const base=`http://127.0.0.1:${port}`;
const env={...process.env,PORT:String(port),HOST:'127.0.0.1',DATA_DIR:dir,VARAQ_CURATED_SEED:'1'};delete env.PUBLIC_URL;const child=spawn(process.execPath,['server.js'],{cwd:ROOT,env,stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',x=>output+=x);child.stderr.on('data',x=>output+=x);t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await Promise.race([new Promise(r=>child.once('exit',r)),wait(3000)]);}fs.rmSync(dir,{force:true,recursive:true});});for(let i=0;i<150;i++){if(child.exitCode!==null)throw Error(output);try{const r=await fetch(base+'/health');if(r.ok)return {base,dir};}catch{}await wait(40)}throw Error(output);}
const get=(base,route,cookie='')=>fetch(base+route,{redirect:'manual',headers:{cookie}});
const post=(base,route,fields,cookie='')=>fetch(base+route,{method:'POST',redirect:'manual',headers:{cookie,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams(fields)});
const csrf=html=>html.match(/name="csrf" value="([^"]+)"/)?.[1];
const cookie=r=>r.headers.get('set-cookie')?.split(';')[0];
test('4.4 HTTP upload, public listing, forbidden downloads, owner review and backup media',async t=>{
 const {base,dir}=await serve(t);
 let r=await get(base,'/pdf-books');assert.equal(r.status,200);assert.match(await r.text(),/فروشگاه کتاب‌های PDF/);
 r=await get(base,'/panel/pdf-private/1');assert.equal(r.status,303);
 r=await post(base,'/login',{username:'admin',password:'ad123456789'});let c=cookie(r);
 r=await get(base,'/panel/account',c);let token=csrf(await r.text());
 r=await post(base,'/panel/account',{csrf:token,username:'admin',old_password:'ad123456789',new_password:'SecureOwnerPassword123',confirm_password:'SecureOwnerPassword123'},c);assert.equal(r.status,303);
 r=await post(base,'/login',{username:'admin',password:'SecureOwnerPassword123'});c=cookie(r);
 r=await get(base,'/panel/pdf-books',c);assert.equal(r.status,200);token=csrf(await r.text());assert.ok(token);
 const form=new FormData();for(const [k,v] of Object.entries(fields))form.set(k,String(v));form.set('csrf',token);form.set('pdf',new Blob([samplePdf],{type:'application/pdf'}),'book.pdf');
 r=await fetch(base+'/panel/pdf-upload',{method:'POST',redirect:'manual',headers:{cookie:c},body:form});assert.equal(r.status,303);
 const dbase=new DatabaseSync(path.join(dir,'varaq.sqlite'));const saved=dbase.prepare('SELECT id,status FROM digital_books').get();assert.equal(saved.status,'draft');dbase.close();
 r=await get(base,'/pdf-books');assert.doesNotMatch(await r.text(),/نسخه دیجیتال تست/);
 r=await get(base,`/panel/pdf-private/${saved.id}`,c);assert.equal(r.status,200);assert.match(r.headers.get('content-disposition'),/attachment/);assert.deepEqual(Buffer.from(await r.arrayBuffer()),samplePdf);
 r=await get(base,`/panel/pdf-private/${saved.id}`);assert.equal(r.status,303);
 r=await post(base,'/panel/pdf-status',{csrf:token,id:saved.id,status:'pending'},c);assert.equal(r.status,303);
 r=await post(base,'/panel/pdf-status',{csrf:token,id:saved.id,status:'approved'},c);assert.equal(r.status,303);
 r=await get(base,'/pdf-books');assert.match(await r.text(),/نسخه دیجیتال تست/);
 r=await get(base,`/media/digital-pdfs/${saved.id}.pdf`);assert.equal(r.status,404);
 r=await get(base,'/panel/cover-completion.csv',c);assert.equal(r.status,200);assert.match(await r.text(),/missing/);
 assert.equal(fs.readdirSync(path.join(dir,'digital-pdfs')).length,1);
});
