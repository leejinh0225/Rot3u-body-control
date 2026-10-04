import {NAMES, MIN, MAX, CENTER, DEFAULT_MIN, DEFAULT_MAX, FIRMWARE, parseState, armCommand, holdCommand, setCommand, mapCommand, limitCommand, withinLimits, isActive, activeChannels, idleState} from './protocol.mjs';
import {degreesToUs, usToDegrees, nominalTicks, nominalPulseUs, secondsToTarget} from './units.mjs';
import {connectionIssue} from './diagnostics.mjs';
import {STORAGE_KEY, emptyProfile, validateProfile, recordZero, zeroPose} from './calibration.mjs';

const $ = id => document.getElementById(id);
let selected = 5, state = null, mode = 'off', handshake = false, busy = false;
let port = null, reader = null, writer = null, readTask = null;
let session = 0, lastStateAt = 0, tripped = false, stopping = false;
let log = [], pendingAt = 0, demoTickAt = performance.now();
let firmware = '', receivedBytes = 0, deviceFault = '', readEnded = false, hiddenTrip = false, lastProbeAt = 0;
const encoder = new TextEncoder();
let profile = emptyProfile(), hardwareProfile = profile;
try { const saved = localStorage.getItem(STORAGE_KEY); if (saved) { const p=validateProfile(JSON.parse(saved)); if(p.source!=='hardware') throw Error('demo'); profile = hardwareProfile = p; } }
catch { note('저장된 원점 기록을 읽지 못했습니다. 원점 파일을 다시 불러오십시오.',true); }

