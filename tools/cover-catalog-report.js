'use strict';
/** Generates an actionable, evidence-based cover worklist. Does not fetch, download, or publish images. */
const fs=require('node:fs'),path=require('node:path');const {DatabaseSync}=require('node:sqlite');
const media=require('../lib/media-integrity');
const ROOT=path.resolve(__dirname,'..'),data=path.resolve(process.env.DATA_DIR||path.join(ROOT,'storage'));
const dbPath=path.join(data,'varaq.sqlite');
if(!fs.existsSync(dbPath)){console.error('ابتدا سایت را اجرا کنید تا دیتابیس ایجاد شود؛ سپس گزارش جلدها را اجرا کنید.');process.exit(1);}
function val(v){let s=String(v??'');if(/^\s*[=+@-]/.test(s))s="'"+s;return '"'+s.replace(/"/g,'""')+'"';}
const db=new DatabaseSync(dbPath,{readOnly:true});const rows=db.prepare(`SELECT b.id,b.title,b.author,b.category,
 e.isbn,e.publisher,e.verified,s.source_url,s.cover_url,s.rights_confirmed,
 bc.filename AS cover_filename,bc.mime AS cover_mime,
 (SELECT ec.filename FROM edition_cover_assets ec JOIN editions ee ON ee.id=ec.edition_id WHERE ee.book_id=b.id ORDER BY ee.verified DESC,ee.id LIMIT 1) AS edition_filename
 FROM books b LEFT JOIN editions e ON e.id=(SELECT ee.id FROM editions ee WHERE ee.book_id=b.id ORDER BY ee.verified DESC,ee.id LIMIT 1)
 LEFT JOIN edition_sources s ON s.edition_id=e.id LEFT JOIN book_covers bc ON bc.book_id=b.id
 ORDER BY b.id`).all();
const outRows=rows.map(b=>{
 const filename=b.edition_filename||b.cover_filename;
 const ext=String(filename||'').split('.').pop();const mime={jpg:'image/jpeg',png:'image/png',webp:'image/webp'}[ext]||b.cover_mime||'';
 const checked=filename?media.checkCover(path.join(data,'covers'),filename,mime).state:'missing';
 const local=checked==='ok';const licensedExternal=b.verified===1&&b.rights_confirmed===1&&Boolean(b.cover_url);
 const status=local?'تصویر محلی سالم':licensedExternal?'نشانی تصویر با مجوز ثبت‌شده؛ سلامت اینترنتی بررسی نشده':'فاقد فایل جلد مجاز و سالم';
 const isbn=/^\d{10}(?:\d{3})?$/.test(b.isbn||'')?b.isbn:'';
 const openLibrary=isbn?'https://covers.openlibrary.org/b/isbn/'+isbn+'-M.jpg?default=false':'';
 return [b.id,b.title,b.author,b.category,isbn,b.publisher||'',b.source_url||'',b.cover_url||'',
  local?'1':'0',licensedExternal?'1':'0',status,openLibrary,
  'https://www.google.com/search?tbm=isch&q='+encodeURIComponent([b.title,b.publisher,isbn,'جلد کتاب'].filter(Boolean).join(' ')),
  local?'':isbn?'تصویر چاپ دقیق و سند حق استفاده را تطبیق دهید':'ابتدا ISBN و ناشر چاپ دقیق را ثبت کنید'];
});
const headers=['شناسه','عنوان','نویسنده','دسته','شابک یک چاپ مستند','ناشر همان چاپ','صفحه منبع شناسنامه','لینک پیشنهادی ثبت‌شده','فایل محلی سالم','حق استفاده از تصویر خارجی ثبت‌شده','وضعیت','Open Library فقط برای بررسی دستی','جست‌وجوی تصویری فقط برای بررسی دستی','اقدام بعدی'];
const file=path.resolve(process.argv[2]||path.join(ROOT,'VARAQ_Cover_Worklist_200.csv'));
fs.writeFileSync(file,'\ufeff'+[headers.map(val).join(','),...outRows.map(row=>row.map(val).join(','))].join('\r\n')+'\r\n');
db.close();console.log('گزارش جلدها:',file,'| کتاب:',rows.length,'| فایل‌های محلی سالم:',outRows.filter(x=>x[8]==='1').length);
