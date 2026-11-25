# PGS 5-B 로컬 검증 보고서

Node.js 24, Windows, 로컬 HTTPS/WSS, PostgreSQL 호환 PGlite 및 SQLite에서 합성 PDF와 테스트용 시크릿으로 수행했다. 아래 결과는 5-B 통합 테스트와 기존 단계의 회귀 테스트에서 관찰한 결과다.

| 번호 | 검증 항목 | 결과 | 근거 |
|---|---|---|---|
| 1 | PDF 등록과 URL 발급 | 성공 | 5-B Mock Delphi 201, 상태 조회에서 URL 확인 |
| 2 | 내부 REST API 4종 | 성공 | 4단계 계약 회귀 테스트 |
| 3 | PDF SHA-256 불일치 | 성공 | 4단계 409 단언 |
| 4 | 생년월일 HMAC v2 | 성공 | 5-B 재발급 URL의 환자 인증 |
| 5 | 동일 요청 중복 방지 | 성공 | 4단계 동일 결과 단언 |
| 6 | 202 결과 재조회 | 성공 | 4단계 대기 상태 회귀 |
| 7 | 응답 유실 및 타임아웃 재조회 | 성공 | 4단계 별도 케이스 |
| 8 | 동일 요청의 입력 변경 409 | 성공 | 4단계 계약 회귀 |
| 9 | 만료·폐기 410 | 성공 | 4단계 만료와 5-B 폐기 |
| 10 | 재발급 후 기존 URL 차단 | 성공 | 5-B 운영 관리자 재발급 및 구 URL 거부 |
| 11 | 다른 문서 세션 사용 차단 | 성공 | 3단계 문서 범위 및 세션 회귀 |
| 12 | Agent 종료·재연결 | 성공 | 2~4단계 프로세스 재연결 검증 |
| 13 | 전송 도중 연결 종료 | 성공 | 3단계 인플라이트 정리 검증 |
| 14 | 동시 PDF 조회 10건 | 성공 | 3단계 동시 전송 |
| 15 | 외부 PDF 영구 미저장·캐시 방지 | 성공 | 3단계 저장물 검사, 5-B 다운로드 no-store |
| 16 | 관리자 권한 | 성공 | 5-B 세 역할 세션, 정책·감사·재발급·폐기 접근 |
| 17 | 종류 및 보관 정책 | 성공 | 5-B 신규 코드 등록과 PDF 10일·링크 5일 적용, 2~4단계 만료 정책 회귀 |
| 18 | 0~4단계 회귀 | 성공 | 기반 단위 8개 및 2~4단계 DB·통합 스크립트 |
| 19 | 외부 Web 포트의 내부 API 차단 | 성공 | 4단계 및 5-B 404 |
| 20 | 실제 DB 기반 집계 | 성공 | 5-B Mock 등록 후 목록 및 금일 건수 확인 |

실행 명령은 `node --test tests/*.test.ts`, `node tests/phase2-db.mjs`, `node tests/phase2-storage.mjs`, `node tests/phase2-integration.mjs`, `node tests/phase3-migration.mjs`, `node tests/phase3-integration.mjs`, `node tests/phase4-integration.mjs`, `node tests/phase5b-integration.mjs`다. 로컬 의존 모듈 위치는 README의 실행환경 설정에 따른다.

미검증 범위는 실제 PostgreSQL 운영 인스턴스, 병원 LAN·방화벽·프록시, 승인된 HIS 매핑과 실기기 화면 확인이다. 중단 복구 시 운영자가 저장 파일을 수동으로 복원하는 절차는 OPEN_ISSUES.md에서 관리한다.

Edge 브라우저에서 5-B 관리자 로그인과 조회 전용 UI, Agent 요청 내역, 320px 환자 화면의 생년월일 확인과 PDF 페이지 이동·확대를 검증했다. 같은 테스트를 실행하려면 PGS_BROWSER_EXE와 PGS_BROWSER_MODULES를 설정한다.
