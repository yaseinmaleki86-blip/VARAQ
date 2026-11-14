'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const {spawn}=require('node:child_process');
const merchandising=require('../lib/merchandising');
const ROOT=path.resolve(__dirname,'..');
async function port(){return new Promise((res,rej)=>{const n=net.createServer();n.on('error',rej);n.listen(0,'127.0.0.1',()=>{const p=n.address().port;n.close(()=>res(p));});});}
async function setup(t){const storage=fs.mkdtempSync(path.join(os.tmpdir(),'varaq18-')),p=await port();const proc=spawn(process.execPath,['server.js'],{cwd:ROOT,env:{...process.env,DATA_DIR:storage,PORT:String(p),HOST:'127.0.0.1',PUBLIC_URL:''},stdio:['ignore','pipe','pipe']});let buf='';await new Promise((done,fail)=>{const timer=setTimeout(()=>fail(Error('Server startup timed out '+buf)),12000);const log=d=>{buf+=d.toString();if(buf.includes('PAYMENT: DISABLED')){clearTimeout(timer);done();}};proc.stdout.on('data',log);proc.stderr.on('data',log);proc.on('exit',code=>fail(Error('Exited '+code+' '+buf)));});const db=new DatabaseSync(path.join(storage,'varaq.sqlite'));
 t.after(async()=>{db.close();proc.kill('SIGINT');await new Promise(r=>{if(proc.exitCode!==null||proc.signalCode)r();else proc.once('exit',r);});fs.rmSync(storage,{recursive:true,force:true});});return {db,url:`http://127.0.0.1:${p}`};}
const csrf=x=>x.match(/name="csrf" value="([^"]+)"/)?.[1];const cookie=r=>r.headers.get('set-cookie')?.split(';')[0];
async function get(s,p,c=''){return fetch(s.url+p,{headers:{cookie:c},redirect:'manual'});}
async function post(s,p,fields,c=''){return fetch(s.url+p,{method:'POST',headers:{cookie:c,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(fields),redirect:'manual'});}
async function owner(s){let r=await post(s,'/login',{username:'admin',password:'ad123456789'});let c=cookie(r);const token=csrf(await (await get(s,'/panel/account',c)).text());r=await post(s,'/panel/account',{csrf:token,username:'admin',old_password:'ad123456789',new_password:'StrongOwnerPassword1234',confirm_password:'StrongOwnerPassword1234'},c);assert.equal(r.status,303);r=await post(s,'/login',{username:'admin',password:'StrongOwnerPassword1234'});c=cookie(r);return {cookie:c,csrf:csrf(await (await get(s,'/panel/merchandising?store=1',c)).text())};}
function item(db,store,book,sku,price=100000,quantity=5){let e=db.prepare('SELECT id FROM editions WHERE book_id=?').get(book);if(!e){const isbn=book===1?'9780131103627':book===2?'9780201633610':'9780321125217';e={id:Number(db.prepare("INSERT INTO editions(book_id,label,publisher,isbn,verified) VALUES(?,'تست','ناشر تست',?,1)").run(book,isbn).lastInsertRowid)};}return Number(db.prepare('INSERT INTO stock_items(store_id,book_id,edition_id,sku,price,quantity,active) VALUES(?,?,?,?,?,?,1)').run(store,book,e.id,sku,price,quantity).lastInsertRowid);}
const lines=(...rows)=>'sku,expected_price,new_price,expected_quantity,new_quantity\n'+rows.join('\n');

test('v1.8: CSV preview, atomic price/stock commit, ledger, price history and demo payment disabled',async t=>{
 const s=await setup(t),a=await owner(s),db=s.db;
 const id1=item(db,1,1,'SKU-1801'),id2=item(db,1,2,'SKU-1802',80000,7);
 const csv=lines('SKU-1801,100000,108000,5,3','SKU-1802,80000,79000,7,8');
 let r=await get(s,'/panel/merchandising-template.csv?store=1',a.cookie);assert.equal(r.status,200);assert.match(await r.text(),/SKU-1801,100000,100000,5,5/);
 r=await post(s,'/panel/merchandising',{csrf:a.csrf,store_id:'1',mode:'preview',csv,note:'به‌روزرسانی تامین‌کننده'},a.cookie);assert.equal(r.status,200);assert.match(await r.text(),/پیش‌نمایش و بررسی گروهی/);
 assert.equal(db.prepare('SELECT price FROM stock_items WHERE id=?').get(id1).price,100000,'preview must not change data');
 r=await post(s,'/panel/merchandising',{csrf:a.csrf,store_id:'1',mode:'commit',csv,note:'به‌روزرسانی تامین‌کننده',confirm:'1'},a.cookie);assert.equal(r.status,303);
 assert.deepEqual({...db.prepare('SELECT price,quantity FROM stock_items WHERE id=?').get(id1)},{price:108000,quantity:3});
 assert.deepEqual({...db.prepare('SELECT price,quantity FROM stock_items WHERE id=?').get(id2)},{price:79000,quantity:8});
 assert.equal(db.prepare('SELECT COUNT(*) n FROM stock_movements WHERE store_id=1 AND reason=\'correction\'').get().n,2);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM stock_price_history WHERE store_id=1').get().n,2);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM bulk_merch_changes').get().n,2);
 assert.equal((await (await get(s,'/health')).json()).payment_enabled,false);
 r=await post(s,'/panel/merchandising',{csrf:a.csrf,store_id:'1',mode:'commit',csv,note:'به‌روزرسانی تامین‌کننده',confirm:'1'},a.cookie);assert.equal(r.status,409,'stale CSV must fail');
 assert.equal(db.prepare('SELECT COUNT(*) n FROM bulk_merch_batches').get().n,1);
});

