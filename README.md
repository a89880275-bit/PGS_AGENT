# PGS 환자 모바일 PDF 안내문 · v2.3

3단계 환자 인증과 조회를 기본 개발 대상으로 제공한다. 실행은 `npm run dev:phase3`이다. [3단계 실행과 API 예제](docs/PHASE3.md)를 참조한다.

아래는 2단계 회귀 프로필 안내다. Agent만 합성 PDF 원본을 저장한다. 중계 서비스는 PostgreSQL에 메타데이터를 기록하고 Agent가 시작한 WSS 연결을 통해 PDF를 전달한다. 기본 PDF 보관 및 링크 유효기간은 각각 **30일(720시간)**이다. 기존 React 화면과 0~1단계 회귀 프로필이 함께 있다.

## Windows 실행

Node.js 24와 PowerShell 7이 필요하다. 승인된 의존성이 이미 설치돼 있으면 PGS 폴더에서 실행한다. 준비된 npm 캐시로 복원하는 명령은 `npm install --offline`이다.

```powershell
npm run dev:phase2
```

런처는 무작위 로컬 비밀값과 루프백용 인증서를 생성하고 React 빌드, 웹·중계, Agent를 실행한다. 데이터와 테스트 인증서는 Git에서 제외한 `.local/phase2/`에 둔다. 종료는 Ctrl+C다. Agent 저장 위치를 바꾸려면 `PGS_STORAGE_DIR`에 웹 공개 경로·클라우드 동기화 경로 밖의 승인된 경로를 사용한다. 로컬 비밀 파일·Agent Storage에는 현재 계정 및 서비스 계정만 접근할 수 있도록 Windows ACL을 확인한다.

### 이 PC에서 외부 패키지 설치 없이 재실행

```powershell
$env:PGS_UI_MODULES = 'C:/Users/user/Documents/ChatGPT/Postgre Interface/apps/web/node_modules'
$env:PGS_DB_MODULES = 'C:/Users/user/Documents/ChatGPT/Postgre Interface/database/node_modules'
$env:PGS_RUNTIME_MODULES = Join-Path (Split-Path (Split-Path (Get-Command node).Source)) 'node_modules'
$env:PGS_PDFJS_DIR = Join-Path $env:PGS_RUNTIME_MODULES 'pdfjs-dist'
node --env-file-if-exists=.env scripts/phase2.mjs
```

기본 실행은 내장 PostgreSQL 엔진 PGlite를 사용하고 동일 SQL을 적용한다. PostgreSQL 17 서버로 별도 확인하려면 로컬에 이미지와 `pg` 패키지를 준비한 뒤, disposable 비밀번호를 설정하고 Compose를 시작한다.

```powershell
$pgsLocalPassword = [guid]::NewGuid().ToString('N')
$env:PGS_LOCAL_DB_PASSWORD = $pgsLocalPassword
docker compose up -d postgres
$env:PGS_DATABASE_URL = "postgresql://pgs_local:${pgsLocalPassword}@127.0.0.1:55432/pgs_local"
npm run dev:phase2
```

런처 부팅 시 로컬 마이그레이션이 적용된다. 기존 DB에 이미 접속하는 경우 해당 DB의 비밀번호를 사용한다. 개발 환경에서 DB 접속은 루프백 주소만 허용한다. `npm run dev`는 0~1단계 메모리 회귀 프로필이며 기본 포트 4173에서 제공한다.

| 구성 | 주소 | 테스트 |
|---|---|---|
| Agent | [Agent](http://127.0.0.1:4180/agent) | **수동등록 → 합성 PDF 받기 → 파일 선택 → 파일명 분석 및 환자 확인 → 내부 저장 및 등록**. READY, 문서별 만료, WSS 및 저장소 지표 확인 |
| 관리자 | [관리자](http://127.0.0.1:4180/admin) | **환경설정**에서 기본 기간 변경, **안내문 종류**에서 종류별 변경, **안내문 관리**에서 변경 전 문서의 기한 비교 및 중계 미리보기 |
| 환자 | Agent의 READY 결과 또는 관리자 **링크 열기** | 합성 생년월일 `19550203`, PDF.js 페이지 이동·다운로드. 링크 교체·차단 및 Agent 종료 후 안내 확인 |
| 내부 Agent API | `http://127.0.0.1:4181/internal/v1/requests/:requestId` | 같은 요청 ID 재조회. 로컬 UI 테스트 API와 운영 HIS API 설계를 구분 |
| Agent HTTPS/WSS | `https://127.0.0.1:4443`, `wss://127.0.0.1:4443/api/v1/agent/connect` | 루프백 TLS, Agent 자격증명과 CA 확인 |
| 삭제 시연 | [삭제 관리](http://127.0.0.1:4180/admin#deletion) | 시험 시간으로 만료 경계를 지난 데이터에 삭제 작업 실행. 오프라인 작업 결과는 재연결 후 동기화 |

## 구조와 검증

- `apps/phase2/` — 메타데이터 DB, HTTPS/WSS 및 로컬 테스트 라우트
- `apps/transfer-agent/` — 파일명 파서, Mock 조회, 원자적 내부 저장, SQLite, Agent API와 UI
- `apps/api-server/mock/`, `apps/admin-web/`, `apps/patient-web/` — 기존 UI와 2단계 로컬 시연
- `database/migrations/` — PostgreSQL 스키마 및 보관기간 기본값 변경
- `tests/` — 기존 테스트와 DB·저장소·프로세스 통합·Edge 검증

`npm run build`, `npm run typecheck`, `npm test`로 기존 검증을 실행한다. 빌드 후 `node tests/phase2-db.mjs`, `node tests/phase2-storage.mjs`, `node tests/phase2-integration.mjs`를 실행한다. `PGS_RUN_LOAD=1`을 설정하면 1,000건 부하를 함께 검증한다. 인증서가 없으면 통합 테스트가 PowerShell로 생성한다. 실행 중인 테스트 서버를 대상으로 `PGS_BROWSER_EXE`와 `PGS_BROWSER_MODULES`를 설정하고 `node tests/phase2-browser.mjs`를 실행한다. `PGS_SCREENSHOTS`는 화면 캡처 경로다.

[요구사항](docs/REQUIREMENTS.md) · [아키텍처](docs/ARCHITECTURE.md) · [DB](docs/DATABASE.md) · [API](docs/API_SPEC.md) · [보안](docs/SECURITY.md) · [검증](docs/TEST_PLAN.md) · [변경 기록](CHANGELOG.md) · [미확정 사항](OPEN_ISSUES.md)
## 4단계 Delphi 연동

npm run dev:phase4로 실행한다. 기본 웹은 https://127.0.0.1:4205 이다. [실행과 Mock 등록](DELPHI_INTEGRATION_GUIDE.md) · [API 계약](DELPHI_AGENT_API_SPEC.md) · [검증](PHASE_4_TEST_REPORT.md)
