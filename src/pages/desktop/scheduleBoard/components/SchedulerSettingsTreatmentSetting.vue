<script setup>
import {computed, nextTick, onBeforeUnmount, onMounted, ref, watch} from 'vue';
import {storeToRefs} from 'pinia';
import dayjs from 'dayjs';
import {cloneDeep, isEqual} from 'lodash-es';
import {push} from 'notivue';
import {useDialog} from '@/lib/useDialog';
import {useStaffStore} from '@/stores/staffStore';
import {useHolidayStore} from '@/stores/holidayStore';
import {useSchedulerFilterStore} from '@/stores/useSchedulerFilterStore';
import {getSiteWorkHours, getStaffWorkHours, getTreatmentSettings, saveTreatmentSettings} from '@/api/siteApi';
import {assignUnassigned, getUnassignedReservations} from '@/api/bookApi';
import UiSegmentedControl from '@/components/ui/UiSegmentedControl.vue';
import CellMorePopover from './CellMorePopover.vue';

const staffStore = useStaffStore();
const {doctors} = storeToRefs(staffStore);
const holidayStore = useHolidayStore();
const filterStore = useSchedulerFilterStore();
const dialog = useDialog();

/* 조회(baseline) 실패 시 안내 문구 — bookStore 의 일시적 장애 안내와 동일 문구를 재사용한다.
 * 저장 게이트: baseline 을 못 읽은 채 전체 치환 저장하면 그 원천 데이터가 통삭제된다(#2).
 *
 * ★게이트는 **원천별**이다 — 한쪽 장애가 다른 쪽 저장까지 막지 않는다.
 *  BE 계약(POST settings/save) — 필드 미전송(null) = 그 파트를 아예 손대지 않음:
 *   teams 미전송 → 자체 파트 통째 skip / workingHours 미전송 → 담당자 운영시간·오버라이드 미변경 / site 미전송 → 사업장 파트 통째 skip.
 *  - teamLoadFailed : getTreatmentSettings(팀)          → 실패 시 teams=[] 로 저장하면 팀·구성원 전멸
 *  - staffLoadFailed : getStaffWorkHours(담당자 운영시간)   → 자체 TB
 *  - siteLoadFailed : getSiteWorkHours(사업장 + 휴무규칙) → 원천 사업장 설정
 *  각 플래그는 소유한 hydrate 함수 하나만 쓴다(서로 덮어쓰기 금지). */
const SERVICE_UNAVAILABLE_MSG = '일시적인 서비스 접근 불가입니다.\n잠시 후에 다시 시도해주세요.';
const teamLoadFailed = ref(false);
const staffLoadFailed = ref(false);
const siteLoadFailed = ref(false);

/* ===== 전송 가능 파트 판정 (3축 독립) =====
 * BE 계약상 파트는 셋이고, 각 파트는 "미전송(null) = 그 파트 손대지 않음" 이다.
 *
 *  ① teams        : 팀 + 구성원.               자체 소유 → 팀만 읽혔으면 저장된다.
 *  ② workingHours : 담당자 운영시간 + 오버라이드. 자체 소유지만 **teams 에 의존**한다 —
 *     BE 가 요청 payload 의 teams 로 "팀 소속 담당자만" 걸러 저장하기 때문이다.
 *     신규 팀은 아직 채번 전이라 DB 조회로 대체할 수 없다 → workingHours 를 보낼 땐 teams 도 반드시 보낸다.
 *  ③ site 번들    : 사업장 운영시간 + 휴무규칙/지정일자/공휴일. 원천 사업장 설정, site 조회 하나가 전부의 baseline.
 *
 * ★팀은 운영시간에 엮이지 않는다 — 담당자 운영시간(staff)을 못 읽었다고 팀 저장이 막히면
 *  "팀을 저장하려면 운영시간이 반드시 있어야 한다" 가 되어 잘못이다. */
const canSaveTeams = computed(() => !teamLoadFailed.value);
const canSaveWorkingHours = computed(() => !teamLoadFailed.value && !staffLoadFailed.value);
const canSaveSite = computed(() => !siteLoadFailed.value);

/* 인라인 안내 배너 노출 조건 — 어느 한 원천이라도 실패 */
const loadFailed = computed(() => teamLoadFailed.value || staffLoadFailed.value || siteLoadFailed.value);
/* 저장 완전 차단 — 저장할 수 있는 파트가 하나도 없을 때만.
 * staff 단독 실패는 여기 해당하지 않는다 — 팀은 저장할 수 있고, workingHours 는 단독으로
 * 저장 가능한 파트가 아니라서(teams 의존) 버튼 활성 여부를 좌우하지 않는다. */
const saveBlocked = computed(() => teamLoadFailed.value && siteLoadFailed.value);

/* ===== 편집 잠금 (게이트의 대우) =====
 * 저장할 수 없는 파트는 **입력 자체를 막는다**. 저장 시점에 편집을 버리고 안내하는 방식은
 * "다른 데이터까지 저장 안 된 것처럼" 읽혀 오해를 낳았다 — 애초에 버릴 편집이 생기지 않게 한다.
 * 이유 설명은 기존 인라인 배너(loadFailed)가 계속 맡는다(신규 문구 없음).
 *
 *                       ★팀 조회 실패 시 함께 잠긴다 — BE 가 요청 teams 로 대상 담당자를 거르므로
 *                         팀 없이는 저장 자체가 불가능하다(canSaveWorkingHours 정의 그대로).
 *  siteLocked         : 사업장 운영시간(요일별 편집)
 *
 * 잠금은 UI(disabled)와 상태 변경 함수 진입부 양쪽에 건다(이중 방어) — 팝업·키보드·프로그램 경로로 새는 것 방지. */
const siteLocked = computed(() => !canSaveSite.value);

/* 좌측 상단 탭 */
const LEFT_TAB_ITEMS = [
  {value: 'OFF', label: '휴무일'},
  {value: 'WORKING_HOURS', label: '운영시간'},
];

const WEEKDAY_LABELS = ['일', '월', '화', '수', '목', '금', '토'];

/* 요일 휴무 반복 옵션 (다중 선택) */
const RECURRING_OPTIONS = [
  {value: 'WEEKLY', label: '매주'},
  {value: 'MONTHLY_1', label: '매월 1번째'},
  {value: 'MONTHLY_2', label: '매월 2번째'},
  {value: 'MONTHLY_3', label: '매월 3번째'},
  {value: 'MONTHLY_4', label: '매월 4번째'},
  {value: 'MONTHLY_5', label: '매월 5번째'},
];

/* 담당자 목록은 staffStore.doctors 사용 — 부모(scheduleBoard)에서 bookStore가 loadDoctor() 호출 완료 상태.
 * 식별자는 staffId(number) 사용 — 백엔드 external_staff_no 컬럼과 그대로 매핑됨 */
function getDoctor(staffId) {
  return doctors.value.find(d => d.staffId === staffId);
}

const props = defineProps({
  initialYear: {type: Number, default: () => dayjs().year()},
});

// 부분 저장(⚙ 모달)이 사라져 'reload' 는 더 이상 발생하지 않는다 —
// 기관 운영시간도 최종 저장 버튼으로 나가고, 그때 부모가 팝업을 닫으며 보드를 재조회한다.
const emit = defineEmits(['cancel', 'save']);

/* 운영시간 탭 — 블록 종류 분리:
 * - WORK: 진료 블록. 시작~종료 단일 구간 하나뿐이다(오전/오후/야간 3세션은 폐기).
 *   사업장·담당자 모두 요일별로 편집한다.
 * - BREAK: 휴게시간1·2. **사업장만 소유한다.** 담당자 화면에서는 기관 값을 읽기 전용으로 보여줄 뿐이고,
 *   보드에서도 의사 컬럼에 기관 휴게가 그대로 그려진다.
 * 코드 심볼(LUNCH/DINNER)과 API 필드(lunchStartHm·dinnerStartHm)는 그대로 두고 화면 표기만 휴게시간1/2 다. */
const WORK_BLOCK_KINDS = ['WORK'];
const BREAK_BLOCK_KINDS = ['LUNCH', 'DINNER'];
const BLOCK_KIND_LABEL = {
  WORK  : '운영시간',
  LUNCH : '휴게시간1',
  DINNER: '휴게시간2',
};

/* INSTITUTION 모드 캘린더 셀의 직원 entry 최대 표시 개수 — 초과 시 "더보기" popover */
const CELL_ENTRY_VISIBLE_MAX = 3;

/* 사업장 운영시간(요일별) — 원천은 사업장 설정.
 *  - WORK: Map<weekday, Block[]>. 진료 블록(WORK) 하나뿐이다.
 *  - BREAK: Map<weekday, {LUNCH:{start,end}|null, DINNER:{start,end}|null}>.
 *    ⚠️ 휴게를 WORK 의 Block[] 에 섞지 않는다 — 표시·집계·전송 코드가 WORK 를 운영시간으로만 보므로
 *       섞으면 진료 구간 자리에 휴게가 끼어든다. */
const institutionWeeklyDayMap = ref(new Map());
const institutionBreaksByWeekday = ref(new Map());

/* 사업장 공휴일 운영시간 — 원천은 사업장 설정 공휴일 운영시간 테이블.
 * 요일 축이 없어 사업장당 한 세트뿐인데, 요일 편집 popover 를 그대로 쓰려고
 * 한 칸(HOLIDAY_SLOT)짜리 Map 으로 담는다.
 * ⚠️ institutionWeeklyDayMap 에 특수 키로 섞지 않는다 — 그 Map 을 요일로 순회하는 곳
 *   (institutionDefaultDayMap · institutionBreakSummary · buildInstitutionTimesPayload)에
 *   공휴일이 요일 행으로 새어 나가 담당자 기본값이나 site[] 에 엉뚱한 dayCd 로 실린다.
 * 공휴일에 쉬는지 여부는 여기가 아니라 includePublicHolidays(=holidayClosedYn) 가 갖는다 —
 * 휴무로 바꿔도 시간 값은 지우지 않고 보존한다(다시 진료로 되돌렸을 때 살아 있어야 한다). */
const HOLIDAY_OWNER = 'INSTITUTION_HOLIDAY';
const HOLIDAY_SLOT = 0;
const institutionHolidayDayMap = ref(new Map());
const institutionHolidayBreaks = ref(new Map());

/* ownerKey('STAFF:<id>') × weekday × WeekdayBlock[]
 * blocks 비어있거나 entry 자체가 없으면 해당 요일 휴무 */
const workingHoursByOwner = ref(new Map());

function getOwnerDayMap(ownerKey) {
  if (ownerKey === 'INSTITUTION') return institutionWeeklyDayMap.value;
  if (ownerKey === HOLIDAY_OWNER) return institutionHolidayDayMap.value;
  return workingHoursByOwner.value.get(ownerKey);
}

/* 그 소유자·칸의 휴게시간 — 없으면 빈 값. 휴게는 사업장(요일별·공휴일)만 소유한다. */
function getBreaksFor(ownerKey, weekday) {
  const source = ownerKey === HOLIDAY_OWNER
      ? institutionHolidayBreaks.value
      : institutionBreaksByWeekday.value;
  return source.get(weekday) ?? {LUNCH: null, DINNER: null};
}

/* 사업장의 그 요일 휴게시간 — 없으면 빈 값 */
function getInstitutionBreaks(weekday) {
  return getBreaksFor('INSTITUTION', weekday);
}

function getBlocksFor(ownerKey, weekday) {
  return getOwnerDayMap(ownerKey)?.get(weekday) ?? [];
}

function hasBlocksFor(ownerKey, weekday) {
  return getBlocksFor(ownerKey, weekday).length > 0;
}

/* ===== 담당자 운영시간 7행 인라인 편집 ===== */

/* 사업장 운영시간을 담당자 요일맵 모양으로. 운영시간을 한 번도 정하지 않은 담당자의 기본값이다. */
function institutionDefaultDayMap() {
  const m = new Map();
  for (const [weekday, blocks] of institutionWeeklyDayMap.value) {
    const work = blocks.find(b => b.kind === 'WORK');
    if (work) m.set(weekday, [{...work}]);
  }
  return m;
}

/* 운영시간을 한 번도 정하지 않은 담당자인가 — 그렇다면 화면·저장 모두 사업장 값을 기본값으로 쓴다.
 * (요일 하나라도 정했으면 그 사람의 설정을 그대로 존중한다. 비워 둔 요일은 "그 요일 휴무"이다.) */
function usesInstitutionDefault(staffId) {
  return isUnsetStaffOwner(`STAFF:${staffId}`);
}

function isUnsetStaffOwner(ownerKey) {
  if (!ownerKey || !ownerKey.startsWith('STAFF:')) return false;
  const dayMap = workingHoursByOwner.value.get(ownerKey);
  return !dayMap || dayMap.size === 0;
}

/* 그 담당자·요일의 진료 시작/종료("HH:MM").
 * 운영시간을 한 번도 정하지 않았으면 사업장 운영시간을 기본값으로 보여준다 —
 * 기관 값을 방금 화면에서 입력했더라도 즉시 따라온다(읽는 시점에 참조하므로). */
function fetchStaffWorkHours(staffId, weekday, field) {
  const source = usesInstitutionDefault(staffId)
      ? institutionDefaultDayMap()
      : workingHoursByOwner.value.get(`STAFF:${staffId}`);

  const block = source.get(weekday)?.find(b => b.kind === 'WORK');
  return block?.[field] ?? '';
}

/* 시작·종료를 모두 비우면 그 요일은 휴무이다 — entry 를 지우지 않고 빈 배열로 남긴다.
 * 지워 버리면 "미설정"으로 되돌아가 사업장 기본값이 도로 나타난다.
 * 한쪽만 입력된 중간 상태는 그대로 두되, 저장 payload 에서 짝이 안 맞으면 휴무로 나간다. */
function setStaffWorkHours(staffId, weekday, field, value) {
  const ownerKey = `STAFF:${staffId}`;
  const next = new Map(workingHoursByOwner.value);

  /* 아직 아무 요일도 정하지 않았다면 화면에는 사업장 값이 보이고 있다.
   * 한 요일을 고치는 순간 보이던 값들을 그대로 확정한다 — 그러지 않으면 나머지 요일이 빈칸이 된다. */
  const dayMap = usesInstitutionDefault(staffId)
      ? institutionDefaultDayMap()
      : new Map(next.get(ownerKey));

  const cur = dayMap.get(weekday)?.find(b => b.kind === 'WORK') ?? {kind: 'WORK', start: '', end: ''};
  const block = {...cur, [field]: value || ''};

  if (!block.start && !block.end) dayMap.set(weekday, []);
  else dayMap.set(weekday, [block]);

  next.set(ownerKey, dayMap);
  workingHoursByOwner.value = next;
}

/* X 버튼 — 그 요일의 진료 시작·종료를 한 번에 비운다(= 그 요일 휴무).
 * setStaffWorkHours 과 동일 규칙: entry 를 지우지 않고 빈 배열로 남긴다(지우면 미설정으로 되돌아가 기관 기본값이 도로 나온다).
 * 미설정 담당자는 보이던 기관 기본값을 먼저 확정해야 나머지 요일이 빈칸이 되지 않는다. */
function clearStaffWorkHours(staffId, weekday) {
  const ownerKey = `STAFF:${staffId}`;
  const next = new Map(workingHoursByOwner.value);
  const dayMap = usesInstitutionDefault(staffId)
      ? institutionDefaultDayMap()
      : new Map(next.get(ownerKey));

  dayMap.set(weekday, []);

  next.set(ownerKey, dayMap);
  workingHoursByOwner.value = next;
}

/* 담당자 표 위에 얹는 사업장 휴게시간 안내.
 * 휴게는 사업장이 요일별로 가질 수 있지만, 담당자에게는 편집 대상이 아니라 "따르게 되는 값"이다.
 * 그래서 요일마다 반복하지 않고 한 줄로 보여준다 — 진료하는 요일들의 값이 모두 같으면 그 값을,
 * 요일마다 다르면 그 사실을 알린다(기관 패널에서 요일별로 확인해야 한다). */
function institutionBreakSummary(kind) {
  const values = new Set();
  for (const [weekday, blocks] of institutionWeeklyDayMap.value) {
    if (blocks.length === 0) continue;
    const range = getInstitutionBreaks(weekday)[kind];
    values.add(range ? `${range.start}~${range.end}` : '-');
  }
  if (values.size === 0) return '-';
  if (values.size === 1) return [...values][0];
  return '요일별 상이';
}

/* 특정 날짜 × 특정 직원 override — Map<'STAFF:<id>', Map<'YYYY-MM-DD', Block[]>>
 *  - entry 존재 + blocks=[]: 그 날짜만 휴무 (정상 override)
 *  - entry 없음: override 없음 → weekly recurring fallback
 * INSTITUTION 모드 캘린더 셀의 직원 entry 클릭 → cellStaffEditor 로 편집 */
const workingHoursOverridesByOwner = ref(new Map());

/* date override 우선, 없으면 weekly recurring */
function getEffectiveBlocks(ownerKey, dateKey, weekday) {
  const override = workingHoursOverridesByOwner.value.get(ownerKey)?.get(dateKey);
  if (override !== undefined) return override;
  return getBlocksFor(ownerKey, weekday);
}

/* 그 날짜를 "휴무로 정한" 것인가 — 아직 정하지 않은 것(미설정)과 구별한다.
 * 둘 다 진료 구간이 없지만 뜻이 다르다: 휴무는 확정된 답이고, 미설정은 사업장 운영시간을 따른다.
 * 일자 지정이 있으면 그것이 답이고(빈 blocks = 그 날짜만 휴무), 없으면 요일 설정을 본다.
 * 요일 entry 자체가 없으면 = 그 요일을 정한 적이 없다. */
function isExplicitlyOff(ownerKey, dateKey, weekday) {
  const override = workingHoursOverridesByOwner.value.get(ownerKey)?.get(dateKey);
  if (override !== undefined) return override.length === 0;
  const dayMap = getOwnerDayMap(ownerKey);
  return dayMap?.has(weekday) === true && dayMap.get(weekday).length === 0;
}

/* ===== 운영시간 서버 응답 변환 =====
 * 백엔드 "HHmm" → 내부 "HH:MM" (popover <input type="time"> 호환) */
function hmmToHHMM(hmm) {
  if (!hmm || hmm.length !== 4) return null;
  return `${hmm.slice(0, 2)}:${hmm.slice(2, 4)}`;
}

/* 의료인주간(B) 한 요일 row → blocks 배열 (staff* 필드)
 * 시작·종료가 없으면 빈 배열 (= 그 요일 휴무) */
function staffRowToBlocks(row) {
  const s = hmmToHHMM(row.staffOpenHm);
  const e = hmmToHHMM(row.staffCloseHm);
  return (s && e) ? [{kind: 'WORK', start: s, end: e}] : [];
}

/* 지정일자(C) override row → blocks 배열 (*Dsnt* 필드)
 * 시작·종료가 없으면 빈 배열 — override 는 "그 날짜만 휴무" 이라는 뜻이므로 정상 값이다. */
function overrideRowToBlocks(ov) {
  const s = hmmToHHMM(ov.overrideOpenHm);
  const e = hmmToHHMM(ov.overrideCloseHm);
  return (s && e) ? [{kind: 'WORK', start: s, end: e}] : [];
}

/* 그 요일이 매주 휴무인가 — 휴무일 탭의 반복 휴무요일(원천=사업장 설정)에서 판정한다.
 *
 * 운영시간 탭은 "요일별 주간 패턴"이라 매주 휴무인 요일만 휴무로 표시할 수 있다.
 * "매월 n번째"는 그 요일이 매주 쉬는 것이 아니므로(예: 매월 3번째 수요일만 휴무) 여기서 제외한다 —
 * 특정 날짜의 휴무는 월 캘린더에서 확인한다. */
function isWeekdayClosed(weekday) {
  return weekdayOffs.value.get(weekday)?.has('WEEKLY') ?? false;
}

/* times[](저장된 요일 행만) → Map<dayCd, Block[]>.
 * ★행이 있다는 것 자체가 "그 요일을 정했다"는 뜻이므로 빈 blocks 도 entry 로 남긴다 —
 * 버리면 명시적 휴무가 미설정으로 강등돼, 다시 저장할 때 사업장 값이 도로 채워진다.
 * setStaffWorkHours / clearStaffWorkHours 이 쓰는 표현과 같다:
 *   entry 없음 = 미설정 / entry = [] = 휴무 / entry = [block] = 진료.
 * 결과가 통째로 비면 = 한 번도 정하지 않은 담당자 → 사업장 값을 기본값으로 쓴다
 * (채워 넣지 않고 읽는 시점에 참조한다 — fetchStaffWorkHours 참고). */
function timesToDayMap(times) {
  const m = new Map();
  for (const row of times ?? []) {
    m.set(row.dayCd, staffRowToBlocks(row));
  }
  return m;
}

/* 사업장 패널 — 그 요일의 운영시간 "09:00~18:00". 사업장 설정에 등록된 실값이다.
 * (담당자 운영시간을 합산해 기관 시간을 추정하던 방식은 폐기했다 — 기관 운영시간이 요일별
 *  실값으로 존재하므로 추정할 이유가 없다.) */
function formatSiteHours(weekday) {
  const block = (institutionWeeklyDayMap.value.get(weekday) ?? []).find(b => b.kind === 'WORK');
  return block ? `${block.start}~${block.end}` : '';
}

/* 사업장 패널 — 그 요일의 휴게시간1/2. 미설정이면 '-' */
function formatInstitutionBreak(weekday, kind) {
  const range = getInstitutionBreaks(weekday)[kind];
  return range ? `${range.start}~${range.end}` : '-';
}

function hasInstitutionDisplayBlocks(weekday) {
  return (institutionWeeklyDayMap.value.get(weekday) ?? []).length > 0;
}

/* 사업장 패널 — 공휴일 운영시간/휴게시간. 요일별과 같은 규약이되 칸이 하나뿐이다. */
function formatSiteHolidayHours() {
  const block = (institutionHolidayDayMap.value.get(HOLIDAY_SLOT) ?? []).find(b => b.kind === 'WORK');
  return block ? `${block.start}~${block.end}` : '';
}

function formatInstitutionHolidayBreak(kind) {
  const range = getBreaksFor(HOLIDAY_OWNER, HOLIDAY_SLOT)[kind];
  return range ? `${range.start}~${range.end}` : '-';
}

function hasInstitutionHolidayBlocks() {
  return (institutionHolidayDayMap.value.get(HOLIDAY_SLOT) ?? []).length > 0;
}

/* 공휴일 운영시간의 **전체 구간**(WORK)이 시작·종료 모두 채워져 있는가.
 * 휴게(점심·저녁) 행만 있는 상태는 운영시간을 정한 것이 아니다 — BE 의 "전체구간 공백" 검사와 같은 기준. */
function hasSiteHolidayHoursRange() {
  return (institutionHolidayDayMap.value.get(HOLIDAY_SLOT) ?? [])
      .some(b => b.kind === 'WORK' && b.start && b.end);
}


/* 상태 */
const activeLeftTab = ref('OFF');
const includePublicHolidays = ref(true);

