"use strict";
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const {spawn}=require('node:child_process'),{DatabaseSync}=require('node:sqlite');
const edition=require('../lib/edition-detail');
async function serve(t,dir){dir=dir||fs.mkdtempSync(path.join(os.tmpdir(),'varaq24-'));const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const port=s.address().port;await new Promise(r=>s.close(r));
 const p=spawn(process.execPath,['server.js'],{cwd:path.resolve(__dirname,'..'),env:{...process.env,DATA_DIR:dir,VARAQ_CURATED_SEED:'1',HOST:'127.0.0.1',PORT:String(port),PUBLIC_URL:''},stdio:['ignore','pipe','pipe']});
 let log='';await new Promise((ok,bad)=>{const tm=setTimeout(()=>bad(Error('startup timeout '+log)),15000);p.stdout.on('data',b=>{log+=b;if(log.includes('PAYMENT: DISABLED')){clearTimeout(tm);ok();}});p.stderr.on('data',b=>{log+=b});p.on('exit',c=>bad(Error('exit '+c+' '+log)));});
 t.after(()=>{p.kill();if(!dir)fs.rmSync(dir,{recursive:true,force:true});});return {url:`http://127.0.0.1:${port}`,dir};}
test('v2.4 seeds twelve distinct sourced editions and never switches on payments',async t=>{const s=await serve(t),db=new DatabaseSync(path.join(s.dir,'varaq.sqlite'));const stats=edition.stats(db);
 assert.deepEqual({...stats},{total_books:1000,sourced_editions:128,sourced_books:71,uploaded_covers:0,licensed_external_covers:0});
 assert.equal(db.prepare('SELECT COUNT(*) n FROM editions WHERE book_id=6 AND isbn IN (?,?)').get('9786006027708','9786002530455').n,2);
 const h=await (await fetch(s.url+'/health')).json();assert.equal(h.version,'8.6.0');assert.equal(h.payment_enabled,false);db.close();});
test('v2.4 pages include individual ISBNs and source links, no fake book covers',async t=>{const s=await serve(t),db=new DatabaseSync(path.join(s.dir,'varaq.sqlite'));const slug=db.prepare('SELECT slug FROM books WHERE id=6').get().slug;db.close();let r=await fetch(s.url+'/book/'+encodeURIComponent(slug));assert.equal(r.status,200);let html=await r.text();assert.match(html,/9789642132201/);assert.match(html,/9786002530455/);assert.match(html,/book-1320912-lgivvm/);assert.match(html,/جلد واقعی این چاپ هنوز تأیید نشده است/);assert.doesNotMatch(html,/publisher\.example/);});
test('v2.4 no unsafe source or unlicensed remote cover appears in public display',async()=>{assert.equal(edition.trustworthySource('javascript:alert(1)'),'');assert.equal(edition.trustworthySource('http://evil.example/a'),'');assert.equal(edition.publicCoverUrl({cover_url:'https://example.org/cover.jpg',rights_confirmed:0,cover_matched:1}),'');assert.equal(edition.publicCoverUrl({filename:'../../private'}),'');});