function note(text, error = false) { $('message').textContent = text; $('message').classList.toggle('error', error); }
function record(text) {
  log.push(`${new Date().toLocaleTimeString('ko-KR', {hour12:false})} ${text}`);
  if (log.length > 500) log.shift();
  $('log').textContent = log.slice(-100).join('\n'); $('log').scrollTop = $('log').scrollHeight;
}
function fresh() { return mode === 'demo' || (mode === 'serial' && performance.now() - lastStateAt < 1100); }
function usable() { return handshake && state?.ready && state.outputKnown && fresh() && !tripped && !busy && !stopping; }
function reportIssue() {
  const issue = connectionIssue({firmware, receivedBytes, state, fault:deviceFault,
    stale:!fresh(), hidden:hiddenTrip, readEnded});
  if (issue) note(`${issue.title} — ${issue.detail}`, true);
}
function render() {
  const canUse = usable(), mask = state?.mask ?? 0, on = isActive(state,selected), channels = activeChannels(state);
  $('badge').textContent = mode === 'demo' ? '화면 연습 · 실물 연결 없음' : mode === 'off' ? '연결 안 됨' :
    tripped ? '연결 진단을 확인하십시오' : !handshake ? '업로드된 스케치 확인 중' :
    !state?.ready ? 'PCA9685 확인 필요' : mask ? `${channels.length}개 관절 유지 중` : '준비 · 출력 꺼짐';
  $('badge').className = `badge ${mode === 'demo' ? 'demo' : canUse ? 'live' : ''}`;
  $('connect').disabled = mode !== 'off'; $('disconnect').disabled = mode === 'off';
  $('demo').disabled = mode !== 'off'; $('retry').disabled = mode !== 'serial' || busy || !writer || readEnded;
  $('diagnosis').textContent = mode === 'demo' ? '화면 연습 · 실제 USB 통신 없음' : mode === 'off' ?
    '먼저 ArmBench.ino를 Uno에 업로드하십시오. USB 연결 버튼은 코드를 자동 업로드하지 않습니다.' :
    `USB 포트: ${writer ? '열림' : '선택·연결 중'} · Uno 수신: ${receivedBytes} bytes · 스케치: ${firmware === FIRMWARE ? 'v4 범위·명령각 확인' : firmware || '미확인'} · PCA: ${state ? state.ready ? '0x40 준비' : '확인 필요' : '미확인'}`;
  $('active-count').textContent = String(channels.length).padStart(2,'0');
  $('selected-title').textContent = `CH${selected} · ${NAMES[selected]} → PCA ${state?.map[selected] ?? '?'}`;
  $('output-state').textContent = mode === 'serial' && (!fresh() || !state?.outputKnown) ? '출력 상태 확인 불가' : on ? 'PWM 출력 중' : '출력 꺼짐';
  $('applied').textContent = on && fresh() ? state.applied[selected] : '—';
  const lo=state?.lower[selected] ?? DEFAULT_MIN, hi=state?.upper[selected] ?? DEFAULT_MAX;
  $('target-label').textContent = on && fresh() ? `목표 ${state.target[selected]}µs (${usToDegrees(state.target[selected]).toFixed(1)}°) · 출력 명령 도달까지 약 ${secondsToTarget(state.applied[selected],state.target[selected]).toFixed(1)}초` : '1500µs = 명령각 90° · 실제 관절의 0°가 아닙니다.';
  $('angle-readout').textContent = on && fresh() ? `명령각 ${usToDegrees(state.applied[selected]).toFixed(1)}° · PCA ${nominalTicks(state.applied[selected])}카운트 ≈ ${nominalPulseUs(state.applied[selected]).toFixed(1)}µs (명목값)` : '명령각 환산: 0° = 500µs, 90° = 1500µs, 180° = 2500µs';
  $('scale-min').textContent=lo; $('scale-max').textContent=`${hi} µs`;
  $('joint-limits').textContent=`CH${selected} 현재 한계 ${lo}–${hi}µs · 명령각 ${usToDegrees(lo).toFixed(1)}–${usToDegrees(hi).toFixed(1)}°`;
  $('pulse').min=lo; $('pulse').max=hi;
  $('needle').style.left = `${on && fresh() ? (state.applied[selected] - lo) / (hi - lo) * 100 : (CENTER-lo)/(hi-lo)*100}%`;
  const canStart = canUse && !mask && $('support').checked;
  $('arm').disabled = !canStart; $('hold').disabled = !canStart;
  $('hold-mask').disabled = !!mask || busy || stopping;
  let hasPose = false;
  try { const pose=zeroPose(profile,Number($('hold-mask').value),mode === 'demo'); hasPose=activeChannels({mask:Number($('hold-mask').value)}).every(ch=>withinLimits(ch,pose[ch],state)); } catch {}
  $('hold-zero').disabled = !canStart || !hasPose;
  $('support').disabled = !!mask || busy || stopping;
  for (const id of ['minus','plus','center','pulse','apply']) $(id).disabled = !canUse || !on;
  const step=Number($('pulse-step').value);
  $('minus').textContent=`−${step} µs`; $('plus').textContent=`+${step} µs`;
  if (on) {
    $('minus').disabled ||= state.target[selected]-step < lo; $('plus').disabled ||= state.target[selected]+step > hi;
  }
  for (const [id,delta] of [['degree-minus5',-5],['degree-minus1',-1],['degree-plus1',1],['degree-plus5',5]]) {
    const degrees=on ? usToDegrees(state.target[selected])+delta : NaN;
    $(id).disabled=!canUse || !on || degrees<0 || degrees>180 || !withinLimits(selected,Math.round(500+degrees/180*2000),state);
  }
  $('degree-input').disabled=$('degree-apply').disabled=!canUse || !on;
  $('zero-minus').disabled=!canUse || !on || state.target[selected]-5<lo;
  $('zero-plus').disabled=!canUse || !on || state.target[selected]+5>hi;
  $('zero-current').textContent=on && fresh() ? `현재 ${state.applied[selected]}µs → 목표 ${state.target[selected]}µs` : '현재 명령 —';
  for (const el of document.querySelectorAll('.channel')) {
    const ch = Number(el.dataset.channel); el.classList.toggle('selected', ch === selected);
    el.classList.toggle('active', isActive(state,ch) && fresh()); el.disabled = busy || stopping;
    el.querySelector('small').textContent = `PCA ${state?.map[ch] ?? '?'} · ${isActive(state,ch) && fresh() ? state.applied[ch]+'µs 유지' : '출력 꺼짐'}`;
  }
  for (const el of document.querySelectorAll('.joint')) el.classList.toggle('selected', Number(el.dataset.joint) === selected);
  const zero = profile.channels[selected];
  $('zero-readout').textContent = zero.recorded ? `CH${selected} 원점 ${zero.zeroUs}µs · 1500 대비 ${zero.zeroUs - CENTER >= 0 ? '+' : ''}${zero.zeroUs - CENTER}µs` : `CH${selected} 원점 미기록`;
  $('zero-delta').textContent = zero.recorded && on && fresh() ? `현재 명령 − 원점 = ${state.applied[selected] - zero.zeroUs}µs` : '원점은 사용자가 정한 자세의 펄스값입니다. 각도·자세 센서 측정값이 아닙니다.';
  $('zero-record').disabled = !canUse || !on || state.applied[selected] !== state.target[selected];
  $('zero-go').disabled = !canUse || !on || !zero.recorded;
  $('zero-clear').disabled = !zero.recorded || busy;
  $('profile-import').disabled = !!mask || busy || stopping;
  $('map-current').textContent = state ? `CH${selected} → PCA ${state.map[selected]}번 · 전체 매핑 [${state.map.join(', ')}]` : '장치 연결 후 실제 포트 매핑을 표시합니다.';
  $('map-apply').disabled = !canUse || !!mask || !$('map-confirm').checked;
  $('pca-port').disabled = !canUse || !!mask;
  $('map-confirm').disabled = !!mask || busy || stopping;
  for (const id of ['limit-min','limit-max','limit-apply']) $(id).disabled=!canUse || !!mask;
  $('zero-channel').value = String(selected); $('zero-channel').disabled = busy || stopping;
  $('profile-summary').textContent = `${profile.source === 'demo' ? '연습용 · 실물 기록과 분리' : '실물 명령 기록'} · ${profile.channels.filter(c=>c.recorded).length}/6개 원점 저장`;
  for (let ch = 0; ch < 6; ch++) {
    const c = profile.channels[ch], cell = document.querySelector(`[data-zero="${ch}"]`);
    cell.textContent = c.recorded ? `${c.zeroUs}µs (${c.zeroUs - CENTER >= 0 ? '+' : ''}${c.zeroUs - CENTER})` : '미기록';
  }
}
function selectChannel(ch) {
  selected = ch; $('support').checked = false; $('pulse').value = state?.target[ch] ?? CENTER;
  $('zero-note').value = profile.channels[ch].note; $('pca-port').value = String(state?.map[ch] ?? ch); $('map-confirm').checked=false;
  $('degree-input').value=usToDegrees(state?.target[ch] ?? CENTER).toFixed(1);
  $('limit-min').value=state?.lower[ch] ?? DEFAULT_MIN; $('limit-max').value=state?.upper[ch] ?? DEFAULT_MAX; render();
}
for (let ch = 0; ch < 6; ch++) {
  const el = document.createElement('button'); el.className = 'channel'; el.dataset.channel = ch;
  el.innerHTML = `<b>CH${ch.toString().padStart(2,'0')}</b><span>${NAMES[ch]}</span><small>출력 꺼짐</small>`;
  el.onclick = () => selectChannel(ch);
  $('channels').append(el);
}
function receive(line) {
  if (!line || line === 'PONG') return;
  if (/^(HELLO|READY) ARM_BENCH_/.test(line)) {
    firmware = line.split(' ')[1]; handshake = firmware === FIRMWARE;
    if (!handshake) { tripped = true; busy = false; reportIssue(); }
  }
  const next = parseState(line);
  if (next) {
    const prior = state?.mask;
    const priorMap = state?.map.join(',');
    const priorLimits=state ? [...state.lower,...state.upper].join(',') : '';
    state = next; lastStateAt = performance.now();
    if (priorLimits !== [...next.lower,...next.upper].join(',')) { $('limit-min').value=next.lower[selected]; $('limit-max').value=next.upper[selected]; }
    if (priorMap !== next.map.join(',')) { $('pca-port').value=String(next.map[selected]); $('map-confirm').checked=false; }
    if (next.mask === 0 && (prior > 0 || stopping)) {
      $('support').checked = false; stopping = false;
    }
    const initializing = busy && pendingAt?.kind === 'INIT';
    if (busy && ((pendingAt?.kind === 'ARM' && next.mask === (1 << pendingAt.ch)) ||
        (pendingAt?.kind === 'HOLD' && next.mask === pendingAt.target.mask) ||
        (pendingAt?.kind === 'SET' && next.target[pendingAt.ch] === pendingAt.target) ||
        (pendingAt?.kind === 'MAP' && next.map[pendingAt.ch] === pendingAt.target) ||
        (pendingAt?.kind === 'LIMIT' && next.lower[pendingAt.ch] === pendingAt.target.lo && next.upper[pendingAt.ch] === pendingAt.target.hi) ||
        (pendingAt?.kind === 'INIT' && handshake))) busy = false;
    if (prior !== next.mask || !next.ready) record(`< ${line}`);
    if (next.ready) deviceFault = '';
    if (!next.ready || !next.outputKnown) reportIssue();
    else if (initializing && !busy && !tripped) note('4선 스케치와 PCA9685 응답 확인 완료. 출력은 꺼져 있습니다. 팔을 지지한 뒤 PSU를 켜고 시험하십시오.');
  } else {
    record(`< ${line}`);
    if (line.startsWith('FAULT ') || line.startsWith('ERR ') || line.startsWith('OFF ')) {
      // Initial STOP is part of INIT; its OFF response must not cancel handshake retries.
      if (pendingAt?.kind !== 'INIT') busy = false;
      $('support').checked = false;
      if (line.startsWith('FAULT ')) { deviceFault = line.slice(6); reportIssue(); }
      if (!line.startsWith('OFF USER') && !line.startsWith('OFF EMERGENCY')) {
        if (!line.startsWith('FAULT ')) note(`PWM 중지 요청: ${line}. 4선 방식에서는 I²C 연결이 필요합니다.`, true);
      }
    }
  }
  render();
}
async function raw(line) {
  if (mode !== 'serial' || !writer) throw Error('USB 연결이 없습니다.');
  await writer.write(encoder.encode(line + '\n'));
  if (line !== 'PING') record(`> ${line}`);
}
async function emergency(reason = '사용자 요청') {
  $('support').checked = false; busy = false; stopping = true; render();
  if (mode === 'demo') {
    state.mask = 0; stopping = false; record('연습: PWM 중지');
  } else if (mode === 'serial') {
    try { await raw('!'); } catch { tripped = true; }
  } else stopping = false;
  note(`${reason}: PWM 중지 요청. 팔을 받치십시오. 실물의 전원 차단은 PSU에서 하십시오.`);
  render();
}
async function sendAction(line, kind, target) {
  if (!usable()) return;
  busy = true; pendingAt = {time:performance.now(), kind, target, ch:selected}; render();
  try {
    if (mode === 'demo') {
      record(`연습 > ${line}`);
      if (kind === 'ARM') { state.applied=Array(6).fill(CENTER); state.target=Array(6).fill(CENTER); state.mask = 1 << selected; }
      if (kind === 'HOLD') { state.mask = target.mask; state.applied = [...target.pose]; state.target = [...target.pose]; }
      if (kind === 'SET') state.target[selected] = target;
      if (kind === 'MAP') { state.map[selected]=target; $('map-confirm').checked=false; }
      if (kind === 'LIMIT') { state.lower[selected]=target.lo; state.upper[selected]=target.hi; }
      busy = false; render();
    } else await raw(line);
  } catch (e) { tripped = true; await emergency('전송 오류'); note(e.message, true); }
}
async function setPulse(us) {
  try {
    const command = setCommand(selected, us, state);
    await sendAction(command, 'SET', us); $('pulse').value = us; $('degree-input').value=usToDegrees(us).toFixed(1);
  } catch (e) { note(e.message, true); }
}
$('arm').onclick = async () => {
  try { await sendAction(armCommand(selected, state, $('support').checked), 'ARM'); }
  catch (e) { note(e.message, true); }
};
$('minus').onclick = () => setPulse(state.target[selected] - Number($('pulse-step').value));
$('plus').onclick = () => setPulse(state.target[selected] + Number($('pulse-step').value));
$('pulse-step').onchange=render;
$('zero-minus').onclick=() => setPulse(state.target[selected]-5);
$('zero-plus').onclick=() => setPulse(state.target[selected]+5);
async function setDegrees(degrees) {
  try { await setPulse(degreesToUs(degrees)); } catch(e) { note(e.message,true); }
}
for (const [id,delta] of [['degree-minus5',-5],['degree-minus1',-1],['degree-plus1',1],['degree-plus5',5]])
  $(id).onclick=()=>setDegrees(usToDegrees(state.target[selected])+delta);
