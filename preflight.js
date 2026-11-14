'use strict';
// VARAQ 5.0: same fail-closed inspection for CLI and administrator dashboard.
const fs=require('node:fs');
const path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const audit=require('./lib/release-audit');
const data=path.resolve(process.env.DATA_DIR||path.join(__dirname,'storage'));
const file=path.join(data,'varaq.sqlite');
let db=null,report;
try{
 if(fs.existsSync(file))db=new DatabaseSync(file,{readOnly:true});
 report=audit.assess({db,dataDir:data});
}finally{db?.close();}
if(process.argv.includes('--json'))console.log(JSON.stringify(report,null,2));
else if(process.argv.includes('--csv'))process.stdout.write(audit.toCsv(report));
else{
 console.log('VARAQ '+audit.VERSION+' — گزارش آمادگی انتشار');
 for(const item of report.checks)console.log(`${item.ok?'[OK]  ':'[TODO]'} [${item.scope==='preview'?'نمایش':'فروش'}] ${item.id} — ${item.detail}`);
 console.log('\nنمایش عمومی: '+(report.readyForInformationPreview?'معیارهای این گزارش پاس شده‌اند؛ تأییدهای انسانی همچنان معتبرسازی مستقل می‌خواهند.':'تأیید نشده'));
 console.log('فروش تجاری: '+(report.readyForPublicSales?'تأیید شده':'NO-GO — درگاه و کنترل‌های تجاری هنوز تکمیل نیستند'));
}
if(process.argv.includes('--strict-preview')&&!report.readyForInformationPreview)process.exitCode=1;
if(process.argv.includes('--strict-sales')&&!report.readyForPublicSales)process.exitCode=1;
