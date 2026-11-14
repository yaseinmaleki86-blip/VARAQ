"use strict";
const editionVerify=require('./edition-verification');
function ranked(db){return editionVerify.rows(db).filter(x=>!x.cover_ready).sort((a,b)=>b.sellers_count-a.sellers_count||a.book_id-b.book_id||a.edition_id-b.edition_id);}
function guard(s){let v=String(s??'');if(/^\s*[=+@-]/.test(v))v="'"+v;return '"'+v.replace(/"/g,'""')+'"';}
function csv(db){const fields=['book_id','title','isbn','publisher','translator','source_url','sellers_with_stock','cover_status','photo_rights','shop_isbn_checked'];
 const data=ranked(db).map(x=>[x.book_id,x.title,x.isbn,x.publisher,x.translator,x.source_url,x.sellers_count,'missing_approved_cover','','']);
 return '\uFEFF'+[fields.map(guard).join(','),...data.map(row=>row.map(guard).join(','))].join('\r\n')+'\r\n';}
function stats(db){const all=editionVerify.rows(db),pending=all.filter(x=>!x.cover_ready);return {total:all.length,missing:pending.length,ready:all.length-pending.length,stockFirst:pending.filter(x=>x.sellers_count>0).length};}
module.exports={ranked,csv,stats};
