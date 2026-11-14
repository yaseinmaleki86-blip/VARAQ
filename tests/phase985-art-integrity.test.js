const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const root=path.resolve(__dirname,'..');
const read=(p)=>fs.readFileSync(path.join(root,p));
test('v985: the precise book 22 cover and thumbnail are nonempty and distinct',()=>{
  const image=read('public/concept-art/book-022.webp');
  const thumb=read('public/concept-thumb/book-022.webp');
  assert.ok(image.length>100000);
  assert.ok(thumb.length>10000);
  assert.equal(image.toString('ascii',0,4),'RIFF');
  assert.equal(image.toString('ascii',8,12),'WEBP');
  assert.notEqual(crypto.createHash('sha256').update(image).digest('hex'),crypto.createHash('sha256').update(thumb).digest('hex'));
});
test('v985: catalog count, review state and Tailscale are preserved',()=>{
  const b=JSON.parse(read('data/books.json'));
  const q=JSON.parse(read('data/COVER_ART_HUMAN_REVIEW_V985.json'));
  assert.equal(b.length,1000);
  assert.equal(q.records.length,1000);
  assert.equal(q.records[21].title,'هزار خورشید تابان');
  assert.equal(q.records[21].art_review_status,'new_scenic_cover_awaiting_human_review');
  assert.equal(q.records[22].art_review_status,'requires_non_schematic_redesign');
  assert.ok(fs.existsSync(path.join(root,'START_WITH_TAILSCALE_WINDOWS.bat')));
});
test('v985: user-visible concept art status does not claim all images are finished',()=>{
  const s=read('server.js').toString('utf8');
  assert.match(s,/const coverVersion=985/);
  assert.match(s,/NEW_SCENIC_COVER_IDS_V985/);
  assert.match(s,/در صف بازطراحی/);
  assert.match(s,/تصویرسازی داستانی ورق/);
});
