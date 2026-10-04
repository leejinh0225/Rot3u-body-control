import test from 'node:test';
import assert from 'node:assert/strict';
import {features,demoLandmarks} from '../body-control/motion.mjs';
import {AutoFollow} from '../body-control/auto-follow.mjs';
const pose=features(demoLandmarks());
const feed=(auto,start,end,feature=pose,context={})=>{
  let result;
  for(let t=start;t<=end;t+=100)result=auto.observe(feature,t,context);
  return result;
};
test('stable upper body starts automatically after three seconds without any direction button',()=>{
  const a=new AutoFollow();
  assert.equal(feed(a,0,2900).phase,'countdown');
  const result=a.observe(pose,3000);
  assert.equal(result.phase,'start');assert.equal(result.baseline.facing,pose.facing);
});
test('standing at attention never starts automatic direction calibration',()=>{
  const a=new AutoFollow(),attention=features(demoLandmarks({arm:-90}));
  assert.equal(feed(a,0,5000,attention).phase,'position');
  assert.equal(feed(a,5100,8000).phase,'countdown');
  assert.equal(a.observe(pose,8100).phase,'start');
});
test('short dropout preserves countdown progress without counting missing time; long gap resets',()=>{
  const a=new AutoFollow();feed(a,0,2800);
  assert.equal(a.observe({valid:false},2900).phase,'holding');
  assert.equal(a.observe(pose,3000).seconds,1);
  assert.equal(a.observe(pose,3200).phase,'start');
  assert.equal(a.observe(pose,5000).seconds,3);
  assert.equal(feed(a,5100,7900).phase,'countdown');
  assert.equal(a.observe(pose,8000).phase,'start');
});
test('unstable posture retries without recording a wrong baseline',()=>{
  const a=new AutoFollow();let result;
  for(let t=0;t<=3000;t+=100)result=a.observe({...pose,torso:40+(t/100%2)*50},t);
  assert.equal(result.phase,'unstable');
  assert.equal(feed(a,3100,6100).phase,'start');
});
test('automatic recovery retains facing and waits for stable pose, including a lowered arm',()=>{
  const a=new AutoFollow(),baseline=feed(a,0,3000).baseline;
  a.observe({valid:false},3200,{baseline});
  const lowered=features(demoLandmarks({arm:-90}));
  assert.equal(feed(a,3300,3800,lowered,{baseline}).phase,'countdown');
  const result=a.observe(lowered,3900,{baseline});
  assert.equal(result.phase,'start');assert.equal(result.baseline,baseline);assert.equal(result.recovering,true);
});
test('manual pause and disabled auto mode never silently restart',()=>{
  const a=new AutoFollow();a.pause();
  assert.equal(feed(a,0,6000).phase,'paused');
  a.observe({valid:false},6100);assert.equal(feed(a,6200,10000).phase,'paused');
  a.arm();assert.equal(feed(a,10100,13100).phase,'start');
  a.setEnabled(false);assert.equal(feed(a,13200,18000).phase,'paused');
  a.setEnabled(true);assert.equal(feed(a,18100,21100).phase,'start');
});