test('v1.8: CSV validation rejects duplicates, wrong store, changed expected state, formulas and mixed invalid rows',async t=>{
 const s=await setup(t),a=await owner(s),db=s.db;item(db,1,1,'SKU-1803');
 db.prepare("INSERT INTO stores(name,slug,city,active) VALUES('دوم','second18','یزد',1)").run();item(db,2,2,'SKU-SECOND-18');
 assert.throws(()=>merchandising.parseCsv(lines('SKU-1803,100000,105000,5,5','SKU-1803,100000,101000,5,5')), /تکراری/);
 assert.throws(()=>merchandising.parseCsv(lines('=HYPERLINK,100000,105000,5,5')), /SKU/);
 assert.throws(()=>merchandising.parseCsv(lines('SKU-1803,-1,105000,5,5')), /قیمت/);
 assert.throws(()=>merchandising.parseCsv(lines('SKU-1803,100000,105000,5,5').replace('new_price','WRONG')), /ستون/);
 const csv=lines('SKU-1803,100000,105000,5,5','SKU-SECOND-18,100000,105000,5,5');
 const r=await post(s,'/panel/merchandising',{csrf:a.csrf,store_id:'1',mode:'commit',csv,note:'تست تراکنش یکپارچه',confirm:'1'},a.cookie);
 assert.equal(r.status,409);assert.equal(db.prepare("SELECT price FROM stock_items WHERE sku='SKU-1803'").get().price,100000);
 const noconsent=await post(s,'/panel/merchandising',{csrf:a.csrf,store_id:'1',mode:'commit',csv:lines('SKU-1803,100000,105000,5,5'),note:'دلیل کافی'},a.cookie);assert.equal(noconsent.status,400);
 const nocsrf=await post(s,'/panel/merchandising',{csrf:'bad',store_id:'1',mode:'commit',csv:lines('SKU-1803,100000,105000,5,5'),note:'دلیل کافی',confirm:'1'},a.cookie);assert.equal(nocsrf.status,403);
});

test('v1.8: seller permissions and per-store isolation for bulk edits and curated shelf',async t=>{
 const s=await setup(t),a=await owner(s),db=s.db;
 const id=item(db,1,1,'SKU-FEATURE-18');db.prepare("INSERT INTO stores(name,slug,city,active) VALUES('دوم','second-feature18','یزد',1)").run();
 const id2=item(db,2,2,'SKU-OTHER-18');
 let r=await post(s,'/panel/featured-item',{csrf:a.csrf,store_id:'1',item_id:String(id),headline:'گزیده امروز',priority:'2',enabled:'1'},a.cookie);assert.equal(r.status,303);
 let h=await (await get(s,'/store/1')).text();assert.match(h,/گزیده امروز/);assert.match(h,/پیشنهادهای این کتاب‌فروشی/);
 r=await post(s,'/panel/featured-item',{csrf:a.csrf,store_id:'1',item_id:String(id2),headline:'سرقت ویترین',priority:'1',enabled:'1'},a.cookie);assert.equal(r.status,400);
 r=await post(s,'/panel/user',{csrf:a.csrf,username:'reader18',password:'StrongSellerPassword18',store_id:'1'},a.cookie);assert.equal(r.status,303);
 db.prepare("UPDATE users SET staff_permission='viewer' WHERE username='reader18'").run();
 r=await post(s,'/login',{username:'reader18',password:'StrongSellerPassword18'});const c=cookie(r);assert.equal((await get(s,'/panel/merchandising',c)).status,403);
 const vcsrf=csrf(await (await get(s,'/panel',c)).text());
 r=await post(s,'/panel/featured-item',{csrf:vcsrf,store_id:'1',item_id:String(id),headline:'دستکاری',priority:'1',enabled:'1'},c);assert.equal(r.status,403);
 r=await post(s,'/panel/merchandising',{csrf:vcsrf,store_id:'1',mode:'commit',csv:lines('SKU-FEATURE-18,100000,110000,5,5'),note:'تلاش نامعتبر',confirm:'1'},c);assert.equal(r.status,403);
 assert.equal(db.prepare('SELECT price FROM stock_items WHERE id=?').get(id).price,100000);
 assert.equal(db.prepare('SELECT headline FROM store_featured_items WHERE item_id=?').get(id).headline,'گزیده امروز');
});

test('v1.8: featured shelf displays only available verified SKUs; DEMO popular stats are not real sales',async t=>{
 const s=await setup(t),a=await owner(s),db=s.db;
 const id=item(db,1,1,'SKU-HIDE-18');merchandising.featuredSet(db,{storeId:1,itemId:id,actorId:1,priority:1,headline:'انتخاب ویژه',enabled:true});
 let html=await (await get(s,'/store/1')).text();assert.match(html,/انتخاب ویژه/);
 db.prepare('UPDATE stock_items SET quantity=0 WHERE id=?').run(id);
 html=await (await get(s,'/store/1')).text();assert.doesNotMatch(html,/انتخاب ویژه/);
 const page=await (await get(s,'/panel/merchandising?store=1',a.cookie)).text();assert.match(page,/پرفروش واقعی نیست/);
 assert.deepEqual(merchandising.demoPopular(db,1),[]);
 // Schema migrations are idempotent, and do not change existing items.
 merchandising.migrate(db);merchandising.migrate(db);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM store_featured_items').get().n,1);
});
