import {makeBaseline,TRACKING_GRACE_MS} from './motion.mjs?v=continuity-11';

// Virtual preview only. Explicit pause latches; tracking loss alone may recover.
export class AutoFollow {
  constructor(){this.enabled=true;this.suspended=false;this.clear();}
  clear(){this.samples=[];this.started=null;this.lastTime=null;this.missing=false;}
  arm(){this.suspended=false;this.clear();}
  pause(){this.suspended=true;this.clear();}
  setEnabled(enabled){this.enabled=enabled;this.arm();}
  observe(f,time,{baseline=null,moving=false}={}){
    if(!this.enabled||this.suspended){this.clear();return {phase:'paused'};}
    if(moving){this.clear();return {phase:'following'};}
    if(!f?.valid){
      if(this.lastTime!==null&&time-this.lastTime<TRACKING_GRACE_MS){this.missing=true;return {phase:'holding',reason:f?.reason};}
      this.clear();return {phase:'waiting',reason:f?.reason};
    }
    if(!baseline&&!f.ready){this.clear();return {phase:'position',reason:f.readinessReason};}
    if(this.lastTime!==null&&(time<=this.lastTime||time-this.lastTime>=TRACKING_GRACE_MS))this.clear();
    else if(this.lastTime!==null&&(this.missing||time-this.lastTime>=350))this.started+=time-this.lastTime;
    this.missing=false;
    if(this.started===null)this.started=time;
    this.lastTime=time;this.samples.push(f);
    const duration=baseline?600:3000,elapsed=time-this.started,minSamples=baseline?5:20;
    if(elapsed<duration||this.samples.length<minSamples)
      return {phase:'countdown',seconds:Math.max(1,Math.ceil((duration-elapsed)/1000)),recovering:!!baseline};
    try{
      const found=makeBaseline(this.samples,{requireReady:!baseline,minSamples});
      this.clear();
      return {phase:'start',baseline:baseline??found,recovering:!!baseline};
    }catch(error){
      this.clear();
      return {phase:'unstable',reason:error.message};
    }
  }
}
