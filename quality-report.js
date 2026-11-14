'use strict';
// Read-only content readiness report: missing metadata is reported, never fabricated.
const fs=require('node:fs');
const path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const publicationReview=require('./lib/publication-review');
const DATA_DIR=path.resolve(process.env.DATA_DIR||path.join(__dirname,'storage'));
const dbFile=path.join(DATA_DIR,'varaq.sqlite');
if(!fs.existsSync(dbFile)){console.error('پایگاه داده پیدا نشد. یک‌بار سرور را اجرا کنید، سپس مجدداً بررسی کنید.');process.exit(2);}
const db=new DatabaseSync(dbFile,{readOnly:true});
try{
 const hasTable=name=>!!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
 const queryCount=q=>db.prepare(q).get().n;
 const books=db.prepare('SELECT id,title,author,publisher,isbn,category,description FROM books ORDER BY id').all();
 const normalized=s=>String(s||'').trim().normalize('NFKC').replace(/[يى]/g,'ی').replace(/ك/g,'ک').replace(/[\u200c\s]+/g,' ').toLowerCase();
 const titles=new Map();for(const book of books){const key=normalized(book.title);titles.set(key,[...(titles.get(key)||[]),book.id]);}
 const duplicateTitles=[...titles.entries()].filter(([,ids])=>ids.length>1).map(([title,ids])=>({title,ids}));
 const report={
  generatedAt:new Date().toISOString(),
  isReadOnly:true,
  books:books.length,
  missingAuthor:books.filter(b=>!b.author?.trim()).length,
  missingPublisher:books.filter(b=>!b.publisher?.trim()).length,
  missingISBN:books.filter(b=>!b.isbn?.trim()).length,
  missingDescription:books.filter(b=>!b.description?.trim()).length,
  covers:hasTable('book_covers')?queryCount('SELECT COUNT(*) n FROM book_covers'):0,
  verifiedEditions:hasTable('editions')?queryCount('SELECT COUNT(*) n FROM editions WHERE verified=1'):0,
  educationalPublished:hasTable('education_profiles')?queryCount('SELECT COUNT(*) n FROM education_profiles WHERE published=1'):0,
  sellerStores:hasTable('stores')?queryCount('SELECT COUNT(*) n FROM stores'):0,
  unverifiedStores:hasTable('stores')?queryCount("SELECT COUNT(*) n FROM stores WHERE review_status <> 'approved'"):0,
  duplicateTitles,
  sampleMissingMetadata:books.filter(b=>!b.author?.trim()||!b.publisher?.trim()||!b.isbn?.trim()).slice(0,12).map(b=>({id:b.id,title:b.title,missing:['author','publisher','isbn'].filter(k=>!b[k]?.trim())})),
  publicationReview:publicationReview.summary(publicationReview.rows(db)),
  paymentEnabled:false
 };
 if(process.argv.includes('--json'))console.log(JSON.stringify(report,null,2));
 else{
  const values=[['تعداد عنوان',report.books],['فاقد نام نویسنده',report.missingAuthor],['فاقد ناشر',report.missingPublisher],['فاقد شابک در سطح عنوان',report.missingISBN],['فاقد توضیح',report.missingDescription],['دارای جلد ثبت‌شده',report.covers],['چاپ‌های تأییدشده',report.verifiedEditions],['پرونده آموزشی منتشرشده',report.educationalPublished],['فروشگاه‌های نیازمند بررسی داخلی',report.unverifiedStores],['عنوان‌های هم‌نام مشکوک',report.duplicateTitles.length]];
  console.log('VARAQ 4.8 — گزارش کیفیت محتوای کتاب‌ها (فقط خواندنی)\n');for(const [k,v] of values)console.log(k+': '+v);
  if(report.duplicateTitles.length)console.log('\nهم‌نام‌های نیازمند بررسی:\n'+report.duplicateTitles.slice(0,20).map(d=>d.title+' [شناسه '+d.ids.join(', ')+']').join('\n'));
  console.log('\nارزیابی انتشار: '+report.publicationReview.technicalCandidates+' نامزد بررسی انسانی؛ '+report.publicationReview.rightsConflicts+' تعارض تصویر؛ '+report.publicationReview.seoCandidates+' عنوان با حداقل معیار فنی سئو.');
  console.log('\nتوجه: شابک معمولاً متعلق به چاپ است؛ نبودن آن در جدول عنوان لزوماً خطا نیست. برای انتشار عمومی، اطلاعات هر چاپ و حقوق تصاویر باید مستقل بررسی شوند.');
 }
}finally{db.close();}
