import { createHash } from 'node:crypto';
import type { OpenRouterQuestion } from '../src/openrouter.js';

export type WorldProbeCharacters = 32_000 | 64_000 | 96_000;
export type WorldProbePosition = 'start' | 'middle' | 'end';

export interface WorldContextProbe {
  id: string;
  state: string;
  questions: OpenRouterQuestion[];
  expected_answers: Record<string, string>;
  metadata: {
    actual_characters: number;
    core_characters: number;
    core_offset: number;
    characters: WorldProbeCharacters;
    position: WorldProbePosition;
    seed: number;
    core_hash: string;
    padding_hash: string;
  };
}

const CORE = `
기록 규칙: 여기부터는 4월 18일 실제 호수문 사건의 확정 기록이다. 인물 표식은 이름만 비슷한 사람을 합치지 않도록 역할과 표식을 함께 적는다.

[4월 18일, 실제 사건, 동쪽 물길]
18:00 동쪽 제련소의 굴뚝 이음부가 갈라져 검댕이 북쪽 빗물 홈으로 새어 나왔다.
18:04 비가 검댕을 북쪽 수로의 거름망까지 씻어 보냈다.
18:09 검댕이 거름망을 막아 북쪽 수로의 유량을 줄였다.
18:16 줄어든 유량 때문에 동쪽 저수실의 물높이가 올라갔다.
18:23 오른 물이 저수실의 뜨개판을 밀어 올렸다.
18:27 뜨개판이 주황색 연결줄을 당겼다.
18:31 연결줄은 안전 제동쇠가 걸리지 않은 상태에서 잠금쇠를 들어 올렸다.
18:34 올라간 잠금쇠가 동쪽 우회 수문을 열었다.
18:39 열린 우회 수문이 저장수를 3번 호수문 뒤쪽에 밀어 넣었다.
19:40 뒤쪽에서 밀린 저장수 때문에 3번 호수문의 배수로에 역류가 발생했다. 이것이 이 기록에서 묻는 terminal event다.

[같은 4월 18일 사건, 경보 및 제동 가지]
18:06 호수에서 불어온 습한 바람이 감시실 환기구로 안개를 밀어 넣었다.
18:09 환기구의 구리 냉각판이 경보 렌즈 받침을 식혔다.
18:12 차가워진 파란 유리 렌즈 안쪽에 물방울이 맺혔다.
18:14 물방울이 붉은 경보등의 빛을 여러 방향으로 흩뜨렸다.
18:16 빛이 흩어져 경보 문양의 바깥 테두리가 흐려졌다.
18:18 흐린 렌즈가 붉은 정지 신호를 가려 당직자는 신호를 읽지 못했다.
18:20 야간 당직자는 흐린 문양을 청색 대기 표식으로 오인했다.
18:22 당직자가 청색 대기 표식으로 판단했기 때문에 감시실에는 수동 정지 호출이 전달되지 않았다.
18:24 호출을 받지 못한 제동 담당자는 안전 제동쇠를 걸지 않은 채 자리를 지켰다.
18:25 제동쇠가 걸리지 않았기 때문에 연결줄이 잠금쇠에 닿을 때 이를 막을 장치가 없었다.
18:31 제동 장치가 비활성인 상태에서 뜨개판의 연결줄은 잠금쇠를 들어 올릴 수 있었다.
두 경로는 제동 장치에서 만나 같은 잠금쇠에 영향을 주었다.

[헷갈리기 쉬운 주변 기록]
4월 17일 남쪽 구역 훈련에서는 파란 방수포가 시험용 3번 배수로를 막았다. 훈련 기록이며 4월 18일 동쪽 물길의 검댕 사건과 다른 장소와 날짜다.
4월 19일 서쪽 구역 모의 운전에서는 펌프 점검 때문에 수문을 수동 개방했다. 실제 사건의 원인 기록이 아니다.
현장 소문에는 붉은 점토 표식이 수문을 열었다고 적혔으나, 점토 표식은 전시품이고 연결줄이나 잠금쇠와 접촉하지 않았다.

[인물 원장: 이름, 역할, 표식을 대조할 것]
윤서린은 남쪽 초소의 지도 제작 기록관이다. 은박 안경을 쓰며 파란 유리 나침반을 수리했다. 현장 별칭 '은박안경 윤서'와 원장 인물 '윤서린'은 동일인이라고 대조 확인되어 있다.
윤수린은 북쪽 초소의 기상 관측원이다. 청동 안경을 쓰며 회색 깃 망토를 입는다. 윤수린은 윤서린과 다른 사람이다. 두 이름은 한 글자만 다르지만 역할과 표식이 다르다.
류해온은 서쪽 나루의 조타수이며 놋쇠 호루라기를 쓴다.
도라온은 동쪽 수문의 정비공이며 붉은 소매를 입는다.
4월 18일 17:50 파란 유리 나침반을 안개 낀 기록 보관함에서 꺼내 수리한 기록은 '은박안경 윤서'라는 현장 별칭으로 서명되었다. 원장의 대조 기록에 따라 수리자는 윤서린이다.

[미확인 인물 참조]
19:02 기록에는 '검은 장갑을 낀 전령이 봉투를 두고 갔다'고만 적혀 있다. 얼굴, 목소리, 서명, 인장, 소속 표식, 동행자 또는 다른 인물과의 연결 기록은 없다.
검은 장갑은 직업상 복장 묘사일 뿐 고유한 신원 표식이 아니다. 이 전령을 윤서린, 윤수린, 류해온 또는 도라온 가운데 누구라고 연결할 증거는 없다. 이 기록으로 전령의 신원은 확인할 수 없다.
`;