/* 공휴일에 쉬기로 했으면 운영시간을 정할 이유가 없어 편집을 막는다(휴무일 탭 체크박스에서 풀어야 한다).
 * 매주 휴무 요일의 요일버튼을 잠그는 것과 같은 규약이다. 값 자체는 지우지 않고 보존한다. */
const holidayTimeLocked = computed(() => includePublicHolidays.value || siteLocked.value);
// 서버 조회(hydrateFromServer) 완료 여부 — 완료 전에는 공휴일 토글을 그리지 않아
// default(true) → 저장값 반영 사이의 깜빡임(true→false)을 없앤다.
const settingsLoaded = ref(false);
const selectedYear = ref(props.initialYear);
const selectedMonth = ref(dayjs().month() + 1); // 1~12

const weekdayOffs = ref(new Map());
const openWeekday = ref(null);
const dropdownPosition = ref({top: 0, left: 0});
const weekdayBtnRefs = new Map();

function setWeekdayBtnRef(idx, el) {
  if (el) weekdayBtnRefs.set(idx, el);
  else weekdayBtnRefs.delete(idx);
}
const dateOverrides = ref(new Map());

const teams = ref([]);
const selectedTeamIds = ref(new Set());

/* 운영시간 탭: 현재 펼쳐진 항목 키 ('staff:<staffId>' | 'institution' | null) — 한 번에 하나만 */
const expandedTreatmentKey = ref(null);

function toggleTreatmentExpansion(key) {
  expandedTreatmentKey.value = expandedTreatmentKey.value === key ? null : key;
}

/* ===== 요일 편집 popover =====
 * 사업장 요일 버튼과 담당자 일자별 지정(월 캘린더)에서 쓴다.
 * 담당자 주간 운영시간은 popover 를 쓰지 않는다 — 7행 인라인 표에서 바로 편집한다.
 * draft 구조:
 *   WORK  { WORK: {active, start, end} } — 비활성 블록도 시간 보존
 *   BREAK { [LUNCH|DINNER]: {start, end} } — 사업장에서만. 토글 없이 시간 존재 여부로 활성 판단 */
const weekdayEditor = ref({
  open    : false,
  ownerKey: null,
  weekday : 0,
  top     : 0,
  left    : 0,
  draft   : null,
  /* 닫기를 시도했는가 — 미완성 입력 하이라이트를 그 뒤에만 그린다(입력 중엔 빨갛게 하지 않는다). */
  tried   : false,
});

/* 휴게시간은 사업장만 소유한다 — 담당자는 기관 휴게를 그대로 따르므로 편집 대상이 아니다.
 * 공휴일 운영시간도 사업장 소유라 휴게시간1·2 를 함께 갖는다. */
function editorHasBreaks(ownerKey) {
  return ownerKey === 'INSTITUTION' || ownerKey === HOLIDAY_OWNER;
}

/* popover draft → 진료 Block[].
 * 사용여부 토글을 두지 않는다 — 시작·종료가 모두 있으면 진료, 비우면 그 요일/날짜는 휴무이다.
 * (휴게시간과 같은 규약이고, 담당자 7행 인라인 표와도 같다.) */
function draftToBlocks(draft) {
  const blocks = [];
  for (const kind of WORK_BLOCK_KINDS) {
    const slot = draft[kind];
    if (slot?.start && slot?.end) blocks.push({kind, start: slot.start, end: slot.end});
  }
  return blocks;
}

/* 시간이 덜 채워진 행 — 흐리게 표시한다(입력 중 or 휴무). */
function isEditorSlotEmpty(draft, kind) {
  const slot = draft?.[kind];
  return !slot?.start || !slot?.end;
}

const INCOMPLETE_TIME_MSG = '시작시간과 종료시간을 모두 입력해 주세요.';

/* 공휴일에 진료하기로 했으면 공휴일 운영시간을 반드시 정해야 한다.
 * 시간이 없어도 그날은 휴무가 아니라 **종일진료**다(useSchedulerRules 주석 참조) — 즉 시간 제한 없이
 * 하루가 통째로 열린다. 대개는 그런 의도가 아니라 입력 누락이라 저장 시점에 한 번 잡아 준다.
 * 공휴일 운영시간(공휴일 운영시간 테이블)은 시작·종료시분이 NOT NULL 이라 "시간 없는 공휴일 진료" 행
 * 자체가 저장되지 않는다는 점도 같다 — 입력하지 않으면 정한 것이 아무것도 남지 않는다. */
const HOLIDAY_TIME_REQUIRED_MSG = '공휴일에 진료하려면 공휴일 운영시간을 입력해 주세요.';

/* 한쪽만 채워진 시간 행 = 미완성. 하나라도 입력했으면 시작·종료 둘 다 있어야 한다.
 * 둘 다 비운 것은 정상이다 — 진료행은 "그 요일 휴무", 휴게행은 "휴게 없음"이라는 뜻이다.
 *
 * ★이 가드가 없으면 반쪽 입력이 조용히 버려진다(blocksToWorkRange 가 짝이 안 맞으면 null 로 바꾼다).
 *  사용자는 09:00 을 입력해 두고 저장했는데 그 요일이 휴무로 저장돼 있는 상황이 된다.
 * @returns 미완성인 첫 행의 kind, 없으면 null */
function findIncompleteSlot(draft) {
  for (const kind of [...WORK_BLOCK_KINDS, ...BREAK_BLOCK_KINDS]) {
    const slot = draft?.[kind];
    if (!slot) continue; // 그 소유자가 갖지 않는 행(예: 담당자의 휴게)
    if (!!slot.start !== !!slot.end) return kind;
  }
  return null;
}

/* 미완성 블록(시작·종료 중 하나만 있는 것)을 가진 첫 소유자의 ownerKey — 저장 직전 최종 가드.
 * popover 는 commit 에서 이미 막지만, 담당자 주간 7행 인라인 표는 중간 상태를 그대로 두므로
 * (입력 중에 매 글자 막을 수 없다) 저장 시점에 한 번 더 본다.
 * ownerKey 를 돌려주는 이유 = 저장 가드가 그 패널을 펼쳐 하이라이트를 화면에 올리기 위해서다. */
function findIncompleteOwner(dayMapByOwner) {
  for (const [ownerKey, dayMap] of dayMapByOwner.entries()) {
    for (const blocks of (dayMap?.values?.() ?? [])) {
      for (const b of blocks ?? []) {
        if (!!b.start !== !!b.end) return ownerKey;
      }
    }
  }
  return null;
}

/* ===== 미완성 입력 하이라이트 =====
 * 예약등록 팝업과 같은 규약 — `data-invalid="true"` 에 빨간 테두리. 입력 중에는 그리지 않고
 * **넘어가려 시도한 뒤에만**(tried) 그린다. 시작·종료 중 한쪽만 채운 행에서 **비어 있는 칸**,
 * 즉 사용자가 채워야 할 칸을 가리킨다. 짝이 맞춰지면 판정이 스스로 풀리므로 해제 코드는 없다. */
const saveTried = ref(false);

function isIncompletePair(start, end) {
  return !!start !== !!end;
}

/* 담당자 주간 7행 인라인 표 — 저장 시도 후에만. */
function staffTimeInvalid(staffId, weekday, field) {
  if (!saveTried.value) return false;
  const start = fetchStaffWorkHours(staffId, weekday, 'start');
  const end = fetchStaffWorkHours(staffId, weekday, 'end');
  if (!isIncompletePair(start, end)) return false;
  return field === 'start' ? !start : !end;
}

/* popover(요일 편집 · 일자 override) — 그 editor 에서 닫기를 시도한 뒤에만. */
function editorSlotInvalid(editor, kind, field) {
  if (!editor?.tried) return false;
  const slot = editor.draft?.[kind];
  if (!slot || !isIncompletePair(slot.start, slot.end)) return false;
  return field === 'start' ? !slot.start : !slot.end;
}

/* 미완성 행이 있는 담당자 패널을 펼쳐 하이라이트를 화면에 올린다.
 * 좌측 탭이 휴무일이면 운영시간 탭으로 옮긴다 — 거기서도 저장 버튼을 누를 수 있기 때문이다. */
function expandIncompleteOwner(ownerKey) {
  if (!ownerKey?.startsWith?.('STAFF:')) return; // 기관·공휴일은 popover commit 이 이미 막는다
  activeLeftTab.value = 'WORKING_HOURS';
  expandedTreatmentKey.value = `staff:${ownerKey.slice('STAFF:'.length)}`;
}

function buildWeekdayDraft(ownerKey, weekday) {
  const existing = new Map(getBlocksFor(ownerKey, weekday).map(b => [b.kind, b]));
  const draft = {};
  for (const kind of WORK_BLOCK_KINDS) {
    const block = existing.get(kind);
    draft[kind] = {start: block?.start ?? '', end: block?.end ?? ''};
  }
  if (editorHasBreaks(ownerKey)) {
    const breaks = getBreaksFor(ownerKey, weekday);
    for (const kind of BREAK_BLOCK_KINDS) {
      const b = breaks[kind];
      draft[kind] = {start: b?.start ?? '', end: b?.end ?? ''};
    }
  }
  return draft;
}

/* 사업장 요일 편집 popover 는 site(사업장 설정) 번들 소유다 — openWeekdayEditor 호출부가 INSTITUTION 뿐이다. */
function openWeekdayEditor(event, ownerKey, weekday) {
  event.stopPropagation();
  if (siteLocked.value) return;
  /* 공휴일에 쉬기로 했으면 시간을 정할 수 없다 — 버튼 disabled 와 같은 규칙을 여기서 한 번 더 막는다. */
  if (ownerKey === HOLIDAY_OWNER && holidayTimeLocked.value) return;
  /* 다른 popover가 열려 있으면 먼저 commit (이전 요일 편집 보존).
   * 미완성 입력이라 커밋이 막히면 새 편집기를 열지 않는다 — 열면 붙잡아 둔 입력이 그대로 버려진다. */
  if (weekdayEditor.value.open && !commitWeekdayEditor()) return;

  const rect = event.currentTarget.getBoundingClientRect();
  weekdayEditor.value = {
    open    : true,
    ownerKey,
    weekday,
    top     : rect.bottom + 4,
    left    : rect.left,
    draft   : buildWeekdayDraft(ownerKey, weekday),
    tried   : false, // 새로 열 때마다 하이라이트는 꺼진 상태로 시작
  };
}

function setEditorBlockTime(kind, field, value) {
  if (siteLocked.value) return;
  const draft = weekdayEditor.value.draft;
  if (!draft) return;
  weekdayEditor.value = {
    ...weekdayEditor.value,
    draft: {...draft, [kind]: {...draft[kind], [field]: value}},
  };
}

/* @returns 커밋하고 닫았으면 true, 미완성 입력이라 붙잡아 뒀으면 false */
function commitWeekdayEditor() {
  /* 잠긴 파트는 커밋도 하지 않고 닫는다 — 외부클릭/스크롤 경로에서도 호출되므로 여기서 한 번 더 막는다 */
  if (siteLocked.value) {
    closeWeekdayEditor();
    return true;
  }
  const {ownerKey, weekday, draft} = weekdayEditor.value;
  if (!ownerKey || !draft) {
    closeWeekdayEditor();
    return true;
  }

  /* 한쪽만 입력한 채로 닫으면 그 값이 조용히 사라진다 — 닫지 말고 알린다.
   * 외부클릭/스크롤로도 들어오므로, 여기서 붙잡아야 입력이 보존된다. */
  if (findIncompleteSlot(draft)) {
    weekdayEditor.value.tried = true; // 어느 칸을 채워야 하는지 하이라이트로 가리킨다
    void alertIncompleteTime();
    return false;
  }

  const blocks = draftToBlocks(draft);

  if (ownerKey === 'INSTITUTION' || ownerKey === HOLIDAY_OWNER) {
    const holiday = ownerKey === HOLIDAY_OWNER;
    const dayMapRef = holiday ? institutionHolidayDayMap : institutionWeeklyDayMap;
    const breaksRef = holiday ? institutionHolidayBreaks : institutionBreaksByWeekday;

    const nextDayMap = new Map(dayMapRef.value);
    if (blocks.length === 0) nextDayMap.delete(weekday);
    else nextDayMap.set(weekday, blocks);
    dayMapRef.value = nextDayMap;

    /* 휴게시간 — 시작·종료가 모두 있어야 유효. 진료 블록이 하나도 없는(휴무) 요일은 휴게도 지운다. */
    const nextBreaks = new Map(breaksRef.value);
    if (blocks.length === 0) {
      nextBreaks.delete(weekday);
    } else {
      const entry = {};
      for (const kind of BREAK_BLOCK_KINDS) {
        const slot = draft[kind];
        entry[kind] = (slot?.start && slot?.end) ? {start: slot.start, end: slot.end} : null;
      }
      nextBreaks.set(weekday, entry);
    }
    breaksRef.value = nextBreaks;
  } else {
    const next = new Map(workingHoursByOwner.value);
    const dayMap = new Map(next.get(ownerKey) ?? []);
    if (blocks.length === 0) dayMap.delete(weekday);
    else dayMap.set(weekday, blocks);
    next.set(ownerKey, dayMap);
    workingHoursByOwner.value = next;
  }

  closeWeekdayEditor();
  return true;
}

function closeWeekdayEditor() {
  weekdayEditor.value = {...weekdayEditor.value, open: false, draft: null};
}

/* ===== 미지정 데이터 적용 modal =====
 * 팀에 등록된 담당자 중 1명을 선택 → 미지정 예약/진료건 일괄 적용 대상 */
const unassignedDataModal = ref({open: false, selectedStaffId: null});

/* 팀에 등록된 담당자 (중복 제거, 팀/구성원 순서 유지) */
const teamDoctors = computed(() => {
  const seen = new Set();
  const list = [];
  for (const team of teams.value) {
    for (const id of team.doctorIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      const name = getDoctor(id)?.text;
      if (name) list.push({staffId: id, name});
    }
  }
  return list;
});

/* 미지정 데이터 설정 버튼 노출 여부 — API 응답 assignable === true 일 때만 노출 */
const unassignedAssignable = ref(false);

async function fetchUnassignedAssignable() {
  try {
    const res = await getUnassignedReservations();
    const body = res?.data ?? res;
    unassignedAssignable.value = body?.payload?.assignable === true;
  } catch (e) {
    unassignedAssignable.value = false;
    console.error('[미지정 데이터 지정 가능 여부 조회] 실패', e);
  }
}

function openUnassignedDataSetting() {
  unassignedDataModal.value = {
    open          : true,
    selectedStaffId: teamDoctors.value[0]?.staffId ?? null,
  };
}

function selectUnassignedDoctor(staffId) {
  unassignedDataModal.value = {...unassignedDataModal.value, selectedStaffId: staffId};
}

function closeUnassignedDataModal() {
  unassignedDataModal.value = {...unassignedDataModal.value, open: false};
}

const applyingUnassigned = ref(false);

async function applyUnassignedData() {
  if (applyingUnassigned.value) return;
  const staffId = unassignedDataModal.value.selectedStaffId;
  if (staffId == null) return;

  applyingUnassigned.value = true;
  try {
    const res = await assignUnassigned(staffId);
    const body = res?.data ?? res;
    /* 백엔드가 HTTP 200 + code 실패로 내려주는 케이스 처리 */
    if (body?.code && body.code !== 'succeed') {
      push.error(body.message || '미지정 데이터 적용에 실패했습니다.');
      return;
    }
    if (body?.message) push.success(body.message);
    /* 성공 시에만 모달 닫기 */
    closeUnassignedDataModal();
    /* 적용 결과를 스케줄러에 반영 — load() 직접 호출 금지, searchVersion watch chain 으로 재조회 */
    filterStore.triggerSearch();
  } catch (e) {
    push.error(e?.response?.data?.message || '미지정 데이터 적용에 실패했습니다.');
    console.error('[미지정 데이터 적용] 실패', e);
  } finally {
    applyingUnassigned.value = false;
  }
}

/* 핸들러 */
function prevYear() {
  selectedYear.value -= 1;
}

function nextYear() {
  selectedYear.value += 1;
}

function prevMonth() {
  if (selectedMonth.value === 1) {
    selectedMonth.value = 12;
    selectedYear.value -= 1;
  } else {
    selectedMonth.value -= 1;
  }
}

function nextMonth() {
  if (selectedMonth.value === 12) {
    selectedMonth.value = 1;
    selectedYear.value += 1;
  } else {
    selectedMonth.value += 1;
  }
}

function hasOption(weekday, option) {
  return weekdayOffs.value.get(weekday)?.has(option) ?? false;
}

function hasAnyOption(weekday) {
  return (weekdayOffs.value.get(weekday)?.size ?? 0) > 0;
}

/* 매주 · 매월 n번째 반복 휴무 규칙 토글.
 *
 * "매주"와 "매월"은 함께 쓸 수 없다 — 매주 휴무가면 매월 몇 번째인지가 의미를 잃는다.
 * 그래서 매주를 켜면 매월 선택을 모두 비운다(매월 쪽은 비활성). 매월 n번째끼리는
 * 여러 개를 고를 수 있다(예: 매월 2번째 + 4번째). */
function toggleOption(weekday, option) {
  const next = new Map(weekdayOffs.value);
  const set = new Set(next.get(weekday) ?? []);

  if (option === 'WEEKLY') {
    if (set.has('WEEKLY')) {
      set.delete('WEEKLY');
    } else {
      set.clear();
      set.add('WEEKLY');
    }
  } else if (set.has(option)) {
    set.delete(option);
  } else {
    set.add(option);
  }

  if (set.size === 0) {
    next.delete(weekday);
  } else {
    next.set(weekday, set);
  }

  weekdayOffs.value = next;
}

/* 공휴일 휴무 여부 — v-model 대신 setter 를 두어 잠금 가드를 걸 수 있게 한다(site 번들). */
function setIncludePublicHolidays(value) {
  includePublicHolidays.value = value;
}

function toggleWeekdayDropdown(weekday) {
  if (openWeekday.value === weekday) {
    openWeekday.value = null;
    return;
  }

  const btn = weekdayBtnRefs.get(weekday);
  if (btn) {
    const rect = btn.getBoundingClientRect();
    dropdownPosition.value = {
      top : rect.bottom + 4,
      left: rect.left,
    };
  }
  openWeekday.value = weekday;
}

function closeWeekdayDropdown() {
  openWeekday.value = null;
}

/* 칩: (요일, 옵션) 조합별로 1개씩 생성 */
const recurringChips = computed(() => {
  const chips = [];

  for (const [weekday, options] of weekdayOffs.value.entries()) {
    for (const option of options) {
      const label = option === 'WEEKLY'
          ? `매주 ${WEEKDAY_LABELS[weekday]}요일`
          : `매월 ${option.split('_')[1]}번째 ${WEEKDAY_LABELS[weekday]}요일`;

      chips.push({weekday, option, label});
    }
  }

  return chips;
});

/* 해당 날짜가 반복 휴무 규칙에 해당하는지 판정 */
function isRecurringOff(date) {
  const options = weekdayOffs.value.get(date.day());
  if (!options || options.size === 0) return false;
  if (options.has('WEEKLY')) return true;

  const occurrence = Math.ceil(date.date() / 7); // 1~5
  return options.has(`MONTHLY_${occurrence}`);
}

/* 공휴일 여부 (체크박스 무관 — 날짜 자체가 국가 공휴일인지).
 * 공휴일은 휴무일(반복)·특정일자(override) 로직에서 제외하고 '공휴일' 체크박스로만 휴무/진료 결정한다. */
function isHolidayDate(date) {
  return holidayStore.isHoliday(date.format('YYYY-MM-DD'));
}

function toggleTeam(teamId) {
  const next = new Set(selectedTeamIds.value);
  next.has(teamId) ? next.delete(teamId) : next.add(teamId);
  selectedTeamIds.value = next;
}

/* ===== 팀 생성/편집 ===== */
/* 신규 팀 작성 폼 (id=null). 기존 팀 편집은 인라인 rename / picker로 분리됨 */
const editingTeam = ref(null);

/* 직원 선택 picker — 신규 팀(teamId=null) / 기존 팀(teamId=string) 공용 */
const staffPicker = ref({open: false, top: 0, left: 0, staged: new Set(), teamId: null});
const staffPickerEl = ref(null);

/* fixed popover 가 트리거 위치에 그대로 펼쳐지면 뷰포트 하단/우측을 벗어남.
 * 렌더 후 실제 크기를 측정해 화면 안으로 clamp — 아래 공간 부족시 위로 flip.
 * (트리거 rect 를 넘겨 위로 flip 시 트리거 바로 위에 붙도록) */
async function clampStaffPickerIntoView(triggerRect) {
  await nextTick();
  const el = staffPickerEl.value;
  if (!el || !staffPicker.value.open) return;

  const margin = 8;
  const {width, height} = el.getBoundingClientRect();
  const {innerWidth, innerHeight} = window;

  let {top, left} = staffPicker.value;

  /* 아래로 넘치면 트리거 위로 flip, 그래도 넘치면 상단 margin 까지 clamp */
  if (top + height > innerHeight - margin) {
    const above = triggerRect.top - 4 - height;
    top = above >= margin ? above : Math.max(margin, innerHeight - margin - height);
  }
  if (left + width > innerWidth - margin) {
    left = Math.max(margin, innerWidth - margin - width);
  }

  staffPicker.value = {...staffPicker.value, top, left};
}

/* "..." 컨텍스트 메뉴 */
const teamMenu = ref({open: false, teamId: null, isCreating: false, top: 0, left: 0});

/* 기존 팀의 인라인 이름 변경 */
const renamingTeam = ref(null); // {id, name} | null

/* 범용 확인 다이얼로그 (팀 삭제 / 멤버 삭제 / 멤버 이동 공용) */
const confirmDialog = ref(null);
// shape: {title, sub?, confirmLabel, onConfirm}

function askConfirm(config) {
  confirmDialog.value = {
    title       : config.title,
    sub         : config.sub ?? '',
    confirmLabel: config.confirmLabel ?? '삭제',
    onConfirm   : config.onConfirm,
  };
}

function closeConfirmDialog() {
  confirmDialog.value = null;
}

function executeConfirm() {
  const fn = confirmDialog.value?.onConfirm;
  closeConfirmDialog();
  fn?.();
}

/* 칩 드래그-드롭 상태 */
const chipDrag = ref({
  active      : false,
  sourceTeamId: null,
  sourceIndex : null,
  doctorId    : null,
  targetTeamId: null,
  targetIndex : null,
});

function resetChipDrag() {
  chipDrag.value = {
    active      : false,
    sourceTeamId: null,
    sourceIndex : null,
    doctorId    : null,
    targetTeamId: null,
    targetIndex : null,
  };
}

function startCreateTeam() {
  closeStaffPicker();
  closeTeamMenu();
  renamingTeam.value = null;
  editingTeam.value = {id: null, name: '', doctorIds: []};
}

function removeDoctorFromEditingTeam(doctorId) {
  if (!editingTeam.value) return;
  editingTeam.value = {
    ...editingTeam.value,
    doctorIds: editingTeam.value.doctorIds.filter(id => id !== doctorId),
  };
}

