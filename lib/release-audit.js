'use strict';
// VARAQ 5.0 — read-only, fail-closed release audit. It NEVER enables checkout.
const fs=require('node:fs');
const path=require('node:path');
const {verifyBackup}=require('./backup-integrity');
const publication=require('./publication-review');
const seo=require('./seo');
const pdfRights=require('./pdf-rights');
const mediaIntegrity=require('./media-integrity');
const VERSION='8.6.0';
function approved(env,key){return env[key]==='1';}
function csvCell(value){
 let s=String(value??'').replace(/[\x00-\x1f\x7f]/g,' ');
 if(/^[\s\uFEFF]*[=+@-]/.test(s))s="'"+s;
 return '"'+s.replace(/"/g,'""')+'"';
}
function toCsv(report){
 const fields=['scope','check_id','passed','detail'];
 return '\uFEFF'+[fields,...report.checks.map(c=>[c.scope,c.id,c.ok?'yes':'no',c.detail])]
  .map(row=>row.map(csvCell).join(',')).join('\r\n')+'\r\n';
}
function recentBackup(dataDir,now){
 const root=path.join(dataDir,'backups');
 if(!fs.existsSync(root))return {ok:false,detail:'بکاپ دارای manifest معتبر یافت نشد.'};
 let candidates=[];
 try{candidates=fs.readdirSync(root,{withFileTypes:true}).filter(x=>x.isDirectory()&&!x.isSymbolicLink()).map(x=>x.name).sort().reverse();}
 catch{return {ok:false,detail:'خواندن مسیر بکاپ ممکن نیست.'};}
 for(const folder of candidates){
  try{
   const b=verifyBackup(path.join(root,folder));
   const age=(now-Date.parse(b.createdAt))/86400000;
   if(!Number.isFinite(age)||age<0)continue;
   return {ok:age<=7,detail:`${folder}: ${b.fileCount} فایل با SHA-256 و SQLite سالم، ${age.toFixed(1)} روز قبل${age>7?'؛ قدیمی‌تر از ۷ روز':''}`};
  }catch{/* invalid backup is never counted as recovery proof */}
 }
 return {ok:false,detail:'هیچ بکاپ قابل بازیابی با چک‌سام معتبر یافت نشد.'};
}
function assess({db=null,dataDir,env=process.env,now=Date.now()}={}){
 const checks=[],metrics={books:0,sourcedBooks:0,missingAuthor:0,missingIntro:0,missingCover:0,rightsConflicts:0,
  technicalCandidates:0,seoCandidates:0,mediaAssetsDamaged:0,approvedStores:0,approvedDigitalBooks:0,digitalRightsHeld:0,digitalRightsExpired:0,digitalVaultErrors:0,demoOrders:0};
 const add=(id,scope,ok,detail)=>checks.push({id,scope,ok:!!ok,detail:String(detail)});
 let url;
 try{url=new URL(env.PUBLIC_URL||'');}catch{}
 add('https','preview',!!url&&url.protocol==='https:'&&!url.username&&!url.password&&url.pathname==='/'&&!url.search&&!url.hash,
  url?'PUBLIC_URL روی HTTPS معتبر است یا باید اصلاح شود.':'دامنه واقعی PUBLIC_URL با HTTPS تنظیم نشده است.');
 add('internal_binding','preview',['127.0.0.1','localhost','::1'].includes(env.HOST||'127.0.0.1'),
  'HOST باید روی loopback باشد و TLS در reverse proxy مدیریت شود.');
 add('database_exists','preview',!!db,db?'پایگاه داده در دسترس است.':'پایگاه داده هنوز ساخته نشده است.');
 if(db){
  try{
   const integrity=db.prepare('PRAGMA integrity_check').get()?.integrity_check;
   const foreign=db.prepare('PRAGMA foreign_key_check').all().length;
   add('sqlite_integrity','preview',integrity==='ok'&&foreign===0,`SQLite: ${integrity||'unknown'}؛ خطای FK: ${foreign}`);
   const owners=db.prepare("SELECT must_change_password,enabled FROM users WHERE role='owner'").all();
   add('owner_credentials','preview',owners.length>0&&owners.every(x=>x.enabled===1&&x.must_change_password===0),
    `${owners.length} حساب مدیر؛ رمز اولیه باید عوض شده و حساب فعال باشد.`);
   const rows=publication.rows(db),stat=publication.summary(rows);
   metrics.books=stat.total;metrics.sourcedBooks=stat.total-stat.missingSource;
   metrics.missingAuthor=stat.missingAuthor;metrics.missingIntro=stat.missingIntro;
   metrics.missingCover=stat.missingCover;metrics.rightsConflicts=stat.rightsConflicts;
   metrics.technicalCandidates=stat.technicalCandidates;metrics.seoCandidates=seo.approvedBooks(db).length;
   add('denied_cover_conflicts','preview',stat.rightsConflicts===0,`${stat.rightsConflicts} تعارض تصویر و پرونده رد مجوز.`);
   add('catalog_preview','preview',metrics.seoCandidates>0,`${metrics.seoCandidates} کتاب دارای حداقل شرایط سایت‌مپ؛ از ${stat.total} عنوان.`);
   add('catalog_complete','sales',stat.total>0&&stat.missingAuthor===0&&stat.missingIntro===0&&stat.missingSource===0&&stat.missingCover===0&&stat.rightsConflicts===0,
    `${stat.missingAuthor} بدون نویسنده، ${stat.missingIntro} معرفی ناقص، ${stat.missingSource} بدون منبع چاپ، ${stat.missingCover} بدون جلدِ دارای ادعای حق استفاده.`);
   const mediaRows=mediaIntegrity.safeRows(db,dataDir);
   metrics.mediaAssetsDamaged=mediaRows.filter(x=>['book_cover','edition_cover','digital_pdf'].includes(x.type)&&['missing_file','invalid_path','invalid_mime','invalid_file','invalid_hash'].includes(x.state)).length;
   add('stored_media_integrity','preview',metrics.mediaAssetsDamaged===0,`${metrics.mediaAssetsDamaged} فایل ثبت‌شده جلد یا PDF خراب، مفقود یا مغایر؛ کتاب‌های بدون عکس در بررسی محتوایی جداگانه لحاظ می‌شوند.`);
   metrics.demoOrders=db.prepare('SELECT COUNT(*) n FROM demo_orders').get().n;
   add('demo_data','preview',metrics.demoOrders===0,`${metrics.demoOrders} سفارش آزمایشی؛ داده‌های نمونه نباید با اطلاعات حقیقی مخلوط شوند.`);
   const st=db.prepare("SELECT COUNT(*) n FROM stores WHERE active=1 AND review_status='approved'").get().n;
   metrics.approvedStores=st;
   add('store_approved','sales',st>0,`${st} فروشگاه فعال با تأیید داخلی؛ مجوز قانونی جداگانه لازم است.`);
   const digital=db.prepare('SELECT id,status,distribution_hold,rights_expires_on,filename,file_bytes,file_sha256 FROM digital_books').all();
   const day=pdfRights.report(db,{role:'owner'});
   metrics.approvedDigitalBooks=digital.filter(x=>x.status==='approved').length;
   metrics.digitalRightsHeld=day.filter(x=>x.rights_state==='held').length;
   metrics.digitalRightsExpired=day.filter(x=>x.rights_state==='expired').length;
   const vault=path.join(dataDir,'digital-pdfs');
   const crypto=require('node:crypto');
   for(const d of digital){
    if(d.status!=='approved')continue;
    if(!/^[0-9a-f]{32}\.pdf$/.test(d.filename)){metrics.digitalVaultErrors++;continue;}
    try{
     const f=path.join(vault,d.filename),s=fs.lstatSync(f);
     if(!s.isFile()||s.isSymbolicLink()||s.size!==d.file_bytes ||
       crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')!==d.file_sha256)metrics.digitalVaultErrors++;
    }catch{metrics.digitalVaultErrors++;}
   }
   add('digital_vault_integrity','sales',metrics.digitalVaultErrors===0,`${metrics.digitalVaultErrors} فایل PDF تأییدشده، مفقود یا مغایر با SHA-256/حجم ثبت‌شده.`);
   add('digital_licensed_catalogue','sales',false,`${metrics.approvedDigitalBooks} PDF تأیید داخلی، ${metrics.digitalRightsHeld} تعلیق، ${metrics.digitalRightsExpired} انقضا؛ تأیید رسمی فروش دیجیتال مستقل لازم است.`);
  }catch(error){add('database_schema','preview',false,'خطا در ممیزی پایگاه داده: '+error.message);}
 }
 const backup=recentBackup(dataDir,now);
 add('verified_backup','preview',backup.ok,backup.detail);
 add('legal_copy_review','preview',approved(env,'VARAQ_LEGAL_REVIEWED'),'تأیید مسئول بررسی متن حقوقی و تماس: '+(approved(env,'VARAQ_LEGAL_REVIEWED')?'اعلام شده':'ثبت نشده'));
 add('media_rights_review','preview',approved(env,'VARAQ_MEDIA_RIGHTS_REVIEWED'),'بررسی انسانی حقوق رسانه و جلدها: '+(approved(env,'VARAQ_MEDIA_RIGHTS_REVIEWED')?'اعلام شده':'ثبت نشده'));
 add('browser_review','preview',approved(env,'VARAQ_BROWSER_QA_APPROVED'),'تست واقعی موبایل/دسکتاپ و دامنه: '+(approved(env,'VARAQ_BROWSER_QA_APPROVED')?'اعلام شده':'ثبت نشده'));
 add('indexing_opt_in','preview',approved(env,'VARAQ_PUBLIC_INDEX'),'فعال‌سازی عمدی ایندکس: '+(approved(env,'VARAQ_PUBLIC_INDEX')?'اعلام شده':'غیرفعال / noindex'));
 add('payment_provider','sales',false,'درگاه واقعی پرداخت هنوز متصل نیست؛ این مورد برای سازگاری گزارش‌های قبلی حفظ شده است.');
 add('gateway_end_to_end','sales',false,'هیچ درگاه رسمی، استعلام سروری، webhook معتبر، رسید پرداخت/استرداد وجه عملیاتی نیست.');
 add('public_checkout','sales',false,'ثبت سفارش و تحویل پولی در نسخه ۵.۱ عمداً غیرفعال است.');
 add('legal_licenses','sales',false,'مجوز و تأیید صاحب‌حقوق برای فروش واقعی باید خارج از سامانه احراز شود.');
 const readyForInformationPreview=checks.filter(x=>x.scope==='preview').every(x=>x.ok);
 const readyForPublicSales=readyForInformationPreview&&checks.filter(x=>x.scope==='sales').every(x=>x.ok);
 return {version:VERSION,generatedAt:new Date(now).toISOString(),readyForInformationPreview,readyForPublicSales,paymentEnabled:false,metrics,checks};
}
module.exports={assess,toCsv,VERSION};
