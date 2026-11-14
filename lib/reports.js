'use strict';
// Phase 8: DEMO-ONLY reporting; amounts are not sales, receivables, profit or settled money.
const {STATUS}=require('./orders');
const MAX_BPS=2000; // Maximum suggested platform fee: 20.00%, stored as integer basis points.
function fail(message){throw Object.assign(new Error(message),{userError:true});}
function migrate(db){db.exec(`
 CREATE TABLE IF NOT EXISTS demo_commission_policies(
  store_id INTEGER PRIMARY KEY REFERENCES stores(id) ON DELETE RESTRICT,
  rate_bps INTEGER NOT NULL CHECK(rate_bps BETWEEN 0 AND 2000),
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
 );
 CREATE TABLE IF NOT EXISTS demo_commission_changes(
  id INTEGER PRIMARY KEY,store_id INTEGER NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  old_rate_bps INTEGER,new_rate_bps INTEGER NOT NULL CHECK(new_rate_bps BETWEEN 0 AND 2000),
  actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
 );
 CREATE INDEX IF NOT EXISTS idx_demo_commission_changes_store ON demo_commission_changes(store_id,id DESC);
 CREATE TABLE IF NOT EXISTS demo_order_financial_snapshots(
  order_id INTEGER PRIMARY KEY REFERENCES demo_orders(id) ON DELETE CASCADE,
  rate_bps INTEGER NOT NULL CHECK(rate_bps BETWEEN 0 AND 2000),
  commission_toman INTEGER NOT NULL CHECK(commission_toman>=0),
  seller_share_toman INTEGER NOT NULL CHECK(seller_share_toman>=0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
 );
 `);}
