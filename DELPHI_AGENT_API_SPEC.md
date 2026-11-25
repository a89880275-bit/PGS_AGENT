# Delphi 7 → PGS 내부 REST API

기본 호출 주소는 `http://127.0.0.1:4206`이다. 네 API 모두 `X-API-Key: <내부 API 키>`를 요구한다. 브라우저 Origin이 있는 요청은 거절한다. 외부 환자 Web/API 주소는 이 경로를 제공하지 않는다.

| 메서드와 경로 | 역할 |
|---|---|
| GET /api/v1/internal/health | Agent와 외부 중계 연결 상태 |
| POST /api/v1/internal/documents | 승인된 공유 폴더의 PDF 인수와 등록 |
| GET /api/v1/internal/requests/{requestId} | 요청 ID로 등록 상태 및 활성 링크 조회 |
| GET /api/v1/internal/documents/{documentId} | 문서 UUID로 상태 및 활성 링크 조회 |

## 등록 JSON

```json
{
  "requestId": "DELPHI-000001",
  "fileName": "guide-000001.pdf",
  "fileSha256": "<PDF SHA-256 소문자 hex 64자리>",
  "documentType": "G001",
  "birthVerifier": {
    "documentId": "1c2d3e4f-1111-4222-8333-abcdef123456",
    "salt": "<OS CSPRNG 32바이트의 소문자 hex 64자리>",
    "value": "<HMAC-SHA256 소문자 hex 64자리>",
    "keyVersion": 2
  },
  "retentionDays": 30,
  "patientNo": "01001111"
}
```

POST는 `Content-Type: application/json`을 사용한다. 필수 필드는 requestId, fileName, fileSha256, documentType, birthVerifier다. requestId는 영문·숫자·밑줄·하이픈 1~100자이며 환자 식별값을 포함하지 않는다. 파일명은 평면 공유 폴더의 ASCII basename과 .pdf 확장자를 사용한다. 크기 상한은 PDF 기본 10 MiB, JSON 4 KiB다. 문서 종류는 G001/G002다. 환자번호는 선택이며 기본 8자리이고 Agent에서 검색용 HMAC 식별값으로 변환한다.

retentionDays는 선택이며 정수 1~90이다. 생략하면 문서 종류별 또는 시스템 기본 정책을 따른다. 기본 PDF와 링크는 각각 30일이다. 요청값은 관리자 보관 정책 이내에서만 적용되며 링크는 확정 보관기간 이내다. 시작 시 확정한 기한을 재요청·재발급에서 연장하지 않는다.

## 응답 JSON

```json
{
  "success": true,
  "resultCode": "OK",
  "message": "처리가 완료되었습니다.",
  "requestId": "DELPHI-000001",
  "documentId": "1c2d3e4f-1111-4222-8333-abcdef123456",
  "guideUrl": "https://127.0.0.1:4205/g/<opaque-token>",
  "expiresAt": "2026-12-25T01:00:00.000Z",
  "status": "READY",
  "retentionDays": 30,
  "deleteAt": "2026-12-25T01:00:00.000Z"
}
```

신규 READY 201, 동일 등록·정상 조회 200, 준비 중이면 202와 `Retry-After: 3`이다. 모든 내부 API 응답은 기본 7개 필드를 사용하며 해당하지 않는 ID·URL·만료 시각은 null이다. Health에는 agent 및 relay의 ONLINE/OFFLINE 상태가 추가된다. 만료·폐기는 410이며 URL을 반환하지 않는다. 예외는 [오류 코드](DELPHI_API_ERROR_CODES.md)를 참조한다.

타임아웃이나 202 이후에는 원래 requestId로 GET 한다. 404라면 같은 요청 본문으로 POST를 재시도한다. 기존 요청에 다른 파일, 환자번호, 검증값 또는 보관 요청값을 쓰면 409다. 수정본은 새 requestId와 UUID가 필요하다. 링크 재발급 이후에는 권한 있는 호출자에게 새 활성 URL만 반환한다. Delphi는 `success=true`와 `status=READY`, 유효한 guideUrl을 모두 확인한 뒤 자체 업무를 계속한다.

## 생년월일 검증값

Delphi가 소문자 UUID를 미리 만들고 문서마다 OS CSPRNG salt 32바이트를 생성한다. YYYYMMDD가 실제 날짜인지 검사한다. HMAC 입력은 아래 공백 없는 UTF-8 JSON 배열의 바이트다.

```text
["pgs-birth-v2","<소문자 UUID>","<소문자 salt 64자리>","<YYYYMMDD>"]
```

value는 HMAC-SHA256 출력의 소문자 hex 64자리다. key는 해당 버전의 UTF-8 비밀 문자열 바이트이며 로컬 런처의 hex 모양 비밀 문자열도 hex 디코딩하지 않는다. 키는 Delphi와 환자 검증 서비스의 보호 저장소에만 배포한다. Agent는 검증값과 키 버전만 받는다. 키 변경 시 신규 문서에 새 버전을 사용하고, 기존 링크 만료 전까지 이전 키를 검증 서비스에 유지한다. API Key는 이 HMAC 키와 용도 및 저장 위치를 분리한다. 평문 생년월일·API Key·URL을 로그에 남기지 않는다.

## Delphi 7 WinHTTP

```pascal
uses SysUtils, Variants, ComObj;

function PgsCall(const BaseUrl, Verb, Path, ApiKey, Payload: WideString;
  out Status: Integer): WideString;
var H: OleVariant;
begin
  H := CreateOleObject('WinHttp.WinHttpRequest.5.1');
  H.SetTimeouts(1500, 3000, 8000, 35000);
  H.Open(Verb, BaseUrl + Path, False);
  H.SetRequestHeader('X-API-Key', ApiKey);
  if Verb = 'POST' then
  begin
    H.SetRequestHeader('Content-Type', 'application/json');
    H.Send(Payload);
  end
  else
    H.Send(EmptyParam);
  Status := H.Status;
  Result := H.ResponseText;
end;
```

