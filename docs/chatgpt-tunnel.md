# OpenAI Secure MCP Tunnel 배포

문서 ID: MEMORY2-TUNNEL-001 / 기준일: 2026-10-27 / 상태: Coolify 배포 구성 준비, 런타임 API 키 주입 후 실제 연결 확인 필요.

## 구성

`deploy/tunnel.compose.yaml`은 OpenAI 공식 `tunnel-client` 이미지를 실행해 기존 memory2 MCP 서버와 ChatGPT 사이에 아웃바운드 터널을 만듭니다. 외부 인바운드 포트는 열지 않습니다.

```text
ChatGPT -> OpenAI control plane <- outbound tunnel-client -> memory2 /mcp
```

현재 기본값은 다음과 같습니다.

| 설정 | 값 |
|---|---|
| 터널 | `tunnel_6ae0c0185e1481918046e7067c701e79` |
| MCP 주소 | `https://qg840oww44wk08o0go4gc0kg.jhlee.me/mcp` |
| 터널 이미지 | `ghcr.io/openai/tunnel-client:v0.0.18` |

터널 클라이언트는 `MCP_RUNTIME_AUTHORIZATION`을 `Authorization` 헤더로 memory2에만 전달합니다. 값은 `Bearer ` 뒤에 서버의 `RPG_BEARER_TOKEN`을 붙인 전체 헤더 값이어야 합니다. OpenAI control plane에는 전달되지 않습니다. 이 구성은 연결된 ChatGPT 사용자들이 동일한 서버 정체성을 공유하므로 개인용·내부 테스트에 적합합니다. 사용자별 격리가 필요하면 공개 HTTPS OAuth 구성을 사용하세요.

## 필요한 비밀

- `CONTROL_PLANE_API_KEY`: 대상 Platform 조직의 런타임 API 키이며 `Tunnels Read + Use` 권한이 필요합니다.
- `MCP_RUNTIME_AUTHORIZATION`: `Bearer 현재_memory2_RPG_BEARER_TOKEN` 형식의 전체 Authorization 값입니다.

터널 ID만으로는 클라이언트를 실행할 수 없습니다. 런타임 키를 일반 OpenAI API 키나 관리자 키와 혼동하지 마세요. 비밀은 저장소 파일에 기록하지 않고 Coolify의 환경변수로 주입합니다.

## Coolify 배포

Coolify에서 이 저장소를 Docker Compose 리소스로 추가하고 Compose 파일 경로를 `/deploy/tunnel.compose.yaml`로 지정합니다. 아래 환경변수 중 두 비밀값을 입력한 뒤 배포합니다.

```dotenv
CONTROL_PLANE_API_KEY=실제_런타임_API_키
CONTROL_PLANE_TUNNEL_ID=tunnel_6ae0c0185e1481918046e7067c701e79
MCP_SERVER_URL=https://qg840oww44wk08o0go4gc0kg.jhlee.me/mcp
MCP_RUNTIME_AUTHORIZATION=Bearer 현재_memory2_bearer_토큰
```

배포 후 컨테이너 상태가 `healthy`인지 확인합니다. 헬스 체크는 로컬 `/readyz`와 control-plane poll 성공을 모두 요구합니다. 실패하면 로그에서 터널 ID·런타임 키 권한·MCP 주소·bearer 토큰을 순서대로 확인하세요.

로컬 Docker에서 Compose 형식만 검증하려면 실제 비밀 대신 임시 문자열을 사용할 수 있습니다. 이 명령은 터널을 실행하지 않습니다.

```bash
CONTROL_PLANE_API_KEY=placeholder \
MCP_RUNTIME_AUTHORIZATION='Bearer placeholder' \
docker compose -f deploy/tunnel.compose.yaml config --quiet
```

## ChatGPT 연결

대상 ChatGPT 워크스페이스가 이 터널과 연결된 Platform 조직에 연계되어 있어야 합니다. ChatGPT에서 Plugins의 추가 버튼을 열고 Add custom MCP server를 선택한 뒤 다음처럼 설정합니다.

1. Connection에서 `Tunnel`을 선택합니다.
2. `tunnel_6ae0c0185e1481918046e7067c701e79`를 선택하거나 붙여 넣습니다.
3. Authentication은 `No authentication`을 선택합니다. 서버 bearer는 터널 클라이언트가 주입합니다.
4. 연결을 만든 뒤 도구를 검색하고, 새 대화에서 캠페인 목록 조회로 읽기 동작부터 확인합니다.

Secure MCP Tunnel은 비공개 테스트와 내부 사용을 위한 연결 방식입니다. 공개 플러그인 제출·배포에는 공개 HTTPS 엔드포인트와 OAuth 구성을 사용하세요.

공식 절차와 권한 요구사항은 [OpenAI Secure MCP Tunnels](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)에서 확인합니다.
