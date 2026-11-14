'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const {spawn}=require('node:child_process'),{DatabaseSync}=require('node:sqlite');
const media=require('../lib/media-integrity');
const img=fs.readFileSync(path.join(__dirname,'fixtures','test_cover.png'));
const pdfBytes=Buffer.from('%PDF-1.4\n1 0 obj\n<</Type/Catalog/Pages 2 0 R>>\nendobj\n2 0 obj\n<</Type/Pages/Count 0/Kids[]>>\nendobj\ntrailer\n<</Root 1 0 R>>\n%%EOF\n');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function boot(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'varaq51-'));
 const netServer=net.createServer();await new Promise(ok=>netServer.listen(0,'127.0.0.1',ok));const port=netServer.address().port;await new Promise(ok=>netServer.close(ok));
 const base='http://127.0.0.1:'+port;
 const proc=spawn(process.execPath,['server.js'],{cwd:path.join(__dirname,'..'),env:{...process.env,DATA_DIR:dir,PORT:String(port),HOST:'127.0.0.1',PUBLIC_URL:'',VARAQ_CURATED_SEED:'1'},stdio:['ignore','pipe','pipe']});
 let stderr='';proc.stderr.on('data',b=>stderr+=b);
 t.after(async()=>{if(proc.exitCode===null){proc.kill('SIGTERM');await Promise.race([new Promise(ok=>proc.once('exit',ok)),delay(1500)]);}fs.rmSync(dir,{recursive:true,force:true});});
 for(let i=0;i<120;i++){try{const r=await fetch(base+'/health');if(r.ok)return {base,dir};}catch{}await delay(50);}
 throw new Error('Boot failed: '+stderr);
}
async function admin(base){
 const post=(data,c='')=>fetch(base+'/login',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',cookie:c},body:new URLSearchParams(data),redirect:'manual'});
 let r=await post({username:'admin',password:'ad123456789'});let cookie=r.headers.get('set-cookie').split(';')[0];
 r=await fetch(base+'/panel/account',{headers:{cookie}});const csrf=(await r.text()).match(/name="csrf" value="([^"]+)"/)[1];
 await fetch(base+'/panel/account',{method:'POST',redirect:'manual',headers:{cookie,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf,username:'admin',old_password:'ad123456789',new_password:'VarAQ-Final-Pass-51-secure!',confirm_password:'VarAQ-Final-Pass-51-secure!'})});
 r=await post({username:'admin',password:'VarAQ-Final-Pass-51-secure!'});return r.headers.get('set-cookie').split(';')[0];
}
test('5.1 media audit detects broken uploads and original missing-cover backlog, never fabricates rights',async t=>{
 const s=await boot(t),db=new DatabaseSync(path.join(s.dir,'varaq.sqlite'));
 t.after(()=>db.close());
 let list=media.safeRows(db,s.dir),stats=media.summary(list);
 assert.equal(list.filter(x=>x.type==='missing_cover').length,1000);
 assert.equal(stats.digital,0);assert.equal(stats.external,0);
 const name='a'.repeat(32)+'.png';
 db.prepare('INSERT INTO book_covers(book_id,filename,mime,alt,source,rights_note) VALUES(?,?,?,?,?,?)').run(1,name,'image/png','جلد آزمایشی','مالک تصویر','مجوز تست');
 list=media.safeRows(db,s.dir);
 assert.ok(list.some(x=>x.type==='book_cover'&&x.state==='missing_file'));
 assert.ok(list.some(x=>x.type==='missing_cover'&&x.book_id===1&&x.state==='needs_repair'));
 const folder=path.join(s.dir,'covers');fs.writeFileSync(path.join(folder,name),img);
 assert.equal(media.checkCover(folder,name,'image/png').state,'ok');
 list=media.safeRows(db,s.dir);assert.equal(list.filter(x=>x.type==='missing_cover').length,999);
 assert.ok(list.some(x=>x.type==='book_cover'&&x.state==='ok'));
 fs.writeFileSync(path.join(folder,'b'.repeat(32)+'.png'),img);
 assert.ok(media.safeRows(db,s.dir).some(x=>x.state==='orphan_file'));
 fs.writeFileSync(path.join(folder,name),Buffer.from('bogus file'));
 assert.equal(media.checkCover(folder,name,'image/png').state,'invalid_file');
 assert.equal(media.checkCover(folder,'../../file.png','image/png').state,'invalid_path');
 assert.equal(media.checkCover(folder,name,'image/jpeg').state,'invalid_mime');
 assert.match(media.csv([{type:'book_cover',title:'=HYPERLINK("https://evil")',state:'missing_file'}]),/"'=HYPERLINK/);
});
test('5.1 owner-only dashboard/CSV; broken public cover falls back safely; checkout disabled',async t=>{
 const s=await boot(t),db=new DatabaseSync(path.join(s.dir,'varaq.sqlite'));t.after(()=>db.close());
 const name='c'.repeat(32)+'.png';
 db.prepare('INSERT INTO book_covers(book_id,filename,mime,alt,source,rights_note) VALUES(?,?,?,?,?,?)').run(1,name,'image/png','نام جلد','آزمایشی','حق انتشار آزمایشی');
 let r=await fetch(s.base+'/book/book-001');let h=await r.text();assert.doesNotMatch(h,new RegExp(name));assert.match(h,/طرح اختصاصی ورق · نه جلد ناشر/);
 r=await fetch(s.base+'/media/covers/'+name);assert.equal(r.status,404);
 r=await fetch(s.base+'/panel/media-integrity',{redirect:'manual'});assert.equal(r.status,303);
 r=await fetch(s.base+'/panel/media-integrity.csv',{redirect:'manual'});assert.equal(r.status,303);
 const cookie=await admin(s.base);
 r=await fetch(s.base+'/panel/media-integrity?status=missing&q=1',{headers:{cookie}});assert.equal(r.status,200);h=await r.text();assert.match(h,/سلامت تصاویر و PDFها/);assert.match(h,/فایل روی دیسک وجود ندارد/);
 r=await fetch(s.base+'/panel/media-integrity.csv?status=missing',{headers:{cookie}});assert.equal(r.status,200);assert.match(r.headers.get('content-type'),/text\/csv/);assert.match(r.headers.get('cache-control'),/no-store/);assert.match(await r.text(),/missing_file/);
 const owner=db.prepare("SELECT password_hash FROM users WHERE role='owner'").get();const store=db.prepare('SELECT id FROM stores ORDER BY id LIMIT 1').get();
 db.prepare("INSERT INTO users(username,password_hash,role,store_id,enabled,must_change_password,staff_permission) VALUES(?,?,'seller',?,1,0,'manager')").run('seller51',owner.password_hash,store.id);
 r=await fetch(s.base+'/login',{method:'POST',redirect:'manual',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({username:'seller51',password:'VarAQ-Final-Pass-51-secure!'})});const seller=r.headers.get('set-cookie').split(';')[0];
 r=await fetch(s.base+'/panel/media-integrity',{headers:{cookie:seller}});assert.equal(r.status,403);
 r=await fetch(s.base+'/panel/media-integrity.csv',{headers:{cookie:seller}});assert.equal(r.status,403);
 const health=await(await fetch(s.base+'/health')).json();assert.equal(health.version,'8.6.0');assert.equal(health.payment_enabled,false);
});
test('5.1 read-only PDF vault audit rejects missing, invalid and tampered files',async t=>{
 const s=await boot(t),db=new DatabaseSync(path.join(s.dir,'varaq.sqlite'));t.after(()=>db.close());
 const store=db.prepare('SELECT id FROM stores ORDER BY id LIMIT 1').get();
 const crypto=require('node:crypto'),file='d'.repeat(32)+'.pdf';
 db.prepare(`INSERT INTO digital_books(store_id,book_id,title,description,price,filename,original_name,file_sha256,file_bytes,rights_holder,rights_basis,rights_evidence,status) VALUES(?,1,'PDF test','',20000,?,'test.pdf',?,?,'صاحب حقوق','مجوز آزمایشی','سند آزمایشی شماره ۵۱','draft')`).run(store.id,file,crypto.createHash('sha256').update(pdfBytes).digest('hex'),pdfBytes.length);
 const dir=path.join(s.dir,'digital-pdfs'),record=db.prepare('SELECT * FROM digital_books LIMIT 1').get();
 assert.equal(media.checkPdf(dir,record).state,'missing_file');
 fs.writeFileSync(path.join(dir,file),pdfBytes);
 assert.equal(media.checkPdf(dir,record).state,'ok');
 fs.writeFileSync(path.join(dir,file),Buffer.concat([pdfBytes,Buffer.from('tampered')]));
 assert.equal(media.checkPdf(dir,record).state,'invalid_file');
 let all=media.safeRows(db,s.dir);assert.equal(all.filter(x=>x.type==='digital_pdf').length,1);
 assert.equal(media.filter(all,'pdf').length,1);
 assert.equal(media.filter(all,'covers').some(x=>x.type==='digital_pdf'),false);
});
