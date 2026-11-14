'use strict';
// Internal correspondence workflow. A reported grant NEVER authorizes publication.
// Public cover availability is controlled separately by the existing cover pipeline.
const statuses = new Set(['not_requested','requested','granted','denied']);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
function validDate(value){
  if(!ISO_DATE.test(value))return false;
  const [year,month,day] = value.split('-').map(Number);
  const d = new Date(Date.UTC(year,month-1,day));
  return d.getUTCFullYear()===year&&d.getUTCMonth()===month-1&&d.getUTCDate()===day;
}
function todayTehran(){
  const parts=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Tehran',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());
  const find=t=>parts.find(x=>x.type===t).value;
  return `${find('year')}-${find('month')}-${find('day')}`;
}
function addDays(iso,days){const d=new Date(iso+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+days);return d.toISOString().slice(0,10);}
function migrate(db){
  db.exec(`CREATE TABLE IF NOT EXISTS edition_rights_requests(
    edition_id INTEGER PRIMARY KEY REFERENCES editions(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'not_requested' CHECK(status IN ('not_requested','requested','granted','denied')),
    contact_name TEXT NOT NULL DEFAULT '',contact_date TEXT NOT NULL DEFAULT '',
    evidence_ref TEXT NOT NULL DEFAULT '',notes TEXT NOT NULL DEFAULT '',
    updated_by INTEGER REFERENCES users(id),updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );`);
  const existing=new Set(db.prepare('PRAGMA table_info(edition_rights_requests)').all().map(c=>c.name));
  if(!existing.has('next_followup_date'))db.exec("ALTER TABLE edition_rights_requests ADD COLUMN next_followup_date TEXT NOT NULL DEFAULT ''");
  if(!existing.has('revision'))db.exec('ALTER TABLE edition_rights_requests ADD COLUMN revision INTEGER NOT NULL DEFAULT 0');
  db.exec(`CREATE TABLE IF NOT EXISTS edition_rights_request_events(
    id INTEGER PRIMARY KEY,
    edition_id INTEGER NOT NULL REFERENCES editions(id) ON DELETE CASCADE,
    actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    previous_status TEXT NOT NULL,
    new_status TEXT NOT NULL,
    snapshot_json TEXT NOT NULL,
    revision INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(edition_id,revision)
  );
  CREATE INDEX IF NOT EXISTS idx_rights_due ON edition_rights_requests(status,next_followup_date);
  CREATE INDEX IF NOT EXISTS idx_rights_events_edition ON edition_rights_request_events(edition_id,id DESC);`);
}
function rows(db){return db.prepare(`SELECT e.id edition_id,e.book_id,b.title,e.publisher,e.isbn,
 COALESCE(r.status,'not_requested') request_status,COALESCE(r.contact_name,'') contact_name,
 COALESCE(r.contact_date,'') contact_date,COALESCE(r.evidence_ref,'') evidence_ref,
 COALESCE(r.notes,'') notes,COALESCE(r.next_followup_date,'') next_followup_date,
 COALESCE(r.revision,0) revision,
 CASE WHEN ca.filename IS NOT NULL OR (es.cover_matched=1 AND es.rights_confirmed=1 AND es.cover_url<>'') THEN 1 ELSE 0 END has_public_cover
 FROM editions e JOIN books b ON b.id=e.book_id
 LEFT JOIN edition_sources es ON es.edition_id=e.id
 LEFT JOIN edition_cover_assets ca ON ca.edition_id=e.id
 LEFT JOIN edition_rights_requests r ON r.edition_id=e.id
 WHERE e.verified=1 AND e.isbn<>'' ORDER BY
 CASE WHEN ca.filename IS NULL AND NOT(es.cover_matched=1 AND es.rights_confirmed=1 AND es.cover_url<>'') THEN 0 ELSE 1 END,
 b.id,e.id`).all();}
function followupState(row,today=todayTehran()){
  if(row.request_status!=='requested')return 'not_applicable';
  const date=row.next_followup_date;
  if(!date)return 'unscheduled';
  if(date<today)return 'overdue';
  if(date===today)return 'today';
  if(date<=addDays(today,7))return 'next7';
  return 'later';
}
function stats(items,today=todayTehran()){
  const result={total:items.length,not_requested:0,requested:0,granted:0,denied:0,public_covers:0,overdue:0,today:0,next7:0,unscheduled:0};
  for(const row of items){result[row.request_status]++;if(row.has_public_cover)result.public_covers++;
    const f=followupState(row,today);if(Object.hasOwn(result,f))result[f]++;
  }return result;
}
function err(message){const e=Error(message);e.userError=true;return e;}
function history(db,editionId,limit=30){return db.prepare(`SELECT h.id,h.edition_id,h.actor_id,h.previous_status,h.new_status,h.snapshot_json,h.revision,h.created_at,u.username actor_name
 FROM edition_rights_request_events h LEFT JOIN users u ON u.id=h.actor_id WHERE h.edition_id=? ORDER BY h.id DESC LIMIT ?`).all(editionId,Math.max(1,Math.min(100,limit)));}
