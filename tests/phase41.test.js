'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net'),crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const {DatabaseSync}=require('node:sqlite');
const review=require('../lib/publication-review');
const root=path.join(__dirname,'..');
function fixture(){
 const db=new DatabaseSync(':memory:');
 db.exec(`CREATE TABLE books(id INTEGER PRIMARY KEY,slug TEXT,title TEXT,author TEXT,description TEXT,category TEXT);
 CREATE TABLE editions(id INTEGER PRIMARY KEY,book_id INTEGER,verified INTEGER);
 CREATE TABLE edition_sources(id INTEGER PRIMARY KEY,edition_id INTEGER,source_url TEXT,cover_matched INTEGER,rights_confirmed INTEGER,cover_url TEXT);
 CREATE TABLE edition_cover_assets(id INTEGER PRIMARY KEY,edition_id INTEGER);
 CREATE TABLE book_covers(id INTEGER PRIMARY KEY,book_id INTEGER);
 CREATE TABLE catalog_metadata_drafts(id INTEGER PRIMARY KEY,book_id INTEGER,status TEXT);
 CREATE TABLE edition_rights_requests(edition_id INTEGER PRIMARY KEY,status TEXT);`);
 db.prepare('INSERT INTO books VALUES(1,?,?,?,?,?)').run('first','کتاب سالم','نویسنده', 'معرفی دقیق '.repeat(20),'رمان');
 db.prepare('INSERT INTO books VALUES(2,?,?,?,?,?)').run('second','=IMPORT("https://evil")','', '', 'رمان');
 db.exec(`INSERT INTO editions VALUES(9,1,1);INSERT INTO editions VALUES(10,2,1);
 INSERT INTO edition_sources VALUES(1,9,'https://publisher.example/edition',1,1,'https://publisher.example/cover.jpg');
 INSERT INTO catalog_metadata_drafts VALUES(1,2,'pending');`);
 return db;
}
test('4.1 content review distinguishes technical evidence from legal clearance',()=>{
 const db=fixture();try{
  let list=review.rows(db),s=review.summary(list);
  assert.equal(s.total,2);assert.equal(s.technicalCandidates,1);assert.equal(s.seoCandidates,1);
  assert.equal(s.missingIntro,1);assert.equal(s.pendingDrafts,1);
  assert.equal(review.filter(list,'technical-candidate').length,1);
  assert.equal(review.filter(list,'missing-author').length,1);
  assert.equal(review.filter(list,'pending-draft').length,1);
  assert.equal(review.forBook(db,1).hasSource,true);assert.equal(review.forBook(db,2).hasSource,false);
  assert.equal(review.forBook(db,99),null);
  // A denial is a review conflict, not proof that unrelated assets are illegal.
  db.exec("INSERT INTO edition_rights_requests VALUES(9,'denied')");
  list=review.rows(db);s=review.summary(list);
  assert.equal(s.rightsConflicts,1);assert.equal(s.technicalCandidates,0);
  assert.equal(review.filter(list,'rights-conflict')[0].id,1);
  db.close();
 }catch(e){try{db.close()}catch{}throw e;}
});
test('4.1 CSV is escaped, BOM-marked and does not expose legal evidence refs',()=>{
 const db=fixture();try{
  const output=review.csv(review.rows(db));
  assert.ok(output.startsWith('\uFEFF'));assert.match(output,/source_editions/);
  assert.match(output,/"'=IMPORT\(""https:\/\/evil""\)"/);
  assert.doesNotMatch(output,/evidence_ref|contact_name|password_hash|token_hash/);
 }finally{db.close();}
});
async function serve(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'varaq41-'));
 const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
 const base=`http://127.0.0.1:${port}`;
 const env={...process.env,PORT:String(port),HOST:'127.0.0.1',DATA_DIR:dir,VARAQ_CURATED_SEED:'1',PUBLIC_URL:base};
 const child=spawn(process.execPath,['server.js'],{cwd:root,env,stdio:['ignore','pipe','pipe']});
 let logs='';child.stdout.on('data',d=>logs+=d);child.stderr.on('data',d=>logs+=d);
 let ready=false;for(let i=0;i<150;i++){
  if(child.exitCode!==null)throw Error(logs);
  try{if((await fetch(base+'/health')).ok){ready=true;break;}}catch{}
  await new Promise(r=>setTimeout(r,45));
 }
 if(!ready)throw Error('not ready '+logs);
 t.after(async()=>{child.kill('SIGTERM');await new Promise(r=>child.exitCode!==null||child.signalCode?r():child.once('exit',r));fs.rmSync(dir,{recursive:true,force:true});});
 return {base,dir};
}
test('4.1 visitor sees truthful book evidence and no demo shopping in public mode',async t=>{
 const s=await serve(t);
 const health=await (await fetch(s.base+'/health')).json();assert.equal(health.version,'8.6.0');assert.equal(health.payment_enabled,false);
 let r=await fetch(s.base+'/book/book-001');assert.equal(r.status,200);
 const html=await r.text();assert.match(html,/وضعیت اطلاعات این کتاب/);assert.match(html,/ثبت اطلاعات، تأیید مستقل صحت/);
 assert.doesNotMatch(html,/class="cta add-cart"/);
 r=await fetch(s.base+'/panel/publication-review.csv',{redirect:'manual'});assert.equal(r.status,303);assert.equal(r.headers.get('location'),'/login');
});
test('4.1 publication audit and CSV accessible to owner, forbidden to sellers',async t=>{
 const s=await serve(t);
 const db=new DatabaseSync(path.join(s.dir,'varaq.sqlite'));
 db.prepare("INSERT INTO stores(name,slug,city,active) VALUES('فروشگاه آزمایشی','test-store','یزد',1)").run();
 db.prepare("INSERT INTO users(username,password_hash,role,must_change_password) VALUES('review-owner','test-hash','owner',0)").run();
 const admin=db.prepare("SELECT * FROM users WHERE role='owner' LIMIT 1").get();assert.ok(admin);
 const token='a'.repeat(64),hash=crypto.createHash('sha256').update(token).digest('hex');
 db.prepare('INSERT INTO sessions(token_hash,user_id,csrf,expires_at) VALUES(?,?,?,?)').run(hash,admin.id,'h'.repeat(48),Date.now()+3600000);
 const store=db.prepare('SELECT id FROM stores ORDER BY id LIMIT 1').get();assert.ok(store);
 db.prepare('INSERT INTO users(username,password_hash,role,store_id,must_change_password) VALUES(?,?,?,?,0)').run('review-seller',admin.password_hash,'seller',store.id);
 const seller=db.prepare("SELECT id FROM users WHERE username='review-seller'").get();
 const sellerToken='b'.repeat(64),sellerHash=crypto.createHash('sha256').update(sellerToken).digest('hex');
 db.prepare('INSERT INTO sessions(token_hash,user_id,csrf,expires_at) VALUES(?,?,?,?)').run(sellerHash,seller.id,'s'.repeat(48),Date.now()+3600000);
 db.close();
 let r=await fetch(s.base+'/panel/publication-review?status=missing-intro',{headers:{cookie:'varaq_sid='+token}});assert.equal(r.status,200);
 const page=await r.text();assert.match(page,/ارزیابی یکپارچه محتوای ۱۰۰۰ کتاب/);assert.match(page,/CSV کامل وظایف و ریسک‌ها/);
 r=await fetch(s.base+'/panel/publication-review.csv',{headers:{cookie:'varaq_sid='+token}});assert.equal(r.status,200);assert.match(r.headers.get('content-type'),/text\/csv/);
 assert.equal((await r.text()).includes('book_id'),true);
 r=await fetch(s.base+'/panel/publication-review.csv',{headers:{cookie:'varaq_sid='+sellerToken}});assert.equal(r.status,403);
 r=await fetch(s.base+'/panel/publication-review',{headers:{cookie:'varaq_sid='+sellerToken}});assert.equal(r.status,403);
});
