'use strict';
// Book-level completion queue; no fabricated metadata, stock or cover permissions.
function rows(db){
 return db.prepare(`SELECT b.id,b.title,b.author,b.category, b.description,
 (SELECT COUNT(*) FROM editions e JOIN edition_sources s ON s.edition_id=e.id
  WHERE e.book_id=b.id AND e.verified=1 AND s.source_url<>'') sourced_editions,
 (SELECT COUNT(*) FROM stock_items x JOIN stores st ON st.id=x.store_id
  WHERE x.book_id=b.id AND x.active=1 AND x.quantity>0 AND st.active=1) stocked_skus,
 (SELECT COUNT(*) FROM edition_cover_assets a JOIN editions e ON e.id=a.edition_id
  WHERE e.book_id=b.id AND e.verified=1) licensed_uploaded_covers,
 (SELECT COUNT(*) FROM edition_sources s JOIN editions e ON e.id=s.edition_id
  WHERE e.book_id=b.id AND e.verified=1 AND s.cover_matched=1 AND s.rights_confirmed=1 AND s.cover_url<>'') licensed_external_covers,
 (SELECT COUNT(*) FROM book_covers c WHERE c.book_id=b.id) licensed_book_covers
 FROM books b ORDER BY b.id`).all().map(x=>{
  const hasCover=x.licensed_uploaded_covers+x.licensed_external_covers+x.licensed_book_covers>0;
  const hasAuthor=Boolean(String(x.author||'').trim());
  const hasIntro=String(x.description||'').trim().length>=100;
  const tasks=[];
  if(!x.sourced_editions)tasks.push('ثبت شناسنامه چاپ و شابک');
  if(!hasCover)tasks.push('تصویر واقعی با اجازه انتشار');
  if(!hasAuthor)tasks.push('تکمیل نام نویسنده');
  if(!hasIntro)tasks.push('معرفی اختصاصی و قابل استناد');
  if(!x.stocked_skus)tasks.push('تطبیق موجودی واقعی فروشگاه');
  return {...x,hasCover,hasAuthor,hasIntro,tasks,ready:tasks.length===0};
 });
}
function counts(items){return {books:items.length,sourced:items.filter(x=>x.sourced_editions>0).length,cover:items.filter(x=>x.hasCover).length,intro:items.filter(x=>x.hasIntro).length,stock:items.filter(x=>x.stocked_skus>0).length,ready:items.filter(x=>x.ready).length};}
function filter(items,mode,q){const query=String(q||'').trim().toLocaleLowerCase('fa');return items.filter(x=>{
 if(mode==='unsourced'&&x.sourced_editions)return false;
 if(mode==='missing-cover'&&x.hasCover)return false;
 if(mode==='missing-author'&&x.hasAuthor)return false;
 if(mode==='missing-intro'&&x.hasIntro)return false;
 if(mode==='stocked'&&!x.stocked_skus)return false;
 if(mode==='ready'&&!x.ready)return false;
 return !query||[x.title,x.author,String(x.id)].some(v=>String(v||'').toLocaleLowerCase('fa').includes(query));
 });}
function csvEscape(v){let s=String(v??'');if(/^\s*[=+@-]/.test(s))s="'"+s;return '"'+s.replace(/"/g,'""')+'"';}
function csv(items){const keys=['book_id','title','author','category','sourced_editions','stocked_skus','licensed_cover','author_complete','intro_complete','next_tasks'];const out=[keys];for(const x of items)out.push([x.id,x.title,x.author,x.category,x.sourced_editions,x.stocked_skus,x.hasCover?'yes':'no',x.hasAuthor?'yes':'no',x.hasIntro?'yes':'no',x.tasks.join(' | ')]);return '\uFEFF'+out.map(x=>x.map(csvEscape).join(',')).join('\r\n')+'\r\n';}
module.exports={rows,counts,filter,csv};
