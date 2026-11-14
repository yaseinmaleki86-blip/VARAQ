"use strict";
const SEED = [...require('../data/print_variants_v26.json'), ...require('../data/print_variants_v28.json')];
const {isbnValid}=require('./bibliography');
function migrate(db){
 db.exec(`CREATE TABLE IF NOT EXISTS print_run_evidence(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 edition_id INTEGER NOT NULL REFERENCES editions(id) ON DELETE CASCADE,
 print_no TEXT NOT NULL, publication_year TEXT NOT NULL,
 pages INTEGER NOT NULL CHECK(pages>0), binding TEXT NOT NULL,
 source_url TEXT NOT NULL UNIQUE,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
 );CREATE INDEX IF NOT EXISTS idx_print_evidence_edition ON print_run_evidence(edition_id)`);
 if(process.env.VARAQ_CURATED_SEED!=='1')return;
 db.exec('BEGIN IMMEDIATE');
 try{
  for(const item of SEED){
   if(!isbnValid(item.isbn)||!Number.isInteger(item.pages)||item.pages<1)throw Error('invalid print evidence');
   const e=db.prepare('SELECT id FROM editions WHERE isbn=?').get(item.isbn);if(!e)continue;
   db.prepare(`INSERT OR IGNORE INTO print_run_evidence(edition_id,print_no,publication_year,pages,binding,source_url) VALUES(?,?,?,?,?,?)`)
     .run(e.id,item.print_no,item.year,item.pages,item.binding,item.source_url);
  }
  db.exec('COMMIT');
 }catch(err){db.exec('ROLLBACK');throw err;}
}
function all(db){return db.prepare(`SELECT b.title,e.isbn,e.publisher,e.translator,r.print_no,r.publication_year,r.pages,r.binding,r.source_url
 FROM print_run_evidence r JOIN editions e ON e.id=r.edition_id JOIN books b ON b.id=e.book_id
 ORDER BY b.id,e.isbn,r.id`).all();}
function conflicts(db){return db.prepare(`SELECT b.title,e.isbn,e.publisher,e.translator,COUNT(*) reports,COUNT(DISTINCT r.pages) distinct_pages,
 MIN(r.pages) min_pages,MAX(r.pages) max_pages
 FROM print_run_evidence r JOIN editions e ON e.id=r.edition_id JOIN books b ON b.id=e.book_id
 GROUP BY e.id HAVING COUNT(DISTINCT r.pages)>1 ORDER BY b.title`).all();}
function forBook(db,bookId){
 const rows=db.prepare(`SELECT e.isbn,r.print_no,r.publication_year,r.pages,r.source_url
  FROM print_run_evidence r JOIN editions e ON e.id=r.edition_id
  WHERE e.book_id=? ORDER BY e.isbn,r.id`).all(bookId);
 return rows.reduce((acc,row)=>{(acc[row.isbn]??=[]).push(row);return acc;},Object.create(null));
}
function csvEscape(v){let t=String(v??'');if(/^\s*[=+@-]/.test(t))t="'"+t;return '"'+t.replace(/"/g,'""')+'"';}
function csv(db){const fields=['title','isbn','publisher','translator','print_no','publication_year','pages','binding','source_url'];return '\ufeff'+[fields.map(csvEscape).join(','),...all(db).map(r=>fields.map(x=>csvEscape(r[x])).join(','))].join('\r\n')+'\r\n';}
module.exports={migrate,all,conflicts,csv,forBook};
