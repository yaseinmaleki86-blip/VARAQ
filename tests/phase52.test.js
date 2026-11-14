'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const {spawn}=require('node:child_process'),{DatabaseSync}=require('node:sqlite');
const coverIntake=require('../lib/cover-intake'),coverBatch=require('../lib/cover-batch'),media=require('../lib/media-integrity');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function boot(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'varaq52-'));
 const probe=net.createServer();await new Promise(ok=>probe.listen(0,'127.0.0.1',ok));const port=probe.address().port;await new Promise(ok=>probe.close(ok));
 const base='http://127.0.0.1:'+port;
 const proc=spawn(process.execPath,['server.js'],{cwd:path.join(__dirname,'..'),env:{...process.env,DATA_DIR:dir,PORT:String(port),HOST:'127.0.0.1',PUBLIC_URL:'',VARAQ_CURATED_SEED:'1'},stdio:['ignore','pipe','pipe']});
 let errors='';proc.stderr.on('data',b=>errors+=b.toString());
 t.after(async()=>{if(proc.exitCode===null){proc.kill('SIGTERM');await Promise.race([new Promise(ok=>proc.once('exit',ok)),sleep(1600)]);}fs.rmSync(dir,{recursive:true,force:true});});
 for(let i=0;i<140;i++){try{if((await fetch(base+'/health')).ok)return {base,dir};}catch{}await sleep(50);}
 throw Error('server could not start '+errors);
}
async function owner(base){
 const login=password=>fetch(base+'/login',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({username:'admin',password}),redirect:'manual'});
 let response=await login('ad123456789'),cookie=response.headers.get('set-cookie').split(';')[0];
 response=await fetch(base+'/panel/account',{headers:{cookie}});const csrf=(await response.text()).match(/name="csrf" value="([^"]+)"/)[1];
 response=await fetch(base+'/panel/account',{method:'POST',headers:{cookie,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf,username:'admin',old_password:'ad123456789',new_password:'VarAQ-Secure-Pass-52-ready!',confirm_password:'VarAQ-Secure-Pass-52-ready!'}),redirect:'manual'});
 assert.equal(response.status,303);response=await login('VarAQ-Secure-Pass-52-ready!');return response.headers.get('set-cookie').split(';')[0];
}
test('5.2 cover intake uses real verified ISBNs, never fabricates evidence or permission',async t=>{
 const s=await boot(t),db=new DatabaseSync(path.join(s.dir,'varaq.sqlite'));t.after(()=>db.close());
 const list=coverIntake.pending(db);assert.ok(list.length>60);assert.ok(list.every(x=>x.isbn&&x.edition_id&&x.book_id));
 const order=list.findIndex(x=>x.stock_count>0),zero=list.findIndex(x=>!x.stock_count);if(order>=0&&zero>=0)assert.ok(order<zero);
 const manifest=coverIntake.importManifestTemplate(list.slice(0,2));assert.ok(manifest.startsWith('\uFEFFisbn,filename,source,rights_note,match_evidence,permission_evidence'));
 assert.ok(manifest.includes(list[0].isbn+',,,,,'));assert.doesNotMatch(manifest,/مجوز تأیید/);
 const report=coverIntake.worklistCsv(list);assert.match(report,/source_url/);assert.ok(report.includes(list[0].isbn));
 assert.equal(coverIntake.filter(list,list[0].isbn).length,1);
 const health=await(await fetch(s.base+'/health')).json();assert.equal(health.version,'8.6.0');assert.equal(health.payment_enabled,false);
});
test('5.2 cover batch rolls back the entire batch including new files if evidence insert fails',async t=>{
 const s=await boot(t),db=new DatabaseSync(path.join(s.dir,'varaq.sqlite'));t.after(()=>db.close());
 const ids=[];for(const [book,isbn] of [[1,'9780131103627'],[2,'9780201633610']]){
  const result=db.prepare("INSERT INTO editions(book_id,label,publisher,isbn,verified) VALUES(?,'تست','ناشر آزمایشی',?,1)").run(book,isbn);ids.push(Number(result.lastInsertRowid));
 }
 const folder=fs.mkdtempSync(path.join(os.tmpdir(),'varaq52-covers-'));t.after(()=>fs.rmSync(folder,{recursive:true,force:true}));
 const bytes=fs.readFileSync(path.join(__dirname,'fixtures','test_cover.png'));fs.writeFileSync(path.join(folder,'one.png'),bytes);fs.writeFileSync(path.join(folder,'two.png'),bytes);
 const line=(isbn,file)=>`${isbn},${file},عکاس مجاز,اجازه کتبی انتشار جلد در فروشگاه,بارکد روی جلد فیزیکی تطبیق شده,سند رسمی اجازه تجاری ناشر`;
 const rows=coverBatch.parseManifest('isbn,filename,source,rights_note,match_evidence,permission_evidence\n'+line('9780131103627','one.png')+'\n'+line('9780201633610','two.png'));
 const target=path.join(s.dir,'covers');assert.equal(coverBatch.processRows(db,rows,folder,target).ready,2);
 db.exec(`CREATE TRIGGER test_cover_evidence_rollback BEFORE INSERT ON edition_cover_import_evidence WHEN NEW.edition_id=${ids[1]} BEGIN SELECT RAISE(ABORT,'simulated failure'); END;`);
 assert.throws(()=>coverBatch.processRows(db,rows,folder,target,true),/simulated failure/);
 assert.equal(db.prepare('SELECT count(*) n FROM edition_cover_assets WHERE edition_id IN (?,?)').get(...ids).n,0);
 assert.equal(db.prepare('SELECT count(*) n FROM edition_cover_import_evidence WHERE edition_id IN (?,?)').get(...ids).n,0);
 assert.deepEqual(fs.readdirSync(target),[]);
 db.exec('DROP TRIGGER test_cover_evidence_rollback');
 const result=coverBatch.processRows(db,rows,folder,target,true);assert.equal(result.saved,2);
 assert.equal(db.prepare('SELECT count(*) n FROM edition_cover_assets WHERE edition_id IN (?,?)').get(...ids).n,2);
 assert.equal(fs.readdirSync(target).length,2);
 assert.ok(!coverIntake.pending(db).some(x=>ids.includes(x.edition_id)));
});
test('5.2 owner-only cover collection exports and orphan-PDF read-only report',async t=>{
 const s=await boot(t),db=new DatabaseSync(path.join(s.dir,'varaq.sqlite'));t.after(()=>db.close());
 let res=await fetch(s.base+'/panel/cover-intake',{redirect:'manual'});assert.equal(res.status,303);
 const cookie=await owner(s.base);
 res=await fetch(s.base+'/panel/cover-intake',{headers:{cookie}});assert.equal(res.status,200);assert.match(await res.text(),/آماده‌سازی تصاویر واقعی جلد/);
 res=await fetch(s.base+'/panel/cover-intake-worklist.csv',{headers:{cookie}});assert.equal(res.status,200);assert.match(res.headers.get('content-type'),/text\/csv/);assert.match(res.headers.get('cache-control'),/no-store/);
 res=await fetch(s.base+'/panel/cover-intake-manifest.csv',{headers:{cookie}});assert.equal(res.status,200);assert.match(await res.text(),/isbn,filename,source,rights_note/);
 // Another seller cannot access owner-only reports.
 const hash=db.prepare("SELECT password_hash FROM users WHERE role='owner'").get().password_hash,store=db.prepare('SELECT id FROM stores LIMIT 1').get();
 db.prepare("INSERT INTO users(username,password_hash,role,store_id,enabled,must_change_password,staff_permission) VALUES(?,?,'seller',?,1,0,'manager')").run('seller52',hash,store.id);
 res=await fetch(s.base+'/login',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({username:'seller52',password:'VarAQ-Secure-Pass-52-ready!'}),redirect:'manual'});const seller=res.headers.get('set-cookie').split(';')[0];
 res=await fetch(s.base+'/panel/cover-intake',{headers:{cookie:seller}});assert.equal(res.status,403);
 const pdf='f'.repeat(32)+'.pdf';const d=path.join(s.dir,'digital-pdfs');fs.writeFileSync(path.join(d,pdf),Buffer.from('%PDF-1.4\n%%EOF\n'));
 let rows=media.safeRows(db,s.dir);assert.ok(rows.some(x=>x.type==='orphan_pdf'&&x.filename===pdf&&x.state==='orphan_file'));
 res=await fetch(s.base+'/panel/media-integrity.csv?status=pdf',{headers:{cookie}});assert.equal(res.status,200);assert.match(await res.text(),/orphan_pdf/);assert.ok(fs.existsSync(path.join(d,pdf)));
});
