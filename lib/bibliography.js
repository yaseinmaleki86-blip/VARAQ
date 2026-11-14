'use strict';
// VARAQ 1.9: edition-level provenance and real-cover pointers.
// No imagined metadata or generated book jackets. Never overwrite seller data.
const EXTRA_SEED = require('../data/curated_editions_v20.json');
const NEW_SEED = require('../data/curated_editions_v21.json');
const SEED_V23 = require('../data/curated_editions_v23.json');
const SEED_V24 = require('../data/curated_editions_v24.json');
const SEED_V25 = require('../data/curated_editions_v25.json');
const SEED_V26 = require('../data/curated_editions_v26.json');
const SEED_V27 = require('../data/curated_editions_v27.json');
const SEED_V28 = require('../data/curated_editions_v28.json');
const SEED_V29 = require('../data/curated_editions_v29.json');
const SEED_V33 = require('../data/curated_editions_v33.json');
const SEED_V34 = require('../data/curated_editions_v34.json');
const SEED = [
 {id:1, title:'ملت عشق', author:'الیف شافاک',isbn:'9789643119195',label:'ترجمه ارسلان فصیحی؛ چاپ ۱۲۹',translator:'ارسلان فصیحی',publisher:'ققنوس',publication_year:'۱۴۰۳',pages:511,binding:'شومیز',source_url:'https://arianhonar.ir/products?id=book-the-forty-rules-of-love-elif-shafak-qoqnoos',cover_url:'https://arianhonar.ir/upload/arianhonar-book-the-forty-rules-of-love-elif-shafak-qoqnoos-qqns-1001-1.jpg',cover_source:'آرین هنر / تصویر چاپ فارسی ققنوس',cover_rights:'تصویر متعلق به صاحب حقوق؛ مجوز استفاده تجاری قبل از انتشار عمومی بررسی شود.'},
 {id:2,title:'کیمیاگر',author:'پائولو کوئیلو',isbn:'9789646404465',label:'ترجمه حسین نعیمی؛ چاپ ۹۸',translator:'حسین نعیمی',publisher:'ثالث',publication_year:'۱۴۰۳',pages:227,binding:'شومیز',source_url:'https://arianhonar.ir/products?id=book-the-alchemist-paulo-coelho-saless',cover_url:'',cover_source:'',cover_rights:''},
 {id:3,title:'شازده کوچولو',author:'آنتوان دو سنت‌اگزوپری',isbn:'9786224891099',label:'ترجمه المیرا دادمهر',translator:'المیرا دادمهر',publisher:'پنتر',publication_year:'۱۴۰۴',pages:112,binding:'',source_url:'https://samanketab.roshd.ir/book/%D8%B4%D8%A7%D8%B2%D8%AF%D9%87-%DA%A9%D9%88%DA%86%D9%88%D9%84%D9%88-10',cover_url:'',cover_source:'',cover_rights:''},
 {id:5,title:'جزء از کل',author:'استیو تولتز',isbn:'9786002295002',label:'ترجمه پیمان خاکسار؛ چاپ ۸۶',translator:'پیمان خاکسار',publisher:'چشمه',publication_year:'۱۴۰۳',pages:659,binding:'گالینگور',source_url:'https://arianhonar.ir/products?id=book-fraction-of-the-whole-steve-toltz-cheshmeh',cover_url:'https://img.taaghche.com/frontCover/84957.jpg',cover_source:'طاقچه / روی جلد ترجمه پیمان خاکسار نشر چشمه',cover_rights:'تصویر متعلق به صاحب حقوق؛ مجوز استفاده تجاری قبل از انتشار عمومی بررسی شود.'},
 {id:40,title:'سمفونی مردگان',author:'عباس معروفی',isbn:'9789643113445',label:'چاپ ۷۰ نشر ققنوس',translator:'',publisher:'ققنوس',publication_year:'۱۴۰۵',pages:352,binding:'شومیز',source_url:'https://owjbook.com/product/symphony-of-the-dead/',cover_url:'https://baranmarket.com/cdn/shop/files/Symphony_of_the_Dead_1024x1024.jpg?v=1757971295',cover_source:'باران مارکت / جلد رمان سمفونی مردگان، نشر ققنوس',cover_rights:'تصویر متعلق به صاحب حقوق؛ مجوز استفاده تجاری قبل از انتشار عمومی بررسی شود.'}
];
const trustedImages = new Set(['arianhonar.ir','img.taaghche.com','baranmarket.com','covers.openlibrary.org','books.google.com','books.googleusercontent.com']);
function httpsUrl(v,limit=850){const s=String(v||'').trim();if(!s)return '';if(s.length>limit)throw Error('طول لینک بیشتر از حد مجاز است.');let u;try{u=new URL(s);}catch{throw Error('لینک نامعتبر است.');}if(u.protocol!=='https:'||u.username||u.password)throw Error('نشانی باید HTTPS معتبر باشد.');return s;}
function imageUrl(v){const s=httpsUrl(v);if(s&&(!trustedImages.has(new URL(s).hostname)))throw Error('دامنه تصویر تأیید نشده؛ لطفاً تصویر را از بخش بارگذاری جلد در سرور خودتان بارگذاری کنید.');return s;}
function isbnValid(raw){const value=String(raw||'').replace(/[\s-]/g,'').toUpperCase();return /^\d{13}$/.test(value)&&[...value].reduce((sum,x,i)=>sum+Number(x)*(i%2?3:1),0)%10===0;}
function migrate(db){db.exec(`CREATE TABLE IF NOT EXISTS edition_sources(
 edition_id INTEGER PRIMARY KEY REFERENCES editions(id) ON DELETE CASCADE,
 source_url TEXT NOT NULL, cover_url TEXT NOT NULL DEFAULT '', cover_source TEXT NOT NULL DEFAULT '',
 cover_rights TEXT NOT NULL DEFAULT '', cover_matched INTEGER NOT NULL DEFAULT 0 CHECK(cover_matched IN (0,1)),
 rights_confirmed INTEGER NOT NULL DEFAULT 0 CHECK(rights_confirmed IN (0,1)),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
 );CREATE INDEX IF NOT EXISTS idx_edition_sources_matched ON edition_sources(cover_matched);`);
 // Only verified, source-linked bibliographic examples; do not write into other books or overwrite existing editions.
 if(process.env.VARAQ_CURATED_SEED!=='1')return;
 db.exec('BEGIN IMMEDIATE');try{
 for(const x of [...SEED,...EXTRA_SEED,...NEW_SEED,...SEED_V23,...SEED_V24,...SEED_V25,...SEED_V26,...SEED_V27,...SEED_V28,...SEED_V29,...SEED_V33,...SEED_V34]){
  if(!isbnValid(x.isbn))throw Error(`Invalid curated ISBN: ${x.isbn}`);const b=db.prepare('SELECT id,author,title FROM books WHERE id=?').get(x.id);if(!b||b.title!==x.title)continue;
  let e=db.prepare('SELECT id,book_id FROM editions WHERE isbn=?').get(x.isbn);
  if(e&&e.book_id!==x.id)continue;
  if(!e){const row=db.prepare(`INSERT INTO editions(book_id,label,translator,publisher,isbn,publication_year,pages,binding,language,notes,verified)
    VALUES(?,?,?,?,?,?,?,?,?,?,1)`).run(x.id,x.label,x.translator,x.publisher,x.isbn,x.publication_year,x.pages,x.binding,'فارسی','مشخصات نمونه از منبع پیوست؛ پیش از اتصال موجودی، کتاب فیزیکی بررسی شود.');e={id:Number(row.lastInsertRowid),book_id:x.id};}
  if(!db.prepare('SELECT 1 FROM edition_sources WHERE edition_id=?').get(e.id))db.prepare(`INSERT INTO edition_sources(edition_id,source_url,cover_url,cover_source,cover_rights,cover_matched) VALUES(?,?,?,?,?,?)`).run(e.id,x.source_url,x.cover_url,x.cover_source,x.cover_rights,x.cover_url?1:0);
  if(!String(b.author||'').trim())db.prepare('UPDATE books SET author=? WHERE id=?').run(x.author,x.id);
 }
 db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}
}
function getCover(db,bookId,publicMode=false){return db.prepare(`SELECT s.cover_url,s.cover_source,s.cover_rights,s.source_url,e.isbn,e.publisher,e.translator
 FROM edition_sources s JOIN editions e ON e.id=s.edition_id
 WHERE e.book_id=? AND e.verified=1 AND s.cover_matched=1 AND s.cover_url<>'' AND (?=0 OR s.rights_confirmed=1)
 ORDER BY s.edition_id DESC LIMIT 1`).get(bookId,publicMode?1:0);}
