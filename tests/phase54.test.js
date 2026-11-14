'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const {spawn}=require('node:child_process'),{DatabaseSync}=require('node:sqlite');
const coverWeb=require('../lib/cover-web-intake');
const sleep=ms=>new Promise(ok=>setTimeout(ok,ms));
async function boot(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'varaq54-'));
 const probe=net.createServer();await new Promise(ok=>probe.listen(0,'127.0.0.1',ok));const port=probe.address().port;await new Promise(ok=>probe.close(ok));
 const base='http://127.0.0.1:'+port;
 const proc=spawn(process.execPath,['server.js'],{cwd:path.join(__dirname,'..'),env:{...process.env,DATA_DIR:dir,PORT:String(port),HOST:'127.0.0.1',PUBLIC_URL:'',VARAQ_CURATED_SEED:'1'},stdio:['ignore','pipe','pipe']});
 let errors='';proc.stderr.on('data',b=>errors+=b.toString());
 t.after(async()=>{if(proc.exitCode===null){proc.kill('SIGTERM');await Promise.race([new Promise(ok=>proc.once('exit',ok)),sleep(1500)]);}fs.rmSync(dir,{recursive:true,force:true});});
 for(let i=0;i<150;i++){try{if((await fetch(base+'/health')).ok)return {base,dir};}catch{}await sleep(50);}throw Error('server could not start: '+errors);
}
async function owner(base){
 const login=password=>fetch(base+'/login',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({username:'admin',password}),redirect:'manual'});
 let response=await login('ad123456789'),cookie=response.headers.get('set-cookie').split(';')[0];
 response=await fetch(base+'/panel/account',{headers:{cookie}});let csrf=(await response.text()).match(/name="csrf" value="([^"]+)"/)[1];
 response=await fetch(base+'/panel/account',{method:'POST',headers:{cookie,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf,username:'admin',old_password:'ad123456789',new_password:'VarAQ-Secure-Pass-54-ready!',confirm_password:'VarAQ-Secure-Pass-54-ready!'}),redirect:'manual'});assert.equal(response.status,303);
 response=await login('VarAQ-Secure-Pass-54-ready!');cookie=response.headers.get('set-cookie').split(';')[0];
 response=await fetch(base+'/panel/cover-web-upload',{headers:{cookie}});csrf=(await response.text()).match(/name="csrf" value="([^"]+)"/)[1];return {cookie,csrf};
}
function form(csrf,images,{mode='apply',confirm='1'}={}){
 const f=new FormData();f.append('csrf',csrf);f.append('mode',mode);f.append('confirm',confirm);
 for(let i=0;i<images.length;i++){
  const n=i+1,r=images[i];
  f.append('isbn_'+n,r.isbn);
  f.append('source_'+n,'صاحب قانونی تصویر نمونه');
  f.append('rights_note_'+n,'مجوز مکتوب استفاده تجاری از عکس جلد برای ورق');
  f.append('match_evidence_'+n,'مطابقت عکس چاپ فیزیکی با شابک مستند');
  f.append('permission_evidence_'+n,'تأییدیه کتبی حقوق انتشار تصویر به شماره سند ۱۴۰۵');
  f.append('cover_'+n,new Blob([r.bytes],{type:'image/png'}),'untrusted.png');
 }
 return f;
}
test('5.4 browser cover import validates complete batch, previews, commits atomically and rejects replay',async t=>{
 const s=await boot(t),db=new DatabaseSync(path.join(s.dir,'varaq.sqlite'));t.after(()=>db.close());
 const {cookie,csrf}=await owner(s.base),bytes=fs.readFileSync(path.join(__dirname,'fixtures','test_cover.png'));
 const ids=[];for(const [book,isbn] of [[1,'9780131103627'],[2,'9780201633610']]){
  const r=db.prepare("INSERT INTO editions(book_id,label,publisher,isbn,verified) VALUES(?,'آزمون پنل','ناشر مجاز',?,1)").run(book,isbn);ids.push(Number(r.lastInsertRowid));
 }
 const post=f=>fetch(s.base+'/panel/cover-web-upload',{method:'POST',headers:{cookie},body:f,redirect:'manual'});
 let r=await post(form(csrf,[{isbn:'9780131103627',bytes},{isbn:'9780201633610',bytes}],{mode:'preview'}));assert.equal(r.status,303);
 assert.match(r.headers.get('location'),/notice=/);
 assert.equal(db.prepare('SELECT count(*) n FROM edition_cover_assets WHERE edition_id IN (?,?)').get(...ids).n,0);
 r=await post(form(csrf,[{isbn:'9780131103627',bytes},{isbn:'9780201633610',bytes:Buffer.from('not an image')} ]));assert.equal(r.status,400);
 assert.equal(db.prepare('SELECT count(*) n FROM edition_cover_assets WHERE edition_id IN (?,?)').get(...ids).n,0);
 db.exec(`CREATE TRIGGER fail_second_cover BEFORE INSERT ON edition_cover_import_evidence WHEN NEW.edition_id=${ids[1]} BEGIN SELECT RAISE(ABORT,'forced-second-image-failure'); END;`);
 r=await post(form(csrf,[{isbn:'9780131103627',bytes},{isbn:'9780201633610',bytes}]));assert.equal(r.status,400);
 assert.equal(db.prepare('SELECT count(*) n FROM edition_cover_assets WHERE edition_id IN (?,?)').get(...ids).n,0);
 assert.deepEqual(fs.readdirSync(path.join(s.dir,'covers')),[]);
 db.exec('DROP TRIGGER fail_second_cover');
 r=await post(form(csrf,[{isbn:'9780131103627',bytes},{isbn:'9780201633610',bytes}]));assert.equal(r.status,303);
 assert.equal(db.prepare('SELECT count(*) n FROM edition_cover_assets WHERE edition_id IN (?,?)').get(...ids).n,2);
 assert.equal(db.prepare('SELECT count(*) n FROM edition_cover_import_evidence WHERE edition_id IN (?,?)').get(...ids).n,2);
 assert.equal(fs.readdirSync(path.join(s.dir,'covers')).length,2);
 r=await post(form(csrf,[{isbn:'9780131103627',bytes}]));assert.equal(r.status,400);
 assert.equal(fs.readdirSync(path.join(s.dir,'covers')).length,2);
 const health=await(await fetch(s.base+'/health')).json();assert.equal(health.version,'8.6.0');assert.equal(health.payment_enabled,false);
});
test('5.4 owner-only form and CSRF; seller and anonymous blocked and no rights-free publication',async t=>{
 const s=await boot(t),db=new DatabaseSync(path.join(s.dir,'varaq.sqlite'));t.after(()=>db.close());
 let r=await fetch(s.base+'/panel/cover-web-upload',{redirect:'manual'});assert.equal(r.status,303);
 const {cookie,csrf}=await owner(s.base);
 r=await fetch(s.base+'/panel/cover-web-upload',{headers:{cookie}});assert.equal(r.status,200);assert.match(await r.text(),/بارگذاری چند جلد از مرورگر/);
 r=await fetch(s.base+'/panel/cover-intake',{headers:{cookie}});assert.equal(r.status,200);assert.match(await r.text(),/بارگذاری مستقیم ۱ تا ۳ جلد/);
 const store=db.prepare('SELECT id FROM stores ORDER BY id LIMIT 1').get(),hash=db.prepare("SELECT password_hash FROM users WHERE role='owner'").get().password_hash;
 db.prepare("INSERT INTO users(username,password_hash,role,store_id,enabled,must_change_password,staff_permission) VALUES(?,?,'seller',?,1,0,'manager')").run('seller54',hash,store.id);
 r=await fetch(s.base+'/login',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({username:'seller54',password:'VarAQ-Secure-Pass-54-ready!'}),redirect:'manual'});const seller=r.headers.get('set-cookie').split(';')[0];
 r=await fetch(s.base+'/panel/cover-web-upload',{headers:{cookie:seller}});assert.equal(r.status,403);
 const fixture=fs.readFileSync(path.join(__dirname,'fixtures','test_cover.png'));
 const f=form(csrf,[{isbn:'9780131103627',bytes:fixture}]);
 r=await fetch(s.base+'/panel/cover-web-upload',{method:'POST',headers:{cookie:seller},body:f,redirect:'manual'});assert.equal(r.status,403);
 r=await fetch(s.base+'/panel/cover-web-upload',{method:'POST',headers:{cookie},body:form('fake-csrf',[{isbn:'9780131103627',bytes:fixture}]),redirect:'manual'});assert.equal(r.status,403);
 r=await fetch(s.base+'/panel/cover-web-upload',{method:'POST',headers:{cookie},body:form(csrf,[{isbn:'9780131103627',bytes:fixture}],{confirm:'0'}),redirect:'manual'});assert.equal(r.status,400);
 assert.equal(db.prepare('SELECT count(*) n FROM edition_cover_assets').get().n,0);
});
test('5.4 direct importer rejects duplicate ISBN and evidence commas before writing',async t=>{
 const s=await boot(t),db=new DatabaseSync(path.join(s.dir,'varaq.sqlite'));t.after(()=>db.close());
 const bytes=fs.readFileSync(path.join(__dirname,'fixtures','test_cover.png')),fields={};
 for(let n=1;n<=2;n++)Object.assign(fields,{['isbn_'+n]:'9780131103627',['source_'+n]:'صاحب حقوق جلد',['rights_note_'+n]:'سند رسمی استفاده تجاری',['match_evidence_'+n]:'مطابقت معتبر چاپ',['permission_evidence_'+n]:'سند رسمی اجازه انتشار'});
 const files={cover_1:{data:bytes},cover_2:{data:bytes}};
 assert.throws(()=>coverWeb.run(db,fields,files,path.join(s.dir,'covers'),true),/Duplicate ISBN/);
 fields.isbn_2='9780201633610';fields.source_2='ناشر, دارای ویرگول';
 assert.throws(()=>coverWeb.run(db,fields,files,path.join(s.dir,'covers'),true),/مدارک باید متن ساده/);
 assert.deepEqual(fs.readdirSync(path.join(s.dir,'covers')),[]);
});
