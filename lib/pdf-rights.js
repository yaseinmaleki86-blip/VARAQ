'use strict';
// PDF distribution rights lifecycle. Holding or expiration blocks public discovery AND all entitlements.
const {todayTehran}=require('./cover-rights');
const DATE=/^\d{4}-\d{2}-\d{2}$/;
function fail(message){const e=new Error(message);e.userError=true;throw e;}
function validDate(value){
 if(!DATE.test(value))return false;
 const [y,m,d]=value.split('-').map(Number),actual=new Date(Date.UTC(y,m-1,d));
 return actual.getUTCFullYear()===y&&actual.getUTCMonth()+1===m&&actual.getUTCDate()===d;
}
function normalizeDate(raw){const value=String(raw??'').trim();if(value&&!validDate(value))fail('تاریخ پایان اجازه فروش باید به شکل YYYY-MM-DD و معتبر باشد.');return value;}
function migrate(db){
 const names=new Set(db.prepare('PRAGMA table_info(digital_books)').all().map(x=>x.name));
 for(const [key,def] of [['rights_expires_on',"TEXT NOT NULL DEFAULT ''"],['distribution_hold','INTEGER NOT NULL DEFAULT 0'],['rights_revision','INTEGER NOT NULL DEFAULT 0'],['hold_reason',"TEXT NOT NULL DEFAULT ''"]]){
  if(!names.has(key))db.exec(`ALTER TABLE digital_books ADD COLUMN ${key} ${def}`);
 }
 db.exec('CREATE INDEX IF NOT EXISTS idx_digital_books_rights ON digital_books(status,distribution_hold,rights_expires_on)');
}
function active(row,date=todayTehran()){return Boolean(row&&row.status==='approved'&&Number(row.distribution_hold)===0&&(!row.rights_expires_on||row.rights_expires_on>=date));}
function report(db,actor,date=todayTehran()){
 if(!actor||!['owner','seller'].includes(actor.role))return [];
 if(actor.role==='seller'&&actor.staff_permission!=='manager')return [];
 const rows=actor.role==='owner'?db.prepare('SELECT d.*,s.name store_name FROM digital_books d JOIN stores s ON s.id=d.store_id ORDER BY d.id DESC').all():db.prepare('SELECT d.*,s.name store_name FROM digital_books d JOIN stores s ON s.id=d.store_id WHERE d.store_id=? ORDER BY d.id DESC').all(actor.store_id);
 const limit=new Date(date+'T00:00:00Z');limit.setUTCDate(limit.getUTCDate()+30);const until=limit.toISOString().slice(0,10);
 return rows.map(row=>({...row,rights_state:row.distribution_hold?'held':row.rights_expires_on&&row.rights_expires_on<date?'expired':row.rights_expires_on&&row.rights_expires_on<=until?'expiring':'current',public_enabled:active(row,date)}));
}
function change(db,actor,opts,date=todayTehran()){
 if(actor?.role!=='owner')fail('تغییر وضعیت مجوز فقط در اختیار مدیر مرکزی YM است.');
 const id=Number(opts.id),expected=Number(opts.revision),action=String(opts.action||'');
 if(!Number.isSafeInteger(id)||id<1||!Number.isSafeInteger(expected)||expected<0)fail('شناسه یا نسخه پرونده نامعتبر است.');
 if(!['hold','resume','renew'].includes(action))fail('نوع اقدام ناشناخته است.');
 const note=String(opts.note||'').trim();if(note.length<8||note.length>500)fail('دلیل و سند تصمیم باید بین ۸ تا ۵۰۰ نویسه باشد.');
 const expiry=action==='renew'?normalizeDate(opts.expires_on):null;
 const evidence=String(opts.evidence||'').trim();if(action==='renew'&&(evidence.length<12||evidence.length>700))fail('برای تمدید مجوز، مرجع معتبر قرارداد یا سند جدید لازم است.');
 db.exec('BEGIN IMMEDIATE');try{
  const row=db.prepare('SELECT * FROM digital_books WHERE id=?').get(id);
  if(!row)fail('فایل دیجیتال پیدا نشد.');
  if(row.rights_revision!==expected)fail('این پرونده در صفحه دیگری تغییر کرده است؛ اطلاعات را دوباره دریافت کنید.');
  if(action==='resume'&&row.rights_expires_on&&row.rights_expires_on<date)fail('مجوز منقضی شده است؛ ابتدا مدرک تمدید مجوز ثبت شود.');
  if(action==='renew'&&expiry&&expiry<date)fail('تاریخ پایان مجوز نمی‌تواند در گذشته باشد.');
  if(action==='hold'&&row.distribution_hold)fail('این فایل از قبل متوقف است.');
  if(action==='resume'&&!row.distribution_hold)fail('این فایل متوقف نیست.');
  const newHold=action==='hold'?1:action==='resume'?0:row.distribution_hold;
  const newExpiry=action==='renew'?expiry:row.rights_expires_on;
  const newEvidence=action==='renew'?evidence:row.rights_evidence;
  const result=db.prepare('UPDATE digital_books SET distribution_hold=?,rights_expires_on=?,rights_evidence=?,rights_revision=rights_revision+1,hold_reason=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND rights_revision=?').run(newHold,newExpiry,newEvidence,action==='hold'?note:action==='resume'?'':row.hold_reason,id,expected);
  if(result.changes!==1)fail('تغییر هم‌زمان؛ دوباره تلاش کنید.');
  db.prepare('INSERT INTO digital_book_events(digital_id,actor_id,action,note) VALUES(?,?,?,?)').run(id,actor.id,'rights_'+action,note+(action==='renew'?' | expires='+expiry+' | evidence='+evidence:''));
  db.exec('COMMIT');return expected+1;
 }catch(err){if(db.isTransaction)db.exec('ROLLBACK');throw err;}
}
function csv(rows){
 const safe=v=>{let s=String(v??'');if(/^\s*[=+@-]/.test(s))s="'"+s;return '"'+s.replace(/"/g,'""')+'"';};
 const cols=['digital_id','store_id','store','title','status','rights_holder','rights_evidence','rights_expires_on','rights_state','distribution_hold','rights_revision'];
 return '\uFEFF'+[cols,...rows.map(r=>[r.id,r.store_id,r.store_name,r.title,r.status,r.rights_holder,r.rights_evidence,r.rights_expires_on,r.rights_state,r.distribution_hold,r.rights_revision])].map(r=>r.map(safe).join(',')).join('\r\n')+'\r\n';
}
module.exports={migrate,active,report,change,normalizeDate,validDate,csv,todayTehran};
