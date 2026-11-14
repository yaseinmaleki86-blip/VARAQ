"use strict";
// Public, source-linked edition display. Never infer that bibliographic evidence
// proves a bookstore physically owns a particular print edition.
function listed(db,bookId){
 return db.prepare(`SELECT e.id,e.label,e.isbn,e.translator,e.publisher,e.publication_year,e.pages,e.binding,e.language,e.notes,
  s.source_url,s.rights_confirmed,s.cover_matched,s.cover_url,
  a.filename,a.alt,a.source AS cover_source,a.rights_note AS cover_rights,
  (SELECT COUNT(*) FROM stock_items o JOIN stores st ON st.id=o.store_id
   WHERE o.edition_id=e.id AND o.book_id=e.book_id AND o.active=1 AND o.quantity>0 AND st.active=1) AS sellers_count
 FROM editions e LEFT JOIN edition_sources s ON s.edition_id=e.id
 LEFT JOIN edition_cover_assets a ON a.edition_id=e.id
 WHERE e.book_id=? AND e.verified=1 ORDER BY e.id DESC`).all(bookId);
}
function trustworthySource(url){
 if(typeof url!=='string'||url.length>1200)return '';
 try{const u=new URL(url);return u.protocol==='https:'&&!u.username&&!u.password?url:'';}catch{return '';}
}
function publicCoverUrl(e){
 if(e.filename&&/^[a-f0-9]{32}\.(?:png|jpe?g|webp)$/.test(e.filename))return '/media/covers/'+e.filename;
 if(e.rights_confirmed===1&&e.cover_matched===1)return trustworthySource(e.cover_url);
 return '';
}
function stats(db){return db.prepare(`SELECT (SELECT COUNT(*) FROM books) total_books,
 (SELECT COUNT(*) FROM editions e JOIN edition_sources s ON e.id=s.edition_id WHERE e.verified=1 AND s.source_url<>'') sourced_editions,
 (SELECT COUNT(DISTINCT e.book_id) FROM editions e JOIN edition_sources s ON e.id=s.edition_id WHERE e.verified=1 AND s.source_url<>'') sourced_books,
 (SELECT COUNT(*) FROM edition_cover_assets) uploaded_covers,
 (SELECT COUNT(*) FROM edition_sources WHERE rights_confirmed=1 AND cover_matched=1 AND cover_url<>'') licensed_external_covers`).get();}
module.exports={listed,trustworthySource,publicCoverUrl,stats};
