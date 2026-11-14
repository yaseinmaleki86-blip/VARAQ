'use strict';
// VARAQ 6.4: factual-review workflow for locally generated introductions.
// Approval applies to the exact text snapshot, never to a cover, publisher license, or store offer.
const crypto = require('node:crypto');
const STATUSES = new Set(['pending','approved','revise','hidden']);
const label = {pending:'نیازمند بررسی',approved:'بازبینی تحریریه شده',revise:'نیازمند اصلاح',hidden:'عدم نمایش متن تولیدی',stale:'بازبینی مجدد پس از تغییر متن'};
function migrate(db){
 db.exec(`CREATE TABLE IF NOT EXISTS generated_editorial_reviews (
  book_id INTEGER PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN ('pending','approved','revise','hidden')),
  content_hash TEXT NOT NULL, source_url TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '', reviewer_id INTEGER REFERENCES users(id),
  revision INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
 );
 CREATE TABLE IF NOT EXISTS generated_editorial_review_history (
  id INTEGER PRIMARY KEY,
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  status TEXT NOT NULL, content_hash TEXT NOT NULL, source_url TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '', reviewer_id INTEGER REFERENCES users(id),
  revision INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
 );
 CREATE INDEX IF NOT EXISTS idx_generated_editorial_reviews_status ON generated_editorial_reviews(status);`);
}
function hash(entry){
 if(!entry)return '';
 return crypto.createHash('sha256').update(JSON.stringify([entry.title,entry.description,entry.reader_note,entry.topics])).digest('hex');
}
function record(db,entry){
 if(!entry)return null;
 const row=db.prepare('SELECT * FROM generated_editorial_reviews WHERE book_id=?').get(entry.id);
 return {book_id:entry.id,status:row?(row.content_hash===hash(entry)?row.status:'stale'):'pending',revision:row?.revision||0,
  hash:hash(entry),source_url:row?.source_url||'',note:row?.note||'',reviewer_id:row?.reviewer_id||null,
  updated_at:row?.updated_at||'',previous_status:row?.status||null};
}
function validSource(raw){
 if(typeof raw!=='string'||raw.length>1000)return false;
 try{const parsed=new URL(raw);return ['https:','http:'].includes(parsed.protocol)&&!!parsed.hostname&&!parsed.username&&!parsed.password;}catch{return false;}
}
function update(db,catalogue,fields,reviewerId){
 const bookId=Number(fields.book_id),entry=catalogue.find(x=>x.id===bookId);
 if(!entry||!Number.isSafeInteger(bookId))throw Error('کتاب معتبر نیست.');
 const liveBook=db.prepare('SELECT title FROM books WHERE id=?').get(bookId);
 if(!liveBook)throw Error('کتاب در پایگاه داده وجود ندارد.');
 const current=record(db,entry),expectedRevision=Number(fields.revision);
 if(!Number.isSafeInteger(expectedRevision)||expectedRevision!==current.revision)throw Error('این پرونده قبلاً تغییر کرده است؛ صفحه را تازه‌سازی کنید.');
 if(fields.content_hash!==current.hash)throw Error('متن کتاب نسبت به نسخه فرم تغییر کرده است.');
 const status=String(fields.status||'');if(!STATUSES.has(status))throw Error('وضعیت نامعتبر است.');
 const note=String(fields.note||'').trim(),source=String(fields.source_url||'').trim();
 if(note.length>1000||source.length>1000)throw Error('متن یادداشت یا منبع بیش از حد مجاز است.');
 if(source&&!validSource(source))throw Error('نشانی منبع باید HTTP یا HTTPS معتبر باشد.');
 if(status==='approved'&&liveBook.title!==entry.title)throw Error('عنوان کتاب تغییر کرده است؛ پیش از تأیید، متن تولیدی را با عنوان جدید تطبیق دهید.');
 if(status==='approved'&&(!validSource(source)||note.length<12))throw Error('برای تأیید معرفی، لینک منبع و یادداشت بررسی حداقل ۱۲ حرف لازم است.');
 if(['revise','hidden'].includes(status)&&note.length<8)throw Error('برای اصلاح یا توقف نمایش باید دلیل ثبت شود.');
 db.exec('BEGIN IMMEDIATE');
 try{
  // A second editor cannot silently override a more recent review.
  const prior=db.prepare('SELECT revision FROM generated_editorial_reviews WHERE book_id=?').get(bookId);
  if((prior?.revision||0)!==expectedRevision)throw Error('نسخه پرونده تغییر کرده است.');
  const rev=expectedRevision+1;
  db.prepare(`INSERT INTO generated_editorial_reviews(book_id,status,content_hash,source_url,note,reviewer_id,revision)
   VALUES(?,?,?,?,?,?,?) ON CONFLICT(book_id) DO UPDATE SET status=excluded.status, content_hash=excluded.content_hash,
   source_url=excluded.source_url,note=excluded.note,reviewer_id=excluded.reviewer_id,
   revision=excluded.revision,updated_at=CURRENT_TIMESTAMP`).run(bookId,status,current.hash,source,note,reviewerId,rev);
  db.prepare('INSERT INTO generated_editorial_review_history(book_id,status,content_hash,source_url,note,reviewer_id,revision) VALUES(?,?,?,?,?,?,?)').run(bookId,status,current.hash,source,note,reviewerId,rev);
  db.exec('COMMIT');return rev;
 }catch(error){db.exec('ROLLBACK');throw error;}
}
function rows(db,catalogue,{q='',status='all'}={}){
 const lookup=db.prepare('SELECT id,title,description FROM books WHERE id=?');const query=String(q).trim().toLocaleLowerCase('fa').slice(0,80);
 return catalogue.map(entry=>{
   const book=lookup.get(entry.id);if(!book)return null;
   const review=record(db,entry);return {...review,title:book.title,author_description:book.description,
    entry,has_editor_copy:!!book.description?.trim()};
 }).filter(Boolean).filter(r=>(status==='all'||r.status===status)&&(!query||r.title.toLocaleLowerCase('fa').includes(query)||String(r.book_id).includes(query)));
}
function csv(db,catalogue){
 const list=rows(db,catalogue),head=['book_id','title','status','version','reviewed_at','source_url','reviewer_note','custom_description'];
 const cell=x=>{const v=String(x??'');const safe=/^[=+@\-\t\r]/.test(v)?"'"+v:v;return '"'+safe.replace(/"/g,'""')+'"';};
 return '\uFEFF'+[head.join(','),...list.map(r=>[r.book_id,r.title,label[r.status],r.revision,r.updated_at,r.source_url,r.note,r.has_editor_copy?'yes':'no'].map(cell).join(','))].join('\r\n')+'\r\n';
}
module.exports={migrate,hash,record,update,rows,csv,label};
