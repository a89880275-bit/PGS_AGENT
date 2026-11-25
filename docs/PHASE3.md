# PGS v2.3 3단계 로컬 검증

## 실행

```powershell
npm run dev:phase3
```

Node.js 24와 PowerShell 7을 사용한다. 이 PC의 오프라인 의존성 설정은 README의 PowerShell 블록과 동일하다. 블록 마지막 명령만 `node --env-file-if-exists=.env scripts/phase2.mjs --phase3`로 실행한다.

- Agent UI는 https://127.0.0.1:4195/agent, 관리자는 https://127.0.0.1:4195/admin 이다.
- 루프백 Agent 내부 API는 http://127.0.0.1:4196, Agent→중계 HTTPS/WSS는 4444 포트다.
- 인증서는 `.local/phase3/tls/cert.pem`이다. CLI에서 이 인증서를 대상으로만 신뢰한다. 시스템 전체의 TLS 검증을 끄지 않는다. 자동 브라우저 테스트는 루프백 인증서를 사용하는 격리된 컨텍스트에서 실행한다.
- 기본 데이터와 키는 `.local/phase3/`에 둔다. 2단계 프로필은 `.local/phase2/`에 유지한다. 업그레이드는 중지된 2단계 DB와 Agent 저장소의 복제본을 각각 `PGS_PGLITE_DIR`, `PGS_STORAGE_DIR`로 지정하고 복제본의 기존 `PGS_LINK_SECRET`, `PGS_SUBJECT_SECRET`을 유지한 상태에서 실행한다. 3단계 DB 복제본을 2단계 런타임에서 다시 열지 않는다.
- 기존 북마크를 그대로 유지하려면 기존 origin도 유지한다. 별도 3단계 기본 포트에서는 이전 `/v/` 경로와 토큰이 호환된다.
- `PGS_WEB_TLS=0`은 명시적 루프백 시험 예외다. 일반 3단계 실행은 HTTPS다.

## 합성 데이터와 단계

1. Agent **수동등록**에서 `0100111120261124a01.pdf` 합성 PDF를 내려받고 해당 파일을 선택한다. 파일명과 합성 환자 확인 후 내부 저장 및 등록을 실행한다.
2. READY의 보안 링크를 연다. 발급된 경로는 `/g/<opaque-token>`이며 문서 제목은 확인 후 표시된다.
3. 합성 생년월일 `19550203`으로 인증한다. 다른 합성 레코드는 환자번호 `00001234`, 생년월일 `19600229`를 사용한다. 테스트 파일의 이름을 `0000123420261124a01.pdf`로 바꾸어 등록할 수 있다.
4. 조회 화면에서 확대, 축소, 페이지 이동, 다운로드 및 조회 종료를 확인한다. 같은 링크에서 틀린 날짜를 5회 넣으면 30분 잠긴다.
5. 관리자 문서 목록에서 링크 발급 상태, 링크 확인·복사, 재발급·폐기를 사용한다. 재발급 후 이전 링크 및 세션은 사용할 수 없다. 환자 세션 만료 시 **다시 인증**을 눌러 생년월일을 입력한다.

## API 호출 예제

PowerShell에서 먼저 `$pgsWeb = 'https://127.0.0.1:4195'`를 설정한다. `$pgsToken`에는 발급받은 합성 링크의 마지막 경로 조각을 넣는다.

```powershell
curl.exe --cacert .local/phase3/tls/cert.pem -c .local/pgs-cookie.txt -H "Origin: $pgsWeb" -H "Content-Type: application/json" --data ('{"token":"' + $pgsToken + '","birthDate":"19550203"}') "$pgsWeb/api/v1/patient/verify"
curl.exe --cacert .local/phase3/tls/cert.pem -b .local/pgs-cookie.txt "$pgsWeb/api/v1/patient/session"
curl.exe --cacert .local/phase3/tls/cert.pem -b .local/pgs-cookie.txt -o .local/synthetic-guide.pdf "$pgsWeb/api/v1/patient/download"
curl.exe --cacert .local/phase3/tls/cert.pem -b .local/pgs-cookie.txt -H "Origin: $pgsWeb" -H "Content-Type: application/json" --data '{}' "$pgsWeb/api/v1/patient/logout"
```

내부 요청 결과는 `GET http://127.0.0.1:4196/internal/v1/requests/<requestId>`에 Agent 전용 `PGS_HIS_SECRET`을 Bearer로 제공한다. 이 시험 키는 `.local/phase3/agent-secrets.env`에 있다. 쿠키 파일은 로컬 테스트 후 제거한다. 운영 API 및 응답 규격은 [API 계약](API_SPEC.md)을 참조한다.
