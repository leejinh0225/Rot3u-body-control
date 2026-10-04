// MediaPipe worldLandmarks are monocular estimates, not depth measurements.
// Camera axes: image-right x, image-down y, depth z. The camera must be level.
const rad=v=>v*Math.PI/180,deg=v=>v*180/Math.PI;
const sub=(a,b)=>({x:a.x-b.x,y:a.y-b.y,z:a.z-b.z});
const length=v=>Math.hypot(v.x,v.y,v.z);
const average=points=>Object.fromEntries(['x','y','z'].map(k=>[k,points.reduce((s,p)=>s+p[k],0)/points.length]));
export const angleDelta=(a,b)=>((a-b+180)%360+360)%360-180;

export function headingFeatures(image,world,aspect=4/3,armMode='both'){
  const bad=reason=>({valid:false,coordinateMode:'heading3d',reason});
  if(!Array.isArray(image)||!Array.isArray(world))return bad('몸 방향 3D 추정을 기다립니다. 양쪽 어깨와 뻗은 팔을 보여주십시오.');
  const good=(i,threshold=.4)=>{
    const p=image[i],w=world[i];
    return p&&w&&[p.x,p.y,w.x,w.y,w.z].every(Number.isFinite)&&
      p.visibility>=threshold&&w.visibility>=threshold&&
      p.x>.005&&p.x<.995&&p.y>.005&&p.y<.995;
  };
  if(!good(11,.5)||!good(12,.5))return bad('양쪽 어깨가 필요합니다. 완전한 옆모습 대신 카메라 쪽으로 조금 돌아보십시오.');
  const right=sub(world[12],world[11]),width=Math.hypot(right.x,right.z);
  const imageWidth=Math.hypot((image[12].x-image[11].x)*aspect,image[12].y-image[11].y);
  if(width<.12||width>.8||imageWidth<.025||Math.abs(right.y)>width*.9)
    return bad('어깨 방향이 불확실합니다. 양쪽 어깨가 겹치지 않도록 조금 돌아보십시오.');
  // Anatomical right from left->right shoulder. Its horizontal normal is forward.
  const forward={x:-right.z/width,z:right.x/width};
  const heading=-deg(Math.atan2(forward.x,-forward.z)); // mirrored preview right is positive
  const fore=v=>v.x*forward.x+v.z*forward.z;
  const pitch=v=>deg(Math.atan2(-v.y,fore(v)));
  const lateral=v=>Math.abs((v.x*right.x+v.z*right.z)/width);
  let arms=[{name:'left',s:11,w:15,h:23},{name:'right',s:12,w:16,h:24}]
    .filter(a=>(armMode==='both'||armMode===a.name)&&good(a.s)&&good(a.w))
    .map(a=>({...a,vector:sub(world[a.w],world[a.s]),score:Math.min(image[a.w].visibility,world[a.w].visibility)}))
    .filter(a=>length(a.vector)>.12&&length(a.vector)<1.1&&lateral(a.vector)<length(a.vector)*.8)
    .sort((a,b)=>b.score-a.score);
  if(!arms.length)return bad('몸 앞쪽으로 뻗은 팔을 보여주십시오. 손목의 3D 위치가 불확실합니다.');
  if(arms.length===2){
    const [a,b]=arms,agreement=['x','y','z'].reduce((sum,k)=>sum+a.vector[k]*b.vector[k],0)/(length(a.vector)*length(b.vector));
    if(agreement<.7||b.score<.5||a.score-b.score>.2)arms=arms.slice(0,1);
  }
  const armVector=average(arms.map(a=>a.vector));
  const torsos=arms.filter(a=>good(a.h)&&length(sub(world[a.s],world[a.h]))>.12);
  const torsoAssumed=!torsos.length;
  const torsoVector=torsoAssumed?{x:0,y:-.4,z:0}:average(torsos.map(a=>sub(world[a.s],world[a.h])));
  if(!torsoAssumed&&(length(torsoVector)>.9||lateral(torsoVector)>length(torsoVector)*.8))
    return bad('몸통의 3D 방향이 불확실합니다. 정면 또는 비스듬한 자세로 돌아오십시오.');
  const legs=[{h:23,a:27},{h:24,a:28}].filter(a=>good(a.h,.5)&&good(a.a,.5)&&length(sub(world[a.h],world[a.a]))>.2);
  const legAssumed=torsoAssumed||!legs.length;
  const legVector=legAssumed?{x:0,y:-.6,z:0}:average(legs.map(a=>sub(world[a.h],world[a.a])));
  // Overlay points stay in image coordinates; never mix normalized image z with world xy.
  const screen=i=>({x:(1-image[i].x)*aspect,y:-image[i].y,z:0});
  const shoulder=average(arms.map(a=>screen(a.s))),hand=average(arms.map(a=>screen(a.w)));
  const hip=torsoAssumed?{...shoulder,y:shoulder.y-.24}:average(torsos.map(a=>screen(a.h)));
  const foot=legAssumed?{...hip,y:hip.y-.24}:average(legs.map(a=>screen(a.a)));
  const ready=fore(armVector)>.12&&pitch(armVector)>-55;
  return {valid:true,coordinateMode:'heading3d',heading,leg:pitch(legVector),torso:pitch(torsoVector),arm:pitch(armVector),
    legAssumed,torsoAssumed,points:[foot,hip,shoulder,hand],lengths:[length(legVector),length(torsoVector),length(armVector)],
    facing:1,bodyX:shoulder.x/aspect,armSource:arms.length===2?'both':arms[0].name,ready,
    readinessReason:ready?'':'양팔을 몸 앞쪽으로 뻗고 잠시 멈추십시오. 거울 화면 오른쪽 45°가 베이스 중앙입니다.'};
}

