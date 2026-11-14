'use strict';
// Never fetch images from external URLs. Files are copied to a throwaway folder,
// validated by the same importer as the Windows CLI, then erased on any outcome.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const coverBatch = require('./cover-batch');
const {validateImage} = require('./images');
const MAX_IMAGES = 3;
const REQUIRED = ['isbn','source','rights_note','match_evidence','permission_evidence'];
function collect(fields,files){
 const raw=[];
 for(let n=1;n<=MAX_IMAGES;n++){
  const values=Object.fromEntries(REQUIRED.map(k=>[k,String(fields[k+'_'+n]||'').trim()]));
  const file=files['cover_'+n]?.data;
  if(!file && !REQUIRED.some(k=>values[k]))continue;
  if(!file||REQUIRED.some(k=>!values[k]))throw Error('برای جلد شماره '+n+' تمام اطلاعات، سند و فایل تصویر الزامی است.');
  if(REQUIRED.some(k=>/[,\r\n"\x00-\x1f]/.test(values[k]))||values.match_evidence.length>300||values.permission_evidence.length>300)throw Error('مدارک باید متن ساده بدون ویرگول یا سطر جدید و حداکثر ۳۰۰ نویسه باشند.');
  const meta=validateImage(file);
  // Ignore the name supplied by the browser. The image signature determines the extension.
  raw.push({...values,image:file,filename:'approved-cover-'+n+'.'+meta.ext});
 }
 if(!raw.length)throw Error('حداقل یک جلد دارای شابک و مدرک انتخاب کنید.');
 return raw;
}
function run(db,fields,files,target,apply=false){
 const input=collect(fields,files);
 // The secure CSV parser independently verifies unique valid ISBN, evidence lengths
 // and safe filenames. Reject commas/quotes in evidence in the browser just as CLI does.
 const csv='isbn,filename,source,rights_note,match_evidence,permission_evidence\n'+input.map(r=>
  ['isbn','filename','source','rights_note','match_evidence','permission_evidence'].map(k=>r[k]).join(',')
 ).join('\n');
 const records=coverBatch.parseManifest(csv);
 const folder=fs.mkdtempSync(path.join(os.tmpdir(),'varaq-cover-upload-'));
 try{
  for(const item of input)fs.writeFileSync(path.join(folder,item.filename),item.image,{flag:'wx',mode:0o600});
  return coverBatch.processRows(db,records,folder,target,apply);
 }finally{fs.rmSync(folder,{recursive:true,force:true});}
}
module.exports={MAX_IMAGES,collect,run};
