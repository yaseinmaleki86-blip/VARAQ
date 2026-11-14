'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const review=require('../lib/bibliographic-review-v83');
function dbFixture(){
 const db=new DatabaseSync(':memory:');
 db.exec(`PRAGMA foreign_keys=ON;
 CREATE TABLE books(id INTEGER PRIMARY KEY,slug TEXT,title TEXT,author TEXT,publisher TEXT,isbn TEXT,category TEXT);
 CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT);
 CREATE TABLE editions(id INTEGER PRIMARY KEY,book_id INTEGER,verified INTEGER,isbn TEXT,publisher TEXT,label TEXT);
 CREATE TABLE edition_sources(edition_id INTEGER PRIMARY KEY,source_url TEXT);
 INSERT INTO users VALUES(1,'admin');
 INSERT INTO books VALUES(1,'book-001','ملت عشق','الیف شافاک','ققنوس','9789643119195','رمان'),(2,'book-002','=HYPERLINK(\"bad\")','','','','ادبیات');
 INSERT INTO editions VALUES(4,1,1,'9789643119195','ققنوس','چاپ اصلی');
 INSERT INTO edition_sources VALUES(4,'https://publisher.example/edition');`);
 review.migrate(db);return db;
}
function submit(row,changes={}){return {book_id:String(row.id),status:'reviewed',revision:String(row.revision),fingerprint:row.signature,source_url:'https://publisher.example/edition',notes:'تطبیق مشخصات بر اساس صفحه ناشر',confirm:'1',...changes};}
test('8.3 initial queue: no records invented, factual gaps remain visible',t=>{
 const db=dbFixture();t.after(()=>db.close());
 const rows=review.all(db);assert.equal(rows.length,2);assert.equal(rows[0].status,'draft');
 assert.equal(rows[0].source_editions,1);assert.deepEqual(rows[0].missing,[]);
 assert.equal(rows[1].missing.includes('نویسنده'),true);
 assert.equal(review.summary(rows).reviewed,0);
 assert.equal(review.select(rows,{mode:'pending'}).total,2);
 assert.equal(review.select(rows,{q:'الیف شافاك'}).total,1);
});
test('8.3 human verification is explicit, evidence-bound and never edits books',t=>{
 const db=dbFixture();t.after(()=>db.close());
 const row=review.all(db)[0];
 assert.throws(()=>review.save(db,submit(row,{confirm:''}),1),/تأیید بررسی انسانی/);
 assert.throws(()=>review.save(db,submit(row,{source_url:'http://insecure.example'}),1),/HTTPS/);
 assert.throws(()=>review.save(db,submit(row,{source_url:'https://alice:pass@example.com'}),1),/HTTPS/);
 assert.throws(()=>review.save(db,submit(row,{source_url:'file:///etc/passwd'}),1),/HTTPS/);
 const before=db.prepare('SELECT * FROM books WHERE id=1').get();
 assert.equal(review.save(db,submit(row),1),1);
 assert.deepEqual(db.prepare('SELECT * FROM books WHERE id=1').get(),before);
 const after=review.all(db)[0];assert.equal(after.status,'reviewed');assert.equal(after.revision,1);
 assert.equal(review.history(db,1).length,1);
 assert.equal(review.save(db,submit(after),1),1); // idempotent saves don't create new history
 assert.equal(review.history(db,1).length,1);
 assert.throws(()=>review.save(db,submit(row,{status:'draft'}),1),/تغییر کرده/);
});
test('8.3 invalid ISBN, missing sourced edition, or absent fields block review',t=>{
 const db=dbFixture();t.after(()=>db.close());
 const bad=review.all(db)[1];
 assert.throws(()=>review.save(db,submit(bad),1),/تکمیل/);
 assert.throws(()=>review.save(db,submit(bad,{status:'needs_correction',notes:'x'}),1),/۸ حرف/);
 assert.equal(review.save(db,submit(bad,{status:'needs_correction',notes:'شابک و نویسنده موجود نیست',confirm:''}),1),2);
 assert.equal(review.all(db)[1].status,'needs_correction');
 assert.equal(review.history(db,2).length,1);
});
test('8.3 verified review becomes stale after book edits or print-source changes',t=>{
 const db=dbFixture();t.after(()=>db.close());
 const first=review.all(db)[0];review.save(db,submit(first),1);
 db.prepare('UPDATE books SET publisher=? WHERE id=1').run('ناشر جدید');
 const stale=review.all(db)[0];assert.equal(stale.status,'stale');
 assert.equal(review.select(review.all(db),{mode:'stale'}).total,1);
 assert.equal(review.save(db,submit(stale),1),1);
 assert.equal(review.all(db)[0].status,'reviewed');
 db.prepare('UPDATE edition_sources SET source_url=? WHERE edition_id=4').run('https://publisher.example/new');
 assert.equal(review.all(db)[0].status,'stale');
});
test('8.3 escaping and CSV formula protection prevent spreadsheet execution',t=>{
 const db=dbFixture();t.after(()=>db.close());
 const output=review.csv(review.all(db));
 assert.match(output,/"'=HYPERLINK/);
 assert.doesNotMatch(output,/password_hash|pdf_file|digital-pdfs/);
 assert.equal(review.select(review.all(db),{page:900,perPage:1}).page,2);
 assert.equal(review.select(review.all(db),{mode:'invalid'}).mode,'pending');
});
