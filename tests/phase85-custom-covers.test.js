'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..');
const books=JSON.parse(fs.readFileSync(path.join(root,'data/books.json'),'utf8'));
const manifest=JSON.parse(fs.readFileSync(path.join(root,'data/CUSTOM_COVER_MANIFEST_V85.json'),'utf8'));
test('8.5: all 200 catalog entries have two distinct valid cover assets',()=>{
 assert.equal(books.length,1000);assert.equal(manifest.books.length,200);
 const checksums=new Set();
 for(const b of books.filter(b=>b.id<=200)){
  const rec=manifest.books.find(x=>x.id===b.id);assert.ok(rec);assert.equal(rec.title,b.title);assert.equal(rec.publisher_cover_verified,false);
  const filename=`book-${String(b.id).padStart(3,'0')}.webp`;
  const full=fs.readFileSync(path.join(root,'public/concept-art',filename));
  const thumb=fs.readFileSync(path.join(root,'public/concept-thumb',filename));
  assert.equal(full.toString('ascii',0,4),'RIFF');assert.equal(full.toString('ascii',8,12),'WEBP');
  assert.equal(thumb.toString('ascii',8,12),'WEBP');assert.ok(thumb.length<full.length);
  const sum=crypto.createHash('sha256').update(full).digest('hex');assert.equal(sum,rec.sha256);assert.ok(!checksums.has(sum),'duplicate artwork '+filename);checksums.add(sum);
 }
});
test('8.5: all concept image paths use new cache key without changing payment policy',()=>{
 const server=fs.readFileSync(path.join(root,'server.js'),'utf8');
 assert.ok(server.includes('/concept-art/book-${n}.webp?v=86'));
 assert.ok(server.includes('/concept-thumb/book-${n}.webp?v=86'));
 assert.ok(server.includes('جلد رسمی ناشر نیست'));
 const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));assert.equal(pkg.version,'8.6.0');
});
