'use strict';
// Demo-only order workflow; NO payment, settlement, stock reservation or delivery.
const promotions = require('./promotions');
const crypto = require('node:crypto');
const STATUS={demo_new:'ثبت آزمایشی',demo_confirmed:'تأیید نمایشی',demo_packed:'آماده‌سازی نمایشی',demo_sent:'ارسال نمایشی',demo_done:'تکمیل نمایشی',demo_cancelled:'لغو آزمایشی'};
const TRANSITIONS={demo_new:['demo_confirmed','demo_cancelled'],demo_confirmed:['demo_packed','demo_cancelled'],demo_packed:['demo_sent','demo_cancelled'],demo_sent:['demo_done'],demo_done:[],demo_cancelled:[]};
function fail(message){throw Object.assign(new Error(message),{userError:true});}
function txn(db,fn){db.exec('BEGIN IMMEDIATE');try{const r=fn();db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}}
function migrate(db){db.exec(`
 CREATE TABLE IF NOT EXISTS demo_orders (
  id INTEGER PRIMARY KEY, order_code TEXT NOT NULL UNIQUE,
  store_id INTEGER NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  client_ref TEXT NOT NULL UNIQUE,
  customer_alias TEXT NOT NULL, city TEXT NOT NULL,
  sample_address TEXT NOT NULL DEFAULT '', shipping_method TEXT NOT NULL
  CHECK(shipping_method IN ('pickup','post','courier')),
  book_subtotal INTEGER NOT NULL CHECK(book_subtotal>=0),
  shipping_fee INTEGER, payment_status TEXT NOT NULL DEFAULT 'disabled' CHECK(payment_status='disabled'),
  status TEXT NOT NULL DEFAULT 'demo_new' CHECK(status IN ('demo_new','demo_confirmed','demo_packed','demo_sent','demo_done','demo_cancelled')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
 );
 CREATE INDEX IF NOT EXISTS idx_demo_orders_store ON demo_orders(store_id,id DESC);
 CREATE TABLE IF NOT EXISTS demo_order_items (
  id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES demo_orders(id) ON DELETE CASCADE,
  stock_item_id INTEGER NOT NULL REFERENCES stock_items(id) ON DELETE RESTRICT,
  book_title TEXT NOT NULL, sku TEXT NOT NULL, edition_label TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK(quantity BETWEEN 1 AND 5),
  unit_price INTEGER NOT NULL CHECK(unit_price>0),
  line_total INTEGER NOT NULL CHECK(line_total>0),
  UNIQUE(order_id,stock_item_id)
 );
 CREATE TABLE IF NOT EXISTS demo_order_events (
  id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES demo_orders(id) ON DELETE CASCADE,
  actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  old_status TEXT, new_status TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
 );
 CREATE INDEX IF NOT EXISTS idx_demo_events ON demo_order_events(order_id,id);
 `);
 const columns=new Set(db.prepare('PRAGMA table_info(demo_orders)').all().map(x=>x.name));
 if(!columns.has('receipt_token_hash'))db.exec('ALTER TABLE demo_orders ADD COLUMN receipt_token_hash TEXT');
 db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_demo_order_receipt_hash ON demo_orders(receipt_token_hash) WHERE receipt_token_hash IS NOT NULL');
}
// A quote is read-only: no stock is reserved, orders are not placed and no money is taken.
function preview(db,{storeId,items}){
 if(!Number.isSafeInteger(storeId)||storeId<1)fail('فروشگاه معتبر نیست.');
 if(!Array.isArray(items)||!items.length||items.length>15)fail('سبد باید بین ۱ تا ۱۵ ردیف داشته باشد.');
 const seen=new Set();let units=0;
 for(const item of items){const id=Number(item.id),qty=Number(item.qty);
  if(!Number.isSafeInteger(id)||id<1||!Number.isSafeInteger(qty)||qty<1||qty>5||seen.has(id))fail('شناسه کالا یا تعداد نامعتبر یا تکراری است.');
  seen.add(id);units+=qty;
 }
 if(units>30)fail('حداکثر ۳۰ جلد در هر سفارش آزمایشی مجاز است.');
 const store=db.prepare('SELECT id,name,active FROM stores WHERE id=?').get(storeId);
 if(!store)fail('فروشگاه موجود نیست.');
 const lookup=db.prepare(`SELECT si.id,si.store_id,si.sku,si.price,si.quantity AS stock,si.active,b.title,e.label AS edition_label,e.verified
   FROM stock_items si JOIN books b ON b.id=si.book_id LEFT JOIN editions e ON e.id=si.edition_id
   WHERE si.id=? AND si.store_id=?`);
 const rows=[];let subtotal=0;
 for(const item of items){const id=Number(item.id),qty=Number(item.qty),record=lookup.get(id,storeId);
  const allowed=Boolean(record&&store.active&&record.active&&record.stock>=qty&&record.price>0&&record.verified===1&&record.edition_label!=null);
  let unitPrice=null,originalPrice=null,discountPercent=0;
  if(allowed){const pricing=promotions.priceFor(db,id,record.price);unitPrice=pricing.price;originalPrice=pricing.originalPrice;discountPercent=pricing.discountPercent;}
  const valid=allowed&&Number.isSafeInteger(unitPrice)&&unitPrice>0&&Number.isSafeInteger(unitPrice*qty)&&unitPrice*qty<=1000000000;
  if(valid)subtotal+=unitPrice*qty;
  rows.push({id,qty,ready:valid,title:record?.title||'کالای ناموجود',sku:record?.sku||'',edition:record?.edition_label||'',unitPrice:valid?unitPrice:null,originalPrice:valid?originalPrice:null,discountPercent:valid?discountPercent:0,stock:record?.stock??0,lineTotal:valid?unitPrice*qty:null,reason:valid?'':!record?'کالا در این فروشگاه موجود نیست.':!store.active?'فروشگاه غیرفعال است.':!record.active||record.stock<qty?'موجودی کافی یا کالای فعال وجود ندارد.':'چاپ یا قیمت این کالا تأیید نشده است.'});
 }
 const ready=rows.every(x=>x.ready)&&subtotal>0&&subtotal<=1000000000;
 return {storeId,storeName:store.name,ready,subtotal:ready?subtotal:null,rows,paymentEnabled:false,shippingFee:null,inventoryReserved:false};
}
function createDemo(db, data){
 const {storeId,clientRef,customerAlias,city,sampleAddress,shippingMethod,items}=data;
 if(!Number.isSafeInteger(storeId)||storeId<1)fail('فروشگاه نامعتبر است.');
 if(!/^[a-f0-9-]{16,72}$/i.test(clientRef||''))fail('شناسه آزمایشی معتبر نیست.');
 if(typeof customerAlias!=='string'||customerAlias.trim().length<2||customerAlias.length>60||typeof city!=='string'||city.trim().length<2||city.length>60||typeof sampleAddress!=='string'||sampleAddress.length>240||!['pickup','post','courier'].includes(shippingMethod))fail('مشخصات نمونه مشتری یا روش ارسال نامعتبر است.');
 return txn(db,()=>{
  const duplicate=db.prepare('SELECT id,order_code,store_id FROM demo_orders WHERE client_ref=?').get(clientRef);
  if(duplicate){if(duplicate.store_id!==storeId)fail('شناسه درخواست تکراری متعلق به فروشگاه دیگر است.');return {id:duplicate.id,code:duplicate.order_code,replayed:true};}
  const quote=preview(db,{storeId,items});
  if(!quote.ready)fail('قیمت، چاپ یا موجودی برخی از کتاب‌ها تغییر کرده است. سبد را بررسی کنید.');
  // New checkout clients must explicitly agree with the server quote; older demo forms remain compatible.
  for(const item of items){if(item.expected_price!==undefined){
   if(!Number.isSafeInteger(Number(item.expected_price))||Number(item.expected_price)!==quote.rows.find(x=>x.id===Number(item.id)).unitPrice)fail('قیمت یک یا چند کتاب تغییر کرده است؛ مبلغ جدید را بررسی و تأیید کنید.');
  }}
  const key=crypto.randomBytes(32).toString('hex'),keyHash=crypto.createHash('sha256').update(key).digest('hex');
  const result=db.prepare(`INSERT INTO demo_orders(order_code,store_id,client_ref,customer_alias,city,sample_address,shipping_method,book_subtotal,receipt_token_hash)
    VALUES('PENDING',?,?,?,?,?,?,?,?)`).run(storeId,clientRef,customerAlias.trim(),city.trim(),sampleAddress.trim(),shippingMethod,quote.subtotal,keyHash);
  const id=Number(result.lastInsertRowid),code='DEMO-'+String(id).padStart(6,'0');
  db.prepare('UPDATE demo_orders SET order_code=? WHERE id=?').run(code,id);
  const ins=db.prepare('INSERT INTO demo_order_items(order_id,stock_item_id,book_title,sku,edition_label,quantity,unit_price,line_total,original_unit_price,discount_percent) VALUES(?,?,?,?,?,?,?,?,?,?)');
  for(const item of quote.rows)ins.run(id,item.id,item.title,item.sku,item.edition,item.qty,item.unitPrice,item.lineTotal,item.originalPrice,item.discountPercent);
  require('./reports').snapshot(db,id,storeId,quote.subtotal);
  db.prepare("INSERT INTO demo_order_events(order_id,old_status,new_status,note) VALUES(?,NULL,'demo_new','ثبت خودکار در محیط آزمایشی بدون پرداخت')").run(id);
  return {id,code,key,replayed:false,subtotal:quote.subtotal};
 });
}
function receipt(db,{code,key}){
 if(typeof code!=='string'||!/^DEMO-\d{6,12}$/.test(code)||typeof key!=='string'||!/^[a-f0-9]{64}$/.test(key))return null;
 const hash=crypto.createHash('sha256').update(key).digest('hex');
 const order=db.prepare('SELECT o.id,o.order_code,o.status,o.book_subtotal,o.shipping_method,o.payment_status,o.created_at,o.updated_at,s.name AS store_name FROM demo_orders o JOIN stores s ON s.id=o.store_id WHERE o.order_code=? AND o.receipt_token_hash=?').get(code,hash);
 if(!order)return null;
 return {order,items:db.prepare('SELECT book_title,sku,edition_label,quantity,unit_price,line_total FROM demo_order_items WHERE order_id=? ORDER BY id').all(order.id),events:db.prepare('SELECT new_status,created_at FROM demo_order_events WHERE order_id=? ORDER BY id').all(order.id)};
}
function updateStatus(db,{orderId,storeId,nextStatus,actorId,note=''}){
 if(!Number.isSafeInteger(orderId)||orderId<1||!Number.isSafeInteger(storeId)||storeId<1||!Number.isSafeInteger(actorId)||actorId<1||typeof note!=='string'||note.length>300)fail('اطلاعات تغییر وضعیت معتبر نیست.');
 return txn(db,()=>{
  const row=db.prepare('SELECT id,status FROM demo_orders WHERE id=? AND store_id=?').get(orderId,storeId);
  if(!row)fail('سفارش آزمایشی مربوط به این فروشگاه نیست.');
  if(!TRANSITIONS[row.status]?.includes(nextStatus))fail('تغییر وضعیت در این مرحله مجاز نیست.');
  db.prepare('UPDATE demo_orders SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(nextStatus,orderId);
  db.prepare('INSERT INTO demo_order_events(order_id,actor_id,old_status,new_status,note) VALUES(?,?,?,?,?)').run(orderId,actorId,row.status,nextStatus,note.trim());
  return nextStatus;
 });
}
module.exports={migrate,preview,createDemo,receipt,updateStatus,STATUS,TRANSITIONS};
