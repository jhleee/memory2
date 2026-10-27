import type { EntityInput, LinkInput, MemoryInput, RecordInput } from '../src/types.js';
import type { GameplayFixture, GameplayPath, GameplayQuery } from './gameplay-benchmark-lib.js';

export type WorldStressSize = 256 | 1024 | 4096;
export interface WorldStressGenerationMetadata {
  size: WorldStressSize;
  seed: number;
  sessions: number;
  main_original_memories: number;
  authored_story_memories: number;
  distractor_memories: number;
  story_entities: number;
  distractor_entities: number;
  main_entities: number;
  decoy_spaces: number;
  operation_records: number;
  decoy_memories: number;
  main_records: number;
  evidence_characters: number;
}
export interface EntityDecision {
  id: string;
  mention: string;
  as_of_session: string;
  candidate_entity_ids: string[];
  expected_entity_id: string | null;
  attributes?: Record<string, unknown>;
}
export interface WorldStressFixture extends GameplayFixture {
  entity_decisions: EntityDecision[];
  generation: WorldStressGenerationMetadata;
}
export interface WorldContextOption { id: string; text: string }
export interface WorldContextQuestion {
  id: string;
  question: string;
  as_of_session: string;
  options: WorldContextOption[];
  expected_choice: string;
  support_memory_ids: string[];
  budgets_chars: number[];
  needle_positions: Array<'start' | 'middle' | 'end'>;
}

export const worldContextQuestions: WorldContextQuestion[] = [
  {
    id: 'world_context_causal_root',
    question: '항만 구호 물자가 진료소에 닿지 못한 직접 원인을 여러 보고서의 연쇄로 설명하라. 아래에서 최초 원인을 고르라.',
    as_of_session: 'world-session-64',
    options: [
      { id: 'root-a', text: '북부 기상탑의 폭풍 경보가 누락되어 산길이 붕괴했다.' },
      { id: 'root-b', text: '소금 펌프 기름이 빼돌려져 지하 기록실과 수송 경로가 침수됐다.' },
      { id: 'root-c', text: '동력 수정이 사라져 경보 종과 동문 감시가 꺼졌다.' },
      { id: 'root-d', text: '남쪽 해협의 신호기가 위조되어 구조선이 얕은 물길로 우회했다.' },
    ],
    expected_choice: 'root-a',
    support_memory_ids: ['stress_chain_a_01', 'stress_chain_a_02', 'stress_chain_a_03', 'stress_chain_a_04', 'stress_chain_a_05', 'stress_chain_a_06', 'stress_chain_a_07', 'stress_chain_a_08', 'stress_chain_a_09'],
    budgets_chars: [32000, 96000], needle_positions: ['start', 'middle', 'end'],
  },
  {
    id: 'world_context_identity_choice',
    question: '봉인 원본을 열람한 “윤아”는 누구인가? 같은 이름의 두 사람 중 역할과 위치 기록에 맞는 사람을 고르라.',
    as_of_session: 'world-session-64',
    options: [
      { id: 'yuna-north', text: '북부 기록관 윤아: 기록 보관소의 등록 담당자.' },
      { id: 'yuna-dock', text: '남부 부두 노동자 윤아: 운송표를 옮긴 현장 노동자.' },
      { id: 'yuna-unknown', text: '자료가 부족해 두 사람을 구분할 수 없다.' },
    ],
    expected_choice: 'yuna-north',
    support_memory_ids: ['stress_extra_01_01', 'stress_extra_01_02', 'stress_extra_01_03', 'stress_extra_01_04'],
    budgets_chars: [32000, 96000], needle_positions: ['start', 'middle', 'end'],
  },
  {
    id: 'world_context_unknown_identity',
    question: '58회 기록 시점에 가면 쓴 연락원의 실명을 확정할 근거가 있는가?',
    as_of_session: 'world-session-58',
    options: [
      { id: 'contact-known', text: '북부 기록관 윤아다.' },
      { id: 'contact-veil', text: '기록이 나중에 밝힐 야간 연락원이다.' },
      { id: 'insufficient-evidence', text: '아니다. 당시 기록에는 가면 쓴 연락원이라는 Mention과 미상 상태만 있다.' },
    ],
    expected_choice: 'insufficient-evidence',
    support_memory_ids: ['stress_unknown_mention'],
    budgets_chars: [32000, 96000], needle_positions: ['start', 'middle', 'end'],
  },
];

const MAIN_SPACE = 'world-main';
const SESSION_COUNT = 64;
const STORY_COUNT = 96;
const MAX_GROUP_MEMORIES = 8;

type Story = { memory: MemoryInput; session: number; links?: LinkInput[] };
type EntityAt = { session: number; entity: EntityInput };
const ref = (type: 'memory' | 'entity' | 'evidence', id: string) => ({ type, id });
const mlink = (from: string, relation: string, to: string, basis: string): LinkInput => ({
  from: ref('memory', from), relation, to: ref('memory', to), metadata: { basis },
});
const isoDay = (session: number): string => new Date(Date.UTC(2025, 0, 1 + session, 18)).toISOString();
const sessionId = (index: number): string => `world-session-${String(index + 1).padStart(2, '0')}`;

