'use strict';
// Transactional, store-isolated inventory ledger. Amounts are whole tomans.
const VALID_SKU=/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/;
const REASONS={receipt:'ورود از تأمین‌کننده',manual_out:'خروج دستی',return:'برگشت به انبار',damage:'ضایعات',correction:'اصلاح شمارش'};
function fail(message){throw Object.assign(new Error(message),{userError:true});}
function integer(value,min,max,name){if(value===null||value===undefined||value===''||!Number.isSafeInteger(Number(value))||Number(value)<min||Number(value)>max)fail(name+' نامعتبر است.');return Number(value);}
function withTransaction(db,callback){db.exec('BEGIN IMMEDIATE');try{const result=callback();db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}}
function migrate(db){
 db.exec(`CREATE TABLE IF NOT EXISTS stock_items (
  id INTEGER PRIMARY KEY,
  store_id INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  edition_id INTEGER REFERENCES editions(id) ON DELETE RESTRICT,
  sku TEXT NOT NULL COLLATE NOCASE,
  price INTEGER NOT NULL DEFAULT 0 CHECK(price BETWEEN 0 AND 1000000000),
  quantity INTEGER NOT NULL DEFAULT 0 CHECK(quantity BETWEEN 0 AND 1000000),
  min_quantity INTEGER NOT NULL DEFAULT 2 CHECK(min_quantity BETWEEN 0 AND 1000000),
  active INTEGER NOT NULL DEFAULT 0 CHECK(active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(store_id,sku)
 );
 CREATE UNIQUE INDEX IF NOT EXISTS idx_stock_store_book_edition ON stock_items(store_id,book_id,edition_id) WHERE edition_id IS NOT NULL;
 CREATE UNIQUE INDEX IF NOT EXISTS idx_stock_legacy ON stock_items(store_id,book_id) WHERE edition_id IS NULL;
 CREATE INDEX IF NOT EXISTS idx_stock_lookup ON stock_items(book_id,active,quantity);
 CREATE TABLE IF NOT EXISTS stock_movements (
  id INTEGER PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES stock_items(id) ON DELETE RESTRICT,
  store_id INTEGER NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  delta INTEGER NOT NULL CHECK(delta<>0),
  before_quantity INTEGER NOT NULL CHECK(before_quantity>=0),
  after_quantity INTEGER NOT NULL CHECK(after_quantity>=0),
  reason TEXT NOT NULL CHECK(reason IN ('receipt','manual_out','return','damage','correction','migration')),
  note TEXT NOT NULL DEFAULT '',
  actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
 );
 CREATE INDEX IF NOT EXISTS idx_movements_store_time ON stock_movements(store_id,id DESC);
 CREATE INDEX IF NOT EXISTS idx_movements_item ON stock_movements(item_id,id DESC);`);
 // Idempotent import from 0.5 offers. Every old balance is traceable by an opening entry.
 withTransaction(db,()=>{
  const legacy=db.prepare('SELECT id,store_id,book_id,price,stock,active FROM offers ORDER BY id').all();
  const ins=db.prepare('INSERT OR IGNORE INTO stock_items(store_id,book_id,edition_id,sku,price,quantity,active) VALUES(?,?,NULL,?,?,?,?)');
  const movement=db.prepare("INSERT INTO stock_movements(item_id,store_id,delta,before_quantity,after_quantity,reason,note) VALUES(?,?,?,0,?,'migration',?)");
  for(const o of legacy){
   const sku=`LEG-${o.store_id}-${o.book_id}`;
   const result=ins.run(o.store_id,o.book_id,sku,o.price,o.stock,o.active);
   if(Number(result.changes)>0 && o.stock>0){const item=db.prepare('SELECT id FROM stock_items WHERE store_id=? AND book_id=? AND edition_id IS NULL').get(o.store_id,o.book_id);movement.run(item.id,o.store_id,o.stock,o.stock,'انتقال مانده موجودی از نسخه 0.5؛ چاپ نامشخص');}
  }
 });
}
function validateBookEdition(db,bookId,editionId){
 if(!db.prepare('SELECT id FROM books WHERE id=?').get(bookId))fail('کتاب انتخاب‌شده وجود ندارد.');
 if(editionId!==null){const e=db.prepare('SELECT book_id FROM editions WHERE id=?').get(editionId);if(!e||e.book_id!==bookId)fail('چاپ انتخابی متعلق به این کتاب نیست.');}
}
function createOrUpdate(db,{id=0,storeId,bookId,editionId,sku,price,minQuantity,active}){
 storeId=integer(storeId,1,1000000000,'فروشگاه');bookId=integer(bookId,1,1000000000,'کتاب');
 editionId=editionId==null||editionId===''?null:integer(editionId,1,1000000000,'چاپ');
 price=integer(price,0,1000000000,'قیمت');minQuantity=integer(minQuantity,0,1000000,'حد هشدار');
 if(!VALID_SKU.test(sku))fail('SKU باید ۳ تا ۶۴ کاراکتر انگلیسی، عدد، نقطه، خط تیره یا زیرخط داشته باشد.');
 if(!db.prepare('SELECT id FROM stores WHERE id=?').get(storeId))fail('فروشگاه پیدا نشد.');
 validateBookEdition(db,bookId,editionId);
 return withTransaction(db,()=>{
  let itemId=id;
  if(id){
   id=integer(id,1,1000000000,'شناسه موجودی');
   const current=db.prepare('SELECT * FROM stock_items WHERE id=? AND store_id=?').get(id,storeId);
   if(!current)fail('ردیف موجودی متعلق به فروشگاه شما نیست.');
   if(current.book_id!==bookId||current.edition_id!==editionId)fail('برای حفظ تاریخچه، کتاب یا چاپ این SKU قابل تغییر نیست؛ ردیف جدید بسازید.');
   db.prepare('UPDATE stock_items SET sku=?,price=?,min_quantity=?,active=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(sku,price,minQuantity,active?1:0,id);
   if(current.edition_id===null)db.prepare('UPDATE offers SET price=?,active=?,updated_at=CURRENT_TIMESTAMP WHERE store_id=? AND book_id=?').run(price,active?1:0,storeId,bookId);
  }else{
   if(editionId===null)fail('برای SKU جدید باید چاپ مشخص انتخاب شود؛ موجودی قدیمی بدون چاپ فقط قابل ویرایش است.');
   itemId=Number(db.prepare('INSERT INTO stock_items(store_id,book_id,edition_id,sku,price,min_quantity,active) VALUES(?,?,?,?,?,?,?)').run(storeId,bookId,editionId,sku,price,minQuantity,active?1:0).lastInsertRowid);
  }
  return itemId;
 });
}
function changeStock(db,{itemId,storeId,delta,reason,note,actorId}){
 itemId=integer(itemId,1,1000000000,'ردیف موجودی');storeId=integer(storeId,1,1000000000,'فروشگاه');
 delta=integer(delta,-100000,100000,'تعداد تغییر');
 if(delta===0||!Object.hasOwn(REASONS,reason))fail('علت یا مقدار تغییر موجودی معتبر نیست.');
 if(['receipt','return'].includes(reason)&&delta<0 || ['manual_out','damage'].includes(reason)&&delta>0)fail('علامت تعداد با علت ورود یا خروج سازگار نیست.');
 note=String(note||'').trim();if(note.length>300 || reason==='correction'&&note.length<5)fail('برای اصلاح شمارش، توضیح حداقل پنج حرفی لازم است.');
 return withTransaction(db,()=>{
  const row=db.prepare('SELECT * FROM stock_items WHERE id=? AND store_id=?').get(itemId,storeId);
  if(!row)fail('موجودی موردنظر در این فروشگاه وجود ندارد.');
  const next=row.quantity+delta;
  if(!Number.isSafeInteger(next)||next<0||next>1000000)fail('موجودی نمی‌تواند منفی یا بیش از ظرفیت مجاز شود.');
  const updated=db.prepare('UPDATE stock_items SET quantity=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND store_id=? AND quantity=?').run(next,itemId,storeId,row.quantity);
  if(updated.changes!==1)fail('تغییر هم‌زمان موجودی؛ دوباره تلاش کنید.');
  if(row.edition_id===null)db.prepare('UPDATE offers SET stock=?,updated_at=CURRENT_TIMESTAMP WHERE store_id=? AND book_id=?').run(next,storeId,row.book_id);
  db.prepare('INSERT INTO stock_movements(item_id,store_id,delta,before_quantity,after_quantity,reason,note,actor_id) VALUES(?,?,?,?,?,?,?,?)').run(itemId,storeId,delta,row.quantity,next,reason,note,actorId??null);
  return next;
 });
}
// Legacy form support: keeps previous offers consistent, while all quantity changes receive a ledger entry.
function legacyOffer(db,{storeId,bookId,price,quantity,active,actorId}){
 storeId=integer(storeId,1,1000000000,'فروشگاه');bookId=integer(bookId,1,1000000000,'کتاب');price=integer(price,0,1000000000,'قیمت');quantity=integer(quantity,0,100000,'موجودی');
 if(active&&(price<=0||quantity<=0))fail('فعال‌سازی نیازمند قیمت و موجودی مثبت است.');
 validateBookEdition(db,bookId,null);
 withTransaction(db,()=>{
  db.prepare(`INSERT INTO offers(book_id,store_id,price,stock,active) VALUES(?,?,?,?,?) ON CONFLICT(book_id,store_id) DO UPDATE SET price=excluded.price,stock=excluded.stock,active=excluded.active,updated_at=CURRENT_TIMESTAMP`).run(bookId,storeId,price,quantity,active?1:0);
  const sku=`LEG-${storeId}-${bookId}`;
  db.prepare('INSERT OR IGNORE INTO stock_items(store_id,book_id,sku,price,quantity,active) VALUES(?,?,?,?,0,?)').run(storeId,bookId,sku,price,active?1:0);
  const row=db.prepare('SELECT * FROM stock_items WHERE store_id=? AND book_id=? AND edition_id IS NULL').get(storeId,bookId);
  const delta=quantity-row.quantity;
  db.prepare('UPDATE stock_items SET price=?,active=?,quantity=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(price,active?1:0,quantity,row.id);
  if(delta)db.prepare("INSERT INTO stock_movements(item_id,store_id,delta,before_quantity,after_quantity,reason,note,actor_id) VALUES(?,?,?,?,?,'correction',?,?)").run(row.id,storeId,delta,row.quantity,quantity,'ثبت از فرم قدیمی موجودی',actorId??null);
 });
}
module.exports={REASONS,VALID_SKU,migrate,createOrUpdate,changeStock,legacyOffer};
