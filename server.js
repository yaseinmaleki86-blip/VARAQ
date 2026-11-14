'use strict';
// VARAQ v1.3 — curated metadata workflow and quality audit; no external NPM dependencies. Requires Node.js >=22.13 (Node 24 recommended).
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { DatabaseSync } = require('node:sqlite');
const {csvParse} = require('./lib/import');
const {validateImage,MAX_COVER_BYTES} = require('./lib/images');
const {multipart} = require('./lib/multipart');
const stock = require('./lib/stock');
const orders = require('./lib/orders');
const fulfillment = require('./lib/fulfillment-preflight');
const finance = require('./lib/reports');
const discovery = require('./lib/discovery');
const searchAssist = require('./lib/search-assist');
const discoveryFacets = require('./lib/discovery-facets');
const education = require('./lib/education');
const educationBatch = require('./lib/education-batch');
const educationCompare = require('./lib/education-compare');
const catalogWorkflow = require('./lib/catalog-workflow');
const homeCms = require('./lib/home-cms');
const promotions = require('./lib/promotions');
const merchandising = require('./lib/merchandising');
const bibliography = require('./lib/bibliography');
const editionCover = require('./lib/edition-cover');
const editionDetail = require('./lib/edition-detail');
const editionVerify = require('./lib/edition-verification');
const coverPriority = require('./lib/cover-priority');
const coverIntake = require('./lib/cover-intake');
const coverWebIntake = require('./lib/cover-web-intake');
const finishingDesk = require('./lib/finishing-desk');
const catalogReadinessV82 = require('./lib/catalog-readiness-v82');
const bibliographicReviewV83 = require('./lib/bibliographic-review-v83');
const catalogConsistency = require('./lib/catalog-consistency');
const catalogWorklist = require('./lib/catalog-worklist');
const editorialBatch = require('./lib/editorial-batch');
const editorialBatchV31 = require('./lib/editorial-batch-v31');
const editorialQa = require('./lib/editorial-qa');
const generatedReview = require('./lib/generated-editorial-review');
const topicDiscovery = require('./lib/topic-discovery');
const bookComparison = require('./lib/book-comparison');
const bookDetailOverview = require('./lib/book-detail-overview');
const readingSamples = require('./lib/reading-samples');
const printVariants = require('./lib/print-variants');
const coverResearch = require('./lib/cover-research');
const coverRights = require('./lib/cover-rights');
const seo = require('./lib/seo');
const catalogAudit = require('./lib/catalog-audit');
const publicationReview = require('./lib/publication-review');
const storeOperations = require('./lib/store-operations');
const pdfStore = require('./lib/pdf-store');
const digitalEntitlements = require('./lib/digital-entitlements');
const digitalPayments = require('./lib/digital-payments');
const releaseAudit = require('./lib/release-audit');
const mediaIntegrity = require('./lib/media-integrity');
const coverCompletion = require('./lib/cover-completion');
const coverDashboard = require('./lib/cover-dashboard');
const contentBatch = require('./lib/content-batch');
const contentWorkbook = require('./lib/content-workbook');
const pdfUi = require('./lib/pdf-ui');
const pdfRights = require('./lib/pdf-rights');
const publisherOutreach = require('./lib/publisher-outreach');
const runtimeControl = require('./lib/runtime-control');
const operationalEvents = require('./lib/operational-events');
const marketGateway = require('./lib/market-gateway');
const {allowUnsafeRequest} = require('./lib/http-guard');
const ROOT = __dirname;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'storage'));
const PORT = Number(process.env.PORT || 3030);
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const IS_PUBLIC = Boolean(process.env.PUBLIC_URL);
// v4.1: public informational preview is read-only; search indexing requires an explicit release switch.
const PUBLIC_READONLY = IS_PUBLIC;
const INDEXING_ENABLED = IS_PUBLIC && ['VARAQ_PUBLIC_INDEX','VARAQ_LEGAL_REVIEWED','VARAQ_MEDIA_RIGHTS_REVIEWED','VARAQ_BROWSER_QA_APPROVED'].every(k => process.env[k] === '1');
if(IS_PUBLIC){const u=new URL(PUBLIC_URL);if(!['https:','http:'].includes(u.protocol))throw Error('PUBLIC_URL requires HTTP(S)');if(u.protocol==='http:'&&!['localhost','127.0.0.1','::1','[::1]'].includes(u.hostname)&&process.env.ALLOW_INSECURE_PUBLIC_HTTP!=='1')throw Error('Public deployments require HTTPS (or explicitly ALLOW_INSECURE_PUBLIC_HTTP=1 for isolated testing).');}

// Deployment safety: never put private SQLite, PDF vault, or incident reports under public/.
const publicAssetRoot=path.resolve(ROOT,'public');
const resolvedDataDir=fs.existsSync(DATA_DIR)?fs.realpathSync(DATA_DIR):DATA_DIR;
if([DATA_DIR,resolvedDataDir].some(p=>p===publicAssetRoot||p.startsWith(publicAssetRoot+path.sep)))
 throw Error('DATA_DIR must be outside the public assets directory.');
const STATIC = path.join(ROOT, 'public');
const conceptEtags = new Map();
function conceptEtag(file,stat){
 const hit=conceptEtags.get(file);
 if(hit&&hit.size===stat.size&&hit.mtimeMs===stat.mtimeMs)return hit.etag;
 const value='"'+crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0,28)+'"';
 conceptEtags.set(file,{size:stat.size,mtimeMs:stat.mtimeMs,etag:value});
 return value;
}
const MAX_POST_BYTES = 360 * 1024;
fs.mkdirSync(DATA_DIR, { recursive:true, mode:0o700 });
const db = new DatabaseSync(path.join(DATA_DIR, 'varaq.sqlite'));
db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
db.exec(`CREATE TABLE IF NOT EXISTS books(
 id INTEGER PRIMARY KEY, slug TEXT UNIQUE NOT NULL, title TEXT NOT NULL, author TEXT NOT NULL DEFAULT '',
 category TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', publisher TEXT NOT NULL DEFAULT '',
 isbn TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_books_category ON books(category);
CREATE INDEX IF NOT EXISTS idx_books_title ON books(title);
CREATE TABLE IF NOT EXISTS stores(
 id INTEGER PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, city TEXT NOT NULL DEFAULT '',
 phone TEXT NOT NULL DEFAULT '', about TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS users(
 id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
 role TEXT NOT NULL CHECK(role IN ('owner','seller')),
 store_id INTEGER REFERENCES stores(id), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS sessions(
 token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 csrf TEXT NOT NULL, expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS offers(
 id INTEGER PRIMARY KEY, book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
 store_id INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE, price INTEGER NOT NULL CHECK(price>=0),
 stock INTEGER NOT NULL CHECK(stock>=0), active INTEGER NOT NULL DEFAULT 0,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(book_id,store_id)
);
CREATE INDEX IF NOT EXISTS idx_offers_book ON offers(book_id,active);
CREATE TABLE IF NOT EXISTS audit_log(
 id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id), action TEXT NOT NULL,
 resource TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`);
// 8.6: additive catalogue import; never replace customer, merchant or operator-edited rows.
const seedBooksV86=JSON.parse(fs.readFileSync(path.join(ROOT,'data','books.json'),'utf8'));
const countBeforeV86=db.prepare('SELECT count(*) AS n FROM books').get().n;
if(countBeforeV86===0){
 db.exec('BEGIN IMMEDIATE');
 try{
  const ins=db.prepare('INSERT INTO books(id,slug,title,author,category,description,publisher,isbn) VALUES(?,?,?,?,?,?,?,?)');
  for(const b of seedBooksV86)ins.run(b.id,b.slug,b.title,b.author,b.category,b.description,b.publisher,b.isbn);
  db.exec('COMMIT');
 }catch(e){db.exec('ROLLBACK');throw e;}
}else{
 // IDs 1-200 are legacy operator-owned catalogue entries: do not rewrite them.
 // New IDs are only inserted if both their ID and slug are currently unused.
 const byId=db.prepare('SELECT id FROM books WHERE id=?');
 const bySlug=db.prepare('SELECT id FROM books WHERE slug=?');
 const ins=db.prepare('INSERT INTO books(id,slug,title,author,category,description,publisher,isbn) VALUES(?,?,?,?,?,?,?,?)');
 db.exec('BEGIN IMMEDIATE');
 try{
  for(const b of seedBooksV86){
   if(b.id<=200||byId.get(b.id)||bySlug.get(b.slug))continue;
   ins.run(b.id,b.slug,b.title,b.author,b.category,b.description,b.publisher,b.isbn);
  }
  db.exec('COMMIT');
 }catch(e){db.exec('ROLLBACK');throw e;}
}
// VARAQ 6.3: expanded spoiler-safe editorial previews and thematic art; never overwrite operator-edited metadata.
const generatedCatalogue=require('./data/generated_catalog_v86.json');
const generatedTextById=new Map(generatedCatalogue.map(row=>[row.id,row]));
const exclusiveContent=require('./lib/exclusive-content');
function exclusiveFor(book){
 const entry=generatedTextById.get(book.id);
 if(entry&&generatedReview.record(db,entry).status==='hidden')return null;
 return exclusiveContent.forBook(book);
}
function exclusiveSummary(book,id='book-summary'){
 const record=exclusiveFor(book);
 return record?`<section class="varaq-exclusive-summary" id="${id}"><h2>خلاصه اختصاصی کتاب</h2><p class="v67-text-body">${esc(record.summary)}</p>${record.scope_note?`<p class="muted tiny">${esc(record.scope_note)}</p>`:''}</section>`:'';
}
const publicTopicsFor = book => topicDiscovery.topicsFor(book,generatedTextById,entry=>generatedReview.record(db,entry).status==='hidden');
generatedReview.migrate(db);
readingSamples.migrate(db);
function generatedIntro(book){
 const custom=exclusiveFor(book);if(custom)return custom.introduction;
 const entry=generatedTextById.get(book.id);
 return entry&&entry.title===book.title&&generatedReview.record(db,entry).status!=='hidden'?entry.description:'';
}
function generatedReadingGuide(book){
 const entry=generatedTextById.get(book.id);
 if(!entry||entry.title!==book.title||!entry.reader_note||!Array.isArray(entry.topics))return '';
 const review=generatedReview.record(db,entry);if(review.status==='hidden')return '';
 const approved=review.status==='approved';
 // Editorial guides are clearly drafts, not publishing rights or verified bibliography.
 const topics=publicTopicsFor(book).slice(0,3).map(x=>`<li><a href="/themes?topic=${encodeURIComponent(x)}" aria-label="دیدن کتاب‌های مرتبط با ${attr(x)}">${esc(x)}</a></li>`).join('');
 return `<section class="varaq-reading-guide" aria-label="راهنمای مطالعه اولیه"><div class="varaq-reading-guide-head"><h2>در یک نگاه</h2><span>${approved?'راهنمای بازبینی‌شده تحریریه':'یادداشت تحریریه · نیازمند بازبینی'}</span></div>${topics?`<ul class="varaq-reading-topics" aria-label="موضوع‌های پیشنهادی">${topics}</ul>`:''}<p>${esc(entry.reader_note)}</p><small>${approved?'این معرفی با منبع ثبت‌شده توسط تحریریه بازبینی شده؛ تأیید مشخصات چاپ و حق استفاده از جلد جداگانه است.':'این راهنمای اولیه برای آشنایی است؛ برای صحت اطلاعات، چاپ و ترجمه، شناسنامه ناشر را بررسی کنید.'}</small></section>`;
}
homeCms.initialize(db);
// Incremental migration: never erase earlier users, stores, offers or catalogue records.
if (!db.prepare('PRAGMA table_info(users)').all().some(c => c.name==='must_change_password')) {
  db.exec('ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0');
}
db.exec(`CREATE TABLE IF NOT EXISTS editions(
 id INTEGER PRIMARY KEY,
 book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
 label TEXT NOT NULL DEFAULT '', translator TEXT NOT NULL DEFAULT '',
 publisher TEXT NOT NULL DEFAULT '', isbn TEXT NOT NULL DEFAULT '',
 publication_year TEXT NOT NULL DEFAULT '', pages INTEGER,
 binding TEXT NOT NULL DEFAULT '', language TEXT NOT NULL DEFAULT '',
 notes TEXT NOT NULL DEFAULT '', verified INTEGER NOT NULL DEFAULT 0 CHECK(verified IN (0,1)),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_editions_book ON editions(book_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_editions_isbn ON editions(isbn) WHERE isbn <> '';
`);
// v0.3 additive migration — existing book data, accounts and offers are never replaced.
db.exec(`CREATE TABLE IF NOT EXISTS book_categories(
 id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, slug TEXT NOT NULL UNIQUE,
 parent_id INTEGER REFERENCES book_categories(id), active INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS book_covers(
 book_id INTEGER PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
 filename TEXT NOT NULL UNIQUE, mime TEXT NOT NULL, alt TEXT NOT NULL,
 source TEXT NOT NULL, rights_note TEXT NOT NULL, uploaded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);`);
// Seed category records from the existing catalogue, without altering a single book.
for(const row of db.prepare('SELECT DISTINCT category FROM books ORDER BY category').all()){
 if(!db.prepare('SELECT id FROM book_categories WHERE name=?').get(row.category)){
  const slug='cat-'+crypto.createHash('sha256').update(row.category).digest('hex').slice(0,12);
  db.prepare('INSERT INTO book_categories(name,slug) VALUES(?,?)').run(row.category,slug);
 }
}
// v0.4: additive reader reviews and editorial analysis, no destructive migrations.
db.exec(`CREATE TABLE IF NOT EXISTS reader_reviews(
 id INTEGER PRIMARY KEY, book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
 display_name TEXT NOT NULL, rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
 body TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, moderated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_reader_reviews_book_status ON reader_reviews(book_id,status,id);
CREATE INDEX IF NOT EXISTS idx_reader_reviews_status ON reader_reviews(status,id);
CREATE TABLE IF NOT EXISTS book_editorials(
 book_id INTEGER PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
 summary TEXT NOT NULL DEFAULT '', audience TEXT NOT NULL DEFAULT '',
 strengths TEXT NOT NULL DEFAULT '', cautions TEXT NOT NULL DEFAULT '',
 published INTEGER NOT NULL DEFAULT 0 CHECK(published IN (0,1)),
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);`);
// v0.5 additive migrations: seller onboarding, private compliance records, employee permissions.
// Existing active stores are NOT automatically claimed as licensed or approved.
for (const [table,column,definition] of [
 ['stores','review_status',"TEXT NOT NULL DEFAULT 'unverified'"],
 ['stores','review_note',"TEXT NOT NULL DEFAULT ''"],
 ['stores','submitted_at','TEXT'],
 ['stores','reviewed_at','TEXT'],
 ['users','enabled','INTEGER NOT NULL DEFAULT 1'],
 ['users','staff_permission',"TEXT NOT NULL DEFAULT 'manager'"],
 ['users','created_by','INTEGER']
]) if (!db.prepare(`PRAGMA table_info(${table})`).all().some(c=>c.name===column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
db.exec(`CREATE TABLE IF NOT EXISTS store_documents(
 id INTEGER PRIMARY KEY, store_id INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
 kind TEXT NOT NULL CHECK(kind IN ('business_license','identity','address','other')),
 original_name TEXT NOT NULL, stored_name TEXT NOT NULL UNIQUE,
 mime TEXT NOT NULL, uploaded_by INTEGER REFERENCES users(id),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_store_documents_store ON store_documents(store_id,id);
CREATE INDEX IF NOT EXISTS idx_users_store ON users(store_id,enabled);
`);
stock.migrate(db);
orders.migrate(db);
fulfillment.migrate(db);
promotions.migrate(db);
merchandising.migrate(db);
finance.migrate(db);
discovery.migrate(db); // FTS5 Persian search and edition-aware index; non-destructive
education.migrate(db); // Optional educational profiles; keep 200 general books unchanged
catalogWorkflow.migrate(db); // v1.3 content queue; non-destructive migration
editorialQa.migrate(db); // v3.2 reviewer checklist and revision-bound evidence
bibliography.migrate(db); // source-linked editions & real cover references
printVariants.migrate(db); // v2.6 print-run source evidence (separate from ISBN)
coverResearch.migrate(db); // v2.2 staged web image candidates; never auto-published
coverRights.migrate(db); // v3.4 permission correspondence, never auto-grants publication
editionCover.migrate(db); // v2.0 ISBN-bound licensed cover uploads
storeOperations.migrate(db); // v4.3 internal per-store tasks and activity audit
// Register the future educational category, not fictitious book records.
if(!db.prepare('SELECT id FROM book_categories WHERE name=?').get('کمک‌درسی و کنکور')) {
 db.prepare('INSERT INTO book_categories(name,slug,active) VALUES(?,?,1)').run('کمک‌درسی و کنکور','educational-books');
}
pdfStore.migrate(db); // v4.4 private licensed digital inventory
pdfRights.migrate(db); // v4.6 suspend/renew digital distribution permissions
contentBatch.migrate(db); // v4.5 sourced metadata completion
digitalEntitlements.migrate(db); // Verified-payment gated private PDF delivery; issuance remains disconnected
digitalPayments.migrate(db); // v4.9 per-store payment readiness and integration-only intent ledger
bibliographicReviewV83.migrate(db); // v8.3 non-destructive manual evidence review and immutable history
const PDF_DIR=path.join(DATA_DIR,'digital-pdfs');fs.mkdirSync(PDF_DIR,{recursive:true,mode:0o700});
const PRIVATE_DOC_DIR=path.join(DATA_DIR,'store-documents');fs.mkdirSync(PRIVATE_DOC_DIR,{recursive:true,mode:0o700});
const DOC_KINDS={business_license:'پروانه کسب',identity:'مدرک هویتی',address:'مدرک محل کسب',other:'سایر مدارک'};
const REVIEW_LABELS={unverified:'هنوز بررسی نشده',submitted:'در انتظار بررسی YM',approved:'تأیید داخلی YM',rejected:'نیازمند اصلاح'};
function storeRole(user){return user?.role==='owner'?'owner':user?.staff_permission||'manager';}
function managerOf(user,storeId){return Boolean(user&&((user.role==='owner')||(user.role==='seller'&&user.store_id===storeId&&storeRole(user)==='manager')));}
function readStore(user,storeId){return Boolean(user&&(user.role==='owner'||user.role==='seller'&&user.store_id===storeId));}
function writeInventory(user,storeId){return readStore(user,storeId)&&storeRole(user)!=='viewer';}
function safeId(v){const n=Number(v);return Number.isSafeInteger(n)&&n>0?n:0;}
function kindLabel(k){return DOC_KINDS[k]||'نامشخص';}
function validatePrivateDoc(file){
 if(!file||!Buffer.isBuffer(file.data)||file.data.length<16||file.data.length>710*1024)return null;
 const b=file.data;
 if(b.subarray(0,5).toString('ascii')==='%PDF-'&&b.lastIndexOf(Buffer.from('%%EOF'))>0)return {mime:'application/pdf',ext:'pdf'};
 if(b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return {mime:'image/png',ext:'png'};
 if(b[0]===255&&b[1]===216&&b[2]===255&&b[b.length-2]===255&&b[b.length-1]===217)return {mime:'image/jpeg',ext:'jpg'};
 return null;
}
const PUBLIC_REVIEW_SECRET=crypto.randomBytes(32);
const reviewAttempts=new Map();
const demoOrderAttempts=new Map();
function signedReviewToken(bookId){const ts=Date.now();const nonce=crypto.randomBytes(12).toString('hex');const raw=`${bookId}.${ts}.${nonce}`;return raw+'.'+crypto.createHmac('sha256',PUBLIC_REVIEW_SECRET).update(raw).digest('hex');}
function validReviewToken(bookId,token){if(typeof token!=='string'||token.length>170)return false;const match=token.match(/^(\d+)\.(\d{13})\.([a-f0-9]{24})\.([a-f0-9]{64})$/);if(!match||Number(match[1])!==bookId||Math.abs(Date.now()-Number(match[2]))>7200000)return false;
 const raw=match.slice(1,4).join('.');const expected=crypto.createHmac('sha256',PUBLIC_REVIEW_SECRET).update(raw).digest();return crypto.timingSafeEqual(Buffer.from(match[4],'hex'),expected);}
function reviewQuota(ip){const now=Date.now(),period=3600000;for(const [key,v] of reviewAttempts)if(now-v.first>period)reviewAttempts.delete(key);
 const old=reviewAttempts.get(ip);return !old||old.count<3;}
function bumpReviewQuota(ip){const now=Date.now();const old=reviewAttempts.get(ip);reviewAttempts.set(ip,old&&now-old.first<3600000?{first:old.first,count:old.count+1}:{first:now,count:1});}
const COVER_DIR=path.join(DATA_DIR,'covers');fs.mkdirSync(COVER_DIR,{recursive:true,mode:0o700});
const BANNER_DIR=path.join(DATA_DIR,'banners');fs.mkdirSync(BANNER_DIR,{recursive:true,mode:0o700});
// First *local* installation only: requested temporary login. Existing sites retain all their accounts.
const ownerAbsent = db.prepare("SELECT count(*) AS n FROM users WHERE role='owner'").get().n === 0;
const localFirstRun = !process.env.PUBLIC_URL && ['127.0.0.1','localhost','::1'].includes(HOST);
if (ownerAbsent && localFirstRun) {
  db.exec('BEGIN IMMEDIATE');
  try {
    if (!db.prepare('SELECT id FROM stores LIMIT 1').get()) {
      db.prepare('INSERT INTO stores(name,slug,city,active) VALUES(?,?,?,1)').run('کتاب‌فروشی همکار','store-1','یزد');
    }
    db.prepare("INSERT INTO users(username,password_hash,role,must_change_password) VALUES(?,?,'owner',1)")
      .run('admin',hashPassword('ad123456789'));
    db.exec('COMMIT');
  } catch(e) { db.exec('ROLLBACK'); throw e; }
}
const initialToken = db.prepare("SELECT count(*) AS n FROM users WHERE role='owner'").get().n === 0
  ? crypto.randomBytes(16).toString('hex') : null;

function esc(x='') { return String(x ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function attr(x='') {return esc(x);}
function money(x){return x == null ? 'ناموجود' : new Intl.NumberFormat('fa-IR').format(x)+' تومان';}
function digits(x){return new Intl.NumberFormat('fa-IR').format(x);}
function str(x,max=200){return String(x??'').trim().slice(0,max);}
function sha(s){return crypto.createHash('sha256').update(s).digest('hex');}
function hashPassword(p,salt=crypto.randomBytes(16).toString('hex')){return salt+':'+crypto.scryptSync(p,salt,64).toString('hex');}
function verifyPassword(p,stored){if(typeof stored!=='string'||!stored.includes(':'))return false; const [salt,h]=stored.split(':'); const a=Buffer.from(h,'hex');if(a.length!==64)return false;return crypto.timingSafeEqual(crypto.scryptSync(p,salt,64),a);}
function cookies(req){const out={};for(const part of String(req.headers.cookie||'').split(';')){const i=part.indexOf('=');if(i<1)continue;try{const k=decodeURIComponent(part.slice(0,i).trim());const v=decodeURIComponent(part.slice(i+1).trim());if(k==='varaq_sid')out[k]=v;}catch{/* A malformed cookie must never crash the request. */}}return out;}
function actor(req){const token=cookies(req).varaq_sid;if(!token||!/^[a-f0-9]{64}$/.test(token))return null;
 const s=db.prepare('SELECT u.id,u.username,u.role,u.store_id,u.must_change_password,u.enabled,u.staff_permission,s.csrf,s.expires_at FROM sessions s JOIN users u ON s.user_id=u.id WHERE s.token_hash=? AND u.enabled=1').get(sha(token));
 return s&&s.expires_at>Date.now()?s:null;}
function appendCookie(res,val){res.setHeader('Set-Cookie',`varaq_sid=${val}; HttpOnly; Path=/; SameSite=Lax; ${PUBLIC_URL.startsWith('https://')?'Secure; ':''}Max-Age=${val?604800:0}`);}
function sessionCreate(res,userId){const token=crypto.randomBytes(32).toString('hex'); const csrf=crypto.randomBytes(24).toString('hex');
 db.prepare('INSERT INTO sessions(token_hash,user_id,csrf,expires_at) VALUES(?,?,?,?)').run(sha(token),userId,csrf,Date.now()+7*86400000);appendCookie(res,token);}
function query(url){return new URL(url, PUBLIC_URL);}
function fields(s){return Object.fromEntries(new URLSearchParams(s));}
function body(req,limit=MAX_POST_BYTES){return new Promise((resolve,reject)=>{let data='';let size=0;req.on('data',chunk=>{size+=chunk.length;if(size>limit){reject(Object.assign(new Error('POST_TOO_LARGE'),{code:413}));req.destroy();return;}data+=chunk.toString('utf8');});req.on('end',()=>resolve(fields(data)));req.on('error',reject);});}
function redirect(res,loc){res.writeHead(303,{Location:loc});res.end();}
function send(res,code,text,type='text/html; charset=utf-8',headers={}){res.writeHead(code,{'Content-Type':type,'Cache-Control':'no-store',...headers});res.end(text);}
function audit(user,action,resource){db.prepare('INSERT INTO audit_log(user_id,action,resource) VALUES(?,?,?)').run(user?.id??null,action,resource);}
function csrfCheck(req,user,form){return !!user&&typeof form.csrf==='string'&&form.csrf.length>0&&crypto.timingSafeEqual(Buffer.from(form.csrf.padEnd(64,' ').slice(0,64)),Buffer.from(user.csrf.padEnd(64,' ').slice(0,64)));}
function categoryNames(){return db.prepare('SELECT name FROM book_categories WHERE active=1 ORDER BY name').all().map(x=>x.name);}
function categoryRecord(slug){return db.prepare('SELECT * FROM book_categories WHERE slug=? AND active=1').get(slug);}
function categoryFilter(name){const row=db.prepare('SELECT id FROM book_categories WHERE name=?').get(name);if(!row)return [name];const all=db.prepare('SELECT id,name,parent_id FROM book_categories').all();const ids=new Set([row.id]);let changed=true;while(changed){changed=false;for(const c of all)if(ids.has(c.parent_id)&&!ids.has(c.id)){ids.add(c.id);changed=true;}}return all.filter(x=>ids.has(x.id)).map(x=>x.name);}
function coverInfo(bookId){return db.prepare('SELECT filename,mime,alt,source,rights_note FROM book_covers WHERE book_id=?').get(bookId);}
const checkedCovers=new Map();
function localCoverExists(filename){
 if(!/^[a-f0-9]{32}\.(?:jpg|png|webp)$/.test(String(filename||'')))return false;
 try{
  const stat=fs.lstatSync(path.join(COVER_DIR,filename));
  if(!stat.isFile()||stat.isSymbolicLink())return false;
  const key=filename+':'+stat.mtimeMs+':'+stat.size;
  const cached=checkedCovers.get(filename);if(cached&&cached.key===key)return cached.ok;
  const ext=filename.slice(filename.lastIndexOf('.')+1),mime={jpg:'image/jpeg',png:'image/png',webp:'image/webp'}[ext];
  const ok=mediaIntegrity.checkCover(COVER_DIR,filename,mime).state==='ok';
  if(checkedCovers.size>1000)checkedCovers.clear();
  checkedCovers.set(filename,{key,ok});return ok;
 }catch{return false;}
}
function availableEditionCover(e){
 const result=editionDetail.publicCoverUrl(e);
 if(result.startsWith('/media/covers/')&&!localCoverExists(e.filename))return e.rights_confirmed===1&&e.cover_matched===1?editionDetail.trustworthySource(e.cover_url):'';
 return result;
}
function palette(i){return ['c0','c1','c2','c3','c4','c5','c6','c7'][Math.abs(Number(i)||0)%8];}
function bookArt(b,large=false){
 // Purposefully not an invented book cover: this is a catalog card for titles whose *real* cover is unavailable.
 const theme=palette(b.id);
 return `<div class="varaq-catalog-art ${theme} ${large?'bigcover':''}" role="img" aria-label="نمایه اطلاعاتی کتاب ${attr(b.title)}، تصویر جلد واقعی موجود نیست">
   <span class="catalog-art-corner" aria-hidden="true">و<span>VARAQ</span></span>
   <span class="catalog-art-category">${esc(b.category||'کتاب')}</span>
   <span class="catalog-art-ornament" aria-hidden="true">✦</span>
   <strong class="catalog-art-title">${esc(b.title)}</strong>
   ${b.author?`<span class="catalog-art-author">${esc(b.author)}</span>`:''}
   <span class="catalog-art-disclaimer">نمایه کتاب · نه تصویر جلد اصلی</span>
 </div>`;
}
// Original concept-art is separate from verified publisher covers and never counted as such.
const AI_COVER_PROGRESS=require('./lib/generated-cover-progress').load(ROOT,require('./data/books.json'));
const NEW_SCENIC_COVER_IDS_V988 = new Set([21,22,23,24,25,...AI_COVER_PROGRESS.keys()]);
function conceptArt(b,large=false,priority=false){
 const entry=generatedTextById.get(b.id);
 if(!entry||entry.title!==b.title)return bookArt(b,large);
 const n=String(b.id).padStart(3,'0');
 const full=path.join(STATIC,'concept-art',`book-${n}.webp`);
 const thumbnail=path.join(STATIC,'concept-thumb',`book-${n}.webp`);
 if(!fs.existsSync(full))return bookArt(b,large);
 const thumbAvailable=fs.existsSync(thumbnail);
 // Only a single prominent image is marked high-priority. Cards always use small local thumbnails.
 const coverVersion=AI_COVER_PROGRESS.get(b.id)?.version||988;
  const src=large||!thumbAvailable?`/concept-art/book-${n}.webp?v=${coverVersion}`:`/concept-thumb/book-${n}.webp?v=${coverVersion}`;
 return `<div class="cover-image-frame varaq-concept-cover ${large?'bigcover':''}"><img class="uploaded-cover" src="${src}" alt="${attr(NEW_SCENIC_COVER_IDS_V988.has(b.id)?'تصویر داستانی اختصاصی ورق برای ' + b.title + '، جلد رسمی ناشر نیست':'تصویر مفهومی نیازمند بازطراحی برای ' + b.title + '، جلد رسمی ناشر نیست')}" loading="${large||priority?'eager':'lazy'}" decoding="async" ${priority?'fetchpriority="high"':''} width="${large?480:240}" height="${large?672:336}"><span class="varaq-concept-credit">${NEW_SCENIC_COVER_IDS_V988.has(b.id)?'تصویرسازی داستانی ورق · نه جلد ناشر':'طرح مفهومی · در صف بازطراحی'}</span></div>`;
}
function cover(b,large=false,priority=false){
 if(AI_COVER_PROGRESS.get(b.id)?.title===b.title)return conceptArt(b,large,priority);
 const matchedEdition=editionCover.forBook(db,b.id);
 if(matchedEdition&&localCoverExists(matchedEdition.filename))return `<div class="cover-image-frame ${large?'bigcover':''}"><img class="uploaded-cover" src="/media/covers/${attr(matchedEdition.filename)}" alt="${attr(matchedEdition.alt)}" loading="${large||priority?'eager':'lazy'}" decoding="async" ${priority?'fetchpriority="high"':''} width="320" height="440"></div>`;
 const uploaded=coverInfo(b.id);
 if(uploaded&&localCoverExists(uploaded.filename))return `<div class="cover-image-frame ${large?'bigcover':''}"><img class="uploaded-cover" src="/media/covers/${attr(uploaded.filename)}" alt="${attr(uploaded.alt||'جلد واقعی کتاب '+b.title)}" loading="${large||priority?'eager':'lazy'}" decoding="async" ${priority?'fetchpriority="high"':''} width="320" height="440"></div>`;
 const source=bibliography.getCover(db,b.id,IS_PUBLIC);
 if(source)return `<div class="cover-image-frame ${large?'bigcover':''}"><img class="uploaded-cover external-cover" src="${attr(source.cover_url)}" alt="تصویر چاپ مرتبط با ${attr(b.title)} از منبع ثبت‌شده" loading="${large||priority?'eager':'lazy'}" decoding="async" ${priority?'fetchpriority="high"':''} referrerpolicy="no-referrer" width="320" height="440"><div class="cover-art-on-error">${conceptArt(b,large)}</div></div>`;
 return conceptArt(b,large,priority);
}
const storefrontUi=require('./lib/storefront-ui');
function navLink(url,label,active){return `<a class="${active?'active':''}" href="${url}">${label}</a>`;}
function page({title='ورق | مرجع کتاب',description='معرفی، بررسی و جست‌وجوی کتاب‌ها و فروشگاه‌های همکار',content='',user=null,reqUrl='/',extraHead='',statusNotice='',pageNonce=''}){
 const fullTitle=title.includes('ورق')?title:`${title} | ورق`;
 const requestUrl=query(reqUrl);const pageNo=Number(requestUrl.searchParams.get('page'));
 const canonicalQuery=((requestUrl.pathname==='/books'||requestUrl.pathname==='/authors'||requestUrl.pathname==='/publishers'||/^\/(?:authors|publishers)\/[^/]+$/.test(requestUrl.pathname))&&pageNo>1&&Number.isInteger(pageNo)&&pageNo<=10000&&![...requestUrl.searchParams.keys()].some(k=>k!=='page'))?'?page='+pageNo:'';
 const canonical=PUBLIC_URL+requestUrl.pathname+canonicalQuery;
 const filteredCatalog=(requestUrl.pathname==='/books'&&['q','category','publisher','author','sort','cover'].some(k=>requestUrl.searchParams.has(k))) || (requestUrl.pathname==='/pdf-books'&&[...requestUrl.searchParams.keys()].length>0) || (requestUrl.pathname==='/educational'&&[...requestUrl.searchParams.keys()].length>0) || requestUrl.pathname==='/educational/compare' || (['/authors','/publishers'].includes(requestUrl.pathname)&&[...requestUrl.searchParams.keys()].some(k=>k!=='page'));
 const privatePage=(requestUrl.pathname==='/themes'||requestUrl.pathname==='/books/compare'||requestUrl.pathname==='/choose-format')||(requestUrl.pathname.endsWith('/sheet')||requestUrl.pathname.endsWith('/read'))||/^\/(panel(?:\/|$)|login$|logout$|setup$|cart$|saved$|demo-order(?:\/|$))/.test(requestUrl.pathname);
 const thinBook=IS_PUBLIC&&requestUrl.pathname.startsWith('/book/')&&!seo.indexableBook(db,decodeURIComponent(requestUrl.pathname.slice(6)));
 const sparseProfile=IS_PUBLIC&&(/^\/authors\//.test(requestUrl.pathname)||/^\/publishers\//.test(requestUrl.pathname))&&!seo.indexableProfile(db,requestUrl.pathname.startsWith('/authors/')?'author':'publisher',decodeURIComponent(requestUrl.pathname.split('/').slice(2).join('/')));
 const sparseCategory=IS_PUBLIC&&requestUrl.pathname.startsWith('/category/')&&!(function(){const c=categoryRecord(decodeURIComponent(requestUrl.pathname.slice(10)));return c&&seo.indexableCategory(db,c.name);})();
 const excessivePagination=IS_PUBLIC&&requestUrl.pathname==='/books'&&pageNo>1&&(!Number.isInteger(pageNo)||pageNo>Math.ceil(db.prepare('SELECT count(*) n FROM books').get().n/24));
 const robotsMeta=(!INDEXING_ENABLED||privatePage?'noindex,nofollow':filteredCatalog||thinBook||sparseProfile||sparseCategory||excessivePagination?'noindex,follow':null);
 const metaSocial=seo.openGraph({title:fullTitle,description,canonical,type:requestUrl.pathname.startsWith('/book/')?'book':'website'});
 const homeSchema=requestUrl.pathname==='/'&&pageNonce?seo.siteSchema(PUBLIC_URL):'';
 return `<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#173e35"><title>${esc(fullTitle)}</title><meta name="description" content="${attr(description)}"><link rel="canonical" href="${attr(canonical)}">${metaSocial}${homeSchema.replace(/__NONCE__/g, pageNonce)}<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Vazirmatn:wght@400;500;600;700;800;900&display=swap"><link rel="stylesheet" href="${ASSET_URLS.style}"><script defer src="${ASSET_URLS.app}"></script>${robotsMeta?`<meta name="robots" content="${robotsMeta}">`:''}${extraHead}</head><body>
 <a href="#main-content" class="skip-link">رفتن به محتوای اصلی</a>
 <div class="topline">کتاب‌ها را بهتر بشناس، آگاهانه انتخاب کن ✦ <b>${PUBLIC_READONLY?'نسخه اطلاعاتی ورق؛ سفارش و پرداخت غیرفعال است':'پنل فروشگاه‌ها فعال؛ پرداخت آنلاین هنوز متصل نشده است'}</b></div>
 <header class="header"><div class="shell header-in"><a class="brand" href="/"><span class="mark">و</span><span class="brand-text">ورق<small>کتاب، کشف، انتخاب</small></span></a><form class="search" action="/books" method="GET"><span aria-hidden="true">⌕</span><input name="q" type="search" placeholder="نام کتاب، نویسنده یا موضوع را جست‌وجو کن…" value="${attr(query(reqUrl).searchParams.get('q')||'')}" aria-label="جست‌وجوی کتاب"><button type="submit">جست‌وجو</button></form><nav class="head-actions">${marketGateway.enabled&&!IS_PUBLIC?'<a href="/market/" class="simple-btn">🛒 <span>فروشگاه و خرید</span></a>':''}<a href="/saved" class="simple-btn shelf-link" aria-label="کتاب‌های نشان‌شده">♡ <span>نشان‌شده <b class="shelf-count">۰</b></span></a>${marketGateway.enabled&&!IS_PUBLIC?'<a href="/market/cart" class="simple-btn">🛒 <span>سبد خرید</span></a>':PUBLIC_READONLY?'':'<a href="/cart" class="simple-btn">🛒 <span>سبد <b class="cart-count">۰</b></span></a>'}<a href="${user?'/panel':initialToken&&!db.prepare("SELECT id FROM users WHERE role=\'owner\'").get()?'/setup':'/login'}" class="simple-btn dark">${user?'پنل مدیریت':initialToken&&!db.prepare("SELECT id FROM users WHERE role=\'owner\'").get()?'راه‌اندازی اولیه':'ورود فروشنده'}</a></nav></div></header>
 <div class="mobile-menu-row"><button class="mobile-menu-toggle" type="button" aria-controls="site-main-nav" aria-expanded="false" aria-label="بازکردن منوی بخش‌های سایت">☰ <span>دسته‌بندی‌ها و بخش‌ها</span></button><a href="/saved" class="mobile-shelf-link">♡ کتاب‌های من</a></div><div class="mobile-nav-backdrop" aria-hidden="true"></div><nav class="nav" id="site-main-nav" aria-label="ناوبری اصلی"><div class="mobile-nav-heading"><strong>فهرست ورق</strong><button class="mobile-nav-close" type="button" aria-label="بستن منو">×</button></div><div class="shell nav-list">${navLink('/','خانه',reqUrl==='/')}${marketGateway.enabled&&!IS_PUBLIC?navLink('/market/','فروشگاه کتاب',reqUrl.startsWith('/market')):''}${navLink('/books','همه کتاب‌ها',reqUrl==='/books')}${navLink('/books-300','مجموعه اختصاصی',reqUrl.startsWith('/books-300'))}${navLink('/themes','کشف موضوعی',reqUrl.startsWith('/themes'))}${navLink('/choose-format','راهنمای انتخاب نسخه',reqUrl.startsWith('/choose-format'))}${navLink('/books/compare','مقایسه کتاب‌ها',reqUrl.startsWith('/books/compare'))}${navLink('/pdf-books','کتاب‌های PDF',reqUrl.startsWith('/pdf-books'))}${navLink('/stores','کتاب‌فروشی‌ها',reqUrl.startsWith('/stores'))}${navLink('/authors','نویسندگان',reqUrl.startsWith('/authors'))}${navLink('/publishers','ناشران',reqUrl.startsWith('/publishers'))}${navLink('/books?category='+encodeURIComponent('کودک و نوجوان'),'کودک و نوجوان',false)}${navLink('/books?category='+encodeURIComponent('روانشناسی و رشد فردی'),'روان‌شناسی',false)}${navLink('/educational','کمک‌درسی و کنکور',reqUrl.startsWith('/educational'))}${navLink('/about','درباره ورق',reqUrl.startsWith('/about'))}</div></nav><nav class="mobile-bottom-nav" aria-label="دسترسی سریع موبایل"><a href="/" ${requestUrl.pathname==='/'?'aria-current="page"':''}><span aria-hidden="true">⌂</span><small>خانه</small></a><a href="/books" ${requestUrl.pathname==='/books'?'aria-current="page"':''}><span aria-hidden="true">▤</span><small>کتاب‌ها</small></a><a href="/choose-format" ${requestUrl.pathname==='/choose-format'?'aria-current="page"':''}><span aria-hidden="true">◫</span><small>نوع نسخه</small></a><a href="/saved" ${requestUrl.pathname==='/saved'?'aria-current="page"':''}><span aria-hidden="true">♡</span><small>نشان‌شده <b class="shelf-count">۰</b></small></a>${marketGateway.enabled&&!IS_PUBLIC?'<a href="/market/cart"><span aria-hidden="true">▣</span><small>سبد خرید</small></a>':PUBLIC_READONLY?'':`<a href="/cart" ${requestUrl.pathname==='/cart'?'aria-current="page"':''}><span aria-hidden="true">▣</span><small>سبد <b class="cart-count">۰</b></small></a>`}</nav>
 ${statusNotice?`<div class="flash">${esc(statusNotice)}</div>`:''}<main id="main-content" tabindex="-1">${content}</main><footer class="footer"><div class="shell footer-inner"><div><div class="footer-brand">ورق <span>✦</span></div><p>مرجع بررسی و کشف کتاب و بستری برای همکاری کتاب‌فروشی‌ها. از زیرمجموعه‌های نرم‌افزاری گروه YM.</p></div><div><b>دسترسی سریع</b><a href="/books">فهرست کتاب‌ها</a><a href="/themes">کشف موضوعی</a><a href="/choose-format">راهنمای چاپی یا PDF</a><a href="/books/compare">مقایسه کتاب‌ها</a><a href="/pdf-books">کتاب‌های PDF</a><a href="/stores">فروشگاه‌ها</a><a href="/about">درباره ما</a></div><div><b>قوانین</b><a href="/privacy">حریم خصوصی</a><a href="/terms">شرایط استفاده</a><a href="/login">ورود فروشندگان</a></div></div><div class="shell copyright">© ${new Date().getFullYear()} Varaq / YM · این سایت در مرحله آماده‌سازی فروش اینترنتی است.</div></footer></body></html>`;
}
const BOOK_CARD_STOCK=db.prepare(`SELECT i.id,i.price FROM stock_items i JOIN stores s ON s.id=i.store_id LEFT JOIN editions e ON e.id=i.edition_id WHERE i.book_id=? AND i.active=1 AND i.quantity>0 AND i.price>0 AND s.active=1 AND (i.edition_id IS NULL OR e.verified=1) LIMIT 100`);
function bookCard(b, quickCompare=false){
 // Array.map(bookCard) also passes an index. Only explicit boolean true enables the checkbox.
 quickCompare=quickCompare===true;
 const stockRows=marketGateway.enabled?[]:BOOK_CARD_STOCK.all(b.id);
 const prices=stockRows.map(o=>promotions.priceFor(db,o.id,o.price));const min=prices.length?Math.min(...prices.map(p=>p.price)):null;
 const best=min!=null?money(min):'اطلاعات کتاب';
 const picture=cover(b);const isConceptPicture=picture.includes('varaq-concept-cover');const hasPicture=picture.includes('cover-image-frame')&&!isConceptPicture;
 const href='/book/'+encodeURIComponent(b.slug);
 return `<article class="book-card book-card-v48"><div class="book-cover-wrap"><a href="${href}" class="cover-link" aria-label="مشاهده مشخصات ${attr(b.title)}">${picture}</a>${hasPicture?'<span class="v48-cover-status has-picture">تصویر جلد</span>':isConceptPicture?`<span class="v48-cover-status varaq-concept-status">${NEW_SCENIC_COVER_IDS_V988.has(b.id)?'تصویر داستانی':'نیازمند بازطراحی'}</span>`:''}<button type="button" class="save-book save-book-card" aria-pressed="false" aria-label="نشان‌کردن کتاب ${attr(b.title)}" data-book-slug="${attr(b.slug)}" data-book-title="${attr(b.title)}" data-book-author="${attr(b.author||'')}" data-book-category="${attr(b.category)}">♡</button></div><div class="v48-book-copy">${quickCompare?`<label class="v71-compare-choice"><input type="checkbox" name="book" value="${attr(b.slug)}" aria-label="انتخاب ${attr(b.title)} برای مقایسه"><span>مقایسه این کتاب</span></label>`:''}<div class="v68-card-kickers"><span class="v68-format-badge">کتاب چاپی · معرفی</span><span class="small-tag">${esc(b.category)}</span></div><a href="${href}" class="book-name">${esc(b.title)}</a><div class="book-author">${esc(b.author||'نویسنده در حال تکمیل')}</div>${generatedIntro(b)?`<p class="varaq-card-intro">${esc(b.description||generatedIntro(b))}</p>`:''}<div class="v68-card-actions"><a href="${href}/read" class="v68-card-read" aria-label="مطالعه معرفی ${attr(b.title)}">خواندن معرفی</a><a href="${href}" class="v68-card-detail" aria-label="مشاهده مشخصات ${attr(b.title)}">مشخصات ←</a><a href="/choose-format?book=${encodeURIComponent(b.slug)}" class="v75-card-formats" aria-label="بررسی نسخه‌های چاپی و PDF کتاب ${attr(b.title)}">چاپی یا PDF؟</a></div><div class="card-foot"><div class="card-price"><small>${min!=null?'قیمت ثبت‌شده از':'معرفی و اطلاعات'}</small><strong>${esc(best)}</strong></div>${marketGateway.enabled?`<a class="circle-arrow" href="/market/legacy-book/${encodeURIComponent(b.id)}" aria-label="بررسی عرضه در فروشگاه ${attr(b.title)}">🛒</a>`:`<a class="circle-arrow" href="${href}" aria-label="جزئیات ${attr(b.title)}">←</a>`}</div></div></article>`;}
function homeBanners(placement){const rows=homeCms.listBanners(db,placement,true);if(!rows.length)return '';
 return `<section class="home-promos" aria-label="پیشنهادهای ویژه"><div class="home-promo-grid">${rows.map(b=>`<article class="home-promo ${b.filename?'with-image':''}">${b.filename?`<div class="home-promo-art"><img src="/media/banners/${attr(b.filename)}" alt="${attr(b.image_alt||b.title)}" loading="lazy" width="900" height="540"></div>`:''}<div class="home-promo-copy"><span class="home-promo-tag">جایگاه ویژه / تبلیغ</span><h2>${esc(b.title)}</h2>${b.summary?`<p>${esc(b.summary)}</p>`:''}${b.label?`<a href="${attr(b.href)}">${esc(b.label)} ←</a>`:''}</div></article>`).join('')}</div></section>`;
}
function hero(){const c=homeCms.homepage(db);return `<div class="hero hero-v14"><div class="hero-copy"><span class="eyebrow">${esc(c.eyebrow)} <span aria-hidden="true">✦</span></span><h1>${esc(c.hero_title)}<br><em>${esc(c.hero_accent)}</em></h1><p>${esc(c.hero_description)}</p><div class="hero-buttons"><a class="cta" href="${attr(c.primary_href)}">${esc(c.primary_label)} ←</a><a class="outline" href="${attr(c.secondary_href)}">${esc(c.secondary_label)}</a></div></div><div class="hero-art hero-real-covers" aria-label="وضعیت تصویر جلد کتاب‌های نمونه">${[1,5,40].map((id,i)=>{const bb=db.prepare('SELECT * FROM books WHERE id=?').get(id);return bb?`<a class="hero-real-cover cover-pos-${i}" href="/book/${encodeURIComponent(bb.slug)}" aria-label="${attr(bb.title)}">${cover(bb,false,i===0)}</a>`:'';}).join('')}<div class="art-note">۱۰۰۰ عنوان منتخب · کتاب‌ها را کشف کن</div></div></div>`;}
function completedBooks(){
 return db.prepare('SELECT * FROM books WHERE id<=300 ORDER BY id').all().filter(b=>exclusiveFor(b)&&AI_COVER_PROGRESS.get(b.id)?.title===b.title);
}
function completedCollection(url){
 const all=completedBooks(),pages=Math.max(1,Math.ceil(all.length/24));
 const page=Math.min(pages,Math.max(1,Math.floor(Number(url.searchParams.get('page'))||1)));
 const rows=all.slice((page-1)*24,page*24);
 return `<div class="shell main"><div class="page-banner"><span class="eyebrow">مجموعه اختصاصی ورق</span><h1>${digits(all.length)} کتاب با تصویر، معرفی و خلاصه اختصاصی</h1><p>برای هر عنوان، معرفی کوتاه و خلاصه جداگانه در صفحه کتاب آماده است. تصویرسازی‌ها برداشت اختصاصی ورق از اثر هستند؛ جلد رسمی ناشر نیستند.</p><a class="outline" href="/books">همه عنوان‌های کتابخانه</a></div><div class="book-grid">${rows.map(bookCard).join('')}</div><nav class="pagination" aria-label="صفحه‌های مجموعه اختصاصی">${page>1?`<a href="/books-300?page=${page-1}">صفحه قبل</a>`:''}<span>صفحه ${digits(page)} از ${digits(pages)}</span>${page<pages?`<a href="/books-300?page=${page+1}">صفحه بعد</a>`:''}</nav></div>`;
}
function home(){const c=homeCms.homepage(db);const top=db.prepare(`SELECT b.*, MIN(CASE WHEN o.active=1 AND o.quantity>0 AND (o.edition_id IS NULL OR e.verified=1) AND s.active=1 THEN o.price END) AS price FROM books b LEFT JOIN stock_items o ON o.book_id=b.id LEFT JOIN editions e ON e.id=o.edition_id LEFT JOIN stores s ON s.id=o.store_id GROUP BY b.id ORDER BY b.id LIMIT 12`).all();const count=db.prepare('SELECT COUNT(*) n FROM books').get().n;const live=db.prepare('SELECT COUNT(*) n FROM stores WHERE active=1').get().n;
return `<div class="shell main">${hero()}<section class="v990-collection"><div><h2>${digits(completedBooks().length)} کتاب؛ تصویر، معرفی و خلاصه اختصاصی</h2><p>مجموعه آماده برای کشف داستان‌ها و ایده‌های کتاب‌ها.</p></div><a class="cta" href="/books-300">دیدن مجموعه اختصاصی ←</a></section><section class="v75-start" aria-labelledby="v75-start-title"><div class="v75-start-head"><div><span class="section-kicker">مسیر کوتاه انتخاب کتاب</span><h2 id="v75-start-title">می‌خوای از کجا شروع کنی؟</h2></div><p>بدون ثبت‌نام یا ورود به سبد، اول کتاب مناسب را پیدا کن و نسخه‌ها را بررسی کن.</p></div><div class="v75-start-grid"><a href="/books" class="v75-start-option"><span aria-hidden="true">⌕</span><strong>پیداکردن کتاب</strong><small>عنوان، نویسنده، ناشر و موضوع را جست‌وجو کن</small><em>رفتن به کتابخانه ←</em></a><a href="/themes" class="v75-start-option"><span aria-hidden="true">✧</span><strong>کشف بر اساس علاقه</strong><small>موضوعات مرتبط با کتاب‌های همین بانک را ببین</small><em>مرور موضوعات ←</em></a><a href="/pdf-books" class="v75-start-option"><span aria-hidden="true">▤</span><strong>شناخت نسخه‌های PDF</strong><small>فایل‌های دارای مجوز معرفی را ببین؛ خرید فعلاً بسته است</small><em>رفتن به ویترین PDF ←</em></a></div></section><section class="v48-format-section" aria-label="مرور بر اساس نوع کتاب"><div class="v48-section-label"><strong>چه نوع کتابی دنبال می‌کنی؟</strong><span>از نسخه چاپی تا کتاب دیجیتال</span></div>${storefrontUi.formatNavigation('home')}<div class="v70-guide-banner"><span>چاپی یا دیجیتال؟ تفاوت نسخه‌ها، مجوز PDF و وضعیت فروشنده را بررسی کن.</span><a href="/choose-format">راهنمای انتخاب نسخه ←</a></div>${storefrontUi.availabilityNotice()}</section><section class="varaq-home-themes" aria-label="کشف کتاب بر اساس موضوع"><div class="v48-section-label"><strong>با یک موضوع شروع کن</strong><a href="/themes">همه موضوع‌ها ←</a></div><div class="varaq-theme-chips">${topicDiscovery.themes(db.prepare('SELECT id,title FROM books').all(),generatedTextById,entry=>generatedReview.record(db,entry).status==='hidden').slice(0,8).map(x=>`<a class="varaq-theme-chip" href="/themes?topic=${encodeURIComponent(x.topic)}">${esc(x.topic)} <small>${digits(x.count)} عنوان</small></a>`).join('')}</div></section>${homeBanners('after_hero')}${c.show_trust?`<div class="v14-trust-strip" aria-label="ویژگی‌های ورق"><div><span>◇</span><b>اطلاعات کتاب‌شناختی</b><small>چاپ‌ها و ترجمه‌های بررسی‌شده</small></div><div><span>◈</span><b>فروشگاه‌های مستقل</b><small>قیمت و موجودی جداگانه</small></div><div><span>♡</span><b>فهرست مطالعه شخصی</b><small>نشان‌کردن کتاب بدون حساب کاربری</small></div></div>`:''}<div class="stats"><div><b>${digits(count)}+</b><span>عنوان در بانک کتاب</span></div><div><b>${digits(categoryNames().length)}</b><span>دسته‌بندی تخصصی</span></div><div><b>${digits(live)}</b><span>فروشگاه همکار</span></div><div><b>۰</b><span>درگاه فعال در حال حاضر</span></div></div>${c.show_categories?`<section class="section"><div class="section-heading"><div><span class="section-kicker">COLLECTIONS</span><h2>از کجا شروع کنیم؟</h2></div><a href="/books">همه دسته‌بندی‌ها ←</a></div><div class="category-grid">${[['رمان و ادبیات جهان','📖'],['روانشناسی و رشد فردی','🧠'],['کودک و نوجوان','🪁'],['فلسفه و تاریخ','🏺'],['علم و فناوری','🔭'],['کمک‌درسی و کنکور','🎓']].map(([cat,ico],i)=>`<a class="category-tile cat${i}" href="${cat==='کمک‌درسی و کنکور'?'/educational':'/books?category='+encodeURIComponent(cat)}"><span>${ico}</span><b>${esc(cat)}</b><small>دیدن کتاب‌ها ←</small></a>`).join('')}</div></section>`:''}${homeBanners('after_categories')}${c.show_selected?`<section class="section"><div class="section-heading"><div><span class="section-kicker">SELECTED BOOKS</span><h2>کتاب‌های منتخب برای شروع</h2></div><a href="/books">مشاهده تمام کتاب‌ها ←</a></div><div class="book-grid">${top.map(bookCard).join('')}</div></section>`:''}<div class="editorial"><span>بیش از یک فروشگاه، یک مرجع آگاهانه</span><h2>هر کتاب، یک صفحه برای کشف و شناخت</h2><p>معرفی آثار مستقل از موجودی فروشندگان است. مشخصات واقعی چاپ‌ها، نقدها و انتخاب نسخه مناسب به مرور تکمیل می‌شود.</p><a class="outline" href="/books">مرور کتابخانه</a></div></div>`;}
function catalog(url){
 const q=str(url.searchParams.get('q'),90),cat=str(url.searchParams.get('category'),100),pub=str(url.searchParams.get('publisher'),120),author=str(url.searchParams.get('author'),120);
 const sort=['relevance','title','author','newest'].includes(url.searchParams.get('sort'))?url.searchParams.get('sort'):'relevance';
 const coverStatus=['all','uploaded','missing'].includes(url.searchParams.get('cover'))?url.searchParams.get('cover'):'all';
 const pageNo=Math.max(1,Math.min(10000,Number(url.searchParams.get('page'))||1));const perPage=24;
 const result=discovery.search(db,{q,category:cat,categoryValues:cat?categoryFilter(cat):[],publisher:pub,author,sort,coverStatus,page:pageNo,perPage});
 const urlBase=new URLSearchParams();if(q)urlBase.set('q',q);if(cat)urlBase.set('category',cat);if(pub)urlBase.set('publisher',pub);if(author)urlBase.set('author',author);if(sort!=='relevance')urlBase.set('sort',sort);if(coverStatus!=='all')urlBase.set('cover',coverStatus);
 const hasFilters=Boolean(cat||pub||author||coverStatus!=='all');
 const openSearch=q&&hasFilters?discovery.search(db,{q,perPage:1,page:1}).total:0;
 const nearbyTitles=result.total===0&&q&&!openSearch?searchAssist.suggest(db,{q,limit:5}):[];
 const facets=result.total>0?discoveryFacets.get(db,{q,category:cat,categoryValues:cat?categoryFilter(cat):[],publisher:pub,author,coverStatus}):{categories:[],authors:[],limited:false};
 const facetLink=(key,value)=>{const params=new URLSearchParams(urlBase);params.set(key,value);params.delete('page');return '/books?'+params.toString();};
 const facetSection=result.total>0&&(facets.categories.length>1||facets.authors.length>0)?`<aside class="v74-discovery-refine" aria-label="پیشنهادهای تکمیلی فیلتر"><div class="v74-refine-heading"><strong>جست‌وجو را دقیق‌تر کن</strong><small>بر اساس اطلاعات کتاب‌های موجود؛ نه رتبه‌بندی یا محبوبیت</small></div>${facets.categories.length>1?`<div class="v74-refine-row"><span>دسته‌ها</span><div class="v74-refine-chips">${facets.categories.map(x=>`<a href="${attr(facetLink('category',x.value))}" ${cat===x.value?'aria-current="true"':''}>${esc(x.value)} <small>${digits(x.count)}</small></a>`).join('')}</div></div>`:''}${facets.authors.length?`<div class="v74-refine-row"><span>نویسندگان</span><div class="v74-refine-chips">${facets.authors.map(x=>`<a href="${attr(facetLink('author',x.value))}" ${author===x.value?'aria-current="true"':''}>${esc(x.value)} <small>${digits(x.count)}</small></a>`).join('')}</div></div>`:''}${facets.limited?'<small>این میانبرها بر اساس حداکثر ۵۰۰ نتیجه نخست هستند.</small>':''}</aside>`:'';
 const resetFilteredUrl='/books'+(q?'?q='+encodeURIComponent(q):'');
 const zeroResultHelp=result.total===0?`<section class="v73-search-help" aria-label="راهنمای جست‌وجو"><h3>راه‌های پیدا کردن کتاب</h3>${openSearch?`<p>کتاب‌های مطابق جست‌وجوی تو وجود دارند، اما فیلترهای انتخاب‌شده آن‌ها را پنهان کرده‌اند.</p><a class="outline" href="${attr(resetFilteredUrl)}">نمایش ${digits(openSearch)} نتیجه بدون فیلترهای اضافی</a>`:''}${nearbyTitles.length?`<p>شاید یکی از این عنوان‌های ثبت‌شده در کتابخانه را جست‌وجو می‌کردی:</p><div class="v73-suggestion-list">${nearbyTitles.map(b=>`<a href="/book/${encodeURIComponent(b.slug)}"><strong>${esc(b.title)}</strong>${b.author?`<small>${esc(b.author)}</small>`:''}</a>`).join('')}</div>`:''}<p class="v73-search-tip">می‌توانی املای عنوان را بررسی کنی، نام نویسنده را بنویسی یا فیلترها را حذف کنی. پیشنهادها فقط از کتاب‌های ثبت‌شده ساخته می‌شوند.</p></section>`:'';
 const filter=`<form class="filterbar discovery-filters" action="/books" method="GET"><label class="filter-field">جست‌وجوی کتاب<input name="q" type="search" value="${attr(q)}" placeholder="عنوان، نویسنده، ناشر، شابک…" maxlength="90"></label><label class="filter-field">موضوع<select name="category"><option value="">همه موضوعات</option>${categoryNames().map(c=>`<option value="${attr(c)}" ${cat===c?'selected':''}>${esc(c)}</option>`).join('')}</select></label><label class="filter-field">ناشر<input name="publisher" list="known-publishers" value="${attr(pub)}" maxlength="120" placeholder="همه ناشران"><datalist id="known-publishers">${discovery.publishers(db,{perPage:40}).rows.map(x=>`<option value="${attr(x.name)}"></option>`).join('')}</datalist></label><label class="filter-field">نویسنده<input name="author" list="known-authors" value="${attr(author)}" maxlength="120" placeholder="نام دقیق نویسنده"><datalist id="known-authors">${discovery.authors(db,{perPage:80}).rows.map(x=>`<option value="${attr(x.name)}"></option>`).join('')}</datalist></label><label class="filter-field">تصویر جلد<select name="cover">${[['all','همه کتاب‌ها'],['uploaded','با فایل جلد بارگذاری‌شده'],['missing','فاقد فایل جلد بارگذاری‌شده']].map(([v,label])=>`<option value="${v}" ${coverStatus===v?'selected':''}>${label}</option>`).join('')}</select></label><label class="filter-field">مرتب‌سازی<select name="sort">${[['relevance','مرتبط‌ترین'],['title','نام کتاب (الفبایی)'],['author','نام نویسنده'],['newest','تازه‌ترین افزوده‌ها']].map(([v,label])=>`<option value="${v}" ${v===sort?'selected':''}>${label}</option>`).join('')}</select></label><div class="discovery-actions"><button class="cta">نمایش نتایج</button><a class="reset" href="/books">پاک‌کردن</a></div></form>`;
 const activeFilters=[['q','جست‌وجو: '+q,q],['category','موضوع: '+cat,cat],['publisher','ناشر: '+pub,pub],['author','نویسنده: '+author,author],['sort','مرتب‌سازی: '+({'title':'الفبایی','author':'نویسنده','newest':'تازه‌ترین'}[sort]||''),sort!=='relevance'],['cover',coverStatus==='uploaded'?'با تصویر بارگذاری‌شده':'بدون تصویر بارگذاری‌شده',coverStatus!=='all']].filter(x=>x[2]);
 const chips=activeFilters.length?`<div class="catalog-active-filters" role="group" aria-label="فیلترهای انتخاب‌شده"><span>فیلترهای فعال</span>${activeFilters.map(([key,label])=>{const params=new URLSearchParams(urlBase);params.delete(key);const href='/books'+(params.toString()?'?'+params.toString():'');return `<a href="${attr(href)}" aria-label="حذف ${attr(label)}">${esc(label)} <span aria-hidden="true">×</span></a>`;}).join('')}<a href="/books" class="catalog-clear-all">حذف همه فیلترها</a></div>`:'';
 const title=q?`نتایج «${esc(q)}»`:cat?esc(cat):pub?`کتاب‌های ناشر «${esc(pub)}»`:'همه کتاب‌ها';
 const pagination=`<div class="pagination">${pageNo>1?`<a href="/books?${urlBase.toString()?urlBase.toString()+'&':''}page=${pageNo-1}" rel="prev">صفحه قبل</a>`:''}<span>صفحه ${digits(pageNo)} از ${digits(Math.max(1,Math.ceil(result.total/perPage)))}</span>${pageNo*perPage<result.total?`<a href="/books?${urlBase.toString()?urlBase.toString()+'&':''}page=${pageNo+1}" rel="next">صفحه بعد</a>`:''}</div>`;
 return `<div class="shell main"><div class="page-banner"><span class="eyebrow">OUR LIBRARY</span><h1>کتابخانه ورق</h1><p>جست‌وجوی فارسی در نام کتاب، نویسنده، موضوع، ناشر، مترجم و شابک چاپ‌های ثبت‌شده.</p><p class="tiny muted">فیلتر «با تصویر» فقط فایل‌های واقعی بارگذاری‌شده را نشان می‌دهد؛ نبود عکس به معنی نبود کتاب نیست.</p></div>${storefrontUi.formatNavigation('print')}<nav class="v75-catalog-shortcuts" aria-label="مسیرهای سریع کتابخانه"><span>شروع سریع:</span><a href="/themes">کشف موضوعی</a><a href="/authors">فهرست نویسندگان</a><a href="/pdf-books">معرفی PDFها</a><a href="/books/compare">مقایسه کتاب‌ها</a></nav><div class="catalog-filter-heading"><h2 id="catalog-filter-title">جست‌وجو و فیلتر کتاب‌ها</h2><a href="#book-results">دیدن نتایج ←</a></div><button type="button" class="catalog-filter-toggle" aria-controls="catalog-filter-panel" aria-expanded="true" data-active-filters="${activeFilters.length}"><span>فیلترها و مرتب‌سازی ${activeFilters.length?'· '+digits(activeFilters.length)+' فعال':''}</span><span class="catalog-filter-toggle-icon" aria-hidden="true">⌄</span></button><div class="catalog-filter-panel" id="catalog-filter-panel">${filter}</div>${chips}${facetSection}<div class="section-heading v14-result-heading" id="book-results"><div><span class="section-kicker">کتابخانه ورق</span><h2>${title}</h2></div><span class="v14-results-pill">${digits(result.total)} عنوان پیدا شد</span></div>${result.rows.length?`<form class="v71-compare-form" action="/books/compare" method="get" aria-label="انتخاب کتاب‌های همین صفحه برای مقایسه"><div class="v71-compare-toolbar"><div><strong>مقایسه سریع کتاب‌ها</strong><p id="v71-compare-help">دو یا سه عنوان از همین صفحه انتخاب کن؛ این مقایسه امتیاز یا فروش واقعی نیست.</p></div><div class="v71-compare-controls"><output id="v71-compare-count" aria-live="polite" aria-atomic="true">۰ از ۳ انتخاب‌شده</output><button type="button" class="outline v71-compare-clear" hidden>پاک‌کردن انتخاب‌ها</button><button type="submit" class="cta v71-compare-submit">مقایسه عنوان‌های انتخاب‌شده</button></div></div><div class="book-grid catalog-book-grid">${result.rows.map(b=>bookCard(b,true)).join('')}</div></form>`:'<div class="empty v57-empty-results"><strong>نتیجه‌ای پیدا نشد</strong><p>کتابی با این مشخصات پیدا نشد. عبارت کوتاه‌تر یا نام نویسنده را امتحان کن.</p><div class="button-row"><a class="cta" href="/books">نمایش همه کتاب‌ها</a><a class="outline" href="/pdf-books">مرور PDFها</a></div></div>'}${zeroResultHelp}${pagination}</div>`;
}

// Educational catalogue: no invented inventory; profiles only become public after YM publication.
// VARAQ 7.0 — informational, source-grounded format guidance. Never creates an order or entitlement.
function formatChoicePage(url){
 const slug=str(url.searchParams.get('book'),80);
 // Prevent broad/untrusted selectors and avoid accidentally suggesting a specific book.
 if(slug&&!/^book-[a-zA-Z0-9-]{1,64}$/.test(slug))return {error:'شناسه کتاب معتبر نیست.'};
 const b=slug?db.prepare('SELECT id,title,slug,author,category FROM books WHERE slug=?').get(slug):null;
 if(slug&&!b)return {notFound:true};
 const offers=b?db.prepare(`SELECT i.id,i.price,i.store_id,s.name AS store_name
 FROM stock_items i JOIN stores s ON s.id=i.store_id
 LEFT JOIN editions e ON e.id=i.edition_id
 WHERE i.book_id=? AND i.active=1 AND i.quantity>0 AND i.price>0 AND s.active=1
 AND (i.edition_id IS NULL OR e.verified=1) ORDER BY i.id LIMIT 100`).all(b.id):[];
 const stores=b?new Set(offers.map(x=>x.store_id)).size:0;
 const digital=b?pdfStore.publicRows(db).filter(x=>x.book_id===b.id):[];
 const physicalMin=offers.length?Math.min(...offers.map(x=>promotions.priceFor(db,x.id,x.price).price)):null;
 const href=b?'/book/'+encodeURIComponent(b.slug):'/books';
 const documentedPrint=b?db.prepare('SELECT COUNT(*) AS n FROM editions WHERE book_id=? AND verified=1').get(b.id).n:0;
 const article=b?`<div class="v70-selected-book">${cover(b)}<div><span class="eyebrow">راهنمای نسخه برای این عنوان</span><h1>${esc(b.title)}</h1><p>${esc(b.author||'نام نویسنده هنوز مستند نشده است')} · ${esc(b.category)}</p><div class="button-row"><a class="outline" href="${href}">بازگشت به مشخصات کتاب</a><a class="outline" href="${href}/read">مطالعه معرفی ورق</a></div></div></div>`:
 `<div class="page-banner v70-advisor-hero"><span class="eyebrow">VARAQ · BOOK FORMATS</span><h1>چاپی یا PDF؟ آگاهانه انتخاب کن</h1><p>قبل از انتخاب، چاپ و شابک، فروشنده، مجوز نسخه دیجیتال و شرایط دریافت را بررسی کن. هیچ پرداختی در این نسخه انجام نمی‌شود.</p><a class="cta" href="/books">انتخاب یک کتاب از فهرست</a></div>`;
 const physicalDetails=b?(stores?`<p class="v70-fact"><strong>${digits(stores)}</strong> فروشگاه دارای موجودی ثبت‌شده</p><p>کمترین قیمت ثبت‌شده برای ردیف‌های قابل‌نمایش: <b>${money(physicalMin)}</b>. قیمت و موجودی نهایی باید مستقیماً با فروشنده تأیید شود.</p>`:'<p class="v70-empty-state">در حال حاضر موجودی قابل‌نمایش برای این عنوان در بانک فروشندگان ثبت نشده است.</p>'):'<p>نسخه، ترجمه، شابک و موجودی هر کتاب را در صفحه اختصاصی آن بررسی کن.</p>';
 const digitalDetails=b?(digital.length?`<p class="v70-fact"><strong>${digits(digital.length)}</strong> پرونده دیجیتال قابل‌نمایش با مجوز ثبت‌شده</p><ul class="v70-digital-options">${digital.slice(0,8).map(x=>`<li><a href="/pdf-books/${x.id}">${esc(x.title)}</a><small>${esc(x.store_name)} · ${money(x.price)} · دانلود پولی غیرفعال</small></li>`).join('')}</ul>`:'<p class="v70-empty-state">نسخه PDF دارای مجوز و قابل‌نمایش برای این کتاب ثبت نشده است؛ وجود PDF در اینترنت به معنی اجازه فروش یا انتشار نیست.</p>'):'<p>فقط PDFهایی که پرونده حقوق توزیع و تأیید مدیریتی دارند در فهرست دیجیتال نشان داده می‌شوند.</p>';
 const content=`<div class="shell main v70-format-page"><div class="breadcrumbs"><a href="/">خانه</a> / <a href="/books">کتاب‌ها</a> / راهنمای انتخاب نسخه</div>${article}<div class="v70-journey-steps" aria-label="مراحل آشنایی تا انتخاب"><span><b>۱</b> شناخت کتاب</span><span><b>۲</b> انتخاب نوع نسخه</span><span><b>۳</b> بررسی مشخصات</span></div><div class="v70-format-grid"><section class="v70-format-tile" aria-labelledby="v70-print-title"><span class="v70-format-icon" aria-hidden="true">▣</span><span class="v70-type">کتاب فیزیکی</span><h2 id="v70-print-title">نسخه چاپی</h2><p class="v70-format-intro">برای کتابخانه شخصی و مطالعه کاغذی؛ چاپ و ترجمه می‌تواند بین فروشندگان متفاوت باشد.</p>${physicalDetails}<a class="cta" href="${b?href+(documentedPrint?'#edition-picker':'#book-offers'):'/books'}">${b?(documentedPrint?'بررسی چاپ‌ها و فروشندگان':'بررسی وضعیت فروشندگان'):'مرور کتاب‌های چاپی'}</a></section><section class="v70-format-tile" aria-labelledby="v70-pdf-title"><span class="v70-format-icon" aria-hidden="true">▤</span><span class="v70-type">فایل دیجیتال با مجوز</span><h2 id="v70-pdf-title">نسخه PDF</h2><p class="v70-format-intro">مناسب خواندن روی دستگاه‌های سازگار؛ داشتن پرونده PDF به معنی قابل‌خرید بودن آن نیست.</p>${digitalDetails}<a class="outline" href="${b&&digital.length?'/pdf-books/'+digital[0].id:'/pdf-books'}">${b&&digital.length?'مشخصات نسخه دیجیتال':'مرور فهرست PDF'}</a></section></div><section class="v70-decision-note"><h2>قبل از انتخاب، این سه مورد را بررسی کن</h2><ul><li>برای کتاب چاپی، ناشر، مترجم و شابکِ همان نسخه را با کتاب فیزیکی تطبیق بده.</li><li>برای PDF، صاحب حقوق و مجازبودن توزیع فایل باید روشن باشد.</li><li>مبلغ و موجودی نمایشی قطعی نیستند؛ ثبت سفارش، پرداخت، ارسال و تحویل پولی در این نسخه غیرفعال‌اند.</li></ul>${b?`<a class="outline" href="${href}/read">ابتدا معرفی کتاب را بخوان</a>`:'<a class="outline" href="/themes">کشف کتاب بر اساس موضوع</a>'}</section></div>`;
 return {content,title:b?'انتخاب نسخه '+b.title:'راهنمای انتخاب نسخه چاپی و دیجیتال'};
}
function educationSelect(name,labels,value,allLabel='همه موارد'){
 const entries=Object.entries(labels);const choose=entries.map(([id,label])=>`<option value="${attr(id)}" ${String(value)===String(id)?'selected':''}>${esc(label)}</option>`).join('');
 return `<select name="${attr(name)}"><option value="">${esc(allLabel)}</option>${choose}</select>`;
}
function educationPublicPage(url){
 const f=education.filters(url.searchParams),r=education.search(db,f),totalPages=Math.max(1,Math.ceil(r.total/r.perPage));
 const form=`<form class="filterbar education-filters" action="/educational" method="get"><label class="filter-field">نام کتاب یا ناشر<input name="q" maxlength="80" value="${attr(f.q)}" placeholder="جست‌وجو در کتاب‌های کمک‌درسی"></label><label class="filter-field">پایه تحصیلی${educationSelect('grade',education.GRADES,f.grade,'همه پایه‌ها')}</label><label class="filter-field">رشته${educationSelect('track',education.TRACKS,f.track,'همه رشته‌ها')}</label><label class="filter-field">درس${educationSelect('subject',Object.fromEntries(education.SUBJECTS.map(x=>[x,x])),f.subject,'همه درس‌ها')}</label><label class="filter-field">ناشر<input name="publisher" maxlength="100" value="${attr(f.publisher)}" placeholder="نام ناشر"></label><label class="filter-field">سال کنکور<input type="number" name="exam_year" min="1400" max="1500" value="${attr(f.examYear||'')}" placeholder="مثلاً ۱۴۰۶"></label><label class="filter-field">هدف مطالعه${educationSelect('goal',education.GOALS,f.goal,'هر هدفی')}</label><label class="filter-field">نوع منبع${educationSelect('material_type',education.TYPES,f.materialType,'همه انواع')}</label><div class="discovery-actions"><button class="cta">جست‌وجوی کتاب‌ها</button><a class="reset" href="/educational">حذف فیلترها</a></div></form>`;
 const params=new URLSearchParams();for(const [k,v] of Object.entries({q:f.q,grade:f.grade,track:f.track,subject:f.subject,goal:f.goal,material_type:f.materialType,publisher:f.publisher,exam_year:f.examYear}))if(v)params.set(k,String(v));
 const links=`<div class="pagination">${f.page>1?`<a href="/educational?${params.toString()}&page=${f.page-1}">صفحه قبل</a>`:''}<span>صفحه ${digits(f.page)} از ${digits(totalPages)}</span>${f.page<totalPages?`<a href="/educational?${params.toString()}&page=${f.page+1}">صفحه بعد</a>`:''}</div>`;
 return `<div class="shell main"><div class="page-banner"><span class="eyebrow">LEARNING & EXAMS</span><h1>کمک‌درسی و کنکور</h1><p>کتاب مناسب پایه، رشته و هدف خودت را پیدا کن. فقط منابعی نمایش داده می‌شوند که مشخصاتشان توسط مدیر YM بررسی و منتشر شده است.</p></div>${form}<div class="section-heading"><h2>منابع آموزشی</h2><span class="muted">${digits(r.total)} عنوان ثبت‌شده و منتشرشده</span></div>${r.rows.length?`<form action="/educational/compare" method="get" class="education-compare-picker"><div class="compare-picker-heading"><strong>مقایسه منابع آموزشی</strong><span>از فهرست زیر دو یا سه کتاب انتخاب کن؛ فقط مشخصات واقعی و ثبت‌شده کنار هم نشان داده می‌شوند.</span><button class="outline" type="submit">مقایسه کتاب‌های انتخابی</button></div><div class="book-grid">${r.rows.map(b=>`<div class="education-result">${bookCard(b)}<div class="education-meta">${esc(education.label(b))} · ${esc(education.GOALS[b.goal])}</div><label class="compare-choose"><input type="checkbox" name="ids" value="${b.id}"> انتخاب برای مقایسه</label></div>`).join('')}</div><div class="compare-picker-foot"><button class="cta" type="submit">مقایسه ۲ یا ۳ کتاب انتخابی</button></div></form>`:'<div class="empty"><b>هنوز کتابی مطابق این فیلتر ثبت و تأیید نشده است.</b><p>این بخش آماده توسعه است؛ اطلاعات واقعی کتاب‌های کمک‌درسی بعد از بررسی توسط مدیر سایت منتشر خواهند شد.</p></div>'}${links}<p class="muted tiny education-disclaimer">نام کتاب و موجودی در این بخش مستقلاً بررسی می‌شوند. پرداخت آنلاین همچنان غیرفعال است.</p></div>`;
}
function panelEducation(user,url){
 if(user.role!=='owner')return null;
 const edit=safeId(url.searchParams.get('edit')),record=edit?db.prepare('SELECT b.id,b.title,ep.* FROM books b LEFT JOIN education_profiles ep ON ep.book_id=b.id WHERE b.id=?').get(edit):null;
 const f=education.filters(url.searchParams),r=education.search(db,f,true);
 const bookSearch=str(url.searchParams.get('book_q'),70),suggestions=db.prepare('SELECT id,title,author FROM books WHERE title LIKE ? ORDER BY id DESC LIMIT 40').all('%'+bookSearch+'%');
 const selected=record?.book_id||edit||null;
 const booksSelect=`<label>کتاب ثبت‌شده در بانک اطلاعات<select name="book_id" required><option value="">انتخاب کتاب</option>${selected&&!suggestions.some(x=>x.id===selected)?`<option selected value="${selected}">${esc(record?.title||'کتاب انتخابی')}</option>`:''}${suggestions.map(b=>`<option value="${b.id}" ${b.id===selected?'selected':''}>${esc(b.title)} — #${b.id}</option>`).join('')}</select></label>`;
 const adminForm=`<div class="panel-note"><h2>${record?.grade?'ویرایش مشخصات کمک‌درسی':'ثبت مشخصات کمک‌درسی برای یک کتاب موجود'}</h2><p class="muted tiny">ابتدا عنوان را از <a href="/panel/books">بانک کتاب</a> ثبت کن. اینجا فقط فراداده آموزشی آن را تعیین کن. چاپ، سال انتشار و ISBN از بخش «چاپ‌ها و ترجمه‌ها» مدیریت می‌شود.</p><form class="inline-search" method="get" action="/panel/education"><input name="book_q" value="${attr(bookSearch)}" maxlength="70" placeholder="جست‌وجوی عنوان برای انتخاب…"><button>یافتن کتاب</button></form><form class="form-grid" method="post" action="/panel/education-save">${csrfInput(user)}${booksSelect}<label>پایه${educationSelect('grade',education.GRADES,record?.grade||'','انتخاب پایه')}</label><label>رشته${educationSelect('track',education.TRACKS,record?.track||'','انتخاب رشته')}</label><label>درس${educationSelect('subject',Object.fromEntries(education.SUBJECTS.map(s=>[s,s])),record?.subject||'','انتخاب درس')}</label><label>هدف${educationSelect('goal',education.GOALS,record?.goal||'','انتخاب هدف')}</label><label>نوع کتاب${educationSelect('material_type',education.TYPES,record?.material_type||'','انتخاب نوع')}</label><label>سال کنکور (اختیاری)<input type="number" name="exam_year" inputmode="numeric" min="1400" max="1500" value="${attr(record?.exam_year||'')}" placeholder="۱۴۰۶"></label><label class="checkbox-line"><input type="checkbox" value="1" name="published" ${record?.published?'checked':''}> انتشار در فهرست عمومی بعد از بررسی مشخصات</label><button class="cta">ذخیره اطلاعات آموزشی</button></form><p class="muted tiny">برای پایه‌های اول تا نهم رشته «عمومی» را انتخاب کن. در منابع ویژه کنکور رشته باید مشخص باشد؛ بدون تأیید، کتاب در فهرست عمومی نمایش داده نمی‌شود.</p></div>`;
 const rows=db.prepare('SELECT b.id,b.title,ep.grade,ep.track,ep.subject,ep.published FROM education_profiles ep JOIN books b ON b.id=ep.book_id ORDER BY ep.updated_at DESC,b.id DESC LIMIT 80').all();
 return panelShell(user,adminForm+`<h2 class="block-title">کتاب‌های کمک‌درسی ثبت‌شده (${digits(db.prepare('SELECT COUNT(*) n FROM education_profiles').get().n)})</h2>${rows.length?`<div class="table-scroll"><table class="data-table"><thead><tr><th>عنوان</th><th>پایه</th><th>رشته</th><th>درس</th><th>وضعیت</th><th>ویرایش</th></tr></thead><tbody>${rows.map(b=>`<tr><td>${esc(b.title)}</td><td>${esc(education.GRADES[b.grade])}</td><td>${esc(education.TRACKS[b.track])}</td><td>${esc(b.subject)}</td><td>${b.published?'منتشرشده':'پیش‌نویس'}</td><td><a href="/panel/education?edit=${b.id}">ویرایش</a></td></tr>`).join('')}</tbody></table></div>`:'<div class="empty">هنوز کتاب کمک‌درسی ثبت نشده است. برای شروع از فرم بالا استفاده کن.</div>'}`,'کمک‌درسی و کنکور');
}
function educationComparePage(url){
 let books;try{books=educationCompare.get(db,educationCompare.idsFromParams(url));}catch(e){return {error:e.message};}
 const fields=[['عنوان',b=>b.title],['نویسنده',b=>b.author||'ثبت نشده'],['ناشر ثبت‌شده',b=>b.publisher||'ثبت نشده'],['پایه',b=>b.gradeLabel],['رشته',b=>b.trackLabel],['درس',b=>b.subject],['هدف',b=>b.goalLabel],['نوع منبع',b=>b.typeLabel],['سال کنکور',b=>b.exam_year||'ثبت نشده']];
 const matrix=`<div class="table-scroll"><table class="data-table education-compare-table"><thead><tr><th scope="col">ویژگی</th>${books.map(b=>`<th scope="col"><a href="/book/${encodeURIComponent(b.slug)}">${esc(b.title)}</a></th>`).join('')}</tr></thead><tbody>${fields.slice(1).map(([label,value])=>`<tr><th scope="row">${esc(label)}</th>${books.map(b=>`<td>${esc(value(b))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
 return {html:`<div class="shell main"><div class="page-banner"><span class="eyebrow">COMPARE EDUCATIONAL BOOKS</span><h1>مقایسه منابع آموزشی</h1><p>مقایسه بر اساس مشخصات ثبت‌شده؛ این صفحه هیچ رتبه‌بندی، نمره کیفیت یا ادعای برتری ایجاد نمی‌کند.</p></div><div class="panel-note">${matrix}<div class="button-row"><a href="/educational" class="outline">بازگشت به فهرست کمک‌درسی</a></div><p class="muted tiny">تعداد تست و سطح سختی فقط در صورت ثبت اطلاعات قابل راستی‌آزمایی در نسخه‌های آینده اضافه می‌شوند. پرداخت واقعی غیرفعال است.</p></div></div>`};
}
function educationImportPage(user){
 if(user.role!=='owner')return null;
 return panelShell(user,`<div class="panel-note"><h2>ورود گروهی فراداده کمک‌درسی</h2><p>این بخش فقط به کتاب‌هایی متصل می‌شود که قبلاً در بانک «ورق» ثبت شده‌اند؛ هیچ عنوان یا شابک ساختگی تولید نمی‌شود.</p><p>فایل CSV با هفت ستون <code>book_id,grade,track,subject,goal,material_type,exam_year</code> و حداکثر ۲۵۰ ردیف آماده کن. رشته/هدف/نوع باید از کدهای فایل راهنما انتخاب شوند.</p><div class="button-row"><a class="outline" href="/panel/education-import-template">دریافت نمونه CSV</a><a class="outline" href="/panel/education-import-help">راهنمای کدها</a><a class="outline" href="/panel/books">شناسه کتاب‌ها</a></div>
 <form method="post" action="/panel/education-import" class="form-grid">${csrfInput(user)}<label class="full">محتوای CSV<textarea name="csv" id="education-csv-input" rows="11" maxlength="175000" required placeholder="book_id,grade,track,subject,goal,material_type,exam_year"></textarea></label><label class="full">انتخاب فایل CSV از کامپیوتر<input type="file" id="education-csv-file" accept=".csv,text/csv"></label><label class="checkbox-line full"><input type="checkbox" name="confirm" value="1"> بررسی کردم؛ ردیف‌های معتبر فقط به‌صورت پیش‌نویس ثبت شوند</label><button class="outline" name="mode" value="preview">اعتبارسنجی و پیش‌نمایش</button><button class="cta" name="mode" value="commit">ثبت پیش‌نویس‌های معتبر</button></form><div class="soft-warning">انتشار عمومی از طریق فرم تأیید مدیر YM انجام می‌شود. پرونده‌های قبلی هرگز با فایل گروهی بازنویسی نمی‌شوند.</div></div>`, 'ورود گروهی کمک‌درسی');
}
function educationImportResult(user,result,committed){
 return panelShell(user,`<div class="panel-note"><h2>${committed?'نتیجه ورود گروهی پیش‌نویس‌ها':'پیش‌نمایش فایل کمک‌درسی'}</h2><div class="stats panel-stats"><div><b>${digits(committed?result.inserted:result.valid.length)}</b><span>${committed?'پرونده پیش‌نویس ثبت شد':'ردیف آماده ورود'}</span></div><div><b>${digits(result.issues.length)}</b><span>ردیف نامعتبر یا تکراری</span></div></div><p>هیچ ردیفی از این فایل به‌صورت عمومی منتشر نخواهد شد.</p>${result.issues.length?`<details open><summary>خطاها و ردیف‌های ردشده</summary><ul>${result.issues.slice(0,40).map(x=>`<li>${esc(x)}</li>`).join('')}</ul></details>`:''}<div class="button-row"><a href="/panel/education-import" class="outline">بازگشت به ورود گروهی</a><a href="/panel/education" class="cta">بررسی و انتشار دستی</a></div></div><div class="table-scroll"><table class="data-table"><thead><tr><th>ردیف</th><th>شناسه</th><th>عنوان موجود</th><th>پایه</th><th>رشته</th><th>درس</th><th>وضعیت</th></tr></thead><tbody>${result.valid.slice(0,60).map(r=>`<tr><td>${digits(r.line)}</td><td>${digits(r.book.id)}</td><td>${esc(r.title)}</td><td>${esc(education.GRADES[r.profile.grade])}</td><td>${esc(education.TRACKS[r.profile.track])}</td><td>${esc(r.profile.subject)}</td><td>پیش‌نویس</td></tr>`).join('')}</tbody></table></div>`, 'نتیجه CSV کمک‌درسی');
}
function personDirectory(kind,url){
 const isAuthor=kind==='author',label=isAuthor?'نویسندگان':'ناشران';
 const q=str(url.searchParams.get('q'),80),pageNo=Math.max(1,Math.min(10000,Number(url.searchParams.get('page'))||1));
 const result=isAuthor?discovery.authors(db,{q,page:pageNo,perPage:36}):discovery.publishers(db,{q,page:pageNo,perPage:36});
 const base=isAuthor?'/authors':'/publishers';
 const entries=result.rows.map(x=>`<a class="directory-tile" href="${base}/${encodeURIComponent(x.name)}"><span class="directory-avatar" aria-hidden="true">${isAuthor?'✍':'▦'}</span><span class="directory-content"><strong>${esc(x.name)}</strong><small>${digits(x.total)} عنوان ثبت‌شده در ورق</small></span><span aria-hidden="true">←</span></a>`).join('');
 const params=new URLSearchParams();if(q)params.set('q',q);
 return `<div class="shell main"><div class="page-banner"><span class="eyebrow">DISCOVER</span><h1>فهرست ${label}</h1><p>این فهرست براساس اطلاعات ثبت‌شده در بانک کتاب ساخته می‌شود؛ نام‌های مشابه ممکن است به یک شخص یا ناشر اشاره کنند.</p></div><form class="directory-search" action="${base}" method="get"><input name="q" value="${attr(q)}" maxlength="80" placeholder="جست‌وجوی نام ${isAuthor?'نویسنده':'ناشر'}…"><button class="cta">جست‌وجو</button></form><div class="section-heading"><h2>${q?'نتایج «'+esc(q)+'»':label}</h2><span class="muted">${digits(result.total)} نام</span></div>${entries?`<div class="directory-grid">${entries}</div>`:'<div class="empty">موردی یافت نشد.</div>'}<div class="pagination">${pageNo>1?`<a href="${base}?${params}&page=${pageNo-1}">قبلی</a>`:''}<span>${digits(pageNo)} از ${digits(Math.max(1,Math.ceil(result.total/36)))}</span>${pageNo*36<result.total?`<a href="${base}?${params}&page=${pageNo+1}">بعدی</a>`:''}</div></div>`;
}
function personProfile(kind,name,url){
 const isAuthor=kind==='author',label=isAuthor?'نویسنده':'ناشر',base=isAuthor?'/authors':'/publishers';
 const pageNo=Math.max(1,Math.min(10000,Number(url.searchParams.get('page'))||1));
 const entry=discovery.personBooks(db,{kind,name,page:pageNo,perPage:24});if(entry.total===0)return null;
 const content=`<div class="shell main"><div class="breadcrumbs"><a href="/">خانه</a> / <a href="${base}">${isAuthor?'نویسندگان':'ناشران'}</a> / ${esc(name)}</div><div class="page-banner"><span class="eyebrow">${isAuthor?'AUTHOR':'PUBLISHER'} · VARAQ</span><h1>${esc(name)}</h1><p>${digits(entry.total)} عنوان با نام ${label} «${esc(name)}» در بانک ورق ثبت شده است. هویت و اطلاعات آثار پس از تطبیق منابع تکمیل می‌شوند.</p></div><div class="section-heading"><h2>کتاب‌های ثبت‌شده</h2><span class="muted">${digits(entry.total)} عنوان</span></div><div class="book-grid">${entry.rows.map(bookCard).join('')}</div><div class="pagination">${pageNo>1?`<a href="${base}/${encodeURIComponent(name)}?page=${pageNo-1}">قبلی</a>`:''}<span>صفحه ${digits(pageNo)}</span>${pageNo*24<entry.total?`<a href="${base}/${encodeURIComponent(name)}?page=${pageNo+1}">بعدی</a>`:''}</div></div>`;
 const ld={'@context':'https://schema.org','@type':isAuthor?'Person':'Organization',name,mainEntityOfPage:PUBLIC_URL+base+'/'+encodeURIComponent(name)};
 const head=`<script type="application/ld+json" nonce="__NONCE__">${JSON.stringify(ld).replace(/</g,'\\u003c')}</script>${seo.breadcrumbs(PUBLIC_URL,[{name:'خانه',path:'/'},{name:isAuthor?'نویسندگان':'ناشران',path:base},{name,path:base+'/'+encodeURIComponent(name)}])}`;
 return {content,head};
}
function scoreMarkup(bookId){const stats=db.prepare("SELECT COUNT(*) AS count,ROUND(AVG(rating),1) AS average FROM reader_reviews WHERE book_id=? AND status='approved'").get(bookId);
 return stats.count?`<div class="score-summary"><span class="score-stars" aria-hidden="true">★</span><strong>${digits(stats.average)}</strong><span>از ۵ · ${digits(stats.count)} نظر تأییدشده</span></div>`:'<div class="score-summary empty-score">هنوز امتیازی ثبت و تأیید نشده است.</div>';}
function editorialBlock(bookId){const row=db.prepare('SELECT * FROM book_editorials WHERE book_id=? AND published=1').get(bookId);
 if(!row)return `<section class="editorial-review content-section"><h2>بررسی تخصصی کتاب</h2><div class="quiet-note">بررسی تحلیلی این عنوان در حال آماده‌سازی است. تا زمان تأیید محتوای تخصصی، مطلب ساختگی نمایش داده نمی‌شود.</div></section>`;
 return `<section class="editorial-review content-section"><div class="section-heading"><h2>نگاه تحلیلی تحریریه ورق</h2><span class="muted tiny">محتوای تهیه و تأییدشده توسط تیم محتوا</span></div>${row.summary?`<p class="review-summary">${esc(row.summary)}</p>`:''}<div class="insight-grid">${[['مناسب چه کسانی است؟',row.audience],['نکات برجسته',row.strengths],['پیش از انتخاب بدانید',row.cautions]].filter(a=>a[1]).map(([label,value])=>`<article class="insight"><h3>${label}</h3><p>${esc(value)}</p></article>`).join('')}</div></section>`;}
function reviewBlock(book){const reviews=db.prepare("SELECT display_name,rating,body,created_at FROM reader_reviews WHERE book_id=? AND status='approved' ORDER BY id DESC LIMIT 20").all(book.id);
 const messages=reviews.map(r=>`<article class="reader-review"><div class="reader-review-top"><strong>${esc(r.display_name)}</strong><span class="stars" aria-label="${r.rating} از ۵ ستاره">${'★'.repeat(r.rating)}${'☆'.repeat(5-r.rating)}</span></div><p>${esc(r.body)}</p><small>نظر تأییدشده · ${esc(r.created_at.slice(0,10))}</small></article>`).join('');
 return `<section class="content-section reader-reviews" id="reader-reviews"><div class="section-heading"><div><span class="section-kicker">READER VOICES</span><h2>نظر خوانندگان</h2></div>${scoreMarkup(book.id)}</div>${messages?`<div class="review-grid">${messages}</div>`:'<div class="quiet-note">هنوز نظری منتشر نشده؛ نخستین تجربه مطالعه را ثبت کن.</div>'}<form class="reader-form" action="/review" method="post"><h3>تجربه خواندن این کتاب را بنویس</h3><p class="muted tiny">نظرها ابتدا توسط مدیر YM بررسی می‌شوند؛ از درج شماره تماس و اطلاعات شخصی خودداری کن.</p><input type="hidden" name="book_id" value="${book.id}"><input type="hidden" name="token" value="${attr(signedReviewToken(book.id))}"><div class="honeypot" aria-hidden="true"><label>این قسمت را خالی بگذار<input name="website" tabindex="-1" autocomplete="off"></label></div><div class="reader-form-grid"><label>نام نمایشی<input name="display_name" minlength="2" maxlength="50" required autocomplete="nickname" placeholder="مثلاً کتاب‌دوست"></label><fieldset class="star-picker"><legend>امتیاز شما</legend><div class="rating-choices">${[5,4,3,2,1].map(n=>`<label><input type="radio" name="rating" value="${n}" required><span aria-label="${n} ستاره" title="${n} ستاره">${n} ★</span></label>`).join('')}</div></fieldset></div><label>متن نظر<textarea name="body" minlength="30" maxlength="1500" rows="4" required placeholder="چه چیزی درباره این کتاب برات جالب بود؟"></textarea></label><button class="cta" type="submit">ارسال نظر برای بررسی</button></form></section>`;}
function relatedBooks(book){
 const rows=topicDiscovery.related(book,db.prepare('SELECT * FROM books').all(),generatedTextById,entry=>generatedReview.record(db,entry).status==='hidden',6);
 return rows.length?`<section class="content-section related-section"><div class="section-heading"><div><span class="section-kicker">DISCOVER</span><h2>کتاب‌های مرتبط؛ برای ادامه کشف</h2><p class="muted tiny">چیدمان بر اساس برچسب‌های موضوعی اولیه، دسته و نویسنده؛ بدون امتیاز، فروش یا محبوبیت ساختگی. برچسب‌های تولیدی نیازمند بازبینی تحریریه‌اند.</p></div><a href="/themes">کشف بر اساس موضوع ←</a></div><div class="book-grid related-grid">${rows.map(item=>`<div class="varaq-relation-item">${bookCard(item.book)}<p class="varaq-relation-reason">${esc(item.reason)}</p><a class="varaq-related-compare" href="${attr(bookComparison.pairLink(book,item.book))}">مقایسه با این کتاب ←</a></div>`).join('')}</div></section>`:'';
}

// v6.6: compare at most three registered titles. Draft-generated topics never masquerade as verified facts.
function compareBooksPage(url){
 const all=db.prepare('SELECT * FROM books ORDER BY title COLLATE NOCASE, id').all();
 const selected=bookComparison.selectBooks(url.searchParams.getAll('book'),all);
 if(selected.error)return {error:selected.error};
 const chosen=selected.books;
  const pick=(i)=>`<label class="compare-select">کتاب ${digits(i+1)}${i===2?' (اختیاری)':''}<select name="book" ${i<2?'required':''}><option value="">${i===0?'کتاب اول را انتخاب کنید':i===1?'کتاب دوم را انتخاب کنید':'بدون کتاب سوم'}</option>${all.map(b=>`<option value="${attr(b.slug)}" ${chosen[i]?.slug===b.slug?'selected':''}>${esc(b.title)}${b.author?' — '+esc(b.author):''}</option>`).join('')}</select></label>`;
 const itemDetail=b=>{
  const entry=generatedTextById.get(b.id);
  const status=entry&&entry.title===b.title?generatedReview.record(db,entry).status:'none';
  const topics=publicTopicsFor(b);
  const info=String(b.description||'').trim();
  const summary=info||((status==='hidden'||!entry||entry.title!==b.title)?'':entry.description)||'';
  const summaryLabel=!summary?'معرفی قابل نمایش موجود نیست':info?'متن ثبت‌شده در کتابخانه':status==='approved'?'معرفی بازبینی‌شده تحریریه':'معرفی اولیه، نیازمند بازبینی';
  const editionCount=editionDetail.listed(db,b.id).length;
  return {b,status,topics,summary,summaryLabel,editionCount};
 };
 const items=chosen.map(itemDetail);
 const field=(label,fn)=>`<tr><th scope="row">${esc(label)}</th>${items.map(x=>`<td>${fn(x)}</td>`).join('')}</tr>`;
 const getTopics=x=>x.topics.length?x.topics.slice(0,5).map(t=>`<a class="compare-topic" href="/themes?topic=${encodeURIComponent(t)}">${esc(t)}</a>`).join(''):'<span class="muted">موضوع تأییدپذیر فعلاً ثبت نشده</span>';
 const relation=chosen.length>1?bookComparison.relation(chosen[0],chosen[1],publicTopicsFor):'';
 return {content:`<div class="shell main varaq-comparison"><div class="breadcrumbs"><a href="/">خانه</a> / <a href="/books">کتاب‌ها</a> / مقایسه کتاب‌ها</div><header class="page-banner"><span class="eyebrow">READ BEFORE YOU CHOOSE</span><h1>مقایسه کتاب‌ها</h1><p>دو یا سه عنوان را کنار هم ببین؛ تفاوت موضوع، نویسنده، خلاصه اولیه و شناسنامه چاپ را بررسی کن. این صفحه هیچ برنده یا امتیاز ساختگی اعلام نمی‌کند.</p></header><form action="/books/compare" method="get" class="varaq-compare-form" aria-label="انتخاب کتاب برای مقایسه"><div class="varaq-compare-inputs">${[0,1,2].map(pick).join('')}</div><div class="button-row"><button class="cta" type="submit">مقایسه کتاب‌های انتخاب‌شده</button><a class="outline" href="/books/compare">شروع دوباره</a></div></form>${items.length>=2?`<section class="varaq-comparison-results" aria-label="نتیجه مقایسه"><h2>نتیجه مقایسه ${digits(items.length)} کتاب</h2><p class="soft-warning">موضوع‌ها و معرفی‌های تولیدی تا زمان بررسی انسانی، صرفاً راهنمای اولیه هستند. چاپ‌ها، ترجمه‌ها و موجودی فروشگاه باید جداگانه با منبع معتبر تطبیق داده شوند.</p><div class="varaq-compare-scroll" tabindex="0" role="region" aria-label="جدول مقایسه؛ برای ستون‌های بیشتر افقی حرکت کنید"><table class="varaq-compare-table"><thead><tr><th scope="col">مشخصات</th>${items.map(x=>`<th scope="col"><div class="compare-book-head">${cover(x.b)}<a href="/book/${encodeURIComponent(x.b.slug)}">${esc(x.b.title)}</a></div></th>`).join('')}</tr></thead><tbody>${field('نویسنده',x=>esc(x.b.author||'ثبت نشده'))}${field('دسته‌بندی',x=>esc(x.b.category||'نامشخص'))}${field('موضوع‌های پیشنهادی',getTopics)}${field('وضعیت معرفی',x=>esc(x.summaryLabel))}${field('معرفی کوتاه',x=>`<p class="compare-summary">${esc(x.summary?x.summary.slice(0,380)+(x.summary.length>380?'…':''):'معرفی قابل نمایش موجود نیست.')}</p>`)}${field('شناسنامه چاپ ثبت‌شده',x=>`${digits(x.editionCount)} مورد؛ صحت هر چاپ مستقل بررسی شود`)}${field('اطلاعات بیشتر',x=>`<a href="/book/${encodeURIComponent(x.b.slug)}">دیدن صفحه کتاب و چاپ‌ها ←</a>`)}</tbody></table></div><div class="varaq-compare-guidance"><h3>راهنمای انتخاب</h3><p>${esc(relation)}. برای انتخاب، موضوع مورد علاقه و مشخصات چاپ و ترجمه را در صفحه هر کتاب بررسی کنید.</p><p>این راهنما بر اساس داده‌های فعلی کتابخانه است؛ توصیه قطعی، رتبه‌بندی کیفیت یا نشانه فروش واقعی نیست.</p></div></section>`:`<section class="varaq-compare-empty"><h2>دو کتاب انتخاب کن</h2><p>از فهرست بالا دو عنوان متفاوت انتخاب کن، یا از بخش «کتاب‌های مرتبط» در صفحه هر کتاب مستقیماً مقایسه را باز کن.</p><a href="/books">مشاهده همه کتاب‌ها ←</a></section>`}</div>`};
}
function themesPage(url){
 const books=db.prepare('SELECT * FROM books ORDER BY id').all();
 const exclude=entry=>generatedReview.record(db,entry).status==='hidden';
 const available=topicDiscovery.themes(books,generatedTextById,exclude);
 const raw=String(url.searchParams.get('topic')||'').slice(0,80),chosen=topicDiscovery.normal(raw);
 const valid=available.some(x=>x.topic===chosen);
 const selected=valid?topicDiscovery.browse(books,generatedTextById,exclude,chosen):[];
 const requestedPage=Number(url.searchParams.get('page')||1),pages=Math.max(1,Math.ceil(selected.length/24));
 const page=Number.isSafeInteger(requestedPage)?Math.max(1,Math.min(pages,requestedPage)):1;
 const list=selected.slice((page-1)*24,page*24);
 const link=n=>'/themes?topic='+encodeURIComponent(chosen)+'&page='+n;
 const chip=x=>`<a class="varaq-theme-chip ${chosen===x.topic?'active':''}" href="/themes?topic=${encodeURIComponent(x.topic)}" ${chosen===x.topic?'aria-current="page"':''}><span>${esc(x.topic)}</span><small>${digits(x.count)} کتاب</small></a>`;
 const chips=available.slice(0,20).map(chip).join('')+(available.length>20?`<details class="varaq-more-themes" ${available.slice(20).some(x=>x.topic===chosen)?'open':''}><summary>موضوع‌های بیشتر (${digits(available.length-20)})</summary><div class="varaq-theme-chips">${available.slice(20).map(chip).join('')}</div></details>`:'');
 return `<div class="shell main varaq-themes"><div class="page-banner"><span class="eyebrow">VARAQ · DISCOVER</span><h1>کشف کتاب با موضوع دلخواه</h1><p>از برچسب‌های پیشنهادی ۲۰۰ معرفی اولیه استفاده کن. این دسته‌بندی‌ها هنوز در فرایند بررسی تحریریه هستند و رتبه‌بندی کیفیت یا میزان محبوبیت کتاب‌ها نیستند.</p></div><nav class="varaq-theme-chips" aria-label="انتخاب موضوع">${chips}</nav>${valid?`<section class="section" aria-label="کتاب‌های موضوع ${attr(chosen)}"><div class="section-heading"><h2>کتاب‌های مرتبط با «${esc(chosen)}»</h2><span class="muted">${digits(selected.length)} عنوان</span></div><div class="book-grid">${list.map(bookCard).join('')}</div><div class="pagination">${page>1?`<a href="${attr(link(page-1))}">قبلی</a>`:''}<span>صفحه ${digits(page)} از ${digits(pages)}</span>${page<pages?`<a href="${attr(link(page+1))}">بعدی</a>`:''}</div></section>`:raw?'<div class="soft-warning">این موضوع در فهرست قابل انتخاب نیست. یکی از موضوع‌های بالا را انتخاب کن.</div>':'<div class="panel-note"><h2>از یک موضوع شروع کن</h2><p>با انتخاب هر برچسب، کتاب‌هایی که موضوع مشترک در معرفی اولیه دارند نمایش داده می‌شوند. برای بررسی صحت متن و مشخصات چاپ، صفحه هر کتاب را ببین.</p></div>'}</div>`;
}
// v4.2: print-friendly informational sheet, no inferred rights, sale or stock claims.
function bookInfoSheet(slug){
 const b=db.prepare('SELECT * FROM books WHERE slug=?').get(slug);
 if(!b)return null;
 const valid=editionDetail.listed(db,b.id).filter(e=>editionDetail.trustworthySource(e.source_url));
 const review=publicationReview.forBook(db,b.id);
 const short=b.description&&b.description.trim().length>=100?`<p>${esc(b.description)}</p>`:generatedIntro(b)?`<p class="varaq-draft-intro-note">معرفی کوتاه اختصاصی ورق؛ پیش‌نویس نیازمند بررسی</p><p>${esc(generatedIntro(b))}</p>`:'<p class="muted">معرفی تفصیلی این کتاب هنوز تکمیل و بازبینی نشده است.</p>';
 const item=valid.map(e=>`<li><strong>${esc(e.label||'چاپ ثبت‌شده')}</strong> · ناشر: ${esc(e.publisher||'ثبت نشده')} · شابک: <code dir="ltr">${esc(e.isbn||'ثبت نشده')}</code> · ${e.pages?digits(e.pages)+' صفحه · ':''}<a href="${attr(e.source_url)}" rel="nofollow noopener noreferrer" target="_blank">منبع چاپ</a></li>`).join('');
 return {b,content:`<div class="shell main reader-sheet"><div class="sheet-toolbar"><a class="outline" href="/book/${encodeURIComponent(b.slug)}">بازگشت به صفحه کتاب</a><button class="cta print-page-action" type="button">چاپ / ذخیره PDF</button></div><article class="sheet-body"><p class="eyebrow">ورق · برگه اطلاعات کتاب</p><h1>${esc(b.title)}</h1><dl class="facts"><div><dt>نویسنده</dt><dd>${esc(b.author||'در حال تکمیل')}</dd></div><div><dt>موضوع</dt><dd>${esc(b.category)}</dd></div><div><dt>ناشر عنوان</dt><dd>${esc(b.publisher||'در حال بررسی')}</dd></div></dl><h2>معرفی کتاب</h2>${short}${exclusiveSummary(b)}${!b.description?generatedReadingGuide(b):''}<h2>چاپ‌های دارای منبع ثبت‌شده</h2>${item?`<ul class="sheet-editions">${item}</ul>`:'<p class="muted">چاپ دارای لینک منبع ثبت‌شده یافت نشد.</p>'}<h2>وضعیت اطلاعات</h2><p>${review.hasAuthor?'نام نویسنده ثبت شده':'نویسنده ناقص'} · ${review.hasIntro?'متن معرفی ثبت شده':'معرفی در حال تکمیل'} · ${review.hasSource?'حداقل یک منبع چاپ ثبت شده':'منبع چاپ ناقص'}</p><p class="sheet-caution">این برگه اطلاعاتی و برای بررسی اولیه است. ثبت داده به معنی تأیید صحت، مجوز تصویر یا موجودی فروشگاه نیست. سفارش و پرداخت واقعی فعال نیست.</p><p class="sheet-source">منبع برگه: ${esc(PUBLIC_URL+'/book/'+b.slug)}</p></article></div>`};
}
// VARAQ 6.7: own editorial introduction and optional licensed text sample, never the private paid PDF.
function readingPage(slug){
 const book=db.prepare('SELECT * FROM books WHERE slug=?').get(slug);if(!book)return null;
 const editorial=book.description||generatedIntro(book);
 const review=generatedTextById.get(book.id);
 const originalNote=book.description?'متن معرفی ثبت‌شده در بانک کتاب':'یادداشت اختصاصی ورق؛ پیش‌نویس نیازمند بررسی';
 const related=pdfStore.publicRows(db).filter(x=>x.book_id===book.id);
 const sample=readingSamples.publicSample(db,book.id);
 const guide=review&&!book.description&&generatedReview.record(db,review).status!=='hidden'?review.reader_note:'';
 const html=`<div class="shell main v67-reading-page"><nav class="v67-reader-back" aria-label="بازگشت"><a href="/book/${encodeURIComponent(book.slug)}">← صفحه اصلی کتاب</a><a href="/books/compare?book=${encodeURIComponent(book.slug)}">مقایسه با کتاب‌های دیگر</a><a href="/pdf-books">ویترین PDF</a></nav>
 <header class="v67-reader-hero"><div>${cover(book)}<span class="v67-cover-disclaimer">اگر تصویر مفهومی باشد، جلد رسمی ناشر نیست.</span></div><div><span class="eyebrow">VARAQ · READING ROOM</span><h1>${esc(book.title)}</h1><p>${esc(book.author||'نویسنده هنوز ثبت نشده')} · ${esc(book.category)}</p><p>این صفحه برای شناخت پیش از انتخاب است و پرداخت یا دانلود پولی انجام نمی‌دهد.</p></div></header>
 <nav class="v68-reader-toc" aria-label="بخش‌های این صفحه"><a href="#reader-intro">معرفی</a>${exclusiveFor(book)?'<a href="#reader-summary">خلاصه کتاب</a>':''}${guide?'<a href="#reader-guide">راهنمای مطالعه</a>':''}<a href="#sample">نمونه مجاز</a><a href="#reader-check">اطلاعات چاپ</a></nav>
 <div class="v67-reading-layout"><article class="v67-reader-sheet" id="reader-text"><div class="v68-reader-progress" role="progressbar" aria-label="میزان مرور صفحه" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span></span></div><div class="v67-reader-toolbar" aria-label="تنظیمات خوانایی"><span>تنظیم نمایش</span><button type="button" data-reading-font="smaller" aria-label="کوچک‌تر کردن نوشته">الف−</button><button type="button" data-reading-font="larger" aria-label="بزرگ‌تر کردن نوشته">الف+</button><button type="button" data-reading-contrast="toggle" aria-pressed="false">حالت مطالعه تیره</button><button type="button" data-reading-spacing aria-pressed="false">فاصله خطوط بیشتر</button><button type="button" data-reading-focus aria-pressed="false">مطالعه متمرکز</button><button type="button" data-reading-reset>بازنشانی</button></div>
 <h2 id="reader-intro">معرفی کتاب</h2><p class="v67-reader-label">${esc(originalNote)}</p>${editorial?`<p class="v67-text-body">${esc(editorial)}</p>`:'<p>معرفی این کتاب هنوز در حال بررسی است.</p>'}
 ${exclusiveSummary(book,'reader-summary')}
 ${guide?`<section class="v67-guide" id="reader-guide"><h2>راهنمای مطالعه ورق</h2><p class="v67-text-body">${esc(guide)}</p></section>`:''}
 <section class="v67-licensed-sample" id="sample"><h2>نمونه متن کتاب</h2>${sample?`<p class="v67-sample-label">نمونه محدود با اجازه انتشار ثبت‌شده · مالک حقوق: ${esc(sample.rights_holder)}${sample.expires_on?' · اعتبار تا '+esc(sample.expires_on):''}</p><blockquote class="v67-text-body">${esc(sample.body)}</blockquote><p class="muted tiny">این متن فقط برای آشنایی است؛ اجازه انتشار نمونه به معنی مجوز توزیع PDF کامل نیست.</p>`:'<p class="v67-sample-unavailable">نمونه‌ای از متن اصلی کتاب با مجوز قابل‌انتشار فعلاً ثبت نشده است. معرفی بالا متن تهیه‌شده توسط ورق است، نه بخشی از متن کتاب.</p>'}</section>
 </article><aside class="v67-reader-aside" id="reader-check"><h2>پیش از انتخاب</h2><p>نام نویسنده، چاپ، مترجم، ناشر و شابک را در صفحه اصلی کتاب بررسی کنید.</p><a class="cta" href="/book/${encodeURIComponent(book.slug)}#verified-editions">مشاهده شناسنامه و چاپ‌ها</a><a class="outline" href="/book/${encodeURIComponent(book.slug)}#book-offers">فروشندگان و موجودی ثبت‌شده</a>${related.length?`<h3>نسخه دیجیتال مرتبط</h3>${related.map(r=>`<p><a href="/pdf-books/${r.id}">${esc(r.title)} · ${esc(r.store_name)}</a></p>`).join('')}<small>فروش و تحویل پولی PDF فعلاً غیرفعال است.</small>`:'<p>برای این عنوان، نسخه دیجیتال تأییدشده‌ای برای نمایش یافت نشد.</p>'}</aside></div></div>`;
 return {book,html};
}
function panelReadingSamples(user,url){
 if(user.role!=='owner')return null;
 const chosen=Number(url.searchParams.get('book'))||1;
 const books=db.prepare('SELECT id,title FROM books ORDER BY id').all();
 const b=books.find(x=>x.id===chosen)||books[0];const row=b?readingSamples.get(db,b.id):null;
 const hist=b?db.prepare('SELECT status,revision,created_at FROM book_reading_sample_history WHERE book_id=? ORDER BY id DESC LIMIT 8').all(b.id):[];
 return panelShell(user,`<div class="panel-note"><h2>نمونه مطالعه با مجوز · نسخه ۶.۸</h2><p>این بخش برای نمونه متن دارای اجازه انتشار صریح است؛ PDF خصوصی را اینجا بارگذاری یا کپی نکنید. تنها مدیر YM می‌تواند نمونه را منتشر یا فوراً متوقف کند. نمونه‌های تولیدیِ معرفی کتاب، جدا از متن اصلی کتاب هستند.</p><form method="get" action="/panel/reading-samples" class="form-grid"><label>کتاب<select name="book">${books.map(x=>`<option value="${x.id}" ${b?.id===x.id?'selected':''}>${esc(x.title)}</option>`).join('')}</select></label><button class="outline">انتخاب کتاب</button></form></div>${b?`<div class="panel-note"><h2>نمونه ${esc(b.title)}</h2><p>وضعیت فعلی: <strong>${{draft:'پیش‌نویس',published:'قابل نمایش',withdrawn:'متوقف'}[row?.status||'draft']}</strong> · نسخه ${digits(row?.revision||0)}</p><form method="post" action="/panel/reading-samples" class="form-stack">${csrfInput(user)}<input type="hidden" name="book_id" value="${b.id}"><input type="hidden" name="revision" value="${row?.revision||0}"><label>متن کوتاه مجاز (۸۰ تا ۱۸۰۰ نویسه برای انتشار)<textarea name="body" rows="10" maxlength="1800">${esc(row?.body||'')}</textarea></label><label>صاحب حقوق / مجوزدهنده<input name="rights_holder" maxlength="140" value="${attr(row?.rights_holder||'')}"></label><label>شناسه قرارداد یا سند اجازه انتشار همین متن<input name="rights_evidence" maxlength="500" value="${attr(row?.rights_evidence||'')}"></label><label>تاریخ پایان اجازه نمایش (اختیاری)<input type="date" name="expires_on" value="${attr(row?.expires_on||'')}"></label><label>وضعیت<select name="status"><option value="draft" ${(row?.status||'draft')==='draft'?'selected':''}>پیش‌نویس، غیرعمومی</option><option value="published" ${row?.status==='published'?'selected':''}>انتشار نمونه دارای مجوز</option><option value="withdrawn" ${row?.status==='withdrawn'?'selected':''}>توقف فوری نمایش</option></select></label><label class="check-row"><input type="checkbox" name="license_confirm" value="1"> اجازه انتشار همین قطعه متن را از صاحب حقوق بررسی و ثبت کرده‌ام.</label><button class="cta">ثبت و به‌روزرسانی مجوز</button></form><p><a href="/book/${encodeURIComponent(db.prepare('SELECT slug FROM books WHERE id=?').get(b.id).slug)}/read" target="_blank" rel="noopener">مشاهده صفحه مطالعه</a></p>${hist.length?`<details><summary>تاریخچه تغییرات (${hist.length})</summary><ul>${hist.map(h=>`<li>${esc(h.created_at)} · ${esc(h.status)} · نسخه ${digits(h.revision)}</li>`).join('')}</ul></details>`:''}</div>`:''}`,'نمونه‌های مطالعه');
}

function bookDetail(slug, requestedEditionId=null){const b=db.prepare('SELECT * FROM books WHERE slug=?').get(slug);if(!b)return null;const sellers=db.prepare(`SELECT o.id,o.sku,o.price,o.quantity AS stock,o.edition_id,e.label AS edition_label,e.translator,e.publisher,e.isbn,s.id AS store_id,s.name,s.city FROM stock_items o LEFT JOIN editions e ON e.id=o.edition_id JOIN stores s ON s.id=o.store_id WHERE o.book_id=? AND o.active=1 AND o.quantity>0 AND (o.edition_id IS NULL OR e.verified=1) AND s.active=1 ORDER BY o.price`).all(b.id);
const editions=editionDetail.listed(db,b.id);
const publicationState=publicationReview.forBook(db,b.id);
const publicContentStatus=`<section class="book-evidence-note" aria-label="وضعیت تکمیل اطلاعات"><h2>وضعیت اطلاعات این کتاب</h2><ul><li>${publicationState.hasAuthor?'نام نویسنده ثبت شده':'نام نویسنده در حال تکمیل'}</li><li>${publicationState.hasIntro?'معرفی کتاب ثبت شده':'معرفی کامل در حال بررسی'}</li><li>${publicationState.hasSource?'حداقل یک چاپ دارای لینک منبع ثبت شده':'منبع مستقل چاپ هنوز ثبت نشده'}</li></ul><p>ثبت اطلاعات، تأیید مستقل صحت آن‌ها نیست؛ مشخصات نسخه فیزیکی و مجوز تصاویر باید جداگانه بررسی شوند.</p></section>`;
// v3.3: An edition is a distinct product identity. Never display a cover from
// another ISBN as though it belongs to the edition requested by the customer.
const hasEditionRequest=requestedEditionId!==null&&requestedEditionId!==undefined&&requestedEditionId!=='';
const requestedId=hasEditionRequest?Number(requestedEditionId):null;
if(hasEditionRequest&&(!Number.isSafeInteger(requestedId)||requestedId<1))return null;
const chosenEdition=hasEditionRequest?editions.find(e=>e.id===requestedId):null;
if(hasEditionRequest&&!chosenEdition)return null;
const heroEdition=chosenEdition||editions.find(e=>Boolean(availableEditionCover(e)))||editions[0]||null;
const heroEditionCover=heroEdition?availableEditionCover(heroEdition):'';
const heroCover=heroEdition?(heroEditionCover?`<div class="cover-image-frame bigcover"><img class="uploaded-cover" src="${attr(heroEditionCover)}" alt="جلد چاپ ${attr(heroEdition.publisher)}، شابک ${attr(heroEdition.isbn)}" loading="eager" width="320" height="440"></div>`:conceptArt(b,true)):cover(b,true);
const heroCaption=heroEdition?`<p class="edition-hero-caption">${chosenEdition?'چاپ انتخاب‌شده':'نمایش نمونه از یکی از چاپ‌های ثبت‌شده'}: <b>${esc(heroEdition.publisher||'ناشر در حال بررسی')}</b> · ${heroEdition.translator?'ترجمه '+esc(heroEdition.translator)+' · ':''}شابک <code dir="ltr">${esc(heroEdition.isbn||'نامشخص')}</code>${heroEditionCover?' · تصویر تأییدشده همین چاپ':' · جلد واقعی این چاپ هنوز تأیید نشده است'}</p>`:'';
const editionChooser=editions.length?`<section class="edition-selector" id="edition-picker" aria-label="انتخاب چاپ و ترجمه"><h2>انتخاب ترجمه و چاپ</h2><p class="muted tiny">هر گزینه شابک مستقلی دارد. انتخاب چاپ، موجودی فروشندگان و تصویر را مطابق همان شابک نمایش می‌دهد.</p><div class="edition-selector-grid"><a class="edition-choice ${!chosenEdition?'active':''}" href="/book/${encodeURIComponent(b.slug)}#edition-picker">همه چاپ‌ها</a>${editions.map(e=>`<a class="edition-choice ${chosenEdition?.id===e.id?'active':''}" href="/book/${encodeURIComponent(b.slug)}?edition=${e.id}#edition-picker" ${chosenEdition?.id===e.id?'aria-current="true"':''}>${esc(e.publisher||'ناشر نامشخص')} · ${esc(e.translator||e.label||'چاپ ثبت‌شده')}<small dir="ltr">${esc(e.isbn)}</small></a>`).join('')}</div></section>`:'';
const editionPrintRuns=printVariants.forBook(db,b.id);
const sellerPrices=marketGateway.enabled?[]:(chosenEdition?sellers.filter(o=>o.edition_id===chosenEdition.id):sellers).map(o=>({...o,...promotions.priceFor(db,o.id,o.price)}));
const eduInfo=education.get(db,b.id,true);

 const digitalRelated=pdfStore.publicRows(db).filter(x=>x.book_id===b.id);
 const digitalRelatedHtml=digitalRelated.length?`<section class="content-section v72-digital-section" id="digital-editions"><div class="v72-section-heading"><div><span class="eyebrow">DIGITAL EDITIONS</span><h2>نسخه‌های PDF مرتبط</h2></div><span class="v72-readonly-pill">فقط معرفی · بدون پرداخت</span></div><div class="v72-digital-list">${digitalRelated.map(x=>`<article class="v72-digital-card"><div><strong>${esc(x.title)}</strong><p>${esc(x.store_name)} · قیمت ثبت‌شده: ${money(x.price)}</p><small>پرونده مجاز برای معرفی؛ خرید و دریافت فایل هنوز فعال نیست.</small></div><a class="outline" href="/pdf-books/${encodeURIComponent(x.id)}">بررسی مشخصات PDF</a></article>`).join('')}</div></section>`:'';
 const v72Summary=bookDetailOverview.overview({editions,offers:sellerPrices,digital:digitalRelated,selectedEdition:chosenEdition});
 const v72Url='/book/'+encodeURIComponent(b.slug);
 const v72Overview=`<section class="v72-overview" aria-labelledby="v72-overview-title"><div class="v72-overview-heading"><h2 id="v72-overview-title">نسخه‌ها در یک نگاه</h2><span>وضعیت ثبت‌شده، نه امکان خرید</span></div><div class="v72-overview-grid"><a href="${v72Summary.editionCount?'#edition-picker':'#book-facts'}" class="v72-overview-item"><strong>${digits(v72Summary.editionCount)}</strong><span>شناسنامه چاپ ثبت‌شده</span></a><a href="#book-offers" class="v72-overview-item"><strong>${digits(v72Summary.sellerCount)}</strong><span>فروشنده با موجودی ثبت‌شده${v72Summary.editionSelected?' برای این چاپ':''}</span></a><a href="${v72Summary.digitalCount?'#digital-editions':'/pdf-books'}" class="v72-overview-item"><strong>${digits(v72Summary.digitalCount)}</strong><span>نسخه PDF قابل معرفی</span></a></div><div class="v72-price-note">${v72Summary.minPrice!==null?`<span>کمترین قیمت ثبت‌شده: <b>${money(v72Summary.minPrice)}</b></span>`:'<span>در حال حاضر قیمت و موجودی قابل نمایش برای این انتخاب ثبت نشده است.</span>'}${v72Summary.editionSelected?`<span>چاپ انتخاب‌شده · شابک <code dir="ltr">${esc(v72Summary.selectedIsbn||'ثبت نشده')}</code></span>`:''}</div><p>قیمت و موجودی قطعی نیست؛ ثبت سفارش واقعی و پرداخت فعال نشده است.</p></section>`;
 const v72Actions=`<nav class="v72-detail-actions" aria-label="دسترسی سریع به جزئیات کتاب"><a class="cta" href="${v72Url}/read">خواندن معرفی کتاب</a><a class="outline" href="${editions.length?'#edition-picker':'#book-facts'}">${editions.length?'بررسی چاپ‌ها':'مشخصات کتاب'}</a><a class="outline" href="/choose-format?book=${encodeURIComponent(b.slug)}">چاپی یا PDF؟</a></nav>`;

 const details=[['نویسنده',b.author],['موضوع',b.category],...(eduInfo?[['پایه',education.GRADES[eduInfo.grade]],['رشته',education.TRACKS[eduInfo.track]],['درس',eduInfo.subject],['هدف مطالعه',education.GOALS[eduInfo.goal]],['نوع منبع',education.TYPES[eduInfo.material_type]],...(eduInfo.exam_year?[['سال کنکور',eduInfo.exam_year]]:[])]:[])];
const editionView=editions.length?`<section class="edition-section" id="verified-editions"><h3>ترجمه‌ها و چاپ‌های ثبت‌شده</h3><p class="muted tiny">این اطلاعات از منابع کتاب‌شناختی گردآوری شده‌اند. چاپ موجود در هر فروشگاه باید جداگانه با شابک و بارکد نسخه فیزیکی تطبیق داده شود.</p><div class="edition-grid">${editions.map(e=>`<article class="edition-card" id="edition-${e.id}"><div class="edition-card-heading"><h4>${esc(e.label||'نسخه ثبت‌شده')}</h4>${e.source_url?'<span class="edition-source-tag">دارای منبع</span>':'<span class="edition-review-tag">بدون منبع مستقل</span>'}</div><div class="edition-cover-inline">${availableEditionCover(e)?`<img src="${attr(availableEditionCover(e))}" alt="${attr(e.alt||'جلد این چاپ از کتاب '+b.title)}" loading="lazy" width="92" height="124">`:'<span class="edition-cover-placeholder">تصویر این چاپ موجود نیست</span>'}</div><dl class="facts">${[['مترجم',e.translator],['ناشر',e.publisher],['شابک',e.isbn],['سال نشر',e.publication_year],['تعداد صفحات',e.pages?digits(e.pages):''],['نوع جلد',e.binding],['زبان',e.language]].filter(v=>v[1]).map(([k,v])=>`<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>${(editionPrintRuns[e.isbn]||[]).length>1?`<details class="print-history"><summary>اطلاعات نوبت‌های چاپ از ${digits(editionPrintRuns[e.isbn].length)} منبع</summary><p class="muted tiny">تعداد صفحات ممکن است میان نوبت‌ها یا منابع متفاوت ثبت شده باشد؛ پیش از خرید، شابک و نسخه فیزیکی را بررسی کنید.</p><ul>${editionPrintRuns[e.isbn].map(r=>`<li>چاپ ${esc(r.print_no)} · سال ${esc(r.publication_year)} · ${digits(r.pages)} صفحه · <a href="${attr(r.source_url)}" rel="noopener noreferrer nofollow" target="_blank">منبع</a></li>`).join('')}</ul></details>`:''}<div class="edition-evidence"><a class="outline" href="/book/${encodeURIComponent(b.slug)}?edition=${e.id}#edition-picker">نمایش همین چاپ</a>${editionDetail.trustworthySource(e.source_url)?`<a href="${attr(e.source_url)}" target="_blank" rel="noopener noreferrer nofollow">مشاهده منبع شناسنامه</a>`:'<span class="muted tiny">منبع مستقل ثبت نشده</span>'}<span>${e.sellers_count?`موجودی ثبت‌شده در ${digits(e.sellers_count)} فروشگاه`:'برای این چاپ موجودی فروشگاه ثبت نشده'}</span></div></article>`).join('')}</div></section>`:'<div class="soft-warning">اطلاعات مستند چاپ‌ها و ترجمه‌های این کتاب هنوز ثبت نشده است.</div>';
const structured={ '@context':'https://schema.org','@type':'Book',name:b.title,url:PUBLIC_URL+'/book/'+b.slug,...(b.author?{author:{'@type':'Person',name:b.author}}:{})};
if(chosenEdition){structured.isbn=chosenEdition.isbn;if(chosenEdition.publisher)structured.publisher={'@type':'Organization',name:chosenEdition.publisher};if(heroEditionCover)structured.image=heroEditionCover.startsWith('/')?PUBLIC_URL+heroEditionCover:heroEditionCover;}

const approvedStats=db.prepare("SELECT COUNT(*) count,AVG(rating) average FROM reader_reviews WHERE book_id=? AND status='approved'").get(b.id);if(approvedStats.count)structured.aggregateRating={'@type':'AggregateRating',ratingValue:Number(approvedStats.average.toFixed(2)),ratingCount:approvedStats.count,bestRating:5};
const head=`<script type="application/ld+json" nonce="__NONCE__">${JSON.stringify(structured).replace(/</g,'\\u003c')}</script>${seo.breadcrumbs(PUBLIC_URL,[{name:'خانه',path:'/'},{name:'کتاب‌ها',path:'/books'},{name:b.title,path:'/book/'+encodeURIComponent(b.slug)}])}`;
const content=`<div class="shell main"><div class="breadcrumbs"><a href="/">خانه</a> / <a href="/books">کتاب‌ها</a> / ${esc(b.title)}</div><nav class="v57-detail-nav" aria-label="بخش‌های صفحه کتاب"><a href="#v72-overview-title">در یک نگاه</a>${exclusiveFor(b)?'<a href="#book-summary">خلاصه کتاب</a>':''}<a href="#book-facts">مشخصات</a>${editions.length?`<a href="#edition-picker">چاپ‌ها و ترجمه‌ها</a>`:''}<a href="#book-offers">وضعیت فروشندگان</a><a href="/choose-format?book=${encodeURIComponent(b.slug)}">چاپی یا PDF؟</a>${digitalRelated.length?`<a href="#digital-editions">نسخه PDF</a>`:''}</nav><div class="v70-book-advisor" role="region" aria-label="راهنمای انتخاب نسخه کتاب"><div><b>قبل از انتخاب این کتاب</b><p>اطلاعات چاپی، PDF و وضعیت عرضه را کنار هم ببین؛ خرید و پرداخت هنوز فعال نیست.</p></div><a class="cta" href="/choose-format?book=${encodeURIComponent(b.slug)}">راهنمای نسخه‌های این کتاب ←</a></div><div class="book-detail"><div class="detail-cover">${heroCover}${heroCaption}</div><div class="detail-text"><span class="eyebrow">${esc(b.category)}</span><h1>${esc(b.title)}</h1>${v72Actions}${marketGateway.enabled&&!IS_PUBLIC?`<a class="outline" href="/market/legacy-book/${encodeURIComponent(b.id)}">مشاهده موجودی و سفارش این کتاب در فروشگاه ←</a>`:''}<a class="outline book-sheet-link" href="/book/${encodeURIComponent(b.slug)}/sheet">برگه اطلاعات و چاپ کتاب</a><a class="outline book-compare-link" href="/books/compare?book=${encodeURIComponent(b.slug)}">مقایسه با کتاب دیگر</a><button type="button" class="save-book detail-save" aria-pressed="false" data-book-slug="${attr(b.slug)}" data-book-title="${attr(b.title)}" data-book-author="${attr(b.author||'')}" data-book-category="${attr(b.category)}">♡ افزودن به فهرست مطالعه</button><p class="detail-author">${b.author?'نویسنده: <a href="/authors/'+encodeURIComponent(b.author)+'">'+esc(b.author)+'</a>':'اطلاعات نویسنده در حال تکمیل'}</p>${b.publisher?`<p class="detail-author">ناشر ثبت‌شده: <a href="/publishers/${encodeURIComponent(b.publisher)}">${esc(b.publisher)}</a></p>`:''}${v72Overview}${!b.description&&generatedIntro(b)?generatedIntroNotice(b):''}<p class="detail-lead">${esc(b.description||generatedIntro(b)||'این عنوان به بانک اطلاعات کتاب ورق اضافه شده است. اطلاعات کتاب‌شناختی و معرفی تحلیلی آن پس از بررسی منابع معتبر و چاپ‌های موجود تکمیل می‌شود.')}</p>${!b.description?generatedReadingGuide(b):''}${publicContentStatus}${exclusiveSummary(b)}<h3 id="book-facts">شناسنامه کتاب</h3><dl class="facts">${details.map(([k,v])=>`<div><dt>${k}</dt><dd>${esc(v||'در حال تکمیل')}</dd></div>`).join('')}</dl>${editionChooser}${editionView}${coverInfo(b.id)?`<p class="cover-credit">منبع تصویر جلد: ${esc(coverInfo(b.id).source)} · ${esc(coverInfo(b.id).rights_note)}</p>`:''}${IS_PUBLIC&&!coverInfo(b.id)&&bibliography.getCover(db,b.id,true)?`<p class="cover-credit">تصویر جلد واقعی از <a href="${attr(bibliography.getCover(db,b.id,IS_PUBLIC).source_url)}" target="_blank" rel="noopener noreferrer">منبع چاپ</a>؛ برای انتشار تجاری، مجوز بازنشر تصویر باید بررسی شود.</p>`:''}<div class="soft-warning">هر قیمت مربوط به یک SKU است. ردیف‌های قدیمی با برچسب «چاپ نامشخص» باید پیش از فروش واقعی با نسخه فیزیکی تطبیق داده شوند.</div></div><aside class="offer-panel" id="book-offers"><h3>فروشندگان این کتاب</h3>${chosenEdition?`<p class="muted tiny">فقط موجودی چاپ انتخاب‌شده با شابک <code dir="ltr">${esc(chosenEdition.isbn)}</code> نمایش داده می‌شود. <a href="/book/${encodeURIComponent(b.slug)}#edition-picker">نمایش همه چاپ‌ها</a></p>`:''}${sellerPrices.length?sellerPrices.map(s=>`<div class="offer-item"><div><b>${esc(s.name)}</b><small>${esc(s.city||'فروشگاه همکار')} · ${esc(s.edition_label||'چاپ نامشخص (موجودی قدیمی)')} · ${s.translator?'ترجمه '+esc(s.translator)+' · ':''}${s.isbn?'شابک: '+esc(s.isbn)+' · ':''}SKU: ${esc(s.sku)} · موجودی: ${digits(s.stock)}</small></div><div class="varaq-sale-price">${s.discountPercent?`<span class="varaq-price-old">${money(s.originalPrice)}</span><span class="varaq-sale-badge">${digits(s.discountPercent)}٪ تخفیف</span>`:''}<strong>${money(s.price)}</strong></div>${marketGateway.enabled&&!IS_PUBLIC?`<a class="cta" href="/market/legacy-book/${encodeURIComponent(b.id)}">بررسی قیمت و موجودی در فروشگاه</a>`:PUBLIC_READONLY?'<span class="public-readonly-label">اطلاعات فروشگاه؛ ثبت سفارش فعلاً فعال نیست</span>':`<button type="button" class="cta add-cart" data-offer="${s.id}" data-store-id="${s.store_id}" data-title="${attr(b.title)}" data-store="${attr(s.name)}" data-book-slug="${attr(b.slug)}" data-price="${s.price}">افزودن به سبد</button>`}</div>`).join(''):'<div class="empty small">در حال حاضر فروشنده‌ای برای این عنوان ثبت نشده است. این صفحه برای مطالعه اطلاعات کتاب فعال است.</div>'}<p class="muted tiny">پرداخت آنلاین تا آماده‌شدن درگاه فروشنده غیرفعال است.</p></aside></div></div>`;
return {b,content:content+`<div class="shell book-extras">${editorialBlock(b.id)}${editions.length>1?`<section class="content-section comparison-section"><h2>مقایسه چاپ‌ها و ترجمه‌ها</h2><p class="muted tiny">فقط نسخه‌هایی که اطلاعاتشان توسط مدیر تأیید شده نمایش داده می‌شوند.</p><div class="table-scroll"><table class="data-table edition-compare"><thead><tr><th>چاپ / ترجمه</th><th>مترجم</th><th>ناشر</th><th>سال نشر</th><th>صفحات</th><th>شابک</th></tr></thead><tbody>${editions.map(e=>`<tr><th>${esc(e.label||'چاپ ثبت‌شده')}</th><td>${esc(e.translator||'—')}</td><td>${esc(e.publisher||'—')}</td><td>${esc(e.publication_year||'—')}</td><td>${e.pages?digits(e.pages):'—'}</td><td dir="ltr">${esc(e.isbn||'—')}</td></tr>`).join('')}</tbody></table></div></section>`:''}${digitalRelatedHtml}<section class="content-section v67-reader-entry"><h2>آشنایی بیشتر پیش از انتخاب</h2><p>معرفی اختصاصی، راهنمای مطالعه و در صورت وجود مجوز، نمونه کوتاهی از متن اصلی را بخوانید.</p><a class="cta" href="/book/${encodeURIComponent(b.slug)}/read">ورود به فضای مطالعه کتاب ←</a></section>${reviewBlock(b)}${relatedBooks(b)}</div>`,head};}
function stores(){const rows=db.prepare('SELECT s.*,COUNT(DISTINCT o.book_id) AS books FROM stores s LEFT JOIN stock_items o ON o.store_id=s.id AND o.active=1 AND o.quantity>0 WHERE s.active=1 GROUP BY s.id ORDER BY s.id').all();return `<div class="shell main"><div class="page-banner"><span class="eyebrow">INDEPENDENT BOOKSTORES</span><h1>کتاب‌فروشی‌های همکار</h1><p>${marketGateway.enabled?`این صفحه برای معرفی فروشگاه‌های همکار است؛ قیمت و موجودی جاری فقط در <a href="/market/shops">فهرست فروشگاه‌های خرید</a> نمایش داده می‌شود.`:`هر فروشگاه، پنل و موجودی اختصاصی خودش را دارد.`}</p></div><div class="store-grid">${rows.map(s=>`<a class="store-card" href="/store/${s.id}"><div class="store-logo">📚</div><h2>${esc(s.name)}</h2><p>${esc(s.city||'ایران')}</p><span>${marketGateway.enabled?'مشخصات فروشگاه ←':digits(s.books)+' عنوان قابل عرضه ←'}</span></a>`).join('')||'<div class="empty">هنوز فروشگاهی فعال نشده است.</div>'}</div></div>`;}
function singleStore(id){const s=db.prepare('SELECT * FROM stores WHERE id=? AND active=1').get(id);if(!s)return null;
 const offers=db.prepare('SELECT b.*,MIN(o.price) AS price FROM stock_items o JOIN books b ON b.id=o.book_id LEFT JOIN editions e ON e.id=o.edition_id WHERE o.store_id=? AND o.active=1 AND o.quantity>0 AND (o.edition_id IS NULL OR e.verified=1) GROUP BY b.id ORDER BY MAX(o.updated_at) DESC').all(s.id);
 const highlighted=db.prepare(`SELECT f.headline,i.id AS item_id,i.price,b.id,b.title,b.author,b.slug,b.category
 FROM store_featured_items f JOIN stock_items i ON i.id=f.item_id AND i.store_id=f.store_id JOIN books b ON b.id=i.book_id
 LEFT JOIN editions e ON e.id=i.edition_id
 WHERE f.store_id=? AND f.enabled=1 AND i.active=1 AND i.price>0 AND i.quantity>0 AND (i.edition_id IS NULL OR e.verified=1)
 ORDER BY f.priority,f.updated_at DESC LIMIT 8`).all(s.id).map(x=>({...x,price:promotions.priceFor(db,x.item_id,x.price).price}));
 return {s,content:`<div class="shell main"><div class="page-banner"><span class="eyebrow">PARTNER BOOKSTORE</span><h1>${esc(s.name)}</h1><p>${esc(s.city)} · ${esc(s.about||'کتاب‌فروشی همکار ورق')}</p>${marketGateway.enabled?`<p><a class="cta" href="/market/shops">مشاهده عرضه جاری در فروشگاه خرید ←</a></p><p>فهرست این صفحه تاریخی و اطلاع‌رسانی است، نه موجودی قابل سفارش.</p>`:''}</div>${highlighted.length?`<section class="section"><div class="section-heading"><div><span class="section-kicker">CURATED BY STORE</span><h2>پیشنهادهای این کتاب‌فروشی</h2></div></div><p class="muted tiny">این کتاب‌ها به انتخاب فروشگاه نمایش داده شده‌اند، نه براساس میزان فروش واقعی.</p><div class="book-grid">${highlighted.map(x=>`<div><span class="featured-tag">انتخاب فروشگاه${x.headline?' · '+esc(x.headline):''}</span>${bookCard(x)}</div>`).join('')}</div></section>`:''}<h2 class="block-title">کتاب‌های این فروشگاه</h2>${offers.length?`<div class="book-grid">${offers.map(bookCard).join('')}</div>`:'<div class="empty">فروشگاه هنوز موجودی خود را وارد نکرده است.</div>'}</div>`};}
function cleanInput(name,value='',type='text',required=false){return `<label class="input-label">${esc(name)}<input ${type==='number'?'min="0" step="1"':''} type="${type}" name="${attr(name)}" value="${attr(value)}" ${required?'required':''}></label>`;}
function csrfInput(user){return `<input type="hidden" name="csrf" value="${attr(user.csrf)}">`;}
function loginForm(error=''){return `<div class="shell auth-shell"><div class="auth-box"><div class="mark">و</div><h1>ورود به پنل فروشندگان</h1><p>ورود تنها برای کاربران ثبت‌شده و تأییدشده توسط مدیریت YM.</p>${error?`<div class="error">${esc(error)}</div>`:''}<form method="post" action="/login" class="form-stack"><label>نام کاربری<input name="username" required autocomplete="username" maxlength="60"></label><label>رمز عبور<input name="password" required type="password" autocomplete="current-password"></label><button class="cta">ورود امن</button></form><a href="/">بازگشت به سایت</a></div></div>`;}
function setupForm(error=''){return `<div class="shell auth-shell"><div class="auth-box"><h1>راه‌اندازی اولیه ورق</h1><p>کد راه‌اندازی را از پنجره اجرای سرور بردار. این صفحه پس از ساخت مدیر مرکزی غیرفعال می‌شود.</p>${error?`<div class="error">${esc(error)}</div>`:''}<form method="post" action="/setup" class="form-stack"><label>کد راه‌اندازی<input type="password" name="setup_token" required></label><label>نام کاربری مدیر YM<input name="username" required minlength="3" maxlength="50" autocomplete="off"></label><label>رمز عبور قوی مدیر<input name="password" required minlength="12" type="password" autocomplete="new-password"></label><label>نام فروشگاه اولیه<input name="store_name" required maxlength="100" placeholder="مثلاً کتاب‌فروشی همکار"></label><label>شهر فروشگاه<input name="city" maxlength="80" placeholder="مثلاً یزد"></label><button class="cta">ساخت مدیر و پایگاه اولیه</button></form></div></div>`;}

function accountPage(user,error='',success=''){
 const must=user.must_change_password===1;
 return panelShell(user,`<div class="panel-note"><h2>تنظیمات حساب ${user.role==='owner'?'مدیریت مرکزی':'فروشنده'}</h2>
 ${must?'<div class="soft-warning">⚠️ برای امنیت، رمز اولیه عمومی است؛ تا زمان تغییر رمز امکان استفاده از قسمت‌های دیگر پنل وجود ندارد.</div>':''}
 ${error?`<div class="error">${esc(error)}</div>`:''}${success?`<div class="soft-warning">${esc(success)}</div>`:''}
 <form method="post" action="/panel/account" class="form-grid">
 ${csrfInput(user)}<label>نام کاربری جدید<input name="username" required minlength="3" maxlength="50" autocomplete="username" value="${attr(user.username)}"></label>
 <label>رمز عبور فعلی<input name="old_password" type="password" required autocomplete="current-password"></label>
 <label>رمز عبور جدید ${must?'(الزامی)':'(در صورت نیاز)'}<input name="new_password" type="password" autocomplete="new-password" minlength="12" ${must?'required':''}></label>
 <label>تکرار رمز عبور جدید<input name="confirm_password" type="password" autocomplete="new-password" ${must?'required':''}></label>
 <button class="cta">ثبت و خروج امن از حساب</button></form><p class="muted tiny">پس از ذخیره، همه نشست‌های قبلی این حساب باطل می‌شوند. برای ورود دوباره از نام کاربری/رمز جدید استفاده کن.</p></div>`, 'حساب و امنیت');
}
function validIsbn(raw){
 if(!raw)return true;
 const v=raw.replace(/[ -]/g,'').toUpperCase();
 if(/^\d{13}$/.test(v))return [...v].reduce((sum,ch,i)=>sum+Number(ch)*(i%2?3:1),0)%10===0;
 if(/^\d{9}[\dX]$/.test(v))return [...v].reduce((sum,ch,i)=>sum+(ch==='X'?10:Number(ch))*(10-i),0)%11===0;
 return false;
}
function panelEditions(user,url){
 if(user.role!=='owner')return null;
 const books=db.prepare('SELECT id,title FROM books ORDER BY id').all();
 const bookId=Number(url.searchParams.get('book'))||books[0]?.id;
 const book=db.prepare('SELECT id,title FROM books WHERE id=?').get(bookId);
 if(!book)return panelShell(user,'<div class="empty">کتابی انتخاب نشده است.</div>','چاپ‌ها و ترجمه‌ها');
 const editingId=Number(url.searchParams.get('edit'))||0;
 const editing=editingId?db.prepare('SELECT * FROM editions WHERE id=? AND book_id=?').get(editingId,bookId):null;
 const editions=db.prepare('SELECT * FROM editions WHERE book_id=? ORDER BY id DESC').all(bookId);
 const selectBooks=`<form class="inventory-filter" action="/panel/editions" method="get"><label>انتخاب کتاب<select name="book">${books.map(b=>`<option value="${b.id}" ${b.id===bookId?'selected':''}>${esc(b.title)}</option>`).join('')}</select></label><button class="cta">نمایش چاپ‌ها</button></form>`;
 return panelShell(user,`${selectBooks}<div class="panel-note"><h2>${editing?'ویرایش نسخه':'افزودن چاپ یا ترجمه جدید'} — ${esc(book.title)}</h2>
 <p class="muted tiny">هر نسخه یک ISBN، ناشر، مترجم و مشخصات چاپ مستقل دارد. اطلاعات تأییدنشده به‌عنوان نسخه قطعی به بازدیدکنندگان نمایش داده نمی‌شوند.</p>
 <form method="post" action="/panel/edition" class="form-grid">${csrfInput(user)}<input type="hidden" name="book_id" value="${bookId}"><input type="hidden" name="id" value="${editing?.id||''}">
 <label>عنوان یا نام چاپ<input name="label" maxlength="140" value="${attr(editing?.label||'')}" placeholder="مثلاً ترجمه دوم، جلد سخت"></label>
 <label>مترجم<input name="translator" maxlength="160" value="${attr(editing?.translator||'')}"></label>
 <label>ناشر<input name="publisher" maxlength="160" value="${attr(editing?.publisher||'')}"></label>
 <label>شابک ISBN-10/13<input name="isbn" maxlength="20" dir="ltr" value="${attr(editing?.isbn||'')}" placeholder="978..."></label>
 <label>سال انتشار<input name="publication_year" maxlength="12" value="${attr(editing?.publication_year||'')}" placeholder="مثلاً ۱۴۰۴"></label>
 <label>تعداد صفحات<input name="pages" type="number" min="1" max="20000" value="${editing?.pages??''}"></label>
 <label>نوع جلد<input name="binding" maxlength="40" value="${attr(editing?.binding||'')}" placeholder="شومیز یا گالینگور"></label>
 <label>زبان<input name="language" maxlength="40" value="${attr(editing?.language||'فارسی')}"></label>
 <label class="full">توضیحات نسخه<textarea name="notes" maxlength="1200">${esc(editing?.notes||'')}</textarea></label>
 <label class="checkbox-line"><input type="checkbox" name="verified" value="1" ${editing?.verified?'checked':''}> اطلاعات این چاپ را با منبع معتبر بررسی کرده‌ام</label>
 <button class="cta">ذخیره نسخه</button></form></div>
 <h2 class="block-title">چاپ‌های ثبت‌شده (${digits(editions.length)})</h2>
 <div class="table-scroll"><table class="data-table"><tr><th>نسخه</th><th>مترجم</th><th>ناشر</th><th>شابک</th><th>وضعیت</th><th>عملیات</th></tr>
 ${editions.map(e=>`<tr><td>${esc(e.label||'چاپ بدون عنوان')}</td><td>${esc(e.translator||'—')}</td><td>${esc(e.publisher||'—')}</td><td dir="ltr">${esc(e.isbn||'—')}</td><td>${e.verified?'تأییدشده':'نیازمند بررسی'}</td><td><a href="/panel/editions?book=${bookId}&edit=${e.id}">ویرایش</a></td></tr>`).join('')}</table></div>`, 'چاپ‌ها و ترجمه‌ها');
}

function panelCategories(user,url){
 if(user.role!=='owner')return null;
 const rows=db.prepare('SELECT c.*, (SELECT count(*) FROM books b WHERE b.category=c.name) AS count FROM book_categories c ORDER BY c.name').all();
 const edit=Number(url.searchParams.get('edit'))?rows.find(x=>x.id===Number(url.searchParams.get('edit'))):null;
 const options=rows.filter(x=>x.id!==edit?.id).map(x=>`<option value="${x.id}" ${edit?.parent_id===x.id?'selected':''}>${esc(x.name)}</option>`).join('');
 return panelShell(user,`<div class="panel-note"><h2>${edit?'ویرایش موضوع':'ایجاد دسته‌بندی'}</h2><p class="muted">موضوع‌ها برای همه فروشگاه‌ها مشترک‌اند. با تغییر نام یک موضوع، کتاب‌های وابسته به همان نام نیز تغییر می‌کنند؛ حذف خودکار کتاب وجود ندارد.</p>
 <form class="form-grid" action="/panel/category" method="post">${csrfInput(user)}<input type="hidden" name="id" value="${edit?.id||''}">
 <label>نام فارسی<input required name="name" maxlength="100" value="${attr(edit?.name||'')}" placeholder="رمان ایرانی"></label>
 <label>نامک انگلیسی برای نشانی صفحات<input required name="slug" pattern="[a-z0-9-]{2,80}" value="${attr(edit?.slug||'')}" placeholder="iranian-novels"></label>
 <label>دسته‌بندی مادر<select name="parent_id"><option value="">بدون والد (موضوع اصلی)</option>${options}</select></label>
 <label class="checkbox-line"><input name="active" type="checkbox" value="1" ${!edit||edit.active?'checked':''}> فعال در فهرست عمومی</label>
 <button class="cta">ذخیره موضوع</button></form></div>
 <div class="table-scroll"><table class="data-table"><tr><th>عنوان دسته‌بندی</th><th>زیرمجموعه</th><th>تعداد مستقیم کتاب</th><th>وضعیت</th><th>عملیات</th></tr>${rows.map(c=>`<tr><td>${esc(c.name)}</td><td>${esc(rows.find(x=>x.id===c.parent_id)?.name||'—')}</td><td>${digits(c.count)}</td><td>${c.active?'فعال':'غیرفعال'}</td><td><a href="/panel/categories?edit=${c.id}">ویرایش</a> · <a href="/category/${encodeURIComponent(c.slug)}">نمایش</a></td></tr>`).join('')}</table></div>`, 'دسته‌بندی‌ها');
}
function panelImport(user){
 if(user.role!=='owner')return null;
 return panelShell(user,`<div class="panel-note"><h2>ورود گروهی کتاب‌ها از CSV یا TSV</h2><p>فایل CSV UTF-8 با ستون‌های <code>title,author,category,description,publisher</code> وارد کن. ستون‌های عنوان و دسته‌بندی اجباری هستند. تعداد مجاز حداکثر ۵۰۰ ردیف در هر نوبت است.</p>
 <p>برای ورود امن، ابتدا دکمه پیش‌نمایش را بزن؛ کتاب‌هایی که عنوان و نویسنده برابر با رکورد موجود دارند اضافه نمی‌شوند. هیچ رکورد موجودی بازنویسی یا حذف نمی‌شود.</p>
 <p><a class="outline" href="/panel/import-template">دریافت نمونه CSV</a></p>
 <form action="/panel/import" method="post" class="form-grid" id="import-form">${csrfInput(user)}
 <label class="full">فایل CSV/TSV از رایانه<input id="csv-file" type="file" accept=".csv,.tsv,text/csv,text/tab-separated-values"></label>
 <label class="full">محتوای فایل (یا ورود مستقیم)<textarea id="csv-input" name="csv" rows="12" maxlength="300000" required placeholder="title,author,category,description,publisher"></textarea></label>
 <label class="checkbox-line full"><input type="checkbox" name="confirm" value="1"> ورود قطعی را تأیید می‌کنم (فقط پس از بررسی داده‌ها)</label>
 <button class="cta" type="submit" name="mode" value="preview">بررسی و پیش‌نمایش فایل</button><button class="outline" type="submit" name="mode" value="commit">ثبت نهایی کتاب‌های معتبر</button>
 </form><div class="soft-warning">مدیریت تصاویر جلد و چاپ‌های دارای ISBN جداست. فایل CSV فقط کتاب‌های اصلی (آثار) را وارد می‌کند، نه قیمت و موجودی فروشندگان.</div></div>`, 'ورود گروهی CSV');
}
function importResult(user,valid,issues,committed,inserted=0,skipped=0){
 return panelShell(user,`<div class="panel-note"><h2>${committed?'نتیجه ورود گروهی':'پیش‌نمایش و اعتبارسنجی CSV'}</h2>
 <div class="stats panel-stats"><div><b>${digits(committed?inserted:valid.length)}</b><span>${committed?'کتاب افزوده شد':'آماده ورود'}</span></div><div><b>${digits(issues.length+skipped)}</b><span>ردیف ردشده یا تکراری</span></div></div>
 ${issues.length?`<details open><summary>گزارش ردیف‌های ردشده (${digits(issues.length)})</summary><ul>${issues.slice(0,35).map(x=>`<li>${esc(x)}</li>`).join('')}</ul>${issues.length>35?'<p>فقط ۳۵ مورد نخست نمایش داده شده است.</p>':''}</details>`:'<p>خطای اعتبارسنجی یا عنوان تکراری شناسایی نشد.</p>'}
 ${committed?'<p><a class="cta" href="/panel/books">نمایش بانک کتاب</a> <a class="outline" href="/panel/import">ورود فایل بعدی</a></p>':'<p>برای واردکردن قطعی فایل، به بخش «ورود گروهی» برگرد، فایل را دوباره انتخاب کن و تأیید ورود قطعی را فعال کن. هنگام ورود نهایی دوباره اعتبارسنجی انجام می‌شود.</p>'}
 </div><h2 class="block-title">نمونه کتاب‌های معتبر</h2><div class="table-scroll"><table class="data-table"><tr><th>ردیف</th><th>عنوان</th><th>نویسنده</th><th>دسته‌بندی</th></tr>${valid.slice(0,25).map(r=>`<tr><td>${r.line}</td><td>${esc(r.title)}</td><td>${esc(r.author||'—')}</td><td>${esc(r.category)}</td></tr>`).join('')}</table></div>`, 'ورود گروهی CSV');
}
function panelContentBatch(user,csv='',preview=null,message=''){
 if(!user||user.role!=='owner')return '';
 const previewHtml=preview?`<div class="panel-note"><h2>پیش‌نمایش تغییرات (هنوز ذخیره نشده)</h2><p>${digits(preview.length)} کتاب · ${digits(preview.reduce((n,r)=>n+r.changes.length,0))} فیلد خالی قابل تکمیل</p><div class="table-scroll content-batch-result"><table class="data-table"><thead><tr><th>کتاب</th><th>فیلد</th><th>متن ثبت‌شونده</th><th>منبع</th></tr></thead><tbody>${preview.flatMap(r=>r.changes.map(c=>`<tr><td>${esc(r.title)}</td><td>${esc(c.field)}</td><td>${esc(c.value.length>140?c.value.slice(0,140)+'…':c.value)}</td><td><a target="_blank" rel="noopener noreferrer nofollow" href="${attr(c.source_url)}">لینک منبع</a></td></tr>`)).join('')}</tbody></table></div><p class="soft-warning">ثبت فقط در فیلدهای خالی امکان‌پذیر است. قبل از اعمال، متن و حق استفاده از محتوای منبع را بررسی کنید؛ کپی‌برداری بدون اجازه مجاز نیست.</p></div>`:'';
 return panelShell(user,`<div class="panel-note"><h2>تکمیل گروهی مستند بانک کتاب</h2><p>با فایل CSV، فیلدهای خالی نویسنده، ناشر و معرفی کتاب را تکمیل کنید؛ هر سطر باید لینک منبع HTTPS داشته باشد. هیچ اطلاعاتی بدون اقدام شما نوشته نمی‌شود و داده‌های قبلی بازنویسی نمی‌شوند.</p><p><a class="outline" href="/panel/content-workbook">ساخت کاربرگ ویژه کتاب‌های ناقص</a> · <a class="outline" href="/panel/content-batch-template">دریافت نمونه CSV خالی</a> · <a href="/panel/cover-completion">صف کمبود جلد و مشخصات</a> · <a href="/panel/covers">بارگذاری جلد مجاز</a></p><p class="muted tiny">ستون‌ها: book_id,author,publisher,description,source_url. حداکثر ۵۰ ردیف؛ معرفی حداقل ۱۰۰ حرف. سلول خالی یعنی بدون تغییر. برای فیلدهای دارای متن قبلی، از ویرایش تکی استفاده کنید.</p></div>${message?`<div class="flash" role="status">${esc(message)}</div>`:''}${previewHtml}<div class="panel-note"><h2>${preview?'تأیید نهایی ورود اطلاعات':'بارگذاری متنی CSV و پیش‌نمایش'}</h2><form method="post" action="/panel/content-batch" class="form-grid">${csrfInput(user)}<label class="full">انتخاب فایل CSV از رایانه<input id="content-workbook-upload" type="file" accept=".csv,text/csv" aria-describedby="content-workbook-file-status"></label><p id="content-workbook-file-status" role="status" class="muted tiny full">برای واردکردن CSV ذخیره‌شده، فایل را انتخاب کنید یا متن آن را مستقیماً وارد کنید.</p><label class="full">متن فایل CSV<textarea id="content-workbook-text" name="csv" rows="9" required maxlength="55000" spellcheck="false" dir="ltr" placeholder="book_id,author,publisher,description,source_url">${esc(csv)}</textarea></label>${preview?`<label class="check-row full"><input type="checkbox" name="confirm" value="1" required> متن، منبع و اجازه استفاده را بررسی کرده‌ام.</label><button class="cta" name="mode" value="apply">ثبت اطلاعات پس از بررسی</button>`:`<button class="cta" name="mode" value="preview">پیش‌نمایش و کنترل خطاها</button>`}</form></div>`,'تکمیل گروهی مستند');
}
function panelCovers(user,url){
 if(user.role!=='owner')return null;
 const q=str(url.searchParams.get('q'),70);
 const candidates=db.prepare('SELECT id,title,author,category FROM books WHERE title LIKE ? OR author LIKE ? ORDER BY id DESC LIMIT 35').all('%'+q+'%','%'+q+'%');
 const bookId=Number(url.searchParams.get('book'))||candidates[0]?.id||0;
 const book=db.prepare('SELECT id,title FROM books WHERE id=?').get(bookId);
 const previous=book?coverInfo(bookId):null;
 return panelShell(user,`<div class="panel-note"><h2>تصویر جلد کتاب‌ها</h2><p>تصاویر اصلی را فقط وقتی وارد کن که مجوز نشر، اجازه ناشر یا حق استفاده قانونی از تصویر را داری. فایل‌ها در پوشه <code>storage/covers</code> ذخیره می‌شوند و از بکاپ جدا نشوند.</p>
 <form action="/panel/covers" method="get" class="inventory-filter"><label>جست‌وجوی اثر<input name="q" value="${attr(q)}" placeholder="عنوان یا نویسنده"></label><button class="cta">جست‌وجو</button></form>
 <div class="cover-selector">${candidates.map(x=>`<a class="${bookId===x.id?'chosen':''}" href="/panel/covers?book=${x.id}">${esc(x.title)}</a>`).join('')}</div>
 ${book?`<h3>${esc(book.title)}</h3>${previous?`<div class="cover-preview"><img alt="${attr(previous.alt)}" src="/media/covers/${attr(previous.filename)}" width="150"><div><p>منبع: ${esc(previous.source)}</p><p>مبنای حق استفاده: ${esc(previous.rights_note)}</p><form action="/panel/cover" method="post">${csrfInput(user)}<input type="hidden" name="book_id" value="${bookId}"><input type="hidden" name="cover_action" value="delete"><button class="save-mini danger" type="submit">حذف تصویر فعلی</button></form></div></div>`:''}
 <form action="/panel/cover-upload" method="post" enctype="multipart/form-data" class="form-grid">${csrfInput(user)}<input type="hidden" name="book_id" value="${bookId}">
 <label class="full">انتخاب تصویر واقعی (PNG / JPEG / WebP، حداکثر ۷۰۰ کیلوبایت)<input type="file" name="cover" accept="image/png,image/jpeg,image/webp" required></label>
 <label>متن جایگزین تصویر<input name="alt" maxlength="180" placeholder="جلد کتاب ${attr(book.title)}"></label>
 <label>منبع تصویر یا صاحب حق<input name="source" maxlength="160" required placeholder="ناشر / عکاس / مالک حقوق"></label>
 <label class="full">مبنای مجوز استفاده<input name="rights_note" maxlength="240" required placeholder="اجازه کتبی ناشر، تصویر متعلق به خودم یا مجوز معتبر"></label>
 <label class="checkbox-line full"><input type="checkbox" value="1" name="licensed" required> تأیید می‌کنم حق انتشار این تصویر در سایت را دارم.</label><button class="cta">بارگذاری تصویر جلد</button></form>`:'<p>کتابی انتخاب نشده است.</p>'}
 </div>`, 'تصاویر جلد');
}

function panelReviews(user,url){if(user.role!=='owner')return null;
 const status=['pending','approved','rejected'].includes(url.searchParams.get('status'))?url.searchParams.get('status'):'pending';
 const records=db.prepare('SELECT r.*,b.title AS book_title,b.slug AS book_slug FROM reader_reviews r JOIN books b ON b.id=r.book_id WHERE r.status=? ORDER BY r.id DESC LIMIT 100').all(status);
 const tabs=[['pending','در انتظار تأیید'],['approved','منتشرشده'],['rejected','ردشده']].map(([v,label])=>`<a class="review-tab ${v===status?'active':''}" href="/panel/reviews?status=${v}">${label}</a>`).join('');
 const count=db.prepare("SELECT COUNT(*) AS n FROM reader_reviews WHERE status='pending'").get().n;
 return panelShell(user,`<div class="panel-note"><h2>مدیریت نظرهای خوانندگان</h2><p>تا زمانی که مدیر نظر را تأیید نکند، متن یا امتیاز آن در سایت نمایش داده نمی‌شود.</p><p><b>${digits(count)}</b> نظر در صف بررسی</p></div><nav class="review-tabs">${tabs}</nav><div class="review-admin-list">${records.map(r=>`<article class="panel-note"><div class="reader-review-top"><b>${esc(r.display_name)} · ${digits(r.rating)} از ۵</b><a href="/book/${encodeURIComponent(r.book_slug)}">${esc(r.book_title)} ←</a></div><p>${esc(r.body)}</p><small>${esc(r.created_at)}</small><div class="button-row"><form method="post" action="/panel/review-moderate">${csrfInput(user)}<input type="hidden" name="id" value="${r.id}"><input type="hidden" name="action" value="approved"><button class="cta">تأیید و انتشار</button></form><form method="post" action="/panel/review-moderate">${csrfInput(user)}<input type="hidden" name="id" value="${r.id}"><input type="hidden" name="action" value="rejected"><button class="outline">رد نظر</button></form></div></article>`).join('')||'<div class="quiet-note">نظری در این وضعیت وجود ندارد.</div>'}</div>`, 'نظرات کاربران');}
function panelEditorial(user,url){if(user.role!=='owner')return null;
 const bookId=Number(url.searchParams.get('book'))||1;const book=db.prepare('SELECT id,title,slug FROM books WHERE id=?').get(bookId);
 const selected=book||db.prepare('SELECT id,title,slug FROM books ORDER BY id LIMIT 1').get();const row=selected?db.prepare('SELECT * FROM book_editorials WHERE book_id=?').get(selected.id):null;
 const query=str(url.searchParams.get('q'),80);const results=db.prepare('SELECT id,title FROM books WHERE title LIKE ? ORDER BY id LIMIT 24').all('%'+query+'%');
 return panelShell(user,`<div class="panel-note"><h2>بررسی تخصصی برای کتاب‌های واقعی</h2><p>تا وقتی متن بررسی نشود و دکمه انتشار فعال نشود، تحلیل در صفحه عمومی نمایش داده نمی‌شود. از نقدهای ساختگی و نقل‌قول بدون منبع خودداری کنید.</p><form method="get" action="/panel/editorial" class="filterbar"><input name="q" value="${attr(query)}" placeholder="جست‌وجوی عنوان"><button class="cta">جست‌وجو</button></form><div class="mini-books">${results.map(b=>`<a class="${selected?.id===b.id?'selected':''}" href="/panel/editorial?book=${b.id}">${esc(b.title)}</a>`).join('')}</div></div>${selected?`<div class="panel-note"><h2>ویرایش: ${esc(selected.title)}</h2><form method="post" action="/panel/editorial" class="form-stack">${csrfInput(user)}<input type="hidden" name="book_id" value="${selected.id}"><label>خلاصه تحلیلی<textarea name="summary" rows="5" maxlength="5000">${esc(row?.summary||'')}</textarea></label><label>این کتاب مناسب چه کسانی است؟<textarea name="audience" rows="3" maxlength="2000">${esc(row?.audience||'')}</textarea></label><label>نکات برجسته<textarea name="strengths" rows="3" maxlength="2000">${esc(row?.strengths||'')}</textarea></label><label>نکاتی که قبل از انتخاب باید دانست<textarea name="cautions" rows="3" maxlength="2000">${esc(row?.cautions||'')}</textarea></label><label class="check-row"><input type="checkbox" name="published" value="1" ${row?.published?'checked':''}> تأیید محتوایی و انتشار عمومی</label><button class="cta">ذخیره بررسی</button></form><p class="muted tiny">وضعیت: ${row?.published?'منتشرشده':'پیش‌نویس / بدون انتشار'} · <a href="/book/${encodeURIComponent(selected.slug)}">مشاهده صفحه کتاب</a></p></div>`:''}`, 'بررسی تخصصی');}
function savedPage(){return `<div class="shell main"><div class="page-banner v14-saved-banner"><span class="eyebrow">MY READING LIST</span><h1>کتاب‌های نشان‌شده من</h1><p>کتاب‌هایی که برای بررسی یا مطالعه بعدی انتخاب می‌کنی، فقط در همین مرورگر نگهداری می‌شوند. این فهرست خرید یا رزرو نیست.</p></div><div class="v14-saved-tools"><a class="outline" href="/books">← جست‌وجوی کتاب‌های بیشتر</a><button type="button" class="v14-clear-saved" id="clear-saved">پاک‌کردن نشان‌های چاپی</button></div><h2 class="v81-saved-heading">کتاب‌های چاپی</h2><div id="saved-root" class="v14-saved-grid" aria-live="polite"><p>در حال نمایش فهرست مطالعه…</p></div><div class="v14-saved-tools v81-saved-pdf-head"><h2 class="v81-saved-heading">نسخه‌های PDF نشان‌شده</h2><div class="button-row"><a class="outline" href="/pdf-books">مرور کتاب‌های PDF</a><button type="button" class="v14-clear-saved" id="clear-pdf-saved">پاک‌کردن نشان‌های PDF</button></div></div><p class="muted tiny">این فهرست فقط برای یادآوری است؛ ممکن است وضعیت مجوز و نمایش یک فایل بعداً تغییر کند. نشان‌کردن به معنی خرید یا دسترسی دانلود نیست.</p><div id="saved-pdf-root" class="v14-saved-grid" aria-live="polite"><p>در حال نمایش PDFهای نشان‌شده…</p></div></div>`;}
function cartPage(){if(PUBLIC_READONLY)return `<div class="shell main"><div class="page-banner"><h1>ورق در مرحله معرفی کتاب‌ها</h1><p>فروش، ثبت سفارش، پرداخت و ارسال در نسخه عمومی اولیه فعال نیست. می‌توانید اطلاعات کتاب‌ها و کتاب‌فروشی‌های همکار را مشاهده کنید.</p><a class="cta" href="/books">بازگشت به فهرست کتاب‌ها</a></div></div>`;return `<div class="shell main"><div class="page-banner"><span class="eyebrow">DEMO CHECKOUT</span><h1>سبد کتاب‌ها و ثبت سفارش نمونه</h1><p>انتخاب کتاب‌ها و ثبت سفارش صرفاً برای آزمایش مراحل سایت است. قیمت و موجودی قبل از ثبت از سرور بررسی می‌شود؛ پرداخت، رزرو کالا و ارسال واقعی انجام نمی‌شود.</p></div><div class="soft-warning">🔒 امکان ثبت سفارش پولی وجود ندارد. هیچ پولی دریافت نمی‌شود. لطفاً نام، شماره تماس یا نشانی واقعی وارد نکنید؛ فقط اطلاعات ساختگی آزمایشی.</div><nav class="v57-cart-links" aria-label="ادامه مرور کتاب‌ها"><a class="outline" href="/books">ادامه مرور کتاب‌های چاپی</a><a class="outline" href="/pdf-books">مشاهده کتاب‌های PDF</a></nav><section id="cart-root" class="panel-note" data-demo-token="${attr(signedReviewToken(0))}"><p>در حال بارگذاری سبد…</p></section><p class="muted tiny"><a href="/demo-order/track">پیگیری سفارش آزمایشی قبلی با کلید اختصاصی</a></p></div>`;}
function demoReceived(url){
 const code=String(url.searchParams.get('code')||''),key=String(url.searchParams.get('key')||'');
 const result=orders.receipt(db,{code,key});
 if(!result)return `<div class="shell main"><div class="panel-note demo-received"><span class="eyebrow">DEMO ONLY · NO PAYMENT</span><h1>رسید آزمایشی در دسترس نیست</h1><p>برای مشاهده جزئیات، لینک اختصاصی رسید یا شماره و کلید پیگیری آن لازم است. شماره سفارش به‌تنهایی برای مشاهده اطلاعات کافی نیست.</p><div class="soft-warning">هیچ پرداخت، رزرو یا ارسال واقعی انجام نمی‌شود.</div><p><a class="cta" href="/demo-order/track">پیگیری با کلید اختصاصی</a></p></div></div>`;
 const {order,items,events}=result;
 return `<div class="shell main"><div class="page-banner"><span class="eyebrow">DEMO TRACKING · NO PAYMENT</span><h1>رسید و پیگیری سفارش آزمایشی</h1><p>این اطلاعات فقط با لینک اختصاصی قابل مشاهده است؛ لینک را در اختیار افراد دیگر نگذارید.</p></div><div class="demo-receipt-grid"><section class="panel-note"><h2>سفارش <span dir="ltr">${esc(order.order_code)}</span></h2><p>فروشگاه: <b>${esc(order.store_name)}</b></p><p>وضعیت فعلی: <strong class="demo-status">${esc(orders.STATUS[order.status]||order.status)}</strong></p><p>ثبت: ${esc(order.created_at)} · آخرین تغییر: ${esc(order.updated_at)}</p><p>جمع قیمت نمونه کتاب‌ها: <b>${money(order.book_subtotal)}</b></p><p>هزینه ارسال: تعیین نشده | پرداخت: غیرفعال</p><div class="soft-warning">🔒 این رسید سند خرید یا پرداخت نیست. موجودی رزرو نشده و ارسال واقعی انجام نمی‌شود.</div><p><a class="outline" href="/demo-order/received?code=${encodeURIComponent(code)}&key=${encodeURIComponent(key)}">بروزرسانی وضعیت</a> <a href="/books">ادامه مشاهده کتاب‌ها</a></p></section><section class="panel-note"><h2>کتاب‌های این سفارش</h2>${items.map(i=>`<div class="demo-receipt-item"><b>${esc(i.book_title)}</b><small>${esc(i.edition_label)} · <span dir="ltr">${esc(i.sku)}</span></small><span>${digits(i.quantity)} × ${money(i.unit_price)} = ${money(i.line_total)}</span></div>`).join('')}</section><section class="panel-note demo-timeline"><h2>تاریخچه پیگیری</h2><ol>${events.map(e=>`<li><b>${esc(orders.STATUS[e.new_status]||e.new_status)}</b><time>${esc(e.created_at)}</time></li>`).join('')}</ol><p class="muted tiny">یادداشت‌های داخلی فروشنده برای مشتری نمایش داده نمی‌شود.</p></section></div></div>`;
}
function demoTrack(){return `<div class="shell main"><div class="panel-note demo-received"><span class="eyebrow">DEMO ONLY</span><h1>پیگیری سفارش آزمایشی</h1><p>برای حفظ حریم خصوصی، مشاهده رسید فقط با شماره سفارش و کلید ۶۴ کاراکتری اختصاصی امکان دارد. بهتر است لینک دریافت‌شده بعد از ثبت سفارش را ذخیره کنید.</p><form action="/demo-order/received" method="get" class="form-stack"><label>شماره سفارش آزمایشی<input name="code" pattern="DEMO-[0-9]{6,12}" placeholder="DEMO-000001" required maxlength="17" dir="ltr"></label><label>کلید اختصاصی<input name="key" pattern="[a-f0-9]{64}" maxlength="64" minlength="64" required dir="ltr" autocomplete="off"></label><button class="cta">مشاهده وضعیت آزمایشی</button></form><div class="soft-warning">هیچ پرداخت یا ارسال واقعی انجام نمی‌شود.</div></div></div>`;}
function panelCustomers(user,url){
 if(user.role!=='owner'&&storeRole(user)!=='manager')return null;
 const {stores,storeId}=storeScope(user,url);if(!storeId)return null;
 const rows=db.prepare(`SELECT customer_alias,city,COUNT(*) AS number,MAX(created_at) AS latest FROM demo_orders WHERE store_id=? GROUP BY customer_alias,city ORDER BY MAX(id) DESC LIMIT 100`).all(storeId);
 return panelShell(user,`<div class="panel-note"><h2>مشتریان نمونه و آدرس‌های فرضی</h2><p>این فهرست برای آزمایش جریان سفارش است و حساب مشتری واقعی، شماره تلفن، اعتبار یا اطلاعات تماس نگهداری نمی‌کند.</p>${user.role==='owner'?`<form action="/panel/customers" method="get" class="inventory-filter"><label>فروشگاه<select name="store">${stores.map(st=>`<option value="${st.id}" ${st.id===storeId?'selected':''}>${esc(st.name)}</option>`).join('')}</select></label><button class="outline">نمایش</button></form>`:''}</div><div class="table-scroll"><table class="data-table"><thead><tr><th>نام مستعار</th><th>شهر نمونه</th><th>درخواست آزمایشی</th><th>آخرین ثبت</th></tr></thead><tbody>${rows.map(x=>`<tr><td>${esc(x.customer_alias)}</td><td>${esc(x.city)}</td><td>${digits(x.number)}</td><td>${esc(x.latest)}</td></tr>`).join('')||'<tr><td colspan="4">هنوز مشتری نمونه ثبت نشده است.</td></tr>'}</tbody></table></div>`,'مشتریان نمونه');
}
function panelOrders(user,url){
 if(user.role!=='owner'&&storeRole(user)!=='manager')return null;
 const {stores,storeId}=storeScope(user,url);if(!storeId)return null;
 const rows=db.prepare('SELECT o.*,s.name store_name FROM demo_orders o JOIN stores s ON s.id=o.store_id WHERE o.store_id=? ORDER BY o.id DESC LIMIT 100').all(storeId);
 const orderId=safeId(url.searchParams.get('order'));
 const selected=orderId?db.prepare('SELECT * FROM demo_orders WHERE id=? AND store_id=?').get(orderId,storeId):null;
 if(orderId&&!selected)return null;
 const items=selected?db.prepare('SELECT * FROM demo_order_items WHERE order_id=? ORDER BY id').all(selected.id):[];
 const events=selected?db.prepare('SELECT e.*,u.username FROM demo_order_events e LEFT JOIN users u ON u.id=e.actor_id WHERE e.order_id=? ORDER BY e.id DESC').all(selected.id):[];
 const canUpdate=managerOf(user,storeId)&&!marketGateway.enabled,possible=selected?(orders.TRANSITIONS[selected.status]||[]):[];
 const checklist=selected?fulfillment.get(db,storeId,selected.id):null;
 const checklistHistory=selected?fulfillment.history(db,storeId,selected.id):[];
 const checkRows=fulfillment.overview(db,storeId);
 const unreviewed=checkRows.filter(x=>!x.complete&&!['demo_done','demo_cancelled'].includes(x.status)).length;
 const checkMap=new Map(checkRows.map(x=>[x.id,x]));
 const checklistSummary=raw=>{let flags={};try{flags=JSON.parse(raw);}catch{}return Object.entries(fulfillment.FIELDS).filter(([k])=>flags[k]===1).map(([,label])=>label).join('، ')||'هیچ‌کدام';};
 const archivePath=marketGateway.enabled?'/panel/demo-orders-archive':'/panel/orders';
 const storeSelect=user.role==='owner'?`<form action="${archivePath}" method="get" class="inventory-filter"><label>نمایش فروشگاه<select name="store">${stores.map(st=>`<option value="${st.id}" ${storeId===st.id?'selected':''}>${esc(st.name)}</option>`).join('')}</select></label><button class="outline">نمایش</button></form>`:'';
 const checklistHtml=selected?`<div class="panel-note fulfillment-checklist"><h2>چک‌لیست آماده‌سازی آزمایشی</h2><p class="soft-warning">فقط تمرین فرایندهای فروشگاه است؛ این تأییدها موجودی را رزرو نمی‌کنند و مدرک ارسال، تسویه یا فروش واقعی نیستند.</p>${canUpdate&&!['demo_cancelled','demo_done'].includes(selected.status)?`<form method="post" action="/panel/order-checklist" class="form-grid">${csrfInput(user)}<input type="hidden" name="store_id" value="${storeId}"><input type="hidden" name="order_id" value="${selected.id}"><input type="hidden" name="revision" value="${checklist.revision}">${Object.entries(fulfillment.FIELDS).map(([key,label])=>`<label class="check-row full"><input type="checkbox" name="${key}" value="1" ${checklist[key]?'checked':''}> ${esc(label)} (فقط نمونه)</label>`).join('')}<label class="full">یادداشت داخلی نمونه<input name="note" maxlength="300" value="${attr(checklist.note)}"></label><button class="cta">ثبت چک‌لیست نمایشی</button></form>`:`<p>وضعیت چک‌لیست: ${checklist.complete?'سه بررسی آزمایشی انجام شده':'هنوز کامل نشده'}؛ این پرونده بسته است یا فقط برای مشاهده باز شده.</p>`}<h3>تاریخچه چک‌لیست</h3>${checklistHistory.map(e=>`<p>${esc(e.created_at)} · ${esc(e.username||'سیستم')} · نسخه ${digits(e.revision)}<small> · از: ${esc(checklistSummary(e.old_flags))} ← به: ${esc(checklistSummary(e.new_flags))}</small>${e.note?' · '+esc(e.note):''}</p>`).join('')||'<p class="muted">هنوز اقدامی ثبت نشده است.</p>'}</div>`:'';
 const selectedHtml=selected?`<div class="panel-note"><h2>${esc(selected.order_code)} — ${esc(orders.STATUS[selected.status])}</h2><p><b>مشتری نمونه:</b> ${esc(selected.customer_alias)} · <b>شهر فرضی:</b> ${esc(selected.city)}</p><p><b>نشانی نمونه:</b> ${esc(selected.sample_address||'ثبت نشده')} · <b>روش ارسال آزمایشی:</b> ${selected.shipping_method==='pickup'?'تحویل حضوری':selected.shipping_method==='post'?'پست':'پیک'}</p><p><b>جمع بهای کتاب‌ها:</b> ${money(selected.book_subtotal)} · <b>پرداخت:</b> غیرفعال · <b>هزینه ارسال:</b> محاسبه نشده</p><div class="table-scroll"><table class="data-table"><thead><tr><th>عنوان</th><th>SKU</th><th>چاپ</th><th>تعداد</th><th>قیمت واحد</th><th>جمع ردیف</th></tr></thead><tbody>${items.map(i=>`<tr><td>${esc(i.book_title)}</td><td dir="ltr">${esc(i.sku)}</td><td>${esc(i.edition_label)}</td><td>${digits(i.quantity)}</td><td>${money(i.unit_price)}${i.discount_percent?`<small>${digits(i.discount_percent)}٪ تخفیف از ${money(i.original_unit_price)}</small>`:''}</td><td>${money(i.line_total)}</td></tr>`).join('')}</tbody></table></div>${canUpdate&&possible.length?`<form action="/panel/order-status" method="post" class="form-grid">${csrfInput(user)}<input type="hidden" name="store_id" value="${storeId}"><input type="hidden" name="order_id" value="${selected.id}"><label>تغییر وضعیت نمایشی<select name="status">${possible.map(st=>`<option value="${st}">${esc(orders.STATUS[st])}</option>`).join('')}</select></label><label>یادداشت داخلی<input name="note" maxlength="300" placeholder="صرفاً برای آزمایش"></label><button class="cta">ثبت وضعیت آزمایشی</button></form>`:''}</div><div class="panel-note"><h2>تاریخچه وضعیت</h2>${events.map(e=>`<p> ${esc(e.created_at)} · ${esc(orders.STATUS[e.new_status])} · ${esc(e.username||'سیستم')} ${e.note?'— '+esc(e.note):''}</p>`).join('')}</div>`:'';
 const mobileOrders=`<section class="v78-orders-cards" aria-label="سفارش‌های نمونه فروشگاه">${rows.map(o=>`<article class="v78-order-card"><div class="v78-order-head"><strong dir="ltr">${esc(o.order_code)}</strong><span>${esc(orders.STATUS[o.status])}</span></div><dl><div><dt>مشتری نمونه</dt><dd>${esc(o.customer_alias)}</dd></div><div><dt>جمع فرضی کتاب‌ها</dt><dd>${money(o.book_subtotal)}</dd></div><div><dt>چک‌لیست</dt><dd>${checkMap.get(o.id)?.complete?'بازبینی نمونه کامل':'نیازمند بازبینی'}</dd></div><div><dt>تاریخ ثبت</dt><dd dir="ltr">${esc(o.created_at)}</dd></div></dl><a class="outline v78-open-order" href="${archivePath}?store=${storeId}&order=${o.id}" aria-label="جزئیات سفارش نمونه ${attr(o.order_code)}">مشاهده جزئیات و چک‌لیست</a></article>`).join('')||'<div class="quiet-note">هنوز سفارش آزمایشی ثبت نشده است.</div>'}</section>`;
 const table=`<div class="table-scroll v78-orders-table"><table class="data-table"><thead><tr><th>شماره</th><th>مشتری نمونه</th><th>مبلغ کتاب‌ها</th><th>وضعیت</th><th>چک‌لیست نمونه</th><th>تاریخ</th><th>جزئیات</th></tr></thead><tbody>${rows.map(o=>`<tr><td dir="ltr">${esc(o.order_code)}</td><td>${esc(o.customer_alias)}</td><td>${money(o.book_subtotal)}</td><td>${esc(orders.STATUS[o.status])}</td><td>${checkMap.get(o.id)?.complete?'بازبینی نمونه کامل':'نیازمند بازبینی'}</td><td>${esc(o.created_at)}</td><td><a href="${archivePath}?store=${storeId}&order=${o.id}">مشاهده</a></td></tr>`).join('')||'<tr><td colspan="7">هنوز سفارش آزمایشی ثبت نشده است.</td></tr>'}</tbody></table></div>`;
 return panelShell(user,`<div class="panel-note"><h2>آرشیو سفارش‌های آزمایشی</h2>${marketGateway.enabled?`<p><a class="cta" href="/market/seller">مدیریت سفارش‌های جدید در فروشگاه ←</a></p>`:``}<p>سفارش‌های این بخش واقعی نیستند و روی موجودی اثر نمی‌گذارند. هیچ درگاه، رزرو کالا، ارسال یا دریافت وجه انجام نمی‌شود. اطلاعات مشتری را صرفاً نمونه وارد کنید.</p>${storeSelect}<div class="stats panel-stats"><div><b>${digits(rows.length)}</b><span>سفارش نمونه (حداکثر ۱۰۰ اخیر)</span></div><div><b>${digits(rows.filter(o=>o.status==='demo_new').length)}</b><span>در انتظار بررسی</span></div><div><b>${digits(unreviewed)}</b><span>چک‌لیست ناتمام (نمونه)</span></div></div><a class="outline" href="/panel/order-checklist.csv?store=${storeId}">گزارش CSV چک‌لیست‌های این فروشگاه</a></div>${selectedHtml}${checklistHtml}${mobileOrders}${table}`,'سفارش‌های آزمایشی');
}
function financeScope(user,url){
 if(user.role!=='owner'&&!(user.role==='seller'&&storeRole(user)==='manager'))return null;
 const raw=url.searchParams.get('store');
 if(user.role==='owner'){
  const storeId=raw===null||raw===''?0:safeId(raw);
  if(raw!==null&&raw!==''&&(!storeId||!db.prepare('SELECT id FROM stores WHERE id=?').get(storeId)))return null;
  return {storeId};
 }
 if(raw!==null&&raw!==''&&Number(raw)!==user.store_id)return null;
 return {storeId:user.store_id};
}
function financeReportFor(user,url){
 const scope=financeScope(user,url);if(!scope)return null;
 try{return {...finance.filters(url),...scope};}catch(e){if(e.userError)return {error:e.message};throw e;}
}
function financeRateLabel(v){return Number(v/100).toFixed(2)+'٪';}
function reportPage(user,url){
 const filter=financeReportFor(user,url);if(!filter)return null;
 if(filter.error)return panelShell(user,`<div class="soft-warning">${esc(filter.error)}</div><a href="/panel/reports">پاک‌کردن فیلتر</a>`,'گزارش‌های آزمایشی');
 const data=finance.getReport(db,filter),m=data.metrics;
 const stores=user.role==='owner'?db.prepare('SELECT id,name FROM stores ORDER BY id').all():[];
 const form=`<form action="/panel/reports" method="get" class="report-filter"><label>از تاریخ (UTC)<input type="date" name="from" required value="${attr(filter.from)}"></label><label>تا تاریخ (UTC)<input type="date" name="to" required value="${attr(filter.to)}"></label>${user.role==='owner'?`<label>کتاب‌فروشی<select name="store"><option value="">همه فروشگاه‌ها</option>${stores.map(x=>`<option value="${x.id}" ${filter.storeId===x.id?'selected':''}>${esc(x.name)}</option>`).join('')}</select></label>`:''}<label>وضعیت سفارش<select name="status"><option value="all">همه وضعیت‌ها</option>${Object.entries(orders.STATUS).map(([k,v])=>`<option value="${k}" ${k===filter.status?'selected':''}>${esc(v)}</option>`).join('')}</select></label><button class="cta" type="submit">نمایش گزارش</button></form>`;
 const urlParams=new URLSearchParams({from:filter.from,to:filter.to,status:filter.status});if(filter.storeId)urlParams.set('store',String(filter.storeId));
 const dailyMax=Math.max(1,...data.days.map(x=>x.amount));
 const chart=data.days.length?`<div class="report-chart" role="img" aria-label="روند ارزش سفارش‌های آزمایشی بر حسب روز">${data.days.map(d=>`<div class="report-chart-row"><span>${esc(d.day)}</span><progress class="report-progress" max="100" value="${Math.round(d.amount/dailyMax*100)}" aria-label="${esc(d.day)}: ${money(d.amount)}"></progress><strong>${money(d.amount)}</strong></div>`).join('')}</div>`:'<div class="quiet-note">در این بازه سفارش نمونه‌ای وجود ندارد.</div>';
 const perStore=user.role==='owner'?`<div class="panel-note"><h2>مقایسه فروشگاه‌ها (نمایشی)</h2><div class="table-scroll"><table class="data-table"><thead><tr><th>فروشگاه</th><th>تعداد درخواست</th><th>جمع نمونه بدون لغوشده‌ها</th></tr></thead><tbody>${data.byStore.map(x=>`<tr><td>${esc(x.name)}</td><td>${digits(x.n)}</td><td>${money(x.amount)}</td></tr>`).join('')||'<tr><td colspan="3">داده‌ای موجود نیست.</td></tr>'}</tbody></table></div></div>`:'';
 const body=`<div class="soft-warning"><strong>گزارش کاملاً آزمایشی 🔒</strong> هیچ سفارش پرداخت‌شده‌ای وجود ندارد. تمام مبالغ، گردش و کارمزدها صرفاً شبیه‌سازی‌اند و نباید به‌عنوان درآمد، فروش واقعی یا طلب فروشنده استفاده شوند. داده‌ها بر مبنای تاریخ UTC فیلتر می‌شوند.</div><div class="panel-note"><h2>گزارش سفارش‌ها و کارمزدهای فرضی</h2>${form}<div class="button-row"><a class="outline" href="/panel/reports.csv?${urlParams.toString()}">دریافت CSV همین گزارش</a>${user.role==='owner'?'<a class="outline" href="/panel/commissions">تعریف نرخ کارمزد فروشندگان</a>':''}</div></div><div class="report-kpis"><div><small>تعداد سفارش نمونه</small><b>${digits(m.count)}</b></div><div><small>در جریان / تکمیل نمایشی</small><b>${digits(m.open)} / ${digits(m.completed)}</b></div><div><small>لغوشده آزمایشی</small><b>${digits(m.cancelled)}</b></div><div><small>جمع مبلغ نمونه بدون لغوشده‌ها</small><b>${money(m.activeSubtotal)}</b></div><div><small>کارمزد فرضی YM (فقط سفارش دارای نرخ ثبت‌شده)</small><b>${money(m.projectedFee)}</b></div><div><small>سهم فرضی فروشندگان (فقط سفارش دارای نرخ ثبت‌شده)</small><b>${money(m.projectedSellerShare)}</b></div></div>${m.unsnapshotted?`<div class="soft-warning">تعداد ${digits(m.unsnapshotted)} سفارش قدیمیِ لغونشده فاقد عکس نرخ کارمزد در لحظه ثبت هستند؛ برای آن‌ها کارمزد یا سهم فروشنده محاسبه و به نرخ جدید منتسب نشده است.</div>`:''}<div class="panel-note"><h2>روند روزانه درخواست‌ها (غیرواقعی)</h2>${chart}</div>${perStore}<div class="panel-note"><h2>آخرین درخواست‌های نمونه</h2><div class="table-scroll"><table class="data-table"><thead><tr><th>شماره نمونه</th><th>فروشگاه</th><th>تاریخ UTC</th><th>وضعیت</th><th>جمع کتاب‌ها</th><th>نرخ ثبت‌شده</th><th>کارمزد فرضی</th></tr></thead><tbody>${data.rows.slice(0,100).map(r=>`<tr><td dir="ltr">${esc(r.order_code)}</td><td>${esc(r.store_name)}</td><td dir="ltr">${esc(r.created_at)}</td><td>${esc(orders.STATUS[r.status])}</td><td>${money(r.book_subtotal)}</td><td>${r.rate_bps===null?'—':financeRateLabel(r.rate_bps)}</td><td>${r.rate_bps===null?'—':money(r.commission_toman)}</td></tr>`).join('')||'<tr><td colspan="7">سفارشی یافت نشد.</td></tr>'}</tbody></table></div>${data.rows.length>100?`<p class="muted tiny">تنها ۱۰۰ سفارش آخر در صفحه نمایش داده می‌شود؛ فایل CSV تمام رکوردهای بازه را دارد.</p>`:''}</div>`;
 return panelShell(user,body,'گزارش‌های آزمایشی');
}
function commissionPage(user){if(user.role!=='owner')return null;
 const rows=db.prepare(`SELECT s.id,s.name,p.rate_bps,p.updated_at FROM stores s LEFT JOIN demo_commission_policies p ON p.store_id=s.id ORDER BY s.id`).all();
 const history=db.prepare(`SELECT c.*,s.name,u.username FROM demo_commission_changes c JOIN stores s ON s.id=c.store_id LEFT JOIN users u ON u.id=c.actor_id ORDER BY c.id DESC LIMIT 50`).all();
 return panelShell(user,`<div class="soft-warning">🔒 نرخ‌های این بخش صرفاً برای محاسبه در سفارش‌های نمایشی استفاده می‌شوند. ذخیره نرخ به معنی ایجاد بدهی، وصول کارمزد یا فعال‌شدن درگاه نیست. تغییر نرخ روی سفارش‌های قبلی اثر نمی‌گذارد.</div><div class="panel-note"><h2>نرخ پیشنهادی هر فروشگاه</h2><div class="commission-grid">${rows.map(r=>`<form class="commission-card" method="post" action="/panel/commission">${csrfInput(user)}<input type="hidden" name="store_id" value="${r.id}"><h3>${esc(r.name)}</h3><small>فروشگاه شماره ${digits(r.id)}</small><label>کارمزد شبیه‌سازی‌شده (۰ تا ۲۰ درصد)<input type="number" min="0" max="20" step="0.01" name="rate" required value="${((r.rate_bps??0)/100).toFixed(2)}"></label><button class="cta" type="submit">ذخیره نرخ نمونه</button><small>${r.rate_bps===null?'نرخ تنظیم نشده؛ پیش‌فرض سفارش‌های جدید صفر درصد است.':`نرخ جاری: ${financeRateLabel(r.rate_bps)}`}</small></form>`).join('')}</div></div><div class="panel-note"><h2>تاریخچه تغییرات نرخ</h2><div class="table-scroll"><table class="data-table"><thead><tr><th>فروشگاه</th><th>نرخ قبلی</th><th>نرخ جدید</th><th>کاربر ثبت‌کننده</th><th>زمان UTC</th></tr></thead><tbody>${history.map(h=>`<tr><td>${esc(h.name)}</td><td>${h.old_rate_bps===null?'بدون تنظیم':financeRateLabel(h.old_rate_bps)}</td><td>${financeRateLabel(h.new_rate_bps)}</td><td>${esc(h.username||'حساب حذف‌شده')}</td><td>${esc(h.created_at)}</td></tr>`).join('')||'<tr><td colspan="5">هنوز تغییری ثبت نشده است.</td></tr>'}</tbody></table></div></div>`,'کارمزدهای آزمایشی');
}
function panelHomeContent(user,url){if(user.role!=='owner')return null;
 const c=homeCms.homepage(db),id=safeId(url.searchParams.get('edit'));
 const banners=homeCms.listBanners(db,null,false),editing=banners.find(b=>b.id===id);
 const editor=editing||{id:'',title:'',summary:'',label:'مشاهده کتاب‌ها',href:'/books',placement:'after_hero',sort_order:10,active:0};
 return panelShell(user,`<div class="panel-note"><h2>متن و چیدمان صفحه اصلی</h2><p class="muted">تغییرات پس از ذخیره در صفحه عمومی اعمال می‌شوند. لینک‌ها فقط می‌توانند به صفحات داخلی ورق اشاره کنند.</p><form method="post" action="/panel/home-settings" class="form-grid">${csrfInput(user)}
 <label>برچسب بالای تیتر<input name="eyebrow" maxlength="90" value="${attr(c.eyebrow)}"></label>
 <label>عنوان اصلی<input name="hero_title" maxlength="100" required value="${attr(c.hero_title)}"></label>
 <label>بخش برجسته عنوان<input name="hero_accent" maxlength="100" required value="${attr(c.hero_accent)}"></label>
 <label class="full">متن معرفی<textarea name="hero_description" maxlength="320" required>${esc(c.hero_description)}</textarea></label>
 <label>دکمه اصلی<input name="primary_label" maxlength="45" required value="${attr(c.primary_label)}"></label>
 <label>لینک دکمه اصلی<input name="primary_href" dir="ltr" maxlength="220" required value="${attr(c.primary_href)}"></label>
 <label>دکمه دوم<input name="secondary_label" maxlength="45" required value="${attr(c.secondary_label)}"></label>
 <label>لینک دکمه دوم<input name="secondary_href" dir="ltr" maxlength="220" required value="${attr(c.secondary_href)}"></label>
 <label class="checkbox-line"><input type="checkbox" name="show_trust" value="1" ${c.show_trust?'checked':''}> نمایش ویژگی‌های ورق</label>
 <label class="checkbox-line"><input type="checkbox" name="show_categories" value="1" ${c.show_categories?'checked':''}> نمایش دسته‌بندی‌ها</label>
 <label class="checkbox-line"><input type="checkbox" name="show_selected" value="1" ${c.show_selected?'checked':''}> نمایش کتاب‌های منتخب</label>
 <div class="full button-row"><button class="cta">ذخیره صفحه اصلی</button><a class="outline" href="/" target="_blank" rel="noopener">مشاهده صفحه عمومی</a></div></form></div>
 <div class="panel-note"><h2>${editing?'ویرایش بنر شماره '+editing.id:'ساخت بنر تازه'}</h2><p>می‌توانی بنر متنی بسازی یا پس از ذخیره تصویر مجاز اضافه کنی. بنر غیرفعال در صفحه عمومی دیده نمی‌شود.</p>
 <form method="post" action="/panel/home-banner" class="form-grid">${csrfInput(user)}<input type="hidden" name="id" value="${editor.id}">
 <label>عنوان بنر<input name="title" maxlength="100" required value="${attr(editor.title)}"></label>
 <label>جای نمایش<select name="placement">${Object.entries(homeCms.POSITIONS).map(([key,label])=>`<option value="${key}" ${editor.placement===key?'selected':''}>${label}</option>`).join('')}</select></label>
 <label class="full">توضیح کوتاه<textarea name="summary" maxlength="250">${esc(editor.summary)}</textarea></label>
 <label>عنوان دکمه<input name="label" maxlength="45" value="${attr(editor.label)}"></label>
 <label>لینک داخلی<input name="href" maxlength="220" dir="ltr" required value="${attr(editor.href)}"></label>
 <label>ترتیب نمایش (۰ تا ۹۹۹)<input type="number" name="sort_order" min="0" max="999" value="${editor.sort_order}"></label>
 <label class="checkbox-line"><input type="checkbox" name="active" value="1" ${editor.active?'checked':''}> بنر فعال و قابل نمایش باشد</label>
 <div class="full button-row"><button class="cta">${editing?'ذخیره ویرایش':'ایجاد بنر'}</button>${editing?'<a href="/panel/home-content" class="outline">بنر جدید</a>':''}</div></form>
 ${editing?`<div class="home-banner-upload"><h3>تصویر بنر</h3>${editing.filename?`<img class="home-banner-thumb" src="/media/banners/${attr(editing.filename)}" alt="${attr(editing.image_alt||editing.title)}"><p class="tiny">منبع: ${esc(editing.image_source)} · حق استفاده: ${esc(editing.rights_note)}</p>`:'<p class="muted">این بنر هنوز تصویر ندارد؛ حالت متنی قابل نمایش است.</p>'}
 <form method="post" action="/panel/home-banner-image" enctype="multipart/form-data" class="form-grid">${csrfInput(user)}<input type="hidden" name="id" value="${editing.id}">
 <label class="full">تصویر JPG/PNG/WebP با حجم حداکثر ۷۰۰ کیلوبایت<input type="file" name="banner" accept=".jpg,.jpeg,.png,.webp" required></label>
 <label>متن جایگزین تصویر<input name="image_alt" maxlength="160" value="${attr(editing.image_alt||editing.title)}" required></label>
 <label>منبع تصویر<input name="image_source" maxlength="160" value="${attr(editing.image_source)}" required></label>
 <label class="full">مبنای مجوز استفاده<input name="rights_note" maxlength="240" value="${attr(editing.rights_note)}" required></label>
 <label class="checkbox-line full"><input type="checkbox" name="licensed" value="1" required> حق استفاده و نمایش عمومی این تصویر را دارم</label>
 <button class="cta">بارگذاری / جایگزینی تصویر</button></form></div>`:''}</div>
 <h2 class="block-title">بنرهای ثبت‌شده (${digits(banners.length)} از ۱۲)</h2><div class="home-admin-banner-list">${banners.map(b=>`<article class="home-admin-banner"><div>${b.filename?`<img src="/media/banners/${attr(b.filename)}" alt="${attr(b.image_alt||'بنر')}">`:'<span class="banner-no-photo">بدون تصویر</span>'}</div><div><strong>${esc(b.title)}</strong><p>${esc(homeCms.POSITIONS[b.placement])} · ترتیب ${digits(b.sort_order)} · ${b.active?'فعال':'پیش‌نویس'}</p><a href="/panel/home-content?edit=${b.id}">ویرایش بنر و تصویر</a></div><form method="post" action="/panel/home-banner-remove">${csrfInput(user)}<input type="hidden" name="id" value="${b.id}"><button class="save-mini danger">حذف</button></form></article>`).join('')||'<p class="muted">هنوز هیچ بنری ثبت نشده است.</p>'}</div>
 <div class="soft-warning">این بخش جایگزین مجوز انتشار محتوا نیست. برای هر تصویر، منبع و اجازه انتشار را ثبت کنید. پرداخت واقعی همچنان غیرفعال است.</div>`, 'صفحه اصلی و بنرها');
}
function generatedIntroNotice(book){
 if(exclusiveFor(book))return '<p class="varaq-draft-intro-note">معرفی و خلاصه نوشته‌شده برای ورق · نقل متن اصلی کتاب نیست.</p>';
 const entry=generatedTextById.get(book.id);if(!entry||entry.title!==book.title)return '';
 const review=generatedReview.record(db,entry);
 if(review.status==='approved')return `<p class="varaq-draft-intro-note varaq-reviewed-intro">معرفی اختصاصی ورق · بازبینی‌شده توسط تحریریه${review.source_url?` · <a href="${attr(review.source_url)}" rel="nofollow noopener noreferrer" target="_blank">منبع بررسی</a>`:''}</p>`;
 return `<p class="varaq-draft-intro-note">معرفی کوتاه اختصاصی ورق · پیش‌نویس تحریریه، نیازمند بررسی صحت</p>`;
}
function panelGeneratedEditorials(user,url){
 if(user.role!=='owner')return null;
 const q=str(url.searchParams.get('q'),80),filter=['all','pending','approved','revise','hidden','stale'].includes(url.searchParams.get('status'))?url.searchParams.get('status'):'all';
 const matches=generatedReview.rows(db,generatedCatalogue,{q,status:filter});
 const all=generatedReview.rows(db,generatedCatalogue),stats=Object.fromEntries(['pending','approved','revise','hidden','stale'].map(k=>[k,all.filter(r=>r.status===k).length]));
 const page=Math.min(100,Math.max(1,Number.parseInt(url.searchParams.get('page'),10)||1)),pages=Math.max(1,Math.ceil(matches.length/25)),current=Math.min(page,pages);
 const selected=Number(url.searchParams.get('book'));
 const chosen=all.find(r=>r.book_id===selected)||matches[(current-1)*25]||all[0];
 const selects=[['all','همه'],['pending','در انتظار بررسی'],['approved','بازبینی‌شده'],['revise','نیازمند اصلاح'],['hidden','مخفی'],['stale','متن تغییر کرده']].map(([k,v])=>`<option value="${k}" ${filter===k?'selected':''}>${v}</option>`).join('');
 const lines=matches.slice((current-1)*25,current*25).map(r=>`<tr><td>${digits(r.book_id)}</td><td>${esc(r.title)}${r.has_editor_copy?' <small>(متن مدیر محفوظ)</small>':''}</td><td>${esc(generatedReview.label[r.status])}</td><td><a href="/panel/generated-editorials?book=${r.book_id}&status=${attr(filter)}&q=${encodeURIComponent(q)}">بررسی</a></td></tr>`).join('');
 const next=n=>'/panel/generated-editorials?'+new URLSearchParams({q,status:filter,page:String(n)});
 const hist=chosen?db.prepare('SELECT h.*,u.username FROM generated_editorial_review_history h LEFT JOIN users u ON u.id=h.reviewer_id WHERE book_id=? ORDER BY id DESC LIMIT 10').all(chosen.book_id):[];
 return panelShell(user,`<div class="panel-note"><h2>بازبینی ۱۰۰۰ معرفی و راهنمای مطالعه · نسخه ۶.۴</h2><p>متن‌های تولیدی پیش‌نویس‌اند. تأیید فقط برای همین نسخه از متن معتبر است؛ تغییر متن، تأیید پیشین را باطل می‌کند. مدرک چاپ، مجوز تصویر و حق فروش PDF جداگانه بررسی می‌شوند.</p><div class="varaq-editorial-stats">${Object.entries(stats).map(([k,n])=>`<span>${esc(generatedReview.label[k])}: <b>${digits(n)}</b></span>`).join('')}</div><a href="/panel/generated-editorials.csv" class="outline">دریافت گزارش CSV تمام ۱۰۰۰ معرفی</a><form method="get" action="/panel/generated-editorials" class="filterbar"><input name="q" maxlength="80" placeholder="جست‌وجوی عنوان یا شناسه" value="${attr(q)}"><select name="status">${selects}</select><button class="cta">فیلتر</button></form></div><div class="table-scroll"><table class="data-table"><thead><tr><th>شماره</th><th>کتاب</th><th>وضعیت</th><th>عملیات</th></tr></thead><tbody>${lines||'<tr><td colspan="4">موردی یافت نشد.</td></tr>'}</tbody></table></div><div class="pagination">${current>1?`<a href="${attr(next(current-1))}">قبلی</a>`:''}<span>صفحه ${digits(current)} از ${digits(pages)}</span>${current<pages?`<a href="${attr(next(current+1))}">بعدی</a>`:''}</div>${chosen?`<div class="panel-note varaq-editorial-review-form"><h2>پرونده شماره ${digits(chosen.book_id)} · ${esc(chosen.title)}</h2><p><a href="/book/${encodeURIComponent(chosen.entry.slug)}" target="_blank" rel="noopener">مشاهده صفحه کتاب</a> · وضعیت: ${esc(generatedReview.label[chosen.status])}</p>${chosen.has_editor_copy?'<p class="soft-warning">معرفی ویرایش‌شده توسط مدیر در بانک کتاب موجود است؛ بررسی متن تولیدی آن را بازنویسی نمی‌کند.</p>':''}<div class="varaq-review-preview"><h3>معرفی تولیدشده</h3><p>${esc(chosen.entry.description)}</p><h3>راهنمای مطالعه</h3><p>${esc(chosen.entry.reader_note)}</p><p>${chosen.entry.topics.map(esc).join(' · ')}</p></div><form action="/panel/generated-editorials-review" method="post" class="form-stack">${csrfInput(user)}<input type="hidden" name="book_id" value="${chosen.book_id}"><input type="hidden" name="revision" value="${chosen.revision}"><input type="hidden" name="content_hash" value="${chosen.hash}"><label>نتیجه بررسی<select name="status"><option value="pending" ${chosen.status==='pending'?'selected':''}>در انتظار بررسی</option><option value="approved" ${chosen.status==='approved'?'selected':''}>بازبینی محتوا با منبع</option><option value="revise" ${chosen.status==='revise'?'selected':''}>نیازمند اصلاح</option><option value="hidden" ${chosen.status==='hidden'?'selected':''}>عدم نمایش متن تولیدی</option></select></label><label>پیوند منبع معتبر برای بررسی<input type="url" name="source_url" dir="ltr" maxlength="1000" value="${attr(chosen.source_url)}" placeholder="https://..."></label><label>یادداشت بررسی، موارد تطبیق داده‌شده یا علت اصلاح<textarea name="note" rows="4" maxlength="1000">${esc(chosen.note)}</textarea></label><button class="cta" type="submit">ثبت نتیجه و تاریخچه بررسی</button></form>${hist.length?`<details><summary>تاریخچه بررسی (${digits(hist.length)} تغییر آخر)</summary><ul>${hist.map(h=>`<li>${esc(h.created_at)} · ${esc(generatedReview.label[h.status]||h.status)} · ${esc(h.username||'مدیر')} · ${esc(h.note)}</li>`).join('')}</ul></details>`:''}</div>`:''}`,'بازبینی معرفی ۲۰۰ کتاب');
}
function panelShell(user,inner,title){const links=user.role==='owner'?[['/panel','داشبورد'],['/panel/release-readiness','آمادگی انتشار ۶.۰'],['/panel/media-integrity','سلامت جلدها و PDFها'],['/panel/finishing-desk','میز کار تکمیل کتابخانه'],['/panel/catalog-readiness','داشبورد ۱۰۰۰ کتاب · کیفیت و تصاویر'],['/panel/bibliographic-review','تأیید مستند شناسنامه کتاب‌ها'],['/panel/generated-editorials','بازبینی ۱۰۰۰ معرفی و راهنمای مطالعه'],['/panel/reading-samples','نمونه متن مجاز کتاب‌ها'],['/panel/catalog-consistency','کنترل شابک و کیفیت اطلاعات'],['/panel/cover-intake','دریافت گروهی جلدهای ناشران'],['/panel/cover-web-upload','بارگذاری چند جلد در پنل'],['/panel/payment-readiness','آمادگی پذیرندگی و تراکنش‌ها'],['/panel/pdf-books','کتاب‌های PDF'],['/panel/store-operations','عملیات فروشگاه‌ها'],['/panel/stores','کتاب‌فروشی‌ها'],['/panel/books','بانک کتاب'],['/panel/publisher-outreach','نامه‌نگاری ناشران برای جلد'],['/panel/cover-completion','تکمیل اطلاعات و تصاویر جلد'],['/panel/content-workbook','کاربرگ تکمیل ۱۰۰۰ کتاب'],['/panel/content-batch','تکمیل گروهی مستند کتاب‌ها'],['/panel/home-content','صفحه اصلی و بنرها'],['/panel/catalog-quality','کیفیت بانک کتاب'],['/panel/edition-audit','کنترل چاپ‌ها و جلدها'],['/panel/edition-verification','تطبیق چاپ فروشگاه'],['/panel/print-evidence','اختلاف نوبت چاپ'],['/panel/cover-research','جست‌وجوی جلد در اینترنت'],['/panel/rights-tracker','پیگیری مجوز تصاویر'],['/panel/cover-priority','اولویت تأمین جلدها'],['/panel/catalog-worklist','صف تکمیل ۱۰۰۰ کتاب'],['/panel/publication-review','ارزیابی انتشار محتوا'],['/panel/editorial-batch','معرفی تألیفی کتاب‌ها'],['/panel/editorial-batch-31','۱۳۴ معرفی جدید'],['/panel/bibliography','شناسنامه چاپ و جلد واقعی'],['/panel/catalog-drafts','صف بررسی محتوا'],['/panel/editorial-qa','کنترل تحریریه و منابع'],['/panel/education','کمک‌درسی و کنکور'],['/panel/education-import','CSV کمک‌درسی'],['/panel/categories','دسته‌بندی‌ها'],['/panel/import','ورود گروهی CSV'],['/panel/covers','تصاویر جلد'],['/panel/editions','چاپ‌ها و ترجمه‌ها'],['/panel/editorial','بررسی تخصصی'],['/panel/reviews','نظرات کاربران'],['/panel/inventory',marketGateway.enabled?'انبار فروش جدید':'انبار و SKU'],['/panel/discounts','تخفیف و قیمت‌ها'],['/panel/merchandising','مدیریت گروهی و ویترین'],['/panel/stock-ledger','گردش انبار'],['/panel/orders','سفارش‌های آزمایشی'],['/panel/reports','گزارش‌های آزمایشی'],['/panel/commissions','کارمزدهای آزمایشی'],['/panel/customers','مشتریان نمونه'],['/panel/users','حساب‌های فروشندگان'],['/panel/settings','تنظیمات پرداخت']]:[['/panel','داشبورد'],['/panel/payment-readiness','آمادگی پذیرندگی'],['/panel/pdf-books','کتاب‌های PDF'],['/panel/store-operations','پیگیری‌های فروشگاه'],['/panel/inventory',marketGateway.enabled?'انبار فروش جدید':'انبار و SKU'],['/panel/discounts','تخفیف و قیمت‌ها'],['/panel/merchandising','مدیریت گروهی و ویترین'],['/panel/stock-ledger','گردش انبار'],['/panel/orders','سفارش‌های آزمایشی'],['/panel/reports','گزارش‌های آزمایشی'],['/panel/customers','مشتریان نمونه']];
if(marketGateway.enabled&&(user.role==='owner'||storeRole(user)==='manager'))links.unshift([user.role==='owner'?'/market/admin':'/market/seller','🛒 سفارش‌ها و موجودی جاری'],['/panel/demo-orders-archive','آرشیو سفارش‌های نمونه']);
if(user.role==='seller'&&storeRole(user)!=='manager'){for(const route of ['/panel/payment-readiness','/panel/pdf-books','/panel/store-operations','/panel/discounts','/panel/merchandising','/panel/orders','/panel/reports','/panel/customers']){const index=links.findIndex(x=>x[0]===route);if(index>=0)links.splice(index,1);}}
if(user.role==='seller'&&storeRole(user)==='manager') links.push(['/panel/store-profile','مشخصات فروشگاه'],['/panel/store-docs','مدارک و تأیید فروشگاه'],['/panel/staff','کارکنان فروشگاه']);
links.push(['/panel/account','حساب و امنیت']);
return `<div class="shell panel-layout"><aside class="panel-side"><h2>پنل ${user.role==='owner'?'مرکزی YM':storeRole(user)==='manager'?'مدیر فروشگاه':storeRole(user)==='inventory'?'کارمند موجودی':'مشاهده‌گر فروشگاه'}</h2><p>👤 ${esc(user.username)}</p><button type="button" class="panel-nav-toggle" aria-controls="panel-section-links" aria-expanded="false">☰ <span>بخش‌های مدیریت</span> <span aria-hidden="true">⌄</span></button><div id="panel-section-links" class="panel-side-links">${links.map(([href,label])=>`<a class="${title===label?'selected':''}" ${title===label?'aria-current="page"':''} href="${href}">${label}</a>`).join('')}<form method="post" action="/logout">${csrfInput(user)}<button class="side-exit">خروج از حساب</button></form></div></aside><section class="panel-main"><div class="panel-heading"><h1>${esc(title)}</h1><a href="/">← بازگشت به سایت</a></div>${inner}</section></div>`;}

function panelRightsTracker(user,url){
 if(user.role!=='owner')return null;
 const q=String(url.searchParams.get('q')||'').trim().slice(0,90);
 const status=['all','not_requested','requested','granted','denied'].includes(url.searchParams.get('status'))?url.searchParams.get('status'):'all';
 const followup=['all','overdue','today','next7','unscheduled'].includes(url.searchParams.get('followup'))?url.searchParams.get('followup'):'all';
 const all=coverRights.rows(db),day=coverRights.todayTehran(),counts=coverRights.stats(all,day);
 const filtered=all.filter(r=>(status==='all'||r.request_status===status)
   &&(followup==='all'||coverRights.followupState(r,day)===followup)
   &&(!q||[r.title,r.publisher,r.isbn,r.contact_name].join(' ').includes(q)));
 const target=Number(url.searchParams.get('edition')||0);
 const targetIdx=filtered.findIndex(row=>row.edition_id===target);
 const requestedPage=url.searchParams.has('page')?Number(url.searchParams.get('page')):targetIdx<0?1:Math.floor(targetIdx/15)+1;
 const page=Math.max(1,Math.min(Math.ceil(filtered.length/15)||1,requestedPage||1));
 const params=new URLSearchParams({status,followup,q});
 const labels={not_requested:'هنوز درخواست نشده',requested:'در انتظار پاسخ',granted:'اجازه گزارش‌شده؛ نیازمند بررسی نهایی',denied:'اجازه رد شده'};
 const followupLabels={overdue:'پیگیری عقب‌افتاده',today:'موعد پیگیری امروز',next7:'پیگیری هفت روز آینده',unscheduled:'بدون موعد پیگیری',later:'پیگیری زمان‌بندی‌شده'};
 const cards=filtered.slice((page-1)*15,page*15).map(r=>{
   const selected=Number(url.searchParams.get('edition')||0)===r.edition_id;
   const followState=coverRights.followupState(r,day);
   const details=selected?coverRights.history(db,r.edition_id,25):[];
   const journal=details.length?`<div class="rights-history"><h3>تاریخچه ثبت‌شده پرونده (${digits(details.length)} رویداد اخیر)</h3><ol>${details.map(e=>{
      const snap=JSON.parse(e.snapshot_json);
      return `<li><strong>${esc(labels[e.previous_status]||e.previous_status)} ← ${esc(labels[e.new_status]||e.new_status)}</strong> · نسخه ${digits(e.revision)} · ${esc(e.created_at)} · ${esc(e.actor_name||'حساب حذف‌شده')}<p class="muted tiny">موعد پیگیری: ${esc(snap.next_followup_date||'—')} · مرجع: ${esc(snap.evidence_ref||'—')} · یادداشت: ${esc(snap.notes||'—')}</p></li>`;
   }).join('')}</ol></div>`:'<p class="muted tiny">هنوز سابقه‌ای برای این پرونده ثبت نشده است. سوابق پیش از نسخه ۳.۵ به‌صورت خودکار ساخته نمی‌شوند.</p>';
   return `<article class="catalog-quality-card"><div><strong>${esc(r.title)}</strong><p class="muted tiny">${esc(r.publisher)} · <code dir="ltr">${esc(r.isbn)}</code> · ${r.has_public_cover?'جلد قابل نمایش موجود':'جلد قابل انتشار ثبت نشده'}</p><small>${esc(labels[r.request_status])}</small>${followState!=='not_applicable'?`<p class="rights-due ${followState==='overdue'?'rights-overdue':''}">${esc(followupLabels[followState])}${r.next_followup_date?' · '+esc(r.next_followup_date):''}</p>`:''}<div class="button-row"><a class="outline" href="/panel/bibliography?book=${r.book_id}">شناسنامه و بارگذاری جلد</a><a class="outline" href="/panel/cover-research?edition=${r.edition_id}">جست‌وجوی جلد</a><a class="outline" href="/panel/rights-tracker?${selected?'':'edition='+r.edition_id+'&'}${params.toString()}&page=${page}">${selected?'بستن جزئیات':'ثبت پیگیری / تاریخچه'}</a></div></div>${selected?`<div><form method="post" action="/panel/rights-tracker" class="form-grid">${csrfInput(user)}<input type="hidden" name="edition_id" value="${r.edition_id}"><input type="hidden" name="revision" value="${r.revision}"><label>وضعیت درخواست<select name="status">${Object.entries(labels).map(([k,v])=>`<option value="${k}" ${k===r.request_status?'selected':''}>${esc(v)}</option>`).join('')}</select></label><label>ناشر یا صاحب حقوق<input name="contact_name" maxlength="180" value="${attr(r.contact_name||'')}"></label><label>تاریخ آخرین مکاتبه (میلادی)<input name="contact_date" type="date" value="${attr(r.contact_date||'')}"></label><label>موعد پیگیری بعدی (میلادی)<input name="next_followup_date" type="date" value="${attr(r.next_followup_date||'')}"></label><label class="full">مرجع مکاتبه یا شماره نامه<input name="evidence_ref" maxlength="300" value="${attr(r.evidence_ref||'')}" placeholder="شناسه نامه یا مسیر پرونده داخلی؛ رمز و اطلاعات حساس وارد نکنید"></label><label class="full">یادداشت مکاتبه<textarea name="notes" maxlength="400">${esc(r.notes||'')}</textarea></label><p class="muted tiny full">موعد پیگیری صرفاً برای وضعیت «در انتظار پاسخ» است. ثبت «اجازه دریافت شده» هرگز به معنای اجازه انتشار تصویر نیست؛ تأیید سند و تطبیق دقیق شابک جداست.</p><button class="cta">ذخیره و ثبت در تاریخچه</button></form>${journal}</div>`:''}</article>`;
 }).join('');
 const filterOptions=[['all','همه'],['overdue','عقب‌افتاده'],['today','موعد امروز'],['next7','۷ روز آینده'],['unscheduled','در انتظار بدون موعد']];
 return panelShell(user,`<div class="soft-warning">وضعیت مکاتبه با ناشر به معنی مجوز حقوقی تاییدشده برای انتشار تصویر نیست. جلد فقط با سند معتبر، تطبیق شابک و بارگذاری مستقل نمایش داده می‌شود. موعدها بر پایه روز رسمی ایران محاسبه می‌شوند.</div><div class="quality-stats">${[['چاپ مستند',counts.total],['در انتظار پاسخ',counts.requested],['عقب‌افتاده',counts.overdue],['موعد امروز',counts.today],['هفته آینده',counts.next7],['بدون موعد',counts.unscheduled],['اجازه گزارش‌شده',counts.granted],['جلد قابل نمایش',counts.public_covers]].map(([k,v])=>`<div><strong>${digits(v)}</strong><span>${k}</span></div>`).join('')}</div><div class="panel-note"><h2>پیگیری اجازه تصاویر ناشران و موعد مکاتبات</h2><p><a class="outline" href="/panel/rights-tracker.csv">دریافت CSV کامل پیگیری‌ها و موعدها</a> · <a class="outline" href="/panel/rights-tracker?followup=overdue">موارد عقب‌افتاده</a> · <a class="outline" href="/panel/rights-tracker?followup=today">کارهای امروز</a></p><form method="get" action="/panel/rights-tracker" class="form-grid"><label>جست‌وجوی کتاب، ناشر، شابک یا مخاطب<input name="q" maxlength="90" value="${attr(q)}"></label><label>وضعیت پرونده<select name="status">${[['all','همه'],...Object.entries(labels)].map(([k,v])=>`<option value="${k}" ${k===status?'selected':''}>${esc(v)}</option>`).join('')}</select></label><label>زمان پیگیری<select name="followup">${filterOptions.map(([k,v])=>`<option value="${k}" ${k===followup?'selected':''}>${v}</option>`).join('')}</select></label><button class="cta">نمایش نتایج</button></form><p>${digits(filtered.length)} نتیجه · صفحه ${digits(page)}</p><div class="catalog-quality-list">${cards||'<p>موردی پیدا نشد.</p>'}</div><div class="button-row">${page>1?`<a class="outline" href="/panel/rights-tracker?${params.toString()}&page=${page-1}">صفحه قبل</a>`:''}${page*15<filtered.length?`<a class="outline" href="/panel/rights-tracker?${params.toString()}&page=${page+1}">صفحه بعد</a>`:''}</div></div>`,'پیگیری مجوز تصاویر');
}

function panelPublicationReview(user,url){
 if(user.role!=='owner')return null;
 const mode=publicationReview.MODES.includes(url.searchParams.get('status'))?url.searchParams.get('status'):'all';
 const q=str(url.searchParams.get('q'),80);
 const all=publicationReview.rows(db),stat=publicationReview.summary(all),list=publicationReview.filter(all,mode,q);
 const totalPages=Math.max(1,Math.ceil(list.length/20));
 const pageNumber=Math.max(1,Math.min(totalPages,Math.floor(Number(url.searchParams.get('page'))||1)));
 const modeLabels=[['all','همه کتاب‌ها'],['rights-conflict','تعارض مجوز تصویر'],['missing-author','نویسنده ناقص'],['missing-intro','معرفی ناقص'],['missing-source','چاپ بدون منبع'],['missing-cover','فاقد تصویر دارای سند'],['pending-draft','پیشنهاد بررسی‌نشده'],['technical-candidate','نامزد بررسی انسانی'],['seo-candidate','حداقل معیار فنی سئو']];
 const cards=list.slice((pageNumber-1)*20,pageNumber*20).map(r=>`<article class="catalog-quality-card"><div><b>${esc(r.title)}</b><small>کتاب ${digits(r.id)} · ${esc(r.category)}</small><div class="quality-tags">${r.hasConflict?'<span>⚠ تعارض حقوق تصویر</span>':''}${r.technicalCandidate?'<span>نامزد بررسی نهایی انسانی</span>':''}${r.seoCandidate?'<span>معیار فنی ایندکس</span>':''}</div><p class="muted tiny">${esc(r.todo.join(' · ')||'بدون نقص فنی در معیارهای این گزارش؛ تأیید قانونی و محتوایی مستقل ضروری است')}</p></div><div class="button-row"><a class="outline" href="/panel/catalog-quality?book=${r.id}#edit-metadata">محتوا</a><a class="outline" href="/panel/bibliography?book=${r.id}">چاپ و جلد</a><a class="outline" href="/book/${encodeURIComponent(r.slug)}">صفحه عمومی</a></div></article>`).join('');
 const nav=n=>'/panel/publication-review?'+new URLSearchParams({status:mode,q,page:String(n)}).toString();
 const filteredCsv='/panel/publication-review.csv?'+new URLSearchParams({status:mode,q}).toString();
 const deskShortcuts=[['rights-conflict','تعارض فوری تصاویر',stat.rightsConflicts],['pending-draft','پیشنهادهای در انتظار',stat.pendingDrafts],['missing-intro','معرفی ناقص',stat.missingIntro],['missing-source','منبع چاپ ناقص',stat.missingSource]]
   .map(([key,label,count])=>`<a class="outline" href="/panel/publication-review?status=${key}">${esc(label)} · ${digits(count)}</a>`).join('');
 return panelShell(user,`<div class="soft-warning">این گزارش صرفاً شاخص‌های فنی و وجود شواهد ثبت‌شده را بررسی می‌کند؛ «نامزد» هرگز به معنی تأیید صحت مطالب، اصالت مجوز تصویر، ایندکس قطعی گوگل یا مجوز فروش نیست. اختلاف وضعیت «رد مجوز» با تصویر موجود فوراً باید بررسی انسانی شود. هیچ چیز خودکار منتشر یا حذف نمی‌شود.</div><div class="quality-stats">${[['کتاب‌ها',stat.total],['معیار فنی سئو',stat.seoCandidates],['نامزد بررسی نهایی',stat.technicalCandidates],['تعارض تصویر',stat.rightsConflicts],['بدون نویسنده',stat.missingAuthor],['معرفی کوتاه یا خالی',stat.missingIntro],['بدون منبع چاپ',stat.missingSource],['بدون سند تصویر',stat.missingCover],['پیشنهاد معلق',stat.pendingDrafts]].map(([name,count])=>`<div><strong>${digits(count)}</strong><span>${esc(name)}</span></div>`).join('')}</div><div class="panel-note"><h2>میز تحریریه و اولویت‌های رسیدگی</h2><div class="button-row">${deskShortcuts}</div><p class="muted tiny">این لینک‌ها صرفاً فهرست کارهای انسانی هستند و هیچ موردی را خودکار تأیید یا منتشر نمی‌کنند.</p><h2>ارزیابی یکپارچه محتوای ۱۰۰۰ کتاب</h2><p><a class="outline" href="${attr(filteredCsv)}">CSV همین فیلتر</a> · <a class="outline" href="/panel/publication-review.csv">CSV کامل وظایف و ریسک‌ها</a>؛ خروجی فقط برای مدیر YM قابل دریافت است.</p><form class="filterbar" method="get" action="/panel/publication-review"><label>وضعیت<select name="status">${modeLabels.map(([value,label])=>`<option value="${value}" ${mode===value?'selected':''}>${label}</option>`).join('')}</select></label><label>نام کتاب / نویسنده / شناسه<input name="q" value="${attr(q)}" maxlength="80"></label><button class="cta">فیلتر</button></form><p>${digits(list.length)} مورد · صفحه ${digits(pageNumber)} از ${digits(totalPages)}</p><div class="catalog-quality-list">${cards||'<p>موردی در این فیلتر وجود ندارد.</p>'}</div><nav class="button-row">${pageNumber>1?`<a class="outline" href="${nav(pageNumber-1)}">صفحه قبل</a>`:''}${pageNumber<totalPages?`<a class="outline" href="${nav(pageNumber+1)}">صفحه بعد</a>`:''}</nav></div>`,'ارزیابی انتشار محتوا');
}
function panelEditionAudit(user,url){
 if(user.role!=='owner')return null;
 const filter=['all','needs_source','needs_cover','needs_author','ready'].includes(url.searchParams.get('status'))?url.searchParams.get('status'):'all';
 const data=catalogAudit.rows(db);const stat=catalogAudit.summary(data);const filtered=catalogAudit.filterRows(data,filter);
 const pageSize=24;const pageTotal=Math.max(1,Math.ceil(filtered.length/pageSize));const pageNum=Math.max(1,Math.min(pageTotal,Number(url.searchParams.get('page'))||1));const shown=filtered.slice((pageNum-1)*pageSize,pageNum*pageSize);
 const filters=[['all','همه'],['needs_source','فاقد چاپ منبع‌دار'],['needs_cover','بدون جلد مجاز'],['needs_author','نویسنده ناقص'],['ready','کامل از نظر شناسنامه و جلد']];
 const controls=filters.map(([id,name])=>`<option value="${id}" ${filter===id?'selected':''}>${name}</option>`).join('');
 const items=shown.map(x=>`<article class="catalog-quality-card"><div><b>${esc(x.title)}</b><small>شناسه ${digits(x.id)} · ${esc(x.author||'نویسنده در انتظار بررسی')} · ${digits(x.sourced)} شناسنامه منبع‌دار</small><div class="quality-tags">${!x.sourced?'<span>شابک و ناشر ناقص</span>':''}${!x.licensedCover?'<span>جلد مجاز ثبت نشده</span>':''}${!x.author?'<span>نویسنده ناقص</span>':''}${x.sourced&&!x.licensedCover?'<span>عکس دقیق چاپ را از فروشگاه دریافت کنید</span>':''}</div></div><div class="button-row"><a class="outline" href="/panel/bibliography?book=${x.id}">ثبت شناسنامه و جلد</a><a class="outline" href="/book/${attr(x.slug)}" target="_blank" rel="noopener">صفحه کتاب</a></div></article>`).join('');
 return panelShell(user,`<div class="soft-warning">«منبع‌دار» به معنی تطبیق فیزیکی چاپ موجود در فروشگاه نیست؛ «جلد مجاز» فقط عکس بارگذاری‌شده با ثبت حق استفاده است. تعداد صفحات و سال چاپ ممکن است میان نوبت‌های چاپ همان شابک تفاوت داشته باشد.</div><div class="quality-stats"><div><strong>${digits(stat.total)}</strong><span>عنوان</span></div><div><strong>${digits(stat.sourced)}</strong><span>عنوان با چاپ منبع‌دار</span></div><div><strong>${digits(stat.editions)}</strong><span>شناسنامه چاپ</span></div><div><strong>${digits(stat.licensedCover)}</strong><span>عنوان با جلد مجاز</span></div></div><div class="panel-note"><h2>پیشرفت تکمیل کتاب‌ها</h2><p>مراحل: بررسی شابک و مشخصات یک چاپ ← تطبیق با کتاب موجود در فروشگاه ← ثبت عکس مجاز همان چاپ ← تکمیل معرفی اختصاصی.</p><div class="button-row"><a class="outline" href="/panel/edition-audit.csv">دانلود چک‌لیست ۲۰۰ عنوان</a><a class="outline" href="/panel/bibliography">ورود به مدیریت چاپ‌ها</a></div><form method="get" action="/panel/edition-audit" class="filterbar"><select name="status">${controls}</select><button class="cta">اعمال فیلتر</button></form><p>${digits(filtered.length)} عنوان در فیلتر انتخابی · صفحه ${digits(pageNum)} از ${digits(pageTotal)}</p><div class="catalog-quality-list">${items||'<p class="muted">موردی یافت نشد.</p>'}</div><nav class="button-row">${pageNum>1?`<a class="outline" href="/panel/edition-audit?status=${filter}&page=${pageNum-1}">صفحه قبل</a>`:''}${pageNum<pageTotal?`<a class="outline" href="/panel/edition-audit?status=${filter}&page=${pageNum+1}">صفحه بعد</a>`:''}</nav></div>`, 'کنترل چاپ‌ها و جلدها');
}
function panelCoverResearch(user,url){
 if(user.role!=='owner')return null;
 const all=coverResearch.list(db);const selected=Number(url.searchParams.get('edition')||0);
 const chosen=all.find(r=>r.edition_id===selected)||all[0];
 const opts=all.map(x=>`<option value="${x.edition_id}" ${chosen&&x.edition_id===chosen.edition_id?'selected':''}>${esc(x.title)} · ${esc(x.publisher)} · ${esc(x.isbn)}</option>`).join('');
 const cards=all.slice(Math.max(0,Number(url.searchParams.get('page')||1)-1)*20,Math.max(0,Number(url.searchParams.get('page')||1)-1)*20+20).map(x=>`<article class="catalog-quality-card"><div><b>${esc(x.title)}</b><small>${esc(x.publisher)} · شابک <code dir="ltr">${esc(x.isbn)}</code></small>${x.current_url?`<img class="bib-cover-image" src="${attr(x.current_url)}" alt="تصویر پیشنهادی جلد ${attr(x.title)}؛ تأیید نشده" loading="lazy" referrerpolicy="no-referrer" width="76" height="106">`:''}<div class="quality-tags"><span>${digits(x.candidate_count)} پیشنهاد ثبت‌شده</span><span>${x.current_url?'یک تصویر منبع‌دار اولیه':'بدون تصویر اولیه'}</span><span>${x.rights_confirmed?'مجوز ثبت‌شده':'حق انتشار بررسی نشده'}</span></div></div><div class="button-row"><a class="outline" target="_blank" rel="noopener noreferrer" href="${attr(coverResearch.imageSearch(x))}">جست‌وجوی اینترنتی جلد</a><a class="outline" target="_blank" rel="noopener noreferrer" href="${attr(coverResearch.coversApi(x))}">بررسی Open Library</a><a class="outline" href="/panel/cover-research?edition=${x.edition_id}">ثبت پیشنهاد</a></div></article>`).join('');
 const proposals=chosen?coverResearch.candidates(db,chosen.edition_id):[];const coverStats=coverResearch.auditSummary(db);
 const existing=proposals.map(x=>`<article class="catalog-quality-card"><div><b>${esc(x.source_name)}</b><small>وضعیت: ${x.status==='rejected'?'ردشده':x.status==='permission_pending'?'در انتظار اجازه استفاده':x.status==='ready_for_upload'?'بررسی‌شده؛ آماده بارگذاری مجاز':'در حال بررسی'}</small><p>${esc(x.rights_note||'مدرک اجازه استفاده ثبت نشده')}</p><a target="_blank" rel="noopener noreferrer" href="${attr(x.image_url)}">مشاهده تصویر از سایت اصلی</a> · <a target="_blank" rel="noopener noreferrer" href="${attr(x.source_url)}">مشاهده صفحه منبع</a></div><form method="post" action="/panel/cover-research/status">${csrfInput(user)}<input type="hidden" name="id" value="${x.id}"><input type="hidden" name="edition_id" value="${chosen.edition_id}"><select name="status"><option value="research" ${x.status==='research'?'selected':''}>در حال بررسی</option><option value="permission_pending" ${x.status==='permission_pending'?'selected':''}>در انتظار اجازه استفاده</option><option value="rejected" ${x.status==='rejected'?'selected':''}>رد تصویر</option><option value="ready_for_upload" ${x.status==='ready_for_upload'?'selected':''}>بررسی‌شده؛ آماده بارگذاری مجاز</option></select><label>مدرک تطبیق با ISBN<input name="match_evidence" value="${attr(x.match_evidence||'')}" maxlength="600" placeholder="عکس بارکد کتاب، سند ناشر یا تطبیق شماره چاپ"></label><label>مدرک مجوز بازنشر<input name="rights_evidence" value="${attr(x.rights_evidence||'')}" maxlength="600" placeholder="اجازه کتبی ناشر یا مالک تصویر"></label><label class="check-row"><input type="checkbox" name="isbn_checked" value="1"> تطبیق شماره چاپ، ناشر و شابک بررسی شد</label><label class="check-row"><input type="checkbox" name="rights_checked" value="1"> حق انتشار تصویر مستند شد</label><button class="outline">ثبت بررسی</button></form></article>`).join('');
 return panelShell(user,`<div class="soft-warning">این بخش فقط برای کشف تصویر جلد واقعی در اینترنت است؛ لینک‌های پیدا شده به‌صورت خودکار در صفحه عمومی منتشر نمی‌شوند. شابک، ناشر، ترجمه و حق استفاده تجاری باید بررسی شوند. دریافت تصویر از منابع اینترنتی توسط سرور انجام نمی‌شود.</div><div class="panel-note"><h2>جست‌وجوی جلد برای ${digits(all.length)} چاپ مستند</h2><p>بانک: ${digits(coverStats.books)} عنوان؛ ${digits(coverStats.books_with_sources)} عنوان دارای شناسنامه مستند؛ ${digits(coverStats.uploaded_edition_covers)} جلد بارگذاری‌شده برای چاپ خاص؛ ${digits(coverStats.ready_candidates)} مورد دارای بررسی مستند و آماده بارگذاری</p><div class="button-row"><a class="outline" href="/panel/cover-research.csv">خروجی CSV لینک‌های جست‌وجو</a><a class="outline" href="/panel/cover-rights.csv">گزارش حقوق و تأیید تصاویر</a><a class="outline" href="/panel/bibliography">شناسنامه و تصاویر</a><a class="outline" href="/panel/edition-audit">کنترل ۲۰۰ عنوان</a></div><div class="catalog-quality-list">${cards}</div><div class="button-row"><a class="outline" href="/panel/cover-research?page=1">صفحه اول</a>${all.length>20?'<a class="outline" href="/panel/cover-research?page=2">صفحه دوم</a>':''}</div></div>${chosen?`<div class="panel-note"><h2>ثبت تصویر اینترنتی پیشنهادی</h2><form method="get" action="/panel/cover-research" class="form-grid"><label>انتخاب چاپ مستند<select name="edition">${opts}</select></label><button class="outline">انتخاب</button></form><p>کتاب: <b>${esc(chosen.title)}</b> · ناشر: ${esc(chosen.publisher)} · شابک: <code dir="ltr">${esc(chosen.isbn)}</code></p><p><a target="_blank" rel="noopener noreferrer" href="${attr(coverResearch.imageSearch(chosen))}">جست‌وجوی جلد همین شابک در تصاویر گوگل</a></p><details class="cover-live-review"><summary>پیش‌نمایش احتمالی جلد از Open Library برای همین شابک</summary><div class="cover-live-preview"><img src="${attr(coverResearch.coversApi(chosen))}" referrerpolicy="no-referrer" alt="جلد احتمالی چاپ دارای شابک ${attr(chosen.isbn)}؛ هنوز تأیید نشده" loading="lazy" width="150" height="205"><p>این فقط پیش‌نمایش آنلاین برای بررسی است؛ ممکن است تصویر موجود نباشد یا با چاپ ایرانی تطبیق نداشته باشد. استفاده در سایت عمومی نیازمند کنترل نسخه و حق استفاده است. <a href="https://openlibrary.org/isbn/${encodeURIComponent(chosen.isbn)}" target="_blank" rel="noopener noreferrer">صفحه شابک در Open Library</a></p></div></details><form method="post" action="/panel/cover-research" class="form-grid">${csrfInput(user)}<input type="hidden" name="edition_id" value="${chosen.edition_id}"><label>نشانی مستقیم تصویر HTTPS<input required type="url" name="image_url" placeholder="https://publisher.example/cover.jpg" maxlength="1200"></label><label>صفحه منبع تصویر HTTPS<input required type="url" name="source_url" placeholder="https://publisher.example/book/..." maxlength="1200"></label><label>نام ناشر یا منبع<input required name="source_name" maxlength="160"></label><label>یادداشت بررسی حقوق و تطبیق<textarea name="rights_note" rows="3" maxlength="300" placeholder="وضعیت درخواست اجازه، تطبیق طرح با ISBN و ..."></textarea></label><label>وضعیت<select name="status"><option value="research">نیازمند بررسی</option><option value="permission_pending">در انتظار تأیید حق استفاده</option></select></label><button class="cta">ثبت برای بررسی (بدون انتشار)</button></form><h3>تصاویر پیشنهادی ثبت‌شده</h3><div class="catalog-quality-list">${existing||'<p class="muted">هنوز پیشنهادی برای این چاپ ثبت نشده است.</p>'}</div><p class="soft-warning">پس از دریافت حق استفاده، تصویر دقیق همین چاپ را از قسمت <a href="/panel/bibliography?book=${chosen.book_id}">شناسنامه</a> یا «بارگذاری جلد» به‌صورت تأییدشده درج کنید.</p></div>`:''}`, 'جست‌وجوی تصویر جلد واقعی');
}
function panelHome(user){const count=db.prepare('SELECT count(*) n FROM books').get().n;const activeStores=db.prepare('SELECT count(*) n FROM stores WHERE active=1').get().n;const offerCount=user.role==='owner'?db.prepare('SELECT count(*) n FROM stock_items WHERE active=1').get().n:db.prepare('SELECT count(*) n FROM stock_items WHERE active=1 AND store_id=?').get(user.store_id).n;const store=user.store_id?db.prepare('SELECT name FROM stores WHERE id=?').get(user.store_id):null;
return panelShell(user,`<div class="stats panel-stats"><div><b>${digits(count)}</b><span>کتاب در بانک اطلاعات</span></div><div><b>${digits(offerCount)}</b><span>موجودی‌های فعال</span></div><div><b>${digits(activeStores)}</b><span>فروشگاه فعال</span></div></div><div class="panel-note"><h2>وضعیت نسخه اول</h2><p>${user.role==='owner'?'مدیریت مرکزی سایت آماده است. می‌توانی اطلاعات کتاب‌ها، فروشگاه‌ها و دسترسی کارکنان را تنظیم کنی.':storeRole(user)==='viewer'?'می‌توانی موجودی فروشگاه را فقط مشاهده کنی.':'می‌توانی قیمت و موجودی کتاب‌های فروشگاه خودت را مدیریت کنی.'}</p><p>🔒 درگاه واقعی و ثبت سفارش پولی هنوز فعال نشده‌اند. سفارش‌های آزمایشی برای بررسی مراحل سایت در پنل قابل مشاهده‌اند؛ هیچ پرداخت یا ارسال واقعی انجام نمی‌شود.</p>${store?`<p>فروشگاه متصل: <b>${esc(store.name)}</b></p>`:''}<div class="button-row"><a class="cta" href="/panel/inventory">مدیریت موجودی</a>${user.role==='owner'||storeRole(user)==='manager'?'<a class="outline" href="/panel/reports">گزارش‌های آزمایشی</a>':''}${user.role==='owner'?'<a class="outline" href="/panel/stores">مدیریت فروشگاه‌ها</a>':''}</div></div>`, 'داشبورد');}
function panelStoreOperations(user,url){
 if(user.role!=='owner' && !(user.role==='seller'&&storeRole(user)==='manager'))return null;
 const owner=user.role==='owner';
 const requested=url.searchParams.has('store')?safeId(url.searchParams.get('store')):0;
 const storeId=owner?requested:user.store_id;
 if(owner&&url.searchParams.has('store')&&!db.prepare('SELECT id FROM stores WHERE id=?').get(storeId))return null;
 const q=owner?str(url.searchParams.get('q'),80):'';
 const review=owner?(url.searchParams.get('review')||'all'):'all';
 const taskStatus=url.searchParams.get('task_status')||'all';
 let rows,tasks;
 try{rows=storeOperations.allStores(db,{storeId,q,review});tasks=storeOperations.tasks(db,{storeId,status:taskStatus,limit:80});}
 catch(e){if(e.userError)return null;throw e;}
 const allStores=owner?db.prepare('SELECT id,name FROM stores ORDER BY name').all():[];
 const stats=storeOperations.overview(rows);
 const storeOptions=allStores.map(x=>`<option value="${x.id}" ${x.id===storeId?'selected':''}>${esc(x.name)}</option>`).join('');
 const query=new URLSearchParams();if(storeId)query.set('store',String(storeId));if(q)query.set('q',q);if(review!=='all')query.set('review',review);
 const csvUrl='/panel/store-operations.csv?'+query.toString();
 const metrics=[['کتاب‌فروشی‌های گزارش',stats.stores],['دارای نمایش عمومی',stats.publicStores],['مدارک در انتظار بررسی',stats.pendingReview],['هشدارهای موجودی',stats.lowStock],['پیگیری‌های باز',stats.openTasks],['پیگیری‌های عقب‌افتاده',stats.overdueTasks],['درخواست‌های نمونه (غیرواقعی)',stats.demoOrders]];
 const filters=owner?`<form class="form-grid" method="get" action="/panel/store-operations"><label>جست‌وجوی فروشگاه<input name="q" maxlength="80" value="${attr(q)}" placeholder="نام یا شهر"></label><label>نمایش فروشگاه<select name="store"><option value="">همه فروشگاه‌ها</option>${storeOptions}</select></label><label>بررسی مدارک<select name="review">${[['all','همه'],['unverified','بررسی نشده'],['submitted','در انتظار'],['approved','تأیید داخلی'],['rejected','نیازمند اصلاح']].map(([k,v])=>`<option value="${k}" ${k===review?'selected':''}>${v}</option>`).join('')}</select></label><button class="cta">اعمال فیلتر</button></form><a class="outline" href="${attr(csvUrl)}">دریافت CSV همین گزارش</a>`:'';
 const board=rows.map(x=>`<tr><td><a href="/panel/store-operations?store=${x.id}">${esc(x.name)}</a><small>${esc(x.city||'—')}</small></td><td>${esc(REVIEW_LABELS[x.review_status]||'در حال بررسی')}<small>${x.active?'نمایش عمومی':'نمایش غیرفعال'}</small></td><td>${digits(x.active_users)}</td><td>${digits(x.active_skus)} / ${digits(x.sku_count)}</td><td><b>${digits(x.low_stock)}</b></td><td>${digits(x.demo_orders)}</td><td>${digits(x.open_tasks)}</td><td>${digits(x.overdue_tasks)}</td><td><a href="/panel/store-docs?store=${x.id}">مدارک</a> · <a href="/panel/inventory?store=${x.id}">موجودی</a></td></tr>`).join('');
 const selectedStore=owner?storeId:user.store_id;
 const createForm=owner?`<div class="panel-note"><h2>ایجاد پیگیری برای کتاب‌فروشی</h2><form method="post" action="/panel/store-task-create" class="form-grid">${csrfInput(user)}<label>کتاب‌فروشی<select name="store_id" required>${allStores.map(x=>`<option value="${x.id}" ${x.id===selectedStore?'selected':''}>${esc(x.name)}</option>`).join('')}</select></label><label>عنوان اقدام<input required name="title" minlength="5" maxlength="160" placeholder="مثلاً دریافت پروانه کسب معتبر"></label><label>نوع پیگیری<select name="task_type">${Object.entries(storeOperations.TYPES).map(([k,v])=>`<option value="${k}">${v}</option>`).join('')}</select></label><label>اولویت<select name="priority">${Object.entries(storeOperations.PRIORITIES).map(([k,v])=>`<option value="${k}">${v}</option>`).join('')}</select></label><label>موعد پیگیری (میلادی)<input type="date" name="due_date"></label><label class="full">شرح و اقدام مورد انتظار<textarea name="note" maxlength="600"></textarea></label><button class="cta">ثبت پیگیری داخلی</button></form><p class="muted tiny">انجام‌شدن یک وظیفه، تأیید قانونی فروشگاه یا فعال‌شدن درگاه نیست.</p></div>`:'';
 const selectedHistory=safeId(url.searchParams.get('history'));
 const taskCards=tasks.map(t=>{
  const canEdit=owner||t.store_id===user.store_id;
  const past=t.status!=='done'&&t.due_date&&t.due_date<storeOperations.todayTehran();
  const history=selectedHistory===t.id?storeOperations.history(db,t.id,t.store_id):null;
  const historyHtml=history?`<ol>${history.map(e=>`<li>${esc(storeOperations.STATES[e.old_status]||'ثبت اولیه')} ← ${esc(storeOperations.STATES[e.new_status])} · ${esc(e.created_at)} · ${esc(e.username||'کاربر حذف شده')}<p class="muted tiny">${esc(e.new_note||'بدون یادداشت')}</p></li>`).join('')}</ol>`:'';
  return `<article class="store-task-card"><div><b>${esc(t.title)}</b><small>${esc(t.store_name)} · ${esc(storeOperations.TYPES[t.task_type])} · ${esc(storeOperations.PRIORITIES[t.priority])} · ${esc(storeOperations.STATES[t.status])}</small><p class="muted tiny">موعد: ${esc(t.due_date||'تعیین نشده')} ${past?'· ⚠ عقب‌افتاده':''} · نسخه ${digits(t.revision)}</p></div>${canEdit?`<form method="post" action="/panel/store-task-update" class="form-grid">${csrfInput(user)}<input type="hidden" name="store_id" value="${t.store_id}"><input type="hidden" name="task_id" value="${t.id}"><input type="hidden" name="revision" value="${t.revision}"><label>وضعیت<select name="status">${Object.entries(storeOperations.STATES).map(([k,v])=>`<option value="${k}" ${t.status===k?'selected':''}>${v}</option>`).join('')}</select></label><label>یادداشت پیشرفت<input name="note" maxlength="600" value="${attr(t.note||'')}"></label><button class="outline">ذخیره پیشرفت</button></form>`:''}<p><a href="/panel/store-operations?${query.toString()}&history=${t.id}">${selectedHistory===t.id?'بستن سوابق':'تاریخچه تغییرات'}</a></p>${historyHtml}</article>`;
 }).join('');
 return panelShell(user,`<div class="soft-warning">این داشبورد برای مدیریت و آمادگی عملیاتی است. «سفارش‌ها» فقط DEMO هستند و هیچ فروش، پرداخت یا تسویه واقعی انجام نمی‌شود. وضعیت «تأیید داخلی مدارک» جایگزین مجوز قانونی نیست.</div><div class="quality-stats">${metrics.map(([k,v])=>`<div><strong>${digits(v)}</strong><span>${k}</span></div>`).join('')}</div><section class="panel-note"><h2>نمای عملیاتی کتاب‌فروشی‌ها</h2>${filters}<div class="table-scroll"><table class="data-table"><thead><tr><th>فروشگاه</th><th>وضعیت</th><th>کاربران</th><th>SKU فعال/کل</th><th>کمبود موجودی</th><th>DEMO</th><th>کارهای باز</th><th>عقب‌افتاده</th><th>دسترسی</th></tr></thead><tbody>${board||'<tr><td colspan="9">فروشگاهی با این شرایط پیدا نشد.</td></tr>'}</tbody></table></div></section>${createForm}<section class="panel-note"><h2>کارهای عملیاتی و پیگیری</h2><form class="inventory-filter" action="/panel/store-operations" method="get">${storeId?`<input type="hidden" name="store" value="${storeId}">`:''}<label>وضعیت<select name="task_status"><option value="all">همه</option>${Object.entries(storeOperations.STATES).map(([k,v])=>`<option value="${k}" ${taskStatus===k?'selected':''}>${v}</option>`).join('')}</select></label><button class="outline">فیلتر وظایف</button></form><p class="muted tiny">حداکثر ۸۰ اقدام در این صفحه نمایش داده می‌شود؛ برای مشاهده کارهای یک فروشگاه روی نام آن کلیک کنید.</p><div class="store-tasks">${taskCards||'<p>پیگیری ثبت‌شده‌ای برای این فیلتر وجود ندارد.</p>'}</div></section>`, 'عملیات فروشگاه‌ها');
}

function panelStores(user,url){if(user.role!=='owner')return null;
const all=db.prepare('SELECT * FROM stores ORDER BY id DESC').all();const editing=safeId(url.searchParams.get('edit'))?db.prepare('SELECT * FROM stores WHERE id=?').get(safeId(url.searchParams.get('edit'))):null;
return panelShell(user,`<div class="panel-note"><h2>${editing?'ویرایش فروشگاه':'ثبت فروشگاه جدید'}</h2><p class="muted tiny">ساخت فروشگاه به معنی تأیید مجوز یا فعال‌سازی پرداخت نیست. فروشگاه‌های جدید تا بررسی مدارک در حالت غیرفعال می‌مانند.</p><form method="post" action="/panel/store" class="form-grid">${csrfInput(user)}<input type="hidden" name="id" value="${editing?.id||''}"><label>نام فروشگاه<input name="name" required maxlength="100" value="${attr(editing?.name||'')}"></label><label>نامک لاتین و یکتا<input name="slug" required pattern="[a-z0-9-]{2,60}" value="${attr(editing?.slug||'')}" placeholder="bookstore-yazd"></label><label>شهر<input name="city" maxlength="80" value="${attr(editing?.city||'')}"></label><label>تلفن عمومی فروشگاه<input name="phone" maxlength="40" value="${attr(editing?.phone||'')}"></label><label class="full">درباره فروشگاه<textarea name="about" maxlength="500">${esc(editing?.about||'')}</textarea></label><label class="checkbox-line"><input name="active" type="checkbox" value="1" ${editing?.active?'checked':''}> نمایش عمومی (فقط پس از تأیید؛ فروشگاه قدیمی حفظ می‌شود)</label><button class="cta">ذخیره فروشگاه</button></form></div><h2 class="block-title">فروشگاه‌های ثبت‌شده</h2><div class="store-mobile-list">${all.map(x=>`<article class="store-mobile-card"><div><b>${esc(x.name)}</b><small>${esc(x.city)} · ${esc(REVIEW_LABELS[x.review_status]||'بررسی نشده')} · ${x.active?'نمایش عمومی':'غیرفعال'}</small></div><nav><a href="/panel/stores?edit=${x.id}">ویرایش</a><a href="/panel/store-docs?store=${x.id}">مدارک و تصمیم</a></nav></article>`).join('')}</div><div class="store-desktop-table table-scroll"><table class="data-table"><thead><tr><th>شناسه</th><th>نام</th><th>شهر</th><th>وضعیت مجوز</th><th>نمایش</th><th>مدیریت</th></tr></thead><tbody>${all.map(s=>`<tr><td>${s.id}</td><td>${esc(s.name)}</td><td>${esc(s.city)}</td><td><span class="small-status">${esc(REVIEW_LABELS[s.review_status]||'بررسی نشده')}</span></td><td>${s.active?'نمایش عمومی':'غیرفعال'}</td><td><a href="/panel/stores?edit=${s.id}">ویرایش</a> · <a href="/panel/store-docs?store=${s.id}">مدارک و تصمیم</a> · <a href="/store/${s.id}">نمایش</a></td></tr>`).join('')}</tbody></table></div>`, 'کتاب‌فروشی‌ها');}

function panelBibliography(user,url){
 if(user.role!=='owner')return null;
 const stats=bibliography.quality(db);
 const id=Number(url.searchParams.get('book'))||1;
 const b=db.prepare('SELECT * FROM books WHERE id=?').get(id);
 const rows=b?bibliography.sourcesFor(db,id):[];
 const books=db.prepare('SELECT id,title,author FROM books ORDER BY id LIMIT 250').all();
 const options=books.map(v=>`<option value="${v.id}" ${v.id===id?'selected':''}>#${v.id} — ${esc(v.title)}</option>`).join('');
 const forms=`<div class="panel-note"><h2>شناسنامه کتاب و جلد واقعی</h2><p class="muted">هر ISBN به یک چاپ مشخص تعلق دارد. تصویر باید دقیقاً با ناشر و ترجمه همان چاپ مطابقت داشته باشد. متن و تصویر غیرمستند منتشر نمی‌شوند؛ حق بازنشر عکس را قبل از انتشار تجاری بررسی کنید.</p><div class="quality-stats"><div><strong>${digits(stats.total)}</strong><span>عنوان</span></div><div><strong>${digits(stats.sourced)}</strong><span>چاپ مستند</span></div><div><strong>${digits(stats.withCover)}</strong><span>تصویر جلدِ نامزد</span></div><div><strong>${digits(stats.approvedCover)}</strong><span>جلد مجاز برای انتشار</span></div></div><form method="get" action="/panel/bibliography" class="inventory-filter"><label>انتخاب کتاب <select name="book">${options}</select></label><button class="cta">باز کردن</button></form></div>`;
 if(!b)return panelShell(user,forms+'<div class="empty">کتاب یافت نشد.</div>','شناسنامه کتاب');
 const known=rows.map(r=>`<div class="bib-edition"><div><b>${esc(r.publisher)} — ${esc(r.label||'چاپ ثبت‌شده')}</b><p>شابک: <code dir="ltr">${esc(r.isbn)}</code> · ${r.pages?digits(r.pages)+' صفحه · ':''}${esc(r.translator||'بدون مترجم')}</p><p>${r.source_url?`<a target="_blank" rel="noopener noreferrer" href="${attr(r.source_url)}">مشاهده منبع شناسنامه</a>`:''} ${r.cover_url?'· جلد واقعی مرتبط ثبت شده':'· تصویر جلد دقیق این چاپ هنوز ثبت نشده'}</p></div>${r.cover_url?`<img class="bib-cover-image" src="${attr(r.cover_url)}" loading="lazy" alt="جلد ${attr(b.title)}">`:''}</div>`).join('');
 const form=`<div class="panel-note"><h2>ثبت چاپ و تصویر مستند: ${esc(b.title)}</h2><form method="post" action="/panel/bibliography" class="form-grid">${csrfInput(user)}<input type="hidden" name="book_id" value="${id}"><label>شابک ۱۳ رقمی<input name="isbn" required pattern="[0-9-]{13,17}" placeholder="978..."></label><label>ناشر<input name="publisher" required maxlength="180"></label><label>عنوان چاپ<input name="label" maxlength="180"></label><label>مترجم<input name="translator" maxlength="180"></label><label>سال انتشار<input name="publication_year" maxlength="30"></label><label>تعداد صفحه<input name="pages" type="number" min="1" max="15000"></label><label>نوع جلد<input name="binding" maxlength="40"></label><label>نشانی منبع شناسنامه (HTTPS)<input name="source_url" type="url" required placeholder="https://..."></label><label>آدرس عکس جلد واقعی (دامنه معتبر)<input name="cover_url" type="url" placeholder="https://..."></label><label>منبع عکس<input name="cover_source" maxlength="200"></label><label>یادداشت حقوق تصویر<input name="cover_rights" maxlength="240"></label><label class="check-row"><input name="cover_matched" type="checkbox" value="1"> تأیید می‌کنم جلد مربوط به همین چاپ و شابک است</label><label class="check-row"><input name="rights_confirmed" type="checkbox" value="1"> مجوز قانونی استفاده عمومی از این تصویر را بررسی و مستند کرده‌ام</label><label class="check-row"><input name="confirm_update" type="checkbox" value="1"> در صورت وجود شابک، اصلاح شناسنامه چاپ با تأیید من انجام شود</label><button class="cta">ثبت شناسنامه مستند</button></form><p class="muted tiny">برای تصویر از سایر دامنه‌ها، از بخش <a href="/panel/covers?book=${id}">بارگذاری جلد روی سرور</a> استفاده کنید. تصویر بدون حق استفاده تجاری نباید در سایت عمومی باقی بماند.</p></div>`;
 const printable=editionCover.list(db,id);
 const photoForm=`<section class="panel-note"><h2>عکس جلد واقعیِ چاپ موجود در کتاب‌فروشی</h2><p class="muted">این فرم به شابک مشخص متصل است؛ از روی جلد همان نسخه در فروشگاه عکس بگیر یا تصویری با اجازه نشر بارگذاری کن. بدون شابک مستند، تصویر به‌عنوان جلد چاپ ثبت نمی‌شود.</p>${printable.length?`<form action="/panel/edition-cover-upload" method="post" enctype="multipart/form-data" class="form-grid">${csrfInput(user)}<input type="hidden" name="book_id" value="${id}"><label>چاپ و شابک<select name="edition_id" required>${printable.map(e=>`<option value="${e.id}">${esc(e.publisher)} · ${esc(e.isbn)}${e.filename?' · دارای تصویر':''}</option>`).join('')}</select></label><label>انتخاب تصویر JPEG، PNG یا WebP (تا ۷۰۰ کیلوبایت)<input type="file" name="cover" accept="image/png,image/jpeg,image/webp" required></label><label>مالک تصویر / منبع<input name="source" required maxlength="160" placeholder="عکس اختصاصی کتاب‌فروشی با رضایت مالک"></label><label>توضیح اجازه استفاده<input name="rights_note" required maxlength="240" placeholder="اجازه کتبی صاحب عکس برای انتشار در سایت"></label><label>متن جایگزین<input name="alt" maxlength="180" placeholder="جلد همین چاپ"></label><label class="check-row"><input type="checkbox" name="matched" value="1" required> جلد و شابک را با چاپ فیزیکی تطبیق دادم</label><label class="check-row"><input type="checkbox" name="licensed" value="1" required> حق قانونی انتشار تصویر در سایت را دارم</label><button class="cta">بارگذاری جلد واقعی این چاپ</button></form>`:'<p class="soft-warning">ابتدا شناسنامه یک چاپ را ثبت کن.</p>'}</section>`;
 return panelShell(user,forms+`<h2 class="block-title">چاپ‌های ثبت‌شده ${esc(b.title)}</h2>${known||'<div class="empty">هنوز چاپ مستندی ثبت نشده است.</div>'}`+photoForm+form,'شناسنامه و جلد واقعی');
}
function panelEditorialBatch(user){if(user.role!=='owner')return null;
 const p=editorialBatch.preview(db);const samples=p.rows.filter(x=>x.available).slice(0,12);
 return panelShell(user,`<div class="soft-warning">متن‌ها تألیفی هستند، اما هر اثر باید پیش از انتشار از نظر صحت نویسنده و اطلاعات بازبینی شود. هیچ متن پیشنهادی بدون تأیید مدیر منتشر نمی‌شود.</div><div class="panel-note"><h2>۶۶ معرفی اختصاصی برای بانک کتاب‌ها</h2><div class="quality-stats"><div><strong>${digits(p.total)}</strong><span>متن آماده</span></div><div><strong>${digits(p.ready)}</strong><span>قابل ورود به صف</span></div><div><strong>${digits(p.skipped)}</strong><span>دارای پیش‌نویس یا تکمیل‌شده</span></div></div><p>اطلاعات موجود و پیش‌نویس‌هایی که قبلاً وارد کرده‌اید تغییر نمی‌کنند. این عملیات فقط اطلاعات ناقص را برای بررسی در صف قرار می‌دهد.</p><form method="post" action="/panel/editorial-batch">${csrfInput(user)}<label class="checkbox-line"><input type="checkbox" name="confirm" value="1" required> متن‌های تألیفی را برای بررسی وارد می‌کنم؛ انتشار خودکار انجام نمی‌شود.</label><button class="cta">افزودن ${digits(p.ready)} مورد به صف بررسی</button></form><div class="button-row"><a class="outline" href="/panel/catalog-drafts">صف بررسی مدیر</a><a class="outline" href="/panel/catalog-worklist">نواقص ۱۰۰۰ کتاب</a></div></div><div class="panel-note"><h2>نمونه متن‌ها</h2>${samples.map(x=>`<article class="catalog-quality-card"><b>${esc(x.title)}</b><p>${esc(x.description)}</p><small>نویسنده پیشنهادی: ${esc(x.author)}</small></article>`).join('')}</div>`, 'معرفی تألیفی کتاب‌ها');
}
function panelEditorialBatchV31(user){if(user.role!=='owner')return null;
 const p=editorialBatchV31.preview(db),samples=p.rows.filter(x=>x.available).slice(0,12);
 const ambiguous=p.rows.filter(x=>!x.author).length;
 return panelShell(user,`<div class="soft-warning">متن‌های این بسته تألیفی و پیشنهادی‌اند و از منابع فروشگاهی کپی نشده‌اند. پیش از تأیید، نویسنده، روایت، چاپ و شابک را بررسی کنید. ${digits(ambiguous)} مورد عمداً بدون نویسنده پیشنهادی ثبت شده‌اند، چون عنوان مبهم است. هیچ متن یا تصویری خودکار منتشر نمی‌شود.</div><div class="panel-note"><h2>۱۳۴ معرفی تازه؛ تکمیل پیش‌نویس‌های ۲۰۰ عنوان</h2><div class="quality-stats"><div><strong>${digits(p.total)}</strong><span>معرفی جدید</span></div><div><strong>${digits(p.ready)}</strong><span>قابل افزودن به صف</span></div><div><strong>${digits(p.skipped)}</strong><span>دارای اطلاعات یا پیش‌نویس قبلی</span></div></div><p>پیش‌نویس‌های ۶۶ کتاب قبلی دست‌نخورده باقی می‌مانند. متن جدید فقط برای کتاب‌های دارای فیلد ناقص و بدون پیش‌نویس موجود وارد صف بررسی می‌شود.</p><form method="post" action="/panel/editorial-batch-31">${csrfInput(user)}<label class="checkbox-line"><input type="checkbox" name="confirm" value="1" required> ورود متن‌های پیشنهادی به صف بررسی، بدون انتشار عمومی و بدون بازنویسی محتوای موجود</label><button class="cta">افزودن ${digits(p.ready)} مورد برای بازبینی مدیر</button></form><div class="button-row"><a class="outline" href="/panel/editorial-batch">۶۶ معرفی قبلی</a><a class="outline" href="/panel/catalog-drafts">بررسی و تأیید متن‌ها</a><a class="outline" href="/panel/catalog-worklist">صف تکمیل بانک</a></div></div><div class="panel-note"><h2>نمونه معرفی‌ها</h2>${samples.map(x=>`<article class="catalog-quality-card"><b>${esc(x.title)}</b><p>${esc(x.description)}</p><small>نویسنده پیشنهادی: ${esc(x.author||'نیازمند شناسایی چاپ')} · ${esc(x.source_note)}</small></article>`).join('')}</div>`, '۱۳۴ معرفی جدید کتاب‌ها');
}
function panelEditorialQa(user,url){if(user.role!=='owner')return null;
 const data=editorialQa.counts(db),stats=data.stats;
 const q=str(url.searchParams.get('q'),80),filter=['all','pending','reviewed','unreviewed','approved','ambiguous'].includes(url.searchParams.get('status'))?url.searchParams.get('status'):'pending';
 const list=data.rows.filter(x=>(!q||x.title.includes(q)||String(x.book_id)===q)&&(
 filter==='all'||filter==='pending'&&x.status==='pending'||filter==='reviewed'&&x.status==='pending'&&x.reviewed||filter==='unreviewed'&&x.status==='pending'&&!x.reviewed||filter==='approved'&&x.status==='approved'||filter==='ambiguous'&&x.status==='pending'&&x.ambiguous));
 const page=Math.max(1,Math.min(100,Number(url.searchParams.get('page'))||1)),pages=Math.max(1,Math.ceil(list.length/20));
 const picked=safeId(url.searchParams.get('draft'));
 let detail='';if(picked){try{const current=editorialQa.status(db,picked),d=current.draft,r=current.record;
  detail=`<section class="panel-note" id="review-draft"><h2>بررسی متن شماره ${digits(d.id)}: ${esc(d.title)}</h2><p class="muted">تأیید محتوای کتاب به معنی تأیید نسخه فیزیکی یا تصویر جلد نیست. اطلاعات را با منبع مستقل بررسی کنید.</p><p><b>نویسنده کتاب موجود:</b> ${esc(d.book_author||'ثبت نشده')} · <b>نویسنده پیشنهادی:</b> ${esc(d.author||'ذکر نشده')}</p><p><b>متن پیشنهادی:</b> ${esc(d.description||'متنی پیشنهاد نشده')}</p><p><b>یادداشت منشأ:</b> ${esc(d.source_note)}</p><p><b>وضعیت بررسی قبلی:</b> ${current.valid?'معتبر برای این نسخه از متن':r?'قدیمی؛ متن از زمان بررسی تغییر کرده':'هنوز بررسی نشده'}</p><form method="post" action="/panel/editorial-qa" class="form-grid">${csrfInput(user)}<input type="hidden" name="draft_id" value="${d.id}"><label>منبع مستقل HTTPS (در صورت وجود)<input type="url" name="source_url" maxlength="500" value="${attr(r?.source_url||d.source_url||'')}" placeholder="https://..."></label><label class="full">یادداشت بررسی، تاریخ و مستندات (حداقل ۲۰ نویسه)<textarea name="review_note" maxlength="600" rows="3" placeholder="نام کتاب، نویسنده و محتوای معرفی با شناسنامه ناشر یا نسخه موجود بررسی شد...">${esc(r?.review_note||'')}</textarea></label><label class="checkbox-line"><input type="checkbox" name="author_checked" value="1" required> عنوان و نام نویسنده را بررسی کردم؛ موارد نامعلوم برای انتشار نیازمند اصلاح‌اند.</label><label class="checkbox-line"><input type="checkbox" name="synopsis_checked" value="1" required> متن معرفی را از نظر صحت، انتساب به اثر و کپی‌نبودن بررسی کردم.</label><button class="cta">ثبت بررسی همین نسخه متن</button></form>${current.valid?`<form method="post" action="/panel/editorial-qa-publish">${csrfInput(user)}<input type="hidden" name="draft_id" value="${d.id}"><button class="outline">تأیید و انتشار فیلدهای ناقص</button></form>`:'<p class="soft-warning">انتشار از این پنل فقط پس از ثبت چک‌لیست معتبر امکان‌پذیر است.</p>'}<div class="button-row"><a class="outline" href="/panel/catalog-quality?book=${d.book_id}#edit-metadata">بازبینی و اصلاح پیشنهاد</a><a class="outline" href="/panel/bibliography?book=${d.book_id}">شناسنامه چاپ</a></div></section>`;
 }catch(e){detail=`<p class="soft-warning">${esc(e.message)}</p>`;}}
 const tabs=[['all','همه'],['pending','در انتظار'],['unreviewed','بررسی‌نشده'],['reviewed','بررسی‌شده'],['approved','منتشرشده'],['ambiguous','نویسنده نامشخص']];
 const cards=list.slice((page-1)*20,page*20).map(x=>`<article class="catalog-quality-card"><div><strong>${esc(x.title)}</strong><small>کتاب ${digits(x.book_id)} · پیش‌نویس ${digits(x.id)} · ${esc(x.status)}</small><div class="quality-tags"><span>${x.reviewed?'بررسی ثبت‌شده':'بدون بررسی معتبر'}</span>${x.needs_author?'<span>نویسنده نامشخص</span>':''}${x.missing_independent_source?'<span>منبع مستقل ثبت نشده</span>':''}</div></div><a class="outline" href="/panel/editorial-qa?draft=${x.id}#review-draft">${x.status==='pending'?'بررسی مستند':'جزئیات'}</a></article>`).join('');
 const link=n=>'/panel/editorial-qa?'+new URLSearchParams({status:filter,q,page:String(n)}).toString();
 return panelShell(user,`<div class="soft-warning">این صفحه ابزار ثبت فرآیند بازبینی انسانی است؛ ادعای تأیید مستقل خودکار ندارد. ۲۰۰ متن تألیفی اولیه همچنان باید یکی‌یکی بررسی شوند. تغییر نسخه متن، تأیید قبلی را نامعتبر می‌کند.</div><div class="quality-stats">${[['کل پیشنهادها',stats.total],['در انتظار',stats.pending],['دارای بررسی معتبر',stats.ready],['نیازمند بررسی',stats.unreviewed],['بدون لینک منبع مستقل',stats.missingSource],['نویسنده مبهم',stats.ambiguous]].map(([k,v])=>`<div><strong>${digits(v)}</strong><span>${k}</span></div>`).join('')}</div><div class="panel-note"><h2>فهرست کنترل تحریریه</h2><div class="button-row"><a class="outline" href="/panel/editorial-qa.csv">دانلود CSV بررسی‌ها</a><a class="outline" href="/panel/catalog-drafts">صف تأیید قدیمی</a><a class="outline" href="/panel/cover-priority">صف تصاویر جلد</a></div><form method="get" action="/panel/editorial-qa" class="form-grid"><label>جست‌وجو<input name="q" maxlength="80" value="${attr(q)}" placeholder="نام کتاب یا شناسه"></label><label>وضعیت<select name="status">${tabs.map(([v,t])=>`<option value="${v}" ${v===filter?'selected':''}>${t}</option>`).join('')}</select></label><button class="cta">فیلتر</button></form><p>${digits(list.length)} مورد مطابق فیلتر</p><div class="catalog-quality-list">${cards||'<p>موردی ثبت نشده است.</p>'}</div><div class="button-row">${page>1?`<a class="outline" href="${attr(link(page-1))}">صفحه قبل</a>`:''}<span>${digits(page)} / ${digits(pages)}</span>${page<pages?`<a class="outline" href="${attr(link(page+1))}">صفحه بعد</a>`:''}</div></div>${detail}`,'کنترل تحریریه و منابع');
}
function panelCatalogQuality(user,url){if(user.role!=='owner')return null;
 const stats=catalogWorkflow.quality(db),filter=['all','author','description','cover','edition'].includes(url.searchParams.get('filter'))?url.searchParams.get('filter'):'all';
 const q=str(url.searchParams.get('q'),80),view=catalogWorkflow.issues(db,filter,q,url.searchParams.get('page'));
 const selectedId=safeId(url.searchParams.get('book'));
 const selected=selectedId?db.prepare('SELECT * FROM books WHERE id=?').get(selectedId):null;
 const currentDraft=selected?db.prepare('SELECT * FROM catalog_metadata_drafts WHERE book_id=?').get(selected.id):null;
 const statCards=[['تعداد آثار',stats.total],['نویسنده ناقص',stats.noAuthor],['معرفی ناقص',stats.noDescription],['جلد ثبت‌نشده',stats.noCover],['چاپ تأییدنشده',stats.noEdition],['پیشنهاد در صف',stats.pending]];
 const tabs=[['all','همه'],['author','نویسنده'],['description','معرفی'],['cover','جلد'],['edition','چاپ معتبر']];
 const form=`<div class="panel-note"><h2>تکمیل اطلاعات با مدرک و بررسی مدیر</h2><p class="muted">اطلاعات تازه ابتدا در صف بررسی می‌مانند؛ تا زمان تأیید، متن پیشنهادی در سایت عمومی نمایش داده نمی‌شود. ناشر، مترجم و شابک را فقط در بخش چاپ‌های مشخص ثبت کنید.</p><form class="inline-search" method="get" action="/panel/catalog-quality"><input name="book" inputmode="numeric" type="number" min="1" placeholder="شناسه کتاب" value="${selected?.id||''}"><button>انتخاب کتاب</button></form>${selected?`<h3>شناسه ${digits(selected.id)} · ${esc(selected.title)}</h3><p class="muted tiny">وضعیت: ${currentDraft?esc(currentDraft.status):'بدون پیشنهاد'} · <a href="/panel/books?edit=${selected.id}">ویرایش تکی اثر</a></p><form class="form-grid" method="post" action="/panel/catalog-draft">${csrfInput(user)}<input type="hidden" name="book_id" value="${selected.id}"><label>نویسنده (فقط در صورت نقص یا تأیید مجدد)<input name="author" maxlength="180" value="${attr(currentDraft?.status==='pending'?currentDraft.author:'')}" placeholder="نام معتبر نویسنده"></label><label>لینک منبع HTTPS<input name="source_url" maxlength="500" type="url" value="${attr(currentDraft?.status==='pending'?currentDraft.source_url:'')}" placeholder="https://..."></label><label class="full">معرفی اصیل، بدون کپی از ناشر (حداقل ۵۰ کاراکتر)<textarea name="description" maxlength="2500" rows="5">${esc(currentDraft?.status==='pending'?currentDraft.description:'')}</textarea></label><label class="full">یادداشت منبع یا روش بررسی<input name="source_note" maxlength="240" value="${attr(currentDraft?.status==='pending'?currentDraft.source_note:'')}" placeholder="مثلاً شناسنامه چاپ موجود در فروشگاه، بررسی شده در تاریخ ..."></label><button class="cta">ذخیره پیش‌نویس برای بررسی</button></form>`:'<p class="muted">برای ثبت پیشنهاد، شناسه کتاب را از جدول پایین انتخاب کن.</p>'}</div>`;
 const params=new URLSearchParams();if(q)params.set('q',q);if(filter!=='all')params.set('filter',filter);
 const href=i=>'/panel/catalog-quality?'+new URLSearchParams([...params,['page',String(i)]]).toString();
 return panelShell(user,`<div class="soft-warning">این گزارش، کیفیت و کامل‌بودن داده‌ها را می‌سنجد، نه صحت علمی آن‌ها را. فقط مشخصات مستند و تأییدشده منتشر کنید؛ اطلاعات فروشندگان و پرداخت تغییر نکرده است.</div><div class="quality-stats">${statCards.map(([label,value])=>`<div><strong>${digits(value)}</strong><span>${esc(label)}</span></div>`).join('')}</div><div class="panel-note"><h2>گزارش کنترل کیفیت بانک کتاب‌ها</h2><div class="button-row"><a class="outline" href="/panel/catalog-template.csv">دریافت CSV اطلاعات ناقص</a><a class="outline" href="/panel/catalog-drafts">صف بررسی و تأیید (${digits(stats.pending)})</a><a class="outline" href="/panel/catalog-import">ورود گروهی پیشنهادی</a></div><form class="filterbar" method="get" action="/panel/catalog-quality"><input name="q" value="${attr(q)}" placeholder="عنوان، نویسنده یا شناسه"><select name="filter">${tabs.map(([value,label])=>`<option value="${value}" ${filter===value?'selected':''}>${label}</option>`).join('')}</select><button class="cta">فیلتر</button></form><p>${digits(view.total)} عنوان در این فیلتر</p><div class="catalog-quality-list">${view.rows.map(b=>`<article class="catalog-quality-card"><div><b>${esc(b.title)}</b><small>شناسه ${digits(b.id)} · ${esc(b.category)}</small><div class="quality-tags">${!b.author.trim()?'<span>نویسنده ناقص</span>':''}${!b.description.trim()?'<span>معرفی ناقص</span>':''}${!b.has_cover?'<span>جلد ندارد</span>':''}${!b.has_edition?'<span>چاپ تأییدنشده</span>':''}${b.draft_status==='pending'?'<span>پیشنهاد در انتظار</span>':''}</div></div><div class="button-row"><a class="outline" href="/panel/catalog-quality?book=${b.id}#edit-metadata">تکمیل</a><a class="outline" href="/panel/covers?book=${b.id}">جلد</a><a class="outline" href="/panel/editions?book=${b.id}">چاپ</a></div></article>`).join('')||'<p>در این فیلتر موردی پیدا نشد.</p>'}</div><nav class="button-row">${view.page>1?`<a class="outline" href="${href(view.page-1)}">صفحه قبل</a>`:''}<span>صفحه ${digits(view.page)} از ${digits(view.pages)}</span>${view.page<view.pages?`<a class="outline" href="${href(view.page+1)}">صفحه بعد</a>`:''}</nav></div><div id="edit-metadata">${form}</div>`, 'کیفیت بانک کتاب');}
function panelCatalogDrafts(user,url){if(user.role!=='owner')return null;
 const status=['pending','approved','rejected'].includes(url.searchParams.get('status'))?url.searchParams.get('status'):'pending';
 const rows=db.prepare('SELECT d.*,b.title,b.author AS current_author,b.description AS current_description FROM catalog_metadata_drafts d JOIN books b ON b.id=d.book_id WHERE d.status=? ORDER BY d.submitted_at DESC,d.id DESC LIMIT 100').all(status);
 return panelShell(user,`<div class="panel-note"><h2>بررسی پیشنهادهای اطلاعات کتاب</h2><p>قبل از تأیید، منبع اطلاعات را بررسی کن. هیچ متنی بدون تصمیم مدیر به عنوان معرفی رسمی منتشر نمی‌شود. اصلاح داده‌های ثبت‌شده قبلی از این مسیر مجاز نیست.</p><nav class="review-tabs">${[['pending','در انتظار'],['approved','تأییدشده'],['rejected','ردشده']].map(([x,t])=>`<a class="${status===x?'selected':''}" href="/panel/catalog-drafts?status=${x}">${t}</a>`).join('')}</nav></div><div class="catalog-draft-list">${rows.map(d=>`<article class="panel-note"><h3>${esc(d.title)} <small>· شناسه ${digits(d.book_id)}</small></h3><div class="quality-tags"><span>${esc(d.status)}</span></div>${d.author?`<p><b>نام نویسنده پیشنهادی:</b> ${esc(d.author)}</p>`:''}${d.description?`<p><b>معرفی پیشنهادی:</b> ${esc(d.description)}</p>`:''}<p><b>منبع:</b> ${d.source_url?`<a href="${attr(d.source_url)}" rel="noopener noreferrer" target="_blank">لینک منبع ↗</a>`:''} ${esc(d.source_note||'')}</p>${d.status==='pending'?`<div class="button-row"><a class="cta" href="/panel/editorial-qa?draft=${d.id}#review-draft">ثبت بررسی مستند و تأیید</a><form method="post" action="/panel/catalog-moderate">${csrfInput(user)}<input type="hidden" name="draft_id" value="${d.id}"><input type="hidden" name="action" value="reject"><input name="reason" maxlength="240" required placeholder="علت رد"><button class="outline">رد پیشنهاد</button></form></div>`:`<p class="muted tiny">${d.status==='rejected'?'علت رد: '+esc(d.rejection_note):'پذیرفته‌شده'} · ${esc(d.reviewed_at||'')}</p>`}</article>`).join('')||'<div class="panel-note">در این وضعیت، پیشنهادی ثبت نشده است.</div>'}</div>`, 'صف بررسی محتوا');}
function panelCatalogImport(user){if(user.role!=='owner')return null;
 return panelShell(user,`<div class="panel-note"><h2>ورود گروهی اطلاعات برای بررسی</h2><p>این ورود گروهی، <b>کتاب جدید ایجاد نمی‌کند</b> و هیچ اطلاعاتی را مستقیم در سایت منتشر نمی‌کند. تنها فیلدهای خالی «نویسنده» و «معرفی» قابل پیشنهاد هستند. اگر حتی یک سطر نامعتبر باشد، کل درخواست رد می‌شود.</p><p>ابتدا <a href="/panel/catalog-template.csv">فایل CSV اطلاعات ناقص</a> را بگیر؛ ستون‌های ضروری <code>book_id,title,author,description,source_url,source_note</code> هستند. عنوان صرفاً برای راهنمایی است و شناسه کتاب برای تطبیق استفاده می‌شود. حداکثر ۱۰۰ ردیف در هر نوبت، ۱۸۰ کیلوبایت. برای هر ردیف منبع قابل بررسی لازم است.</p><form method="post" action="/panel/catalog-import" class="form-stack">${csrfInput(user)}<label>متن CSV (UTF-8)<textarea name="csv" rows="12" maxlength="180000" placeholder="book_id,title,author,description,source_url,source_note"></textarea></label><label class="check-row"><input name="confirm" value="1" type="checkbox" required> تأیید می‌کنم که رکوردها فقط در صف بررسی ذخیره شوند.</label><button class="cta">ثبت گروهی پیش‌نویس‌ها</button></form></div>`, 'ورود گروهی محتوا');}

function panelBooks(user,url){if(user.role!=='owner')return null;const id=Number(url.searchParams.get('edit'))||0;const editing=id?db.prepare('SELECT * FROM books WHERE id=?').get(id):null;const q=str(url.searchParams.get('q'),70);const books=db.prepare('SELECT * FROM books WHERE title LIKE ? OR author LIKE ? ORDER BY id DESC LIMIT 80').all('%'+q+'%','%'+q+'%');
return panelShell(user,`<div class="panel-note"><h2>${editing?'ویرایش مشخصات کتاب':'افزودن عنوان جدید'}</h2><form method="post" action="/panel/book" class="form-grid">${csrfInput(user)}<input name="id" type="hidden" value="${editing?.id||''}"><label>نام کتاب<input name="title" required maxlength="180" value="${attr(editing?.title||'')}"></label><label>نام نویسنده<input name="author" maxlength="180" value="${attr(editing?.author||'')}"></label><label>دسته‌بندی<input name="category" required maxlength="100" list="categories" value="${attr(editing?.category||'')}"></label><datalist id="categories">${categoryNames().map(c=>`<option value="${attr(c)}">`).join('')}</datalist><label>ناشر (در صورت تأیید)<input name="publisher" maxlength="160" value="${attr(editing?.publisher||'')}"></label><label>شابک (چاپ مشخص)<input name="isbn" maxlength="17" value="${attr(editing?.isbn||'')}"></label><label class="full">معرفی اختصاصی کتاب<textarea name="description" maxlength="4000">${esc(editing?.description||'')}</textarea></label><button class="cta">ذخیره مشخصات</button></form><p class="muted tiny">نکته: هر عنوان یک اثر است؛ برای ثبت چاپ‌ها و ترجمه‌های مستقل از بخش «چاپ‌ها و ترجمه‌ها» استفاده کن. شابک چاپ مشخص را در همان بخش ثبت کن.</p></div><form class="search inline-search" method="get" action="/panel/books"><input name="q" value="${attr(q)}" placeholder="جست‌وجوی کتاب…"><button>جست‌وجو</button></form><div class="table-scroll"><table class="data-table"><thead><tr><th>شناسه</th><th>عنوان</th><th>نویسنده</th><th>موضوع</th><th>عملیات</th></tr></thead><tbody>${books.map(b=>`<tr><td>${b.id}</td><td>${esc(b.title)}</td><td>${esc(b.author)}</td><td>${esc(b.category)}</td><td><a href="/panel/books?edit=${b.id}">ویرایش اثر</a> · <a href="/panel/editions?book=${b.id}">چاپ‌ها</a> · <a href="/panel/covers?book=${b.id}">جلد</a></td></tr>`).join('')}</tbody></table></div>`, 'بانک کتاب');}
function allowedStore(user,id){return readStore(user,id);}
function storeScope(user,url){
 const stores=user.role==='owner'?db.prepare('SELECT id,name FROM stores ORDER BY id').all():db.prepare('SELECT id,name FROM stores WHERE id=?').all(user.store_id);
 const sid=user.role==='owner'?(safeId(url.searchParams.get('store'))||stores[0]?.id):user.store_id;
 return {stores,storeId:stores.some(s=>s.id===sid)?sid:0};
}
function inventoryStoreSelect(user,stores,id,destination){
 return user.role==='owner'?`<label>فروشگاه<select name="store">${stores.map(s=>`<option value="${s.id}" ${s.id===id?'selected':''}>${esc(s.name)}</option>`).join('')}</select></label>`:'';
}
function panelMerchandising(user,url,preview=null){
 const {stores,storeId}=storeScope(user,url);
 if(!storeId||!managerOf(user,storeId))return null;
 const rows=db.prepare(`SELECT i.id,i.sku,i.price,i.quantity,i.active,b.title,f.headline,f.priority,f.enabled AS featured_enabled
 FROM stock_items i JOIN books b ON b.id=i.book_id LEFT JOIN store_featured_items f ON f.item_id=i.id
 WHERE i.store_id=? ORDER BY i.id DESC LIMIT 80`).all(storeId);
 const batches=db.prepare(`SELECT id,count,created_at FROM bulk_merch_batches WHERE store_id=? ORDER BY id DESC LIMIT 8`).all(storeId);
 const tops=merchandising.demoPopular(db,storeId);
 const sample=db.prepare('SELECT sku,price,quantity FROM stock_items WHERE store_id=? ORDER BY id LIMIT 1').get(storeId);
 const csvSample=sample?`sku,expected_price,new_price,expected_quantity,new_quantity\n${sample.sku},${sample.price},${sample.price},${sample.quantity},${sample.quantity}`:'sku,expected_price,new_price,expected_quantity,new_quantity';
 const previewHtml=preview?`<section class="panel-note"><h2>${preview.committed?'ثبت گروهی انجام شد':'پیش‌نمایش و بررسی گروهی'}</h2><div class="inventory-summary"><div><b>${digits(preview.rows?.length||0)}</b><span>ردیف معتبر</span></div><div><b>${digits(preview.errors?.length||0)}</b><span>خطا</span></div></div>${(preview.errors||[]).length?`<div class="error">${preview.errors.map(esc).join('<hr>')}</div>`:''}<div class="table-scroll"><table class="data-table"><thead><tr><th>SKU</th><th>کتاب</th><th>قیمت قبلی</th><th>قیمت جدید</th><th>موجودی قبلی</th><th>موجودی جدید</th></tr></thead><tbody>${(preview.rows||[]).map(x=>`<tr><td dir="ltr">${esc(x.sku)}</td><td>${esc(x.title)}</td><td>${money(x.expectedPrice)}</td><td>${money(x.newPrice)}</td><td>${digits(x.expectedQuantity)}</td><td>${digits(x.newQuantity)}</td></tr>`).join('')}</tbody></table></div>${preview.committed?`<p>شماره دسته: ${digits(preview.batchId)}. اطلاعات دفتر گردش و تاریخچه قیمت به‌روز شد.</p>`:'<p class="muted tiny">برای اعمال تغییرات، فایل CSV را در فرم پایین نگه دار و «ثبت قطعی» را انتخاب کن؛ در زمان ثبت، همه مقادیر قبلی دوباره بررسی می‌شوند.</p>'}</section>`:'';
 const featured=rows.map(i=>`<article class="merch-card"><div><b>${esc(i.title)}</b><small dir="ltr">${esc(i.sku)} · ${money(i.price)} · ${digits(i.quantity)} جلد</small></div><form action="/panel/featured-item" method="post" class="merch-form">${csrfInput(user)}<input type="hidden" name="store_id" value="${storeId}"><input type="hidden" name="item_id" value="${i.id}"><label>عنوان کوتاه<input name="headline" maxlength="80" value="${attr(i.headline||'')}" placeholder="انتخاب فروشگاه"></label><label>اولویت<input type="number" min="0" max="99" name="priority" value="${i.priority??50}"></label><label class="checkbox-line"><input type="checkbox" name="enabled" value="1" ${i.featured_enabled?'checked':''}> نمایش در ویترین</label><button class="outline">ذخیره</button></form></article>`).join('');
 return panelShell(user,`${previewHtml}<div class="panel-note"><h2>ویرایش گروهی قیمت و موجودی</h2><p>برای هر SKU قیمت و موجودی فعلی را در فایل CSV بنویس. اگر حتی یک ردیف ناسازگار، تکراری یا متعلق به فروشگاه دیگر باشد، <b>هیچ تغییری ذخیره نمی‌شود</b>. تمام اختلاف‌های موجودی در دفتر گردش ثبت می‌شوند.</p><div class="button-row"><a class="outline" href="/panel/merchandising-template.csv?store=${storeId}">دریافت CSV موجودی همین فروشگاه</a><a class="outline" href="/panel/inventory?store=${storeId}">بازگشت به انبار</a></div><p class="muted tiny">قالب: <code>sku,expected_price,new_price,expected_quantity,new_quantity</code> · تومان و تعداد صحیح · حداکثر ۱۰۰ ردیف. برای هر ردیف دست‌کم قیمت یا موجودی باید تغییر کند؛ ردیف‌های بدون تغییر را حذف کن.</p><form method="post" action="/panel/merchandising" class="form-stack">${csrfInput(user)}<input type="hidden" name="store_id" value="${storeId}"><label>CSV با کدگذاری UTF-8<textarea name="csv" rows="9" maxlength="120000" dir="ltr" required spellcheck="false" placeholder="${attr(csvSample)}">${esc(preview?.csv||'')}</textarea></label><label>علت اصلاح گروهی<input name="note" minlength="5" maxlength="180" required value="${attr(preview?.note||'')}" placeholder="مثلاً بازنگری قیمت تأمین‌کننده و شمارش مجدد"></label><label class="checkbox-line"><input type="checkbox" name="confirm" value="1"> بررسی کرده‌ام که این اصلاحات فقط برای فروشگاه منتخب هستند.</label><div class="button-row"><button class="outline" name="mode" value="preview">پیش‌نمایش بدون تغییر اطلاعات</button><button class="cta" name="mode" value="commit">ثبت قطعی گروهی</button></div></form></div>
 <div class="panel-note"><h2>پیشنهادهای ویژه فروشگاه</h2><p>هر کتاب‌فروشی می‌تواند حداکثر ۸ SKU را برای نمایش بالای صفحه خودش انتخاب کند. فقط کتاب‌های فعال، دارای موجودی و چاپ تأییدشده عمومی نمایش داده می‌شوند.</p><div class="merch-grid">${featured||'<p>ابتدا SKU ثبت کن.</p>'}</div></div>
 <div class="panel-note"><h2>کتاب‌های پرتکرار در درخواست‌های آزمایشی</h2><p class="soft-warning">این آمار از سفارش‌های DEMO (به‌جز لغوشده‌ها) محاسبه شده و <b>پرفروش واقعی نیست</b>.</p><div class="table-scroll"><table class="data-table"><thead><tr><th>کتاب</th><th>SKU</th><th>تعداد درخواست نمونه</th><th>تعداد جلد نمونه</th></tr></thead><tbody>${tops.map(x=>`<tr><td>${esc(x.book_title)}</td><td dir="ltr">${esc(x.sku)}</td><td>${digits(x.orders)}</td><td>${digits(x.quantity)}</td></tr>`).join('')||'<tr><td colspan="4">سفارش آزمایشی وجود ندارد.</td></tr>'}</tbody></table></div></div>
 <div class="panel-note"><h2>سوابق ویرایش گروهی</h2><div class="table-scroll"><table class="data-table"><thead><tr><th>شماره دسته</th><th>تعداد تغییر</th><th>زمان</th></tr></thead><tbody>${batches.map(x=>`<tr><td>${digits(x.id)}</td><td>${digits(x.count)}</td><td>${esc(x.created_at)} UTC</td></tr>`).join('')||'<tr><td colspan="3">هنوز تغییر گروهی انجام نشده است.</td></tr>'}</tbody></table></div></div>`, 'مدیریت گروهی و ویترین');
}
function panelInventory(user,url){
 const {stores,storeId}=storeScope(user,url);
 if(!storeId)return panelShell(user,'<div class="empty">فروشگاهی وجود ندارد یا مجاز نیست.</div>','انبار و SKU');
 const q=str(url.searchParams.get('q'),80),low=url.searchParams.get('low')==='1';
 const total=db.prepare('SELECT COUNT(*) n FROM stock_items WHERE store_id=?').get(storeId).n;
 const alerts=db.prepare('SELECT COUNT(*) n FROM stock_items WHERE store_id=? AND active=1 AND quantity<=min_quantity').get(storeId).n;
 const sum=db.prepare('SELECT COALESCE(SUM(quantity),0) n FROM stock_items WHERE store_id=?').get(storeId).n;
 const rows=db.prepare(`SELECT i.*,b.title,b.author,e.label edition_label,e.translator,e.isbn, e.verified
   FROM stock_items i JOIN books b ON b.id=i.book_id LEFT JOIN editions e ON e.id=i.edition_id
   WHERE i.store_id=? AND (b.title LIKE ? OR i.sku LIKE ? OR e.isbn LIKE ?)
   ${low?'AND i.active=1 AND i.quantity<=i.min_quantity':''}
   ORDER BY CASE WHEN i.active=1 AND i.quantity<=i.min_quantity THEN 0 ELSE 1 END,i.updated_at DESC,i.id DESC LIMIT 100`).all(storeId,...Array(3).fill('%'+q+'%'));
 const mobileCards=rows.map(i=>`<article class="stock-mobile-card"><div class="stock-mobile-heading"><b>${esc(i.title)}</b><span class="${i.active&&i.quantity<=i.min_quantity?'stock-warning':i.active?'stock-ok':''}">${!i.active?'غیرفعال':i.quantity<=i.min_quantity?'⚠️ کمبود':'فعال'}</span></div><p>${i.edition_id?esc(i.edition_label||'چاپ '+i.edition_id):'چاپ نامشخص — موجودی قدیمی'}</p><dl><div><dt>SKU</dt><dd dir="ltr">${esc(i.sku)}</dd></div><div><dt>قیمت</dt><dd>${money(i.price)}</dd></div><div><dt>موجودی</dt><dd>${digits(i.quantity)} جلد</dd></div><div><dt>حد هشدار</dt><dd>${digits(i.min_quantity)}</dd></div></dl><div class="stock-actions"><a href="/panel/stock-item?store=${storeId}&item=${i.id}">ویرایش و ثبت ورود/خروج</a><a href="/panel/stock-ledger?store=${storeId}&item=${i.id}">گردش</a></div></article>`).join('');
 return panelShell(user,`<div class="panel-note"><h2>انبار فروشگاه</h2><p>هر چاپ یا ترجمه دارای SKU، قیمت، موجودی و حد هشدار جداگانه است. ورود و خروج فقط از طریق دفتر گردش ثبت می‌شود. پرداخت و سفارش آنلاین همچنان غیرفعال‌اند.</p>${storeRole(user)==='viewer'?'<div class="soft-warning">حساب شما فقط مجوز مشاهده دارد.</div>':''}<div class="inventory-summary"><div><b>${digits(total)}</b><span>ردیف SKU</span></div><div><b>${digits(sum)}</b><span>جلد موجود در انبار</span></div><div><b>${digits(alerts)}</b><span>هشدار کمبود</span></div></div><div class="button-row">${storeRole(user)!=='viewer'?`<a class="cta" href="/panel/stock-item?store=${storeId}">افزودن SKU برای چاپ مشخص</a>`:''}<a class="outline" href="/panel/stock-ledger?store=${storeId}">گزارش گردش موجودی</a>${managerOf(user,storeId)?`<a class="outline" href="/panel/merchandising?store=${storeId}">ویرایش گروهی قیمت و موجودی</a>`:''}</div></div>
 <form action="/panel/inventory" method="get" class="inventory-filter">${inventoryStoreSelect(user,stores,storeId)}<label>نام کتاب، SKU یا شابک<input name="q" value="${attr(q)}" placeholder="جست‌وجوی موجودی"></label><label class="checkbox-line"><input type="checkbox" name="low" value="1" ${low?'checked':''}> فقط کمبودها</label><button class="cta">اعمال فیلتر</button></form>
 <div class="stock-desktop-table table-scroll"><table class="data-table stock-table"><thead><tr><th>عنوان و چاپ</th><th>SKU</th><th>قیمت</th><th>موجودی</th><th>حد هشدار</th><th>وضعیت</th><th>عملیات</th></tr></thead><tbody>${rows.map(i=>`<tr><td><b>${esc(i.title)}</b><small>${i.edition_id?esc(i.edition_label||'چاپ شماره '+i.edition_id)+(i.translator?' · '+esc(i.translator):''):'چاپ نامشخص — مهاجرت از نسخه قدیمی'}${i.edition_id&&!i.verified?' · اطلاعات چاپ تأییدنشده':''}</small></td><td dir="ltr">${esc(i.sku)}</td><td>${money(i.price)}</td><td><b>${digits(i.quantity)}</b></td><td>${digits(i.min_quantity)}</td><td>${i.active?(i.quantity<=i.min_quantity?'<span class="stock-warning">⚠️ کمبود</span>':'<span class="stock-ok">فعال</span>'):'غیرفعال'}</td><td><div class="stock-actions"><a href="/panel/stock-item?store=${storeId}&item=${i.id}">جزئیات</a><a href="/panel/stock-ledger?store=${storeId}&item=${i.id}">گردش</a></div></td></tr>`).join('')||'<tr><td colspan="7">هنوز SKU ثبت نشده؛ چاپ را در پنل YM ثبت کن و سپس SKU بساز.</td></tr>'}</tbody></table></div><div class="stock-mobile-list">${mobileCards||'<div class="empty">هنوز موجودی ثبت نشده است.</div>'}</div>
 <div class="soft-warning">موجودی‌های نسخه 0.5 با شناسه LEG منتقل شده‌اند؛ چاپشان هنوز مشخص نیست. برای فروش واقعی باید نسخه فیزیکی هر ردیف بررسی و SKU مشخص ثبت شود.</div>`, 'انبار و SKU');
}
function panelDiscounts(user,url){
 const {stores,storeId}=storeScope(user,url);
 if(!storeId||!managerOf(user,storeId))return null;
 const search=str(url.searchParams.get('q'),80),onlyActive=url.searchParams.get('active')==='1';
 const rows=db.prepare(`SELECT i.id,i.sku,i.price,i.quantity,i.active AS item_active,b.title,e.label AS edition_label,
   d.percent,d.enabled,d.starts_at,d.ends_at,h.changed_at AS last_change
 FROM stock_items i JOIN books b ON b.id=i.book_id LEFT JOIN editions e ON e.id=i.edition_id
 LEFT JOIN stock_discounts d ON d.item_id=i.id
 LEFT JOIN (SELECT item_id,MAX(changed_at) AS changed_at FROM stock_price_history GROUP BY item_id) h ON h.item_id=i.id
 WHERE i.store_id=? AND (b.title LIKE ? OR i.sku LIKE ?) ${onlyActive?'AND i.active=1':''}
 ORDER BY i.updated_at DESC,i.id DESC LIMIT 100`).all(storeId,'%'+search+'%','%'+search+'%');
 const historyRows=db.prepare('SELECT item_id,old_price,new_price,changed_at FROM stock_price_history WHERE store_id=? ORDER BY id DESC LIMIT 400').all(storeId);
 const histories=new Map();for(const event of historyRows){if(!histories.has(event.item_id))histories.set(event.item_id,[]);if(histories.get(event.item_id).length<6)histories.get(event.item_id).push(event);}
 const table=rows.map(item=>{const current=promotions.priceFor(db,item.id,item.price);const changes=histories.get(item.id)||[];
 return `<article class="varaq-discount-card"><div class="varaq-discount-heading"><div><h3>${esc(item.title)}</h3><p>${esc(item.edition_label||'چاپ قدیمی نامشخص')} · SKU: <span dir="ltr">${esc(item.sku)}</span></p></div><span class="${current.discountPercent?'varaq-sale-badge':'muted'}">${current.discountPercent?digits(current.discountPercent)+'٪ فعال':'بدون تخفیف فعال'}</span></div>
 <div class="varaq-discount-prices"><div><small>قیمت پایه</small><b>${money(item.price)}</b></div><div><small>قیمت نمایشی فعلی</small><b>${money(current.price)}</b></div><div><small>موجودی</small><b>${digits(item.quantity)} جلد</b></div></div>
 <form method="post" action="/panel/discount" class="form-grid varaq-discount-form">${csrfInput(user)}<input type="hidden" name="store_id" value="${storeId}"><input type="hidden" name="item_id" value="${item.id}"><label>درصد تخفیف (۱ تا ۷۰)<input type="number" name="percent" min="1" max="70" step="1" required value="${item.percent??10}"></label><label>شروع UTC (اختیاری)<input name="starts_at" dir="ltr" placeholder="2026-11-01T08:00:00.000Z" value="${attr(item.starts_at||'')}" maxlength="24"></label><label>پایان UTC (اختیاری)<input name="ends_at" dir="ltr" placeholder="2026-11-10T20:00:00.000Z" value="${attr(item.ends_at||'')}" maxlength="24"></label><label class="checkbox-line"><input type="checkbox" name="enabled" value="1" ${item.enabled?'checked':''}> تخفیف فعال باشد</label><button class="cta" type="submit">ذخیره تنظیمات تخفیف</button></form>${changes.length?`<details class="varaq-price-timeline"><summary>تاریخچه تغییر قیمت پایه (${digits(changes.length)} مورد اخیر)</summary><ul>${changes.map(ev=>`<li>${esc(ev.changed_at)} UTC · ${money(ev.old_price)} ← ${money(ev.new_price)}</li>`).join('')}</ul></details>`:''}</article>`;}).join('');
 return panelShell(user,`<div class="panel-note"><h2>قیمت‌گذاری و تخفیف SKU</h2><p>تخفیف روی همان چاپ و همان فروشگاه تعریف می‌شود و قیمت پایه تغییر نمی‌کند. قیمت نهایی توسط سرور حساب می‌شود؛ سفارش‌ها فقط آزمایشی‌اند.</p><p class="soft-warning">زمان‌های اختیاری را به قالب ISO و منطقه UTC وارد کن. خالی‌گذاشتن زمان یعنی بدون محدودیت از آن طرف. درصد تخفیف حداکثر ۷۰٪ است.</p></div>
 <form method="get" action="/panel/discounts" class="inventory-filter">${inventoryStoreSelect(user,stores,storeId)}<label>کتاب یا SKU<input name="q" value="${attr(search)}" placeholder="جست‌وجو"></label><label class="checkbox-line"><input type="checkbox" name="active" value="1" ${onlyActive?'checked':''}> فقط کالاهای فعال</label><button class="outline">جست‌وجو</button></form>
 <div class="varaq-discount-list">${table||'<div class="empty">SKU ثبت نشده است. ابتدا موجودی فروشگاه را ثبت کن.</div>'}</div>
 <p class="muted tiny">قیمت‌های قبلی هر SKU در جدول تاریخچه نگهداری می‌شوند. این تنظیمات به‌تنهایی فروش، تسویه یا درگاه واقعی فعال نمی‌کنند.</p>`, 'تخفیف و قیمت‌گذاری');
}
function panelStockItem(user,url){
 const {stores,storeId}=storeScope(user,url);if(!storeId)return null;
 const id=safeId(url.searchParams.get('item'));
 const item=id?db.prepare('SELECT i.*,b.title,e.label edition_label FROM stock_items i JOIN books b ON b.id=i.book_id LEFT JOIN editions e ON e.id=i.edition_id WHERE i.id=? AND i.store_id=?').get(id,storeId):null;
 if(id&&!item)return null;
 const editions=db.prepare('SELECT e.id,e.label,e.translator,e.isbn,e.verified,b.title,b.id book_id FROM editions e JOIN books b ON b.id=e.book_id ORDER BY b.title,e.id DESC LIMIT 1500').all();
 const canWrite=writeInventory(user,storeId);
 const movements=item?db.prepare('SELECT m.*,u.username FROM stock_movements m LEFT JOIN users u ON u.id=m.actor_id WHERE m.item_id=? AND m.store_id=? ORDER BY m.id DESC LIMIT 12').all(item.id,storeId):[];
 const stockForm=`${canWrite?`<div class="panel-note"><h2>${item?'ویرایش اطلاعات SKU':'SKU جدید برای چاپ مشخص'}</h2><form method="post" action="/panel/stock-item" class="form-grid">${csrfInput(user)}<input type="hidden" name="store_id" value="${storeId}"><input type="hidden" name="id" value="${item?.id||''}">${item?`<input type="hidden" name="book_id" value="${item.book_id}"><input type="hidden" name="edition_id" value="${item.edition_id??''}"><div class="full"><b>${esc(item.title)}</b><p>چاپ: ${esc(item.edition_label||'نامشخص (مانده قدیمی)')} · موجودی فعلی: ${digits(item.quantity)}</p></div>`:`<label class="full">کتاب و چاپ مشخص<select name="edition_id" required><option value="">انتخاب چاپ ثبت‌شده</option>${editions.map(e=>`<option value="${e.id}">${esc(e.title)} — ${esc(e.label||e.isbn||'چاپ شماره '+e.id)}${e.verified?'':' (تأییدنشده)'}</option>`).join('')}</select></label><p class="muted tiny full">اگر چاپ کتاب در فهرست نیست، مدیر YM ابتدا باید آن را در «چاپ‌ها و ترجمه‌ها» ثبت کند.</p>`}<label>شناسه SKU (انگلیسی)<input dir="ltr" name="sku" required maxlength="64" minlength="3" pattern="[A-Za-z0-9][A-Za-z0-9._-]{2,63}" value="${attr(item?.sku||'')}"></label><label>قیمت (تومان)<input type="number" name="price" min="0" max="1000000000" step="1" required value="${item?.price??0}"></label><label>حد هشدار کمبود<input type="number" name="min_quantity" min="0" max="1000000" step="1" required value="${item?.min_quantity??2}"></label><label class="checkbox-line"><input type="checkbox" name="active" value="1" ${item?.active?'checked':''}> فعال برای نمایش (تنها با موجودی مثبت و چاپ تأییدشده نمایش داده می‌شود)</label><button class="cta">ذخیره SKU و قیمت</button></form></div>`:''}`;
 const moveForm=item&&canWrite?`<div class="panel-note"><h2>ورود و خروج موجودی</h2><p>موجودی فعلی: <b>${digits(item.quantity)} جلد</b>. اعداد مثبت برای ورود و منفی برای خروج هستند؛ تمام تغییرات در دفتر گردش ثبت می‌شوند.</p><form class="form-grid" method="post" action="/panel/stock-move">${csrfInput(user)}<input type="hidden" name="store_id" value="${storeId}"><input type="hidden" name="item_id" value="${item.id}"><label>علت تغییر<select name="reason">${Object.entries(stock.REASONS).map(([value,label])=>`<option value="${value}">${label}</option>`).join('')}</select></label><label>تعداد تغییر (مثلاً ۵ یا ‎-۲)<input type="number" name="delta" required min="-100000" max="100000" step="1" placeholder="5"></label><label class="full">توضیحات (برای اصلاح شمارش الزامی)<textarea name="note" maxlength="300" placeholder="شماره رسید تأمین‌کننده، دلیل خروج یا اصلاح…"></textarea></label><button class="cta">ثبت گردش انبار</button></form></div>`:'';
 return panelShell(user,`<div class="button-row"><a class="outline" href="/panel/inventory?store=${storeId}">← بازگشت به انبار</a></div>${stockForm}${moveForm}${item?`<h2 class="block-title">آخرین گردش‌های این SKU</h2><div class="table-scroll"><table class="data-table"><thead><tr><th>تاریخ</th><th>علت</th><th>تغییر</th><th>قبل</th><th>بعد</th><th>کاربر</th></tr></thead><tbody>${movements.map(m=>`<tr><td>${esc(m.created_at)}</td><td>${esc(stock.REASONS[m.reason]||'مانده افتتاحیه')}</td><td dir="ltr">${m.delta>0?'+':''}${m.delta}</td><td>${digits(m.before_quantity)}</td><td>${digits(m.after_quantity)}</td><td>${esc(m.username||'مهاجرت سیستم')}</td></tr>`).join('')||'<tr><td colspan="6">هنوز گردشی ثبت نشده است.</td></tr>'}</tbody></table></div>`:''}`,'SKU و گردش موجودی');
}
function stockLedgerRecords(storeId,itemId,limit=200){return db.prepare(`SELECT m.*,i.sku,b.title,e.label edition_label,u.username FROM stock_movements m JOIN stock_items i ON i.id=m.item_id JOIN books b ON b.id=i.book_id LEFT JOIN editions e ON e.id=i.edition_id LEFT JOIN users u ON u.id=m.actor_id WHERE m.store_id=? ${itemId?'AND m.item_id=?':''} ORDER BY m.id DESC LIMIT ?`).all(...(itemId?[storeId,itemId,limit]:[storeId,limit]));}
function panelStockLedger(user,url){const {stores,storeId}=storeScope(user,url);if(!storeId)return null;const id=safeId(url.searchParams.get('item'));if(id&&!db.prepare('SELECT id FROM stock_items WHERE id=? AND store_id=?').get(id,storeId))return null;const rows=stockLedgerRecords(storeId,id);
return panelShell(user,`<div class="panel-note"><h2>دفتر گردش انبار</h2><p>گزارش ۲۰۰ گردش آخر با تعداد قبل و بعد، علت، کاربر و توضیح ثبت‌شده. تغییرات موجودی از طریق همین دفتر قابل پیگیری هستند.</p><div class="button-row"><a class="outline" href="/panel/inventory?store=${storeId}">بازگشت به موجودی</a><a class="cta" href="/panel/stock-ledger.csv?store=${storeId}${id?'&item='+id:''}">خروجی CSV همین گزارش</a></div>${user.role==='owner'?`<form action="/panel/stock-ledger" method="get" class="inventory-filter">${inventoryStoreSelect(user,stores,storeId)}<button class="outline">نمایش</button></form>`:''}</div><div class="table-scroll"><table class="data-table stock-table"><thead><tr><th>تاریخ</th><th>کتاب و چاپ</th><th>SKU</th><th>علت</th><th>تغییر</th><th>قبل/بعد</th><th>توضیح</th><th>کاربر</th></tr></thead><tbody>${rows.map(m=>`<tr><td>${esc(m.created_at)}</td><td>${esc(m.title)}<small>${esc(m.edition_label||'چاپ نامشخص')}</small></td><td dir="ltr">${esc(m.sku)}</td><td>${esc(stock.REASONS[m.reason]||'مانده افتتاحیه')}</td><td dir="ltr">${m.delta>0?'+':''}${m.delta}</td><td>${digits(m.before_quantity)} ← ${digits(m.after_quantity)}</td><td>${esc(m.note||'—')}</td><td>${esc(m.username||'سیستم')}</td></tr>`).join('')||'<tr><td colspan="8">هنوز گردشی وجود ندارد.</td></tr>'}</tbody></table></div>`,'گردش انبار');}
function ledgerCsv(rows){
 const clean=value=>{let text=String(value??'');if(/^[=+@\-\t\r]/.test(text))text="'"+text;return '"'+text.replace(/"/g,'""')+'"';};
 const headers=['شناسه','تاریخ','عنوان کتاب','چاپ','SKU','علت','تعداد تغییر','موجودی قبل','موجودی بعد','توضیحات','کاربر'];
 return '\uFEFF'+[headers,...rows.map(m=>[m.id,m.created_at,m.title,m.edition_label||'',m.sku,stock.REASONS[m.reason]||'مانده افتتاحیه',m.delta,m.before_quantity,m.after_quantity,m.note,m.username||'سیستم'])].map(a=>a.map(clean).join(',')).join('\r\n');
}

function panelUsers(user){if(user.role!=='owner')return null;const stores=db.prepare('SELECT id,name FROM stores ORDER BY id').all();const users=db.prepare('SELECT u.id,u.username,u.role,u.enabled,u.staff_permission,s.name store_name FROM users u LEFT JOIN stores s ON s.id=u.store_id ORDER BY u.id').all();return panelShell(user,`<div class="panel-note"><h2>ساخت حساب فروشنده</h2><form method="post" action="/panel/user" class="form-grid">${csrfInput(user)}<label>نام کاربری<input required name="username" minlength="3" maxlength="50" placeholder="seller1"></label><label>رمز عبور (حداقل ۱۲ کاراکتر)<input required name="password" type="password" minlength="12" autocomplete="new-password"></label><label>فروشگاه<select required name="store_id">${stores.map(s=>`<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select></label><button class="cta">ساخت حساب</button></form><p class="muted tiny">مدیر مرکزی دسترسی همه فروشگاه‌ها را دارد؛ هر فروشنده تنها موجودی و مشخصات فروشگاه متصل به حساب خودش را می‌بیند.</p></div><h2 class="block-title">کاربران موجود</h2><div class="table-scroll"><table class="data-table"><tr><th>کاربری</th><th>نقش</th><th>فروشگاه</th><th>وضعیت</th><th>عملیات</th></tr>${users.map(u=>`<tr><td>${esc(u.username)}</td><td>${u.role==='owner'?'مدیر YM':u.staff_permission==='manager'?'مدیر فروشگاه':u.staff_permission==='inventory'?'کارمند موجودی':'مشاهده‌گر'}</td><td>${esc(u.store_name||'—')}</td><td>${u.enabled?'فعال':'غیرفعال'}</td><td>${u.role==='owner'?'—':`<form method="post" action="/panel/user-status">${csrfInput(user)}<input type="hidden" name="id" value="${u.id}"><input type="hidden" name="enabled" value="${u.enabled?'0':'1'}"><button class="save-mini">${u.enabled?'مسدودسازی':'فعال‌سازی'}</button></form>`}</td></tr>`).join('')}</table></div>`, 'حساب‌های فروشندگان');}
function panelStoreProfile(user){if(user.role==='owner'||storeRole(user)!=='manager')return null;const s=db.prepare('SELECT * FROM stores WHERE id=?').get(user.store_id);if(!s)return null;return panelShell(user,`<div class="panel-note"><h2>مشخصات فروشگاه</h2><p>وضعیت فعال یا غیرفعال بودن فروشگاه تنها توسط مدیریت مرکزی تعیین می‌شود.</p><form action="/panel/store-profile" method="post" class="form-grid">${csrfInput(user)}<label>نام فروشگاه<input name="name" required maxlength="100" value="${attr(s.name)}"></label><label>شهر<input name="city" maxlength="80" value="${attr(s.city)}"></label><label>تلفن عمومی<input name="phone" maxlength="40" value="${attr(s.phone)}"></label><label class="full">درباره فروشگاه<textarea name="about" maxlength="500">${esc(s.about)}</textarea></label><button class="cta">ذخیره تغییرات</button></form></div>`, 'مشخصات فروشگاه');}
function panelStoreDocs(user,url){
 const storeId=user.role==='owner'?safeId(url.searchParams.get('store'))||db.prepare('SELECT id FROM stores ORDER BY id LIMIT 1').get()?.id:user.store_id;
 if(!storeId||!managerOf(user,storeId))return null;
 const store=db.prepare('SELECT * FROM stores WHERE id=?').get(storeId);if(!store)return null;
 const docs=db.prepare('SELECT id,kind,original_name,created_at FROM store_documents WHERE store_id=? ORDER BY id DESC').all(storeId);
 const owners=user.role==='owner'?db.prepare('SELECT id,name FROM stores ORDER BY id').all():[];
 const notes=store.review_note?`<p class="soft-warning">توضیح بررسی: ${esc(store.review_note)}</p>`:'';
 return panelShell(user,`<div class="panel-note"><h2>وضعیت پرونده: ${esc(REVIEW_LABELS[store.review_status]||'بررسی نشده')}</h2><p>فروشگاه: <b>${esc(store.name)}</b> · شناسه: ${store.id} · نمایش عمومی: ${store.active?'فعال':'غیرفعال'}</p>${notes}<p class="muted tiny">این وضعیت فقط بررسی داخلی YM است و تأیید دولتی، اینماد یا مجوز درگاه پرداخت محسوب نمی‌شود.</p>${owners.length?`<form method="get" action="/panel/store-docs" class="inventory-filter"><label>فروشگاه<select name="store">${owners.map(x=>`<option value="${x.id}" ${x.id===storeId?'selected':''}>${esc(x.name)}</option>`).join('')}</select></label><button class="outline">نمایش</button></form>`:''}</div>
 <div class="panel-note"><h2>ثبت مدرک برای بررسی خصوصی</h2><p class="muted tiny">فقط مدارکی را که واقعاً لازم هستند با رضایت مالک بارگذاری کنید؛ اطلاعات هویتی دیگران را منتشر نکنید. فایل‌ها عمومی نیستند.</p><form method="post" action="/panel/store-doc-upload" enctype="multipart/form-data" class="form-grid">${csrfInput(user)}<input type="hidden" name="store_id" value="${storeId}"><label>نوع مدرک<select name="kind">${Object.entries(DOC_KINDS).map(([v,t])=>`<option value="${v}">${t}</option>`).join('')}</select></label><label>فایل PNG/JPG/PDF حداکثر ۷۰۰ کیلوبایت<input type="file" name="document" accept=".png,.jpg,.jpeg,.pdf" required></label><label class="checkbox-line full"><input type="checkbox" name="consent" value="1" required> اجازه مالک مدرک برای نگهداری خصوصی و بررسی آن را دارم</label><button class="cta">بارگذاری خصوصی</button></form></div>
 <div class="panel-note"><h2>مدارک بارگذاری‌شده</h2>${docs.length?`<div class="table-scroll"><table class="data-table"><tr><th>نوع</th><th>نام فایل</th><th>تاریخ</th><th>دریافت</th></tr>${docs.map(d=>`<tr><td>${esc(kindLabel(d.kind))}</td><td>${esc(d.original_name)}</td><td>${esc(d.created_at)}</td><td><a href="/panel/store-doc-download/${d.id}">دانلود خصوصی</a></td></tr>`).join('')}</table></div>`:'<p>هنوز مدرکی ارسال نشده است.</p>'}</div>
 ${user.role==='owner'?`<div class="panel-note"><h2>بررسی و تأیید توسط YM</h2><p>قبل از تأیید، صحت و اعتبار پروانه کسب و مطابقت مدارک را خارج از سامانه استعلام کن؛ این سامانه استعلام خودکار مجوز ندارد.</p><form method="post" action="/panel/store-review" class="form-grid">${csrfInput(user)}<input type="hidden" name="store_id" value="${storeId}"><label>نتیجه بررسی<select name="status"><option value="submitted">در انتظار بررسی</option><option value="approved">تأیید داخلی مدارک</option><option value="rejected">نیازمند اصلاح</option><option value="unverified">بررسی نشده</option></select></label><label class="full">توضیح نتیجه<textarea name="review_note" maxlength="500">${esc(store.review_note)}</textarea></label><label class="checkbox-line full"><input name="verified_manually" type="checkbox" value="1"> تأیید می‌کنم اصالت و اعتبار پروانه کسب را به‌صورت مستقل بررسی کرده‌ام (برای وضعیت تأیید الزامی)</label><button class="cta">ثبت نتیجه بررسی</button></form></div>`:`<div class="panel-note"><h2>ارسال پرونده برای بررسی YM</h2><form method="post" action="/panel/store-submit">${csrfInput(user)}<input type="hidden" name="store_id" value="${storeId}"><button class="cta">ارسال درخواست بررسی</button></form></div>`}`,'مدارک و تأیید فروشگاه');
}
function panelStaff(user){if(user.role!=='seller'||storeRole(user)!=='manager')return null;
 const members=db.prepare("SELECT id,username,enabled,staff_permission FROM users WHERE store_id=? AND role='seller' ORDER BY id DESC").all(user.store_id);
 return panelShell(user,`<div class="panel-note"><h2>ساخت حساب کارمند</h2><p>کارمند فقط در فروشگاه شما فعالیت می‌کند و در اولین ورود مجبور به تغییر رمز است.</p><form method="post" action="/panel/staff" class="form-grid">${csrfInput(user)}<label>نام کاربری<input name="username" required pattern="[A-Za-z0-9._-]{3,50}" maxlength="50"></label><label>رمز موقت (حداقل ۱۲ کاراکتر)<input name="password" type="password" minlength="12" maxlength="128" required autocomplete="new-password"></label><label>سطح دسترسی<select name="permission"><option value="inventory">مدیریت موجودی و قیمت</option><option value="viewer">فقط مشاهده</option></select></label><button class="cta">افزودن کارمند</button></form></div><h2 class="block-title">حساب‌های فروشگاه</h2><div class="table-scroll"><table class="data-table"><tr><th>نام کاربری</th><th>اختیار</th><th>وضعیت</th><th>عملیات</th></tr>${members.map(m=>`<tr><td>${esc(m.username)}${m.id===user.id?' (شما)':''}</td><td>${m.staff_permission==='manager'?'مدیر فروشگاه':m.staff_permission==='inventory'?'مدیریت موجودی':'فقط مشاهده'}</td><td>${m.enabled?'فعال':'غیرفعال'}</td><td>${m.staff_permission==='manager'?'—':`<form method="post" action="/panel/staff-status">${csrfInput(user)}<input type="hidden" name="id" value="${m.id}"><input type="hidden" name="enabled" value="${m.enabled?'0':'1'}"><button class="save-mini">${m.enabled?'غیرفعال کن':'فعال کن'}</button></form>`}</td></tr>`).join('')}</table></div>`,'کارکنان فروشگاه');
}
function panelSettings(user){if(user.role!=='owner')return null;return panelShell(user,`<div class="panel-note"><h2>وضعیت پرداخت: غیرفعال 🔒</h2><p>در ۵.۰ پرونده پذیرندگی مستقل هر کتاب‌فروشی و دفتر ثبت درخواست پرداخت آماده شده است، اما درگاه بانکی و اتصال سرور به استعلام رسمی تراکنش وجود ندارد. هیچ پرداختی دریافت نمی‌شود.</p><p><a class="cta" href="/panel/payment-readiness">بررسی پرونده پذیرندگی و تراکنش‌ها</a></p><div class="soft-warning">رمز، توکن درگاه، اطلاعات کارت یا کلید خصوصی را در پنل وارد نکنید.</div></div>`, 'تنظیمات پرداخت');}
function panelReleaseReadiness(user){
 if(user?.role!=='owner')return null;
 const r=releaseAudit.assess({db,dataDir:DATA_DIR});
 const m=r.metrics;
 const cards=[['تعداد کتاب‌ها',m.books],['دارای حداقل سئو',m.seoCandidates],['فاقد نویسنده',m.missingAuthor],['معرفی ناقص',m.missingIntro],['فاقد جلد قابل انتشار',m.missingCover],['تعارض مجوز جلد',m.rightsConflicts],['PDF تأیید داخلی',m.approvedDigitalBooks],['اشکال فایل PDF',m.digitalVaultErrors]]
  .map(([label,num])=>`<div><strong>${digits(num)}</strong><span>${esc(label)}</span></div>`).join('');
 const list=scope=>r.checks.filter(x=>x.scope===scope).map(x=>`<tr><td>${x.ok?'✅ تأیید فنی/اعلامی':'⛔ نیازمند اقدام'}</td><td><code dir="ltr">${esc(x.id)}</code></td><td>${esc(x.detail)}</td></tr>`).join('');
 return panelShell(user,`<div class="page-banner"><span class="eyebrow">VARAQ 6.0 · RELEASE CONTROL</span><h1>مرکز آمادگی انتشار</h1><p>گزارش زنده و فقط‌خواندنی بر اساس اطلاعات واقعی این نصب؛ نتیجه بررسی انسانی و خودکار از هم قابل تفکیک است.</p></div><div class="soft-warning">⛔ <strong>فروش تجاری: NO-GO</strong> — تا زمان اتصال واقعی درگاه، کنترل حقوق فروش و آزمون‌های عملی، هیچ دکمه خرید یا دانلود پولی فعال نمی‌شود. شماره نسخه ۶.۰ به معنی تأیید فروش نیست.</div><div class="panel-note"><h2>انتشار اطلاعاتی</h2><p><strong>${r.readyForInformationPreview?'معیارهای گزارش پاس شده‌اند، نیازمند تأیید اجرایی':'شرایط انتشار اطلاعاتی هنوز کامل نشده است'}</strong></p><p>وضعیت فروش واقعی: <strong>غیرفعال 🔒</strong></p><p><a class="outline" href="/panel/release-readiness.csv">دریافت گزارش CSV آمادگی انتشار</a> · <a href="/panel/catalog-worklist">صف تکمیل اطلاعات ۲۰۰ کتاب</a> · <a href="/panel/payment-readiness">پرونده پذیرندگی</a></p><p class="muted tiny">زمان گزارش: ${esc(r.generatedAt)} UTC · گزارش نه تنظیمات پروژه را تغییر می‌دهد و نه به‌جای مجوز و تست حقیقی است.</p></div><div class="quality-stats">${cards}</div><div class="panel-note"><h2>کنترل‌های انتشار اطلاعاتی</h2><div class="table-scroll"><table class="data-table"><thead><tr><th>وضعیت</th><th>کنترل</th><th>توضیحات</th></tr></thead><tbody>${list('preview')}</tbody></table></div></div><div class="panel-note"><h2>کنترل‌های فروش تجاری</h2><div class="table-scroll"><table class="data-table"><thead><tr><th>وضعیت</th><th>کنترل</th><th>توضیحات</th></tr></thead><tbody>${list('sales')}</tbody></table></div></div>`,'آمادگی انتشار ۶.۰');
}
function panelPaymentReadiness(user){
 if(!user||(user.role!=='owner'&&!(user.role==='seller'&&storeRole(user)==='manager')))return null;
 const rows=digitalPayments.profiles(db,user),recent=digitalPayments.intents(db,user);
 const profiles=rows.map(r=>`<article class="panel-note"><h3>${esc(r.store_name)}</h3><p>وضعیت فروشگاه: ${esc(r.store_review)} · فایل PDF دارای مجوز فعلی: ${digits(r.licensed_pdfs)} · درخواست‌های پرداخت ثبت‌شده: ${digits(r.intent_count)}</p><p>وضعیت بررسی پذیرندگی: <strong>${esc(({unreviewed:'بررسی‌نشده',approved:'تأیید داخلی YM',rejected:'نیازمند اصلاح'})[r.payment_review])}</strong></p><form action="/panel/payment-profile" method="post" class="form-grid">${csrfInput(user)}<input type="hidden" name="store_id" value="${r.store_id}"><input type="hidden" name="revision" value="${r.revision}"><label>درگاه پیشنهادی<select name="provider"><option value="">انتخاب نشده</option>${[['zarinpal','زرین‌پال'],['idpay','آیدی‌پی'],['other','درگاه دیگر']].map(([key,label])=>`<option value="${key}" ${r.provider===key?'selected':''}>${label}</option>`).join('')}</select></label><label>شناسه عمومی پذیرنده (بدون رمز و توکن)<input name="merchant_label" value="${attr(r.merchant_label)}" maxlength="80" placeholder="شناسه عمومی قرارداد" autocomplete="off"></label><label class="checkbox-line full"><input type="checkbox" name="owner_confirmed" value="1" ${r.owner_confirmed?'checked':''}> پذیرندگی و حساب تسویه متعلق به همین کتاب‌فروشی است (تأیید اولیه، نه تأیید رسمی)</label><button class="outline" type="submit">ذخیره پرونده و ارسال مجدد برای بررسی</button></form>${r.review_note?`<p class="muted">یادداشت بررسی YM: ${esc(r.review_note)}</p>`:''}${user.role==='owner'&&r.provider&&r.owner_confirmed?`<form class="form-grid" method="post" action="/panel/payment-profile-review">${csrfInput(user)}<input type="hidden" name="store_id" value="${r.store_id}"><input type="hidden" name="revision" value="${r.revision}"><label>تصمیم بررسی<select name="status"><option value="approved">تأیید داخلی مدارک</option><option value="rejected">نیازمند اصلاح</option></select></label><label>توضیح بررسی<input name="note" required minlength="8" maxlength="400"></label><button class="outline">ثبت بررسی YM</button></form>`:''}</article>`).join('');
 const ledger=recent.map(r=>`<tr><td dir="ltr">${esc(r.intent_ref)}</td><td>${esc(r.store_name)}</td><td>${esc(r.title)}</td><td>${money(r.amount_toman)}</td><td>${esc(r.status)}</td></tr>`).join('');
 return panelShell(user,`<div class="page-banner"><span class="eyebrow">VARAQ · PAYMENT READINESS</span><h1>پرونده پذیرندگی و چرخه تراکنش PDF</h1><p>برای هر کتاب‌فروشی پذیرندگی و تسویه جدا در نظر گرفته شده است.</p></div><div class="soft-warning">🔒 پرداخت و صدور دانلود پولی هنوز غیرفعال است. ثبت این فرم فقط پرونده آمادگی است؛ دکمه خرید یا دریافت پول فعال نمی‌کند. هیچ کلید محرمانه‌ای وارد نکنید.</div><div class="panel-note"><h2>مراحل لازم برای فعال‌سازی</h2><p>تأیید مدارک فروشنده و حقوق PDF ← اتصال SDK/API درگاه معتبر با کلید در محیط امن سرور ← تأیید مستقل مبلغ، پذیرنده و شناسه تراکنش ← تست پرداخت، تکرار callback و برگشت وجه ← مجوز انتشار تجاری.</p><p>زیرساخت ۵.۰ درخواست‌های داخلی را ثبت می‌کند، اما بدون اتصال رسمی به درگاه هیچ مسیر عمومی پرداخت ایجاد نمی‌کند.</p></div>${profiles||'<div class="panel-note">فروشگاه قابل‌مدیریتی وجود ندارد.</div>'}<div class="panel-note"><h2>دفتر درخواست‌های پرداخت</h2><p>${user.role==='owner'?'<a class="outline" href="/panel/payment-ledger.csv">دریافت گزارش CSV مدیریت YM</a>':''} این جدول فقط رکوردهای واقعی دفتر داخلی را نشان می‌دهد؛ تراکنش ساختگی اضافه نشده است.</p><div class="table-scroll"><table class="data-table"><thead><tr><th>شناسه</th><th>فروشگاه</th><th>PDF</th><th>مبلغ</th><th>وضعیت</th></tr></thead><tbody>${ledger||'<tr><td colspan="5">هنوز درخواستی ثبت نشده است.</td></tr>'}</tbody></table></div></div>`,'آمادگی پذیرندگی PDF');
}
// Cached, immutable-in-process static assets; supports conditional and gzip responses.
const STATIC_FILES={
 '/assets/style.css':['style.css','text/css; charset=utf-8'],
 '/assets/app.js':['app.js','text/javascript; charset=utf-8']
};
const STATIC_BYTES={};
const ASSET_URLS={};
for(const [url,[filename,mime]] of Object.entries(STATIC_FILES)){
 const raw=fs.readFileSync(path.join(STATIC,filename));
 const digest=crypto.createHash('sha256').update(raw).digest('hex');
 const ext=path.extname(filename),basename=filename.slice(0,-ext.length);
 const fingerprint='/assets/'+basename+'.'+digest.slice(0,16)+ext;
 const asset={mime,raw,gzip:zlib.gzipSync(raw,{level:6}),etag:'"'+digest.slice(0,24)+'"'};
 STATIC_BYTES[url]={...asset,immutable:false};STATIC_BYTES[fingerprint]={...asset,immutable:true};
 ASSET_URLS[basename]=fingerprint;
}
function staticFile(req,res,pathname){
 const a=STATIC_BYTES[pathname];if(!a)return false;
 const headers={'ETag':a.etag,'Vary':'Accept-Encoding','Cache-Control':a.immutable?'public,max-age=31536000,immutable':'public,max-age=3600','X-Content-Type-Options':'nosniff'};
 if(req.headers['if-none-match']===a.etag){res.writeHead(304,headers);res.end();return true;}
 const wantsGzip=/(?:^|,)\s*gzip(?:\s*[;,]|$)/i.test(req.headers['accept-encoding']||'');
 res.writeHead(200,{...headers,'Content-Type':a.mime,...(wantsGzip?{'Content-Encoding':'gzip'}:{})});
 res.end(wantsGzip?a.gzip:a.raw);return true;
}
const attempts=new Map();
function limiter(ip){const now=Date.now();const a=attempts.get(ip)||{n:0,t:now};if(now-a.t>15*60000){attempts.set(ip,{n:0,t:now});return false;}return a.n>=8;}
function failed(ip){const a=attempts.get(ip)||{n:0,t:Date.now()};a.n++;attempts.set(ip,a);if(attempts.size>5000){for(const [k,v] of attempts)if(Date.now()-v.t>15*60000)attempts.delete(k);}}
function bad(res,code,message,user=null){send(res,code,page({title:code+' | خطا',content:`<div class="shell main"><div class="empty"><h1>${code}</h1><p>${esc(message)}</p><a href="/">بازگشت به خانه</a></div></div>`,user}));}
async function handler(req,res){const nonce=crypto.randomBytes(16).toString('base64');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Cross-Origin-Opener-Policy','same-origin');res.setHeader('X-Permitted-Cross-Domain-Policies','none');
 if(PUBLIC_URL.startsWith('https://'))res.setHeader('Strict-Transport-Security','max-age=31536000');
 if(!INDEXING_ENABLED||new URL(req.url, PUBLIC_URL).pathname.endsWith('/read')||new URL(req.url, PUBLIC_URL).pathname==='/themes'||/^\/(panel(?:\/|$)|login$|logout$|setup$|cart$|saved$|demo-order(?:\/|$)|health$)/.test(new URL(req.url, PUBLIC_URL).pathname))res.setHeader('X-Robots-Tag','noindex, nofollow');
 if(!['GET','POST','HEAD'].includes(req.method)){res.writeHead(405,{'Allow':'GET, POST, HEAD'});res.end('Method not allowed');return;}
 if(!allowUnsafeRequest(req,PUBLIC_URL)){return send(res,403,'Cross-site request rejected','text/plain; charset=utf-8');}
 res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy',req.url.startsWith('/demo-order/')?'no-referrer':'strict-origin-when-cross-origin');res.setHeader('X-Frame-Options','DENY');res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');res.setHeader('Content-Security-Policy',`default-src 'self'; img-src 'self' data: https://arianhonar.ir https://img.taaghche.com https://baranmarket.com https://covers.openlibrary.org https://books.google.com https://books.googleusercontent.com; font-src 'self' https://fonts.gstatic.com; style-src 'self' https://fonts.googleapis.com; script-src 'self' 'nonce-${nonce}'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`);
 const url=query(req.url);const p=url.pathname;
 if(p==='/__varaq_local/stop'){
  if(!runtimeControl.authorized(req,localControl))return send(res,404,'Not found','text/plain; charset=utf-8');
  send(res,200,'VARAQ shutdown accepted','text/plain; charset=utf-8');
  setImmediate(shutdown);
  return;
 }
 const user=actor(req);
 if(p==='/market'||p.startsWith('/market/')){
   if(IS_PUBLIC) return send(res,404,'این بخش هنوز برای انتشار عمومی فعال نشده است.','text/plain; charset=utf-8');
   if(!marketGateway.enabled) return send(res,503,'درگاه یکپارچه فعال نیست. سایت را با START_UNIFIED_WINDOWS.bat اجرا کنید.','text/plain; charset=utf-8');
   if(user?.must_change_password) return redirect(res,'/panel/account');
   if(user?.role==='seller'&&user.staff_permission!=='manager') return redirect(res,'/panel');
   const store=user?.store_id ? db.prepare('SELECT name FROM stores WHERE id=? AND active=1').get(user.store_id) : null;
   if(user?.role==='seller'&&!store) return send(res,403,'فروشگاه غیرفعال یا فاقد مجوز است.');
   return marketGateway.forward(req,res,{user,storeName:store?.name||''});
 }
 // v9.7: Retail SQLite is the only writer for NEW checkout and stock in unified mode.
 // Historical Node demo orders stay readable but can no longer be mutated.
 if(marketGateway.enabled&&!IS_PUBLIC){
   if(['GET','HEAD'].includes(req.method)&&p==='/cart') return redirect(res,'/market/cart');
   if(req.method==='POST'&&p==='/demo-order/preview')
     return send(res,409,JSON.stringify({error:'ثبت سفارش آزمایشی قدیمی بسته است. لطفاً از /market/cart استفاده کنید.'}),'application/json; charset=utf-8');
   if(req.method==='POST'&&p==='/demo-order')
     return bad(res,409,'ثبت سفارش در بخش قدیمی متوقف است. از فروشگاه یکپارچه استفاده کنید.',user);
   if(req.method==='POST'&&new Set([
     '/panel/stock-item','/panel/stock-move','/panel/offer','/panel/discount',
     '/panel/merchandising','/panel/featured-item',
     '/panel/order-checklist','/panel/order-status'
   ]).has(p))return bad(res,409,'این دفتر قدیمی فقط برای بازبینی است. موجودی و سفارش جدید را در /market/seller مدیریت کنید.',user);
 }
 const method=req.method==='HEAD'?'GET':req.method;function render(title,content,description='',extraHead='',status=200){
 const html=page({title,content,description,user,reqUrl:req.url,extraHead:extraHead.replace(/__NONCE__/g,nonce),pageNonce:nonce});
 const allowCompression=status===200&&!user&&!req.headers.cookie&&/^(?:\/$|\/books$|\/stores(?:\/.*)?$|\/authors(?:\/.*)?$|\/publishers(?:\/.*)?$|\/educational(?:\/.*)?$|\/about$|\/terms$|\/privacy$)/.test(p)&&req.method==='GET'&&/(?:^|,)\s*gzip(?:[\s;,]|$)/i.test(req.headers['accept-encoding']||'')&&Buffer.byteLength(html)>4096;
 if(allowCompression){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Content-Encoding':'gzip','Vary':'Accept-Encoding','Cache-Control':'no-store'});res.end(zlib.gzipSync(html,{level:4}));return;}
 return send(res,status,html,'text/html; charset=utf-8',{'Vary':'Accept-Encoding'});
}
 if(method==='GET'&&staticFile(req,res,p))return;
 if(method==='GET'&&/^\/concept-(?:art|thumb)\/book-\d{3,4}\.webp$/.test(p)){
  const thumbnail=p.startsWith('/concept-thumb/');
  const id=Number(p.match(/book-(\d{3,4})\.webp$/)[1]);
  if(id<1||id>1000||!generatedTextById.has(id))return bad(res,404,'تصویر یافت نشد.');
  const folder=thumbnail?'concept-thumb':'concept-art';
  const file=path.join(STATIC,folder,`book-${String(id).padStart(3,'0')}.webp`);
  if(!fs.existsSync(file))return bad(res,404,'تصویر یافت نشد.');
  const stat=fs.statSync(file),size=stat.size;
  // Versioned URLs allow immutable caching; ETag hashes the actual file bytes.
  const versioned=url.searchParams.get('v')==='86';
  const etag=conceptEtag(file,stat);
  const headers={'Content-Type':'image/webp','Cache-Control':versioned?'public,max-age=31536000,immutable':'public,max-age=3600','ETag':etag,'X-Content-Type-Options':'nosniff'};
  if(req.headers['if-none-match']===etag){res.writeHead(304,headers);res.end();return;}
  res.writeHead(200,{...headers,'Content-Length':size});
  if(req.method==='HEAD'){res.end();return;}
  fs.createReadStream(file).pipe(res);return;
 }
 
 if(req.method==='HEAD'&&/^\/pdf-delivery\/[A-Za-z0-9_-]{43}$/.test(p))return send(res,405,'HEAD is not supported for paid downloads','text/plain; charset=utf-8',{'Allow':'GET'});
 if(method==='GET'&&/^\/pdf-delivery\/[A-Za-z0-9_-]{43}$/.test(p)){
  const downloaded=digitalEntitlements.claim(db,PDF_DIR,p.split('/').pop());
  if(!downloaded)return bad(res,404,'لینک دریافت معتبر یا فعال نیست.');
  res.writeHead(200,{'Content-Type':'application/pdf','Content-Disposition':`attachment; filename="varaq-pdf-${downloaded.digitalId}.pdf"`,'Content-Length':downloaded.bytes,'Cache-Control':'private, no-store','Referrer-Policy':'no-referrer','X-Robots-Tag':'noindex, nofollow','X-Content-Type-Options':'nosniff'});
  fs.createReadStream(downloaded.full).pipe(res);return;
 }
 if(method==='GET'&&/^\/media\/covers\/[a-f0-9]{32}\.(png|jpg|webp)$/.test(p)){
  const filename=p.split('/').pop(),record=db.prepare('SELECT mime FROM book_covers WHERE filename=?').get(filename)||db.prepare('SELECT mime FROM edition_cover_assets WHERE filename=?').get(filename);
  if(!record)return bad(res,404,'تصویر یافت نشد.');
  const file=path.join(COVER_DIR,filename);if(!localCoverExists(filename))return bad(res,404,'تصویر یافت نشد.');
  res.writeHead(200,{'Content-Type':record.mime,'Cache-Control':'public,max-age=86400','X-Content-Type-Options':'nosniff','Content-Disposition':'inline'});
  fs.createReadStream(file).pipe(res);return;
 }
 if(method==='GET'&&/^\/media\/banners\/[a-f0-9]{32}\.(png|jpg|webp)$/.test(p)){
  const filename=p.split('/').pop(),record=db.prepare('SELECT mime,active FROM homepage_banners WHERE filename=?').get(filename);
  if(!record||(!record.active&&(!user||user.role!=='owner'||user.must_change_password)))return bad(res,404,'تصویر یافت نشد.');
  const full=path.join(BANNER_DIR,filename);if(!fs.existsSync(full))return bad(res,404,'تصویر یافت نشد.');
  res.writeHead(200,{'Content-Type':record.mime,'Content-Disposition':'inline','Cache-Control':record.active?'public,max-age=3600':'private,no-store','X-Content-Type-Options':'nosniff'});
  fs.createReadStream(full).pipe(res);return;
 }
 if(method==='GET'&&p==='/panel/education-import-template'){
  if(!user||user.role!=='owner'||user.must_change_password)return bad(res,403,'دسترسی مجاز نیست.',user);
  return send(res,200,educationBatch.template,'text/csv; charset=utf-8',{'Content-Disposition':'attachment; filename="varaq-education-template.csv"'});
 }
 if(method==='GET'&&p==='/panel/education-import-help'){
  if(!user||user.role!=='owner'||user.must_change_password)return bad(res,403,'دسترسی مجاز نیست.',user);
  const manual=`# کدهای فایل ورود گروهی کمک‌درسی\n\nbook_id: شناسه کتابی که قبلاً در پنل کتاب ثبت شده است.\ngrade: عدد 1 تا 13 (13 یعنی کنکور)\ntrack: ${Object.entries(education.TRACKS).map(([k,v])=>k+'='+v).join(', ')}\nsubject: ${education.SUBJECTS.join('، ')}\ngoal: ${Object.entries(education.GOALS).map(([k,v])=>k+'='+v).join(', ')}\nmaterial_type: ${Object.entries(education.TYPES).map(([k,v])=>k+'='+v).join(', ')}\nexam_year: اختیاری، 1400 تا 1500؛ فقط از پایه دهم به بالا\n\nنکته: همه ردیف‌ها پیش‌نویس می‌شوند؛ موجودی و قیمت تغییر نمی‌کند.\n`;
  return send(res,200,manual,'text/plain; charset=utf-8',{'Content-Disposition':'attachment; filename="varaq-education-codes.txt"'});
 }
 if(method==='GET'&&p==='/panel/import-template'){
   if(!user||user.role!=='owner'||user.must_change_password)return bad(res,403,'دسترسی مجاز نیست.',user);
   const csv='\uFEFFtitle,author,category,description,publisher\n"کتاب آزمایشی","نویسنده نمونه","رمان و ادبیات جهان","معرفی نمونه",""\n';
   return send(res,200,csv,'text/csv; charset=utf-8',{'Content-Disposition':'attachment; filename="varaq-import-template.csv"'});
 }
 if(method==='GET'&&/^\/panel\/store-doc-download\/\d+$/.test(p)){
   const id=safeId(p.split('/').pop()),doc=db.prepare('SELECT * FROM store_documents WHERE id=?').get(id);
   if(!user||user.must_change_password||!doc||!managerOf(user,doc.store_id))return bad(res,403,'دسترسی به مدرک مجاز نیست.',user);
   const full=path.join(PRIVATE_DOC_DIR,doc.stored_name);if(!fs.existsSync(full))return bad(res,404,'فایل پیدا نشد.',user);
   audit(user,'download-store-document',String(id));
   res.writeHead(200,{'Content-Type':doc.mime,'Content-Disposition':`attachment; filename="document-${id}.${doc.mime==='application/pdf'?'pdf':doc.mime==='image/png'?'png':'jpg'}"`,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'});
   fs.createReadStream(full).pipe(res);return;
 }
 if(method==='GET'&&p==='/panel/reports.csv'){
   if(!user||user.must_change_password)return bad(res,403,'دسترسی مجاز نیست.',user);
   const f=financeReportFor(user,url);
   if(!f)return bad(res,403,'دسترسی به گزارش این فروشگاه مجاز نیست.',user);
   if(f.error)return bad(res,400,f.error,user);
   const csv=finance.csv(finance.getReport(db,f));
   return send(res,200,csv,'text/csv; charset=utf-8',{'Content-Disposition':'attachment; filename="varaq-demo-report.csv"'});
 }
 if(method==='GET'&&p==='/panel/stock-ledger.csv'){
   if(!user||user.must_change_password)return bad(res,403,'ابتدا وارد حساب شوید.',user);
   const {storeId}=storeScope(user,url),itemId=safeId(url.searchParams.get('item'));
   if(!storeId||itemId&&!db.prepare('SELECT id FROM stock_items WHERE id=? AND store_id=?').get(itemId,storeId))return bad(res,403,'دسترسی به گزارش مجاز نیست.',user);
   return send(res,200,ledgerCsv(stockLedgerRecords(storeId,itemId)),'text/csv; charset=utf-8',{'Content-Disposition':'attachment; filename="varaq-stock-ledger.csv"'});
 }
 if(method==='GET'&&p==='/health')return send(res,200,JSON.stringify({ok:true,version:'8.6.0',payment_enabled:false,orders_mode:PUBLIC_READONLY?'public_readonly':'demo_only'}), 'application/json; charset=utf-8');
 if(method==='GET'&&p==='/robots.txt')return send(res,200,INDEXING_ENABLED?'User-agent: *\nDisallow: /panel\nDisallow: /login\nDisallow: /cart\nDisallow: /demo-order/\nSitemap: '+PUBLIC_URL+'/sitemap.xml\n':'User-agent: *\nDisallow: /\n','text/plain; charset=utf-8');
 if(method==='GET'&&p==='/sitemap.xml'){
   if(IS_PUBLIC&&!INDEXING_ENABLED)return send(res,404,'Sitemap not enabled for this preview','text/plain; charset=utf-8');
   const books=IS_PUBLIC?seo.approvedBooks(db):db.prepare('SELECT slug FROM books ORDER BY id').all();
   const categories=db.prepare('SELECT slug,name FROM book_categories WHERE active=1 ORDER BY id').all().filter(c=>!IS_PUBLIC||seo.indexableCategory(db,c.name));
   const writers=discovery.authors(db,{perPage:20000}).rows.filter(x=>!IS_PUBLIC||seo.indexableProfile(db,'author',x.name));
   const publishers=discovery.publishers(db,{perPage:20000}).rows.filter(x=>!IS_PUBLIC||seo.indexableProfile(db,'publisher',x.name));
   const paths=['/','/books','/educational','/stores','/about','/authors','/publishers',...categories.map(c=>'/category/'+encodeURIComponent(c.slug)),...books.map(b=>'/book/'+encodeURIComponent(b.slug)),...writers.map(x=>'/authors/'+encodeURIComponent(x.name)),...publishers.map(x=>'/publishers/'+encodeURIComponent(x.name))];
   const xml=seo.xmlSitemap(PUBLIC_URL,paths);
   return send(res,200,xml,'application/xml; charset=utf-8',{'Cache-Control':IS_PUBLIC?'public, max-age=3600':'no-store'});
 }
 if(method==='GET'&&p==='/')return render('ورق | مرجع کتاب و کتاب‌فروشی',home(),'کشف و معرفی کتاب‌ها، بررسی آثار و مشاهده فروشگاه‌های کتاب همکار');
 if(method==='GET'&&p.startsWith('/category/')){const c=categoryRecord(decodeURIComponent(p.slice(10)));if(!c)return bad(res,404,'موضوع یافت نشد.',user);const q=new URL('/books',PUBLIC_URL);q.searchParams.set('category',c.name);return render(c.name+' | دسته‌بندی',catalog(q),'کتاب‌های موضوع '+c.name,seo.breadcrumbs(PUBLIC_URL,[{name:'خانه',path:'/'},{name:'کتاب‌ها',path:'/books'},{name:c.name,path:'/category/'+encodeURIComponent(c.slug)}]));}
 if(method==='GET'&&p==='/pdf-books')return render('کتاب‌های PDF',pdfUi.publicPage(db,url,{esc,attr,digits,money,csrfInput,panelShell,storeRole,localCoverExists,linkedPrintCover:bookId=>{const book=db.prepare('SELECT id,title,slug,author,category FROM books WHERE id=?').get(bookId);return book?cover(book,false):'';}}),'فروشگاه کتاب‌های الکترونیکی با حقوق توزیع ثبت‌شده؛ پرداخت غیرفعال');
 if(method==='GET'&&/^\/pdf-books\/\d+$/.test(p)){const v=pdfUi.publicDetail(db,p.split('/').pop(),{esc,attr,digits,money,localCoverExists});return v?render(v.title+' | PDF',v.content,v.description):bad(res,404,'کتاب دیجیتال تأییدشده یافت نشد.');}
 if(method==='GET'&&p==='/choose-format'){const v=formatChoicePage(url);return v.error?bad(res,400,v.error,user):v.notFound?bad(res,404,'کتاب موردنظر در بانک ورق پیدا نشد.',user):render(v.title,v.content,'راهنمای انتخاب نسخه چاپی و PDF کتاب با وضعیت مستند عرضه و بدون امکان پرداخت');}
 if(method==='GET'&&p==='/books-300')return render('مجموعه اختصاصی ورق',completedCollection(url));
 if(method==='GET'&&p==='/books')return render('فهرست کتاب‌ها',catalog(url),'جست‌وجو میان ۱۰۰۰ عنوان منتخب کتاب');
 if(method==='GET'&&p==='/books/compare'){const v=compareBooksPage(url);return v.error?bad(res,400,v.error,user):render('مقایسه کتاب‌ها',v.content,'مقایسه مشخصات ثبت‌شده دو یا سه کتاب در ورق');}
 if(method==='GET'&&p==='/themes')return render('کشف کتاب بر اساس موضوع',themesPage(url),'مرور برچسب‌های موضوعی پیشنهادی و کتاب‌های هم‌موضوع در ورق');
  if(method==='GET'&&p==='/educational/compare'){const v=educationComparePage(url);return v.error?bad(res,400,v.error,user):render('مقایسه منابع آموزشی',v.html,'مقایسه مشخصات ثبت‌شده کتاب‌های کمک‌درسی');}
 if(method==='GET'&&p==='/educational')return render('کتاب‌های کمک‌درسی و کنکور',educationPublicPage(url),'جست‌وجوی کتاب کمک‌درسی بر اساس پایه، رشته، درس و هدف مطالعه');
 if(method==='GET'&&(p==='/authors'||p==='/publishers')){const isAuthor=p==='/authors';return render(isAuthor?'نویسندگان کتاب':'ناشران کتاب',personDirectory(isAuthor?'author':'publisher',url));}
 if(method==='GET'&&(p.startsWith('/authors/')||p.startsWith('/publishers/'))){const kind=p.startsWith('/authors/')?'author':'publisher',prefix=kind==='author'?'/authors/':'/publishers/';let name;try{name=decodeURIComponent(p.slice(prefix.length));}catch{return bad(res,404,'آدرس نامعتبر است.',user);}if(!name||name.length>160||name.includes('/'))return bad(res,404,'نام معتبر نیست.',user);const result=personProfile(kind,name,url);return result?render(name+' | '+(kind==='author'?'نویسنده':'ناشر'),result.content,'کتاب‌های ثبت‌شده '+name+' در مرجع ورق',result.head):bad(res,404,'نام پیدا نشد.',user);}
 if(method==='GET'&&/^\/book\/[^/]+\/sheet$/.test(p)){
  let slug;try{slug=decodeURIComponent(p.slice('/book/'.length,-'/sheet'.length));}catch{return bad(res,404,'آدرس کتاب نامعتبر است.');}
  const v=bookInfoSheet(slug);return v?render('برگه اطلاعات '+v.b.title,v.content,'برگه مطالعه و چاپ اطلاعات کتاب '+v.b.title):bad(res,404,'کتاب یافت نشد.');
 }
 if(method==='GET'&&/^\/book\/[^/]+\/read$/.test(p)){let slug;try{slug=decodeURIComponent(p.slice('/book/'.length,-'/read'.length));}catch{return bad(res,404,'آدرس کتاب نامعتبر است.');}const v=readingPage(slug);return v?render('فضای مطالعه '+v.book.title,v.html,'راهنمای شناخت کتاب و نمونه متن دارای مجوز؛ بدون پرداخت'):bad(res,404,'کتاب یافت نشد.');}
 if(method==='GET'&&p.startsWith('/book/')){const v=bookDetail(decodeURIComponent(p.slice('/book/'.length)),url.searchParams.get('edition'));if(!v)return bad(res,404,'کتاب یافت نشد.',user);return render(v.b.title,url.searchParams.get('review')==='pending'?`<div class="shell"><div class="flash" role="status">نظر شما ثبت شد و پس از بررسی مدیر قابل نمایش خواهد بود.</div></div>`+v.content:v.content,`${v.b.title} | ${v.b.author||v.b.category} | معرفی و مشخصات کتاب`,v.head);}
 if(method==='POST'&&p==='/review'){
   const f=await body(req);const bookId=Number(f.book_id),book=db.prepare('SELECT id,slug FROM books WHERE id=?').get(bookId);
   if(!book)return bad(res,404,'این کتاب پیدا نشد.');
   const origin=req.headers.origin;
   if(origin&&origin!==new URL(PUBLIC_URL).origin)return bad(res,403,'مبدأ درخواست نامعتبر است.');
   const name=str(f.display_name,51),message=str(f.body,1501),rating=Number(f.rating);
   if(f.website||!validReviewToken(bookId,f.token)||name.length<2||name.length>50||message.length<30||message.length>1500||!Number.isInteger(rating)||rating<1||rating>5)return bad(res,400,'اطلاعات نظر معتبر نیست؛ لطفاً فرم صفحه کتاب را تکمیل کنید.');
   const ip=req.socket.remoteAddress||'unknown';if(!reviewQuota(ip))return bad(res,429,'تعداد نظرهای ارسالی زیاد است؛ کمی بعد دوباره تلاش کنید.');
   db.prepare('INSERT INTO reader_reviews(book_id,display_name,rating,body) VALUES(?,?,?,?)').run(bookId,name,rating,message);bumpReviewQuota(ip);
   return redirect(res,'/book/'+encodeURIComponent(book.slug)+'?review=pending#reader-reviews');
 }
 if(method==='POST'&&p==='/demo-order/preview'){
   if(PUBLIC_READONLY)return send(res,403,JSON.stringify({error:'در نسخه عمومی اطلاعاتی، ثبت سفارش غیرفعال است.'}),'application/json; charset=utf-8');
   const origin=req.headers.origin;if(origin&&origin!==new URL(PUBLIC_URL).origin)return send(res,403,JSON.stringify({error:'مبدأ نامعتبر'}),'application/json; charset=utf-8');
   const f=await body(req);
   if(!validReviewToken(0,f.token))return send(res,403,JSON.stringify({error:'کلید اعتبارسنجی منقضی شده است؛ صفحه را بارگذاری کنید.'}),'application/json; charset=utf-8');
   let items;try{items=JSON.parse(f.items||'');}catch{return send(res,400,JSON.stringify({error:'سبد نامعتبر است.'}),'application/json; charset=utf-8');}
   try{const result=orders.preview(db,{storeId:safeId(f.store_id),items});return send(res,200,JSON.stringify(result),'application/json; charset=utf-8');}
   catch(e){if(e.userError)return send(res,400,JSON.stringify({error:e.message}),'application/json; charset=utf-8');throw e;}
 }
 if(method==='POST'&&p==='/demo-order'){
   if(PUBLIC_READONLY)return bad(res,403,'ثبت سفارش آزمایشی در نسخه عمومی اطلاعاتی فعال نیست.');
   const origin=req.headers.origin;if(origin&&origin!==new URL(PUBLIC_URL).origin)return bad(res,403,'مبدأ درخواست معتبر نیست.');
   const f=await body(req),ip=req.socket.remoteAddress||'unknown';
   if(f.website||!validReviewToken(0,f.token)||f.demo_consent!=='1')return bad(res,403,'درخواست آزمایشی نامعتبر است یا تأیید آزمایشی بودن ثبت نشده.');
   const now=Date.now(),a=demoOrderAttempts.get(ip)||{first:now,count:0};
   if(now-a.first>3600000){a.first=now;a.count=0;}if(a.count>=8)return bad(res,429,'سقف ثبت سفارش نمونه در این ساعت تکمیل شده است.');
   // Avoid unbounded memory growth for long-running local demonstrations.
   if(demoOrderAttempts.size>2000)for(const [k,v] of demoOrderAttempts)if(now-v.first>3600000)demoOrderAttempts.delete(k);
   let items;try{items=JSON.parse(f.items||'');}catch{return bad(res,400,'سبد کتاب‌ها معتبر نیست.');}
   try{const result=orders.createDemo(db,{storeId:safeId(f.store_id),clientRef:String(f.client_ref||''),customerAlias:String(f.customer_alias||''),city:String(f.city||''),sampleAddress:String(f.sample_address||''),shippingMethod:String(f.shipping_method||''),items});
     if(!result.replayed){a.count++;demoOrderAttempts.set(ip,a);}return redirect(res,'/demo-order/received?code='+encodeURIComponent(result.code)+(result.key?'&key='+encodeURIComponent(result.key):''));
   }catch(e){if(e.userError)return bad(res,400,e.message);throw e;}
 }
 if(method==='GET'&&p==='/stores')return render('فروشگاه‌های کتاب',stores());
 if(method==='GET'&&/^\/store\/\d+$/.test(p)){const v=singleStore(Number(p.split('/').pop()));return v?render(v.s.name,v.content):bad(res,404,'فروشگاه پیدا نشد.',user);}
 if(method==='GET'&&p==='/coming/educational')return redirect(res,'/educational');
 if(method==='GET'&&p==='/saved')return render('کتاب‌های نشان‌شده',savedPage());
 if(method==='GET'&&p==='/cart')return render('سبد کتاب‌ها',cartPage());
 if(method==='GET'&&PUBLIC_READONLY&&p.startsWith('/demo-order/'))return bad(res,404,'این قابلیت فقط در محیط آزمایشی قابل استفاده است.');
 if(method==='GET'&&p==='/demo-order/received')return render('رسید و پیگیری آزمایشی',demoReceived(url));
 if(method==='GET'&&p==='/demo-order/track')return render('پیگیری سفارش آزمایشی',demoTrack());
 if(method==='GET'&&p==='/about')return render('درباره ورق',`<div class="shell main prose"><h1>درباره ورق</h1><p>ورق یک پروژه از گروه YM برای ایجاد بانک اطلاعاتی مستقل کتاب‌ها و فراهم‌کردن پنل فروش برای کتاب‌فروشی‌های همکار است.</p><p>اکنون ۱۰۰۰ عنوان معرفی شده‌اند؛ مشخصات چاپ و امکان فروش فقط پس از بررسی و تأیید افزودنی هستند. اطلاعات نشر و نسخه‌های چاپی پس از بررسی و تکمیل افزوده می‌شوند. درگاه پرداخت هنوز فعال نیست.</p></div>`);
 if(method==='GET'&&p==='/privacy')return render('حریم خصوصی',`<div class="shell main prose"><h1>حریم خصوصی</h1><p>اطلاعات نشست کاربران مدیر و فروشنده برای ورود امن در پایگاه داده محلی ذخیره می‌شود. برای انتشار نظر، نام نمایشی، متن و امتیاز تا زمان بررسی مدیر در پایگاه داده ذخیره می‌شوند؛ داده‌های ردشده نیز تا حذف مدیریتی نگهداری می‌شوند. آدرس IP نظرها در پایگاه داده ثبت نمی‌شود ولی برای محدودسازی ارسال در حافظه موقت استفاده می‌شود. داده‌های سبد خرید و فهرست کتاب‌های نشان‌شده فقط در حافظه محلی مرورگر نگهداری می‌شوند و برای ذخیره نشان‌ها به سرور ارسال نمی‌شوند. پرداخت آنلاین و جمع‌آوری اطلاعات مالی مشتری فعلاً وجود ندارد.</p><p>در فاز هفتم، فرم سفارش نمونه فقط نام مستعار، شهر و آدرس فرضی آزمایشی می‌گیرد؛ این اطلاعات در پایگاه داده محلی ذخیره می‌شود و نباید اطلاعات واقعی اشخاص وارد شود. سفارش‌های ثبت‌شده واقعی، پرداخت‌شده یا قابل ارسال نیستند. اطلاعات نمونه باید پیش از انتشار عمومی پاک‌سازی شوند.</p><p>پیش از انتشار عمومی باید نام و اطلاعات تماس مسئول حفاظت از داده‌ها و شرایط نگهداری و حذف اطلاعات تکمیل شوند.</p></div>`);
 if(method==='GET'&&p==='/terms')return render('شرایط استفاده',`<div class="shell main prose"><h1>شرایط استفاده</h1><p>اطلاعات کتاب‌ها برای آشنایی کاربران گردآوری شده است و ممکن است در نسخه اولیه ناقص باشد. قیمت‌ها و موجودی‌ها توسط فروشندگان مدیریت می‌شوند. تا تأیید مجوزها و اتصال درگاه، فروش و پرداخت آنلاین انجام نمی‌شود.</p></div>`);
 if(p==='/setup'){
   if(!initialToken||db.prepare('SELECT count(*) n FROM users WHERE role=\'owner\'').get().n)return bad(res,403,'راه‌اندازی اولیه قبلاً انجام شده است.');
   if(method==='GET')return render('راه‌اندازی اولیه',setupForm());
   if(method==='POST'){const f=await body(req);const username=str(f.username,50),storeName=str(f.store_name,100),city=str(f.city,80),pass=String(f.password||'');if(f.setup_token!==initialToken||!/^[a-zA-Z0-9._-]{3,50}$/.test(username)||pass.length<12||!storeName)return render('راه‌اندازی',setupForm('کد یا اطلاعات نامعتبر است. حداقل طول رمز ۱۲ کاراکتر است.'));
    db.exec('BEGIN IMMEDIATE');try{db.prepare('INSERT INTO stores(name,slug,city,active) VALUES(?,?,?,1)').run(storeName,'store-1',city);db.prepare("INSERT INTO users(username,password_hash,role) VALUES(?,?,'owner')").run(username,hashPassword(pass));db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');return render('راه‌اندازی',setupForm('نام کاربری قبلاً استفاده شده یا خطای ثبت رخ داده است.'));}audit(null,'bootstrap','owner-store');return redirect(res,'/login');}
 }
 if(p==='/login'){
   if(method==='GET')return user?redirect(res,'/panel'):render('ورود فروشندگان',loginForm(url.searchParams.get('changed')==='1'?'اطلاعات حساب به‌روز شد؛ با رمز جدید وارد شوید.':''));
   if(method==='POST'){const ip=req.socket.remoteAddress||'unknown';if(limiter(ip))return bad(res,429,'تلاش‌های ناموفق زیاد است؛ بعداً دوباره امتحان کنید.');const f=await body(req);const username=str(f.username,50);const row=db.prepare('SELECT * FROM users WHERE username=?').get(username);if(!row||row.enabled!==1||!verifyPassword(String(f.password||''),row.password_hash)){failed(ip);return render('ورود فروشندگان',loginForm('نام کاربری یا رمز عبور اشتباه است.'));}attempts.delete(ip);sessionCreate(res,row.id);audit({id:row.id},'login','session');return redirect(res,row.must_change_password?'/panel/account':'/panel');}
 }
 if(method==='POST'&&p==='/logout'){const f=await body(req,p==='/panel/education-import'?1400*1024:MAX_POST_BYTES);if(!csrfCheck(req,user,f))return bad(res,403,'درخواست نامعتبر است.');db.prepare('DELETE FROM sessions WHERE token_hash=?').run(sha(cookies(req).varaq_sid));appendCookie(res,'');return redirect(res,'/');}
 if(p.startsWith('/panel')){if(!user)return redirect(res,'/login');
   if(user.must_change_password===1 && p!=='/panel/account')return redirect(res,'/panel/account');
   if(method==='GET'){
     if(p==='/panel')return render('داشبورد',panelHome(user));
     if(p==='/panel/pdf-rights.csv'){if(user.role!=='owner')return bad(res,403,'دسترسی مجاز نیست.',user);return send(res,200,pdfRights.csv(pdfRights.report(db,user)),'text/csv; charset=utf-8',{'Content-Disposition':'attachment; filename=varaq-pdf-rights.csv'});}
     if(p==='/panel/pdf-books'){const v=pdfUi.panel(db,user,{esc,attr,digits,money,csrfInput,panelShell,storeRole});return v?render('کتاب‌های PDF',v):bad(res,403,'دسترسی مجاز نیست.',user);}
     if(p==='/panel/cover-completion'){const v=pdfUi.coverPanel(db,user,{esc,attr,digits,money,csrfInput,panelShell,storeRole},url);return v?render('تکمیل جلد و اطلاعات',v):bad(res,403,'دسترسی مجاز نیست.',user);}
     if(p==='/panel/content-batch')return user.role==='owner'?render('تکمیل گروهی کتاب‌ها',panelContentBatch(user)):bad(res,403,'دسترسی مجاز نیست.',user);
     if(p==='/panel/content-workbook'||p==='/panel/content-workbook.csv'||p==='/panel/content-workbook-guide.csv'){
       if(user.role!=='owner')return bad(res,403,'کاربر مجاز نیست.',user);
       const selected=contentWorkbook.select(db,{missing:url.searchParams.get('missing'),q:url.searchParams.get('q'),batch:Number(url.searchParams.get('batch')||1)});
       const qs=new URLSearchParams({missing:selected.mode,q:selected.q,batch:String(selected.batch)}).toString();
       if(p.endsWith('.csv'))return send(res,200,p.endsWith('-guide.csv')?contentWorkbook.guide(selected.items):contentWorkbook.csv(selected.items),
         'text/csv; charset=utf-8',{'Content-Disposition':`attachment; filename="varaq-v53-${p.endsWith('-guide.csv')?'reference':'intake'}-${selected.batch}.csv"`,
         'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'});
       const fields=Object.entries({all:'تمام فیلدهای خالی',author:'نویسنده ناقص',publisher:'ناشر ناقص',description:'معرفی کاملاً خالی'});
       const opts=fields.map(([key,label])=>`<option value="${key}" ${key===selected.mode?'selected':''}>${label}</option>`).join('');
       const items=selected.items.map(r=>`<tr><td>${digits(r.id)}</td><td>${esc(r.title)}</td><td>${esc(r.needs.join('، '))}</td><td>${esc(r.isbn||'—')}</td><td>${r.hasCover?'فایل جلد ثبت‌شده':'در انتظار جلد مجاز'}</td><td><a href="/panel/books?edit=${r.id}">ویرایش</a></td></tr>`).join('');
       const nextLink=n=>'/panel/content-workbook?'+new URLSearchParams({missing:selected.mode,q:selected.q,batch:String(n)}).toString();
       return render('کاربرگ تکمیل مستند کتاب‌ها',panelShell(user,`<div class="page-banner"><span class="eyebrow">VARAQ 5.3 · EDITORIAL INTAKE</span><h1>کاربرگ تکمیل اطلاعات کتاب‌ها</h1><p>کاربرگ‌های قابل ورود، حداکثر ۵۰ کتاب در هر بخش؛ فقط کتاب‌هایی با اطلاعات کاملاً خالی.</p></div><div class="soft-warning">فایل خروجی اطلاعات یا منبعی را حدس نمی‌زند. عنوان و شابک در فایل راهنما صرفاً برای تطبیق‌اند؛ لینک منبع چاپ، به‌تنهایی منبع تأیید نویسنده یا معرفی کتاب نیست. برای هر ردیف، منبع مستقل معتبر ثبت و حق استفاده از متن بررسی شود. عکس بدون مجوز منتشر نمی‌شود.</div><div class="quality-stats"><div><strong>${digits(selected.stats.books)}</strong><span>کتاب‌ها</span></div><div><strong>${digits(selected.stats.incomplete)}</strong><span>دارای فیلد خالی</span></div><div><strong>${digits(selected.stats.missingAuthor)}</strong><span>نویسنده ناقص</span></div><div><strong>${digits(selected.stats.missingPublisher)}</strong><span>ناشر ناقص</span></div><div><strong>${digits(selected.stats.missingDescription)}</strong><span>معرفی خالی</span></div><div><strong>${digits(selected.stats.coverMissing)}</strong><span>بدون فایل جلد ثبت‌شده</span></div></div><div class="panel-note"><h2>۱. انتخاب کاربرگ</h2><form action="/panel/content-workbook" method="get" class="form-grid"><label>نوع نقص<select name="missing">${opts}</select></label><label>جست‌وجوی عنوان، شابک، ناشر و شناسه<input name="q" value="${attr(selected.q)}" maxlength="80"></label><button class="cta" type="submit">اعمال فیلتر</button></form><p>${digits(selected.total)} نتیجه · بسته ${digits(selected.batch)} از ${digits(selected.pages)}</p><div class="button-row"><a class="cta" href="/panel/content-workbook.csv?${attr(qs)}">دانلود CSV قابل ورود (${digits(selected.items.length)} کتاب)</a><a class="outline" href="/panel/content-workbook-guide.csv?${attr(qs)}">CSV راهنمای عنوان و شابک</a></div><div class="table-scroll"><table class="data-table"><thead><tr><th>شناسه</th><th>کتاب</th><th>فیلدهای خالی</th><th>شابک مستند</th><th>جلد</th><th>اقدام</th></tr></thead><tbody>${items||'<tr><td colspan="6">کتابی نیازمند ورود گروهی در این فیلتر نیست.</td></tr>'}</tbody></table></div><div class="button-row">${selected.batch>1?`<a class="outline" href="${attr(nextLink(selected.batch-1))}">بسته قبل</a>`:''}${selected.batch<selected.pages?`<a class="outline" href="${attr(nextLink(selected.batch+1))}">بسته بعد</a>`:''}</div></div><div class="panel-note"><h2>۲. تکمیل و ورود بدون بازنویسی</h2><p>CSV اصلی را با اطلاعات تأییدشده، متن معرفی اختصاصی و URL منبع HTTPS تکمیل کنید؛ سطرهای بدون داده را حذف کنید. سپس وارد پنل تکمیل گروهی شوید، ابتدا پیش‌نمایش بگیرید و فقط پس از بررسی ثبت کنید.</p><div class="button-row"><a class="cta" href="/panel/content-batch">ورود فایل تکمیل‌شده و پیش‌نمایش</a><a class="outline" href="/panel/cover-intake">صف تصاویر جلد ناشران</a><a class="outline" href="/panel/catalog-worklist">بررسی سایر کمبودها</a></div><p class="muted tiny">معرفی ناقص ولی غیرخالی با ویرایش تکی اصلاح می‌شود. ذخیره گروهی هیچ متن قبلی را بازنویسی نمی‌کند و پرداخت PDF هنوز غیرفعال است.</p></div>`,'کاربرگ تکمیل اطلاعات ۵.۳'));
     }
     if(p==='/panel/content-batch-template'){if(user.role!=='owner')return bad(res,403,'دسترسی مجاز نیست.',user);return send(res,200,fs.readFileSync(path.join(ROOT,'data','CONTENT_BATCH_TEMPLATE.csv')),'text/csv; charset=utf-8',{'Content-Disposition':'attachment; filename="varaq-content-batch.csv"'});} 
     if(p==='/panel/publisher-outreach'){
       if(user.role!=='owner')return bad(res,403,'دسترسی مجاز نیست.',user);
       const items=publisherOutreach.rows(db),groups=publisherOutreach.groups(items);
       const cards=groups.slice(0,80).map(group=>`<article class="panel-note"><h3>${esc(group.publisher)} · ${digits(group.items.length)} چاپ فاقد جلد مجاز</h3><p class="muted">${digits(group.stocked)} چاپ دارای موجودی فروشگاهی · برای ارسال درخواست اجازه تصویر با شابک تطبیق دهید.</p><div class="table-scroll"><table class="data-table"><thead><tr><th>کتاب</th><th>شابک</th><th>پیگیری مجوز</th></tr></thead><tbody>${group.items.slice(0,15).map(x=>`<tr><td>${esc(x.title)}</td><td dir="ltr">${esc(x.isbn)}</td><td>${esc(x.rights_status)} · <a href="/panel/rights-tracker">ثبت پیگیری</a></td></tr>`).join('')}</tbody></table></div></article>`).join('');
       return render('درخواست جلد از ناشران',panelShell(user,`<div class="panel-note"><h2>بسته آماده مکاتبات ناشران</h2><p>${digits(items.length)} چاپ فاقد جلد قابل‌انتشار در ${digits(groups.length)} ناشر گروه‌بندی شده‌اند. این گزارش فقط پیش‌نویس پیگیری است؛ نامه، تصویر یا مجوز به‌طور خودکار دریافت یا منتشر نمی‌شود.</p><p><a class="outline" href="/panel/publisher-outreach.csv">دانلود CSV کامل برای ارسال به ناشران</a> · <a href="/panel/cover-completion">وضعیت ۲۰۰ کتاب</a> · <a href="/panel/covers">بارگذاری جلد تأییدشده</a></p><p class="soft-warning">پیش از انتشار: شابک دقیق، اجازه استفاده تجاری روی وب‌سایت و فایل جلد واقعی همان چاپ را از صاحب حقوق دریافت کنید.</p></div>${cards||'<p>صف خالی است.</p>'}`,'مکاتبات ناشران'));
     }
     if(p==='/panel/publisher-outreach.csv'){
       if(user.role!=='owner')return bad(res,403,'دسترسی مجاز نیست.',user);
       return send(res,200,publisherOutreach.csv(publisherOutreach.rows(db)),'text/csv; charset=utf-8',{'Content-Disposition':'attachment; filename=varaq-publisher-covers.csv'});
     }
     if(p==='/panel/cover-completion.csv'){if(user.role!=='owner')return bad(res,403,'دسترسی مجاز نیست.',user);return send(res,200,coverCompletion.csv(coverDashboard.select(coverCompletion.rows(db),{q:url.searchParams.get('q'),missing:url.searchParams.get('missing')}).all),'text/csv; charset=utf-8',{'Content-Disposition':'attachment; filename="varaq-cover-completion.csv"'});}
     if(/^\/panel\/pdf-private\/\d+$/.test(p)){const item=pdfStore.privateDownload(db,PDF_DIR,user,p.split('/').pop());if(!item)return bad(res,404,'فایل خصوصی پیدا نشد یا دسترسی ندارید.',user);res.writeHead(200,{'Content-Type':'application/pdf','Content-Disposition':`attachment; filename="varaq-private-${item.row.id}.pdf"`,'Content-Length':item.row.file_bytes,'X-Content-Type-Options':'nosniff','X-Robots-Tag':'noindex, nofollow','Cache-Control':'private,no-store'});fs.createReadStream(item.full).pipe(res);return;}

     if(p==='/panel/account')return render('حساب و امنیت',accountPage(user));
     if(p==='/panel/home-content'){const v=panelHomeContent(user,url);return v?render('صفحه اصلی و بنرها',v):bad(res,403,'دسترسی مجاز نیست.',user);}
     if(p==='/panel/reviews'){const v=panelReviews(user,url);return v?render('نظرات کاربران',v):bad(res,403,'دسترسی مجاز نیست.',user);}
     if(p==='/panel/generated-editorials'){const v=panelGeneratedEditorials(user,url);return v?render('بازبینی معرفی‌ها',v):bad(res,403,'دسترسی مجاز نیست.',user);}
     if(p==='/panel/generated-editorials.csv'){if(user.role!=='owner')return bad(res,403,'دسترسی مجاز نیست.',user);return send(res,200,generatedReview.csv(db,generatedCatalogue),'text/csv; charset=utf-8',{'Content-Disposition':'attachment; filename=varaq-generated-editorials-review.csv','Cache-Control':'private,no-store'});}
     if(p==='/panel/editorial'){const v=panelEditorial(user,url);return v?render('بررسی تخصصی',v):bad(res,403,'دسترسی مجاز نیست.',user);}
     if(p==='/panel/editions'){const v=panelEditions(user,url);return v?render('چاپ‌ها و ترجمه‌ها',v):bad(res,403,'دسترسی مجاز نیست.',user);}
     if(p==='/panel/store-docs'){const v=panelStoreDocs(user,url);return v?render('مدارک و تأیید فروشگاه',v):bad(res,403,'دسترسی مجاز نیست.',user);}
     if(p==='/panel/staff'){const v=panelStaff(user);return v?render('کارکنان فروشگاه',v):bad(res,403,'دسترسی مجاز نیست.',user);}
     if(p==='/panel/stores'){const v=panelStores(user,url);return v?render('کتاب‌فروشی‌ها',v):bad(res,403,'دسترسی مجاز نیست.',user);}
     if(p==='/panel/store-operations'){const v=panelStoreOperations(user,url);return v?render('عملیات فروشگاه‌ها',v):bad(res,403,'دسترسی مجاز نیست.',user);}
     if(p==='/panel/store-operations.csv'){if(user.role!=='owner')return bad(res,403,'گزارش سراسری فقط برای مدیریت YM است.',user);if(url.searchParams.has('store')&&!db.prepare('SELECT id FROM stores WHERE id=?').get(safeId(url.searchParams.get('store'))))return bad(res,400,'فروشگاه معتبر نیست.',user);try{const rows=storeOperations.allStores(db,{storeId:url.searchParams.has('store')?safeId(url.searchParams.get('store')):0,q:str(url.searchParams.get('q'),80),review:url.searchParams.get('review')||'all'});return send(res,200,storeOperations.csv(rows),'text/csv; charset=utf-8',{'Content-Disposition':'attachment; filename="varaq-store-operations.csv"','Cache-Control':'private,no-store'});}catch(e){return bad(res,400,e.message,user);}}
     if(p==='/panel/categories'){const v=panelCategories(user,url);return v?render('مدیریت دسته‌بندی‌ها',v):bad(res,403,'دسترسی مجاز نیست.',user);}
     if(p==='/panel/import'){const v=panelImport(user);return v?render('ورود گروهی کتاب‌ها',v):bad(res,403,'دسترسی مجاز نیست.',user);}
     if(p==='/panel/covers'){const v=panelCovers(user,url);return v?render('تصاویر جلد',v):bad(res,403,'دسترسی مجاز نیست.',user);}
     if(p==='/panel/bibliography'){const v=panelBibliography(user,url);return v?render('شناسنامه و جلد واقعی',v):bad(res,403,'دسترسی مجاز نیست.',user);}
     if(p==='/panel/editorial-batch'){const v=panelEditorialBatch(user);return v?render('معرفی تألیفی کتاب‌ها',v):bad(res,403,'دسترسی مجاز نیست.',user);}
     if(p==='/panel/editorial-batch-31'){const v=panelEditorialBatchV31(user);return v?render('۱۳۴ معرفی جدید',v):bad(res,403,'دسترسی مجاز نیست.',user);}
     if(p==='/panel/catalog-quality'){const v=panelCatalogQuality(user,url);return v?render('کیفیت بانک کتاب',v):bad(res,403,'دسترسی مجاز نیست.',user);}
     if(p==='/panel/publication-review'){const v=panelPublicationReview(user,url);return v?render('ارزیابی انتشار محتوا',v):bad(res,403,'دسترسی مجاز نیست.',user);}
     if(p==='/panel/publication-review.csv'){if(user.role!=='owner')return bad(res,403,'دسترسی مجاز نیست.',user);return send(res,200,publicationReview.csv(publicationReview.filter(publicationReview.rows(db),url.searchParams.get('status')||'all',str(url.searchParams.get('q'),80))),'text/csv; charset=utf-8',{'Content-Disposition':'attachment; filename="varaq-publication-review.csv"','Cache-Control':'private,no-store'});}
     if(p==='/panel/cover-research'){const v=panelCoverResearch(user,url);return v?render('جست‌وجوی تصویر جلد واقعی',v):bad(res,403,'دسترسی مجاز نیست.',user);}
     if(p==='/panel/rights-tracker'){const v=panelRightsTracker(user,url);return v?render('پیگیری مجوز تصاویر',v):bad(res,403,'دسترسی مجاز نیست.',user);}
     if(p==='/panel/rights-tracker.csv'){if(user.role!=='owner')return bad(res,403,'دسترسی مجاز نیست.',user);return send(res,200,coverRights.csv(db),'text/csv; charset=utf-8',{'Content-Disposition':'attachment; filename="varaq-rights-requests.csv"'});}
     if(p==='/panel/cover-rights.csv'){if(user.role!=='owner')return bad(res,403,'دسترسی مجاز نیست.',user);return send(res,200,coverResearch.rightsExport(db),'text/csv; charset=utf-8',{'Content-Disposition':'attachment; filename="varaq-cover-rights.csv"'});}
     if(p==='/panel/cover-research.csv'){if(user.role!=='owner')return bad(res,403,'دسترسی مجاز نیست.',user);return send(res,200,coverResearch.csv(db),'text/csv; charset=utf-8',{'Content-Disposition':'attachment; filename="varaq-online-cover-research.csv"'});}
     if(p==='/panel/bibliographic-review'||p==='/panel/bibliographic-review.csv'){
       if(user.role!=='owner')return bad(res,403,'این پرونده‌ها فقط برای مدیریت YM است.',user);
       const all=bibliographicReviewV83.all(db);
       const chosen=bibliographicReviewV83.select(all,{mode:url.searchParams.get('mode'),q:url.searchParams.get('q'),page:url.searchParams.get('page')});
       if(p.endsWith('.csv'))return send(res,200,bibliographicReviewV83.csv(chosen.all),'text/csv; charset=utf-8',{
         'Content-Disposition':'attachment; filename="varaq-v83-bibliographic-review.csv"','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'});
       const stats=bibliographicReviewV83.summary(all),params={mode:chosen.mode,q:chosen.q};
       const selectOpts=Object.entries({...bibliographicReviewV83.STATES,pending:'در انتظار بازبینی',missing:'دارای مشخصات ناقص',all:'همه کتاب‌ها'}).map(([k,v])=>`<option value="${k}" ${k===chosen.mode?'selected':''}>${esc(v)}</option>`).join('');
       const bookId=safeId(url.searchParams.get('book'));
       const focus=bookId?all.find(x=>x.id===bookId):null;
       const options=Object.entries(bibliographicReviewV83.STATES).filter(([k])=>k!=='stale').map(([k,v])=>`<option value="${k}" ${k===(focus?.last_saved_status||'draft')?'selected':''}>${esc(v)}</option>`).join('');
       const history=focus?bibliographicReviewV83.history(db,focus.id):[];
       const detail=focus?`<section class="panel-note v83-review-editor" id="review-editor"><h2>پرونده ${digits(focus.id)} · ${esc(focus.title)}</h2><p>وضعیت فعلی: <strong>${esc(bibliographicReviewV83.STATES[focus.status])}</strong> · آخرین نسخه: ${digits(focus.revision)}</p><p class="muted tiny">نویسنده: ${esc(focus.author||'نامشخص')} · ناشر: ${esc(focus.publisher||'نامشخص')} · شابک‌ها: ${esc(focus.isbns||'ثبت‌نشده')} · چاپ مستند: ${digits(focus.source_editions)}</p><p class="muted tiny">${focus.missing.length?'نواقص: '+esc(focus.missing.join('، ')):'فیلدهای لازم موجودند؛ صحت آن‌ها باید توسط انسان با منبع تطبیق داده شود.'}</p><form method="post" action="/panel/bibliographic-review-save" class="form-grid">${csrfInput(user)}<input type="hidden" name="book_id" value="${focus.id}"><input type="hidden" name="revision" value="${focus.revision}"><input type="hidden" name="fingerprint" value="${focus.signature}"><label>وضعیت بازبینی<select name="status">${options}</select></label><label>آدرس منبع مستند (HTTPS)<input name="source_url" type="url" dir="ltr" maxlength="800" value="${attr(focus.source_url)}" placeholder="https://..."></label><label class="full">یادداشت تطبیق چاپ و شناسنامه<textarea name="notes" maxlength="1000" rows="4">${esc(focus.notes)}</textarea></label><label class="check-row full"><input type="checkbox" name="confirm" value="1"> شناسنامه و چاپ را شخصاً با منبع بررسی کرده‌ام؛ این تأیید، مجوز جلد/PDF یا تأیید فروش نیست.</label><button class="cta">ذخیره پرونده و ثبت تاریخچه</button></form><div class="button-row"><a class="outline" href="/panel/books?edit=${focus.id}">اصلاح اطلاعات</a><a class="outline" href="/panel/bibliography?book=${focus.id}">ثبت منبع چاپ</a><a class="outline" href="/panel/covers?book=${focus.id}">مدیریت جلد</a></div>${history.length?`<details><summary>تاریخچه ثبت (${history.length})</summary><ol>${history.map(h=>`<li>نسخه ${digits(h.revision)} · ${esc(h.created_at)} · ${esc(h.actor||'کاربر حذف‌شده')} · ${esc(h.previous_status)} ← ${esc(h.new_status)}</li>`).join('')}</ol></details>`:''}</section>`:bookId?'<div class="soft-warning">کتاب انتخابی یافت نشد.</div>':'';
       const entries=chosen.items.map(b=>`<article class="v83-fact-item"><div><h3>${digits(b.id)} · ${esc(b.title)}</h3><p class="muted tiny">${esc(b.author||'نویسنده نامشخص')} · ${esc(b.publisher||'ناشر نامشخص')} · ${esc(b.isbns||'فاقد شابک')}</p><p><strong>${esc(bibliographicReviewV83.STATES[b.status])}</strong> · ${digits(b.source_editions)} چاپ مستند ${b.missing.length?'· نواقص: '+esc(b.missing.join('، ')):''}</p></div><a class="outline" href="/panel/bibliographic-review?${new URLSearchParams({...params,book:String(b.id)}).toString()}#review-editor">بررسی پرونده</a></article>`).join('');
       const pageUrl=n=>'/panel/bibliographic-review?'+new URLSearchParams({...params,page:String(n)}).toString();
       return render('بررسی مستند شناسنامه کتاب‌ها',panelShell(user,`<div class="page-banner"><span class="eyebrow">VARAQ 8.3 · HUMAN EVIDENCE REVIEW</span><h1>میز تأیید مستند شناسنامه کتاب‌ها</h1><p>ثبت منبع، نتیجه بررسی انسانی و سابقه تغییرات برای هر کتاب؛ بدون تغییر اطلاعات کتاب یا مجوزهای نشر.</p></div><div class="soft-warning">تأیید شناسنامه فقط یک سابقه داخلی است؛ مجوز بازنشر جلد و حق فروش PDF مستقل هستند. اگر اطلاعات کتاب یا چاپ عوض شود، تأیید قبلی منقضی و وضعیت «بازبینی مجدد» نمایش داده می‌شود.</div><div class="quality-stats">${[['کتاب‌های بانک',stats.total],['بازبینی معتبر فعلی',stats.reviewed],['نیازمند بازبینی مجدد',stats.stale],['دارای نواقص',stats.missing],['منتظر بررسی',stats.pending]].map(([k,v])=>`<div><strong>${digits(v)}</strong><span>${esc(k)}</span></div>`).join('')}</div>${detail}<section class="panel-note"><h2>صف پرونده‌ها</h2><form class="filterbar" action="/panel/bibliographic-review" method="get"><label>فیلتر<select name="mode">${selectOpts}</select></label><label>عنوان، نویسنده، ناشر یا شابک<input type="search" name="q" maxlength="80" value="${attr(chosen.q)}"></label><button class="cta">نمایش</button></form><p>${digits(chosen.total)} نتیجه · صفحه ${digits(chosen.page)} از ${digits(chosen.pages)} · <a class="outline" href="/panel/bibliographic-review.csv?${new URLSearchParams(params).toString()}">دریافت گزارش CSV</a></p><div class="v83-review-list">${entries||'<p class="empty">نتیجه‌ای پیدا نشد.</p>'}</div><div class="button-row">${chosen.page>1?`<a class="outline" href="${attr(pageUrl(chosen.page-1))}">صفحه قبل</a>`:''}${chosen.page<chosen.pages?`<a class="outline" href="${attr(pageUrl(chosen.page+1))}">صفحه بعد</a>`:''}</div></section>`,'شناسنامه کتاب‌ها · ۸.۳'));
     }
     if(p==='/panel/catalog-readiness'||p==='/panel/catalog-readiness.csv'){
       if(user.role!=='owner')return bad(res,403,'این گزارش فقط برای مدیریت مرکزی YM است.',user);
       const rows=catalogReadinessV82.scan(db,{root:ROOT,dataDir:DATA_DIR,catalogue:generatedCatalogue});
       const chosen=catalogReadinessV82.select(rows,{mode:url.searchParams.get('mode'),q:url.searchParams.get('q'),page:url.searchParams.get('page')});
       if(p.endsWith('.csv'))return send(res,200,catalogReadinessV82.csv(chosen.all),'text/csv; charset=utf-8',{
         'Content-Disposition':'attachment; filename="varaq-v82-catalog-readiness.csv"','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'});
       const stat=catalogReadinessV82.summary(rows);
       const opts=Object.entries(catalogReadinessV82.MODES).map(([k,v])=>`<option value="${k}" ${chosen.mode===k?'selected':''}>${esc(v)}</option>`).join('');
       const params={mode:chosen.mode,q:chosen.q};
       const nav=n=>'/panel/catalog-readiness?'+new URLSearchParams({...params,page:String(n)}).toString();
       const exportUrl='/panel/catalog-readiness.csv?'+new URLSearchParams(params).toString();
       const labels={art:'طرح یا تصویر کوچک ناقص/خراب',intro:'معرفی موجود نیست',editorial:'معرفی تولیدی نیازمند بازبینی',author:'نام نویسنده ناقص',publisher:'ناشر ثبت نشده',sources:'منبع مستند چاپ یافت نشد',cover:'جلد واقعی سالم محلی ثبت نشده'};
       const entries=chosen.items.map(b=>`<article class="v82-quality-item"><div class="v82-quality-visual"><img src="/concept-thumb/book-${String(b.id).padStart(3,'0')}.webp?v=983" alt="طرح گرافیکی ورق برای ${attr(b.title)}؛ جلد ناشر نیست" loading="lazy" width="120" height="168"><span>طرح اختصاصی؛ نه جلد ناشر</span></div><div class="v82-quality-body"><div class="finishing-head"><div><h3>${digits(b.id)} · ${esc(b.title)}</h3><p class="muted tiny">${esc(b.author||'نویسنده نامشخص')} · ${esc(b.category)}</p></div><span class="finishing-count">${digits(b.issues.length)} مورد پیگیری</span></div><div class="v82-quality-flags"><span>${b.art_ok&&b.thumb_ok?'✓ دو تصویر گرافیکی سالم':'! تصویر گرافیکی ناقص'}</span><span>${b.local_cover?'✓ فایل جلد محلی سالم':'! جلد محلی ثبت نشده'}</span><span>${b.custom_intro?'متن مدیر':b.generated_intro?'پیش‌نویس معرفی':'بدون معرفی'}</span><span>${b.editorial_status==='approved'?'بازبینی تأییدشده':'وضعیت تحریریه: '+esc(b.editorial_status)}</span><span>${digits(b.source_editions)} چاپ منبع‌دار</span></div><p class="finishing-gaps">${b.issues.map(i=>`<span>${esc(labels[i])}</span>`).join('')||'<span class="done">چک‌های فنی عبور کردند؛ صحت اطلاعات و مجوزها هنوز نیازمند بررسی انسانی است</span>'}</p><div class="button-row"><a class="outline" href="/panel/books?edit=${b.id}">ویرایش معرفی</a><a class="outline" href="/panel/generated-editorials?q=${encodeURIComponent(b.title)}">بررسی تحریریه</a><a class="outline" href="/panel/bibliography?book=${b.id}">منبع چاپ</a><a class="outline" href="/panel/covers?book=${b.id}">جلد کتاب</a><a class="outline" href="/book/${encodeURIComponent(b.slug)}">مشاهده صفحه</a></div></div></article>`).join('');
       const metrics=[['کتاب‌های بانک',stat.total],['دو تصویر گرافیکی سالم',stat.withArtwork],['دارای معرفی اولیه',stat.withGeneratedIntro],['معرفی مدیر یا بازبینی‌شده',stat.editorialApproved],['جلد محلی سالم',stat.localCovers],['دارای چاپ منبع‌دار',stat.documentedEditions],['نویسنده ناقص',stat.missingAuthor],['دارای مورد پیگیری',stat.needsAttention]];
       return render('داشبورد کیفیت ۲۰۰ کتاب',panelShell(user,`<div class="page-banner"><span class="eyebrow">VARAQ 8.2 · LIVE CATALOG REPORT</span><h1>داشبورد کیفیت کتاب‌ها و تصاویر</h1><p>کنترل لحظه‌ای سلامت طرح‌های گرافیکی، معرفی کتاب‌ها، بازبینی تحریریه، منابع چاپ و فایل جلد واقعی.</p></div><div class="soft-warning">طرح اختصاصی صرفاً تصویر معرفی است و جلد ناشر محسوب نمی‌شود. فایل جلد سالم، تأیید چاپ یا متن تولیدی، به‌تنهایی اثبات صحت اطلاعات و حق نشر نیست. هیچ داده یا مجوزی در این گزارش خودکار تکمیل و تأیید نمی‌شود.</div><div class="quality-stats v82-summary">${metrics.map(([k,v])=>`<div><strong>${digits(v)}</strong><span>${esc(k)}</span></div>`).join('')}</div><div class="panel-note"><form method="get" action="/panel/catalog-readiness" class="filterbar v82-filter"><label>فیلتر اقدامات<select name="mode">${opts}</select></label><label>عنوان، نویسنده، ناشر یا شناسه<input type="search" name="q" value="${attr(chosen.q)}" maxlength="80" placeholder="مثلاً ملت عشق"></label><button class="cta">نمایش موارد</button></form><p class="v82-list-meta">${digits(chosen.total)} نتیجه · صفحه ${digits(chosen.page)} از ${digits(chosen.pages)} · <a class="outline" href="${attr(exportUrl)}">خروجی CSV همین فیلتر</a></p><div class="v82-quality-list">${entries||'<p class="empty">موردی با این فیلتر پیدا نشد.</p>'}</div><nav class="button-row v82-pages" aria-label="صفحه‌بندی فهرست کیفیت">${chosen.page>1?`<a class="outline" href="${attr(nav(chosen.page-1))}">صفحه پیش</a>`:''}${chosen.page<chosen.pages?`<a class="outline" href="${attr(nav(chosen.page+1))}">صفحه بعد</a>`:''}</nav></div>`,'داشبورد کیفیت نسخه ۸.۲'));
     }
     if(p==='/panel/catalog-consistency'||p==='/panel/catalog-consistency.csv'){
       if(user.role!=='owner')return bad(res,403,'گزارش کیفیت شابک و محتوا فقط برای مدیریت مرکزی YM است.',user);
       const rows=catalogConsistency.scan(db,DATA_DIR);
       const result=catalogConsistency.select(rows,{mode:url.searchParams.get('issue')||'all',q:url.searchParams.get('q')||'',page:url.searchParams.get('page')||1});
       if(p.endsWith('.csv'))return send(res,200,catalogConsistency.csv(result.all),'text/csv; charset=utf-8',{
        'Content-Disposition':'attachment; filename="varaq-catalog-consistency-v56.csv"','Cache-Control':'private,no-store','X-Content-Type-Options':'nosniff'});
       const totals=catalogConsistency.summary(rows);
       const filters=[['all','همه عنوان‌ها'],['priority','خطاهای اولویت بالا'],['isbn','مشکل شابک'],['duplicates','عنوان یا شابک تکراری'],['description','کیفیت معرفی'],['cover','جلد آسیب‌دیده'],['missing','اطلاعات ناقص'],['clean','بدون هشدار فنی']];
       const opts=filters.map(([key,label])=>`<option value="${key}" ${result.mode===key?'selected':''}>${label}</option>`).join('');
       const params={issue:result.mode,q:result.q};
       const nav=page=>'/panel/catalog-consistency?'+new URLSearchParams({...params,page:String(page)}).toString();
       const csvLink='/panel/catalog-consistency.csv?'+new URLSearchParams(params).toString();
       const cards=result.items.map(r=>`<article class="finishing-entry"><div class="finishing-head"><div><h3>${digits(r.id)} · ${esc(r.title)}</h3><p class="muted tiny">${esc(r.author||'نویسنده ثبت نشده')} · ${esc(r.publisher||'ناشر ثبت نشده')} · شابک: ${esc(r.isbns||'ثبت نشده')}</p></div><span class="finishing-count">${digits(r.issues.length)} هشدار</span></div><p class="finishing-gaps">${r.issues.map(x=>`<span>${esc(x.label)}${x.details?' · '+esc(x.details):''}</span>`).join('')||'<span class="done">هشدار خودکار ثبت نشد؛ بررسی انسانی اعتبار محتوا و مجوزها همچنان لازم است</span>'}</p><div class="button-row"><a class="outline" href="/panel/books?edit=${r.id}">اصلاح اطلاعات</a><a class="outline" href="/panel/bibliography?book=${r.id}">بررسی شناسنامه چاپ</a><a class="outline" href="/panel/finishing-desk?q=${r.id}">صف تکمیل کتاب</a></div></article>`).join('');
       const metric=[['کل کتاب‌ها',totals.books],['نیازمند بررسی',totals.needingReview],['اولویت بالا',totals.critical],['شابک نامعتبر',totals.invalidISBN],['عنوان مشابه',totals.duplicateTitle],['جلد خرابِ ثبت‌شده',totals.damagedCover]];
       return render('ممیزی کیفیت کتاب‌ها',panelShell(user,`<div class="page-banner"><span class="eyebrow">VARAQ 5.6 · CATALOG CONSISTENCY</span><h1>کنترل کیفیت شابک و اطلاعات کتاب‌ها</h1><p>کنترل فنی شماره شابک، عناوین احتمالاً تکراری، متن معرفی و سلامت جلد ثبت‌شده؛ بدون ادغام یا تغییر خودکار داده‌ها.</p></div><div class="soft-warning">این ابزار صحت واقعی ISBN برای یک چاپ خاص، مالکیت تصاویر یا مجوز فروش PDF را تأیید نمی‌کند. مشابه‌بودن عنوان لزوماً تکراری بودن اثر نیست. تمام هشدارها باید پیش از اصلاح توسط انسان با منبع معتبر بررسی شوند. پرداخت آنلاین همچنان غیرفعال است.</div><div class="quality-stats">${metric.map(([label,num])=>`<div><strong>${digits(num)}</strong><span>${label}</span></div>`).join('')}</div><div class="panel-note"><form class="filterbar" method="get" action="/panel/catalog-consistency"><label>گروه هشدار<select name="issue">${opts}</select></label><label>نام، نویسنده، ناشر یا شابک<input name="q" maxlength="80" value="${attr(result.q)}"></label><button class="cta">فیلتر</button></form><p>${digits(result.total)} کتاب · صفحه ${digits(result.page)} از ${digits(result.totalPages)} · <a class="outline" href="${attr(csvLink)}">دریافت CSV همین فیلتر</a></p><div class="finishing-list">${cards||'<p>موردی برای این فیلتر پیدا نشد.</p>'}</div><div class="button-row">${result.page>1?`<a class="outline" href="${attr(nav(result.page-1))}">صفحه قبل</a>`:''}${result.page<result.totalPages?`<a class="outline" href="${attr(nav(result.page+1))}">صفحه بعد</a>`:''}</div></div>`,'کنترل کیفیت کتابخانه ۵.۶'));
     }
     if(p==='/panel/finishing-desk'||p==='/panel/finishing-desk.csv'){
       if(user.role!=='owner')return bad(res,403,'این بخش فقط برای مدیریت مرکزی YM است.',user);
       const rows=finishingDesk.scan(db,DATA_DIR);
       const result=finishingDesk.select(rows,{mode:url.searchParams.get('status')||'all',q:url.searchParams.get('q')||'',page:url.searchParams.get('page')||1});
       if(p.endsWith('.csv'))return send(res,200,finishingDesk.csv(result.all),'text/csv; charset=utf-8',{'Content-Disposition':'attachment; filename="varaq-finishing-desk.csv"','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'});
       const filterOptions=[['all','همه کتاب‌ها'],['cover','فاقد فایل جلد سالم'],['author','فاقد نویسنده'],['publisher','فاقد ناشر در فهرست اصلی'],['description','بدون معرفی'],['source','فاقد منبع چاپ'],['stock','دارای موجودی مرتبط']].map(([k,v])=>`<option value="${k}" ${result.mode===k?'selected':''}>${v}</option>`).join('');
       const params={status:result.mode,q:result.q};
       const route=page=>'/panel/finishing-desk?'+new URLSearchParams({...params,page:String(page)}).toString();
       const issueLabels={cover:'جلد سالم',author:'نویسنده',publisher:'ناشر',description:'معرفی',source:'مدرک چاپ'};
       const records=result.items.map(b=>`<article class="finishing-entry"><div class="finishing-head"><div><h3>${digits(b.id)} · ${esc(b.title)}</h3><p class="muted">${esc(b.category)} · ${digits(b.stocked_skus)} کالای دارای موجودی · ${digits(b.documented_editions)} چاپ منبع‌دار</p></div><span class="finishing-count">${digits(b.gaps.length)} نقص فنی</span></div><p class="finishing-gaps">${b.gaps.map(g=>`<span>${esc(issueLabels[g])}</span>`).join('')||'<span class="done">اطلاعات اصلی ثبت‌شده؛ بررسی انسانی حقوق و محتوا همچنان لازم است</span>'}</p><div class="button-row"><a class="outline" href="/panel/books?edit=${b.id}">ویرایش اطلاعات</a><a class="outline" href="/panel/catalog-quality?book=${b.id}">بررسی منابع و متن</a><a class="outline" href="/panel/bibliography?book=${b.id}">شناسنامه چاپ</a>${b.upload_isbn?`<a class="cta" href="/panel/cover-web-upload?isbn=${encodeURIComponent(b.upload_isbn)}">بارگذاری جلد همین چاپ</a>`:'<a class="outline" href="/panel/editions?book='+b.id+'">ثبت چاپ معتبر</a>'}</div></article>`).join('');
       const csvLink='/panel/finishing-desk.csv?'+new URLSearchParams(params).toString();
       return render('میز کار تکمیل کتابخانه',panelShell(user,`<div class="page-banner"><span class="eyebrow">VARAQ 5.6 · CATALOG FINISHING DESK</span><h1>میز کار تکمیل کتابخانه</h1><p>اولویت رسیدگی به اطلاعات و جلدها، بر پایه داده‌های همین نصب؛ موارد دارای موجودی در ابتدای صف.</p></div><div class="soft-warning">این میز کار هیچ اطلاعات، تصویر یا مجوزی تولید و تأیید نمی‌کند. «فایل جلد سالم» به معنی تأیید حقوق انتشار نیست. فروش و دانلود پولی همچنان غیرفعال است.</div><div class="quality-stats">${[['کتاب‌ها',result.stats.books],['دارای نقص فنی',result.stats.incomplete],['فاقد جلد سالم',result.stats.missingCovers],['نویسنده خالی',result.stats.missingAuthor],['معرفی خالی',result.stats.missingDescriptions]].map(([k,v])=>`<div><strong>${digits(v)}</strong><span>${k}</span></div>`).join('')}</div><div class="panel-note"><form method="get" action="/panel/finishing-desk" class="filterbar"><label>نوع اقدام<select name="status">${filterOptions}</select></label><label>جست‌وجوی کتاب یا شابک<input name="q" maxlength="80" value="${attr(result.q)}"></label><button class="cta">نمایش</button></form><p>${digits(result.total)} نتیجه · صفحه ${digits(result.page)} از ${digits(result.totalPages)} · <a class="outline" href="${attr(csvLink)}">CSV همین فیلتر</a></p><div class="finishing-list">${records||'<p>موردی برای این فیلتر پیدا نشد.</p>'}</div><div class="button-row">${result.page>1?`<a class="outline" href="${attr(route(result.page-1))}">صفحه قبل</a>`:''}${result.page<result.totalPages?`<a class="outline" href="${attr(route(result.page+1))}">صفحه بعد</a>`:''}</div></div>`,'تکمیل کتابخانه ۵.۶'));
     }
     if(p==='/panel/cover-web-upload'){
       if(user.role!=='owner')return bad(res,403,'بارگذاری جلدها فقط برای مدیریت مرکزی YM مجاز است.',user);
       const requestedIsbn=str(url.searchParams.get('isbn'),18);
       const pendingEdition=coverIntake.pending(db).find(x=>x.isbn===requestedIsbn);
       const fields=Array.from({length:coverWebIntake.MAX_IMAGES},(_,i)=>{
         const n=i+1;
         return `<fieldset class="cover-web-entry"><legend>جلد ${digits(n)} — ${n===1?'الزامی':'اختیاری'}</legend><label>شابک چاپ تأییدشده<input name="isbn_${n}" dir="ltr" pattern="[0-9 -]{10,18}" placeholder="978..." ${n===1?'required':''} maxlength="18" value="${n===1&&pendingEdition?attr(pendingEdition.isbn):''}"></label><label>تصویر واقعی همان چاپ (JPG/PNG/WebP، حداکثر ۷۰۰ کیلوبایت)<input type="file" name="cover_${n}" data-cover-preview="${n}" accept="image/png,image/jpeg,image/webp" ${n===1?'required':''}></label><div class="cover-local-preview" data-cover-slot="${n}" role="status" aria-live="polite">پیش‌نمایش تصویر انتخاب‌نشده</div><label>منبع تصویر یا نام صاحب حقوق<input name="source_${n}" maxlength="160" ${n===1?'required':''}></label><label>مبنای مجوز استفاده تجاری<input name="rights_note_${n}" minlength="12" maxlength="240" ${n===1?'required':''}></label><label>شاهد تطبیق تصویر با شابک<input name="match_evidence_${n}" minlength="8" maxlength="300" ${n===1?'required':''}></label><label>مرجع سند اجازه ناشر/صاحب حقوق<input name="permission_evidence_${n}" minlength="12" maxlength="300" ${n===1?'required':''}></label></fieldset>`;
       }).join('');
       return render('بارگذاری گروهی جلدهای مجاز',panelShell(user,`<div class="page-banner"><span class="eyebrow">VARAQ 5.6 · GUIDED COVER UPLOAD</span><h1>بارگذاری چند جلد از مرورگر</h1><p>بدون نیاز به فایل BAT: انتخاب حداکثر سه تصویر و ثبت هم‌زمان اطلاعات حقوقی مرتبط با هر شابک.</p></div><div class="soft-warning">فقط عکس واقعی همان چاپ را همراه با سند اجازه انتشار تجاری وارد کنید. وجود تصویر در اینترنت یا دریافت از ناشر به‌تنهایی مجوز بازنشر نیست. اگر یکی از پرونده‌ها نامعتبر باشد، هیچ‌کدام ثبت نمی‌شوند. پرداخت PDF همچنان غیرفعال است.</div>${pendingEdition?`<div class="panel-note cover-edition-context"><h2>چاپ انتخاب‌شده از صف پیگیری</h2><p><b>${esc(pendingEdition.title)}</b> · ${esc(pendingEdition.publisher||'ناشر نامشخص')} · شابک <code dir="ltr">${esc(pendingEdition.isbn)}</code></p><p>${digits(pendingEdition.stock_count)} فروشگاه دارای موجودی مرتبط · این اطلاعات فقط برای تطبیق انسانی است.</p>${/^https:\/\/[^\s]+$/i.test(pendingEdition.source_url||'')?`<a href="${attr(pendingEdition.source_url)}" target="_blank" rel="noopener noreferrer nofollow">مشاهده شناسنامه منبع</a>`:''}</div>`:''}<div class="panel-note"><h2>مرحله ۱: انتخاب تصاویر و اسناد</h2><p>فیلدهای جلد دوم و سوم اختیاری‌اند؛ هر جلد انتخاب‌شده باید تمام مدارک را داشته باشد. تصاویر از URL دانلود نمی‌شوند.</p><form method="post" action="/panel/cover-web-upload" enctype="multipart/form-data" class="form-grid">${csrfInput(user)}${fields}<label class="check-row full"><input type="checkbox" name="confirm" value="1" required> تطبیق شابک و حق استفاده تجاری تمام تصاویر انتخاب‌شده را با سند بررسی کرده‌ام.</label><div class="button-row full"><button class="outline" name="mode" value="preview">بررسی بدون ثبت</button><button class="cta" name="mode" value="apply">بررسی و ثبت یک‌جای تصاویر</button></div></form><p class="muted tiny">در حالت بررسی بدون ثبت، برای ثبت نهایی لازم است تصاویر را دوباره انتخاب کنید. نسخه قدیمی CSV + BAT نیز در دسترس است.</p><a href="/panel/cover-intake">فهرست جلدهای موردنیاز و الگوی CSV</a></div>`,'بارگذاری جلدهای واقعی ۵.۶'));
     }
     if(p==='/panel/cover-intake'||p==='/panel/cover-intake-worklist.csv'||p==='/panel/cover-intake-manifest.csv'){
       if(user.role!=='owner')return bad(res,403,'صف دریافت جلد فقط برای مدیریت مرکزی YM است.',user);
       const all=coverIntake.pending(db),q=str(url.searchParams.get('q'),90),matched=coverIntake.filter(all,q);
       const notice=str(url.searchParams.get('notice'),120);
       if(p==='/panel/cover-intake-worklist.csv')return send(res,200,coverIntake.worklistCsv(matched),'text/csv; charset=utf-8',{'Content-Disposition':'attachment; filename="varaq-cover-intake-worklist.csv"','Cache-Control':'private,no-store'});
       if(p==='/panel/cover-intake-manifest.csv')return send(res,200,coverIntake.importManifestTemplate(matched.slice(0,150)),'text/csv; charset=utf-8',{'Content-Disposition':'attachment; filename="varaq-cover-import-template.csv"','Cache-Control':'private,no-store'});
       const pages=Math.max(1,Math.ceil(matched.length/25)),page=Math.max(1,Math.min(pages,Number.parseInt(url.searchParams.get('page')||'1',10)||1));
       const group=matched.slice((page-1)*25,page*25);
       const qs=new URLSearchParams({q}),download='?'+qs.toString();
       const entry=group.map(x=>`<tr><td>${esc(x.title)}</td><td><code dir="ltr">${esc(x.isbn)}</code></td><td>${esc(x.publisher||'ثبت نشده')}</td><td>${x.stock_count?digits(x.stock_count)+' فروشگاه':'بدون موجودی مرتبط'}</td><td>${/^https:\/\/[^\s]+$/i.test(x.source_url||'')?`<a href="${attr(x.source_url)}" target="_blank" rel="noopener noreferrer nofollow">منبع چاپ</a>`:'منبع چاپ ندارد'}</td><td><a href="/panel/bibliography?book=${x.book_id}">بررسی چاپ و مجوز</a> · <a href="/panel/cover-web-upload?isbn=${encodeURIComponent(x.isbn)}">ارسال جلد</a></td></tr>`).join('');
       return render('دریافت گروهی جلد کتاب‌ها',panelShell(user,`<div class="page-banner"><span class="eyebrow">VARAQ 5.6 · COVER INTAKE</span><h1>آماده‌سازی تصاویر واقعی جلد</h1><p>فهرست چاپ‌های دارای شابک معتبر که هنوز تصویر واردشده ندارند؛ مرتب‌شده با اولویت موجودی کتاب‌فروشی.</p></div>${notice?`<div class="flash" role="status">${esc(notice)}</div>`:``}<div class="soft-warning">در این صفحه تصویری خودکار از اینترنت دریافت یا منتشر نمی‌شود. فایل تصویر باید دقیقاً متعلق به همان شابک باشد و اجازه استفاده تجاری با مدرک معتبر ثبت شود. وجود لینک شناسنامه، اجازه کپی عکس نیست.</div><div class="quality-stats"><div><strong>${digits(all.length)}</strong><span>چاپ در صف دریافت</span></div><div><strong>${digits(all.filter(x=>x.stock_count>0).length)}</strong><span>دارای موجودی مرتبط</span></div><div><strong>${digits(all.filter(x=>x.source_url).length)}</strong><span>دارای منبع چاپ ثبت‌شده</span></div></div><div class="panel-note"><h2>خروجی آماده برای جمع‌آوری از ناشران</h2><p>ابتدا فهرست پیگیری را برای تطبیق شابک ارسال کنید. پس از دریافت تصاویر و اجازه حقوقی، ستون‌های الگوی ورود را تکمیل کنید. ورود با <code>IMPORT_COVERS_WINDOWS.bat</code> و پیش‌نمایش بدون ثبت انجام می‌شود.</p><div class="button-row"><a class="outline" href="/panel/cover-intake-worklist.csv${attr(download)}">CSV پیگیری چاپ‌ها</a><a class="outline" href="/panel/cover-intake-manifest.csv${attr(download)}">الگوی شش‌ستونی ورود جلد (حداکثر ۱۵۰)</a><a class="cta" href="/panel/cover-web-upload">بارگذاری مستقیم ۱ تا ۳ جلد در مرورگر</a><a class="outline" href="/panel/media-integrity">بررسی سلامت فایل‌های موجود</a></div><form method="get" class="filterbar"><label>عنوان، ناشر یا شابک<input name="q" maxlength="90" value="${attr(q)}"></label><button class="cta">جست‌وجو</button></form><p>${digits(matched.length)} نتیجه · صفحه ${digits(page)} از ${digits(pages)}</p><div class="table-scroll"><table class="data-table"><thead><tr><th>کتاب</th><th>شابک</th><th>ناشر</th><th>موجودی</th><th>شناسنامه</th><th>پیگیری</th></tr></thead><tbody>${entry||'<tr><td colspan="6">چاپی برای این فیلتر پیدا نشد.</td></tr>'}</tbody></table></div><div class="button-row">${page>1?`<a class="outline" href="/panel/cover-intake?q=${encodeURIComponent(q)}&page=${page-1}">صفحه قبل</a>`:''}${page<pages?`<a class="outline" href="/panel/cover-intake?q=${encodeURIComponent(q)}&page=${page+1}">صفحه بعد</a>`:''}</div></div>`,'دریافت گروهی جلد'));
     }
     if(p==='/panel/media-integrity'||p==='/panel/media-integrity.csv'){
       if(user.role!=='owner')return bad(res,403,'گزارش سلامت فایل‌ها فقط برای مدیریت مرکزی است.',user);
       const mode=['all','problems','covers','pdf','missing','ok'].includes(url.searchParams.get('status'))?url.searchParams.get('status'):'problems';
       const q=str(url.searchParams.get('q'),80);
       const all=mediaIntegrity.safeRows(db,DATA_DIR),filtered=mediaIntegrity.filter(all,mode,q),stats=mediaIntegrity.summary(all);
       if(p.endsWith('.csv'))return send(res,200,mediaIntegrity.csv(filtered),'text/csv; charset=utf-8',{'Content-Disposition':'attachment; filename="varaq-media-integrity.csv"','Cache-Control':'private,no-store'});
       const pages=Math.max(1,Math.ceil(filtered.length/30)),pageNum=Math.min(pages,Math.max(1,parseInt(url.searchParams.get('page')||'1',10)||1));
       const shown=filtered.slice((pageNum-1)*30,pageNum*30);
       const select=[['problems','نیازمند اقدام'],['all','همه'],['covers','تصاویر جلد'],['pdf','فایل‌های PDF'],['missing','فایل و جلد مفقود'],['ok','فایل‌های سالم']].map(([v,label])=>`<option value="${v}" ${v===mode?'selected':''}>${label}</option>`).join('');
       const links=n=>'/panel/media-integrity?'+new URLSearchParams({status:mode,q,page:String(n)}).toString();
       const body=shown.map(x=>`<tr><td>${esc(x.type)}</td><td>${x.book_id?`<a href="/panel/books?edit=${x.book_id}">${esc(x.title||'کتاب '+x.book_id)}</a>`:esc(x.title||'—')}</td><td><code>${esc(x.state)}</code></td><td>${esc(x.detail)}</td><td>${esc(x.filename||'—')}</td><td>${x.book_id?`<a href="/panel/covers?book=${x.book_id}">جلد</a> · <a href="/panel/bibliography?book=${x.book_id}">منبع چاپ</a>`:x.type==='digital_pdf'?'<a href="/panel/pdf-books">PDFها</a>':'—'}</td></tr>`).join('');
       return render('سلامت فایل‌های جلد و PDF',panelShell(user,`<div class="page-banner"><span class="eyebrow">VARAQ 5.4 · MEDIA AUDIT</span><h1>سلامت تصاویر و PDFها</h1><p>این بررسی فقط فایل‌های داخلی، چک‌سام PDF و ادعاهای ثبت‌شده درباره منابع را گزارش می‌کند.</p></div><div class="soft-warning">هیچ فایل یا تصویر به‌صورت خودکار دانلود، حذف، تأیید حقوقی یا منتشر نمی‌شود. سالم‌بودن فایل به معنی داشتن اجازه نشر نیست؛ دسترس‌پذیری لینک‌های خارجی به‌طور خودکار آزمون نمی‌شود.</div><div class="quality-stats">${[['موارد گزارش',stats.records],['نیازمند اقدام',stats.issues],['عناوین فاقد جلد قابل‌تأیید',stats.missingCovers],['فایل‌های مشکل‌دار',stats.damaged],['PDF ثبت‌شده',stats.digital],['فایل‌های بی‌مرجع',stats.orphan]].map(([label,n])=>`<div><strong>${digits(n)}</strong><span>${esc(label)}</span></div>`).join('')}</div><div class="panel-note"><form class="filterbar" method="get" action="/panel/media-integrity"><label>فیلتر<select name="status">${select}</select></label><label>نام، شابک یا شناسه<input name="q" value="${attr(q)}" maxlength="80"></label><button class="cta">بررسی</button></form><p>${digits(filtered.length)} نتیجه، صفحه ${digits(pageNum)} از ${digits(pages)} · <a class="outline" href="/panel/media-integrity.csv?${new URLSearchParams({status:mode,q}).toString()}">دریافت CSV همین فیلتر</a></p><div class="table-scroll"><table class="data-table"><thead><tr><th>نوع</th><th>عنوان</th><th>وضعیت</th><th>شرح</th><th>فایل</th><th>پیگیری</th></tr></thead><tbody>${body||'<tr><td colspan="6">موردی یافت نشد.</td></tr>'}</tbody></table></div><div class="button-row">${pageNum>1?`<a class="outline" href="${links(pageNum-1)}">صفحه قبل</a>`:''}${pageNum<pages?`<a class="outline" href="${links(pageNum+1)}">صفحه بعد</a>`:''}</div></div>`,'سلامت رسانه‌ها'));
     }
     if(p==='/panel/catalog-worklist'){
       if(user.role!=='owner')return bad(res,403,'دسترسی مجاز نیست.',user);
       const all=catalogWorklist.rows(db),totals=catalogWorklist.counts(all);
       const mode=String(url.searchParams.get('status')||'all'),q=String(url.searchParams.get('q')||'').slice(0,80);
       const modes=['all','unsourced','missing-cover','missing-author','missing-intro','stocked','ready'];
       const selected=modes.includes(mode)?mode:'all';
       const filtered=catalogWorklist.filter(all,selected,q);
       const page=Math.max(1,Math.min(10,Number.parseInt(url.searchParams.get('page')||'1',10)||1));
       const chunk=filtered.slice((page-1)*25,page*25);
       const controls=modes.map((v,i)=>`<option value="${v}" ${selected===v?'selected':''}>${['تمام کتاب‌ها','فاقد چاپ منبع‌دار','فاقد جلد مجاز','فاقد نویسنده','فاقد معرفی کامل','دارای موجودی','آماده'][i]}</option>`).join('');
       const cards=chunk.map(b=>`<article class="catalog-quality-card"><div><strong>${digits(b.id)}. ${esc(b.title)}</strong><p class="muted">${esc(b.category)} · ${digits(b.sourced_editions)} چاپ مستند · ${digits(b.stocked_skus)} موجودی فعال · ${b.hasCover?'جلد مجاز ثبت شده':'فاقد جلد قابل انتشار'}</p><p>${esc(b.tasks.join(' • ')||'تمام معیارهای کنترل تکمیل شده')}</p><div class="button-row"><a href="/panel/bibliography?book=${b.id}">ثبت شناسنامه و جلد</a><a href="/panel/content-workbook?missing=all&q=${b.id}">کاربرگ اطلاعات</a><a href="/panel/catalog-quality?book=${b.id}">بررسی کیفیت</a><a href="/panel/books?edit=${b.id}">ویرایش کتاب</a></div></div></article>`).join('');
       const pager=`<div class="button-row">${page>1?`<a class="outline" href="/panel/catalog-worklist?status=${selected}&page=${page-1}&q=${encodeURIComponent(q)}">صفحه قبل</a>`:''}${page*25<filtered.length?`<a class="outline" href="/panel/catalog-worklist?status=${selected}&page=${page+1}&q=${encodeURIComponent(q)}">صفحه بعد</a>`:''}</div>`;
       return render('صف تکمیل بانک کتاب',panelShell(user,`<div class="soft-warning">این گزارش، معیار کنترل محتوایی است و تأیید مجوز نشر یا آماده‌بودن فروش واقعی نیست. عکس اینترنتی تا ثبت حق استفاده و تطبیق چاپ عمومی نمی‌شود.</div><div class="quality-stats"><div><strong>${digits(totals.books)}</strong><span>عنوان</span></div><div><strong>${digits(totals.sourced)}</strong><span>عنوان با چاپ مستند</span></div><div><strong>${digits(totals.cover)}</strong><span>عنوان دارای جلد مجاز</span></div><div><strong>${digits(totals.ready)}</strong><span>تکمیل تمام معیارها</span></div></div><div class="panel-note"><h2>صف تکمیل اطلاعات و جلد واقعی</h2><form method="get" class="form-grid"><label>وضعیت<select name="status">${controls}</select></label><label>جست‌وجوی کتاب<input name="q" maxlength="80" value="${attr(q)}"></label><button class="cta">فیلتر</button></form><p>${digits(filtered.length)} نتیجه · صفحه ${digits(page)} · <a class="outline" href="/panel/catalog-worklist.csv">دانلود CSV تمام ۱۰۰۰ کتاب</a> · <a href="/panel/content-workbook">کاربرگ ۵.۳ ورود گروهی اطلاعات</a></p><div class="catalog-quality-list">${cards||'<p>موردی پیدا نشد.</p>'}</div>${pager}</div>`,'صف تکمیل بانک کتاب'));
     }
     if(p==='/panel/catalog-worklist.csv'){
       if(user.role!=='owner')return bad(res,403,'دسترسی مجاز نیست.',user);
       return send(res,200,catalogWorklist.csv(catalogWorklist.rows(db)),'text/csv; charset=utf-8',{'Content-Disposition':'attachment; filename="varaq-catalog-worklist.csv"'});
     }
     if(p==='/panel/print-evidence'){
       if(user.role!=='owner')return bad(res,403,'دسترسی مجاز نیست.',user);
       const collisions=printVariants.conflicts(db);
       const entries=printVariants.all(db);
       const conflictsHtml=collisions.map(x=>`<article class="catalog-quality-card"><strong>${esc(x.title)}</strong><p>ISBN: <code dir="ltr">${esc(x.isbn)}</code> · ناشر: ${esc(x.publisher)} · تعداد صفحات ثبت‌شده: ${digits(x.min_pages)} تا ${digits(x.max_pages)}</p><p class="muted">این اختلاف باید از روی نسخه فیزیکی بررسی شود؛ اطلاعات چاپ اصلی نباید خودکار بازنویسی شود.</p></article>`).join('');
       const cards=entries.map(x=>`<article class="catalog-quality-card"><strong>${esc(x.title)}</strong><p>شابک <code dir="ltr">${esc(x.isbn)}</code> · نوبت چاپ: ${esc(x.print_no)} · سال ${esc(x.publication_year)} · ${digits(x.pages)} صفحه</p><a target="_blank" rel="noopener noreferrer" href="${attr(x.source_url)}">منبع ثبت‌شده</a></article>`).join('');
       return render('کنترل نوبت‌های چاپ',panelShell(user,`<div class="soft-warning">ISBN هویت نسخه نشر است و الزاماً تعداد صفحات همه نوبت‌های چاپ را یکسان نمی‌کند؛ این موارد فقط شواهد منبع‌دارند و به موجودی یا مشخصات فروشگاه دست نمی‌زنند.</div><div class="panel-note"><h2>اختلاف اطلاعات چاپ</h2><p>${digits(collisions.length)} شابک با گزارش تعداد صفحات متفاوت از ${digits(entries.length)} رکورد منبع‌دار.</p><a class="outline" href="/panel/print-evidence.csv">دریافت CSV مدارک چاپ</a><div class="catalog-quality-list">${conflictsHtml||'<p>اختلاف ثبت‌شده‌ای نداریم.</p>'}</div></div><div class="panel-note"><h2>فهرست مدارک مستقل</h2><div class="catalog-quality-list">${cards}</div></div>`,'کنترل نوبت‌های چاپ'));
     }
     if(p==='/panel/print-evidence.csv'){
       if(user.role!=='owner')return bad(res,403,'دسترسی مجاز نیست.',user);
       return send(res,200,printVariants.csv(db),'text/csv; charset=utf-8',{'Content-Disposition':'attachment; filename="varaq-print-evidence.csv"'});
     }
     if(p==='/panel/cover-priority'){
       if(user.role!=='owner')return bad(res,403,'دسترسی مجاز نیست.',user);
       const stats=coverPriority.stats(db),list=coverPriority.ranked(db).slice(0,90);
       const cards=list.map(r=>`<article class="catalog-quality-card"><strong>${esc(r.title)}</strong><p>ناشر: ${esc(r.publisher)} · مترجم: ${esc(r.translator||'—')} · شابک <code dir="ltr">${esc(r.isbn)}</code></p><p class="muted">${r.sellers_count?'فروشندگان دارای موجودی: '+digits(r.sellers_count):'فعلاً بدون موجودی متصل'} · تصویر مجاز هنوز ثبت نشده</p><a href="/panel/cover-research?edition=${r.edition_id}">جست‌وجوی اینترنتی جلد</a> · <a href="/panel/bibliography?book=${r.book_id}">ثبت عکس خود کتاب</a> · <a target="_blank" rel="noopener noreferrer" href="${attr(r.source_url)}">منبع چاپ</a></article>`).join('');
       return render('اولویت تصاویر واقعی',panelShell(user,`<div class="soft-warning">هدف این صف، یافتن تصویر دقیق چاپ و شابک است. مرتب‌سازی ابتدا براساس چاپ‌هایی است که در فروشگاه موجودی دارند. بارگذاری تصویر فقط بعد از تطبیق فیزیکی و تأیید اجازه استفاده انجام می‌شود؛ تصویر نامزد به‌صورت خودکار عمومی نمی‌شود.</div><div class="panel-note"><h2>صف جلدهای واقعی و مجاز</h2><p>${digits(stats.total)} چاپ مستند · ${digits(stats.missing)} چاپ فاقد تصویر مجاز · ${digits(stats.stockFirst)} چاپ در صف دارای موجودی</p><p><a class="outline" href="/panel/cover-priority.csv">دانلود صف کامل CSV</a></p><div class="catalog-quality-list">${cards||'<p>همه چاپ‌ها تصویر مجاز دارند.</p>'}</div></div>`,'تأمین تصویر جلد واقعی'));
     }
     if(p==='/panel/cover-priority.csv'){
       if(user.role!=='owner')return bad(res,403,'دسترسی مجاز نیست.',user);
       return send(res,200,coverPriority.csv(db),'text/csv; charset=utf-8',{'Content-Disposition':'attachment; filename="varaq-cover-priority.csv"'});
     }
     if(p==='/panel/edition-verification'){
       if(user.role!=='owner')return bad(res,403,'دسترسی مجاز نیست.',user);
       const rows=editionVerify.rows(db);
       const q=String(url.searchParams.get('q')||'').trim().slice(0,100);
       const filtered=q?rows.filter(x=>[x.title,x.publisher,x.isbn,x.translator].some(v=>String(v||'').includes(q))):rows;
       const cards=filtered.slice(0,100).map(x=>`<article class="catalog-quality-card"><div><strong>${esc(x.title)}</strong> — ${esc(x.publisher)}<br><span class="muted">مترجم: ${esc(x.translator||'بدون مترجم')} · شابک: <code dir="ltr">${esc(x.isbn)}</code></span><p class="muted">${x.sellers_count?'فروشندگان دارای موجودی: '+digits(x.sellers_count):'هنوز موجودی به این چاپ متصل نشده'} · ${x.cover_ready?'جلد مجاز ثبت شده':'جلد مجاز ثبت نشده'}</p><a target="_blank" rel="noopener noreferrer" href="${attr(x.source_url)}">منبع شناسنامه</a> · <a href="/panel/cover-research?edition=${x.edition_id}">بررسی جلد</a></div></article>`).join('');
       const html=panelShell(user,`<div class="soft-warning">تطبیق شابک و چاپ با کتاب موجود در مغازه باید توسط فروشنده انجام شود؛ این فهرست به معنی موجودی واقعی نیست. ممکن است تعداد صفحات در نوبت‌های چاپ یک شابک تفاوت داشته باشد.</div><div class="panel-note"><h2>فهرست کنترل شابک و جلد</h2><p>${digits(rows.length)} چاپ منبع‌دار · ${digits(rows.filter(r=>r.sellers_count).length)} چاپ دارای اتصال موجودی · ${digits(rows.filter(r=>r.cover_ready).length)} چاپ با تصویر مجاز</p><form method="get" class="form-grid" action="/panel/edition-verification"><label>جست‌وجوی نام کتاب، ناشر یا ISBN<input name="q" maxlength="100" value="${attr(q)}"></label><button class="cta">جست‌وجو</button></form><p><a class="outline" href="/panel/edition-verification.csv">دریافت فایل CSV کامل برای تطبیق فروشگاه</a></p><div class="catalog-quality-list">${cards||'<p>نتیجه‌ای یافت نشد.</p>'}</div></div>`,'تطبیق چاپ فروشگاه');
       return render('تطبیق چاپ فروشگاه',html);
     }
     if(p==='/panel/edition-verification.csv'){
       if(user.role!=='owner')return bad(res,403,'دسترسی مجاز نیست.',user);
       return send(res,200,editionVerify.csv(db),'text/csv; charset=utf-8',{'Content-Disposition':'attachment; filename="varaq-edition-verification.csv"'});
     }
     if(p==='/panel/edition-audit'){const v=panelEditionAudit(user,url);return v?render('کنترل چاپ‌ها و جلدها',v):bad(res,403,'دسترسی مجاز نیست.',user);}
     if(p==='/panel/edition-audit.csv'){if(user.role!=='owner')return bad(res,403,'دسترسی مجاز نیست.',user);return send(res,200,catalogAudit.exportCsv(catalogAudit.rows(db)),'text/csv; charset=utf-8',{'Content-Disposition':'attachment; filename="varaq-edition-audit.csv"'});}
     if(p==='/panel/editorial-qa'){const v=panelEditorialQa(user,url);return v?render('کنترل تحریریه و منابع',v):bad(res,403,'دسترسی مجاز نیست.',user);}
     if(p==='/panel/editorial-qa.csv'){if(user.role!=='owner')return bad(res,403,'دسترسی مجاز نیست.',user);return send(res,200,editorialQa.csv(editorialQa.counts(db).rows),'text/csv; charset=utf-8',{'Content-Disposition':'attachment; filename="varaq-editorial-qa.csv"'});}
     if(p==='/panel/catalog-drafts'){const v=panelCatalogDrafts(user,url);return v?render('صف بررسی محتوا',v):bad(res,403,'دسترسی مجاز نیست.',user);}
     if(p==='/panel/catalog-import'){const v=panelCatalogImport(user);return v?render('ورود گروهی محتوا',v):bad(res,403,'دسترسی مجاز نیست.',user);}
     if(p==='/panel/catalog-template.csv'){if(user.role!=='owner')return bad(res,403,'دسترسی مجاز نیست.',user);return send(res,200,catalogWorkflow.exportTemplate(db),'text/csv; charset=utf-8',{'Content-Disposition':'attachment; filename="varaq-missing-metadata.csv"'});}
     if(p==='/panel/reading-samples'){const v=panelReadingSamples(user,url);return v?render('نمونه‌های مطالعه',v):bad(res,403,'دسترسی مجاز نیست.',user);}
     if(p==='/panel/books'){const v=panelBooks(user,url);return v?render('بانک کتاب',v):bad(res,403,'دسترسی مجاز نیست.',user);}
     if(p==='/panel/education-import'){const v=educationImportPage(user);return v?render('CSV کمک‌درسی',v):bad(res,403,'دسترسی مجاز نیست.',user);}
     if(p==='/panel/education'){const v=panelEducation(user,url);return v?render('مدیریت کمک‌درسی',v):bad(res,403,'دسترسی مجاز نیست.',user);}
     if(p==='/panel/merchandising'){const v=panelMerchandising(user,url);return v?render('مدیریت گروهی و ویترین',v):bad(res,403,'فقط مدیر فروشگاه مجاز است.',user);}
     if(p==='/panel/merchandising-template.csv'){
       const {storeId}=storeScope(user,url);if(!storeId||!managerOf(user,storeId))return bad(res,403,'دسترسی مجاز نیست.',user);
       const rows=db.prepare('SELECT sku,price,quantity FROM stock_items WHERE store_id=? ORDER BY id LIMIT 100').all(storeId);
       const content='﻿sku,expected_price,new_price,expected_quantity,new_quantity\n'+rows.map(r=>[r.sku,r.price,r.price,r.quantity,r.quantity].join(',')).join('\n');
       return send(res,200,content,'text/csv; charset=utf-8',{'Content-Disposition':'attachment; filename="varaq-store-'+storeId+'-bulk.csv"'});
     }
     if(marketGateway.enabled&&['/panel/inventory','/panel/discounts','/panel/stock-item','/panel/stock-ledger','/panel/merchandising'].includes(p)&&
       (user.role==='owner'||storeRole(user)==='manager'))return redirect(res,'/market/seller');
     if(p==='/panel/legacy-inventory')return render('آرشیو انبار قدیمی (بدون ویرایش)',panelInventory(user,url));
     if(p==='/panel/inventory')return render('انبار و SKU',panelInventory(user,url));
     if(p==='/panel/discounts'){const v=panelDiscounts(user,url);return v?render('قیمت‌گذاری و تخفیف‌ها',v):bad(res,403,'اجازه مدیریت تخفیف این فروشگاه را ندارید.',user);}
     if(p==='/panel/stock-item'){const v=panelStockItem(user,url);return v?render('SKU و گردش موجودی',v):bad(res,403,'دسترسی مجاز نیست.',user);}
     if(p==='/panel/stock-ledger'){const v=panelStockLedger(user,url);return v?render('گردش انبار',v):bad(res,403,'دسترسی مجاز نیست.',user);}
     if(p==='/panel/orders'&&marketGateway.enabled)return redirect(res,user.role==='owner'?'/market/admin':'/market/seller');
     if(p==='/panel/demo-orders-archive'){const v=panelOrders(user,url);return v?render('آرشیو سفارش‌های نمایشی',v):bad(res,403,'دسترسی مجاز نیست.',user);}
     if(p==='/panel/orders'){const v=panelOrders(user,url);return v?render('سفارش‌های آزمایشی',v):bad(res,403,'دسترسی مجاز نیست.',user);}
     if(p==='/panel/order-checklist.csv'){const {storeId}=storeScope(user,url);if(user.role==='seller'&&url.searchParams.has('store')&&String(user.store_id)!==url.searchParams.get('store'))return bad(res,403,'گزارش فروشگاه دیگر قابل دریافت نیست.',user);if(!storeId||!managerOf(user,storeId))return bad(res,403,'گزارش این فروشگاه مجاز نیست.',user);return send(res,200,fulfillment.csv(fulfillment.overview(db,storeId,500)),'text/csv; charset=utf-8',{'Content-Disposition':'attachment; filename=varaq-demo-fulfillment-'+storeId+'.csv','Cache-Control':'private,no-store'});}
     if(p==='/panel/reports'){const v=reportPage(user,url);return v?render('گزارش‌های آزمایشی',v):bad(res,403,'دسترسی مجاز نیست.',user);}
     if(p==='/panel/commissions'){const v=commissionPage(user);return v?render('کارمزدهای آزمایشی',v):bad(res,403,'دسترسی مجاز نیست.',user);}
     if(p==='/panel/customers'){const v=panelCustomers(user,url);return v?render('مشتریان نمونه',v):bad(res,403,'دسترسی مجاز نیست.',user);}
     if(p==='/panel/users'){const v=panelUsers(user);return v?render('کاربران فروشنده',v):bad(res,403,'دسترسی مجاز نیست.',user);}
     if(p==='/panel/store-profile'){const v=panelStoreProfile(user);return v?render('مشخصات فروشگاه',v):bad(res,403,'دسترسی مجاز نیست.',user);}
     if(p==='/panel/release-readiness'){const v=panelReleaseReadiness(user);return v?render('آمادگی انتشار ۶.۰',v):bad(res,403,'دسترسی مجاز نیست.',user);}
     if(p==='/panel/release-readiness.csv'){if(user.role!=='owner')return bad(res,403,'گزارش انتشار فقط مخصوص YM است.',user);return send(res,200,releaseAudit.toCsv(releaseAudit.assess({db,dataDir:DATA_DIR})),'text/csv; charset=utf-8',{'Content-Disposition':'attachment; filename=varaq-release-readiness-v5.csv','Cache-Control':'private,no-store','X-Content-Type-Options':'nosniff'});}
     if(p==='/panel/payment-readiness'){const v=panelPaymentReadiness(user);return v?render('آمادگی پذیرندگی PDF',v):bad(res,403,'دسترسی مجاز نیست.',user);}
     if(p==='/panel/payment-ledger.csv'){if(user.role!=='owner')return bad(res,403,'گزارش سراسری فقط در اختیار YM است.',user);return send(res,200,digitalPayments.csv(digitalPayments.intents(db,user,500)),'text/csv; charset=utf-8',{'Content-Disposition':'attachment; filename=varaq-payment-ledger.csv','Cache-Control':'private,no-store'});}
     if(p==='/panel/settings'){const v=panelSettings(user);return v?render('وضعیت پرداخت',v):bad(res,403,'دسترسی مجاز نیست.',user);}
   }
   if(method==='POST'&&p==='/panel/pdf-upload'){
     if(!(user.role==='owner'||user.role==='seller'&&storeRole(user)==='manager'))return bad(res,403,'دسترسی مجاز نیست.',user);
     let parts;try{parts=await multipart(req,{maxTotal:pdfStore.MAX_PDF_BYTES+20000,maxFile:pdfStore.MAX_PDF_BYTES});}
     catch(e){return bad(res,400,'بارگذاری PDF معتبر نیست یا از ۲۰ مگابایت بیشتر است.',user);}
     if(!csrfCheck(req,user,parts.fields))return bad(res,403,'کد امنیتی معتبر نیست.',user);
     try{const id=pdfStore.create(db,PDF_DIR,user,{...parts.fields,original_name:'کتاب.pdf'},parts.files.pdf?.data);audit(user,'pdf-draft-upload',String(id));return redirect(res,'/panel/pdf-books?new='+id);}
     catch(e){return bad(res,e.userError?400:500,e.userError?e.message:'خطای ذخیره PDF.',user);}
   }
   if(method==='POST'&&p==='/panel/store-doc-upload'){
     let parts;try{parts=await multipart(req);}catch(e){return bad(res,400,'فایل بیش از حد بزرگ یا فرم نامعتبر است.',user);}
     const f=parts.fields; if(!csrfCheck(req,user,f))return bad(res,403,'کد امنیتی معتبر نیست.',user);
     const storeId=safeId(f.store_id),kind=String(f.kind||''),file=parts.files.document;
     if(!managerOf(user,storeId)||!db.prepare('SELECT id FROM stores WHERE id=?').get(storeId))return bad(res,403,'دسترسی به فروشگاه مجاز نیست.',user);
     const type=validatePrivateDoc(file);
     if(!DOC_KINDS[kind]||f.consent!=='1'||!type)return bad(res,400,'نوع مدرک، رضایت مالک یا فایل نامعتبر است. PNG/JPG/PDF تا ۷۰۰ کیلوبایت.',user);
     const filename=crypto.randomBytes(24).toString('hex')+'.'+type.ext;
     const orig=(kind==='business_license'?'business-license':kind==='identity'?'identity':kind==='address'?'address':'other')+'-'+Date.now()+'.'+type.ext;
     fs.writeFileSync(path.join(PRIVATE_DOC_DIR,filename),file.data,{mode:0o600,flag:'wx'});
     try{db.prepare('INSERT INTO store_documents(store_id,kind,original_name,stored_name,mime,uploaded_by) VALUES(?,?,?,?,?,?)').run(storeId,kind,orig,filename,type.mime,user.id);}
     catch(e){try{fs.unlinkSync(path.join(PRIVATE_DOC_DIR,filename));}catch{}return bad(res,500,'ثبت فایل انجام نشد.',user);}
     audit(user,'upload-store-document',`${storeId}:${kind}`);return redirect(res,'/panel/store-docs?store='+storeId);
   }
   if(method==='POST'&&p==='/panel/home-banner-image'){
     if(!user||user.role!=='owner'||user.must_change_password)return bad(res,403,'دسترسی مجاز نیست.',user);
     let parts;try{parts=await multipart(req);}catch{return bad(res,400,'فایل نامعتبر یا بیش از سقف مجاز است.',user);}
     const f=parts.fields;
     if(!csrfCheck(req,user,f))return bad(res,403,'کد امنیتی معتبر نیست.',user);
     const id=safeId(f.id),existing=db.prepare('SELECT * FROM homepage_banners WHERE id=?').get(id),file=parts.files.banner;
     const source=str(f.image_source,160),rights=str(f.rights_note,240),alt=str(f.image_alt,160);
     if(!existing)return bad(res,404,'بنر یافت نشد.',user);
     if(!source||!rights||!alt||f.licensed!=='1'||!file)return bad(res,400,'تصویر و توضیح حق استفاده و منبع الزامی هستند.',user);
     let meta;try{meta=validateImage(file.data);}catch{return bad(res,400,'تصویر باید JPG/PNG/WebP واقعی با حداقل ۱۰۰×۱۲۰ پیکسل و حداکثر ۷۰۰ کیلوبایت باشد.',user);}
     const filename=crypto.randomBytes(16).toString('hex')+'.'+meta.ext,full=path.join(BANNER_DIR,filename);
     try{fs.writeFileSync(full,file.data,{flag:'wx',mode:0o600});
      db.prepare('UPDATE homepage_banners SET filename=?,mime=?,image_alt=?,image_source=?,rights_note=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(filename,meta.mime,alt,source,rights,id);
      if(existing.filename)try{fs.unlinkSync(path.join(BANNER_DIR,existing.filename));}catch{}
     }catch{try{fs.unlinkSync(full);}catch{}return bad(res,500,'تصویر ذخیره نشد.',user);}
     audit(user,'upload-home-banner-image',String(id));return redirect(res,'/panel/home-content?edit='+id);
   }
   if(method==='POST'&&p==='/panel/cover-web-upload'){
     if(user.role!=='owner')return bad(res,403,'بارگذاری گروهی فقط برای مدیریت مرکزی YM مجاز است.',user);
     let parts;
     try{parts=await multipart(req,{maxTotal:2500000,maxFile:MAX_COVER_BYTES,maxParts:24});}
     catch{return bad(res,400,'تصاویر بیش از حد بزرگ‌اند یا قالب فرم معتبر نیست.',user);}
     if(!csrfCheck(req,user,parts.fields))return bad(res,403,'کد امنیتی یا نشست نامعتبر است.',user);
     if(parts.fields.confirm!=='1')return bad(res,400,'تأیید صریح حق استفاده از تصاویر الزامی است.',user);
     if(!['preview','apply'].includes(parts.fields.mode))return bad(res,400,'عملیات نامعتبر است.',user);
     try{
       const applied=parts.fields.mode==='apply';
       const result=coverWebIntake.run(db,parts.fields,parts.files,COVER_DIR,applied);
       if(applied)audit(user,'cover-web-batch',String(result.saved));
       const report=applied?'ثبت موفق '+result.saved+' تصویر دارای مدرک':'بررسی موفق '+result.ready+' تصویر؛ هیچ‌کدام ثبت نشدند';
       return redirect(res,'/panel/cover-intake?notice='+encodeURIComponent(report));
     }catch(e){return bad(res,400,'ثبت گروهی انجام نشد: '+e.message,user);}
   }
   if(method==='POST'&&p==='/panel/edition-cover-upload'){
     if(user.role!=='owner')return bad(res,403,'دسترسی مجاز نیست.',user);
     let parts;try{parts=await multipart(req);}catch(e){return bad(res,400,'بارگذاری تصویر معتبر نیست یا فایل بیش از حد بزرگ است.',user);}
     const f=parts.fields;if(!csrfCheck(req,user,f))return bad(res,403,'کد امنیتی نامعتبر است.',user);
     try{
       const saved=editionCover.save(db,{bookId:f.book_id,editionId:f.edition_id,image:parts.files.cover?.data,
         alt:f.alt,source:f.source,rights:f.rights_note,permission:f.licensed,matched:f.matched},COVER_DIR);
       audit(user,'upload-edition-cover',String(saved.editionId));
       return redirect(res,'/panel/bibliography?book='+Number(f.book_id)+'&uploaded=1');
     }catch(e){return bad(res,400,e.message||'امکان ثبت تصویر وجود ندارد.',user);}
   }
   if(method==='POST'&&p==='/panel/cover-upload'){
     if(user.role!=='owner')return bad(res,403,'دسترسی مجاز نیست.',user);
     let parts;try{parts=await multipart(req);}catch(e){return bad(res,400,'فایل بارگذاری معتبر نیست یا حجم از سقف مجاز بیشتر است.',user);}
     const f=parts.fields;if(!csrfCheck(req,user,f))return bad(res,403,'نشست یا کد امنیتی نامعتبر است.',user);
     const bookId=Number(f.book_id),b=db.prepare('SELECT id,title FROM books WHERE id=?').get(bookId);
     if(!b)return bad(res,404,'کتاب پیدا نشد.',user);
     const source=str(f.source,160),rights=str(f.rights_note,240),alt=str(f.alt,180),file=parts.files.cover;
     if(!source||!rights||f.licensed!=='1'||!file)return bad(res,400,'منبع، توضیح مجوز استفاده و تأیید حق انتشار تصویر الزامی است.',user);
     let meta;try{meta=validateImage(file.data);}catch(e){return bad(res,400,'تصویر باید JPG/PNG/WebP واقعی، حداقل ۱۰۰×۱۲۰ و حداکثر ۷۰۰ کیلوبایت باشد.',user);}
     const name=crypto.randomBytes(16).toString('hex')+'.'+meta.ext,output=path.join(COVER_DIR,name),old=coverInfo(bookId);
     try{fs.writeFileSync(output,file.data,{flag:'wx',mode:0o600});
       db.prepare(`INSERT INTO book_covers(book_id,filename,mime,alt,source,rights_note) VALUES(?,?,?,?,?,?)
         ON CONFLICT(book_id) DO UPDATE SET filename=excluded.filename,mime=excluded.mime,alt=excluded.alt,source=excluded.source,rights_note=excluded.rights_note,uploaded_at=CURRENT_TIMESTAMP`)
         .run(bookId,name,meta.mime,alt||'جلد کتاب '+b.title,source,rights);
       if(old)try{fs.unlinkSync(path.join(COVER_DIR,old.filename));}catch{}
     }catch(e){try{fs.unlinkSync(output)}catch{}return bad(res,500,'ذخیره تصویر موفق نبود.',user);}
     audit(user,'upload-cover',String(bookId));return redirect(res,'/panel/covers?book='+bookId);
   }
   if(method==='POST'){
     const f=await body(req);if(!csrfCheck(req,user,f))return bad(res,403,'نشست یا کد امنیتی نامعتبر است. صفحه را تازه‌سازی کنید.',user);
     if(p==='/panel/reading-samples'){if(user.role!=='owner')return bad(res,403,'فقط مدیریت مرکزی مجاز است.',user);try{const rev=readingSamples.save(db,f,user.id);audit(user,'reading-sample-update',String(f.book_id)+':'+String(rev));return redirect(res,'/panel/reading-samples?book='+Number(f.book_id));}catch(e){return bad(res,409,e.message,user);}}
     if(p==='/panel/generated-editorials-review'){
       if(user.role!=='owner')return bad(res,403,'فقط مدیریت مرکزی مجاز است.',user);
       try{const revision=generatedReview.update(db,generatedCatalogue,f,user.id);audit(user,'generated-editorial-review',String(f.book_id)+':'+String(revision));return redirect(res,'/panel/generated-editorials?book='+Number(f.book_id));}
       catch(e){return bad(res,409,e.message,user);}
     }
     if(p==='/panel/content-batch'){
       if(user.role!=='owner')return bad(res,403,'دسترسی مجاز نیست.',user);
       try{const rows=contentBatch.parseCsv(f.csv);const preview=contentBatch.inspect(db,rows);
        if(f.mode==='apply'){if(f.confirm!=='1')return bad(res,400,'برای ثبت گروهی ابتدا تأیید نهایی را علامت بزنید.',user);const result=contentBatch.apply(db,rows,user);audit(user,'content-batch',result.books+':'+result.fields);return render('تکمیل اطلاعات',panelContentBatch(user,'',null,'اطلاعات '+result.books+' کتاب و '+result.fields+' فیلد با منبع ثبت شد.'));}
        return render('پیش‌نمایش تکمیل اطلاعات',panelContentBatch(user,String(f.csv||''),preview));
       }catch(e){return render('بررسی تکمیل گروهی',panelContentBatch(user,String(f.csv||''),null,e.message));}
     }
     if(p==='/panel/pdf-rights-update'){
       if(user.role!=='owner')return bad(res,403,'فقط مدیریت مرکزی مجاز است.',user);
       try{pdfRights.change(db,user,{id:f.id,revision:f.revision,action:f.action,note:f.note,expires_on:f.expires_on,evidence:f.evidence});audit(user,'pdf-rights-'+f.action,String(f.id));return redirect(res,'/panel/pdf-books');}
       catch(e){if(e.userError)return bad(res,409,e.message,user);throw e;}
     }
     if(p==='/panel/pdf-status'){
       try{const id=pdfStore.setStatus(db,user,f.id,f.status,f.note);audit(user,'pdf-status-'+f.status,String(id));return redirect(res,'/panel/pdf-books');}
       catch(e){return bad(res,e.userError?403:500,e.userError?e.message:'خطای تغییر وضعیت.',user);}
     }
     if(p==='/panel/store-task-create'){
       if(user.role!=='owner')return bad(res,403,'ایجاد پیگیری فقط برای مدیریت YM مجاز است.',user);
       try{const id=storeOperations.create(db,{storeId:f.store_id,title:f.title,taskType:f.task_type,priority:f.priority,dueDate:f.due_date||'',note:f.note||'',actorId:user.id});audit(user,'store-task-create',String(id));return redirect(res,'/panel/store-operations?store='+safeId(f.store_id)+'&history='+id);}
       catch(e){if(e.userError)return bad(res,400,e.message,user);throw e;}
     }
     if(p==='/panel/store-task-update'){
       const sid=safeId(f.store_id);
       if(!managerOf(user,sid))return bad(res,403,'دسترسی به پیگیری این فروشگاه مجاز نیست.',user);
       try{const revision=storeOperations.update(db,{taskId:f.task_id,storeId:sid,status:f.status,note:f.note||'',expectedRevision:f.revision,actorId:user.id});audit(user,'store-task-update',`${sid}:${safeId(f.task_id)}:${revision}`);return redirect(res,'/panel/store-operations?store='+sid+'&history='+safeId(f.task_id));}
       catch(e){if(e.userError)return bad(res,409,e.message,user);throw e;}
     }
     if(p==='/panel/merchandising'){
       const sid=safeId(f.store_id);if(!sid||!managerOf(user,sid))return bad(res,403,'فقط مدیر همان فروشگاه مجاز است.',user);
       const scoped=new URL('/panel/merchandising?store='+sid,PUBLIC_URL);
       if(f.mode==='preview'){
         try{const result=merchandising.validate(db,sid,f.csv);return render('پیش‌نمایش ویرایش گروهی',panelMerchandising(user,scoped,{...result,csv:String(f.csv||''),note:String(f.note||'')}));}
         catch(e){if(e.userError)return bad(res,400,e.message,user);throw e;}
       }
       if(f.mode!=='commit'||f.confirm!=='1')return bad(res,400,'برای ثبت قطعی، تأیید صریح و انتخاب عملیات لازم است.',user);
       try{const outcome=merchandising.commit(db,{storeId:sid,csv:f.csv,actorId:user.id,note:f.note});return redirect(res,'/panel/merchandising?store='+sid+'&batch='+outcome.batchId);}
       catch(e){if(e.userError)return bad(res,409,e.message,user);throw e;}
     }
     if(p==='/panel/featured-item'){
       const sid=safeId(f.store_id);if(!sid||!managerOf(user,sid))return bad(res,403,'فقط مدیر فروشگاه می‌تواند ویترین را ویرایش کند.',user);
       try{merchandising.featuredSet(db,{storeId:sid,itemId:f.item_id,actorId:user.id,headline:f.headline,priority:f.priority,enabled:f.enabled==='1'});return redirect(res,'/panel/merchandising?store='+sid);}
       catch(e){if(e.userError)return bad(res,400,e.message,user);throw e;}
     }
     if(p==='/panel/home-settings'){
       if(user.role!=='owner')return bad(res,403,'دسترسی مجاز نیست.',user);
       try{homeCms.updateSettings(db,f);audit(user,'update-home-settings','homepage');return redirect(res,'/panel/home-content');}
       catch(e){if(e.userError)return bad(res,400,e.message,user);throw e;}
     }
     if(p==='/panel/payment-profile'){try{const id=digitalPayments.saveProfile(db,user,f);audit(user,'payment-profile-preparation',String(id));return redirect(res,'/panel/payment-readiness');}catch(e){return bad(res,e.userError?400:500,e.userError?e.message:'خطا در ذخیره پرونده پذیرندگی',user);}}
     if(p==='/panel/payment-profile-review'){try{const id=digitalPayments.reviewProfile(db,user,f);audit(user,'payment-profile-review',String(id));return redirect(res,'/panel/payment-readiness');}catch(e){return bad(res,e.userError?400:500,e.userError?e.message:'خطا در بررسی پرونده',user);}}
     if(p==='/panel/home-banner'){
       if(user.role!=='owner')return bad(res,403,'دسترسی مجاز نیست.',user);
       try{const id=homeCms.saveBanner(db,f);audit(user,'save-home-banner',String(id));return redirect(res,'/panel/home-content?edit='+id);}
       catch(e){if(e.userError)return bad(res,400,e.message,user);throw e;}
     }
     if(p==='/panel/home-banner-remove'){
       if(user.role!=='owner')return bad(res,403,'دسترسی مجاز نیست.',user);
       try{const banner=homeCms.deleteBanner(db,safeId(f.id));if(banner.filename)try{fs.unlinkSync(path.join(BANNER_DIR,banner.filename));}catch{}audit(user,'delete-home-banner',String(banner.id));return redirect(res,'/panel/home-content');}
       catch(e){if(e.userError)return bad(res,400,e.message,user);throw e;}
     }
     if(p==='/panel/rights-tracker'){if(user.role!=='owner')return bad(res,403,'دسترسی مجاز نیست.',user);try{const id=coverRights.save(db,f,user.id);audit(user,'update-image-rights',String(id));return redirect(res,'/panel/rights-tracker?edition='+Number(f.edition_id));}catch(e){return bad(res,400,e.message,user);}}
     if(p==='/panel/cover-research'){if(user.role!=='owner')return bad(res,403,'دسترسی مجاز نیست.',user);try{const id=coverResearch.add(db,f,user.id);audit(user,'research-cover-add',String(id));return redirect(res,'/panel/cover-research?edition='+Number(f.edition_id));}catch(e){return bad(res,400,e.message,user);}}
     if(p==='/panel/cover-research/status'){if(user.role!=='owner')return bad(res,403,'دسترسی مجاز نیست.',user);try{const id=coverResearch.setStatus(db,f.id,f.status,f,user.id);audit(user,'research-cover-status',String(id));return redirect(res,'/panel/cover-research?edition='+Number(f.edition_id));}catch(e){return bad(res,400,e.message,user);}}
     if(p==='/panel/bibliography'){if(user.role!=='owner')return bad(res,403,'دسترسی مجاز نیست.',user);try{const id=bibliography.save(db,f);audit(user,'bibliography-edition',String(id));return redirect(res,'/panel/bibliography?book='+id+'&saved=1');}catch(e){return bad(res,400,e.message,user);}}
     if(p==='/panel/editorial-batch'){if(user.role!=='owner')return bad(res,403,'دسترسی مجاز نیست.',user);if(f.confirm!=='1')return bad(res,400,'تأیید صریح لازم است.',user);try{const result=editorialBatch.stage(db,user.id);audit(user,'editorial-batch',String(result.staged));return redirect(res,'/panel/catalog-drafts');}catch(e){return bad(res,400,e.message,user);}}
     if(p==='/panel/editorial-batch-31'){if(user.role!=='owner')return bad(res,403,'دسترسی مجاز نیست.',user);if(f.confirm!=='1')return bad(res,400,'تأیید صریح لازم است.',user);try{const result=editorialBatchV31.stage(db,user.id);audit(user,'editorial-batch-31',String(result.staged));return redirect(res,'/panel/catalog-drafts');}catch(e){return bad(res,400,e.message,user);}}
     if(p==='/panel/catalog-draft'){if(user.role!=='owner')return bad(res,403,'دسترسی مجاز نیست.',user);try{const id=catalogWorkflow.upsertDraft(db,f,user.id);audit(user,'catalog-draft',String(id));return redirect(res,'/panel/catalog-drafts');}catch(e){return bad(res,400,e.message,user);}}
     if(p==='/panel/editorial-qa'){if(user.role!=='owner')return bad(res,403,'فقط مدیر مرکزی مجاز است.',user);try{const id=editorialQa.verify(db,f,user.id);audit(user,'editorial-qa',String(id));return redirect(res,'/panel/editorial-qa?draft='+id);}catch(e){return bad(res,400,e.message,user);}}
     if(p==='/panel/editorial-qa-publish'){if(user.role!=='owner')return bad(res,403,'فقط مدیر مرکزی مجاز است.',user);try{const id=editorialQa.publishReviewed(db,f.draft_id,user.id);audit(user,'editorial-qa-publish',String(id));return redirect(res,'/panel/editorial-qa');}catch(e){return bad(res,409,e.message,user);}}
     if(p==='/panel/catalog-moderate'){if(user.role!=='owner')return bad(res,403,'دسترسی مجاز نیست.',user);try{if(f.action==='approve'&&!editorialQa.status(db,f.draft_id).valid)return bad(res,409,'برای انتشار ابتدا بررسی مستند همان نسخه از متن را در پنل تحریریه ثبت کنید.',user);const id=catalogWorkflow.moderate(db,f.draft_id,f.action,user.id,f.reason);audit(user,'catalog-moderate',`${id}:${f.action}`);return redirect(res,'/panel/catalog-drafts');}catch(e){return bad(res,409,e.message,user);}}
     if(p==='/panel/catalog-import'){if(user.role!=='owner')return bad(res,403,'دسترسی مجاز نیست.',user);if(f.confirm!=='1')return bad(res,400,'تأیید ورود گروهی لازم است.',user);try{const count=catalogWorkflow.batch(db,f.csv,user.id);audit(user,'catalog-batch',String(count));return redirect(res,'/panel/catalog-drafts');}catch(e){return bad(res,400,e.message,user);}}
     if(p==='/panel/commission'){
       if(user.role!=='owner')return bad(res,403,'تنظیم کارمزد فقط برای مدیر YM مجاز است.',user);
       const sid=safeId(f.store_id);try{const rateBps=finance.parseRate(String(f.rate||''));finance.savePolicy(db,{storeId:sid,rateBps,actorId:user.id});}
       catch(e){if(e.userError)return bad(res,400,e.message,user);throw e;}
       audit(user,'save-demo-commission',String(sid));return redirect(res,'/panel/commissions');
     }
     if(p==='/panel/order-checklist'){
       const sid=safeId(f.store_id),oid=safeId(f.order_id);
       if(!managerOf(user,sid))return bad(res,403,'چک‌لیست فقط برای مدیر همان فروشگاه است.',user);
       try{fulfillment.save(db,{storeId:sid,orderId:oid,actorId:user.id,revision:f.revision,note:String(f.note||''),checks:Object.fromEntries(Object.keys(fulfillment.FIELDS).map(k=>[k,f[k]==='1'?1:0]))});}
       catch(e){if(e.userError)return bad(res,409,e.message,user);throw e;}
       audit(user,'demo-fulfillment-checklist',`${sid}:${oid}`);return redirect(res,`/panel/orders?store=${sid}&order=${oid}`);
     }
     if(p==='/panel/order-status'){
       const sid=safeId(f.store_id),orderId=safeId(f.order_id),nextStatus=String(f.status||'');
       if(!managerOf(user,sid))return bad(res,403,'تغییر وضعیت فقط توسط مدیر فروشگاه یا مدیر YM مجاز است.',user);
       try{orders.updateStatus(db,{storeId:sid,orderId,nextStatus,actorId:user.id,note:str(f.note,301)});}catch(e){if(e.userError)return bad(res,400,e.message,user);throw e;}
       audit(user,'demo-order-status',`${sid}:${orderId}:${nextStatus}`);return redirect(res,`/panel/orders?store=${sid}&order=${orderId}`);
     }
     if(p==='/panel/staff'){
       if(user.role!=='seller'||storeRole(user)!=='manager')return bad(res,403,'فقط مدیر همان فروشگاه می‌تواند کارمند بسازد.',user);
       const username=str(f.username,50),pass=String(f.password||''),permission=String(f.permission||'');
       if(!/^[a-zA-Z0-9._-]{3,50}$/.test(username)||pass.length<12||pass.length>128||!['inventory','viewer'].includes(permission))return bad(res,400,'نام کاربری، رمز یا سطح دسترسی نامعتبر است.',user);
       try{db.prepare("INSERT INTO users(username,password_hash,role,store_id,must_change_password,staff_permission,created_by) VALUES(?,?,'seller',?,1,?,?)").run(username,hashPassword(pass),user.store_id,permission,user.id);}
       catch(e){return bad(res,409,'نام کاربری تکراری است.',user);}
       audit(user,'create-staff',username);return redirect(res,'/panel/staff');
     }
     if(p==='/panel/staff-status'){
       if(user.role!=='seller'||storeRole(user)!=='manager')return bad(res,403,'مدیریت کارمند مجاز نیست.',user);
       const id=safeId(f.id),enabled=f.enabled==='1'?1:0;
       const row=db.prepare("SELECT id FROM users WHERE id=? AND store_id=? AND role='seller' AND staff_permission IN ('inventory','viewer')").get(id,user.store_id);
       if(!row)return bad(res,403,'کارمند مربوط به این فروشگاه نیست یا حساب مدیر است.',user);
       db.exec('BEGIN IMMEDIATE');try{db.prepare('UPDATE users SET enabled=? WHERE id=?').run(enabled,id);if(!enabled)db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}
       audit(user,'staff-status',`${id}:${enabled}`);return redirect(res,'/panel/staff');
     }
     if(p==='/panel/user-status'){
       if(user.role!=='owner')return bad(res,403,'فقط مدیر YM می‌تواند حساب فروشنده را غیرفعال کند.',user);
       const id=safeId(f.id),enabled=f.enabled==='1'?1:0;
       const row=db.prepare("SELECT id FROM users WHERE id=? AND role='seller'").get(id);if(!row)return bad(res,403,'حساب مجاز نیست.',user);
       db.exec('BEGIN IMMEDIATE');try{db.prepare('UPDATE users SET enabled=? WHERE id=?').run(enabled,id);if(!enabled)db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}
       audit(user,'seller-status',`${id}:${enabled}`);return redirect(res,'/panel/users');
     }
     if(p==='/panel/store-submit'){
       const storeId=safeId(f.store_id);
       if(!managerOf(user,storeId)||!db.prepare('SELECT id FROM stores WHERE id=?').get(storeId))return bad(res,403,'فروشگاه مجاز نیست.',user);
       if(!db.prepare('SELECT id FROM store_documents WHERE store_id=? LIMIT 1').get(storeId))return bad(res,400,'ابتدا حداقل یک مدرک برای بررسی ارسال کنید.',user);
       db.prepare("UPDATE stores SET review_status='submitted',submitted_at=CURRENT_TIMESTAMP,review_note='' WHERE id=?").run(storeId);
       audit(user,'submit-store-review',String(storeId));return redirect(res,'/panel/store-docs?store='+storeId);
     }
     if(p==='/panel/store-review'){
       if(user.role!=='owner')return bad(res,403,'تأیید مدارک فقط توسط مدیریت YM انجام می‌شود.',user);
       const storeId=safeId(f.store_id),status=String(f.status||''),note=str(f.review_note,500);
       const existing=db.prepare('SELECT id FROM stores WHERE id=?').get(storeId);
       if(!existing||!['unverified','submitted','approved','rejected'].includes(status))return bad(res,400,'فروشگاه یا وضعیت معتبر نیست.',user);
       if(status==='approved'&&(!db.prepare("SELECT id FROM store_documents WHERE store_id=? AND kind='business_license' LIMIT 1").get(storeId)||f.verified_manually!=='1'))return bad(res,400,'برای تأیید داخلی، مدرک پروانه کسب و تأیید دستی اعتبار آن ضروری است.',user);
       if(status==='rejected'&&note.length<10)return bad(res,400,'برای رد پرونده علت را حداقل در ده کاراکتر بنویسید.',user);
       db.prepare("UPDATE stores SET review_status=?,review_note=?,reviewed_at=CURRENT_TIMESTAMP,active=CASE WHEN ? IN ('rejected','unverified') THEN 0 ELSE active END WHERE id=?").run(status,note,status,storeId);
       audit(user,'store-review',`${storeId}:${status}`);return redirect(res,'/panel/store-docs?store='+storeId);
     }
     if(p==='/panel/category'&&user.role==='owner'){
       const id=Number(f.id)||0,name=str(f.name,100),slug=str(f.slug,80),parentId=f.parent_id?Number(f.parent_id):null,active=f.active==='1'?1:0;
       if(name.length<2||!/^[a-z0-9-]{2,80}$/.test(slug)||parentId!==null&&!Number.isSafeInteger(parentId))return bad(res,400,'نام یا شناسه دسته‌بندی معتبر نیست.',user);
       if(parentId!==null&&!db.prepare('SELECT id FROM book_categories WHERE id=?').get(parentId))return bad(res,400,'دسته والد موجود نیست.',user);
       if(id&&parentId===id)return bad(res,400,'دسته نمی‌تواند والد خودش باشد.',user);
       if(id&&parentId!==null){const nested=categoryFilter(db.prepare('SELECT name FROM book_categories WHERE id=?').get(id)?.name||'');if(nested.includes(db.prepare('SELECT name FROM book_categories WHERE id=?').get(parentId)?.name))return bad(res,400,'حلقه در دسته‌بندی مجاز نیست.',user);}
       try{
         if(id){const old=db.prepare('SELECT name FROM book_categories WHERE id=?').get(id);if(!old)return bad(res,404,'دسته یافت نشد.',user);
           db.exec('BEGIN IMMEDIATE');db.prepare('UPDATE book_categories SET name=?,slug=?,parent_id=?,active=? WHERE id=?').run(name,slug,parentId,active,id);
           if(old.name!==name)db.prepare('UPDATE books SET category=? WHERE category=?').run(name,old.name);
           db.exec('COMMIT');
         }else db.prepare('INSERT INTO book_categories(name,slug,parent_id,active) VALUES(?,?,?,?)').run(name,slug,parentId,active);
       }catch(e){try{db.exec('ROLLBACK')}catch{}return bad(res,409,'موضوع یا نامک تکراری است یا ذخیره موفق نشد.',user);}
       audit(user,'save-category',slug);return redirect(res,'/panel/categories');
     }
     if(p==='/panel/education-import'){
       if(user.role!=='owner')return bad(res,403,'فقط مدیر YM اجازه ورود گروهی دارد.',user);
       let result;
       try{
         if(f.mode==='commit'){
           if(f.confirm!=='1')return bad(res,400,'برای ثبت پیش‌نویس‌ها باید تأیید ورود را علامت بزنی.',user);
           result=educationBatch.commit(db,String(f.csv||''));
           audit(user,'education-batch-draft',String(result.inserted));
           return render('نتیجه ثبت CSV آموزشی',educationImportResult(user,result,true));
         }
         result=educationBatch.preview(db,String(f.csv||''));
         return render('پیش‌نمایش CSV آموزشی',educationImportResult(user,result,false));
       }catch(e){return bad(res,400,'CSV آموزشی معتبر نیست: '+e.message,user);}
     }
     if(p==='/panel/import'&&user.role==='owner'){
       let rows;try{rows=csvParse(String(f.csv||''));}catch(e){return bad(res,400,'فایل CSV/TSV معتبر نیست یا بیش از حد بزرگ است: '+e.message,user);}
       if(rows.length>500)return bad(res,400,'هر نوبت حداکثر ۵۰۰ کتاب وارد کنید.',user);
       const validCategories=new Set(db.prepare('SELECT name FROM book_categories WHERE active=1').all().map(x=>x.name));
       const issues=[];const known=new Set();const fresh=[];
       for(const row of rows){const key=row.title.toLocaleLowerCase('fa')+'|'+row.author.toLocaleLowerCase('fa');
         if(!row.title||row.title.length>180||row.author.length>180||!validCategories.has(row.category)||row.description.length>4000||row.publisher.length>160){issues.push('ردیف '+row.line+': عنوان، نویسنده، موضوع یا طول توضیحات نامعتبر است');continue;}
         if(known.has(key)){issues.push('ردیف '+row.line+': تکراری در همین فایل');continue;}known.add(key);
         if(db.prepare('SELECT id FROM books WHERE title=? AND author=?').get(row.title,row.author)){issues.push('ردیف '+row.line+': این کتاب قبلاً ثبت شده');continue;}
         fresh.push(row);
       }
       if(f.mode!=='commit')return render('پیش‌نمایش ورود CSV',importResult(user,fresh,issues,false));
       if(f.confirm!=='1')return bad(res,400,'برای ورود قطعی باید تأیید ورود گروهی را فعال کنید.',user);
       let inserted=0,skipped=0;
       db.exec('BEGIN IMMEDIATE');try{
         const ins=db.prepare('INSERT INTO books(slug,title,author,category,description,publisher) VALUES(?,?,?,?,?,?)');
         for(const r of fresh){if(db.prepare('SELECT id FROM books WHERE title=? AND author=?').get(r.title,r.author)){skipped++;continue;}
           // Use collision-resistant slugs and never modify preexisting books.
           ins.run('import-'+crypto.randomUUID(),r.title,r.author,r.category,r.description,r.publisher);inserted++;
         }
         db.exec('COMMIT');
       }catch(e){db.exec('ROLLBACK');return bad(res,500,'ورود فایل انجام نشد؛ داده‌های قبلی تغییر نکردند.',user);}
       audit(user,'csv-import',String(inserted));return render('نتیجه ورود',importResult(user,fresh,issues,true,inserted,skipped));
     }
     if(p==='/panel/cover'&&user.role==='owner'){
       const bookId=Number(f.book_id),book=db.prepare('SELECT id,title FROM books WHERE id=?').get(bookId);
       if(!book)return bad(res,404,'کتاب موردنظر پیدا نشد.',user);
       if(f.cover_action==='delete'){
         const old=coverInfo(bookId);db.prepare('DELETE FROM book_covers WHERE book_id=?').run(bookId);
         if(old)try{fs.unlinkSync(path.join(COVER_DIR,old.filename));}catch{}audit(user,'delete-cover',String(bookId));return redirect(res,'/panel/covers?book='+bookId);
       }
       return bad(res,400,'آپلود جلد نیازمند فرم بارگذاری فایل است.',user);
     }
     if(p==='/panel/account'){
       const username=str(f.username,50),old=String(f.old_password||''),next=String(f.new_password||''),confirm=String(f.confirm_password||'');
       const present=db.prepare('SELECT * FROM users WHERE id=?').get(user.id);
       if(!verifyPassword(old,present.password_hash))return render('حساب و امنیت',accountPage(user,'رمز عبور فعلی درست نیست.'));
       if(!/^[a-zA-Z0-9._-]{3,50}$/.test(username))return render('حساب و امنیت',accountPage(user,'نام کاربری باید ۳ تا ۵۰ کاراکتر انگلیسی یا عدد باشد.'));
       if((user.must_change_password||next)&& (next.length<12||next.length>128||next!==confirm||next===old))return render('حساب و امنیت',accountPage(user,'رمز جدید باید حداقل ۱۲ کاراکتر، متفاوت با رمز قبلی و منطبق با تکرار باشد.'));
       if(username===user.username&&!next)return render('حساب و امنیت',accountPage(user,'برای ذخیره، نام کاربری یا رمز عبور را تغییر بده.'));
       try{db.exec('BEGIN IMMEDIATE');db.prepare('UPDATE users SET username=?,password_hash=?,must_change_password=0 WHERE id=?').run(username,next?hashPassword(next):present.password_hash,user.id);db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id);db.exec('COMMIT');}
       catch(e){try{db.exec('ROLLBACK');}catch{}return render('حساب و امنیت',accountPage(user,'نام کاربری تکراری است یا ذخیره موفق نبود.'));}
       audit(user,'change-credentials',String(user.id));appendCookie(res,'');return redirect(res,'/login?changed=1');
     }
     if(p==='/panel/review-moderate'&&user.role==='owner'){
       const id=Number(f.id),action=f.action;
       if(!Number.isSafeInteger(id)||id<1||!['approved','rejected'].includes(action))return bad(res,400,'درخواست نامعتبر است.',user);
       const outcome=db.prepare('UPDATE reader_reviews SET status=?,moderated_at=CURRENT_TIMESTAMP WHERE id=?').run(action,id);
       if(!outcome.changes)return bad(res,404,'نظر پیدا نشد.',user);
       audit(user,'moderate-review',`${id}:${action}`);return redirect(res,'/panel/reviews');
     }
     if(p==='/panel/editorial'&&user.role==='owner'){
       const bookId=Number(f.book_id),book=db.prepare('SELECT id FROM books WHERE id=?').get(bookId);
       if(!Number.isSafeInteger(bookId)||!book)return bad(res,404,'کتاب پیدا نشد.',user);
       const summary=str(f.summary,5001),audience=str(f.audience,2001),strengths=str(f.strengths,2001),cautions=str(f.cautions,2001),published=f.published==='1'?1:0;
       if(summary.length>5000||audience.length>2000||strengths.length>2000||cautions.length>2000||published&&summary.length<60)return bad(res,400,'برای انتشار، خلاصه حداقل ۶۰ کاراکتر و اطلاعات معتبر لازم است.',user);
       db.prepare(`INSERT INTO book_editorials(book_id,summary,audience,strengths,cautions,published) VALUES(?,?,?,?,?,?) ON CONFLICT(book_id) DO UPDATE SET summary=excluded.summary,audience=excluded.audience,strengths=excluded.strengths,cautions=excluded.cautions,published=excluded.published,updated_at=CURRENT_TIMESTAMP`).run(bookId,summary,audience,strengths,cautions,published);
       audit(user,'save-editorial',`${bookId}:${published}`);return redirect(res,'/panel/editorial?book='+bookId);
     }
     if(p==='/panel/edition'&&user.role==='owner'){
       const bookId=Number(f.book_id),editionId=Number(f.id)||0;
       if(!Number.isSafeInteger(bookId)||!db.prepare('SELECT id FROM books WHERE id=?').get(bookId))return bad(res,404,'اثر موردنظر یافت نشد.',user);
       const label=str(f.label,140),translator=str(f.translator,160),publisher=str(f.publisher,160),isbn=str(f.isbn,20).replace(/[ -]/g,'').toUpperCase(),publicationYear=str(f.publication_year,12),pages=(f.pages==null||f.pages==='')?null:Number(f.pages),binding=str(f.binding,40),language=str(f.language,40),notes=str(f.notes,1200),verified=f.verified==='1'?1:0;
       if(!validIsbn(isbn)||pages!==null&&(!Number.isSafeInteger(pages)||pages<1||pages>20000)||verified&&(!publisher||!isbn))return bad(res,400,'شابک باید معتبر باشد؛ نسخه تأییدشده نیاز به ناشر و شابک معتبر دارد.',user);
       try{
         if(editionId){const old=db.prepare('SELECT id FROM editions WHERE id=? AND book_id=?').get(editionId,bookId);if(!old)return bad(res,404,'این چاپ متعلق به این کتاب نیست.',user);
           db.prepare('UPDATE editions SET label=?,translator=?,publisher=?,isbn=?,publication_year=?,pages=?,binding=?,language=?,notes=?,verified=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(label,translator,publisher,isbn,publicationYear,pages,binding,language,notes,verified,editionId);
         }else db.prepare('INSERT INTO editions(book_id,label,translator,publisher,isbn,publication_year,pages,binding,language,notes,verified) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(bookId,label,translator,publisher,isbn,publicationYear,pages,binding,language,notes,verified);
       }catch(e){return bad(res,409,'شابک تکراری است یا داده چاپ ذخیره نشد.',user);}
       audit(user,'save-edition',String(bookId));return redirect(res,'/panel/editions?book='+bookId);
     }
     if(p==='/panel/discount'){
       const sid=safeId(f.store_id),itemId=safeId(f.item_id);
       if(!sid||!managerOf(user,sid))return bad(res,403,'مدیریت تخفیف فقط برای مدیر همان فروشگاه مجاز است.',user);
       try{promotions.save(db,{storeId:sid,itemId,percent:f.percent,enabled:f.enabled==='1',startsAt:f.starts_at,endsAt:f.ends_at});audit(user,'save-discount',`${sid}:${itemId}`);return redirect(res,`/panel/discounts?store=${sid}`);}
       catch(e){if(e.userError)return bad(res,400,e.message,user);throw e;}
     }
     if(p==='/panel/stock-item'){
       const sid=safeId(f.store_id);if(!sid||!writeInventory(user,sid))return bad(res,403,'دسترسی به انبار مجاز نیست.',user);
       let bookId=safeId(f.book_id),editionId=f.edition_id===''?null:safeId(f.edition_id);
       if(!bookId&&editionId)bookId=db.prepare('SELECT book_id FROM editions WHERE id=?').get(editionId)?.book_id;
       try{const id=stock.createOrUpdate(db,{id:safeId(f.id),storeId:sid,bookId,editionId,sku:String(f.sku||'').trim(),price:f.price,minQuantity:f.min_quantity,active:f.active==='1'});audit(user,'save-stock-item',`${sid}:${id}`);return redirect(res,`/panel/stock-item?store=${sid}&item=${id}`);}catch(e){if(e.userError||e.code?.startsWith('SQLITE_CONSTRAINT'))return bad(res,400,e.userError?e.message:'SKU تکراری است یا قبلاً برای این چاپ ثبت شده است.',user);throw e;}
     }
     if(p==='/panel/stock-move'){
       const sid=safeId(f.store_id),id=safeId(f.item_id);if(!sid||!writeInventory(user,sid))return bad(res,403,'دسترسی به انبار مجاز نیست.',user);
       try{stock.changeStock(db,{itemId:id,storeId:sid,delta:f.delta,reason:f.reason,note:f.note,actorId:user.id});audit(user,'stock-movement',`${sid}:${id}:${f.delta}`);return redirect(res,`/panel/stock-item?store=${sid}&item=${id}`);}catch(e){if(e.userError)return bad(res,400,e.message,user);throw e;}
     }
     if(p==='/panel/offer'){
       const sid=safeId(f.store_id),bid=safeId(f.book_id);if(!sid||!writeInventory(user,sid)||!db.prepare('SELECT id FROM stores WHERE id=?').get(sid))return bad(res,403,'دسترسی به انبار مجاز نیست.',user);
       try{stock.legacyOffer(db,{storeId:sid,bookId:bid,price:f.price,quantity:f.stock,active:f.active==='1',actorId:user.id});audit(user,'legacy-save-offer',`${sid}:${bid}`);return redirect(res,`/panel/inventory?store=${sid}`);}catch(e){if(e.userError)return bad(res,400,e.message,user);throw e;}
     }
     if(p==='/panel/store'&&user.role==='owner'){
       const id=Number(f.id)||0,name=str(f.name,100),slug=str(f.slug,60),city=str(f.city,80),phone=str(f.phone,40),about=str(f.about,500),active=f.active==='1'?1:0;
       if(!name||!/^[a-z0-9-]{2,60}$/.test(slug))return bad(res,400,'نام یا نامک فروشگاه معتبر نیست.',user);
       try {if(id){const row=db.prepare('SELECT id,active,review_status FROM stores WHERE id=?').get(id);if(!row)return bad(res,404,'فروشگاه موجود نیست.',user);db.prepare('UPDATE stores SET name=?,slug=?,city=?,phone=?,about=?,active=? WHERE id=?').run(name,slug,city,phone,about,(row.active===1||row.review_status==='approved')?active:0,id);}else{db.prepare('INSERT INTO stores(name,slug,city,phone,about,active) VALUES(?,?,?,?,?,0)').run(name,slug,city,phone,about);}audit(user,'save-store',slug);}catch(e){return bad(res,409,'نامک فروشگاه تکراری است یا اطلاعات ثبت نشد.',user);}return redirect(res,'/panel/stores');
     }
     if(p==='/panel/education-save'&&user.role==='owner'){
        try {const result=education.upsert(db,f);audit(user,'save-educational-profile',`${result.bookId}:${result.published}`);return redirect(res,'/panel/education?edit='+result.bookId);}
        catch(e){return bad(res,400,e.message,user);}
      }
      if(p==='/panel/bibliographic-review-save'){
       if(user.role!=='owner')return bad(res,403,'دسترسی ثبت بازبینی فقط برای مدیریت YM است.',user);
       try{const id=bibliographicReviewV83.save(db,f,user.id);audit(user,'bibliographic-review-v83',String(id));return redirect(res,'/panel/bibliographic-review?book='+id+'#review-editor');}
       catch(e){if(e.userError)return bad(res,400,e.message,user);throw e;}
     }
     if(p==='/panel/book'&&user.role==='owner'){
       const id=Number(f.id)||0,title=str(f.title,180),author=str(f.author,180),category=str(f.category,100),publisher=str(f.publisher,160),isbn=str(f.isbn,17),description=str(f.description,4000);
       if(!title||!category||!db.prepare('SELECT id FROM book_categories WHERE name=? AND active=1').get(category)||isbn&&!/^[0-9Xx-]{10,17}$/.test(isbn))return bad(res,400,'نام، موضوع فعال یا شابک معتبر نیست. موضوع جدید را ابتدا در بخش دسته‌بندی بسازید.',user);
       if(id){if(!db.prepare('SELECT id FROM books WHERE id=?').get(id))return bad(res,404,'کتاب موجود نیست.',user);db.prepare('UPDATE books SET title=?,author=?,category=?,publisher=?,isbn=?,description=? WHERE id=?').run(title,author,category,publisher,isbn,description,id);}
       else{const next=db.prepare('SELECT COALESCE(MAX(id),0)+1 n FROM books').get().n;db.prepare('INSERT INTO books(id,slug,title,author,category,publisher,isbn,description) VALUES(?,?,?,?,?,?,?,?)').run(next,'book-'+next,title,author,category,publisher,isbn,description);}
       audit(user,'save-book',title);return redirect(res,'/panel/books');
     }
     if(p==='/panel/user'&&user.role==='owner'){
       const username=str(f.username,50),pass=String(f.password||''),sid=Number(f.store_id);
       if(!/^[a-zA-Z0-9._-]{3,50}$/.test(username)||pass.length<12||!db.prepare('SELECT id FROM stores WHERE id=?').get(sid))return bad(res,400,'نام کاربری، رمز یا فروشگاه نامعتبر است.',user);
       try{db.prepare("INSERT INTO users(username,password_hash,role,store_id) VALUES(?,?,'seller',?)").run(username,hashPassword(pass),sid);}catch(e){return bad(res,409,'نام کاربری تکراری است.',user);}audit(user,'create-seller',username);return redirect(res,'/panel/users');
     }
     if(p==='/panel/store-profile'&&user.role==='seller'&&storeRole(user)==='manager'){
       const name=str(f.name,100),city=str(f.city,80),phone=str(f.phone,40),about=str(f.about,500);if(!name)return bad(res,400,'نام فروشگاه لازم است.',user);
       db.prepare('UPDATE stores SET name=?,city=?,phone=?,about=? WHERE id=?').run(name,city,phone,about,user.store_id);audit(user,'edit-profile',String(user.store_id));return redirect(res,'/panel/store-profile');
     }
   }
 }
 return bad(res,404,'این صفحه وجود ندارد.',user);
}
const server=http.createServer((req,res)=>{handler(req,res).catch(e=>{
 const status=e.code===413?413:500;
 const ref=operationalEvents.recordError(DATA_DIR,{method:req.method,url:req.url,status,error:e});
 // Never dump exception details, request URL, tokens or customer data to stdout.
 console.error('[VARAQ incident]',ref,'status',status);
 if(!res.headersSent)bad(res,status,status===413?'درخواست بیش از حد بزرگ است.':`خطای داخلی سرور. کد پیگیری: ${ref}`);
 else res.destroy();
});});
// Bound slow connections without breaking uploads below their existing size caps.
server.headersTimeout=15_000;
server.requestTimeout=30_000;
server.keepAliveTimeout=5_000;
server.maxHeadersCount=64;
server.maxRequestsPerSocket=100;
let localControl=null;
server.listen(PORT,HOST,()=>{localControl=runtimeControl.register(DATA_DIR,server);console.log(`\nVARAQ 8.3 — http://${HOST}:${server.address().port}`);console.log(`Storage: ${DATA_DIR}`);console.log(PUBLIC_READONLY?'PAYMENT: DISABLED — public informational read-only preview.':'PAYMENT: DISABLED — demo orders only; no real sale or shipping.');console.log('SEARCH INDEXING: '+(INDEXING_ENABLED?'enabled by explicit opt-in':'disabled'));if(initialToken){console.log('\nINITIAL SETUP: http://localhost:'+server.address().port+'/setup');console.log('SETUP TOKEN: '+initialToken+'\nKeep this token private.');}else console.log('Log in: http://localhost:'+server.address().port+'/login');});
let shuttingDown=false;
function shutdown(){
 if(shuttingDown)return;shuttingDown=true;
 server.close(()=>{runtimeControl.clear(localControl);db.close();});
 server.closeIdleConnections();
 setTimeout(()=>server.closeAllConnections(),5000).unref();
}
process.once('SIGINT',shutdown);
process.once('SIGTERM',shutdown);
module.exports={server,db};