$('degree-apply').onclick=()=>setDegrees($('degree-input').value.trim()==='' ? NaN : Number($('degree-input').value));
$('limit-apply').onclick=async()=>{
  try {
    const lo=Number($('limit-min').value), hi=Number($('limit-max').value);
    await sendAction(limitCommand(selected,lo,hi,state),'LIMIT',{lo,hi});
    note(`CH${selected} 한계 ${lo}–${hi}µs 설정을 요청했습니다. 장치가 보고한 현재 한계를 확인하십시오. 범위 변경만으로 움직이지 않습니다.`);
  } catch(e) { note(e.message,true); }
};
$('center').onclick = () => setPulse(CENTER);
$('apply').onclick = () => setPulse(Number($('pulse').value));
$('support').onchange = render;
$('hold-mask').onchange = render;
$('zero-channel').onchange = () => selectChannel(Number($('zero-channel').value));
$('map-confirm').onchange = render;
$('pca-port').onchange = () => { $('map-confirm').checked = false; render(); };
$('map-apply').onclick = async () => {
  try {
    const port=Number($('pca-port').value);
    const line=mapCommand(selected,port,state,$('map-confirm').checked);
    await sendAction(line,'MAP',port);
    note(`CH${selected} → PCA ${port}번 설정을 요청했습니다. 표시된 실제 매핑을 확인하고, 플러그가 같은 포트에 있는지 확인한 뒤 PSU를 켜십시오.`);
  } catch(e) { note(e.message,true); }
};
async function startHold(useZeros) {
  const mask = Number($('hold-mask').value);
  try {
    const pose = useZeros ? zeroPose(profile,mask,mode === 'demo') : Array(6).fill(CENTER);
    const line = holdCommand(mask,state,$('support').checked,useZeros ? pose : null);
    await sendAction(line,'HOLD',{mask,pose});
  } catch(e) { note(e.message,true); }
}
$('hold').onclick = () => startHold(false);
$('hold-zero').onclick = () => startHold(true);

