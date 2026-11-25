# Relay 연결 가이드

로컬 기본 구성은 Web/환자 HTTPS 4205, Delphi 내부 HTTP 4206, Relay WSS 4445다. WSS 경로는 `/api/v1/agent/connect`다. `PGS_PORT`, `PGS_AGENT_PORT`, `PGS_TLS_PORT`로 로컬 포트를 조정한다.

`PGS_PUBLIC_ORIGIN`은 발급되는 환자 URL의 HTTPS 원점이고 `PGS_RELAY_ORIGIN`은 Agent가 접속할 HTTPS 기준 원점이다. 설정을 생략하면 로컬 주소를 사용한다. 별도 배포 주소를 명시하면 HTTPS 원점 형식과 로컬 호스트명 제한을 검증한다. `PGS_AGENT_ID`는 안정적으로 유지할 UUID다.

Relay는 인증 및 요청 UUID 대조 뒤 제한된 전송을 시작한다. Agent 화면은 Heartbeat ACK, 종료 및 자동 재연결 상태를 표시한다. 중간 전송이 끊기면 해당 스트림과 인플라이트 항목을 정리한다. 진단 시 인증서, Agent ID·비밀키, 포트 접근과 마지막 Heartbeat를 확인한다. 테스트는 로컬 연결에서 수행했다.
