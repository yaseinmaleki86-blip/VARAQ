'use strict';
const MAX_COVER_BYTES=700*1024;
let crcTable;
function crc32(bytes){
 if(!crcTable)crcTable=Array.from({length:256},(_,i)=>{let c=i;for(let j=0;j<8;j++)c=(c&1)?(0xedb88320^(c>>>1)):(c>>>1);return c>>>0;});
 let c=0xffffffff;for(const v of bytes)c=crcTable[(c^v)&255]^(c>>>8);return (c^0xffffffff)>>>0;
}
// Header/structure checks, byte-size and dimension caps. No SVG, executable HTML or animated formats.
function validateImage(buf){
 if(!Buffer.isBuffer(buf)||buf.length<32||buf.length>MAX_COVER_BYTES)throw Error('IMAGE_SIZE');
 let mime='',ext='',w=0,h=0;
 if(buf.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'))){
   mime='image/png';ext='png';let p=8,seenHeader=false,seenData=false,seenEnd=false;
   while(p+12<=buf.length){const len=buf.readUInt32BE(p),type=buf.toString('ascii',p+4,p+8);if(len>buf.length-p-12)throw Error('IMAGE_INVALID');
     const block=buf.subarray(p+4,p+8+len),expected=buf.readUInt32BE(p+8+len);
     if(crc32(block)!==expected)throw Error('IMAGE_CRC');
     if(!seenHeader){if(type!=='IHDR'||len!==13)throw Error('IMAGE_INVALID');w=buf.readUInt32BE(p+8);h=buf.readUInt32BE(p+12);seenHeader=true;}
     if(type==='acTL'||type==='fcTL'||type==='fdAT')throw Error('IMAGE_ANIMATED');
     if(type==='IDAT')seenData=true;
     p+=len+12;
     if(type==='IEND'){seenEnd=true;if(p!==buf.length)throw Error('IMAGE_INVALID');break;}
   }
   if(!seenHeader||!seenData||!seenEnd)throw Error('IMAGE_INVALID');
 }else if(buf[0]===0xff&&buf[1]===0xd8&&buf[2]===0xff){
   mime='image/jpeg';ext='jpg';let p=2;
   if(buf[buf.length-2]!==0xff||buf[buf.length-1]!==0xd9)throw Error('IMAGE_INVALID');
   while(p+4<buf.length){if(buf[p]!==0xff){p++;continue;}let marker=buf[p+1];p+=2;if(marker===0xd8||marker===0xd9||marker===0x01)continue;if(p+2>buf.length)break;const size=buf.readUInt16BE(p);if(size<2||p+size>buf.length)break;if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)){h=buf.readUInt16BE(p+3);w=buf.readUInt16BE(p+5);break;}p+=size;}
 }else if(buf.toString('ascii',0,4)==='RIFF'&&buf.toString('ascii',8,12)==='WEBP'){
   mime='image/webp';ext='webp';if(buf.readUInt32LE(4)!==buf.length-8)throw Error('IMAGE_INVALID');
   const type=buf.toString('ascii',12,16);
   if(type==='VP8X'){w=1+buf.readUIntLE(24,3);h=1+buf.readUIntLE(27,3);if((buf[20]&2)!==0)throw Error('IMAGE_ANIMATED');}
   else if(type==='VP8L'){if(buf[20]!==0x2f)throw Error('IMAGE_INVALID');const n=buf.readUInt32LE(21);w=(n&0x3fff)+1;h=((n>>>14)&0x3fff)+1;}
   else if(type==='VP8 '){if(buf[23]!==0x9d||buf[24]!==0x01||buf[25]!==0x2a)throw Error('IMAGE_INVALID');w=buf.readUInt16LE(26)&0x3fff;h=buf.readUInt16LE(28)&0x3fff;}
 }
 if(!mime||!w||!h||w<100||h<120||w>3000||h>4200)throw Error('IMAGE_DIMENSIONS');
 return {mime,ext,width:w,height:h};
}
module.exports={validateImage,MAX_COVER_BYTES};
