import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { createFineArrow, createAssaultDirectionArrow, createAttackArrow, createSwallowtailAttackArrow, createCurvedArrow } from '../src/lib/arrow/index';
import type { LonLatPoint } from '../src/lib/arrow/arrow-types';
const mLon=1.02e-5,mLat=9.01e-6,cLon=119,cLat=28.2;
const P=(e:number,n:number):LonLatPoint=>[cLon+e*mLon,cLat+n*mLat];
function area(r:LonLatPoint[]):number{let a=0;const n=r.length;for(let i=0;i<n;i++){const p=r[i],q=r[(i+1)%n];a+=p[0]*q[1]-q[0]*p[1];}return Math.abs(a)/2/(mLon*mLat);}
const fineP=[P(-60,0),P(60,0)] as [LonLatPoint,LonLatPoint];
const atk=[P(-60,-10),P(-60,10),P(0,16),P(70,4)];
const u=(()=>{const p:LonLatPoint[]=[];for(let i=0;i<44;i++){const t=i/43;let x:number,y:number;if(t<0.40){const v=t/0.40;x=(-1.8+v*3.6)*13;y=0.9*13;}else if(t<0.70){const v=(t-0.40)/0.30;const a=Math.PI/2-v*Math.PI;x=(1.8+0.9*Math.cos(a))*13;y=(0.9*Math.sin(a))*13;}else{const v=(t-0.70)/0.30;x=(1.8-v*3.6)*13;y=-0.9*13;}p.push([cLon+x*mLon,cLat+y*mLat]);}return p;})();
const types:[string,(ws:number)=>LonLatPoint[]][]=[
  ['fine',(ws)=>createFineArrow(fineP[0],fineP[1],{widthScale:ws})],
  ['assault',(ws)=>createAssaultDirectionArrow(fineP[0],fineP[1],{widthScale:ws})],
  ['attack',(ws)=>createAttackArrow(atk,{widthScale:ws})],
  ['swallow',(ws)=>createSwallowtailAttackArrow(atk,{widthScale:ws})],
  ['curved',(ws)=>createCurvedArrow(u,{widthScale:ws})]];
for(const[n,f]of types){const a05=area(f(0.5)),a10=area(f(1.0)),a20=area(f(2.0));console.log(`${n.padEnd(8)} area@0.5=${a05.toFixed(0)} @1.0=${a10.toFixed(0)} @2.0=${a20.toFixed(0)}  ratio(2.0/1.0)=${(a20/a10).toFixed(2)} (1.0/0.5)=${(a10/a05).toFixed(2)}`);}
