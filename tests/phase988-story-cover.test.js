'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.join(__dirname,'..');
const {validateImage}=require('../lib/images');
const books=require('../data/books.json');
const review=require('../data/COVER_ART_HUMAN_REVIEW_V988.json');
const src=fs.readFileSync(path.join(root,'server.js'),'utf8');
const artPath=i=>path.join(root,'public','concept-art',`book-${String(i).padStart(3,'0')}.webp`);
const thumbPath=i=>path.join(root,'public','concept-thumb',`book-${String(i).padStart(3,'0')}.webp`);
test('9.8.8: one new story illustration, truthful art-review status',()=>{
 assert.equal(books.length,1000);
 assert.deepEqual(review.newly_replaced_book_ids,[25]);
 assert.deepEqual(review.all_new_illustrated_cover_ids_since_984,[21,22,23,24,25]);
 assert.equal(review.records.length,1000);
 assert.equal(review.records[24].title,'مردی به نام اوه');
 assert.equal(review.records[24].art_review_status,'new_scenic_cover_awaiting_human_review');
 assert.equal(review.records[25].art_review_status,'requires_non_schematic_redesign');
 assert.equal(review.pending_visual_review_count,1000);
 assert.match(src,/NEW_SCENIC_COVER_IDS_V988 = new Set\(\[21,22,23,24,25\]\)/);
 assert.match(src,/const coverVersion=988;/);
});
test('9.8.8: all 1000 unique covers + 1000 thumbnails remain valid',()=>{
 const hashes=new Set();
 for (let i=1;i<=1000;i++){
  const a=fs.readFileSync(artPath(i));const t=fs.readFileSync(thumbPath(i));
  const A=validateImage(a),T=validateImage(t);
  assert.equal(A.mime,'image/webp');assert.equal(T.mime,'image/webp');
  assert.ok(A.width>=480&&A.height>=672,`cover too small #${i}`);
  assert.equal(T.width,240);assert.equal(T.height,336);
  const h=require('node:crypto').createHash('sha256').update(a).digest('hex');
  assert.ok(!hashes.has(h),`duplicate #${i}`);hashes.add(h);
 }
 const A=validateImage(fs.readFileSync(artPath(25)));
 assert.equal(A.width,1000);assert.equal(A.height,1400);
});
