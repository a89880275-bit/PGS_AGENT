# PGS 4단계 Delphi 연동 검증 결과

이 보고서는 이전 Oracle 직접 연동 계획을 대체한 Delphi 아키텍처의 검증 기록이다. 이전 지시는 이력 문서로 보존한다.

## 적용 결과와 변경 파일

| 영역 | 변경 파일 및 결과 |
|---|---|
| Delphi 등록 | apps/transfer-agent/delphi.mjs, phase2.mjs, storage.mjs. 인증된 loopback API, 인수 파일 검증, 증명값 보관, 재시도 및 상태 조회 |
| 보안 경계 | apps/phase2/service.mjs, scripts/phase2.mjs. 외부 요청은 내부 등록 라우트에 도달하지 않으며 Agent 프로세스에 생년월일 HMAC 키를 전달하지 않음 |
| 화면 | apps/transfer-agent/DelphiAgent.jsx, apps/api-server/mock/web/main.jsx, apps/admin-web/ui.jsx. 여덟 메뉴와 관리자 권한 링크 작업 및 삭제 |
| SQLite | database/migrations/sqlite/004_delphi_intake.sql. 기존 등록 레코드를 유지하고 요청 지문과 최소 이벤트 로그를 추가 |
| 제거 | apps/transfer-agent/automation의 Oracle·발송 모듈 및 UI, 직접 Oracle 스텁, 이전 발송 테스트·마이그레이션 소스. package.json의 드라이버, .env.example의 접속·발송 변수 |
| 시험과 문서 | tests/phase4-integration.mjs, tests/foundation.test.ts, scripts/mock-delphi.mjs, DELPHI_AGENT_API_SPEC.md, DELPHI_INTEGRATION_GUIDE.md, PGS_SECURITY_ARCHITECTURE_v3.md |

기존 SQLite 발송 테이블은 데이터 폐기 권한이 확정될 때까지 유지되며 현재 런타임은 이를 읽거나 쓰지 않는다. 신규 SQLite에는 이전 발송 테이블이 생성되지 않는다. Agent 시작 시 SQLite 버전 4를 적용하며 PostgreSQL 스키마 변경은 없다.

## 실행 및 결과

| 검증 | 실제 결과 |
|---|---|
| 빌드 | Node 소스 검사, React 번들, TypeScript 엄격 검사 통과 |
| 0~3단계 회귀 | 기존 단위 테스트 8건, 2단계 중계 통합, 3단계 SQLite·PostgreSQL 마이그레이션 및 HTTPS/WSS 통합 통과 |
| Delphi 등록 | 신규 201·READY, 동일 요청 200, 바뀐 검증값 또는 중복 문서 ID 409. 응답 유실과 원본 제거·Agent 재시작 후에도 요청 ID를 기준으로 같은 등록 결과 복구 |
| 파일·인증 경계 | Bearer 미제공, 브라우저 Origin, 외부 웹의 등록 경로, 경로 순회·절대경로·ADS·장치명·하드링크, 해시 불일치, 비PDF와 생년월일 평문 필드를 차단 |
| 환자 | 전달된 HMAC으로 생년월일 확인, 미인증 PDF 401, WSS 조회·다운로드 바이트 일치, 30일 기한 확인 |
| 화면 | Edge에서 여덟 메뉴와 Oracle·발송 메뉴 미노출, Mock 등록 이력, 관리자 세션으로 링크 확인을 검증 |
| 실제 로컬 프로필 | scripts/mock-delphi.mjs가 4206 포트에서 201 READY를 반환 |

재실행은 PGS 폴더에서 `npm run dev:phase4`, API 검증은 빌드 뒤 `node tests/phase4-integration.mjs`다. 의존성은 이전 단계의 승인된 로컬 패키지를 사용했다.

별도 PC HTTPS/mTLS, 운영 키 저장소 및 ACL, 실제 Delphi 7 컴파일·연동, 설치형 PostgreSQL 17, 병원 TMAX 및 알림톡은 검증 범위에 포함하지 않았다. 실제 환자정보, 운영 DB, 외부 호스팅을 사용하지 않았다.