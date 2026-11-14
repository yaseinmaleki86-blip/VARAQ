'use strict';
// v1.8 - bulk SKU edits and featured store shelf. NEVER handles real orders/payments.
function fail(msg){throw Object.assign(new Error(msg),{userError:true});}
function integer(text,min,max,name){
 const s=String(text??'');
 if(!/^(0|[1-9][0-9]*)$/.test(s)||!Number.isSafeInteger(Number(s))||Number(s)<min||Number(s)>max)fail(name+' معتبر نیست.');
 return Number(s);
}
function migrate(db){db.exec(`
 CREATE TABLE IF NOT EXISTS bulk_merch_batches(
   id INTEGER PRIMARY KEY, store_id INTEGER NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
   actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
   count INTEGER NOT NULL CHECK(count BETWEEN 1 AND 100),
   created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
 );
 CREATE TABLE IF NOT EXISTS bulk_merch_changes(
   batch_id INTEGER NOT NULL REFERENCES bulk_merch_batches(id) ON DELETE RESTRICT,
   stock_item_id INTEGER NOT NULL REFERENCES stock_items(id) ON DELETE RESTRICT,
   old_price INTEGER NOT NULL,new_price INTEGER NOT NULL,
   old_quantity INTEGER NOT NULL,new_quantity INTEGER NOT NULL,
   PRIMARY KEY(batch_id,stock_item_id)
 );
 CREATE TABLE IF NOT EXISTS store_featured_items(
   item_id INTEGER PRIMARY KEY REFERENCES stock_items(id) ON DELETE CASCADE,
   store_id INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
   headline TEXT NOT NULL DEFAULT '', priority INTEGER NOT NULL DEFAULT 50 CHECK(priority BETWEEN 0 AND 99),
   enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
   updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
 );
 CREATE INDEX IF NOT EXISTS idx_featured_store ON store_featured_items(store_id,enabled,priority);
 `);}
