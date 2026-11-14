"use strict";
// Export sourced editions for shelf/ISBN checks. No change to seller stock or ownership.
const {publicCoverUrl}=require('./edition-detail');
function rows(db){
 const entries=db.prepare(`SELECT e.id edition_id,b.id book_id,b.title,b.author,e.isbn,e.label,e.translator,e.publisher,e.publication_year,e.pages,e.binding,s.source_url,
 a.filename,s.cover_url,s.rights_confirmed,s.cover_matched,
 (SELECT COUNT(*) FROM stock_items si JOIN stores st ON st.id=si.store_id WHERE si.edition_id=e.id AND si.quantity>0 AND si.active=1 AND st.active=1) sellers_count
 FROM editions e JOIN books b ON b.id=e.book_id JOIN edition_sources s ON s.edition_id=e.id
 LEFT JOIN edition_cover_assets a ON a.edition_id=e.id WHERE e.verified=1 AND s.source_url<>'' ORDER BY b.id,e.id`).all();
 return entries.map(e=>({...e,cover_ready:Boolean(publicCoverUrl(e))}));
}
function cell(value){let t=String(value??'');if(/^[\s]*[=+@-]/.test(t))t="'"+t;return '"'+t.replace(/"/g,'""')+'"';}
function csv(db){const h=['book_id','title','author','isbn','publisher','translator','publication_year','pages','binding','source_url','sellers_with_stock','licensed_cover','shop_isbn_checked','cover_matches_shop','notes'];const rowsList=rows(db);return '﻿'+[h.map(cell).join(','),...rowsList.map(r=>[r.book_id,r.title,r.author,r.isbn,r.publisher,r.translator,r.publication_year,r.pages,r.binding,r.source_url,r.sellers_count,r.cover_ready?'yes':'no','','',''].map(cell).join(','))].join('\r\n')+'\r\n';}
module.exports={rows,csv};
