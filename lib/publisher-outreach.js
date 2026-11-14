'use strict';
// Sourced, not automatically contacted. Turns missing covers into a publisher-specific request queue.
const coverPriority=require('./cover-priority');
const coverRights=require('./cover-rights');
const contentQueue=require('./catalog-worklist');
function rows(db){
 const rights=new Map(coverRights.rows(db).map(r=>[r.edition_id,r]));
 const missingMeta=new Map(contentQueue.rows(db).map(r=>[r.id,r]));
 return coverPriority.ranked(db).map(e=>{
  const r=rights.get(e.edition_id),b=missingMeta.get(e.book_id);
  return {edition_id:e.edition_id,book_id:e.book_id,title:e.title,publisher:e.publisher||'ناشر نامشخص',isbn:e.isbn,source_url:e.source_url||'',stocked_stores:e.sellers_count||0,rights_status:r?.request_status||'not_requested',next_followup_date:r?.next_followup_date||'',missing_author:!b?.hasAuthor,missing_intro:!b?.hasIntro};
 }).sort((a,b)=>b.stocked_stores-a.stocked_stores||a.publisher.localeCompare(b.publisher,'fa')||a.book_id-b.book_id);
}
function groups(rows){const groups=new Map();for(const r of rows){if(!groups.has(r.publisher))groups.set(r.publisher,[]);groups.get(r.publisher).push(r);}return [...groups].map(([publisher,items])=>({publisher,items,stocked:items.filter(x=>x.stocked_stores>0).length})).sort((a,b)=>b.stocked-a.stocked||b.items.length-a.items.length||a.publisher.localeCompare(b.publisher,'fa'));}
function csv(items){const safe=v=>{let s=String(v??'');if(/^\s*[=+@-]/.test(s))s="'"+s;return '"'+s.replace(/"/g,'""')+'"';};
 const data=[['publisher','book_id','edition_id','book_title','isbn','edition_source','stocked_stores','rights_request','followup_date','author_missing','description_missing','publisher_contact','permission_document','cover_file']];
 for(const x of items)data.push([x.publisher,x.book_id,x.edition_id,x.title,x.isbn,x.source_url,x.stocked_stores,x.rights_status,x.next_followup_date,x.missing_author?'yes':'no',x.missing_intro?'yes':'no','','','']);
 return '\uFEFF'+data.map(line=>line.map(safe).join(',')).join('\r\n')+'\r\n';
}
module.exports={rows,groups,csv};
