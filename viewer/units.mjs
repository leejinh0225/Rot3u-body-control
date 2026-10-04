// A declared command scale, not measured shaft/joint geometry.
export const DEGREE_MIN_US = 500, DEGREE_MAX_US = 2500;
export const SLEW_US_PER_SECOND = 100;
export function degreesToUs(degrees) {
  if (!Number.isFinite(degrees) || degrees<0 || degrees>180) throw Error('명령각은 0–180° 안에 입력하십시오.');
  return Math.round(DEGREE_MIN_US + degrees/180*(DEGREE_MAX_US-DEGREE_MIN_US));
}
export function usToDegrees(us) {
  return (us-DEGREE_MIN_US)*180/(DEGREE_MAX_US-DEGREE_MIN_US);
}
export function nominalTicks(us) { return Math.floor((us*25+61)/122); }
export function nominalPulseUs(us) { return nominalTicks(us)*122/25; }
export function secondsToTarget(applied,target) { return Math.abs(target-applied)/SLEW_US_PER_SECOND; }
