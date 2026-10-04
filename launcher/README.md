# Windows 실행기

Python 3와 Chrome 또는 Edge가 필요합니다. 인식 파일이 없으면 최초 실행에서 다운로드합니다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install-desktop-shortcuts.ps1
```

- **로봇팔 조종**: 서버 시작·재사용 후 조종 창을 엽니다.
- **로봇팔 서버 종료**: 로컬 서버만 종료합니다. 실물은 먼저 원점 복귀 후 OFF로 끝냅니다.
- 창을 닫아도 서버는 남습니다. PC 재시작 후에는 시작 아이콘을 다시 실행합니다.
- 폴더를 옮기면 바로가기를 다시 설치합니다.

직접 실행:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\launch-robot-arm.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\launch-robot-arm.ps1 -View Servo
powershell -NoProfile -ExecutionPolicy Bypass -File .\launch-robot-arm.ps1 -Action Stop
```

서버는 `127.0.0.1:8765`에만 연결합니다. 다른 프로그램의 포트는 재사용하거나 종료하지 않습니다. 로그는 `.runtime/server-8765.stderr.log`에 저장합니다. 시작 아이콘은 카메라·서보 출력을 자동으로 켜지 않습니다.
