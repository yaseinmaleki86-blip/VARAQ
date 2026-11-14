'use strict';
// Detect missing / accidentally modified shipped source. Not an authenticity signature.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const VERSION='8.6.0', MANIFEST='RELEASE_MANIFEST.json';
const ROOT_DIRS=['data','docs','lib','public','tests','tools'];
function hash(file){return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');}
function filesAt(root){
 const found=[];
 function walk(relative){
  const full=path.join(root,relative);
  for(const entry of fs.readdirSync(full,{withFileTypes:true})){
   if(entry.isSymbolicLink())throw Error('Symbolic link not allowed in release files: '+path.join(relative,entry.name));
   const rel=path.posix.join(relative.replaceAll(path.sep,'/'),entry.name);
   if(entry.isDirectory())walk(rel);
   else if(entry.isFile())found.push(rel);
   else throw Error('Unsupported release file type: '+rel);
  }
 }
 for(const folder of ROOT_DIRS){if(fs.existsSync(path.join(root,folder)))walk(folder);}
 for(const file of fs.readdirSync(root,{withFileTypes:true})){
  if(file.isSymbolicLink())throw Error('Symbolic link in source root: '+file.name);
  if(file.isFile()&&(file.name.endsWith('.js')||file.name.endsWith('.bat')||file.name.endsWith('.sh')||file.name.endsWith('.json')||file.name.endsWith('.md')||file.name.endsWith('.example'))&&file.name!==MANIFEST)found.push(file.name);
 }
 return found.sort();
}
function create(root){
 const files=filesAt(root);
 return {schema:1,app:'VARAQ',version:VERSION,notice:'SHA-256 detects accidental changes; it does not prove author identity or make a package trusted.',files:files.map(rel=>{
  const stat=fs.statSync(path.join(root,rel));return {path:rel,size:stat.size,sha256:hash(path.join(root,rel))};
 })};
}
function verify(root){
 const manifest=JSON.parse(fs.readFileSync(path.join(root,MANIFEST),'utf8'));
 if(manifest.schema!==1||manifest.app!=='VARAQ'||manifest.version!==VERSION||!Array.isArray(manifest.files))throw Error('Unsupported or mismatched release manifest');
 const expected=new Set(),errors=[];
 for(const record of manifest.files){
  const rel=record.path;
  if(typeof rel!=='string'||rel.startsWith('/')||rel.includes('\\')||rel.split('/').some(x=>x==='..'||x===''||x==='.')||expected.has(rel)||!/^[a-f0-9]{64}$/.test(record.sha256)||!Number.isSafeInteger(record.size)||record.size<0){errors.push('Invalid manifest entry: '+String(rel));continue;}
  expected.add(rel);
  const dest=path.join(root,rel);
  try{
   const s=fs.lstatSync(dest);
   if(!s.isFile()||s.isSymbolicLink()||s.size!==record.size||hash(dest)!==record.sha256)errors.push('Altered: '+rel);
  }catch{errors.push('Missing: '+rel);}
 }
 let unexpected=[];
 try{unexpected=filesAt(root).filter(f=>!expected.has(f));}catch(e){errors.push(e.message);}
 return {version:VERSION,passed:errors.length===0&&unexpected.length===0,verifiedFiles:expected.size,errors,unexpectedFiles:unexpected};
}
module.exports={create,verify,VERSION,MANIFEST};
