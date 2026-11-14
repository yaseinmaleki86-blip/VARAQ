'use strict';
const fs=require('node:fs'),path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const review=require('../lib/generated-editorial-review');
const catalogue=require('../data/generated_catalog_v63.json');
const root=path.resolve(__dirname,'..'),data=path.resolve(process.env.DATA_DIR||path.join(root,'storage'));
const dbPath=path.join(data,'varaq.sqlite');
if(!fs.existsSync(dbPath)){console.error('اول سایت را اجرا کنید تا دیتابیس ساخته شود.');process.exit(1);}
const db=new DatabaseSync(dbPath,{readOnly:true});
try{
 const output=path.resolve(process.argv[2]||path.join(root,'VARAQ_Editorial_Review_200.csv'));
 fs.writeFileSync(output,review.csv(db,catalogue));
 console.log('فهرست بررسی ۲۰۰ معرفی:',output,'| تعداد ردیف:',review.rows(db,catalogue).length);
}finally{db.close();}
