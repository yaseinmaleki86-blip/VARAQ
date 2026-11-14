'use strict';
// Human review is recorded per exact draft revision; this is NOT an automatic
// factual verification service and does not change book content or seller data.
const crypto = require('node:crypto');
const workflow = require('./catalog-workflow');
function migrate(db){
 db.exec(`CREATE TABLE IF NOT EXISTS editorial_qa_checks(
   draft_id INTEGER PRIMARY KEY REFERENCES catalog_metadata_drafts(id) ON DELETE CASCADE,
   draft_sha256 TEXT NOT NULL,
   author_checked INTEGER NOT NULL CHECK(author_checked IN(0,1)),
   synopsis_checked INTEGER NOT NULL CHECK(synopsis_checked IN(0,1)),
   source_url TEXT NOT NULL DEFAULT '',
   review_note TEXT NOT NULL DEFAULT '',
   reviewer_id INTEGER NOT NULL REFERENCES users(id),
   checked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
 );
 CREATE INDEX IF NOT EXISTS idx_editorial_qa_checked_at ON editorial_qa_checks(checked_at);`);
}
function fingerprint(d){return crypto.createHash('sha256').update(JSON.stringify([
  d.id,d.book_id,d.author,d.description,d.source_url,d.source_note,d.submitted_at,d.status
 ])).digest('hex');}
function pending(db,id){
 const n=Number(id);if(!Number.isSafeInteger(n)||n<1)throw Error('شناسه پیش‌نویس نامعتبر است.');
 const d=db.prepare("SELECT d.*,b.title,b.author AS book_author,b.description AS book_description FROM catalog_metadata_drafts d JOIN books b ON b.id=d.book_id WHERE d.id=? AND d.status='pending'").get(n);
 if(!d)throw Error('پیش‌نویس در انتظار بررسی پیدا نشد.');return d;
}
function clean(v,max){const s=String(v??'').normalize('NFC').trim();if(s.length>max)throw Error('متن بیشتر از حد مجاز است.');return s;}
function verify(db,input,userId){
 const user=Number(userId);if(!Number.isSafeInteger(user)||user<1)throw Error('شناسه مدیر نامعتبر است.');
 const d=pending(db,input.draft_id);
 if(input.author_checked!=='1'||input.synopsis_checked!=='1')throw Error('تطبیق نویسنده و معرفی باید هر دو به‌صورت آگاهانه تأیید شوند.');
 if(!d.author&&!d.description)throw Error('پیشنهاد فاقد محتواست.');
 if(!d.author&&!d.book_author)throw Error('برای تأیید، نام نویسنده یا پدیدآورنده باید در شناسنامه اثر مشخص شود.');
 const source=clean(input.source_url,500),note=clean(input.review_note,600);
 if(!source&&!note)throw Error('برای تأیید بررسی، منبع مستقل یا یادداشت بررسی لازم است.');
 if(note&&note.length<20)throw Error('یادداشت بررسی باید حداقل ۲۰ نویسه داشته باشد.');
 if(source){let u;try{u=new URL(source);}catch{throw Error('آدرس منبع معتبر نیست.');}
   if(u.protocol!=='https:'||!u.hostname||u.username||u.password)throw Error('منبع باید آدرس HTTPS معتبر و بدون اطلاعات ورود باشد.');}
 const hash=fingerprint(d);
 db.prepare(`INSERT INTO editorial_qa_checks(draft_id,draft_sha256,author_checked,synopsis_checked,source_url,review_note,reviewer_id,checked_at)
 VALUES(?, ?,1,1,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(draft_id) DO UPDATE SET
 draft_sha256=excluded.draft_sha256,author_checked=1,synopsis_checked=1,
 source_url=excluded.source_url,review_note=excluded.review_note,
 reviewer_id=excluded.reviewer_id,checked_at=CURRENT_TIMESTAMP`).run(d.id,hash,source,note,user);
 return d.id;
}
function status(db,id){const d=pending(db,id);const q=db.prepare('SELECT * FROM editorial_qa_checks WHERE draft_id=?').get(d.id);
 return {draft:d,record:q||null,valid:Boolean(q&&q.draft_sha256===fingerprint(d)&&q.author_checked&&q.synopsis_checked)};
}
function publishReviewed(db,draftId,userId){
 const s=status(db,draftId);if(!s.valid)throw Error('ابتدا بررسی مستند همین نسخه از پیش‌نویس را ثبت کنید.');
 return workflow.moderate(db,draftId,'approve',userId);
}
function counts(db){
 const drafts=db.prepare("SELECT d.id,d.book_id,d.status,d.author,d.description,d.source_url,d.source_note,d.submitted_at,b.title,b.author AS book_author,b.description AS book_description,q.draft_sha256,q.checked_at FROM catalog_metadata_drafts d JOIN books b ON b.id=d.book_id LEFT JOIN editorial_qa_checks q ON q.draft_id=d.id ORDER BY CASE d.status WHEN 'pending' THEN 0 WHEN 'rejected' THEN 1 ELSE 2 END,d.id").all();
 const rows=drafts.map(d=>({ ...d, reviewed:Boolean(d.draft_sha256&&d.draft_sha256===fingerprint(d)), needs_author:!d.author&&!d.book_author, needs_description:!d.description&&!d.book_description, missing_independent_source:!d.source_url, ambiguous:!d.author&&!d.book_author }));
 return {rows,stats:{total:rows.length,pending:rows.filter(x=>x.status==='pending').length,
    ready:rows.filter(x=>x.status==='pending'&&x.reviewed).length,
    unreviewed:rows.filter(x=>x.status==='pending'&&!x.reviewed).length,
    published:rows.filter(x=>x.status==='approved').length,
    missingSource:rows.filter(x=>x.status==='pending'&&x.missing_independent_source).length,
    ambiguous:rows.filter(x=>x.status==='pending'&&x.ambiguous).length }};
}
function csv(rows){
 const val=x=>{let s=String(x??'');if(/^[\s\uFEFF]*[=+@\-\t\r]/.test(s))s="'"+s;return '"'+s.replace(/"/g,'""')+'"';};
 return '\uFEFF'+[['draft_id','book_id','title','status','review_current','missing_author','missing_independent_source'].map(val).join(','),
  ...rows.map(r=>[r.id,r.book_id,r.title,r.status,r.reviewed?'yes':'no',r.needs_author?'yes':'no',r.missing_independent_source?'yes':'no'].map(val).join(','))].join('\r\n')+'\r\n';
}
module.exports={migrate,fingerprint,verify,status,publishReviewed,counts,csv};
