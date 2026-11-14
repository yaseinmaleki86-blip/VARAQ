'use strict';
const path=require('node:path');
const diagnostics=require('../lib/operational-status');
const root=path.resolve(__dirname,'..');
const report=diagnostics.run({root,dataDir:path.resolve(process.env.DATA_DIR||path.join(root,'storage'))});
if(process.argv.includes('--json'))process.stdout.write(JSON.stringify(report,null,2)+'\n');
else{
 console.log(`VARAQ ${report.version} — وضعیت عملیاتی فقط‌خواندنی`);
 for(const c of report.checks)console.log(`${c.ok?'[OK]':'[ACTION]'} ${c.code}: ${c.detail}`);
 console.log(`رخدادهای سرور در ۲۴ ساعت اخیر: ${report.incidentCount24h}`);
 console.log('فروش و دانلود پولی: غیرفعال؛ گزارش فنی مجوز انتشار عمومی یا تجاری نیست.');
}
if(process.argv.includes('--strict')&&!report.technicalChecksPassed)process.exitCode=1;