const DISTRACTOR_TEMPLATES = [
  (n: number) => `4월 ${11 + n % 6}일 동쪽 구역 모의 점검 ${n}: 시험용 거름망에 검댕 모형을 넣었으나 실제 수로와 연결하지 않았다. 기록 표식 ${n}.`,
  (n: number) => `4월 ${12 + n % 5}일 서쪽 나루 훈련 ${n}: 파란 유리 경보 렌즈에 물방울을 뿌려 판독 연습을 했다. 실제 감시실의 안개 기록이 아니다.`,
  (n: number) => `4월 ${10 + n % 7}일 북쪽 축제 구역 관측 기록 ${n}: 윤수림(흰 장갑, 임시 전령)이 축제 깃발의 방향을 기록했다. 동쪽 호수문 근무표가 아니다.`,
  (n: number) => `4월 ${11 + n % 6}일 남쪽 장터 지도 정리 ${n}: 윤서람(금색 안경, 축제 지도 화가)이 종이지도를 접었다. 초소 근무 명부와 다른 행사 자료다.`,
  (n: number) => `4월 ${12 + n % 5}일 동쪽 구역 배수로 모의 실험 ${n}: 푸른 천 조각을 시험관에 넣었다. 실험은 3번 호수문에 저장수를 보내지 않았다.`,
  (n: number) => `4월 ${10 + n % 7}일 북쪽 저수실 훈련 ${n}: 뜨개판 모형과 주황색 연결줄을 분리한 상태에서 장력 숫자만 측정했다. 사건 재현이나 실제 작동이 아니다.`,
  (n: number) => `4월 ${11 + n % 6}일 서쪽 구역 정비 연습 ${n}: 도라온(붉은 소매, 수문 정비공)이 폐쇄된 시험 밸브를 점검했다. 동쪽 실제 수문과 연결되지 않았다.`,
  (n: number) => `4월 ${12 + n % 5}일 나루 게시판 소문 ${n}: 붉은 점토 표식이 문을 열었다는 말이 돌았지만, 전시품 확인표는 기계 접촉이 없었다고 적었다. 날짜와 구역을 혼동하지 말 것.`,
  (n: number) => `4월 ${10 + n % 7}일 동쪽 감시실 시뮬레이션 ${n}: 경보 렌즈 상태와 제동쇠 반응을 따로 측정했다. 이 값은 실제 사건의 원인 판정이 아니다.`,
  (n: number) => `4월 ${11 + n % 6}일 북쪽 수로 표본 ${n}: 회색 재를 물통에 넣어 탁도를 관찰했다. 표본은 빗물 홈, 거름망, 동쪽 저수실로 옮겨지지 않았다.`,
  (n: number) => `4월 ${12 + n % 5}일 서쪽 펌프 훈련 ${n}: 유지보수 담당자가 시험 스위치를 눌렀다. 4월 19일 모의 운전 자료이며 4월 18일 사건이 아니다.`,
  (n: number) => `지역 행사 인명표 ${n}: 윤서람(금색 안경, 축제 지도 화가)과 윤수림(흰 장갑, 임시 전령)은 축제 운영을 맡았다. 행사는 수문 감시와 별도다.`,
  (n: number) => `4월 ${10 + n % 7}일 남부 항구 배달 기록 ${n}: 행사 안내 봉투가 임시 운반인에게 전달되었다. 항구의 봉투 경로는 동쪽 초소 기록과 연결되지 않았다.`,
  (n: number) => `4월 ${10 + n % 7}일 북쪽 성문 훈련 ${n}: 경보등에는 파란 필터를 붙였다. 훈련 등급은 초급이며 실제 동쪽 감시실과 배선이 다르다.`,
  (n: number) => `지역 기록 ${n}: 류해온은 서쪽 나루 조타수이며 놋쇠 호루라기를 쓴다. 동쪽 수문 정비 기록에는 참여자로 기재되지 않았다.`,
  (n: number) => `보관함 목록 ${n}: 파란 유리 나침반은 지도 제작 도구다. 모의 훈련에서 사용한 나무 나침반과 구분하며 보관함 번호를 함께 확인한다.`,
];

