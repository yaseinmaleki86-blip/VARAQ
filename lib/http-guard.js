'use strict';
// In addition to per-session CSRF tokens, reject cross-site browser submissions,
// including anonymous login/bootstrap and public demo actions.
function isLoopback(host){return ['localhost','127.0.0.1','[::1]','::1'].includes(host);}
function acceptableOrigin(origin,publicUrl){
 try{
  const submitted=new URL(origin);
  const configured=new URL(publicUrl);
  if(!['http:','https:'].includes(submitted.protocol)||submitted.username||submitted.password||submitted.pathname!=='/'||submitted.search||submitted.hash)return false;
  if(submitted.origin===configured.origin)return true;
  // Local Windows scripts open localhost even when the development HTTP client uses 127.0.0.1.
  return !process.env.PUBLIC_URL&&isLoopback(submitted.hostname)&&isLoopback(configured.hostname)&&submitted.port===configured.port&&submitted.protocol===configured.protocol;
 }catch{return false;}
}
function allowUnsafeRequest(req,publicUrl){
 if(req.method!=='POST')return true;
 const fetchSite=String(req.headers['sec-fetch-site']||'').toLowerCase();
 if(fetchSite==='cross-site')return false;
 if(Object.hasOwn(req.headers,'origin'))return acceptableOrigin(String(req.headers.origin),publicUrl);
 // Origin is not sent by some programmatic HTTP clients; authenticated writes still require CSRF.
 return true;
}
module.exports={allowUnsafeRequest,acceptableOrigin};
