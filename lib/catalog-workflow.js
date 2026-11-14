'use strict';
// v1.3: Metadata contribution is never auto-published. ISBN and publisher of an edition
// remain managed by the existing editions workflow. No external fetch or API calls.
const FIELDS=['book_id','author','description','source_url','source_note'];
function migrate(db){db.exec(`CREATE TABLE IF NOT EXISTS catalog_metadata_drafts(
 id INTEGER PRIMARY KEY, book_id INTEGER NOT NULL UNIQUE REFERENCES books(id) ON DELETE CASCADE,
 author TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '',
 source_url TEXT NOT NULL DEFAULT '', source_note TEXT NOT NULL DEFAULT '',
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
 submitted_by INTEGER REFERENCES users(id), reviewed_by INTEGER REFERENCES users(id),
 submitted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, reviewed_at TEXT,
 rejection_note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_catalog_drafts_status ON catalog_metadata_drafts(status,submitted_at);`);}
function clean(v,max){const s=String(v??'').trim().normalize('NFC');if(s.length>max)throw Error('متن از حداکثر طول مجاز بیشتر است.');return s;}
function checked(data){const bookId=Number(data.book_id);if(!Number.isSafeInteger(bookId)||bookId<1)throw Error('شناسه کتاب نامعتبر است.');
 const author=clean(data.author,180),description=clean(data.description,2500),sourceUrl=clean(data.source_url,500),sourceNote=clean(data.source_note,240);
 if(!author&&!description)throw Error('حداقل نویسنده یا معرفی کتاب را وارد کنید.');
 if(author&&author.length<3)throw Error('نام نویسنده خیلی کوتاه است.');
 if(description&&description.length<50)throw Error('توضیح کتاب برای انتشار باید حداقل ۵۰ کاراکتر باشد.');
 if(!sourceUrl&&!sourceNote)throw Error('منبع اطلاعات یا یادداشت روش اعتبارسنجی را وارد کنید.');
 if(sourceUrl){let u;try{u=new URL(sourceUrl);}catch{throw Error('نشانی منبع معتبر نیست.');}if(u.protocol!=='https:'||!u.hostname||u.username||u.password)throw Error('نشانی منبع باید HTTPS و بدون نام کاربری یا رمز باشد.');}
 return {bookId,author,description,sourceUrl,sourceNote};}
function validateAgainstBook(db,form){const b=db.prepare('SELECT * FROM books WHERE id=?').get(form.bookId);if(!b)throw Error('کتاب با شناسه ارائه‌شده وجود ندارد.');
 if(form.author&&b.author.trim()&&b.author.trim()!==form.author)throw Error('نویسنده از قبل ثبت شده؛ برای اصلاح اطلاعات موجود از ویرایش تکی استفاده کنید.');
 if(form.description&&b.description.trim()&&b.description.trim()!==form.description)throw Error('توضیح از قبل ثبت شده؛ بازنویسی خودکار ممنوع است.');
 if((!form.author||!!b.author.trim())&&(!form.description||!!b.description.trim()))throw Error('هیچ فیلد خالی تازه‌ای برای تکمیل وجود ندارد.');return b;}
function upsertDraft(db,input,userId){const data=checked(input);validateAgainstBook(db,data);
 db.prepare(`INSERT INTO catalog_metadata_drafts(book_id,author,description,source_url,source_note,status,submitted_by,submitted_at,reviewed_by,reviewed_at,rejection_note)
 VALUES(?,?,?,?,?,'pending',?,CURRENT_TIMESTAMP,NULL,NULL,'') ON CONFLICT(book_id) DO UPDATE SET
 author=excluded.author,description=excluded.description,source_url=excluded.source_url,source_note=excluded.source_note,
 status='pending',submitted_by=excluded.submitted_by,submitted_at=CURRENT_TIMESTAMP,reviewed_by=NULL,reviewed_at=NULL,rejection_note=''`).run(data.bookId,data.author,data.description,data.sourceUrl,data.sourceNote,userId);
 return data.bookId;}
