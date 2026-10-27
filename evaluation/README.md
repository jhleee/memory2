# 평가 실행

`korean-memory.json`과 `gameplay-graph.fixture.json`은 재사용하는 합성 fixture입니다. 나머지 실행 결과·DB·호출 로그는 로컬에서 생성하고 Git에 올리지 않습니다. 과거 상세 평가 자료는 [공개 범위 안내](../docs/evaluation-policy.md)를 확인하세요.

키 없이 실행할 수 있는 예시:

```bash
npm run evaluate:rpg:world-time
npm run evaluate:rpg:world-time:audit
npm run evaluate:rpg:gm-attention
npm run evaluate:rpg:world-evolution
npm run evaluate:rpg:world-evolution:audit
```

장기 플레이는 `npm run evaluate:rpg:longplay:offline`으로 먼저 생성합니다. 후속 engagement·campaign 평가는 선행 DB와 스크립트별 인자가 필요합니다. 평가 스크립트는 docs의 결과 파일을 생성·덮어쓸 수 있으므로 별도 브랜치에서 실행하세요. 원래 실행 ID에 고정된 경로는 그대로 재현되지 않을 수 있습니다.

첫 사용 setup 명령은 fixture만 생성합니다. 새 에이전트 분리·상황 전달·인계를 실제 수행하지 않고 전체 실증 완료라고 보고하지 마세요.

선택적 OpenRouter 테스트에는 환경변수 `OPENROUTER_API_KEY`를 주입합니다. 무료 제공 여부·실패·비용을 확인하세요. 기본 CI는 외부 LLM을 호출하지 않습니다.
