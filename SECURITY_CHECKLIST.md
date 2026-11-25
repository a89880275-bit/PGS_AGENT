# 5-B 보안 체크리스트

- 내부 Delphi API loopback 분리, X-API-Key, Origin 차단, 승인 인수 경로 검사, SHA-256 검증.
- WSS Agent 인증, UUID 기반 문서 조회, Heartbeat, 전송 제한과 연결 종료 정리.
- 환자 HMAC v2, 문서별 세션, 만료·폐기 차단, 토큰 해시, Agent의 암호화된 URL 보관.
- 관리자 HTTPS 세션, API 권한 검사, 감사 이력, 환자 인증 쿠키 분리.
- 외부 PDF 응답 캐시 금지 및 로컬 시험의 외부 PDF 영구 미저장 확인.
- 운영 도입 전 Windows ACL, TLS 인증서 신뢰·교체, 키 회전, 관리자 프로비저닝, 역방향 프록시 로그 가림 및 운영 DB 정책 검증 필요.