function moderate(db,id,action,userId,reason=''){
 const draftId=Number(id);if(!Number.isSafeInteger(draftId)||draftId<1||!['approve','reject'].includes(action))throw Error('درخواست نامعتبر است.');
 const note=clean(reason,240);
 if(action==='reject'&&!note)throw Error('دلیل رد را وارد کنید.');
 db.exec('BEGIN IMMEDIATE');try{
  const d=db.prepare("SELECT * FROM catalog_metadata_drafts WHERE id=? AND status='pending'").get(draftId);
  if(!d)throw Error('پیشنهاد در صف بررسی یافت نشد.');
  if(action==='approve'){
   const b=validateAgainstBook(db,{bookId:d.book_id,author:d.author,description:d.description});
   db.prepare('UPDATE books SET author=?,description=? WHERE id=?').run(b.author.trim()||d.author,b.description.trim()||d.description,b.id);
  }
  db.prepare(`UPDATE catalog_metadata_drafts SET status=?,reviewed_by=?,reviewed_at=CURRENT_TIMESTAMP,rejection_note=? WHERE id=?`).run(action==='approve'?'approved':'rejected',userId,action==='reject'?note:'',draftId);
  db.exec('COMMIT');return d.book_id;
 }catch(e){db.exec('ROLLBACK');throw e;}
}
function quality(db){const row=db.prepare(`SELECT COUNT(*) AS total,
 SUM(CASE WHEN TRIM(author)='' THEN 1 ELSE 0 END) AS no_author,
 SUM(CASE WHEN TRIM(description)='' THEN 1 ELSE 0 END) AS no_description,
 SUM(CASE WHEN NOT EXISTS(SELECT 1 FROM book_covers c WHERE c.book_id=books.id) AND NOT EXISTS(SELECT 1 FROM editions e JOIN edition_sources s ON s.edition_id=e.id WHERE e.book_id=books.id AND e.verified=1 AND s.cover_matched=1 AND s.cover_url<>'') THEN 1 ELSE 0 END) AS no_cover,
 SUM(CASE WHEN NOT EXISTS(SELECT 1 FROM editions e WHERE e.book_id=books.id AND e.verified=1) THEN 1 ELSE 0 END) AS no_edition FROM books`).get();
 const pending=db.prepare("SELECT COUNT(*) n FROM catalog_metadata_drafts WHERE status='pending'").get().n;
 return {total:row.total,noAuthor:row.no_author||0,noDescription:row.no_description||0,noCover:row.no_cover||0,noEdition:row.no_edition||0,pending};}
function issues(db,filter='all',q='',page=1){const allowed=['all','author','description','cover','edition'];if(!allowed.includes(filter))filter='all';
 const cond={all:'1=1',author:"TRIM(b.author)=''",description:"TRIM(b.description)=''",cover:'c.book_id IS NULL AND rc.book_id IS NULL',edition:'e.book_id IS NULL'}[filter];
 const pattern='%'+String(q).slice(0,80)+'%';
 const base=`FROM books b LEFT JOIN book_covers c ON c.book_id=b.id LEFT JOIN (SELECT DISTINCT e.book_id FROM editions e JOIN edition_sources s ON s.edition_id=e.id WHERE e.verified=1 AND s.cover_matched=1 AND s.cover_url<>'') rc ON rc.book_id=b.id LEFT JOIN (SELECT DISTINCT book_id FROM editions WHERE verified=1) e ON e.book_id=b.id LEFT JOIN catalog_metadata_drafts d ON d.book_id=b.id WHERE ${cond} AND (b.title LIKE ? OR b.author LIKE ? OR CAST(b.id AS TEXT)=?)`;
 const total=db.prepare('SELECT COUNT(*) n '+base).get(pattern,pattern,String(q)).n;
 const n=Math.max(1,Math.min(500,Math.floor(Number(page)||1)));const rows=db.prepare(`SELECT b.id,b.slug,b.title,b.author,b.description,b.publisher,b.category,CASE WHEN c.book_id IS NULL AND rc.book_id IS NULL THEN 0 ELSE 1 END has_cover,CASE WHEN e.book_id IS NULL THEN 0 ELSE 1 END has_edition,d.status draft_status ${base} ORDER BY (TRIM(b.author)='') DESC,(TRIM(b.description)='') DESC,b.id LIMIT 30 OFFSET ?`).all(pattern,pattern,String(q),(n-1)*30);
 return {total,rows,page:n,pages:Math.max(1,Math.ceil(total/30))};}
