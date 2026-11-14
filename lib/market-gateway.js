'use strict';
// Local-only same-origin gateway: no generic proxy, no external host selection.
const http = require('node:http');
const crypto = require('node:crypto');
const secret = String(process.env.VARAQ_BRIDGE_SECRET || '');
const enabled = /^[a-f0-9]{64,}$/i.test(secret);
const port = Number(process.env.VARAQ_MARKET_PORT || 8765);
if (enabled && (!Number.isSafeInteger(port) || port < 1024 || port > 65535))
  throw new Error('Invalid VARAQ_MARKET_PORT');
function sign(user, storeName = '') {
  if (!enabled || !user || !['owner','seller'].includes(user.role)) return null;
  if (user.must_change_password || (user.role === 'seller' && user.staff_permission !== 'manager')) return null;
  const msg = {
    id: Number(user.id), name: String(user.username).slice(0, 50), role: user.role,
    store_id: Number(user.store_id || 0), store_name: String(storeName).slice(0, 100),
    permission: user.staff_permission || 'manager', ts: Math.floor(Date.now()/1000),
    nonce: crypto.randomBytes(12).toString('hex')
  };
  const raw = Buffer.from(JSON.stringify(msg)).toString('base64url');
  return raw+'.'+crypto.createHmac('sha256', Buffer.from(secret,'hex')).update(raw).digest('hex');
}
function forward(req,res,identity={}) {
  if (!enabled) {res.writeHead(503);res.end('Integration disabled');return;}
  const targetPath=req.url.slice('/market'.length) || '/';
  if(!targetPath.startsWith('/') || targetPath.startsWith('//')){res.writeHead(400);res.end('Bad path');return;}
  const len=Number(req.headers['content-length']||0);
  if (Number.isFinite(len) && len>32*1024*1024){res.writeHead(413);res.end('Request too large');return;}
  const headers={...req.headers};
  for(const key of ['host','connection','proxy-connection','upgrade','x-varaq-bridge',
                   'x-forwarded-for','x-forwarded-host','x-forwarded-proto','forwarded','te','trailer']) delete headers[key];
  headers.host='127.0.0.1:'+port;
  const assertion=sign(identity.user,identity.storeName);
  if(assertion)headers['x-varaq-bridge']=assertion;
  const upstream=http.request({hostname:'127.0.0.1',port,method:req.method,path:targetPath,headers,timeout:20000}, response=>{
    const out={...response.headers};
    for(const key of ['connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailer','transfer-encoding','upgrade']) delete out[key];
    if(typeof out.location==='string' && out.location.startsWith('/') && !out.location.startsWith('/market/')) {
      out.location='/market'+out.location;
    }
    // The retail backend emits Path=/market in unified mode; never let its cookie overwrite Node's / session.
    if(out['set-cookie'])out['set-cookie']=[].concat(out['set-cookie']).map(x=>x.replace(/;\s*Path=\/(?:;|$)/i,'; Path=/market;'));
    res.writeHead(response.statusCode||502,out);
    response.pipe(res);
  });
  upstream.on('timeout',()=>upstream.destroy(new Error('market timeout')));
  upstream.on('error',()=>{
    if(!res.headersSent){res.writeHead(503,{'Content-Type':'text/plain; charset=utf-8'});res.end('بخش فروشگاه در حال حاضر در دسترس نیست.');}
    else res.destroy();
  });
  let size=0;
  req.on('data',chunk=>{size+=chunk.length;if(size>32*1024*1024)upstream.destroy(new Error('market upload too large'));});
  req.pipe(upstream);
}
module.exports={enabled,sign,forward};
