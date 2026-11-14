'use strict';
// CSV/TSV with UTF-8 BOM, RFC4180 double quotes and embedded newlines.
function csvParse(input){
  const s=String(input||'').replace(/^\uFEFF/,'');
  if(s.length>300000)throw Error('CSV_TOO_LARGE');
  const firstLine=s.split(/\r?\n/,1)[0];
  const choices=[',','\t',';'];
  const d=choices.map(c=>({c,n:firstLine.split(c).length-1})).sort((a,b)=>b.n-a.n)[0].c;
  let quoted=false,row=[],field='',rows=[];
  for(let i=0;i<s.length;i++){
    const c=s[i];
    if(c==='"'){if(quoted&&s[i+1]==='"'){field+='"';i++;}else if(!quoted&&field.trim()===''){quoted=true;}else if(quoted){quoted=false;}else throw Error('CSV_INVALID_QUOTE');}
    else if(c===d&&!quoted){row.push(field.trim());field='';}
    else if((c==='\n'||c==='\r')&&!quoted){if(c==='\r'&&s[i+1]==='\n')i++;row.push(field.trim());if(row.some(v=>v!==''))rows.push(row);row=[];field='';}
    else field+=c;
    if(rows.length>501)throw Error('CSV_TOO_MANY_ROWS');
  }
  if(quoted)throw Error('CSV_UNCLOSED_QUOTE');
  row.push(field.trim());if(row.some(v=>v!==''))rows.push(row);
  if(rows.length<2)throw Error('CSV_EMPTY');
  const keys=rows.shift().map(v=>v.toLowerCase().replace(/\s+/g,'_'));
  const aliases={title:['title','عنوان','نام_کتاب'],author:['author','نویسنده'],category:['category','دسته‌بندی','دسته_بندی','موضوع'],description:['description','توضیحات','معرفی'],publisher:['publisher','ناشر']};
  const cols=Object.fromEntries(Object.entries(aliases).map(([k,v])=>[k,keys.findIndex(a=>v.includes(a))]));
  if(cols.title<0||cols.category<0)throw Error('CSV_REQUIRED_COLUMNS');
  return rows.map((r,i)=>({line:i+2,title:(r[cols.title]||'').trim(),author:cols.author<0?'':(r[cols.author]||'').trim(),category:(r[cols.category]||'').trim(),description:cols.description<0?'':(r[cols.description]||'').trim(),publisher:cols.publisher<0?'':(r[cols.publisher]||'').trim()}));
}
module.exports={csvParse};
