'use strict';
// Per-SKU catalogue discounts. No payment capability; server authoritative prices.
function fail(message){throw Object.assign(new Error(message),{userError:true});}
function migrate(db){
 db.exec(`CREATE TABLE IF NOT EXISTS stock_discounts(
   item_id INTEGER PRIMARY KEY REFERENCES stock_items(id) ON DELETE CASCADE,
   store_id INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
   percent INTEGER NOT NULL CHECK(percent BETWEEN 1 AND 70),
   enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
   starts_at TEXT NOT NULL DEFAULT '', ends_at TEXT NOT NULL DEFAULT '',
   updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
   CHECK(ends_at='' OR starts_at='' OR ends_at>starts_at)
 );
 CREATE INDEX IF NOT EXISTS idx_stock_discounts_store ON stock_discounts(store_id,enabled);
 CREATE TABLE IF NOT EXISTS stock_price_history(
   id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL REFERENCES stock_items(id) ON DELETE CASCADE,
   store_id INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
   old_price INTEGER NOT NULL, new_price INTEGER NOT NULL,
   changed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
 );
 CREATE INDEX IF NOT EXISTS idx_stock_price_history_item ON stock_price_history(item_id,id DESC);
 CREATE TRIGGER IF NOT EXISTS trg_varaq_stock_price_history AFTER UPDATE OF price ON stock_items
 WHEN NEW.price<>OLD.price BEGIN
 INSERT INTO stock_price_history(item_id,store_id,old_price,new_price) VALUES(NEW.id,NEW.store_id,OLD.price,NEW.price);
 END;`);
 // Old orders get backward-compatible price snapshot fields; history remains untouched.
 const fields=new Set(db.prepare('PRAGMA table_info(demo_order_items)').all().map(c=>c.name));
 if(!fields.has('original_unit_price'))db.exec('ALTER TABLE demo_order_items ADD COLUMN original_unit_price INTEGER');
 if(!fields.has('discount_percent'))db.exec('ALTER TABLE demo_order_items ADD COLUMN discount_percent INTEGER NOT NULL DEFAULT 0');
}
function effectivePrice(price,percent){
 if(!Number.isSafeInteger(price)||price<0||!Number.isSafeInteger(percent)||percent<0||percent>70)fail('قیمت یا درصد تخفیف نامعتبر است.');
 // Half-up integer rounding, without floating point rounding errors or unsafe products.
 return Math.floor((price*(100-percent)+50)/100);
}
function active(discount,now=new Date()){
 if(!discount||!discount.enabled)return false;
 const time=now.toISOString();
 return (!discount.starts_at||discount.starts_at<=time)&&(!discount.ends_at||discount.ends_at>time);
}
function parseTime(v){
 if(v==null||String(v).trim()==='')return '';
 const value=String(v).trim();
 // Date-time value is UTC, strict format for predictable comparisons.
 if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z$/.test(value)||Number.isNaN(Date.parse(value))||new Date(value).toISOString()!==value)fail('زمان شروع/پایان باید معتبر و بر حسب UTC باشد.');
 return value;
}
function save(db,{storeId,itemId,percent,enabled,startsAt='',endsAt=''}){
 if(!Number.isSafeInteger(Number(storeId))||Number(storeId)<1||!Number.isSafeInteger(Number(itemId))||Number(itemId)<1)fail('فروشگاه یا SKU نامعتبر است.');
 storeId=Number(storeId);itemId=Number(itemId);
 const item=db.prepare('SELECT id,price FROM stock_items WHERE id=? AND store_id=?').get(itemId,storeId);
 if(!item)fail('این SKU متعلق به فروشگاه انتخاب‌شده نیست.');
 const n=Number(percent);
 if(!Number.isSafeInteger(n)||n<1||n>70)fail('تخفیف باید عددی بین ۱ تا ۷۰ درصد باشد.');
 const start=parseTime(startsAt),end=parseTime(endsAt);
 if(start&&end&&end<=start)fail('پایان تخفیف باید بعد از شروع آن باشد.');
 db.prepare(`INSERT INTO stock_discounts(item_id,store_id,percent,enabled,starts_at,ends_at)
 VALUES(?,?,?,?,?,?) ON CONFLICT(item_id) DO UPDATE SET percent=excluded.percent,enabled=excluded.enabled,
 starts_at=excluded.starts_at,ends_at=excluded.ends_at,updated_at=CURRENT_TIMESTAMP`)
 .run(itemId,storeId,n,enabled?1:0,start,end);
 return {price:item.price,discounted:effectivePrice(item.price,n)};
}
function priceFor(db,itemId,basePrice,now=new Date()){
 const d=db.prepare('SELECT percent,enabled,starts_at,ends_at FROM stock_discounts WHERE item_id=?').get(itemId);
 const percent=active(d,now)?d.percent:0;
 return {price:effectivePrice(basePrice,percent),originalPrice:basePrice,discountPercent:percent};
}
module.exports={migrate,save,active,priceFor,effectivePrice,parseTime};
