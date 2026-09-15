<script setup>
import {computed, nextTick, onBeforeUnmount, onMounted, ref, watch} from 'vue';
import {storeToRefs} from 'pinia';
import dayjs from 'dayjs';
import {cloneDeep, isEqual} from 'lodash-es';
import {push} from 'notivue';
import {useDialog} from '@/lib/useDialog';
import {useStaffStore} from '@/stores/staffStore';
import {useHolidayStore} from '@/stores/holidayStore';
import {getSiteWorkHours, getStaffWorkHours, getTeams, saveTreatmentSettings} from '@/api/siteApi';
import {getUnassignedReservations} from '@/api/bookApi';
import {isInvalidTimeText, isReversedTimeRange, maskTimeTyping, normalizeTimeInput} from '@/utils/timeInputUtils';
import {clampOverlayPos, clampPopoverPos, settlePopoverPos} from '@/utils/popoverPlacementUtils';
import UiSegmentedControl from '@/components/ui/UiSegmentedControl.vue';
import UnassignedDataModal from '@/components/popup/UnassignedDataModal.vue';
import CellMorePopover from './CellMorePopover.vue';
import SchedulerSettingsOffDayControls from './SchedulerSettingsOffDayControls.vue';
import {monthlyOptionValue, recurringChipLabel, WEEKDAY_LABELS} from '../offDayOptions';
import {inheritedInstitutionOffOn, isEveryWeekOff, isInstitutionRecurringOff, isStaffOffOn} from '../offDayRules';
import {useDialogGuard} from '@/composables/useDialogGuard';
import {DEFAULT_OPERATING_END, DEFAULT_OPERATING_START} from '@/constants/operatingHours';

const staffStore = useStaffStore();
const {doctors} = storeToRefs(staffStore);
const holidayStore = useHolidayStore();
const dialog = useDialog();

/* 조회(baseline) 실패 시 안내 문구 — bookStore 의 일시적 장애 안내와 동일 문구를 재사용한다.
 * 저장 게이트: baseline 을 못 읽은 채 전체 치환 저장하면 그 원천 데이터가 통삭제된다(#2).
 *
 * ★게이트는 **원천별**이다 — 한쪽 장애가 다른 쪽 저장까지 막지 않는다.
 *  BE 계약(POST settings/save) — 필드 미전송(null) = 그 파트를 아예 손대지 않음:
 *   teams 미전송 → 자체 파트 통째 skip / workingHours 미전송 → 담당자 운영시간·오버라이드 미변경 / site 미전송 → 사업장 설정 파트 통째 skip.
 *  - teamLoadFailed : getTeams(팀, 자체 DB)          → 실패 시 teams=[] 로 저장하면 팀·구성원 전멸
 *  - staffLoadFailed : getStaffWorkHours(담당자 운영시간)   → 자체 TB
 *  - siteLoadFailed : getSiteWorkHours(사업장 + 휴무규칙) → 원천 외부 시스템
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

/* 요일 라벨·반복 옵션은 휴무 컨트롤(SchedulerSettingsOffDayControls)과 공유한다 → offDayOptions.ts */

/* 팀 구성원으로 배정할 수 없는 담당자명. BE 가 사업장 설정 경유 예약의 담당의로 고정 사용하는 자리표시자다
 * (McsBookSyncService.resolveDoctorName · McsReservationBackfillService 의 선등록). */
const UNASSIGNABLE_DOCTOR_NAME = '미지정';

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
 * - WORK: 운영 블록. 시작~종료 단일 구간 하나뿐이다(오전/오후/야간 3세션은 폐기).
 *   사업장·담당자 모두 요일별로 편집한다.
 * - BREAK: 휴게시간1·2. **사업장만 소유한다.** 담당자 화면에서는 기관 값을 읽기 전용으로 보여줄 뿐이고,
 *   보드에서도 담당자 컬럼에 기관 휴게가 그대로 그려진다.
 * 코드 심볼(LUNCH/DINNER)과 API 필드(lunchStartHm·dinnerStartHm)는 그대로 두고 화면 표기만 휴게시간1/2 다. */
const WORK_BLOCK_KINDS = ['WORK'];
const BREAK_BLOCK_KINDS = ['LUNCH', 'DINNER'];
const BLOCK_KIND_LABEL = {
  WORK  : '운영시간',
  LUNCH : '휴게시간1',
  DINNER: '휴게시간2',
};

/* 캘린더 셀의 직원 entry 최대 표시 개수 — 초과 시 "더보기" popover */
const CELL_ENTRY_VISIBLE_MAX = 3;

/* 사업장 운영시간(요일별) — 원천은 사업장 설정.
 *  - WORK: Map<weekday, Block[]>. 운영 블록(WORK) 하나뿐이다.
 *  - BREAK: Map<weekday, {LUNCH:{start,end}|null, DINNER:{start,end}|null}>.
 *    ⚠️ 휴게를 WORK 의 Block[] 에 섞지 않는다 — 표시·집계·전송 코드가 WORK 를 운영시간으로만 보므로
 *       섞으면 운영 구간 자리에 휴게가 끼어든다. */
const institutionWeeklyDayMap = ref(new Map());
const institutionBreaksByWeekday = ref(new Map());

/* 사업장 공휴일 운영시간 — 원천은 사업장 설정 공휴일 운영시간 테이블.
 * 요일 축이 없어 사업장당 한 세트뿐인데, 요일 편집 popover 를 그대로 쓰려고
 * 한 칸(HOLIDAY_SLOT)짜리 Map 으로 담는다.
 * ⚠️ institutionWeeklyDayMap 에 특수 키로 섞지 않는다 — 그 Map 을 요일로 순회하는 곳
 *   (getStaffWorkBlock · buildInstitutionTimesPayload)에
 *   공휴일이 요일 행으로 새어 나가 담당자 기본값이나 site[] 에 엉뚱한 dayCd 로 실린다.
 * 공휴일에 쉬는지 여부는 여기가 아니라 includePublicHolidays(=holidayClosedYn) 가 갖는다 —
 * 휴무로 바꿔도 시간 값은 지우지 않고 보존한다(다시 운영으로 되돌렸을 때 살아 있어야 한다). */
const HOLIDAY_OWNER = 'INSTITUTION_HOLIDAY';
const HOLIDAY_SLOT = 0;
const institutionHolidayDayMap = ref(new Map());
const institutionHolidayBreaks = ref(new Map());

/* 사업장 **일자별** 운영시간 — Map<'YYYY-MM-DD', Block[]>. 임시운영으로 지정한 날짜에 실제로 저장된 시각이다.
 * ⚠️ 조회 전용이다(응답 dateTimes). 자체 에 일자별 시간 편집 UI 가 없어 저장 payload 에도 없고,
 *   그래서 dirty 판정(SITE_STATE_KEYS)에도 넣지 않는다.
 * 이 값을 안 보면 보드·타임라인은 그 날짜에 저장된 시각으로 열리는데 이 화면만 요일 시각을 그려
 * 같은 날 같은 담당자의 시간이 화면마다 갈린다(임시운영 지정 후 요일 운영시간을 바꾼 경우 등). */
const institutionDateDayMap = ref(new Map());

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

/* 그 담당자의 **그 요일**이 미설정인가 — 미설정이면 사업장의 그 요일 운영시간을 기본값으로 쓴다.
 *
 * ★판정 단위는 요일이다(담당자가 아니다). 월요일만 정한 담당자의 화~일은 여전히 미설정이므로
 *  기관 값을 따른다. 예전에는 "요일을 하나라도 정했으면 그 담당자 전체가 상속 대상에서 빠지는"
 *  담당자 단위 판정이라, 월요일 1건 때문에 나머지 6일이 빈칸(=휴무)으로 보였다.
 *  보드(staffStore.loadWorkHours → doctorRules)와 월 캘린더(formatListEntries)는 처음부터
 *  요일 단위였다 — 이 표만 어긋나 있었다.
 *
 * 세 상태는 요일마다 따로 선다(BE SiteService.getStaffWorkHours 규약과 같다):
 *   entry 없음 = 미설정(기관 값 상속) / entry = [] = 휴무 / entry = [block] = 운영. */
function usesInstitutionDefault(staffId, weekday) {
  return !workingHoursByOwner.value.get(`STAFF:${staffId}`)?.has(weekday);
}

/* 화면에 보이는 그 시각이 **담당자 자기 값이 아니라 사업장에서 빌려온 값**인가.
 * 표기를 갈라 주지 않으면 두 상태가 똑같이 생겨서, DB 를 열어 본 사람은 "담당자 운영시간이
 * 사라졌다"고 읽는다 — 실제로는 애초에 저장된 적이 없고 기관 값을 참조해 그리던 것이다.
 * 같은 이유로 사업장 운영시간을 지우면 이 사람들의 표기가 함께 사라진다(상속의 정상 동작이지
 * 데이터 삭제가 아니다 — 자기 값을 가진 담당자의 행은 그대로 남는다).
 *
 * ★빌린 값을 담당자 행으로 확정 저장하지는 않는다. 사업장 운영시간의 원천은 외부 시스템
 *  (사업장 운영시간 테이블)고 담당자는 자체 테이블(담당자 운영시간 테이블)이라, 복사하면
 *  사업장 설정 값이 자체 에 굳어 이후 기관 운영시간을 바꿔도 따라오지 않는다(dayMapToTimes 주석). */
function showsInheritedStaffTime(staffId, weekday) {
  return usesInstitutionDefault(staffId, weekday)
      && getStaffWeekdayBlocks(`STAFF:${staffId}`, weekday).length > 0;
}

/* 그 담당자·요일에 실제로 표시할 운영 블록들. 미설정 요일이면 사업장의 그 요일 블록이다.
 * 채워 넣지 않고 읽는 시점에 참조하므로, 기관 값을 방금 화면에서 고쳤어도 즉시 따라온다.
 *
 * ★상속 판정을 하는 곳은 여기 하나여야 한다 — 담당자 7행 표 · 월 캘린더 라벨 · 일자 지정 popover 가
 *  같은 값을 보여야 한다. (예전에는 popover 만 raw dayMap 을 읽어, 셀에 기관 시간이 찍혀 있는데
 *  클릭하면 입력칸이 비어 있었다.) */
function getStaffWeekdayBlocks(ownerKey, weekday) {
  const dayMap = workingHoursByOwner.value.get(ownerKey);
  if (dayMap?.has(weekday)) return dayMap.get(weekday);
  const institution = institutionWeeklyDayMap.value.get(weekday) ?? [];
  return institution.length > 0 ? institution : defaultWorkBlocks();
}

/* 담당자도 사업장도 그 요일을 정하지 않았을 때 화면이 보여줄 운영시간 —
 * 예약장부 보드·타임라인이 그 칸을 실제로 여는 값과 같다(SSOT = constants/operatingHours).
 *
 * 사업장이 매주 쉬는 요일에는 기관 운영시간 행 자체가 없다. 그래서 **기관 휴무를 상속하지 않는**
 * 담당자(휴무일 탭에서 자기 휴무를 정한 사람)의 칸이 통째로 비어, 화면에는 아무것도 없는데
 * 보드에서는 09:00~18:00 로 예약을 받는 상태가 됐다.
 *
 * ★기관 조회에 실패했거나 아직 받아오기 전에는 쓰지 않는다 — 그건 "정한 것이 없다"가 아니라
 *  "모른다"이고, 모르는 것을 기본값으로 그리면 화면이 없는 사실을 지어낸다
 *  (조회 실패는 배너와 저장 차단이 따로 알린다). */
function defaultWorkBlocks() {
  if (!settingsLoaded.value || siteLoadFailed.value) return [];
  return [{kind: 'WORK', start: DEFAULT_OPERATING_START, end: DEFAULT_OPERATING_END}];
}

function getStaffWorkBlock(staffId, weekday) {
  return getStaffWeekdayBlocks(`STAFF:${staffId}`, weekday).find(b => b.kind === 'WORK');
}

/* 그 담당자·요일의 운영 시작/종료("HH:MM") */
function fetchStaffWorkHours(staffId, weekday, field) {
  return getStaffWorkBlock(staffId, weekday)?.[field] ?? '';
}

/* ★시작·종료를 모두 비우면 그 요일은 **미설정**으로 되돌아간다(entry 를 지운다) — 휴무가 아니다.
 * 휴무는 휴무일 탭이 정한다(탭 책임 분리). 운영시간 탭이 휴무까지 만들면 같은 상태를 두 화면이
 * 만들게 되고, 휴무일 탭이 잠가 둔 요일을 운영시간 탭이 다시 여는 모순이 생긴다.
 * 미설정으로 두면 그 요일은 다시 사업장 값을 따라간다.
 * 한쪽만 입력된 중간 상태는 그대로 두되, 저장 payload 에서 짝이 안 맞으면 그 행은 나가지 않는다.
 *
 * ★고치는 요일만 확정한다 — 다른 요일은 미설정으로 남겨 기관 값을 계속 따르게 한다.
 *  (예전에는 첫 편집 때 기관 값 전 요일을 한꺼번에 확정시켜, 월요일만 고쳐도 나머지 6일이
 *   그 시점의 기관 값으로 굳었다. 그러면 이후 기관 운영시간이 바뀌어도 따라오지 않는다.) */
function setStaffWorkHours(staffId, weekday, field, value) {
  const ownerKey = `STAFF:${staffId}`;
  const next = new Map(workingHoursByOwner.value);
  const dayMap = new Map(next.get(ownerKey));

  /* 미설정 요일을 고치기 시작했다면 화면에 보이던 값은 사업장 값이다 —
   * 그것을 기준으로 삼아야 한쪽 칸만 고쳤을 때 나머지 칸이 빈칸으로 날아가지 않는다. */
  const cur = getStaffWorkBlock(staffId, weekday) ?? {kind: 'WORK', start: '', end: ''};
  const block = {...cur, [field]: value || ''};

  if (!block.start && !block.end) dayMap.delete(weekday);
  else dayMap.set(weekday, [block]);

  next.set(ownerKey, dayMap);
  workingHoursByOwner.value = next;
}

function onStaffTimeInput(event, staffId, weekday, field) {
  commitTimeInput(event, v => setStaffWorkHours(staffId, weekday, field, v));
}

/* ※ 그 요일을 "휴무로 만드는" × 버튼은 제거됐다(탭 책임 분리).
 *   담당자 매주 휴무는 휴무일 탭에서 정한다. 시간을 비우면 미설정으로 돌아갈 뿐이다. */

/* 담당자 표의 휴게시간 열 — 사업장의 그 요일 휴게를 읽기 전용으로 보여준다.
 * 휴게는 사업장만 소유하고 담당자에게는 "따르게 되는 값"이라 입력칸을 두지 않는다.
 *
 * 요일축이 이미 있는 표라 요일마다 실값을 그대로 싣는다 — 예전의 한 줄 요약은 요일마다 값이
 * 다르면 '요일별 상이'로만 알려 줘, 실제 값을 보려면 사업장 패널을 따로 펼쳐 대조해야 했다.
 * 그 요일에 운영 자체가 없으면(휴무) 휴게도 의미가 없어 '-' 로 둔다. */
