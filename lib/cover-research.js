"use strict";
// Research workflow for INTERNET cover image URLs. No automatic downloads/rights grants.
// Only admins may create candidates; public covers still use approved assets/edition sources.
function validUrl(raw){
 const text=String(raw||'').trim();if(!text||text.length>1200)throw Error('لینک تصویر یا منبع نامعتبر است.');
 let url;try{url=new URL(text);}catch{throw Error('فرمت نشانی اینترنتی معتبر نیست.');}
 if(url.protocol!=='https:'||url.username||url.password||url.port&&url.port!=='443')throw Error('نشانی باید HTTPS استاندارد باشد.');
 const h=url.hostname.toLowerCase();
 if(h==='localhost'||h.endsWith('.localhost')||h.endsWith('.local')||h.endsWith('.internal')||h.endsWith('.test')||h.endsWith('.invalid')||h==='[::1]'||h==='0.0.0.0'||h==='169.254.169.254'||/^\d+(?:\.\d+){3}$/.test(h)||h.includes(':'))throw Error('دامنه خصوصی یا IP مجاز نیست.');
 return url.toString();
}
function migrate(db){db.exec(`CREATE TABLE IF NOT EXISTS online_cover_candidates(
 id INTEGER PRIMARY KEY, edition_id INTEGER NOT NULL REFERENCES editions(id) ON DELETE CASCADE,
 image_url TEXT NOT NULL, source_url TEXT NOT NULL, source_name TEXT NOT NULL,
 rights_note TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'research'
 CHECK(status IN ('research','rejected','permission_pending','ready_for_upload')),
 created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(edition_id,image_url)
 );CREATE INDEX IF NOT EXISTS idx_online_cover_candidates_edition ON online_cover_candidates(edition_id,status);`);
 const oldSchema=db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='online_cover_candidates'").get()?.sql||'';
 // SQLite cannot extend a CHECK constraint with ALTER COLUMN. Rebuild preserving candidate IDs.
 if(!oldSchema.includes("'ready_for_upload'")){
  db.exec(`BEGIN IMMEDIATE;
   CREATE TABLE online_cover_candidates_v23(
    id INTEGER PRIMARY KEY,edition_id INTEGER NOT NULL REFERENCES editions(id) ON DELETE CASCADE,
    image_url TEXT NOT NULL,source_url TEXT NOT NULL,source_name TEXT NOT NULL,
    rights_note TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'research' CHECK(status IN ('research','rejected','permission_pending','ready_for_upload')),
    created_by INTEGER REFERENCES users(id),created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    match_evidence TEXT NOT NULL DEFAULT '',rights_evidence TEXT NOT NULL DEFAULT '',reviewed_by INTEGER,reviewed_at TEXT,
    UNIQUE(edition_id,image_url)
   );
   INSERT INTO online_cover_candidates_v23(id,edition_id,image_url,source_url,source_name,rights_note,status,created_by,created_at)
   SELECT id,edition_id,image_url,source_url,source_name,rights_note,status,created_by,created_at FROM online_cover_candidates;
   DROP TABLE online_cover_candidates;
   ALTER TABLE online_cover_candidates_v23 RENAME TO online_cover_candidates;
   CREATE INDEX idx_online_cover_candidates_edition ON online_cover_candidates(edition_id,status);
   COMMIT;`);
 }
 const cols=db.prepare('PRAGMA table_info(online_cover_candidates)').all().map(x=>x.name);
 for(const [name,spec] of [["match_evidence","TEXT NOT NULL DEFAULT ''"],["rights_evidence","TEXT NOT NULL DEFAULT ''"],['reviewed_by','INTEGER'],['reviewed_at','TEXT']])if(!cols.includes(name))db.exec(`ALTER TABLE online_cover_candidates ADD COLUMN ${name} ${spec}`);
}
function list(db){return db.prepare(`SELECT e.id edition_id,e.isbn,e.publisher,e.translator,e.label,b.id book_id,b.title,
 s.cover_url current_url,s.source_url edition_source,s.rights_confirmed,
 (SELECT count(*) FROM online_cover_candidates c WHERE c.edition_id=e.id) candidate_count
 FROM editions e JOIN books b ON b.id=e.book_id LEFT JOIN edition_sources s ON s.edition_id=e.id
 WHERE e.verified=1 AND e.isbn<>'' ORDER BY b.id,e.id`).all();}
function candidates(db,editionId){return db.prepare(`SELECT id,image_url,source_url,source_name,rights_note,status,match_evidence,rights_evidence,reviewed_by,reviewed_at,created_at
 FROM online_cover_candidates WHERE edition_id=? ORDER BY id DESC`).all(editionId);}
