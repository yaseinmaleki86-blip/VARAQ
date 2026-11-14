'use strict';
function multipart(req,options={}){
 const maxTotal=Number.isSafeInteger(options.maxTotal)?Math.min(options.maxTotal,25*1024*1024):900*1024;
 const maxFile=Number.isSafeInteger(options.maxFile)?Math.min(options.maxFile,20*1024*1024):710*1024;
 const maxParts=Number.isSafeInteger(options.maxParts)?Math.max(1,Math.min(options.maxParts,40)):12;
 return new Promise((resolve,reject)=>{
  const h=req.headers['content-type']||'';
  const m=h.match(/^multipart\/form-data;\s*boundary=(?:"([\w'+.,\-]{1,100})"|([\w'+.,\-]{1,100}))/i);
  if(!m)return reject(Error('INVALID_MULTIPART'));
  const boundary=Buffer.from('--'+(m[1]||m[2]));
  const buffers=[];let bytes=0;
  req.on('data',chunk=>{bytes+=chunk.length;if(bytes>maxTotal){reject(Error('TOO_BIG'));req.destroy();}else buffers.push(chunk);});
  req.on('error',reject);
  req.on('end',()=>{
   try{
    const b=Buffer.concat(buffers);let p=0,count=0;const fields={},files={};
    while(true){let i=b.indexOf(boundary,p);if(i<0)break;p=i+boundary.length;
      if(b.toString('ascii',p,p+2)==='--')break;
      if(b.toString('ascii',p,p+2)!=='\r\n')throw Error('BOUNDARY');p+=2;
      const sep=b.indexOf(Buffer.from('\r\n\r\n'),p);if(sep<0||sep-p>2048)throw Error('HEADERS');
      const headers=b.toString('latin1',p,sep),name=headers.match(/name="([a-zA-Z0-9_]{1,50})"/);
      if(!name)throw Error('NAME');
      const next=b.indexOf(Buffer.concat([Buffer.from('\r\n'),boundary]),sep+4);
      if(next<0)throw Error('END_BOUNDARY');
      const data=b.subarray(sep+4,next);
      if(++count>maxParts)throw Error('TOO_MANY_PARTS');
      if(/filename="/.test(headers)){if(data.length>maxFile)throw Error('FILE_SIZE');files[name[1]]={data};}
      else{if(data.length>2000)throw Error('FIELD_SIZE');fields[name[1]]=data.toString('utf8');}
      p=next+2;
    }
    resolve({fields,files});
   }catch(e){reject(e);}
  });
 });
}
module.exports={multipart};
