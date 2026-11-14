'use strict';
// VARAQ 6.7: An optional, permission-documented public *text-only* sample.
// Never reveal bytes or a page of a paid/private PDF from this feature.
const crypto=require('node:crypto');
function validDate(value){if(value==='')return true;if(!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;const d=new Date(value+'T00:00:00Z');return !Number.isNaN(d.getTime())&&d.toISOString().slice(0,10)===value;}
const hash=text=>crypto.createHash('sha256').update(text,'utf8').digest('hex');
function migrate(db){db.exec(`CREATE TABLE IF NOT EXISTS book_reading_samples(
 book_id INTEGER PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
 body TEXT NOT NULL DEFAULT '', rights_holder TEXT NOT NULL DEFAULT '', rights_evidence TEXT NOT NULL DEFAULT '',
 expires_on TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published','withdrawn')),
 content_hash TEXT NOT NULL DEFAULT '', revision INTEGER NOT NULL DEFAULT 1,
 updated_by INTEGER REFERENCES users(id), updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS book_reading_sample_history(
 id INTEGER PRIMARY KEY,book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
 status TEXT NOT NULL, content_hash TEXT NOT NULL, rights_holder TEXT NOT NULL,
 rights_evidence TEXT NOT NULL, expires_on TEXT NOT NULL,
 revision INTEGER NOT NULL, user_id INTEGER REFERENCES users(id), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);`);}
function get(db,id){return db.prepare('SELECT * FROM book_reading_samples WHERE book_id=?').get(id)||null;}
function isLive(row,day=new Date().toISOString().slice(0,10)){
 return !!row&&row.status==='published'&&row.content_hash===hash(row.body)&&row.body.trim().length>=80&&row.rights_holder.trim().length>=3&&row.rights_evidence.trim().length>=12&&(!row.expires_on||row.expires_on>=day);
}
function publicSample(db,bookId,day){const row=get(db,bookId);return isLive(row,day)?row:null;}
function save(db,fields,userId){
 const bookId=Number(fields.book_id),rev=Number(fields.revision);
 if(!Number.isSafeInteger(bookId)||bookId<1||!db.prepare('SELECT id FROM books WHERE id=?').get(bookId))throw Error('کتاب انتخاب‌شده معتبر نیست.');
 const current=get(db,bookId);
 if(!Number.isSafeInteger(rev)||rev!==(current?.revision||0))throw Error('این پرونده تغییر کرده است؛ صفحه را تازه کنید.');
 const status=String(fields.status||'');if(!['draft','published','withdrawn'].includes(status))throw Error('وضعیت نمونه نامعتبر است.');
 const body=String(fields.body||'').trim(),holder=String(fields.rights_holder||'').trim(),evidence=String(fields.rights_evidence||'').trim(),until=String(fields.expires_on||'').trim();
 if(body.length>1800||holder.length>140||evidence.length>500||!validDate(until))throw Error('طول متن، مدرک یا تاریخ اعتبار نامعتبر است.');
 if(status==='published'&&(body.length<80||holder.length<3||evidence.length<12||fields.license_confirm!=='1'))throw Error('انتشار فقط با متن نمونه، مالک حقوق، سند اجازه انتشار و تأیید صریح مجاز است.');
 if(status==='published'&&until&&until<new Date().toISOString().slice(0,10))throw Error('مجوز منقضی شده را نمی‌توان منتشر کرد.');
 db.exec('BEGIN IMMEDIATE');try{
  const again=get(db,bookId);if((again?.revision||0)!==rev)throw Error('پرونده تغییر کرده است؛ دوباره بارگذاری کنید.');
  const revision=rev+1,digest=hash(body);
  db.prepare(`INSERT INTO book_reading_samples(book_id,body,rights_holder,rights_evidence,expires_on,status,content_hash,revision,updated_by)
  VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(book_id) DO UPDATE SET body=excluded.body,rights_holder=excluded.rights_holder,
  rights_evidence=excluded.rights_evidence,expires_on=excluded.expires_on,status=excluded.status,content_hash=excluded.content_hash,
  revision=excluded.revision,updated_by=excluded.updated_by,updated_at=CURRENT_TIMESTAMP`).run(bookId,body,holder,evidence,until,status,digest,revision,userId);
  db.prepare('INSERT INTO book_reading_sample_history(book_id,status,content_hash,rights_holder,rights_evidence,expires_on,revision,user_id) VALUES(?,?,?,?,?,?,?,?)').run(bookId,status,digest,holder,evidence,until,revision,userId);
  db.exec('COMMIT');return revision;
 }catch(e){db.exec('ROLLBACK');throw e;}
}
module.exports={migrate,get,isLive,publicSample,save,hash};
