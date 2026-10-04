import {parseState,FIRMWARE} from '../viewer/protocol.mjs';
import {CAPABILITY,SPEED_CAPABILITY,RESPONSIVE_CAPABILITY} from './hardware-plan.mjs?v=continuity-11';
export class SerialLink{
  constructor(onChange=()=>{},onFault=()=>{}){
    this.onChange=onChange;this.onFault=onFault;this.state=null;this.capable=false;this.firmware='';
    this.port=null;this.writer=null;this.reader=null;this.pending=null;this.epoch=0;this.lastStateAt=0;this.faulted=false;
    this.speedCapable=false;this.responsiveCapable=false;this.bodyRate=100;
  }
  fresh(){return !!this.state&&performance.now()-this.lastStateAt<750&&!this.faulted;}
  async connect(){
    if(this.port)throw Error('이미 연결되어 있습니다.');
    if(!navigator.serial)throw Error('USB 연결은 데스크톱 Chrome 또는 Edge에서 여십시오.');
    this.faulted=false;this.state=null;this.capable=false;this.firmware='';this.speedCapable=false;this.responsiveCapable=false;this.bodyRate=100;const epoch=++this.epoch;
    const port=await navigator.serial.requestPort();this.port=port;
    try{
      await port.open({baudRate:115200});this.writer=port.writable.getWriter();this.readTask=this.readLoop(epoch);
      await new Promise(r=>setTimeout(r,2100));
      if(epoch!==this.epoch)return;
      await this.command('STOP',line=>line.startsWith('OFF '));
      await this.command('HELLO',line=>line.startsWith('HELLO '));
      await this.command('INIT',line=>line==='READY '+FIRMWARE);
      // INIT status follows its READY line.
      await this.waitState(s=>s.ready&&s.outputKnown&&s.mask===0,1200);
      if(this.firmware!==FIRMWARE||!this.capable)throw Error('새 ArmBench.ino를 업로드하십시오. BODY_STREAM_V1 기능이 필요합니다.');
      await this.configureBodySpeed();
      this.onChange();
    }catch(error){await this.close();throw error;}
  }
  async configureBodySpeed(){
    this.bodyRate=100;
    if(!this.speedCapable&&!this.responsiveCapable)return;
    if(!this.fresh()||this.state.mask!==0)throw Error('추종 속도 설정에는 출력 OFF가 필요합니다.');
    const rate=this.responsiveCapable?1200:1000;
    await this.command('SPEED '+rate,line=>line==='OK SPEED '+rate);
    this.bodyRate=rate;
  }
  async readLoop(epoch){
    const reader=this.port.readable.getReader();this.reader=reader;
    const decoder=new TextDecoder();let buffer='';
    try{
      while(epoch===this.epoch){
        const {value,done}=await reader.read();if(done)break;
        buffer+=decoder.decode(value,{stream:true});
        if(buffer.length>10000)throw Error('시리얼 프레임이 너무 깁니다.');
        let newline;
        while((newline=buffer.indexOf('\n'))>=0){
          const line=buffer.slice(0,newline).trim();buffer=buffer.slice(newline+1);
          const state=parseState(line);
          if(state){this.state=state;this.lastStateAt=performance.now();}
          if(line===CAPABILITY)this.capable=true;
          if(line===SPEED_CAPABILITY)this.speedCapable=true;
          if(line===RESPONSIVE_CAPABILITY)this.responsiveCapable=true;
          if(line.startsWith('HELLO '))this.firmware=line.slice(6);
          const hardwareFault=/^(ERR|FAULT)\b/.test(line)||line==='OFF TIMEOUT'||line==='FROZEN STREAM_TIMEOUT';
          if(hardwareFault)this.fail(Error(line));
          else if(this.pending?.accept(line)){const p=this.pending;this.pending=null;clearTimeout(p.timer);p.resolve(line);}
          this.onChange();
        }
      }
      if(epoch===this.epoch)this.fail(Error('USB 연결이 끝났습니다.'));
    }catch(error){if(epoch===this.epoch)this.fail(error);}
    finally{reader.releaseLock();if(this.reader===reader)this.reader=null;}
  }
  fail(error){
    if(this.pending){clearTimeout(this.pending.timer);this.pending.reject(error);this.pending=null;}
    if(this.faulted)return;
    this.faulted=true;this.onFault(error);this.onChange();
  }
  command(text,accept=line=>line==='OK '+text.split(' ')[0]){
    if(!this.writer||this.faulted)return Promise.reject(Error('USB 상태를 확인하십시오.'));
    if(this.pending)return Promise.reject(Error('이전 명령 응답을 기다리는 중입니다.'));
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{if(this.pending?.timer===timer)this.fail(Error('명령 응답 시간 초과: '+text.split(' ')[0]));},900);
      this.pending={resolve,reject,accept,timer};
      this.writer.write(new TextEncoder().encode(text+'\n')).catch(error=>this.fail(error));
    });
  }
  async waitState(predicate,timeout=1000){
    const deadline=performance.now()+timeout;
    while(performance.now()<deadline){if(this.fresh()&&predicate(this.state))return this.state;await new Promise(r=>setTimeout(r,20));}
    throw Error('장치 상태 확인 시간 초과');
  }
  async emergency(){
    if(!this.writer)return;
    if(this.pending){clearTimeout(this.pending.timer);this.pending.reject(Error('PWM OFF 요청으로 명령 취소'));this.pending=null;}
    // No command queue: only a bounded in-flight command precedes this byte.
    try{await this.writer.write(new TextEncoder().encode('!\n'));}catch{}
  }
  async close(){
    await this.emergency();++this.epoch;
    if(this.pending){clearTimeout(this.pending.timer);this.pending.reject(Error('USB 연결 해제'));this.pending=null;}
    try{await this.reader?.cancel();await this.readTask;}catch{}
    try{this.writer?.releaseLock();}catch{}this.writer=null;
    try{await this.port?.close();}catch{}this.port=null;this.state=null;this.capable=false;this.speedCapable=false;this.responsiveCapable=false;this.bodyRate=100;this.onChange();
  }
}
