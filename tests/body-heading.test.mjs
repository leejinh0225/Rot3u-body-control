import test from 'node:test';
import assert from 'node:assert/strict';
import {headingFeatures,HeadingContinuity,angleDelta,demoBody3D} from '../body-control/body-heading.mjs';
import {features,makeBaseline,mapBody} from '../body-control/motion.mjs';
import {AutoFollow} from '../body-control/auto-follow.mjs';
import {absoluteTarget,defaultMapping,poseFromPulses} from '../body-control/hardware-plan.mjs';
import {emptyProfile} from '../viewer/calibration.mjs';
import {idleState} from '../viewer/protocol.mjs';
const approx=(a,b,t=1e-8)=>assert.ok(Math.abs(a-b)<t,`${a} != ${b}`);
const feature=pose=>{const p=demoBody3D(pose);return headingFeatures(p.landmarks,p.worldLandmarks);};
const baseline=f=>makeBaseline(Array.from({length:25},()=>f));

test('3D body heading changes while identical forward bends retain their pitch',()=>{
  for(const heading of [-65,-30,0,35,65])for(const pose of [{leg:90,torso:90,arm:0},{leg:80,torso:55,arm:-30},{leg:105,torso:100,arm:55}]){
    const f=feature({...pose,heading});assert.equal(f.valid,true,f.reason);
    approx(f.heading,heading);
    for(const k of ['leg','torso','arm'])approx(f[k],pose[k]);
  }
});

test('positive heading faces right in the mirrored preview and repeated recapture never changes yaw zero',()=>{
  const p=demoBody3D({heading:45});
  assert.ok(p.landmarks[15].x<p.landmarks[11].x,'hand extends toward mirrored screen-right');
  const f=headingFeatures(p.landmarks,p.worldLandmarks);approx(f.heading,45);
  for(const start of [0,15,30,45,60,75]){
    const base=baseline(feature({heading:start}));
    approx(mapBody(f,base).yaw,0);
    approx(mapBody(feature({heading:65}),base).yaw,25.5);
  }
});

test('image translation and arbitrary world origin do not steer the base or alter bends',()=>{
  const p=demoBody3D({heading:35,torso:65,arm:20}),a=headingFeatures(p.landmarks,p.worldLandmarks),base=baseline(a);
  p.landmarks.forEach(v=>v.x+=.1);p.worldLandmarks.forEach(v=>{v.x+=2;v.y-=3;v.z+=4;});
  const b=headingFeatures(p.landmarks,p.worldLandmarks);
  assert.equal(b.valid,true);approx(mapBody(b,base).yaw,mapBody(a,base).yaw);
  for(const k of ['heading','leg','torso','arm'])approx(b[k],a[k]);
});

test('body turn maps to bounded yaw with gain, dead band and reverse; bend remains absolute',()=>{
  const start=feature({heading:15,torso:65,arm:20}),base=baseline(start);
  const changed=feature({heading:68,torso:65,arm:20});
  approx(mapBody(changed,base).yaw,30);
  approx(mapBody(changed,base,{baseReverse:true}).yaw,-30);
  approx(mapBody(changed,base,{headingGain:2}).yaw,40);
  approx(mapBody(feature({heading:47}),base).yaw,0);
  approx(mapBody(feature({heading:0}),base).yaw,-60);
  approx(mapBody(changed,baseline(feature({heading:60}))).yaw,30);
  approx(mapBody(feature({heading:45}),base).yaw,0);
  approx(mapBody(changed,base,{baseEnabled:false}).yaw,0);
  approx(mapBody(changed,base).torso,65);approx(mapBody(changed,base).arm,20);
});

test('front-facing forward arms can calibrate without the old screen-width facing rule',()=>{
  const f=feature({heading:0});assert.equal(f.valid,true);assert.equal(f.ready,true);
  assert.equal(baseline(f).coordinateMode,'heading3d');
  assert.equal(feature({heading:0,arm:-90}).ready,false);
});

test('cropped hips and legs use vertical assumptions; occluded shoulder freezes 3D instead of falling back',()=>{
  const p=demoBody3D({heading:30,arm:20});
  [23,24,27,28].forEach(i=>{p.landmarks[i].visibility=0;p.landmarks[i].y=1.2;});
  const f=headingFeatures(p.landmarks,p.worldLandmarks);
  assert.equal(f.valid,true);assert.equal(f.legAssumed,true);assert.equal(f.torsoAssumed,true);
  approx(f.leg,90);approx(f.torso,90);approx(f.arm,20);
  p.landmarks[12].visibility=.1;
  const missing=headingFeatures(p.landmarks,p.worldLandmarks);
  assert.equal(missing.valid,false);assert.match(missing.reason,/양쪽 어깨/);
  assert.equal(features(p.landmarks).valid,true,'fixed 2D still works on the visible arm');
});