function sourcesFor(db,bookId){return db.prepare(`SELECT e.id,e.label,e.isbn,e.translator,e.publisher,e.publication_year,e.pages,e.binding,e.verified,s.source_url,s.cover_url,s.cover_source,s.cover_matched,s.cover_rights,s.rights_confirmed
 FROM editions e LEFT JOIN edition_sources s ON s.edition_id=e.id WHERE e.book_id=? ORDER BY e.verified DESC,e.id DESC`).all(bookId);}
function quality(db){const totals=db.prepare(`SELECT COUNT(*) AS total,
 SUM(CASE WHEN EXISTS(SELECT 1 FROM editions e JOIN edition_sources s ON s.edition_id=e.id WHERE e.book_id=b.id AND e.verified=1 AND s.source_url<>'') THEN 1 ELSE 0 END) AS sourced,
 SUM(CASE WHEN EXISTS(SELECT 1 FROM book_covers c WHERE c.book_id=b.id) OR EXISTS(SELECT 1 FROM edition_cover_assets c JOIN editions e ON e.id=c.edition_id WHERE e.book_id=b.id) OR EXISTS(SELECT 1 FROM editions e JOIN edition_sources s ON s.edition_id=e.id WHERE e.book_id=b.id AND s.cover_matched=1 AND s.cover_url<>'') THEN 1 ELSE 0 END) AS with_cover,
 SUM(CASE WHEN EXISTS(SELECT 1 FROM book_covers c WHERE c.book_id=b.id) OR EXISTS(SELECT 1 FROM edition_cover_assets c JOIN editions e ON e.id=c.edition_id WHERE e.book_id=b.id) OR EXISTS(SELECT 1 FROM editions e JOIN edition_sources s ON s.edition_id=e.id WHERE e.book_id=b.id AND s.cover_matched=1 AND s.cover_url<>'' AND s.rights_confirmed=1) THEN 1 ELSE 0 END) AS approved_cover
 FROM books b`).get();return {total:totals.total,sourced:totals.sourced||0,withCover:totals.with_cover||0,approvedCover:totals.approved_cover||0};}