/* ----- staff picker ----- */
function openStaffPickerForNew(event) {
  if (!editingTeam.value) return;
  const trigger = event.currentTarget;
  if (!trigger) return;

  const rect = trigger.getBoundingClientRect();
  staffPicker.value = {
    open  : true,
    top   : rect.bottom + 4,
    left  : rect.left,
    staged: new Set(editingTeam.value.doctorIds),
    teamId: null,
  };
  clampStaffPickerIntoView(rect);
}

function closeStaffPicker() {
  if (!staffPicker.value.open) return;
  staffPicker.value = {...staffPicker.value, open: false};
}

function toggleStagedDoctor(doctorId) {
  if (staffPickerDisabledIds.value.has(doctorId)) return;
  const next = new Set(staffPicker.value.staged);
  next.has(doctorId) ? next.delete(doctorId) : next.add(doctorId);
  staffPicker.value = {...staffPicker.value, staged: next};
}

/* 다른 팀에 이미 속한 직원은 비활성화 (현재 picker가 편집 중인 팀은 제외) */
const staffPickerDisabledIds = computed(() => {
  const ids = new Set();
  const currentTeamId = staffPicker.value.teamId;
  for (const team of teams.value) {
    if (team.id === currentTeamId) continue;
    for (const id of team.doctorIds) ids.add(id);
  }
  return ids;
});

/* picker 완료 — teamId=null: 신규 팀 생성 / teamId=existing: 구성원만 업데이트 */
function confirmStaffPicker() {
  const {teamId, staged} = staffPicker.value;
  const doctorIds = [...staged];

  if (teamId === null) {
    if (!editingTeam.value) {
      closeStaffPicker();
      return;
    }
    const trimmedName = editingTeam.value.name.trim() || '새 팀';
    const newId = `TEAM_${Date.now()}`;
    teams.value = [...teams.value, {id: newId, name: trimmedName, doctorIds}];
    selectedTeamIds.value = new Set([...selectedTeamIds.value, newId]);
    editingTeam.value = null;
  } else {
    teams.value = teams.value.map(t =>
        t.id === teamId ? {...t, doctorIds} : t
    );
  }
  closeStaffPicker();
}

/* ----- "..." 메뉴 ----- */
function openTeamMenu(event, teamId, isCreating = false) {
  event.stopPropagation();
  closeStaffPicker();
  const rect = event.currentTarget.getBoundingClientRect();
  teamMenu.value = {
    open: true,
    teamId,
    isCreating,
    top : rect.bottom + 4,
    left: rect.right - 110,
  };
}

function closeTeamMenu() {
  if (!teamMenu.value.open) return;
  teamMenu.value = {...teamMenu.value, open: false};
}

function handleMenuRename() {
  const {teamId} = teamMenu.value;
  const team = teams.value.find(t => t.id === teamId);
  closeTeamMenu();
  if (team) renamingTeam.value = {id: team.id, name: team.name};
}

function handleMenuMembers() {
  const {teamId, top, left} = teamMenu.value;
  const team = teams.value.find(t => t.id === teamId);
  closeTeamMenu();
  if (!team) return;
  staffPicker.value = {
    open: true,
    top,
    left,
    staged: new Set(team.doctorIds),
    teamId: team.id,
  };
  /* 트리거 rect 가 없으므로 menu top 기준 pseudo-rect 로 flip 처리 */
  clampStaffPickerIntoView({top});
}

function handleMenuDelete() {
  const {teamId, isCreating} = teamMenu.value;
  closeTeamMenu();

  if (isCreating) {
    askConfirm({
      title    : '생성중인 팀을 삭제하시겠습니까?',
      onConfirm: () => {
        editingTeam.value = null;
        closeStaffPicker();
      },
    });
    return;
  }

  const team = teams.value.find(t => t.id === teamId);
  if (!team) return;
  askConfirm({
    title    : `[${team.name}]을 삭제하시겠습니까?`,
    onConfirm: () => {
      teams.value = teams.value.filter(t => t.id !== teamId);
      const next = new Set(selectedTeamIds.value);
      next.delete(teamId);
      selectedTeamIds.value = next;
      if (renamingTeam.value?.id === teamId) renamingTeam.value = null;
    },
  });
}

/* ----- 인라인 이름 변경 ----- */
/* rename input은 매 입력마다 ref 콜백이 재호출되므로,
 * 동일 element 에 대해서는 최초 1회만 focus + select 한다.
 * (그렇지 않으면 매 keystroke 마다 전체 선택 → 다음 글자가 선택 텍스트를 치환해 1글자만 남는 버그) */
let renameInputEl = null;
function onRenameInputMount(el) {
  if (!el) {
    renameInputEl = null;
    return;
  }
  if (el === renameInputEl) return;
  renameInputEl = el;
  el.focus();
  el.select();
}

function saveRename() {
  if (!renamingTeam.value) return;
  const {id, name} = renamingTeam.value;
  const trimmed = name.trim();
  if (!trimmed) {
    renamingTeam.value = null;
    return;
  }
  teams.value = teams.value.map(t => t.id === id ? {...t, name: trimmed} : t);
  renamingTeam.value = null;
}

function cancelRename() {
  renamingTeam.value = null;
}

/* ----- 멤버 삭제 (×) ----- */
function onRequestRemoveMember(teamId, doctorId) {
  const team = teams.value.find(t => t.id === teamId);
  if (!team) return;
  askConfirm({
    title    : `해당 직원을 [${team.name}]에서 삭제하시겠습니까?`,
    sub      : '직원의 휴무일/운영시간 정보도 삭제됩니다.',
    onConfirm: () => {
      teams.value = teams.value.map(t =>
          t.id === teamId
              ? {...t, doctorIds: t.doctorIds.filter(id => id !== doctorId)}
              : t
      );
    },
  });
}

/* ----- 칩 드래그-드롭 ----- */
function onChipDragStart(event, teamId, doctorId, index) {
  chipDrag.value = {
    active      : true,
    sourceTeamId: teamId,
    sourceIndex : index,
    doctorId,
    targetTeamId: null,
    targetIndex : null,
  };
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', doctorId);
  }
}

function onChipDragOver(event, teamId, index) {
  if (!chipDrag.value.active) return;
  event.preventDefault();
  event.stopPropagation();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  if (chipDrag.value.targetTeamId !== teamId || chipDrag.value.targetIndex !== index) {
    chipDrag.value = {...chipDrag.value, targetTeamId: teamId, targetIndex: index};
  }
}

function onChipListDragOver(event, teamId) {
  if (!chipDrag.value.active) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  /* 컨테이너 자체에 드롭 → 끝에 추가 (chip li의 dragover는 별도로 stopPropagation됨) */
  if (chipDrag.value.targetTeamId !== teamId || chipDrag.value.targetIndex !== null) {
    chipDrag.value = {...chipDrag.value, targetTeamId: teamId, targetIndex: null};
  }
}

function onChipDrop(event, teamId, index) {
  if (!chipDrag.value.active) return;
  event.preventDefault();
  event.stopPropagation();
  handleChipDrop(teamId, index);
}

function onChipListDrop(event, teamId) {
  if (!chipDrag.value.active) return;
  event.preventDefault();
  handleChipDrop(teamId, null);
}

function onChipDragEnd() {
  resetChipDrag();
}

function handleChipDrop(targetTeamId, targetIndex) {
  const {sourceTeamId, sourceIndex, doctorId} = chipDrag.value;
  resetChipDrag();
  if (!sourceTeamId || !doctorId) return;

  if (sourceTeamId === targetTeamId) {
    /* 같은 팀 — 즉시 순서 변경 */
    reorderWithinTeam(sourceTeamId, sourceIndex, targetIndex);
    return;
  }

  /* 다른 팀 — 확인 후 이동 */
  const sourceTeam = teams.value.find(t => t.id === sourceTeamId);
  const targetTeam = teams.value.find(t => t.id === targetTeamId);
  if (!sourceTeam || !targetTeam) return;
  if (targetTeam.doctorIds.includes(doctorId)) return; // 이미 대상 팀에 있음

  askConfirm({
    title       : '해당 직원의 팀 이동을 실행하시겠습니까?',
    confirmLabel: '확인',
    onConfirm   : () => {
      const newSourceIds = sourceTeam.doctorIds.filter(id => id !== doctorId);
      const newTargetIds = [...targetTeam.doctorIds];
      const insertAt = targetIndex === null ? newTargetIds.length : targetIndex;
      newTargetIds.splice(insertAt, 0, doctorId);

      teams.value = teams.value.map(t => {
        if (t.id === sourceTeamId) return {...t, doctorIds: newSourceIds};
        if (t.id === targetTeamId) return {...t, doctorIds: newTargetIds};
        return t;
      });
    },
  });
}

function reorderWithinTeam(teamId, fromIndex, toIndex) {
  const team = teams.value.find(t => t.id === teamId);
  if (!team || fromIndex == null) return;
  const ids = [...team.doctorIds];
  const [moved] = ids.splice(fromIndex, 1);
  /* toIndex=null → 끝, 아니면 "target 앞에 삽입" 시맨틱 */
  let insertAt;
  if (toIndex === null) {
    insertAt = ids.length;
  } else {
    insertAt = fromIndex < toIndex ? toIndex - 1 : toIndex;
  }
  if (insertAt === fromIndex) return; // 같은 위치
  ids.splice(insertAt, 0, moved);
  teams.value = teams.value.map(t => t.id === teamId ? {...t, doctorIds: ids} : t);
}

/* ===== 특정일자: 클릭 토글 / 드래그 페인트 ===== */
const dragState = ref({active: false, startKey: null, endKey: null});

/* dayjs 객체로 OFF 표시 여부 판정 (override 우선, 없으면 반복 휴무).
 * 공휴일이라도 그 날짜에 override 가 있으면 override 가 이긴다 — 지정한 것이 일반 규칙을 이긴다.
 * (BE 운영중 판정도 "일자별 → 휴무규칙/공휴일 → 요일별" 순서라 우선순위가 같다.) */
function isDisplayedOff(date) {
  const override = dateOverrides.value.get(date.format('YYYY-MM-DD'));
  if (override === 'OFF') return true;
  if (override === 'WORK') return false;
  return isNaturallyOff(date);
}

/* override 가 없을 때의 그 날짜 기본 상태 — 공휴일이면 공휴일 체크박스, 아니면 반복 휴무요일.
 * 표시(캘린더 셀)와 토글(자연 상태면 override 를 지운다)이 같은 규칙을 써야 클릭이 헛돌지 않는다. */
function isNaturallyOff(date) {
  return isHolidayDate(date) ? includePublicHolidays.value : isRecurringOff(date);
}

/* 범위 OFF 토글 (단일 클릭/드래그 공통)
 * - 범위 내 모두 OFF → 모두 해제 (자연 OFF는 'WORK' override, 아니면 override 삭제)
 * - 그 외 → 모두 OFF (자연 OFF는 override 삭제, 아니면 'OFF' override)
 * 공휴일 날짜도 토글 대상이다 — 공휴일에 임시진료/임시휴무를 지정할 수 있어야 한다
 * (지정하면 일자별 행으로 저장돼 체크박스보다 우선한다). */
function toggleRangeOff(startKey, endKey) {
  const a = dayjs(startKey);
  const b = dayjs(endKey);
  const [from, to] = a.isBefore(b) ? [a, b] : [b, a];

  let allOff = true;
  let cursor = from;
  while (!cursor.isAfter(to, 'day')) {
    if (!isDisplayedOff(cursor)) {
      allOff = false;
      break;
    }
    cursor = cursor.add(1, 'day');
  }

  const newOff = !allOff;
  const next = new Map(dateOverrides.value);

  cursor = from;
  while (!cursor.isAfter(to, 'day')) {
    const key = cursor.format('YYYY-MM-DD');
    const naturalOff = isNaturallyOff(cursor);

    if (newOff === naturalOff) {
      next.delete(key);
    } else {
      next.set(key, newOff ? 'OFF' : 'WORK');
    }
    cursor = cursor.add(1, 'day');
  }

  dateOverrides.value = next;
}

function onCellMouseDown(cell, event) {
  if (!cell.isCurrentMonth) return;
  event.preventDefault();
  dragState.value = {active: true, startKey: cell.key, endKey: cell.key};
}

function onCellMouseEnter(cell) {
  if (!dragState.value.active || !cell.isCurrentMonth) return;
  if (dragState.value.endKey === cell.key) return;
  dragState.value = {...dragState.value, endKey: cell.key};
}

function onDocumentMouseUp() {
  if (!dragState.value.active) return;
  const {startKey, endKey} = dragState.value;
  dragState.value = {active: false, startKey: null, endKey: null};

  if (!startKey || !endKey) return;

  toggleRangeOff(startKey, endKey);
}

function isInDragRange(cell) {
  const {active, startKey, endKey} = dragState.value;
  if (!active || !cell.isCurrentMonth || !startKey || !endKey) return false;
  const [from, to] = startKey <= endKey ? [startKey, endKey] : [endKey, startKey];
  return cell.key >= from && cell.key <= to;
}

/* 특정일자 chip: dateOverrides → 정렬 후 연속+동일 타입 묶기.
 * ★공휴일 날짜도 그대로 노출한다 — 일자별 운영시간(일자별 운영시간 테이블)에 행이 있으면 그게 사실이다.
 *   숨기면 (1) 있는 데이터를 못 보고 (2) 저장 payload 에서도 빠져 사업장 설정 행이 통삭제된다.
 * 병합 경계: 타입 + 공휴일 여부 + 연도가 모두 같고 날짜가 연속일 때만 한 칩으로 묶는다.
 *   공휴일과 일반 휴무일을 한 칩으로 묶으면, × 로 지울 때 무엇이 지워지는지 보이지 않는다. */
const specificDates = computed(() => {
  const sorted = [...dateOverrides.value.entries()].sort(([a], [b]) => a.localeCompare(b));
  const ranges = [];

  for (const [key, type] of sorted) {
    const d = dayjs(key);
    const isHoliday = holidayStore.isHoliday(key);
    const last = ranges[ranges.length - 1];

    if (last && last.type === type && last.isHoliday === isHoliday
        && last.endDate.year() === d.year()
        && last.endDate.add(1, 'day').isSame(d, 'day')) {
      last.endDate = d;
      last.endKey = key;
    } else {
      ranges.push({startDate: d, endDate: d, startKey: key, endKey: key, type, isHoliday});
    }
  }

  /* 여러 해가 섞여 있을 때만 칩에 연도를 붙인다 — 한 해뿐이면 군더더기고,
   * 섞였는데 없으면 "8월 15일"이 어느 해인지 알 수 없다(사업장 설정가 여러 해를 전개해 둘 수 있다). */
  const multiYear = new Set(ranges.map(r => r.startDate.year())).size > 1;
  const dateLabel = (d) => (multiYear ? `${d.year()}년 ` : '') + `${d.month() + 1}월 ${d.date()}일`;

  return ranges.map((r) => {
    /* 타입은 그룹 헤더(진료/휴무)가 말해 준다 — 칩마다 "(휴무)"을 붙이면 눈에 안 들어온다. */
    const label = r.startKey === r.endKey
        ? dateLabel(r.startDate)
        : `${dateLabel(r.startDate)} ~ ${dateLabel(r.endDate)}`;
    return {...r, label};
  });
});

/* 특정일자 칩을 **진료/휴무**으로 묶는다.
 * 종전에는 연도로 묶고 칩마다 "(휴무)"을 붙였는데, 정작 중요한 진료/휴무 구분이 괄호 안에 묻혀
 * 눈에 들어오지 않았다. 연도는 여러 해가 섞였을 때만 칩 라벨에 실린다(specificDates 참조).
 * 순서는 휴무 → 진료. 이 탭의 주 관심사가 휴무일이다. */
const SPECIFIC_DATE_GROUPS = [
  {type: 'OFF', label: '휴무'},
  {type: 'WORK', label: '진료'},
];

const specificDatesByType = computed(() =>
    SPECIFIC_DATE_GROUPS
        .map(g => ({...g, ranges: specificDates.value.filter(r => r.type === g.type)}))
        .filter(g => g.ranges.length > 0));

function removeSpecificRange(range) {
  const next = new Map(dateOverrides.value);
  let cursor = range.startDate;
  while (!cursor.isAfter(range.endDate, 'day')) {
    next.delete(cursor.format('YYYY-MM-DD'));
    cursor = cursor.add(1, 'day');
  }
  dateOverrides.value = next;
}

/* 캘린더에 표시할 운영시간 owner 결정.
 *  - 직원 expand 중 → 그 직원 + 이름 prefix
 *  - 그 외 (사업장 expand / 미선택) → INSTITUTION (직원별 리스트 모드) */
function getCalendarOwner() {
  const key = expandedTreatmentKey.value;
  if (key && key.startsWith('staff:')) {
    const docId = Number(key.slice('staff:'.length));
    return {ownerKey: `STAFF:${docId}`, doctorName: getDoctor(docId)?.text ?? ''};
  }
  return {ownerKey: 'INSTITUTION', doctorName: ''};
}

/* 블록들의 첫 시작 ~ 마지막 종료를 단일 범위로 (오전/오후/야간 구분 없이) */
function formatBlocksRange(blocks) {
  if (blocks.length === 0) return null;
  let minStart = blocks[0].start;
  let maxEnd = blocks[0].end;
  for (const b of blocks) {
    if (b.start < minStart) minStart = b.start;
    if (b.end > maxEnd) maxEnd = b.end;
  }
  return `${minStart} ~ ${maxEnd}`;
}

/* STAFF 모드 단일 라벨 — INSTITUTION 모드는 entries[] 별도 처리 */
function formatAppointmentLabel(weekday, isOff) {
  const {ownerKey, doctorName} = getCalendarOwner();
  const blocks = getBlocksFor(ownerKey, weekday);
  if (blocks.length === 0) return null;

  if (isOff) {
    return doctorName ? `${doctorName} (휴무)` : null;
  }
  const timeText = formatBlocksRange(blocks);
  return doctorName ? `${doctorName} ${timeText}` : timeText;
}

/* 사업장 모드 캘린더 셀의 직원 표시 순서.
 * teams[] 순회 + 각 팀의 doctorIds 순서대로 (같은 직원이 N팀 소속이면 N번 표시 — 의도된 중복).
 * 팀 미소속 STAFF 는 끝에 staffId 오름차순. */
function getInstitutionDoctorOrder() {
  const ordered = [];
  const inAnyTeam = new Set();
  for (const team of teams.value) {
    for (const id of team.doctorIds) {
      ordered.push(id);
      inAnyTeam.add(id);
    }
  }
  const orphan = [];
  for (const key of workingHoursByOwner.value.keys()) {
    if (!key.startsWith('STAFF:')) continue;
    const id = Number(key.slice('STAFF:'.length));
    if (!inAnyTeam.has(id)) orphan.push(id);
  }
  orphan.sort((a, b) => a - b);
  return [...ordered, ...orphan];
}

/* INSTITUTION 모드 한 셀의 entries — {staffId, label, isOff}[]
 *  - 셀 isOff=true → 모든 직원 "(휴무)"
 *  - 직원이 그 날짜를 휴무로 정함 → "(휴무)"
 *  - 정한 적 없음 + 사업장 운영시간을 앎 → 기관 시간으로 표기
 *  - 정한 적 없음 + 기관 운영시간도 모름 → "(운영시간 없음)"
 *  - 그 외 → "이름 09:00 ~ 14:00"
 * effective: date override > weekly recurring */
function formatInstitutionEntries(weekday, isOff, dateKey) {
  const entries = [];
  /* cascade(사용자 모델): 담당자별 운영시간 → (미설정이면)사업장 운영시간(⚙ TB) → (그것도 모르면)운영시간 없음.
   *  - isOff(휴무일/공휴일)은 운영시간과 무관하게 항상 휴무.
   *  - ★"휴무로 정함"과 "아직 안 정함"을 갈라야 한다. 예전에는 둘 다 진료 구간이 없다는 이유로
   *    똑같이 "(휴무)"으로 찍었는데, 그래서 사업장 운영시간을 못 불러온 것뿐인데도
   *    전원이 휴무로 보였다. 쉬기로 한 것과 모르는 것은 다르다. */
  const dayBlocks = institutionWeeklyDayMap.value.get(weekday) ?? [];
  const institutionBlocks = dayBlocks.length > 0 ? dayBlocks : null;
  for (const id of getInstitutionDoctorOrder()) {
    const name = getDoctor(id)?.text;
    if (!name) continue;
    const ownerKey = `STAFF:${id}`;
    const blocks = getEffectiveBlocks(ownerKey, dateKey, weekday);
    if (isOff) {
      entries.push({staffId: id, label: `${name} (휴무)`, isOff: true});
    } else if (blocks.length > 0) {
      entries.push({staffId: id, label: `${name} ${formatBlocksRange(blocks)}`, isOff: false});
    } else if (isExplicitlyOff(ownerKey, dateKey, weekday)) {
      entries.push({staffId: id, label: `${name} (휴무)`, isOff: true});
    } else if (institutionBlocks) {
      // 담당자별 미설정 → 사업장 운영시간(자체 TB) 으로 표기
      entries.push({staffId: id, label: `${name} ${formatBlocksRange(institutionBlocks)}`, isOff: false});
    } else {
      // 미설정인데 사업장 운영시간도 모른다 — 휴무가 아니라 "알 수 없음"이다
      entries.push({staffId: id, label: `${name} (운영시간 없음)`, isOff: true});
    }
  }
  return entries;
}

/* 셀 더보기 popover — 클릭한 셀의 전체 entries 표시 */
const cellMorePopover = ref({
  open     : false,
  top      : 0,
  left     : 0,
  dayNumber: 0,
  isOff    : false,
  dateKey  : null,
  weekday  : 0,
  entries  : [],
});

function openCellMore(event, cell) {
  event.stopPropagation();
  const cellEl = event.currentTarget.closest('.schedulerTreatmentSetting__monthCell');
  if (!cellEl) return;
  const rect = cellEl.getBoundingClientRect();
  cellMorePopover.value = {
    open     : true,
    top      : rect.top,
    left     : rect.left,
    dayNumber: cell.dayNumber,
    isOff    : cell.isOff,
    dateKey  : cell.key,
    weekday  : cell.weekday,
    entries  : cell.entries,
  };
}

function closeCellMore() {
  if (!cellMorePopover.value.open) return;
  cellMorePopover.value = {...cellMorePopover.value, open: false};
}

/* ===== 셀 × 직원 popover editor (날짜별 override 편집) =====
 * weekdayEditor 와 같은 3블록 토글 UI 지만 키가 (ownerKey, dateKey) — 그 날짜 한정 override.
 * draft 폴백 순서: 기존 override → weekly recurring → 기본 프리필 시간 */
const cellStaffEditor = ref({
  open    : false,
  ownerKey: null,
  dateKey : null,
  weekday : 0,
  top     : 0,
  left    : 0,
  draft   : null,
  /* weekdayEditor 와 같은 규약 — 닫기를 시도한 뒤에만 하이라이트를 그린다. */
  tried   : false,
});

function buildCellStaffDraft(ownerKey, dateKey, weekday) {
  const override = workingHoursOverridesByOwner.value.get(ownerKey)?.get(dateKey);
  const source = override !== undefined ? override : getBlocksFor(ownerKey, weekday);
  const existing = new Map(source.map(b => [b.kind, b]));
  const draft = {};
  for (const kind of WORK_BLOCK_KINDS) {
    const block = existing.get(kind);
    draft[kind] = {start: block?.start ?? '', end: block?.end ?? ''};
  }
  return draft;
}

