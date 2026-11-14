'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const discovery=require('../lib/pdf-discovery');
const pdfStore=require('../lib/pdf-store');
const pdfUi=require('../lib/pdf-ui');
function fixture(){
 const db=new DatabaseSync(':memory:');
 db.exec(`PRAGMA foreign_keys=ON;
 CREATE TABLE books(id INTEGER PRIMARY KEY,slug TEXT,title TEXT,author TEXT,category TEXT);
 CREATE TABLE stores(id INTEGER PRIMARY KEY,name TEXT,active INTEGER);
 CREATE TABLE users(id INTEGER PRIMARY KEY);
 INSERT INTO users VALUES(1);
 INSERT INTO stores VALUES(1,'کتاب‌فروشی اول',1),(2,'کتاب‌فروشی دوم',1),(3,'فروشگاه غیرفعال',0);
 INSERT INTO books VALUES(1,'book-1','داستان کتاب یک','نویسنده الف','داستان'),
  (2,'book-2','کتاب دوم','نویسنده ب','علمی');`);
 pdfStore.migrate(db);
 const sql=db.prepare(`INSERT INTO digital_books(store_id,book_id,title,description,price,filename,original_name,file_sha256,file_bytes,
  rights_holder,rights_basis,rights_evidence,status,rights_expires_on,distribution_hold)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
 const add=(i,store,book,state='approved',hold=0,expiry='2099-12-31')=>sql.run(store,book,'نسخه PDF '+i,'توضیح معتبر',12000+i,
  i.toString(16).padStart(32,'0')+'.pdf','test.pdf','f'.repeat(64),50000,'دارنده حقوق','اجازه کتبی مالک','شناسه قرارداد معتبر',state,expiry,hold);
 for(let i=1;i<=27;i++)add(i,i===27?2:1,i%2===0?2:1);
 add(28,1,1,'approved',1);add(29,1,1,'approved',0,'2020-01-01');add(30,3,1);
 add(31,1,1,'pending');
 return db;
}
const escape=s=>String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;');
const uiHelpers={esc:escape,attr:escape,money:n=>n+' تومان',digits:n=>String(n),linkedPrintCover:()=>'<div class="cover-image-frame">طرح نمونه</div>'};
test('8.0 public PDF discovery excludes suspended, expired, inactive and unapproved records',t=>{
 const db=fixture();t.after(()=>db.close());
 const first=discovery.browse(db,{},'2026-11-04');
 assert.equal(first.total,27);assert.equal(first.pages,3);assert.equal(first.items.length,12);
 const last=discovery.browse(db,{page:999},'2026-11-04');
 assert.equal(last.page,3);assert.equal(last.items.length,3);
 const scoped=discovery.browse(db,{store:2},'2026-11-04');
 assert.equal(scoped.total,1);assert.equal(scoped.items[0].store_name,'کتاب‌فروشی دوم');
 const facets=discovery.facets(db,'2026-11-04');
 assert.equal(facets.categories.find(x=>x.name==='داستان').total,14);
 assert.equal(facets.categories.find(x=>x.name==='علمی').total,13);
 assert.equal(facets.stores.find(x=>x.id===1).total,26);
 assert.equal(facets.stores.some(x=>x.id===3),false);
});
test('8.0 category, author, sort and literal query filters are parameterized and consistent',t=>{
 const db=fixture();t.after(()=>db.close());
 assert.equal(discovery.browse(db,{category:'علمی'}).total,13);
 assert.equal(discovery.browse(db,{q:'نویسنده ب'}).total,13);
 assert.equal(discovery.browse(db,{category:'علمی',store:2}).total,0);
 assert.equal(discovery.browse(db,{q:'%'}).total,0);
 assert.equal(discovery.browse(db,{category:"داستان' OR 1=1 --"}).total,0);
 assert.equal(discovery.browse(db,{sort:'price_asc'}).items[0].price,12001);
 const html=pdfUi.publicPage(db,new URL('https://varaq.example/pdf-books?category=%D8%B9%D9%84%D9%85%DB%8C&page=2'),uiHelpers);
 assert.match(html,/موضوع/);assert.match(html,/صفحه 2 از 2/);
 assert.match(html,/صفحه قبل/);assert.match(html,/category=/);
 assert.doesNotMatch(html,/file_sha256|rights_evidence|digital-pdfs|\/pdf-delivery\//);
 assert.match(html,/پرداخت و دانلود پولی هنوز فعال نشده است/);
});
test('8.0 filters keep the PDF listings safe when all eligible inventory is removed',t=>{
 const db=fixture();t.after(()=>db.close());
 db.exec("UPDATE digital_books SET distribution_hold=1");
 assert.equal(discovery.browse(db).total,0);
 assert.deepEqual(discovery.facets(db).stores,[]);
 const html=pdfUi.publicPage(db,new URL('https://varaq.example/pdf-books?sort=title'),uiHelpers);
 assert.match(html,/PDF قابل‌نمایشی پیدا نشد/);
 assert.doesNotMatch(html,/نسخه PDF 1/);
});
