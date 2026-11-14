'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawn}=require('node:child_process'),net=require('node:net');
const {DatabaseSync}=require('node:sqlite'),research=require('../lib/cover-research');
async function boot(t,oldData){
 const tmp=oldData||fs.mkdtempSync(path.join(os.tmpdir(),'varaq23-'));
 const listener=net.createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
 const proc=spawn(process.execPath,['server.js'],{cwd:path.resolve(__dirname,'..'),env:{...process.env,DATA_DIR:tmp,VARAQ_CURATED_SEED:'1',HOST:'127.0.0.1',PORT:String(port),PUBLIC_URL:''},stdio:['ignore','pipe','pipe']});
 let out='';await new Promise((ok,fail)=>{const timer=setTimeout(()=>fail(Error('timeout '+out)),12000);proc.stdout.on('data',d=>{out+=d;if(out.includes('PAYMENT: DISABLED')){clearTimeout(timer);ok();}});proc.stderr.on('data',d=>out+=d);proc.on('exit',c=>fail(Error('server exited '+c+' '+out)));});
 t.after(()=>{proc.kill();if(!oldData)fs.rmSync(tmp,{recursive:true,force:true});});return {dir:tmp,url:`http://127.0.0.1:${port}`};
}
test('v2.3 seed adds exactly seven source-linked ISBNs for five titles and leaves payment disabled',async t=>{
 const a=await boot(t),db=new DatabaseSync(path.join(a.dir,'varaq.sqlite'));
 const totals=research.auditSummary(db);assert.equal(totals.books,1000);assert.equal(totals.sourced_editions,128);assert.equal(totals.books_with_sources,71);assert.equal(totals.uploaded_edition_covers,0);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM editions WHERE book_id=19 AND verified=1').get().n,2);
 assert.equal(db.prepare('SELECT count(*) n FROM edition_sources WHERE rights_confirmed=1').get().n,0);
 const h=await(await fetch(a.url+'/health')).json();assert.equal(h.payment_enabled,false);assert.equal(h.version,'8.6.0');db.close();
});
test('v2.3 rights review needs ISBN match, documented permission, and cannot publish cover itself',async t=>{
 const a=await boot(t),db=new DatabaseSync(path.join(a.dir,'varaq.sqlite'));
 const e=research.list(db).find(x=>x.title==='صد سال تنهایی');assert.ok(e);
 const id=research.add(db,{edition_id:e.edition_id,image_url:'https://publisher.example/book-cover.jpg',source_url:'https://publisher.example/book',source_name:'ناشر'},null);
 assert.throws(()=>research.setStatus(db,id,'ready_for_upload',{},1),/مدرک|تطبیق/);
 assert.throws(()=>research.setStatus(db,id,'ready_for_upload',{match_evidence:'کد شابک در سایت ناشر دیده شد',rights_evidence:'',isbn_checked:'1',rights_checked:'1'},1));
 research.setStatus(db,id,'ready_for_upload',{match_evidence:'تصویر بارکد ISBN منطبق با چاپ',rights_evidence:'موافقت کتبی ثبت‌شده مالک تصویر برای نمایش در سایت',isbn_checked:'1',rights_checked:'1'},null);
 assert.equal(research.candidates(db,e.edition_id)[0].status,'ready_for_upload');
 assert.equal(db.prepare('SELECT COUNT(*) n FROM edition_cover_assets').get().n,0);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM edition_sources WHERE rights_confirmed=1').get().n,0);
 assert.match(research.rightsExport(db),/ready_for_upload/);db.close();
});
test('v2.3 rights CSV remains private to owner login',async t=>{
 const a=await boot(t);const res=await fetch(a.url+'/panel/cover-rights.csv',{redirect:'manual'});assert.equal(res.status,303);
 const read=await fetch(a.url+'/books');assert.equal(read.status,200);assert.doesNotMatch(await read.text(),/publisher\.example/);
});
test('v2.3 schema upgrade preserves existing v2.2 candidates and expands review statuses',()=>{
 const db=new DatabaseSync(':memory:');db.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY);CREATE TABLE editions(id INTEGER PRIMARY KEY);
  INSERT INTO users(id) VALUES(1);INSERT INTO editions(id) VALUES(1);
  CREATE TABLE online_cover_candidates (
   id INTEGER PRIMARY KEY, edition_id INTEGER NOT NULL REFERENCES editions(id) ON DELETE CASCADE,
   image_url TEXT NOT NULL,source_url TEXT NOT NULL,source_name TEXT NOT NULL,
   rights_note TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'research'
   CHECK(status IN ('research','rejected','permission_pending')),
   created_by INTEGER REFERENCES users(id),created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
   UNIQUE(edition_id,image_url)
  );INSERT INTO online_cover_candidates(id,edition_id,image_url,source_url,source_name,rights_note,status,created_by)
   VALUES(7,1,'https://book.example/a.jpg','https://book.example/book','ناشر','تطبیق نشده','permission_pending',1);`);
 research.migrate(db);const row=db.prepare('SELECT * FROM online_cover_candidates WHERE id=7').get();assert.equal(row.status,'permission_pending');assert.equal(row.created_by,1);
 research.setStatus(db,7,'ready_for_upload',{match_evidence:'مطابقت بارکد و شابک چاپ',rights_evidence:'اجازه کتبی استفاده از تصویر صاحب اثر',isbn_checked:'1',rights_checked:'1'},1);
 assert.equal(db.prepare('SELECT status FROM online_cover_candidates WHERE id=7').get().status,'ready_for_upload');
 research.migrate(db);assert.equal(db.prepare('SELECT COUNT(*) n FROM online_cover_candidates').get().n,1);db.close();
});