동일 PC BaseUrl은 `http://127.0.0.1:4206`이다. 별도 PC의 승인된 HTTPS 환경에서는 WinHTTP가 요청 전 신뢰 저장소의 서버 CA와 클라이언트 인증서를 사용하도록 구성한다. 필요한 경우 `H.SetClientCertificate`를 Open 후 Send 전에 호출한다. 인증서 확인 옵션은 유지한다. 암호 API는 병원 승인 모듈을 사용한다.

## PowerShell에서 curl 테스트

PGS 폴더에서 실행한다. 기본 로컬 키는 `.local/phase4/agent-secrets.env`의 PGS_HIS_SECRET이다. 별도 `PGS_INTERNAL_API_KEY`를 설정한 경우 해당 값이 우선한다. 아래 명령은 화면에 보여 줄 합성 링크 응답만 사용한다.

```powershell
$pgsBase = 'http://127.0.0.1:4206/api/v1/internal'
$pgsKey = $env:PGS_INTERNAL_API_KEY
if (-not $pgsKey) {
  $pgsKey = (Get-Content .local/phase4/agent-secrets.env | Where-Object { $_ -like 'PGS_HIS_SECRET=*' }).Split('=',2)[1]
}
$fixture = node scripts/mock-delphi.mjs --prepare | ConvertFrom-Json
$pgsHeader = "X-API-Key: $pgsKey"
curl.exe -sS -H $pgsHeader "$pgsBase/health"
curl.exe -sS -H $pgsHeader -H "Content-Type: application/json" --data-binary "@$($fixture.file)" "$pgsBase/documents"
curl.exe -sS -H $pgsHeader "$pgsBase/requests/$($fixture.requestId)"
curl.exe -sS -H $pgsHeader "$pgsBase/documents/$($fixture.documentId)"
```

`/internal/v1/`의 이전 Bearer·JSON 규격은 기존 로컬 클라이언트 호환용이다. 신규 Delphi 배치는 이 문서의 `/api/v1/internal/`과 API Key를 사용한다.
## Delphi 7 JSON 처리 예제

[컴파일 가능한 검증 예제](examples/PgsApiSmoke.dpr)는 별도 JSON 라이브러리 없이 응답의 평면 스칼라 필드와 JSON 문자열 이스케이프를 읽는다. Delphi 7 DCC32로 컴파일하고 로컬 HTTP로 직접 호출했다. 이 예제는 API 확인을 위한 콘솔 프로그램이다. 상용 배치에서는 승인된 JSON 라이브러리와 보호된 작업 저장소를 사용하고, 응답 본문을 원문 로그로 남기지 않는다.

```pascal
Answer := PgsCall(BaseUrl, 'POST', '/api/v1/internal/documents',
  ApiKey, RegistrationJson, HttpStatus);
Reply := ReadReply(Answer);  { TPgsReply, WideString response }
if (HttpStatus = 202) or
   ((HttpStatus = 409) and (Reply.Code = 'REQUEST_BUSY')) then
  { Wait for Retry-After and query the original RequestId. }
  Exit;

if ((HttpStatus = 200) or (HttpStatus = 201)) and Reply.OK and
   (Reply.State = 'READY') and (Reply.GuideUrl <> '') then
begin
  DocumentId := Reply.DocumentId;
  GuideUrl := Reply.GuideUrl;
  ExpiresAt := Reply.ExpiresAt;
end;
```

POST에서 COM 통신 예외나 읽기 타임아웃이 발생하면 원래 requestId로 GET 한다. GET이 404인 경우에만 동일 요청 본문을 다시 POST 한다. GET이 410이거나 200/201이어도 READY가 아니면 발송하지 않는다. 검증 예제는 리디렉션을 비활성화하고 루프백에서 직접 접속한다. WinHTTP가 추가하는 UTF-8 문자셋을 포함해 application/json과 application/json; charset=UTF-8을 수락한다.

합성 HMAC 대조 벡터는 키 텍스트가 pgs-delphi-test-key-v2, UUID가 1c2d3e4f-1111-4222-8333-abcdef123456, salt가 00을 32회 반복한 소문자 hex, 생년월일이 19550203이다. 기대 결과는 아래와 같다.

```text
bb11e8feb570fa8d78971dc8e1844301af73e4e2246e445aa41cefe1eef5f03a
```

검증 예제의 실행 파일에는 API Key를 인수로 전달하지 않는다. 실행 프로세스에서 PGS_INTERNAL_API_KEY를 설정하고, node scripts/mock-delphi.mjs --prepare가 반환한 합성 JSON 파일 경로를 첫 인수로 전달한다. Delphi 7 컴파일러가 경로를 인식하기 어려운 경우 예제와 빌드 결과를 ASCII 경로에서 처리한다.


## 5-B 문서 종류 호환성

기존 포트, 내부 REST API 4종, 인증 헤더, READY 응답 및 HMAC v2의 입력 바이트는 그대로 적용된다. G001/G002는 기본 카탈로그 코드다. 5-B 프로필에서는 시스템 관리자가 사용 승인한 Gnnn 문서코드를 추가할 수 있다. 신규 요청은 카탈로그의 활성 코드와 정책으로 검증한다. 기존 requestId 조회에는 등록 때 확정한 문서 정보와 만료일을 사용한다. 운영 HIS 파일명 코드와의 매핑은 승인 후 Delphi 설정에 적용한다.
