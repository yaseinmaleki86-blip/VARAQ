'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const {spawn,execFileSync}=require('node:child_process');const net=require('node:net');
const {DatabaseSync}=require('node:sqlite');
const ROOT=path.join(__dirname,'..');
async function port(){return new Promise((resolve,reject)=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const n=s.address().port;s.close(()=>resolve(n));});s.once('error',reject);});}
async function fixture(t){
 const storage=fs.mkdtempSync(path.join(os.tmpdir(),'varaq16-'));const p=await port();
 const child=spawn(process.execPath,['server.js'],{cwd:ROOT,env:{...process.env,PORT:String(p),HOST:'127.0.0.1',DATA_DIR:storage,PUBLIC_URL:''},stdio:['ignore','pipe','pipe']});
 let output='';await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('timeout: '+output)),12000);const acc=b=>{output+=b.toString();if(output.includes('PAYMENT: DISABLED')){clearTimeout(timer);resolve();}};child.stdout.on('data',acc);child.stderr.on('data',acc);child.on('exit',n=>reject(Error('server exit '+n+' '+output)));});
 t.after(()=>{child.kill('SIGINT');fs.rmSync(storage,{recursive:true,force:true});});
 return {base:`http://127.0.0.1:${p}`,storage};
}
const csrf=html=>html.match(/name="csrf" value="([^"]+)"/)?.[1];
const cookie=res=>res.headers.get('set-cookie')?.split(';')[0];
async function get(s,p,c=''){return fetch(s.base+p,{headers:{cookie:c},redirect:'manual'});}
async function post(s,p,fields,c=''){return fetch(s.base+p,{method:'POST',headers:{cookie:c,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(fields),redirect:'manual'});}
async function owner(s){
 let r=await post(s,'/login',{username:'admin',password:'ad123456789'});let c=cookie(r);
 const a=csrf(await (await get(s,'/panel/account',c)).text());
 r=await post(s,'/panel/account',{csrf:a,username:'admin',old_password:'ad123456789',new_password:'SafetyAdminPass1234',confirm_password:'SafetyAdminPass1234'},c);assert.equal(r.status,303);
 r=await post(s,'/login',{username:'admin',password:'SafetyAdminPass1234'});assert.equal(r.status,303);c=cookie(r);
 return {cookie:c,csrf:csrf(await (await get(s,'/panel/home-content',c)).text())};
}
const banner={title:'هفته کتاب و مطالعه',summary:'مجموعه منتخب برای علاقه‌مندان مطالعه',label:'مشاهده مجموعه',href:'/books?category=fiction',placement:'after_hero',sort_order:'1',active:'1'};

test('v1.6 owner can edit hero and reorder/toggle marketing banner without touching sales',async t=>{
 const s=await fixture(t),a=await owner(s);
 let r=await get(s,'/panel/home-content',a.cookie);assert.equal(r.status,200);assert.match(await r.text(),/بنرهای ثبت‌شده/);
 r=await post(s,'/panel/home-settings',{csrf:a.csrf,eyebrow:'پیشنهادهای این هفته',hero_title:'کتاب برای همه',hero_accent:'دنیای تازه',hero_description:'انتخاب آگاهانه کتاب برای همه خانواده‌ها.',primary_label:'مشاهده آثار',primary_href:'/books',secondary_label:'درس و مدرسه',secondary_href:'/educational',show_categories:'1',show_trust:'1'},a.cookie);assert.equal(r.status,303);
 let page=await (await get(s,'/')).text();assert.match(page,/کتاب برای همه/);assert.match(page,/پیشنهادهای این هفته/);assert.match(page,/درس و مدرسه/);assert.doesNotMatch(page,/SELECTED BOOKS/);
 r=await post(s,'/panel/home-banner',{csrf:a.csrf,...banner},a.cookie);assert.equal(r.status,303);assert.equal(r.headers.get('location'),'/panel/home-content?edit=1');
 page=await (await get(s,'/')).text();assert.match(page,/هفته کتاب و مطالعه/);assert.match(page,/href="\/books\?category=fiction"/);
 r=await post(s,'/panel/home-banner',{csrf:a.csrf,...banner,id:'1',active:'',sort_order:'50'},a.cookie);assert.equal(r.status,303);
 page=await (await get(s,'/')).text();assert.doesNotMatch(page,/هفته کتاب و مطالعه/);
 const db=new DatabaseSync(path.join(s.storage,'varaq.sqlite'),{readOnly:true});assert.equal(db.prepare('SELECT COUNT(*) n FROM books').get().n,1000);db.close();
 assert.deepEqual(await (await get(s,'/health')).json(),{ok:true,version:'8.6.0',payment_enabled:false,orders_mode:'demo_only'});
});

test('v1.6 admin-only, CSRF, unsafe URLs and script injection blocked/escaped',async t=>{
 const s=await fixture(t),a=await owner(s);
 let r=await post(s,'/panel/home-banner',{csrf:a.csrf,...banner,href:'javascript:alert(1)'},a.cookie);assert.equal(r.status,400);
 r=await post(s,'/panel/home-banner',{csrf:a.csrf,...banner,href:'//external.org/ads'},a.cookie);assert.equal(r.status,400);
 r=await post(s,'/panel/home-banner',{csrf:a.csrf,...banner,href:'/panel/stores'},a.cookie);assert.equal(r.status,400);
 r=await post(s,'/panel/home-banner',{csrf:'fake',...banner},a.cookie);assert.equal(r.status,403);
 r=await post(s,'/panel/home-banner',{...banner},'');assert.equal(r.status,303,'anonymous redirected to sign in');
 r=await post(s,'/panel/home-banner',{csrf:a.csrf,...banner,title:'<script>alert(1)</script>'},a.cookie);assert.equal(r.status,303);
 const html=await (await get(s,'/')).text();assert.match(html,/&lt;script&gt;alert\(1\)&lt;\/script&gt;/);assert.doesNotMatch(html,/<script>alert\(1\)<\/script>/);
 r=await post(s,'/panel/user',{csrf:a.csrf,username:'seller16',password:'sellerSuperStrong000',store_id:'1'},a.cookie);assert.equal(r.status,303);
 r=await post(s,'/login',{username:'seller16',password:'sellerSuperStrong000'});const c=cookie(r);
 r=await get(s,'/panel/home-content',c);assert.equal(r.status,403,'seller cannot open YM homepage management');
 const sellerCookie=c;
 const sellerCsrf=csrf(await (await get(s,'/panel',sellerCookie)).text());
 r=await get(s,'/panel/home-content',sellerCookie);assert.equal(r.status,403);
 r=await post(s,'/panel/home-banner',{csrf:sellerCsrf,...banner},sellerCookie);assert.equal(r.status,403);
});

test('v1.6 images are validated, inactive ones private, backups include assets and restore verifies checksums',async t=>{
 const s=await fixture(t),a=await owner(s);
 let r=await post(s,'/panel/home-banner',{csrf:a.csrf,...banner,active:''},a.cookie);assert.equal(r.status,303);
 const db=new DatabaseSync(path.join(s.storage,'varaq.sqlite'),{readOnly:true});const b=db.prepare('SELECT id FROM homepage_banners').get();assert.ok(b.id);
 const makeForm=(bytes,rights=true)=>{const f=new FormData();f.set('csrf',a.csrf);f.set('id',String(b.id));f.set('image_alt','تصویر معرفی کتاب‌ها');f.set('image_source','آرشیو تصویری YM');f.set('rights_note','تولید اختصاصی تیم');if(rights)f.set('licensed','1');f.set('banner',new Blob([bytes],{type:'image/png'}),'poster.png');return f;};
 r=await fetch(s.base+'/panel/home-banner-image',{method:'POST',headers:{cookie:a.cookie},body:makeForm(Buffer.from('bad-image')),redirect:'manual'});assert.equal(r.status,400);
 const png=fs.readFileSync(path.join(__dirname,'fixtures','test_banner.png'));
 r=await fetch(s.base+'/panel/home-banner-image',{method:'POST',headers:{cookie:a.cookie},body:makeForm(png,false),redirect:'manual'});assert.equal(r.status,400);
 r=await fetch(s.base+'/panel/home-banner-image',{method:'POST',headers:{cookie:a.cookie},body:makeForm(png),redirect:'manual'});assert.equal(r.status,303);
 const uploaded=db.prepare('SELECT filename,mime,active FROM homepage_banners').get();assert.match(uploaded.filename,/^[a-f0-9]{32}\.png$/);
 r=await get(s,'/media/banners/'+uploaded.filename);assert.equal(r.status,404,'unpublished banner image remains private');
 r=await get(s,'/media/banners/'+uploaded.filename,a.cookie);assert.equal(r.status,200);
 r=await post(s,'/panel/home-banner',{csrf:a.csrf,...banner,id:String(b.id)},a.cookie);assert.equal(r.status,303);
 let html=await (await get(s,'/')).text();assert.match(html,/media\/banners/);
 r=await get(s,'/media/banners/'+uploaded.filename);assert.equal(r.status,200);
 const stdout=execFileSync(process.execPath,['backup.js'],{cwd:ROOT,env:{...process.env,DATA_DIR:s.storage},encoding:'utf8'});
 const directory=stdout.match(/VERIFIED BACKUP: ([^\n]+)/)?.[1];assert.ok(directory);
 assert.ok(fs.existsSync(path.join(directory,'banners',uploaded.filename)));
 const manifest=JSON.parse(fs.readFileSync(path.join(directory,'manifest.json'),'utf8'));
 assert.ok(manifest.files.some(x=>x.path==='banners/'+uploaded.filename));
 const restore=path.join(os.tmpdir(),'varaq16-restored-'+Date.now()+'-'+Math.random().toString(16).slice(2));
 try{execFileSync(process.execPath,['restore-backup.js',directory,restore],{cwd:ROOT,encoding:'utf8'});assert.ok(fs.existsSync(path.join(restore,'banners',uploaded.filename)));}
 finally{fs.rmSync(restore,{recursive:true,force:true});}
 r=await post(s,'/panel/home-banner-remove',{csrf:a.csrf,id:String(b.id)},a.cookie);assert.equal(r.status,303);
 r=await get(s,'/media/banners/'+uploaded.filename);assert.equal(r.status,404);
 db.close();
});

test('v1.6 banner ordering, display positions and 12-banner limit',async t=>{
 const s=await fixture(t),a=await owner(s);
 for(let i=0;i<12;i++){
  const fields={...banner,title:'بنر شماره '+(i+1),placement:i%2?'after_categories':'after_hero',sort_order:String(50-i),active:i<3?'1':''};
  const r=await post(s,'/panel/home-banner',{csrf:a.csrf,...fields},a.cookie);assert.equal(r.status,303,'banner '+i);
 }
 let r=await post(s,'/panel/home-banner',{csrf:a.csrf,...banner},a.cookie);assert.equal(r.status,400);
 const homepage=await (await get(s,'/')).text();assert.match(homepage,/بنر شماره 1/);assert.match(homepage,/بنر شماره 2/);assert.match(homepage,/بنر شماره 3/);assert.doesNotMatch(homepage,/بنر شماره 4/);
 assert.ok(homepage.indexOf('بنر شماره 3')<homepage.indexOf('بنر شماره 1'),'smaller sort_order is shown first within placement');
 const db=new DatabaseSync(path.join(s.storage,'varaq.sqlite'),{readOnly:true});assert.equal(db.prepare('SELECT COUNT(*) n FROM homepage_banners').get().n,12);db.close();
});

test('v1.6 migration from v1.5 keeps existing user, seller, book and offers',async t=>{
 const storage=fs.mkdtempSync(path.join(os.tmpdir(),'varaq16-upgrade-'));
 t.after(()=>fs.rmSync(storage,{recursive:true,force:true}));
 const p=await port(),old=path.resolve(ROOT,'../../varaq_v15_build/varaq/server.js');
 if(!fs.existsSync(old)){t.skip('نسخه قدیمی v1.5 برای آزمون ارتقای تاریخی در این بسته موجود نیست.');return;}
 const child=spawn(process.execPath,[old],{cwd:path.dirname(old),env:{...process.env,DATA_DIR:storage,PORT:String(p),HOST:'127.0.0.1',PUBLIC_URL:''},stdio:['ignore','pipe','pipe']});
 let out='';await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('v1.5 startup timeout '+out)),12000);child.stdout.on('data',b=>{out+=b.toString();if(out.includes('PAYMENT: DISABLED')){clearTimeout(timer);resolve();}});child.stderr.on('data',b=>out+=b.toString());child.on('exit',code=>reject(Error('v1.5 exited '+code+' '+out)));});
 child.kill('SIGINT');await new Promise(resolve=>child.once('exit',resolve));
 const before=new DatabaseSync(path.join(storage,'varaq.sqlite'));
 const count=before.prepare('SELECT COUNT(*) n FROM books').get().n;
 before.prepare("INSERT INTO stores(name,slug,city,active) VALUES('فروشگاه تست','legacy-shop','یزد',0)").run();
 before.prepare("INSERT INTO offers(book_id,store_id,price,stock,active) VALUES(1,2,121000,3,0)").run();
 before.close();
 const procPort=await port();const current=spawn(process.execPath,['server.js'],{cwd:ROOT,env:{...process.env,DATA_DIR:storage,PORT:String(procPort),HOST:'127.0.0.1',PUBLIC_URL:''},stdio:['ignore','pipe','pipe']});
 let str='';await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('v1.6 upgrade startup timeout '+str)),12000);current.stdout.on('data',b=>{str+=b.toString();if(str.includes('PAYMENT: DISABLED')){clearTimeout(timer);resolve();}});current.stderr.on('data',b=>str+=b.toString());current.on('exit',code=>reject(Error('v1.6 exited '+code+' '+str)));});
 t.after(()=>current.kill('SIGINT'));
 const db=new DatabaseSync(path.join(storage,'varaq.sqlite'),{readOnly:true});
 assert.equal(db.prepare('SELECT COUNT(*) n FROM books').get().n,count);
 assert.equal(db.prepare("SELECT COUNT(*) n FROM users WHERE username='admin'").get().n,1);
 assert.equal(db.prepare("SELECT price FROM offers WHERE store_id=2").get().price,121000);
 assert.ok(db.prepare('SELECT hero_title FROM homepage_settings WHERE id=1').get().hero_title);
 db.close();
});