function seededRandom(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value += 0x6D2B79F5;
    let t = value;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makePadding(length: number, seed: number): string {
  const random = seededRandom(seed);
  let output = '';
  let record = 0;
  while (output.length < length) {
    const templateIndex = Math.floor(random() * DISTRACTOR_TEMPLATES.length);
    const line = DISTRACTOR_TEMPLATES[templateIndex]!(record++);
    const separator = output.length === 0 ? '' : '\n';
    const addition = separator + line;
    const remaining = length - output.length;
    if (addition.length <= remaining) output += addition;
    else {
      // A repeated neutral marker fills the final code units without adding a competing fact.
      output += '·'.repeat(remaining);
    }
  }
  return output;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

export function buildWorldContextProbe(input: {
  characters: WorldProbeCharacters;
  position: WorldProbePosition;
  seed: number;
}): WorldContextProbe {
  const { characters, position, seed } = input;
  if (characters !== 32_000 && characters !== 64_000 && characters !== 96_000) throw new TypeError('characters must be 32000, 64000, or 96000');
  if (!['start','middle','end'].includes(position)) throw new TypeError('position must be start, middle, or end');
  if (!Number.isSafeInteger(seed)) throw new TypeError('seed must be a safe integer');
  if (CORE.length >= characters) throw new Error('authored core exceeds requested context length');

  const paddingLength = characters - CORE.length;
  const leftLength = position === 'start' ? 0 : position === 'end' ? paddingLength : Math.floor(paddingLength / 2);
  const padding = makePadding(paddingLength, seed);
  const prefix = padding.slice(0, leftLength);
  const suffix = padding.slice(leftLength);
  const state = prefix + CORE + suffix;
  const questions: OpenRouterQuestion[] = [
    {
      key: 'root_cause', type: 'choice',
      instructions: 'For the specified 4월18일 19:40 reverse-flow event, identify the earliest initiating physical cause of the water-flow chain, rather than a later enabling brake condition. Trace the recorded sequence; distinguish simulations or other dates.',
      options: ['c0','c1','c2','c3'],
      criteria: {
        c0: '동쪽 제련소 굴뚝 이음부의 균열.',
        c1: '감시실 파란 유리 경보 렌즈 안쪽의 안개 응결.',
        c2: '다른 날짜 서쪽 구역의 펌프 수동 점검.',
        c3: '기록만으로 특정할 수 없는 원인.',
      },
    },
    {
      key: 'identity', type: 'choice',
      instructions: 'Identify who repaired the blue-glass compass using the records. Do not merge similar names.',
      options: ['c0','c1','c2','c3'],
      criteria: {
        c0: '윤서린 — 남쪽 초소 지도 제작 기록관.',
        c1: '윤수린 — 북쪽 초소 기상 관측원.',
        c2: '류해온 — 서쪽 나루 조타수.',
        c3: '미확인 인물.',
      },
    },
    {
      key: 'unknown_agent', type: 'choice',
      instructions: 'Resolve the identity of the black-gloved courier only if the records provide identity evidence. Clothing alone is not a unique identity proof; otherwise choose the insufficient-evidence option.',
      options: ['c0','c1','c2','c3'],
      criteria: {
        c0: '윤서린 — 남쪽 초소 지도 제작 기록관.',
        c1: '윤수린 — 북쪽 초소 기상 관측원.',
        c2: '류해온 — 서쪽 나루 조타수.',
        c3: '미확인 인물 — 제시된 신원 선택지 중 기록으로 입증되는 사람이 없음.',
      },
    },
  ];
  const expected_answers = { root_cause: 'c0', identity: 'c0', unknown_agent: 'c3' };
  const metadata = {
    actual_characters: state.length,
    core_characters: CORE.length,
    core_offset: prefix.length,
    characters,
    position,
    seed,
    core_hash: createHash('sha256').update(CORE).digest('hex'),
    padding_hash: createHash('sha256').update(padding).digest('hex'),
  };
  const content = { state, questions, expected_answers, metadata };
  const id = createHash('sha256').update(JSON.stringify(content)).digest('hex');
  return deepFreeze({ id, ...content });
}