function staffBreakText(staffId, weekday, kind) {
  if (!getStaffWorkBlock(staffId, weekday)) return '-';
  const range = getInstitutionBreaks(weekday)[kind];
  return range ? `${range.start}~${range.end}` : '-';
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

/* ===== 운영시간 서버 응답 변환 =====
 * 백엔드 "HHmm" → 내부 "HH:MM" (화면 시간 입력칸 표기) */
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
function isWeekdayClosed(weekday, ownerKey = 'INSTITUTION') {
  /* '매주'와 '매월 1~5번째 전부'는 같은 결과라 같게 본다(isEveryWeekOff) — 표기·잠금·저장 제외가 함께 간다. */
  const institutionOff = isEveryWeekOff(weekdayOffs.value.get(weekday));
  if (ownerKey === 'INSTITUTION') return institutionOff;

  /* 담당자의 매월 1~5번째 전부도 매주다 — 매주 자체는 entry = [] 로 표현되지만 다섯 개는 매월 표에 남는다. */
  if (isEveryWeekOff(staffMonthlyOffs.value.get(ownerKey)?.get(weekday))) return true;

  /* ★담당자 설정이 사업장 휴무보다 우선한다(R11) — 사업장이 쉬는 요일이라도 그 담당자가
   * 운영시간을 정해 뒀으면 잠그지 않는다. 보드(useSchedulerRules)·휴무일 탭 뷰어와 같은 규칙이다.
   * 휴무일 탭이 만든 상태를 그대로 읽는다: entry = [] 휴무 / entry = [block] 운영 / entry 없음 = 미설정.
   * 미설정일 때만 사업장을 상속한다. 운영시간 탭은 잠그기만 하고 값은 지우지 않는다. */
  const entry = getOwnerDayMap(ownerKey)?.get(weekday);
  if (entry !== undefined) return entry.length === 0;

  /* 미설정 요일 — 상속은 항목이 아니라 **축 단위**다(offDayRules 의 inheritedInstitutionOffOn).
   * 휴무일 탭에서 자기 반복 휴무를 하나라도 정한 담당자는 사업장 요일 규칙을 더는 따라가지 않는다.
   * 월 캘린더(isDisplayedOffFor)·휴무일 탭 컨트롤(isInheritedOffWeekday)·보드(staffStore 의
   * inheritsHospitalWeekdayOff)가 이미 축 단위인데 여기만 요일 단위로 상속하고 있었다 —
   * 목요일만 쉬기로 한 담당자가 이 표에서는 사업장 휴무요일(일·금)까지 '휴무'으로 잠겼다. */
  return hasOwnRecurringOff(ownerKey) ? false : institutionOff;
}

/* times[](저장된 요일 행만) → Map<dayCd, Block[]>.
 * ★행이 있다는 것 자체가 "그 요일을 정했다"는 뜻이므로 빈 blocks 도 entry 로 남긴다 —
 * 버리면 명시적 휴무가 미설정으로 강등돼, 다시 저장할 때 사업장 값이 도로 채워진다.
 * setStaffWorkHours / clearStaffWorkHours 이 쓰는 표현과 같다:
 *   entry 없음 = 미설정 / entry = [] = 휴무 / entry = [block] = 운영.
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
 *  실값으로 존재하므로 추정할 이유가 없다.)
 *
 * ★미설정이면 '휴무'이 아니라 휴게시간과 같은 '-' 다. 저장하면 그 요일은 '매주 휴무'이 되지만
 *  (missingTimeWeekdays) **아직은 아니다** — 지금 '휴무'이라 적으면 휴무일 탭이 정한 요일과
 *  구별되지 않고, 그 사이 보드는 기본 운영시간으로 예약을 받고 있어 표기가 동작보다 앞선다.
 *  무엇이 저장될지는 배너가 말하고, 진짜 휴무는 isWeekdayClosed 가 가른다. */
function formatSiteHours(weekday) {
  const block = (institutionWeeklyDayMap.value.get(weekday) ?? []).find(b => b.kind === 'WORK');
  return block ? `${block.start}~${block.end}` : '-';
}

/* 사업장 패널 — 그 요일의 휴게시간1/2. 미설정이면 '-' */
function formatInstitutionBreak(weekday, kind) {
  const range = getInstitutionBreaks(weekday)[kind];
  return range ? `${range.start}~${range.end}` : '-';
}

/* 그 요일에 사업장 운영시간이 **온전히** 정해져 있는가 — 공휴일의 hasSiteHolidayHoursRange
 * 와 같은 판정이다. 휴게시간만 있거나 반쪽만 채운 상태는 정해진 것으로 보지 않는다
 * (반쪽은 미완성 게이트가 따로 잡는다 — 여기서 통과시키면 두 게이트 사이로 빠져나간다). */
function hasInstitutionWorkRange(weekday) {
  return (institutionWeeklyDayMap.value.get(weekday) ?? [])
      .some(b => b.kind === 'WORK' && b.start && b.end);
}

/* 그 요일의 사업장 운영시간에 **입력한 것이 하나라도** 있는가 — 시작·종료 중 한쪽만 채웠어도 참.
 * '매주 휴무' 예고(missingTimeWeekdays)는 이것이 거짓인 요일, 즉 **둘 다 비어 있는** 요일만 대상으로 한다.
 * 반쪽만 채운 요일은 채우다 만 것이지 쉬기로 한 것이 아니고, 그 상태는 미완성 게이트(findIncompleteOwner)가
 * 저장 전에 먼저 막는다 — 여기서 휴무로 예고하면 같은 칸을 두 안내가 다르게 말한다. */
function hasInstitutionWorkValue(weekday) {
  return (institutionWeeklyDayMap.value.get(weekday) ?? [])
      .some(b => b.kind === 'WORK' && (b.start || b.end));
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

/* 사업장 반복 휴무 — Map<weekday, Set<'WEEKLY' | 'MONTHLY_n'>>. 매주·매월을 한 자리에 담는다.
 * (요일 드롭다운의 열림 상태는 컨트롤 컴포넌트가 갖는다 — 한 번에 한 패널만 떠 있다.) */
const weekdayOffs = ref(new Map());
const dateOverrides = ref(new Map());

/* 담당자 "매월 N번째 O요일" 휴무 — Map<ownerKey, Map<weekday, Set<'MONTHLY_n'>>>.
 * ★담당자의 **매주** 휴무는 여기 없다 — 운영시간 표(workingHoursByOwner) 의 `entry = []` 그 자체다.
 *  같은 상태를 두 자리에 두면 운영시간 탭과 휴무일 탭이 서로를 덮어쓴다(계획서 R1). */
const staffMonthlyOffs = ref(new Map());

/* 담당자 공휴일 운영 여부 — Map<ownerKey, 'Y' | 'N'>. NOT NULL 2상태라 서버가 전원 값을 내려준다.
 * 상속은 팀 배치 시점 복사(applyInheritedSettings)로 해결한다 — 키 부재는 조회 전 과도 상태뿐. */
const staffHolidayOff = ref(new Map());

const teams = ref([]);

/* 휴무일 탭: 지금 보고 있는 대상 ('INSTITUTION' | 'STAFF:<staffId>') — 한 번에 하나만.
 * 팀은 선택 단위가 아니다. 휴무는 사업장과 담당자에만 붙고 팀에는 붙지 않는다.
 * 운영시간 탭의 expandedTreatmentKey 와 키를 공유하지 않는다 — 그쪽은 팀도 선택 단위라 뜻이 다르다. */
const OFF_OWNER_INSTITUTION = 'INSTITUTION';
const selectedOffOwner = ref(OFF_OWNER_INSTITUTION);

function staffOffOwnerKey(doctorId) {
  return `STAFF:${doctorId}`;
}

function selectOffOwner(key) {
  selectedOffOwner.value = key;
}

/* 선택된 대상 **하나만** 컨트롤을 펼친다 — 두 패널이 동시에 떠 있으면 어느 쪽이 우측 캘린더에
 * 반영되는지 알 수 없다. 자리는 둘(사업장 헤더 아래 / 그 담당자가 속한 팀의 칩 리스트 아래)이고
 * 넘기는 값은 하나라, 같은 props 를 v-bind 로 그대로 준다. */
const offControlsProps = computed(() => {
  const ownerKey = selectedOffOwner.value;
  return {
    ownerKey,
    optionsByWeekday: offOptionsMapFor(ownerKey),
    inheritedWeekdays: inheritedWeekdaysFor(ownerKey),
    chips           : recurringChipsFor(ownerKey),
    dateGroups      : specificDatesByType.value,
    holidayOff      : holidayOffFor(ownerKey),
    showHoliday     : settingsLoaded.value,
    holidayTip      : ownerKey === OFF_OWNER_INSTITUTION
        ? '공휴일은 현재 연도부터 최대 3년까지 표기됩니다.'
        : '체크하면 이 담당자는 공휴일에 휴무합니다.',
  };
});

/* 선택된 담당자가 이 팀에 있는가 — 컨트롤을 그 팀 칩 리스트 아래에 붙인다(§4-5-3). */
function isOffOwnerInTeam(team) {
  return (team.doctorIds ?? []).some(docId => staffOffOwnerKey(docId) === selectedOffOwner.value);
}

function onOffOptionToggle(weekday, option) {
  toggleOptionFor(selectedOffOwner.value, weekday, option);
}

function onOffHolidayChange(value) {
  setHolidayOffFor(selectedOffOwner.value, value);
}

/* 운영시간 탭: 현재 펼쳐진 항목 키 ('staff:<staffId>' | 'institution' | null) — 한 번에 하나만 */
const expandedTreatmentKey = ref(null);

function toggleTreatmentExpansion(key) {
  expandedTreatmentKey.value = expandedTreatmentKey.value === key ? null : key;
}

/* ===== popover 위치 =====
 * 규칙 본체는 @/utils/popoverPlacementUtils 로 옮겼다 — 운영일정 보기 탭의 더보기와
 * 스케줄러 카드 ⋮ 메뉴가 같은 규칙을 쓴다. */
/* 측정 전 임시 계산용 — CSS min-width 와 같은 값이다(실폭은 렌더 후 다시 잰다). */
const POPOVER_FALLBACK_WIDTH = 320;
const POPOVER_FALLBACK_HEIGHT = 120;

const weekdayEditorEl = ref(null);
const cellStaffEditorEl = ref(null);

/* ===== 요일 편집 popover =====
 * 사업장 요일 버튼과 담당자 일자별 지정(월 캘린더)에서 쓴다.
 * 담당자 주간 운영시간은 popover 를 쓰지 않는다 — 7행 인라인 표에서 바로 편집한다.
 * draft 구조:
 *   WORK  { WORK: {active, start, end} } — 비활성 블록도 시간 보존
 *   BREAK { [LUNCH|DINNER]: {start, end} } — 사업장에서만. 토글 없이 시간 존재 여부로 활성 판단
 *
 * ★시간 popover(요일 편집 · 일자 지정 · 셀 더보기)는 한 번에 하나만 뜬다 — 여는 쪽이 먼저
 *  settleTimePopovers 로 나머지를 닫는다. 두 개가 겹치면 어느 입력이 어디로 가는지 알 수 없다.
 * ★popover 는 닫을 때 검증하지 않는다. 외부 클릭이면 입력을 **그대로 상태에 보존**하고 닫는다
 *  (담당자 7행 인라인 표와 같은 규약). 미완성·형식·순서는 저장 버튼에서 한 번만 본다(onSave).
 *  예전에는 commit 이 붙잡고 안내를 띄웠는데, 외부 클릭마다 안내가 뜨고 패널을 접어도 popover 가
 *  남는 등 배경 이벤트와 얽혔다. */
const weekdayEditor = ref({
  open    : false,
  ownerKey: null,
  weekday : 0,
  top     : 0,
  left    : 0,
  draft   : null,
});

/* 휴게시간은 사업장만 소유한다 — 담당자는 기관 휴게를 그대로 따르므로 편집 대상이 아니다.
 * 공휴일 운영시간도 사업장 소유라 휴게시간1·2 를 함께 갖는다. */
function editorHasBreaks(ownerKey) {
  return ownerKey === 'INSTITUTION' || ownerKey === HOLIDAY_OWNER;
}

/* popover draft → 운영 Block[].
 * 사용여부 토글을 두지 않는다 — 시작·종료가 모두 있으면 운영, 둘 다 비우면 그 요일/날짜는 휴무가다.
 * (휴게시간과 같은 규약이고, 담당자 7행 인라인 표와도 같다.)
 * ★한쪽만 채운 블록도 그대로 담는다 — 닫을 때 버리면 반쪽 입력이 조용히 사라져 그 요일이 휴무가
 *  된다. 상태에 남겨 두고 저장 게이트(findIncompleteOwner)가 잡는다. */
function draftToBlocks(draft) {
  const blocks = [];
  for (const kind of WORK_BLOCK_KINDS) {
    const slot = draft[kind];
    if (slot?.start || slot?.end) blocks.push({kind, start: slot.start ?? '', end: slot.end ?? ''});
  }
  return blocks;
}

/* 시간이 덜 채워진 행 — 흐리게 표시한다(입력 중 or 휴무). */
function isEditorSlotEmpty(draft, kind) {
  const slot = draft?.[kind];
  return !slot?.start || !slot?.end;
}

const INCOMPLETE_TIME_MSG = '시작시간과 종료시간을 모두 입력해 주세요.';

/* 시간 입력칸은 일반 텍스트다 — `<input type="time">` 이 보장하던 형식·범위를 화면이 직접 본다.
 * 이 두 가드가 없으면 "2590" 같은 값이 state 에 남아 HHMMToHmm(콜론만 제거)을 그대로 지나
 * 서버로 나간다. 문자·자릿수는 입력 단계(maskTimeTyping)에서 이미 걸러지므로 여기 남는 것은
 * 범위를 벗어난 숫자다 — "몇 시부터 몇 시까지 되는가"를 알려 줘야 사용자가 고칠 수 있다. */
const INVALID_TIME_MSG = '시간을 00:00 ~ 23:59 범위로 입력해 주세요.';
const REVERSED_TIME_MSG = '종료시간은 시작시간보다 늦어야 합니다.';

/* 공휴일에 운영하기로 했으면 공휴일 운영시간을 반드시 정해야 한다.
 * 시간이 없어도 그날은 휴무가 아니라 **종일운영**다(useSchedulerRules 주석 참조) — 즉 시간 제한 없이
 * 하루가 통째로 열린다. 대개는 그런 의도가 아니라 입력 누락이라 저장 시점에 한 번 잡아 준다.
 * 공휴일 운영시간(공휴일 운영시간 테이블)은 시작·종료시분이 NOT NULL 이라 "시간 없는 공휴일 운영" 행
 * 자체가 저장되지 않는다는 점도 같다 — 입력하지 않으면 정한 것이 아무것도 남지 않는다. */
const HOLIDAY_TIME_REQUIRED_MSG = '공휴일에 운영하려면 공휴일 운영시간을 입력해 주세요.';

/* 팀은 구성원이 있어야 뜻이 있다 — 이름만 있는 팀은 예약을 받을 수도, 운영시간을 가질 수도 없다.
 * 서버는 이 상태를 거부하지 않고 팀만 저장하므로(구성원 목록이 비면 그냥 넣지 않는다) 화면에서 막는다.
 * ★문구에 팀 이름을 넣지 않는다 — 빈 팀이 여럿이면 하나만 말하게 되어 나머지를 감춘다.
 *  어느 팀인지는 화면에서 빈 팀 전부를 하이라이트해 보여준다(시간 미완성 칸과 같은 규약). */
/* 빌려온 시각의 안내 문구 — 7행 표 · 달력 셀 · 더보기 popover 가 같은 말을 해야 한다. */
const INHERITED_TIME_HINT = '사업장 운영시간을 따릅니다. 이 담당자의 운영시간은 아직 정해지지 않았습니다.';

const TEAM_MEMBERS_REQUIRED_MSG = '팀 구성원이 없습니다.\n구성원을 선택해 주세요.';

/* ===== 저장 게이트 — 시간 입력 3종(미완성 → 형식 → 순서) =====
 * 최종 차단은 **저장 버튼**이 한다. popover 는 바깥을 눌러 닫으려 할 때마다 같은 3단으로 한 번 더
 * 잡고(onDocumentClickCapture), 그래도 나가고 싶으면 우상단 [X] 로 검증 없이 닫는다. 담당자 7행
 * 인라인 표는 종전대로 닫을 때 막지 않는다(닫는다는 조작 자체가 없다).
 * 순서가 뜻이 있다: 덜 채운 칸을 "형식 오류"라고 하거나, 형식이 깨진 값을 "순서가 틀렸다"고
 * 안내하면 사용자가 엉뚱한 곳을 고친다.
 *
 * 한쪽만 채워진 시간 행 = 미완성. 하나라도 입력했으면 시작·종료 둘 다 있어야 한다.
 * 둘 다 비운 것은 정상이다 — 운영행은 "그 요일 휴무", 휴게행은 "휴게 없음"이라는 뜻이다.
 * ★이 가드가 없으면 반쪽 입력이 조용히 버려진다(blocksToWorkRange 가 짝이 안 맞으면 null 로 바꾼다).
 *  사용자는 09:00 을 입력해 두고 저장했는데 그 요일이 휴무로 저장돼 있는 상황이 된다.
 * {ownerKey, key} 를 돌려주는 이유 = 저장 가드가 그 패널을 펼치고 그 요일/날짜 popover 를 다시 열어
 * 비어 있는 칸을 화면에 올리기 위해서다(revealTimeGateViolation). key = 요일(주간) 또는 'YYYY-MM-DD'(지정일자). */
function findIncompleteOwner(dayMapByOwner) {
  return findOwnerBy(dayMapByOwner, b => isIncompletePair(b.start, b.end));
}

/* 형식 오류가 남은 첫 소유자. 놓치면 "2590" 이 그대로 payload 에 실린다. */
function findInvalidOwner(dayMapByOwner) {
  return findOwnerBy(dayMapByOwner, b => isInvalidTimeText(b.start) || isInvalidTimeText(b.end));
}

/* 시작·종료가 역전된 첫 소유자. */
function findReversedOwner(dayMapByOwner) {
  return findOwnerBy(dayMapByOwner, b => isReversedTimeRange(b.start, b.end));
}

/* 운영 요일인데 사업장 운영시간이 없는 요일들 — **저장하면 '매주 휴무'이 될 요일**이다.
 * 배너와 buildPayload 가 같은 값을 본다: 안내한 것과 다른 것이 저장되면 안 된다.
 *
 * 막지 않고 보정하는 이유 — 원천(마이페이지)이 "운영시간이 모두 없으면 휴무"으로 읽으므로
 * 그 요일을 미설정으로 남겨 두면 원천과 자체 보드의 해석이 갈린다(buildPayload 주석).
 * 저장을 막는 쪽은 팀 이름만 고치러 온 사용자까지 볼모로 잡는 덫이 된다.
 *
 * ★siteLocked(= 조회 실패로 요일버튼이 잠긴 상태)면 대상이 없다. 그건 "비어 있다"가 아니라
 *  "원천이 뭘 갖고 있는지 모른다"이고, 여기서 휴무로 확정하면 장애를 데이터로 굳힌다.
 *  잠금 축이라 나중에 권한이 붙어도 따라온다 — siteLoadFailed 를 따로 보지 않는 이유다.
 * ★대상은 사업장뿐이다. 담당자의 미설정은 "사업장 값을 따른다"는 정상 상태이고
 *  (getStaffWeekdayBlocks), 기관 시간이 채워지면 상속칸도 함께 풀린다.
 * ★반복 휴무(매주·매월)이 하나라도 있는 요일은 뺀다 — 매주면 이미 휴무가고, 매월 n번째는
 *  사용자가 직접 고른 값이라 자동 '매주'로 덮지 않는다. 휴무일 탭이 매주·매월을 한 요일에
 *  같이 두지 않는(toggleOption) 배타를 여기서 깨면 payload 에 두 행이 실린다.
 * ★대상은 **시작·종료가 둘 다 비어 있는** 요일이다(hasInstitutionWorkValue). 한쪽만 채운 요일은
 *  채우다 만 것이지 쉬기로 한 것이 아니라, 미완성 게이트가 저장 자체를 먼저 막는다 — 그 요일까지
 *  여기서 세면 저장되지도 않을 '매주 휴무'을 예고하게 된다. */
const missingTimeWeekdays = computed(() => {
  if (!settingsLoaded.value || siteLocked.value) return [];
  const found = [];
  for (let w = 0; w < 7; w++) {
    if ((weekdayOffs.value.get(w)?.size ?? 0) > 0) continue;
    if (!hasInstitutionWorkValue(w)) found.push(w);
  }
  return found;
});

/* 매월 n번째**만** 쉬는 요일인가 — 나머지 주에 운영하는 요일. 매주이거나 다섯 개 전부(isEveryWeekOff)면
 * 쉬지 않는 주가 없어 여기 들지 않는다. */
function isMonthlyOnlyOff(weekday) {
  const options = weekdayOffs.value.get(weekday);
  return (options?.size ?? 0) > 0 && !isEveryWeekOff(options);
}

/* 매월 n번째만 쉬는 요일인데 사업장 운영시간이 없는 요일들 — **운영시간이 있어야 저장되는 요일**이다.
 * 나머지 주에 운영하는 요일이라 자동 '매주 휴무'(missingTimeWeekdays)의 대상이 아니고, 미설정으로
 * 두면 보드가 기본 운영시간으로 열린다. 배너 둘째 줄과 저장 게이트(findTimeGateViolation)가 같은
 * 값을 본다. 잠금·로드 전 제외는 missingTimeWeekdays 와 같은 이유다. */
const monthlyOnlyMissingTimeWeekdays = computed(() => {
  if (!settingsLoaded.value || siteLocked.value) return [];
  const found = [];
  for (let w = 0; w < 7; w++) {
    if (isMonthlyOnlyOff(w) && !hasInstitutionWorkRange(w)) found.push(w);
  }
  return found;
});

/* 배너 문구의 요일 나열 — "수, 목요일". 어느 요일인지 말해 주지 않으면 7행을 눈으로 훑어야 한다. */
function weekdaysLabel(weekdays) {
  return weekdays.map(w => WEEKDAY_LABELS[w]).join(', ');
}
const missingTimeWeekdaysLabel = computed(() => weekdaysLabel(missingTimeWeekdays.value));

/* 그 요일의 매월 차수 나열 — "1, 3". 몇 번째만 쉬는지 말해 주지 않으면 휴무일 탭을 열어 봐야 한다. */
function monthlyOrdinalsLabel(weekday) {
  return [...(weekdayOffs.value.get(weekday) ?? [])]
      .map(monthlyOptionValue)
      .filter(n => n !== null)
      .sort((a, b) => a - b)
      .join(', ');
}

/* 배너 둘째 줄·게이트 안내가 함께 쓰는 조각 — [{weekday, label:'수', ordinals:'1, 3'}] */
const monthlyOnlyMissingTimeSegments = computed(() => monthlyOnlyMissingTimeWeekdays.value.map(w => ({
  weekday : w,
  label   : WEEKDAY_LABELS[w],
  ordinals: monthlyOrdinalsLabel(w),
})));

/* 게이트 안내는 배너 둘째 줄과 같은 문장이어야 한다 — 같은 문제를 누르기 전과 후에 다르게 말하면
 * 사용자가 다른 문제로 읽는다. "수요일은 매월 1, 3번째, 금요일은 매월 2번째 휴무라 …" */
function monthlyTimeRequiredMsg(weekdays) {
  const head = weekdays
      .map(w => `${WEEKDAY_LABELS[w]}요일은 매월 ${monthlyOrdinalsLabel(w)}번째`)
      .join(', ');
  return `${head} 휴무라 나머지 주에 운영합니다.\n운영시간을 입력해 주세요.`;
}

/* 매월 n번째만 쉬는 사업장 요일의 빈 운영시간 — 붉은 표시 판정. 게이트 4단이 가리키는 칸이다.
 * 미완성(한쪽만)과 같은 규약으로 넘어가려 시도한 뒤에만 그린다(입력 도중 상시 경고가 되지 않게). */
function monthlyTimeMissing(ownerKey, weekday, start, end) {
  return saveTried.value && ownerKey === 'INSTITUTION' && isMonthlyOnlyOff(weekday) && !start && !end;
}

/* @returns 첫 적중 {ownerKey, key}, 없으면 null */
function findOwnerBy(dayMapByOwner, predicate) {
  for (const [ownerKey, dayMap] of dayMapByOwner.entries()) {
    for (const [key, blocks] of (dayMap?.entries?.() ?? [])) {
      for (const b of blocks ?? []) {
        if (predicate(b)) return {ownerKey, key};
      }
    }
  }
  return null;
}

/* 휴게시간 Map<weekday, {LUNCH, DINNER}> → 운영 블록과 같은 Map<weekday, {start,end}[]> 모양.
 * 게이트가 운영·휴게를 한 predicate 로 보게 하기 위한 어댑터다(값은 복사하지 않는다). */
function breaksToGateBlocks(breaksMap) {
  const out = new Map();
  for (const [weekday, entry] of breaksMap ?? []) {
    out.set(weekday, Object.values(entry ?? {}).filter(Boolean));
  }
  return out;
}

/* 저장 게이트가 훑는 시간 상태 전부 — 담당자 주간 · 일자 지정 · 사업장 요일/공휴일 운영 · 휴게.
 * 소유자 키가 겹치는 Map(담당자 주간과 일자 지정은 둘 다 STAFF:)이 있어 하나로 합치지 않고 순서대로 본다.
 * 순서가 곧 안내 순서다 — 먼저 걸린 소유자의 패널을 펼친다.
 * ★잠긴 자리는 보지 않는다 — 매주 휴무 요일·공휴일 휴무는 버튼이 disabled 라 고칠 길이 없고,
 *  payload 도 그 행을 싣지 않는다(buildInstitutionTimesPayload). 보면 저장이 영영 막히는 덫이 된다. */
function timeGateSources() {
  const openWeekdays = map => new Map([...map].filter(([w]) => !isWeekdayClosed(w)));
  const unlessHolidayLocked = map => (holidayTimeLocked.value ? new Map() : map);
  return [
    workingHoursByOwner.value,
    workingHoursOverridesByOwner.value,
    new Map([
      ['INSTITUTION', openWeekdays(institutionWeeklyDayMap.value)],
      [HOLIDAY_OWNER, unlessHolidayLocked(institutionHolidayDayMap.value)],
    ]),
    new Map([
      ['INSTITUTION', breaksToGateBlocks(openWeekdays(institutionBreaksByWeekday.value))],
      [HOLIDAY_OWNER, breaksToGateBlocks(unlessHolidayLocked(institutionHolidayBreaks.value))],
    ]),
  ];
}

/* 저장을 막는 첫 시간 오류 — {ownerKey, key, message}. 없으면 null. */
function findTimeGateViolation() {
  const gates = [
    [findIncompleteOwner, INCOMPLETE_TIME_MSG],
    [findInvalidOwner, INVALID_TIME_MSG],
    [findReversedOwner, REVERSED_TIME_MSG],
  ];
  for (const [findOwner, message] of gates) {
    for (const source of timeGateSources()) {
      const hit = findOwner(source);
      if (hit) return {...hit, message};
    }
  }
  /* 4단 — 매월 n번째만 쉬는 요일의 운영시간 부재. 위 3단은 "입력한 것이 맞는가"이고 이것은 "입력이
   * 있어야 하는가"라, 한쪽만 채운 행은 미완성으로 먼저 걸리고 둘 다 빈 행만 여기까지 온다. 규칙이 없는
   * 요일의 빈 행은 자동 '매주 휴무'(missingTimeWeekdays)이라 게이트 대상이 아니다. */
  const monthlyOnly = monthlyOnlyMissingTimeWeekdays.value;
  if (monthlyOnly.length) {
    return {ownerKey: 'INSTITUTION', key: monthlyOnly[0], message: monthlyTimeRequiredMsg(monthlyOnly)};
  }
  return null;
}

/* 열려 있는 popover 한 개의 draft 를 저장 게이트와 같은 3단(미완성 → 형식 → 순서)으로 본다.
 * 저장 게이트는 상태로 옮겨진 뒤를 훑고 이쪽은 아직 상태로 가기 전의 draft 를 보지만, 판정 순서와
 * 문구는 같아야 한다 — 같은 오류를 닫을 때와 저장할 때 다르게 말하면 사용자가 다른 문제로 읽는다.
 * @returns 걸린 안내 문구, 통과하면 null */
function findDraftTimeViolation(draft, {ownerKey, weekday} = {}) {
  const slots = Object.values(draft ?? {}).filter(Boolean);
  if (slots.some(s => isIncompletePair(s.start, s.end))) return INCOMPLETE_TIME_MSG;
  if (slots.some(s => isInvalidTimeText(s.start) || isInvalidTimeText(s.end))) return INVALID_TIME_MSG;
  if (slots.some(s => isReversedTimeRange(s.start, s.end))) return REVERSED_TIME_MSG;
  /* 4단 — 저장 게이트와 같다: 매월 n번째만 쉬는 사업장 요일은 둘 다 비운 것이 "휴무"이 아니다. */
  if (ownerKey === 'INSTITUTION' && isMonthlyOnlyOff(weekday) && isEditorSlotEmpty(draft, 'WORK')) {
    return monthlyTimeRequiredMsg([weekday]);
  }
  return null;
}

/* ===== 미완성 입력 하이라이트 =====
 * 예약등록 팝업과 같은 규약 — `data-invalid="true"` 에 빨간 테두리. 입력 중에는 그리지 않고
 * **넘어가려 시도한 뒤에만**(tried) 그린다. 시작·종료 중 한쪽만 채운 행에서 **비어 있는 칸**,
 * 즉 사용자가 채워야 할 칸을 가리킨다. 짝이 맞춰지면 판정이 스스로 풀리므로 해제 코드는 없다.
 * "넘어가려 시도"는 저장 버튼과 popover 바깥 클릭 둘 다다 — 이름은 저장에서 왔지만 뜻은 처음부터
 * tried 이고, 닫기 가드도 같은 규약으로 이 값을 켠다. */
const saveTried = ref(false);

/* 구성원 없는 팀 하이라이트 — **저장을 시도한 그 순간 비어 있던 팀만** 표시한다.
 * saveTried 처럼 한 번 켜고 두면, 그 뒤에 새로 만드는 팀은 반드시 빈 상태로 시작하므로
 * 이름을 적기도 전에 빨간 테두리가 뜬다(경고가 상시가 되어 뜻을 잃는다).
 * 저장을 누를 때마다 다시 계산하므로 해제 코드는 없다 — 채워지면 그 영역 자체가 사라진다. */
const emptyTeamsAtSave = ref(new Set());

function isIncompletePair(start, end) {
  return !!start !== !!end;
}

/* 한 칸의 오류 표시 여부 — 세 컨텍스트(담당자 7행 · 요일 popover · 일자 override)가 함께 쓴다.
 *
 * ★형식 오류·역전은 tried 와 무관하게 즉시 그린다. 정규화를 지나고도 남은 값이라 이미 확정된
 *  오류이고(입력 도중 상태가 아니다), 저장을 눌러야 알게 하면 어디가 틀렸는지 찾기 늦다.
 * ★미완성(한쪽만)은 입력 도중에도 계속 참이므로 종전대로 넘어가려 시도한 뒤에만 그린다.
 * 역전은 **종료칸**을 가리킨다 — 대개 고쳐야 할 쪽이 종료다. */
function timeFieldInvalid(start, end, field, tried) {
  if (isInvalidTimeText(field === 'start' ? start : end)) return true;
  if (field === 'end' && isReversedTimeRange(start, end)) return true;
  if (!tried) return false;
  if (!isIncompletePair(start, end)) return false;
  return field === 'start' ? !start : !end;
}

/* 담당자 주간 7행 인라인 표 — 미완성은 저장 시도 후에만. */
function staffTimeInvalid(staffId, weekday, field) {
  const start = fetchStaffWorkHours(staffId, weekday, 'start');
  const end = fetchStaffWorkHours(staffId, weekday, 'end');
  return timeFieldInvalid(start, end, field, saveTried.value);
}

/* popover(요일 편집 · 일자 override) — 미완성은 7행 표와 같이 저장 시도 후에만.
 * 저장이 막힌 뒤 다시 연 popover 에서 비어 있는 칸이 바로 보여야 한다. */
function editorSlotInvalid(editor, kind, field) {
  const slot = editor?.draft?.[kind];
  if (!slot) return false;
  if (kind === 'WORK' && monthlyTimeMissing(editor.ownerKey, editor.weekday, slot.start, slot.end)) return true;
  return timeFieldInvalid(slot.start, slot.end, field, saveTried.value);
}

/* 사업장 요일/공휴일 버튼의 오류 표시 — popover 를 닫아 버린 뒤에는 버튼이 그 요일을 가리키는
 * 유일한 자리다. 운영·휴게 어느 한 칸이라도 timeFieldInvalid 면 켠다(어느 칸인지는 열어 보면 보인다). */
function ownerWeekdayInvalid(ownerKey, weekday) {
  if (ownerKey === 'INSTITUTION' && !hasInstitutionWorkRange(weekday)
      && monthlyTimeMissing(ownerKey, weekday, '', '')) return true;
  const ranges = [
    ...getBlocksFor(ownerKey, weekday),
    ...Object.values(getBreaksFor(ownerKey, weekday)).filter(Boolean),
  ];
  return ranges.some(r => timeFieldInvalid(r.start, r.end, 'start', saveTried.value)
      || timeFieldInvalid(r.start, r.end, 'end', saveTried.value));
}

/* 달력 셀 항목(일자 지정)의 오류 표시 — 같은 판정을 블록 목록에 적용한다. */
function blocksInvalid(blocks) {
  return blocks.some(b => timeFieldInvalid(b.start, b.end, 'start', saveTried.value)
      || timeFieldInvalid(b.start, b.end, 'end', saveTried.value));
}

/* 시간 입력칸의 blur/Enter 시점 처리 — 세 컨텍스트가 함께 쓴다.
 *
 * ★살릴 수 있으면 정규화해 확정하고("930"→"09:30"), 못 살리면 **원문을 그대로 둔다.**
 *  말없이 지우면 운영행에서는 그 요일이 휴무로 바뀐다 — 사용자는 시간을 쳐 놨는데 쉬는 날이 된다.
 *  대신 빨간 테두리로 가리키고 저장 게이트에서 막는다.
 * ★DOM 값을 직접 맞춘다: "0930"→"09:30" 처럼 state 가 이미 같은 값이면 재렌더가 일어나지 않아
 *  :value 바인딩만으로는 입력칸에 친 원문("0930")이 그대로 남는다. */
/* 입력 중(타이핑·붙여넣기) — 숫자 외 문자와 5번째 숫자는 칸에 들어오지도 못하게 한다.
 * state 는 건드리지 않는다(확정은 blur 의 commitTimeInput 이 한다) — 여기서 반영하면
 * "09" 까지 친 중간 상태가 09:00 으로 저장돼 버린다.
 *
 * 값을 다시 써 넣으면 커서가 끝으로 간다. 5자짜리 칸이라 끝에서 이어 치는 게 대부분이고,
 * 실제로 바뀔 때만 대입하므로 정상 입력 중에는 커서가 움직이지 않는다. */
function maskTimeInput(event) {
  const el = event?.target;
  if (!el) return;
  const masked = maskTimeTyping(el.value);
  if (masked !== el.value) el.value = masked;
}

function commitTimeInput(event, apply) {
  const raw = event?.target?.value ?? '';
  const next = normalizeTimeInput(raw) ?? String(raw).trim();
  if (event?.target) event.target.value = next;
  apply(next);
}

/* 오류가 있는 소유자의 패널을 펼쳐 하이라이트를 화면에 올린다.
 * 좌측 탭이 휴무일이면 운영시간 탭으로 옮긴다 — 거기서도 저장 버튼을 누를 수 있기 때문이다.
 * 사업장·공휴일은 한 패널(사업장)에 있다 — 요일/공휴일 버튼이 빨갛게 가리킨다. */
function expandIncompleteOwner(ownerKey) {
  activeLeftTab.value = 'WORKING_HOURS';
  if (ownerKey?.startsWith?.('STAFF:')) {
    expandedTreatmentKey.value = `staff:${ownerKey.slice('STAFF:'.length)}`;
  } else if (ownerKey === 'INSTITUTION' || ownerKey === HOLIDAY_OWNER) {
    expandedTreatmentKey.value = 'institution';
  }
}

/* 저장 게이트가 가리킬 앵커 — 사업장 요일/공휴일 버튼 · 달력 셀 항목. v-for 안이라 배열 ref 순서를
 * 믿지 않고 함수 ref 로 키를 붙여 모은다(Vue 는 unmount 때 null 로 부른다). */
const rootEl = ref(null);
const weekdayBtnEls = new Map();
const cellEntryEls = new Map();
function setWeekdayBtnEl(ownerKey, weekday, el) {
  const k = `${ownerKey}:${weekday}`;
  if (el) weekdayBtnEls.set(k, el); else weekdayBtnEls.delete(k);
}
function setCellEntryEl(ownerKey, dateKey, el) {
  const k = `${ownerKey}|${dateKey}`;
  if (el) cellEntryEls.set(k, el); else cellEntryEls.delete(k);
}
function anchorEvent(el) {
  return {stopPropagation() {}, currentTarget: el};
}

/* 저장 게이트가 막은 **그 칸**을 화면에 올린다 — 안내 문구만으로는 어느 시간이 비었는지 알 수 없다.
 *  담당자 7행 표: 패널을 펼치면 빨간 칸이 그 자리에 있다.
 *  사업장·공휴일: popover 는 이미 닫혀 있으므로 그 요일 popover 를 **다시 열어** 빈 칸을 보인다.
 *  일자 지정: 그 달로 옮기고 그 셀 항목의 편집기를 다시 연다(더보기 안에 숨은 항목은 앵커가 없어 펼침까지만).
 * 안내(alert)보다 먼저 연다 — [확인] 뒤에 시선이 갈 곳이 이미 떠 있어야 한다. */
async function revealTimeGateViolation({ownerKey, key}) {
  expandIncompleteOwner(ownerKey);
  const isDateKey = ownerKey?.startsWith?.('STAFF:') && typeof key === 'string';
  if (isDateKey) {
    const d = dayjs(key);
    selectedYear.value = d.year();
    selectedMonth.value = d.month() + 1;
  }
  await nextTick();
  if (ownerKey === 'INSTITUTION' || ownerKey === HOLIDAY_OWNER) {
    const el = weekdayBtnEls.get(`${ownerKey}:${key}`);
    if (el) openWeekdayEditor(anchorEvent(el), ownerKey, key);
  } else if (isDateKey) {
    const el = cellEntryEls.get(`${ownerKey}|${key}`);
    if (el) openCellStaffEditor(anchorEvent(el), ownerKey, key, dayjs(key).day());
  }
  await nextTick();
  focusFirstInvalidInput();
}

/* 첫 오류 칸에 포커스 — 열린 popover 안을 먼저, 없으면 화면 전체(담당자 7행 표). */
function focusFirstInvalidInput() {
  const scope = weekdayEditorEl.value ?? cellStaffEditorEl.value ?? rootEl.value;
  scope?.querySelector?.('input[data-invalid="true"]')?.focus?.();
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

/* 열려 있는 시간 popover 를 전부 정리한다 — 편집기는 입력을 상태로 옮기고(commit) 닫고, 더보기는 닫는다.
 * 새 popover 를 여는 쪽과 외부 클릭·스크롤이 같은 경로를 쓴다: 한 번에 하나만 떠 있어야 한다. */
function settleTimePopovers() {
  if (weekdayEditor.value.open) commitWeekdayEditor();
  if (cellStaffEditor.value.open) commitCellStaffEditor();
  if (cellMorePopover.value.open) closeCellMore();
}

/* 사업장 요일 편집 popover 는 site 번들 소유다 — openWeekdayEditor 호출부가 INSTITUTION 뿐이다. */
function openWeekdayEditor(event, ownerKey, weekday) {
  event.stopPropagation();
  if (siteLocked.value) return;
  /* 공휴일에 쉬기로 했으면 시간을 정할 수 없다 — 버튼 disabled 와 같은 규칙을 여기서 한 번 더 막는다. */
  if (ownerKey === HOLIDAY_OWNER && holidayTimeLocked.value) return;
  settleTimePopovers();

  const rect = event.currentTarget.getBoundingClientRect();
  weekdayEditor.value = {
    open    : true,
    ownerKey,
    weekday,
    ...clampPopoverPos(rect, POPOVER_FALLBACK_WIDTH, POPOVER_FALLBACK_HEIGHT),
    draft   : buildWeekdayDraft(ownerKey, weekday),
  };
  void settlePopoverPos(() => weekdayEditorEl.value, weekdayEditor, rect, clampPopoverPos);
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

function onEditorTimeInput(event, kind, field) {
  commitTimeInput(event, v => setEditorBlockTime(kind, field, v));
}

/* draft 를 상태로 옮기고 닫는다. 여기서는 검증하지 않는다 — 스크롤·리사이즈와 [X] 가 이 경로로
 * 들어오는데 셋 다 막을 자리가 아니다. 바깥 클릭의 검증은 캡처 가드(onDocumentClickCapture)가,
 * 최종 차단은 저장 게이트가 맡는다. 입력은 그대로 상태에 남아 다시 열면 이어서 고칠 수 있다. */
function commitWeekdayEditor() {
  /* 잠긴 파트는 커밋도 하지 않고 닫는다 — 외부클릭/스크롤 경로에서도 호출되므로 여기서 한 번 더 막는다 */
  if (siteLocked.value) {
    closeWeekdayEditor();
    return;
  }
  const {ownerKey, weekday, draft} = weekdayEditor.value;
  if (!ownerKey || !draft) {
    closeWeekdayEditor();
    return;
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

    /* 휴게시간 — 둘 다 비우면 없음(null). 운영 블록이 하나도 없는(휴무) 요일은 휴게도 지운다.
     * 한쪽만 채운 휴게도 운영 블록과 같이 보존한다 — 저장 게이트(timeGateSources)가 잡는다. */
    const nextBreaks = new Map(breaksRef.value);
    if (blocks.length === 0) {
      nextBreaks.delete(weekday);
    } else {
      const entry = {};
      for (const kind of BREAK_BLOCK_KINDS) {
        const slot = draft[kind];
        entry[kind] = (slot?.start || slot?.end) ? {start: slot.start ?? '', end: slot.end ?? ''} : null;
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
}

function closeWeekdayEditor() {
  weekdayEditor.value = {...weekdayEditor.value, open: false, draft: null};
}

/* ===== 미지정 데이터 적용 modal =====
 * 팀에 등록된 담당자 중 1명을 선택 → 미지정 예약/방문 건 일괄 적용 대상.
 * 모달 본체는 공용 UnassignedDataModal (메인 화면 담당자 순서 변경 팝업과 동일 컴포넌트).
 * 대상 목록은 '저장 전 편집 draft(teams)' 기준이라 여기서 만들어 prop 으로 내려준다. */
const unassignedDataModalOpen = ref(false);

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

/* 매주 · 매월 n번째 반복 휴무 규칙 토글 (사업장).
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

/* ===== 휴무 컨트롤의 owner 일반화 (§4-5) =====
 * 화면은 사업장과 담당자에 **같은 컨트롤**을 준다. 그런데 저장 표현은 축마다 다르다:
 *   사업장 — weekdayOffs(매주·매월) / dateOverrides / includePublicHolidays
 *   담당자   — 운영시간 표 entry=[](매주) + staffMonthlyOffs(매월) / 운영시간 override / staffHolidayOff
 * 아래 함수들이 그 차이를 흡수해, 컨트롤 컴포넌트는 한 가지 모양만 보게 한다. */

const EMPTY_OPTION_SET = new Set();

/* 그 대상·요일에 걸린 반복 휴무 옵션 집합 (읽기 전용으로 다룬다)
 *
 * ★그 요일을 아무것도 정하지 않은 담당자는 **사업장 것을 상속해 보여준다.** 우측 달력은 상속을
 *  그리는데 이 컨트롤만 비어 있으면, 체크한 적 없는 날이 휴무로 칠해진 것으로 보인다.
 *  운영시간 탭의 '휴무' 표기(isWeekdayClosed)도 같은 상속을 하므로 두 탭이 갈리지 않는다. */
function offOptionsFor(ownerKey, weekday) {
  if (ownerKey === OFF_OWNER_INSTITUTION) return weekdayOffs.value.get(weekday) ?? EMPTY_OPTION_SET;

  if (isInheritedOffWeekday(ownerKey, weekday)) return weekdayOffs.value.get(weekday) ?? EMPTY_OPTION_SET;

  const monthly = staffMonthlyOffs.value.get(ownerKey)?.get(weekday);
  const entry = workingHoursByOwner.value.get(ownerKey)?.get(weekday);
  if (entry?.length !== 0) return monthly ?? EMPTY_OPTION_SET;

  const set = new Set(monthly ?? []);
  set.add('WEEKLY');
  return set;
}

/* 이 담당자가 **반복 휴무를 하나라도 직접 정했는가** (매주 휴무 행 또는 매월 규칙).
 * ★상속은 항목 단위가 아니라 **축 단위**다 — 팀 배치 때 한 번 물려받고, 그 뒤로 스스로 정하기
 *  시작하면 사업장 요일 규칙을 더는 따라가지 않는다. 항목마다 따라가면 "설정을 시작했는데도
 *  기관이 요일을 추가할 때마다 끌려가는" 상태가 되고, 화면에서 자기 것과 빌린 것이 섞인다. */
function hasOwnRecurringOff(ownerKey) {
  for (const blocks of workingHoursByOwner.value.get(ownerKey)?.values() ?? []) {
    if (blocks.length === 0) return true;   // 매주 휴무로 정한 요일이 있다
  }
  for (const options of staffMonthlyOffs.value.get(ownerKey)?.values() ?? []) {
    if (options.size > 0) return true;
  }
  return false;
}

/* 그 요일의 반복 휴무 표기가 **사업장에서 상속한 것**인가 (자기 값이 아니라).
 * 반복 휴무를 하나도 정하지 않았고, 그 요일에 자기 운영시간도 없을 때만 상속이다. */
function isInheritedOffWeekday(ownerKey, weekday) {
  if (ownerKey === OFF_OWNER_INSTITUTION) return false;
  if (hasOwnRecurringOff(ownerKey)) return false;
  return workingHoursByOwner.value.get(ownerKey)?.get(weekday) === undefined;
}

/* Map<weekday, Set<option>> — 컨트롤이 요일 버튼과 칩을 그리는 입력.
 * 사업장은 저장된 순서를 그대로 쓰고(칩 순서 유지), 담당자는 요일 순으로 만든다. */
function offOptionsMapFor(ownerKey) {
  if (ownerKey === OFF_OWNER_INSTITUTION) return weekdayOffs.value;

  const map = new Map();
  for (let w = 0; w < 7; w++) {
    const options = offOptionsFor(ownerKey, w);
    if (options.size > 0) map.set(w, options);
  }
  return map;
}

/* 칩: (요일, 옵션) 조합별로 1개씩 생성.
 * locked = 사업장에서 상속해 보여주는 것 — 지울 자기 값이 없으므로 × 를 두지 않는다.
 * ★매주도 잠근다. 축 단위 상속에서는 상속된 것을 누르면 "켜기"라 × 가 도리어 자기 휴무를 만든다. */
function recurringChipsFor(ownerKey) {
  const chips = [];
  for (const [weekday, options] of offOptionsMapFor(ownerKey).entries()) {
    const inherited = isInheritedOffWeekday(ownerKey, weekday);
    for (const option of options) {
      chips.push({
        weekday, option,
        label : recurringChipLabel(weekday, option),
        locked: inherited,
      });
    }
  }
  return chips;
}

/* 지금 상속으로 그려지고 있는 요일 — 컨트롤이 자기 값과 빌린 값을 눈으로 가르는 데 쓴다. */
function inheritedWeekdaysFor(ownerKey) {
  const set = new Set();
  for (const weekday of offOptionsMapFor(ownerKey).keys()) {
    if (isInheritedOffWeekday(ownerKey, weekday)) set.add(weekday);
  }
  return set;
}

/* 담당자 매주 휴무 = 운영시간 표의 `entry = []`.
 * ⚠️ 켜면 그 요일에 넣어 둔 운영시간은 사라진다 — 한 요일에 "휴무"과 "운영시간"을 함께 담을 자리가
 *   원천 테이블(담당자 운영시간 테이블, 시분 NULL = 휴무)에 없다.
 * 끄면 그 요일 행을 지운다. 자기 반복 휴무가 하나도 남지 않으면 그 담당자는 다시 사업장을 따라간다. */
function setStaffWeekdayOff(ownerKey, weekday, off) {
  const next = new Map(workingHoursByOwner.value);
  const dayMap = new Map(next.get(ownerKey) ?? []);
  if (off) dayMap.set(weekday, []);
  else dayMap.delete(weekday);
  next.set(ownerKey, dayMap);
  workingHoursByOwner.value = next;
}

function setStaffMonthlyOptions(ownerKey, weekday, options) {
  const next = new Map(staffMonthlyOffs.value);
  const dayMap = new Map(next.get(ownerKey) ?? []);
  if (options.size === 0) dayMap.delete(weekday);
  else dayMap.set(weekday, options);

  if (dayMap.size === 0) next.delete(ownerKey);
  else next.set(ownerKey, dayMap);
  staffMonthlyOffs.value = next;
}

/* 그 담당자의 매월 규칙 → API 계약 모양 [{dayCd, monthlyNth}]. 요일·차수 오름차순으로 고정한다
 * — 순서가 흔들리면 baseline 비교가 "변경됨"으로 오판해 저장 버튼이 잘못 켜진다(계획서 G2). */
function monthlyOffRulesOf(ownerKey) {
  const rules = [];
  for (const [dayCd, options] of staffMonthlyOffs.value.get(ownerKey) ?? []) {
    for (const option of options) {
      const monthlyNth = monthlyOptionValue(option);
      if (monthlyNth !== null) rules.push({dayCd, monthlyNth});
    }
  }
  rules.sort((a, b) => a.dayCd - b.dayCd || a.monthlyNth - b.monthlyNth);
  return rules;
}

/* 담당자 반복 휴무 토글 — 배타 규칙은 사업장과 같다(매주를 켜면 매월을 비운다).
 *
 * ★아직 아무것도 정하지 않아 **사업장 것을 빌려 보여주는 중**이면, 누르는 것은 언제나 "켜기"다.
 *  그 순간 그 요일이 자기 값이 되고 상속이 끊겨, 빌려 보여주던 나머지 요일 표기는 사라진다.
 *  (빌린 표기를 끄는 조작은 두지 않는다 — 지울 자기 값이 없어 눌러도 아무 일이 없다.) */
function toggleStaffOption(ownerKey, weekday, option) {
  const inherited = !hasOwnRecurringOff(ownerKey);
  const weeklyOff = inherited ? false : offOptionsFor(ownerKey, weekday).has('WEEKLY');

  if (option === 'WEEKLY') {
    setStaffWeekdayOff(ownerKey, weekday, !weeklyOff);
    if (!weeklyOff) setStaffMonthlyOptions(ownerKey, weekday, new Set());
    return;
  }
  /* 매주가 켜져 있으면 매월은 의미가 없다 — 드롭다운에서도 disabled 지만 여기서 한 번 더 막는다. */
  if (weeklyOff) return;

  const options = new Set(staffMonthlyOffs.value.get(ownerKey)?.get(weekday) ?? []);
  if (options.has(option)) options.delete(option);
  else options.add(option);
  setStaffMonthlyOptions(ownerKey, weekday, options);
}

function toggleOptionFor(ownerKey, weekday, option) {
  if (ownerKey === OFF_OWNER_INSTITUTION) toggleOption(weekday, option);
  else toggleStaffOption(ownerKey, weekday, option);
}

/* 그 대상이 공휴일에 쉬는가. 담당자 값 부재는 조회 전 과도 상태뿐이라 기관 값으로 표시만 한다. */
function holidayOffFor(ownerKey) {
  if (ownerKey === OFF_OWNER_INSTITUTION) return includePublicHolidays.value;
  const yn = staffHolidayOff.value.get(ownerKey);
  if (yn === 'N') return true;
  if (yn === 'Y') return false;
  return includePublicHolidays.value;
}

/* 체크박스를 만지는 순간 'Y'/'N' 으로 확정된다 — 상속(미설정)으로 되돌리는 조작은 두지 않는다.
 * 3상태 순환을 만들면 사업장 체크박스와 모양이 갈린다(§4-5-5). */
function setHolidayOffFor(ownerKey, value) {
  if (ownerKey === OFF_OWNER_INSTITUTION) {
    setIncludePublicHolidays(value);
    return;
  }
  const next = new Map(staffHolidayOff.value);
  next.set(ownerKey, value ? 'N' : 'Y');
  staffHolidayOff.value = next;
}

/* 해당 날짜가 반복 휴무 규칙에 해당하는지 판정 — 규칙은 offDayRules 가 소유한다(뷰어와 공용). */
function isRecurringOff(date) {
  return isInstitutionRecurringOff(date, weekdayOffs.value);
}

/* 공휴일 여부 (체크박스 무관 — 날짜 자체가 국가 공휴일인지).
 * 공휴일은 휴무일(반복)·특정일자(override) 로직에서 제외하고 '공휴일' 체크박스로만 휴무/운영 결정한다. */
function isHolidayDate(date) {
  return holidayStore.isHoliday(date.format('YYYY-MM-DD'));
}

/* 팀에서 빠진 담당자가 선택된 채로 남으면 우측 뷰어가 목록에 없는 대상을 계속 그린다 —
 * 구성원 삭제·팀 삭제 어느 경로로 빠지든 사업장 선택으로 되돌린다. */
watch(teams, () => {
  if (selectedOffOwner.value === OFF_OWNER_INSTITUTION) return;

  const stillListed = teams.value.some(team =>
      (team.doctorIds ?? []).some(docId => staffOffOwnerKey(docId) === selectedOffOwner.value));
  if (!stillListed) selectedOffOwner.value = OFF_OWNER_INSTITUTION;
}, {deep: true});

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

  closeTeamMenu();
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

/* 구성원 picker 목록 — 팀에 배정할 수 없는 담당자를 걸러낸다.
 * "미지정"은 사람이 아니라 사업장 설정 경유 예약의 담당의 자리표시자이며, BE 가 사업장마다 담당자 대표에 1회 선등록한다.
 * 팀에 넣으면 "미지정 예약"(= 대표에는 있으나 팀 멤버가 아닌 건)이라는 정의가 무너져 미지정 데이터 설정이 대상을 잃는다.
 * 이미 팀에 들어가 있는 경우에는 staged 에 그대로 남으므로 저장으로 빠지지는 않는다(목록에서만 감춘다). */
const staffPickerDoctors = computed(() =>
    doctors.value.filter(d => d.text !== UNASSIGNABLE_DOCTOR_NAME)
);

/* ===== 팀 배치 시점 상속(복사) — 화면정의서 APB032/033 §4 =====
 * "사업장 값은 첫 직원에게, 첫 직원 값은 다음 직원들에게 상속됨"은 런타임 참조가 아니라
 * **배치 시점 복사**다 — 복사 후 개별 수정은 자유고, 원본이 나중에 바뀌어도 따라가지 않는다.
 * (개별 편집 UI 가 있는 이상 라이브 추종은 성립하지 않는다.)
 * 팀 이탈은 설정 삭제(4-2)이므로, 재배치되는 직원의 잔존 상태는 덮어써도 된다. */
function inheritedStaffSettingsFrom(sourceKey) {
  if (sourceKey === OFF_OWNER_INSTITUTION) {
    const dayMap = new Map();
    const monthly = new Map();
    for (const [weekday, options] of weekdayOffs.value) {
      if (options.has('WEEKLY')) dayMap.set(weekday, []);
      const monthlyOptions = new Set([...options].filter(o => o !== 'WEEKLY'));
      if (monthlyOptions.size > 0) monthly.set(weekday, monthlyOptions);
    }
    /* 기관 임시운영(WORK) 일자는 담당자에겐 시간이 필요하다 — 이 시점엔 요일 시간이 없으니 기본값. */
    const overrides = new Map();
    for (const [dateKey, type] of dateOverrides.value) {
      overrides.set(dateKey, type === 'OFF' ? [] : [{...DEFAULT_WORK_BLOCK}]);
    }
    return {dayMap, monthly, overrides, phdy: includePublicHolidays.value ? 'N' : 'Y'};
  }
  const dayMap = new Map([...(workingHoursByOwner.value.get(sourceKey) ?? [])]
      .map(([w, blocks]) => [w, blocks.map(b => ({...b}))]));
  const monthly = new Map([...(staffMonthlyOffs.value.get(sourceKey) ?? [])]
      .map(([w, opts]) => [w, new Set(opts)]));
  const overrides = new Map([...(workingHoursOverridesByOwner.value.get(sourceKey) ?? [])]
      .map(([d, blocks]) => [d, blocks.map(b => ({...b}))]));
  return {
    dayMap, monthly, overrides,
    phdy: staffHolidayOff.value.get(sourceKey) ?? (includePublicHolidays.value ? 'N' : 'Y'),
  };
}

function applyInheritedSettings(newDoctorIds, sourceKey) {
  if (newDoctorIds.length === 0) return;
  const s = inheritedStaffSettingsFrom(sourceKey);
  const hoursNext = new Map(workingHoursByOwner.value);
  const overridesNext = new Map(workingHoursOverridesByOwner.value);
  const monthlyNext = new Map(staffMonthlyOffs.value);
  const holidayNext = new Map(staffHolidayOff.value);
  for (const id of newDoctorIds) {
    const key = staffOffOwnerKey(id);
    /* 대상마다 새 사본 — 같은 Map/배열을 공유하면 한 명을 고칠 때 전원이 바뀐다. */
    if (s.dayMap.size) hoursNext.set(key, new Map([...s.dayMap].map(([w, b]) => [w, b.map(x => ({...x}))])));
    else hoursNext.delete(key);
    if (s.overrides.size) overridesNext.set(key, new Map([...s.overrides].map(([d, b]) => [d, b.map(x => ({...x}))])));
    else overridesNext.delete(key);
    if (s.monthly.size) monthlyNext.set(key, new Map([...s.monthly].map(([w, o]) => [w, new Set(o)])));
    else monthlyNext.delete(key);
    holidayNext.set(key, s.phdy);
  }
  workingHoursByOwner.value = hoursNext;
  workingHoursOverridesByOwner.value = overridesNext;
  staffMonthlyOffs.value = monthlyNext;
  staffHolidayOff.value = holidayNext;
}

/* picker 완료 — teamId=null: 신규 팀 생성 / teamId=existing: 구성원만 업데이트.
 * 어느 팀에도 없던 직원이 새로 배치되면 상위(기존 첫 직원, 없으면 사업장) 값을 복사한다. */
function confirmStaffPicker() {
  const {teamId, staged} = staffPicker.value;
  const doctorIds = [...staged];
  const assignedBefore = new Set(teams.value.flatMap(t => t.doctorIds));
  const newMembers = doctorIds.filter(id => !assignedBefore.has(id));

  if (teamId === null) {
    if (!editingTeam.value) {
      closeStaffPicker();
      return;
    }
    const trimmedName = editingTeam.value.name.trim() || '새 팀';
    const newId = `TEAM_${Date.now()}`;
    teams.value = [...teams.value, {id: newId, name: trimmedName, doctorIds}];
    editingTeam.value = null;
    applyInheritedSettings(newMembers, OFF_OWNER_INSTITUTION);
  } else {
    const priorTop = teams.value.find(t => t.id === teamId)?.doctorIds[0];
    teams.value = teams.value.map(t =>
        t.id === teamId ? {...t, doctorIds} : t
    );
    applyInheritedSettings(newMembers,
        priorTop != null ? staffOffOwnerKey(priorTop) : OFF_OWNER_INSTITUTION);
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
  closeTeamMenu();
  openStaffPickerFor(teamId, {top, left});
}

/* 구성원 picker 를 연다 — 팀 메뉴(⋯)의 「구성원 설정」과 빈 팀 영역 클릭이 같은 경로를 쓴다.
 * triggerRect 가 없으면(메뉴 경로) top 기준 pseudo-rect 로 flip 처리한다. */
function openStaffPickerFor(teamId, {top, left, triggerRect = null}) {
  const team = teams.value.find(t => t.id === teamId);
  if (!team) return;
  closeTeamMenu();
  staffPicker.value = {
    open: true,
    top,
    left,
    staged: new Set(team.doctorIds),
    teamId: team.id,
  };
  clampStaffPickerIntoView(triggerRect ?? {top});
}

/* 구성원이 0명인 팀의 안내 영역 클릭 — 그 자리에서 바로 배정할 수 있게 picker 를 연다.
 * 빈 팀에 사람을 넣는 길이 ⋯ 메뉴 하나뿐이면 찾기 어렵고, 드래그로만 넣으려 해도 놓을 자리가 보이지 않는다.
 * ★호출부에 @click.stop 이 필요하다 — document 클릭 리스너가 방금 연 picker 를 그 클릭으로 닫는다
 *   (신규 팀 폼의 memberArea 도 같은 이유로 .stop 을 달고 있다). */
function onEmptyMemberAreaClick(event, teamId) {
  const rect = event.currentTarget.getBoundingClientRect();
  openStaffPickerFor(teamId, {top: rect.bottom + 4, left: rect.left, triggerRect: rect});
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
  /* 컨테이너 자체에 드롭 → 끝에 추가 (chip li의 dragover는 별도로 stopPropagation됨).
   * ★같은 팀 안에서는 targetIndex 를 건드리지 않는다 — 칩 사이 gap(4px) 위를 지날 때마다
   *  여기가 발동해 "끝으로"(null)로 덮어쓰면, 드래그하는 내내 드롭 위치 표시가 깜빡이며 튄다.
   *  팀이 바뀔 때만(빈 팀 포함) 끝에 추가로 초기화한다. */
  if (chipDrag.value.targetTeamId !== teamId) {
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
  /* toIndex=null → 끝, 아니면 "그 칩이 있던 자리로" 시맨틱 —
   * 뺀 뒤의 배열에 toIndex 로 그대로 꽂는다. 담당자 순서 변경 팝업(SchedulerDoctorOrderPopup)과 같은 규약이다.
   * ★"target 앞에 삽입"(fromIndex<toIndex 일 때 toIndex-1 보정)으로 두면 아래로 끌었을 때 한 칸 덜 가
   *  잡은 자리에 놓이지 않는다 — 드래그가 겉도는 것처럼 느껴지던 원인. */
  const insertAt = toIndex === null ? ids.length : toIndex;
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

/* ===== 우측 뷰어의 owner 일반화 (§4-5-2) =====
 * 12개월 뷰어는 선택한 대상의 휴무일을 그린다. 담당자 판정은 순수함수(offDayRules.ts)가 하고,
 * "정하지 않음"은 사업장 판정을 상속한다 — 미설정을 휴무로 접으면 기관이 운영하는 날에도
 * 그 담당자만 통째로 쉬는 것처럼 보인다. */
function staffOffContextFor(ownerKey, date) {
  const dateKey = date.format('YYYY-MM-DD');
  return {
    dateBlocks     : workingHoursOverridesByOwner.value.get(ownerKey)?.get(dateKey),
    weekdayBlocks  : workingHoursByOwner.value.get(ownerKey)?.get(date.day()),
    monthlyOffRules: monthlyOffRulesOf(ownerKey),
    holidayOpenYn     : staffHolidayOff.value.get(ownerKey) ?? null,
    isHoliday      : isHolidayDate(date),
  };
}

/* 정한 것이 없는 담당자가 상속하는 사업장 판정.
 *
 * ★상속은 **축 단위**다. 요일 축을 스스로 정한 담당자에게는 기관 반복 휴무를, 일자 축을 스스로 정한
 *  담당자에게는 기관 일자 지정을 더는 적용하지 않는다. 축마다 따로 끊기므로 둘을 함께 묻지 않는다 —
 *  요일 휴무를 하나 정했다고 사업장 임시휴무일까지 안 따라가면 그건 정한 적 없는 결정이다.
 *
 * ★공휴일 축은 다르다 — `HOLIDAY_OPEN_YN` 은 NOT NULL 2상태라 늘 자기 값이고, 기관 값은 팀 배치 시점에
 *  이미 복사됐다(계획서 §3-2). 그래서 기관에서 런타임으로 내려받을 것이 없다. 답을 holidayOffFor 로
 *  내는 이유는 **판정과 체크박스 표시를 한 함수로 묶기 위해서다** — 조회 전 과도 상태로 값이 비어 있을 때
 *  둘이 갈리면, 체크는 기관 값으로 켜져 보이는데 판정만 운영이 된다.
 * 공휴일에 기관 **요일** 휴무를 보지 않는 것은 기관 축과 같은 규약이다(isNaturallyOff) — 기관도 공휴일을
 * 반복 휴무에서 빼고 공휴일 스위치로만 가른다. */
function inheritedInstitutionOff(date, ownerKey) {
  return inheritedInstitutionOffOn({
    hasOwnDateOverrides: hasOwnDateOverrides(ownerKey),
    institutionDateOverride: dateOverrides.value.get(date.format('YYYY-MM-DD')),
    isHoliday: isHolidayDate(date),
    holidayOff: holidayOffFor(ownerKey),
    hasOwnRecurringOff: hasOwnRecurringOff(ownerKey),
    institutionRecurringOff: isRecurringOff(date),
  });
}

function isDisplayedOffFor(ownerKey, date) {
  if (ownerKey === OFF_OWNER_INSTITUTION) return isDisplayedOff(date);
  return isStaffOffOn(date, staffOffContextFor(ownerKey, date), inheritedInstitutionOff(date, ownerKey));
}

/* 범위 OFF 토글 (단일 클릭/드래그 공통)
 * - 범위 내 모두 OFF → 모두 해제 (자연 OFF는 'WORK' override, 아니면 override 삭제)
 * - 그 외 → 모두 OFF (자연 OFF는 override 삭제, 아니면 'OFF' override)
 * 공휴일 날짜도 토글 대상이다 — 공휴일에 임시운영/임시휴무를 지정할 수 있어야 한다
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

/* 캘린더에서 "그 날짜 운영"로 뒤집을 때 채울 운영시간 (§4-4).
 * 그 담당자의 그 요일 → 없으면 사업장의 그 요일 → 그것도 없으면 기본값.
 *
 * ★채우는 주체가 FE 인 이유 — BE 가 저장 시점에 채우면 "휴무일 탭이 운영으로 뒤집은 날짜"와
 *  "운영시간 탭에서 정상적으로 휴무 지정한 날짜"를 구분할 수 없어 후자까지 운영으로 뒤집힌다(계획서 D5).
 * 지정 자체가 만들어지는 시점에 채운다 — 일자 지정은 "빈 blocks = 휴무 / 값 있음 = 운영" 로만
 * 뜻이 갈려, 값 없는 운영 지정을 만들어 두면 그 순간부터 휴무와 구분되지 않는다. */
const DEFAULT_WORK_BLOCK = {kind: 'WORK', start: '09:00', end: '18:00'};

/* 그 담당자·요일을 "운영"로 확정할 때 넣을 운영시간 (계획서 §4-4)
 * — 자기 그 요일 → 없으면 사업장 그 요일 → 그것도 없으면 09:00~18:00. */
function staffWorkBlocksFor(ownerKey, weekday) {
  const blocks = getStaffWeekdayBlocks(ownerKey, weekday);
  return blocks.length > 0 ? blocks.map(b => ({...b})) : [{...DEFAULT_WORK_BLOCK}];
}

function workDayBlocksFor(ownerKey, date) {
  return staffWorkBlocksFor(ownerKey, date.day());
}

/* 담당자 범위 토글 — 규칙은 사업장과 같다(자연 상태와 같아지면 지정을 지운다).
 * 담기는 곳만 다르다: 담당자의 일자 지정은 운영시간 override 그 자체다(계획서 R1). */
function toggleStaffRangeOff(ownerKey, startKey, endKey) {
  const a = dayjs(startKey);
  const b = dayjs(endKey);
  const [from, to] = a.isBefore(b) ? [a, b] : [b, a];

  let allOff = true;
  let cursor = from;
  while (!cursor.isAfter(to, 'day')) {
    if (!isDisplayedOffFor(ownerKey, cursor)) {
      allOff = false;
      break;
    }
    cursor = cursor.add(1, 'day');
  }

  const newOff = !allOff;
  const next = new Map(workingHoursOverridesByOwner.value);
  const dayMap = new Map(next.get(ownerKey) ?? []);

  cursor = from;
  while (!cursor.isAfter(to, 'day')) {
    const key = cursor.format('YYYY-MM-DD');
    /* ★누르고 지나간 날은 **자연 상태와 같아도** 자기 지정으로 남긴다 — 사용자가 고른 값이다.
     *  사업장과 달리 지우지 않는 이유: 일자 축 상속은 축 단위라, 같은 드래그가 다른 날에 지정을
     *  만드는 순간 이 대상은 기관 일자 지정을 더는 따라가지 않는다. 그때 "어차피 상속으로 휴무"이라며
     *  지정을 만들지 않고 넘어간 날만 운영으로 되살아난다(기관 임시휴무일을 가로질러 휴무로 끌면
     *  그 하루만 운영으로 남던 결함). 지우는 조작은 칩의 × 하나로 둔다. */
    dayMap.set(key, newOff ? [] : workDayBlocksFor(ownerKey, cursor));
    cursor = cursor.add(1, 'day');
  }

  next.set(ownerKey, dayMap);
  workingHoursOverridesByOwner.value = next;
}

function toggleRangeOffFor(ownerKey, startKey, endKey) {
  if (ownerKey === OFF_OWNER_INSTITUTION) toggleRangeOff(startKey, endKey);
  else toggleStaffRangeOff(ownerKey, startKey, endKey);
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

  toggleRangeOffFor(selectedOffOwner.value, startKey, endKey);
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
/* 이 담당자가 **일자 지정을 하나라도 직접 했는가** — 요일 축의 hasOwnRecurringOff 와 같은 규약이다. */
function hasOwnDateOverrides(ownerKey) {
  return (workingHoursOverridesByOwner.value.get(ownerKey)?.size ?? 0) > 0;
}

/* 그 대상의 일자 지정 — Map<'YYYY-MM-DD', 'OFF' | 'WORK'>.
 * 담당자 쪽은 운영시간 override 가 그대로 답이다: 빈 blocks = 그 날짜 휴무 / 값 있음 = 그 날짜 운영.
 *
 * ★일자 축을 **아직 하나도 정하지 않았을 때만** 사업장 지정을 상속해 보여준다.
 *  하나라도 정했으면 자기 것만 그린다 — 섞어 그리면 자기가 정한 날과 사업장을 따라가는 날이
 *  한 칩 목록에 나란히 앉아, 어느 쪽이 자기 결정인지 화면에서 사라진다. */
function dateOverridesFor(ownerKey) {
  if (ownerKey === OFF_OWNER_INSTITUTION) return dateOverrides.value;

  const map = hasOwnDateOverrides(ownerKey) ? new Map() : new Map(dateOverrides.value);
  for (const [dateKey, blocks] of workingHoursOverridesByOwner.value.get(ownerKey) ?? []) {
    map.set(dateKey, blocks.length === 0 ? 'OFF' : 'WORK');
  }
  return map;
}

/* 그 날짜 지정이 이 담당자 자신의 것인가 (아니면 사업장에서 상속한 것) */
function ownsDateOverride(ownerKey, dateKey) {
  if (ownerKey === OFF_OWNER_INSTITUTION) return true;
  return workingHoursOverridesByOwner.value.get(ownerKey)?.has(dateKey) === true;
}

const specificDates = computed(() => {
  const sorted = [...dateOverridesFor(selectedOffOwner.value).entries()].sort(([a], [b]) => a.localeCompare(b));
  const ranges = [];

  for (const [key, type] of sorted) {
    const d = dayjs(key);
    const isHoliday = holidayStore.isHoliday(key);
    /* 상속분과 자기 지정은 한 칩으로 묶지 않는다 — 한쪽만 × 를 갖게 되어 무엇이 지워지는지 흐려진다. */
    const locked = !ownsDateOverride(selectedOffOwner.value, key);
    const last = ranges[ranges.length - 1];

    if (last && last.type === type && last.isHoliday === isHoliday && last.locked === locked
        && last.endDate.year() === d.year()
        && last.endDate.add(1, 'day').isSame(d, 'day')) {
      last.endDate = d;
      last.endKey = key;
    } else {
      ranges.push({startDate: d, endDate: d, startKey: key, endKey: key, type, isHoliday, locked});
    }
  }

  /* 여러 해가 섞여 있을 때만 칩에 연도를 붙인다 — 한 해뿐이면 군더더기고,
   * 섞였는데 없으면 "8월 15일"이 어느 해인지 알 수 없다(사업장 설정가 여러 해를 전개해 둘 수 있다). */
  const multiYear = new Set(ranges.map(r => r.startDate.year())).size > 1;
  const dateLabel = (d) => (multiYear ? `${d.year()}년 ` : '') + `${d.month() + 1}월 ${d.date()}일`;

  return ranges.map((r) => {
    /* 타입은 그룹 헤더(운영/휴무)가 말해 준다 — 칩마다 "(휴무)"을 붙이면 눈에 안 들어온다. */
    const label = r.startKey === r.endKey
        ? dateLabel(r.startDate)
        : `${dateLabel(r.startDate)} ~ ${dateLabel(r.endDate)}`;
    return {...r, label};
  });
});

/* 특정일자 칩을 **운영/휴무**으로 묶는다.
 * 종전에는 연도로 묶고 칩마다 "(휴무)"을 붙였는데, 정작 중요한 운영/휴무 구분이 괄호 안에 묻혀
 * 눈에 들어오지 않았다. 연도는 여러 해가 섞였을 때만 칩 라벨에 실린다(specificDates 참조).
 * 순서는 휴무 → 운영. 이 탭의 주 관심사가 휴무일이다. */
const SPECIFIC_DATE_GROUPS = [
  {type: 'OFF', label: '휴무'},
  {type: 'WORK', label: '운영'},
];

const specificDatesByType = computed(() =>
    SPECIFIC_DATE_GROUPS
        .map(g => ({...g, ranges: specificDates.value.filter(r => r.type === g.type)}))
        .filter(g => g.ranges.length > 0));

function removeSpecificRange(range) {
  const ownerKey = selectedOffOwner.value;
  const dateKeys = [];
  let cursor = range.startDate;
  while (!cursor.isAfter(range.endDate, 'day')) {
    dateKeys.push(cursor.format('YYYY-MM-DD'));
    cursor = cursor.add(1, 'day');
  }

  if (ownerKey === OFF_OWNER_INSTITUTION) {
    const next = new Map(dateOverrides.value);
    for (const key of dateKeys) next.delete(key);
    dateOverrides.value = next;
    return;
  }

  const next = new Map(workingHoursOverridesByOwner.value);
  const dayMap = new Map(next.get(ownerKey) ?? []);
  /* 자기 지정만 지운다(미설정으로 되돌아가 사업장을 따른다).
   * 상속분 칩에는 × 가 없다(§4-5-7) — 지울 것이 없기 때문이다. 뒤집으려면 달력에서 그 날짜를 누른다. */
  for (const key of dateKeys) dayMap.delete(key);
  next.set(ownerKey, dayMap);
  workingHoursOverridesByOwner.value = next;
}

/* 캘린더에 표시할 운영시간 조회 단위 — 직원 / 팀 / 사업장 셋이다.
 *  - 직원 선택 중 → STAFF        그 직원 하나 + 이름 prefix (단일 라벨 모드)
 *  - 팀 선택 중   → TEAM         그 팀 소속 직원들 (직원별 리스트 모드)
 *  - 그 외        → INSTITUTION  전 직원 (직원별 리스트 모드)
 * 팀이 사라진 뒤(삭제·구성원 변경) 키만 남으면 INSTITUTION 으로 떨어진다 — 빈 캘린더보다 낫다. */
function getCalendarOwner() {
  const key = expandedTreatmentKey.value;
  if (key && key.startsWith('staff:')) {
    const docId = Number(key.slice('staff:'.length));
    return {scope: 'STAFF', ownerKey: `STAFF:${docId}`, doctorName: getDoctor(docId)?.text ?? '', doctorId: docId};
  }
  if (key && key.startsWith('team:')) {
    /* ★팀 id 는 문자열이다(loadSettings 의 `String(t.id)`) — 숫자로 바꿔 비교하면 항상 어긋난다.
     * 신규 생성 팀도 같은 규약이라 문자열끼리 비교한다. */
    const teamId = key.slice('team:'.length);
    if (teams.value.some(t => String(t.id) === teamId)) {
      return {scope: 'TEAM', ownerKey: 'INSTITUTION', doctorName: '', teamId};
    }
  }
  return {scope: 'INSTITUTION', ownerKey: 'INSTITUTION', doctorName: ''};
}

/* 블록들의 첫 시작 ~ 마지막 종료를 단일 범위로 (오전/오후/야간 구분 없이).
 * ★직원 단위 전용 라벨 함수(formatAppointmentLabel)는 폐기했다 — 그 함수는 요일 운영시간만 보고
 *  일자 지정과 사업장 폴백을 타지 않아, 같은 날짜가 직원 단위에서만 빈칸으로 보였다.
 *  라벨을 만드는 곳은 formatListEntries 하나뿐이어야 한다. */
/* 그 날짜에 미설정 담당자가 빌려 쓸 사업장 운영시간.
 * ★공휴일이면 기관의 **공휴일 운영시간**(holidayHours)을 먼저 본다. 요일 시간을 쓰면 기관이 그날 실제로
 *  여는 시간과 다른 값이 찍힌다 — 기관 공휴일이 09:00~13:00 인데 그날이 금요일이라 09:00~18:00 으로
 *  표기되던 것이 그 예다. 기관이 공휴일 시간을 따로 등록했다는 건 "이날은 요일 시간과 다르다"는
 *  명시적 의사표시이므로 상속도 그것을 따라야 한다.
 * 공휴일 시간을 등록하지 않은 기관은 요일 시간으로 내려간다 — 종전 동작 유지다. 여기서 미표기로
 *  바꾸면 지금 보이던 줄이 통째로 사라진다.
 * 기관이 공휴일 휴무(holidayClosedYn)이어도 등록된 시간 값은 보존되므로(institutionHolidayDayMap 주석)
 *  담당자만 holidayOpenYn='Y' 로 운영하는 경우에도 이 값을 쓴다 — 그 사람이 실제로 여는 시간에 가장 가깝다. */
function institutionBlocksOn(date, weekday) {
  /* 일자 > 공휴일 > 요일 — 보드 예약검증(pickDailySchedule)·타임라인 밴드(resolveUnitHours)와 같은 순서다.
   * 날짜를 콕 집어 저장된 시각이 가장 구체적인 의도라 공휴일 시간보다도 먼저다. */
  const dateBlocks = institutionDateDayMap.value.get(date.format('YYYY-MM-DD'));
  if (dateBlocks?.length > 0) return dateBlocks;

  if (isHolidayDate(date) && hasSiteHolidayHoursRange()) {
    return institutionHolidayDayMap.value.get(HOLIDAY_SLOT) ?? [];
  }
  return institutionWeeklyDayMap.value.get(weekday) ?? [];
}

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

/* 캘린더 셀의 직원 표시 순서 — 세 조회 단위 모두 이 하나를 쓴다.
 * 직원:     그 한 명. 단위가 달라도 표기가 갈리면 안 되므로 "1명짜리 목록"으로 다룬다
 *           (예전에는 STAFF 만 별도 라벨 함수를 써서 cascade·일자 지정이 통째로 빠져 있었다).
 * 사업장: teams[] 순회 + 각 팀의 doctorIds 순서대로 (같은 직원이 N팀 소속이면 N번 표시 — 의도된 중복).
 *           팀 미소속 STAFF 는 끝에 staffId 오름차순.
 * 팀:       그 팀의 doctorIds 만. 팀 미소속(orphan)은 넣지 않는다 —
 *           "그 팀 소속 직원"을 보려고 고른 것이라 남이 섞이면 조회 단위가 무의미해진다. */
function getCalendarDoctorOrder(owner) {
  if (owner.scope === 'STAFF') {
    return owner.doctorId == null ? [] : [owner.doctorId];
  }
  if (owner.scope === 'TEAM') {
    return teams.value.find(t => String(t.id) === owner.teamId)?.doctorIds ?? [];
  }

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

/* 한 셀의 entries — {staffId, label, isOff, isDesignated}[]
 * 대상 직원만 달라질 뿐 라벨 판정(cascade)은 조회 단위 셋(직원·팀·사업장)이 완전히 같다 —
 * 갈라놓으면 같은 날짜가 단위에 따라 다르게 보인다.
 *  - 셀 isOff=true → 모든 직원 "(휴무)"
 *  - 직원이 그 날짜를 휴무로 정함 → "(휴무)"
 *  - 정한 적 없음 + 사업장 운영시간을 앎 → 기관 시간으로 표기
 *  - 정한 적 없음 + 기관 운영시간도 모름 → 표기하지 않음(화면정의서 §2-1)
 *  - 그 외 → "이름 09:00 ~ 14:00"
 * effective: date override > weekly recurring
 *
 * isDesignated = 그 (직원, 날짜)에 일자 지정이 걸려 있다 → 셀에서 그 줄만 강조한다(화면정의서 APB033 §6-2
 * "해당 운영시간만 하이라이트되어 표시"). 요일 반복만 따르는 줄과 눈으로 갈리지 않으면
 * 어느 날을 따로 지정해 뒀는지 캘린더에서 확인할 방법이 없다.
 * 사업장 휴무일에도 억제하지 않는다 — 직원별 판정이 갈리면서(지정 운영은 기관 휴무를 이긴다, R11)
 * 그런 날일수록 "이 줄만 지정"이라는 신호가 필요해졌다. */
function formatListEntries(doctorIds, date, dateKey) {
  const weekday = date.day();
  const entries = [];
  /* cascade(사용자 모델): 담당자별 운영시간 → (미설정이면)사업장 운영시간(⚙ TB) → (그것도 모르면)미표기.
   *  - 휴무 여부는 직원마다 담당자 축(isDisplayedOffFor, §4-2)으로 판정한다. 셀의 isOff(사업장 축)를
   *    그대로 덮으면 공휴일 운영('Y')·기관 휴무 요일의 명시적 운영(R11)로 정한 담당자까지 (휴무)이 된다 —
   *    날짜 옆 '휴무' 라벨(사업장 축)과 직원 리스트(각자 판정)는 축이 다르다(화면정의서 APB031 §2-1).
   *    명시적 휴무(요일·일자)·매월 규칙은 모두 이 판정에 접혀 있어 별도 분기가 필요 없다.
   *  - ★"휴무로 정함"과 "아직 안 정함"을 갈라야 한다. 예전에는 둘 다 운영 구간이 없다는 이유로
   *    똑같이 "(휴무)"으로 찍었는데, 그래서 사업장 운영시간을 못 불러온 것뿐인데도
   *    전원이 휴무로 보였다. 쉬기로 한 것과 모르는 것은 다르다. */
  /* 빌려 쓸 값: 사업장의 그 날짜 운영시간 → 그것도 없으면 보드·타임라인이 여는 기본 운영시간.
   * (기관 조회 실패 상태에서는 defaultWorkBlocks 가 비어 종전대로 미표기다.) */
  const dayBlocks = institutionBlocksOn(date, weekday);
  const borrowed = dayBlocks.length > 0 ? dayBlocks : defaultWorkBlocks();
  const institutionBlocks = borrowed.length > 0 ? borrowed : null;
  for (const id of doctorIds) {
    const name = getDoctor(id)?.text;
    if (!name) continue;
    const ownerKey = `STAFF:${id}`;
    const blocks = getEffectiveBlocks(ownerKey, dateKey, weekday);
    /* entry 는 name·time 분리(퍼블리싱 셀 렌더링) + label(테스트·popover 겸용)을 함께 담는다. */
    const isDesignated = workingHoursOverridesByOwner.value.get(ownerKey)?.has(dateKey) === true;
    if (isDisplayedOffFor(ownerKey, date)) {
      entries.push({staffId: id, name, time: '(휴무)', label: `${name} (휴무)`, isOff: true, isDesignated});
    } else if (blocks.length > 0) {
      const time = formatBlocksRange(blocks);
      /* isInvalid — [X] 로 검증을 건너뛰고 닫으면 반쪽·형식오류 값이 셀에 그대로 남는다.
       * 저장 게이트가 막은 뒤 어느 줄인지 가리키는 표시다(담당자 7행 표의 data-invalid 와 같은 규약). */
      entries.push({staffId: id, name, time, label: `${name} ${time}`, isOff: false, isDesignated,
        isOwn: true, isInvalid: blocksInvalid(blocks)});
    } else if (institutionBlocks) {
      /* 담당자별 미설정(공휴일 운영 'Y'인데 자기 시간이 없는 경우 포함) → 사업장 운영시간으로 표기.
       * 원천은 외부 시스템(사업장 운영시간 테이블)이다 — 자체 DB 에는 이 테이블이 없다.
       * isInherited 로 갈라 둔다: 빌린 값과 자기 값이 똑같이 생기면, 사업장 운영시간을 지웠을 때
       * 표기가 사라지는 것을 "담당자 운영시간이 삭제됐다"고 읽게 된다(showsInheritedStaffTime). */
      const time = formatBlocksRange(institutionBlocks);
      entries.push({staffId: id, name, time, label: `${name} ${time}`, isOff: false, isDesignated,
        isInherited: true, isInvalid: blocksInvalid(institutionBlocks)});
    }
    /* 미설정인데 사업장 운영시간도 모르는 직원은 표기하지 않는다 — 화면정의서(§2-1)는
     * 운영하는 직원의 시간과 휴무 직원의 (휴무)만 정의한다. 휴무로 정한 적이 없는데
     * (휴무)으로 찍으면 거짓이고, 기관 조회 실패 상태는 배너·저장차단이 따로 알린다. */
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
  settleTimePopovers(); // 열려 있던 편집기는 닫고 하나만 띄운다
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
  /* 위치 계산은 호출처 책임이라(CellMorePopover 는 셸일 뿐) 여기서 접는다.
   * 셸에 ref 를 뚫는 대신 DOM 으로 찾는다 — 이 popover 는 한 번에 하나만 열린다. */
  void settlePopoverPos(() => document.querySelector('.cellMorePopover'), cellMorePopover, rect, clampOverlayPos);
}

function closeCellMore() {
  if (!cellMorePopover.value.open) return;
  cellMorePopover.value = {...cellMorePopover.value, open: false};
}

/* ===== 셀 × 직원 popover editor (날짜별 override 편집) =====
 * weekdayEditor 와 같은 UI 지만 키가 (ownerKey, dateKey) — 그 날짜 한정 override.
 * draft 폴백 순서: 기존 지정 → 담당자 그 요일 → 사업장 그 요일 (getStaffWeekdayBlocks) */
const cellStaffEditor = ref({
  open    : false,
  ownerKey: null,
  dateKey : null,
  weekday : 0,
  top     : 0,
  left    : 0,
  draft   : null,
});

function buildCellStaffDraft(ownerKey, dateKey, weekday) {
  const override = workingHoursOverridesByOwner.value.get(ownerKey)?.get(dateKey);
  /* 지정이 없으면 셀 라벨과 같은 cascade 를 프리필한다 — 담당자 요일값, 미설정이면 사업장 요일값.
   * 셀에 보이던 시간이 그대로 입력칸에 들어와야 "무엇을 고치는지"가 화면과 어긋나지 않는다. */
  const source = override !== undefined ? override : getStaffWeekdayBlocks(ownerKey, weekday);
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
  /* 다른 시간 popover(요일 편집·이전 일자 지정·더보기)는 먼저 정리한다 — 한 번에 하나만. */
  settleTimePopovers();

  const rect = event.currentTarget.getBoundingClientRect();
  cellStaffEditor.value = {
    open    : true,
    ownerKey,
    dateKey,
    weekday,
    ...clampPopoverPos(rect, POPOVER_FALLBACK_WIDTH, POPOVER_FALLBACK_HEIGHT),
    draft   : buildCellStaffDraft(ownerKey, dateKey, weekday),
  };
  void settlePopoverPos(() => cellStaffEditorEl.value, cellStaffEditor, rect, clampPopoverPos);
}

function setCellStaffBlockTime(kind, field, value) {
  const draft = cellStaffEditor.value.draft;
  if (!draft) return;
  cellStaffEditor.value = {
    ...cellStaffEditor.value,
    draft: {...draft, [kind]: {...draft[kind], [field]: value}},
  };
}

function onCellStaffTimeInput(event, kind, field) {
  commitTimeInput(event, v => setCellStaffBlockTime(kind, field, v));
}

/* 운영 블록 목록이 같은가 — 단일 구간(WORK)이라 kind·시작·종료만 보면 된다. */
function sameBlocks(a, b) {
  return a.length === b.length
      && a.every((x, i) => x.kind === b[i].kind && x.start === b[i].start && x.end === b[i].end);
}

/* draft 를 지정(override)으로 옮기고 닫는다. 요일 편집기와 같은 규약 —
 * 여기서는 검증하지 않고, 캡처 가드와 저장 게이트가 나눠 맡는다. */
function commitCellStaffEditor() {
  const {ownerKey, dateKey, weekday, draft} = cellStaffEditor.value;
  if (!ownerKey || !dateKey || !draft) {
    closeCellStaffEditor();
    return;
  }
  const blocks = draftToBlocks(draft);

  /* ★열어보기만 하고 닫았다면 지정을 만들지 않는다 — 프리필과 값이 같으면 "지정 없음"을 유지한다.
   * 요일 7행의 "고친 요일만 확정한다" 와 같은 규율이다. 지정이 생겨 버리면 그 날짜가 그 시각으로
   * 굳어, 이후 담당자 요일값·사업장 값을 바꿔도 따라오지 않고 하이라이트까지 켜진다.
   * 이미 지정이 있는 날은 값이 같아도 지우지 않는다 — 사용자가 그 날을 명시적으로 정해 둔 것이다. */
  const hadDesignation = workingHoursOverridesByOwner.value.get(ownerKey)?.has(dateKey) === true;
  if (!hadDesignation && sameBlocks(blocks, getStaffWeekdayBlocks(ownerKey, weekday))) {
    closeCellStaffEditor();
    return;
  }

  const next = new Map(workingHoursOverridesByOwner.value);
  const dayMap = new Map(next.get(ownerKey) ?? []);

  /* ★시간을 모두 비우는 것은 "그 날짜 지정 해제(미설정)" 다 — 휴무가 아니다.
   * 휴무는 휴무일 탭이 정한다(탭 책임 분리). 여기서 휴무 override 를 만들면 같은 상태를
   * 두 화면이 만들게 되고, 휴무일 탭이 잠가 둔 날을 운영시간 탭이 다시 열어버린다.
   * 지정을 지우면 그 날짜는 요일 규칙·기관 값을 다시 따라간다. */
  if (blocks.length === 0) dayMap.delete(dateKey);
  else dayMap.set(dateKey, blocks);

  next.set(ownerKey, dayMap);
  workingHoursOverridesByOwner.value = next;
  closeCellStaffEditor();
}

function closeCellStaffEditor() {
  cellStaffEditor.value = {...cellStaffEditor.value, open: false, draft: null};
}

/* 캘린더 셀 계산 — 조회 단위 셋(직원·팀·사업장)이 모두 entries[] 를 쓴다.
 * 대상 직원 목록만 다르고 라벨 판정은 하나뿐이다(formatListEntries). */
function buildMonthCells(year, month, offOwnerKey = OFF_OWNER_INSTITUTION) {
  const startOfMonth = dayjs(`${year}-${String(month).padStart(2, '0')}-01`);
  const endOfMonth = startOfMonth.endOf('month');

  const gridStart = startOfMonth.subtract(startOfMonth.day(), 'day');
  const gridEnd = endOfMonth.add(6 - endOfMonth.day(), 'day');

  /* 대상 직원은 셀마다 같다 — 루프 밖에서 한 번만 구한다(월 42셀 × 팀 순회를 피한다). */
  const doctorIds = getCalendarDoctorOrder(getCalendarOwner());

  const cells = [];
  let cursor = gridStart;

  while (cursor.isBefore(gridEnd) || cursor.isSame(gridEnd, 'day')) {
    const isCurrentMonth = cursor.month() === startOfMonth.month();
    const key = cursor.format('YYYY-MM-DD');

    /* 국가 공휴일 — 그 대상이 공휴일에 쉬기로 했고 현재 달 셀일 때만 빨간날 표기(휴무 라벨은 isOff 가 담당). */
    const isHoliday = isCurrentMonth && holidayOffFor(offOwnerKey) && isHolidayDate(cursor);

    /* 우선순위 = 일자별 지정(override) > 공휴일 체크박스 > 반복 휴무요일.
     * 지정한 것이 일반 규칙을 이긴다 — BE 운영중 판정(McsService)도 일자별 운영시간을 먼저 본다.
     * (공휴일이라도 임시운영으로 지정했으면 운영다.)
     * 담당자를 보고 있으면 그 담당자 축으로 판정하고, 정하지 않은 날은 사업장 판정을 상속한다. */
    const isOff = isCurrentMonth && isDisplayedOffFor(offOwnerKey, cursor);

    const entries = isCurrentMonth ? formatListEntries(doctorIds, cursor, key) : null;

    cells.push({
      key,
      dayNumber: cursor.date(),
      weekday  : cursor.day(),
      isCurrentMonth,
      isOff,
      isHoliday,
      entries,
    });

    cursor = cursor.add(1, 'day');
  }

  return cells;
}

/* 휴무일 탭 12개월 뷰어 — 선택한 대상(사업장 / 담당자)의 휴무일을 그린다(§4-5-2). */
const yearMonths = computed(() =>
    Array.from({length: 12}, (_, i) => ({
      key  : `${selectedYear.value}-${String(i + 1).padStart(2, '0')}`,
      label: `${i + 1}월`,
      cells: buildMonthCells(selectedYear.value, i + 1, selectedOffOwner.value),
    }))
);

const monthCells = computed(() =>
    buildMonthCells(selectedYear.value, selectedMonth.value)
);

/* 선택 연도 공휴일 보장 — 이미 로드된 연도는 no-op. 연 이동 시 자동 보충 */
watch(selectedYear, (y) => holidayStore.ensureYears([y]), {immediate: true});

/* ===== 닫을 때의 시간 검증 =====
 * 사용자가 popover 바깥을 눌러 닫으려 할 때, 저장까지 미루지 않고 그 자리에서 잡는다.
 * 판정은 저장 게이트와 같은 3단(findDraftTimeViolation) — 문구도 순서도 같다.
 *
 * ★캡처 단계에 붙는다. 배경 요소의 @click(패널 접기·탭 이동·다른 popover 열기)보다 **먼저** 보고
 *  클릭 자체를 삼켜야 하기 때문이다. 버블에서 막으면 배경은 이미 바뀐 뒤라 popover 만 앵커를 잃고
 *  body 에 떠 있게 된다 — 되돌렸던 구현(14252b6)이 정확히 그 상태였다.
 * ★바깥 클릭은 **매번** 막는다. 덫이 되지 않는 이유는 popover 우상단의 [X] 가 검증 없이 닫아 주기
 *  때문이다 — 이 둘은 한 쌍이라 X 를 떼면 나갈 길이 없어진다(14252b6 의 두 번째 사고).
 * ★막는 범위는 **설정 팝업 안쪽 클릭까지**다. 팝업 바깥 여백과 ESC 는 DxPopup 이 click 이 아니라
 *  pointerdown·keydown 으로 먼저 닫으므로(devextreme ui.overlay 의 _outsideClickHandler) 여기까지
 *  오지 않는다. 그 경로는 부모가 settlePopovers 로 정리하고 미저장 확인창을 띄우며, 잘못된 값은
 *  저장 게이트가 받는다 — 검증이 비는 것이 아니라 **막는 주체가 다르다.**
 * ★스크롤·리사이즈는 검증하지 않는다. popover 가 fixed 라 유지하면 버튼과 어긋난 자리에 떠 버리고,
 *  애초에 사용자가 닫으려 한 조작도 아니다. */

/* 지금 열려 있는 시간 편집 popover — {draft, el}. 없으면 null. 더보기는 입력칸이 없어 대상이 아니다. */
function openTimeEditor() {
  if (weekdayEditor.value.open) {
    const {draft, ownerKey, weekday} = weekdayEditor.value;
    return {draft, ownerKey, weekday, el: weekdayEditorEl.value};
  }
  if (cellStaffEditor.value.open) return {draft: cellStaffEditor.value.draft, el: cellStaffEditorEl.value};
  return null;
}

function onDocumentClickCapture(event) {
  if (dialogBusy.value) return; // 안내의 [확인] 클릭이 여기로 돌아온다
  const editor = openTimeEditor();
  if (!editor) return;
  if (editor.el?.contains?.(event.target)) return; // popover 안쪽([X] 포함)은 닫으려는 조작이 아니다
  const message = findDraftTimeViolation(editor.draft, editor);
  if (!message) return;

  event.stopPropagation(); // 배경 @click 도 아래 버블의 닫기도 이 한 줄로 함께 멈춘다
  void blockCloseWithTimeError(message);
}

async function blockCloseWithTimeError(message) {
  saveTried.value = true; // 미완성 칸을 그 자리에서 빨갛게 — 저장 게이트와 같은 규약
  await alertTimeError(message);
  focusFirstInvalidInput(); // 모달이 가져간 포커스를 그 칸으로 되돌린다
}

/* 드롭다운 외부 클릭 시 닫기
 * 토글 버튼/패널에 @click.stop 이 걸려있어 내부 클릭은 document로 전파되지 않음.
 * 시간 popover 는 외부 클릭이면 commit·닫힘(확인 버튼 없는 즉시반영 UX) — 사업장 행·다른 패널·
 * 탭을 눌러도 popover 가 떠 있는 채로 남지 않는다. 시간 오류가 남아 있는 동안은 위 캡처 가드가 삼킨다.
 *
 * ★안내 다이얼로그가 떠 있는 동안에는 아무것도 하지 않는다.
 *   다이얼로그는 팝업 바깥(모달)에 그려지므로 [확인] 클릭이 document 까지 올라온다.
 *   저장 게이트 안내 뒤에 열린 드롭다운이 그 클릭으로 닫히는 것을 막는다. 스크롤/리사이즈 경로도 같다. */
function handleDocumentClick() {
  if (dialogBusy.value) return;
  settleAllPopovers();
}

/* fixed 위치 드롭다운은 사이드바 스크롤/창 리사이즈 시 버튼과 분리됨 → 닫음 */
function handleScrollOrResize() {
  if (dialogBusy.value) return;
  settleAllPopovers();
}

/* 떠 있는 레이어를 한 번에 정리한다 — 드롭다운은 닫고, 시간 편집기는 draft 를 상태로 옮기고 닫는다.
 * 부르는 곳 셋: document 클릭 · 스크롤/리사이즈 · **설정 팝업이 닫힐 때**(부모가 settlePopovers 로).
 *
 * ★이 셋이 같은 목록을 봐야 한다. 레이어는 Teleport 로 body 에 그려져 설정 팝업 DOM 밖에 있으므로,
 *  팝업이 닫혀도 스스로 사라지지 않는다 — 목록에서 빠진 레이어는 팝업이 사라진 스케줄러 화면 위에
 *  그대로 떠 있게 된다(실제 사고). 새 popover 를 만들면 여기에 반드시 추가한다.
 * ★확인 오버레이(confirmDialog)는 뺀다 — 그건 isDialogBusy 로 팝업 닫힘 자체를 막는 쪽이다. */
function settleAllPopovers() {
  if (staffPicker.value.open) closeStaffPicker();
  if (teamMenu.value.open) closeTeamMenu();
  settleTimePopovers();
}

/* 서버 → 내부 state 변환 — 팀만 담당한다.
 * ★조회는 GET /site/teams(자체 DB 전용) 로 한다. /site/settings 는 팀에 휴무 규칙(원천 외부 시스템)을 번들해
 *   BE 가 사업장 설정 응답을 기다린 뒤에야 팀을 내려주므로, 사업장 설정 장애 시 팀·구성원 표시까지 함께 멈췄다.
 * 휴무 규칙(recurringOffRules/workDates/offDates/holidayClosedYn) baseline 은 site strict 번들에서 받는다
 * (applyOffRulesBaseline). 원천이 사업장 설정라 운영시간과 원자적으로 읽어 저장 게이트와 정합을 맞춘다.
 * - teams.id는 서버 number → 클라 string으로 변환 (신규 팀 TEAM_xxx 패턴과 통일)
 * - doctorIds 는 응답 doctors[].staffId 로 조립 */
async function hydrateFromServer() {
  try {
    const res = await getTeams();
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
      doctorIds: (t.doctors ?? []).map(d => d.staffId),
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

/* blocks → 운영 시작/종료("HHmm") 쌍. 한쪽만 입력된 중간 상태는 휴무(null)으로 보낸다. */
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
 * 운영하는 요일 행만 보낸다. BE 는 site 에서 생략된 요일을 "행 없음"으로만 처리한다 —
 * 휴무는 site 생략이 아니라 recurringOffRules(WEEKLY)로 표현해야 사업장 설정에 휴무로 남는다(#휴무 이중표현).
 *
 * ★정합성: 매주 휴무(WEEKLY)인 요일은 site 운영행으로 내보내지 않는다.
 *  화면에서 그 요일에 운영시간이 남아 있어도(휴무일 탭에서 나중에 휴무 지정한 경우) 휴무 규칙이 우선이다
 *  — site 에도 넣으면 "운영행 + 휴무규칙" 이 동시에 나가 사업장 설정에서 모순이 된다. 여기서 skip 해 recurringOffRules 로만 표현한다.
 * 휴게 미설정은 HM null 로 표현한다. */
function buildInstitutionTimesPayload() {
  const rows = [];
  for (let w = 0; w < 7; w++) {
    if (isWeekdayClosed(w)) continue;         // 매주 휴무 요일 → recurringOffRules 로만 (site 운영행 금지)

    const blocks = institutionWeeklyDayMap.value.get(w) ?? [];
    if (blocks.length === 0) continue;

    const work = blocksToWorkRange(blocks);
    if (!work.start || !work.end) continue;   // 운영 구간이 온전치 않은 요일은 보내지 않는다(= 휴무)

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
 * 공휴일 휴무(체크박스 ON)이어도 값은 그대로 실어 보낸다 — 지우면 다시 운영으로 되돌렸을 때 시간이 사라진다.
 *
 * ★운영 구간을 비웠으면 null 이 아니라 **전 필드 null 인 객체**를 보낸다.
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
   * 끌어다 채우지 않기 때문이다. 사업장 설정 조회 실패 중이라 해서 따로 걸러낼 필요가 없다. */
  /* ★대상은 세 상태의 **합집합**이다 — 운영시간은 한 번도 안 정했지만 매월 휴무가나 공휴일만
   *  정한 담당자가 있다. 운영시간 표만 순회하면 그 사람이 통째로 빠져 저장되지 않는다. */
  const staffKeys = new Set();
  for (const source of [workingHoursByOwner.value, staffMonthlyOffs.value, staffHolidayOff.value]) {
    for (const key of source.keys()) {
      if (key.startsWith('STAFF:')) staffKeys.add(key);
    }
  }

  const staff = [];
  for (const key of staffKeys) {
    staff.push({
      staffId : Number(key.slice('STAFF:'.length)),
      times          : dayMapToTimes(workingHoursByOwner.value.get(key)),
      monthlyOffRules: monthlyOffRulesOf(key),
      /* 미설정은 null 로 보낸다 — BE 가 거래처 전체를 NULL 로 리셋한 뒤 요청분만 확정한다. */
      holidayOpenYn     : staffHolidayOff.value.get(key) ?? null,
    });
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
 * 운영 여부 판단은 시작·종료 HM 존재 여부다. */
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

/* 응답 dateTimes → institutionDateDayMap.
 * 보드(staffStore.dateTimesToDailyMap)와 같은 규약이다:
 *  - `closed`(임시휴무) 인 날짜는 담지 않는다 — 휴무는 dateOverrides 가 갖고 있고, 시간과 섞으면 판정이 흐려진다.
 *  - 시작·종료가 온전한 행만 담는다. 반쪽 행은 담지 않아 종전 폴백(공휴일 → 요일 → 기본값)으로 내려간다. */
function applyInstitutionDateTimes(rows) {
  const next = new Map();
  for (const row of rows ?? []) {
    if (!row?.date || row.closed) continue;
    const start = hmmToHHMM(row.openHm);
    const end = hmmToHHMM(row.closeHm);
    if (start && end) next.set(row.date, [{kind: 'WORK', start, end}]);
  }
  institutionDateDayMap.value = next;
}

/* site strict 번들의 휴무 규칙 → 편집 baseline (weekdayOffs/dateOverrides/공휴일).
 * 휴무 규칙의 원천도 사업장 설정이므로, 운영시간과 함께 site 응답으로 strict 하게 받는다
 * (teams 만 getTeams 로 별도 조회). recurringOffRules 는 매주(WEEKLY)와 매월 n번째(MONTHLY_n) 로 정규화. */
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
          applyInstitutionDateTimes(sitePayload.dateTimes);
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
    const monthlyNext = new Map();
    const holidayNext = new Map();
    for (const staffRow of staffPayload.staff ?? []) {
      const key = `STAFF:${staffRow.staffId}`;
      weeklyNext.set(key, timesToDayMap(staffRow.times));

      /* 매월 N번째 휴무 — 요일별 Set 으로 되접어 사업장 weekdayOffs 와 같은 모양으로 만든다. */
      const monthlyDayMap = new Map();
      for (const rule of staffRow.monthlyOffRules ?? []) {
        if (rule?.dayCd == null || rule?.monthlyNth == null) continue;
        const options = monthlyDayMap.get(rule.dayCd) ?? new Set();
        options.add(`MONTHLY_${rule.monthlyNth}`);
        monthlyDayMap.set(rule.dayCd, options);
      }
      if (monthlyDayMap.size > 0) monthlyNext.set(key, monthlyDayMap);

      /* null(미설정)은 담지 않는다 — 키가 없는 것이 곧 "사업장 판정 상속" 이다. */
      if (staffRow.holidayOpenYn === 'Y' || staffRow.holidayOpenYn === 'N') holidayNext.set(key, staffRow.holidayOpenYn);
    }
    workingHoursByOwner.value = weeklyNext;
    staffMonthlyOffs.value = monthlyNext;
    staffHolidayOff.value = holidayNext;

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
  document.addEventListener('click', onDocumentClickCapture, true); // 배경 @click 보다 먼저 봐야 한다
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
  document.removeEventListener('click', onDocumentClickCapture, true);
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
  staffMonthlyOffs,
  staffHolidayOff,
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
/* 담당자 매월 휴무·공휴일도 workingHours 파트로 나간다(staff[] 의 필드) — 여기에 넣지 않으면
 * 그 둘만 고쳤을 때 dirty 로 잡히지 않아 저장 API 자체가 스킵된다(계획서 G3). */
const WORKING_HOURS_STATE_KEYS = ['workingHoursByOwner', 'workingHoursOverridesByOwner', 'staffMonthlyOffs', 'staffHolidayOff'];
const SITE_STATE_KEYS = ['weekdayOffs', 'dateOverrides', 'includePublicHolidays', 'institutionWeeklyDayMap', 'institutionBreaksByWeekday',
  'institutionHolidayDayMap', 'institutionHolidayBreaks'];

/* 공휴일 운영 여부·운영시간을 이번에 건드렸는가 — 공휴일 시간 필수 가드의 발동 조건.
 * 운영일정 설정 전체가 아니라 이 셋만 본다: 예전에 저장된 "운영인데 시간 없음" 상태는 그대로 둔 채
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
  /* ★운영시간을 정하지 않은 요일은 '매주 휴무'으로 명시해 내보낸다(배너가 미리 알린다).
   * site 운영행에서 빼는 것만으로는 원천에 휴무로 남지 않는다 — 그건 "행 없음"(미설정)이고,
   * 휴무는 recurringOffRules(WEEKLY)로만 표현된다(#휴무 이중표현 — buildInstitutionTimesPayload).
   * 그 자리를 비워 두면 원천은 미설정으로 두는데 자체 보드는 기본 운영시간(useSchedulerRules 의
   * DEFAULT_OPEN_DAILY)으로 열어 예약을 받아, 같은 요일을 두 시스템이 다르게 읽는다.
   * 원천(마이페이지)이 "운영시간이 모두 없으면 휴무"으로 읽는 것과 같은 결론을 명시로 남긴다.
   * missingTimeWeekdays 는 반복 휴무(매주·매월)이 있는 요일을 빼므로 위 루프와 같은 dayCd 가 겹치지 않는다. */
  for (const weekday of missingTimeWeekdays.value) {
    recurringOffRules.push({dayCd: weekday, repeatTy: 'WEEKLY', monthlyNth: null});
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
    /* 사업장(site) 운영시간 — 운영하는 요일 행만. 원천 사업장 설정. 보낼 땐 반드시 완전상태로
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
/* 띄우는 동안 팝업 닫힘을 막는다. 호출은 전부 withDialog 를 지난다(useDialogGuard — 해제는 한 tick 뒤,
 * [확인] 클릭과 팝업 hiding 이 같은 클릭에서 이어지기 때문. 서비스 항목 설정·예약 팝업과 같은 가드). */
const {dialogOpen: dialogBusy, withDialog} = useDialogGuard();

/* 시간 오류(미완성·형식·순서)를 알릴 때 — 안내의 [확인] 클릭이 팝업 외부클릭으로 이어져 팝업이
 * 닫히면 입력이 사라진다. 부르는 곳은 둘 — 저장 버튼(onSave)과 popover 바깥 클릭(blockCloseWithTimeError).
 * popover commit 에서는 부르지 않는다: commit 은 스크롤·리사이즈와 [X] 로도 들어온다. */
async function alertTimeError(message) {
  if (dialogBusy.value) return;
  await withDialog(() => dialog.alert(message, {title: '운영시간 입력'}));
}

/* 공휴일 운영인데 공휴일 운영시간이 비어 있을 때. 안내만으로는 어디를 고칠지 알 수 없어
 * 운영시간 탭 + 사업장 패널을 펼쳐 공휴일 행이 화면에 보이게 한 뒤 띄운다. */
async function alertHolidayTimeRequired() {
  activeLeftTab.value = 'WORKING_HOURS';
  expandedTreatmentKey.value = 'institution';
  await withDialog(() => dialog.alert(HOLIDAY_TIME_REQUIRED_MSG, {title: '공휴일 운영시간 입력'}));
}

/* 구성원이 없는 팀 — 저장 전에 막는다. 어느 팀인지는 문구가 아니라 화면 하이라이트가 알린다
 * (호출부에서 saveTried 를 켠다). 상태는 건드리지 않는다 — 사용자가 사람을 넣거나 팀을 지우면 된다. */
async function alertTeamMembersRequired() {
  await withDialog(() => dialog.alert(TEAM_MEMBERS_REQUIRED_MSG, {title: '구성원 선택'}));
}

async function alertServiceUnavailable() {
  await withDialog(() => dialog.alert(SERVICE_UNAVAILABLE_MSG, {title: '서비스 이용 안내'}));
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

  /* 열려 있는 popover 의 draft 를 먼저 상태로 옮긴다 — 저장은 상태만 보므로, 정리하지 않으면
   * 방금 입력한 값이 저장에서 통째로 빠진다. 배경 클릭 정리(handleDocumentClick)는 버블이라
   * 저장 버튼 @click 보다 **뒤에** 돌아, 이 자리를 대신하지 못한다.
   * 시간 게이트보다 앞이어야 한다: 게이트가 그 draft 까지 보고 판정해야 한다. */
  settleAllPopovers();

  /* ★시간 게이트 — 시작·종료 중 한쪽만 채워진 행, 형식(HH:MM) 오류, 순서(시작<종료) 역전이 남아
   * 있으면 저장하지 않는다. popover 바깥 클릭도 같은 3단을 보지만 [X] 로 건너뛸 수 있으므로,
   * 반드시 막는 곳은 여기다. 그대로 보내면 짝이 안 맞는 행이 휴무(null)으로 저장돼 시간을 입력해 둔
   * 요일이 쉬는 날로 뒤집히고, "2590" 같은 값은 콜론만 떼여 서버로 나간다. */
  const violation = findTimeGateViolation();
  if (violation) {
    /* 안내만으로는 어느 칸인지 알 수 없다 — 패널을 펼치고 그 요일/날짜 popover 를 다시 열어
     * 빈 칸을 가리킨다(접힌 패널·닫힌 popover 에 빨간 테두리를 그려 봐야 화면에 없다). */
    saveTried.value = true;
    await revealTimeGateViolation(violation);
    await alertTimeError(violation.message);
    focusFirstInvalidInput(); // 모달이 가져간 포커스를 그 칸으로 되돌린다
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
  /* ★고친 것이 없어도 **자동 보정할 요일이 있으면** site 파트를 보낸다(missingTimeWeekdays).
   * 그 보정은 사용자가 고친 값이 아니라 화면이 만드는 값이라 isDirtyIn 이 잡지 못한다 — 여기서
   * 세지 않으면 "보낼 게 없다"로 빠져 저장 API 자체가 나가지 않고, 배너가 예고한 '매주 휴무'이
   * 아무 일도 없이 사라진다(안내가 거짓이 된다). 저장을 눌렀다는 것이 그 안내에 대한 의사표시다. */
  const siteDirty = canSaveSite.value && (siteEdited || missingTimeWeekdays.value.length > 0);

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

  /* ★이름만 있고 구성원이 없는 팀은 저장하지 않는다.
   * 팀을 이번에 실제로 보낼 때만 본다 — 이미 저장돼 있던 빈 팀 때문에 무관한 저장까지 막으면
   * 덫이 된다(아래 공휴일 가드와 같은 규약). 서버는 이 상태를 거부하지 않으므로 여기서 막지 않으면
   * 구성원 없는 팀이 그대로 저장된다. */
  if (teamDirty) {
    /* 시간 미완성 칸과 같은 규약 — 넘어가려 시도한 뒤에만 그린다. 빈 팀이 여럿이면 전부 표시된다.
     * 시도할 때마다 다시 계산해, 그 사이 채운 팀은 빠지고 새로 만든 팀은 아직 들어오지 않는다. */
    const emptyTeamIds = teams.value.filter(t => !t.doctorIds?.length).map(t => t.id);
    emptyTeamsAtSave.value = new Set(emptyTeamIds);
    if (emptyTeamIds.length) {
      await alertTeamMembersRequired();
      return;
    }
  }

  /* ★공휴일 운영(체크 해제)로 저장하려면 공휴일 운영시간이 있어야 한다.
   * site 를 실제로 보내면서 **공휴일 설정을 이번에 건드렸을 때만** 본다 — 이미 저장돼 있던
   * "운영인데 시간 없음" 상태 때문에 무관한 저장까지 막으면 덫이 된다(HOLIDAY_STATE_KEYS 주석 참조). */
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
  /* 설정 팝업이 닫히기 직전에 부모가 부른다. 두 가지를 한꺼번에 해결한다 —
   * ① body 로 teleport 된 popover 가 팝업만 사라진 화면에 남는 것을 막고,
   * ② 아직 draft 로만 있던 입력을 상태로 옮겨 isDirty() 가 그것까지 보게 한다.
   * 순서가 뜻이 있다: 부모는 이걸 부른 **뒤에** isDirty() 를 물어야 한다. */
  settlePopovers: settleAllPopovers,
  /* 다이얼로그가 떠 있는 동안 부모가 팝업을 닫지 않게 한다 — 안내 [확인] 클릭이
   * 곧바로 "저장하지 않고 닫으시겠습니까?"로 이어지던 문제를 막는다.
   * 인라인 확인창(confirmDialog)도 같은 이유로 포함한다. */
  isDialogBusy: () => dialogBusy.value || confirmDialog.value != null,
});
</script>

<template>
  <div
      ref="rootEl"
      class="schedulerTreatmentSetting"
  >
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
            @click="unassignedDataModalOpen = true"
        >미지정 데이터 설정</button>
      </div>

      <section
          v-if="activeLeftTab === 'OFF'"
          class="schedulerTreatmentSetting__section institution-section"
      >
        <!-- 사업장도 선택 단위다 — 우측 12개월 캘린더가 무엇을 그릴지 이 선택이 정한다.
             선택 표시는 운영시간 탭(__institutionRow.is-expanded)과 같은 색을 쓴다. -->
        <header
            :class="{ 'is-selected': selectedOffOwner === OFF_OWNER_INSTITUTION }"
            class="schedulerTreatmentSetting__sectionHeader schedulerTreatmentSetting__sectionHeader--selectable"
            @click="selectOffOwner(OFF_OWNER_INSTITUTION)"
        >
          사업장
        </header>
        <!-- 요일별·특정일자·공휴일 컨트롤은 사업장과 담당자가 같은 컴포넌트를 쓴다(§4-5-3).
             선택된 대상 아래에만 펼쳐진다 — 두 패널이 함께 떠 있으면 우측 캘린더가 어느 쪽을
             그리는지 알 수 없다. -->
        <SchedulerSettingsOffDayControls
            v-if="selectedOffOwner === OFF_OWNER_INSTITUTION"
            v-bind="offControlsProps"
            @toggle-option="onOffOptionToggle"
            @remove-range="removeSpecificRange"
            @set-holiday="onOffHolidayChange"
        />
      </section>

      <template v-if="activeLeftTab === 'OFF'">
      <section
          v-for="team in teams"
          :key="team.id"
          class="schedulerTreatmentSetting__section team-section"
      >
        <!-- 팀은 선택 단위가 아니다(휴무는 사업장·담당자에만 붙는다) — 이름 변경과 ⋯ 메뉴만 갖는다.
             ★단 drop 은 받는다 — 구성원이 0명인 팀은 아래 칩 리스트가 빈 상태라, 사람이 겨냥하는
             곳은 사실상 팀명 줄이다. 여기서 받지 않으면 "끌어다 놓아도 아무 일이 없는" 상태가 된다. -->
        <header
            class="schedulerTreatmentSetting__teamHeader"
            @dragover="onChipListDragOver($event, team.id)"
            @drop="onChipListDrop($event, team.id)"
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
          >⋮</button>
        </header>

        <ul
            v-if="team.doctorIds.length"
            class="schedulerTreatmentSetting__chipList schedulerTreatmentSetting__chipList--member"
            @dragover="onChipListDragOver($event, team.id)"
            @drop="onChipListDrop($event, team.id)"
        >
          <li
              v-for="(docId, idx) in team.doctorIds"
              :key="docId"
              :class="{
                'is-dragging'   : chipDrag.active && chipDrag.sourceTeamId === team.id && chipDrag.sourceIndex === idx,
                'is-drop-target': chipDrag.active && chipDrag.targetTeamId === team.id && chipDrag.targetIndex === idx
                    && !(chipDrag.sourceTeamId === team.id && chipDrag.sourceIndex === idx),
                'is-selected'   : selectedOffOwner === staffOffOwnerKey(docId),
              }"
              class="schedulerTreatmentSetting__chip schedulerTreatmentSetting__chip--selectable"
              @click="selectOffOwner(staffOffOwnerKey(docId))"
              @dragover="onChipDragOver($event, team.id, idx)"
              @drop="onChipDrop($event, team.id, idx)"
              @dragend="onChipDragEnd"
          >
            <!-- ★드래그는 ≡ 그립에서만 시작한다 — 이름까지 draggable 이면 row 내부가 전부 드래그 존이 돼
                 선택 클릭이 (몇 px 움직임에도 drag 로 해석되어) 가장자리 여백에서만 먹는다. drop 대상은 칩(li) 그대로다. -->
            <span class="schedulerTreatmentSetting__chipHandle">
              <span
                  aria-hidden="true"
                  class="schedulerTreatmentSetting__chipHandleGrip"
                  draggable="true"
                  @dragstart="onChipDragStart($event, team.id, docId, idx)"
              >≡</span>
              <span>{{ getDoctor(docId)?.text }}</span>
            </span>
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

        <!-- ★구성원이 0명이면 위 칩 리스트는 높이가 0 이라 드롭 대상이 되지 못한다(핸들러는 있어도
             dragover 가 일어나지 않는다). 신규 팀 폼과 **같은 안내 영역**을 세워 클릭으로 배정하고
             드래그로 놓을 자리도 함께 만든다 — 마크업을 새로 발명하지 않는다. -->
        <div
            v-else
            :class="{'is-drop-target': chipDrag.active && chipDrag.targetTeamId === team.id}"
            :data-invalid="emptyTeamsAtSave.has(team.id)"
            class="schedulerTreatmentSetting__memberArea"
            @click.stop="onEmptyMemberAreaClick($event, team.id)"
            @dragover="onChipListDragOver($event, team.id)"
            @drop="onChipListDrop($event, team.id)"
        >
          <!-- 안내 마크업은 신규 팀 폼과 동일하게 둔다 — 한 탭 안에서 같은 상태가 다르게 보이면 안 된다. -->
          <div class="team-member-empty">
            <p class="schedulerTreatmentSetting__memberPlaceholder">클릭하여 직원을 추가해주세요.</p>
            <span class="team-member-add">
              <span aria-hidden="true" class="team-member-add-icon">+</span>
              <span>직원 추가</span>
            </span>
          </div>
        </div>

        <!-- 선택된 담당자의 컨트롤은 그 담당자가 속한 팀의 칩 리스트 아래에 붙인다(§4-5-3).
             사업장 것과 **같은 컴포넌트**다 — 마크업을 복제하지 않는다. -->
        <SchedulerSettingsOffDayControls
            v-if="isOffOwnerInTeam(team)"
            v-bind="offControlsProps"
            @toggle-option="onOffOptionToggle"
            @remove-range="removeSpecificRange"
            @set-holiday="onOffHolidayChange"
        />
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
          >⋮</button>
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
          <div v-else class="team-member-empty">
            <p class="schedulerTreatmentSetting__memberPlaceholder">클릭하여 직원을 추가해주세요.</p>
            <span class="team-member-add">
              <span aria-hidden="true" class="team-member-add-icon">+</span>
              <span>직원 추가</span>
            </span>
          </div>
        </div>
      </section>

      <!-- 신규 팀 추가 트리거 -->
      <div v-else class="team-add-area">
        <button
            class="schedulerTreatmentSetting__addBtn"
            type="button"
            @click="startCreateTeam"
        >
          <span aria-hidden="true" class="team-add-icon">+</span>
          <span>팀 추가</span>
        </button>
      </div>
      </template>

      <!-- ===== 운영시간 탭: 팀(클릭=조회 단위) → 멤버(클릭 확장) + 사업장 ===== -->
      <template v-else-if="activeLeftTab === 'WORKING_HOURS'">
        <section
            v-for="team in teams"
            :key="`hours-${team.id}`"
            class="schedulerTreatmentSetting__section team-section hours-team-section"
        >
          <!-- 팀 헤더 = 조회 단위 선택(팀). 고르면 오른쪽 캘린더가 그 팀 소속으로 좁혀지고,
               좌측에는 아무 패널도 펼치지 않는다 — 운영시간 편집은 직원·사업장 단위라서다.
               휴무일 탭의 팀 헤더(이름변경·구성원설정·삭제 메뉴)와 달리 여기에는 메뉴를 두지 않는다. -->
          <header
              :class="{ 'is-selected': expandedTreatmentKey === `team:${team.id}` }"
              class="schedulerTreatmentSetting__teamHeader schedulerTreatmentSetting__teamHeader--selectable"
          >
            <button
                class="schedulerTreatmentSetting__teamLabel schedulerTreatmentSetting__teamSelect"
                type="button"
                @click="toggleTreatmentExpansion(`team:${team.id}`)"
            >- {{ team.name }}</button>
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
                   운영은 시작~종료 한 구간이고, 둘 다 비우면 그 요일은 휴무이다.
                   휴게는 담당자가 갖지 않으므로 사업장 값을 읽기 전용으로 보여준다. -->
              <div
                  v-if="expandedTreatmentKey === `staff:${docId}`"
                  class="schedulerTreatmentSetting__hoursPanel"
              >
                <!-- 열 머리글은 두지 않는다 — 각 칸이 스스로를 밝히고(입력칸 placeholder·'휴게시간1/2' 라벨)
                     사업장 패널 표(__hoursTable)와도 같은 모양이 된다. -->
                <table class="schedulerTreatmentSetting__staffHoursTable">
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
                      <td v-if="isWeekdayClosed(w, `STAFF:${docId}`)" class="schedulerTreatmentSetting__hoursOff" colspan="2">휴무</td>
                      <td v-else>
                        <input
                            :value="fetchStaffWorkHours(docId, w, 'start')"
                            :data-invalid="staffTimeInvalid(docId, w, 'start')"
                            :aria-invalid="staffTimeInvalid(docId, w, 'start')"
                            :data-inherited="showsInheritedStaffTime(docId, w)"
                            :title="showsInheritedStaffTime(docId, w) ? INHERITED_TIME_HINT : null"
                            autocomplete="off"
                            class="schedulerTreatmentSetting__timeInput"
                            inputmode="numeric"
                            maxlength="5"
                            placeholder="HH:MM"
                            type="text"
                            @input="maskTimeInput"
                            @change="onStaffTimeInput($event, docId, w, 'start')"
                        />
                        <span class="schedulerTreatmentSetting__timeDash">~</span>
                        <input
                            :value="fetchStaffWorkHours(docId, w, 'end')"
                            :data-invalid="staffTimeInvalid(docId, w, 'end')"
                            :aria-invalid="staffTimeInvalid(docId, w, 'end')"
                            :data-inherited="showsInheritedStaffTime(docId, w)"
                            :title="showsInheritedStaffTime(docId, w) ? INHERITED_TIME_HINT : null"
                            autocomplete="off"
                            class="schedulerTreatmentSetting__timeInput"
                            inputmode="numeric"
                            maxlength="5"
                            placeholder="HH:MM"
                            type="text"
                            @input="maskTimeInput"
                            @change="onStaffTimeInput($event, docId, w, 'end')"
                        />
                      </td>
                      <!-- 사업장의 그 요일 휴게시간(읽기 전용). 사업장 패널과 같은 배치로 둬 대조가 쉽다. -->
                      <td v-if="!isWeekdayClosed(w, `STAFF:${docId}`)" class="schedulerTreatmentSetting__staffBreakCell">
                        <div
                            v-for="kind in BREAK_BLOCK_KINDS"
                            :key="`brk-${docId}-${w}-${kind}`"
                        >
                          {{ BLOCK_KIND_LABEL[kind] }}
                          <span class="schedulerTreatmentSetting__hoursValue break-time">{{ staffBreakText(docId, w, kind) }}</span>
                        </div>
                      </td>
                    </tr>
                  </tbody>
                </table>
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
                  :ref="el => setWeekdayBtnEl('INSTITUTION', idx, el)"
                  :data-invalid="ownerWeekdayInvalid('INSTITUTION', idx)"
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
                  :ref="el => setWeekdayBtnEl(HOLIDAY_OWNER, HOLIDAY_SLOT, el)"
                  :data-invalid="ownerWeekdayInvalid(HOLIDAY_OWNER, HOLIDAY_SLOT)"
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
                  <template v-if="!isWeekdayClosed(w) && !siteLoadFailed">
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
                  <!-- ★'휴무'이라 적는 것은 **휴무일 탭이 그렇게 정한 요일**뿐이다. 운영 요일인데
                       운영시간이 비어 있는 것은 아직 정하지 않은 상태이므로 휴게시간과 같은 '-' 로
                       두고(formatSiteHours), 저장하면 휴무가 된다는 사실은 배너가 알린다.
                       조회에 실패했을 때는 원천이 뭘 갖고 있는지 모르는 것이라 '-' 로도 적지 않는다 —
                       비어 있다고 단정하면 화면이 없는 사실을 지어낸다(배너·저장차단이 따로 알린다). -->
                  <td v-else-if="isWeekdayClosed(w)" class="schedulerTreatmentSetting__hoursOff" colspan="2">휴무</td>
                  <td v-else class="schedulerTreatmentSetting__hoursOff" colspan="2">운영시간 없음</td>
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
                  <!-- 공휴일에 운영하기로 했는데 시간을 아직 안 정했다 — 쉬기로 한 것과 다르다. -->
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
                v-for="doc in staffPickerDoctors"
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
                class="schedulerTreatmentSetting__staffPickerCancel popup-action-button popup-action-button--compact"
                type="button"
                @click="closeStaffPicker"
            >취소</button>
            <button
                class="schedulerTreatmentSetting__staffPickerConfirm popup-action-button popup-action-button--compact popup-action-button--primary"
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
            ref="weekdayEditorEl"
            :style="{
              top : `${weekdayEditor.top}px`,
              left: `${weekdayEditor.left}px`,
            }"
            class="schedulerTreatmentSetting__weekdayEditor"
            @click.stop
            @mousedown.stop
            @pointerdown.stop
        >
          <!-- [X] — 검증 없이 닫는 유일한 출구. 바깥 클릭은 시간 오류가 남아 있는 한 매번 막히므로,
               이 버튼을 떼면 고치기 전에는 나갈 길이 없어진다(캡처 가드 주석과 한 쌍). -->
          <header class="schedulerTreatmentSetting__weekdayEditorHeader">
            <button
                aria-label="닫기"
                class="schedulerTreatmentSetting__weekdayEditorClose schedule-popup__close-button schedule-popup__close-button--small"
                type="button"
                @click="commitWeekdayEditor"
            >×</button>
          </header>

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
                :aria-invalid="editorSlotInvalid(weekdayEditor, kind, 'start')"
                autocomplete="off"
                class="schedulerTreatmentSetting__timeInput"
                inputmode="numeric"
                maxlength="5"
                placeholder="HH:MM"
                type="text"
                @input="maskTimeInput"
                @change="onEditorTimeInput($event, kind, 'start')"
            />
            <span class="schedulerTreatmentSetting__timeDash">~</span>
            <input
                :value="weekdayEditor.draft[kind].end"
                :data-invalid="editorSlotInvalid(weekdayEditor, kind, 'end')"
                :aria-invalid="editorSlotInvalid(weekdayEditor, kind, 'end')"
                autocomplete="off"
                class="schedulerTreatmentSetting__timeInput"
                inputmode="numeric"
                maxlength="5"
                placeholder="HH:MM"
                type="text"
                @input="maskTimeInput"
                @change="onEditorTimeInput($event, kind, 'end')"
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
                  :aria-invalid="editorSlotInvalid(weekdayEditor, kind, 'start')"
                  autocomplete="off"
                  class="schedulerTreatmentSetting__timeInput"
                  inputmode="numeric"
                  maxlength="5"
                  placeholder="HH:MM"
                  type="text"
                  @input="maskTimeInput"
                  @change="onEditorTimeInput($event, kind, 'start')"
              />
              <span class="schedulerTreatmentSetting__timeDash">~</span>
              <input
                  :value="weekdayEditor.draft[kind].end"
                  :data-invalid="editorSlotInvalid(weekdayEditor, kind, 'end')"
                  :aria-invalid="editorSlotInvalid(weekdayEditor, kind, 'end')"
                  autocomplete="off"
                  class="schedulerTreatmentSetting__timeInput"
                  inputmode="numeric"
                  maxlength="5"
                  placeholder="HH:MM"
                  type="text"
                  @input="maskTimeInput"
                  @change="onEditorTimeInput($event, kind, 'end')"
              />
            </div>
          </template>
        </div>
      </Teleport>

      <!-- 미지정 데이터 적용 modal (공용 컴포넌트) -->
      <UnassignedDataModal
          :doctors="teamDoctors"
          :visible="unassignedDataModalOpen"
          @close="unassignedDataModalOpen = false"
      />

      <!-- 확인 다이얼로그 (팀 삭제 / 멤버 삭제 / 멤버 이동 공용) -->
      <Teleport to="body">
        <div
            v-if="confirmDialog"
            class="schedulerTreatmentSetting__deleteOverlay"
            @click.stop
            @mousedown.stop
        >
          <div class="schedulerTreatmentSetting__deletePanel schedule-popup">
            <button
                aria-label="닫기"
                class="schedule-popup__close-button"
                type="button"
                @click="closeConfirmDialog"
            ></button>
            <div class="schedule-popup__body">
              <p class="schedulerTreatmentSetting__deleteMessage">{{ confirmDialog.title }}</p>
              <p
                  v-if="confirmDialog.sub"
                  class="schedulerTreatmentSetting__deleteSubMessage"
              >{{ confirmDialog.sub }}</p>
            </div>
            <div class="schedulerTreatmentSetting__deleteActions schedule-popup__footer">
              <button
                  class="schedulerTreatmentSetting__deleteCancelBtn popup-action-button"
                  type="button"
                  @click="closeConfirmDialog"
              >취소</button>
              <button
                  class="schedulerTreatmentSetting__deleteConfirmBtn popup-action-button popup-action-button--primary"
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
        <!-- 범례 — 셀 안의 색·굵기가 무엇을 뜻하는지 화면이 스스로 밝힌다.
             월 달력에만 붙인다(휴무일 탭의 12개월 미니 캘린더에는 이 표기가 없다).
             월 라벨은 헤더 중앙에 그대로 둬야 하므로 범례는 absolute 로 왼쪽에 띄운다. -->
        <ul
            v-if="activeLeftTab !== 'OFF'"
            class="schedulerTreatmentSetting__legend"
        >
          <li class="schedulerTreatmentSetting__legendItem is-designated">
            <span class="schedulerTreatmentSetting__legendDot" />특정일자 운영
          </li>
          <li class="schedulerTreatmentSetting__legendItem is-own">
            <span class="schedulerTreatmentSetting__legendDot" />요일별 운영시간
          </li>
        </ul>

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

            <!-- 직원별 리스트 (최대 CELL_ENTRY_VISIBLE_MAX, 초과 시 더보기).
                 조회 단위 셋 모두 이 경로다 — 직원 모드는 대상이 1명일 뿐이라,
                 그 줄을 클릭하는 일자 지정(§6-2)이 세 단위에서 똑같이 열린다. -->
            <div
                v-if="cell.isCurrentMonth && cell.entries && cell.entries.length"
                class="schedulerTreatmentSetting__monthCellEntries"
            >
              <button
                  v-for="(entry, i) in cell.entries.slice(0, CELL_ENTRY_VISIBLE_MAX)"
                  :key="i"
                  :class="{
                    'is-off'       : entry.isOff,
                    'is-own'       : entry.isOwn === true,
                    'is-designated': entry.isDesignated,
                    'is-inherited' : entry.isInherited === true,
                    'is-editing'   : cellStaffEditor.open
                        && cellStaffEditor.ownerKey === `STAFF:${entry.staffId}`
                        && cellStaffEditor.dateKey === cell.key,
                  }"
                  :ref="el => setCellEntryEl(`STAFF:${entry.staffId}`, cell.key, el)"
                  :data-invalid="entry.isInvalid === true"
                  :title="entry.isInherited === true ? INHERITED_TIME_HINT : null"
                  class="schedulerTreatmentSetting__monthCellEntry"
                  type="button"
                  @click.stop="openCellStaffEditor($event, `STAFF:${entry.staffId}`, cell.key, cell.weekday)"
              ><span class="schedulerTreatmentSetting__monthCellEntryName">{{ entry.name }}</span>
                <span class="schedulerTreatmentSetting__monthCellEntryTime">{{ entry.time }}</span></button>
              <button
                  v-if="cell.entries.length > CELL_ENTRY_VISIBLE_MAX"
                  class="schedulerTreatmentSetting__monthCellMore"
                  type="button"
                  @click.stop="openCellMore($event, cell)"
              >+{{ cell.entries.length - CELL_ENTRY_VISIBLE_MAX }} 더보기</button>
            </div>

          </div>
        </div>
      </div>

      <!-- 셀 더보기 popover (entries 가 임계를 넘을 때) -->
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
            :class="{'is-off': entry.isOff, 'is-own': entry.isOwn === true, 'is-designated': entry.isDesignated, 'is-inherited': entry.isInherited === true}"
            :data-invalid="entry.isInvalid === true"
            :title="entry.isInherited === true ? INHERITED_TIME_HINT : null"
            class="schedulerTreatmentSetting__monthCellEntry schedulerTreatmentSetting__monthCellEntry--more"
            type="button"
            @click.stop="openCellStaffEditor($event, `STAFF:${entry.staffId}`, cellMorePopover.dateKey, cellMorePopover.weekday)"
        ><span class="schedulerTreatmentSetting__monthCellEntryName">{{ entry.name }}</span>
          <span class="schedulerTreatmentSetting__monthCellEntryTime">{{ entry.time }}</span></button>
      </CellMorePopover>

      <!-- 셀 × 직원 popover editor (날짜별 override 편집) -->
      <Teleport to="body">
        <div
            v-if="cellStaffEditor.open"
            ref="cellStaffEditorEl"
            :style="{
              top : `${cellStaffEditor.top}px`,
              left: `${cellStaffEditor.left}px`,
            }"
            class="schedulerTreatmentSetting__weekdayEditor"
            @click.stop
            @mousedown.stop
            @pointerdown.stop
        >
          <!-- [X] — 요일 편집기와 같은 규약(검증 없이 닫는 유일한 출구) -->
          <header class="schedulerTreatmentSetting__weekdayEditorHeader">
            <button
                aria-label="닫기"
                class="schedulerTreatmentSetting__weekdayEditorClose schedule-popup__close-button schedule-popup__close-button--small"
                type="button"
                @click="commitCellStaffEditor"
            >×</button>
          </header>

          <!-- 시간을 모두 비우면 그 날짜 지정이 해제된다(미설정) — 휴무가 아니다. 휴무는 휴무일 탭이 정한다(commitCellStaffEditor) -->
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
                :aria-invalid="editorSlotInvalid(cellStaffEditor, kind, 'start')"
                autocomplete="off"
                class="schedulerTreatmentSetting__timeInput"
                inputmode="numeric"
                maxlength="5"
                placeholder="HH:MM"
                type="text"
                @input="maskTimeInput"
                @change="onCellStaffTimeInput($event, kind, 'start')"
            />
            <span class="schedulerTreatmentSetting__timeDash">~</span>
            <input
                :value="cellStaffEditor.draft[kind].end"
                :data-invalid="editorSlotInvalid(cellStaffEditor, kind, 'end')"
                :aria-invalid="editorSlotInvalid(cellStaffEditor, kind, 'end')"
                autocomplete="off"
                class="schedulerTreatmentSetting__timeInput"
                inputmode="numeric"
                maxlength="5"
                placeholder="HH:MM"
                type="text"
                @input="maskTimeInput"
                @change="onCellStaffTimeInput($event, kind, 'end')"
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
        <span class="schedulerTreatmentSetting__loadErrorMsg">운영시간 정보를 불러오지 못해 기본 운영시간으로 표시 중입니다. 잠시 후 다시 시도해 주세요.</span>
        <button
            class="schedulerTreatmentSetting__loadErrorRetry"
            type="button"
            @click="retryHydrate"
        >재시도</button>
      </div>

      <!-- 운영시간이 비어 있는 요일 안내 — buildPayload 가 '매주 휴무'으로 내보낼 요일과 같은
           값을 본다(missingTimeWeekdays). 저장을 막지 않는 대신, 무엇이 그렇게 저장되는지
           누르기 전에 알려야 한다. 운영시간을 채우면 스스로 사라지므로 해제 코드는 없다. -->
      <div
          v-if="missingTimeWeekdays.length || monthlyOnlyMissingTimeWeekdays.length"
          class="schedulerTreatmentSetting__missingTimeNotice"
          role="status"
      >
        <p
            v-if="missingTimeWeekdays.length"
            class="schedulerTreatmentSetting__missingTimeLine"
        >운영시간이 없는 <strong>{{ missingTimeWeekdaysLabel }}요일</strong>은 저장하면 매주 휴무로 처리됩니다.<br>운영시간을 입력해 주세요.</p>
        <!-- 매월 n번째만 쉬는 요일은 나머지 주에 운영한다 — 자동 휴무가 아니라 운영시간 필수(저장 게이트 4단) -->
        <p
            v-if="monthlyOnlyMissingTimeSegments.length"
            class="schedulerTreatmentSetting__missingTimeLine"
        ><template
            v-for="(seg, i) in monthlyOnlyMissingTimeSegments"
            :key="`monthly-missing-${seg.weekday}`"
        ><template v-if="i > 0">, </template><strong>{{ seg.label }}요일</strong>은 매월 {{ seg.ordinals }}번째</template> 휴무라 나머지 주에 운영합니다.<br>운영시간을 입력해 주세요.</p>
      </div>

      <footer class="schedulerTreatmentSetting__footer">
        <button
            class="schedulerTreatmentSetting__cancelBtn popup-action-button"
            type="button"
            @click="onCancel"
        >취소</button>

        <button
            :disabled="saving || saveBlocked"
            :title="saveBlocked ? '운영시간 정보를 불러오지 못해 저장할 수 없습니다.' : ''"
            class="schedulerTreatmentSetting__saveBtn popup-action-button popup-action-button--primary"
            type="button"
            @click="onSave"
        >{{ saving ? '저장 중...' : '저장' }}</button>
      </footer>
    </div>
  </div>
</template>

<style lang="scss" scoped>
@use '@/scss/variables' as *;
@use '@/scss/schedule/setting-chip' as chip;
@use '@/scss/schedule/invalid' as invalid;

.schedulerTreatmentSetting {
  /* 칩 기본형은 휴무 컨트롤(SchedulerSettingsOffDayControls)과 공유한다 — scoped 스타일이
     서로 닿지 않아, 두 벌 적지 않으려면 mixin 이어야 한다. 모디파이어는 각자 갖는다. */
  @include chip.scheduler-setting-chip-base;

  display: flex;
  height: 100%;
  min-height: 0;

  /* ---------- Sidebar ---------- */
  &__sidebar {
    flex: 0 0 350px;
    display: flex;
    flex-direction: column;
    min-height: 0;
    padding: 8px 0;
    overflow-y: auto;
    background: #fff;
    border-right: 1px solid #e9e9e9;
  }

  /* 휴무일/운영시간 세그먼트 + 미지정 데이터 설정 버튼 한 줄 배치 */
  &__segmentRow {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 0 16px;
    margin-bottom: 8px;
  }

  &__unassignedBtn {
    height: 24px;
    padding: 0 12px;
    border: 1px solid #a5a5a5;
    border-radius: $radius-4;
    background: #fff;
    cursor: pointer;
    font-size: 14px;
    font-weight: 500;
    color: $color-text-default;
    white-space: nowrap;

    &:hover {
      background: #f2f2f2;
    }
  }

  &__section {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 0 16px;
    background: #fff;

    &--placeholder {
      color: $color-text-muted;
      font-size: $font-size-12;
    }

    &.institution-section {
      padding: 0 0 12px;
      background: #fafafa;

      > :not(.schedulerTreatmentSetting__sectionHeader) {
        margin-right: 16px;
        margin-left: 16px;
      }
    }

    &.team-section {
      margin-top: 0;
      padding-top: 12px;
      padding-bottom: 12px;
      border-top: 1px solid #eee;
    }
  }

  .hours-team-section {
    padding-top: 0;
  }

  &__sectionHeader {
    display: flex;
    align-items: center;
    height: 40px;
    padding: 0 16px;
    border-right: 4px solid $color-primary;
    background: #fff4ed;
    font-size: $font-size-14;
    font-weight: $font-weight-bold;
    color: $color-primary;

    /* 휴무일 탭 — 사업장도 선택 단위라 상태를 드러낸다(색 규약은 팀 헤더·담당자 칩과 동일). */
    &--selectable {
      cursor: pointer;

      &:hover { background: $color-surface-hover; }

      &.is-selected {
        background: #E88B1D;
        color: #fff;
      }
    }
  }

  /* 칩 형태 리스트 (반복 휴무, 특정일자, 담당자) */
  &__chipList {
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
    /* 칩 자체는 "고르는" 대상이다 — 끄는 곳은 ≡ 그립뿐이라 커서도 거기서만 grab 으로 바뀐다.
     * 시각 규격(높이 32·테두리·흰 배경)은 퍼블리싱(version2)의 member 칩 값을 따른다. */
    &--selectable {
      justify-content: flex-start;
      gap: 12px;
      height: 32px;
      padding: 0 12px;
      border: 1px solid #eee;
      border-radius: $radius-4;
      background: #fff;
      line-height: normal;
      color: #565656;
      cursor: pointer;

      &:hover { background: $color-surface-hover; }
    }

    /* 선택 표시는 사업장 행·팀 헤더와 같은 색을 쓴다 — 셋 다 "이 단위로 캘린더를 보고 있다"는 같은 뜻이다. */
    &.is-selected {
      background: #E88B1D;
      color: #fff;

      .schedulerTreatmentSetting__chipRemove::before,
      .schedulerTreatmentSetting__chipHandleGrip { color: #fff; }
    }

    &.is-dragging {
      opacity: 0.4;
    }

    /* 드롭될 자리 — 그 칩 배경을 통째로 강조한다(담당자 순서 변경 팝업과 같은 규약).
     * 종전의 좌측 2px 세로 막대는 가로 리스트용 "이 앞에 삽입" 표시였는데,
     * 이 리스트(--member)는 세로 1열이라 어디에 놓이는지 읽히지 않았다. */
    &.is-drop-target {
      background: #cfe2ff;
    }
  }

  /* 그립+이름 묶음 — 클릭(선택)은 칩(li) 전체, dragstart 는 안쪽 ≡ 그립에서만 난다. */
  &__chipHandle {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    flex: 1;
    min-width: 0;
  }

  /* 드래그 손잡이. 글자 하나라 히트 영역만 패딩으로 키우고 음수 마진으로 시각 위치를 유지한다.
   * 색·크기는 퍼블리싱(.chip-handle) 값을 따른다. */
  &__chipHandleGrip {
    color: #727272;
    font-size: $font-size-14;
    line-height: 1;
    user-select: none;
    cursor: grab;
    padding: 4px 6px;
    margin: -4px -6px;

    &:active { cursor: grabbing; }
  }

  &__teamHeader {
    display: flex;
    align-items: center;
    justify-content: space-between;
    cursor: pointer;
    font-size: $font-size-14;

    color: $color-text-default;

    /* 운영시간 탭 — 팀이 조회 단위라 선택 상태를 드러낸다.
       선택 상태는 휴무일 화면의 sectionHeader와 같은 규격을 쓴다. */
    &--selectable {
      &.is-selected {
        margin: 0 -16px;
      }

      &.is-selected .schedulerTreatmentSetting__teamSelect {
        height: 40px;
        padding: 0 16px;
        border-right: 4px solid $color-primary;
        background: #fff4ed;
        color: $color-primary;
        font-size: $font-size-14;
        font-weight: $font-weight-bold;
      }
    }
  }

  /* 팀 헤더 안의 선택 버튼 */
  &__teamSelect {
    flex: 1;
    padding: 4px 8px;
    border: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
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
    display: flex;
    align-items: center;
    width: 100%;
    height: 32px;
    padding: 0 12px;
    border: 1px solid #eee;
    background: #fff;
    border-radius: 4px;
    text-align: left;
    cursor: pointer;
    font-size: $font-size-14;
    line-height: normal;
    color: #565656;   

    &.is-expanded {
      // border-color: $color-primary;
      // background: $color-primary;
      color: $color-primary;
      font-weight: 700;
    }
  }

  &__hoursPanel {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 8px;
    border: 1px solid #eee;
    border-top: 0;
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
      background: $color-primary;
      border-color: $color-primary;
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

    /* 저장이 막힌 요일 — popover 를 닫은 뒤 그 요일을 가리키는 유일한 자리다.
     * 시간 입력칸(data-invalid)과 같은 값을 쓴다. is-active·is-editing 보다 뒤에 둬 그 위에 그린다. */
    &[data-invalid="true"] {
      @include invalid.outline;
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
    font-weight: $font-weight-regular;
  }

  /* 담당자 운영시간 7행 인라인 표 — 요일 | 운영시간(입력) | 휴게시간(사업장 값, 읽기 전용) */
  &__staffHoursTable {
    width: 100%;
    border-collapse: collapse;
    font-size: $font-size-12;
    color: $color-text-default;

    th, td {
      padding: 3px 4px;
      text-align: left;
      font-weight: $font-weight-medium;
      white-space: nowrap;
      vertical-align: middle;
    }

    th:first-child, td:first-child { width: 22px; }

    /* 운영시간 입력칸은 이 표에서만 좁힌다 — 좌측 패널 폭 안에 휴게시간 열까지 들어가야 한다.
       공용 &__timeInput(103px)은 건드리지 않는다: 그 폭은 사업장 요일 편집 popover 가 쓴다.
       "09:30"·placeholder "HH:MM" 5글자가 가운데 정렬로 들어가는 최소 폭이다. */
    .schedulerTreatmentSetting__timeInput { width: 56px; }
  }

  /* 담당자 표의 휴게시간 열 — 사업장 값을 그대로 따른다. 입력칸이 아니라는 것이 색으로 드러나야 한다.
     운영시간 입력칸이 폭을 먼저 가져가도록 남는 폭만 쓴다(width:1% + nowrap). */
  &__staffBreakCell {
    width: 1%;
    white-space: nowrap;
    color: $color-text-muted;
  }

  .break-time {
    font-weight: 400;
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
    height: 40px;
    margin: 0 -16px;
    padding: 0;
    border-top: 1px solid #eee;
    border-bottom: 1px solid #eee;
    background: #fff;
    font-size: $font-size-14;
    font-weight: $font-weight-medium;
    color: #565656;

    &.is-expanded {
      background: #fff;
      color: #565656;
    }
  }

  &__institutionRow + &__hoursPanel {
    padding: 0;
    border: 0;
  }

  &__institutionExpand {
    flex: 1;
    display: flex;
    align-items: center;
    height: 100%;
    padding: 0 16px;
    border: 0;
    background: transparent;
    cursor: pointer;
    text-align: left;
    font: inherit;
    color: inherit;

    &::after {
      content: '';
      width: 16px;
      height: 16px;
      margin-left: auto;
      background: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23424242' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Ccircle cx='12' cy='12' r='3'/%3E%3Cpath d='M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z'/%3E%3C/svg%3E") center / contain no-repeat;
    }
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
    font-size: $font-size-14;

    .schedulerTreatmentSetting__timeInput {
      font-size: $font-size-14;
    }
  }

  /* [X] 한 개만 담는 머리줄. 제목이 없으므로 padding 안쪽으로 당겨 높이를 거의 쓰지 않되,
   * 첫 입력행과 붙지 않게 아래쪽은 조금 남긴다(부모 gap 6px − 2px = 4px). */
  &__weekdayEditorHeader {
    display: flex;
    justify-content: flex-end;
    margin: -4px -4px -2px 0;
  }

  &__weekdayEditorRow {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: $font-size-14;
    color: $color-text-default;

    &.is-inactive {
      color: $color-text-muted;
    }
  }

  /* 운영 / 휴게시간1 / 휴게시간2 공통 라벨 — "휴게시간1" 이 한 줄에 들어가는 폭. */
  &__weekdayEditorKindLabel {
    flex: 0 0 60px;
    font-weight: $font-weight-medium;
    white-space: nowrap;
  }

  /* 운영(WORK) 행과 휴게(BREAK) 행 사이 구분선 */
  &__weekdayEditorDivider {
    height: 1px;
    margin: 2px 0;
    background: $color-border-light;
  }

  &__timeInput {
    /* popover(사업장 요일 편집) 기준 폭 — type="time" 시절 그대로다.
     * 담당자 7행 표는 휴게시간 열이 함께 들어가야 해 &__staffHoursTable 에서 따로 좁힌다. */
    width: 103px;
    height: 24px;
    padding: 0 6px;
    border: 1px solid $color-border-light;
    border-radius: $radius-2;
    font-size: $font-size-12;
    color: $color-text-default;
    background: #fff;
    /* 네이티브 시계 아이콘이 사라진 자리 — 텍스트를 가운데로 둬야 "09:30"이 칸 중앙에 온다 */
    text-align: center;

    &::placeholder {
      color: $color-text-muted;
    }

    &:focus {
      outline: none;
      border-color: #E88B1D;
    }

    &:disabled {
      background: $color-surface-alt;
      color: $color-text-muted;
      cursor: not-allowed;
    }

    /* 사업장에서 빌려온 시각 — 이 담당자에게 저장된 값이 아니다.
     * placeholder 와 같은 농도로 낮춰 "입력된 값"이 아니라 "따라가는 값"으로 읽히게 한다.
     * 사용자가 이 칸을 고치는 순간 setStaffWorkHours 이 그 요일을 확정해 표시도 기본 농도로 돌아온다. */
    &[data-inherited="true"] {
      color: #9e9e9e;   /* muted 는 기본색과 거의 같다 — __monthCellEntry.is-inherited 와 같은 값 */
      font-style: italic;
    }

    /* 시작·종료 중 한쪽만 채운 채 넘어가려 했을 때 채워야 할 칸.
     * 예약등록 팝업(.scheduleField[data-invalid])과 같은 값을 쓴다 — 두 화면의 오류 표시가 갈리면 안 된다.
     * data-inherited 뒤에 둬 오류 표시가 이긴다. */
    &[data-invalid="true"] {
      @include invalid.outline;
    }
  }

  &__timeDash {
    color: $color-text-muted;
    padding: 0 4px;
  }

  &__timeClear {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    margin-left: 4px;
    border: 0;
    padding: 0;
    background: transparent;
    color: transparent;
    font-size: 0;
    line-height: 1;
    cursor: pointer;
    vertical-align: middle;

    &::before {
      content: '\2715';
      color: #000;
      font-size: 14px;
      line-height: 1;
    }

    &:hover { color: transparent; }

    &:focus {
      outline: none;
    }
  }

  &__teamMenu {
    width: 20px;
    height: 20px;
    border: 0;
    background: transparent;
    cursor: pointer;
    color: #565656;
    padding: 0;
    line-height: 1;
  }

  &__addBtn {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    height: 20px;
    margin: 6px 0;
    padding: 0;
    border: 0;
    background: transparent;
    font-size: $font-size-14;
    font-weight: $font-weight-semibold;
    color: $color-primary;
    cursor: pointer;
    transition: color 0.2s;

    &:hover {
      color: $color-primary;
    }

    .team-add-icon {
      display: inline-flex;
      align-items: center;
      height: 20px;
      font-size: 22px;
      font-weight: $font-weight-regular;
      line-height: 1;
    }

    > span:not(.team-add-icon) {
      display: inline-flex;
      align-items: center;
      height: 20px;
      line-height: 1;
    }
  }

  .team-add-area {
    display: flex;
    justify-content: center;
    margin-top: 12px;
    border-top: 1px solid #eee;
  }

  /* ---------- 팀 편집 폼 ---------- */
  &__section--editing {
    padding: 0 16px;
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
    height: 32px;
    padding: 0 8px;
    border: 1px solid #c4c4c4;
    border-radius: $radius-2;
    font-size: $font-size-13;
    color: $color-text-default;

    &:focus {
      outline: none;
      border-color: #E88B1D;
    }
  }

  &__memberArea {
    box-sizing: border-box;
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 80px;
    padding: 8px;
    border: 1px dashed #c4c4c4;
    border-radius: $radius-2;
    background: #fafafa;
    cursor: pointer;

    &:hover {
      background: #fafafa;
    }

    /* 휴무일 탭의 빈 팀에서는 이 영역이 드롭 대상도 겸한다 — 끌고 오면 놓을 자리를 표시한다. */
    &.is-drop-target {
      border-color: #E88B1D;
      background: $color-surface-hover;
    }

    /* 구성원 없이 저장을 시도했을 때 채워야 할 자리. 시간 입력칸과 같은 값을 쓴다 —
     * 한 화면 안에서 오류 표시가 갈리면 안 된다. 사람을 넣으면 이 영역 자체가 사라져 스스로 풀린다. */
    &[data-invalid="true"] {
      @include invalid.outline;
    }
  }

  &__memberPlaceholder {
    margin: 0;
    text-align: center;
    font-size: $font-size-12;
    color: $color-text-muted;
  }

  .team-member-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
  }

  .team-member-add {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    color: $color-primary;
    font-size: $font-size-14;
    font-weight: $font-weight-semibold;
    line-height: 1;
  }

  .team-member-add-icon {
    display: inline-flex;
    align-items: center;
    height: 20px;
    font-size: 22px;
    font-weight: $font-weight-regular;
    line-height: 1;
    transform: translateY(-2px);
  }

  .team-member-add > span:not(.team-member-add-icon) {
    display: inline-flex;
    align-items: center;
    height: 20px;
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
  }

  &__staffOption {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 32px;
    padding: 0 8px;
    border: 1px solid #bcbcbc;
    border-radius: $radius-4;
    background: #fff;
    cursor: pointer;
    font-size: $font-size-14;
    color: #565656;
    transition: border-color 0.2s, color 0.2s, background-color 0.2s;

    &.is-selected {
      border-color: $color-primary;
      background: #fff;
      color: $color-primary;
    }

    &:hover:not(.is-disabled):not(:disabled) {
      border-color: $color-primary;
      color: $color-primary;
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
    justify-content: center;
    gap: 6px;
    padding-top: 8px;
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
    min-width: 90px;
    padding: 0;
    background: #fff;
    border: 1px solid #ddd;
    border-radius: $radius-4;
    box-shadow: 0 4px 10px 0 rgba(0, 0, 0, 0.24);
    display: flex;
    flex-direction: column;
  }

  &__teamMenuItem {
    display: block;
    width: 100%;
    padding: 6px 10px;
    border: none;
    background: transparent;
    cursor: pointer;
    font-size: $font-size-12;
    font-weight: $font-weight-semibold;
    color: #333;
    text-align: left;
    white-space: nowrap;

    & + & {
      border-top: 1px solid #e9e9e9;
    }

    &:hover {
      color: #000;
    }

    &:last-child {
      color: #e53935;

      &:hover {
        color: #c62828;
      }
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
    position: relative;
    min-width: 280px;

    .schedule-popup__body {
      padding-top: 56px;
    }

    .schedule-popup__close-button {
      position: absolute;
      top: 12px;
      right: 12px;
    }
  }

  &__deleteMessage,
  &__deleteSubMessage {
    text-align: center;
    font-size: 18px;
    font-weight: $font-weight-bold;
    color: #333;
    white-space: pre-wrap;
  }

  &__deleteMessage {
    margin: 0;
  }

  &__deleteSubMessage {
    margin: 4px 0 0;
  }

  /* ---------- Main ---------- */
  &__main {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    background: #f7f7f7;
  }

  &__yearNav {
    position: relative;   /* 범례를 왼쪽에 띄우되 월 라벨의 중앙 정렬은 건드리지 않는다 */
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 12px;
    padding: 12px 0;
  }

  /* 셀 표기 범례 — 색·굵기의 뜻을 화면에 적어 둔다. */
  &__legend {
    position: absolute;
    /* 달력 좌측 테두리와 같은 선에서 시작한다 — __monthView 의 좌우 padding 과 같은 값이다. */
    left: 16px;
    top: 50%;
    transform: translateY(-50%);
    display: flex;
    align-items: center;
    gap: 12px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  &__legendItem {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: $font-size-12;
    color: $color-text-default;
    white-space: nowrap;
  }

  &__legendDot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    /* 점 색은 셀 줄의 글자색과 같아야 한다 — 다르면 범례가 다른 것을 가리키게 된다. */
    background: currentColor;
  }

  /* 셀 줄과 같은 값이어야 한다 — 다르면 범례가 다른 것을 가리키게 된다(__monthCellEntry.is-designated). */
  &__legendItem.is-designated {
    color: #E88B1D;
    font-weight: $font-weight-semibold;
  }

  &__legendItem.is-own {
    color: $color-text-default;
    font-weight: $font-weight-semibold;
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
    gap: 8px;
    padding: 16px 20px;
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
    border-radius: $radius-4;
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
    /* 휴무일 네모 채움이 인접 셀끼리 이어지도록(주말 세로 띠·연휴 가로 띠) 셀 간격은 두지 않는다. */
    gap: 0;
  }

  /* 휴무일 표기 = 셀 전체 네모 채움(원형 아님). 숫자 span 이 아니라 셀에 칠해야 이웃 휴무일과 띠로 이어진다. */
  &__miniDay {
    display: flex;
    align-items: center;
    justify-content: center;
    min-width: 0;
    min-height: 0;
    padding: 3px 0;
    font-size: $font-size-11;
    line-height: 1;
    color: $color-text-default;
    cursor: pointer;
    user-select: none;

    &.is-sunday   { color: $color-danger; }
    &.is-saturday { color: $color-now; }
    &.is-holiday  { color: $color-danger; }
    &.is-other    { color: transparent; cursor: default; }

    &.is-off {
      background-color: #FEF7F2;
    }

    /* hover — 브랜드색 1px 네모 테두리. inset box-shadow 라 셀 크기·이웃 띠가 밀리지 않는다. 다른 달 빈 셀은 제외. */
    &:not(.is-other):hover {
      box-shadow: inset 0 0 0 1px $color-primary;
    }

    &.is-drag-selecting {
      background-color: rgba(232, 139, 29, 0.45);
      color: #fff;
    }
  }

  &__miniDayNum {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 1.8em;
    height: 20px;
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
    border: 1px solid $color-border-light;
  }

  &__monthHeaderCell {
    padding: 8px 0;
    text-align: center;
    font-size: $font-size-13;
    font-weight: $font-weight-bold;
    color: $color-text-default;

    &.is-sunday   { color: $color-danger; }
    &.is-saturday { color: $color-now; }

    & + & {
      border-left: 1px solid $color-border-light;
    }
  }

  &__monthGrid {
    display: grid;
    grid-template-columns: repeat(7, 1fr);
    grid-auto-rows: 1fr;
    flex: 1;
    min-height: 0;
    border-left: 1px solid $color-border-light;
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

  /* ---------- 셀 entries / 더보기 (직원·팀·사업장 공통) ---------- */
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

    &:hover { color: $color-primary; }

    &.is-off {
      color: $color-text-muted;
    }

    /* 그 담당자에게 실제로 저장된 운영시간 — 사업장에서 빌려 그린 줄(is-inherited)과 눈으로 갈린다.
       기울기만으로는 티가 나지 않아 굵기를 얹었다. semibold(600) 인 이유: 700 은 일자 지정·편집 중·
       오류가 이미 쓰고 있어, 같은 값을 주면 "저장된 값"과 그 세 상태가 구분되지 않는다. */
    &.is-own {
      font-weight: $font-weight-semibold;
    }

    /* 그 날짜를 따로 지정한 줄 — 요일 반복을 따르는 줄과 눈으로 갈린다(화면정의서 APB033 §6-2).
       is-off 뒤에 둬야 "그 날짜만 휴무" 지정도 지정으로 보인다.
       굵기는 요일별(is-own)과 같은 semibold 로 두고 색으로만 가른다 — 색은 좌측 범례(__legend)와
       같은 값이어야 한다. 범례가 가리키는 대상이 이 줄이다.
       $color-primary(#2F6FED)보다 옅은 이 파일의 기존 오렌지를 쓴다(입력칸 focus 테두리와 같은 값). */
    &.is-designated {
      color: #E88B1D;
      font-weight: $font-weight-semibold;
    }

    &.is-editing {
      color: $color-primary;
      font-weight: $font-weight-bold;
    }

    /* 사업장에서 빌려온 시각 — 그 담당자에게 저장된 값이 아니다(showsInheritedStaffTime 과 같은 규약).
       is-designated 뒤에 둬도 지정 줄은 자기 값이라 여기 걸리지 않는다. */
    &.is-inherited {
      /* ★$color-text-muted(rgba(0,0,0,0.75))는 기본색 #333 과 거의 같아 구분되지 않는다.
         이 파일의 화살표 아이콘과 같은 회색을 쓴다. */
      color: #9e9e9e;
      font-style: italic;
    }

    /* 더보기 popover 안에서는 기울이지 않는다 — 셀과 달리 한 줄에 여유가 있어 회색만으로 충분하고,
       좁은 셀에서 자간을 벌지 않아도 되는 자리다. 색 규약은 그대로 공유한다. */
    &--more.is-inherited {
      font-style: normal;
    }

    /* 저장이 막힌 일자 지정 줄 — 시간 입력칸과 같은 빨간 값. 셀 안이라 테두리 대신 글자색으로 가리킨다. */
    &[data-invalid="true"] {
      @include invalid.text;
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

  /* 조회 장애(loadError)와 달리 사용자가 지금 고칠 수 있는 안내라 경고색으로 낮춘다. */
  &__missingTimeNotice {
    padding: 8px 12px;
    background: #FFF4E5;
    color: #8A5300;
    font-size: $font-size-13;
    line-height: 1.5;
    text-align: center;

    strong { font-weight: 700; }
  }

  &__missingTimeLine {
    margin: 0;
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
    background: #f7f7f7;
  }

}
</style>
