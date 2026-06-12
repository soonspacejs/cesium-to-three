import { createAttackArrow, createSwallowtailAttackArrow } from '../src/lib/arrow/index';
import type { LonLatPoint } from '../src/lib/arrow/arrow-types';
const mLon=1.02e-5,mLat=9.01e-6,cLon=119,cLat=28.2;
// U-shape path points (dense, path-style) — same as demo U arrow
function buildU(s:number,n:number):LonLatPoint[]{const p:LonLatPoint[]=[];for(let i=0;i<n;i++){const t=i/(n-1);let x:number,y:number;if(t<0.40){const u=t/0.40;x=(-1.8+u*3.6)*s;y=0.9*s;}else if(t<0.70){const u=(t-0.40)/0.30;const a=Math.PI/2-u*Math.PI;x=(1.8+0.9*Math.cos(a))*s;y=(0.9*Math.sin(a))*s;}else{const u=(t-0.70)/0.30;x=(1.8-u*3.6)*s;y=-0.9*s;}p.push([cLon+x*mLon,cLat+y*mLat]);}return p;}
const u=buildU(13,44);
console.log('U points[0..2] (m):',u.slice(0,3).map(p=>[+((p[0]-cLon)/mLon).toFixed(2),+((p[1]-cLat)/mLat).toFixed(2)]));
console.log('tail width = dist(p0,p1) =', (Math.hypot((u[0][0]-u[1][0])/mLon,(u[0][1]-u[1][1])/mLat)).toFixed(2),'m');
const a=createAttackArrow(u), s=createSwallowtailAttackArrow(u);
console.log('U-as-attack:  ring=',a.length);
console.log('U-as-swallow: ring=',s.length);
