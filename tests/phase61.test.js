'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const {spawn}=require('node:child_process'),{DatabaseSync}=require('node:sqlite');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function boot(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'varaq61-'));
 const socket=net.createServer();await new Promise(done=>socket.listen(0,'127.0.0.1',done));
 const port=socket.address().port;await new Promise(done=>socket.close(done));
 const base='http://127.0.0.1:'+port,proc=spawn(process.execPath,['server.js'],{cwd:path.join(__dirname,'..'),env:{...process.env,PORT:String(port),HOST:'127.0.0.1',DATA_DIR:dir,PUBLIC_URL:'',VARAQ_CURATED_SEED:'1'},stdio:['ignore','pipe','pipe']});
 let err='';proc.stderr.on('data',chunk=>err+=chunk.toString());
 t.after(async()=>{if(proc.exitCode===null){proc.kill('SIGTERM');await Promise.race([new Promise(ok=>proc.once('exit',ok)),sleep(1500)]);}fs.rmSync(dir,{recursive:true,force:true});});
 for(let i=0;i<120;i++){try{if((await fetch(base+'/health')).ok)return {base,dir};}catch{}await sleep(60);}
 throw Error('Server did not start: '+err);
}
test('6.1: missing real covers render attractive, truthfully labeled book profiles, not repetitive pending badges',async t=>{
 const {base}=await boot(t);
 const html=await(await fetch(base+'/books')).text();
 assert.match(html,/varaq-concept-cover/);
 assert.match(html,/طرح اختصاصی ورق · نه جلد ناشر/);
 assert.match(html,/ملت عشق/);
 assert.doesNotMatch(html,/جلد در حال تکمیل/);
 assert.doesNotMatch(html,/picture-pending/);
 assert.ok(new Set([...html.matchAll(/concept-thumb\/book-(\d{3})\.webp/g)].map(x=>x[1])).size>=3);
 const b=await(await fetch(base+'/book/book-006')).text();
 assert.match(b,/تصویر گرافیکی اختصاصی معرفی کتاب جنایت و مکافات/);
 assert.match(b,/طرح اختصاصی ورق · نه جلد ناشر/);
 const style=html.match(/href="(\/assets\/style\.[^"]+\.css)"/)?.[1];assert.ok(style);
 const css=await(await fetch(base+style)).text();assert.match(css,/VARAQ 6\.1/);assert.match(css,/@media\(max-width:620px\)/);
});
test('6.1: valid local book-cover image replaces catalog profile; missing image never claims to exist',async t=>{
 const {base,dir}=await boot(t);const db=new DatabaseSync(path.join(dir,'varaq.sqlite'));t.after(()=>db.close());
 const name='f'.repeat(32)+'.png',cover=fs.readFileSync(path.join(__dirname,'fixtures','test_cover.png'));
 let html=await(await fetch(base+'/books?q='+encodeURIComponent('جنایت و مکافات'))).text();assert.match(html,/varaq-concept-cover/);
 db.prepare('INSERT INTO book_covers(book_id,filename,mime,alt,source,rights_note) VALUES(?,?,?,?,?,?)').run(6,name,'image/png','جلد مجاز چاپ تطبیق‌داده‌شده','منبع مستند','تأییدیه صاحب حقوق');
 fs.writeFileSync(path.join(dir,'covers',name),cover);
 html=await(await fetch(base+'/books?q='+encodeURIComponent('جنایت و مکافات'))).text();assert.match(html,new RegExp('/media/covers/'+name));assert.match(html,/v48-cover-status has-picture/);assert.doesNotMatch(html,/varaq-concept-cover/);
 const imageResponse=await fetch(base+'/media/covers/'+name);assert.equal(imageResponse.status,200);
 const health=await(await fetch(base+'/health')).json();assert.equal(health.version,'8.6.0');assert.equal(health.payment_enabled,false);
});
test('6.1: storefront keeps PDF catalog and payment disabled; design does not manufacture rights',async t=>{
 const {base,dir}=await boot(t);
 const html=await(await fetch(base+'/pdf-books')).text();assert.match(html,/کتاب‌های PDF/);
 const db=new DatabaseSync(path.join(dir,'varaq.sqlite'));t.after(()=>db.close());
 const rights=db.prepare('SELECT COUNT(*) n FROM edition_sources WHERE rights_confirmed=1').get();assert.equal(rights.n,0);
 const coverAssets=db.prepare('SELECT COUNT(*) n FROM book_covers').get();assert.equal(coverAssets.n,0);
 const r=await fetch(base+'/panel/cover-web-upload',{redirect:'manual'});assert.equal(r.status,303);
});
