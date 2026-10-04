import test from 'node:test';
import assert from 'node:assert/strict';
import {degreesToUs,usToDegrees,nominalTicks,nominalPulseUs,secondsToTarget} from '../viewer/units.mjs';
import {idleState,setCommand,holdCommand} from '../viewer/protocol.mjs';
import {emptyProfile,recordZero,validateProfile} from '../viewer/calibration.mjs';
test('declared degree scale is centered at 1500, with bounded and monotonic rounded pulses',()=>{
  assert.equal(degreesToUs(0),500); assert.equal(degreesToUs(90),1500); assert.equal(degreesToUs(180),2500);
  assert.equal(degreesToUs(91),1511); assert.equal(degreesToUs(95),1556);
  for(const deg of [-1,181,NaN,Infinity]) assert.throws(()=>degreesToUs(deg));
  for(let deg=0;deg<=180;deg++) assert.ok(Math.abs(usToDegrees(degreesToUs(deg))-deg)<=0.0451);
  const state={...idleState(),mask:32};
  assert.equal(setCommand(5,degreesToUs(120),state),'SET 5 1833');
  assert.throws(()=>setCommand(5,degreesToUs(180),state));
});
test('quantization and ramp timing explain small or delayed commands',()=>{
  assert.equal(nominalTicks(1500),307); assert.equal(nominalTicks(1501),308);
  assert.equal(nominalTicks(1502),308); assert.equal(nominalTicks(1505),308);
  assert.equal(nominalPulseUs(1500),1498.16);
  assert.equal(secondsToTarget(1500,1600),1); assert.equal(secondsToTarget(1600,1500),1);
});
test('old zeros remain valid and wider zero files still obey current firmware joint limits',()=>{
  const old=emptyProfile(); old.channels[1]={ch:1,zeroUs:1515,recorded:true,note:'v3 기록'};
  assert.equal(validateProfile(old).channels[1].zeroUs,1515);
  const state={...idleState(),mask:63}; state.upper[5]=2400; state.applied[5]=state.target[5]=2300;
  let profile=emptyProfile(); for(let ch=0;ch<6;ch++) profile=recordZero(profile,ch,state,false,'');
  assert.equal(validateProfile(JSON.parse(JSON.stringify(profile))).channels[5].zeroUs,2300);
  assert.throws(()=>holdCommand(63,idleState(),true,profile.channels.map(c=>c.zeroUs)));
});
