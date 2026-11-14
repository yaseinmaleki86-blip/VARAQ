'use strict';
// Editable homepage content; no third-party scripts or externally supplied URLs.
const DEFAULTS=Object.freeze({
 eyebrow:'کتابخانه‌ای برای کشف‌های تازه',
 hero_title:'هر کتاب، آغاز یک',
 hero_accent:'دنیای تازه است.',
 hero_description:'کتاب‌ها را بشناس، ترجمه‌ها و چاپ‌ها را مقایسه کن و از کتاب‌فروشی‌های مستقل حمایت کن.',
 primary_label:'کشف کتاب‌ها',primary_href:'/books',
 secondary_label:'کتاب‌های کمک‌درسی',secondary_href:'/educational',
 show_categories:1,show_selected:1,show_trust:1,
});
const MAX_BANNERS=12;
const POSITIONS={after_hero:'پس از معرفی اصلی',after_categories:'پس از دسته‌بندی‌ها'};
function initialize(db){
 db.exec(`CREATE TABLE IF NOT EXISTS homepage_settings(
  id INTEGER PRIMARY KEY CHECK(id=1),
  eyebrow TEXT NOT NULL,hero_title TEXT NOT NULL,hero_accent TEXT NOT NULL,
  hero_description TEXT NOT NULL,primary_label TEXT NOT NULL,primary_href TEXT NOT NULL,
  secondary_label TEXT NOT NULL,secondary_href TEXT NOT NULL,
  show_categories INTEGER NOT NULL DEFAULT 1 CHECK(show_categories IN (0,1)),
  show_selected INTEGER NOT NULL DEFAULT 1 CHECK(show_selected IN (0,1)),
  show_trust INTEGER NOT NULL DEFAULT 1 CHECK(show_trust IN (0,1)),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
 );
 CREATE TABLE IF NOT EXISTS homepage_banners(
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '',
  label TEXT NOT NULL DEFAULT '',href TEXT NOT NULL DEFAULT '/books',
  placement TEXT NOT NULL CHECK(placement IN ('after_hero','after_categories')),
  sort_order INTEGER NOT NULL DEFAULT 0 CHECK(sort_order BETWEEN 0 AND 999),
  active INTEGER NOT NULL DEFAULT 0 CHECK(active IN (0,1)),
  filename TEXT UNIQUE,mime TEXT,image_alt TEXT NOT NULL DEFAULT '',
  image_source TEXT NOT NULL DEFAULT '',rights_note TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
 );
 CREATE INDEX IF NOT EXISTS idx_homepage_banners_active ON homepage_banners(active,placement,sort_order,id);
 `);
 db.prepare(`INSERT OR IGNORE INTO homepage_settings(id,eyebrow,hero_title,hero_accent,hero_description,primary_label,primary_href,secondary_label,secondary_href,show_categories,show_selected,show_trust)
 VALUES(1,?,?,?,?,?,?,?,?,?,?,?)`).run(...Object.values(DEFAULTS));
}
function text(s,max){const v=String(s??'').trim();return v.length<=max?v:null;}
function safeHref(value){
 const v=text(value,220);
 if(!v||!v.startsWith('/')||v.startsWith('//')||v.includes('\\')||/[\u0000-\u001f\u007f]/.test(v))return null;
 let url;try{url=new URL(v,'https://varaq.local');}catch{return null;}
 if(url.origin!=='https://varaq.local'||url.hash)return null;
 const allowed=['/','/books','/educational','/stores','/authors','/publishers','/about'];
 if(!allowed.includes(url.pathname)&&!/^\/(book\/[a-zA-Z0-9_-]{1,120}|category\/[a-zA-Z0-9_-]{1,120}|store\/[0-9]{1,8})$/.test(url.pathname))return null;
 return v;
}
function validation(message){const e=new Error(message);e.userError=true;throw e;}
function homepage(db){return db.prepare('SELECT * FROM homepage_settings WHERE id=1').get();}
function updateSettings(db,f){
 const values={};
 for(const [key,max] of Object.entries({eyebrow:90,hero_title:100,hero_accent:100,hero_description:320,primary_label:45,secondary_label:45})){
  const value=text(f[key],max);if(value===null||(!value&&key!=='eyebrow'))validation('متن صفحه اصلی بیش از حد طولانی یا خالی است: '+key);
  values[key]=value;
 }
 for(const key of ['primary_href','secondary_href']){values[key]=safeHref(f[key]);if(!values[key])validation('لینک باید داخلی و معتبر باشد: '+key);}
 for(const key of ['show_categories','show_selected','show_trust'])values[key]=f[key]==='1'?1:0;
 const keys=Object.keys(values);
 db.prepare(`UPDATE homepage_settings SET ${keys.map(k=>k+'=?').join(',')}, updated_at=CURRENT_TIMESTAMP WHERE id=1`).run(...keys.map(k=>values[k]));
 return homepage(db);
}
function listBanners(db,placement,activeOnly=false){
 const sql='SELECT * FROM homepage_banners WHERE '+(placement?'placement=? AND ':'')+(activeOnly?'active=1':'1=1')+' ORDER BY sort_order ASC,id DESC'+(activeOnly?' LIMIT 4':'');
 return db.prepare(sql).all(...(placement?[placement]:[]));
}
function saveBanner(db,f){
 const id=Number(f.id||0);
 if(!Number.isSafeInteger(id)||id<0)validation('شناسه بنر نامعتبر است.');
 const title=text(f.title,100),summary=text(f.summary,250),label=text(f.label,45),href=safeHref(f.href),placement=String(f.placement||'');
 const order=Number(f.sort_order??0),active=f.active==='1'?1:0;
 if(!title||summary===null||label===null||!href||!POSITIONS[placement]||!Number.isSafeInteger(order)||order<0||order>999)validation('اطلاعات بنر یا لینک داخلی آن معتبر نیست.');
 if(id){
  const original=db.prepare('SELECT id FROM homepage_banners WHERE id=?').get(id);if(!original)validation('بنر یافت نشد.');
  db.prepare('UPDATE homepage_banners SET title=?,summary=?,label=?,href=?,placement=?,sort_order=?,active=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(title,summary,label,href,placement,order,active,id);
  return id;
 }
 if(db.prepare('SELECT COUNT(*) n FROM homepage_banners').get().n>=MAX_BANNERS)validation('حداکثر تعداد بنرها ۱۲ عدد است؛ ابتدا یک بنر را حذف کنید.');
 return Number(db.prepare('INSERT INTO homepage_banners(title,summary,label,href,placement,sort_order,active) VALUES(?,?,?,?,?,?,?)').run(title,summary,label,href,placement,order,active).lastInsertRowid);
}
function deleteBanner(db,id){
 if(!Number.isSafeInteger(Number(id))||Number(id)<=0)validation('شناسه بنر نامعتبر است.');
 const banner=db.prepare('SELECT * FROM homepage_banners WHERE id=?').get(Number(id));if(!banner)validation('بنر یافت نشد.');
 db.prepare('DELETE FROM homepage_banners WHERE id=?').run(Number(id));return banner;
}
module.exports={DEFAULTS,POSITIONS,initialize,homepage,updateSettings,listBanners,saveBanner,deleteBanner,safeHref};