test('invalid depth, collapsed shoulder line and out-of-frame shoulders cannot control yaw',()=>{
  for(const mutate of [p=>p.worldLandmarks[12].z=NaN,p=>p.worldLandmarks[11].visibility=0,p=>p.landmarks[11].x=1.2,
    p=>p.worldLandmarks[12]={...p.worldLandmarks[11]},p=>p.landmarks[12]={...p.landmarks[11]}]){
    const p=demoBody3D();mutate(p);assert.equal(headingFeatures(p.landmarks,p.worldLandmarks).valid,false);
  }
  assert.equal(headingFeatures(demoBody3D().landmarks,null).valid,false);
  assert.equal(feature({heading:90}).valid,false);
});

test('one visible wrist is enough but a left shoulder cannot pair with the opposite wrist',()=>{
  const p=demoBody3D();p.landmarks[16].visibility=.1;
  assert.equal(headingFeatures(p.landmarks,p.worldLandmarks).armSource,'left');
  assert.equal(headingFeatures(p.landmarks,p.worldLandmarks,4/3,'right').valid,false);
  p.landmarks[15].visibility=.1;assert.equal(headingFeatures(p.landmarks,p.worldLandmarks).valid,false);
});

test('calibration checks heading stability and circular wrap; automatic recovery retains heading zero',()=>{
  const f=feature({heading:30}),a=new AutoFollow();let started;
  for(let t=0;t<=3000;t+=100)started=a.observe(f,t);
  assert.equal(started.phase,'start');approx(started.baseline.heading,30);
  const samples=Array.from({length:25},(_,i)=>({...f,heading:i%2?30:65}));
  assert.throws(()=>makeBaseline(samples),/움직임/);
  const wrapped=makeBaseline(samples.map((v,i)=>({...v,heading:i%2?179:-179})));
  assert.ok(Math.abs(wrapped.heading)>178);
  approx(angleDelta(-179,179),2);
  a.observe({valid:false},3200,{baseline:started.baseline});let recovered;
  for(let t=3300;t<=3900;t+=100)recovered=a.observe(feature({heading:50,arm:-90}),t,{baseline:started.baseline});
  assert.equal(recovered.phase,'start');assert.equal(recovered.baseline,started.baseline);
  assert.throws(()=>makeBaseline([f,...Array.from({length:24},()=>({...f,coordinateMode:undefined}))]),/입력 방식/);
});

test('single-frame depth/left-right glitches stop input; stale history cannot create a permanent lock',()=>{
  const continuity=new HeadingContinuity(),f=feature({heading:30});
  assert.equal(continuity.observe(f,100).valid,true);
  assert.equal(continuity.observe({...f,heading:-150},160).valid,false);
  assert.equal(continuity.observe({...f,heading:33},220).valid,true);
  assert.equal(continuity.observe({...f,arm:-70},280).valid,false);
  assert.equal(continuity.observe({...f,arm:-70},600).valid,true);
  continuity.reset();assert.equal(continuity.observe(f,620).valid,true);
});

test('fixed mode ignores image translation and feeds the same absolute pitch to robot mapping',()=>{
  const p=demoBody3D({heading:65,torso:75,arm:35});
  const f=features(p.landmarks),b=baseline(f);p.landmarks.forEach(v=>v.x+=.05);
  const moved=mapBody(features(p.landmarks),b,{baseEnabled:false});
  approx(moved.yaw,0);approx(moved.arm,mapBody(f,b,{baseEnabled:false}).arm);
  const real=emptyProfile();real.channels.slice(0,5).forEach(c=>c.recorded=true);
  const state=idleState();state.lower.fill(500);state.upper.fill(2500);
  const absolute=mapBody(feature({heading:38,torso:65,arm:20}),baseline(feature({heading:15}))),mapping=defaultMapping();
  const goal=absoluteTarget(absolute,real,mapping,state),roundTrip=poseFromPulses(goal.pulses,real,mapping);
  for(const k of ['yaw','leg','torso','arm'])approx(roundTrip[k],absolute[k],.15);
  assert.equal(goal.pulses[5],1500);
});
