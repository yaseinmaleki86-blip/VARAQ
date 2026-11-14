'use strict';
// VARAQ 4.9: per-merchant payment PREPARATION, internal intent ledger and trusted-verification boundary.
// Deliberately NO public checkout, payment callback, or gateway credentials. All real purchases remain off.
const crypto=require('node:crypto');
const rights=require('./pdf-rights');
const PROVIDERS=new Set(['zarinpal','idpay','other']);
const safeId=value=>{const n=Number(value);return Number.isSafeInteger(n)&&n>0?n:0;};
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
function fail(message){const e=new Error(message);e.userError=true;throw e;}
function migrate(db){
 db.exec(`CREATE TABLE IF NOT EXISTS store_payment_profiles(
 store_id INTEGER PRIMARY KEY REFERENCES stores(id),
 provider TEXT NOT NULL DEFAULT '', merchant_label TEXT NOT NULL DEFAULT '',
 owner_confirmed INTEGER NOT NULL DEFAULT 0 CHECK(owner_confirmed IN (0,1)),
 review_status TEXT NOT NULL DEFAULT 'unreviewed' CHECK(review_status IN ('unreviewed','approved','rejected')),
 review_note TEXT NOT NULL DEFAULT '', revision INTEGER NOT NULL DEFAULT 0,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
 );
 CREATE TABLE IF NOT EXISTS digital_payment_intents(
 id INTEGER PRIMARY KEY, intent_ref TEXT NOT NULL UNIQUE,
 idempotency_hash TEXT NOT NULL UNIQUE,
 store_id INTEGER NOT NULL REFERENCES stores(id),
 digital_id INTEGER NOT NULL REFERENCES digital_books(id),
 provider TEXT NOT NULL, merchant_label TEXT NOT NULL,
 amount_toman INTEGER NOT NULL CHECK(amount_toman>0), currency TEXT NOT NULL DEFAULT 'TOMAN' CHECK(currency='TOMAN'),
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','verified','cancelled','expired')),
 gateway_transaction_id TEXT NOT NULL DEFAULT '', entitlement_id INTEGER REFERENCES digital_entitlements(id),
 created_at_ms INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL, verified_at_ms INTEGER
 );
 CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_verified_receipt ON digital_payment_intents(provider,gateway_transaction_id) WHERE gateway_transaction_id<>'';
 CREATE INDEX IF NOT EXISTS idx_digital_payments_store ON digital_payment_intents(store_id,id DESC);
 CREATE TABLE IF NOT EXISTS digital_payment_events(
 id INTEGER PRIMARY KEY, intent_id INTEGER NOT NULL REFERENCES digital_payment_intents(id),
 event TEXT NOT NULL, created_at_ms INTEGER NOT NULL
 );`);
}
function canManage(actor,storeId){return Boolean(actor&&(actor.role==='owner'||actor.role==='seller'&&actor.staff_permission==='manager'&&actor.store_id===storeId));}
function saveProfile(db,actor,input){
 if(actor?.role==='seller'&&input.store_id&&safeId(input.store_id)!==safeId(actor.store_id))fail('فروشنده نمی‌تواند پذیرندگی فروشگاه دیگری را تغییر دهد.');
 const storeId=actor?.role==='seller'?safeId(actor.store_id):safeId(input.store_id);
 if(!canManage(actor,storeId))fail('دسترسی به پذیرندگی این فروشگاه مجاز نیست.');
 if(!db.prepare('SELECT id FROM stores WHERE id=?').get(storeId))fail('فروشگاه وجود ندارد.');
 const provider=String(input.provider||'').trim();if(provider&&!PROVIDERS.has(provider))fail('درگاه انتخابی معتبر نیست.');
 const merchantLabel=String(input.merchant_label||'').trim();
 if(merchantLabel&&(!/^[a-zA-Z0-9._-]{4,80}$/.test(merchantLabel)))fail('شناسه عمومی پذیرنده نامعتبر است؛ رمز یا کلید محرمانه وارد نکنید.');
 const ownerConfirmed=input.owner_confirmed==='1'?1:0;
 if(provider&&(!merchantLabel||!ownerConfirmed))fail('شناسه عمومی و تأیید مالکیت پذیرندگی لازم است.');
 if(!provider&&merchantLabel)fail('ابتدا نوع درگاه را مشخص کنید.');
 const revision=Number(input.revision);if(!Number.isSafeInteger(revision)||revision<0)fail('نسخه فرم نامعتبر است.');
 db.exec('BEGIN IMMEDIATE');try{
  const old=db.prepare('SELECT revision FROM store_payment_profiles WHERE store_id=?').get(storeId);
  if((old?.revision||0)!==revision)fail('تنظیمات در صفحه دیگری ویرایش شده‌اند؛ تازه‌سازی کنید.');
  if(old){db.prepare(`UPDATE store_payment_profiles SET provider=?,merchant_label=?,owner_confirmed=?,review_status='unreviewed',review_note='',revision=revision+1,updated_at=CURRENT_TIMESTAMP WHERE store_id=?`).run(provider,merchantLabel,ownerConfirmed,storeId);}
  else db.prepare('INSERT INTO store_payment_profiles(store_id,provider,merchant_label,owner_confirmed,revision) VALUES(?,?,?,?,1)').run(storeId,provider,merchantLabel,ownerConfirmed);
  db.exec('COMMIT');return storeId;
 }catch(err){if(db.isTransaction)db.exec('ROLLBACK');throw err;}
}
function reviewProfile(db,actor,input){
 if(actor?.role!=='owner')fail('تنها مدیریت YM می‌تواند پرونده پذیرندگی را بررسی کند.');
 const storeId=safeId(input.store_id),status=String(input.status||''),note=String(input.note||'').trim();
 if(!['approved','rejected'].includes(status)||note.length<8||note.length>400)fail('وضعیت و توضیح بررسی معتبر نیست.');
 const revision=Number(input.revision);
 db.exec('BEGIN IMMEDIATE');try{
  const profile=db.prepare('SELECT * FROM store_payment_profiles WHERE store_id=?').get(storeId);
  if(!profile||profile.revision!==revision||!profile.provider||!profile.merchant_label||profile.owner_confirmed!==1)fail('پذیرندگی کامل نیست یا قبلاً تغییر کرده است.');
  db.prepare('UPDATE store_payment_profiles SET review_status=?,review_note=?,revision=revision+1,updated_at=CURRENT_TIMESTAMP WHERE store_id=?').run(status,note,storeId);
  db.exec('COMMIT');return storeId;
 }catch(err){if(db.isTransaction)db.exec('ROLLBACK');throw err;}
}
function profiles(db,actor){
 if(!actor||!['seller','owner'].includes(actor.role))return [];
 if(actor.role==='seller'&&actor.staff_permission!=='manager')return [];
 const filter=actor.role==='seller'?'WHERE s.id=?':'';
 const q=`SELECT s.id store_id,s.name store_name,s.review_status store_review,s.active,
 COALESCE(p.provider,'') provider,COALESCE(p.merchant_label,'') merchant_label,
 COALESCE(p.owner_confirmed,0) owner_confirmed,COALESCE(p.review_status,'unreviewed') payment_review,
 COALESCE(p.review_note,'') review_note,COALESCE(p.revision,0) revision,
 (SELECT COUNT(*) FROM digital_books d WHERE d.store_id=s.id AND d.status='approved' AND d.distribution_hold=0 AND (d.rights_expires_on='' OR d.rights_expires_on>=?)) licensed_pdfs,
 (SELECT COUNT(*) FROM digital_payment_intents i WHERE i.store_id=s.id) intent_count
 FROM stores s LEFT JOIN store_payment_profiles p ON p.store_id=s.id ${filter} ORDER BY s.id`;
 return db.prepare(q).all(...(actor.role==='seller'?[rights.todayTehran(),actor.store_id]:[rights.todayTehran()]));
}
function intents(db,actor,limit=100){
 if(!actor||!(actor.role==='owner'||actor.role==='seller'&&actor.staff_permission==='manager'))return [];
 const q=`SELECT i.id,i.intent_ref,i.store_id,s.name store_name,i.digital_id,d.title,
 i.amount_toman,i.currency,i.status,i.provider,i.created_at_ms,i.expires_at_ms,i.verified_at_ms
 FROM digital_payment_intents i JOIN stores s ON s.id=i.store_id JOIN digital_books d ON d.id=i.digital_id
 ${actor.role==='seller'?'WHERE i.store_id=?':''} ORDER BY i.id DESC LIMIT ?`;
 return db.prepare(q).all(...(actor.role==='seller'?[actor.store_id,Math.min(limit,500)]:[Math.min(limit,500)]));
}
function expire(db,now=Date.now()){
 const changes=db.prepare(`UPDATE digital_payment_intents SET status='expired' WHERE status='pending' AND expires_at_ms<=?`).run(now).changes;
 return changes;
}
// Integration-only method: future trusted backend must create this intent; never expose publicly until gateway integration.
function createIntent(db,{digitalId,idempotencyKey},now=Date.now()){
 const id=safeId(digitalId),key=String(idempotencyKey||'');
 if(!/^[A-Za-z0-9_-]{24,128}$/.test(key))fail('شناسه یکتای درخواست نامعتبر است.');
 const idem=hash(key);
 const previous=db.prepare('SELECT * FROM digital_payment_intents WHERE idempotency_hash=?').get(idem);
 if(previous){if(previous.digital_id!==id)fail('شناسه درخواست برای کالای دیگری استفاده شده است.');return {duplicate:true,intentRef:previous.intent_ref,status:previous.status};}
 const record=db.prepare(`SELECT d.id,d.store_id,d.price,p.provider,p.merchant_label FROM digital_books d
 JOIN stores s ON s.id=d.store_id JOIN store_payment_profiles p ON p.store_id=s.id
 WHERE d.id=? AND s.active=1 AND s.review_status='approved' AND d.status='approved' AND d.distribution_hold=0
 AND (d.rights_expires_on='' OR d.rights_expires_on>=?) AND p.owner_confirmed=1 AND p.review_status='approved'`).get(id,rights.todayTehran());
 if(!record||!PROVIDERS.has(record.provider)||!record.merchant_label)fail('فروشگاه، مجوز PDF یا پرونده پذیرندگی آماده نیست.');
 const ref='vp_'+crypto.randomBytes(18).toString('hex');
 db.exec('BEGIN IMMEDIATE');try{
  const result=db.prepare(`INSERT INTO digital_payment_intents
  (intent_ref,idempotency_hash,store_id,digital_id,provider,merchant_label,amount_toman,created_at_ms,expires_at_ms)
  VALUES(?,?,?,?,?,?,?,?,?)`).run(ref,idem,record.store_id,record.id,record.provider,record.merchant_label,record.price,now,now+15*60_000);
  db.prepare('INSERT INTO digital_payment_events(intent_id,event,created_at_ms) VALUES(?,?,?)').run(Number(result.lastInsertRowid),'intent_created',now);
  db.exec('COMMIT');return {duplicate:false,intentRef:ref,amountToman:record.price,storeId:record.store_id,provider:record.provider,currency:'TOMAN'};
 }catch(err){if(db.isTransaction)db.exec('ROLLBACK');throw err;}
}
// Integration-only method: verifier must independently query official gateway API from SERVER-SIDE credentials.
// A callback's claimed success/amount is NEVER adequate evidence; do not expose an HTTP confirm endpoint.
async function verifyIntent(db,intentRef,verificationRequest,verifier,now=Date.now()){
 if(typeof verifier!=='function')fail('اتصال امن استعلام پرداخت از درگاه موجود نیست.');
 const intent=db.prepare('SELECT * FROM digital_payment_intents WHERE intent_ref=?').get(String(intentRef||''));
 if(!intent)fail('درخواست پرداخت یافت نشد.');
 if(intent.status==='verified')return {duplicate:true,entitlementId:intent.entitlement_id};
 if(intent.status!=='pending'||intent.expires_at_ms<=now)fail('مهلت پرداخت به پایان رسیده یا درخواست متوقف شده است.');
 const expectation={intentRef:intent.intent_ref,provider:intent.provider,merchantLabel:intent.merchant_label,amountToman:intent.amount_toman,currency:'TOMAN',storeId:intent.store_id,digitalId:intent.digital_id};
 const confirmed=await verifier(verificationRequest,Object.freeze(expectation));
 if(!confirmed||confirmed.success!==true||confirmed.intentRef!==expectation.intentRef||confirmed.provider!==expectation.provider||confirmed.merchantLabel!==expectation.merchantLabel||confirmed.amountToman!==expectation.amountToman||confirmed.currency!=='TOMAN'||confirmed.storeId!==expectation.storeId||confirmed.digitalId!==expectation.digitalId||!/^[A-Za-z0-9_.-]{8,120}$/.test(String(confirmed.transactionId||'')))fail('استعلام مستقل درگاه با درخواست ثبت‌شده مطابقت ندارد.');
 const token=crypto.randomBytes(32).toString('base64url');
 db.exec('BEGIN IMMEDIATE');try{
  const fresh=db.prepare('SELECT * FROM digital_payment_intents WHERE id=?').get(intent.id);
  if(fresh.status==='verified'){db.exec('ROLLBACK');return {duplicate:true,entitlementId:fresh.entitlement_id};}
  if(fresh.status!=='pending'||fresh.expires_at_ms<=now)fail('وضعیت درخواست تغییر کرده است.');
  const item=db.prepare(`SELECT d.price,d.file_sha256,d.file_bytes FROM digital_books d JOIN stores s ON s.id=d.store_id
  WHERE d.id=? AND d.store_id=? AND d.status='approved' AND d.distribution_hold=0 AND s.active=1 AND s.review_status='approved'
  AND (d.rights_expires_on='' OR d.rights_expires_on>=?)`).get(fresh.digital_id,fresh.store_id,rights.todayTehran());
  if(!item||item.price!==fresh.amount_toman)fail('قیمت، موجودی یا مجوز فروش تغییر کرده است.');
  // Provider receipt is globally unique. Prevent replay across stores, items, or intents.
  if(db.prepare('SELECT id FROM digital_entitlements WHERE provider=? AND provider_ref=?').get(fresh.provider,confirmed.transactionId))fail('رسید درگاه قبلاً استفاده شده است.');
  const grant=db.prepare(`INSERT INTO digital_entitlements(digital_id,store_id,provider,provider_ref,token_hash,issued_at,expires_at)
  VALUES(?,?,?,?,?,?,?)`).run(fresh.digital_id,fresh.store_id,fresh.provider,confirmed.transactionId,hash(token),now,now+72*60*60_000);
  const entitlementId=Number(grant.lastInsertRowid);
  db.prepare(`UPDATE digital_payment_intents SET status='verified',verified_at_ms=?,gateway_transaction_id=?,entitlement_id=? WHERE id=?`).run(now,confirmed.transactionId,entitlementId,fresh.id);
  db.prepare('INSERT INTO digital_payment_events(intent_id,event,created_at_ms) VALUES(?,?,?)').run(fresh.id,'gateway_verified',now);
  db.exec('COMMIT');return {duplicate:false,token,entitlementId,intentRef:fresh.intent_ref};
 }catch(err){if(db.isTransaction)db.exec('ROLLBACK');throw err;}
}
function csv(rows){
 const quote=v=>{let s=String(v??'');if(/^\s*[=+@-]/.test(s))s="'"+s;return '"'+s.replace(/"/g,'""')+'"';};
 const cols=['intent_ref','store_id','store_name','digital_id','title','amount_toman','currency','provider','status','created_at_ms','verified_at_ms'];
 return '\uFEFF'+[cols,...rows.map(r=>cols.map(c=>r[c]??''))].map(r=>r.map(quote).join(',')).join('\r\n')+'\r\n';
}
module.exports={migrate,saveProfile,reviewProfile,profiles,intents,expire,createIntent,verifyIntent,csv};
