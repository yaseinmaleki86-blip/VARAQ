'use strict';
// VARAQ 8.3: human provenance review. Saving a review DOES NOT modify a book,
// validate copyright/cover rights, approve an edition, or enable payment.
const crypto=require('node:crypto');
const {validIsbn,isbn:cleanIsbn}=require('./catalog-consistency');
const {normalize}=require('./discovery');
const STATES=Object.freeze({draft:'ثبت‌نشده / پیش‌نویس',needs_correction:'نیازمند اصلاح',reviewed:'بازبینی انسانی ثبت‌شده',stale:'نیازمند بازبینی مجدد'});
function fail(message){const e=Error(message);e.userError=true;return e;}
function migrate(db){
 db.exec(`CREATE TABLE IF NOT EXISTS book_fact_reviews(
  book_id INTEGER PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','needs_correction','reviewed')),
  source_url TEXT NOT NULL DEFAULT '',notes TEXT NOT NULL DEFAULT '',
  fingerprint TEXT NOT NULL DEFAULT '',revision INTEGER NOT NULL DEFAULT 0,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
 );
 CREATE TABLE IF NOT EXISTS book_fact_review_events(
  id INTEGER PRIMARY KEY,book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  previous_status TEXT NOT NULL,new_status TEXT NOT NULL,
  revision INTEGER NOT NULL,snapshot_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(book_id,revision)
 );
 CREATE INDEX IF NOT EXISTS idx_fact_review_status ON book_fact_reviews(status);
 CREATE INDEX IF NOT EXISTS idx_fact_review_events_book ON book_fact_review_events(book_id,id DESC);`);
}
function source(value){
 const raw=String(value||'').trim();if(!raw)return '';
 if(raw.length>800)throw fail('آدرس منبع بیش از حد طولانی است.');
 let u;try{u=new URL(raw);}catch{throw fail('لینک منبع معتبر نیست.');}
 if(u.protocol!=='https:'||!u.hostname||u.username||u.password)throw fail('منبع باید نشانی HTTPS بدون نام کاربری و رمز باشد.');
 return raw;
}
function all(db){
 const books=db.prepare('SELECT id,slug,title,author,publisher,isbn,category FROM books ORDER BY id').all();
 const editions=db.prepare(`SELECT e.book_id,e.id,e.isbn,e.publisher,e.label,e.verified,COALESCE(s.source_url,'') source_url
 FROM editions e LEFT JOIN edition_sources s ON s.edition_id=e.id ORDER BY e.book_id,e.id`).all();
 const reviews=db.prepare('SELECT * FROM book_fact_reviews').all();
 const byBook=new Map(),reviewById=new Map(reviews.map(x=>[x.book_id,x]));
 for(const e of editions){if(!byBook.has(e.book_id))byBook.set(e.book_id,[]);byBook.get(e.book_id).push(e);}
 return books.map(b=>{
  const e=byBook.get(b.id)||[];
  const sourced=e.filter(x=>x.verified===1&&x.source_url&&validIsbn(x.isbn));
  const isbnValues=[b.isbn,...e.map(x=>x.isbn)].map(cleanIsbn).filter(Boolean);
  const missing=[];
  if(!String(b.author||'').trim())missing.push('نویسنده');
  if(!String(b.publisher||'').trim()&&!sourced.some(x=>String(x.publisher||'').trim()))missing.push('ناشر');
  if(!isbnValues.some(validIsbn))missing.push('شابک معتبر');
  if(!sourced.length)missing.push('چاپ مستند');
  const signature=crypto.createHash('sha256').update(JSON.stringify({
   title:b.title,author:b.author,publisher:b.publisher,isbn:b.isbn,category:b.category,
   editions:e.map(x=>[x.id,x.isbn,x.publisher,x.label,x.verified,x.source_url])
  })).digest('hex');
  const review=reviewById.get(b.id)||null;
  const stale=Boolean(review&&review.status==='reviewed'&&review.fingerprint!==signature);
  const status=stale?'stale':review?.status||'draft';
  return {...b,source_editions:sourced.length,isbns:[...new Set(isbnValues)].join('، '),missing,
   status,signature,source_url:review?.source_url||'',notes:review?.notes||'',
   revision:review?.revision||0,reviewer_id:review?.updated_by||null,updated_at:review?.updated_at||'',
   last_saved_status:review?.status||'draft'};
 });
}
function select(rows,{mode='pending',q='',page=1,perPage=18}={}){
 if(!Object.hasOwn(STATES,mode)&&mode!=='all'&&mode!=='pending'&&mode!=='missing')mode='pending';
 q=String(q||'').trim().slice(0,80);
 const terms=normalize(q).split(' ').filter(Boolean).slice(0,8);
 const filtered=rows.filter(b=>{
  const found=mode==='all'||(mode==='pending'?b.status!=='reviewed':mode==='missing'?b.missing.length>0:b.status===mode);
  return found&&terms.every(term=>normalize([b.id,b.title,b.author,b.publisher,b.isbns].join(' ')).includes(term));
 });
 const priority={stale:0,needs_correction:1,draft:2,reviewed:3};
 filtered.sort((a,b)=>priority[a.status]-priority[b.status]||b.missing.length-a.missing.length||a.id-b.id);
 const pp=Math.max(1,Math.min(100,Math.floor(Number(perPage)||18)));
 const pages=Math.max(1,Math.ceil(filtered.length/pp)),p=Math.max(1,Math.min(pages,Math.floor(Number(page)||1)));
 return {all:filtered,items:filtered.slice((p-1)*pp,p*pp),total:filtered.length,pages,page:p,mode,q};
}
function summary(rows){return {total:rows.length,reviewed:rows.filter(r=>r.status==='reviewed').length,
  stale:rows.filter(r=>r.status==='stale').length,needsCorrection:rows.filter(r=>r.status==='needs_correction').length,
  missing:rows.filter(r=>r.missing.length).length,pending:rows.filter(r=>r.status!=='reviewed').length};}
