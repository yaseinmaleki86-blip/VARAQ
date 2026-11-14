'use strict';
// Read-only editorial worklist: no inferred authors, unlicensed images or silent publication.
const {normalize}=require('./discovery');
const filterNames={all:'',cover:'جلد مجاز',description:'معرفی',author:'نویسنده',edition:'چاپ تأییدشده',source:'منبع چاپ'};
function select(items,params={}){
 const q=String(params.q||'').trim().slice(0,100),missing=Object.hasOwn(filterNames,params.missing)?params.missing:'all';
 const words=normalize(q).split(' ').filter(Boolean);
 const subset=items.filter(row=>{
  if(filterNames[missing]&&!row.missing.includes(filterNames[missing]))return false;
  const text=normalize([row.title,row.author,row.isbn,row.verified_isbn,row.publisher,row.id].join(' '));
  return words.every(w=>text.includes(w));
 });
 // Clamp to a realistic page number without returning phantom/empty pages.
 const perPage=50,pages=Math.max(1,Math.ceil(subset.length/perPage));
 const asked=Number(params.page);const page=Number.isSafeInteger(asked)?Math.max(1,Math.min(pages,asked)):1;
 return {items:subset.slice((page-1)*perPage,page*perPage),all:subset,total:subset.length,pages,page,q,missing};
}
module.exports={select,filterNames};
