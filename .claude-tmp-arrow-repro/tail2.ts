import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { createAttackArrow, createSwallowtailAttackArrow } from '../src/lib/arrow/index';
import { expandPolygonPointsThroughMeters } from '../src/lib/ground/polygon/polygon-helpers';
import type { LonLatPoint } from '../src/lib/arrow/arrow-types';
const mLon=1.02e-5,mLat=9.01e-6,cLon=119,cLat=28.2;
const cp: LonLatPoint[]=[[cLon-95*mLon,cLat+92*mLat],[cLon-95*mLon,cLat+102*mLat],[cLon-20*mLon,cLat+108*mLat],[cLon+70*mLon,cLat+96*mLat]];
const cells:[string,LonLatPoint[]][]=[['attack',createAttackArrow(cp)],['swallow',createSwallowtailAttackArrow(cp)]];
const W=940,H=420;
function img0(){const b=new Uint8Array(W*H*4);for(let i=0;i<W*H;i++){b[i*4]=18;b[i*4+1]=20;b[i*4+2]=22;b[i*4+3]=255;}return b;}
function spx(img:Uint8Array,x:number,y:number,rr:number,g:number,b:number){if(x<0||x>=W||y<0||y>=H)return;const i=(y*W+x)*4;img[i]=rr;img[i+1]=g;img[i+2]=b;}
function fill(img:Uint8Array,poly:[number,number][],rr:number,g:number,b:number){if(poly.length<3)return;let mn=Infinity,mx=-Infinity;for(const p of poly){mn=Math.min(mn,p[1]);mx=Math.max(mx,p[1]);}mn=Math.max(0,Math.floor(mn));mx=Math.min(H-1,Math.ceil(mx));for(let y=mn;y<=mx;y++){const xs:number[]=[];for(let i=0;i<poly.length;i++){const a=poly[i],c=poly[(i+1)%poly.length];if((a[1]<=y&&c[1]>y)||(c[1]<=y&&a[1]>y))xs.push(a[0]+(y-a[1])/(c[1]-a[1])*(c[0]-a[0]));}xs.sort((p,q)=>p-q);for(let k=0;k+1<xs.length;k+=2){const xa=Math.max(0,Math.ceil(xs[k])),xb=Math.min(W-1,Math.floor(xs[k+1]));for(let x=xa;x<=xb;x++)spx(img,x,y,rr,g,b);}}}
function ln(img:Uint8Array,x0:number,y0:number,x1:number,y1:number,rr:number,g:number,b:number){const st=Math.ceil(Math.hypot(x1-x0,y1-y0))+1;for(let s=0;s<=st;s++){const t=s/st;for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++)spx(img,Math.round(x0+(x1-x0)*t+dx),Math.round(y0+(y1-y0)*t+dy),rr,g,b);}}
function enc(img:Uint8Array):Buffer{const raw=Buffer.alloc((W*4+1)*H);for(let y=0;y<H;y++){raw[y*(W*4+1)]=0;img.subarray(y*W*4,(y+1)*W*4).forEach((v,i)=>{raw[y*(W*4+1)+1+i]=v;});}const idat=deflateSync(raw);const ct=(()=>{const t:number[]=[];for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;t[n]=c>>>0;}return t;})();const crc=(buf:Buffer)=>{let c=0xffffffff;for(let i=0;i<buf.length;i++)c=ct[(c^buf[i])&0xff]^(c>>>8);return(c^0xffffffff)>>>0;};const ch=(ty:string,d:Buffer)=>{const l=Buffer.alloc(4);l.writeUInt32BE(d.length);const tt=Buffer.from(ty,'ascii');const cr=Buffer.alloc(4);cr.writeUInt32BE(crc(Buffer.concat([tt,d])));return Buffer.concat([l,tt,d,cr]);};const sig=Buffer.from([137,80,78,71,13,10,26,10]);const ih=Buffer.alloc(13);ih.writeUInt32BE(W,0);ih.writeUInt32BE(H,4);ih[8]=8;ih[9]=6;return Buffer.concat([sig,ch('IHDR',ih),ch('IDAT',idat),ch('IEND',Buffer.alloc(0))]);}
const im=img0();
cells.forEach(([name,ring],idx)=>{
  const stroke=expandPolygonPointsThroughMeters(ring,3.0); // 3m border to see spikes
  console.log(name,'fill pts=',ring.length,'stroke pts=',stroke.length);
  const ox=idx*(W/2);
  // shared zoom: tail region x[-105,75] y[78,118]
  const X0=-105,Y0=78,RANGE=185;const sc=(W/2-30)/(RANGE*mLon);
  const px=(p:LonLatPoint):[number,number]=>[ox+(((p[0]-cLon)/mLon)-X0)*mLon*sc+15,H-((((p[1]-cLat)/mLat)-Y0)*mLat*sc+150)];
  // draw stroke band (dark) first then fill (blue) on top -> leftover dark = border
  fill(im,stroke.map(px),20,40,120);
  fill(im,ring.map(px),60,110,255);
  const sp=stroke.map(px);for(let i=0;i<sp.length;i++){const a=sp[i],b=sp[(i+1)%sp.length];ln(im,a[0],a[1],b[0],b[1],10,25,90);}
});
writeFileSync('.claude-tmp-arrow-repro/png-tail2.png',enc(im));console.log('wrote png-tail2.png (left attack, right swallow; with 3m stroke border)');
