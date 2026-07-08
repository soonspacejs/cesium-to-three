import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { createSwallowtailAttackArrow } from '../src/lib/arrow/index';
import type { LonLatPoint } from '../src/lib/arrow/arrow-types';
const mLon=1.02e-5,mLat=9.01e-6,cLon=119,cLat=28.2;
// plot large swallowtail (km), normalized shape == this:
const cp4: LonLatPoint[] = [[cLon-16000*mLon,cLat+18500*mLat],[cLon-16000*mLon,cLat+20000*mLat],[cLon,cLat+22500*mLat],[cLon+16000*mLon,cLat+19000*mLat]];
// freehand swallowtail: 2 tail pts + 30-pt curved spine
const spine: LonLatPoint[]=[];for(let i=0;i<30;i++){const t=i/29;const x=(-1.5+t*4)*30;const y=Math.sin(t*Math.PI)*12;spine.push([cLon+x*mLon,cLat+y*mLat]);}
const cpFree: LonLatPoint[]=[[cLon-1.5*30*mLon,cLat-1.0*30*mLat],[cLon-1.5*30*mLon,cLat+1.0*30*mLat],...spine.slice(1)];
function selfX(r:readonly LonLatPoint[]):number{const n=r.length;let h=0;const c=(o:LonLatPoint,p:LonLatPoint,q:LonLatPoint)=>((p[0]-o[0])*(q[1]-o[1])-(p[1]-o[1])*(q[0]-o[0]));const s=(a:LonLatPoint,b:LonLatPoint,cc:LonLatPoint,d:LonLatPoint)=>{const d1=c(cc,d,a),d2=c(cc,d,b),d3=c(a,b,cc),d4=c(a,b,d);return((d1>0&&d2<0)||(d1<0&&d2>0))&&((d3>0&&d4<0)||(d3<0&&d4>0));};for(let i=0;i<n;i++)for(let j=i+2;j<n;j++){if(i===0&&j===n-1)continue;if(s(r[i],r[(i+1)%n],r[j],r[(j+1)%n]))h++;}return h;}
const r4=createSwallowtailAttackArrow(cp4);
const rF=createSwallowtailAttackArrow(cpFree);
console.log('swallow 4pt no-opts: ring=',r4.length,'selfX=',selfX(r4));
console.log('swallow freehand   : ring=',rF.length,'selfX=',selfX(rF));
const W=900,H=420;
function img0(){const b=new Uint8Array(W*H*4);for(let i=0;i<W*H;i++){b[i*4]=22;b[i*4+1]=24;b[i*4+2]=26;b[i*4+3]=255;}return b;}
function sp(img:Uint8Array,x:number,y:number,r:number,g:number,b:number){if(x<0||x>=W||y<0||y>=H)return;const i=(y*W+x)*4;img[i]=r;img[i+1]=g;img[i+2]=b;}
function fill(img:Uint8Array,poly:[number,number][],r:number,g:number,b:number){if(poly.length<3)return;let mn=Infinity,mx=-Infinity;for(const p of poly){mn=Math.min(mn,p[1]);mx=Math.max(mx,p[1]);}mn=Math.max(0,Math.floor(mn));mx=Math.min(H-1,Math.ceil(mx));for(let y=mn;y<=mx;y++){const xs:number[]=[];for(let i=0;i<poly.length;i++){const a=poly[i],c=poly[(i+1)%poly.length];if((a[1]<=y&&c[1]>y)||(c[1]<=y&&a[1]>y))xs.push(a[0]+(y-a[1])/(c[1]-a[1])*(c[0]-a[0]));}xs.sort((p,q)=>p-q);for(let k=0;k+1<xs.length;k+=2){const xa=Math.max(0,Math.ceil(xs[k])),xb=Math.min(W-1,Math.floor(xs[k+1]));for(let x=xa;x<=xb;x++)sp(img,x,y,r,g,b);}}}
function ln(img:Uint8Array,x0:number,y0:number,x1:number,y1:number,r:number,g:number,b:number){const st=Math.ceil(Math.hypot(x1-x0,y1-y0))+1;for(let s=0;s<=st;s++){const t=s/st;sp(img,Math.round(x0+(x1-x0)*t),Math.round(y0+(y1-y0)*t),r,g,b);}}
function enc(img:Uint8Array):Buffer{const raw=Buffer.alloc((W*4+1)*H);for(let y=0;y<H;y++){raw[y*(W*4+1)]=0;img.subarray(y*W*4,(y+1)*W*4).forEach((v,i)=>{raw[y*(W*4+1)+1+i]=v;});}const idat=deflateSync(raw);const ct=(()=>{const t:number[]=[];for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;t[n]=c>>>0;}return t;})();const crc=(buf:Buffer)=>{let c=0xffffffff;for(let i=0;i<buf.length;i++)c=ct[(c^buf[i])&0xff]^(c>>>8);return(c^0xffffffff)>>>0;};const ch=(ty:string,d:Buffer)=>{const l=Buffer.alloc(4);l.writeUInt32BE(d.length);const tt=Buffer.from(ty,'ascii');const cr=Buffer.alloc(4);cr.writeUInt32BE(crc(Buffer.concat([tt,d])));return Buffer.concat([l,tt,d,cr]);};const sig=Buffer.from([137,80,78,71,13,10,26,10]);const ih=Buffer.alloc(13);ih.writeUInt32BE(W,0);ih.writeUInt32BE(H,4);ih[8]=8;ih[9]=6;return Buffer.concat([sig,ch('IHDR',ih),ch('IDAT',idat),ch('IEND',Buffer.alloc(0))]);}
function bb(rs:LonLatPoint[][]):[number,number,number,number]{let a=Infinity,b=Infinity,c=-Infinity,d=-Infinity;for(const r of rs)for(const p of r){a=Math.min(a,p[0]);b=Math.min(b,p[1]);c=Math.max(c,p[0]);d=Math.max(d,p[1]);}return[a,b,c,d];}
const[mnx,mny,mxx,mxy]=bb([r4,rF]);const sc=(Math.min(W/2,H)-50)/Math.max(mxx-mnx,mxy-mny);const im=img0();
function place(r:LonLatPoint[],ox:number,col:[number,number,number]){const px=(p:LonLatPoint):[number,number]=>[(p[0]-mnx)*sc+ox,H-((p[1]-mny)*sc+30)];const poly=r.map(px);fill(im,poly,col[0],col[1],col[2]);for(let i=0;i<poly.length;i++){const a=poly[i],b=poly[(i+1)%poly.length];ln(im,a[0],a[1],b[0],b[1],240,240,255);}}
place(r4,30,[150,50,220]);place(rF,W/2+10,[50,160,80]);
writeFileSync('.claude-tmp-arrow-repro/png-swallow2.png',enc(im));
console.log('wrote png-swallow2.png (left=4pt no-opts purple, right=freehand green)');
