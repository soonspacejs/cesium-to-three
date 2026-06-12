import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { createAttackArrow, createSwallowtailAttackArrow } from '../src/lib/arrow/index';
import type { LonLatPoint } from '../src/lib/arrow/arrow-types';
const mLon=1.02e-5,mLat=9.01e-6,cLon=119,cLat=28.2;
const P=(e:number,n:number):LonLatPoint=>[cLon+e*mLon,cLat+n*mLat];
// EXACT plot-demo small attack + small swallow control points
const attackCp=[P(-95,92),P(-95,102),P(-20,108),P(70,96)];
const swallowCp=[P(-95,22),P(-95,32),P(-20,38),P(70,26)];
function buildU(s:number,n:number):LonLatPoint[]{const p:LonLatPoint[]=[];for(let i=0;i<n;i++){const t=i/(n-1);let x:number,y:number;if(t<0.40){const u=t/0.40;x=(-1.8+u*3.6)*s;y=0.9*s;}else if(t<0.70){const u=(t-0.40)/0.30;const a=Math.PI/2-u*Math.PI;x=(1.8+0.9*Math.cos(a))*s;y=(0.9*Math.sin(a))*s;}else{const u=(t-0.70)/0.30;x=(1.8-u*3.6)*s;y=-0.9*s;}p.push([cLon+x*mLon,cLat+y*mLat]);}return p;}
const cells:[string,LonLatPoint[]][]=[
  ['demo attack 4pt',createAttackArrow(attackCp)],
  ['demo swallow 4pt',createSwallowtailAttackArrow(swallowCp)],
  ['U->attack',createAttackArrow(buildU(13,44))],
  ['U->swallow',createSwallowtailAttackArrow(buildU(13,44))]];
function selfX(r:readonly LonLatPoint[]):number{const n=r.length;let h=0;const c=(o:LonLatPoint,p:LonLatPoint,q:LonLatPoint)=>((p[0]-o[0])*(q[1]-o[1])-(p[1]-o[1])*(q[0]-o[0]));const s=(a:LonLatPoint,b:LonLatPoint,cc:LonLatPoint,d:LonLatPoint)=>{const d1=c(cc,d,a),d2=c(cc,d,b),d3=c(a,b,cc),d4=c(a,b,d);return((d1>0&&d2<0)||(d1<0&&d2>0))&&((d3>0&&d4<0)||(d3<0&&d4>0));};for(let i=0;i<n;i++)for(let j=i+2;j<n;j++){if(i===0&&j===n-1)continue;if(s(r[i],r[(i+1)%n],r[j],r[(j+1)%n]))h++;}return h;}
for(const[n,r]of cells)console.log(n,'ring=',r.length,'selfX=',selfX(r));
const CW=470,CH=290,W=CW*2,H=CH*2;
function img0(){const b=new Uint8Array(W*H*4);for(let i=0;i<W*H;i++){b[i*4]=18;b[i*4+1]=20;b[i*4+2]=22;b[i*4+3]=255;}return b;}
function spx(im:Uint8Array,x:number,y:number,r:number,g:number,b:number){if(x<0||x>=W||y<0||y>=H)return;const i=(y*W+x)*4;im[i]=r;im[i+1]=g;im[i+2]=b;}
function fill(im:Uint8Array,poly:[number,number][],r:number,g:number,b:number){if(poly.length<3)return;let mn=Infinity,mx=-Infinity;for(const p of poly){mn=Math.min(mn,p[1]);mx=Math.max(mx,p[1]);}mn=Math.max(0,Math.floor(mn));mx=Math.min(H-1,Math.ceil(mx));for(let y=mn;y<=mx;y++){const xs:number[]=[];for(let i=0;i<poly.length;i++){const a=poly[i],c=poly[(i+1)%poly.length];if((a[1]<=y&&c[1]>y)||(c[1]<=y&&a[1]>y))xs.push(a[0]+(y-a[1])/(c[1]-a[1])*(c[0]-a[0]));}xs.sort((p,q)=>p-q);for(let k=0;k+1<xs.length;k+=2){const xa=Math.max(0,Math.ceil(xs[k])),xb=Math.min(W-1,Math.floor(xs[k+1]));for(let x=xa;x<=xb;x++)spx(im,x,y,r,g,b);}}}
function ln(im:Uint8Array,x0:number,y0:number,x1:number,y1:number,r:number,g:number,b:number){const st=Math.ceil(Math.hypot(x1-x0,y1-y0))+1;for(let s=0;s<=st;s++){const t=s/st;spx(im,Math.round(x0+(x1-x0)*t),Math.round(y0+(y1-y0)*t),r,g,b);}}
function enc(im:Uint8Array):Buffer{const raw=Buffer.alloc((W*4+1)*H);for(let y=0;y<H;y++){raw[y*(W*4+1)]=0;im.subarray(y*W*4,(y+1)*W*4).forEach((v,i)=>{raw[y*(W*4+1)+1+i]=v;});}const idat=deflateSync(raw);const ct=(()=>{const t:number[]=[];for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;t[n]=c>>>0;}return t;})();const crc=(buf:Buffer)=>{let c=0xffffffff;for(let i=0;i<buf.length;i++)c=ct[(c^buf[i])&0xff]^(c>>>8);return(c^0xffffffff)>>>0;};const ch=(ty:string,d:Buffer)=>{const l=Buffer.alloc(4);l.writeUInt32BE(d.length);const tt=Buffer.from(ty,'ascii');const cr=Buffer.alloc(4);cr.writeUInt32BE(crc(Buffer.concat([tt,d])));return Buffer.concat([l,tt,d,cr]);};const sig=Buffer.from([137,80,78,71,13,10,26,10]);const ih=Buffer.alloc(13);ih.writeUInt32BE(W,0);ih.writeUInt32BE(H,4);ih[8]=8;ih[9]=6;return Buffer.concat([sig,ch('IHDR',ih),ch('IDAT',idat),ch('IEND',Buffer.alloc(0))]);}
const im=img0();const cols:[number,number,number][]=[[60,180,230],[255,150,50],[60,180,230],[255,150,50]];
cells.forEach(([_n,r],idx)=>{const ox=(idx%2)*CW,oy=Math.floor(idx/2)*CH;let a=Infinity,b=Infinity,c=-Infinity,d=-Infinity;for(const p of r){a=Math.min(a,p[0]);b=Math.min(b,p[1]);c=Math.max(c,p[0]);d=Math.max(d,p[1]);}const sc=(Math.min(CW,CH)-40)/Math.max(c-a,d-b);const px=(p:LonLatPoint):[number,number]=>[ox+(p[0]-a)*sc+20,oy+CH-((p[1]-b)*sc+20)];const poly=r.map(px);fill(im,poly,cols[idx][0],cols[idx][1],cols[idx][2]);for(let i=0;i<poly.length;i++){const u=poly[i],v=poly[(i+1)%poly.length];ln(im,u[0],u[1],v[0],v[1],235,235,255);}});
writeFileSync('.claude-tmp-arrow-repro/png-verify.png',enc(im));console.log('wrote png-verify.png (TL demo-attack TR demo-swallow BL U->attack BR U->swallow)');
