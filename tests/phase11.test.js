'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const {spawn}=require('node:child_process'),{DatabaseSync}=require('node:sqlite');
const education=require('../lib/education');
const batch=require('../lib/education-batch');
const compare=require('../lib/education-compare');
const root=path.resolve(__dirname,'..');
function port(){return new Promise(resolve=>{const s=net.createServer().listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});}
async function setup(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'varaq-phase11-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const p=await port(),base=`http://127.0.0.1:${p}`;
 const proc=spawn(process.execPath,['server.js'],{cwd:root,env:{...process.env,PORT:String(p),HOST:'127.0.0.1',DATA_DIR:dir,PUBLIC_URL:''},stdio:['ignore','pipe','pipe']});
 let logs='';proc.stdout.on('data',x=>logs+=x);proc.stderr.on('data',x=>logs+=x);t.after(()=>proc.kill('SIGINT'));
 let started=false;for(let i=0;i<80;i++){if(proc.exitCode!==null)throw Error('server stopped: '+logs);try{if((await fetch(base+'/health')).ok){started=true;break;}}catch{}await new Promise(r=>setTimeout(r,75));}
 if(!started)throw Error('server timeout '+logs);
 const db=new DatabaseSync(path.join(dir,'varaq.sqlite'));t.after(()=>db.close());return {db,base};
}
const get=(s,u,cookie='')=>fetch(s.base+u,{headers:{cookie},redirect:'manual'});
const post=(s,u,data,cookie='')=>fetch(s.base+u,{method:'POST',headers:{cookie,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams(data),redirect:'manual'});
const cookie=r=>r.headers.get('set-cookie')?.split(';')[0];
const csrf=html=>html.match(/name="csrf" value="([^"]+)"/)?.[1];
async function owner(s){const first=cookie(await post(s,'/login',{username:'admin',password:'ad123456789'}));const token=csrf(await(await get(s,'/panel/account',first)).text());let r=await post(s,'/panel/account',{csrf:token,username:'admin',old_password:'ad123456789',new_password:'StrongPhase11Pass!',confirm_password:'StrongPhase11Pass!'},first);assert.equal(r.status,303);return cookie(await post(s,'/login',{username:'admin',password:'StrongPhase11Pass!'}));}
function newBook(db,slug,title){return Number(db.prepare('INSERT INTO books(slug,title,author,category,publisher) VALUES(?,?,?,?,?)').run(slug,title,'نویسنده تست','کمک‌درسی و کنکور','ناشر تست').lastInsertRowid);}
function row(id,options={}){return [id,12,'experimental','زیست‌شناسی','test','tests',1406].map((v,i)=>options[i]??v).join(',');}
const csv=(...rows)=>batch.template+rows.join('\r\n')+'\r\n';
test('v1.1: CSV validates book ids, existing draft and duplicates without changing books',async t=>{
 const s=await setup(t),db=s.db;const id=newBook(db,'test-edu-csv-1','کتاب آزمایشی کمک‌درسی');
 const data=csv(row(id),row(id),row(999999),row(id+1,{1:7}),row(id+2));
 const preview=batch.preview(db,data);assert.equal(preview.valid.length,1);assert.equal(preview.issues.length,4);
 assert.equal(db.prepare('SELECT count(*) n FROM education_profiles').get().n,0);
 const committed=batch.commit(db,data);assert.equal(committed.inserted,1);
 const saved=db.prepare('SELECT grade,published FROM education_profiles WHERE book_id=?').get(id);assert.equal(saved.grade,12);assert.equal(saved.published,0);
 assert.equal(db.prepare('SELECT count(*) n FROM books WHERE id=?').get(id).n,1);
 assert.equal(batch.preview(db,csv(row(id))).valid.length,0,'existing records must never be overwritten');
 assert.equal((await(await get(s,'/educational')).text()).includes('کتاب آزمایشی کمک‌درسی'),false,'draft must be invisible');
});
test('v1.1: import commit is transactional and rolls back if one insert fails',async t=>{
 const s=await setup(t),db=s.db,id1=newBook(db,'test-edu-rollback-1','ورودی اول'),id2=newBook(db,'test-edu-rollback-2','ورودی دوم');
 db.exec(`CREATE TRIGGER fail_phase11 BEFORE INSERT ON education_profiles WHEN NEW.book_id=${id2} BEGIN SELECT RAISE(ABORT,'blocked'); END`);
 assert.throws(()=>batch.commit(db,csv(row(id1),row(id2))),/blocked/);
 assert.equal(db.prepare('SELECT count(*) n FROM education_profiles').get().n,0);
});
test('v1.1: comparison uses published data, escapes content, rejects unknown and 4+ selections',async t=>{
 const s=await setup(t),db=s.db;
 const a=newBook(db,'test-compare-1','زیست نمونه اول <unsafe>');const b=newBook(db,'test-compare-2','زیست نمونه دوم');const c=newBook(db,'test-compare-3','کتاب مخفی');
 for(const [id,pub] of [[a,1],[b,1],[c,0]])education.upsert(db,{book_id:id,grade:12,track:'experimental',subject:'زیست‌شناسی',goal:'test',material_type:'tests',exam_year:'1406',published:String(pub)});
 let r=await get(s,`/educational/compare?ids=${a}&ids=${b}`);assert.equal(r.status,200);let html=await r.text();assert.match(html,/مقایسه منابع آموزشی/);assert.match(html,/زیست نمونه اول &lt;unsafe&gt;/);assert.doesNotMatch(html,/<unsafe>/);
 for(const args of [`?ids=${a}&ids=${c}`,`?ids=${a}&ids=${a}`,`?ids=${a}`,`?ids=${a}&ids=${b}&ids=${c}&ids=4`,`?ids=a&ids=${b}`]){r=await get(s,'/educational/compare'+args);assert.equal(r.status,400);}
 r=await get(s,'/educational');assert.equal(r.status,200);html=await r.text();assert.match(html,/انتخاب برای مقایسه/);assert.doesNotMatch(html,/کتاب مخفی/);
 assert.equal((await(await get(s,'/health')).json()).payment_enabled,false);
});
test('v1.1: CSV admin route protects drafts, checks CSRF and requires confirmation',async t=>{
 const s=await setup(t),db=s.db,id=newBook(db,'test-edu-http','نمونه پنل CSV');const logged=await owner(s),payload=csv(row(id));
 let r=await get(s,'/panel/education-import',logged);assert.equal(r.status,200);const token=csrf(await r.text());assert.ok(token);
 r=await get(s,'/panel/education-import-template');assert.equal(r.status,403);
 r=await get(s,'/panel/education-import-template',logged);assert.equal(r.status,200);assert.match(await r.text(),/book_id,grade,track/);
 r=await post(s,'/panel/education-import',{csrf:token,csv:payload,mode:'preview'},logged);assert.equal(r.status,200);assert.match(await r.text(),/پیش‌نمایش فایل/);
 assert.equal(db.prepare('SELECT count(*) n FROM education_profiles').get().n,0);
 r=await post(s,'/panel/education-import',{csrf:'invalid',csv:payload,mode:'commit',confirm:'1'},logged);assert.equal(r.status,403);
 r=await post(s,'/panel/education-import',{csrf:token,csv:payload,mode:'commit'},logged);assert.equal(r.status,400);
 r=await post(s,'/panel/education-import',{csrf:token,csv:payload,mode:'commit',confirm:'1'},logged);assert.equal(r.status,200);assert.equal(db.prepare('SELECT published FROM education_profiles WHERE book_id=?').get(id).published,0);
 // Seller account with an already-changed password cannot administer education data.
 db.prepare("INSERT INTO users(username,password_hash,role,store_id,enabled,must_change_password) VALUES(?,?,'seller',1,1,0)").run('phase11seller','0123456789abcdef:'+require('node:crypto').scryptSync('SellerPass!1234','0123456789abcdef',64).toString('hex'));
 const seller=cookie(await post(s,'/login',{username:'phase11seller',password:'SellerPass!1234'}));assert.ok(seller);
 r=await get(s,'/panel/education-import',seller);assert.equal(r.status,403);
 r=await post(s,'/panel/education-import',{csrf:token,csv:payload,mode:'commit',confirm:'1'},seller);assert.equal(r.status,403);
});
test('v1.1: invalid UTF-8 CSV format, embedded commas, and large batches rejected',()=>{
 assert.equal(batch.parseCSV(csv('1,12,experimental,"زیست, شناسی",test,tests,1406'))[0].subject,'زیست, شناسی');
 assert.throws(()=>batch.parseCSV('title,name\n1,2'),/ترتیب ستون‌ها/);
 assert.throws(()=>batch.parseCSV(csv(...Array.from({length:251},(_,i)=>row(i+1)))),/۲۵۰/);
 assert.throws(()=>batch.parseCSV('book_id,grade,track,subject,goal,material_type,exam_year\n"1,12,experimental,زیست‌شناسی,test,tests,1406'),/بسته نشده/);
 assert.throws(()=>compare.idsFromParams(new URL('http://example.com/educational/compare?ids=1&ids=1')),/غیرتکراری/);
});