function saveProfile() {
  if (mode === 'demo') return;
  hardwareProfile = profile;
  try { localStorage.setItem(STORAGE_KEY,JSON.stringify(profile)); }
  catch { note('브라우저에 저장하지 못했습니다. 원점 파일 저장으로 보관하십시오.',true); }
}
$('zero-record').onclick = () => {
  if (!usable()) return;
  try {
    profile = recordZero(profile,selected,state,mode === 'demo',$('zero-note').value);
    note(`CH${selected} 원점을 ${profile.channels[selected].zeroUs}µs로 기록했습니다. 실제 자세는 실물에서 확인하십시오.`);
    record(`원점 기록 CH${selected} ${profile.channels[selected].zeroUs}us`); saveProfile(); render();
  } catch(e) { note(e.message,true); }
};
$('zero-go').onclick = () => setPulse(profile.channels[selected].zeroUs);
$('zero-clear').onclick = () => {
  profile.channels[selected] = emptyProfile().channels[selected]; $('zero-note').value = '';
  saveProfile(); render(); note(`CH${selected} 원점 기록을 지웠습니다. 모터에는 명령을 보내지 않았습니다.`);
};
function downloadJSON(data,name) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'})), a = document.createElement('a');
  a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url),1000);
}
$('profile-export').onclick = () => downloadJSON({...profile,pcaChannels:state?.map ?? profile.pcaChannels},`rot3u-zero-${profile.source}.json`);
$('profile-import').onclick = () => $('profile-file').click();
$('profile-file').onchange = async () => {
  const file = $('profile-file').files[0]; $('profile-file').value = '';
  if (!file || state?.mask || busy || stopping) return;
  try {
    if (file.size > 20000) throw Error('원점 파일이 너무 큽니다.');
    const parsed = validateProfile(JSON.parse(await file.text()));
    if (state?.mask || busy || stopping) throw Error('출력이 꺼진 상태에서 불러오십시오.');
    if (parsed.source !== (mode === 'demo' ? 'demo' : 'hardware')) throw Error('실물 원점과 화면 연습 원점은 서로 불러올 수 없습니다.');
    profile = parsed; saveProfile(); $('zero-note').value = profile.channels[selected].note;
    note(`원점 기록을 불러왔습니다. 파일의 PCA 매핑 [${profile.pcaChannels.join(', ')}]은 참고값이며 자동 적용하지 않습니다. 실제 배선·매핑을 확인한 뒤 원점 이동 또는 함께 켜기를 누르십시오.`); render();
  } catch(e) { note(`원점 불러오기 실패: ${e.message}`,true); }
};
$('stop').onclick = () => emergency();
document.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); emergency('Esc'); } });

