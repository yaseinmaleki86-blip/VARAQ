'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const {spawn}=require('node:child_process');
const {DatabaseSync}=require('node:sqlite');
const seo=require('../lib/seo');
async function serve(t,publicMode=true){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'varaq-38-'));
 const sock=net.createServer();await new Promise(r=>sock.listen(0,'127.0.0.1',r));const port=sock.address().port;await new Promise(r=>sock.close(r));
 const base=`http://127.0.0.1:${port}`;
 const env={...process.env,HOST:'127.0.0.1',PORT:String(port),DATA_DIR:dir,VARAQ_CURATED_SEED:'1'};
 if(publicMode){Object.assign(env,{PUBLIC_URL:base,VARAQ_PUBLIC_INDEX:'1',VARAQ_LEGAL_REVIEWED:'1',VARAQ_MEDIA_RIGHTS_REVIEWED:'1',VARAQ_BROWSER_QA_APPROVED:'1'});}else delete env.PUBLIC_URL;
 const child=spawn(process.execPath,['server.js'],{cwd:path.join(__dirname,'..'),env,stdio:['ignore','pipe','pipe']});
 let logs='';child.stdout.on('data',b=>logs+=b);child.stderr.on('data',b=>logs+=b);
 for(let tries=0;tries<120;tries++){
  if(child.exitCode!==null||child.signalCode)throw Error('3.8 server unexpectedly exited: '+logs);
  try{const r=await fetch(base+'/health');if(r.ok)break;}catch{}
  await new Promise(r=>setTimeout(r,50));
 }
 const db=new DatabaseSync(path.join(dir,'varaq.sqlite'));
 t.after(async()=>{db.close();child.kill('SIGTERM');await new Promise(r=>child.exitCode!==null||child.signalCode?r():child.once('exit',r));fs.rmSync(dir,{recursive:true,force:true});});
 return {base,db};
}
test('3.8 public SEO: canonical social metadata, JSON-LD, trusted titles and no real payments',async t=>{
 const s=await serve(t);
 let r=await fetch(s.base+'/');let html=await r.text();
 assert.match(html,/<meta property="og:locale" content="fa_IR">/);
 assert.match(html,/<meta property="og:url" content="http:\/\/127\.0\.0\.1:\d+\/">/);
 assert.match(html,/https:\/\/schema\.org/);assert.match(html,/SearchAction/);
 r=await fetch(s.base+'/book/book-001');html=await r.text();
 assert.match(html,/<meta property="og:type" content="book">/);
 assert.match(html,/BreadcrumbList/);assert.match(html,/application\/ld\+json/);
 assert.doesNotMatch(html,/<meta name="robots" content="noindex,follow">/);
 r=await fetch(s.base+'/books?q='+encodeURIComponent('ملت عشق'));html=await r.text();
 assert.match(html,/<meta name="robots" content="noindex,follow">/);
 assert.match(html,new RegExp('rel="canonical" href="'+s.base.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'/books"'));
 assert.equal((await(await fetch(s.base+'/health')).json()).payment_enabled,false);
});
test('3.8 public indexing: unsourced book visible but excluded; sourced page included; sitemap XML safe',async t=>{
 const s=await serve(t);
 const missing=s.db.prepare(`SELECT b.slug FROM books b WHERE trim(b.author)<>'' AND NOT EXISTS
  (SELECT 1 FROM editions e JOIN edition_sources x ON x.edition_id=e.id WHERE e.book_id=b.id AND e.verified=1 AND trim(x.source_url)<>'') LIMIT 1`).get();
 assert.ok(missing);
 let r=await fetch(s.base+'/book/'+missing.slug);assert.equal(r.status,200);let html=await r.text();assert.match(html,/noindex,follow/);
 r=await fetch(s.base+'/sitemap.xml');html=await r.text();
 assert.match(html,/\/book\/book-001/);assert.doesNotMatch(html,new RegExp('\\/book\\/'+missing.slug+'(?:<|\\?)'));
 const q=seo.xmlSitemap('https://books.example',['/','/authors/'+encodeURIComponent('آیدا & نویسنده')]);
 assert.match(q,/https:\/\/books\.example\/authors\//);assert.match(q,/%26/);assert.throws(()=>seo.xmlSitemap('https://books.example',['//attacker.example/']));
 s.db.prepare('UPDATE books SET author=? WHERE slug=?').run('','book-001');
 r=await fetch(s.base+'/book/book-001');assert.match(await r.text(),/noindex,follow/);
 r=await fetch(s.base+'/sitemap.xml');assert.doesNotMatch(await r.text(),/\/book\/book-001</);
});
test('3.8 static fingerprint cache is immutable; legacy asset path remains compatible',async t=>{
 const s=await serve(t);
 const html=await(await fetch(s.base+'/')).text();
 const css=html.match(/href="(\/assets\/style\.[a-f0-9]{16}\.css)"/),js=html.match(/src="(\/assets\/app\.[a-f0-9]{16}\.js)"/);
 assert.ok(css,'fingerprinted CSS');assert.ok(js,'fingerprinted JS');
 let r=await fetch(s.base+css[1]);assert.equal(r.status,200);assert.match(r.headers.get('cache-control'),/immutable/);
 const etag=r.headers.get('etag');assert.ok(etag);
 r=await fetch(s.base+css[1],{headers:{'if-none-match':etag}});assert.equal(r.status,304);
 r=await fetch(s.base+'/assets/style.css');assert.equal(r.status,200);assert.doesNotMatch(r.headers.get('cache-control'),/immutable/);
 r=await fetch(s.base+js[1]);assert.equal(r.status,200);assert.match(r.headers.get('cache-control'),/immutable/);
});
test('3.8 public unauthenticated HTML is gzipped; secret receipt, cart and authenticated/private pages are not',async t=>{
 const s=await serve(t);
 let r=await fetch(s.base+'/books',{headers:{'accept-encoding':'gzip'}});
 assert.equal(r.status,200);assert.equal(r.headers.get('content-encoding'),'gzip');
 assert.match(r.headers.get('vary'),/Accept-Encoding/);assert.match(await r.text(),/کتابخانه ورق/);
 r=await fetch(s.base+'/cart',{headers:{'accept-encoding':'gzip'}});assert.equal(r.headers.get('content-encoding'),null);
 r=await fetch(s.base+'/book/book-001',{headers:{'accept-encoding':'gzip'}});assert.equal(r.headers.get('content-encoding'),null);
 r=await fetch(s.base+'/books',{headers:{cookie:'test=one','accept-encoding':'gzip'}});assert.equal(r.headers.get('content-encoding'),null);
});
test('3.8 SEO helper does not inject untrusted metadata as HTML/script',()=>{
 const html=seo.openGraph({title:'آزمایش <script>"',description:'a&b',canonical:'https://example.test/book'});
 assert.match(html,/&lt;script&gt;&quot;/);assert.doesNotMatch(html,/<script>/);assert.match(html,/a&amp;b/);
 const data=seo.breadcrumbs('https://example.test',[{name:'<script>alert(1)</script>',path:'/'}]);
 assert.doesNotMatch(data,/<script>alert/);assert.match(data,/\\u003cscript>/);
});
