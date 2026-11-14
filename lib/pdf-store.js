'use strict';
// Electronic books: licensed uploads, private vault, tenant isolation, YM approval.
// No public paid downloads or payment claims until a verified gateway/entitlement is implemented.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const rights=require('./pdf-rights');
const MAX_PDF_BYTES=20*1024*1024;
const STATES=['draft','pending','approved','rejected'];
function fail(msg){const e=new Error(msg);e.userError=true;throw e;}
function migrate(db){db.exec(`CREATE TABLE IF NOT EXISTS digital_books (
 id INTEGER PRIMARY KEY,
 store_id INTEGER NOT NULL REFERENCES stores(id),
 book_id INTEGER REFERENCES books(id),
 title TEXT NOT NULL,
 description TEXT NOT NULL DEFAULT '',
 price INTEGER NOT NULL CHECK(price>0),
 filename TEXT NOT NULL UNIQUE,
 original_name TEXT NOT NULL DEFAULT '',
 file_sha256 TEXT NOT NULL,
 file_bytes INTEGER NOT NULL,
 rights_holder TEXT NOT NULL,
 rights_basis TEXT NOT NULL,
 rights_evidence TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','pending','approved','rejected')),
 reviewer_id INTEGER REFERENCES users(id),
 review_note TEXT NOT NULL DEFAULT '',
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
 );
 CREATE INDEX IF NOT EXISTS idx_digital_books_store ON digital_books(store_id,status);
 CREATE INDEX IF NOT EXISTS idx_digital_books_book ON digital_books(book_id);
 CREATE TABLE IF NOT EXISTS digital_book_events (
 id INTEGER PRIMARY KEY, digital_id INTEGER NOT NULL REFERENCES digital_books(id),
 actor_id INTEGER REFERENCES users(id), action TEXT NOT NULL,
 note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
 );`);rights.migrate(db);}
