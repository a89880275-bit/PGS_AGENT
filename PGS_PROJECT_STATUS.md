# PGS 프로젝트 진행현황

점검 범위는 기존 0~3단계와 변경된 4단계 Delphi 연동형 Agent다. 5단계 배치 프로그램은 구현 범위에서 제외했다.

## 단계별 상태

| 단계 | 확인된 구현 | 미완료 및 검증 범위 |
|---|---|---|
| 0 | 설정형 파일명 파서, 8자리 기본값 및 앞자리 0 유지, 합성 환자 공급자, v2.3 설계 및 로컬 환경 | 실운영 파일명·코드 매핑, 병원 정책 승인 |
| 1 | Agent·관리자·환자 UI, 합성 전송 흐름 및 오류·재시도 시나리오 | Mock 프로필이다. 운영 서비스 및 실제 연동 범위는 다른 단계에 있다. |
| 2 | Agent 내부 PDF 저장, UUID 경로, 해시 확인, SQLite 상태, PostgreSQL 메타데이터, Agent 시작 WSS, 보관 정책과 로컬 삭제 작업 | 별도 PostgreSQL 17 서버, 운영 프록시·네트워크 및 쓰기 계정 검증 |
| 3 | 암호화 보관된 난수 토큰, HMAC 생년월일 검증, 잠금과 세션, 스트리밍, 재발급·폐기, PDF.js | 운영 관리자 SSO/MFA·RBAC, 실기기 및 인증 적정성 승인 |
| 4 | API Key 기반 네 내부 REST API, 인수 폴더 제한, 외부 경로 분리, 문서 및 요청 ID로 활성 URL 조회, 선택 내부 mTLS | 실제 병원 SMB·별도 PC 배치 네트워크 및 인증서 검증. Multipart는 설계만 제공. Windows 서비스 등록·재부팅 및 정기 운영 삭제는 미검증 또는 후속 범위 |

## 제거 및 보안 경계

- Agent 실행 소스·매니페스트·환경 예제에서 Oracle 직접 조회, node-oracledb, KAKAOSEND와 TMAX 실행 경로를 발견하지 않았다. 합성 Oracle 장애 사례는 이전 0~3단계 회귀 프로필에 있다. 운영 Delphi를 외부 요청이 역호출하는 경로가 없다.
- 내부 API는 기본 127.0.0.1:4206에서 X-API-Key를 검증한다. 외부 환자 서비스 4205에는 내부 등록 라우트가 없다. 별도 PC용 선택 HTTPS는 기본 4246, 명시한 사설 IPv4, IP 허용목록, 클라이언트 인증서와 API Key가 필요하다.
- PDF 원문은 Agent 내부에만 두고, 외부에는 메타데이터 및 인증 검증값을 둔다. 로컬/외부 경로 검사, 링크·하드링크 차단, 해시 검증, 인증 없는 PDF 차단, WSS 스트리밍 및 no-store를 검증했다. 운영 파일 권한, 프록시의 URL 마스킹·버퍼 정책, 키 보호 저장소는 현장 검증이 필요하다.
- Delphi와 검증 서비스가 버전별 HMAC 키를 보유한다. Agent는 문서 UUID, salt, 검증값, 키 버전을 인수한다. API Key·원본 URL·평문 생년월일을 로그에 남기지 않는다.

## API 확정

Base URL은 로컬 기본 `http://127.0.0.1:4206`이다. 경로는 `/api/v1/internal/health`, `/api/v1/internal/documents` POST, `/api/v1/internal/requests/{requestId}` GET, `/api/v1/internal/documents/{documentId}` GET이다. 요청 JSON·응답·인증·메서드·상태 코드는 [API 명세](DELPHI_AGENT_API_SPEC.md)를 따른다. 기본 30일, 관리자 정책 상한 이내에서 더 짧은 기간을 요청할 수 있다.