// A single depth/sign glitch must not create a new commanded heading.
// After a real tracking gap the existing stable-pose recovery handles restart.
export class HeadingContinuity{
  constructor(){this.reset();}
  reset(){this.previous=null;this.at=0;}
  observe(feature,time){
    if(!feature.valid)return feature;
    if(this.previous&&time>this.at&&time-this.at<350){
      const jumps=['heading','leg','torso','arm'].filter(k=>Math.abs(angleDelta(feature[k],this.previous[k]))>35);
      if(jumps.length)return {...feature,valid:false,reason:'3D 방향이 갑자기 바뀌어 잠시 멈춥니다. 자세가 안정되면 다시 이어갑니다.'};
    }
    this.previous=feature;this.at=time;return feature;
  }
}

// Synthetic 3D skeleton for repeatable UI/math tests. No camera or servo input.
export function demoBody3D({heading=45,leg=90,torso=90,arm=0,shift=0}={}){
  const f={x:-Math.sin(rad(heading)),z:-Math.cos(rad(heading))},r={x:-Math.cos(rad(heading)),z:Math.sin(rad(heading))};
  const world=Array.from({length:33},()=>({x:0,y:0,z:0,visibility:.99}));
  const offset=(p,side)=>({x:p.x+r.x*side,y:p.y,z:p.z+r.z*side,visibility:.99});
  const vector=(l,a)=>({x:f.x*l*Math.cos(rad(a)),y:-l*Math.sin(rad(a)),z:f.z*l*Math.cos(rad(a))});
  const add=(a,b)=>({x:a.x+b.x,y:a.y+b.y,z:a.z+b.z,visibility:.99});
  const hip={x:0,y:0,z:0},foot=sub(hip,vector(.65,leg)),shoulder=add(hip,vector(.45,torso)),hand=add(shoulder,vector(.55,arm));
  for(const [ids,p,width] of [[[23,24],hip,.16],[[27,28],foot,.13],[[11,12],shoulder,.2],[[15,16],hand,.18]])
    ids.forEach((id,i)=>world[id]=offset(p,i?width:-width));
  [[13,11,15],[14,12,16],[25,23,27],[26,24,28]].forEach(([id,a,b])=>world[id]={...average([world[a],world[b]]),visibility:.99});
  world[0]=add(shoulder,{x:f.x*.05,y:-.2,z:f.z*.05});
  [29,31].forEach(id=>world[id]={...world[27]});[30,32].forEach(id=>world[id]={...world[28]});
  const landmarks=world.map(p=>({x:.5+p.x*.55+shift,y:.48+p.y*.43,z:p.z,visibility:.99}));
  return {landmarks,worldLandmarks:world};
}
