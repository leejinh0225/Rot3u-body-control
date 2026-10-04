// Conservative capsule proxies. No claim of measured hardware collision freedom.
export const DEFAULT_GEOMETRY=Object.freeze({lengths:[.21,.20,.21],tool:.055,baseHeight:.075,baseRadius:.07,radius:.018,margin:.015,floor:0,zeroAngles:[90,0,0]});
// User-selected minimal hardware guard, not an envelope of the real parts.
export const MINIMAL_HARDWARE_CLEARANCE=Object.freeze({radius:.01,margin:.01});
export const BASIC_HARDWARE_GEOMETRY=Object.freeze({...DEFAULT_GEOMETRY,
  lengths:[.105,.1,.07],tool:0,baseHeight:.11,baseRadius:.02,...MINIMAL_HARDWARE_CLEARANCE});
// The visible scoop is wider than a link. Enclose its full 3D extent too.
export const VIRTUAL_GEOMETRY=Object.freeze({...DEFAULT_GEOMETRY,radius:.065});
const rad=x=>x*Math.PI/180,clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
const sub=(a,b)=>a.map((v,i)=>v-b[i]),dot=(a,b)=>a.reduce((s,v,i)=>s+v*b[i],0);
const add=(a,b,t=1)=>a.map((v,i)=>v+t*b[i]);
export function validateGeometry(g){
  if(!g||!Array.isArray(g.lengths)||g.lengths.length!==3||g.lengths.some(x=>!Number.isFinite(x)||x<.03||x>.6)||
    !Array.isArray(g.zeroAngles)||g.zeroAngles.length!==3||g.zeroAngles.some(x=>!Number.isFinite(x)||Math.abs(x)>180)||
    !Number.isFinite(g.tool)||g.tool<0||g.tool>.25||
    !Number.isFinite(g.baseHeight)||g.baseHeight<.03||g.baseHeight>.3||
    !Number.isFinite(g.baseRadius)||g.baseRadius<.02||g.baseRadius>.25||
    !Number.isFinite(g.radius)||g.radius<.01||g.radius>.08||
    !Number.isFinite(g.margin)||g.margin<.01||g.margin>.08||
    !Number.isFinite(g.floor)||Math.abs(g.floor)>.2)throw Error('링크 길이·두께·베이스·원점 각도를 확인하십시오.');
  return structuredClone(g);
}
export function geometryPoints(pose,g=DEFAULT_GEOMETRY){
  const points=[[0,g.baseHeight,0]],yaw=rad(pose.yaw??0);
  ['leg','torso','arm'].forEach((key,i)=>{
    const a=rad(pose[key]),p=points.at(-1),r=g.lengths[i]*Math.cos(a);
    points.push([p[0]+r*Math.cos(yaw),p[1]+g.lengths[i]*Math.sin(a),p[2]+r*Math.sin(yaw)]);
  });
  const p=points.at(-1),a=rad(pose.arm),r=g.tool*Math.cos(a);
  points.push([p[0]+r*Math.cos(yaw),p[1]+g.tool*Math.sin(a),p[2]+r*Math.sin(yaw)]);
  return points;
}
export function segmentDistance(p1,q1,p2,q2){
  const d1=sub(q1,p1),d2=sub(q2,p2),r=sub(p1,p2),a=dot(d1,d1),e=dot(d2,d2),f=dot(d2,r);
  let s=0,t=0;
  if(a<=1e-12&&e<=1e-12)return Math.hypot(...r);
  if(a<=1e-12)t=clamp(f/e,0,1);
  else{
    const c=dot(d1,r);
    if(e<=1e-12)s=clamp(-c/a,0,1);
    else{
      const b=dot(d1,d2),den=a*e-b*b;
      s=den>1e-12?clamp((b*f-c*e)/den,0,1):0;t=(b*s+f)/e;
      if(t<0){t=0;s=clamp(-c/a,0,1);}
      else if(t>1){t=1;s=clamp((b-c)/a,0,1);}
    }
  }
  return Math.hypot(...sub(add(p1,d1,s),add(p2,d2,t)));
}
export function collisionAt(pose,g=DEFAULT_GEOMETRY){
  if(['yaw','leg','torso','arm'].some(k=>!Number.isFinite(pose[k])))return '자세 값 오류';
  const joints=[pose.leg,pose.torso-pose.leg,pose.arm-pose.torso];
  if(Math.abs(pose.yaw)>90||joints[0]<10||joints[0]>170||Math.abs(joints[1])>150||Math.abs(joints[2])>150)return '가상 관절 각도 한계';
  const p=geometryPoints(pose,g),padding=g.radius+g.margin;
  if(p.slice(1).some(v=>v[1]<g.floor+padding))return '바닥 / 테이블';
  // Folded adjacent joints are bounded above. Check all nonadjacent capsules.
  for(const [a,b] of [[0,2],[0,3],[1,3]])
    if(segmentDistance(p[a],p[a+1],p[b],p[b+1])<2*g.radius+g.margin)return '링크끼리 간섭';
  for(let link=1;link<4;link++){
    const steps=Math.max(1,Math.ceil(Math.hypot(...sub(p[link+1],p[link]))/.008));
    for(let i=0;i<=steps;i++){
      const v=add(p[link],sub(p[link+1],p[link]),i/steps);
      if(v[1]<g.baseHeight+padding&&Math.hypot(v[0],v[2])<g.baseRadius+padding)return '베이스 간섭';
    }
  }
  return '';
}
export function collisionExplanation(pose,g=DEFAULT_GEOMETRY){
  const reason=collisionAt(pose,g);
  if(reason!=='링크끼리 간섭')return reason;
  const p=geometryPoints(pose,g),required=2*g.radius+g.margin;
  const labels=['어깨→팔꿈치','팔꿈치→손목','손목→도구 부착점','부착점→도구 끝'];
  const mm=x=>Number((x*1000).toFixed(1));
  for(const [a,b] of [[0,2],[0,3],[1,3]]){
    const gap=segmentDistance(p[a],p[a+1],p[b],p[b+1]);
    if(gap<required)return reason+' · '+labels[a]+' / '+labels[b]+
      ' · 모델 중심선 간격 '+mm(gap)+'mm < 필요 '+mm(required)+'mm'+
      ' (반경 '+mm(g.radius)+'×2 + 추가 간격 '+mm(g.margin)+')';
  }
  return reason;
}
export function safePath(from,to,g=DEFAULT_GEOMETRY){
  const start=collisionAt(from,g);if(start)return {safe:false,reason:'현재 자세: '+start};
  const keys=['yaw','leg','torso','arm'];
  if(keys.some(k=>!Number.isFinite(to[k])))return {safe:false,reason:'목표 자세 값 오류'};
  const steps=Math.max(1,Math.ceil(Math.max(...keys.map(k=>Math.abs(to[k]-from[k])))/1));
  if(steps>720)return {safe:false,reason:'각도 경로 오류'};
  for(let i=1;i<=steps;i++){
    const pose=Object.fromEntries(keys.map(k=>[k,from[k]+(to[k]-from[k])*i/steps]));
    const reason=collisionAt(pose,g);if(reason)return {safe:false,reason};
  }
  return {safe:true,reason:''};
}
