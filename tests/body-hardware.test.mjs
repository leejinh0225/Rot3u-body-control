import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyProfile} from '../viewer/calibration.mjs';
import {idleState} from '../viewer/protocol.mjs';
import {defaultMapping,validateMapping,checkSetup,targetPulses,absoluteTarget,poseFromPulses,guardedStep,moveCommand,planRemap} from '../body-control/hardware-plan.mjs';
import {DEFAULT_GEOMETRY,VIRTUAL_GEOMETRY,validateGeometry,collisionAt,safePath,segmentDistance} from '../body-control/collision.mjs';
const upright={yaw:0,leg:90,torso:90,arm:90};
test('virtual collision envelope includes the visible scoop width',()=>{
  assert.equal(collisionAt(upright,VIRTUAL_GEOMETRY),'');
  assert.match(collisionAt({yaw:45,leg:90,torso:4,arm:-88},VIRTUAL_GEOMETRY),/바닥/);
});
function fixture(){
  const p=emptyProfile();for(let ch=0;ch<5;ch++)p.channels[ch].recorded=true;
  return {p,s:{...idleState(),mask:31},m:defaultMapping()};
}
test('zero uses recorded PWM, excludes unrecorded gripper, and requires matching ports',()=>{
  const {p,s,m}=fixture();p.channels[1].zeroUs=1677;
  assert.equal(checkSetup(p,m,s).zero[1],1677);
  s.map[5]=6;assert.throws(()=>checkSetup(p,m,s),/매핑/);
  s.map[5]=5;s.upper[1]=1600;assert.throws(()=>checkSetup(p,m,s),/한계/);
  s.upper[1]=2000;p.source='demo';assert.throws(()=>checkSetup(p,m,s));
});
test('joint delta uses relative pitch, configurable sign, no gripper and fixed wrist roll',()=>{
  const {p,s,m}=fixture();m.forEach(r=>{r.usPerDegree=10;r.gain=.5;});m[2].sign=-1;
  const result=targetPulses({yaw:10,leg:100,torso:120,arm:110},upright,s.applied,p,m,s);
  assert.deepEqual(result,[1550,1550,1400,1450,1500,1500]);
  // Actual geometry undoes pulse scaling, not the operator's motion gain.
  assert.deepEqual(poseFromPulses(result,p,m),{yaw:5,leg:95,torso:105,arm:100});
});
test('body control saturates both zero-relative limits and firmware limits',()=>{
  const {p,s,m}=fixture();s.upper[0]=1550;s.lower[1]=1480;
  const result=targetPulses({yaw:500,leg:-500,torso:-900,arm:900},upright,s.applied,p,m,s);
  assert.deepEqual(result,[1550,1480,1000,2000,1500,1500]);
  assert.throws(()=>targetPulses({...upright,arm:NaN},upright,s.applied,p,m,s));
});
test('default motion maps a 30 degree change to 30 commanded degrees without increasing step speed',()=>{
  const {p,s,m}=fixture();
  const desired=targetPulses({...upright,arm:120},upright,s.applied,p,m,s);
  assert.equal(desired[3],1833);
  const step=guardedStep(desired,s,p,m,DEFAULT_GEOMETRY);
  assert.equal(step.safe,true);assert.equal(step.pulses[3],1508);
  assert.equal(targetPulses({...upright,arm:180},upright,s.applied,p,m,s)[3],2000);
});
test('off-center calibrated zero still obeys firmware upper bound with the wider default range',()=>{
  const {p,s,m}=fixture();p.channels[1].zeroUs=1677;s.applied[1]=s.target[1]=1677;
  const desired=targetPulses({yaw:0,leg:150,torso:150,arm:150},upright,s.applied,p,m,s);
  assert.equal(desired[1],2000);assert.equal(desired[4],1500);assert.equal(desired[5],1500);
});
test('duplicate or excluded joint mapping and unknown physical dimensions are rejected',()=>{
  const {m}=fixture();m[4].ch=3;assert.throws(()=>validateMapping(m));
  m[4].ch=5;assert.throws(()=>validateMapping(m));
  assert.throws(()=>validateGeometry({...DEFAULT_GEOMETRY,lengths:[0,.1,.1]}));
  assert.throws(()=>validateGeometry({...DEFAULT_GEOMETRY,radius:NaN}));
});

test('absolute target uses recorded vertical zero regardless of present output or first pose',()=>{
  const {p,s,m}=fixture();
  [1523,1677,1611,1500,1612].forEach((v,ch)=>p.channels[ch].zeroUs=v);
  s.lower.fill(500);s.upper.fill(2500);s.applied=[1400,1400,1400,1800,1500,1500];s.target=[...s.applied];
  const goal=absoluteTarget({yaw:12,leg:100,torso:80,arm:0},p,m,s);
  assert.deepEqual(goal.pulses,[1656,1788,1389,611,1612,1500]);assert.deepEqual(goal.limited,[]);
  const pose=poseFromPulses(goal.pulses,p,m);
  for(const [key,value] of Object.entries({yaw:12,leg:100,torso:80,arm:0}))assert.ok(Math.abs(pose[key]-value)<.1);
  assert.deepEqual(absoluteTarget(upright,p,m,s).pulses,[1523,1677,1611,1500,1612,1500]);
  assert.deepEqual(absoluteTarget({...upright,arm:-30},p,m,s).limited,['CH3 손목 굽힘']);
});

