# 전송 Agent 운영 가이드

PGS 루트에서 `npm run dev:phase5b` 또는 `node --env-file-if-exists=.env scripts/phase2.mjs --phase5b`를 실행하고 [Agent](https://127.0.0.1:4205/agent)를 연다. 이 프로필은 `.local/phase5b`에 별도 저장소와 카탈로그를 만든다. 기본 포트가 같은 4단계 프로필은 종료 후 실행한다.

`node scripts/mock-delphi.mjs --phase5b`로 가상 PDF를 인수 폴더에 넣어 등록한다. 실제 Delphi 호출은 DELPHI_AGENT_API_SPEC.md의 API Key와 SHA-256 및 HMAC v2 규격을 적용한다. 클라이언트 연결이 끊어지면 같은 requestId로 상태를 확인한다.

- 대시보드에서 KST 등록 호출·실패, 처리 상태, 보관량과 내부 API 및 Relay 상태를 확인한다. 등록 호출 건수는 같은 요청의 재호출을 포함한다.
- Delphi 연동 내역에서 기간, 문서 종류, 요청 ID, 문서 ID와 상태를 좁힌다. 상세에서 원격 등록 결과, 저장 파일 상태 및 SHA-256을 확인한다.
- 재처리는 기존 PDF와 requestId가 남은 재시도 대상에만 실행한다. 무결성이 깨졌거나 파일이 유실되면 상세 결과와 원본 제출 경로를 먼저 확인한다.
- URL은 승인된 상세 작업 또는 내부 API 상태 재조회에서 확인한다. 재발급은 기존 세션을 종료하며 기존 만료일을 유지한다.
- 만료·삭제 메뉴에서는 삭제 기한에 도달한 자료와 삭제 오류를 확인한다. 저장소와 인수 폴더에는 Agent 서비스 계정의 최소 권한만 부여한다.
- 연결관리에서 마지막 연결·종료, Heartbeat 응답과 재연결을 확인한다. 복구 중에는 등록 요청이 대기할 수 있다.