function openCellStaffEditor(event, ownerKey, dateKey, weekday) {
  event.stopPropagation();
  /* 다른 운영시간 popover 가 열려 있으면 commit 후 진행 */
  if (weekdayEditor.value.open) commitWeekdayEditor();
  if (cellStaffEditor.value.open) commitCellStaffEditor();
  /* cellMorePopover 안의 entry 클릭이라면 cellMorePopover 도 닫음 (Z-order 단순화) */
  if (cellMorePopover.value.open) closeCellMore();

  const rect = event.currentTarget.getBoundingClientRect();
  cellStaffEditor.value = {
    open    : true,
    ownerKey,
    dateKey,
    weekday,
    top     : rect.bottom + 4,
    left    : rect.left,
    draft   : buildCellStaffDraft(ownerKey, dateKey, weekday),
    tried   : false, // 새로 열 때마다 하이라이트는 꺼진 상태로 시작
  };
}

function setCellStaffBlockTime(kind, field, value) {
  const draft = cellStaffEditor.value.draft;
  if (!draft) return;
  cellStaffEditor.value = {
    ...cellStaffEditor.value,
    draft: {...draft, [kind]: {...draft[kind], [field]: value}},
  };
}

/* @returns 커밋하고 닫았으면 true, 미완성 입력이라 붙잡아 뒀으면 false */
function commitCellStaffEditor() {
  const {ownerKey, dateKey, draft} = cellStaffEditor.value;
  if (!ownerKey || !dateKey || !draft) {
    closeCellStaffEditor();
    return true;
  }
  /* 요일 편집기와 같은 규약 — 한쪽만 입력한 채로는 닫지 않는다(조용히 휴무로 저장되는 것 방지). */
  if (findIncompleteSlot(draft)) {
    cellStaffEditor.value.tried = true; // 어느 칸을 채워야 하는지 하이라이트로 가리킨다
    void alertIncompleteTime();
    return false;
  }
  const blocks = draftToBlocks(draft);
  /* blocks=[] 도 정상 저장 — "그 날짜만 휴무" override */
  const next = new Map(workingHoursOverridesByOwner.value);
  const dayMap = new Map(next.get(ownerKey) ?? []);
  dayMap.set(dateKey, blocks);
  next.set(ownerKey, dayMap);
  workingHoursOverridesByOwner.value = next;
  closeCellStaffEditor();
  return true;
}

function closeCellStaffEditor() {
  cellStaffEditor.value = {...cellStaffEditor.value, open: false, draft: null};
}

/* 캘린더 셀 계산.
 * INSTITUTION 모드: entries[] 채움 (직원별 리스트)
 * STAFF 모드:       appointmentLabel 채움 (단일 라벨) */
function buildMonthCells(year, month) {
  const startOfMonth = dayjs(`${year}-${String(month).padStart(2, '0')}-01`);
  const endOfMonth = startOfMonth.endOf('month');

  const gridStart = startOfMonth.subtract(startOfMonth.day(), 'day');
  const gridEnd = endOfMonth.add(6 - endOfMonth.day(), 'day');

  const {ownerKey} = getCalendarOwner();
  const isInstitution = ownerKey === 'INSTITUTION';

  const cells = [];
  let cursor = gridStart;

  while (cursor.isBefore(gridEnd) || cursor.isSame(gridEnd, 'day')) {
    const isCurrentMonth = cursor.month() === startOfMonth.month();
    const key = cursor.format('YYYY-MM-DD');

    /* 국가 공휴일 — 토글 ON + 현재 달 셀만 빨간날 표기(휴무 라벨은 isOff 가 담당). */
    const isHoliday = isCurrentMonth && includePublicHolidays.value && isHolidayDate(cursor);

    /* 우선순위 = 일자별 지정(override) > 공휴일 체크박스 > 반복 휴무요일.
     * 지정한 것이 일반 규칙을 이긴다 — BE 운영중 판정(서버 운영시간 판정)도 일자별 운영시간을 먼저 본다.
     * (공휴일이라도 임시진료로 지정했으면 진료다.) */
    const isOff = isCurrentMonth && isDisplayedOff(cursor);

    let appointmentLabel = null;
    let entries = null;
    if (isCurrentMonth) {
      if (isInstitution) {
        entries = formatInstitutionEntries(cursor.day(), isOff, key);
      } else {
        appointmentLabel = formatAppointmentLabel(cursor.day(), isOff);
      }
    }

    cells.push({
      key,
      dayNumber: cursor.date(),
      weekday  : cursor.day(),
      isCurrentMonth,
      isOff,
      isHoliday,
      appointmentLabel,
      entries,
    });

    cursor = cursor.add(1, 'day');
  }

  return cells;
}

const yearMonths = computed(() =>
    Array.from({length: 12}, (_, i) => ({
      key  : `${selectedYear.value}-${String(i + 1).padStart(2, '0')}`,
      label: `${i + 1}월`,
      cells: buildMonthCells(selectedYear.value, i + 1),
    }))
);

const monthCells = computed(() =>
    buildMonthCells(selectedYear.value, selectedMonth.value)
);

/* 선택 연도 공휴일 보장 — 이미 로드된 연도는 no-op. 연 이동 시 자동 보충 */
watch(selectedYear, (y) => holidayStore.ensureYears([y]), {immediate: true});

/* 드롭다운 외부 클릭 시 닫기
 * 토글 버튼/패널에 @click.stop 이 걸려있어 내부 클릭은 document로 전파되지 않음
 *
 * ★안내 다이얼로그가 떠 있는 동안에는 아무것도 하지 않는다.
 *   다이얼로그는 popover 바깥(모달)에 그려지므로 [확인] 클릭이 document 까지 올라온다.
 *   그때 commit 을 다시 돌리면 → 여전히 미완성 → 안내 재노출 → **무한 반복**이 되고,
 *   입력칸에 손도 못 대게 된다. 스크롤/리사이즈 경로도 같다. */
function handleDocumentClick() {
  if (dialogBusy.value) return;
  if (openWeekday.value !== null) closeWeekdayDropdown();
  if (staffPicker.value.open) closeStaffPicker();
  if (teamMenu.value.open) closeTeamMenu();
  /* 운영시간 요일 popover는 외부 클릭시 commit (확인 버튼 없는 즉시반영 UX) */
  if (weekdayEditor.value.open) commitWeekdayEditor();
  if (cellStaffEditor.value.open) commitCellStaffEditor();
  if (cellMorePopover.value.open) closeCellMore();
}

/* fixed 위치 드롭다운은 사이드바 스크롤/창 리사이즈 시 버튼과 분리됨 → 닫음 */
function handleScrollOrResize() {
  if (dialogBusy.value) return;
  if (openWeekday.value !== null) closeWeekdayDropdown();
  if (staffPicker.value.open) closeStaffPicker();
  if (teamMenu.value.open) closeTeamMenu();
  if (weekdayEditor.value.open) commitWeekdayEditor();
  if (cellStaffEditor.value.open) commitCellStaffEditor();
  if (cellMorePopover.value.open) closeCellMore();
}

/* 서버 → 내부 state 변환 — 팀만 담당한다.
 * 휴무 규칙(recurringOffRules/workDates/offDates/holidayClosedYn) baseline 은 site strict 번들에서 받는다
 * (applyOffRulesBaseline). 원천이 사업장 설정라 운영시간과 원자적으로 읽어 저장 게이트와 정합을 맞춘다.
 * - teams.id는 서버 number → 클라 string으로 변환 (신규 팀 TEAM_xxx 패턴과 통일) */
async function hydrateFromServer() {
  try {
    const res = await getTreatmentSettings();
    const body = (res?.data ?? res);
    /* code=failed 는 "장애" — 무음으로 넘기면 teams 가 초기값 [] 인 채 저장돼 팀·구성원이 전멸한다(#1). */
    if (body?.code && body.code !== 'succeed') {
      console.error('[운영일정 설정 > 팀 조회] 실패', body?.message);
      teamLoadFailed.value = true;
      return;
    }
    /* payload 부재도 "장애"다 — code=succeed 여도 payload 가 null/undefined 면 baseline 을 못 읽은 것이다.
     * 무음으로 넘기면 teams 가 초기값 [] 인 채 저장되고, BE 는 [] 를 null 과 구분해
     * "팀 전부 삭제"라는 정상 의도로 해석한다(파트 skip 은 teams 미전송일 때만) → 팀·구성원 전멸.
     *
     * ★"미설정(정상)"과 혼동 금지 — 팀을 한 번도 만들지 않은 거래처는 succeed + payload:{teams:[]}
     *  (payload 는 있고 그 안이 빈 배열)로 내려온다. 그건 정상이며 teams=[] 로 hydrate 되고 저장도 가능해야 한다.
     *  장애로 승격하는 것은 payload 키 자체가 없거나 null/undefined 인 경우뿐이다. */
    const payload = body?.payload;
    if (!payload) {
      console.error('[운영일정 설정 > 팀 조회] payload 부재 — baseline 미확보');
      teamLoadFailed.value = true;
      return;
    }
    teams.value = (payload.teams ?? []).map(t => ({
      id       : String(t.id),
      name     : t.name,
      doctorIds: [...(t.doctorIds ?? [])],
    }));
    teamLoadFailed.value = false;
  } catch (e) {
    console.error('[운영일정 설정 > 조회] 실패', e);
    teamLoadFailed.value = true;
  } finally {
    // 조회 성공/실패 무관 — 이 시점부터 공휴일 토글을 노출(실패 시 default true fallback).
    settingsLoaded.value = true;
  }
}

/* ===== 운영시간 reverse 변환 (내부 state → 서버 payload) ===== */

/* "09:00" → "0900" */
function HHMMToHmm(hhmm) {
  if (!hhmm) return null;
  return hhmm.replace(':', '');
}

/* dayMap (Map<dayCd, Block[]>) → WorkHoursRow[] (의료인주간 B)
 * ★정한 요일만 보낸다 — 7행으로 채우지 않는다. 채우면 "안 정한 요일"이 "휴무로 정한 요일"과
 * 똑같은 모양(시각 null)으로 저장돼, 한 번 저장한 담당자는 다시는 미설정으로 돌아가지 못한다.
 *
 * 미설정 담당자(dayMap 비어 있음)은 빈 배열이 나가고 BE 는 그 사람의 행을 남기지 않는다 —
 * 화면에 보이던 사업장 값은 "기본값 참조"일 뿐 확정이 아니다. 기관 값을 그대로 박아 두면
 * 이후 기관 운영시간을 바꿔도 담당자가 따라오지 않는다. 사용자가 한 요일이라도 건드리면
 * setStaffWorkHours 이 그 시점에 보이던 값을 확정한다.
 *
 * dayCd 오름차순 — 결정적 순서로 dirty 비교 안정. */
function dayMapToTimes(dayMap) {
  const rows = [];
  for (const [dayCd, blocks] of dayMap ?? []) {
    rows.push({dayCd, ...blocksToStaffTimeFields(blocks)});
  }
  rows.sort((a, b) => a.dayCd - b.dayCd);
  return rows;
}

/* blocks → 진료 시작/종료("HHmm") 쌍. 한쪽만 입력된 중간 상태는 휴무(null)으로 보낸다. */
function blocksToWorkRange(blocks) {
  const work = blocks.find(b => b.kind === 'WORK');
  const start = work ? HHMMToHmm(work.start) : null;
  const end = work ? HHMMToHmm(work.end) : null;
  return (start && end) ? {start, end} : {start: null, end: null};
}

/* blocks → 의료인주간(B) 시작/종료 필드 (staff* 접두) */
function blocksToStaffTimeFields(blocks) {
  const {start, end} = blocksToWorkRange(blocks);
  return {staffOpenHm: start, staffCloseHm: end};
}

/* blocks → 지정일자(C) override 시작/종료 필드 (*Dsnt* 삽입) */
function blocksToOverrideTimeFields(blocks) {
  const {start, end} = blocksToWorkRange(blocks);
  return {overrideOpenHm: start, overrideCloseHm: end};
}

/* 사업장(site) 운영시간(요일별) → settings/save 의 site[] 필드.
 * 진료하는 요일 행만 보낸다. BE 는 site 에서 생략된 요일을 "행 없음"으로만 처리한다 —
 * 휴무는 site 생략이 아니라 recurringOffRules(WEEKLY)로 표현해야 사업장 설정에 휴무로 남는다(#휴무 이중표현).
 *
 * ★정합성: 매주 휴무(WEEKLY)인 요일은 site 진료행으로 내보내지 않는다.
 *  화면에서 그 요일에 운영시간이 남아 있어도(휴무일 탭에서 나중에 휴무 지정한 경우) 휴무 규칙이 우선이다
 *  — site 에도 넣으면 "진료행 + 휴무규칙" 이 동시에 나가 사업장 설정에서 모순이 된다. 여기서 skip 해 recurringOffRules 로만 표현한다.
 * 휴게 미설정은 HM null 로 표현한다. */
function buildInstitutionTimesPayload() {
  const rows = [];
  for (let w = 0; w < 7; w++) {
    if (isWeekdayClosed(w)) continue;         // 매주 휴무 요일 → recurringOffRules 로만 (site 진료행 금지)

    const blocks = institutionWeeklyDayMap.value.get(w) ?? [];
    if (blocks.length === 0) continue;

    const work = blocksToWorkRange(blocks);
    if (!work.start || !work.end) continue;   // 진료 구간이 온전치 않은 요일은 보내지 않는다(= 휴무)

    const breaks = getInstitutionBreaks(w);
    const hm = (block, field) => (block ? HHMMToHmm(block[field]) : null);

    rows.push({
      dayCd     : w,
      openHm: work.start,
      closeHm : work.end,
      lunchStartHm: hm(breaks.LUNCH, 'start'),
      lunchEndHm : hm(breaks.LUNCH, 'end'),
      dinnerStartHm: hm(breaks.DINNER, 'start'),
      dinnerEndHm : hm(breaks.DINNER, 'end'),
    });
  }
  return rows;
}

/* 사업장 공휴일 운영시간 → settings/save 의 holidayHours 필드.
 * 공휴일 휴무(체크박스 ON)이어도 값은 그대로 실어 보낸다 — 지우면 다시 진료로 되돌렸을 때 시간이 사라진다.
 *
 * ★진료 구간을 비웠으면 null 이 아니라 **전 필드 null 인 객체**를 보낸다.
 *  null 은 BE 에서 "미전송 = baseline 보존"이라, 그걸 보내면 지운 값이 되살아나 삭제할 방법이 없어진다.
 *  전 필드 null 객체는 BE buildHolidayRows 가 빈 목록으로 바꿔 사업장 설정에 전체 교체(=전삭제)로 나간다. */
function buildInstitutionHolidayPayload() {
  const blocks = institutionHolidayDayMap.value.get(HOLIDAY_SLOT) ?? [];
  const work = blocksToWorkRange(blocks);
  if (!work.start || !work.end) {
    return {
      openHm: null, closeHm: null,
      lunchStartHm: null, lunchEndHm: null,
      dinnerStartHm: null, dinnerEndHm: null,
    };
  }

  const breaks = getBreaksFor(HOLIDAY_OWNER, HOLIDAY_SLOT);
  const hm = (block, field) => (block ? HHMMToHmm(block[field]) : null);

  return {
    openHm: work.start,
    closeHm : work.end,
    lunchStartHm: hm(breaks.LUNCH, 'start'),
    lunchEndHm : hm(breaks.LUNCH, 'end'),
    dinnerStartHm: hm(breaks.DINNER, 'start'),
    dinnerEndHm : hm(breaks.DINNER, 'end'),
  };
}

/* workingHoursByOwner 의 STAFF 엔트리 → {staff: [{staffId, times}], overrides: [...]}
 * 사업장 운영시간은 여기 포함하지 않는다 — 원천이 사업장 설정라 전용 엔드포인트로 따로 저장한다.
 * staffId / date 오름차순 — 결정적 순서로 dirty 비교 안정 */
function buildWorkingHoursPayload() {
  /* 미설정 담당자는 빈 times 로 나가고 그대로 미설정으로 남는다 — dayMapToTimes 가 사업장 값을
   * 끌어다 채우지 않기 때문이다. 사업장 조회 실패 중이라 해서 따로 걸러낼 필요가 없다. */
  const staff = [];
  for (const [key, dayMap] of workingHoursByOwner.value) {
    if (!key.startsWith('STAFF:')) continue;
    const staffId = Number(key.slice('STAFF:'.length));
    staff.push({staffId, times: dayMapToTimes(dayMap)});
  }
  staff.sort((a, b) => a.staffId - b.staffId);

  const overrides = [];
  for (const [key, dayMap] of workingHoursOverridesByOwner.value) {
    if (!key.startsWith('STAFF:')) continue;
    const staffId = Number(key.slice('STAFF:'.length));
    for (const [date, blocks] of dayMap) {
      overrides.push({staffId, date, ...blocksToOverrideTimeFields(blocks)});
    }
  }
  overrides.sort((a, b) => a.staffId - b.staffId || a.date.localeCompare(b.date));

  return {staff, overrides};
}

/* 서버 institution[](요일별) → institutionWeeklyDayMap + institutionBreaksByWeekday.
 * 빈 목록이면 한 번도 등록하지 않은 거래처 — 보드의 "운영시간 등록 권장" 판정은
 * staffStore.hospitalRules.weekly 가 비었는지로 이뤄지므로 여기서 따로 플래그를 두지 않는다.
 * 진료 여부 판단은 시작·종료 HM 존재 여부다. */
function applyInstitutionTimes(rows) {
  const list = rows ?? [];

  const dayMapNext = new Map();
  const breaksNext = new Map();

  for (const row of list) {
    const w = row.dayCd;
    if (w == null || w < 0 || w > 6) continue;

    const blocks = [];
    const openTime = hmmToHHMM(row.openHm);
    const closeTime = hmmToHHMM(row.closeHm);
    if (openTime && closeTime) blocks.push({kind: 'WORK', start: openTime, end: closeTime});
    if (blocks.length > 0) dayMapNext.set(w, blocks);

    const toBreak = (startHm, endHm) => {
      const s = hmmToHHMM(startHm);
      const e = hmmToHHMM(endHm);
      return (s && e) ? {start: s, end: e} : null;
    };
    breaksNext.set(w, {
      LUNCH : toBreak(row.lunchStartHm, row.lunchEndHm),
      DINNER: toBreak(row.dinnerStartHm, row.dinnerEndHm),
    });
  }

  institutionWeeklyDayMap.value = dayMapNext;
  institutionBreaksByWeekday.value = breaksNext;
}

/* 서버 holidayHours(공휴일 운영시간 1행) → institutionHolidayDayMap + institutionHolidayBreaks.
 * 요일별과 같은 규약이되 칸이 하나(HOLIDAY_SLOT)뿐이다. 미설정(null)이면 빈 Map —
 * "공휴일에 쉰다"와는 다르다(그건 holidayClosedYn 이 갖는다). */
function applyInstitutionHolidayTime(row) {
  const dayMapNext = new Map();
  const breaksNext = new Map();

  const openTime = hmmToHHMM(row?.openHm);
  const closeTime = hmmToHHMM(row?.closeHm);
  if (openTime && closeTime) {
    dayMapNext.set(HOLIDAY_SLOT, [{kind: 'WORK', start: openTime, end: closeTime}]);

    const toBreak = (startHm, endHm) => {
      const s = hmmToHHMM(startHm);
      const e = hmmToHHMM(endHm);
      return (s && e) ? {start: s, end: e} : null;
    };
    breaksNext.set(HOLIDAY_SLOT, {
      LUNCH : toBreak(row.lunchStartHm, row.lunchEndHm),
      DINNER: toBreak(row.dinnerStartHm, row.dinnerEndHm),
    });
  }

  institutionHolidayDayMap.value = dayMapNext;
  institutionHolidayBreaks.value = breaksNext;
}

/* site strict 번들의 휴무 규칙 → 편집 baseline (weekdayOffs/dateOverrides/공휴일).
 * 휴무 규칙의 원천도 사업장 설정이므로, 운영시간과 함께 site 응답으로 strict 하게 받는다
 * (teams 만 getTreatmentSettings 로 별도 조회). recurringOffRules 는 매주(WEEKLY)와 매월 n번째(MONTHLY_n) 로 정규화. */
function applyOffRulesBaseline(payload) {
  const wMap = new Map();
  for (const rule of payload.recurringOffRules ?? []) {
    const optionKey = rule.repeatTy === 'WEEKLY' ? 'WEEKLY' : `MONTHLY_${rule.monthlyNth}`;
    if (!wMap.has(rule.dayCd)) wMap.set(rule.dayCd, new Set());
    wMap.get(rule.dayCd).add(optionKey);
  }
  /* 매주와 매월은 함께 쓸 수 없다 — 과거 데이터가 둘 다 가진 경우 매주로 정규화. */
  for (const options of wMap.values()) {
    if (options.has('WEEKLY') && options.size > 1) {
      options.clear();
      options.add('WEEKLY');
    }
  }
  weekdayOffs.value = wMap;

  const oMap = new Map();
  for (const d of payload.offDates ?? []) oMap.set(d, 'OFF');
  for (const d of payload.workDates ?? []) oMap.set(d, 'WORK');
  dateOverrides.value = oMap;

  if (typeof payload.holidayClosedYn === 'boolean') includePublicHolidays.value = payload.holidayClosedYn;
}

/* 운영시간 서버 → 내부 state 매핑 (원천 분리 2조회 — BE 계약 전환 2026-07).
 *  - getSiteWorkHours(site, 원천 사업장 설정): site[] → institutionWeeklyDayMap/Breaks, 휴무 규칙 → 편집 baseline
 *  - getStaffWorkHours(staff, 자체 TB): staff[]/overrides[] → workingHoursByOwner / workingHoursOverridesByOwner
 * override 는 weekly 와 달리 blocks=[] (시작/종료 null) 도 정상 저장 — "그 날짜만 휴무".
 *
 * ★게이트: 두 조회를 **독립 판정**한다(Promise.allSettled) — 한쪽 장애가 다른 쪽 저장을 막지 않게.
 *  reject 든 code!=='succeed' 든 자기 플래그(siteLoadFailed / staffLoadFailed)만 세운다.
 *  baseline 을 못 읽은 채 그 파트를 전체 치환 저장하면 통삭제되기 때문(#2).
 *  무음 catch 금지 — 실패를 표면화(인라인 안내 + 해당 파트 미전송 + 재시도).
 *
 * @param {{site?: boolean, staff?: boolean}} sources 재시도 시 실패한 원천만 다시 읽기 위한 선택자.
 *  (성공한 쪽을 다시 적용하면 사용자가 편집 중인 값을 덮어쓰므로 재시도는 실패분만 대상으로 한다.) */
