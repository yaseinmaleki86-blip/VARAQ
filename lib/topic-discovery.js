'use strict';
// VARAQ 6.5 — transparent, deterministic discovery over existing draft editorial topics.
// This is NOT a review, recommendation from a human, popularity ranking or proof of accuracy.
const FEATURED = Object.freeze([
 'دوستی','عشق','خانواده','تاریخ','علم','اخلاق','سفر','مسئولیت',
 'زندگی','فناوری','جامعه','تغییر','تصمیم‌گیری','معنا','کودکی','اقتصاد',
 'جهان','قدرت','خلاقیت','رشد فردی'
]);
const normal = value => String(value||'').trim().normalize('NFC').replace(/ي/g,'ی').replace(/ك/g,'ک').replace(/\s+/g,' ');
function topicsFor(book, catalogueById, excluded=()=>false){
 const entry=catalogueById.get(book.id);
 if(!entry || normal(entry.title)!==normal(book.title) || excluded(entry))return [];
 return [...new Set((Array.isArray(entry.topics)?entry.topics:[]).filter(x=>typeof x==='string').map(normal).filter(x=>x.length>1&&x.length<=45))].slice(0,6);
}
function themes(books,catalogueById,excluded){
 const count=new Map();
 for(const b of books)for(const topic of topicsFor(b,catalogueById,excluded))count.set(topic,(count.get(topic)||0)+1);
 const ordered=[...FEATURED.filter(topic=>count.get(topic)>0),...([...count.keys()].filter(topic=>!FEATURED.includes(topic)).sort((a,b)=>count.get(b)-count.get(a)||a.localeCompare(b,'fa')))];
 return ordered.map(topic=>({topic,count:count.get(topic)}));
}
function browse(books,catalogueById,excluded,topic){
 const key=normal(topic);
 if(!key||key.length>45||!books.some(b=>topicsFor(b,catalogueById,excluded).includes(key)))return [];
 return books.filter(b=>topicsFor(b,catalogueById,excluded).includes(key));
}
function related(target,books,catalogueById,excluded,limit=6){
 const origin=topicsFor(target,catalogueById,excluded);
 return books.filter(b=>b.id!==target.id).map(book=>{
  const common=topicsFor(book,catalogueById,excluded).filter(t=>origin.includes(t));
  const sameCategory=book.category===target.category;
  const sameAuthor=Boolean(normal(target.author))&&normal(book.author)===normal(target.author);
  const points=common.length*5+(sameAuthor?4:0)+(sameCategory?2:0);
  const reason=common.length?'موضوع مشترک: '+common.slice(0,2).join('، '):sameAuthor?'نویسنده مشترک':sameCategory?'دسته‌بندی مشابه':'';
  return {book,common,points,reason};
 }).filter(item=>item.points>0).sort((a,b)=>b.points-a.points||a.book.id-b.book.id).slice(0,Math.max(0,Math.min(12,limit)));
}
module.exports={FEATURED,normal,topicsFor,themes,browse,related};
