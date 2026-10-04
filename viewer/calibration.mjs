import {CENTER, MIN, MAX, isActive, activeChannels} from './protocol.mjs';
export const STORAGE_KEY = 'rot3u-zero-profile-v1';
export function emptyProfile() {
  return {schema:'rot3u-zero-v1',name:'ROT3U 기준 자세',source:'hardware',units:'us',
    pcaChannels:[0,1,2,3,4,5],channels:Array.from({length:6}, (_,ch) => ({ch,zeroUs:CENTER,recorded:false,note:''}))};
}
export function validateProfile(data) {
  if (!data || data.schema !== 'rot3u-zero-v1' || data.units !== 'us' || !['hardware','demo'].includes(data.source) ||
      typeof data.name !== 'string' || data.name.length > 100 || !Array.isArray(data.channels) || data.channels.length !== 6 ||
      !Array.isArray(data.pcaChannels) || data.pcaChannels.length !== 6 || new Set(data.pcaChannels).size !== 6 ||
      data.pcaChannels.some(p=>!Number.isInteger(p) || p<0 || p>15))
    throw Error('지원하지 않는 원점 기록 형식입니다.');
  const channels = data.channels.map((c,i) => {
    if (!c || c.ch !== i || !Number.isInteger(c.zeroUs) || c.zeroUs < MIN || c.zeroUs > MAX ||
        typeof c.recorded !== 'boolean' || typeof c.note !== 'string' || c.note.length > 1000 ||
        (!c.recorded && c.zeroUs !== CENTER)) throw Error(`CH${i} 원점값 또는 메모를 확인하십시오.`);
    return {ch:i,zeroUs:c.zeroUs,recorded:c.recorded,note:c.note};
  });
  return {schema:data.schema,name:data.name,source:data.source,units:'us',pcaChannels:[...data.pcaChannels],channels};
}
export function recordZero(profile, ch, state, isDemo, note) {
  const p = validateProfile(profile);
  if (!state?.ready || !state.outputKnown || !isActive(state,ch) || state.applied[ch] !== state.target[ch])
    throw Error('활성 채널의 명령 변경이 완료된 뒤 원점을 기록하십시오.');
  if (p.source !== (isDemo ? 'demo' : 'hardware')) throw Error('연습 기록과 실물 기록은 분리됩니다.');
  p.channels[ch] = {ch,zeroUs:state.applied[ch],recorded:true,note};
  p.pcaChannels = [...state.map];
  return validateProfile(p);
}
export function zeroPose(profile, mask, isDemo) {
  const p = validateProfile(profile);
  if (!isDemo && p.source !== 'hardware') throw Error('화면 연습 원점은 실물에 적용할 수 없습니다.');
  if (![31,63].includes(mask) || activeChannels({mask}).some(ch => !p.channels[ch].recorded))
    throw Error('함께 켤 모든 채널의 원점을 먼저 기록하십시오.');
  return p.channels.map(c => c.zeroUs);
}
