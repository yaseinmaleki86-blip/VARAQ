'use strict';
// v4.3 — internal operations, not a license decision or real sales/financial reporting.
const TYPES={onboarding:'راه‌اندازی',documents:'مدارک',catalog:'اطلاعات کالا',inventory:'موجودی',media:'حقوق تصاویر',other:'سایر'};
const PRIORITIES={normal:'عادی',high:'بالا',urgent:'فوری'};
const STATES={open:'باز',in_progress:'در حال انجام',blocked:'نیازمند اقدام',done:'انجام شد'};
function fail(message){throw Object.assign(new Error(message),{userError:true});}
function positive(v){const n=Number(v);return Number.isSafeInteger(n)&&n>0?n:0;}
function isoDate(s){return typeof s==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(s)&&!Number.isNaN(Date.parse(s+'T00:00:00Z'))&&new Date(s+'T00:00:00Z').toISOString().slice(0,10)===s;}
function todayTehran(){const parts=new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Tehran',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());const p=Object.fromEntries(parts.map(x=>[x.type,x.value]));return `${p.year}-${p.month}-${p.day}`;}
function migrate(db){db.exec(`
 CREATE TABLE IF NOT EXISTS store_followup_tasks(
  id INTEGER PRIMARY KEY,store_id INTEGER NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  title TEXT NOT NULL CHECK(length(title) BETWEEN 5 AND 160),
  task_type TEXT NOT NULL CHECK(task_type IN ('onboarding','documents','catalog','inventory','media','other')),
  priority TEXT NOT NULL CHECK(priority IN ('normal','high','urgent')),
  due_date TEXT, status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','in_progress','blocked','done')),
  note TEXT NOT NULL DEFAULT '',revision INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
 );
 CREATE INDEX IF NOT EXISTS idx_store_followups_store_status_due ON store_followup_tasks(store_id,status,due_date,id);
 CREATE TABLE IF NOT EXISTS store_followup_events(
  id INTEGER PRIMARY KEY,task_id INTEGER NOT NULL REFERENCES store_followup_tasks(id) ON DELETE RESTRICT,
  actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,old_status TEXT,new_status TEXT NOT NULL,
  old_note TEXT,new_note TEXT NOT NULL,revision INTEGER NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
 );
 CREATE INDEX IF NOT EXISTS idx_store_followup_events_task ON store_followup_events(task_id,id DESC);
 `);}
function allStores(db,{storeId=0,q='',review='all'}={}){
 if(storeId!==0&&!positive(storeId))fail('شناسه فروشگاه معتبر نیست.');
 if(!['all','unverified','submitted','approved','rejected'].includes(review))fail('فیلتر مدارک نامعتبر است.');
 const text=String(q||'').trim().slice(0,80);const items=db.prepare(`SELECT s.id,s.name,s.city,s.slug,s.active,s.review_status,
 (SELECT COUNT(*) FROM users u WHERE u.store_id=s.id AND u.role='seller' AND u.enabled=1) active_users,
 (SELECT COUNT(*) FROM stock_items i WHERE i.store_id=s.id) sku_count,
 (SELECT COUNT(*) FROM stock_items i WHERE i.store_id=s.id AND i.active=1) active_skus,
 (SELECT COUNT(*) FROM stock_items i WHERE i.store_id=s.id AND i.active=1 AND i.quantity<=i.min_quantity) low_stock,
 (SELECT COUNT(*) FROM demo_orders o WHERE o.store_id=s.id) demo_orders,
 (SELECT COUNT(*) FROM store_followup_tasks t WHERE t.store_id=s.id AND t.status<>'done') open_tasks,
 (SELECT COUNT(*) FROM store_followup_tasks t WHERE t.store_id=s.id AND t.status<>'done' AND t.due_date IS NOT NULL AND t.due_date<?) overdue_tasks
 FROM stores s WHERE (?=0 OR s.id=?) AND (?='all' OR s.review_status=?)
 AND (?='' OR s.name LIKE ? OR s.city LIKE ? OR s.slug LIKE ?) ORDER BY s.id DESC`).all(todayTehran(),storeId,storeId,review,review,text,'%'+text+'%','%'+text+'%','%'+text+'%');
 return items;
}
function overview(rows){return {stores:rows.length,publicStores:rows.filter(x=>x.active).length,pendingReview:rows.filter(x=>x.review_status==='submitted').length,lowStock:rows.reduce((a,x)=>a+x.low_stock,0),openTasks:rows.reduce((a,x)=>a+x.open_tasks,0),overdueTasks:rows.reduce((a,x)=>a+x.overdue_tasks,0),demoOrders:rows.reduce((a,x)=>a+x.demo_orders,0)};}
function tasks(db,{storeId=0,status='all',limit=80}={}){
 if(storeId!==0&&!positive(storeId))fail('فروشگاه معتبر نیست.');
 if(status!=='all'&&!Object.hasOwn(STATES,status))fail('وضعیت پیگیری معتبر نیست.');
 return db.prepare(`SELECT t.*,s.name store_name,cu.username created_by_name,uu.username updated_by_name
 FROM store_followup_tasks t JOIN stores s ON s.id=t.store_id
 LEFT JOIN users cu ON cu.id=t.created_by LEFT JOIN users uu ON uu.id=t.updated_by
 WHERE (?=0 OR t.store_id=?) AND (?='all' OR t.status=?)
 ORDER BY CASE WHEN t.status='done' THEN 1 ELSE 0 END,CASE WHEN t.due_date IS NULL THEN 1 ELSE 0 END,
 t.due_date ASC,CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 ELSE 2 END,t.id DESC LIMIT ?`).all(storeId,storeId,status,status,Math.min(Math.max(limit,1),200));
}
function create(db,{storeId,title,taskType='other',priority='normal',dueDate='',note='',actorId}){
 const id=positive(storeId),actor=positive(actorId),name=String(title??'').trim(),comment=String(note??'').trim();
 if(!id||!actor||!db.prepare('SELECT id FROM stores WHERE id=?').get(id))fail('فروشگاه معتبر نیست.');
 if(name.length<5||name.length>160||comment.length>600||!Object.hasOwn(TYPES,taskType)||!Object.hasOwn(PRIORITIES,priority)||dueDate&&!isoDate(dueDate))fail('عنوان، موعد، نوع یا توضیحات پیگیری معتبر نیست.');
 db.exec('BEGIN IMMEDIATE');try{
 const result=db.prepare('INSERT INTO store_followup_tasks(store_id,title,task_type,priority,due_date,note,created_by,updated_by) VALUES(?,?,?,?,?,?,?,?)').run(id,name,taskType,priority,dueDate||null,comment,actor,actor);
 db.prepare('INSERT INTO store_followup_events(task_id,actor_id,old_status,new_status,old_note,new_note,revision) VALUES(?,?,NULL,?,?,?,1)').run(result.lastInsertRowid,actor,'open','',comment);
 db.exec('COMMIT');return Number(result.lastInsertRowid);
 }catch(e){db.exec('ROLLBACK');throw e;}
}
function update(db,{taskId,storeId,status,note='',expectedRevision,actorId}){
 const task=positive(taskId),sid=positive(storeId),actor=positive(actorId),revision=positive(expectedRevision),comment=String(note??'').trim();
 if(!task||!sid||!actor||!revision||!Object.hasOwn(STATES,status)||comment.length>600)fail('اطلاعات تغییر وضعیت معتبر نیست.');
 db.exec('BEGIN IMMEDIATE');try{
  const old=db.prepare('SELECT * FROM store_followup_tasks WHERE id=? AND store_id=?').get(task,sid);
  if(!old)fail('پیگیری این فروشگاه پیدا نشد.');
  if(old.revision!==revision)fail('این پیگیری قبلاً تغییر کرده است؛ صفحه را تازه‌سازی کنید.');
  if(old.status===status&&old.note===comment)fail('تغییری ثبت نشده است.');
  db.prepare('UPDATE store_followup_tasks SET status=?,note=?,revision=revision+1,updated_by=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND store_id=?').run(status,comment,actor,task,sid);
  db.prepare('INSERT INTO store_followup_events(task_id,actor_id,old_status,new_status,old_note,new_note,revision) VALUES(?,?,?,?,?,?,?)').run(task,actor,old.status,status,old.note,comment,revision+1);
  db.exec('COMMIT');return revision+1;
 }catch(e){db.exec('ROLLBACK');throw e;}
}
function history(db,taskId,storeId){if(!positive(taskId)||!positive(storeId))return [];return db.prepare(`SELECT e.id,e.old_status,e.new_status,e.old_note,e.new_note,e.revision,e.created_at,u.username FROM store_followup_events e JOIN store_followup_tasks t ON t.id=e.task_id LEFT JOIN users u ON u.id=e.actor_id WHERE e.task_id=? AND t.store_id=? ORDER BY e.id DESC LIMIT 40`).all(taskId,storeId);}
function csvField(v){let s=String(v??'');if(/^[\s\uFEFF]*[=+@\-\t\r]/.test(s))s="'"+s;return '"'+s.replace(/"/g,'""')+'"';}
function csv(rows){const data=[['شناسه فروشگاه','فروشگاه','شهر','نمایش عمومی','وضعیت بررسی داخلی','کاربران فعال','SKUها','SKU فعال','هشدار موجودی','سفارش نمایشی','پیگیری باز','پیگیری عقب‌افتاده'],...rows.map(x=>[x.id,x.name,x.city,x.active?'بله':'خیر',x.review_status,x.active_users,x.sku_count,x.active_skus,x.low_stock,x.demo_orders,x.open_tasks,x.overdue_tasks])];return '\uFEFF'+data.map(x=>x.map(csvField).join(',')).join('\r\n')+'\r\n';}
module.exports={TYPES,PRIORITIES,STATES,migrate,allStores,overview,tasks,create,update,history,csv,todayTehran};
