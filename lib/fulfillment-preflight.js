'use strict';
// Internal training checklist for demonstration orders only. No stock movement,
// real fulfilment, payment, address verification or entitlement is implied.
const FIELDS={edition_checked:'تطبیق چاپ و شابک',stock_checked:'بازبینی موجودی نمونه',packing_checked:'بازبینی بسته‌بندی فرضی'};
function fail(msg){throw Object.assign(new Error(msg),{userError:true});}
function idOf(raw){const n=Number(raw);return Number.isSafeInteger(n)&&n>0?n:0;}
function migrate(db){db.exec(`
 CREATE TABLE IF NOT EXISTS demo_fulfillment_checklists(
  order_id INTEGER PRIMARY KEY REFERENCES demo_orders(id) ON DELETE CASCADE,
  store_id INTEGER NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  edition_checked INTEGER NOT NULL DEFAULT 0 CHECK(edition_checked IN (0,1)),
  stock_checked INTEGER NOT NULL DEFAULT 0 CHECK(stock_checked IN (0,1)),
  packing_checked INTEGER NOT NULL DEFAULT 0 CHECK(packing_checked IN (0,1)),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0),
  note TEXT NOT NULL DEFAULT '',
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
 );
 CREATE INDEX IF NOT EXISTS idx_demo_fulfillment_store ON demo_fulfillment_checklists(store_id,order_id);
 CREATE TABLE IF NOT EXISTS demo_fulfillment_events(
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES demo_orders(id) ON DELETE CASCADE,
  store_id INTEGER NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  old_flags TEXT NOT NULL,new_flags TEXT NOT NULL,note TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
 );
 CREATE INDEX IF NOT EXISTS idx_demo_fulfillment_events ON demo_fulfillment_events(order_id,id DESC);
 `);}
function clean(row){const flags=Object.fromEntries(Object.keys(FIELDS).map(k=>[k,Number(row?.[k]||0)]));return {...flags,revision:Number(row?.revision||0),note:row?.note||'',complete:Object.keys(FIELDS).every(k=>flags[k]===1)};}
function get(db,storeId,orderId){
 if(!idOf(storeId)||!idOf(orderId))return null;
 const order=db.prepare('SELECT id,status FROM demo_orders WHERE id=? AND store_id=?').get(orderId,storeId);
 if(!order)return null;
 const row=db.prepare('SELECT * FROM demo_fulfillment_checklists WHERE order_id=? AND store_id=?').get(orderId,storeId);
 return {...clean(row),status:order.status,orderId,storeId};
}
function save(db,{storeId,orderId,actorId,revision,checks,note=''}){
 const sid=idOf(storeId),oid=idOf(orderId),aid=idOf(actorId),rev=Number(revision);
 const noteText=String(note??'').trim();
 if(!sid||!oid||!aid||!Number.isSafeInteger(rev)||rev<0||noteText.length>300||!checks||typeof checks!=='object')fail('مشخصات چک‌لیست نامعتبر است.');
 const flags={};for(const key of Object.keys(FIELDS)){
  if(![0,1,'0','1',false,true].includes(checks[key]))fail('مقادیر چک‌لیست نامعتبر است.');
  flags[key]=Number(checks[key]);
 }
 db.exec('BEGIN IMMEDIATE');try{
  const old=get(db,sid,oid);
  if(!old)fail('سفارش این فروشگاه پیدا نشد.');
  if(old.revision!==rev)fail('چک‌لیست قبلاً تغییر کرده است؛ صفحه را تازه‌سازی کنید.');
  if(['demo_cancelled','demo_done'].includes(old.status))fail('پرونده آزمایشی بسته است و دیگر قابل ویرایش نیست.');
  if(Object.keys(FIELDS).every(k=>old[k]===flags[k])&&old.note===noteText)fail('تغییری برای ثبت وجود ندارد.');
  if(old.revision===0){
   db.prepare(`INSERT INTO demo_fulfillment_checklists(order_id,store_id,edition_checked,stock_checked,packing_checked,revision,note,updated_by)
    VALUES(?,?,?,?,?,1,?,?)`).run(oid,sid,flags.edition_checked,flags.stock_checked,flags.packing_checked,noteText,aid);
  }else{
   db.prepare(`UPDATE demo_fulfillment_checklists SET edition_checked=?,stock_checked=?,packing_checked=?,revision=revision+1,note=?,updated_by=?,updated_at=CURRENT_TIMESTAMP WHERE order_id=? AND store_id=?`).run(flags.edition_checked,flags.stock_checked,flags.packing_checked,noteText,aid,oid,sid);
  }
  db.prepare(`INSERT INTO demo_fulfillment_events(order_id,store_id,actor_id,old_flags,new_flags,note,revision) VALUES(?,?,?,?,?,?,?)`).run(oid,sid,aid,JSON.stringify(Object.fromEntries(Object.keys(FIELDS).map(k=>[k,old[k]]))),JSON.stringify(flags),noteText,rev+1);
  db.exec('COMMIT');return rev+1;
 }catch(e){db.exec('ROLLBACK');throw e;}
}
function history(db,storeId,orderId){return db.prepare(`SELECT e.*,u.username FROM demo_fulfillment_events e LEFT JOIN users u ON u.id=e.actor_id
 WHERE e.store_id=? AND e.order_id=? ORDER BY e.id DESC LIMIT 30`).all(idOf(storeId),idOf(orderId));}
function overview(db,storeId,limit=200){
 if(!idOf(storeId))return [];
 return db.prepare(`SELECT o.id,o.order_code,o.status,o.created_at,
 COALESCE(c.edition_checked,0) edition_checked,COALESCE(c.stock_checked,0) stock_checked,
 COALESCE(c.packing_checked,0) packing_checked,COALESCE(c.revision,0) revision
 FROM demo_orders o LEFT JOIN demo_fulfillment_checklists c ON c.order_id=o.id AND c.store_id=o.store_id
 WHERE o.store_id=? ORDER BY o.id DESC LIMIT ?`).all(storeId,Math.max(1,Math.min(limit,500))).map(r=>({...r,complete:Boolean(r.edition_checked&&r.stock_checked&&r.packing_checked)}));
}
function csv(rows){const escape=v=>{let s=String(v??'');if(/^[\s\uFEFF]*[=+@\-\t\r]/.test(s))s="'"+s;return '"'+s.replace(/"/g,'""')+'"';};
 const columns=['order_code','status','edition_checked','stock_checked','packing_checked','revision','created_at'];
 return '\uFEFF'+[columns,...rows.map(r=>columns.map(k=>r[k]??''))].map(row=>row.map(escape).join(',')).join('\r\n')+'\r\n';}
module.exports={FIELDS,migrate,get,save,history,overview,csv};