function add(db,f,actorId){
 const id=Number(f.edition_id);if(!Number.isSafeInteger(id)||id<1||!db.prepare('SELECT id FROM editions WHERE id=? AND verified=1 AND isbn<>\'\'').get(id))throw Error('شابک چاپ معتبر نیست.');
 const image=validUrl(f.image_url),page=validUrl(f.source_url),name=String(f.source_name||'').trim().slice(0,160),note=String(f.rights_note||'').trim().slice(0,300);
 if(!name)throw Error('نام منبع لازم است.');
 if(f.status&&f.status!=='research'&&f.status!=='permission_pending')throw Error('وضعیت درخواست نامعتبر است.');
 const r=db.prepare(`INSERT INTO online_cover_candidates(edition_id,image_url,source_url,source_name,rights_note,status,created_by)
 VALUES(?,?,?,?,?,?,?) ON CONFLICT(edition_id,image_url) DO UPDATE SET source_url=excluded.source_url,source_name=excluded.source_name,rights_note=excluded.rights_note,status=excluded.status`).run(id,image,page,name,note,f.status||'research',actorId||null);
 return Number(r.lastInsertRowid||db.prepare('SELECT id FROM online_cover_candidates WHERE edition_id=? AND image_url=?').get(id,image).id);
}
function setStatus(db,rawId,status,form={},reviewer=null){
 const id=Number(rawId);if(!Number.isSafeInteger(id)||id<1||!['research','rejected','permission_pending','ready_for_upload'].includes(status))throw Error('درخواست نامعتبر است.');
 const item=db.prepare('SELECT id,status FROM online_cover_candidates WHERE id=?').get(id);if(!item)throw Error('کاندید پیدا نشد.');
 const prior=db.prepare('SELECT match_evidence,rights_evidence FROM online_cover_candidates WHERE id=?').get(id);
 const evidence=String(form.match_evidence??prior.match_evidence??'').trim().slice(0,600);
 const rights=String(form.rights_evidence??prior.rights_evidence??'').trim().slice(0,600);
 if(status==='ready_for_upload'&&(evidence.length<12||rights.length<12||form.isbn_checked!=='1'||form.rights_checked!=='1'))throw Error('برای تایید، تطبیق شابک و مستند اجازه انتشار ضروری است.');
 const stmt=db.prepare(`UPDATE online_cover_candidates SET status=?,match_evidence=?,rights_evidence=?,reviewed_by=?,reviewed_at=CURRENT_TIMESTAMP WHERE id=?`);
 stmt.run(status,evidence,rights,reviewer,id);
 return id;
}
function rightsExport(db){
 const rows=db.prepare(`SELECT b.title,e.isbn,e.publisher,c.id,c.image_url,c.source_url,c.source_name,c.status,c.match_evidence,c.rights_evidence,c.reviewed_at
 FROM online_cover_candidates c JOIN editions e ON e.id=c.edition_id JOIN books b ON b.id=e.book_id ORDER BY c.status,c.id`).all();
 const header=['title','isbn','publisher','candidate_id','image_url','source_url','source_name','status','match_evidence','rights_evidence','reviewed_at'];
 return '\ufeff'+[header.map(escapeCsv).join(','),...rows.map(r=>[r.title,r.isbn,r.publisher,r.id,r.image_url,r.source_url,r.source_name,r.status,r.match_evidence,r.rights_evidence,r.reviewed_at].map(escapeCsv).join(','))].join('\r\n')+'\r\n';
}
function auditSummary(db){const r=db.prepare(`SELECT (SELECT COUNT(*) FROM books) AS books,(SELECT COUNT(*) FROM editions e JOIN edition_sources s ON s.edition_id=e.id WHERE e.verified=1 AND s.source_url<>'') AS sourced_editions,(SELECT COUNT(DISTINCT e.book_id) FROM editions e JOIN edition_sources s ON s.edition_id=e.id WHERE e.verified=1 AND s.source_url<>'') AS books_with_sources,(SELECT COUNT(*) FROM edition_cover_assets) AS uploaded_edition_covers,(SELECT COUNT(*) FROM online_cover_candidates) AS candidates,(SELECT COUNT(*) FROM online_cover_candidates WHERE status='ready_for_upload') AS ready_candidates`).get();return r;}

function imageSearch(row){return 'https://www.google.com/search?tbm=isch&q='+encodeURIComponent(`${row.title} ${row.publisher} ${row.isbn} جلد کتاب`);}
function coversApi(row){return 'https://covers.openlibrary.org/b/isbn/'+encodeURIComponent(row.isbn)+'-M.jpg?default=false';}
function escapeCsv(v){let s=String(v??'');if(/^[\s]*[=+@-]/.test(s))s="'"+s;return '"'+s.replace(/"/g,'""')+'"';}
function csv(db){const rows=list(db);return '\uFEFF'+[['شناسه کتاب','عنوان','ناشر','مترجم','شابک','چاپ','آدرس منبع شناسنامه','جستجوی جلد اینترنتی','جلد پیشنهادی Open Library (نیازمند بررسی)','تصویر ثبت شده','تعداد پیشنهادها'].map(escapeCsv).join(','),...rows.map(x=>[x.book_id,x.title,x.publisher,x.translator,x.isbn,x.label,x.edition_source||'',imageSearch(x),coversApi(x),x.current_url||'',x.candidate_count].map(escapeCsv).join(','))].join('\r\n')+'\r\n';}
module.exports={validUrl,migrate,list,candidates,add,setStatus,imageSearch,coversApi,csv,rightsExport,auditSummary};
