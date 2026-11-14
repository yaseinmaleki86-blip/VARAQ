'use strict';
// 5.1 read-only media audit: local files are checked, external cover URLs are not
// fetched. Database records claiming permission do NOT constitute legal verification.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {validateImage,MAX_COVER_BYTES}=require('./images');
const {MAX_PDF_BYTES}=require('./pdf-store');
const {todayTehran}=require('./pdf-rights');
const LOCAL_COVER=/^[a-f0-9]{32}\.(?:jpg|png|webp)$/;
const LOCAL_PDF=/^[a-f0-9]{32}\.pdf$/;
const MIME={'jpg':'image/jpeg','png':'image/png','webp':'image/webp'};
function checkCover(dir,filename,mime){
 if(!LOCAL_COVER.test(String(filename||'')))return {state:'invalid_path',detail:'نام فایل غیرمجاز است'};
 const extension=filename.split('.').pop();
 if(mime!==MIME[extension])return {state:'invalid_mime',detail:'نوع تصویر با پسوند سازگار نیست'};
 try{
  const full=path.join(dir,filename),s=fs.lstatSync(full);
  if(!s.isFile()||s.isSymbolicLink()||s.size<32||s.size>MAX_COVER_BYTES)return {state:'invalid_file',detail:'نوع یا حجم فایل غیرمجاز است'};
  const parsed=validateImage(fs.readFileSync(full));
  if(parsed.mime!==mime||parsed.ext!==extension)return {state:'invalid_mime',detail:'امضای فایل با نوع ثبت‌شده مطابقت ندارد'};
  return {state:'ok',detail:`تصویر قابل خواندن: ${parsed.width} × ${parsed.height}`};
 }catch(e){
  return {state:e.code==='ENOENT'?'missing_file':'invalid_file',detail:e.code==='ENOENT'?'فایل روی دیسک وجود ندارد':'فایل تصویر خراب یا غیرقابل‌خواندن است'};
 }
}
function checkPdf(dir,row){
 const filename=String(row.filename||'');
 if(!LOCAL_PDF.test(filename))return {state:'invalid_path',detail:'نام فایل PDF غیرمجاز است'};
 try{
  const full=path.join(dir,filename),s=fs.lstatSync(full);
  if(!s.isFile()||s.isSymbolicLink()||s.size<100||s.size>MAX_PDF_BYTES||s.size!==row.file_bytes)return {state:'invalid_file',detail:'اندازه یا نوع فایل PDF با رکورد مطابقت ندارد'};
  if(!/^[a-f0-9]{64}$/.test(String(row.file_sha256||'')))return {state:'invalid_hash',detail:'چک‌سام ثبت‌شده معتبر نیست'};
  const b=fs.readFileSync(full);
  if(!b.subarray(0,8).toString('latin1').match(/^%PDF-[12]\./)||!b.subarray(-2048).toString('latin1').includes('%%EOF'))return {state:'invalid_file',detail:'امضای فایل PDF معتبر نیست'};
  if(crypto.createHash('sha256').update(b).digest('hex')!==row.file_sha256)return {state:'invalid_hash',detail:'SHA-256 فایل با رکورد مطابقت ندارد'};
  return {state:'ok',detail:'سلامت فایل و SHA-256 تأیید فنی شد؛ نه اعتبار حقوق فروش'};
 }catch(e){return {state:e.code==='ENOENT'?'missing_file':'invalid_file',detail:e.code==='ENOENT'?'PDF در فضای خصوصی وجود ندارد':'PDF غیرقابل‌خواندن است'};}
}
function safeRows(db,dir){
 const out=[],coverDir=path.join(dir,'covers'),pdfDir=path.join(dir,'digital-pdfs');
 const books=db.prepare('SELECT id,title,slug FROM books ORDER BY id').all();
 const coverage=new Map(books.map(b=>[b.id,{local:false,external:false,record:false}]));
 const names=new Set(),pdfNames=new Set();
 const add=(type,bookId,title,filename,record,scan,extra={})=>out.push({type,book_id:bookId||'',title:title||'',filename:filename||'',state:scan.state,detail:scan.detail,reference:record||'',...extra});
 for(const c of db.prepare('SELECT c.*,b.title FROM book_covers c JOIN books b ON b.id=c.book_id').all()){
  const scan=checkCover(coverDir,c.filename,c.mime),status=coverage.get(c.book_id);
  status.record=true;if(scan.state==='ok')status.local=true;names.add(c.filename);
  add('book_cover',c.book_id,c.title,c.filename,c.source,scan);
 }
 for(const c of db.prepare('SELECT c.*,e.book_id,e.isbn,b.title,e.verified FROM edition_cover_assets c JOIN editions e ON e.id=c.edition_id JOIN books b ON b.id=e.book_id').all()){
  const scan=checkCover(coverDir,c.filename,c.mime),status=coverage.get(c.book_id);
  status.record=true;if(scan.state==='ok'&&c.verified===1)status.local=true;names.add(c.filename);
  add('edition_cover',c.book_id,c.title,c.filename,c.source,scan,{isbn:c.isbn});
 }
 for(const x of db.prepare(`SELECT e.book_id,b.title,e.isbn,s.cover_url,s.cover_source
 FROM editions e JOIN edition_sources s ON s.edition_id=e.id JOIN books b ON b.id=e.book_id
 WHERE e.verified=1 AND s.cover_matched=1 AND s.rights_confirmed=1 AND s.cover_url<>''`).all()){
  const state=coverage.get(x.book_id);state.external=true;
  add('external_cover',x.book_id,x.title,'',x.cover_source,{state:'external_unverified',detail:'لینک خارجی دارای تأیید ثبت‌شده؛ دسترسی تصویر و اعتبار حقوق آن خودکار بررسی نشده'},{isbn:x.isbn});
 }
 for(const b of books){
  const x=coverage.get(b.id);
  if(!x.local&&!x.external)add('missing_cover',b.id,b.title,'','',{state:x.record?'needs_repair':'missing_cover',detail:x.record?'رکورد تصویر هست، اما فایل سالمِ منطبق پیدا نشد':'جلد قابل‌نمایش تأییدشده‌ای ثبت نشده است'});
 }
 for(const d of db.prepare('SELECT d.*,s.name store_name FROM digital_books d JOIN stores s ON s.id=d.store_id ORDER BY d.id').all()){
  pdfNames.add(d.filename);
  let scan=checkPdf(pdfDir,d);
  if(scan.state==='ok'&&d.distribution_hold)scan={state:'rights_held',detail:'فایل سالم است ولی مجوز توزیع تعلیق شده'};
  if(scan.state==='ok'&&d.rights_expires_on&&d.rights_expires_on<todayTehran())scan={state:'rights_expired',detail:'فایل سالم است ولی مجوز توزیع منقضی شده'};
  add('digital_pdf',d.book_id,d.title,d.filename,d.rights_holder,scan,{store:d.store_name,status:d.status});
 }
 try{
  for(const entry of fs.readdirSync(coverDir,{withFileTypes:true})){
   if(entry.isFile()&&LOCAL_COVER.test(entry.name)&&!names.has(entry.name))add('orphan_cover','','',entry.name,'',{state:'orphan_file',detail:'فایل روی دیسک وجود دارد اما به هیچ جلد ثبت‌شده‌ای متصل نیست؛ حذف خودکار ممنوع'});
  }
 }catch(e){if(e.code!=='ENOENT')throw e;}
 try{
  for(const entry of fs.readdirSync(pdfDir,{withFileTypes:true})){
   if(entry.isFile()&&LOCAL_PDF.test(entry.name)&&!pdfNames.has(entry.name))
    add('orphan_pdf','','',entry.name,'',{state:'orphan_file',detail:'PDF خصوصی بدون رکورد دیتابیس است؛ تا بررسی دستی، حذف یا دانلود عمومی نشود'});
  }
 }catch(e){if(e.code!=='ENOENT')throw e;}
 return out;
}
const actionStates=new Set(['missing_file','invalid_path','invalid_mime','invalid_file','invalid_hash','missing_cover','needs_repair','orphan_file','rights_held','rights_expired']);
function filter(rows,mode='all',q=''){
 const text=String(q||'').trim().toLocaleLowerCase('fa').slice(0,80);
 return rows.filter(r=>{
  if(mode==='problems'&&!actionStates.has(r.state))return false;
  if(mode==='covers'&&!['book_cover','edition_cover','external_cover','missing_cover','orphan_cover'].includes(r.type))return false;
  if(mode==='pdf'&&!['digital_pdf','orphan_pdf'].includes(r.type))return false;
  if(mode==='missing'&&!['missing_cover','needs_repair','missing_file'].includes(r.state))return false;
  if(mode==='ok'&&r.state!=='ok')return false;
  return !text||[r.title,r.filename,r.isbn,r.store,r.reference,String(r.book_id)].some(v=>String(v||'').toLocaleLowerCase('fa').includes(text));
 });
}
function summary(rows){return {records:rows.length,issues:rows.filter(x=>actionStates.has(x.state)).length,missingCovers:rows.filter(x=>x.type==='missing_cover').length,damaged:rows.filter(x=>['missing_file','invalid_file','invalid_hash','invalid_path','invalid_mime'].includes(x.state)).length,digital:rows.filter(x=>x.type==='digital_pdf').length,orphan:rows.filter(x=>x.state==='orphan_file').length,external:rows.filter(x=>x.state==='external_unverified').length};}
function cell(value){let s=String(value??'').replace(/[\x00-\x1f\x7f]/g,' ');if(/^[\s\uFEFF]*[=+@-]/.test(s))s="'"+s;return '"'+s.replace(/"/g,'""')+'"';}
function csv(rows){const fields=['type','book_id','title','isbn','store','status','filename','state','detail','reference'];return '\uFEFF'+[fields,...rows.map(x=>fields.map(k=>x[k]||''))].map(r=>r.map(cell).join(',')).join('\r\n')+'\r\n';}
module.exports={safeRows,checkCover,checkPdf,filter,summary,csv};