function save(db,form,actor){
 const id=Number(form.edition_id),status=String(form.status||'');
 if(!Number.isSafeInteger(id)||id<1||!statuses.has(status))throw err('چاپ یا وضعیت درخواست معتبر نیست.');
 if(!db.prepare("SELECT id FROM editions WHERE id=? AND verified=1 AND isbn<>''").get(id))throw err('این چاپ معتبر نیست.');
 const contact=String(form.contact_name||'').trim().slice(0,180);
 const date=String(form.contact_date||'').trim();
 const ref=String(form.evidence_ref||'').trim().slice(0,300);
 const notes=String(form.notes||'').trim().slice(0,400);
 let next=String(form.next_followup_date||'').trim();
 if(date&&!validDate(date))throw err('تاریخ مکاتبه معتبر نیست.');
 if(status!=='not_requested'&&(!contact||!date))throw err('برای پیگیری، نام صاحب حقوق و تاریخ مکاتبه الزامی است.');
 if(status==='granted'&&ref.length<8)throw err('برای ثبت اجازه دریافت‌شده، مرجع کتبی یا شناسه سند الزامی است؛ این ثبت باعث انتشار خودکار نمی‌شود.');
 if(next&&!validDate(next))throw err('موعد پیگیری معتبر نیست.');
 if(status!=='requested'&&next)throw err('موعد پیگیری فقط در وضعیت «درخواست شده» قابل ثبت است.');
 if(next&&date&&next<date)throw err('موعد پیگیری نمی‌تواند زودتر از تاریخ مکاتبه باشد.');
 if(status!=='requested')next='';
 db.exec('BEGIN IMMEDIATE');
 try{
   const old=db.prepare('SELECT * FROM edition_rights_requests WHERE edition_id=?').get(id);
   const revision=old?.revision||0;
   if(form.revision!==undefined&&form.revision!==''&&String(revision)!==String(form.revision))throw err('این پرونده توسط فرد دیگری تغییر کرده است. صفحه را بازخوانی کنید تا تغییرات جدید را ببینید.');
   const snapshot={status,contact_name:contact,contact_date:date,evidence_ref:ref,notes,next_followup_date:next};
   // No-op saves are idempotent and do not spam the immutable correspondence log.
   if(old&&Object.entries(snapshot).every(([key,value])=>old[key]===value)){
     db.exec('COMMIT');return id;
   }
   const nextRevision=revision+1;
   db.prepare(`INSERT INTO edition_rights_requests(edition_id,status,contact_name,contact_date,evidence_ref,notes,next_followup_date,revision,updated_by)
    VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(edition_id) DO UPDATE SET status=excluded.status,contact_name=excluded.contact_name,
    contact_date=excluded.contact_date,evidence_ref=excluded.evidence_ref,notes=excluded.notes,next_followup_date=excluded.next_followup_date,
    revision=excluded.revision,updated_by=excluded.updated_by,updated_at=CURRENT_TIMESTAMP`)
    .run(id,status,contact,date,ref,notes,next,nextRevision,actor||null);
   db.prepare(`INSERT INTO edition_rights_request_events(edition_id,actor_id,previous_status,new_status,snapshot_json,revision)
    VALUES(?,?,?,?,?,?)`).run(id,actor||null,old?.status||'not_requested',status,JSON.stringify(snapshot),nextRevision);
   db.exec('COMMIT');return id;
 }catch(e){db.exec('ROLLBACK');throw e;}
}
function csvCell(x){let v=String(x??'');if(/^[\s]*[=+@-]/.test(v))v="'"+v;return '"'+v.replace(/"/g,'""')+'"';}
function csv(db){const keys=['title','publisher','isbn','request_status','contact_name','contact_date','next_followup_date','followup_state','evidence_ref','notes','revision','has_public_cover'];const day=todayTehran();return '\uFEFF'+[keys.map(csvCell).join(','),...rows(db).map(x=>keys.map(k=>csvCell(k==='followup_state'?followupState(x,day):x[k])).join(','))].join('\r\n')+'\r\n';}
module.exports={migrate,rows,stats,save,csv,history,followupState,todayTehran,validDate};