function parseCsv(csv){
 const text=String(csv??'').replace(/^\uFEFF/,'');
 if(!text.trim()||Buffer.byteLength(text,'utf8')>120000)fail('فایل CSV خالی یا بزرگ‌تر از ۱۲۰ کیلوبایت است.');
 let quoted=false,field='',row=[],rows=[];
 for(let i=0;i<text.length;i++){
  const c=text[i];
  if(c==='"'){
   if(quoted&&text[i+1]==='"'){field+='"';i++;}
   else if(quoted)quoted=false;
   else if(field==='')quoted=true;
   else fail('ساختار نقل‌قول CSV نامعتبر است.');
  }else if(c===','&&!quoted){row.push(field.trim());field='';}
  else if((c==='\n'||c==='\r')&&!quoted){if(c==='\r'&&text[i+1]==='\n')i++;row.push(field.trim());if(row.some(Boolean))rows.push(row);row=[];field='';}
  else field+=c;
  if(rows.length>101)fail('حداکثر ۱۰۰ SKU در هر فایل قابل ثبت است.');
 }
 if(quoted)fail('نقل‌قول CSV بسته نشده است.');
 row.push(field.trim());if(row.some(Boolean))rows.push(row);
 if(rows.length<2||rows.length>101)fail('فایل باید بین ۱ تا ۱۰۰ ردیف اطلاعات داشته باشد.');
 const header=['sku','expected_price','new_price','expected_quantity','new_quantity'];
 if(rows[0].join(',')!==header.join(','))fail('ستون‌ها باید دقیقاً sku,expected_price,new_price,expected_quantity,new_quantity باشند.');
 const seen=new Set();
 return rows.slice(1).map((r,i)=>{
  if(r.length!==5)fail(`ردیف ${i+2}: تعداد ستون‌ها نامعتبر است.`);
  const [sku,oldPrice,newPrice,oldQty,newQty]=r;
  if(!/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/.test(sku))fail(`ردیف ${i+2}: SKU نامعتبر است.`);
  if(seen.has(sku.toLowerCase()))fail(`ردیف ${i+2}: SKU تکراری است.`);
  seen.add(sku.toLowerCase());
  return {line:i+2,sku,expectedPrice:integer(oldPrice,0,1000000000,'قیمت قبلی'),newPrice:integer(newPrice,0,1000000000,'قیمت جدید'),expectedQuantity:integer(oldQty,0,1000000,'موجودی قبلی'),newQuantity:integer(newQty,0,1000000,'موجودی جدید')};
 });
}
function validate(db,storeId,csv){
 storeId=integer(storeId,1,1000000000,'شناسه فروشگاه');
 const rows=parseCsv(csv),find=db.prepare('SELECT id,sku,book_id,edition_id,price,quantity,active FROM stock_items WHERE store_id=? AND sku=? COLLATE NOCASE');
 const errors=[],valid=[];
 for(const r of rows){
  const item=find.get(storeId,r.sku);
  if(!item){errors.push(`ردیف ${r.line}: SKU در این فروشگاه وجود ندارد.`);continue;}
  if(item.price!==r.expectedPrice||item.quantity!==r.expectedQuantity){errors.push(`ردیف ${r.line}: قیمت یا موجودی در سرور تغییر کرده است؛ قالب تازه دریافت کنید.`);continue;}
  if(r.newPrice===r.expectedPrice&&r.newQuantity===r.expectedQuantity){errors.push(`ردیف ${r.line}: تغییری در قیمت یا موجودی وجود ندارد.`);continue;}
  if(Math.abs(r.newQuantity-r.expectedQuantity)>100000){errors.push(`ردیف ${r.line}: تغییر موجودی بیش از حد مجاز است.`);continue;}
  valid.push({...r,itemId:item.id,title:db.prepare('SELECT title FROM books WHERE id=?').get(item.book_id)?.title||''});
 }
 return {rows:valid,errors,total:rows.length};
}
function commit(db,{storeId,csv,actorId,note}){
 storeId=integer(storeId,1,1000000000,'شناسه فروشگاه');
 actorId=integer(actorId,1,1000000000,'شناسه کاربر');
 note=String(note??'').trim();if(note.length<5||note.length>180)fail('برای تغییر گروهی، توضیح ۵ تا ۱۸۰ کاراکتری لازم است.');
 db.exec('BEGIN IMMEDIATE');
 try{
  const v=validate(db,storeId,csv);
  if(v.errors.length||v.rows.length!==v.total)fail('عملیات لغو شد: '+v.errors.slice(0,3).join(' | '));
  const batchId=Number(db.prepare('INSERT INTO bulk_merch_batches(store_id,actor_id,count) VALUES(?,?,?)').run(storeId,actorId,v.rows.length).lastInsertRowid);
  const update=db.prepare('UPDATE stock_items SET price=?,quantity=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND store_id=? AND price=? AND quantity=?');
  const log=db.prepare('INSERT INTO bulk_merch_changes(batch_id,stock_item_id,old_price,new_price,old_quantity,new_quantity) VALUES(?,?,?,?,?,?)');
  const mv=db.prepare("INSERT INTO stock_movements(item_id,store_id,delta,before_quantity,after_quantity,reason,note,actor_id) VALUES(?,?,?,?,?,'correction',?,?)");
  const legacy=db.prepare('SELECT edition_id,book_id FROM stock_items WHERE id=? AND store_id=?');
  for(const r of v.rows){
   const result=update.run(r.newPrice,r.newQuantity,r.itemId,storeId,r.expectedPrice,r.expectedQuantity);
   if(result.changes!==1)fail('تغییر هم‌زمان اطلاعات؛ هیچ ردیفی ذخیره نشد.');
   log.run(batchId,r.itemId,r.expectedPrice,r.newPrice,r.expectedQuantity,r.newQuantity);
   if(r.newQuantity!==r.expectedQuantity)mv.run(r.itemId,storeId,r.newQuantity-r.expectedQuantity,r.expectedQuantity,r.newQuantity,'CSV گروهی #'+batchId+': '+note,actorId);
   const meta=legacy.get(r.itemId,storeId);
   if(meta.edition_id===null)db.prepare('UPDATE offers SET price=?,stock=?,updated_at=CURRENT_TIMESTAMP WHERE store_id=? AND book_id=?').run(r.newPrice,r.newQuantity,storeId,meta.book_id);
  }
  db.prepare('INSERT INTO audit_log(user_id,action,resource) VALUES(?,?,?)').run(actorId,'bulk-stock-price-update',storeId+':'+batchId+':'+v.rows.length);
  db.exec('COMMIT');return {batchId,count:v.rows.length};
 }catch(e){db.exec('ROLLBACK');throw e;}
}
function featuredSet(db,{storeId,itemId,actorId,headline,priority,enabled}){
 storeId=integer(storeId,1,1000000000,'فروشگاه');itemId=integer(itemId,1,1000000000,'SKU');
 priority=integer(priority,0,99,'اولویت');headline=String(headline||'').trim();
 if(headline.length>80)fail('عنوان پیشنهاد نباید بیش از ۸۰ حرف باشد.');
 db.exec('BEGIN IMMEDIATE');try{
  const item=db.prepare('SELECT id FROM stock_items WHERE id=? AND store_id=?').get(itemId,storeId);
  if(!item)fail('این SKU متعلق به فروشگاه انتخاب‌شده نیست.');
  const count=db.prepare('SELECT COUNT(*) n FROM store_featured_items WHERE store_id=? AND enabled=1 AND item_id<>?').get(storeId,itemId).n;
  if(enabled&&count>=8)fail('هر فروشگاه حداکثر ۸ پیشنهاد فعال می‌تواند داشته باشد.');
  db.prepare(`INSERT INTO store_featured_items(item_id,store_id,headline,priority,enabled) VALUES(?,?,?,?,?) ON CONFLICT(item_id) DO UPDATE SET headline=excluded.headline,priority=excluded.priority,enabled=excluded.enabled,updated_at=CURRENT_TIMESTAMP`).run(itemId,storeId,headline,priority,enabled?1:0);
  db.prepare('INSERT INTO audit_log(user_id,action,resource) VALUES(?,?,?)').run(actorId,'featured-update',storeId+':'+itemId);
  db.exec('COMMIT');
 }catch(e){db.exec('ROLLBACK');throw e;}
}
function demoPopular(db,storeId){return db.prepare(`
 SELECT di.sku,di.book_title,SUM(di.quantity) AS quantity,COUNT(DISTINCT o.id) AS orders
 FROM demo_order_items di JOIN demo_orders o ON o.id=di.order_id
 WHERE o.store_id=? AND o.status<>'demo_cancelled'
 GROUP BY di.sku,di.book_title ORDER BY quantity DESC, orders DESC, di.sku LIMIT 12`).all(storeId);}
module.exports={migrate,parseCsv,validate,commit,featuredSet,demoPopular};