async function hydrateWorkingHoursFromServer({site = true, staff = true} = {}) {
  const [siteSettled, staffSettled] = await Promise.allSettled([
    site ? getSiteWorkHours() : Promise.resolve(null),
    staff ? getStaffWorkHours() : Promise.resolve(null),
  ]);

  // ── 사업장(site) — 원천 사업장 설정. code=failed 는 "장애"(미설정 succeed+빈목록과 구분) ──
  if (site) {
    if (siteSettled.status === 'rejected') {
      console.error('[운영시간 > 사업장(site) 조회] 실패', siteSettled.reason);
      siteLoadFailed.value = true;
    } else {
      const siteRes = siteSettled.value;
      const siteBody = siteRes?.data ?? siteRes;
      if (siteBody?.code && siteBody.code !== 'succeed') {
        console.error('[운영시간 > 사업장(site) 조회] 실패', siteBody?.message);
        siteLoadFailed.value = true;
      } else {
        /* payload 부재 = 장애 — 조용히 넘기면 institutionWeeklyDayMap 이 빈 채 site:[] 로 저장돼
         * 사업장 운영시간이 통삭제된다(BE 는 [] 를 "전부 삭제" 의도로 읽는다).
         * ★미설정 거래처는 succeed + payload:{site:[], ...} 로 온다 — payload 는 존재하므로 여기 걸리지 않는다. */
        const sitePayload = siteBody?.payload;
        if (!sitePayload) {
          console.error('[운영시간 > 사업장(site) 조회] payload 부재 — baseline 미확보');
          siteLoadFailed.value = true;
        } else {
          applyInstitutionTimes(sitePayload.site);
          applyInstitutionHolidayTime(sitePayload.holidayHours);
          applyOffRulesBaseline(sitePayload);
          siteLoadFailed.value = false;
        }
      }
    }
  }

  // ── 담당자(staff) — 자체 TB. code 없이 payload 만 오는 게 정상이나 방어적으로 실패 검사 ──
  if (staff) {
    if (staffSettled.status === 'rejected') {
      console.error('[운영시간 > 담당자(staff) 조회] 실패', staffSettled.reason);
      staffLoadFailed.value = true;
      return;
    }
    const staffRes = staffSettled.value;
    const staffBody = staffRes?.data ?? staffRes;
    if (staffBody?.code && staffBody.code !== 'succeed') {
      console.error('[운영시간 > 담당자(staff) 조회] 실패', staffBody?.message);
      staffLoadFailed.value = true;
      return;
    }
    /* payload 부재 = 장애 — 넘기면 workingHoursByOwner 가 빈 채 workingHours.staff:[] 로 저장돼
     * 담당자 운영시간·오버라이드가 통삭제된다.
     * ★미설정 거래처는 succeed + payload:{staff:[], overrides:[]} 로 온다(payload 존재) → 정상 경로. */
    const staffPayload = staffBody?.payload;
    if (!staffPayload) {
      console.error('[운영시간 > 담당자(staff) 조회] payload 부재 — baseline 미확보');
      staffLoadFailed.value = true;
      return;
    }
    const weeklyNext = new Map();
    for (const staffRow of staffPayload.staff ?? []) {
      weeklyNext.set(`STAFF:${staffRow.staffId}`, timesToDayMap(staffRow.times));
    }
    workingHoursByOwner.value = weeklyNext;

    const overrideNext = new Map();
    for (const ov of staffPayload.overrides ?? []) {
      const key = `STAFF:${ov.staffId}`;
      const dayMap = overrideNext.get(key) ?? new Map();
      /* override(C) 는 weekday 필드 무관 — 지정 시작/종료만 본다 */
      dayMap.set(ov.date, overrideRowToBlocks(ov));
      overrideNext.set(key, dayMap);
    }
    workingHoursOverridesByOwner.value = overrideNext;

    staffLoadFailed.value = false;
  }
}

/* baseline 재조회 — 조회 장애 안내에서 "재시도". 실패한 원천만 다시 읽고,
 * 전부 정상이 되면 origin 스냅샷을 다시 캡처한다(그 전엔 파트별 게이트가 계속 유효). */
async function retryHydrate() {
  const retriedTeam = teamLoadFailed.value;
  const retriedSite = siteLoadFailed.value;
  const retriedStaff = staffLoadFailed.value;

  const tasks = [];
  if (retriedTeam) tasks.push(hydrateFromServer());
  if (retriedSite || retriedStaff) {
    tasks.push(hydrateWorkingHoursFromServer({site: retriedSite, staff: retriedStaff}));
  }
  await Promise.allSettled(tasks);

  /* baseline 은 **이번에 새로 읽어온 파트만** 갱신한다.
   * 전체를 다시 캡처하면, 재시도를 누르기 전에 사용자가 정상 파트(예: 팀)를 고쳐둔 내용까지
   * baseline 이 되어 dirty 가 사라진다 — 저장을 눌러도 API 가 안 나가고 그 편집이 조용히 증발한다.
   * 실패가 남아 있는 파트의 baseline 은 손대지 않는다(다음 재시도까지 유지). */
  const refreshed = [];
  if (retriedTeam && !teamLoadFailed.value) refreshed.push(...TEAM_STATE_KEYS);
  if (retriedStaff && !staffLoadFailed.value) refreshed.push(...WORKING_HOURS_STATE_KEYS);
  if (retriedSite && !siteLoadFailed.value) refreshed.push(...SITE_STATE_KEYS);
  if (refreshed.length) rebaseOriginFor(refreshed);
}

/* originState 의 일부 키만 현재 값으로 교체한다(파트별 baseline 갱신). */
function rebaseOriginFor(keys) {
  const now = captureState();
  const base = originState ? {...originState} : now;
  for (const k of keys) base[k] = now[k];
  originState = base;
}

onMounted(async () => {
  document.addEventListener('click', handleDocumentClick);
  document.addEventListener('mouseup', onDocumentMouseUp);
  window.addEventListener('scroll', handleScrollOrResize, true);
  window.addEventListener('resize', handleScrollOrResize);

  /* settings(팀) 와 운영시간(site/staff) 조회는 독립 → 병렬 호출.
   * 휴무 규칙 baseline 은 site 응답(strict)에서 받으므로 hydrateFromServer 는 teams 만 담당한다. */
  await Promise.allSettled([
    hydrateFromServer(),
    hydrateWorkingHoursFromServer(),
    fetchUnassignedAssignable(),
  ]);
  /* origin은 hydrate 후 캡처 — 서버 데이터 기준으로 dirty 비교 */
  originState = captureState();
});
onBeforeUnmount(() => {
  document.removeEventListener('click', handleDocumentClick);
  document.removeEventListener('mouseup', onDocumentMouseUp);
  window.removeEventListener('scroll', handleScrollOrResize, true);
  window.removeEventListener('resize', handleScrollOrResize);
});

/* origin 스냅샷 — 마운트 시 1회 캡처, onCancel에서 isEqual로 변경 여부 비교
 * Map/Set은 lodash isEqual이 구조적으로 비교하므로 정렬·평탄화 불필요 */
/* 스냅샷 키 → 실제 ref. 스냅샷 뜨기(captureState)와 되돌리기(revertStateFor)가 같은 표를
 * 쓰게 해서, 한쪽만 갱신돼 어긋나는 일을 막는다. */
const STATE_REFS = {
  weekdayOffs,
  dateOverrides,
  includePublicHolidays,
  teams,
  workingHoursByOwner,
  workingHoursOverridesByOwner,
  institutionWeeklyDayMap,
  institutionBreaksByWeekday,
  institutionHolidayDayMap,
  institutionHolidayBreaks,
};

function captureState() {
  const snapshot = {};
  for (const [key, stateRef] of Object.entries(STATE_REFS)) snapshot[key] = stateRef.value;
  return cloneDeep(snapshot);
}

/* 지정한 키들을 baseline(originState) 값으로 되돌린다 — 저장할 수 없는 파트의 편집을 버린다.
 * 화면도 함께 원래 값으로 돌아가므로, 사용자는 "안 들어갔다"는 안내와 화면이 일치하는 것을 본다. */
function revertStateFor(keys) {
  if (!originState) return;
  for (const key of keys) {
    if (!(key in STATE_REFS) || !(key in originState)) continue;
    STATE_REFS[key].value = cloneDeep(originState[key]);
  }
}

let originState = null;

/* 스냅샷 키의 파트 구분 — 저장 파트별 dirty 판정에 쓴다(BE 가 파트 단위로 skip 하므로).
 * 전송 게이트가 3축이므로 스냅샷 키도 3분할한다.
 *  TEAM         : payload.teams
 *  WORKING_HOURS: payload.workingHours
 *  운영일정 : payload.site + recurringOffRules/workDates/offDates/holidayClosedYn (한 번들, 원천 사업장 설정)
 *
 * ★captureState() 의 모든 키가 정확히 한 그룹에 속해야 한다 — 어느 그룹에도 없는 키가 생기면
 *  그 항목만 바꿨을 때 dirty 로 잡히지 않아 저장 API 자체가 스킵되는 조용한 버그가 된다.
 *  아래 STATE_KEY_GROUPS 합집합 == captureState() 키 집합을 개발 중 단언한다. */
const TEAM_STATE_KEYS = ['teams'];
const WORKING_HOURS_STATE_KEYS = ['workingHoursByOwner', 'workingHoursOverridesByOwner'];
const SITE_STATE_KEYS = ['weekdayOffs', 'dateOverrides', 'includePublicHolidays', 'institutionWeeklyDayMap', 'institutionBreaksByWeekday',
  'institutionHolidayDayMap', 'institutionHolidayBreaks'];

/* 공휴일 진료 여부·운영시간을 이번에 건드렸는가 — 공휴일 시간 필수 가드의 발동 조건.
 * 운영일정 설정 전체가 아니라 이 셋만 본다: 예전에 저장된 "진료인데 시간 없음" 상태는 그대로 둔 채
 * 휴무요일만 고치는 저장까지 막으면, 무관한 파트를 볼모로 잡는 덫이 된다(droppedKeys 주석과 같은 원칙). */
const HOLIDAY_STATE_KEYS = ['includePublicHolidays', 'institutionHolidayDayMap', 'institutionHolidayBreaks'];

if (import.meta.env.DEV) {
  const grouped = [...TEAM_STATE_KEYS, ...WORKING_HOURS_STATE_KEYS, ...SITE_STATE_KEYS];
  const captured = Object.keys(captureState());
  const missing = captured.filter(k => !grouped.includes(k));
  const orphan = grouped.filter(k => !captured.includes(k));
  if (missing.length || orphan.length) {
    console.error('[운영일정 설정] 스냅샷 키 그룹 누락 — 그 항목 변경이 저장되지 않는다', {missing, orphan});
  }
}

function isDirtyIn(keys) {
  const now = captureState();
  return keys.some(k => !isEqual(now[k], originState?.[k]));
}

function isDirty() {
  return !isEqual(captureState(), originState);
}

/* emit/console.log용 직렬화 가능 페이로드 (Map/Set → 평범한 객체/배열)
 * - recurringOffRules: (dayCd, repeatTy, monthlyNth) row 배열로 평탄화 → 백엔드 테이블 1:1 매핑
 * - workDates/offDates: type별 분리 → 백엔드에서 type 분기 없이 처리 */
function buildPayload() {
  const recurringOffRules = [];
  for (const [weekday, options] of weekdayOffs.value.entries()) {
    for (const option of options) {
      if (option === 'WEEKLY') {
        recurringOffRules.push({dayCd: weekday, repeatTy: 'WEEKLY', monthlyNth: null});
      } else {
        recurringOffRules.push({
          dayCd    : weekday,
          repeatTy : 'MONTHLY',
          monthlyNth: Number(option.split('_')[1]),
        });
      }
    }
  }
  recurringOffRules.sort((a, b) => {
    if (a.dayCd !== b.dayCd) return a.dayCd - b.dayCd;
    if (a.repeatTy !== b.repeatTy) return a.repeatTy === 'WEEKLY' ? -1 : 1;
    return (a.monthlyNth ?? 0) - (b.monthlyNth ?? 0);
  });

  const workDates = [];
  const offDates = [];
  /* ★공휴일 날짜도 그대로 내보낸다 — 여기서 걸러내면 일자별 운영시간(일자별 운영시간 테이블)이
   * 전체 치환이라 사업장 설정가 전개해 둔 공휴일 행이 저장할 때마다 통삭제된다.
   * 조회(applyOffRulesBaseline)는 이미 공휴일 날짜를 그대로 받고 있어, 걸러낸 쪽이 어긋난 것이었다. */
  for (const [key, type] of dateOverrides.value.entries()) {
    if (type === 'WORK') workDates.push(key);
    else if (type === 'OFF') offDates.push(key);
  }
  workDates.sort();
  offDates.sort();

  /* ★파트별 전송 — BE 계약: 필드 미전송(null) = 그 파트를 아예 손대지 않음.
   *   site 미전송         → 사업장 파트(기관 운영시간 + 휴무규칙 4종) 통째 skip
   *   teams 미전송        → 자체 파트 통째 skip
   *   workingHours 미전송 → 담당자 운영시간·오버라이드 두 테이블 미변경(삭제도 안 함). 팀은 정상 저장.
   * 조회 실패한 원천은 baseline 이 없으므로 아예 보내지 않는다(보내면 전체 치환으로 통삭제).
   * 빈 목록 []/{} 은 생략이 아니라 "전부 삭제" 라는 정상 의도다 — null 과 구분된다. */
  const payload = {};

  if (canSaveSite.value) {
    /* 사업장(site) 운영시간 — 진료하는 요일 행만. 원천 사업장 설정. 보낼 땐 반드시 완전상태로
     * (null 이면 BE 500 + 부분저장). 휴무는 여기 아닌 recurringOffRules 로.
     * 휴무규칙/지정일자/공휴일도 같은 사업장 번들이라 site 와 함께 나가거나 함께 빠진다. */
    payload.site = buildInstitutionTimesPayload();
    payload.holidayHours = buildInstitutionHolidayPayload();
    payload.recurringOffRules = recurringOffRules;
    payload.workDates = workDates;
    payload.offDates = offDates;
    payload.holidayClosedYn = includePublicHolidays.value;
  }

  if (canSaveTeams.value) {
    payload.teams = teams.value.map(t => ({...t, doctorIds: [...t.doctorIds]}));
  }

  /* ★workingHours 는 teams 없이 보낼 수 없다 — BE 가 요청 payload 의 teams 로 저장 대상 담당자를 거른다.
   * canSaveWorkingHours 가 이미 teamLoadFailed 를 포함하므로 여기서는 그대로 쓰면 된다. */
  if (canSaveWorkingHours.value) {
    payload.workingHours = buildWorkingHoursPayload();
  }

  return payload;
}

function onCancel() {
  if (!isDirty()) {
    emit('cancel');
    return;
  }

  askConfirm({
    title       : '수정한 설정값이 있습니다.',
    sub         : '저장하지 않고 화면을 닫으시겠습니까?',
    confirmLabel: '확인',
    onConfirm   : () => emit('cancel'),
  });
}

const saving = ref(false);

/* 우리가 띄운 다이얼로그가 떠 있는 동안인가 — 부모(SchedulerSearchFilter.onSettingsPopupHiding)가
 * 이 값을 보고 팝업 닫힘을 취소한다. 없으면 alert 의 [확인] 클릭이 그대로 팝업 외부클릭으로 이어져
 * "저장하지 않고 화면을 닫으시겠습니까?" 확인창이 연달아 뜬다(사용자가 닫을 의도가 없었는데도).
 * 부모는 optional chaining 으로 호출하므로, 노출하지 않으면 가드가 조용히 무력화된다. */
const dialogBusy = ref(false);

/* 서비스 접근 불가 안내 — 띄우는 동안 팝업 닫힘을 막는다.
 * 해제는 한 tick 뒤에 한다: [확인] 클릭과 팝업 hiding 이 같은 클릭에서 이어지므로,
 * 다이얼로그가 닫히자마자 풀면 가드가 걸리기 전에 false 가 된다. */
/* 시작·종료 중 한쪽만 입력한 채 넘어가려 할 때. alertServiceUnavailable 과 같은 dialogBusy 규약을 쓴다
 * — 안내를 띄우는 동안 팝업이 닫히면 붙잡아 둔 입력이 그대로 사라진다.
 *
 * ★재진입 방어: 이 안내는 popover commit 에서 나오고 commit 은 외부클릭·스크롤 등 여러 경로로 불린다.
 *   이미 떠 있는데 또 띄우면 안내가 겹겹이 쌓여 입력칸에 손도 못 대게 된다(무한 반복처럼 보인다).
 *   handleDocumentClick/handleScrollOrResize 의 dialogBusy 가드와 한 쌍이다. */
async function alertIncompleteTime() {
  if (dialogBusy.value) return;
  dialogBusy.value = true;
  try {
    await dialog.alert(INCOMPLETE_TIME_MSG, {title: '운영시간 입력'});
  } finally {
    await nextTick();
    dialogBusy.value = false;
  }
}

/* 공휴일 진료인데 공휴일 운영시간이 비어 있을 때. 안내만으로는 어디를 고칠지 알 수 없어
 * 운영시간 탭 + 사업장 패널을 펼쳐 공휴일 행이 화면에 보이게 한 뒤 띄운다. */
async function alertHolidayTimeRequired() {
  activeLeftTab.value = 'WORKING_HOURS';
  expandedTreatmentKey.value = 'institution';
  dialogBusy.value = true;
  try {
    await dialog.alert(HOLIDAY_TIME_REQUIRED_MSG, {title: '공휴일 운영시간 입력'});
  } finally {
    await nextTick();
    dialogBusy.value = false;
  }
}

async function alertServiceUnavailable() {
  dialogBusy.value = true;
  try {
    await dialog.alert(SERVICE_UNAVAILABLE_MSG, {title: '서비스 이용 안내'});
  } finally {
    await nextTick();
    dialogBusy.value = false;
  }
}

/* 저장은 settings/save 한 콜로 나간다 — 사업장(site)·휴무요일·지정일자·팀·담당자 운영시간을 한 번에.
 * 사업장 운영시간은 payload.site 에 흡수됐다(별도 institution PUT 제거).
 *
 * ★게이트: baseline 조회에 실패한 원천은 payload 에서 통째로 빠진다(buildPayload) — BE 가 그 파트를 skip 한다.
 *  못 읽은 상태로 전체 치환 저장하면 그 원천 데이터가 통삭제되기 때문. 저장할 수 있는 파트가
 *  하나도 없을 때(팀·site 둘 다 실패)만 일시적 장애 안내(재사용 문구)를 띄우고 중단한다.
 * ★dirty 가드: 파트별로 본다 — 게이트로 제외된 파트의 변경은 dirty 로 치지 않는다.
 *  실제 보낼 변경이 없으면 저장 API 를 건너뛰고 그대로 닫는다(불필요한 전체 치환·보드 재조회 회피).
 * ★유실 경고(droppedDirty): 게이트로 제외된 파트를 사용자가 고쳤다면 그 입력은 전송되지 않는다.
 *  입력칸은 계속 편집 가능하게 두는 대신, 저장 시점에 안내를 띄우고 **팝업을 닫지 않는다**.
 *  닫으면 방금 친 입력이 실제로 사라져 "저장된 줄 알았는데 없어졌다" 가 된다.
 *  보낼 수 있는 파트는 그대로 저장한다 — 팀은 운영시간 가용성과 무관하게 저장돼야 하므로. */
async function onSave() {
  if (saving.value) return;

  if (saveBlocked.value) {
    await alertServiceUnavailable();
    return;
  }

  /* ★최종 가드 — 시작·종료 중 한쪽만 채워진 행이 남아 있으면 저장하지 않는다.
   * popover 는 commit 에서 이미 막지만, 담당자 주간 7행 인라인 표는 입력 중간 상태를 그대로 둔다
   * (매 글자 막을 수 없다). 그대로 보내면 짝이 안 맞는 행이 휴무(null)으로 저장돼,
   * 시간을 입력해 둔 요일이 쉬는 날로 뒤집힌다. */
  const incompleteOwner = findIncompleteOwner(workingHoursByOwner.value)
      ?? findIncompleteOwner(workingHoursOverridesByOwner.value);
  if (incompleteOwner) {
    /* 안내만으로는 어느 칸인지 알 수 없다 — 그 담당자 패널을 펼쳐 하이라이트가 보이게 한다.
     * (접힌 패널에 빨간 테두리를 그려 봐야 화면에 없다.) */
    saveTried.value = true;
    expandIncompleteOwner(incompleteOwner);
    await alertIncompleteTime();
    return;
  }
  saveTried.value = false;

  /* 사용자가 실제로 고쳤는가(게이트 무관) */
  const teamEdited = isDirtyIn(TEAM_STATE_KEYS);
  const workingHoursEdited = isDirtyIn(WORKING_HOURS_STATE_KEYS);
  const siteEdited = isDirtyIn(SITE_STATE_KEYS);

  /* 실제로 전송되는가(고쳤고 + 게이트 통과) */
  const teamDirty = canSaveTeams.value && teamEdited;
  const workingHoursDirty = canSaveWorkingHours.value && workingHoursEdited;
  const siteDirty = canSaveSite.value && siteEdited;

  /* ★저장할 수 없는 파트의 편집은 baseline 으로 되돌린다.
   * 입력칸을 잠그지 않는 대신(편집은 계속 가능) 저장 시점에 버리고 한 번 알린다.
   *
   * 되돌리지 않으면 그 편집이 계속 dirty 로 남아, 저장을 눌러도 매번 같은 안내가 뜨고
   * 사용자가 손수 원래대로 고치기 전까지 다른 변경까지 저장을 방해한다(덫).
   * 저장할 수 없는 파트가 저장할 수 있는 파트를 볼모로 잡으면 안 된다 —
   * 팀·담당자 설정은 운영시간 가용성과 무관하게 저장돼야 한다는 것이 이 트랙의 요구사항이다. */
  const droppedKeys = [
    ...(teamEdited && !canSaveTeams.value ? TEAM_STATE_KEYS : []),
    ...(workingHoursEdited && !canSaveWorkingHours.value ? WORKING_HOURS_STATE_KEYS : []),
    ...(siteEdited && !canSaveSite.value ? SITE_STATE_KEYS : []),
  ];
  const droppedDirty = droppedKeys.length > 0;
  if (droppedDirty) revertStateFor(droppedKeys);

  if (!teamDirty && !workingHoursDirty && !siteDirty) {
    /* 보낼 게 없다 — 버린 편집이 있으면 한 번 알린 뒤 닫는다 */
    if (droppedDirty) await alertServiceUnavailable();
    emit('cancel');
    return;
  }

  /* ★공휴일 진료(체크 해제)로 저장하려면 공휴일 운영시간이 있어야 한다.
   * site 를 실제로 보내면서 **공휴일 설정을 이번에 건드렸을 때만** 본다 — 이미 저장돼 있던
   * "진료인데 시간 없음" 상태 때문에 무관한 저장까지 막으면 덫이 된다(HOLIDAY_STATE_KEYS 주석 참조). */
  if (siteDirty && isDirtyIn(HOLIDAY_STATE_KEYS)
      && !includePublicHolidays.value && !hasSiteHolidayHoursRange()) {
    await alertHolidayTimeRequired();
    return;
  }

  saving.value = true;

  const payload = buildPayload();

  try {
    const res = await saveTreatmentSettings(payload);
    const body = res?.data ?? res;
    /* 백엔드가 HTTP 200 + code 실패로 내려주는 케이스 처리.
     * payload 는 파트별 결과 {staff, site}: 'succeed'|'failed'|'skipped'.
     * 부분 성공이어도 code!=='succeed' 면 팝업을 닫지 않는다("성공 시에만 닫기"). */
    if (body?.code && body.code !== 'succeed') {
      console.error('[운영일정 설정 > 저장] 파트별 결과', body?.payload);
      push.error(body.message || '저장에 실패했습니다.');
      return;
    }
    /* 게이트로 빠진 편집이 있으면 성공 토스트 대신 유실 안내만 띄운다 — "저장되었습니다"와
     * "저장하지 못했다"가 동시에 뜨면 서로 모순돼 사용자가 무엇을 믿을지 알 수 없다.
     * 전송된 파트는 실제로 저장됐고, 지금 알려야 할 사실은 "일부가 안 들어갔다" 쪽이다.
     * 안내 뒤에는 닫는다(위 덫 방지와 같은 이유). */
    if (droppedDirty) await alertServiceUnavailable();
    else if (body?.message) push.success(body.message);
    /* 성공 시에만 팝업 닫기 */
    emit('save', payload);
  } catch (e) {
    push.error(e?.response?.data?.message || '저장에 실패했습니다.');
    console.error('[운영일정 설정 > 저장] 실패', e);
  } finally {
    saving.value = false;
  }
}

