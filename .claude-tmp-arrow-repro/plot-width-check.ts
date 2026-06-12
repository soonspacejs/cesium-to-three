import { GisPlotArrow } from '../src/lib/plot/plugins/arrow';
import type { LonLatPoint } from '../src/lib/arrow/arrow-types';
const mLon=1.02e-5,mLat=9.01e-6,cLon=119,cLat=28.2;
// simple curved spine
const pts: LonLatPoint[]=[];for(let i=0;i<6;i++){const t=i/5;pts.push([cLon+(t*100)*mLon,cLat+Math.sin(t*Math.PI)*20*mLat]);}
function maxWidthMeters(ring:LonLatPoint[]):number{ // rough: bbox diagonal not useful; measure perpendicular spread near mid via bbox height of a thin band is hard. Use area/length proxy.
  // simpler: report ring bbox + vertex count + a width proxy = 2*min dist from centroid? Just report area.
  let a=0;const n=ring.length;for(let i=0;i<n;i++){const p=ring[i],q=ring[(i+1)%n];a+=p[0]*q[1]-q[0]*p[1];}return Math.abs(a)/2/(mLon*mLat); // area in m^2
}
for(const w of [0.03,0.06,0.12]){
  const arr=new GisPlotArrow({type:'arrow',points:pts.map(p=>[p[0],p[1]]),arrowType:'curved',curvedBodyWidthFactor:w,curvedHeadWidthFactor:w*2,curvedHeadLengthFactor:0.14} as any);
  const ring=arr.generateCoords();
  console.log(`bodyWidth=${w}: ring=${ring.length} area(m^2)=${maxWidthMeters(ring).toFixed(0)}`);
}
