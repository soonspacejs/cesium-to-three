import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { createAttackArrow, createSwallowtailAttackArrow } from '../src/lib/arrow/index';
import type { LonLatPoint } from '../src/lib/arrow/arrow-types';
const mLon=1.02e-5,mLat=9.01e-6,cLon=119,cLat=28.2;
// EXACT plot-demo small arrow points (attack/swallow share these via arrowType switch)
const cp: LonLatPoint[]=[
  [cLon-95*mLon,cLat+92*mLat],[cLon-95*mLon,cLat+102*mLat],[cLon-20*mLon,cLat+108*mLat],[cLon+70*mLon,cLat+96*mLat]];
const rA=createAttackArrow(cp); // lib defaults (GisPlotArrow passes none)
const rS=createSwallowtailAttackArrow(cp);
console.log('attack tail-region ring pts (first 6 + last 4):');
const dump=(r:LonLatPoint[])=>r.map(p=>[+((p[0]-cLon)/mLon).toFixed(1),+((p[1]-cLat)/mLat).toFixed(1)]);
console.log('attack ring='+rA.length, JSON.stringify(dump(rA)));
console.log('swallow ring='+rS.length, JSON.stringify(dump(rS)));
const W=900,H=460;
function img0(){const b=new Uint8Array(W*H*4);for(let i=0;i<W*H;i++){b[i*4]=20;b[i*4+1]=22;b[i*4+2]=24;b[i*4+3]=255;}return b;}
function spx(img:Uint8Array,x:number,y:number,rr:number,g:number,b:number){if(x<0||x>=W||y<0||y>=H)return;const i=(y*W+x)*4;img[i]=rr;img[i+1]=g;img[i+2]=b;}
function fill(img:Uint8Array,poly:[number,number][],rr:number,g:number,b:number){if(poly.length<3)return;let mn=Infinity,mx=-Infinity;for(const p of poly){mn=Math.min(mn,p[1]);mx=Math.max(mx,p[1]);}mn=Math.max(0,Math.floor(mn));mx=Math.min(H-1,Math.ceil(mx));for(let y=mn;y<=mx;y++){const xs:number[]=[];for(let i=0;i<poly.length;i++){const a=poly[i],c=poly[(i+1)%poly.length];if((a[1]<=y&&c[1]>y)||(c[1]<=y&&a[1]>y))xs.push(a[0]+(y-a[1])/(c[1]-a[1])*(c[0]-a[0]));}xs.sort((p,q)=>p-q);for(let k=0;k+1<xs.length;k+=2){const xa=Math.max(0,Math.ceil(xs[k])),xb=Math.min(W-1,Math.floor(xs[k+1]));for(let x=xa;x<=xb;x++)spx(img,x,y,rr,g,b);}}}
function ln(img:Uint8Array,x0:number,y0:number,x1:number,y1:number,rr:number,g:number,b:number){const st=Math.ceil(Math.hypot(x1-x0,y1-y0))+1;for(let s=0;s<=st;s++){const t=s/st;for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++)spx(img,Math.round(x0+(x1-x0)*t+dx),Math.round(y0+(y1-y0)*t+dy),rr,g,b);}}
function dot(img:Uint8Array,x:number,y:number,rr:number,g:number,b:number){for(let dx=-3;dx<=3;dx++)for(let dy=-3;dy<=3;dy++)spx(img,Math.round(x+dx),Math.round(y+dy),rr,g,b);}
function enc(img:Uint8Array):Buffer{const raw=Buffer.alloc((W*4+1)*H);for(let y=0;y<H;y++){raw[y*(W*4+1)]=0;img.subarray(y*W*4,(y+1)*W*4).forEach((v,i)=>{raw[y*(W*4+1)+1+i]=v;});}const idat=deflateSync(raw);const ct=(()=>{const t:number[]=[];for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;t[n]=c>>>0;}return t;})();const crc=(buf:Buffer)=>{let c=0xffffffff;for(let i=0;i<buf.length;i++)c=ct[(c^buf[i])&0xff]^(c>>>8);return(c^0xffffffff)>>>0;};const ch=(ty:string,d:Buffer)=>{const l=Buffer.alloc(4);l.writeUInt32BE(d.length);const tt=Buffer.from(ty,'ascii');const cr=Buffer.alloc(4);cr.writeUInt32BE(crc(Buffer.concat([tt,d])));return Buffer.concat([l,tt,d,cr]);};const sig=Buffer.from([137,80,78,71,13,10,26,10]);const ih=Buffer.alloc(13);ih.writeUInt32BE(W,0);ih.writeUInt32BE(H,4);ih[8]=8;ih[9]=6;return Buffer.concat([sig,ch('IHDR',ih),ch('IDAT',idat),ch('IEND',Buffer.alloc(0))]);}
const im=img0();
// zoom on tail region (x in [-105,-10]m, y in [80,115]m) shared scale
const X0=-110,X1=10,Y0=80,Y1=120;const sc=Math.min((W/2-20)/((X1-X0)*mLon),(H-40)/((Y1-Y0)*mLat));
function place(r:LonLatPoint[],ox:number,col:[number,number,number],raw:LonLatPoint[]){const px=(p:LonLatPoint):[number,number]=>[ox+((p[0]-cLon)/mLon-X0)*mLon*sc+10,H-(((p[1]-cLat)/mLat-Y0)*mLat*sc+20)];const poly=r.map(px);fill(im,poly,col[0],col[1],col[2]);for(let i=0;i<poly.length;i++){const a=poly[i],b=poly[(i+1)%poly.length];ln(im,a[0],a[1],b[0],b[1],235,235,255);}
  // mark the 4 control points
  for(const c of raw){const q=px(c);dot(im,q[0],q[1],255,220,0);}}
place(rA,10,[200,70,50],cp);place(rS,W/2+5,[150,60,210],cp);
writeFileSync('.claude-tmp-arrow-repro/png-tail.png',enc(im));console.log('wrote png-tail.png (left=attack TAIL zoom, right=swallow TAIL zoom; yellow=control pts)');