/* 부모(모달 hiding/외부 클릭/닫기 버튼)에서 호출 — onCancel 흐름과 동일 */
defineExpose({
  isDirty,
  attemptClose: onCancel,
  /* 다이얼로그가 떠 있는 동안 부모가 팝업을 닫지 않게 한다 — 안내 [확인] 클릭이
   * 곧바로 "저장하지 않고 닫으시겠습니까?"로 이어지던 문제를 막는다.
   * 인라인 확인창(confirmDialog)도 같은 이유로 포함한다. */
  isDialogBusy: () => dialogBusy.value || confirmDialog.value != null,
});
</script>

<template>
  <div class="schedulerTreatmentSetting">
    <!-- ===== Left Sidebar ===== -->
    <aside
        class="schedulerTreatmentSetting__sidebar"
        @wheel.stop
    >
      <div class="schedulerTreatmentSetting__segmentRow">
        <UiSegmentedControl
            v-model="activeLeftTab"
            :items="LEFT_TAB_ITEMS"
        />

        <button
            v-if="unassignedAssignable"
            class="schedulerTreatmentSetting__unassignedBtn"
            type="button"
            @click="openUnassignedDataSetting"
        >미지정 데이터 설정</button>
      </div>

      <section
          v-if="activeLeftTab === 'OFF'"
          class="schedulerTreatmentSetting__section"
      >
        <header class="schedulerTreatmentSetting__sectionHeader">
          사업장
        </header>

        <div class="schedulerTreatmentSetting__field">
          <span class="schedulerTreatmentSetting__fieldLabel">요일별</span>

          <div class="schedulerTreatmentSetting__weekdayList">
            <div
                v-for="(label, idx) in WEEKDAY_LABELS"
                :key="label"
                class="schedulerTreatmentSetting__weekdayItem"
            >
              <button
                  :ref="(el) => setWeekdayBtnRef(idx, el)"
                  :class="{
                    'is-active': hasAnyOption(idx),
                    'is-open'  : openWeekday === idx,
                  }"
                  class="schedulerTreatmentSetting__weekdayBtn"
                  type="button"
                  @click.stop="toggleWeekdayDropdown(idx)"
              >
                {{ label }}
              </button>

              <Teleport to="body">
                <div
                    v-if="openWeekday === idx"
                    :style="{
                      top : `${dropdownPosition.top}px`,
                      left: `${dropdownPosition.left}px`,
                    }"
                    class="schedulerTreatmentSetting__weekdayDropdown"
                    @click.stop
                    @mousedown.stop
                    @pointerdown.stop
                >
                  <!-- 모두 체크박스지만 매주와 매월은 배타다(toggleOption 이 강제).
                       매주를 켜면 매월 n번째는 선택할 수 없다. -->
                  <label
                      v-for="opt in RECURRING_OPTIONS"
                      :key="opt.value"
                      :class="{ 'is-disabled': opt.value !== 'WEEKLY' && hasOption(idx, 'WEEKLY') }"
                      class="schedulerTreatmentSetting__weekdayDropdownItem"
                  >
                    <input
                        :checked="hasOption(idx, opt.value)"
                        :disabled="opt.value !== 'WEEKLY' && hasOption(idx, 'WEEKLY')"
                        type="checkbox"
                        @change="toggleOption(idx, opt.value)"
                    />
                    <span>{{ opt.label }}</span>
                  </label>
                </div>
              </Teleport>
            </div>
          </div>
        </div>

        <ul class="schedulerTreatmentSetting__chipList">
          <li
              v-for="chip in recurringChips"
              :key="`recurring-${chip.weekday}-${chip.option}`"
              class="schedulerTreatmentSetting__chip"
          >
            <span>{{ chip.label }}</span>
            <button
                aria-label="삭제"
                class="schedulerTreatmentSetting__chipRemove"
                type="button"
                @click="toggleOption(chip.weekday, chip.option)"
            >×</button>
          </li>
        </ul>

        <div class="schedulerTreatmentSetting__field">
          <span class="schedulerTreatmentSetting__fieldLabel">특정일자</span>

          <!-- 지정은 오른쪽 달력에서 한다 — 지정된 일자가 없을 때만 조작법을 안내하고, 있으면 칩으로 대체한다 -->
          <div class="schedulerTreatmentSetting__fieldBody">
            <p v-if="!specificDates.length" class="schedulerTreatmentSetting__fieldHint">
              * 달력의 일자 선택 및 드래그 시 휴무일로 설정 가능
            </p>

            <template v-else>
              <!-- 목록이 길어질 수 있어 전부 노출하되(숨기면 저장에서도 빠져 사업장 설정 행이 지워진다)
                   진료/휴무 구분선 + 스크롤로 정리한다.
                   ※ "* 공휴일 및 휴무일" 안내를 두었었는데, 목록에 **진료 지정도** 들어가 사실과 달랐고
                      그룹 머리글(휴무/진료)이 같은 역할을 하므로 뺐다. -->
              <div class="schedulerTreatmentSetting__specificDates">
                <template v-for="group in specificDatesByType" :key="`override-type-${group.type}`">
                  <p
                      :class="[
                        'schedulerTreatmentSetting__specificDatesGroup',
                        group.type === 'OFF' ? 'is-off' : 'is-work',
                      ]"
                  >{{ group.label }}</p>

                  <ul class="schedulerTreatmentSetting__chipList schedulerTreatmentSetting__chipList--inline">
                    <li
                        v-for="range in group.ranges"
                        :key="`override-${range.startKey}-${range.endKey}-${range.type}`"
                        class="schedulerTreatmentSetting__chip"
                    >
                      <span>{{ range.label }}</span>
                      <button
                          aria-label="삭제"
                          class="schedulerTreatmentSetting__chipRemove"
                          type="button"
                          @click="removeSpecificRange(range)"
                      >×</button>
                    </li>
                  </ul>
                </template>
              </div>
            </template>
          </div>
        </div>

        <div class="schedulerTreatmentSetting__field">
          <span class="schedulerTreatmentSetting__fieldLabel">공휴일</span>

          <!-- 커버리지 안내는 hover tooltip 으로 — 공휴일 원천(사업장 설정)이 보유한 범위 밖은 표기되지 않는다.
               인라인 문구는 패널 폭에서 2줄로 깨지고, 아래 줄에 두면 필드 간격이 벌어진다. -->
          <label
              v-if="settingsLoaded"
              class="schedulerTreatmentSetting__check schedulerTreatmentSetting__check--tip"
              data-tip="공휴일은 현재 연도부터 최대 3년까지 표기됩니다."
          >
            <input
                :checked="includePublicHolidays"
                type="checkbox"
                @change="setIncludePublicHolidays($event.target.checked)"
            />
          </label>
        </div>
      </section>

      <template v-if="activeLeftTab === 'OFF'">
      <section
          v-for="team in teams"
          :key="team.id"
          class="schedulerTreatmentSetting__section"
      >
        <header
            :class="{ 'is-active': selectedTeamIds.has(team.id) }"
            class="schedulerTreatmentSetting__teamHeader"
            @click="toggleTeam(team.id)"
        >
          <input
              v-if="renamingTeam?.id === team.id"
              :ref="el => onRenameInputMount(el)"
              v-model="renamingTeam.name"
              type="text"
              class="schedulerTreatmentSetting__teamRenameInput"
              @click.stop
              @keyup.enter="saveRename"
              @keydown.esc="cancelRename"
              @blur="saveRename"
          />
          <span
              v-else
              class="schedulerTreatmentSetting__teamLabel"
          >- {{ team.name }}</span>

          <button
              aria-label="팀 메뉴"
              class="schedulerTreatmentSetting__teamMenu"
              type="button"
              @click.stop="openTeamMenu($event, team.id, false)"
          >⋯</button>
        </header>

        <ul
            class="schedulerTreatmentSetting__chipList schedulerTreatmentSetting__chipList--member"
            @dragover="onChipListDragOver($event, team.id)"
            @drop="onChipListDrop($event, team.id)"
        >
          <li
              v-for="(docId, idx) in team.doctorIds"
              :key="docId"
              :class="{
                'is-dragging'   : chipDrag.active && chipDrag.sourceTeamId === team.id && chipDrag.sourceIndex === idx,
                'is-drop-target': chipDrag.active && chipDrag.targetTeamId === team.id && chipDrag.targetIndex === idx,
              }"
              class="schedulerTreatmentSetting__chip schedulerTreatmentSetting__chip--draggable"
              @dragstart="onChipDragStart($event, team.id, docId, idx)"
              @dragover="onChipDragOver($event, team.id, idx)"
              @drop="onChipDrop($event, team.id, idx)"
              @dragend="onChipDragEnd"
          >
            <span>{{ getDoctor(docId)?.text }}</span>
            <button
                aria-label="삭제"
                class="schedulerTreatmentSetting__chipRemove"
                type="button"
                draggable="false"
                @click.stop="onRequestRemoveMember(team.id, docId)"
                @mousedown.stop
            >×</button>
          </li>
        </ul>
      </section>

      <!-- 신규 팀 생성 폼 -->
      <section
          v-if="editingTeam && editingTeam.id === null"
          class="schedulerTreatmentSetting__section schedulerTreatmentSetting__section--editing"
      >
        <header class="schedulerTreatmentSetting__teamEditHeader">
          <input
              v-model="editingTeam.name"
              type="text"
              placeholder="팀 이름을 입력하세요."
              class="schedulerTreatmentSetting__teamNameInput"
          />
          <button
              aria-label="팀 메뉴"
              class="schedulerTreatmentSetting__teamMenu"
              type="button"
              @click.stop="openTeamMenu($event, null, true)"
          >⋯</button>
        </header>

        <div
            class="schedulerTreatmentSetting__memberArea"
            @click.stop="openStaffPickerForNew($event)"
        >
          <ul
              v-if="editingTeam.doctorIds.length"
              class="schedulerTreatmentSetting__chipList schedulerTreatmentSetting__chipList--member"
          >
            <li
                v-for="docId in editingTeam.doctorIds"
                :key="docId"
                class="schedulerTreatmentSetting__chip"
            >
              <span>{{ getDoctor(docId)?.text }}</span>
              <button
                  aria-label="삭제"
                  class="schedulerTreatmentSetting__chipRemove"
                  type="button"
                  @click.stop="removeDoctorFromEditingTeam(docId)"
              >×</button>
            </li>
          </ul>
          <p
              v-else
              class="schedulerTreatmentSetting__memberPlaceholder"
          >클릭하여 직원을 추가해주세요</p>
        </div>
      </section>

      <!-- 신규 팀 추가 트리거 -->
      <button
          v-else
          class="schedulerTreatmentSetting__addBtn schedulerTreatmentSetting__addBtn--newTeam"
          type="button"
          @click="startCreateTeam"
      >+</button>
      </template>

      <!-- ===== 운영시간 탭: 팀 → 멤버(클릭 확장) + 사업장 ===== -->
      <template v-else-if="activeLeftTab === 'WORKING_HOURS'">
        <section
            v-for="team in teams"
            :key="`hours-${team.id}`"
            class="schedulerTreatmentSetting__section"
        >
          <header class="schedulerTreatmentSetting__teamHeader schedulerTreatmentSetting__teamHeader--readonly">
            <span class="schedulerTreatmentSetting__teamLabel">- {{ team.name }}</span>
          </header>

          <ul class="schedulerTreatmentSetting__memberList">
            <li
                v-for="docId in team.doctorIds"
                :key="docId"
                class="schedulerTreatmentSetting__memberItem"
            >
              <button
                  :class="{ 'is-expanded': expandedTreatmentKey === `staff:${docId}` }"
                  class="schedulerTreatmentSetting__memberRow"
                  type="button"
                  @click="toggleTreatmentExpansion(`staff:${docId}`)"
              >{{ getDoctor(docId)?.text }}</button>

              <!-- 담당자 운영시간 — 요일 7행을 그 자리에서 편집한다(요일 버튼 + popover 방식은 폐기).
                   진료는 시작~종료 한 구간이고, 둘 다 비우면 그 요일은 휴무이다.
                   휴게는 담당자가 갖지 않으므로 사업장 값을 읽기 전용으로 보여준다. -->
              <div
                  v-if="expandedTreatmentKey === `staff:${docId}`"
                  class="schedulerTreatmentSetting__hoursPanel"
              >
                <table class="schedulerTreatmentSetting__staffHoursTable">
                  <thead>
                    <tr>
                      <th class="schedulerTreatmentSetting__staffHoursHead">요일</th>
                      <th class="schedulerTreatmentSetting__staffHoursHead">운영시간</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr
                        v-for="(label, w) in WEEKDAY_LABELS"
                        :key="`hr-${docId}-${w}`"
                    >
                      <th
                          :class="{
                            'is-sunday'  : w === 0,
                            'is-saturday': w === 6,
                          }"
                          class="schedulerTreatmentSetting__hoursTableLabel"
                      >{{ label }}</th>
                      <!-- 매주 휴무인 요일은 담당자 운영시간을 정할 수 없다(휴무일 탭에서 해제해야 한다) -->
                      <td v-if="isWeekdayClosed(w)" class="schedulerTreatmentSetting__hoursOff">휴무</td>
                      <td v-else>
                        <input
                            :value="fetchStaffWorkHours(docId, w, 'start')"
                            :data-invalid="staffTimeInvalid(docId, w, 'start')"
                            class="schedulerTreatmentSetting__timeInput"
                            type="time"
                            @change="setStaffWorkHours(docId, w, 'start', $event.target.value)"
                        />
                        <span class="schedulerTreatmentSetting__timeDash">~</span>
                        <input
                            :value="fetchStaffWorkHours(docId, w, 'end')"
                            :data-invalid="staffTimeInvalid(docId, w, 'end')"
                            class="schedulerTreatmentSetting__timeInput"
                            type="time"
                            @change="setStaffWorkHours(docId, w, 'end', $event.target.value)"
                        />
                        <!-- 운영시간 비우기(= 그 요일 휴무). 시작/종료 중 값이 있을 때만 노출. -->
                        <button
                            v-if="fetchStaffWorkHours(docId, w, 'start') || fetchStaffWorkHours(docId, w, 'end')"
                            type="button"
                            class="schedulerTreatmentSetting__timeClear"
                            title="운영시간 지우기"
                            aria-label="운영시간 지우기"
                            @click="clearStaffWorkHours(docId, w)"
                        >×</button>
                      </td>
                    </tr>
                  </tbody>
                </table>

                <!-- 휴게시간은 사업장 값을 그대로 따른다 — 담당자가 편집하는 값이 아니라
                     요일 아래에 안내로 둔다 -->
                <div class="schedulerTreatmentSetting__staffBreakRow">
                  <span>{{ BLOCK_KIND_LABEL.LUNCH }} {{ institutionBreakSummary('LUNCH') }}</span>
                  <span>{{ BLOCK_KIND_LABEL.DINNER }} {{ institutionBreakSummary('DINNER') }}</span>
                </div>
              </div>
            </li>
          </ul>
        </section>

        <!-- 사업장 — 운영시간 탭 맨 아래. 담당자와 동일하게 요일별로 편집한다(원천=사업장 설정) -->
        <section class="schedulerTreatmentSetting__section">
          <div
              :class="{ 'is-expanded': expandedTreatmentKey === 'institution' }"
              class="schedulerTreatmentSetting__institutionRow"
          >
            <button
                class="schedulerTreatmentSetting__institutionExpand"
                type="button"
                @click="toggleTreatmentExpansion('institution')"
            >사업장</button>
          </div>

          <div
              v-if="expandedTreatmentKey === 'institution'"
              class="schedulerTreatmentSetting__hoursPanel"
          >
            <!-- 매주 휴무인 요일은 운영시간을 정할 이유가 없어 편집을 막는다(휴무일 탭에서 해제해야 한다) -->
            <div class="schedulerTreatmentSetting__hoursWeekdays">
              <button
                  v-for="(label, idx) in WEEKDAY_LABELS"
                  :key="`hw-inst-${idx}`"
                  :class="{
                    'is-active'  : hasBlocksFor('INSTITUTION', idx) && !isWeekdayClosed(idx),
                    'is-editing' : weekdayEditor.open
                      && weekdayEditor.ownerKey === 'INSTITUTION'
                      && weekdayEditor.weekday === idx,
                    'is-sunday'  : idx === 0,
                    'is-saturday': idx === 6,
                  }"
                  :disabled="isWeekdayClosed(idx) || siteLocked"
                  class="schedulerTreatmentSetting__hoursWeekdayBtn"
                  type="button"
                  @click.stop="openWeekdayEditor($event, 'INSTITUTION', idx)"
              >{{ label }}</button>

              <!-- 공휴일은 요일이 아니라 별도 한 세트다(모든 공휴일에 공통 적용).
                   공휴일에 쉬기로 했으면(휴무일 탭 체크박스) 정할 이유가 없어 잠근다. -->
              <button
                  :class="{
                    'is-active'  : hasInstitutionHolidayBlocks() && !holidayTimeLocked,
                    'is-editing' : weekdayEditor.open && weekdayEditor.ownerKey === HOLIDAY_OWNER,
                  }"
                  :disabled="holidayTimeLocked"
                  class="schedulerTreatmentSetting__hoursWeekdayBtn schedulerTreatmentSetting__hoursWeekdayBtn--holiday"
                  type="button"
                  @click.stop="openWeekdayEditor($event, HOLIDAY_OWNER, HOLIDAY_SLOT)"
              >공휴일</button>
            </div>

            <table class="schedulerTreatmentSetting__hoursTable">
              <tbody>
                <tr
                    v-for="(label, w) in WEEKDAY_LABELS"
                    :key="`hr-inst-${w}`"
                >
                  <th
                      :class="{
                        'is-sunday'  : w === 0,
                        'is-saturday': w === 6,
                      }"
                      class="schedulerTreatmentSetting__hoursTableLabel"
                  >{{ label }}</th>
                  <!-- 매주 휴무인 요일은 운영시간이 있어도 휴무로 보여준다(휴무 규칙이 우선) -->
                  <!-- 운영시간은 왼쪽 한 줄, 휴게시간1·2 는 오른쪽에 세로로 둔다 -->
                  <template v-if="!isWeekdayClosed(w) && hasInstitutionDisplayBlocks(w)">
                    <td class="schedulerTreatmentSetting__siteHoursCell">
                      {{ BLOCK_KIND_LABEL.WORK }}
                      <span class="schedulerTreatmentSetting__hoursValue">{{ formatSiteHours(w) }}</span>
                    </td>
                    <td class="schedulerTreatmentSetting__instBreakCell">
                      <div
                          v-for="kind in BREAK_BLOCK_KINDS"
                          :key="`brk-inst-${w}-${kind}`"
                      >
                        {{ BLOCK_KIND_LABEL[kind] }}
                        <span class="schedulerTreatmentSetting__hoursValue">{{ formatInstitutionBreak(w, kind) }}</span>
                      </div>
                    </td>
                  </template>
                  <!-- ★사업장 운영시간은 원천(사업장 설정)이 2상태다 — 행이 없거나 값이 없으면 '휴무'.
                       그래서 표기도 원천을 따라간다. 단 조회에 실패했을 때는 원천이 뭘 갖고 있는지
                       모르는 것이므로 '휴무'이라 단정하지 않는다(장애를 휴무로 오표기하면
                       전 요일이 쉬는 것처럼 보인다 — 배너·저장차단과 함께 '운영시간 없음'으로 둔다).
                       ※표기만 따라갈 뿐 저장은 하지 않는다 — 미설정 요일을 휴무로 만들어 보내지 않는다.
                       요일버튼은 계속 열려 있어 지금 바로 운영시간을 정할 수 있다. -->
                  <td v-else-if="isWeekdayClosed(w)" class="schedulerTreatmentSetting__hoursOff" colspan="2">휴무</td>
                  <td v-else class="schedulerTreatmentSetting__hoursOff" colspan="2">
                    {{ siteLoadFailed ? '운영시간 없음' : '휴무' }}
                  </td>
                </tr>

                <!-- 공휴일 — 요일 아래 한 행. 모든 공휴일에 공통 적용되는 한 세트다.
                     공휴일 휴무(체크박스 ON)이면 '휴무'만 보이고 값은 보존된다. -->
                <tr class="schedulerTreatmentSetting__hoursTableHolidayRow">
                  <th class="schedulerTreatmentSetting__hoursTableLabel">공휴일</th>
                  <template v-if="!holidayTimeLocked && hasInstitutionHolidayBlocks()">
                    <td class="schedulerTreatmentSetting__siteHoursCell">
                      {{ BLOCK_KIND_LABEL.WORK }}
                      <span class="schedulerTreatmentSetting__hoursValue">{{ formatSiteHolidayHours() }}</span>
                    </td>
                    <td class="schedulerTreatmentSetting__instBreakCell">
                      <div
                          v-for="kind in BREAK_BLOCK_KINDS"
                          :key="`brk-inst-holiday-${kind}`"
                      >
                        {{ BLOCK_KIND_LABEL[kind] }}
                        <span class="schedulerTreatmentSetting__hoursValue">{{ formatInstitutionHolidayBreak(kind) }}</span>
                      </div>
                    </td>
                  </template>
                  <!-- ★조회 실패를 먼저 가른다 — 못 읽었을 뿐인데 '휴무'이라 쓰면 거짓이다.
                       공휴일 체크박스의 기본값이 '휴무'이라, 순서를 뒤집으면 장애가 휴무로 보인다. -->
                  <td v-else-if="siteLoadFailed" class="schedulerTreatmentSetting__hoursOff" colspan="2">운영시간 없음</td>
                  <td v-else-if="includePublicHolidays" class="schedulerTreatmentSetting__hoursOff" colspan="2">휴무</td>
                  <!-- 공휴일에 진료하기로 했는데 시간을 아직 안 정했다 — 쉬기로 한 것과 다르다. -->
                  <td v-else class="schedulerTreatmentSetting__hoursOff" colspan="2">미설정</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      </template>

      <!-- 직원 선택 picker -->
      <Teleport to="body">
        <div
            v-if="staffPicker.open"
            ref="staffPickerEl"
            :style="{
              top : `${staffPicker.top}px`,
              left: `${staffPicker.left}px`,
            }"
            class="schedulerTreatmentSetting__staffPicker"
            @click.stop
            @mousedown.stop
            @pointerdown.stop
        >
          <div class="schedulerTreatmentSetting__staffPickerList">
            <button
                v-for="doc in doctors"
                :key="doc.staffId"
                :class="{
                  'is-selected': staffPicker.staged.has(doc.staffId),
                  'is-disabled': staffPickerDisabledIds.has(doc.staffId),
                }"
                :disabled="staffPickerDisabledIds.has(doc.staffId)"
                class="schedulerTreatmentSetting__staffOption"
                type="button"
                @click="toggleStagedDoctor(doc.staffId)"
            >{{ doc.text }}</button>
          </div>

          <div class="schedulerTreatmentSetting__staffPickerActions">
            <button
                class="schedulerTreatmentSetting__staffPickerCancel"
                type="button"
                @click="closeStaffPicker"
            >취소</button>
            <button
                class="schedulerTreatmentSetting__staffPickerConfirm"
                type="button"
                @click="confirmStaffPicker"
            >완료</button>
          </div>
        </div>
      </Teleport>

      <!-- 팀 "..." 컨텍스트 메뉴 -->
      <Teleport to="body">
        <div
            v-if="teamMenu.open"
            :style="{
              top : `${teamMenu.top}px`,
              left: `${teamMenu.left}px`,
            }"
            class="schedulerTreatmentSetting__teamMenuDropdown"
            @click.stop
            @mousedown.stop
            @pointerdown.stop
        >
          <template v-if="!teamMenu.isCreating">
            <button
                class="schedulerTreatmentSetting__teamMenuItem"
                type="button"
                @click="handleMenuRename"
            >이름 변경</button>
            <button
                class="schedulerTreatmentSetting__teamMenuItem"
                type="button"
                @click="handleMenuMembers"
            >구성원 설정</button>
          </template>
          <button
              class="schedulerTreatmentSetting__teamMenuItem"
              type="button"
              @click="handleMenuDelete"
          >삭제</button>
        </div>
      </Teleport>

      <!-- 운영시간: 요일 편집 popover -->
      <Teleport to="body">
        <div
            v-if="weekdayEditor.open"
            :style="{
              top : `${weekdayEditor.top}px`,
              left: `${weekdayEditor.left}px`,
            }"
            class="schedulerTreatmentSetting__weekdayEditor"
            @click.stop
            @mousedown.stop
            @pointerdown.stop
        >
          <!-- 운영시간 — 사용여부 토글 없이 시간 입력 여부로 판단한다(비우면 그 요일 휴무) -->
          <div
              v-for="kind in WORK_BLOCK_KINDS"
              :key="kind"
              :class="{ 'is-inactive': isEditorSlotEmpty(weekdayEditor.draft, kind) }"
              class="schedulerTreatmentSetting__weekdayEditorRow"
          >
            <span class="schedulerTreatmentSetting__weekdayEditorKindLabel">
              {{ BLOCK_KIND_LABEL[kind] }}
            </span>
            <input
                :value="weekdayEditor.draft[kind].start"
                :data-invalid="editorSlotInvalid(weekdayEditor, kind, 'start')"
                class="schedulerTreatmentSetting__timeInput"
                type="time"
                @change="setEditorBlockTime(kind, 'start', $event.target.value)"
            />
            <span class="schedulerTreatmentSetting__timeDash">~</span>
            <input
                :value="weekdayEditor.draft[kind].end"
                :data-invalid="editorSlotInvalid(weekdayEditor, kind, 'end')"
                class="schedulerTreatmentSetting__timeInput"
                type="time"
                @change="setEditorBlockTime(kind, 'end', $event.target.value)"
            />
          </div>

          <!-- 휴게시간1/2 — 사업장에만. 운영시간과 같은 규약(시간 입력 여부로 판단) -->
          <template v-if="editorHasBreaks(weekdayEditor.ownerKey)">
            <div class="schedulerTreatmentSetting__weekdayEditorDivider"></div>
            <div
                v-for="kind in BREAK_BLOCK_KINDS"
                :key="`brk-${kind}`"
                :class="{ 'is-inactive': isEditorSlotEmpty(weekdayEditor.draft, kind) }"
                class="schedulerTreatmentSetting__weekdayEditorRow"
            >
              <span class="schedulerTreatmentSetting__weekdayEditorKindLabel">
                {{ BLOCK_KIND_LABEL[kind] }}
              </span>
              <input
                  :value="weekdayEditor.draft[kind].start"
                  :data-invalid="editorSlotInvalid(weekdayEditor, kind, 'start')"
                  class="schedulerTreatmentSetting__timeInput"
                  type="time"
                  @change="setEditorBlockTime(kind, 'start', $event.target.value)"
              />
              <span class="schedulerTreatmentSetting__timeDash">~</span>
              <input
                  :value="weekdayEditor.draft[kind].end"
                  :data-invalid="editorSlotInvalid(weekdayEditor, kind, 'end')"
                  class="schedulerTreatmentSetting__timeInput"
                  type="time"
                  @change="setEditorBlockTime(kind, 'end', $event.target.value)"
              />
            </div>
          </template>
        </div>
      </Teleport>

      <!-- 미지정 데이터 적용 modal -->
      <Teleport to="body">
        <div
            v-if="unassignedDataModal.open"
            class="schedulerTreatmentSetting__deleteOverlay"
            @click.stop="closeUnassignedDataModal"
            @mousedown.stop
        >
          <div
              class="schedulerTreatmentSetting__unassignedPanel"
              @click.stop
          >
            <header class="schedulerTreatmentSetting__unassignedHeader">
              <span class="schedulerTreatmentSetting__unassignedTitle">미지정 데이터 적용</span>
              <button
                  aria-label="닫기"
                  class="schedulerTreatmentSetting__unassignedClose"
                  type="button"
                  @click="closeUnassignedDataModal"
              >×</button>
            </header>

            <p class="schedulerTreatmentSetting__unassignedDesc">
              담당자가 미지정된 예약/진료건에 대해 일괄 적용할 대상을 선택해주세요.
            </p>

            <div class="schedulerTreatmentSetting__unassignedOptions">
              <label
                  v-for="doc in teamDoctors"
                  :key="`unassigned-${doc.staffId}`"
                  class="schedulerTreatmentSetting__unassignedOption"
              >
                <input
                    :checked="unassignedDataModal.selectedStaffId === doc.staffId"
                    type="radio"
                    name="unassignedDoctor"
                    @change="selectUnassignedDoctor(doc.staffId)"
                />
                <span>{{ doc.name }}</span>
              </label>
              <p
                  v-if="teamDoctors.length === 0"
                  class="schedulerTreatmentSetting__unassignedEmpty"
              >팀에 등록된 담당자가 없습니다.</p>
            </div>

            <div class="schedulerTreatmentSetting__deleteActions">
              <button
                  :disabled="applyingUnassigned"
                  class="schedulerTreatmentSetting__unassignedLaterBtn"
                  type="button"
                  @click="closeUnassignedDataModal"
              >나중에 설정</button>
              <button
                  :disabled="unassignedDataModal.selectedStaffId == null || applyingUnassigned"
                  class="schedulerTreatmentSetting__deleteConfirmBtn"
                  type="button"
                  @click="applyUnassignedData"
              >{{ applyingUnassigned ? '적용 중...' : '적용' }}</button>
            </div>
          </div>
        </div>
      </Teleport>

      <!-- 확인 다이얼로그 (팀 삭제 / 멤버 삭제 / 멤버 이동 공용) -->
      <Teleport to="body">
        <div
            v-if="confirmDialog"
            class="schedulerTreatmentSetting__deleteOverlay"
            @click.stop
            @mousedown.stop
        >
          <div class="schedulerTreatmentSetting__deletePanel">
            <p class="schedulerTreatmentSetting__deleteMessage">{{ confirmDialog.title }}</p>
            <p
                v-if="confirmDialog.sub"
                class="schedulerTreatmentSetting__deleteSubMessage"
            >{{ confirmDialog.sub }}</p>
            <div class="schedulerTreatmentSetting__deleteActions">
              <button
                  class="schedulerTreatmentSetting__deleteCancelBtn"
                  type="button"
                  @click="closeConfirmDialog"
              >취소</button>
              <button
                  class="schedulerTreatmentSetting__deleteConfirmBtn"
                  type="button"
                  @click="executeConfirm"
              >{{ confirmDialog.confirmLabel }}</button>
            </div>
          </div>
        </div>
      </Teleport>
    </aside>

    <!-- ===== Right Main ===== -->
    <div class="schedulerTreatmentSetting__main">
      <header class="schedulerTreatmentSetting__yearNav">
        <button
            :aria-label="activeLeftTab === 'OFF' ? '이전 년' : '이전 월'"
            class="schedulerTreatmentSetting__arrow"
            type="button"
            @click="activeLeftTab === 'OFF' ? prevYear() : prevMonth()"
        />

        <span class="schedulerTreatmentSetting__yearLabel">
          <template v-if="activeLeftTab === 'OFF'">{{ selectedYear }}년</template>
          <template v-else>{{ selectedMonth }}월</template>
        </span>

        <button
            :aria-label="activeLeftTab === 'OFF' ? '다음 년' : '다음 월'"
            class="schedulerTreatmentSetting__arrow schedulerTreatmentSetting__arrow--next"
            type="button"
            @click="activeLeftTab === 'OFF' ? nextYear() : nextMonth()"
        />
      </header>

      <!-- 휴무일: 1년 12개월 미니 캘린더 -->
      <div
          v-if="activeLeftTab === 'OFF'"
          class="schedulerTreatmentSetting__yearGrid"
      >
        <div
            v-for="m in yearMonths"
            :key="m.key"
            class="schedulerTreatmentSetting__miniMonth"
        >
          <div class="schedulerTreatmentSetting__miniMonthLabel">{{ m.label }}</div>

          <div class="schedulerTreatmentSetting__miniMonthGrid">
            <div
                v-for="cell in m.cells"
                :key="cell.key"
                :class="{
                  'is-sunday'        : cell.weekday === 0,
                  'is-saturday'      : cell.weekday === 6,
                  'is-holiday'       : cell.isHoliday,
                  'is-off'           : cell.isOff,
                  'is-other'         : !cell.isCurrentMonth,
                  'is-drag-selecting': isInDragRange(cell),
                }"
                class="schedulerTreatmentSetting__miniDay"
                @mousedown="onCellMouseDown(cell, $event)"
                @mouseenter="onCellMouseEnter(cell)"
            >
              <span
                  v-if="cell.isCurrentMonth"
                  class="schedulerTreatmentSetting__miniDayNum"
              >{{ cell.dayNumber }}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- 운영시간: 선택 월 상세 캘린더 -->
      <div
          v-else
          class="schedulerTreatmentSetting__monthView"
      >
        <div class="schedulerTreatmentSetting__monthHeader">
          <div
              v-for="(label, idx) in WEEKDAY_LABELS"
              :key="label"
              :class="{
                'is-sunday'  : idx === 0,
                'is-saturday': idx === 6,
              }"
              class="schedulerTreatmentSetting__monthHeaderCell"
          >
            {{ label }}
          </div>
        </div>

        <div class="schedulerTreatmentSetting__monthGrid">
          <div
              v-for="cell in monthCells"
              :key="cell.key"
              :class="{
                'is-sunday'  : cell.weekday === 0,
                'is-saturday': cell.weekday === 6,
                'is-off'     : cell.isOff,
                'is-other'   : !cell.isCurrentMonth,
              }"
              class="schedulerTreatmentSetting__monthCell"
          >
            <div class="schedulerTreatmentSetting__monthCellHeader">
              <span class="schedulerTreatmentSetting__monthCellDate">{{ cell.dayNumber }}</span>
              <span
                  v-if="cell.isCurrentMonth && cell.isOff"
                  class="schedulerTreatmentSetting__offLabel"
              >휴무</span>
            </div>

            <!-- INSTITUTION 모드: 직원별 리스트 (최대 5, 초과 시 더보기) -->
            <div
                v-if="cell.isCurrentMonth && cell.entries && cell.entries.length"
                class="schedulerTreatmentSetting__monthCellEntries"
            >
              <button
                  v-for="(entry, i) in cell.entries.slice(0, CELL_ENTRY_VISIBLE_MAX)"
                  :key="i"
                  :class="{
                    'is-off'    : entry.isOff,
                    'is-editing': cellStaffEditor.open
                        && cellStaffEditor.ownerKey === `STAFF:${entry.staffId}`
                        && cellStaffEditor.dateKey === cell.key,
                  }"
                  class="schedulerTreatmentSetting__monthCellEntry"
                  type="button"
                  @click.stop="openCellStaffEditor($event, `STAFF:${entry.staffId}`, cell.key, cell.weekday)"
              >{{ entry.label }}</button>
              <button
                  v-if="cell.entries.length > CELL_ENTRY_VISIBLE_MAX"
                  class="schedulerTreatmentSetting__monthCellMore"
                  type="button"
                  @click.stop="openCellMore($event, cell)"
              >+{{ cell.entries.length - CELL_ENTRY_VISIBLE_MAX }} 더보기</button>
            </div>

            <!-- STAFF 모드: 단일 라벨 -->
            <div
                v-else-if="cell.isCurrentMonth && cell.appointmentLabel"
                class="schedulerTreatmentSetting__monthCellBody"
            >
              {{ cell.appointmentLabel }}
            </div>
          </div>
        </div>
      </div>

      <!-- 셀 더보기 popover (INSTITUTION 모드, entries>5) -->
      <CellMorePopover
          :open="cellMorePopover.open"
          :top="cellMorePopover.top"
          :left="cellMorePopover.left"
          :day-number="cellMorePopover.dayNumber"
          :is-off="cellMorePopover.isOff"
          @close="closeCellMore"
      >
        <button
            v-for="(entry, i) in cellMorePopover.entries"
            :key="i"
            :class="{'is-off': entry.isOff}"
            class="schedulerTreatmentSetting__monthCellEntry"
            type="button"
            @click.stop="openCellStaffEditor($event, `STAFF:${entry.staffId}`, cellMorePopover.dateKey, cellMorePopover.weekday)"
        >{{ entry.label }}</button>
      </CellMorePopover>

      <!-- 셀 × 직원 popover editor (날짜별 override 편집) -->
      <Teleport to="body">
        <div
            v-if="cellStaffEditor.open"
            :style="{
              top : `${cellStaffEditor.top}px`,
              left: `${cellStaffEditor.left}px`,
            }"
            class="schedulerTreatmentSetting__weekdayEditor"
            @click.stop
            @mousedown.stop
            @pointerdown.stop
        >
          <!-- 시간을 비우면 "그 날짜만 휴무" 지정이 된다 -->
          <div
              v-for="kind in WORK_BLOCK_KINDS"
              :key="`cse-${kind}`"
              :class="{ 'is-inactive': isEditorSlotEmpty(cellStaffEditor.draft, kind) }"
              class="schedulerTreatmentSetting__weekdayEditorRow"
          >
            <span class="schedulerTreatmentSetting__weekdayEditorKindLabel">
              {{ BLOCK_KIND_LABEL[kind] }}
            </span>
            <input
                :value="cellStaffEditor.draft[kind].start"
                :data-invalid="editorSlotInvalid(cellStaffEditor, kind, 'start')"
                class="schedulerTreatmentSetting__timeInput"
                type="time"
                @change="setCellStaffBlockTime(kind, 'start', $event.target.value)"
            />
            <span class="schedulerTreatmentSetting__timeDash">~</span>
            <input
                :value="cellStaffEditor.draft[kind].end"
                :data-invalid="editorSlotInvalid(cellStaffEditor, kind, 'end')"
                class="schedulerTreatmentSetting__timeInput"
                type="time"
                @change="setCellStaffBlockTime(kind, 'end', $event.target.value)"
            />
          </div>
        </div>
      </Teleport>

      <!-- 조회(baseline) 장애 → 인라인 안내 + 실패한 원천만 저장 제외 + 재시도(실패분만 재조회).
           못 읽은 상태로 저장하면 그 원천 데이터가 통삭제된다.
           저장 버튼은 "저장할 수 있는 파트가 하나도 없을 때"만 비활성(saveBlocked = 팀·site 둘 다 실패). -->
      <div
          v-if="loadFailed"
          class="schedulerTreatmentSetting__loadError"
          role="alert"
      >
        <span class="schedulerTreatmentSetting__loadErrorMsg">운영시간 정보를 불러오지 못했습니다. 잠시 후 다시 시도해주세요.</span>
        <button
            class="schedulerTreatmentSetting__loadErrorRetry"
            type="button"
            @click="retryHydrate"
        >재시도</button>
      </div>

      <footer class="schedulerTreatmentSetting__footer">
        <button
            class="schedulerTreatmentSetting__cancelBtn"
            type="button"
            @click="onCancel"
        >취소</button>

        <button
            :disabled="saving || saveBlocked"
            :title="saveBlocked ? '운영시간 정보를 불러오지 못해 저장할 수 없습니다.' : ''"
            class="schedulerTreatmentSetting__saveBtn"
            type="button"
            @click="onSave"
        >{{ saving ? '저장 중...' : '저장' }}</button>
      </footer>
    </div>
  </div>
