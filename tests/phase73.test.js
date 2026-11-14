'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {spawn}=require('node:child_process');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const {distance,suggest}=require('../lib/search-assist');
const pause=ms=>new Promise(done=>setTimeout(done,ms));

async function server(t){
 const root=path.resolve(__dirname,'..');
 const storage=fs.mkdtempSync(path.join(os.tmpdir(),'varaq73-search-'));
 const socket=net.createServer();
 const port=await new Promise((resolve,reject)=>{socket.once('error',reject);socket.listen(0,'127.0.0.1',()=>{const n=socket.address().port;socket.close(()=>resolve(n));});});
 const base='http://127.0.0.1:'+port;
 const child=spawn(process.execPath,['server.js'],{cwd:root,env:{...process.env,HOST:'127.0.0.1',PORT:String(port),DATA_DIR:storage,PUBLIC_URL:base},stdio:['ignore','ignore','pipe']});
 let errors='';child.stderr.on('data',data=>errors+=String(data));
 t.after(async()=>{if(child.exitCode===null){child.kill('SIGINT');await Promise.race([new Promise(ok=>child.once('exit',ok)),pause(1500)]);}fs.rmSync(storage,{recursive:true,force:true});});
 for(let i=0;i<100;i++){try{const res=await fetch(base+'/health');if(res.ok)return base;}catch{}await pause(80);}
 throw Error('Could not start VARAQ '+errors);
}

test('7.3: typo matching is bounded and uses only actual database records',()=>{
 assert.equal(distance('کیمایگر','کیمیاگر',2),2);
 const db=new DatabaseSync(':memory:');
 db.exec('CREATE TABLE books (id INTEGER,slug TEXT,title TEXT,author TEXT)');
 db.prepare('INSERT INTO books VALUES (?,?,?,?)').run(1,'book-001','ملت عشق','الیف شافاک');
 db.prepare('INSERT INTO books VALUES (?,?,?,?)').run(2,'book-002','کیمیاگر','پائولو کوئیلو');
 db.prepare('INSERT INTO books VALUES (?,?,?,?)').run(3,'book-003','شازده کوچولو','آنتوان دو سنت اگزوپری');
 assert.equal(suggest(db,{q:'کیمایگر'})[0].slug,'book-002');
 assert.equal(suggest(db,{q:'شازده کوشولو'})[0].slug,'book-003');
 assert.deepEqual(suggest(db,{q:'9781234567890'}),[]);
 assert.deepEqual(suggest(db,{q:'\u200c'}),[]);
 assert.deepEqual(suggest(db,{q:'نامفهوممممممممممم'}),[]);
 db.close();
});

test('7.3: zero-result search suggests real books and avoids fabricated purchases',async t=>{
 const base=await server(t);
 const r=await fetch(base+'/books?q='+encodeURIComponent('کیمایگر'));
 assert.equal(r.status,200);
 const html=await r.text();
 assert.match(html,/راهنمای جست‌وجو/);
 assert.match(html,/<a href="\/book\/book-002"><strong>کیمیاگر<\/strong>/);
 assert.doesNotMatch(html,/class="cta add-cart"/);
 assert.equal((await(await fetch(base+'/health')).json()).payment_enabled,false);
});

test('7.3: over-filtered query offers a safe unfiltered link preserving query',async t=>{
 const base=await server(t);
 const path='/books?q='+encodeURIComponent('ملت عشق')+'&publisher='+encodeURIComponent('ناشر ناموجود');
 const html=await(await fetch(base+path)).text();
 assert.match(html,/فیلترهای انتخاب‌شده آن‌ها را پنهان کرده‌اند/);
 assert.match(html,/href="\/books\?q=%D9%85%D9%84%D8%AA%20%D8%B9%D8%B4%D9%82"/);
 assert.doesNotMatch(html,/class="cta add-cart"/);
});

test('7.3: exact results stay unchanged, malicious query stays escaped and CSS is responsive',async t=>{
 const base=await server(t);
 const exact=await(await fetch(base+'/books?q='+encodeURIComponent('ملت عشق'))).text();
 assert.match(exact,/ملت عشق/);
 assert.doesNotMatch(exact,/v73-search-help/);
 const injected=await(await fetch(base+'/books?q='+encodeURIComponent('<script>alert(1)</script>'))).text();
 assert.doesNotMatch(injected,/<script>alert\(1\)<\/script>/);
 assert.match(injected,/&lt;script&gt;/);
 const css=fs.readFileSync(path.join(__dirname,'../public/style.css'),'utf8');
 assert.match(css,/\.v73-search-help/);
 assert.match(css,/@media\(max-width:640px\)/);
});
