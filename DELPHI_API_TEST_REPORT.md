# Delphi 내부 REST API 추가 검증

확정된 [API 명세](DELPHI_AGENT_API_SPEC.md)를 기준으로, 합성 PDF·환자번호·생년월일과 실행마다 발급한 시험 키를 사용했다. 네 API는 테스트 환경에서 별도 루프백 Agent와 중계를 구동해 호출했다. 기본 로컬 프로필 URL은 http://127.0.0.1:4206 이다.

| 실제 호출 | 확인 결과 |
|---|---|
| GET /api/v1/internal/health | API Key 유효 시 200, agent/relay ONLINE. 키 누락 또는 Bearer만 있으면 401. 외부 웹에서는 404 |
| POST /api/v1/internal/documents | 신규 201 READY, 같은 입력과 requestId 재호출은 200. 문서 UUID·URL·만료일 포함 |
| GET /api/v1/internal/requests/{requestId} | READY 200. 등록 결과와 전체 JSON 및 활성 링크 일치 |
| GET /api/v1/internal/documents/{documentId} | READY 200. 요청 ID 조회와 동일한 데이터·URL |

## 복구 및 실패

| 상황 | 실제 검증 결과 |
|---|---|
| 202 | 외부 등록 응답을 유실시켰을 때 ACCEPTED 및 Retry-After: 3. 기존 요청 ID로 조회해 READY 확인 |
| 404 | 없는 요청 ID 및 문서 UUID는 REQUEST_NOT_FOUND. 요청 ID 응답의 guideUrl은 null |
| 409 | 동일 requestId의 보관값을 바꾸면 REQUEST_CONFLICT. 동일한 본문은 기존 결과와 일치 |
| 410 | 관리자가 폐기한 문서 재조회는 410, guideUrl은 null |
| 클라이언트 타임아웃 | 테스트용 루프백 중계가 Agent로 요청을 전달한 뒤 응답을 보류했다. 호출자는 500ms 제한으로 TimeoutError를 받고 원래 requestId로 재조회했다. 최초 201 결과 및 같은 본문의 200 재시도 응답과 일치했다. |
| 추가 회귀 | 환자 생년월일 인증, PDF 조회·다운로드 원본 바이트 일치, 30일 정책, WSS 재연결, 경로 이탈·하드링크·해시 불일치 차단 |

같은 요청에 대해 관리자가 링크를 별도로 재발급하면 재조회는 새 활성 URL을 반환한다. 완료 후 원래 발급 URL의 영구 고정이 보장되는 계약은 아니다.

## 암호 및 자료 검증

Node.js 프로덕션 코드 경로의 birthProof와 별도의 PowerShell/.NET HMACSHA256 결과가 고정 벡터에서 같았다. 비교 스크립트는 올바른 값과 변조 값의 수락·거부, UTF-8 바이트 및 PDF SHA-256을 검증했다. Delphi에서 직접 계산한 HMAC을 이번 작업에서 받아 검증한 결과는 없다. 이전 검증에서는 Delphi 7 WinHTTP 실행 파일로 API 호출과 JSON 파싱을 확인했다.

## 소스 검토

기본 환자번호 자릿수는 8이고 PGS_FILENAME_PATIENT_DIGITS로 조정한다. 9자리 검증 조건에서 8자리 거절 및 앞자리 0을 유지한 9자리 수락을 확인했다. Delphi 경로는 documentType을 명시적으로 받는다. 기존 PGS_FILENAME_TYPE_MAP은 이전 파일명 파서에 적용되며, Delphi API에서는 HIS 식별코드를 자동 변환하지 않는다.

외부 반환 링크와 중계 origin은 현재 로컬 127.0.0.1과 포트 설정을 사용한다. 호출자가 로컬 HTTP와 내부 mTLS 주소를 환경별로 선택할 수 있지만 운영 공개 환자 도메인을 설정하는 기능은 현재 없다. 실제 운영 URL 분리는 별도 적용·검증이 필요하다.

Agent 앱·패키지·환경 예제에서 Oracle 드라이버/직접 접속 및 KAKAOSEND 호출 경로를 발견하지 않았다. 이전 합성 프로필의 장애 시나리오는 실서비스 호출을 하지 않는다.

재현은 PGS 폴더에서 `node tests/phase4-integration.mjs` 및 `node scripts/verify-delphi-vector.mjs`다. 실제 환자정보, 운영 키, Oracle/TMAX, KAKAOSEND 및 병원 운영 URL은 사용하지 않았다.