</template>

<style lang="scss" scoped>
@use '@/scss/variables' as *;

.schedulerTreatmentSetting {
  display: flex;
  height: 100%;
  min-height: 0;

  /* ---------- Sidebar ---------- */
  &__sidebar {
    flex: 0 0 400px;
    display: flex;
    flex-direction: column;
    min-height: 0;
    padding: 10px;
    overflow-y: auto;
    background: #fff;
  }

  /* 휴무일/운영시간 세그먼트 + 미지정 데이터 설정 버튼 한 줄 배치 */
  &__segmentRow {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  &__unassignedBtn {
    height: 26px;
    padding: 0 12px;
    border: 1px solid $color-border-light;
    border-radius: $radius-2;
    background: #fff;
    cursor: pointer;
    font-size: $font-size-12;
    font-weight: $font-weight-medium;
    color: $color-text-default;
    white-space: nowrap;

    &:hover {
      background: $color-surface-hover;
    }
  }

  &__section {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px;
    background: #fff;

    & + & {
      margin-top: 10px;
    }

    &--placeholder {
      color: $color-text-muted;
      font-size: $font-size-12;
    }
  }

  &__sectionHeader {
    font-size: $font-size-13;
    font-weight: $font-weight-bold;
    color: $color-text-default;
    padding: 4px 8px;
    background: $color-bg-segment;
  }

  &__field {
    display: flex;
    align-items: flex-start;
    gap: 8px;
  }

  &__fieldLabel {
    flex: 0 0 56px;
    font-size: $font-size-12;
    font-weight: $font-weight-medium;
    color: $color-text-default;
    padding-top: 4px;
  }

  &__fieldBody {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  /* 조작이 오른쪽 달력에서 이뤄지는 항목의 사용법 안내 */
  &__fieldHint {
    margin: 0;
    padding-top: 4px;
    font-size: $font-size-11;
    line-height: 1.5;
    color: $color-text-muted;
  }

  /* 특정일자 목록 — 사업장 설정가 공휴일을 여러 해 치 전개해 두므로 길어진다.
     전부 노출하되 높이를 묶고 스크롤한다(숨기면 저장에서도 빠져 사업장 설정 행이 지워진다). */
  &__specificDates {
    max-height: 132px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  /* 진료/휴무 구분 머리글. 이 목록에서 가장 먼저 읽혀야 하는 정보라 색으로 갈라 준다
     — 종전처럼 칩 뒤에 "(휴무)"으로 붙이면 눈에 들어오지 않는다. */
  &__specificDatesGroup {
    position: sticky;
    top: 0;
    z-index: 1;
    margin: 0;
    padding: 2px 0;
    background: #fff;
    font-size: $font-size-11;
    font-weight: 700;

    &.is-off {
      color: #e54848;
    }

    &.is-work {
      color: $color-text-muted;
    }
  }

  &__weekdayList {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }

  &__weekdayItem {
    position: relative;
    display: inline-flex;
  }

  &__weekdayBtn {
    width: 26px;
    height: 24px;
    border: 1px solid $color-border-light;
    border-radius: $radius-2;
    background: #fff;
    cursor: pointer;
    font-size: $font-size-12;
    color: $color-text-default;

    &.is-active {
      background: #E88B1D;
      border-color: #E88B1D;
      color: #fff;
      font-weight: $font-weight-bold;
    }

    &.is-open {
      box-shadow: 0 0 0 1px #E88B1D;
    }
  }

  &__weekdayDropdown {
    position: fixed;
    z-index: 2000;
    min-width: 120px;
    padding: 6px 0;
    background: #fff;
    border: 1px solid $color-border-light;
    border-radius: $radius-2;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.12);
    display: flex;
    flex-direction: column;
  }

  &__weekdayDropdownItem {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    cursor: pointer;
    font-size: $font-size-12;
    color: $color-text-default;
    user-select: none;
    white-space: nowrap;

    /* 매주 휴무를 고르면 매월 n번째는 의미가 없어져 선택할 수 없다. */
    &.is-disabled {
      cursor: not-allowed;
      color: $color-text-muted;
    }

    &:first-child {
      border-bottom: 1px solid $color-border-light;
    }

    &:hover {
      background: $color-surface-hover;
    }

    input[type="checkbox"] {
      width: 14px;
      height: 14px;
      margin: 0;
      cursor: pointer;
    }
  }

  /* 칩 형태 리스트 (반복 휴무, 특정일자, 의사) */
  &__chipList {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: row;
    flex-wrap: wrap;
    align-items: flex-start;
    align-content: flex-start;
    gap: 4px;

    &--inline {
      flex: 1;

      .schedulerTreatmentSetting__chip {
        width: auto;
        flex: 0 0 auto;
      }
    }

    /* 담당자 chip — 한 줄당 1개, 너비 가득 (휴무일 탭 팀/신규팀 폼 공용) */
    &--member {
      flex-direction: column;
      flex-wrap: nowrap;

      .schedulerTreatmentSetting__chip {
        width: 100%;
        flex: 0 0 auto;
      }
    }
  }

  &__chip {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    flex: 0 0 auto;
    padding: 4px 8px;
    background: $color-surface-alt;
    border-radius: $radius-2;
    font-size: $font-size-12;
    color: $color-text-default;

    &--draggable {
      cursor: grab;

      &:active {
        cursor: grabbing;
      }
    }

    &.is-dragging {
      opacity: 0.4;
    }

    &.is-drop-target::before {
      content: '';
      position: absolute;
      left: -3px;
      top: 0;
      bottom: 0;
      width: 2px;
      background: #E88B1D;
      border-radius: 1px;
    }
  }

  &__chipRemove {
    width: 16px;
    height: 16px;
    border: 0;
    background: transparent;
    cursor: pointer;
    color: $color-text-muted;
    font-size: $font-size-13;
    padding: 0;
    line-height: 1;

    &:hover { color: $color-text-default; }
  }

  &__check {
    display: inline-flex;
    align-items: center;
    padding-top: 4px;
  }

  /* 체크박스 오른쪽(right) 커스텀 tooltip. 예약설정(__numberInputWrap)과 같은 방식 —
   * 네이티브 title 은 방향 고정이 안 돼 CSS tooltip 으로 대체한다.
   * 위가 아니라 오른쪽에 띄우는 이유: 바로 위 필드와 겹치지 않고, 오른쪽은 빈 공간이라 잘리지 않는다. */
  &__check--tip {
    position: relative;

    &:hover::after {
      content: attr(data-tip);
      position: absolute;
      left: calc(100% + 8px);
      top: 50%;
      transform: translateY(-50%);
      padding: 5px 9px;
      border-radius: $radius-2;
      background: rgba(33, 33, 33, 0.92);
      color: #fff;
      font-size: $font-size-12;
      font-weight: $font-weight-medium;
      line-height: 1.4;
      /* 사이드바가 400px 고정이라 nowrap 이면 말풍선이 잘린다. 말풍선 안에서는 줄바꿈이 자연스럽다.
       * keep-all — 한글을 어절 중간에서 끊지 않는다. */
      width: max-content;
      max-width: 220px;
      white-space: normal;
      word-break: keep-all;
      pointer-events: none;
      z-index: 10;
    }

    /* 말풍선 왼쪽 화살표 */
    &:hover::before {
      content: '';
      position: absolute;
      left: calc(100% + 3px);
      top: 50%;
      transform: translateY(-50%);
      border: 5px solid transparent;
      border-right-color: rgba(33, 33, 33, 0.92);
      pointer-events: none;
      z-index: 10;
    }
  }

  &__teamHeader {
    display: flex;
    align-items: center;
    justify-content: space-between;
    cursor: pointer;
    font-size: $font-size-13;
    font-weight: $font-weight-bold;
    color: $color-text-default;

    &--readonly {
      cursor: default;
    }
  }

  /* ---------- 운영시간 탭 — 멤버 리스트 / 운영시간 패널 ---------- */
  &__memberList {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  &__memberItem {
    display: flex;
    flex-direction: column;
  }

  &__memberRow {
    display: block;
    width: 100%;
    padding: 6px 8px;
    border: 0;
    background: $color-surface-alt;
    border-radius: $radius-2;
    text-align: left;
    cursor: pointer;
    font-size: $font-size-12;
    color: $color-text-default;

    &:hover { background: $color-surface-hover; }

    &.is-expanded {
      background: #E88B1D;
      color: #fff;
      font-weight: $font-weight-bold;
    }
  }

  &__hoursPanel {
    padding: 8px;
    border: 1px solid $color-border-light;
    border-radius: $radius-2;
    background: #fff;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  &__hoursWeekdays {
    display: flex;
    gap: 4px;
  }

  &__hoursWeekdayBtn {
    flex: 1;
    height: 22px;
    border: 1px solid $color-border-light;
    border-radius: $radius-2;
    background: #fff;
    cursor: pointer;
    font-size: $font-size-11;
    color: $color-text-default;

    &.is-sunday   { color: $color-danger; }
    &.is-saturday { color: $color-now; }

    &.is-active {
      background: #E88B1D;
      border-color: #E88B1D;
      color: #fff;
      font-weight: $font-weight-bold;
    }

    /* 매주 휴무인 요일 — 운영시간을 정할 수 없다. */
    &:disabled {
      background: $color-surface-alt;
      color: $color-text-muted;
      cursor: not-allowed;
    }

    /* popover 편집 중인 요일 — active 위에 ring 덧붙임 */
    &.is-editing {
      box-shadow: 0 0 0 2px rgba(232, 139, 29, 0.35);
    }

    /* 공휴일 — 요일이 아니므로 요일 7칸과 구분되게 넓이를 더 준다(라벨이 세 글자다). */
    &--holiday {
      flex: 1.6;
    }
  }

  &__hoursTable {
    width: 100%;
    border-collapse: collapse;
    font-size: $font-size-11;
    color: $color-text-default;

    th, td {
      padding: 2px 4px;
      text-align: left;
      font-weight: $font-weight-medium;
      white-space: nowrap;
    }
  }

  &__hoursTableLabel {
    width: 18px;

    &.is-sunday   { color: $color-danger; }
    &.is-saturday { color: $color-now; }
  }

  /* 공휴일 행 — 요일 7행과 성격이 다르므로(요일 축이 아닌 한 세트) 구분선으로 가른다.
     라벨이 세 글자라 요일 라벨의 18px 고정폭을 쓰지 않는다. */
  &__hoursTableHolidayRow {
    border-top: 1px solid $color-border-light;

    > th {
      width: auto;
      color: $color-danger;
    }
  }

  &__hoursValue {
    font-weight: $font-weight-bold;
  }

  /* 담당자 운영시간 7행 인라인 표 — 요일 | 운영시간(입력). 휴게는 열이 아니라 위쪽 안내 줄이다. */
  &__staffHoursTable {
    width: 100%;
    border-collapse: collapse;
    font-size: $font-size-11;
    color: $color-text-default;

    th, td {
      padding: 3px 4px;
      text-align: left;
      font-weight: $font-weight-medium;
      white-space: nowrap;
      vertical-align: middle;
    }

    th:first-child, td:first-child { width: 22px; }
  }

  &__staffHoursHead {
    color: $color-text-muted;
    font-weight: $font-weight-medium;
  }

  /* 담당자 표 아래 — 사업장 휴게시간 안내. 담당자가 편집하는 값이 아니라 따르게 되는 값이다. */
  &__staffBreakRow {
    display: flex;
    gap: 12px;
    padding: 2px 4px 0;
    font-size: $font-size-11;
    color: $color-text-muted;
    white-space: nowrap;
  }

  /* 사업장 한 요일 — 운영시간(왼쪽 한 줄) | 휴게시간1·2(오른쪽 세로 두 줄) */
  &__siteHoursCell {
    white-space: nowrap;
  }

  &__instBreakCell {
    white-space: nowrap;
    color: $color-text-muted;
  }

  &__hoursOff {
    color: $color-text-muted;
  }

  /* ---------- 운영시간 탭 — 사업장 행 ---------- */
  &__institutionRow {
    display: flex;
    align-items: center;
    padding: 0;
    background: $color-bg-segment;
    border-radius: $radius-2;
    font-size: $font-size-13;
    font-weight: $font-weight-bold;
    color: $color-text-default;

    &.is-expanded {
      background: #E88B1D;
      color: #fff;
    }
  }

  &__institutionExpand {
    flex: 1;
    padding: 4px 8px;
    border: 0;
    background: transparent;
    cursor: pointer;
    text-align: left;
    font: inherit;
    color: inherit;
  }

  /* ---------- 운영시간 — 요일 편집 popover ---------- */
  &__weekdayEditor {
    position: fixed;
    z-index: 2000;
    min-width: 320px;
    padding: 10px 12px;
    background: #fff;
    border: 1px solid $color-border-light;
    border-radius: $radius-2;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.12);
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  &__weekdayEditorRow {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: $font-size-12;
    color: $color-text-default;

    &.is-inactive {
      color: $color-text-muted;
    }
  }

  /* 진료 / 휴게시간1 / 휴게시간2 공통 라벨 — "휴게시간1" 이 한 줄에 들어가는 폭. */
  &__weekdayEditorKindLabel {
    flex: 0 0 60px;
    font-weight: $font-weight-medium;
    white-space: nowrap;
  }

  /* 진료(WORK) 행과 휴게(BREAK) 행 사이 구분선 */
  &__weekdayEditorDivider {
    height: 1px;
    margin: 2px 0;
    background: $color-border-light;
  }

  &__timeInput {
    width: 103px;
    height: 24px;
    padding: 0 6px;
    border: 1px solid $color-border-light;
    border-radius: $radius-2;
    font-size: $font-size-12;
    color: $color-text-default;
    background: #fff;

    &:focus {
      outline: none;
      border-color: #E88B1D;
    }

    &:disabled {
      background: $color-surface-alt;
      color: $color-text-muted;
      cursor: not-allowed;
    }

    /* 시작·종료 중 한쪽만 채운 채 넘어가려 했을 때 채워야 할 칸.
     * 예약등록 팝업(.scheduleField[data-invalid])과 같은 값을 쓴다 — 두 화면의 오류 표시가 갈리면 안 된다. */
    &[data-invalid="true"] {
      border-color: #e54848;
      box-shadow: 0 0 0 2px rgba(229, 72, 72, 0.15);
    }
  }

  &__timeDash {
    color: $color-text-muted;
  }

  &__timeClear {
    width: 20px;
    height: 24px;
    margin-left: 4px;
    border: 0;
    padding: 0;
    background: transparent;
    color: $color-text-muted;
    font-size: $font-size-14;
    line-height: 1;
    cursor: pointer;
    vertical-align: middle;

    &:hover {
      color: $color-text-default;
    }

    &:focus {
      outline: none;
      color: #E88B1D;
    }
  }

  &__teamMenu {
    width: 20px;
    height: 20px;
    border: 0;
    background: transparent;
    cursor: pointer;
    color: $color-text-muted;
    padding: 0;
    line-height: 1;
  }

  &__addBtn {
    height: 28px;
    border: 1px dashed $color-border-light;
    background: #fff;
    cursor: pointer;
    font-size: $font-size-14;
    color: $color-text-muted;
    border-radius: $radius-2;

    &:hover {
      color: $color-text-default;
      border-color: $color-border-default;
    }

    &--newTeam {
      margin: 10px 10px 0;
    }
  }

  /* ---------- 팀 편집 폼 ---------- */
  &__section--editing {
    background: #fff;
  }

  &__teamEditHeader {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  &__teamNameInput {
    flex: 1;
    min-width: 0;
    height: 28px;
    padding: 0 8px;
    border: 1px solid $color-border-light;
    border-radius: $radius-2;
    font-size: $font-size-13;
    color: $color-text-default;

    &:focus {
      outline: none;
      border-color: #E88B1D;
    }
  }

  &__memberArea {
    min-height: 36px;
    padding: 8px;
    border: 1px solid $color-border-light;
    border-radius: $radius-2;
    cursor: pointer;

    &:hover {
      background: $color-surface-hover;
    }
  }

  &__memberPlaceholder {
    margin: 0;
    text-align: center;
    font-size: $font-size-12;
    color: $color-text-muted;
  }

  /* ---------- 직원 선택 picker ---------- */
  &__staffPicker {
    position: fixed;
    z-index: 2000;
    min-width: 240px;
    max-width: 320px;
    padding: 10px;
    background: #fff;
    border: 1px solid $color-border-light;
    border-radius: $radius-2;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.12);
  }

  &__staffPickerList {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding-bottom: 10px;
    border-bottom: 1px solid $color-border-light;
  }

  &__staffOption {
    padding: 4px 10px;
    border: 1px solid $color-border-light;
    border-radius: $radius-2;
    background: #fff;
    cursor: pointer;
    font-size: $font-size-12;
    color: $color-text-default;

    &.is-selected {
      background: #E88B1D;
      border-color: #E88B1D;
      color: #fff;
      font-weight: $font-weight-bold;
    }

    &:hover:not(.is-selected):not(.is-disabled) {
      background: $color-surface-hover;
    }

    &.is-disabled,
    &:disabled {
      cursor: not-allowed;
      opacity: 0.45;
      background: $color-surface-alt;
      color: $color-text-muted;
    }
  }

  &__staffPickerActions {
    display: flex;
    justify-content: flex-end;
    gap: 6px;
    padding-top: 8px;
  }

  &__staffPickerCancel,
  &__staffPickerConfirm {
    height: 26px;
    padding: 0 14px;
    border-radius: $radius-2;
    cursor: pointer;
    font-size: $font-size-12;
  }

  &__staffPickerCancel {
    border: 1px solid $color-border-light;
    background: #fff;
    color: $color-text-default;

    &:hover { background: $color-surface-hover; }
  }

  &__staffPickerConfirm {
    border: 1px solid #E88B1D;
    background: #E88B1D;
    color: #fff;
    font-weight: $font-weight-bold;

    &:hover { filter: brightness(0.95); }
  }

  /* ---------- 팀 인라인 이름 변경 ---------- */
  &__teamRenameInput {
    flex: 1;
    min-width: 0;
    height: 24px;
    padding: 0 6px;
    border: 1px solid #E88B1D;
    border-radius: $radius-2;
    font-size: $font-size-13;
    font-weight: $font-weight-bold;
    color: $color-text-default;
    background: #fff;

    &:focus {
      outline: none;
    }
  }

  /* ---------- 팀 "..." 컨텍스트 메뉴 ---------- */
  &__teamMenuDropdown {
    position: fixed;
    z-index: 2000;
    min-width: 110px;
    padding: 4px 0;
    background: #fff;
    border: 1px solid $color-border-light;
    border-radius: $radius-2;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.12);
    display: flex;
    flex-direction: column;
  }

  &__teamMenuItem {
    display: block;
    width: 100%;
    padding: 6px 12px;
    border: 0;
    background: transparent;
    cursor: pointer;
    font-size: $font-size-12;
    color: $color-text-default;
    text-align: left;
    white-space: nowrap;

    & + & {
      border-top: 1px solid $color-border-light;
    }

    &:hover {
      background: $color-surface-hover;
    }
  }

  /* ---------- 팀 삭제 확인 다이얼로그 ---------- */
  &__deleteOverlay {
    position: fixed;
    inset: 0;
    z-index: 2100;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.3);
  }

  &__deletePanel {
    min-width: 280px;
    padding: 24px 20px 16px;
    background: #fff;
    border-radius: $radius-2;
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.18);
  }

  /* ----- 미지정 데이터 적용 modal ----- */
  &__unassignedPanel {
    min-width: 360px;
    max-width: 440px;
    max-height: calc(100vh - 64px);
    padding: 16px 18px 14px;
    background: #fff;
    border-radius: $radius-2;
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.18);
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  &__unassignedHeader {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  &__unassignedTitle {
    font-size: $font-size-14;
    font-weight: $font-weight-bold;
    color: $color-text-default;
  }

  &__unassignedClose {
    width: 22px;
    height: 22px;
    border: 0;
    background: transparent;
    cursor: pointer;
    font-size: 18px;
    line-height: 1;
    color: $color-text-muted;
    padding: 0;

    &:hover { color: $color-text-default; }
  }

  &__unassignedDesc {
    margin: 0;
    font-size: $font-size-12;
    color: $color-text-muted;
  }

  &__unassignedOptions {
    display: flex;
    flex-wrap: wrap;
    gap: 16px;
    padding: 4px 0;
    /* 담당자 多(예: 100명) 시 모달 무한 확장 방지 — 리스트만 스크롤 */
    max-height: 260px;
    overflow-y: auto;
  }

  &__unassignedOption {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
    font-size: $font-size-13;
    color: $color-text-default;

    input[type="radio"] {
      appearance: none;
      -webkit-appearance: none;
      width: 16px;
      height: 16px;
      margin: 0;
      border: 1px solid $color-border-light;
      border-radius: 50%;
      background: #fff;
      cursor: pointer;

      /* 선택 시: 테두리 오렌지 + 중앙 흰색 */
      &:checked {
        border: 2px solid #E88B1D;
        background: #fff;
      }
    }
  }

  &__unassignedEmpty {
    margin: 0;
    font-size: $font-size-12;
    color: $color-text-muted;
  }

  &__unassignedLaterBtn {
    height: 28px;
    padding: 0 18px;
    border-radius: $radius-2;
    border: 1px solid #000;
    background: #fff;
    color: #000;
    cursor: pointer;
    font-size: $font-size-12;

    &:hover { background: rgba(0, 0, 0, 0.05); }
  }

  &__deleteMessage {
    margin: 0;
    text-align: center;
    font-size: $font-size-13;
    font-weight: $font-weight-bold;
    color: $color-text-default;
  }

  &__deleteSubMessage {
    margin: 4px 0 0;
    text-align: center;
    font-size: $font-size-12;
    color: $color-text-muted;
  }

  &__deleteActions {
    display: flex;
    justify-content: center;
    gap: 8px;
    margin-top: 16px;
  }

  &__deleteCancelBtn,
  &__deleteConfirmBtn {
    height: 28px;
    padding: 0 18px;
    border-radius: $radius-2;
    cursor: pointer;
    font-size: $font-size-12;
  }

  &__deleteCancelBtn {
    border: 1px solid #E88B1D;
    background: #fff;
    color: #E88B1D;

    &:hover { background: rgba(232, 139, 29, 0.08); }
  }

  &__deleteConfirmBtn {
    border: 1px solid #E88B1D;
    background: #E88B1D;
    color: #fff;
    font-weight: $font-weight-bold;

    &:hover { filter: brightness(0.95); }
  }

  /* ---------- Main ---------- */
  &__main {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
  }

  &__yearNav {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 12px;
    padding: 12px 0;
  }

  &__arrow {
    width: 22px;
    height: 22px;
    border: 0;
    background: transparent;
    cursor: pointer;
    padding: 0;
    font-size: 0;
    color: transparent;

    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%239e9e9e' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='15 18 9 12 15 6'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: center;
    background-size: 22px 22px;

    &--next {
      transform: rotate(180deg);
    }

    &:hover {
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='15 18 9 12 15 6'/%3E%3C/svg%3E");
    }
  }

  &__yearLabel {
    font-size: $font-size-16;
    font-weight: $font-weight-bold;
    color: $color-text-default;
    min-width: 72px;
    text-align: center;
  }

  &__yearGrid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    grid-template-rows: repeat(3, 1fr);
    gap: 16px;
    padding: 16px 20px;
    background: $color-border-light;
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }

  &__miniMonth {
    display: flex;
    flex-direction: column;
    min-height: 0;
    padding: 8px 10px 10px;
    border: 1px solid $color-border-light;
    border-radius: $radius-2;
    background: #fff;
  }

  &__miniMonthLabel {
    text-align: center;
    padding: 4px 0 8px;
    font-size: $font-size-13;
    font-weight: $font-weight-bold;
    color: $color-text-default;
    flex: 0 0 auto;
  }

  &__miniMonthGrid {
    display: grid;
    grid-template-columns: repeat(7, 1fr);
    grid-auto-rows: 1fr;
    flex: 1;
    min-height: 0;
    padding: 0;
    gap: 4px 2px;
  }

  &__miniDay {
    display: flex;
    align-items: center;
    justify-content: center;
    min-width: 0;
    min-height: 0;
    font-size: $font-size-11;
    line-height: 1;
    color: $color-text-default;
    cursor: pointer;
    user-select: none;

    &.is-sunday   { color: $color-danger; }
    &.is-saturday { color: $color-now; }
    &.is-holiday  { color: $color-danger; }
    &.is-other    { color: transparent; cursor: default; }

    &.is-drag-selecting .schedulerTreatmentSetting__miniDayNum {
      background-color: rgba(232, 139, 29, 0.45);
      color: #fff;
    }
  }

  &__miniDayNum {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    aspect-ratio: 1 / 1;
    height: 80%;
    max-height: 20px;
    min-width: 1.8em;
    border-radius: 50%;

    .schedulerTreatmentSetting__miniDay.is-off & {
      background-color: rgba(232, 139, 29, 0.18);
    }
  }

  /* ---------- Month View (운영시간) ---------- */
  &__monthView {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    padding: 0 16px 16px;
  }

  &__monthHeader {
    display: grid;
    grid-template-columns: repeat(7, 1fr);
    border-bottom: 1px solid $color-border-light;
  }

  &__monthHeaderCell {
    padding: 8px 0;
    text-align: center;
    font-size: $font-size-13;
    font-weight: $font-weight-bold;
    color: $color-text-default;

    &.is-sunday   { color: $color-danger; }
    &.is-saturday { color: $color-now; }
  }

  &__monthGrid {
    display: grid;
    grid-template-columns: repeat(7, 1fr);
    grid-auto-rows: 1fr;
    flex: 1;
    min-height: 0;
    border-left: 1px solid $color-border-light;
    border-top: 1px solid $color-border-light;
  }

  &__monthCell {
    padding: 6px 8px;
    border-right: 1px solid $color-border-light;
    border-bottom: 1px solid $color-border-light;
    background: #fff;
    overflow: hidden;

    &.is-other {
      background: $color-surface-alt;
    }

    &.is-off {
      background: #f5f5f5;
    }
  }

  &__monthCellHeader {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 4px;
  }

  &__monthCellDate {
    font-size: $font-size-13;
    font-weight: $font-weight-medium;
    color: $color-text-default;

    .is-sunday & {
      color: $color-danger;
    }

    .is-saturday & {
      color: $color-now;
    }

    .is-other & {
      color: $color-text-muted;
    }
  }

  &__offLabel {
    font-size: $font-size-12;
    font-weight: $font-weight-bold;
    color: $color-danger;
  }

  &__monthCellBody {
    font-size: $font-size-12;
    color: $color-text-default;
    line-height: 1.4;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* ---------- INSTITUTION 모드 셀 entries / 더보기 ---------- */
  &__monthCellEntries {
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-height: 0;
    overflow: hidden;
  }

  &__monthCellEntry {
    display: block;
    width: 100%;
    margin: 0;
    padding: 0;
    border: 0;
    background: transparent;
    text-align: left;
    cursor: pointer;
    font-size: $font-size-12;
    color: $color-text-default;
    line-height: 1.4;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;

    &:hover { color: #E88B1D; }

    &.is-off {
      color: $color-text-muted;
    }

    &.is-editing {
      color: #E88B1D;
      font-weight: $font-weight-bold;
    }
  }

  &__monthCellMore {
    align-self: flex-start;
    margin-top: 2px;
    padding: 0;
    border: 0;
    background: transparent;
    cursor: pointer;
    font-size: $font-size-12;
    color: $color-now;
    text-decoration: underline;
    line-height: 1.4;

    &:hover { color: darken(#256AF5, 10%); }
  }

  /* ---------- Footer ---------- */
  &__loadError {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 12px;
    padding: 8px 12px;
    background: #FDECEA;
    color: #B3261E;
    font-size: $font-size-13;
  }

  &__loadErrorRetry {
    height: 26px;
    padding: 0 12px;
    border: 1px solid #B3261E;
    border-radius: $radius-2;
    background: #fff;
    color: #B3261E;
    cursor: pointer;
    font-weight: $font-weight-medium;

    &:hover { background: #FBD9D5; }
  }

  &__footer {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 12px;
    border-top: 1px solid $color-border-light;
    background: #fff;
  }

  &__cancelBtn,
  &__saveBtn {
    height: 32px;
    padding: 0 24px;
    border-radius: $radius-2;
    cursor: pointer;
    font-size: $font-size-13;
    font-weight: $font-weight-medium;
  }

  &__cancelBtn {
    border: 1px solid $color-border-light;
    background: #fff;
    color: $color-text-default;

    &:hover { background: $color-surface-hover; }
  }

  &__saveBtn {
    border: 1px solid #E88B1D;
    background: #E88B1D;
    color: #fff;
    font-weight: $font-weight-bold;

    &:hover { filter: brightness(0.95); }

    &:disabled {
      cursor: not-allowed;
      opacity: 0.6;

      &:hover { filter: none; }
    }
  }
}
</style>