async function readLoop(thisPort, token) {
  let buffer = ''; const decoder = new TextDecoder();
  try {
    reader = thisPort.readable.getReader(); const thisReader = reader;
    try {
      while (token === session) {
        const {value, done} = await thisReader.read(); if (done) break;
        if (token !== session) break;
        receivedBytes += value.length;
        buffer += decoder.decode(value, {stream:true});
        if (buffer.length > 4096) throw Error('유효하지 않은 장치 응답입니다.');
        let end;
        while ((end = buffer.indexOf('\n')) >= 0) {
          receive(buffer.slice(0,end).trim()); buffer = buffer.slice(end+1);
        }
      }
    } finally { thisReader.releaseLock(); if (reader === thisReader) reader = null; }
  } catch (e) {
    if (token === session) { tripped = true; record(`USB 수신 오류: ${e.message}`); }
  } finally {
    if (token === session) { readEnded = true; tripped = true; busy = false; $('support').checked = false; reportIssue(); render(); }
  }
}
async function initialize() {
  if (!writer) return;
  handshake = false; tripped = false; stopping = false; busy = true;
  firmware = ''; receivedBytes = 0; deviceFault = ''; hiddenTrip = false; state = null;
  pendingAt = {kind:'INIT', time:performance.now()}; $('support').checked = false;
  lastProbeAt = performance.now();
  note('Uno의 4선 스케치와 PCA9685 응답을 확인하고 있습니다.');
  await raw('!'); await raw('INIT'); await raw('HELLO'); render();
}
async function closeConnection() {
  await emergency('연결 해제');
  // Give STOP a chance to reach the UART before closing, even during reset.
  if (mode === 'serial') await new Promise(resolve => setTimeout(resolve, 100));
  session++;
  const closingPort = port;
  try { if (reader) await reader.cancel(); } catch {}
  try { if (readTask) await readTask; } catch {}
  try { if (writer) writer.releaseLock(); } catch {}
  writer = null;
  try { if (closingPort) await closingPort.close(); } catch {}
  port = null; reader = null; readTask = null; state = null; mode = 'off';
  profile = hardwareProfile; $('zero-note').value = profile.channels[selected].note;
  handshake = busy = tripped = stopping = false; render();
}
$('connect').onclick = async () => {
  if (!('serial' in navigator)) { note('USB 연결은 데스크톱 Chrome 또는 Edge에서 여십시오. 화면 연습은 여기서도 가능합니다.', true); return; }
  const token = ++session;
  mode = 'serial'; handshake = false; state = null; busy = true;
  firmware = ''; receivedBytes = 0; deviceFault = ''; readEnded = hiddenTrip = false;
  pendingAt = {kind:'OPEN', time:performance.now()}; render();
  try {
    const candidate = await navigator.serial.requestPort();
    if (token !== session) return;
    port = candidate; await port.open({baudRate:115200});
    if (token !== session) { await candidate.close(); return; }
    writer = port.writable.getWriter(); readTask = readLoop(port, token);
    note('Uno 재시작을 기다립니다. 4선 방식이므로 서보 PSU는 꺼 두십시오.');
    await new Promise(resolve => setTimeout(resolve, 2000));
    if (token !== session) return;
    await initialize();
  } catch (e) {
    if (token !== session) return;
    await closeConnection();
    if (e.name === 'NotFoundError') note('포트 선택이 취소되었습니다. USB 연결을 다시 누르고 Uno 포트를 선택하십시오.');
    else note(`포트를 열지 못했습니다: ${e.message}. Arduino 시리얼 모니터를 닫고 Uno 포트를 선택하십시오.`, true);
  }
};
$('disconnect').onclick = closeConnection;
$('retry').onclick = async () => { try { await initialize(); } catch(e) { tripped = true; note(e.message,true); render(); } };
$('demo').onclick = () => {
  mode = 'demo'; handshake = true; busy = tripped = stopping = false;
  state = idleState();
  $('limit-min').value=DEFAULT_MIN; $('limit-max').value=DEFAULT_MAX; $('degree-input').value=90; $('pulse').value=CENTER;
  $('pca-port').value=String(selected); $('map-confirm').checked=false;
  profile = {...emptyProfile(),source:'demo'}; $('zero-note').value = '';
  $('support').checked = false; demoTickAt = performance.now();
  record('화면 연습 시작 · USB 포트를 열지 않습니다.');
  note('화면 연습 중입니다. 어떤 서보에도 신호를 보내지 않습니다.'); render();
};
$('export').onclick = () => {
  const blob = new Blob([JSON.stringify({time:new Date().toISOString(), mode,
    hardwareVerified:false, channelLabelsAreProvisional:true, channelNames:NAMES,
    lastCommandState:state, zeroProfile:profile, notes:$('notes').value, log},null,2)],{type:'application/json'});
  const url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = `arm-bench-${new Date().toISOString().replace(/[:.]/g,'-')}.json`;
  a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
};
// Do not keep feeding the watchdog after a missing/stale state reply.
setInterval(async () => {
  if (mode !== 'serial' || !writer || !handshake || tripped) return;
  if (busy && pendingAt.kind === 'INIT') return;
  if (!fresh()) { tripped = true; await emergency('상태 응답 없음'); reportIssue(); return; }
  try { await raw('PING'); } catch { tripped = true; await emergency('통신 오류'); }
}, 400);
setInterval(() => {
  if (mode === 'demo' && state.mask) {
    const steps = Math.floor((performance.now() - demoTickAt) / 20);
    if (steps > 0) {
      for (const ch of activeChannels(state)) {
        const delta = state.target[ch] - state.applied[ch];
        state.applied[ch] += Math.sign(delta) * Math.min(Math.abs(delta), steps * 2);
      }
      demoTickAt = performance.now();
    }
  } else demoTickAt = performance.now();
  if (mode === 'serial' && busy && pendingAt.kind === 'INIT' && !tripped && writer &&
      performance.now() - lastProbeAt > 750) {
    lastProbeAt = performance.now();
    raw('HELLO').catch(() => { tripped = true; busy = false; reportIssue(); });
  }
  if (mode === 'serial' && busy && pendingAt.kind !== 'OPEN' &&
      performance.now() - pendingAt.time > (pendingAt.kind === 'INIT' ? 6000 : 3500)) {
    tripped = true; busy = false; emergency('명령 응답 시간 초과').then(reportIssue);
  }
  render();
},100);
document.addEventListener('visibilitychange', () => {
  // A port picker can change visibility; only inhibit an armed/pending-arm session.
  if (document.hidden && mode === 'serial' && (state?.mask > 0 || (busy && ['ARM','HOLD'].includes(pendingAt.kind)))) {
    hiddenTrip = true; tripped = true; emergency('탭을 벗어남').then(reportIssue);
  }
});
window.addEventListener('pagehide', () => { if (mode === 'serial') { tripped = true; emergency('페이지 종료'); } });
if (!('serial' in navigator)) note('이 브라우저는 USB 직접 연결을 지원하지 않습니다. 실물 조작은 데스크톱 Chrome/Edge를 사용하십시오. 화면 연습은 가능합니다.');
$('zero-note').value = profile.channels[selected].note;
render();
