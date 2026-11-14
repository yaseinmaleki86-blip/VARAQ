'use strict';
// VARAQ 6.6: read-only factual comparison, never a popularity score or purchase recommendation.
const MAX_BOOKS=3;
function selectBooks(raw, available){
 const values=Array.isArray(raw)?raw:raw?[raw]:[];
 if(values.length>MAX_BOOKS)return {error:'حداکثر سه کتاب را می‌توان هم‌زمان مقایسه کرد.',books:[]};
 if(values.some(v=>typeof v!=='string'||v.length>100||!/^[a-zA-Z0-9_-]+$/.test(v)))return {error:'شناسه کتاب معتبر نیست.',books:[]};
 const unique=new Set(values.filter(Boolean));
 if(unique.size!==values.filter(Boolean).length)return {error:'هر کتاب را فقط یک‌بار انتخاب کنید.',books:[]};
 const dict=new Map(available.map(b=>[b.slug,b]));
 if([...unique].some(slug=>!dict.has(slug)))return {error:'یک یا چند کتاب انتخاب‌شده در کتابخانه یافت نشد.',books:[]};
 return {error:'',books:[...unique].map(slug=>dict.get(slug))};
}
function pairLink(left,right){
 return '/books/compare?'+new URLSearchParams([['book',left.slug],['book',right.slug]]).toString();
}
function relation(left,right,topics){
 const a=topics(left),b=topics(right),common=a.filter(x=>b.includes(x));
 if(common.length)return 'برچسب‌های پیشنهادی مشترک: '+common.slice(0,3).join('، ');
 if(left.author&&left.author.trim()===right.author.trim())return 'نام نویسنده ثبت‌شده مشترک است';
 if(left.category===right.category)return 'دسته‌بندی ثبت‌شده یکسان است';
 return 'موضوعات ثبت‌شده متفاوت‌اند؛ انتخاب به علاقه شما بستگی دارد';
}
module.exports={MAX_BOOKS,selectBooks,pairLink,relation};
