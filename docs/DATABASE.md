# 메타데이터 DB와 Agent 인덱스

2단계 로컬 기준 SQL은 `database/migrations/001_metadata.sql`, `002_legacy_compat.sql`이다. 0~1단계에는 실제 DB 스키마가 없었다. 두 SQL은 기존 v2.3 스키마 및 이전 정책을 가진 문서에 반복 실행할 수 있으며 확정 시각을 갱신하지 않는다. 알려지지 않은 운영 스키마에 적용하기 전 현재 스키마와 백업을 점검한다.

| PostgreSQL | 주요 내용 |
|---|---|
| pgs_agent | Agent UUID와 클라이언트 UUID, enabled, 연결 상태, heartbeat 시각 |
| pgs_document | Agent·클라이언트·요청 ID의 소유권, 문서 종류/비식별 제목, 크기/해시, 기간/정책 버전, UTC 시각 및 상태 |
| pgs_retention_policy / pgs_policy_history | 종류별 또는 DEFAULT, 정수 1~90, 링크 ≤ 보관, 변경 전후·시간·테스트 관리자 |
| pgs_access_token / pgs_session | 토큰·세션 SHA-256만 저장. 문서 범위, 만료, 실패 횟수·잠금, 삭제 시 연쇄 정리 |
| pgs_transfer_log / pgs_delete_log / pgs_security_log | 최소 결과 기록용 구조. 이번 단계 삭제 결과 기록 |

PDF 바이트, 원본명, 저장 경로, 환자명·환자번호·생년월일 원문은 외부 DB 스키마에 없다. 기존 `storage_key`가 확인된 DB에서는 호환 필드로 표시하고 v2.3에서 기록하지 않는다. 등록 충돌은 `UNIQUE(client_id,request_id)`, Agent 소유권은 복합 FK, 만료는 `expires_at <= delete_at` 및 인덱스를 사용한다. 기간 계산은 UTC의 경과시간으로 수행하고 UI에는 KST로 표시한다.

Agent의 `Data/agent.sqlite`에는 요청, UUID, 내부 상대 경로, 원본명, 해시, 크기, 상태, 시각 및 재시도를 둔다. 신규 기간 기본값은 30일이며 확정된 날짜를 복제한다. 토큰 원문은 SQLite에 저장하지 않는다. 테스트 링크는 외부 DB의 해시·재발급 세대와 서버의 별도 비밀키로 복구한다.

삭제 후 로컬 경로와 원본명·검증값을 비우고 PostgreSQL 토큰/세션과 환자·파일 검증값을 정리한다. 요청·문서 식별자는 중복 방지 및 삭제 결과 확인에 사용한다. 운영 감사 보관 범위와 tombstone 보존기한은 별도 승인 대상이다.
## 3단계 마이그레이션

PostgreSQL 003은 기존 문서에 birth_salt와 최초 토큰 해시를 추가한다. 토큰 UUID, 발급·폐기 시각과 문서별 활성 한 건 partial unique index를 적용한다. 세션에 토큰/문서 복합 외래키와 생성·폐기 시각을 추가하고 기존 데이터를 backfill한다. 인증 속도 제한은 키 기반 가명 버킷과 분 단위 원자 카운터로 기록한다. 보안 로그에는 실패·잠금 결과만 기록하고 열람 이력을 저장하지 않는다.

SQLite 002는 문서와 세대에 연결된 암호화 토큰을 추가한다. 기존 2단계 문서는 원래 기한과 기존 링크 호환성을 유지한다. 3단계 신규 링크와 재발급 링크에 CSPRNG를 사용한다.
