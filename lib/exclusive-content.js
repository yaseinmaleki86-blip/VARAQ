'use strict';
const data=require('../data/exclusive_content_v990.json');
const rows=new Map(data.records.map(r=>[r.id,Object.freeze(r)]));
function forBook(book){
 const r=rows.get(Number(book.id));
 return r&&r.title===book.title&&r.slug===book.slug?r:null;
}
module.exports={forBook,count:rows.size};
