'use strict';
// Uploaded real cover for a particular ISBN/edition, not a generic decorative artwork.
// Pictures are never fetched from arbitrary URLs by the server (SSRF avoidance).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {validateImage} = require('./images');
function migrate(db){
 db.exec(`CREATE TABLE IF NOT EXISTS edition_cover_assets (
  edition_id INTEGER PRIMARY KEY REFERENCES editions(id) ON DELETE CASCADE,
  filename TEXT NOT NULL UNIQUE, mime TEXT NOT NULL, alt TEXT NOT NULL,
  source TEXT NOT NULL, rights_note TEXT NOT NULL,
  uploaded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
 ); CREATE INDEX IF NOT EXISTS idx_edition_cover_filename ON edition_cover_assets(filename);
 CREATE TABLE IF NOT EXISTS edition_cover_import_evidence(
 edition_id INTEGER PRIMARY KEY REFERENCES editions(id) ON DELETE CASCADE,
 match_evidence TEXT NOT NULL, permission_evidence TEXT NOT NULL,
 imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
 );`);
}
function forBook(db,bookId){return db.prepare(`SELECT c.*,e.isbn,e.publisher,e.translator,e.book_id,e.verified
 FROM edition_cover_assets c JOIN editions e ON e.id=c.edition_id
 WHERE e.book_id=? AND e.verified=1 ORDER BY e.id DESC LIMIT 1`).get(bookId);}
function list(db,bookId){return db.prepare(`SELECT e.id,e.isbn,e.publisher,e.translator,e.label,c.filename,c.source
 FROM editions e LEFT JOIN edition_cover_assets c ON c.edition_id=e.id
 WHERE e.book_id=? AND e.verified=1 AND e.isbn<>'' ORDER BY e.id DESC`).all(bookId);}
function save(db,{bookId,editionId,image,alt,source,rights,permission,matched},dir){
 if(permission!=='1'||matched!=='1')throw Error('تطبیق شابک و تأیید حق استفاده از تصویر الزامی است.');
 const row=db.prepare('SELECT id,book_id,isbn,verified FROM editions WHERE id=?').get(Number(editionId));
 if(!row||row.book_id!==Number(bookId)||row.verified!==1||!row.isbn)throw Error('این تصویر باید به چاپ مستند و همان کتاب تعلق داشته باشد.');
 const src=String(source||'').trim().slice(0,160),note=String(rights||'').trim().slice(0,240);
 if(!src||note.length<8)throw Error('نام صاحب تصویر و مبنای واقعی اجازه انتشار الزامی است.');
 if(!Buffer.isBuffer(image))throw Error('تصویر بارگذاری نشده است.');
 const meta=validateImage(image);
 const name=crypto.randomBytes(16).toString('hex')+'.'+meta.ext;
 const old=db.prepare('SELECT filename FROM edition_cover_assets WHERE edition_id=?').get(row.id);
 fs.mkdirSync(dir,{recursive:true,mode:0o700});
 const destination=path.join(dir,name);
 fs.writeFileSync(destination,image,{flag:'wx',mode:0o600});
 try{
  db.prepare(`INSERT INTO edition_cover_assets(edition_id,filename,mime,alt,source,rights_note)
   VALUES(?,?,?,?,?,?) ON CONFLICT(edition_id) DO UPDATE SET filename=excluded.filename,mime=excluded.mime,
   alt=excluded.alt,source=excluded.source,rights_note=excluded.rights_note,uploaded_at=CURRENT_TIMESTAMP`)
   .run(row.id,name,meta.mime,String(alt||'').trim().slice(0,180)||`جلد چاپ ${row.isbn}`,src,note);
 }catch(e){try{fs.unlinkSync(destination);}catch{}throw e;}
 if(old&&old.filename!==name)try{fs.unlinkSync(path.join(dir,old.filename));}catch{}
 return {editionId:row.id,filename:name,isbn:row.isbn};
}
module.exports={migrate,forBook,list,save};
