// A planar three-link embodiment preview, not calibrated ROT3U geometry.
export const ARM=Object.freeze({leg:.21,torso:.20,arm:.21,tool:.055,base:.075});
export const NEUTRAL=Object.freeze({yaw:0,leg:90,torso:90,arm:90});
// Heading is positive toward the RIGHT of the mirrored camera preview.
export const HEADING_ZERO=45;
export const TRACKING_GRACE_MS=800;
export const clamp=(v,lo,hi)=>Math.max(lo,Math.min(hi,v));
const radians=d=>d*Math.PI/180;
const degrees=r=>r*180/Math.PI;
const wrap=a=>((a+180)%360+360)%360-180;
const distance=(a,b)=>Math.hypot(b.x-a.x,b.y-a.y);
const middle=points=>({x:points.reduce((s,p)=>s+p.x,0)/points.length,y:points.reduce((s,p)=>s+p.y,0)/points.length});
export function features(landmarks,aspect=4/3,armMode='both'){
  const bad=reason=>({valid:false,reason});
  if(!Array.isArray(landmarks)||landmarks.length<17)return bad('상반신과 뻗은 팔을 화면에 넣으십시오. 다리는 보이지 않아도 됩니다.');
  const good=i=>landmarks[i]&&Number.isFinite(landmarks[i].x)&&Number.isFinite(landmarks[i].y)&&landmarks[i].visibility>=.35&&landmarks[i].x>.005&&landmarks[i].x<.995&&landmarks[i].y>.005&&landmarks[i].y<.995;
  const point=i=>({x:(1-landmarks[i].x)*aspect,y:-landmarks[i].y});
  // Keep each shoulder, wrist and hip on the SAME side. A hidden far arm
  // must not be averaged into the visible near arm in a side-on view.
  let arms=[{name:'left',s:11,e:13,w:15,h:23},{name:'right',s:12,e:14,w:16,h:24}]
    .filter(a=>(armMode==='both'||a.name===armMode)&&good(a.s)&&good(a.w))
    .map(a=>({...a,shoulder:point(a.s),hand:point(a.w),score:Math.min(landmarks[a.s].visibility,landmarks[a.w].visibility)}))
    .filter(a=>distance(a.shoulder,a.hand)>.045)
    .sort((a,b)=>b.score-a.score);
  if(!arms.length)return bad('보이는 쪽의 어깨와 손목이 필요합니다. 완전한 옆모습 대신 카메라 쪽으로 조금만 돌아보십시오.');
  if(arms.length===2){
    const vector=a=>({x:a.hand.x-a.shoulder.x,y:a.hand.y-a.shoulder.y});
    const a=vector(arms[0]),b=vector(arms[1]),la=Math.hypot(a.x,a.y),lb=Math.hypot(b.x,b.y);
    const agreement=(a.x*b.x+a.y*b.y)/(la*lb);
    if(arms[1].score<.55||arms[0].score-arms[1].score>.2||agreement<.8||Math.min(la,lb)/Math.max(la,lb)<.55)arms=arms.slice(0,1);
  }
  const shoulder=middle(arms.map(a=>a.shoulder)),hand=middle(arms.map(a=>a.hand));
  const torsos=arms.filter(a=>good(a.h)&&distance(point(a.h),a.shoulder)>.07);
  const torsoAssumed=torsos.length===0;
  const torsoVector=torsoAssumed?{x:0,y:.24}:middle(torsos.map(a=>({x:a.shoulder.x-point(a.h).x,y:a.shoulder.y-point(a.h).y})));
  const hip={x:shoulder.x-torsoVector.x,y:shoulder.y-torsoVector.y};
  const legs=[{h:23,a:27},{h:24,a:28}].filter(a=>good(a.h)&&good(a.a)&&landmarks[a.h].visibility>=.5&&landmarks[a.a].visibility>=.5&&distance(point(a.h),point(a.a))>.1);
  const legAssumed=torsoAssumed||!legs.length;
  const legVector=legAssumed?{x:0,y:.24}:middle(legs.map(a=>({x:point(a.h).x-point(a.a).x,y:point(a.h).y-point(a.a).y})));
  const foot={x:hip.x-legVector.x,y:hip.y-legVector.y};
  const dx=hand.x-shoulder.x,dy=hand.y-shoulder.y,length=Math.hypot(dx,dy);
  const facingCertain=Math.abs(dx)>Math.max(.05,length*.35);
  // Arms hanging at attention give no reliable facing direction.
  const ready=facingCertain&&dy/length>-.8;
  const points=[foot,hip,shoulder,hand],f={valid:true,points,lengths:[distance(foot,hip),distance(hip,shoulder),length],
    leg:legAssumed?90:degrees(Math.atan2(legVector.y,legVector.x)),legAssumed,bodyX:shoulder.x/aspect,
    torso:torsoAssumed?90:degrees(Math.atan2(torsoVector.y,torsoVector.x)),
    arm:degrees(Math.atan2(dy,dx)),torsoAssumed,armSource:arms.length===2?'both':arms[0].name,
    ready,readinessReason:ready?'':'양팔을 앞으로 뻗어 화면에서도 옆으로 길게 보이게 해주십시오. 차렷 자세에서는 방향을 정하지 않습니다.'};
  f.facing=dx>=0?1:-1;
  return f;
}
export function makeBaseline(samples,{requireReady=true,minSamples=20}={}){
  if(samples.length<minSamples||samples.some(f=>!f.valid))throw Error('자세를 안정적으로 읽을 시간이 더 필요합니다. 다시 시도하십시오.');
  if(requireReady&&samples.some(f=>!f.ready))throw Error('양팔을 앞으로 뻗은 자세에서 방향을 잡습니다.');
  const facing=samples.reduce((s,f)=>s+f.facing,0)>=0?1:-1;
  const is3D=samples[0].coordinateMode==='heading3d';
  if(samples.some(f=>(f.coordinateMode==='heading3d')!==is3D))throw Error('입력 방식이 바뀌었습니다. 방향을 다시 잡으십시오.');
  for(const key of is3D?['leg','torso','arm','heading']:['leg','torso','arm']){
    if(samples.some(f=>!Number.isFinite(f[key])))throw Error('자세 값이 불확실합니다. 다시 시도하십시오.');
    const first=samples[0][key],angles=samples.map(f=>wrap(f[key]-first)).sort((a,b)=>a-b);
    if(angles[Math.floor(angles.length*.9)]-angles[Math.floor(angles.length*.1)]>18)
      throw Error('방향을 잡는 동안 움직임이 컸습니다. 팔을 편 채 잠시 멈추십시오.');
  }
  const centers=samples.map(f=>f.bodyX).filter(Number.isFinite).sort((a,b)=>a-b);
  const result={valid:true,facing,bodyX:centers.length?centers[Math.floor(centers.length/2)]:.5};
  if(is3D){
    const first=samples[0].heading,offsets=samples.map(f=>wrap(f.heading-first)).sort((a,b)=>a-b);
    result.heading=wrap(first+offsets[Math.floor(offsets.length/2)]);result.coordinateMode='heading3d';
  }
  return result;
}
export function mapBody(f,base,{reverse=false,baseEnabled=true,baseReverse=false,headingGain=1.5}={}){
  if(!f?.valid||!base?.valid)return null;
  const direction=base.facing*(reverse?-1:1);
  const pose=Object.fromEntries(['leg','torso','arm'].map(key=>[key,direction===1?f[key]:wrap(180-f[key])]));
  if(f.coordinateMode==='heading3d'){
    if(!Number.isFinite(f.heading))return null;
    const turn=wrap(f.heading-HEADING_ZERO),gain=Number.isFinite(headingGain)?clamp(headingGain,.5,3):1.5;
    pose.yaw=baseEnabled?clamp(Math.sign(turn)*Math.max(0,Math.abs(turn)-3)*gain*(baseReverse?-1:1),-60,60):0;
  }else{
    const shift=(f.bodyX??base.bodyX??.5)-(base.bodyX??.5);
    pose.yaw=baseEnabled?clamp(Math.sign(shift)*Math.max(0,Math.abs(shift)-.025)*240*(baseReverse?-1:1),-60,60):0;
  }
  return pose;
}
export function smoothPose(current,target,dt){
  const t=clamp(dt,0,.05),a=1-Math.exp(-t/.10),next={};
  for(const key of ['yaw','leg','torso','arm']){
    const from=current[key]??0,to=target[key]??0,rate=key==='yaw'?55:125;
    next[key]=from+clamp(wrap(to-from)*a,-rate*t,rate*t);
  }
  return next;
}
export function solveArm(pose){
  const points=[[0,ARM.base,0]];
  for(const key of ['leg','torso','arm']){
    const a=radians(pose[key]),p=points.at(-1);
    points.push([p[0]+ARM[key]*Math.cos(a),p[1]+ARM[key]*Math.sin(a),0]);
  }
  const hand=points.at(-1),pitch=radians(pose.arm),tip=[hand[0]+ARM.tool*Math.cos(pitch),hand[1]+ARM.tool*Math.sin(pitch),0];
  const yaw=radians(pose.yaw??0),rotate=p=>[p[0]*Math.cos(yaw),p[1],p[0]*Math.sin(yaw)];
  return {points:points.map(rotate),tip:rotate(tip),pitch,yaw,angles:[pose.yaw??0,pose.leg,wrap(pose.torso-pose.leg),wrap(pose.arm-pose.torso)],belowFloor:points.some(p=>p[1]<.025)||tip[1]<.025};
}
export function demoLandmarks({leg=90,torso=90,arm=0}={}){
  const p=Array.from({length:33},()=>({x:.5,y:.5,z:0,visibility:.99}));
  const put=(i,xy)=>p[i]={x:1-xy.x/(4/3),y:-xy.y,z:0,visibility:.99};
  const offset=(p,dx,dy)=>({x:p.x+dx,y:p.y+dy});
  const next=(p,l,a)=>({x:p.x+l*Math.cos(radians(a)),y:p.y+l*Math.sin(radians(a))});
  const foot={x:.45,y:-.94},hip=next(foot,.29,leg),shoulder=next(hip,.25,torso),hand=next(shoulder,.29,arm);
  [27,28].forEach((id,i)=>put(id,offset(foot,(i-.5)*.025,0)));
  [23,24].forEach((id,i)=>put(id,offset(hip,(i-.5)*.02,0)));
  [11,12].forEach((id,i)=>put(id,offset(shoulder,(i-.5)*.02,0)));
  [15,16].forEach((id,i)=>put(id,offset(hand,(i-.5)*.02,0)));
  [25,26].forEach((id,i)=>put(id,offset(middle([foot,hip]),.025+(i-.5)*.015,0)));
  [13,14].forEach((id,i)=>put(id,offset(middle([shoulder,hand]),(i-.5)*.015,0)));
  put(0,offset(shoulder,.025,.08));
  [29,30,31,32].forEach((id,i)=>put(id,offset(foot,.015+(i%2)*.015,-.01)));
  return p;
}
export class TrackingGate{
  constructor(){this.lastSeen=-Infinity;this.engaged=false;this.valid=false;}
  seen(valid,time){
    if(time-this.lastSeen>=TRACKING_GRACE_MS)this.engaged=false;
    this.valid=valid;if(valid)this.lastSeen=time;
  }
  start(time){this.engaged=this.valid&&time-this.lastSeen<350;return this.engaged;}
  stop(){this.engaged=false;}
  canMove(time){
    if(time-this.lastSeen>=TRACKING_GRACE_MS)this.engaged=false;
    // Retain the session during brief loss, but never extrapolate missing input.
    return this.engaged&&this.valid&&time-this.lastSeen<350;
  }
}
