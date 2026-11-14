'use strict';
// VARAQ 7.4: compact, source-grounded refinements of the actual catalogue.
// Nothing is inferred about popularity or the quality of a book.
const discovery = require('./discovery');
const MAX_ROWS = 500;
function groups(rows,field,limit){
 const counts=new Map();
 for(const row of rows){const value=String(row[field]||'').trim();if(!value)continue;
  counts.set(value,(counts.get(value)||0)+1);
 }
 return [...counts].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0],'fa')).slice(0,limit).map(([value,count])=>({value,count}));
}
function get(db,{q='',category='',categoryValues=[],publisher='',author='',coverStatus='all'}={}){
 // Query using the same FTS/search/filter semantics as the visible catalogue.
 // Each facet omits only its own selection so users can switch choices.
 const query={q,category,categoryValues,publisher,author,coverStatus,perPage:MAX_ROWS,page:1};
 const categoryRows=discovery.search(db,{...query,category:'',categoryValues:[]}).rows;
 const authorRows=discovery.search(db,{...query,author:''}).rows;
 return {
  categories:groups(categoryRows,'category',8),
  authors:groups(authorRows,'author',8),
  limited:categoryRows.length===MAX_ROWS||authorRows.length===MAX_ROWS
 };
}
module.exports={groups,get};
