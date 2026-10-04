import test from 'node:test';
import assert from 'node:assert/strict';
import {ARM,NEUTRAL,features,makeBaseline,mapBody,smoothPose,solveArm,demoLandmarks,TrackingGate} from '../body-control/motion.mjs';
const approx=(a,b,t=1e-8)=>assert.ok(Math.abs(a-b)<t,a+' != '+b);
const base=makeBaseline(Array.from({length:25},()=>features(demoLandmarks())));

test('base rotation has a deadzone, bounded yaw, reverse and disable controls',()=>{
  const f=features(demoLandmarks()),b={...base,bodyX:f.bodyX};
  approx(mapBody({...f,bodyX:b.bodyX+.02},b).yaw,0);
  approx(mapBody({...f,bodyX:b.bodyX+.125},b).yaw,24);
  approx(mapBody({...f,bodyX:b.bodyX+.125},b,{baseReverse:true}).yaw,-24);
  approx(mapBody({...f,bodyX:b.bodyX+1},b).yaw,60);
  approx(mapBody({...f,bodyX:b.bodyX+1},b,{baseEnabled:false}).yaw,0);
});
test('cropped ankles fall back to 90 degrees and visible ankles restore leg motion',()=>{
  const points=demoLandmarks({leg:80});
  assert.equal(features(points).legAssumed,false);approx(features(points).leg,80);
  [27,28].forEach(i=>points[i].visibility=.1);
  assert.equal(features(points).legAssumed,true);approx(features(points).leg,90);
});
test('base yaw rotates the arm in space without changing height or radial reach',()=>{
  const pose={leg:85,torso:60,arm:0};
  const a=solveArm({...pose,yaw:0}),b=solveArm({...pose,yaw:60});
  approx(a.tip[1],b.tip[1]);approx(Math.hypot(a.tip[0],a.tip[2]),Math.hypot(b.tip[0],b.tip[2]));
  assert.ok(b.tip[2]>.1);
});

