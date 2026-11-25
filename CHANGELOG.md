# 변경 기록


## v2.3 · 3단계

- Agent의 256비트 링크 발급, AES-GCM SQLite 보관, 등록/응답 유실/재시작 시 같은 링크 회복을 추가했다.
- PostgreSQL 토큰/세션 마이그레이션, 생년월일 HMAC, 인증 속도 제한, 실패 잠금, 재인증 및 폐기를 추가했다.
- 기존 WSS를 사용하고 HTTPS 환자·관리자 화면과 2단계 회귀 경로를 분리했다.

| 영역 | 변경 파일 |
|---|---|
| 데이터 | database/migrations/003_patient_auth.sql, database/migrations/sqlite/002_agent_links.sql |
| 인증 | apps/phase3/auth.mjs, crypto.mjs, routes.mjs, package.json |
| 등록·중계 | apps/phase2/common.mjs, db.mjs, relay.mjs, service.mjs, apps/transfer-agent/phase2.mjs, storage.mjs |
| 화면 | apps/api-server/mock/server.mjs, web/main.jsx, web/common.jsx, apps/{admin-web,patient-web,transfer-agent}/ui.jsx |
| 실행 | scripts/phase2.mjs, package.json, .env.example |
| 자동 검증 | tests/phase3-migration.mjs, phase3-integration.mjs, phase3-browser.mjs |
| 문서 | README.md, CHANGELOG.md, OPEN_ISSUES.md, docs/PHASE3.md, docs/{REQUIREMENTS,ARCHITECTURE,DATABASE,API_SPEC,SECURITY,TEST_PLAN}.md, 3단계 원문 |
## v2.3 · 2단계

- 0~1단계 React 화면·파일명 파서·합성 환자 공급자를 유지했다. 2단계 실행에서는 이전 메모리 PDF 라우트를 비활성화했다.
- Agent 내부 원자적 저장, SQLite 인덱스, 메타데이터 전용 PostgreSQL 마이그레이션과 별도 WSS 중계를 추가했다.
- 시스템 및 종류별 보관/링크 정책을 기본 30일, 정수 1~90일, 링크 ≤ 보관으로 적용했다. 기존 확정 기한은 보존한다.
- Agent 저장소·연결 상태, 관리자 정책 변경 이력·중계 미리보기, 환자 중계 오류와 재시도 안내를 추가했다.
- 만료 조회 차단, 수동 삭제·실패 재시도 및 오프라인 삭제 동기화, 회귀·부하 테스트를 추가했다.

### 변경 파일

| 영역 | 파일 |
|---|---|
| Agent | `apps/transfer-agent/phase2.mjs`, `storage.mjs`, `ui.jsx` |
| 중계 및 DB | `apps/phase2/common.mjs`, `db.mjs`, `relay.mjs`, `service.mjs`, `package.json` |
| 공통 웹 | `apps/api-server/mock/server.mjs`, `web/common.jsx`, `web/main.jsx` |
| 관리자·환자 | `apps/admin-web/policy.jsx`, `ui.jsx`, `apps/patient-web/ui.jsx` |
| 정책 및 마이그레이션 | `packages/shared/policy.ts`, `database/migrations/001_metadata.sql`, `002_legacy_compat.sql`, `sqlite/001_agent.sql`, 마이그레이션·시드 README |
| 로컬 실행 | `package.json`, `.env.example`, `docker-compose.yml`, `scripts/phase2.mjs`, `local-cert.ps1`, `fixture.mjs` |
| 검증 | `tests/foundation.test.ts`, `phase2-db.mjs`, `phase2-storage.mjs`, `phase2-integration.mjs`, `phase2-browser.mjs` |
| 문서 | `README.md`, `CHANGELOG.md`, `OPEN_ISSUES.md`, `docs/{REQUIREMENTS,ARCHITECTURE,DATABASE,API_SPEC,SECURITY,TEST_PLAN}.md`, v2.3 원문 |

## v2.1 · 0~1단계

요구사항, 기본 설계, 파일명 파서·Mock 환자 공급자 및 전송 Agent·관리자·환자 시연 화면.
