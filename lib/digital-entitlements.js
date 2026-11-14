'use strict';
// Digital fulfillment primitives. Gateway NOT connected: no HTTP endpoint may issue grants.
// A future provider adapter must independently verify payment and return authoritative fields.
const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const rights=require('./pdf-rights');
function migrate(db){db.exec(`CREATE TABLE IF NOT EXISTS digital_entitlements(
 id INTEGER PRIMARY KEY,
 digital_id INTEGER NOT NULL REFERENCES digital_books(id),
 store_id INTEGER NOT NULL REFERENCES stores(id),
 provider TEXT NOT NULL,
 provider_ref TEXT NOT NULL,
 token_hash TEXT NOT NULL UNIQUE,
 issued_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL,
 download_count INTEGER NOT NULL DEFAULT 0 CHECK(download_count>=0),
 max_downloads INTEGER NOT NULL DEFAULT 3,
 UNIQUE(provider,provider_ref)
 );CREATE INDEX IF NOT EXISTS idx_digital_entitlements_expires ON digital_entitlements(expires_at);`);}
function sha(text){return crypto.createHash('sha256').update(text).digest('hex');}
function id(v){const n=Number(v);return Number.isSafeInteger(n)&&n>0?n:0;}
// verifier is a required independent gateway API verification adapter, NOT a user-supplied boolean.
async function issueAfterGatewayVerification(db,{digitalId,paymentRequest},verifier,now=Date.now()){
 if(typeof verifier!=='function')throw Error('Real payment gateway verification adapter required');
 const item=db.prepare(`SELECT d.id,d.store_id,d.price FROM digital_books d JOIN stores s ON s.id=d.store_id WHERE d.id=? AND d.status='approved' AND s.active=1 AND d.distribution_hold=0 AND (d.rights_expires_on='' OR d.rights_expires_on>=?)`).get(id(digitalId),rights.todayTehran());
 if(!item)throw Error('Digital item is not sellable');
 const confirmed=await verifier(paymentRequest,{digitalId:item.id,storeId:item.store_id,amountToman:item.price});
 if(!confirmed||confirmed.success!==true||confirmed.digitalId!==item.id||confirmed.storeId!==item.store_id||confirmed.amountToman!==item.price||confirmed.currency!=='TOMAN')throw Error('Gateway verification did not confirm exact item and price');
 const provider=String(confirmed.provider||'');const ref=String(confirmed.transactionId||'');
 if(!/^[a-z0-9_-]{2,40}$/i.test(provider)||!/^[a-zA-Z0-9_.-]{8,120}$/.test(ref))throw Error('Trusted provider receipt is incomplete');
 const token=crypto.randomBytes(32).toString('base64url');
 db.exec('BEGIN IMMEDIATE');try{
  const current=db.prepare(`SELECT d.price FROM digital_books d JOIN stores s ON s.id=d.store_id WHERE d.id=? AND d.store_id=? AND d.status='approved' AND s.active=1 AND d.distribution_hold=0 AND (d.rights_expires_on='' OR d.rights_expires_on>=?)`).get(item.id,item.store_id,rights.todayTehran());
  if(!current||current.price!==item.price)throw Error('Product rights, price or availability changed during verification');
  const previous=db.prepare('SELECT id FROM digital_entitlements WHERE provider=? AND provider_ref=?').get(provider,ref);
  if(previous){db.exec('ROLLBACK');return {duplicate:true,entitlementId:previous.id};}
  const result=db.prepare('INSERT INTO digital_entitlements(digital_id,store_id,provider,provider_ref,token_hash,issued_at,expires_at) VALUES(?,?,?,?,?,?,?)').run(item.id,item.store_id,provider,ref,sha(token),now,now+72*60*60*1000);
  db.exec('COMMIT');return {duplicate:false,token,entitlementId:Number(result.lastInsertRowid)};
 }catch(e){if(db.isTransaction)db.exec('ROLLBACK');throw e;}
}
function claim(db,dir,token,now=Date.now()){
 if(!/^[A-Za-z0-9_-]{43}$/.test(String(token||'')))return null;
 db.exec('BEGIN IMMEDIATE');
 try{
  const row=db.prepare(`SELECT e.id,e.digital_id,e.download_count,e.max_downloads,e.expires_at,d.filename,d.file_bytes,d.file_sha256,d.status,d.distribution_hold,d.rights_expires_on,s.active
 FROM digital_entitlements e JOIN digital_books d ON d.id=e.digital_id JOIN stores s ON s.id=e.store_id
 WHERE e.token_hash=? AND e.store_id=d.store_id`).get(sha(token));
  if(!row||row.download_count>=row.max_downloads||row.expires_at<=now||row.status!=='approved'||row.distribution_hold!==0||(row.rights_expires_on&&row.rights_expires_on<rights.todayTehran())||row.active!==1||!/^[a-f0-9]{32}\.pdf$/.test(row.filename)){db.exec('ROLLBACK');return null;}
  const full=path.join(dir,row.filename);
  // Refuse missing/replaced files. No user-controlled path or original filename is used.
  const stat=fs.statSync(full,{throwIfNoEntry:false});
  if(!stat||!stat.isFile()||stat.size!==row.file_bytes||sha(fs.readFileSync(full))!==row.file_sha256){db.exec('ROLLBACK');return null;}
  const change=db.prepare('UPDATE digital_entitlements SET download_count=download_count+1 WHERE id=? AND download_count<?').run(row.id,row.max_downloads);
  if(change.changes!==1)throw Error('Download count changed concurrently');
  db.exec('COMMIT');return {full,bytes:row.file_bytes,digitalId:row.digital_id};
 }catch(e){if(db.isTransaction)db.exec('ROLLBACK');if(e.code==='ENOENT'||e.code==='EACCES')return null;throw e;}
}
module.exports={migrate,issueAfterGatewayVerification,claim};