test('absolute target respects configured zero geometry, role permutation and signs',()=>{
  const {p,s,m}=fixture();s.lower.fill(500);s.upper.fill(2500);
  [m[1].ch,m[2].ch]=[2,1];m[1].sign=-1;
  const geometry={...DEFAULT_GEOMETRY,zeroAngles:[85,5,-5]};
  const pose={yaw:-10,leg:100,torso:80,arm:10},goal=absoluteTarget(pose,p,m,s,geometry);
  const recovered=poseFromPulses(goal.pulses,p,m,geometry);
  for(const key of Object.keys(pose))assert.ok(Math.abs(recovered[key]-pose[key])<.1);
});

test('fast steps remain bounded, preserve CH5 and reject a crossed joint boundary',()=>{
  const {p,s,m}=fixture(),goal=[1600,1510,1450,1520,1500,1900];
  const result=guardedStep(goal,s,p,m,DEFAULT_GEOMETRY,100);
  assert.equal(result.safe,true);assert.deepEqual(result.pulses,[1600,1510,1450,1520,1500,1500]);
  assert.equal(guardedStep([1620,...goal.slice(1)],s,p,m,DEFAULT_GEOMETRY,120).pulses[0],1620);
  assert.throws(()=>guardedStep(goal,s,p,m,DEFAULT_GEOMETRY,121));
  s.lower.fill(500);s.upper.fill(2500);
  s.applied[0]=s.target[0]=2450;
  const invalid=guardedStep([2500,1500,1500,1500,1500,1500],s,p,m,DEFAULT_GEOMETRY,100);
  assert.equal(invalid.safe,false);assert.match(invalid.reason,/각도/);
});
test('settled commanded output is required and a step cannot exceed eight microseconds',()=>{
  const {p,s,m}=fixture(),goal=[1600,1510,1450,1520,1500,1900];
  const result=guardedStep(goal,s,p,m,DEFAULT_GEOMETRY);
  assert.equal(result.safe,true);assert.deepEqual(result.pulses,[1508,1508,1492,1508,1500,1500]);
  assert.equal(moveCommand(result.pulses),'MOVE 31 1508 1508 1492 1508 1500 1500');
  s.target[0]=1508;assert.throws(()=>guardedStep(goal,s,p,m,DEFAULT_GEOMETRY),/완료/);
  s.target[0]=1500;s.mask=63;assert.throws(()=>guardedStep(goal,s,p,m,DEFAULT_GEOMETRY));
  assert.throws(()=>moveCommand([1500,1500,499,1500,1500,1500]));
});
test('capsule distance covers crossing, parallel and point-degenerate segments',()=>{
  assert.equal(segmentDistance([0,0,0],[1,0,0],[.5,-1,0],[.5,1,0]),0);
  assert.equal(segmentDistance([0,0,0],[1,0,0],[0,2,0],[1,2,0]),2);
  assert.equal(segmentDistance([0,0,0],[0,0,0],[0,3,4],[0,3,4]),5);
});
test('floor, base, self interference and joint limits have distinct stop reasons',()=>{
  assert.equal(collisionAt(upright),'');
  assert.equal(collisionAt({yaw:0,leg:20,torso:-120,arm:-150}),'바닥 / 테이블');
  assert.equal(collisionAt({yaw:0,leg:20,torso:100,arm:240}),'링크끼리 간섭');
  assert.equal(collisionAt({yaw:0,leg:20,torso:140,arm:240}),'베이스 간섭');
  assert.match(collisionAt({...upright,yaw:91}),/각도/);
  assert.match(collisionAt({...upright,arm:NaN}),/오류/);
});
test('safe endpoints do not permit passing through the floor between them',()=>{
  const a={yaw:0,leg:20,torso:-20,arm:0},b={yaw:0,leg:20,torso:60,arm:-90};
  assert.equal(collisionAt(a),'');assert.equal(collisionAt(b),'');
  assert.deepEqual(safePath(a,b),{safe:false,reason:'바닥 / 테이블'});
  assert.equal(safePath(upright,{yaw:40,leg:90,torso:75,arm:0}).safe,true);
});
test('a physical ramp that reaches a collision boundary is rejected before transmission',()=>{
  const {p,s,m}=fixture();m.forEach(r=>r.usPerDegree=5);
  // Approach a fold from a non-colliding configuration; locate the first
  // rejected 1us sample using the geometric oracle, then propose its 8us step.
  let previous=null,found=false;
  for(let us=1600;us>=1000;us--){
    const pulses=[1500,1150,1300,us,1500,1500];
    const reason=collisionAt(poseFromPulses(pulses,p,m));
    if(reason&&previous){
      s.applied=[...previous];s.target=[...previous];
      const result=guardedStep(pulses,s,p,m,DEFAULT_GEOMETRY);
      assert.equal(result.safe,false);assert.deepEqual(result.pulses,previous);found=true;break;
    }
    if(!reason)previous=pulses;
  }
  assert.equal(found,true);
});
test('PCA permutation uses an unoccupied temporary port and preserves uniqueness',()=>{
  for(const wanted of [[1,2,0,4,3,6],[0,1,2,3,4,8]]){
    const map=[0,1,2,3,4,5];
    for(const cmd of planRemap(map,wanted)){
      const [,ch,port]=cmd.split(' ').map(Number);
      assert.equal(map.includes(port),false);map[ch]=port;
      assert.equal(new Set(map).size,6);
    }
    assert.deepEqual(map,wanted);
  }
});
