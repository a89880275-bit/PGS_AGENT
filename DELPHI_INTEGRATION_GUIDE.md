# Delphi 배치 프로그램 연동

Delphi는 파일 감지, 환자번호 추출, TMAX 조회, 인증 검증값 생성과 후속 발송을 담당한다. PGS Agent는 지정 폴더의 파일 인수, 저장, 메타데이터 전송 및 링크 발급을 담당한다. 외부 서버에서 Delphi로 연결하거나 실행하는 API는 없다.

1. 합성 또는 승인된 문서가 작성 중인 동안 임시 확장자로 보관한다. 쓰기를 닫고 SHA-256을 계산한 뒤 공유 인수 폴더 안에서 최종 .pdf 이름으로 변경한다.
2. 요청 ID와 문서 UUID, 검증값, 파일 해시를 Delphi의 보호된 대기열에 저장한다. 지정된 공유 폴더에서 전달할 값은 basename이다.
3. 같은 PC에서 `http://127.0.0.1:4206/api/v1/internal/documents`를 호출한다. 문서와 활성 URL이 READY일 때만 Delphi가 다음 업무로 진행한다. 응답을 놓치면 GET으로 상태와 활성 URL을 재조회한다.
4. 인수 후 원본 정리는 Delphi와 병원 정책이 담당한다. Agent는 자체 사본과 확정 만료일을 관리한다.

## 실행과 공유 폴더

`npm run dev:phase4` 또는 README의 로컬 의존성 설정 후 `node scripts/phase2.mjs --phase4`로 실행한다. Agent 웹은 https://127.0.0.1:4205/agent 이다. 기본 공유 인수 위치는 `.local/phase4/agent/Incoming`이다. 서비스 관리자가 `PGS_INTAKE_DIR`에 승인된 공유 마운트 또는 UNC 경로를 지정할 수 있다. 서비스 계정은 해당 폴더에 최소 읽기 권한을 받는다. 등록 요청으로 폴더를 바꿀 수 없다. 쓰기 계정을 Delphi로 제한하고 재분석 지점 또는 링크를 두지 않는다.

`node scripts/mock-delphi.mjs`는 합성 PDF를 준비하고 새 REST 계약으로 등록한다. 합성 테스트의 환자 생년월일은 19550203이다. `--prepare` 플래그는 curl용 JSON만 준비한다. 현재 개발 프로필은 승인된 합성 PDF 해시를 검사한다.

## 별도 PC

선택 HTTPS 리스너는 Agent의 명시적인 사설 IPv4 주소 `PGS_INTERNAL_TLS_HOST`와 포트 `PGS_INTERNAL_TLS_PORT`(기본 4246)에만 바인딩된다. `PGS_INTERNAL_TLS_ALLOWLIST`에 Delphi PC IP를 지정하고 `PGS_INTERNAL_TLS_CERT`, `PGS_INTERNAL_TLS_KEY`, `PGS_INTERNAL_TLS_CLIENT_CA`로 인증서를 설정한다. 요청 Host는 설정한 IP:포트와 일치해야 한다. 서버 인증서에는 해당 IP SAN이 필요하다. 이 리스너는 상호 TLS 및 X-API-Key를 모두 확인하고 내부 네 엔드포인트만 처리한다. 기관 방화벽에서 사설망 접근만 허용한다. 루프백 HTTP는 동일 PC용이다. 실제 SMB 서버·별도 PC·병원 인증서는 현장 승인 후 검증한다.

## 추후 Multipart

현재 등록 처리기는 인수 파일을 읽는 단계와 문서 등록 단계를 분리한다. Multipart를 추가할 때 별도 미디어 타입 입력 어댑터에서 허용량을 제한하고 임시 파일을 격리한 뒤 검증된 SHA-256과 같은 등록 파이프라인으로 넘긴다. 요청 ID의 지문, 인증 및 만료 규칙을 공유한다. 현재 엔드포인트는 JSON만 수락한다.
## Delphi 적용 전 추가 검증

- HMAC 입력과 UTF-8 바이트, 기대값 및 합성 PDF 해시는 [고정 벡터](DELPHI_CRYPTO_TEST_VECTORS.md)에서 확인한다. Delphi에서 계산한 결과가 준비되면 PGS 폴더에서 node scripts/verify-delphi-vector.mjs 뒤에 64자리 hex 값을 전달한다.
- PGS_FILENAME_PATIENT_DIGITS 기본값은 8이다. 변경 시 파일명 처리와 환자번호 검색이 같은 자릿수를 사용하도록 Agent와 중계 프로필을 동일 설정으로 재시작한다. patientNo는 JSON 문자열로 전달하고 앞자리 0을 유지한다.
- Delphi는 HIS 파일명 식별코드를 해석해 API documentType을 결정한다. 기존 PGS_FILENAME_TYPE_MAP의 시연값 a01 → G001, a02 → G002는 이전 파서의 설정이다. Delphi 경로에는 자동 변환이나 매핑 CRUD가 없다. 실제 표는 병원 측 확인 후 Delphi의 환경설정으로 유지한다.
- Delphi의 내부 API 주소는 환경 설정에서 분리할 수 있다. 기본은 로컬 127.0.0.1:4206이고 별도 PC는 승인된 내부 HTTPS/mTLS 주소를 사용한다. 현재 PGS가 반환하는 guideUrl과 outbound 중계 URL은 로컬 호스트로 구성되므로 운영 공개 URL로 자동 전환되지 않는다. 운영 공개 환자 origin 및 중계 대상 분리 구현·검증은 배포 승인 범위에 남아 있다.
- 요청 ID와 최초 JSON을 같이 보존한다. 응답 유실이나 타임아웃이면 같은 ID로 조회하고, 404일 때만 최초 JSON을 재제출한다. 상태별 결과는 [API 검증 보고서](DELPHI_API_TEST_REPORT.md)에 있다.