test('visible legs and upper body follow their measured orientations',()=>{
  for(const pose of [{leg:90,torso:90,arm:0},{leg:80,torso:45,arm:-35},{leg:105,torso:95,arm:60}]){
    const f=features(demoLandmarks(pose));assert.equal(f.valid,true);
    const output=mapBody(f,base);
    approx(output.leg,pose.leg);
    for(const key of ['torso','arm'])approx(output[key],pose[key]);
  }
});
test('opposite facing is normalized without reversing gravity',()=>{
  const points=demoLandmarks({leg:80,torso:60,arm:20});
  points.forEach(p=>p.x=1-p.x);
  const f=features(points),b=makeBaseline(Array.from({length:25},()=>f));
  const output=mapBody(f,b);
  approx(output.leg,80);approx(output.torso,60);approx(output.arm,20);
});
test('occluded paired landmarks use the visible side; losing both stops input',()=>{
  const p=demoLandmarks();[11,15,23,27].forEach(i=>p[i].visibility=.1);
  assert.equal(features(p).valid,true);
  assert.equal(features(p,4/3,'left').valid,false);
  assert.equal(features(p,4/3,'right').valid,true);
  p[28].visibility=.1;assert.equal(features(p).valid,true);
  p[16].visibility=.1;assert.equal(features(p).valid,false);
  assert.equal(features(null).valid,false);
});
test('inconsistent far arm does not corrupt the higher-confidence near arm',()=>{
  const p=demoLandmarks({torso:60,arm:20});p[16].x=.9;p[16].visibility=.45;
  const f=features(p);
  assert.equal(f.valid,true);assert.equal(f.armSource,'left');approx(f.arm,20);
});
test('cropped feet and hips still allow arm motion with explicit vertical torso assumption',()=>{
  const p=demoLandmarks({torso:55,arm:10});
  [23,24,25,26,27,28].forEach(i=>{p[i].visibility=0;p[i].y=1.2;});
  const f=features(p);assert.equal(f.valid,true);assert.equal(f.torsoAssumed,true);
  approx(f.leg,90);approx(f.torso,90);approx(f.arm,10);
});
test('side view works with only one coherent arm at moderate confidence',()=>{
  const p=demoLandmarks({torso:65,arm:25});
  [11,15,23].forEach(i=>p[i].visibility=.42);
  [12,16,24,27,28].forEach(i=>p[i].visibility=.1);
  const f=features(p);assert.equal(f.valid,true);assert.equal(f.ready,true);
  assert.equal(f.armSource,'left');approx(f.torso,65);approx(f.arm,25);
});
test('a mismatched shoulder and opposite wrist are not accepted as one arm',()=>{
  const p=demoLandmarks();p[15].visibility=.1;p[12].visibility=.1;
  assert.equal(features(p).valid,false);
});
test('attention posture can be tracked but cannot set a random facing direction',()=>{
  const f=features(demoLandmarks({arm:-90}));
  assert.equal(f.valid,true);assert.equal(f.ready,false);
  assert.throws(()=>makeBaseline(Array.from({length:25},()=>f)),/앞으로/);
});
test('calibration rejects inadequate or unstable samples and preserves actual angles',()=>{
  const f=features(demoLandmarks({leg:85,torso:55,arm:10}));
  assert.throws(()=>makeBaseline([f]),/시간/);
  const samples=Array.from({length:30},(_,i)=>({...f,torso:i*3}));
  assert.throws(()=>makeBaseline(samples),/움직임/);
  const b=makeBaseline(Array.from({length:25},()=>f));
  approx(mapBody(f,b).torso,55);
});
test('brief loss holds motion without dropping the session; expiry and manual pause require restart',()=>{
  const g=new TrackingGate();assert.equal(g.start(0),false);
  g.seen(true,100);assert.equal(g.start(120),true);
  assert.equal(g.canMove(449),true);assert.equal(g.canMove(450),false);
  assert.equal(g.engaged,true);
  g.seen(true,500);assert.equal(g.canMove(510),true);
  g.seen(false,520);assert.equal(g.canMove(530),false);assert.equal(g.engaged,true);
  g.seen(true,540);assert.equal(g.canMove(550),true);
  assert.equal(g.canMove(1340),false);assert.equal(g.engaged,false);
  g.seen(true,1350);assert.equal(g.canMove(1360),false);assert.equal(g.start(1360),true);
  g.stop();assert.equal(g.canMove(560),false);
  g.seen(true,1400);assert.equal(g.canMove(1400),false);
});
test('frame gaps do not cause a sudden angle jump, and wrap uses shortest rotation',()=>{
  const next=smoothPose(NEUTRAL,{leg:10,torso:10,arm:90},3);
  for(const key of Object.keys(NEUTRAL))assert.ok(Math.abs(next[key]-NEUTRAL[key])<=6.25+.00001);
  assert.deepEqual(smoothPose(NEUTRAL,{leg:10,torso:10,arm:90},0),NEUTRAL);
  assert.ok(smoothPose({leg:179,torso:179,arm:179},{leg:-179,torso:-179,arm:-179},.016).leg>179);
});
test('connected model keeps fixed link lengths and bends down with a bowing body',()=>{
  const standing=solveArm(NEUTRAL),bow=solveArm({leg:85,torso:35,arm:-40});
  assert.ok(bow.tip[1]<standing.tip[1]);assert.ok(bow.tip[0]>standing.tip[0]);
  for(const leg of [50,90,130])for(const torso of [0,45,90])for(const arm of [-60,0,90]){
    const k=solveArm({leg,torso,arm});
    ['leg','torso','arm'].forEach((key,i)=>{
      const a=k.points[i],b=k.points[i+1];
      approx(Math.hypot(...a.map((x,j)=>x-b[j])),ARM[key]);
    });
    assert.ok(k.angles.every(Number.isFinite));
  }
});