function randomFor(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function makeEntity(id: string, name: string, type: string, description: string, aliases: string[] = []): EntityInput {
  return { id, name, metadata: { type, description, aliases } };
}

function makeStory(id: string, content: string, session: number, entity_ids: string[], kind = 'event', data: Record<string, unknown> = {}): Story {
  return { session, memory: { id, kind, content, occurred_at: isoDay(session), data, entity_ids } };
}

function chainEntities(): EntityAt[] {
  const at: EntityAt[] = [];
  const add = (session: number, id: string, name: string, type: string, desc: string, aliases: string[] = []) => at.push({ session, entity: makeEntity(id, name, type, desc, aliases) });
  // Neutral descriptions identify only what is already locally known; plot outcomes live in evidence, never future metadata.
  add(0, 'world_mira', '미라', 'person', '북부 수로의 야간 관측원.', ['Mira', '米拉']);
  add(0, 'world_ren', '렌', 'person', '구호선 항해사.', ['Ren']);
  add(0, 'world_harborwatch', '항만 감시대', 'faction', '하구 항로와 부두를 순찰한다.', ['Harbor Watch']);
  add(0, 'world_ridge_road', '산등성이 길', 'place', '북부 진료소와 하구를 잇는 길.');
  add(0, 'world_clinic', '하구 진료소', 'place', '강 하구의 작은 진료소.');
  add(0, 'world_north_dock', '북부 부두', 'place', '구호선과 수레가 만나는 부두.');
  add(0, 'world_weather_bell', '기압종', 'artifact', '기상탑의 수동 경보 장치.');
  add(10, 'world_salt_guild', '소금 운송 길드', 'faction', '염수와 펌프 부품을 운반한다.', ['Salt Carriers']);
  add(10, 'world_seo', '서진', 'person', '수문 정비공.', ['Seojin']);
  add(10, 'world_archive', '지하 기록실', 'place', '수로 아래 장부 보관소.');
  add(10, 'world_cistern', '동부 저수조', 'place', '광산과 기록실 사이의 저수조.');
  add(10, 'world_salt_pump', '소금 펌프', 'artifact', '저수조의 물을 밀어내는 장치.');
  add(10, 'world_water_ledger', '수문 장부', 'artifact', '조수와 수문 압력을 적은 장부.');
  add(10, 'world_courier', '나린', 'person', '기록실과 항만을 오가는 전령.', ['Narin']);
  add(20, 'world_jin', '진', 'person', '동력 설비를 관리하는 기술자.', ['Jin']);
  add(20, 'world_glassworks', '유리 공방회', 'faction', '수정과 전력 계통을 관리한다.', ['Glasswrights']);
  add(20, 'world_relay', '동력 수정', 'artifact', '경보 계통의 전력 매개체.');
  add(20, 'world_east_gate', '동문 수레문', 'place', '시장과 기록 구역 사이의 문.');
  add(20, 'world_night_guard', '야간 경비대', 'faction', '문과 기록 구역을 순찰한다.');
  add(20, 'world_market', '유리시장', 'place', '유리 공방과 부두 사이의 시장.');
  add(20, 'world_seal_cabinet', '봉인 보관함', 'artifact', '기록실의 봉인 원본을 보관한다.');
  add(20, 'world_subarchive', '하부 문서고', 'place', '기록실 아래의 작은 문서고.');
  add(32, 'world_ara', '아라', 'person', '남쪽 해협의 구조선 선장.', ['Ara', '阿羅']);
  add(32, 'world_yoon', '윤', 'person', '남쪽 해협의 도선사.', ['Yoon']);
  add(32, 'world_red_sail', '붉은 돛 구조대', 'faction', '남쪽 해협과 외항을 오간다.', ['Red Sail']);
  add(32, 'world_south_narrows', '남쪽 여울목', 'place', '조류가 빠른 얕은 해협.');
  add(32, 'world_rescue_harbor', '남부 구조항', 'place', '구호 물자와 구조선이 모이는 항구.');
  add(32, 'world_healer', '소연', 'person', '구조항의 야전 치료사.', ['Soyeon']);
  add(32, 'world_tide_chart', '조류 지도', 'artifact', '항로별 조수와 수심을 표시한 지도.');
  add(32, 'world_signal_tower', '남쪽 신호탑', 'place', '선박에 깃발 신호를 보내는 탑.');
  return at;
}

function chainStories(): { stories: Story[]; entities: EntityAt[]; paths: Record<string, GameplayPath> } {
  const entities = chainEntities();
  const specs: Array<{ prefix: string; start: number; ids: string[]; contents: string[] }> = [
    { prefix: 'a', start: 0, ids: ['world_mira','world_ridge_road','world_harborwatch','world_north_dock','world_clinic','world_weather_bell','world_ren'], contents: [
      '북부 관측원이 기압종으로 폭풍 경보를 보냈으나 하구 중계소가 신호를 받지 못했다.',
      '폭풍 경보가 닿지 않은 채 비가 쏟아져 산등성이 길의 절개면이 무너졌다.',
      '산등성이 길 폐쇄로 하구 진료소 보급 수레가 출발을 늦췄다.',
      '보급 수레가 늦어지자 진료소의 냉장 발전기에 쓸 예비 연료가 도착하지 않았다.',
      '예비 연료가 끊겨 백신 보관함의 온도가 기준을 넘었다.',
      '온도 기록이 기준을 넘어 백신 상자를 격리하고 접종 예약을 중단했다.',
      '진료소 환자 이송이 늘어 렌의 구호선은 북부 부두 쪽 항로로 우회했다.',
      '구호선 우회와 보급 수레가 겹쳐 북부 부두의 구조 통로가 막혔다.',
      '구조 통로가 막혀 외곽 진료소의 구호 물자가 약속한 조수 전에 도착하지 못했다.',
    ]},
    { prefix: 'b', start: 10, ids: ['world_seo','world_salt_guild','world_salt_pump','world_cistern','world_archive','world_water_ledger','world_courier'], contents: [
      '소금 운송 길드가 수문 펌프용 기름통 하나를 표시 없이 지하로 옮겼다.',
      '기름통이 빠진 뒤 서진이 담당하는 소금 펌프의 회전축이 과열됐다.',
      '과열된 펌프가 멈춰 동부 저수조의 배수 속도가 급격히 떨어졌다.',
      '배수되지 않은 물이 지하 기록실의 바닥과 하부 문서고까지 차올랐다.',
      '침수된 기록실에서 수문 장부의 잉크가 번지고 숫자 일부가 사라졌다.',
      '번진 숫자로 조수 암호표의 두 자리를 복원할 수 없게 됐다.',
      '나린은 암호표 없이 원본 장부를 수송할 수 없어 북쪽 보관소 경로로 바꿨다.',
      '경로 변경 기록을 보지 못한 항만 감시대는 나린의 배가 예정 항로를 이탈했다고 보고했다.',
      '항로 이탈 오인으로 검문정이 나린의 배를 멈춰 원본 장부 인도가 늦어졌다.',
    ]},
    { prefix: 'c', start: 20, ids: ['world_jin','world_glassworks','world_relay','world_east_gate','world_night_guard','world_market','world_seal_cabinet','world_subarchive'], contents: [
      '야간 설비 점검 직전 동력 수정 한 개가 유리 공방의 배전함에서 사라졌다.',
      '동력 수정이 빠지자 기록 구역 전력망과 경보 회로가 함께 끊겼다.',
      '전력망이 끊긴 동안 시장 경보 종이 울리지 않았다.',
      '경보를 듣지 못한 야간 경비대는 동문 대신 수동 순찰로를 따라 이동했다.',
      '경비대가 자리를 비운 동안 동문 수레문의 확인 담당자가 없어졌다.',
      '확인 담당자가 없는 틈에 표시 없는 수레가 유리시장 쪽으로 통과했다.',
      '수레에 실린 공구로 봉인 보관함 자물쇠가 열렸다.',
      '봉인 보관함에서 원본 대신 번호가 비슷한 사본이 하부 문서고로 옮겨졌다.',
      '사본이 원본으로 보고되어 감정 결과가 잘못된 기록 담당자에게 귀속됐다.',
    ]},
    { prefix: 'd', start: 32, ids: ['world_ara','world_yoon','world_red_sail','world_south_narrows','world_rescue_harbor','world_healer','world_tide_chart','world_signal_tower'], contents: [
      '남쪽 신호탑에 기존 적색 경보와 비슷한 위조 깃발이 걸렸다.',
      '위조 깃발을 본 아라는 붉은 돛 구조선의 항로를 남쪽 여울목으로 바꿨다.',
      '윤이 수심을 확인했을 때 구조선은 이미 얕은 물길 안쪽으로 들어가 있었다.',
      '물길이 얕아 배 밑바닥이 암초에 닿아 구호 상자 일부가 파손됐다.',
      '파손된 상자에 바닷물이 들어와 야전 치료 물자의 포장이 젖었다.',
      '소연은 젖은 포장을 확인하느라 외곽 환자에게 투여할 약품을 늦췄다.',
      '약품 전달 지연으로 구조대가 임시 검문소 인원을 남부 구조항 쪽으로 이동시켰다.',
      '검문소 인원이 빠진 사이 전령이 치료 기록 원본을 다른 창고로 옮겼다.',
      '기록 원본이 창고에서 발견되지 않아 조약 협상단은 피해 규모를 확인하지 못했다.',
    ]},
  ];
  const stories: Story[] = [];
  const paths: Record<string, GameplayPath> = {};
  for (const chain of specs) {
    const nodes: string[] = [];
    for (let index = 0; index < chain.contents.length; index++) {
      const id = `stress_chain_${chain.prefix}_${String(index + 1).padStart(2, '0')}`;
      nodes.push(id);
      const session = chain.start + index;
      const entitiesForMemory = chain.prefix === 'a'
        ? ['world_mira','world_harborwatch','world_ren']
        : chain.prefix === 'b'
          ? ['world_seo','world_salt_guild','world_salt_pump','world_harborwatch','world_courier']
          : chain.prefix === 'c'
            ? ['world_jin','world_glassworks','world_relay','world_night_guard']
            : ['world_ara','world_yoon','world_red_sail'];
      stories.push(makeStory(id, chain.contents[index]!, session, entitiesForMemory, 'event', { chain: chain.prefix, step: index + 1 }));
    }
    for (let index = 1; index < nodes.length; index++) {
      const cause = nodes[index - 1]!;
      const effect = nodes[index]!;
      const effectStory = stories.find(item => item.memory.id === effect)!;
      effectStory.links = [...(effectStory.links ?? []), mlink(cause, index === 5 ? 'enables' : 'causes', effect, '세션 증거에서 확인된 물리적·조직적 단계')];
    }
    paths[chain.prefix] = { nodes, relations: nodes.slice(1).map((_id, index) => index === 4 ? 'enables' : 'causes') };
  }
  // A common power loss has two documented branches: failed surveillance and water damage.
  const branchItems = [
    makeStory('stress_chain_c_10', '동력망이 끊긴 동안 자동 배수 펌프도 멈춰 하부 문서고로 물이 흘렀다.', 29, ['world_relay','world_subarchive','world_cistern'], 'event', { branch: 'power-loss-water-damage' }),
    makeStory('stress_chain_c_11', '하부 문서고의 수위가 올라 봉인 보관함의 종이 꼬리표가 떨어졌다.', 30, ['world_subarchive','world_seal_cabinet'], 'event', { branch: 'power-loss-water-damage' }),
  ];
  branchItems[0]!.links = [mlink('stress_chain_c_02','causes','stress_chain_c_10','정전으로 자동 배수 펌프 정지')];
  branchItems[1]!.links = [mlink('stress_chain_c_10','causes','stress_chain_c_11','펌프 정지 뒤 문서고 침수')];
  stories.push(...branchItems);
  return { stories, entities, paths };
}

function extraStory(entities: EntityAt[]): Story[] {
  const stories: Story[] = [];
  const addEntity = (session: number, entity: EntityInput) => entities.push({ session, entity });
  addEntity(41, makeEntity('world_yuna_north','윤아','person','북부 기록관의 등록 담당자.', ['Yuna','允娥']));
  addEntity(41, makeEntity('world_yuna_dock','윤아','person','남부 부두에서 운송표를 나르는 노동자.', ['Yuna-dock']));
  addEntity(41, makeEntity('world_mariner_union','순회 선원 조합','faction','여러 항구 사이의 선원 연락망.', ['Circuit Mariners']));
  addEntity(41, makeEntity('world_clocktower','구시계탑','place','시장과 북부 문서고 사이의 시계 시설.'));
  addEntity(41, makeEntity('world_twinned_seal','쌍문장 인장','artifact','두 문양을 겹쳐 찍는 세관 도구.'));
  addEntity(41, makeEntity('world_marshal','마른','person','순회 검문 기록 담당자.', ['Maren']));
  addEntity(41, makeEntity('world_old_stage','오래된 무대','place','폐쇄된 극장과 임시 게시판이 있는 장소.'));
  const groupSpecs = [
    ['윤아의 두 근무표에는 같은 이름이 적혀 있었으나 한 사람은 북부 문서고, 다른 사람은 남부 부두에서 근무했다.','순회 선원 조합은 구시계탑에서 전달된 운송표 사본을 각 항구에 배포했다.','구시계탑 시각과 부두 종 시각은 3분 차이가 나지만 어느 쪽이 표준인지는 확인되지 않았다.','쌍문장 인장 자국은 원본과 사본에서 모두 발견됐으나 압력 차이는 달랐다.','마른은 두 윤아의 근무 기록을 이름만으로 합치지 말고 근무지로 구분하겠다고 기록했다.','기록관 윤아는 북부 보관함을 열었고 부두 노동자 윤아는 접수표를 전달했다.','같은 이름의 접수표가 두 장소에서 발견되어 추가 대조 대상으로 남았다.'],
    ['첫째 번호가 붙은 운송표에는 북부 부두 출발 시각이 적혀 있었다.','둘째 번호 운송표에는 남부 구조항의 도착 시각이 기록됐다.','번호가 한 자리 다른 봉인 문서는 같은 사건의 원본으로 단정할 수 없다.','기록관 윤아는 문서 양쪽의 인장 압력과 잉크 번짐을 비교했다.','순회 선원 조합은 사본이 원본보다 하루 늦게 인쇄됐다고 보고했다.','검문 담당 마른은 훼손된 표의 숫자를 추측으로 채우지 말라고 지시했다.','서로 다른 번호표는 같은 항로를 가리켰지만 발행처는 달랐다.'],
    ['아라는 조류 지도를 확인한 뒤 다음 조수에 구조선을 보내겠다고 약속했다.','진은 동력 수정 보관함의 재고를 다음 점검까지 맞추겠다고 약속했다.','렌은 구호 상자 개수를 북부 진료소와 대조하겠다고 약속했다.','서진은 펌프 기름 반환 여부를 수문 장부에 기록하겠다고 약속했다.','마른은 회수된 인장 문서를 봉인 상태로 보관하겠다고 약속했다.','윤아는 두 이름의 근무표를 별도 항목으로 유지하겠다고 약속했다.','각 약속의 이행 여부는 다음 순찰 때 확인하기로 했다.'],
    ['부두 소문은 붉은 돛 구조대가 항로 지도를 바꿨다고 주장했으나 서명된 운항 기록은 없었다.','유리 공방회는 동력 수정의 회수 시각을 확인했지만 누가 가져갔는지는 밝히지 못했다.','하부 문서고 침수와 같은 날 시장 종도 멈췄으나 한 사건이 다른 사건을 일으켰다는 증거는 없다.','남부 검문소에서 발견된 젖은 끈은 구조선 상자와 같은 재질로 보였지만 제조처는 미상이다.','순회 선원 조합은 “검은 깃발”이라는 제보가 여러 선박을 가리킬 수 있다고 경고했다.','북부 관측원은 폭풍 전후 바람 방향을 기록했으나 항로 변경의 직접 원인을 확정하지 않았다.','경비대는 익명 투서의 이름만으로 용의자를 특정하지 않기로 했다.'],
    ['구시계탑의 종은 부두 경보와 같은 분류에 넣지 않는다고 시계지기가 설명했다.','기록관 윤아와 서진은 수문 장부의 압력 표기를 함께 검토했다.','부두 노동자 윤아는 빈 운송표 세 장을 반납했으며 문서 내용은 적혀 있지 않았다.','마른은 봉인 원본을 북쪽 문서고의 이중 잠금함에 옮겼다.','나린의 배가 검문을 받은 시각은 항만 감시대의 교대표와 맞지 않아 조사 중이다.','쌍문장 인장은 중앙 문양이 닳아 이전 발행분과 새 발행분을 구분하기 어렵다.','구조대는 부두 통로가 비워진 뒤에만 다음 물자를 내보내기로 했다.'],
    ['오래된 무대 게시판에는 날짜가 없는 항로 쪽지가 붙어 있었다.','구시계탑 시계지기는 초침 고장으로 3분 오차가 생겼음을 확인했다.','북부 문서고의 환기창은 비가 오는 날에만 안쪽으로 물방울이 맺힌다.','남부 구조항의 물자 상자에는 같은 색이지만 서로 다른 크기의 봉인이 쓰였다.','야간 순찰대는 동문과 서문의 교대 시각을 다시 맞추었다.','하구 진료소는 격리된 백신 상자를 별도 냉장고에 보관했다.','유리시장 상인은 유리 파편의 출처를 특정하지 못해 표본 봉투만 제출했다.'],
    ['“Mira”와 “미라”는 북부 관측원의 같은 서명으로 확인됐고 별도 인물 기록은 없다.','“Ren”은 렌의 항해 일지에 쓰인 영문 표기다.','“允娥”는 북부 기록관 윤아가 제출한 가족 문서의 한자 표기다.','“Yuna-dock”은 부두 노동자 윤아를 구분하려고 선원 조합이 사용한 별칭이다.','“Circuit Mariners”는 순회 선원 조합의 영문 표기다.','“Maren”은 마른의 서명 표기이며 하늘이라는 이름과는 다른 사람이다.','비슷한 별칭이 검색되더라도 같은 Entity라고 자동 결론 내리지 않는다.'],
  ];
  let global = 1;
  for (let group = 0; group < groupSpecs.length; group++) {
    const session = 41 + group;
    for (let index = 0; index < groupSpecs[group]!.length; index++) {
      const id = `stress_extra_${String(group + 1).padStart(2,'0')}_${String(index + 1).padStart(2,'0')}`;
      const text = groupSpecs[group]![index]!;
      const refs = group === 0
        ? [['world_yuna_north'],['world_yuna_dock'],['world_clocktower'],['world_twinned_seal'],['world_marshal','world_yuna_north','world_yuna_dock'],['world_yuna_north','world_yuna_dock'],['world_yuna_north','world_yuna_dock']][index]!
        : group === 1
          ? [['world_yuna_north','world_yuna_dock'],['world_mariner_union'],['world_twinned_seal'],['world_yuna_north'],['world_mariner_union'],['world_marshal'],['world_yuna_north']][index]!
          : ['world_mira','world_ren','world_harborwatch','world_archive','world_mariner_union','world_marshal'];
      const kind = text.includes('약속') ? 'commitment' : (text.includes('소문') || text.includes('단정') ? 'claim' : 'event');
      const memoryRefs = group < 2 ? refs as string[] : [refs[index % refs.length] as string];
      const story = makeStory(id, text, session, memoryRefs, kind, { dossier: group + 1, item: index + 1 });
      if (id === 'stress_extra_04_03') story.links = [mlink('stress_extra_04_01','related_to','stress_extra_04_03','같은 시각대에 관측됐을 뿐 인과관계는 확인되지 않음')];
      stories.push(story); global++;
    }
  }
  const custom: Array<{ id: string; session: number; kind: string; text: string; refs: string[]; data?: Record<string, unknown> }> = [
    { id:'stress_correlation_weather', session:48, kind:'claim', text:'폭풍 구름과 구시계탑의 종소리가 같은 저녁에 관측됐으나 종소리가 폭풍을 만들었다는 증거는 없다.', refs:['world_clocktower','world_mira'], data:{ causal_status:'correlation_only' } },
    { id:'stress_correlation_bell', session:48, kind:'event', text:'구시계탑 시계지기는 기압종이 울린 시각을 따로 기록했으며 풍향 변화는 그보다 먼저 시작됐다고 적었다.', refs:['world_clocktower','world_weather_bell'], data:{ causal_status:'correlation_only' } },
    { id:'stress_false_leak', session:49, kind:'claim', text:'익명 쪽지는 기록관 윤아가 봉인 보관함 암호를 시장에 팔았다고 주장했으나 근거를 제시하지 않았다.', refs:['world_yuna_north','world_seal_cabinet'], data:{ support:'rumor', false_leak:true } },
    { id:'stress_verified_no_leak', session:50, kind:'event', text:'문서고 출입표와 봉인 번호 대조 결과 윤아의 암호 판매 주장은 사실이 아닌 것으로 판명됐다.', refs:['world_yuna_north','world_seal_cabinet'], data:{ finding:'rumor_disproved' } },
    { id:'stress_wrong_inventory', session:51, kind:'claim', text:'손상된 표의 번진 숫자를 잘못 읽어 기록관 윤아가 수정정을 가져갔다고 적은 임시 판단.', refs:['world_yuna_north'], data:{ support:'disputed', inference:'unverified' } },
    { id:'stress_verified_inventory', session:52, kind:'event', text:'봉인 원본 재검사에서 해당 수정정은 처음부터 서진의 공구함에 있었고 윤아의 기록과 무관함을 확인했다.', refs:['world_seo','world_yuna_north'], data:{ verified:true } },
    { id:'stress_unknown_mention', session:58, kind:'mention', text:'야간 배전실 입구에 남은 발자국 옆에서 목격된 가면 쓴 연락원. 이름과 소속은 알 수 없다.', refs:['world_glassworks'], data:{ identity:{ state:'unknown' }, mention:'가면 쓴 연락원' } },
    { id:'stress_commitment_last', session:60, kind:'commitment', text:'렌은 다음 조수 전에 북부 부두에서 회수한 구호 상자 수량을 진료소와 맞춰 보기로 했다.', refs:['world_ren','world_north_dock'], data:{ owner:'world_ren', due:'2025-03-10' } },
    { id:'stress_identity_reveal', session:63, kind:'event', text:'배전실 통신원의 인장과 본인 서명을 대조해 가면 쓴 연락원이 하늘이라는 야간 연락원임을 확인했다.', refs:['world_veil_contact'], data:{ resolution:'confirmed_by_seal_and_signature' } },
  ];
  addEntity(63, makeEntity('world_veil_contact','하늘','person','야간 배전실에서 근무하는 연락원. 현장 호출명으로 연락원 17을 사용한다.',['연락원 17','Night courier 17','Haneul']));
  for (const item of custom) stories.push(makeStory(item.id,item.text,item.session,item.refs,item.kind,item.data));
  const correlation = stories.find(item => item.memory.id === 'stress_correlation_bell')!;
  correlation.links = [mlink('stress_correlation_weather','related_to','stress_correlation_bell','동일 시간대의 동시 관측. 원인 관계는 기록되지 않음.')];
  return stories;
}

function distractorText(index: number, sector: string, person: string, recordNo: number, template: number): string {
  const variants = [
    `${sector} 관측소의 ${person}은(는) 제${recordNo}호 바람표에서 등불 진동과 기압 변화를 함께 기록했다.`,
    `${sector} 운송대의 ${person}은(는) 봉인 ${String(recordNo).padStart(4,'0')}번이 다른 문서와 번호가 비슷하다고 보고했다.`,
    `${sector} 회의록에 ${person}의 이름이 두 번 나타났지만 서로 다른 교대조 표기였다.`,
    `${sector} 수문 옆에서 발견한 물자표에는 배수 펌프 점검 시각만 있고 고장 원인은 적혀 있지 않다.`,
    `${sector} 기록원은 비와 종소리가 함께 기록된 사실만 확인했고 한 사건이 다른 사건을 일으켰다고 쓰지 않았다.`,
    `${sector} 순찰 보고서의 ${recordNo}호 쪽지는 발행 기관이 달라 인접 번호 문서와 합칠 수 없다.`,
    `${sector} 주민 ${person}은(는) “검은 돛”을 보았다고 했으나 배 이름이나 방향을 특정하지 못했다.`,
    `${sector}의 ${person}은(는) 다음 조수 전에 창고 표본을 대조하겠다고 약속했다.`,
  ];
  return variants[template % variants.length]!;
}

function buildQueries(paths: Record<string, GameplayPath>, extra: Story[], decoyIds: string[]): GameplayQuery[] {
  const ids = (path: GameplayPath) => [...path.nodes];
  const q = (id: string, category: GameplayQuery['category'], query: string, expected_support_ids: string[], more: Partial<GameplayQuery> = {}): GameplayQuery => ({
    id, space_id: MAIN_SPACE, category, query,
    expected_support_ids: [...new Set([...expected_support_ids, ...(more.expected_paths ?? []).flatMap(path => path.nodes)])],
    limit: 20, ...more,
  });
  const branchA = { nodes: ['stress_chain_c_02','stress_chain_c_03','stress_chain_c_04','stress_chain_c_05','stress_chain_c_06','stress_chain_c_07','stress_chain_c_08','stress_chain_c_09'], relations: paths.c!.relations.slice(1) };
  const branchB = { nodes: ['stress_chain_c_02','stress_chain_c_10','stress_chain_c_11'], relations: ['causes','causes'] };
  const a=paths.a!,b=paths.b!,c=paths.c!,d=paths.d!;
  const multiIds=[...new Set([...a.nodes,...b.nodes,...d.nodes])];
  const queries: GameplayQuery[] = [
    q('ws_causal_01','causal','외곽 진료소에 구호 물자가 제시간에 도착하지 못한 경로를 거슬러 올라가라',ids(a),{expected_paths:[a]}),
    q('ws_causal_02','causal','검문정이 나린의 배를 멈춰 세운 원인 사슬을 찾아라',ids(b),{expected_paths:[b]}),
    q('ws_causal_03','causal','잘못된 기록 담당자에게 책임이 돌아간 사건의 원인을 연결하라',ids(c),{expected_paths:[c]}),
    q('ws_causal_04','causal','조약 협상단이 피해 규모를 확인하지 못한 이유를 추적하라',ids(d),{expected_paths:[d]}),
    q('ws_causal_05','causal','동력 수정 분실 뒤 서로 다른 두 피해 경로가 어떻게 갈라졌나',[...branchA.nodes,...branchB.nodes],{expected_paths:[branchA,branchB]}),
    q('ws_causal_06','causal','세 지역에서 서로 다른 구호·기록 손실이 발생한 전체 선행 원인을 비교하라',multiIds,{expected_paths:[a,b,d],limit:20}),
    q('ws_causal_07','causal','산등성이 길 붕괴가 진료소 백신 격리로 이어진 앞 단계를 찾아라',['stress_chain_a_02','stress_chain_a_03','stress_chain_a_04','stress_chain_a_05','stress_chain_a_06'],{expected_paths:[{nodes:a.nodes.slice(1,6),relations:a.relations.slice(1,5)}]}),
    q('ws_causal_08','causal','지하 기록실의 수위 장부가 판독 불가가 된 과정을 설명하라',['stress_chain_b_02','stress_chain_b_03','stress_chain_b_04','stress_chain_b_05','stress_chain_b_06'],{expected_paths:[{nodes:b.nodes.slice(1,6),relations:b.relations.slice(1,5)}]}),
    q('ws_causal_09','causal','야간 경보가 울리지 않은 뒤 문서고에서 일어난 연쇄를 복원하라',['stress_chain_c_03','stress_chain_c_04','stress_chain_c_05','stress_chain_c_06','stress_chain_c_07'],{expected_paths:[{nodes:c.nodes.slice(2,7),relations:c.relations.slice(2,6)}]}),
    q('ws_causal_10','causal','위조 깃발 뒤 구조 물자가 젖기까지 연결되는 사건을 찾아라',['stress_chain_d_01','stress_chain_d_02','stress_chain_d_03','stress_chain_d_04','stress_chain_d_05'],{expected_paths:[{nodes:d.nodes.slice(0,5),relations:d.relations.slice(0,4)}]}),
    q('ws_causal_11','causal','펌프 기름이 빠진 뒤 검문 지연으로 이어진 원인을 찾아라',['stress_chain_b_01','stress_chain_b_02','stress_chain_b_03','stress_chain_b_04','stress_chain_b_07','stress_chain_b_08','stress_chain_b_09'],{expected_paths:[b]}),
    q('ws_causal_12','causal','동문 수레문이 확인 없이 통과된 뒤 원본 문서가 바뀐 이유는?',['stress_chain_c_04','stress_chain_c_05','stress_chain_c_06','stress_chain_c_07','stress_chain_c_08'],{expected_paths:[{nodes:c.nodes.slice(3,8),relations:c.relations.slice(3,7)}]}),
    q('ws_relationship_01','relationship','기록관 윤아가 열람하거나 비교한 봉인 원본과 판단 기록을 모아라',['stress_extra_01_01','stress_extra_01_05','stress_extra_01_06','stress_verified_no_leak','stress_corrected_inventory','stress_verified_inventory'],{entity_id:'world_yuna_north'}),
    q('ws_relationship_02','relationship','북부 진료소와 렌이 주고받은 구호 물자 기록은?',['stress_chain_a_03','stress_chain_a_06','stress_chain_a_09','stress_commitment_last'],{entity_id:'world_ren'}),
    q('ws_relationship_03','relationship','수문 정비공 서진과 소금 펌프에 연결된 기록은?',['stress_chain_b_01','stress_chain_b_02','stress_chain_b_03','stress_verified_inventory'],{entity_id:'world_seo'}),
    q('ws_relationship_04','relationship','항만 감시대가 확인한 항로 이탈과 검문 기록은?',['stress_chain_a_01','stress_chain_b_08','stress_chain_b_09'],{entity_id:'world_harborwatch'}),
    q('ws_relationship_05','relationship','남쪽 구조선 선장 아라와 신호·항로 기록을 모아라',['stress_chain_d_01','stress_chain_d_02','stress_chain_d_03'],{entity_id:'world_ara'}),
    q('ws_relationship_06','relationship','동력 기술자 진과 유리 공방회의 설비 기록은?',['stress_chain_c_01','stress_chain_c_02'],{entity_id:'world_jin'}),
    q('ws_relationship_07','relationship','쌍문장 인장과 관련된 비교 기록을 찾아라',['stress_extra_01_04','stress_extra_02_03'],{entity_id:'world_twinned_seal'}),
    q('ws_relationship_08','relationship','같은 이름의 윤아 두 명의 역할과 장소를 구분하라',['stress_extra_01_01','stress_extra_01_05','stress_extra_01_06'],{entity_id:'world_yuna_north'}),
    q('ws_identity_01','identity','가면 쓴 연락원의 신원은 최종적으로 어떻게 확인됐나?',['stress_unknown_mention','stress_identity_reveal'],{entity_id:'world_veil_contact'}),
    q('ws_identity_02','identity','미라와 Mira는 서로 다른 인물인가?',['stress_chain_a_01','stress_extra_07_01'],{entity_id:'world_mira'}),
    q('ws_identity_03','identity','영문 별칭 Narin으로 불린 전령의 기록은 무엇인가?',['stress_chain_b_07','stress_chain_b_09'],{entity_id:'world_courier'}),
    q('ws_identity_04','identity','같은 이름 윤아 중 북부 기록관은 누구인가?',['stress_extra_01_01','stress_extra_01_05'],{entity_id:'world_yuna_north'}),
    q('ws_identity_05','identity','같은 이름 윤아 중 부두 운송표를 옮긴 사람은 누구인가?',['stress_extra_01_02','stress_extra_01_06'],{entity_id:'world_yuna_dock'}),
    q('ws_identity_06','identity','가면 쓴 연락원이 언급된 최초 시점에는 이름이 밝혀졌나?',['stress_unknown_mention'],{entity_id:'world_glassworks'}),
    q('ws_temporal_01','temporal','1월 1일부터 1월 9일까지 기상 경보와 진료소 물자 사건을 시간순으로 보라',ids(a),{from:'2025-01-01T00:00:00Z',to:'2025-01-09T23:59:59Z'}),
    q('ws_temporal_02','temporal','1월 11일부터 1월 19일까지 수문과 지하 문서 기록을 시간순으로 보라',ids(b),{from:'2025-01-11T00:00:00Z',to:'2025-01-19T23:59:59Z'}),
    q('ws_temporal_03','temporal','1월 21일부터 1월 31일까지 정전과 하부 문서고 기록을 모아라',[...c.nodes,'stress_chain_c_10','stress_chain_c_11'],{from:'2025-01-21T00:00:00Z',to:'2025-01-31T23:59:59Z'}),
    q('ws_temporal_04','temporal','2월 2일부터 2월 10일까지 남쪽 해협과 구조항 기록을 보라',ids(d),{from:'2025-02-02T00:00:00Z',to:'2025-02-10T23:59:59Z'}),
    q('ws_negative_01','negative','기압종과 구시계탑 종이 같은 날 관측됐다는 사실이 폭풍의 원인을 증명하나?',['stress_correlation_weather','stress_correlation_bell'],{expected_paths:[]}),
    q('ws_negative_02','negative','기록관 윤아가 암호를 팔았다는 제보가 사실인지 확인하라',['stress_verified_no_leak'],{excluded_ids:['stress_false_leak'],expected_paths:[]}),
    q('ws_negative_03','negative','초기 재고 판단을 그대로 현재 사실로 반환하지 말고 정정 이력을 확인하라',['stress_corrected_inventory','stress_verified_inventory'],{excluded_ids:['stress_wrong_inventory'],expected_paths:[]}),
    q('ws_negative_04','negative','가면 쓴 연락원 언급 시점에 실명을 알고 있었나?',['stress_unknown_mention'],{expected_paths:[]}),
    q('ws_negative_05','negative','북부 항구 유사 사건의 평행 세계 기록을 현재 공간 결과에서 제외하라',['stress_chain_a_09'],{excluded_ids:[decoyIds[0]!] }),
    q('ws_negative_06','negative','남부 여울목에서 비슷한 조난 기록이 있어도 다른 평행 공간 기억은 섞지 말라',['stress_chain_d_09'],{excluded_ids:[decoyIds[1]!] }),
  ];
  return queries;
}

function entityDecisions(): EntityDecision[] {
  return [
    { id:'ws_ed_known_mira_alias', mention:'Mira / 米拉', as_of_session:sessionId(8), candidate_entity_ids:['world_mira','world_ren','world_harborwatch'], expected_entity_id:'world_mira' },
    { id:'ws_ed_known_yuna_alias', mention:'允娥', as_of_session:sessionId(63), candidate_entity_ids:['world_yuna_north','world_yuna_dock','world_marshal'], expected_entity_id:'world_yuna_north' },
    { id:'ws_ed_unknown_contact_early', mention:'가면 쓴 연락원', as_of_session:sessionId(58), candidate_entity_ids:['world_mira','world_yuna_north','world_marshal'], expected_entity_id:null },
    { id:'ws_ed_contact_revealed', mention:'가면 쓴 연락원', as_of_session:sessionId(63), candidate_entity_ids:['world_veil_contact','world_marshal','world_yuna_north'], expected_entity_id:'world_veil_contact' },
    { id:'ws_ed_same_yuna_role', mention:'봉인 원본을 열람한 윤아', as_of_session:sessionId(63), candidate_entity_ids:['world_yuna_north','world_yuna_dock'], expected_entity_id:'world_yuna_north', attributes:{ role:'북부 기록관', task:'원본 열람' } },
    { id:'ws_ed_same_yuna_location', mention:'남부 부두의 운송표 담당 윤아', as_of_session:sessionId(63), candidate_entity_ids:['world_yuna_north','world_yuna_dock'], expected_entity_id:'world_yuna_dock', attributes:{ location:'남부 부두', task:'운송표 전달' } },
    { id:'ws_ed_unknown_suspect', mention:'동문에서 본 어두운 망토의 인물', as_of_session:sessionId(24), candidate_entity_ids:['world_jin','world_mira','world_seo'], expected_entity_id:null },
    { id:'ws_ed_unknown_flag', mention:'남쪽 탑의 깃발을 건 사람', as_of_session:sessionId(35), candidate_entity_ids:['world_ara','world_yoon','world_jin'], expected_entity_id:null },
    { id:'ws_ed_known_pilot', mention:'남쪽 여울목 도선사 윤', as_of_session:sessionId(40), candidate_entity_ids:['world_yoon','world_ren','world_seo'], expected_entity_id:'world_yoon' },
    { id:'ws_ed_known_courier', mention:'Narin', as_of_session:sessionId(19), candidate_entity_ids:['world_courier','world_seo','world_mira'], expected_entity_id:'world_courier' },
    { id:'ws_ed_unknown_new_npc', mention:'푸른 장갑을 낀 낯선 연락원', as_of_session:sessionId(12), candidate_entity_ids:['world_seo','world_mira','world_ren'], expected_entity_id:null },
    { id:'ws_ed_same_name_ara', mention:'항해일지 서명을 한 아라', as_of_session:sessionId(63), candidate_entity_ids:['world_ara','world_yuna_north'], expected_entity_id:'world_ara', attributes:{ role:'남쪽 구조선 선장' } },
  ];
}

export function buildWorldStressFixture(input: { size: WorldStressSize; seed: number }): WorldStressFixture {
  const { size, seed } = input;
  if (![256, 1024, 4096].includes(size)) throw new RangeError('size must be 256, 1024, or 4096');
  if (!Number.isInteger(seed) || !Number.isFinite(seed)) throw new TypeError('seed must be a finite integer');
  const entitiesBySession = Array.from({ length: SESSION_COUNT }, () => [] as EntityInput[]);
  const storyData = chainStories();
  const stories = [...storyData.stories, ...extraStory(storyData.entities)];
  if (stories.length !== STORY_COUNT) throw new Error(`authored story count invariant failed: ${stories.length}`);
  for (const item of storyData.entities) entitiesBySession[item.session]!.push(item.entity);
  for (const item of storyData.stories) {
    const chain = item.memory.id!.match(/^stress_chain_([a-d])_(\d+)$/);
    if (chain) {
      const start = chain[1] === 'a' ? 0 : chain[1] === 'b' ? 10 : chain[1] === 'c' ? 20 : 32;
      if (Number(chain[2]) === 1) {
        const ids = new Set(item.memory.entity_ids ?? []);
        for (const entity of storyData.entities.filter(entry => entry.session === start)) ids.add(entity.entity.id!);
        // First chain evidence creates its local cast; entity metadata remains neutral and session-local.
        item.memory.entity_ids = [...ids].slice(0, 8);
      }
    }
  }
  for (const item of storyData.entities) {
    // Chained story entities are introduced in the same session as the first use. Others from that session attach to its first record.
  }
  for (const item of stories) {
    const session = item.session;
    const entitiesKnown = new Set<string>();
    for (let i = 0; i <= session; i++) for (const entity of entitiesBySession[i]!) entitiesKnown.add(entity.id!);
    const futureRef = (item.memory.entity_ids ?? []).find(id => !entitiesKnown.has(id));
    if (futureRef) throw new Error(`story memory ${item.memory.id} references future entity ${futureRef}`);
  }

  // The explicit appendix record is one additional original main-space memory.
  const distractorCount = size - STORY_COUNT - 1;
  const distractorEntityCount = Math.ceil(distractorCount / 4);
  const entityNames = ['윤아','도윤','Ren','Mira','나린','아라','Jin','Yuna','순회대','검은 깃발'];
  const sectors = ['북부 수로','동부 유리시장','남부 여울목','회색 분지','서쪽 제방','은빛 고개','검은 항구 외곽','수림 관측소','하구 창고','돌문 구역'];
  const entityTypes = ['person','faction','place','artifact'];
  const distractors: Story[] = [];
  for (let index = 0; index < distractorEntityCount; index++) {
    const session = (index * 4) % SESSION_COUNT;
    const random = randomFor((seed ^ Math.imul(index + 1, 0x9e3779b9)) >>> 0);
    const type = entityTypes[index % entityTypes.length]!;
    const name = `${entityNames[Math.floor(random() * entityNames.length)]} ${String(index % 97).padStart(2,'0')}`;
    const sector = sectors[Math.floor(random() * sectors.length)]!;
    const entity = makeEntity(`world_generated_entity_${String(index).padStart(5,'0')}`, name, type,
      `${sector}에서 관측·운송·보관 업무에 연결된 ${type} 기록.`, [`${name.split(' ')[0]}-${String(index).padStart(4,'0')}`, `Sector ${index % 64}`]);
    entitiesBySession[session]!.push(entity);
  }
  const distractorEntityFor = new Map<number, string>();
  for (let index = 0; index < distractorCount; index++) {
    const entityIndex = Math.floor(index / 4);
    const entityId = `world_generated_entity_${String(entityIndex).padStart(5,'0')}`;
    distractorEntityFor.set(index, entityId);
    const session = index % SESSION_COUNT;
    const random = randomFor((seed ^ Math.imul(index + 1, 0x85ebca6b)) >>> 0);
    const sector = sectors[Math.floor(random() * sectors.length)]!;
    const person = entityNames[Math.floor(random() * entityNames.length)]!;
    const template = Math.floor(random() * 8);
    const recordNo = (index * 37 + Math.floor(random() * 17)) % 10000;
    const memoryId = `world_distractor_memory_${String(index).padStart(5,'0')}`;
    distractors.push(makeStory(memoryId, distractorText(index,sector,person,recordNo,template),session,[distractorEntityFor.get(index)!],
      template === 7 ? 'commitment' : template === 4 || template === 6 ? 'claim' : 'event',
      { distractor_index:index, sector, record_no:recordNo, seed_variant:Math.floor(random()*256) }));
  }
  const storyBySession = Array.from({ length: SESSION_COUNT }, () => [] as Story[]);
  for (const item of stories) storyBySession[item.session]!.push(item);
  for (const item of distractors) storyBySession[item.session]!.push(item);
  const sessionRecords: RecordInput[][] = Array.from({ length: SESSION_COUNT }, () => []);
  const locationByMemory = new Map<string, { session: number; chunk: number }>();
  const generatedLinks: Array<{ session: number; chunk: number; link: LinkInput }> = [];
  for (let session = 0; session < SESSION_COUNT; session++) {
    const items = storyBySession[session]!;
    for (let offset = 0; offset < items.length; offset += MAX_GROUP_MEMORIES) {
      const group = items.slice(offset, offset + MAX_GROUP_MEMORIES);
      const chunk = offset / MAX_GROUP_MEMORIES;
      const sourceText = `현장 묶음 ${sessionId(session)}-${chunk + 1}: ${group.map(item => item.memory.content).join(' ')}`;
      const record: RecordInput = {
        space_id: MAIN_SPACE,
        evidence: { source_type:'world_stress_session', content:sourceText, metadata:{ session:sessionId(session), group:chunk + 1, seed } },
        memories: group.map(item => item.memory),
        entities: chunk === 0 ? entitiesBySession[session]! : [],
      };
      sessionRecords[session]!.push(record);
      for (const item of group) {
        locationByMemory.set(item.memory.id!, { session, chunk });
        for (const link of item.links ?? []) generatedLinks.push({ session, chunk, link });
      }
    }
  }
  for (const { session, chunk, link } of generatedLinks) {
    const record = sessionRecords[session]![chunk]!;
    record.links = [...(record.links ?? []), link];
  }

  const decoyIds = ['world_decoy_memo_archive','world_decoy_memo_coast'];
  sessionRecords[SESSION_COUNT - 1]!.push(
    { space_id:'world-decoy-archive', evidence:{source_type:'parallel_world',content:'별도 세계의 기록: 북부 구역의 기압종과 문서고 침수는 이 캠페인과 무관하다.'}, entities:[makeEntity('world_decoy_entity_archive','미라','person','평행 세계의 북부 조사원.')], memories:[{id:decoyIds[0],kind:'event',content:'평행 세계의 북부 조사원 미라는 기압종 이상 뒤 문서고에 들어갔다.',occurred_at:isoDay(55),data:{parallel_world:true},entity_ids:['world_decoy_entity_archive']}] },
    { space_id:'world-decoy-coast', evidence:{source_type:'parallel_world',content:'별도 세계의 기록: 남부 여울목에서 다른 구조선이 좌초했다.'}, entities:[makeEntity('world_decoy_entity_coast','아라','person','평행 세계의 남부 선장.')], memories:[{id:decoyIds[1],kind:'event',content:'평행 세계의 선장 아라는 위조 깃발 뒤 다른 여울목으로 향했다.',occurred_at:isoDay(35),data:{parallel_world:true},entity_ids:['world_decoy_entity_coast']}] },
  );
  const sessions = sessionRecords.map((records,index) => ({ id:sessionId(index), label:`세계기 ${index + 1} · ${index < 9 ? '북부 구호선' : index < 19 ? '지하 수문 장부' : index < 31 ? '동력망과 시장' : index < 41 ? '남쪽 해협' : '지역 조사 기록'}`, records }));

  const operationRecord: RecordInput = {
    space_id:MAIN_SPACE,
    evidence:{source_type:'appendix_record',content:'후속 장부 묶음: 구호 상자 인수 수량을 다시 기록했다.'},
    memories:[{id:'stress_operation_record',kind:'event',content:'후속 장부에서 북부 부두 구호 상자 인수 수량을 열두 개로 확정했다.',occurred_at:isoDay(63),data:{count:12},entity_ids:['world_north_dock','world_ren']}],
  };
  const operations = [
    { type:'correct' as const, input:{space_id:MAIN_SPACE,memory_id:'stress_wrong_inventory',replacement:{id:'stress_corrected_inventory',kind:'claim',content:'원본 대조 결과 수정정은 서진의 공구함에 있었으며 기록관 윤아가 가져갔다는 주장은 오독에서 생겼다.',data:{correction:'ledger number misread',support:'disproved'},resolution:'resolved' as const,support:'supported' as const,entity_ids:['world_seo','world_yuna_north']},evidence:{source_type:'verified_correction',content:'인장 번호와 공구함 재고를 현장 대조한 정정 기록.'}} },
    { type:'forget' as const, input:{space_id:MAIN_SPACE,memory_id:'stress_false_leak'} },
    { type:'record' as const, input:operationRecord },
    { type:'resolve' as const, input:{space_id:MAIN_SPACE,mention_id:'stress_unknown_mention',entity_id:'world_veil_contact'} },
  ];
  const queries = buildQueries(storyData.paths, stories, decoyIds);
  const fixture: WorldStressFixture = {
    version:1,
    title:`World stress fixture ${size}`,
    description:'64회 캠페인 기록. 동일한 96개 스토리 기억과 질문을 유지하고, 시드 기반 지역·인물·파벌·문서 distractor를 입력 크기에 맞춰 앞에서부터 추가한다. 인과는 명시적 causes/enables 링크만 사용하고, 동시 관측은 related_to 또는 단순 기록으로 구분한다.',
    space_id:MAIN_SPACE,
    sessions,
    operations,
    queries,
    entity_decisions:entityDecisions(),
    generation:{
      size,seed,sessions:SESSION_COUNT,main_original_memories:size,authored_story_memories:STORY_COUNT,
      distractor_memories:distractorCount,story_entities:entitiesBySession.flat().filter(entity=>!entity.id!.startsWith('world_generated_entity_')).length,
      distractor_entities:distractorEntityCount,main_entities:entitiesBySession.flat().length,
      decoy_spaces:2,operation_records:1,decoy_memories:2,main_records:sessionRecords.flat().filter(record=>record.space_id===MAIN_SPACE).length,
      evidence_characters:sessionRecords.flat().filter(record=>record.space_id===MAIN_SPACE).reduce((sum,record)=>sum+record.evidence.content.length,0),
    },
  };
  return fixture;
}
