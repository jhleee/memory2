# 변경 이력

## ChatGPT 터널 프로토콜 협상 — 2026-10-28

- MCP v2 서버 패키지로 전환해 ChatGPT Secure MCP Tunnel의 `2026-07-28` `server/discover`와 현대식 `tools/list` 요청을 네이티브로 제공합니다.
- 같은 엔드포인트에서 2025 계열 stateless 초기화도 계속 지원하며, HTTP 본문 제한·bearer/OIDC 인증·stdio 실행을 유지합니다.
- 터널이 생략하는 SEP-2243 미러 헤더를 인증된 JSON-RPC envelope에서 복원해 최신 discovery가 구형 초기화로 잘못 후퇴하지 않게 했습니다.

## OpenAI Secure MCP Tunnel 배포 — 2026-10-27

- OpenAI 공식 터널 클라이언트의 고정 버전 Compose 구성과 Coolify 배포 환경변수 예시를 추가했습니다.
- 기존 운영 bearer를 MCP 서버에만 정적 헤더로 전달하고 터널 헬스·control-plane 연결을 검사하도록 구성했습니다.
- 개인용 터널 연결과 사용자별 공개 OAuth 연결의 적용 범위를 문서화했습니다.

## ChatGPT 연결 준비 — 2026-10-27

- OAuth resource metadata와 401 scope challenge, 도구의 읽기·변경 annotations를 추가했습니다.
- HTTPS 리버스 프록시·비루트 컨테이너·영속 SQLite 볼륨 배포 구성과 연결·GM 운영 안내를 추가했습니다.
- 공개 서버 배포와 실제 ChatGPT OAuth 로그인은 별도 설정 후 검증해야 합니다.


## OpenRouter 무료 모델 갱신 — 2026-10-27

- 종료된 `inception/mercury-decide:free` 대신 OpenRouter Decisions API에서 실제 가용한 `baseten/mammoth-1:free`를 기본 판단 모델로 지정했습니다.
- 라이브 평가 스크립트가 `OPENROUTER_GM_MODEL`과 `OPENROUTER_DECISION_MODEL`을 일관되게 사용하도록 했습니다.

## 운영 배포 구성 — 2026-10-27

- Node.js 24 기반 다중 단계 Docker 빌드와 `/data` SQLite 영속 볼륨, 헬스 체크를 추가했습니다.
- IdP가 없는 소규모 HTTPS 배포에서 사용할 수 있도록 개발 토큰과 분리된 `RPG_BEARER_TOKEN`과 `RPG_PUBLIC_URL`을 추가했습니다.
- 운영 의존성의 `body-parser`, `fast-uri`, `ip-address` 보안 업데이트를 잠금 파일에 반영했습니다.

## 의존성 검토 — 2026-10-27

- Node 타입 24.19.2, TypeScript 7.0.2와 Zod 4.6.7을 적용했습니다.
- Zod 4의 record API와 MCP 입력 shape에 맞춰 이관하고 시간 비용 기본값의 입력 파싱을 유지했습니다.
- GM 메모 생성 기본값과 부분 수정 스키마를 분리해 제목만 수정할 때 기존 중요도·연결·라벨이 초기화되지 않도록 했습니다.
- 기존 Zod 3 합성 시작 상태의 정규화·해시, 중첩 검증, 시간 비용 및 MCP 멱등 재시도를 회귀 검사합니다.

- MCP SDK 1.32.2, Vitest 5.0.5와 checkout/setup-node v7을 검토해 적용했습니다.
- Vitest의 검색 대상을 원본 tests 디렉터리로 제한해 dist의 중복 실행을 방지합니다.
- Node 24 기준 개발 환경에 맞춰 `@types/node` 24 계열을 유지하고 타입만 올리는 메이저 업데이트를 보류합니다.
- CI에 최소 지원 Node 22.12.0과 Node 24 매트릭스를 추가했습니다.

## 저장소 이관 — 2026-10-27

- memory2 저장소 메타데이터, 시작 안내, 개발·에이전트 지침, CI와 이슈·PR 양식을 추가했습니다.
- 합성 평가 fixture와 실행 스크립트를 보존했습니다. 공개 검토에서 차단된 상세 평가 자료와 실행 DB·빌드·로그는 제외했습니다.
- 제품 동작 버전은 0.4.0을 유지합니다. 첫 사용 평가의 수정 과제는 미해결 상태입니다.

## 0.4.0

- 세계 시간, 활동별 시간 비용, 비공개 마감 결과와 관측을 추가했습니다.
- 첫 사용 에이전트·인계 평가를 기록했습니다. 평가 도구 추가는 해당 제품 문제의 수정이 아닙니다.

## 이전 구현 단계

- GM 전용 복선·TODO와 주의 예산, 세계 확장 제안·검토·확정, 캠페인 상태·기억·MCP 도구를 순차 구현했습니다.
- 과거 변경의 상세 근거는 docs의 구현 현황과 주제별 평가 보고서에 있습니다. 이관 시 확인하지 못한 릴리스 날짜·태그는 기재하지 않습니다.