function validatePdf(buf){
 if(!Buffer.isBuffer(buf)||buf.length<100||buf.length>MAX_PDF_BYTES)fail('فایل PDF باید حداقل ۱۰۰ بایت و حداکثر ۲۰ مگابایت باشد.');
 if(!buf.subarray(0,8).toString('latin1').startsWith('%PDF-1.')&&!buf.subarray(0,8).toString('latin1').startsWith('%PDF-2.'))fail('امضای PDF معتبر نیست.');
 const last=buf.subarray(Math.max(0,buf.length-2048)).toString('latin1');
 if(!/%%EOF(?:\s|$)/.test(last))fail('پایان ساختار PDF معتبر نیست.');
 // Static signature checks cannot guarantee safety; only privileged staff can download.
 return {sha256:crypto.createHash('sha256').update(buf).digest('hex'),size:buf.length};
}
function requireText(value,max,label,min=3){const text=String(value||'').trim();if(text.length<min||text.length>max)fail(label+' معتبر نیست.');return text;}
function id(v){const n=Number(v);return Number.isSafeInteger(n)&&n>0?n:0;}
function accessible(actor,record){return Boolean(actor&&(actor.role==='owner'||actor.role==='seller'&&actor.store_id===record.store_id&&actor.staff_permission==='manager'));}
function create(db,dir,actor,fields,buf){
 if(!actor||!(actor.role==='owner'||actor.role==='seller'&&actor.staff_permission==='manager'))fail('دسترسی مجاز نیست.');
 const storeId=actor.role==='owner'?id(fields.store_id):actor.store_id;
 if(!storeId||!db.prepare('SELECT id FROM stores WHERE id=?').get(storeId))fail('فروشگاه معتبر نیست.');
 const bookId=fields.book_id?id(fields.book_id):null;
 if(fields.book_id&&(!bookId||!db.prepare('SELECT id FROM books WHERE id=?').get(bookId)))fail('کتاب مرتبط معتبر نیست.');
 const title=requireText(fields.title,170,'عنوان کتاب');
 const description=String(fields.description||'').trim();if(description.length>1500)fail('متن معرفی بیش از حد بلند است.');
 const price=Number(fields.price);if(!Number.isSafeInteger(price)||price<1000||price>1000000000)fail('قیمت PDF باید به تومان و در بازه معتبر باشد.');
 const rightsHolder=requireText(fields.rights_holder,180,'صاحب حقوق');
 const rightsBasis=requireText(fields.rights_basis,500,'مبنای حق فروش',12);
 const rightsEvidence=requireText(fields.rights_evidence,700,'سند مجوز فروش',12);
 if(fields.licensed!=='1')fail('تأیید مسئولیت حقوق فروش فایل لازم است.');
 const expires=rights.normalizeDate(fields.rights_expires_on);
 const meta=validatePdf(buf);
 const filename=crypto.randomBytes(16).toString('hex')+'.pdf';
 fs.mkdirSync(dir,{recursive:true,mode:0o700});
 const full=path.join(dir,filename);fs.writeFileSync(full,buf,{flag:'wx',mode:0o600});
 try{
  const result=db.prepare(`INSERT INTO digital_books(store_id,book_id,title,description,price,filename,original_name,file_sha256,file_bytes,rights_holder,rights_basis,rights_evidence,rights_expires_on)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(storeId,bookId,title,description,price,filename,requireText(fields.original_name||'کتاب.pdf',180,'نام فایل',1),meta.sha256,meta.size,rightsHolder,rightsBasis,rightsEvidence,expires);
  const bookIdNew=Number(result.lastInsertRowid);
  db.prepare('INSERT INTO digital_book_events(digital_id,actor_id,action) VALUES(?,?,?)').run(bookIdNew,actor.id,'uploaded_draft');
  return bookIdNew;
 }catch(error){fs.rmSync(full,{force:true});throw error;}
}
function setStatus(db,actor,productId,status,note=''){
 if(!actor)fail('ورود ضروری است.');
 const row=db.prepare('SELECT * FROM digital_books WHERE id=?').get(id(productId));if(!row)fail('کتاب دیجیتال پیدا نشد.');
 if(!accessible(actor,row))fail('این فایل متعلق به فروشگاه دیگری است.');
 if(!STATES.includes(status))fail('وضعیت معتبر نیست.');
 if(actor.role==='seller' && status!=='pending')fail('فقط مدیریت YM می‌تواند انتشار را تأیید یا رد کند.');
 if(actor.role==='seller'&&!['draft','rejected'].includes(row.status))fail('این پرونده در مرحله فعلی قابل ارسال نیست.');
 if(actor.role==='owner'&&status==='approved'&&row.status!=='pending')fail('تأیید فقط از صف بررسی مجاز است.');
 if(actor.role==='owner'&&status==='pending'&&!['draft','rejected'].includes(row.status))fail('پرونده از این وضعیت قابل ارسال برای بررسی نیست.');
 if(actor.role==='owner'&&status==='approved'&&(!row.rights_evidence||!row.rights_basis))fail('مدرک اجازه فروش کامل نیست.');
 if(status==='approved'&&(row.distribution_hold||(row.rights_expires_on&&row.rights_expires_on<rights.todayTehran())))fail('فایل متوقف است یا مجوز فروش آن منقضی شده است.');
 const reviewNote=String(note||'').trim().slice(0,500);
 if(status==='rejected'&&reviewNote.length<5)fail('دلیل رد باید ثبت شود.');
 db.exec('BEGIN IMMEDIATE');
 try{
  db.prepare('UPDATE digital_books SET status=?,reviewer_id=?,review_note=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(status,actor.role==='owner'?actor.id:null,reviewNote,row.id);
  db.prepare('INSERT INTO digital_book_events(digital_id,actor_id,action,note) VALUES(?,?,?,?)').run(row.id,actor.id,'status_'+status,reviewNote);
  db.exec('COMMIT');
 }catch(e){db.exec('ROLLBACK');throw e;}
 return row.id;
}
function rows(db,actor,filter='all'){
 if(!actor)return [];
 const list=actor.role==='owner'?db.prepare('SELECT d.*,s.name store_name FROM digital_books d JOIN stores s ON s.id=d.store_id ORDER BY d.id DESC LIMIT 250').all():db.prepare('SELECT d.*,s.name store_name FROM digital_books d JOIN stores s ON s.id=d.store_id WHERE d.store_id=? ORDER BY d.id DESC LIMIT 250').all(actor.store_id);
 return list.filter(r=>filter==='all'||r.status===filter);
}
function publicRows(db,opts=''){
 // Legacy call compatibility for related physical-book cards.
 if(typeof opts==='string')opts={q:opts};
 const q=String(opts.q||'').trim().slice(0,80);
 const storeId=Number(opts.store)||0;
 const stores=Number.isSafeInteger(storeId)&&storeId>0?storeId:0;
 const sorts={latest:'d.id DESC',title:'d.title COLLATE NOCASE ASC',price_asc:'d.price ASC, d.id DESC',price_desc:'d.price DESC, d.id DESC'};
 const order=sorts[opts.sort]||sorts.latest;
 return db.prepare(`SELECT d.id,d.book_id,d.title,d.description,d.price,d.file_bytes,s.name store_name,s.id store_id,b.slug book_slug,b.author
 FROM digital_books d JOIN stores s ON s.id=d.store_id LEFT JOIN books b ON b.id=d.book_id
 WHERE d.status='approved' AND s.active=1 AND d.distribution_hold=0 AND (d.rights_expires_on='' OR d.rights_expires_on>=?) AND (?=0 OR s.id=?)
 AND (instr(d.title, ?) > 0 OR instr(d.description, ?) > 0)
 ORDER BY ${order} LIMIT 100`).all(rights.todayTehran(),stores,stores,q,q);
}
function publicBook(db,productId){
 return db.prepare(`SELECT d.id,d.book_id,d.title,d.description,d.price,d.file_bytes,d.created_at,s.name store_name,s.id store_id,b.slug book_slug,b.author
 FROM digital_books d JOIN stores s ON s.id=d.store_id LEFT JOIN books b ON b.id=d.book_id
 WHERE d.id=? AND d.status='approved' AND d.distribution_hold=0 AND (d.rights_expires_on='' OR d.rights_expires_on>=?) AND s.active=1`).get(id(productId),rights.todayTehran())||null;
}
function privateDownload(db,dir,actor,productId){
 const row=db.prepare('SELECT * FROM digital_books WHERE id=?').get(id(productId));
 if(!row||!accessible(actor,row))return null;
 if(!/^[0-9a-f]{32}\.pdf$/.test(row.filename))return null;
 const full=path.join(dir,row.filename);
 if(!fs.existsSync(full)||!fs.statSync(full).isFile()||fs.statSync(full).size!==row.file_bytes)return null;
 if(crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')!==row.file_sha256)return null;
 return {full,row};
}
module.exports={migrate,validatePdf,create,setStatus,rows,publicRows,publicBook,privateDownload,accessible,MAX_PDF_BYTES};
