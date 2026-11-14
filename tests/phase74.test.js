'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const {spawn}=require('node:child_process');
const {DatabaseSync}=require('node:sqlite');
const discovery=require('../lib/discovery');
const facets=require('../lib/discovery-facets');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function launch(t){
 const root=path.resolve(__dirname,'..'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'varaq74-'));
 const sock=net.createServer();
 const port=await new Promise((resolve,reject)=>{sock.once('error',reject);sock.listen(0,'127.0.0.1',()=>{const p=sock.address().port;sock.close(()=>resolve(p));});});
 const base='http://127.0.0.1:'+port;
 const child=spawn(process.execPath,['server.js'],{cwd:root,env:{...process.env,DATA_DIR:dir,HOST:'127.0.0.1',PORT:String(port),PUBLIC_URL:base},stdio:['ignore','ignore','pipe']});
 let errors='';child.stderr.on('data',chunk=>errors+=String(chunk));
 t.after(async()=>{if(child.exitCode===null){child.kill('SIGINT');await Promise.race([new Promise(done=>child.once('exit',done)),pause(1800)]);}fs.rmSync(dir,{force:true,recursive:true});});
 for(let i=0;i<110;i++){try{const res=await fetch(base+'/health');if(res.ok)return {base,dir};}catch{}await pause(90);}
 throw new Error('Server unavailable: '+errors);
}
test('7.4 facets list actual nonempty authors and categories only',()=>{
 assert.deepEqual(facets.groups([{author:'ب'},{author:''},{author:'الف'},{author:'ب'}],'author',5),[
  {value:'ب',count:2},{value:'الف',count:1}]);
 assert.deepEqual(facets.groups([{category:''}],'category',8),[]);
});
test('7.4 author selection uses parameter binding, combines with category and can sort',async t=>{
 const {dir}=await launch(t);const db=new DatabaseSync(path.join(dir,'varaq.sqlite'));
 t.after(()=>db.close());
 const author='فئودور داستایفسکی';
 const all=discovery.search(db,{author,perPage:100}),byGenre=discovery.search(db,{author,category:'رمان و ادبیات جهان',perPage:100});
 assert.ok(all.total>1);assert.ok(byGenre.total>0);
 assert.ok(all.rows.every(b=>b.author===author));
 assert.ok(byGenre.rows.every(b=>b.category==='رمان و ادبیات جهان'));
 assert.equal(discovery.search(db,{author:"' OR 1=1 --",perPage:100}).total,0);
 const ordered=discovery.search(db,{sort:'author',perPage:100}).rows;
 const expected=db.prepare("SELECT author,title FROM books ORDER BY CASE WHEN TRIM(author)='' THEN 1 ELSE 0 END,author COLLATE NOCASE ASC,title ASC,id ASC LIMIT 100").all();
 assert.deepEqual(ordered.map(b=>[b.author,b.title]),expected.map(b=>[b.author,b.title]));
});
test('7.4 /books has source-based refinements preserving search constraints and no JS dependency',async t=>{
 const {base}=await launch(t);
 const category='رمان و ادبیات جهان';
 let html=await(await fetch(base+'/books?category='+encodeURIComponent(category))).text();
 assert.match(html,/v74-discovery-refine/);
 assert.match(html,/name="author"/);
 assert.match(html,/نویسندگان/);
 assert.match(html,/author=/);
 assert.match(html,/category=/);
 const chosen='فئودور داستایفسکی';
 html=await(await fetch(base+'/books?author='+encodeURIComponent(chosen))).text();
 assert.match(html,/نویسنده: فئودور داستایفسکی/);
 assert.match(html,/مقایسه سریع کتاب‌ها/);
 assert.doesNotMatch(html,/<a class="book-name"[^>]*>ملت عشق<\/a>/);
 const blank=await(await fetch(base+'/books?author='+encodeURIComponent('نویسنده ناموجود'))).text();
 assert.match(blank,/نتیجه‌ای پیدا نشد/);
 assert.equal((await(await fetch(base+'/health')).json()).payment_enabled,false);
});
test('7.4 mobile refinements are touch-scrollable and user-controlled, no unsupported downloads',async t=>{
 const root=path.resolve(__dirname,'..');const css=fs.readFileSync(path.join(root,'public/style.css'),'utf8');
 assert.match(css,/\.v74-refine-chips/);assert.match(css,/overflow-x:auto/);
 const {base}=await launch(t);
 const attack='<img src=x onerror=alert(1)>';
 const page=await(await fetch(base+'/books?author='+encodeURIComponent(attack))).text();
 assert.doesNotMatch(page,/<img src=x onerror=alert\(1\)>/);
 assert.match(page,/&lt;img/);
 assert.equal((await fetch(base+'/pdf-delivery/'+'X'.repeat(43))).status,404);
});