HMAC 입력은 공백 없는 UTF-8 JSON 배열 ["pgs-birth-v2","문서 UUID","salt hex","YYYYMMDD"]다. HMAC-SHA256 출력은 64자리 소문자 hex다. 버전별 키는 UTF-8 텍스트 바이트를 사용한다. API 명세에 고정 합성 벡터를 포함했다.

## 실제 검증

| 검증 | 결과 |
|---|---|
| 빌드·정적 검사 | Node 소스, React 번들, TypeScript 엄격 검사 통과 |
| 0~1단계 회귀 | 기존 단위 테스트 8건 통과. 이번 점검에서는 이전 Mock UI의 별도 브라우저 전수 검사를 수행하지 않았다. |
| 2단계 | SQLite 경로·파일·오프라인 삭제 재시도, PGlite PostgreSQL 마이그레이션, WSS 중계·재연결·30일 정책 통합 통과 |
| 3단계 | DB 마이그레이션 및 HTTPS/WSS 인증·세션 통합 통과. Edge 320px에서 로그인, 페이지 이동, 확대, 다운로드 및 종료 통과 |
| 4단계 | 합성 등록, 기본 30일과 단축 요청, 재조회, 미인증·외부 접근·임의 파일 차단, 타임아웃/응답 유실·재시작 복구, mTLS 루프백, 환자 인증 후 동일 PDF 바이트 확인 |
| 실제 Delphi 7 | DCC32 15.0으로 검증용 콘솔 예제를 빌드했다. WinHTTP로 로컬 API에 접속하여 health, 등록, 요청 ID/문서 ID 조회 및 동일 요청 재시도를 실행했다. WideString JSON 파싱 및 같은 URL을 확인했다. |

## 발견한 오류와 보완

1. Delphi 7 WinHTTP POST의 UTF-8 문자셋 파라미터를 기존 엄격 비교가 거절했다. UTF-8 JSON 미디어 타입을 허용하고 UTF-16은 거절하도록 수정했다. 실제 Delphi 7 실행 파일로 POST 및 재시도를 재검증했다.
2. 복구 대기열 앞의 파일 읽기 오류가 나머지 복구를 중단할 수 있었다. 해당 사본에 파일 오류 상태를 기록하고 다음 요청으로 진행하도록 수정했다.

## 5단계 착수 판단

**로컬 합성 데이터로 Delphi 배치 개발에 착수 가능하다.** 내부 REST 계약과 시험 예제는 확정했다. [Delphi 7 콘솔 검증 예제](examples/PgsApiSmoke.dpr)는 API 확인용이며 배치 프로그램의 파일 감시, TMAX 조회, 실제 발송 기능은 포함하지 않는다.

운영 투입 전에는 Delphi 쪽 TMAX 결과 및 발송 중복 방지 계약, 병원 공유 폴더 ACL과 인수·원본 삭제 책임, 인증 키 저장·배포·회전, 별도 PC mTLS 및 Windows 서비스 복구를 확정해야 한다. 실제 운영 Oracle, 병원 SMB, TMAX, KAKAOSEND, 운영 PostgreSQL, Android/iOS/카카오 인앱 브라우저는 이번 점검에서 실행하지 않았다.
## 5-B 전송 운영 기능과 Web Manager

로컬 5-B 프로필에 요청 필터·상세·재처리, 로컬 및 외부 결과 대조, PDF 무결성 확인, WSS 연결 표시와 관리자 로그인·감사·문서 종류·정책·대시보드를 추가했다. PostgreSQL 카탈로그에 004_manager, Agent SQLite에 006_agent_metrics를 적용한다. Delphi API 4종의 주소와 요청·응답 계약을 유지했다. 환자 HMAC과 PDF 전송은 기존 구현을 사용한다.

로컬 검증과 검증 범위는 PGS_PHASE_5B_TEST_REPORT.md, 운영 절차는 TRANSFER_AGENT_OPERATION_GUIDE.md와 WEB_MANAGER_GUIDE.md를 참조한다. 운영 전환 항목은 OPEN_ISSUES.md에서 관리한다.
