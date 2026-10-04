import {FIRMWARE} from './protocol.mjs';

export function connectionIssue({firmware, receivedBytes, state, fault, stale, hidden, readEnded}) {
  if (readEnded) return {title:'USB 수신이 끊겼습니다', detail:'서보 PSU를 끄고 USB 케이블·COM 포트·시리얼 모니터 점유를 확인한 뒤 재연결하십시오.'};
  if (firmware && firmware !== FIRMWARE) return {title:'이전 스케치가 실행 중입니다', detail:'PSU를 끄고 수정된 ArmBench.ino(v4 범위·명령각)를 Uno에 다시 업로드하십시오.'};
  if (hidden) return {title:'탭 이동으로 조작을 잠갔습니다', detail:'팔 지지를 확인하고 「출력 끄고 통신 재확인」을 누르십시오. USB 포트 선택 창만 여는 것은 이 잠금을 발생시키지 않습니다.'};
  if (!firmware && receivedBytes === 0) return {title:'USB 포트는 열렸지만 Uno 응답이 없습니다', detail:'수정된 ArmBench.ino를 Arduino IDE에서 Uno에 업로드했는지 확인하십시오. 뷰어의 USB 연결은 스케치를 자동 업로드하지 않습니다. 실제 Uno COM 포트를 선택하십시오.'};
  if (!firmware) return {title:'데이터는 오지만 테스트 스케치가 확인되지 않습니다', detail:'ArmBench.ino 업로드와 115200 baud 설정을 확인하십시오. 다른 스케치·잘못된 포트·깨진 문자가 원인일 수 있습니다.'};
  if (state && !state.outputKnown) return {title:'PWM 중지 전달을 확인할 수 없습니다', detail:'서보 PSU를 끄십시오. 4선 방식은 I²C가 끊기면 기존 PWM이 계속될 수 있습니다. VCC·GND·A4→SDA·A5→SCL을 확인하십시오.'};
  if (fault || (state && !state.ready)) return {title:'Uno는 응답하지만 PCA9685가 준비되지 않았습니다', detail:`${fault ? fault + ' · ' : ''}PCA의 VCC·GND·SDA·SCL 및 기본 주소 0x40을 확인하십시오. 서보 PSU가 꺼져 있어도 논리 전원이 있으면 PCA는 응답해야 합니다.`};
  if (stale || !state) return {title:'Uno의 상태 응답이 지연됩니다', detail:'서보 PSU를 끄고 「출력 끄고 통신 재확인」을 누르십시오. 지속되면 USB 케이블과 시리얼 포트 점유를 확인하십시오.'};
  return null;
}
