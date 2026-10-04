import {SerialLink} from './serial-link.mjs?v=continuity-11';
import {STORAGE_KEY,validateProfile} from '../viewer/calibration.mjs';
import {holdCommand} from '../viewer/protocol.mjs';
import {ROLES,defaultMapping,validateMapping,checkSetup,absoluteTarget,guardedStep,moveCommand,poseFromPulses,planRemap} from './hardware-plan.mjs?v=continuity-11';
import {DEFAULT_GEOMETRY,BASIC_HARDWARE_GEOMETRY,MINIMAL_HARDWARE_CLEARANCE,validateGeometry,collisionExplanation} from './collision.mjs?v=basic-preset-6';
import {FollowReadiness,inputWaitReason} from './follow-readiness.mjs?v=continuity-11';
import {TRACKING_GRACE_MS} from './motion.mjs?v=continuity-11';

export function createHardware(getInput,{
  createLink=(onChange,onFault)=>new SerialLink(onChange,onFault),
  now=()=>performance.now(),every=(fn,ms)=>setInterval(fn,ms)
}={}){
  const $=id=>document.getElementById(id),note=text=>$('hw-message').textContent=text;
  let profile=null,busy=false,follow=false,anchor=null,syncing=false;
  const readiness=new FollowReadiness();
  let followDetail='',moveAckCount=0,lastMoveAck=null,bodyGoal=null,limited=[];
  const maxStep=()=>link.bodyRate>=1000?link.bodyRate/10:8;
  let lossSince=null,needFreeze=false,lastPing=0,lastSend=0,epoch=0;
  const link=createLink(render,error=>{
    follow=false;anchor=null;bodyGoal=null;readiness.reset();needFreeze=false;epoch++;
    followDetail='연결 오류로 추종을 해제했습니다: '+error.message;
    note('실물 연결 중지: '+error.message+' · 상태 확인 전에는 전원과 팔을 직접 확인하십시오.');
    if(error.message!=='FROZEN STREAM_TIMEOUT')link.emergency();
  });
  const rows=defaultMapping();
  $('hw-mapping').innerHTML=rows.map((r,i)=>'<tr><td>'+ROLES[i]+'</td><td><select data-hw="ch" data-role="'+i+'">'+rows.map((_,ch)=>'<option value="'+ch+'"'+(ch===r.ch?' selected':'')+'>CH'+ch+'</option>').join('')+'</select></td><td><select data-hw="sign" data-role="'+i+'"><option value="1">+</option><option value="-1">−</option></select></td><td><input data-hw="scale" data-role="'+i+'" type="number" min="2" max="25" step=".001" value="'+r.usPerDegree+'"></td><td><input data-hw="gain" data-role="'+i+'" type="number" min=".1" max="1" step=".1" value="'+r.gain+'"></td><td><input data-hw="span" data-role="'+i+'" type="number" min="20" max="1000" step="10" value="'+r.span+'"></td></tr>').join('');
  function mapping(){
    return validateMapping(rows.map((r,i)=>{
      const val=k=>Number(document.querySelector('[data-hw="'+k+'"][data-role="'+i+'"]').value);
      return {ch:val('ch'),sign:val('sign'),usPerDegree:val('scale'),gain:val('gain'),span:val('span')};
    }));
  }
  function geometry(){
    const value=id=>Number($(id).value);
    for(const [id,label,min,max] of [
      ['hw-l1','어깨→팔꿈치',30,600],['hw-l2','팔꿈치→손목',30,600],['hw-l3','손목→도구 부착점',30,600],
      ['hw-tool','추가 도구 길이',0,250],['hw-base-height','어깨 축 높이',30,300],['hw-base-radius','베이스 반경',20,250]
    ]){
      if(!String($(id).value).trim()||!Number.isFinite(value(id))||value(id)<min||value(id)>max)
        throw Error(label+': '+min+'~'+max+'mm로 입력하십시오. 현재 '+($(id).value||'빈칸')+' · 단위는 cm가 아닌 mm입니다.');
    }
    return validateGeometry({...DEFAULT_GEOMETRY,
      lengths:['hw-l1','hw-l2','hw-l3'].map(id=>value(id)/1000),
      tool:value('hw-tool')/1000,baseHeight:value('hw-base-height')/1000,baseRadius:value('hw-base-radius')/1000,
      ...MINIMAL_HARDWARE_CLEARANCE,
      zeroAngles:['hw-a1','hw-a2','hw-a3'].map(value)});
  }
  function showFixedClearance(){
    $('hw-radius').value=String(MINIMAL_HARDWARE_CLEARANCE.radius*1000);$('hw-radius').readOnly=true;
    $('hw-margin').value=String(MINIMAL_HARDWARE_CLEARANCE.margin*1000);$('hw-margin').readOnly=true;
  }
  function applyBasicGeometry(){
    const g=BASIC_HARDWARE_GEOMETRY;
    ['hw-l1','hw-l2','hw-l3'].forEach((id,i)=>$(id).value=String(g.lengths[i]*1000));
    ['hw-a1','hw-a2','hw-a3'].forEach((id,i)=>$(id).value=String(g.zeroAngles[i]));
    for(const [id,key] of [['hw-tool','tool'],['hw-base-height','baseHeight'],['hw-base-radius','baseRadius']])$(id).value=String(g[key]*1000);
    showFixedClearance();
  }
  applyBasicGeometry();
  function configured(){
    if(!profile)throw Error('실물 원점 파일을 불러오십시오.');
    const setup=checkSetup(profile,mapping(),link.state),g=geometry();
    const collision=collisionExplanation(poseFromPulses(setup.zero,profile,setup.mapping,g),g);
    if(collision)throw Error('설정한 원점 모델의 충돌: '+collision);
    return {...setup,geometry:g};
  }
  function armBlockReason(){
    if(busy)return '진행 중인 처리가 끝나기를 기다립니다.';
    if(!link.writer)return 'Uno USB 연결이 필요합니다.';
    if(link.faulted)return '연결 오류가 발생했습니다. 위 오류 안내를 확인하십시오.';
    if(!link.fresh())return '최신 장치 상태 응답을 기다립니다.';
    if(!link.capable)return 'BODY_STREAM_V1 펌웨어 기능 확인이 필요합니다.';
    if(!link.state?.ready)return 'PCA 보드 초기화 확인이 필요합니다.';
    if(!link.state.outputKnown)return '장치 출력 상태를 확인할 수 없습니다.';
    if(link.state.mask)return link.state.mask===31?'CH0~4 PWM이 이미 켜져 있습니다.':'일부 PWM이 켜져 있어 재활성화할 수 없습니다.';
    try{configured();}catch(error){return error.message;}
    if(!$('hw-supported').checked)return '버튼 위의 팔 받침·원점 근처 확인이 필요합니다.';
    return '';
  }
  function render(){
    const active=!!link.state?.mask,connected=!!link.writer,healthy=link.fresh()&&link.capable&&link.state?.ready&&link.state.outputKnown;
    $('hw-status').textContent=link.faulted?'연결 오류':busy?'처리 중':!connected?'실물 미연결':!healthy?'장치 확인 중':follow?anchor?(syncing?'첫 자세 맞추는 중':'실물 절대 추종 중'):'실물 자세 대기':active?'실물 PWM 유지':'준비 · 출력 OFF';
    $('hw-connect').disabled=connected||busy||!$('hw-power-off').checked;
    $('hw-disconnect').disabled=!connected||busy;
    const armReason=armBlockReason();
    $('hw-arm').disabled=!!armReason;
    $('hw-arm').title=armReason||'저장 원점으로 CH0~4 PWM을 켭니다.';
    $('hw-arm-reason').textContent=armReason?'원점 PWM: '+armReason:'원점 PWM을 켤 수 있습니다.';
    $('hw-arm-reason').dataset.blocked=String(!!armReason&&!active);
    $('hw-follow').disabled=!healthy||link.state.mask!==31||busy||follow||!$('hw-direction-checked').checked;
    $('hw-freeze').disabled=!active||busy;$('hw-stop').disabled=!connected;
    $('hw-park').disabled=$('hw-park-off').disabled=!healthy||link.state.mask!==31||busy;
    $('hw-remap').disabled=!healthy||active||busy||!profile||!$('hw-power-off').checked;
    $('hw-profile-file').disabled=active||busy;$('hw-load-browser').disabled=active||busy;
    $('hw-import-config').disabled=active||busy;$('hw-export-config').disabled=!profile;
    $('hw-reference').disabled=active||busy;
    document.querySelectorAll('[data-hw],.hw-geometry input').forEach(el=>el.disabled=active||busy);
    $('hw-jog-plus').disabled=$('hw-jog-minus').disabled=$('hw-jog-zero').disabled=!healthy||link.state.mask!==31||busy||follow;
    $('hw-jog-channel').disabled=active&&follow;
    $('hw-profile-summary').textContent=profile?'원점 '+profile.channels.slice(0,5).map((c,i)=>'CH'+i+' '+c.zeroUs).join(' / ')+' µs · PCA ['+profile.pcaChannels.join(', ')+']':'실물 원점 기록을 기다립니다.';
    $('hw-telemetry').textContent=link.state?'CH0 → CH5 · 단위 µs\n출력 ['+link.state.applied.join(', ')+']\n목표 ['+link.state.target.join(', ')+']\n실제 각도 센서값 아님':'USB 연결 전 · 실물에는 명령을 보내지 않습니다.';
    $('hw-body-goal').textContent=follow&&anchor&&bodyGoal?
      '시뮬 절대 자세 목표 ['+bodyGoal.join(', ')+'] µs\n'+(limited.length?'범위 제한: '+limited.join(', ')+' · 이 관절은 시뮬 각도에 도달하지 못합니다.':'저장한 수직 원점 기준 · 위 목표는 속도 제한을 거치는 다음 단계입니다.'):
      '첫 인식 자세부터 시뮬레이션과 같은 관절각을 목표로 합니다. 손목 회전 고정 · 그리퍼 OFF';
    $('hw-speed-status').textContent=!connected?'절대 조종 · 새 ArmBench 업로드 후 최대 1,200µs/초 · 도착 응답 즉시 전송':
      link.bodyRate>=1000?'속도 설정 확인: 최대 '+link.bodyRate.toLocaleString('en-US')+'µs/초 · '+(link.bodyRate===1200?'이전보다 20% 증가 · 도착 응답 개선':'1,200µs/초와 응답 개선은 새 ArmBench 업로드 필요'):
      '현재 펌웨어: 최대 100µs/초 · 속도를 높이려면 새 ArmBench.ino를 업로드하고 USB를 다시 연결하십시오.';
    $('hw-follow-detail').textContent=!connected?'실물 추종: USB 연결 전':link.faulted?followDetail:!active?'실물 추종: 출력 OFF':
      follow?(anchor?'실물 추종 중 · ':'실물 추종 대기 · ')+followDetail:
      '실물 추종 해제 · '+(followDetail||'실물 추종 대기를 눌러 시작하십시오.');
    $('hw-live').dataset.state=link.faulted?'fault':follow?(anchor?'following':'waiting'):'idle';
    $('hw-command-status').textContent='이번 추종의 이동 명령 수신 확인 '+moveAckCount+'회'+
      (lastMoveAck===null?' · 아직 이동 명령을 보내지 않았습니다.':' · 마지막 확인 '+Math.max(0,(now()-lastMoveAck)/1000).toFixed(1)+'초 전')+
      ' · 수신 확인은 실제 모터 움직임의 측정값이 아닙니다.';
    $('hardware-badge').textContent=connected&&(!link.state?.outputKnown||link.faulted)?'HARDWARE · 출력 확인 필요':active?'HARDWARE · PWM ON':'VIRTUAL / 실물 출력 OFF';
  }
  async function action(fn){
    if(busy)return;busy=true;render();
    try{await fn();}catch(error){
      if(link.state?.mask&&link.fresh()&&!link.pending){try{await link.command('FREEZE',line=>line==='FROZEN USER');}catch{}}
      note(error.message);
    }finally{busy=false;render();}
  }
  function freeze(reason,{keepWaiting=false}={}){
    epoch++;follow=keepWaiting&&follow;anchor=null;bodyGoal=null;lossSince=null;readiness.reset();followDetail=reason||'추종을 멈췄습니다.';
    if(link.state?.mask===31&&!link.faulted)needFreeze=true;
    if(reason&&link.writer)note(reason);render();
  }
  function importProfile(raw){
    const p=validateProfile(raw.zeroProfile??raw);
    if(p.source!=='hardware'||p.channels.slice(0,5).some(c=>!c.recorded))throw Error('CH0~4 원점이 있는 실물 기록이 필요합니다.');
    profile=p;note('실물 원점을 불러왔습니다. 그리퍼 CH5는 출력하지 않습니다.');render();
  }
  $('hw-reference').onclick=()=>{
    if(link.state?.mask||busy)return;
    applyBasicGeometry();
    defaultMapping().forEach((r,i)=>Object.entries({ch:r.ch,sign:r.sign,scale:r.usPerDegree,gain:r.gain,span:r.span})
      .forEach(([k,v])=>document.querySelector('[data-hw="'+k+'"][data-role="'+i+'"]').value=String(v)));
    $('hw-direction-checked').checked=false;
    note('임시 기본값을 넣었습니다. 링크 105·100·70mm, 스쿱 없음, 최소 충돌 검사. 저장 PWM 원점은 그대로입니다.');render();
  };
  $('hw-profile-file').onchange=()=>action(async()=>{
    const file=$('hw-profile-file').files[0];if(file)importProfile(JSON.parse(await file.text()));
  });
  $('hw-load-browser').onclick=()=>action(async()=>{
    const saved=localStorage.getItem(STORAGE_KEY);if(!saved)throw Error('이 브라우저에 저장된 원점이 없습니다. 다운로드한 파일을 선택하십시오.');
    importProfile(JSON.parse(saved));
  });
  $('hw-connect').onclick=()=>action(async()=>{
    note('Uno 재시작 중입니다. 서보 PSU는 끈 상태를 유지하십시오.');await link.connect();
    if(!link.fresh()||link.state.mask!==0)throw Error('명령 범위 설정에는 출력 OFF가 필요합니다.');
    for(let ch=0;ch<5;ch++){
      await link.command('LIMIT '+ch+' 500 2500');
      await link.waitState(s=>s.mask===0&&s.lower[ch]===500&&s.upper[ch]===2500);
    }
    followDetail='';moveAckCount=0;lastMoveAck=null;
    note('절대 조종 준비 · CH0~4 명령 범위 500~2500µs · 출력 OFF. 원점 PWM부터 켤 수 있습니다.');
  });
  $('hw-disconnect').onclick=()=>action(async()=>{follow=false;needFreeze=false;epoch++;await link.close();note('연결을 해제했습니다. 출력 해제 시 팔을 받치십시오.');});
  $('hw-remap').onclick=()=>action(async()=>{
    if(!profile||link.state.mask||!$('hw-power-off').checked)throw Error('PSU OFF와 전체 출력 OFF가 필요합니다.');
    for(const command of planRemap(link.state.map,profile.pcaChannels)){
      const [,ch,port]=command.split(' ').map((v,i)=>i?Number(v):v);
      await link.command(command);await link.waitState(s=>s.map[ch]===port);
    }
    note('원점 파일의 PCA 포트 매핑과 일치시켰습니다.');
  });
  $('hw-arm').onclick=()=>action(async()=>{
    const cfg=configured();
    if(!$('hw-supported').checked)throw Error('팔을 받친 상태를 확인하십시오.');
    const cmd=holdCommand(31,link.state,true,cfg.zero);
    await link.command(cmd,line=>line==='OK ARM');
    await link.waitState(s=>s.mask===31&&s.target.slice(0,5).every((v,i)=>v===cfg.zero[i]));
    note('CH0~4 원점 PWM을 켰습니다. 원점이 위로 편 자세인지 확인하고 ±20µs로 방향을 시험하십시오.');
  });
  $('hw-follow').onclick=()=>action(async()=>{
    configured();
    if(!$('hw-direction-checked').checked)throw Error('관절 역할과 +방향을 확인하십시오.');
    if(getInput().mode!=='camera')throw Error('실물 추종에는 실제 카메라를 켜십시오. 합성 입력은 전송하지 않습니다.');
    await link.command('FREEZE',line=>line==='FROZEN USER');follow=true;anchor=null;lossSince=null;readiness.reset();needFreeze=false;
    moveAckCount=0;lastMoveAck=null;bodyGoal=null;limited=[];syncing=true;followDetail='카메라에서 자세를 확인하고 있습니다.';
    note('절대 조종 대기: 자세를 1.8초 유지하면 첫 시뮬 자세로 이동합니다. 저장한 수직 원점을 기준으로 따라갑니다.');
  });
  $('hw-freeze').onclick=()=>freeze('실물 목표 이동을 멈추고 현재 PWM을 유지합니다. 다시 실물 추종 대기로 시작하십시오.');
  $('hw-stop').onclick=async()=>{follow=false;needFreeze=false;epoch++;followDetail='PWM OFF 요청';await link.emergency();note('PWM OFF를 요청했습니다. 팔을 받치십시오. 버스 오류 시 전원 차단이 필요합니다.');};
  async function moveTo(desired){
    const cfg=mapping(),deadline=now()+45000;
    const token=++epoch;follow=false;followDetail='단독 시험 또는 원점 복귀 중입니다. 끝난 뒤 실물 추종 대기로 다시 시작하십시오.';
    while(link.fresh()&&token===epoch){
      if(now()>deadline)throw Error('복귀 시간 초과 · 위치를 확인하십시오.');
      if(now()-lastPing>300){await link.command('PING',line=>line==='PONG');lastPing=now();}
      if(link.state.applied.slice(0,5).some((v,ch)=>v!==link.state.target[ch])){await new Promise(r=>setTimeout(r,25));continue;}
      if(link.state.applied.slice(0,5).every((v,ch)=>v===desired[ch]))break;
      const step=guardedStep(desired,link.state,profile,cfg,geometry(),maxStep());
      if(!step.safe)throw Error('충돌 검사 차단: '+step.reason);
      await link.command(moveCommand(step.pulses));
      await new Promise(r=>setTimeout(r,20));
    }
    if(token===epoch&&!link.fresh())throw Error('상태 응답 지연');
    if(token===epoch)await link.command('FREEZE',line=>line==='FROZEN USER');
    return token===epoch;
  }
  async function jog(delta){
    configured();const ch=Number($('hw-jog-channel').value),desired=[...link.state.applied];
    const zero=profile.channels[ch].zeroUs;desired[ch]=delta===null?zero:desired[ch]+delta;
    const row=mapping().find(r=>r.ch===ch);
    if(desired[ch]<Math.max(link.state.lower[ch],zero-row.span)||desired[ch]>Math.min(link.state.upper[ch],zero+row.span))throw Error('시험 범위 밖입니다.');
    await moveTo(desired);
    note('단독 시험 종료 · CH'+ch+' 명령 '+link.state?.applied[ch]+'µs');
  }
  async function park(off){
    const cfg=configured();note('저장 원점으로 천천히 복귀 중입니다. 충돌 경계가 있으면 복귀도 중단합니다.');
    if(!await moveTo(cfg.zero))return;
    if(off){await link.command('STOP',line=>line.startsWith('OFF '));note('원점 명령에 도달한 뒤 PWM을 껐습니다. 팔을 받치고 전원을 끄십시오. 실제 위치는 측정하지 않습니다.');}
    else note('저장 원점에서 대기합니다. 정상 종료는 원점 복귀 후 OFF를 사용하십시오.');
  }
  $('hw-park').onclick=()=>action(()=>park(false));
  $('hw-park-off').onclick=()=>action(()=>park(true));
  $('hw-jog-minus').onclick=()=>action(()=>jog(-20));
  $('hw-jog-plus').onclick=()=>action(()=>jog(20));
  $('hw-jog-zero').onclick=()=>action(()=>jog(null));
  function download(data,name){
    const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'})),a=document.createElement('a');
    a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  $('hw-export-config').onclick=()=>action(async()=>download({schema:'rot3u-body-v1',zeroProfile:profile,mapping:mapping(),geometry:geometry()},'rot3u-body-settings.json'));
  $('hw-import-config').onchange=()=>action(async()=>{
    const file=$('hw-import-config').files[0];if(!file)return;
    const data=JSON.parse(await file.text());
    if(data.schema!=='rot3u-body-v1')throw Error('실물 추종 설정 형식이 아닙니다.');
    const m=validateMapping(data.mapping),g=validateGeometry({...data.geometry,...MINIMAL_HARDWARE_CLEARANCE});importProfile(data.zeroProfile);
    m.forEach((r,i)=>Object.entries({ch:r.ch,sign:r.sign,scale:r.usPerDegree,gain:r.gain,span:r.span}).forEach(([k,v])=>document.querySelector('[data-hw="'+k+'"][data-role="'+i+'"]').value=v));
    ['hw-l1','hw-l2','hw-l3'].forEach((id,i)=>$(id).value=g.lengths[i]*1000);
    ['hw-a1','hw-a2','hw-a3'].forEach((id,i)=>$(id).value=g.zeroAngles[i]);
    for(const [id,key] of [['hw-tool','tool'],['hw-base-height','baseHeight'],['hw-base-radius','baseRadius'],['hw-radius','radius'],['hw-margin','margin']])$(id).value=g[key]*1000;
    showFixedClearance();
    $('hw-direction-checked').checked=false;
    note('설정을 불러왔습니다. 충돌 반경 10mm·여유 10mm는 고정 적용됩니다.');
  });
  document.querySelectorAll('[data-hw],.hw-geometry input').forEach(el=>el.addEventListener('input',()=>{$('hw-direction-checked').checked=false;}));
  for(const id of ['hw-power-off','hw-supported','hw-direction-checked'])$(id).addEventListener('change',render);
  async function pump(){
    if(!link.writer||busy||link.pending||link.faulted)return;
    if(!link.fresh()){link.fail(Error('상태 응답이 오래되었습니다.'));return;}
    if(needFreeze){
      needFreeze=false;await link.command('FREEZE',line=>line==='FROZEN USER');return;
    }
    if(now()-lastPing>=300){await link.command('PING',line=>line==='PONG');lastPing=now();}
    if(!follow)return;
    if(link.state.mask!==31){freeze('출력이 꺼져 실물 추종을 해제했습니다.');return;}
    const input=getInput(),time=now(),waitReason=inputWaitReason(input,document.hidden);
    if(waitReason){
      if(anchor&&!document.hidden&&input.mode==='camera'&&input.moving&&!input.valid){
        // Freeze output immediately, retaining the absolute mapping during a short gap.
        if(lossSince===null){lossSince=time;await link.command('FREEZE',line=>line==='FROZEN USER');}
        if(time-lossSince<TRACKING_GRACE_MS)followDetail='잠깐 인식 대기 · 재시작 대기 없이 이어갑니다. '+waitReason;
        else freeze(waitReason,{keepWaiting:true});
      }else if(anchor)freeze(waitReason,{keepWaiting:true});
      else followDetail=readiness.observe(input,time,document.hidden).message;
      return;
    }
    lossSince=null;
    // Visibility changes use the same smoothed absolute angles, not a new anchor.
    if(!anchor){
      const ready=readiness.observe(input,time,document.hidden);followDetail=ready.message;
      if(!ready.ready)return;
      if(link.state.applied.slice(0,5).some((v,ch)=>v!==link.state.target[ch])){followDetail='직전 출력 명령이 멈추기를 기다립니다.';return;}
      anchor=true;syncing=true;
      note('첫 시뮬 자세로 이동합니다. 저장한 수직 원점 기준 절대 조종 · 손목 회전 고정 / 그리퍼 OFF');
    }
    const goal=absoluteTarget(input.pose,profile,mapping(),link.state,geometry()),desired=goal.pulses;
    bodyGoal=desired;limited=goal.limited;
    if(syncing&&desired.slice(0,5).every((v,ch)=>Math.abs(v-link.state.applied[ch])<=2))syncing=false;
    if(link.state.applied.slice(0,5).some((v,ch)=>v!==link.state.target[ch])){followDetail=(syncing?'첫 시뮬 자세로 맞추는 중 · ':'')+'속도 제한에 따라 목표까지 출력 중입니다.';return;}
    if(time-lastSend<20)return;
    const step=guardedStep(desired,link.state,profile,mapping(),geometry(),maxStep());
    if(!step.safe){freeze('실물 충돌 검사 차단: '+step.reason+' · 설정과 자세를 확인한 뒤 다시 시작하십시오.');return;}
    followDetail=step.pulses.slice(0,5).some((v,ch)=>v!==link.state.applied[ch])?(syncing?'첫 시뮬 자세로 맞추는 중':'시뮬 관절각을 절대 목표로 전송 중'):
      '시뮬 절대 목표 유지 · 저장 원점 기준으로 같은 관절각을 명령합니다.';
    if(limited.length)followDetail+=' · 범위 제한: '+limited.join(', ');
    const token=epoch;lastSend=time;await link.command(moveCommand(step.pulses));
    if(token===epoch&&follow){moveAckCount++;lastMoveAck=now();}
  }
  every(()=>pump().catch(error=>{freeze(error.message);if(!link.fresh())link.fail(error);}),10);
  every(render,150);
  window.addEventListener('pagehide',()=>{follow=false;link.emergency();});
  fetch('./local-zero.json').then(r=>r.ok?r.json():null).then(data=>{
    if(data&&!profile)importProfile(data);
    else if(!profile){const saved=localStorage.getItem(STORAGE_KEY);if(saved)importProfile(JSON.parse(saved));}
  }).catch(()=>{try{const saved=localStorage.getItem(STORAGE_KEY);if(saved&&!profile)importProfile(JSON.parse(saved));}catch{}});
  render();
  return {pause:reason=>freeze(reason),interrupt:reason=>freeze(reason,{keepWaiting:true}),active:()=>!!link.state?.mask};
}
