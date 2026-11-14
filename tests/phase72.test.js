'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {overview}=require('../lib/book-detail-overview');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const net=require('node:net');
const {spawn}=require('node:child_process');
const {DatabaseSync}=require('node:sqlite');
const pause=ms=>new Promise(done=>setTimeout(done,ms));

async function start(t,publicMode=true){
 const root=path.resolve(__dirname,'..'),storage=fs.mkdtempSync(path.join(os.tmpdir(),'varaq72-'));
 const socket=net.createServer();
 const port=await new Promise((ok,bad)=>{socket.listen(0,'127.0.0.1',()=>{const n=socket.address().port;socket.close(()=>ok(n));});socket.once('error',bad);});
 const base=`http://127.0.0.1:${port}`;
 const child=spawn(process.execPath,['server.js'],{cwd:root,env:{...process.env,DATA_DIR:storage,HOST:'127.0.0.1',PORT:String(port),PUBLIC_URL:publicMode?base:''},stdio:['ignore','ignore','pipe']});
 let err='';child.stderr.on('data',b=>err+=b.toString());
 t.after(async()=>{if(child.exitCode===null){child.kill('SIGINT');await Promise.race([new Promise(ok=>child.once('exit',ok)),pause(1500)]);}fs.rmSync(storage,{recursive:true,force:true});});
 for(let i=0;i<150;i++){try{const r=await fetch(base+'/health');if(r.ok)return {base,storage};}catch{}await pause(65);}throw Error('Failed boot '+err);
}

test('7.2: overview counts unique sellers, filters the exact ISBN edition and uses reduced prices',()=>{
 const editions=[{id:1,isbn:'9781234567897'},{id:2,isbn:'9780000000002'}];
 const offers=[
  {edition_id:1,store_id:5,stock:2,price:400000},
  {edition_id:1,store_id:5,stock:4,price:380000},
  {edition_id:2,store_id:7,stock:1,price:220000},
  {edition_id:2,store_id:8,stock:0,price:120000},
  {edition_id:1,store_id:9,stock:2,price:0}
 ];
 const all=overview({editions,offers,digital:[{},{}]});
 assert.deepEqual([all.editionCount,all.sellerCount,all.minPrice,all.digitalCount],[2,2,220000,2]);
 const selected=overview({editions,offers,digital:[],selectedEdition:editions[0]});
 assert.deepEqual([selected.sellerCount,selected.minPrice,selected.selectedIsbn],[1,380000,'9781234567897']);
 assert.deepEqual([overview().sellerCount,overview().minPrice],[0,null]);
});

test('7.2: book detail shows independent print/PDF statuses and accessible navigation without fake checkout',async t=>{
 const {base,storage}=await start(t,true);
 const response=await fetch(base+'/book/book-001');assert.equal(response.status,200);
 const html=await response.text();
 assert.match(html,/id="v72-overview-title">نسخه‌ها در یک نگاه/);
 assert.match(html,/href="#v72-overview-title">در یک نگاه/);
 assert.match(html,/class="v72-detail-actions"/);
 assert.match(html,/خواندن معرفی کتاب/);
 assert.match(html,/قیمت و موجودی قطعی نیست؛ ثبت سفارش واقعی و پرداخت فعال نشده است/);
 assert.match(html,/نسخه PDF قابل معرفی/);
 assert.match(html,/aria-label="دسترسی سریع به جزئیات کتاب"/);
 assert.doesNotMatch(html,/class="cta add-cart"/);
 const edb=new DatabaseSync(path.join(storage,'varaq.sqlite'));
 const ed=edb.prepare('SELECT id,isbn FROM editions WHERE book_id=(SELECT id FROM books WHERE slug=?) AND verified=1 LIMIT 1').get('book-001');
 edb.close();
 if(ed){
  const chosen=await fetch(base+'/book/book-001?edition='+ed.id);
  assert.equal(chosen.status,200);
  const chosenPage=await chosen.text();assert.match(chosenPage,/چاپ انتخاب‌شده · شابک/);
  assert.ok(chosenPage.includes(ed.isbn));
 }
 const preview=await(await fetch(base+'/choose-format?book=book-001')).text();assert.match(preview,/پرداخت/);
 assert.equal((await fetch(base+'/pdf-delivery/'+'X'.repeat(43))).status,404);
 const health=await (await fetch(base+'/health')).json();assert.equal(health.payment_enabled,false);assert.equal(health.version,'8.6.0');
});

test('7.2: mobile style does not require JavaScript, and legacy packages and thumbnails survive',()=>{
 const root=path.resolve(__dirname,'..');
 const css=fs.readFileSync(path.join(root,'public/style.css'),'utf8');
 assert.match(css,/\.v57-detail-nav\{display:flex;flex-wrap:nowrap;overflow-x:auto/);
 assert.match(css,/\.v72-overview-grid\{display:grid/);
 assert.match(css,/\.v72-detail-actions a:focus-visible/);
 assert.equal(fs.readdirSync(path.join(root,'public/concept-art')).filter(x=>x.endsWith('.webp')).length,1000);
 assert.equal(fs.readdirSync(path.join(root,'public/concept-thumb')).filter(x=>x.endsWith('.webp')).length,1000);
 for(const f of ['START_WINDOWS.bat','STOP_ALL.bat','BACKUP_WINDOWS.bat','PREPARE_REMOVAL_WINDOWS.bat'])assert.ok(fs.existsSync(path.join(root,f)));
});
