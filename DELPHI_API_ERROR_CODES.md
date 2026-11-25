# Delphi 내부 API 오류 코드

모든 응답은 success, resultCode, message, requestId, documentId, guideUrl, expiresAt을 포함한다. 민감한 요청 본문, 파일 경로, 키, 토큰 및 스택 트레이스는 오류에 넣지 않는다.

| HTTP | resultCode | 호출자 처리 |
|---|---|---|
| 200 / 201 | OK | READY 상태와 활성 링크를 확인 |
| 202 | ACCEPTED | Retry-After에 따라 요청 ID로 조회 |
| 400 | INVALID_REQUEST, INVALID_JSON, INVALID_FILE_NAME, INVALID_DOCUMENT_CODE, INVALID_PATIENT_NO, INVALID_RETENTION_DAYS, UNKNOWN_KEY_VERSION | 본문과 서비스 설정을 확인 |
| 401 | AUTH_REQUIRED | 내부 전용 API Key 확인 |
| 403 | FORBIDDEN, UNSAFE_INTAKE | 호출 경계와 공유 폴더의 파일·ACL 확인 |
| 404 | INTAKE_NOT_FOUND, REQUEST_NOT_FOUND, NOT_FOUND | 파일 인수 또는 문서/요청 경로 확인 |
| 405 | METHOD_NOT_ALLOWED | 허용 메서드 사용 |
| 409 | REQUEST_BUSY, REQUEST_CONFLICT, DOCUMENT_CONFLICT, FILE_CHANGED, FILE_HASH_MISMATCH | 처리 중이면 재조회. 내용이 바뀌면 새 업무 요청 생성 |
| 410 | LINK_UNAVAILABLE | 발송을 보류하고 상태 확인 |
| 413 | INVALID_FILE_SIZE, TOO_LARGE | 본문/파일 크기 확인 |
| 415 | JSON_ONLY, INVALID_PDF, USE_SYNTHETIC_PDF, METADATA_ONLY | JSON 및 합성 시험 PDF 확인 |
| 503 | SERVICE_UNAVAILABLE, TRANSFER_UNAVAILABLE, LINK_SYNC_PENDING, POLICY_SYNC_FAILED 등 | 기존 요청 ID로 재조회. 승인된 장애 대응 절차 사용 |

mTLS에서 인증서가 거절되는 경우 HTTP 교환 자체가 시작되지 않을 수 있다.
## 202, 404, 409, 410 및 호출 타임아웃

- 202 ACCEPTED는 HTTP 오류가 아니다. Retry-After에 따라 기존 requestId를 조회하고 READY 이전에는 후속 발송을 보류한다.
- 404 REQUEST_NOT_FOUND는 조회 기준의 레코드가 없음을 뜻한다. 원래 작업이 확실히 필요하면 같은 POST 본문과 같은 requestId를 사용한다.
- 409 REQUEST_BUSY면 기존 요청을 조회한다. REQUEST_CONFLICT는 같은 ID의 내용이 다르므로 원래 내용 및 업무 목적을 확인한다.
- 410 LINK_UNAVAILABLE은 활성 링크가 없음을 뜻한다. guideUrl은 null이며 발송을 중단한다.
- 호출자 타임아웃에는 HTTP 결과코드가 없다. 성공·실패 여부는 요청 ID 조회로 결정한다. HTTP 408로 기록하지 않는다.

[상황별 실측 결과](DELPHI_API_TEST_REPORT.md)