function save(db,fields){const id=Number(fields.book_id);if(!Number.isSafeInteger(id)||id<1||!db.prepare('SELECT 1 FROM books WHERE id=?').get(id))throw Error('شناسه کتاب نامعتبر است.');
 const isbn=String(fields.isbn||'').replace(/[\s-]/g,'');if(!isbnValid(isbn))throw Error('شابک ۱۳ رقمی معتبر لازم است.');
 const source=httpsUrl(fields.source_url);if(!source)throw Error('لینک منبع معتبر الزامی است.');
 const image=imageUrl(fields.cover_url);const coverNote=String(fields.cover_source||'').trim().slice(0,200),rights=String(fields.cover_rights||'').trim().slice(0,240);
 const title=String(fields.label||'').trim().slice(0,180);const translator=String(fields.translator||'').trim().slice(0,180),publisher=String(fields.publisher||'').trim().slice(0,180);if(!publisher)throw Error('نام ناشر را وارد کنید.');
 const pages=fields.pages?Number(fields.pages):null;if(pages!==null&&(!Number.isSafeInteger(pages)||pages<1||pages>15000))throw Error('تعداد صفحه نامعتبر است.');
 const rightsConfirmed=fields.rights_confirmed==='1'?1:0;
 if(rightsConfirmed&&!rights)throw Error('برای استفاده عمومی از تصویر، یادداشت حق نشر و مجوز لازم است.');
 const existing=db.prepare('SELECT id,book_id FROM editions WHERE isbn=?').get(isbn);if(existing&&existing.book_id!==id)throw Error('این شابک برای کتاب دیگری ثبت شده است.');
 if(image&&fields.cover_matched!=='1')throw Error('برای ثبت تصویر جلد باید تطبیق آن با همین چاپ و شابک را تأیید کنید.');
 db.exec('BEGIN IMMEDIATE');try{
  let e=existing;if(!e){const r=db.prepare(`INSERT INTO editions(book_id,label,translator,publisher,isbn,publication_year,pages,binding,language,notes,verified)
  VALUES(?,?,?,?,?,?,?,?,?,?,1)`).run(id,title,translator,publisher,isbn,String(fields.publication_year||'').slice(0,30),pages,String(fields.binding||'').slice(0,40),'فارسی','ثبت‌شده با منبع؛ تطبیق فیزیکی پیش از فروش ضروری است.');e={id:Number(r.lastInsertRowid)};}
  else if(fields.confirm_update==='1')db.prepare(`UPDATE editions SET label=?,translator=?,publisher=?,publication_year=?,pages=?,binding=?,verified=1,updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(title,translator,publisher,String(fields.publication_year||'').slice(0,30),pages,String(fields.binding||'').slice(0,40),e.id);
  db.prepare(`INSERT INTO edition_sources(edition_id,source_url,cover_url,cover_source,cover_rights,cover_matched,rights_confirmed)
   VALUES(?,?,?,?,?,?,?) ON CONFLICT(edition_id) DO UPDATE SET source_url=excluded.source_url,
    cover_url=CASE WHEN excluded.cover_url<>'' THEN excluded.cover_url ELSE edition_sources.cover_url END,
    cover_source=CASE WHEN excluded.cover_url<>'' THEN excluded.cover_source ELSE edition_sources.cover_source END,
    cover_rights=CASE WHEN excluded.cover_url<>'' THEN excluded.cover_rights ELSE edition_sources.cover_rights END,
    cover_matched=CASE WHEN excluded.cover_url<>'' THEN excluded.cover_matched ELSE edition_sources.cover_matched END,
    rights_confirmed=CASE WHEN excluded.cover_url<>'' THEN excluded.rights_confirmed ELSE edition_sources.rights_confirmed END,updated_at=CURRENT_TIMESTAMP`)
   .run(e.id,source,image,coverNote,rights,image?1:0,rightsConfirmed);
  db.exec('COMMIT');return id;
 }catch(error){db.exec('ROLLBACK');throw error;}
}
module.exports={migrate,getCover,sourcesFor,quality,save,isbnValid,SEED,EXTRA_SEED,NEW_SEED,SEED_V23,SEED_V24,SEED_V25,SEED_V26,SEED_V27,SEED_V28,SEED_V33,SEED_V34};