function save(db,fields,actor){
 const id=Number(fields.book_id),status=String(fields.status||'');
 if(!Number.isSafeInteger(id)||id<1||!['draft','needs_correction','reviewed'].includes(status))throw fail('شناسه یا وضعیت معتبر نیست.');
 if(!Number.isSafeInteger(actor)||actor<1)throw fail('کاربر بررسی‌کننده معتبر نیست.');
 const row=all(db).find(x=>x.id===id);if(!row)throw fail('کتاب وجود ندارد.');
 const link=source(fields.source_url),notes=String(fields.notes||'').trim();
 if(notes.length>1000)throw fail('یادداشت بررسی بیش از حد طولانی است.');
 if(status==='needs_correction'&&notes.length<8)throw fail('برای اعلام مشکل حداقل ۸ حرف توضیح بنویسید.');
 if(status==='reviewed'){
  if(fields.confirm!=='1')throw fail('تأیید بررسی انسانی منبع و شناسنامه کتاب ضروری است.');
  if(!link)throw fail('برای تأیید اطلاعات، لینک منبع HTTPS لازم است.');
  if(row.missing.length)throw fail('تا زمان تکمیل این موارد، تأیید مجاز نیست: '+row.missing.join('، '));
 }
 const revision=Number(fields.revision);
 if(!Number.isSafeInteger(revision)||revision<0)throw fail('نسخه بازبینی نامعتبر است.');
 db.exec('BEGIN IMMEDIATE');try{
  const old=db.prepare('SELECT * FROM book_fact_reviews WHERE book_id=?').get(id);
  const latest=old?.revision||0;
  if(latest!==revision)throw fail('این پرونده در پنل دیگری تغییر کرده است؛ صفحه را تازه‌سازی کنید.');
  // The page may have changed after the form loaded, even if the review row did not.
  if(status==='reviewed'&&fields.fingerprint!==row.signature)throw fail('مشخصات کتاب تغییر کرده است؛ دوباره بررسی کنید.');
  const previous=old?.status||'draft';
  if(old&&old.status===status&&old.source_url===link&&old.notes===notes&&old.fingerprint===row.signature){db.exec('COMMIT');return id;}
  const next=latest+1;
  db.prepare(`INSERT INTO book_fact_reviews(book_id,status,source_url,notes,fingerprint,revision,updated_by)
  VALUES(?,?,?,?,?,?,?) ON CONFLICT(book_id) DO UPDATE SET
  status=excluded.status,source_url=excluded.source_url,notes=excluded.notes,fingerprint=excluded.fingerprint,
  revision=excluded.revision,updated_by=excluded.updated_by,updated_at=CURRENT_TIMESTAMP`)
   .run(id,status,link,notes,row.signature,next,actor);
  db.prepare(`INSERT INTO book_fact_review_events(book_id,actor_id,previous_status,new_status,revision,snapshot_json)
    VALUES(?,?,?,?,?,?)`).run(id,actor,previous,status,next,JSON.stringify({status,source_url:link,notes,fingerprint:row.signature}));
  db.exec('COMMIT');return id;
 }catch(e){db.exec('ROLLBACK');throw e;}
}
function history(db,id,limit=30){return db.prepare(`SELECT h.revision,h.previous_status,h.new_status,h.created_at,u.username actor
 FROM book_fact_review_events h LEFT JOIN users u ON u.id=h.actor_id
 WHERE h.book_id=? ORDER BY h.id DESC LIMIT ?`).all(id,Math.max(1,Math.min(50,Number(limit)||30)));}
function cell(value){let s=String(value??'').replace(/[\x00-\x1f\x7f]/g,' ');if(/^[\s\uFEFF]*[=+@\-]/.test(s))s="'"+s;return '"'+s.replace(/"/g,'""')+'"';}
function csv(rows){const fields=['id','title','author','publisher','isbn','status','missing','sourced_editions','source_url','notes','revision','updated_at'];
 return '\ufeff'+[fields,...rows.map(r=>[r.id,r.title,r.author,r.publisher,r.isbns,r.status,r.missing.join('; '),r.source_editions,r.source_url,r.notes,r.revision,r.updated_at])]
 .map(r=>r.map(cell).join(',')).join('\r\n')+'\r\n';}
module.exports={migrate,source,all,select,summary,save,history,csv,STATES};
