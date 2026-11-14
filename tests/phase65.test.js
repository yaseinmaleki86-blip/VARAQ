'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const {spawn}=require('node:child_process');
const topic=require('../lib/topic-discovery'),review=require('../lib/generated-editorial-review');
const catalogue=require('../data/generated_catalog_v63.json'),bookData=require('../data/books.json');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const index=new Map(catalogue.map(b=>[b.id,b]));

test('6.5: 200 catalogue entries, browsable topics and shared-theme ranking without fabricated metrics',()=>{
 assert.equal(bookData.length,1000);assert.equal(catalogue.length,200);
 const ts=topic.themes(bookData,index,()=>false);
 assert.ok(ts.length>=10);assert.ok(ts.find(x=>x.topic==='عشق'&&x.count>=10));
 const fromTopic=topic.browse(bookData,index,()=>false,'عشق');
 assert.equal(fromTopic.length,ts.find(x=>x.topic==='عشق').count);
 assert.ok(fromTopic.every(b=>index.get(b.id).topics.includes('عشق')));
 assert.equal(topic.browse(bookData,index,()=>false,'<script>alert(1)</script>').length,0);
 const list=topic.related(bookData[0],bookData,index,()=>false);
 assert.ok(list.length>0&&list.length<=6);
 assert.ok(list.every(x=>x.book.id!==bookData[0].id && x.points>0 && x.reason));
 assert.ok(list.every((x,i)=>i===0||x.points<=list[i-1].points));
 const hidden=topic.related(bookData[0],bookData,index,entry=>entry.id===bookData[0].id);
 assert.ok(hidden.every(x=>!x.common.length));
});
async function serve(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'varaq65-'));
 const sock=net.createServer();await new Promise(resolve=>sock.listen(0,'127.0.0.1',resolve));const port=sock.address().port;await new Promise(resolve=>sock.close(resolve));
 const base='http://127.0.0.1:'+port;
 const proc=spawn(process.execPath,['server.js'],{cwd:path.join(__dirname,'..'),env:{...process.env,DATA_DIR:dir,HOST:'127.0.0.1',PORT:String(port),PUBLIC_URL:''},stdio:['ignore','pipe','pipe']});
 let error='';proc.stderr.on('data',c=>error+=c);
 t.after(async()=>{if(proc.exitCode===null){proc.kill();await Promise.race([new Promise(resolve=>proc.once('exit',resolve)),delay(1300)])}fs.rmSync(dir,{recursive:true,force:true})});
 for(let i=0;i<130;i++){try{if((await fetch(base+'/health')).ok)return{base,dir};}catch{}await delay(50)}throw Error(error);
}
test('6.5: real routes, links, private editorial status and payment guard',async t=>{
 const s=await serve(t);const db=new DatabaseSync(path.join(s.dir,'varaq.sqlite'));t.after(()=>db.close());
 const health=await(await fetch(s.base+'/health')).json();assert.equal(health.version,'8.6.0');assert.equal(health.payment_enabled,false);
 const indexPage=await(await fetch(s.base+'/themes')).text();assert.match(indexPage,/کشف کتاب با موضوع دلخواه/);assert.match(indexPage,/دوستی/);
 const r=await fetch(s.base+'/themes?topic='+encodeURIComponent('عشق'));
 assert.equal(r.status,200);assert.match(r.headers.get('x-robots-tag')||'',/noindex/);
 const html=await r.text();assert.match(html,/کتاب‌های مرتبط با/);assert.match(html,/book-card-v48/);
 const detail=await(await fetch(s.base+'/book/book-001')).text();assert.match(detail,/کتاب‌های مرتبط؛ برای ادامه کشف/);assert.match(detail,/موضوع مشترک|دسته‌بندی مشابه|نویسنده مشترک/);assert.match(detail,/\/themes\?topic=/);
 const home=await(await fetch(s.base+'/')).text();assert.match(home,/با یک موضوع شروع کن/);
 const bad=await(await fetch(s.base+'/themes?topic=%3Cscript%3E')).text();assert.doesNotMatch(bad,/<script>alert/);
 review.migrate(db);
 const item=catalogue[0];db.prepare(`INSERT INTO generated_editorial_reviews(book_id,status,content_hash,revision) VALUES(?,?,?,1)`).run(item.id,'hidden',review.hash(item));
 const hidden=await(await fetch(s.base+'/book/book-001')).text();assert.doesNotMatch(hidden,/راهنمای مطالعه اولیه/);
 assert.equal((await fetch(s.base+'/pdf-delivery/'+'1'.repeat(43))).status,404);
});