function escapeCSV(x){let s=String(x??'');if(/^[\s\uFEFF]*[=+@\-\t\r]/.test(s))s="'"+s;return '"'+s.replace(/"/g,'""')+'"';}
function exportTemplate(db){const rows=db.prepare(`SELECT b.id,b.title,b.author,b.description FROM books b WHERE TRIM(b.author)='' OR TRIM(b.description)='' ORDER BY b.id`).all();
 return '\uFEFFbook_id,title,author,description,source_url,source_note\r\n'+rows.map(r=>[r.id,r.title,r.author,r.description,'',''].map(escapeCSV).join(',')).join('\r\n')+'\r\n';}
function csvRows(s){s=String(s??'').replace(/^\uFEFF/,'');if(Buffer.byteLength(s,'utf8')>180000)throw Error('فایل CSV بیش از حد بزرگ است.');
 let rows=[],row=[],v='',quoted=false;for(let i=0;i<s.length;i++){const c=s[i];if(c==='"'){if(quoted&&s[i+1]==='"'){v+='"';i++;}else if(quoted){quoted=false;}else if(v===''){quoted=true;}else throw Error('علامت نقل قول CSV نامعتبر است.');}
 else if(c===','&&!quoted){row.push(v);v='';}else if((c==='\n'||c==='\r')&&!quoted){if(c==='\r'&&s[i+1]==='\n')i++;row.push(v);if(row.some(x=>x.trim()))rows.push(row);row=[];v='';}else{v+=c;}
 if(rows.length>105)throw Error('حداکثر ۱۰۰ ردیف قابل واردکردن است.');}
 if(quoted)throw Error('CSV دارای نقل‌قول بسته‌نشده است.');row.push(v);if(row.some(x=>x.trim()))rows.push(row);
 if(!rows.length)throw Error('CSV خالی است.');const header=rows.shift().map(v=>v.trim().toLowerCase());for(const f of FIELDS)if(!header.includes(f))throw Error('ستون ضروری وجود ندارد: '+f);
 if(rows.length>100)throw Error('حداکثر ۱۰۰ ردیف مجاز است.');
 const entries=rows.map((r,i)=>{if(r.length!==header.length)throw Error('تعداد ستون‌های سطر '+(i+2)+' صحیح نیست.');return Object.fromEntries(FIELDS.map(k=>[k,r[header.indexOf(k)]]));});
 const seen=new Set();for(const r of entries){const id=Number(r.book_id);if(seen.has(id))throw Error('شناسه تکراری در CSV: '+id);seen.add(id);}return entries;}
function batch(db,csv,userId){const entries=csvRows(csv);if(!entries.length)throw Error('CSV ردیفی ندارد.');const validated=entries.map(e=>{const x=checked(e);validateAgainstBook(db,x);return x;});
 db.exec('BEGIN IMMEDIATE');try{for(const x of validated)upsertDraft(db,{book_id:x.bookId,author:x.author,description:x.description,source_url:x.sourceUrl,source_note:x.sourceNote},userId);db.exec('COMMIT');return validated.length;}catch(e){db.exec('ROLLBACK');throw e;}}
module.exports={migrate,checked,upsertDraft,moderate,quality,issues,exportTemplate,csvRows,batch};
