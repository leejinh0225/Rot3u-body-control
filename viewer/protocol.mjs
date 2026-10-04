export const NAMES = ['베이스', '어깨', '팔꿈치', '손목 굽힘', '손목 회전', '그리퍼'];
export const MIN = 500, MAX = 2500, CENTER = 1500;
export const DEFAULT_MIN = 1000, DEFAULT_MAX = 2000;
export const FIRMWARE = 'ARM_BENCH_V4_ANGLE';
export const isActive = (state, ch) => Number.isInteger(ch) && ch >= 0 && ch < 6 && !!((state?.mask ?? 0) & (1 << ch));
export const activeChannels = state => NAMES.map((_, ch) => ch).filter(ch => isActive(state,ch));
export function parseState(line) {
  const parts = line.trim().split(/\s+/);
  if (parts.length !== 37 || parts[0] !== 'STATE4' || !parts.slice(1).every(p => /^\d+$/.test(p))) return null;
  const values = parts.slice(1).map(Number);
  const [ready, mask, min, max, watchdog, outputKnown] = values;
  const applied = values.slice(6,12), target = values.slice(12,18);
  const map = values.slice(18,24);
  const lower = values.slice(24,30), upper = values.slice(30,36);
  if (!values.every(Number.isSafeInteger) || ![0,1].includes(ready) || mask > 63 ||
      min !== MIN || max !== MAX || watchdog !== 2000 || ![0,1].includes(outputKnown) ||
      (!ready && mask !== 0) || (ready && !outputKnown) ||
      [...applied,...target].some(us => us < min || us > max) || map.some(port=>port>15) || new Set(map).size !== 6 ||
      lower.some((lo,ch)=>lo<MIN || lo>CENTER || upper[ch]<CENTER || upper[ch]>MAX || lo>=upper[ch]) ||
      activeChannels({mask}).some(ch=>applied[ch]<lower[ch] || applied[ch]>upper[ch] || target[ch]<lower[ch] || target[ch]>upper[ch])) return null;
  return {ready:!!ready, mask, min, max, watchdog, outputKnown:!!outputKnown, applied, target, map, lower, upper};
}
function requireOff(state, acknowledged) {
  if (!acknowledged || !state?.ready || !state.outputKnown || state.mask !== 0)
    throw Error('전체 출력이 꺼진 상태에서 팔 지지를 확인하십시오.');
}
export function armCommand(ch, state, acknowledged) {
  requireOff(state,acknowledged);
  if (!Number.isInteger(ch) || ch < 0 || ch > 5) throw Error('CH0~CH5를 선택하십시오.');
  return `ARM ${ch} ${CENTER}`;
}
export function holdCommand(mask, state, acknowledged, pose = null) {
  requireOff(state,acknowledged);
  if (![31,63].includes(mask)) throw Error('CH00~04 또는 전체 6개를 선택하십시오.');
  if (pose === null) return `HOLD ${mask}`;
  if (!Array.isArray(pose) || pose.length !== 6 || pose.some(us => !Number.isInteger(us) || us < MIN || us > MAX))
    throw Error('원점값은 500–2500µs 안에 있어야 합니다.');
  for (const ch of activeChannels({mask})) if (!withinLimits(ch,pose[ch],state))
    throw Error(`CH${ch} 원점이 현재 관절 한계 ${state.lower[ch]}–${state.upper[ch]}µs 밖에 있습니다. OFF에서 한계를 확인하십시오.`);
  return `POSE ${mask} ${pose.join(' ')}`;
}
export function setCommand(ch, us, state) {
  if (!state?.ready || !state.outputKnown || !isActive(state,ch) ||
      !withinLimits(ch,us,state)) throw Error(`활성 채널과 관절 한계 ${state?.lower?.[ch] ?? '?'}–${state?.upper?.[ch] ?? '?'}µs를 확인하십시오.`);
  return `SET ${ch} ${us}`;
}
export function idleState() {
  return {ready:true,mask:0,applied:Array(6).fill(CENTER),target:Array(6).fill(CENTER),min:MIN,max:MAX,watchdog:2000,outputKnown:true,map:[0,1,2,3,4,5],lower:Array(6).fill(DEFAULT_MIN),upper:Array(6).fill(DEFAULT_MAX)};
}
export function withinLimits(ch,us,state) {
  return Number.isInteger(ch) && ch>=0 && ch<6 && Number.isInteger(us) && us>=MIN && us<=MAX &&
    us>=state?.lower?.[ch] && us<=state?.upper?.[ch];
}
export function limitCommand(ch,lo,hi,state) {
  requireOff(state,true);
  if (!Number.isInteger(ch) || ch<0 || ch>5 || !Number.isInteger(lo) || !Number.isInteger(hi) ||
      lo<MIN || hi>MAX || lo>CENTER || hi<CENTER || lo>=hi)
    throw Error('관절 한계는 500–2500µs 안에서 최소 < 최대, 시작값 1500µs를 포함하도록 정하십시오.');
  return `LIMIT ${ch} ${lo} ${hi}`;
}
export function mapCommand(ch, port, state, powerOffConfirmed) {
  requireOff(state,powerOffConfirmed);
  if (!Number.isInteger(ch) || ch<0 || ch>5 || !Number.isInteger(port) || port<0 || port>15)
    throw Error('논리 관절 CH0~5, 실제 PCA 포트 0~15를 선택하십시오.');
  if (state.map.some((p,i)=>i!==ch && p===port)) throw Error(`PCA ${port}번은 다른 관절이 사용 중입니다. 빈 포트를 선택하십시오.`);
  return `MAP ${ch} ${port}`;
}
