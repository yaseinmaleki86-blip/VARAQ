'use strict';
// FTS5-based Persian search with normalized Arabic/Persian Unicode variants.
const normalize = value=>String(value??'').normalize('NFKC')
 .replace(/[\u064B-\u065F\u0670\u0640]/g,'')
 .replace(/[يى]/g,'ی').replace(/ك/g,'ک').replace(/ة/g,'ه')
 .replace(/[آأإٱ]/g,'ا').replace(/[ؤ]/g,'و').replace(/[ئ]/g,'ی')
 .replace(/[\u200c\u200d\u200e\u200f\u2066-\u2069]/g,' ')
 .replace(/[۰-۹]/g,c=>String(c.charCodeAt(0)-0x06f0))
 .replace(/[٠-٩]/g,c=>String(c.charCodeAt(0)-0x0660))
 .toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim().replace(/\s+/g,' ');
function migrate(db){
 db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS book_search USING fts5(book_id UNINDEXED,content, tokenize='unicode61 remove_diacritics 2');
 CREATE TRIGGER IF NOT EXISTS book_search_bi AFTER INSERT ON books BEGIN
  INSERT INTO book_search(book_id,content) VALUES(NEW.id,replace(replace(replace(replace(replace(replace(replace(replace(NEW.title||' '||NEW.author||' '||NEW.category||' '||NEW.publisher||' '||NEW.isbn||' '||COALESCE((SELECT GROUP_CONCAT(translator||' '||publisher||' '||isbn,' ') FROM editions WHERE book_id=NEW.id),''),'ي','ی'),'ى','ی'),'ك','ک'),'آ','ا'),'أ','ا'),'إ','ا'),'‌',' '),'ة','ه'));
 END;
 CREATE TRIGGER IF NOT EXISTS book_search_bu AFTER UPDATE OF title,author,category,publisher,isbn ON books BEGIN
  DELETE FROM book_search WHERE book_id=OLD.id;
  INSERT INTO book_search(book_id,content) VALUES(NEW.id,replace(replace(replace(replace(replace(replace(replace(replace(NEW.title||' '||NEW.author||' '||NEW.category||' '||NEW.publisher||' '||NEW.isbn||' '||COALESCE((SELECT GROUP_CONCAT(translator||' '||publisher||' '||isbn,' ') FROM editions WHERE book_id=NEW.id),''),'ي','ی'),'ى','ی'),'ك','ک'),'آ','ا'),'أ','ا'),'إ','ا'),'‌',' '),'ة','ه'));
 END;
 CREATE TRIGGER IF NOT EXISTS book_search_bd AFTER DELETE ON books BEGIN DELETE FROM book_search WHERE book_id=OLD.id; END;
 CREATE TRIGGER IF NOT EXISTS book_search_ei AFTER INSERT ON editions BEGIN
  DELETE FROM book_search WHERE book_id=NEW.book_id;
  INSERT INTO book_search(book_id,content) SELECT id,replace(replace(replace(replace(replace(replace(replace(replace(title||' '||author||' '||category||' '||publisher||' '||isbn||' '||COALESCE((SELECT GROUP_CONCAT(translator||' '||publisher||' '||isbn,' ') FROM editions WHERE book_id=NEW.book_id),''),'ي','ی'),'ى','ی'),'ك','ک'),'آ','ا'),'أ','ا'),'إ','ا'),'‌',' '),'ة','ه') FROM books WHERE id=NEW.book_id;
 END;
 CREATE TRIGGER IF NOT EXISTS book_search_eu AFTER UPDATE OF book_id,translator,publisher,isbn ON editions BEGIN
  DELETE FROM book_search WHERE book_id=OLD.book_id;DELETE FROM book_search WHERE book_id=NEW.book_id;
  INSERT INTO book_search(book_id,content) SELECT id,replace(replace(replace(replace(replace(replace(replace(replace(title||' '||author||' '||category||' '||publisher||' '||isbn||' '||COALESCE((SELECT GROUP_CONCAT(translator||' '||publisher||' '||isbn,' ') FROM editions WHERE book_id=OLD.book_id),''),'ي','ی'),'ى','ی'),'ك','ک'),'آ','ا'),'أ','ا'),'إ','ا'),'‌',' '),'ة','ه') FROM books WHERE id=OLD.book_id;
  INSERT INTO book_search(book_id,content) SELECT id,replace(replace(replace(replace(replace(replace(replace(replace(title||' '||author||' '||category||' '||publisher||' '||isbn||' '||COALESCE((SELECT GROUP_CONCAT(translator||' '||publisher||' '||isbn,' ') FROM editions WHERE book_id=NEW.book_id),''),'ي','ی'),'ى','ی'),'ك','ک'),'آ','ا'),'أ','ا'),'إ','ا'),'‌',' '),'ة','ه') FROM books WHERE id=NEW.book_id AND NEW.book_id<>OLD.book_id;
 END;
 CREATE TRIGGER IF NOT EXISTS book_search_ed AFTER DELETE ON editions BEGIN
  DELETE FROM book_search WHERE book_id=OLD.book_id;
  INSERT INTO book_search(book_id,content) SELECT id,replace(replace(replace(replace(replace(replace(replace(replace(title||' '||author||' '||category||' '||publisher||' '||isbn||' '||COALESCE((SELECT GROUP_CONCAT(translator||' '||publisher||' '||isbn,' ') FROM editions WHERE book_id=OLD.book_id),''),'ي','ی'),'ى','ی'),'ك','ک'),'آ','ا'),'أ','ا'),'إ','ا'),'‌',' '),'ة','ه') FROM books WHERE id=OLD.book_id;
 END;`);
 // Upgrade existing v0.8 storage once; triggers maintain subsequent changes.
 const count=db.prepare('SELECT count(*) AS n FROM book_search').get().n;
 const total=db.prepare('SELECT count(*) AS n FROM books').get().n;
 if(count!==total){
  db.exec('BEGIN IMMEDIATE');
  try{
   db.exec('DELETE FROM book_search');
   db.exec(`INSERT INTO book_search(book_id,content)
    SELECT b.id,replace(replace(replace(replace(replace(replace(replace(replace(b.title||' '||b.author||' '||b.category||' '||b.publisher||' '||b.isbn||' '||COALESCE((SELECT GROUP_CONCAT(e.translator||' '||e.publisher||' '||e.isbn,' ') FROM editions e WHERE e.book_id=b.id),''),'ي','ی'),'ى','ی'),'ك','ک'),'آ','ا'),'أ','ا'),'إ','ا'),'‌',' '),'ة','ه') FROM books b`);
   db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}
 }
}
const bookPrices=`LEFT JOIN stock_items o ON o.book_id=b.id
 LEFT JOIN editions priced_e ON priced_e.id=o.edition_id
 LEFT JOIN stores s ON s.id=o.store_id`;
const priceExpr=`MIN(CASE WHEN o.active=1 AND o.quantity>0 AND (o.edition_id IS NULL OR priced_e.verified=1) AND s.active=1 THEN o.price END) AS price`;
const publisherWhere=`(b.publisher=? OR EXISTS(SELECT 1 FROM editions publisher_e WHERE publisher_e.book_id=b.id AND publisher_e.publisher=? AND publisher_e.verified=1))`;
function search(db,{q='',category='',categoryValues=[],publisher='',author='',sort='relevance',coverStatus='all',page=1,perPage=24}={}){
 const words=normalize(q).split(' ').filter(x=>x.length>0).slice(0,10);
 const match=words.map(w=>'"'+w.replace(/"/g,'')+'"*').join(' AND ');
 const args=[];let joins='';let where='WHERE 1=1';
 if(q&&words.length===0)return {total:0,rows:[]};
 if(q){joins+=' JOIN book_search ON CAST(book_search.book_id AS INTEGER)=b.id';where+=' AND book_search MATCH ?';args.push(match);}
 if(category){if(!categoryValues.length)categoryValues=[category];where+=' AND b.category IN ('+categoryValues.map(()=>'?').join(',')+')';args.push(...categoryValues);}
 if(publisher){where+=' AND '+publisherWhere;args.push(publisher,publisher);}
 if(author){where+=' AND b.author=?';args.push(author);}
 // Only real, locally uploaded image assets are included. A candidate URL is not evidence of a licensed upload.
 if(coverStatus==='uploaded')where+=` AND (EXISTS (SELECT 1 FROM book_covers bc WHERE bc.book_id=b.id)
 OR EXISTS (SELECT 1 FROM edition_cover_assets ca JOIN editions ce ON ce.id=ca.edition_id WHERE ce.book_id=b.id AND ce.verified=1))`;
 if(coverStatus==='missing')where+=` AND NOT EXISTS (SELECT 1 FROM book_covers bc WHERE bc.book_id=b.id)
 AND NOT EXISTS (SELECT 1 FROM edition_cover_assets ca JOIN editions ce ON ce.id=ca.edition_id WHERE ce.book_id=b.id AND ce.verified=1)`;
 const total=db.prepare(`SELECT COUNT(DISTINCT b.id) AS n FROM books b ${joins} ${where}`).get(...args).n;
 const ranking=q?'MIN(CASE WHEN b.title LIKE ? THEN 0 WHEN b.author LIKE ? THEN 1 ELSE 2 END) AS relevance,':'0 AS relevance,';
 const ordering=sort==='title'?'b.title COLLATE NOCASE ASC,b.id ASC':sort==='author'?"CASE WHEN TRIM(b.author)='' THEN 1 ELSE 0 END,b.author COLLATE NOCASE ASC,b.title ASC,b.id ASC":sort==='newest'?'b.id DESC':q?'relevance ASC,b.title ASC':'b.id ASC';
 const rows=db.prepare(`SELECT b.*,${ranking} ${priceExpr} FROM books b ${joins} ${bookPrices} ${where} GROUP BY b.id ORDER BY ${ordering} LIMIT ? OFFSET ?`).all(...(q?['%'+q+'%','%'+q+'%']:[]),...args,perPage,(page-1)*perPage);
 return {total,rows};
}
function authors(db,{q='',page=1,perPage=36}={}){
 const where=q?'WHERE author LIKE ?':'WHERE author<>\'\'';
 const arg=q?['%'+q+'%']:[];
 const total=db.prepare(`SELECT count(*) AS n FROM (SELECT author FROM books ${where} AND author<>'' GROUP BY author)`).get(...arg).n;
 const rows=db.prepare(`SELECT author AS name,COUNT(*) AS total FROM books ${where} AND author<>'' GROUP BY author ORDER BY author COLLATE NOCASE LIMIT ? OFFSET ?`).all(...arg,perPage,(page-1)*perPage);
 return {total,rows};
}
function publishers(db,{q='',page=1,perPage=36}={}){
 const filter=q?'WHERE name LIKE ?':'';const args=q?['%'+q+'%']:[];
 const cte=`WITH names AS (SELECT id AS book_id,trim(publisher) AS name FROM books WHERE trim(publisher)<>'' UNION SELECT book_id,trim(publisher) AS name FROM editions WHERE verified=1 AND trim(publisher)<>'')`;
 const total=db.prepare(`${cte} SELECT count(*) AS n FROM (SELECT name FROM names ${filter} GROUP BY name)`).get(...args).n;
 const rows=db.prepare(`${cte} SELECT name,COUNT(DISTINCT book_id) total FROM names ${filter} GROUP BY name ORDER BY name COLLATE NOCASE LIMIT ? OFFSET ?`).all(...args,perPage,(page-1)*perPage);
 return {total,rows};
}
function personBooks(db,{kind,name,page=1,perPage=24}){
 const where=kind==='author'?'WHERE b.author=?':`WHERE ${publisherWhere}`;
 const args=kind==='author'?[name]:[name,name];
 const total=db.prepare(`SELECT COUNT(*) AS n FROM books b ${where}`).get(...args).n;
 const rows=db.prepare(`SELECT b.*,${priceExpr} FROM books b ${bookPrices} ${where} GROUP BY b.id ORDER BY b.title COLLATE NOCASE LIMIT ? OFFSET ?`).all(...args,perPage,(page-1)*perPage);
 return {total,rows};
}
module.exports={normalize,migrate,search,authors,publishers,personBooks};