function parseRate(value){
 if(typeof value!=='string'||!/^(?:\d{1,2})(?:\.\d{1,2})?$/.test(value.trim()))fail('درصد باید عددی بین ۰ تا ۲۰ با حداکثر دو رقم اعشار باشد.');
 const parts=value.trim().split('.');const bps=Number(parts[0])*100+Number((parts[1]||'').padEnd(2,'0'));
 if(!Number.isSafeInteger(bps)||bps<0||bps>MAX_BPS)fail('درصد کارمزد باید بین ۰ تا ۲۰ باشد.');
 return bps;
}
function savePolicy(db,{storeId,rateBps,actorId}){
 if(!Number.isSafeInteger(storeId)||storeId<1||!Number.isSafeInteger(actorId)||actorId<1||!Number.isSafeInteger(rateBps)||rateBps<0||rateBps>MAX_BPS)fail('اطلاعات تنظیم کارمزد معتبر نیست.');
 db.exec('BEGIN IMMEDIATE');try{
  if(!db.prepare('SELECT id FROM stores WHERE id=?').get(storeId))fail('فروشگاه یافت نشد.');
  const old=db.prepare('SELECT rate_bps FROM demo_commission_policies WHERE store_id=?').get(storeId);
  db.prepare(`INSERT INTO demo_commission_policies(store_id,rate_bps,updated_by) VALUES(?,?,?)
   ON CONFLICT(store_id) DO UPDATE SET rate_bps=excluded.rate_bps,updated_by=excluded.updated_by,updated_at=CURRENT_TIMESTAMP`).run(storeId,rateBps,actorId);
  db.prepare('INSERT INTO demo_commission_changes(store_id,old_rate_bps,new_rate_bps,actor_id) VALUES(?,?,?,?)').run(storeId,old?.rate_bps??null,rateBps,actorId);
  db.exec('COMMIT');
 }catch(e){db.exec('ROLLBACK');throw e;}
}
function snapshot(db,orderId,storeId,subtotal){
 const policy=db.prepare('SELECT rate_bps FROM demo_commission_policies WHERE store_id=?').get(storeId);
 const rateBps=policy?.rate_bps??0;
 const fee=Math.floor((subtotal*rateBps+5000)/10000); // nearest toman, avoid floating fee rates
 db.prepare('INSERT INTO demo_order_financial_snapshots(order_id,rate_bps,commission_toman,seller_share_toman) VALUES(?,?,?,?)').run(orderId,rateBps,fee,subtotal-fee);
 return {rateBps,fee,share:subtotal-fee};
}
function safeDate(value){return typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&!Number.isNaN(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;}
function filters(query){const now=new Date(), today=now.toISOString().slice(0,10),monthAgo=new Date(now.getTime()-29*86400000).toISOString().slice(0,10);
 const from=query.searchParams.has('from')?query.searchParams.get('from'):monthAgo;
 const to=query.searchParams.has('to')?query.searchParams.get('to'):today;
 if(!safeDate(from)||!safeDate(to)||from>to||(Date.parse(to)-Date.parse(from))>366*86400000)fail('بازه تاریخ معتبر نیست یا بیشتر از ۳۶۶ روز است.');
 const status=query.searchParams.get('status')||'all';if(status!=='all'&&!Object.hasOwn(STATUS,status))fail('وضعیت فیلتر معتبر نیست.');
 return {from,to,status};}
function getReport(db,{storeId=0,from,to,status='all'}){
 // storeId 0 is allowed ONLY when server route has already authorized the platform owner.
 if(!Number.isSafeInteger(storeId)||storeId<0||!safeDate(from)||!safeDate(to)||from>to||status!=='all'&&!Object.hasOwn(STATUS,status))fail('فیلتر گزارش معتبر نیست.');
 const where=["o.created_at >= ?","o.created_at < date(?,'+1 day')"],args=[from,to];
 if(storeId){where.push('o.store_id=?');args.push(storeId);}
 if(status!=='all'){where.push('o.status=?');args.push(status);}
 const sql=`SELECT o.order_code,o.store_id,s.name AS store_name,o.status,o.book_subtotal,o.created_at,
  f.rate_bps,f.commission_toman,f.seller_share_toman
  FROM demo_orders o JOIN stores s ON s.id=o.store_id LEFT JOIN demo_order_financial_snapshots f ON f.order_id=o.id
  WHERE ${where.join(' AND ')} ORDER BY o.id DESC`;
 const rows=db.prepare(sql).all(...args);
 const metrics={count:rows.length,open:0,cancelled:0,completed:0,subtotal:0,activeSubtotal:0,projectedFee:0,projectedSellerShare:0,unsnapshotted:0};
 for(const r of rows){metrics.subtotal+=r.book_subtotal;
  if(r.status==='demo_cancelled'){metrics.cancelled++;continue;}
  metrics.activeSubtotal+=r.book_subtotal;
  if(r.status==='demo_done')metrics.completed++;else metrics.open++;
  if(r.rate_bps===null)metrics.unsnapshotted++;
  else{metrics.projectedFee+=r.commission_toman;metrics.projectedSellerShare+=r.seller_share_toman;}
 }
 const days=db.prepare(`SELECT substr(o.created_at,1,10) AS day,COUNT(*) n,COALESCE(SUM(CASE WHEN o.status<>'demo_cancelled' THEN o.book_subtotal ELSE 0 END),0) AS amount
  FROM demo_orders o WHERE ${where.join(' AND ')} GROUP BY substr(o.created_at,1,10) ORDER BY day ASC`).all(...args);
 const byStore=db.prepare(`SELECT s.id,s.name,COUNT(o.id) n,COALESCE(SUM(CASE WHEN o.status<>'demo_cancelled' THEN o.book_subtotal ELSE 0 END),0) amount
  FROM stores s JOIN demo_orders o ON o.store_id=s.id WHERE ${where.join(' AND ')} GROUP BY s.id,s.name ORDER BY amount DESC,s.id`).all(...args);
 return {rows,metrics,days,byStore};
}
function safeCsvField(value){let s=String(value??'');if(/^[\s\uFEFF]*[=+@\-\t\r]/.test(s))s="'"+s;return '"'+s.replace(/"/g,'""')+'"';}
function csv(report){const header=['شماره سفارش نمونه','فروشگاه','شناسه فروشگاه','وضعیت آزمایشی','جمع کتاب (تومان)','نرخ کارمزد نمونه (درصد)','کارمزد فرضی YM (تومان)','سهم فرضی فروشنده (تومان)','زمان UTC'];
 const result=[header,...report.rows.map(r=>[r.order_code,r.store_name,r.store_id,STATUS[r.status],r.book_subtotal,r.rate_bps===null?'ثبت نشده':(r.rate_bps/100).toFixed(2),r.commission_toman??'ثبت نشده',r.seller_share_toman??'ثبت نشده',r.created_at])];
 return '\uFEFF'+result.map(row=>row.map(safeCsvField).join(',')).join('\r\n')+'\r\n';}
module.exports={migrate,parseRate,savePolicy,snapshot,filters,getReport,csv,STATUS};
