# v2.3 API와 중계 계약

| 메서드 / 경로 | 인증과 결과 |
|---|---|
| POST `/api/v1/documents` | Agent HTTPS Bearer 및 Agent ID. JSON 메타데이터만 허용. 201 신규, 200 재시도, 파일·추가 필드·multipart 거절 |
| POST `/api/v1/documents/:id/activate` | Agent가 확정 정책을 로컬에 복제한 후 활성화 |
| GET `/api/v1/requests/:id` | 소유 Agent의 결과 조회. 미완료 202, READY 200 |
| WSS `/api/v1/agent/connect` | Agent가 먼저 연결. Bearer와 Agent ID 및 서버 TLS 인증서 확인 |
| GET `/api/v1/patient/pdf`, `/api/v1/patient/download` | 로컬 문서별 테스트 세션 확인 후 스트림, 다운로드는 attachment |
| POST/GET `/internal/v1/requests[/:id]` | Agent 로컬 합성 파일 등록 및 요청 상태. 운영 HIS 계약은 후속 |
| POST `/mock/policy`, GET `/mock/state` | 루프백 테스트 관리자 세션. 정책 변경 및 문서 상태 |
| POST `/api/v1/cleanup`, POST `/api/v1/documents/:id/deleted` | Agent의 인증정보 정리 요청 및 삭제 결과 재동기화 |

메타데이터는 documentId, agentId, requestId, documentCode, fileSize, fileHash, createdAt, patientKey(HMAC), birthVerify(문서별 테스트 HMAC)다. 파일명 날짜에는 시각이 없으므로 시연의 createdAt은 Agent 처리 시각을 사용한다. 등록 응답의 최초 단계에는 URL이 없다. READY는 문서 ID, 링크, 확정 시각 및 기간·정책 버전이다.

WSS는 HELLO/HEARTBEAT → FETCH → META → 바이너리 CHUNK → END를 사용한다. FETCH는 요청 UUID, 문서 UUID, Agent UUID, 시간 제한, HMAC 권한증표를 담는다. CHUNK는 요청 UUID 36B + big-endian 순번 4B + 데이터 최대 64KiB다. ACK는 META와 각 CHUNK의 수신을 제어하고 ERROR/CANCEL은 요청 단위로 정리한다. 범위 요청은 `Accept-Ranges: none`이며 전체 응답은 200과 Content-Length를 사용한다.

401/403은 인증·권한, 404는 대상 없음, 409는 동일 요청 충돌, 410은 만료·차단, 503은 Agent 오프라인 등 사용 불가, 504는 응답 지연이다. 스트림 도중 실패는 응답을 종료한다. 2단계 테스트의 /mock/patient 경로는 3단계 프로필에서 차단한다.
## 3단계 환자 API

| 메서드 및 경로 | 입력과 결과 |
|---|---|
| POST /api/v1/patient/verify | token, birthDate. 재인증 Cookie가 있으면 token을 생략할 수 있다. 성공 응답에는 name, expiresAt, sessionExpiresAt만 포함하며 세션 쿠키를 설정 |
| GET /api/v1/patient/session | 현재 문서의 비식별 제목과 링크·세션 만료시각 |
| GET /api/v1/patient/pdf 및 /download | 쿠키에 연결된 문서만 제공, Content-Length 및 Accept-Ranges: none |
| POST /api/v1/patient/logout | JSON 빈 객체. 세션을 폐기하고 쿠키와 진행 중 해당 세션 스트림을 종료 |
| POST /api/v1/documents/:id/link 및 /reissue | 로컬 관리자 세션과 정확한 Origin. Agent용 서명 증표 반환 |
| POST /api/v1/documents/:id/revoke | 세션을 폐기하고 링크·진행 중 스트림을 차단 |
| POST HTTPS Agent /api/v1/documents/:id/reissue | Agent Bearer, 서명 증표 grant 및 tokenHash. 문서·세대·용도 검증 |

3단계 Agent 등록에는 tokenHash, birthSalt, keyVersion이 추가된다. Agent HTTPS 요청 조회는 세대와 활성 해시를 반환하며, 내부 Agent 조회가 암호화 저장소와 대조한 뒤 URL을 반환한다. 잘못된 날짜 401, 만료·위조 링크 410, 잠금·속도 제한 429, 권한·origin 오류 403이다. 세션 만료는 401로 처리한다. 호출 예제는 [3단계 실행 가이드](PHASE3.md)에 있다.
