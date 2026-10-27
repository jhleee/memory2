# ChatGPT 연결과 배포

문서 ID: MEMORY2-CHATGPT-001 / 기준일: 2026-10-27 / 대상: 0.4.0. 상태: 서버 계약·배포 구성 구현, 실제 ChatGPT OAuth 연결은 배포 후 확인 필요.

## 연결 방식

ChatGPT가 GM을 맡고 이 서버의 MCP 도구로 세계·기억·행동을 저장합니다. ChatGPT 안에서 사용할 별도 OpenRouter GM 키는 필요하지 않습니다. 현재 구현은 stdio와 인증된 Streamable HTTP를 지원합니다. ChatGPT 연결에는 후자의 공개 HTTPS `/mcp` 주소와 외부 OAuth 제공자를 사용합니다.

이 저장소를 GitHub에 올리는 것만으로 서버가 실행되지는 않습니다. 현재 대화의 실행 환경을 영구 호스팅으로 취급하지 않습니다. 익명 공개 모드나 공용 개발 토큰으로 캠페인 소유권을 대체하지 않습니다.

## 준비할 값

| 설정 | 의미 |
|---|---|
| `RPG_PUBLIC_HOST` | 운영 서버로 DNS가 연결된 실제 도메인 |
| `OIDC_ISSUER` | OAuth 제공자가 발급하는 JWT의 정확한 issuer |
| `OIDC_JWKS_URL` | 서명 검증용 실제 JWKS 주소 |
| `OIDC_AUDIENCE` | Compose가 `https://도메인/mcp`로 설정하는 리소스 식별자 |
| `OIDC_SCOPE` | API 접근 scope, 기본값 `rpg` |

OAuth 제공자는 authorization-code + PKCE S256, 발견 문서, 사용자 로그인·동의, 리소스 audience와 scope가 들어간 서명된 access token을 제공해야 합니다. 이 서버는 ID token이나 임의 문자열 API 키를 access token으로 취급하지 않습니다. issuer와 subject 조합으로 사용자를 식별합니다.

ChatGPT 클라이언트 등록은 제공자가 지원하는 CIMD·DCR 또는 사전 등록한 OAuth 클라이언트를 사용합니다. 제공자에 맞춰 실제 ChatGPT 화면에서 표시하는 redirect URI를 등록하세요. 장기 연결에는 refresh token과 해당 제공자의 offline access 설정이 필요합니다. OAuth 로그인·발급·갱신은 외부 제공자에서 처리하며 이 서버는 이를 직접 구현하지 않습니다. [OpenAI 인증 안내](https://developers.openai.com/plugins/build/auth)를 기준으로 설정합니다.

## Docker 배포

Docker Engine과 Compose가 설치된 서버에서 실행합니다. `deploy/.env`는 로컬 운영 설정 파일이며 Git에 올리지 않습니다.

```bash
cp deploy/.env.example deploy/.env
# deploy/.env를 실제 도메인·OAuth 설정으로 수정
docker compose --env-file deploy/.env -f deploy/compose.yaml config --quiet
docker compose --env-file deploy/.env -f deploy/compose.yaml up --build -d
```

DNS가 서버를 가리키고 80·443 포트에 접근할 수 있어야 Caddy가 HTTPS 인증서를 발급합니다. 내부 Node 포트 3000은 외부에 공개하지 않습니다. 서버는 비루트 사용자로 실행합니다. `/data/rpg.db`와 WAL 등은 `game-data` 볼륨에 보존하고 Caddy 인증서도 별도 볼륨에 보존합니다. SQLite이므로 이 구성은 단일 서버 인스턴스를 전제로 합니다.

인증 정보와 실제 도메인이 없으면 Compose 실행을 중단합니다. 개발 토큰은 이 배포 구성으로 전달하지 않습니다. 운영 설정과 비밀을 명령 출력·이슈에 붙여 넣지 마세요.

```bash
curl -fsS https://실제도메인/health
curl -fsS https://실제도메인/.well-known/oauth-protected-resource/mcp
curl -i -X POST https://실제도메인/mcp \
  -H 'Content-Type: application/json' --data '{}'
```

마지막 요청은 로그인 전이므로 401과 `WWW-Authenticate`의 실제 metadata URL·scope를 반환해야 합니다. metadata의 `resource`는 연결할 `/mcp` 주소와 같아야 합니다. 루트 `/.well-known/oauth-protected-resource`도 호환 별칭으로 제공합니다. 이 확인만으로 브라우저 OAuth 로그인이 검증되지는 않습니다.

백업은 SQLite의 backup API를 쓰는 제공 스크립트로 만듭니다.

```bash
docker compose --env-file deploy/.env -f deploy/compose.yaml exec server \
  node dist/scripts/rpg-backup.js backup /data/backup.db
```

백업을 서버 밖에도 보관하세요. `docker compose down`은 기본적으로 DB 볼륨을 보존하지만 `down -v`는 볼륨을 삭제합니다. 실제 캠페인에서 사용하지 마세요.

## ChatGPT에 추가

계정·워크스페이스에서 사용자 정의 MCP 연결 권한이 있어야 합니다. 현재 UI에서는 Plugins의 추가 버튼에서 Add custom MCP server를 선택해 실제 공개 HTTPS `/mcp` 주소와 OAuth 설정을 입력하고, 도구를 검색해 연결합니다. 계정에 구형 Apps 화면이 보이면 해당 화면의 Create·Scan Tools 경로를 사용합니다. 화면과 권한은 변경될 수 있으므로 [공식 연결 안내](https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt)를 확인하세요.

연결·로그인 후 새 대화에서 플러그인을 선택하고 “내 캠페인 목록을 조회해 줘”로 읽기부터 확인합니다. 도구는 25개입니다. 변경 작업의 ChatGPT 확인 화면은 플랫폼의 권한 정책에 따릅니다. 도구의 annotations는 읽기·변경·파괴 가능성·외부 조회를 구분하며 서버의 소유권 검사를 대체하지 않습니다.

서로 다른 로그인 계정이 같은 캠페인을 볼 수 없는지도 확인합니다. 로컬 `db:seed:sample`은 `local-development` 사용자용입니다. OAuth 로그인 사용자의 캠페인으로 자동 이전되지 않습니다. 초기 로그인 계정의 목록이 비어 있는 것은 정상이며, 해당 계정에서 도구로 세계 초안·Release·Game을 만들어야 합니다.

[GM 운영 지침](chatgpt-gm-instructions.md)을 대화 또는 연결한 플러그인의 지침으로 사용합니다. 연결 상태가 복구된 새 대화에서도 먼저 서버의 캠페인 목록과 컨텍스트를 조회해야 합니다.

## 검증 범위

자동 검사는 OAuth 발견 정보·401 challenge·JWT 권한·도구 목록과 실제 MCP 동작을 확인합니다. 컨테이너 CI는 이미지 빌드, 비루트 실행, 임시 합성 게임의 볼륨 보존과 재시작, Compose·Caddy 구성을 확인합니다. 로컬에서도 `docker build -t memory2:chatgpt .` 다음 `python3 scripts/check-container.py`로 같은 검사를 실행할 수 있습니다. 공개 DNS·인증서 발급·외부 OAuth 동의·ChatGPT 로그인·재연결은 실제 호스팅과 사용자 인증이 있어야 검증할 수 있습니다. 이를 확인하기 전에는 “ChatGPT 연결 완료”로 표시하지 않습니다.
