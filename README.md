# memory2

LLM Game Master가 여러 세션에 걸쳐 같은 세계를 운영하도록 돕는 TypeScript·SQLite 기반 TRPG MCP 서버입니다. 세계 설정, 행동 결과, 기억, 복선, 세계 시간을 영속화합니다. GM의 서술과 서버에 확정된 사실을 구분합니다.

현재 버전은 **0.4.0, RPG MCP 도구 25개**입니다. 서버가 GM을 자동 실행하지는 않습니다. MCP 호스트에 연결한 에이전트가 도구를 사용해 플레이를 진행합니다. 별도 웹 플레이 UI와 완성된 TRPG 룰북은 제공하지 않습니다.

## 빠른 시작

Node.js **22.12 이상**과 npm이 필요합니다. 로컬 검증 환경은 Node.js 24입니다. `better-sqlite3`의 사전 빌드가 없는 환경에서는 네이티브 빌드 도구가 필요할 수 있습니다.

```bash
git clone https://github.com/jhleee/memory2.git
cd memory2
npm ci
npm run typecheck
npm test
npm run db:seed:sample
npm run dev:mcp:stdio
```

샘플 생성 명령이 Game·Release·actor ID를 출력합니다. 기본 DB는 실행 디렉터리의 `rpg.db`입니다. 이 파일은 Git에 올리지 않습니다. `.env.example`은 변수 안내이며 자동으로 읽지 않습니다.

빌드 후 MCP 호스트의 stdio 설정 예시입니다. 경로를 실제 절대 경로로 바꾸세요.

```json
{
  "mcpServers": {
    "memory2": {
      "command": "node",
      "args": ["/absolute/path/memory2/dist/scripts/rpg-server.js", "--stdio"],
      "env": {
        "RPG_DB": "/absolute/path/memory2/rpg.db",
        "RPG_LOCAL_USER": "developer"
      }
    }
  }
}
```

로컬 HTTP 연결은 아래처럼 실행합니다. MCP 주소는 `http://127.0.0.1:3000/mcp`, 인증은 `Authorization: Bearer local-test-token`입니다.

```bash
RPG_DEV_TOKEN=local-test-token npm run dev:server
```

개발 토큰은 루프백 개발용입니다. 원격 운영에는 HTTPS와 외부 IdP의 issuer·audience·JWKS 설정이 필요합니다. 서버 자체가 OAuth 인증 서버를 제공하지 않으며, 운영 배포 검증은 별도로 필요합니다.

IdP가 없는 소규모 운영 배포는 `RPG_BEARER_TOKEN`과 HTTPS `RPG_PUBLIC_URL`을 비밀 관리자로 주입해 실행할 수 있습니다. 이 모드는 단일 운영자 정체성을 사용하므로 다중 사용자 운영에는 OIDC를 사용하세요.

Docker 이미지는 루트에서 빌드하고 `/data`를 영속 볼륨으로 마운트합니다.

```bash
docker build -t memory2 .
docker run --rm -p 3000:3000 -v memory2-data:/data \
  -e RPG_BEARER_TOKEN="$(openssl rand -hex 32)" \
  -e RPG_PUBLIC_URL=https://memory.example memory2
```

## 구현 범위

- 검증한 세계 초안을 불변 Release로 발행하고 캠페인 Game에 고정합니다.
- 새 인물·도시·종교·집단·던전·사건은 캠페인 overlay로 제안·검토·확정합니다. 참조·타입·경계 검증을 적용합니다.
- 행동, 사건, 기억, 출처와 스냅샷을 저장하고 재시도 멱등성·권한·revision을 검사합니다.
- GM 전용 복선·약속·TODO·결과 메모를 기록하고, 회수 제안의 빈도와 노출 예산을 제한합니다.
- 선택적으로 세계 시간을 켜고 활동별 시간 비용, 비공개 마감 결과, 파티의 관측 시점을 분리합니다.
- 기존 context-memory의 검색·그래프·평가 도구도 포함합니다. 기존 `context-memory` CLI 이름은 호환성을 위해 유지합니다.

## 현재 한계와 평가

자동 테스트는 저장·권한·MCP 계약을 검사합니다. 서사의 의미 정합성과 사람의 재미는 별도의 검증이 필요합니다. 현재 알려진 한계는 다음과 같습니다.

- 첫 플레이 행동 뒤에는 세계 시간을 새로 활성화할 수 없습니다. 시간 제한을 쓸 캠페인은 시작 전에 설정하세요.
- 이전 미확인 사실과 새 확정 사실, 변경 전 묘사가 함께 남을 수 있습니다.
- 지리 연결은 잠금·통행 조건을 자동으로 표현하지 않습니다.
- NPC 동행의 실제 이동, 소지 문서 inspect, 큰 응답의 압축에 보완이 필요합니다.

이 항목은 아직 수정 완료가 아닙니다. [수정 과제](docs/known-issues.md)에 후속 작업을 기록했습니다.

## 문서와 개발

- [문서 안내](docs/README.md)
- [구조와 상태 경계](docs/architecture.md)
- [개발 참여](CONTRIBUTING.md) · [에이전트 작업 지침](AGENTS.md) · [변경 이력](CHANGELOG.md)
- [평가 실행과 공개 범위](docs/evaluation-policy.md)

```text
src/           메모리 기반 모듈과 src/rpg/ 도메인·MCP 서버
migrations/    순서대로 적용하는 SQL 마이그레이션
scripts/       실행·시드·백업·평가·저장소 검사
tests/        단위·통합·MCP 계약·권한·재생 검사
docs/         설계, 운용 안내, 평가 결과와 근거
 evaluation/   재사용하는 평가 fixture; 새 실행 데이터는 로컬 생성
.github/       CI, 의존성 업데이트, 이슈·PR 양식
```

```bash
npm run repo:check
npm run typecheck
npm test
# API 키 없이 실행하는 선택 평가
npm run evaluate:rpg:world-time
npm run evaluate:rpg:world-time:audit
```

일부 과거 평가 명령은 앞선 평가의 DB를 필요로 합니다. [평가 데이터 안내](evaluation/README.md)를 확인하세요. OpenRouter 호출은 선택 사항이며 키는 환경변수로만 주입합니다. 지정 모델은 `recursive/flint-v1.0:free`와 `inception/mercury-decide:free`이며 무료 제공 여부와 가용성은 공급자가 변경할 수 있습니다. 기본 CI는 외부 LLM을 호출하지 않습니다.

이 저장소는 `jhleee/context-memory` 기반 구현을 이관했습니다. [출처](NOTICE.md)에 원본 커밋과 보존 문서를 기록했습니다. 별도 라이선스는 아직 지정하지 않았습니다.
