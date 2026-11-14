'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const {spawn}=require('node:child_process');
const {DatabaseSync}=require('node:sqlite');
async function boot(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'varaq33-'));
 const sock=net.createServer();await new Promise(r=>sock.listen(0,'127.0.0.1',r));const port=sock.address().port;await new Promise(r=>sock.close(r));
 const child=spawn(process.execPath,['server.js'],{cwd:path.join(__dirname,'..'),env:{...process.env,VARAQ_CURATED_SEED:'1',DATA_DIR:dir,HOST:'127.0.0.1',PORT:String(port),PUBLIC_URL:''},stdio:['ignore','pipe','pipe']});
 let log=''; await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('Server timeout '+log)),20000);const listener=x=>{log+=x.toString();if(log.includes('PAYMENT: DISABLED')){clearTimeout(timeout);resolve();}};child.stdout.on('data',listener);child.stderr.on('data',listener);child.once('exit',c=>{clearTimeout(timeout);reject(Error('server exited '+c+' '+log));});});
 const db=new DatabaseSync(path.join(dir,'varaq.sqlite'));
 t.after(async()=>{db.close();child.kill('SIGTERM');await new Promise(r=>{if(child.exitCode!==null||child.signalCode)r();else child.once('exit',r);});fs.rmSync(dir,{recursive:true,force:true});});
 return {db,url:'http://127.0.0.1:'+port,dir};
}
test('3.3: selecting edition displays exactly matching ISBN and approved image, not another cover',async t=>{
 const s=await boot(t); const b=s.db.prepare('SELECT id,slug FROM books WHERE id=1').get();
 const existing=s.db.prepare('SELECT id FROM editions WHERE book_id=1 ORDER BY id LIMIT 1').get();assert.ok(existing);
 const other=Number(s.db.prepare("INSERT INTO editions(book_id,label,translator,publisher,isbn,verified) VALUES(1,'نسخه دوم آزمایشی','مترجم تست','ناشر دوم','9780131103627',1)").run().lastInsertRowid);
 const name='1234567890abcdef1234567890abcdef.png';
 s.db.prepare('INSERT INTO edition_cover_assets(edition_id,filename,mime,alt,source,rights_note) VALUES(?,?,?,?,?,?)').run(existing.id,name,'image/png','عکس مجاز چاپ اول','تصویر آزمایشی دارای اجازه','تأیید آزمایشی حق استفاده');
 // v5.1 checks that the referenced cover file exists and is a valid image.
 fs.writeFileSync(path.join(s.dir,'covers',name),fs.readFileSync(path.join(__dirname,'fixtures','test_cover.png')));
 const base='/book/'+encodeURIComponent(b.slug);
 let r=await fetch(s.url+base+'?edition='+existing.id);assert.equal(r.status,200);let h=await r.text();
 assert.ok(h.includes('src="/media/covers/'+name+'"')); assert.match(h,/چاپ انتخاب‌شده/); assert.match(h,/9780131103627/);
 r=await fetch(s.url+base+'?edition='+other);assert.equal(r.status,200);h=await r.text();
 assert.doesNotMatch(h.split('<div class="detail-text">')[0],new RegExp('src="/media/covers/'+name+'"'));
 assert.match(h,/جلد واقعی این چاپ هنوز تأیید نشده است/); assert.match(h,/ناشر دوم/);
 assert.match(h,new RegExp('href="/book/'+b.slug+'\\?edition='+existing.id));
});
test('3.3: selected edition filters seller offers and rejects cross-book forged edition',async t=>{
 const s=await boot(t);const b=s.db.prepare('SELECT id,slug FROM books WHERE id=1').get();
 const first=s.db.prepare('SELECT id FROM editions WHERE book_id=1 ORDER BY id LIMIT 1').get().id;
 const second=Number(s.db.prepare("INSERT INTO editions(book_id,label,translator,publisher,isbn,verified) VALUES(1,'چاپ دوم','تست','ناشر تست','9780131103627',1)").run().lastInsertRowid);
 s.db.prepare("UPDATE stores SET active=1 WHERE id=1").run();
 const add=s.db.prepare('INSERT INTO stock_items(book_id,store_id,edition_id,sku,price,quantity,active) VALUES(?,1,?,?,150000,5,1)');
 add.run(b.id,first,'E33-FIRST');add.run(b.id,second,'E33-SECOND');
 let h=await (await fetch(s.url+'/book/'+b.slug+'?edition='+first)).text();assert.match(h,/E33-FIRST/);assert.doesNotMatch(h,/E33-SECOND/);
 h=await (await fetch(s.url+'/book/'+b.slug+'?edition='+second)).text();assert.match(h,/E33-SECOND/);assert.doesNotMatch(h,/E33-FIRST/);
 h=await (await fetch(s.url+'/book/'+b.slug)).text();assert.match(h,/E33-FIRST/);assert.match(h,/E33-SECOND/);
 const foreign=s.db.prepare('SELECT id FROM editions WHERE book_id!=1 ORDER BY id LIMIT 1').get().id;
 assert.equal((await fetch(s.url+'/book/'+b.slug+'?edition='+foreign)).status,404);
 assert.equal((await fetch(s.url+'/book/'+b.slug+'?edition=banana')).status,404);
 assert.equal((await fetch(s.url+'/book/'+b.slug+'?edition=-1')).status,404);
 const status=await(await fetch(s.url+'/health')).json();assert.equal(status.payment_enabled,false);assert.equal(status.version,'8.6.0');
});
