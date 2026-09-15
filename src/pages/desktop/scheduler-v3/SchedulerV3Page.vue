<script setup>
/**
 * V2 엔진 재설계 — route `/book` 페이지.
 * runLayout 출력(columns/bandInfos/rects)을 DOM 에 바인딩.
 * useBookStore() 인스턴스화 시 searchVersion watch(immediate)가 loadDoctor→loadSchedule→load 체인 트리거
 * (bookStore.load() 직접 호출 금지 준수).
 */
import { computed, nextTick, onBeforeUnmount, onMounted, provide, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import dayjs from 'dayjs'
import { debounce } from 'lodash-es'
import { push } from 'notivue'
import { useDialog } from '@/lib/useDialog'
import { useBookStore } from '@/stores/bookStore'
import { useStaffStore } from '@/stores/staffStore'
import { useHolidayStore } from '@/stores/holidayStore'
import { useSchedulerFilterStore } from '@/stores/useSchedulerFilterStore'
import { useQueryString } from '@/composables/useQueryString'
// 장부 설정(전체 칸 개수) 조회 — 방문 모드 zoom 이 설정 전체칸을 따르도록.
import { useReservationSettingStore } from '@/stores/reservationSettingStore'
import { pickBlockWarning, useSchedulerRules } from '@/composables/useSchedulerRules'
// 줄달력 날짜 상태(selectedDate 단일 기준).
import { useSchedulerNavigation } from '@/pages/desktop/scheduler/composables/useSchedulerNavigation'
// 인터랙션 composable 재사용(페이지-로컬 격리) — hover/popover/drag/resize/reschedule.
import { useSchedulerInteractionLock } from '@/pages/desktop/scheduler/composables/useSchedulerInteractionLock'
import { useSchedulerHover } from '@/pages/desktop/scheduler/composables/useSchedulerHover'
import { useSchedulerPopover } from '@/pages/desktop/scheduler/composables/useSchedulerPopover'
import { useSchedulerDrag } from '@/pages/desktop/scheduler/composables/useSchedulerDrag'
import { useSchedulerResize } from '@/pages/desktop/scheduler/composables/useSchedulerResize'
import { useSchedulerReschedule } from '@/pages/desktop/scheduler/composables/useSchedulerReschedule'
// 검색 pick 카드로의 세로 스크롤 계산(가시 판정 + 스크롤 컨테이너 탐색).
import { computeScrollDelta, findScrollContainer } from './searchScrollFocus'
import { runLayout } from '@/scheduler-engine/redesign/layoutPipeline'
import { normalizeRangeToGrid } from '@/scheduler-engine/schedulerSnapGrid'
import { STEP_MIN } from '@/constants/componentConstants'
import { toEngineAppointments } from '@/pages/desktop/scheduler/adapters/appointmentAdapter'
import { dragResultToBookItemRequest, resizeResultToBookItemRequest } from '@/pages/desktop/scheduler/adapters/dragResultAdapter'
import { normalizeName, resolveVisibleDoctors } from '@/utils/schedulerSearchFilterUtils'
import { countBoardStatistics, filterByStatus } from './boardStatistics'
import { labelBlockedReason } from '@/utils/formatStringUtils'
import { buildStoreRunLayoutInput } from './v3StoreInput'
import { reanchorArgsForSlot } from './navSlots'
import { toV2Bands, toV2Columns, toV2HeaderTree, toV2Rects } from './v3ParityAdapter'
// 공유 검색필터 컴포넌트 재사용. filterStore→searchVersion→bookStore 자체 구동.
import SchedulerSearchFilter from '@/pages/desktop/scheduleBoard/components/SchedulerSearchFilter.vue'
// 줄달력 — 예약 모드: 당일 포함 미래 30일 / 방문: 당일 포함 직전 30일.
import SchedulerDateStrip from '@/pages/desktop/scheduler/components/SchedulerDateStrip.vue'
// 렌더 컴포넌트 재사용(어댑터로 props 변환).
import SchedulerTimeAxis from '@/pages/desktop/scheduler/components/SchedulerTimeAxis.vue'
import NowIndicator from '@/pages/desktop/scheduler/components/NowIndicator.vue'
import SchedulerHeader from '@/pages/desktop/scheduler/components/SchedulerHeader.vue'
import SchedulerGrid from '@/pages/desktop/scheduler/components/SchedulerGrid.vue'
import SchedulerToolbar from '@/pages/desktop/scheduler/components/SchedulerToolbar.vue'
// 예약 카드 레이어 재사용 — 카드는 hover/popover/drag/resize 4 inject 필수(모두 provide).
import AppointmentLayer from '@/pages/desktop/scheduler/components/AppointmentLayer.vue'
import DragPreview from '@/pages/desktop/scheduler/components/DragPreview.vue'
import ResizePreview from '@/pages/desktop/scheduler/components/ResizePreview.vue'
// sub-column 칸수조절 — 컬럼별 개별(customSlots), 페이지-로컬 배선
import SubColResizeHandles from '@/pages/desktop/scheduler/components/SubColResizeHandles.vue'
import { useSubColResize } from '@/pages/desktop/scheduler/composables/useSubColResize'
// 예약 생성/수정 팝업 (공유 컴포넌트)
import ReservationPopup from '@/components/popup/ReservationPopup.vue'

// ── 실 store (read-only). useBookStore() 인스턴스화 → searchVersion watch(immediate) 가 load 체인 트리거 ──
const bookStore = useBookStore()
const staffStore = useStaffStore()
const filterStore = useSchedulerFilterStore()
const reservationSettingStore = useReservationSettingStore()
const holidayStore = useHolidayStore()
// 날짜 표기/이동을 일별(하루) 기준으로 DAY 강제. 조회 날짜 폭은 윈도우가 결정(viewMode 무관).
// ⚠️ useQueryString() 보다 먼저 강제한다 — URL 에 viewMode=DAY 가 남아 있으면 store 기본값(WEEK)과 달라
//    query→store 반영이 "실제 변경"으로 잡혀 재조회가 한 번 나간다. 어차피 DAY 로 만들 값이라 낭비다.
if (filterStore.viewMode !== 'DAY') filterStore.setViewMode('DAY', false)
// URL query(dataType/viewMode) ↔ filterStore 동기화 — 외부 deep-link 진입 + 기본 query set.
// (MR-Swap 으로 /book 을 SchedulerPage→V3Page 로 옮기며 누락됐던 호출 복구.)
useQueryString()
// query 가 viewMode=WEEK 였던 경우의 복구 — V3 는 DAY 전용(검색필터도 hide-view-mode)이라 최종값은 항상 DAY.
if (filterStore.viewMode !== 'DAY') filterStore.setViewMode('DAY', false)
const { appointments, appointmentsStale, redirectReason, serviceUnavailable, noTreatmentTime, pending: bookPending } = storeToRefs(bookStore)
const { doctors, hospitalRules, doctorRules, teams, workTimeLoadFailed } = storeToRefs(staffStore)
// 운영시간 조회 실패(원천 무관) — 보드는 fallback(기관/기본 시간)으로 그려지므로 배너로만 표면화한다.
// 재시도는 승인된 재조회 경로(searchVersion watch chain)로 — clearRedirect 가 initialized 도 풀어
// runInitialSetup(loadSchedule + noTreatmentTime 게이트)이 다시 돌게 한다.
const workTimeLoadFailedAny = computed(() => workTimeLoadFailed.value.site || workTimeLoadFailed.value.staff)
function retryWorkTime() {
  bookStore.clearRedirect()
  filterStore.triggerSearch()
}
// 날짜 행 '휴무' 라벨의 정의는 useSchedulerRules destructure 뒤(holidayLabelFor)에 있다 —
// 판정을 그 composable 하나로 모으려고 뒤로 뺐다. 소비처(computed)는 지연 평가라 순서에 영향이 없다.
const { periodDate, doctors: selectedDoctorIds, dataType, selectedTeamName, status: selectedStatusKeys } = storeToRefs(filterStore)
// 예약장부 설정(budget base/grid 간격/카드높이/표시정보). 미로딩 시 store 기본값 → onMounted 에서 조회.
const {
  totalColumns: settingTotalColumns,
  timeUnit: settingTimeUnit,
  displayInfo: settingDisplayInfo,
  rowHeightLevel: settingRowHeightLevel,
  // 설정 조회 진행 여부 — 조회 윈도우 폭(BUDGET_MAX)이 totalColumns 에 걸려 있어 응답 전엔 윈도우를 잡지 않는다.
  loading: settingLoading,
} = storeToRefs(reservationSettingStore)

// ── Navigation (selectedDate 단일 기준) ──
// 줄달력(SchedulerDateStrip)·UiDateNavigator·헤더가 공유하는 날짜 상태. filterStore.periodDate 와 양방향 sync.
const visibleDayCount = ref(1)
const navigation = useSchedulerNavigation({
  initialDate: dayjs(periodDate.value).format('YYYY-MM-DD'),
  headerWindowDays: 30,
  visibleDayCount,
})
// navigation → filterStore (날짜 이동 시 periodDate 동기화만, 재조회는 안 건다)
// ⚠️ trigger=false — 재조회는 조회 윈도우 경로(applyDataWindow→setWindow)가 담당한다.
//    여기서도 트리거하면 페이징 1회에 searchVersion 이 두 번 튀어 staff·장부·통계 전 세트가
//    2번씩 나갔다(실측). 커버 범위 안 이동이면 윈도우 경로가 재조회를 생략하는 것이 정합.
watch(() => navigation.selectedDate.value, (newDate) => {
  if (dayjs(periodDate.value).format('YYYY-MM-DD') !== newDate) {
    filterStore.patch({ periodDate: dayjs(newDate).toDate() }, false)
  }
})
// filterStore → navigation (UiDateNavigator/검색필터 등 외부 변경 동기화)
watch(periodDate, (newPeriodDate) => {
  const formatted = dayjs(newPeriodDate).format('YYYY-MM-DD')
  if (navigation.selectedDate.value !== formatted) {
    navigation.goToDate(formatted)
  }
})
// runLayout/카드매핑이 쓰는 선택 날짜(ymd) = navigation 단일 기준
const selectedDate = computed(() => navigation.selectedDate.value)

// 담당자 0명(표시 컬럼 없음)일 때 헤더에 표기할 날짜 라벨 — 날짜는 정해져 있으므로 담당자 행만 비고 날짜는 보인다.
const WEEKDAY_KO = ['일', '월', '화', '수', '목', '금', '토']
const fallbackDateLabel = computed(() => {
  const d = dayjs(selectedDate.value)
  return d.isValid() ? `${d.format('MM-DD')} (${WEEKDAY_KO[d.day()]})` : ''
})
// 담당자 0명(fallback) 헤더의 공휴일 휴무 — 빨간 span 으로 별도 표기.
const fallbackHolidayLabel = computed(() => {
  const d = dayjs(selectedDate.value)
  return d.isValid() ? holidayLabelFor(d.format('YYYY-MM-DD')) : undefined
})

// 나머지는 페이지-로컬 (DB 저장 X) — 보기단계/N칸/페이지
// N칸보기 기본값 = 2 (예약·방문 공통). 예약은 툴바로 라이브 조절, 운영은 effectiveSlotDivision 에서 2 강제.
const viewStep = ref(3)
const slotDivision = ref(2)
// 컬럼별 칸수 override(state-only). { '${date}__${doctorId}': N }. 드래그로 특정 컬럼만 N칸 조절 → 엔진 resolveSlots 우선 적용.
const customSlots = ref({})
// 칸수배정 모델. 'A'=레인폭=min(동시겹침, N) — 예약이 겹치는 만큼만 컬럼을 넓힌다(빈 담당자=1칸).
// 'B2'=레인폭 N고정(데이터 무관). 엔진 default(미전달)도 'A'.
const layoutMode = ref('A')
// date-anchored 윈도우 시작 sub-col offset. 좌측 끝은 항상 selectedDate(날짜)로 고정 →
// 데이터 재조회로 밀도가 변해도 보던 날짜가 안 끌려감(헤더 > 빈보드 점프 차단). 0 = selectedDate 첫 컬럼부터.
// >0 은 하루 컬럼수가 budget 을 초과할 때만(within-day 담당자 페이징).
const colOffset = ref(0)
// 헤더 담당자 <> 의 날짜 re-anchor 용 — selectedDate 변경(→colOffset reset) 후 flush:post 에서 복원할 offset.
const pendingColOffset = ref(null)
// 시간축 수동 확장(시간) — 시작 일찍(^)/종료 늦게(v).
const timelineTopExtend = ref(0)
const timelineBottomExtend = ref(0)

// ── 줄달력 상태 + 이벤트 (예약/방문 분기) ──
// 줄달력은 filterStore.dataType(실제 토글) 기준 분기.
const isTreatmentMode = computed(() => dataType.value === 'TREATMENT')
// 방문 모드는 N칸 2 강제(라이브 무시). 렌더(viewState)와 drag/resize hitTest 가 동일 값을 써야 좌표 정합 → 단일 computed.
const effectiveSlotDivision = computed(() => (isTreatmentMode.value ? 2 : slotDivision.value))
const dateStripMode = ref('rolling')
const expandedMonth = ref(null)

// 예약: 당일 포함 미래 30일 / 방문: 당일 포함 직전 30일(당일=오른쪽 끝)
function computeInitialStrip() {
  return isTreatmentMode.value
    ? dayjs().subtract(29, 'day').format('YYYY-MM-DD')
    : dayjs().format('YYYY-MM-DD')
}
const stripWindowStart = ref(computeInitialStrip())
// 방문: 미래 표기 불가 → 줄달력 maxDate=오늘 (월버튼 왼쪽·› 숨김 자동). 예약: 제한 없음.
const stripMaxDate = computed(() => (isTreatmentMode.value ? dayjs().format('YYYY-MM-DD') : null))

// 방문: strip 끝(start+29) ≤ 오늘 보장
function clampStripForTreatment() {
  if (!isTreatmentMode.value) return
  const maxStart = dayjs().subtract(29, 'day').format('YYYY-MM-DD')
  if (stripWindowStart.value > maxStart) stripWindowStart.value = maxStart
}
function isInStripRange(date) {
  const start = dayjs(stripWindowStart.value)
  const end = start.add(29, 'day')
  return !dayjs(date).isBefore(start, 'day') && !dayjs(date).isAfter(end, 'day')
}
function adjustStripToInclude(date) {
  // 방문: 선택일이 strip 끝 / 예약: 선택일이 strip 시작
  stripWindowStart.value = isTreatmentMode.value
    ? dayjs(date).subtract(29, 'day').format('YYYY-MM-DD')
    : dayjs(date).format('YYYY-MM-DD')
  clampStripForTreatment()
}
function ensureStripContains(date) {
  if (!isInStripRange(date)) adjustStripToInclude(date)
}

// 연두 ‹› : strip + 선택일 ±1일
function onStripShiftPrev() {
  navigation.goPrevDay()
  stripWindowStart.value = dayjs(stripWindowStart.value).subtract(1, 'day').format('YYYY-MM-DD')
}
function onStripShiftNext() {
  // 방문: 오늘 이후 이동 불가
  if (isTreatmentMode.value && !dayjs(navigation.selectedDate.value).isBefore(dayjs(), 'day')) return
  navigation.goNextDay()
  stripWindowStart.value = dayjs(stripWindowStart.value).add(1, 'day').format('YYYY-MM-DD')
  clampStripForTreatment()
}
// 노랑 ◁▷ : 선택일 기준 ±1달 (명세 9 확정 — 날짜 유지, 달만 ±1)
function onExpandPrevMonth() {
  const base = dateStripMode.value === 'monthExpanded' && expandedMonth.value
    ? dayjs(`${expandedMonth.value}-01`)
    : dayjs(navigation.selectedDate.value)
  const target = base.subtract(1, 'month').format('YYYY-MM-DD')
  navigation.goToDate(target)
  adjustStripToInclude(target)
  dateStripMode.value = 'rolling'
  expandedMonth.value = null
}
function onExpandNextMonth() {
  const base = dateStripMode.value === 'monthExpanded' && expandedMonth.value
    ? dayjs(`${expandedMonth.value}-01`)
    : dayjs(navigation.selectedDate.value)
  let target = base.add(1, 'month').format('YYYY-MM-DD')
  // 방문: 오늘 이후 불가 → 오늘로 clamp
  if (isTreatmentMode.value && target > dayjs().format('YYYY-MM-DD')) {
    target = dayjs().format('YYYY-MM-DD')
  }
  navigation.goToDate(target)
  adjustStripToInclude(target)
  dateStripMode.value = 'rolling'
  expandedMonth.value = null
}
// 날짜 셀 클릭
function onDateStripSelectDate(date) {
  navigation.goToDate(date)
  ensureStripContains(date)
  if (dateStripMode.value === 'monthExpanded') {
    dateStripMode.value = 'rolling'
    expandedMonth.value = null
  }
}
// 월 축약 버튼: 해당 월 1일로 strip + 선택일 이동 (rolling 유지)
function onExpandMonth(yearMonth) {
  const target = `${yearMonth}-01`
  navigation.goToDate(target)
  stripWindowStart.value = target
  clampStripForTreatment()
}
// [오늘]
function onDateStripGoToday() {
  navigation.goToday()
  stripWindowStart.value = computeInitialStrip()
  dateStripMode.value = 'rolling'
  expandedMonth.value = null
}
// 선택일이 외부(검색필터/헤더)에서 변경될 때 strip 보정
watch(() => navigation.selectedDate.value, (date) => {
  ensureStripContains(date)
})
// dataType(예약↔방문) 전환 시 strip 재계산. selectedDate 클램프는 filterStore.setDataType(#1) 담당.
watch(isTreatmentMode, () => {
  stripWindowStart.value = computeInitialStrip()
  dateStripMode.value = 'rolling'
  expandedMonth.value = null
})

const viewState = computed(() => ({
  // TREATMENT 시 엔진 buildUnitSequence 가 horizon=1일로 전환. 카드 상태셋/⋮메뉴/hover 는 AppointmentCard 가 dataType 직접 구독.
  dataType: dataType.value,
  selectedDate: selectedDate.value,
  // 방문 장부 기본값 강제: 라이브 zoom/N칸(예약값) 무시하고 설정 전체칸(viewStep=3 → budget=totalColumns)·N칸2.
  // ref 자체는 예약값 보존 → 예약 복귀 시 사용자 zoom/N칸 유지. layout 계산만 방문 시 기본 적용.
  viewStep: isTreatmentMode.value ? 3 : viewStep.value,
  slotDivision: effectiveSlotDivision.value,
  // 컬럼별 칸수 — customSlots override 우선, 없으면 기본(예약=slotDivision / 방문=2).
  customSlots: customSlots.value,
  // date-anchored 모델: 엔진이 [colOffset, colOffset+budget) 임의 슬라이스. 좌측=selectedDate 기준.
  slotOffset: colOffset.value,
  // 시간축 수동 확장(^v ±1h)
  timelineTopExtendHours: timelineTopExtend.value,
  timelineBottomExtendHours: timelineBottomExtend.value,
  layoutMode: layoutMode.value,
}))

// ── availableWidth 측정 (ResizeObserver) ──
const boardEl = ref(null)
// sticky 헤더 — 검색 pick 스크롤이 "헤더에 가린 카드"를 보인 것으로 오판하지 않도록 실측에 쓴다.
const boardHeadEl = ref(null)
const availableWidth = ref(0)
let ro = null

onMounted(() => {
  // 예약장부 설정(전체 칸 개수) 조회 — 캐시 있으면 skip. budget/윈도우 base 갱신.
  reservationSettingStore.load()
  // #2 담당자 sync 전략 — 장부 처음 진입 시 외부 동기화 1회(비차단).
  //   /staff(loadDoctor)=로컬 selectStaffList 라 외부 담당자 추가/삭제는 syncDoctor 발화 시점에만 반영.
  //   설정팝업 열 때(SchedulerSearchFilter)에만 발화하던 것을 진입 시에도 1회 보강 → 새로고침만으로 최신 목록.
  //   await 안 함(렌더 비차단). 매 검색마다가 아닌 진입 1회. 수동 갱신은 검색필터 ↻ 버튼.
  staffStore.syncDoctor()
  if (!boardEl.value) return
  // 정수로 끊는다 — 컬럼 경계(정수)와 보드 오른쪽 끝이 같은 자리여야 우측 끝 구분선이 경계에 맞는다.
  // 내림인 이유: 올림하면 헤더 폭이 실제 칸보다 넓어져 마지막 세로선이 overflow:hidden 에 잘린다.
  ro = new ResizeObserver((entries) => {
    availableWidth.value = Math.floor(entries[0]?.contentRect?.width ?? 0)
  })
  ro.observe(boardEl.value)
  availableWidth.value = Math.floor(boardEl.value.getBoundingClientRect().width)
  nowTimer = setInterval(() => { nowTick.value = Date.now() }, 30_000)
})

onBeforeUnmount(() => {
  ro?.disconnect()
  ro = null
  if (nowTimer) clearInterval(nowTimer)
  // V3 떠날 때 조회 윈도우 해제 → V2 등 다른 소비자는 기존 viewMode/periodDate 경로로 복귀(잔류 방지).
  filterStore.setWindow(null, 0, false)
})

// ── 로딩 표시 ──────────────────────────────────────────
// 진입 직후엔 담당자·예약장부 설정·운영시간·예약이 순차로 도착할 때까지 보드가 빈 격자로 보인다.
// 그 구간을 "로딩 중"으로 알린다 — 데이터가 없는 건지 불러오는 중인지 사용자가 구분할 수 없기 때문.
// 최초 조회가 한 번 끝나면(pending true→false) 이후는 재조회로 취급해 표시를 약하게 한다
// (전체를 덮으면 페이징·필터 조작 때마다 화면이 통째로 가려져 오히려 답답하다).
const boardReady = ref(false)
watch(bookPending, (now, prev) => { if (prev && !now) boardReady.value = true })
// 최초 로딩 = 아직 한 번도 그릴 데이터를 못 받은 상태. 보드를 덮는 오버레이.
// 실패(재시도 안내·설정 화면 이동)로 끝난 경우엔 조회가 시작되지도 않아 boardReady 가 영영 false 다
// → 그 상태에서 "불러오는 중"을 계속 띄우면 거짓 안내가 된다. 실패 신호가 있으면 즉시 걷는다.
const isInitialLoading = computed(() =>
  !boardReady.value && !redirectReason.value && !serviceUnavailable.value)
// 재조회 = 이미 그려진 화면 위에서 갱신 중. 상단 진행바만(레이아웃 이동 없음).
const isRefreshing = computed(() => boardReady.value && bookPending.value)

// ── 팀 표시 필터 (이름 통일): 미지정=담당자 목록−팀멤버 / 팀=∩ → 컬럼(header tree) 소스 ──
const visibleDoctors = computed(() => resolveVisibleDoctors(selectedTeamName.value, doctors.value, teams.value))

// ── 조회 윈도우 = 예약0(최소밀도) 가정 한 화면 채울 일수 + 버퍼1 (담당자/budget 기반 동적, 과조회 방지) ──
// 담당자 많으면 적게(하루 칸수 > budget → 1일), 적으면 많이 조회. 표시(horizon)가 조회를 주도.
// budget_max = zoom out 최대(viewStep=1) = totalColumns + 4. totalColumns = 예약장부 설정값(reservationSettingStore).
// 설정 6칸이면 budget_max 10 → 윈도우 조회량이 설정에 정합. 방문(TREATMENT)는 엔진이 horizon=1 강제라 무관.
const BUDGET_MAX = computed(() => settingTotalColumns.value + 4) // = computeBudget(totalColumns, viewStep=1)
const MAX_WINDOW_DAYS = 90
// 실제 표시 담당자 수 = 팀/미지정 visibleDoctors ∩ 검색필터 담당자선택(없으면 전체).
const activeDoctorCount = computed(() => {
  const sel = selectedDoctorIds.value
  const visible = visibleDoctors.value
  if (sel.length === 0) return visible.length
  return visible.filter(d => sel.includes(d.id)).length
})
// 한 화면(budget_max)을 채울 최소 일수 (예약0 → 담당자당 1칸). 담당자 0 가드.
const baseWindowDays = computed(() => {
  const n = activeDoctorCount.value
  return n <= 0 ? 1 : Math.max(1, Math.ceil(BUDGET_MAX.value / n))
})
// 패킹 horizon = 날짜 컬럼 레이아웃 범위(데이터 무관, forward). date-anchored 라 windowChunks/자동채움 불필요 —
// 임의 colOffset+budget 윈도우가 항상 채워지도록 한 화면(baseWindowDays)의 넉넉한 배수로 고정.
// ⚠️ 데이터 조회와 분리 — 조회는 "보이는 날짜 범위"(visibleDates, 아래)만 주도하므로 horizon 을 키워도 과조회 없음.
const horizonDays = computed(() => Math.min(MAX_WINDOW_DAYS, baseWindowDays.value * 3 + 7))

// ── 타임라인 밴드 소스 일원화(이슈②③) ──
// 타임라인 밴드를 담당자 운영시간(담당자 우선 → 미설정 요일은 기관 fallback)으로 계산해
// 예약검증(getBlockedReason, DOCTOR_FIRST)과 같은 소스를 쓰게 한다.
//  - ② "담당자 요일 운영시간 설정해도 타임라인에 안 뜸" → 담당자 시간이 밴드에 반영돼 해소.
//  - ③ "타임라인 활성인데 예약 시 운영종료 alert" → 밴드와 검증이 같은 소스라 괴리 해소.
// QA 원복은 이 상수만 false 로 — false 면 타임라인이 기관 단독(현행)으로 복귀(바이트 동일).
const USE_DOCTOR_HOURS_IN_TIMELINE = true
// doctorRules({담당자키:{weekly}}) → {담당자키: weekly}. 키 = replaceDoctorName(이름) = name 모드 unit.doctorId 정합.
const doctorWeeklyById = computed(() => {
  if (!USE_DOCTOR_HOURS_IN_TIMELINE) return undefined
  const out = {}
  for (const [key, rule] of Object.entries(doctorRules.value ?? {})) {
    if (rule?.weekly) out[key] = rule.weekly
  }
  return out
})
// doctorRules → {담당자키: {날짜: DailySchedule}} — 특정일자 운영 시각(밴드용). 요일 시각과 같은 스위치를 탄다.
const doctorDailyByDateById = computed(() => {
  if (!USE_DOCTOR_HOURS_IN_TIMELINE) return undefined
  const out = {}
  for (const [key, rule] of Object.entries(doctorRules.value ?? {})) {
    if (rule?.dailyByDate && Object.keys(rule.dailyByDate).length) out[key] = rule.dailyByDate
  }
  return out
})

/* 국가 공휴일 목록 → 엔진이 쓰는 배열로. store 는 Set 이라 조회가 빠르지만 엔진 config 는 plain 만 담는다.
 * ★"사업장이 문을 여는 공휴일"(holidayOpenDates)이 아니라 **공휴일 전부**를 넘긴다 — 공휴일 축은
 *  담당자 자기 값(HOLIDAY_OPEN_YN)이라 기관이 쉬어도 그날 운영하는 담당자가 있고, 그 사람의 밴드는
 *  기관 공휴일 운영시간으로 그려야 한다. 예약검증(useSchedulerRules 의 isPublicHolidayDate)과 한 쌍이다. */
const publicHolidayDateList = computed(() => {
  const src = hospitalRules.value?.publicHolidayDates
  if (!src) return []
  return Array.isArray(src) ? src : Array.from(src)
})

// ── 상태 필터 = 그리는 단계에서 숨긴다(엔진 입력은 전체) ──
// 목록은 모든 상태를 받는다(조회 payload 에 status 없음). 엔진에도 전체를 넣어 칸의 폭·한 페이지에 드는
// 날짜가 필터와 무관하게 같도록 하고, 숨길 카드는 rect 단계에서 뺀다(visibleRects). 엔진 입력을 줄이면
// 겹침이 줄어 칸이 좁아지고 날짜가 더 들어와, '취소' 칩을 켰다고 '전체'·'예약' 숫자가 늘어난다.
// 거르는 기준은 카드가 보이는 상태(toDisplayStatus) — 예약장부의 '예약' 칩은 완료·미이행·대기도
// 함께 보여 준다(카드가 '예약'으로 그려지는 것과 같은 규칙). 숨긴 자리(레인)는 빈 채로 남는다.
const hiddenAppointmentIds = computed(() => {
  if (selectedStatusKeys.value.length === 0) return new Set()
  const shown = new Set(filterByStatus(appointments.value, selectedStatusKeys.value, dataType.value).map(a => a.id))
  return new Set(appointments.value.filter(a => !shown.has(a.id)).map(a => a.id))
})

// ── 엔진 파이프 (store → adapter → runLayout) ──
const layout = computed(() =>
  runLayout(buildStoreRunLayoutInput({
    doctors: visibleDoctors.value,
    appts: appointments.value,
    // 기관 운영시간(institution) = timeline·미설정 담당자 요일의 fallback 소스.
    weekly: hospitalRules.value?.weekly,
    // 공휴일 운영시간 — 공휴일에 운영하는 날은 요일·담당자 시간 대신 기관 공휴일 시간으로 밴드를 그린다
    // (예약검증 useSchedulerRules 와 같은 규칙. 한쪽만 반영하면 "밴드는 열렸는데 클릭하면 운영종료").
    holiday: hospitalRules.value?.holiday,
    holidayDates: publicHolidayDateList.value,
    dailyByDate: hospitalRules.value?.dailyByDate ?? undefined,
    // 담당자별 요일 운영시간(밴드용). 미설정 요일은 어댑터→엔진 fallback 이 기관으로 메꾼다.
    doctorWeeklyById: doctorWeeklyById.value,
    // 담당자별 특정일자 운영 시각(밴드용). 그 날짜는 요일·기관 시각 대신 이걸로 연다 — 예약검증과 한 쌍.
    doctorDailyByDateById: doctorDailyByDateById.value,
    availableWidth: availableWidth.value,
    selectedDate: selectedDate.value,
    viewState: viewState.value,
    selectedDoctorIds: selectedDoctorIds.value,
    horizonDays: horizonDays.value,
    totalColumns: settingTotalColumns.value,
    // — 예약장부 설정값 엔진 주입: timeUnit→grid 간격, rowHeightLevel→카드높이, displayInfo→카드렌더(23-2)
    timeUnit: settingTimeUnit.value,
    displayInfo: settingDisplayInfo.value,
    rowHeightLevel: settingRowHeightLevel.value,
  })),
)

const columns = computed(() => layout.value.columns)
const bandInfos = computed(() => layout.value.bandInfos)
// step16 컬럼별 현재 칸수 맵 — SubColResizeHandles 분할선용.
// 화면에 그리는 칸수(subColCount)를 쓴다. 경계에서 압축된 컬럼은 unit.slots 보다 작으므로
// unit.slots 를 쓰면 분할선이 실제 레인과 어긋난다(카드는 subColCount 로 배치되므로).
const slotsByKey = computed(() => {
  const map = {}
  for (const col of layout.value.columns) map[col.unit.key] = col.subColCount
  return map
})

// ── 시간축 수동 확장 — V1 SchedulerTimeCell 동일: ∧(top, 시작 일찍) / ∨(bottom, 종료 늦게), 확장 전용 ──
// 경계 도달 시 버튼 숨김(V1: startDayHour>0 / endDayHour<24).
const operatingRange = computed(() => layout.value.operatingRange)
const canExtendTop = computed(() => operatingRange.value.startMin > 0)
const canExtendBottom = computed(() => operatingRange.value.endMin < 1440)
function onExtendTop() { timelineTopExtend.value++ }
function onExtendBottom() { timelineBottomExtend.value++ }
// TimeAxis/Grid/NowIndicator 용 band 형태로 변환(startMinute/endMinute/blocked/bandIndex).
const v2Bands = computed(() => toV2Bands(bandInfos.value))
// Header/Grid/NowIndicator 용 FlatColumn 형태로 변환(key/date/resourceId/leftPx/widthPx).
const v2Columns = computed(() => toV2Columns(columns.value))
// SchedulerHeader 용 날짜>담당자 트리(leaf.key=unit.key → 담당자1명 행제거 자동 동작).
const v2HeaderTree = computed(() => toV2HeaderTree(columns.value, holidayLabelFor))

// 현재 페이지에 보이는 날짜들 — 공휴일 연도 보장·페이징 폭 등 표시용. 조회 윈도우는 선택 날짜 기준(아래)이라 여기에 매달리지 않는다.
const visibleDates = computed(() => [...new Set(columns.value.map(c => c.unit.date))].sort())
// 표시 날짜들의 연도 공휴일 보장 — 연 이동 시 누락 연도 보충(App.vue 는 현재±1년만 프리로드). 헤더 공휴일명 표기용.
watch(visibleDates, (dates) => {
  const years = [...new Set(dates.map(d => Number(d.slice(0, 4))).filter(Boolean))]
  if (years.length) holidayStore.ensureYears(years)
}, { immediate: true })
// ── 데이터 조회 윈도우 = 선택 날짜 기준 (layout 결과와 무관) ──
// 목록과 통계(상태·회원 카운트)는 이 창 하나를 같은 파라미터로 쓴다. 창을 둘로 나누면
// 보드에 그려진 것과 숫자의 모수가 갈라지므로 나누지 않는다.
//
// ⚠️ 예전에는 창을 "보이는 날짜 범위"(visibleDates)로 잡았다. 그 값은 layout 결과라 데이터에
//    연동된다 — 카드가 겹치면 레인이 늘어 컬럼이 넓어지고, 한 페이지에 담기는 날짜가 줄었다
//    늘었다 한다. 그대로 재조회하면 조회 → 카드 도착 → 표시 일수 변화 → 재조회 의 되먹임이
//    생겨 페이징 1회에 조회가 3번 나갔고, 그래서 covering 규칙(이미 조회한 범위 안이면 재조회
//    안 함)으로 끊었다. 그런데 그 규칙 때문에 날짜를 옮겨도 창이 그대로여서 상태·회원 카운트가
//    이전 날짜의 값으로 남았다(줄달력 ‹ › 이동에서 재현).
//    → 창을 layout 결과에서 떼어낸다. selectedDate + baseWindowDays 는 예약장부 설정값과 표시
//      담당자 수로만 정해져 데이터에 연동되지 않으므로 되먹임이 없고, covering 규칙 없이도 날짜를
//      옮기면 언제나 그 범위로 갱신된다. baseWindowDays 는 겹침 0 가정의 한 화면 일수라,
//      겹침이 많은 날은 화면에 그려지는 날짜가 이보다 적을 수 있다(그만큼 미리 받아 둔 셈).
const dataWindowAnchor = computed(() => selectedDate.value)
const dataWindowDays = computed(() => baseWindowDays.value)

// load 직접호출 금지 → setWindow→searchVersion watch chain. setWindow dedup(anchor+days 동일 return)으로 수렴.
// 랜딩 중에는 표시 담당자 집합이 단계적으로 확정된다(전체 → 팀 미배정만 → 기본 팀). 그 중간 상태마다
// 재조회하면 같은 화면에서 조회가 3번 나가므로, 마지막 값 1회로 수렴시킨다(SSE 재조회와 동일 패턴).
const applyDataWindow = debounce(() => {
  // 표시 담당자가 아직 없으면(담당자 로드 전) 잡지 않는다 — baseWindowDays 가 담당자 수로 정해져
  // 로드 전 값으로 한 번, 로드 후 또 한 번 조회가 나간다.
  if (activeDoctorCount.value === 0) return
  // 예약장부 설정(전체 칸 개수)이 도착하기 전에는 잡지 않는다 — 기본값으로 한 번, 응답 후 또 한 번 나간다.
  // 설정 조회가 실패해도 loading 은 풀리므로(기본값 유지) 윈도우가 영영 미설정으로 남지는 않는다.
  if (settingLoading.value) return

  filterStore.setWindow(dayjs(dataWindowAnchor.value).toDate(), dataWindowDays.value)
}, 150)
// settingLoading 을 watch 소스에 함께 둔다 — 설정 응답이 기본값과 같아도(totalColumns 불변) 대기 해제 시 잡히도록.
watch([dataWindowAnchor, dataWindowDays, settingLoading], () => applyDataWindow(), { immediate: true })
// 떠난 뒤 늦게 발화해 해제해 둔 윈도우(setWindow(null,0))를 되살리지 않도록 취소.
onBeforeUnmount(() => applyDataWindow.cancel())

// ── 통합 페이징 (date-anchored) — 좌측 끝 = selectedDate(날짜), colOffset = within-day offset ──
// 엔진이 [colOffset, colOffset+budget) 임의 슬라이스. 헤더 담당자 <> 는 윈도우를 budget 칸씩 이동하되
// 착지한 컬럼의 "날짜"로 selectedDate 를 재고정 → 데이터 재조회로 밀도가 변해도 좌측 날짜가 안 끌려감(점프 차단).
const totalSlots = computed(() => layout.value.totalSlots)
// 실제 적용된(clamp 후) 윈도우 시작 offset — 증감 계산의 기준.
const effectiveColOffset = computed(() => layout.value.slotOffset)
// 현 horizon 안에 다음 윈도우가 더 있나 — 엔진이 unit 경계로 낸 다음 시작 slot 유무로 판정.
const hasMoreForward = computed(() => layout.value.nextSlotOffset != null)
// 예약: <> 항시(과거/미래 무한). 방문: < 항시(과거), > 는 오늘 도달 시 숨김(미래 불가).
const canPrevDoctor = computed(() => totalSlots.value > 0)
const canNextDoctor = computed(() =>
  isTreatmentMode.value
    ? hasMoreForward.value || dayjs(selectedDate.value).isBefore(dayjs(), 'day')
    : totalSlots.value > 0,
)

// 좌측 끝을 (date, 그 날짜 내 offset) 로 재고정. 같은 날=직접 / 날짜 변경=pending(flush:post 복원).
function reanchorTo(date, offset) {
  if (date === selectedDate.value) {
    colOffset.value = Math.max(0, offset)
  } else {
    pendingColOffset.value = Math.max(0, offset)
    navigation.goToDate(date) // selectedDate 변경 → colOffset reset(0) → units watch(post) 가 pending 복원
  }
}
// 헤더 담당자 > — 다음 윈도우로 전진(착지 컬럼의 날짜로 재고정).
// 이동 단위는 budget 칸이 아니라 **엔진이 낸 unit 경계**다 — 마지막 컬럼이 압축 표시됐어도
// 그 담당자는 이미 다 봤으므로 다음 페이지는 그 다음 담당자부터 시작한다(중복 노출 방지).
function onNextDoctor() {
  const target = layout.value.nextSlotOffset
  if (target != null) {
    const at = reanchorArgsForSlot(layout.value.units, target, selectedDate.value)
    reanchorTo(at.date, at.offset)
    return
  }
  // horizon 끝 → 미래로 (예약: 보이는 일수만큼 앞 / 방문: 오늘까지 +1일).
  if (isTreatmentMode.value) {
    if (dayjs(selectedDate.value).isBefore(dayjs(), 'day')) {
      reanchorTo(dayjs(selectedDate.value).add(1, 'day').format('YYYY-MM-DD'), 0)
    }
    return
  }
  reanchorTo(dayjs(firstVisibleDate.value).add(Math.max(1, visiblePageDays.value), 'day').format('YYYY-MM-DD'), 0)
}
// 헤더 담당자 < — 이전 윈도우로 후퇴(unit 경계, 엔진 산출).
function onPrevDoctor() {
  const target = layout.value.prevSlotOffset
  if (target != null) {
    const at = reanchorArgsForSlot(layout.value.units, target, selectedDate.value)
    reanchorTo(at.date, at.offset)
    return
  }
  // 과거로 — 보이는 일수만큼(방문 1일) selectedDate 뒤로, colOffset 0.
  const back = isTreatmentMode.value ? 1 : Math.max(1, visiblePageDays.value)
  reanchorTo(dayjs(selectedDate.value).subtract(back, 'day').format('YYYY-MM-DD'), 0)
}
// 날짜 re-anchor 후 pending colOffset 복원 — units 재구성(selectedDate 변경) 후 flush:post.
// reset watch(pre, colOffset=0) 가 먼저 실행된 뒤 pending 으로 덮어씀(순서 보장).
watch(() => layout.value.units, () => {
  if (pendingColOffset.value == null) return
  const offset = pendingColOffset.value
  pendingColOffset.value = null
  colOffset.value = offset
}, { flush: 'post' })
// colOffset 리셋 — 페이지 구성이 바뀌는 변경(날짜/필터/팀/zoom/N칸). 헤더 re-anchor 는 pendingColOffset 가 post 로 덮음.
watch(
  [selectedDate, selectedDoctorIds, dataType, selectedTeamName, slotDivision, viewStep],
  () => { colOffset.value = 0 },
)
// 장부(예약↔방문) 전환 시 보기단계/N칸을 기본값(보기단계=3·N칸=2)으로 리셋 — 한 장부의 라이브 조절값이 다른 장부로 이월되지 않음.
watch(dataType, () => {
  viewStep.value = 3
  slotDivision.value = 2
})
// 예약장부 설정 "전체 칸 개수" 변경(저장) 시 보기단계(zoom)를 기본값(3)으로 리셋.
//   viewStep=3 ⟺ budget = totalColumns(공식 중립점) → 보드가 새 설정 전체칸을 정확히 표시.
//   전체칸이 실제로 바뀔 때만 발화(rowHeightLevel 등만 바꾼 저장은 동일값→zoom 보존).
watch(settingTotalColumns, () => {
  if (viewStep.value !== 3) viewStep.value = 3
})
// 담당자 행 항상 유지 → 1명만 선택/표시돼도 해당 담당자명이 헤더에 보이게(사용자 요구).
// (페이징으로 한 페이지에 1명만 표시될 때 담당자행이 사라져 < > 까지 갇히는 것도 함께 방지.)
const keepDoctorRow = computed(() => true)

// ── 본문 좌우 페이지 네비 — 화면 보이는 일자수만큼 ±N일 이동(슬라이드+재조회) ──
// 헤더 담당자 <> 는 윈도우를 budget 칸씩(담당자+날짜 혼합), 본문 좌우 <> 는 보이는 일자 단위 점프.
// visibleDates 는 위(데이터 조회 윈도우)에서 정의 — 보이는 날짜 수만큼 점프.
const visiblePageDays = computed(() => visibleDates.value.length || 1)
// firstVisible = 좌측 첫 컬럼의 날짜 (date-anchored: colOffset 0 이면 selectedDate, within-day overflow 면 그 날짜).
const firstVisibleDate = computed(() => visibleDates.value[0] ?? selectedDate.value)
const lastVisibleDate = computed(() => visibleDates.value[visibleDates.value.length - 1] ?? selectedDate.value)
// 줄달력 하이라이트(=firstVisible)가 strip 윈도우 밖으로 스크롤되면(헤더 담당자 <> 페이징으로 anchor≠firstVisible)
// 윈도우를 따라 이동. ensureStripContains 는 범위 밖일 때만 조정(멱등) — re-anchor 조작은 selectedDate watch 가 이미 커버.
watch(firstVisibleDate, (date) => { ensureStripContains(date) })
// 방문 모드는 미래 불가 → 마지막 보이는 날짜가 오늘 이전일 때만 다음 구간 허용(줄달력 maxDate 정합).
const canBodyNext = computed(() => !isTreatmentMode.value || dayjs(lastVisibleDate.value).isBefore(dayjs(), 'day'))
// 본문 <> = 보이는 첫 날짜(firstVisible) 기준 ±N일. goToDate → colOffset reset(0) → 좌측=새 날짜.
//   date-anchored 라 colOffset 복원 불필요(0 착지). firstVisible 기준이므로 헤더 페이징 후에도 보이는 화면 기준 이동.
function onBodyPagePrev() {
  reanchorTo(dayjs(firstVisibleDate.value).subtract(visiblePageDays.value, 'day').format('YYYY-MM-DD'), 0)
}
function onBodyPageNext() {
  if (!canBodyNext.value) return
  reanchorTo(dayjs(firstVisibleDate.value).add(visiblePageDays.value, 'day').format('YYYY-MM-DD'), 0)
}

// 🔑 zoom·N칸 변경 시 "지금 보고 있는 날짜"(firstVisible) 유지 — 좌측 날짜로 점프 방지.
//   변경 직전 firstVisible 캡처 → 변경 후 좌측을 그 날짜로 재고정(colOffset 0). 미분기면 no-op.
function reanchorThen(apply) {
  const keep = firstVisibleDate.value // 변경 전 보고 있는 첫 날짜
  apply()
  if (keep && keep !== selectedDate.value) reanchorTo(keep, 0)
}
// zoom·N칸(전역 base) 변경 시 컬럼별 칸수조절(customSlots) 리셋 — 이전 base 기준이라 stale, 새 보기 설정 기본 레이아웃으로 초기화.
function resetCustomSlots() { if (Object.keys(customSlots.value).length) customSlots.value = {} }
function onChangeViewStep(v) { reanchorThen(() => { viewStep.value = v; resetCustomSlots() }) }
function onChangeSlotDivision(v) { reanchorThen(() => { slotDivision.value = v; resetCustomSlots() }) }

// ── 휴무/차단 규칙 (useSchedulerRules 재사용) — Grid 셀 음영 + 헤더 휴무 뱃지 ──
const blockOptions = ref({ lunchBlock: true, blockedTime: true, closedDay: true })
const ruleCellDuration = computed(() => layout.value.config.cellDuration ?? 30)
const selectedDoctorSet = computed(() => new Set(selectedDoctorIds.value))
// 담당자 운영시간/요일휴무 우선(DOCTOR_FIRST), 담당자 미설정 요일은 기관(institution)으로 fallback(FALLBACK).
// 담당자가 설정한 요일은 그 담당자 daily 통째로 사용(기관 점심 merge 안 함).
const rulesOptions = { priority: 'DOCTOR_FIRST', mergePolicy: 'FALLBACK' }
const {
  getBlockedReason,
  isClosedDayForHeader,
  isHospitalClosedDayForHeader,
  isHospitalClosedDayForDoctor,
} = useSchedulerRules({
  hospitalRules,
  doctorRules,
  blockOptions,
  selectedDoctors: selectedDoctorSet,
  cellDuration: ruleCellDuration,
  doctorsRef: doctors,
  // ⚠️ priority/mergePolicy 는 options 객체로 전달해야 적용됨(최상위 prop 은 구조분해에서 무시됨).
  options: rulesOptions,
})
// Grid 가 inject 하는 셀 차단 판정 함수
provide('getBlockedReason', getBlockedReason)

/* 날짜 행(담당자 무관)의 '휴무' 라벨.
 * ★공휴일만이 아니라 **사업장 휴무일 전부**를 표기한다 — 요일 휴무·매월 N번째·임시휴무일도 사업장이 닫는 날이다.
 *  종전에는 `holidayStore.isHoliday(ymd) &&` 가 앞에 걸려 있어 공휴일에만 라벨이 붙었고,
 *  기관이 매주 쉬는 요일에는 날짜 행이 아무 표시도 없었다.
 * 판정은 셀·담당자 칸과 같은 `isHospitalClosedDayForHeader` 하나로 모은다(공휴일 운영일 rescue 포함). */
const holidayLabelFor = ymd => (isHospitalClosedDayForHeader(dayjs(ymd).hour(12).toDate()) ? '휴무' : undefined)

// 컬럼 key → { doctorClosed, hospitalClosed, dateClosed } (헤더 뱃지 + Grid 셀)
//  - hospitalClosed: 사업장 휴무가 **이 담당자 칸에** 적용되는가 — 담당자가 그날 운영으로 정했으면 false(R11).
//    셀(getBlockedReason)과 같은 판정이어야 "뱃지는 휴무인데 셀은 열림"이 안 생긴다.
//  - dateClosed: 사업장 순수 휴무 — 날짜 행(담당자 무관) 표기용.
const closedDayMap = computed(() => {
  const map = {}
  for (const col of columns.value) {
    const at12 = dayjs(col.unit.date).hour(12).toDate()
    map[col.unit.key] = {
      doctorClosed: isClosedDayForHeader(at12, col.unit.doctorId),
      hospitalClosed: isHospitalClosedDayForDoctor(at12, col.unit.doctorId),
      dateClosed: isHospitalClosedDayForHeader(at12),
    }
  }
  return map
})


// V2 TimeAxis/NowIndicator 가 inject 하는 현재시각 ref (30초 갱신).
const nowTick = ref(Date.now())
provide('nowTick', nowTick)
let nowTimer = null

// 오늘(ymd) — nowTick 기준이라 자정을 넘겨도 갱신된다. 헤더/본문 오늘 강조의 단일 판정처.
const todayYmd = computed(() => dayjs(nowTick.value).format('YYYY-MM-DD'))

// 오늘 날짜 그룹의 본문 좌/우 경계 좌표 — 헤더 날짜셀 브랜드 강조(SchedulerHeader `is-today`)와 한 쌍.
// 컬럼은 날짜별로 연속 배치되므로 그 날짜의 첫/마지막 컬럼이 곧 그룹 경계다. 오늘이 안 보이면 null.
const todayEdgeRect = computed(() => {
  const cols = v2Columns.value.filter(c => c.date === todayYmd.value)
  if (!cols.length) return null
  const first = cols[0]
  const last = cols[cols.length - 1]
  return { left: first.leftPx, width: last.leftPx + last.widthPx - first.leftPx }
})

// ── 카드 (AppointmentCard/Layer 재사용) ──
// raw bookStore 예약 → EngineAppointment(카드가 기대하는 startMinute/statusClass/uiPatient 포함).
const engineAppointments = computed(() => toEngineAppointments(appointments.value))
// 상태 필터로 숨긴 카드를 뺀 rect — 그리기·hit test·스크롤 대상 전부 이것을 본다(엔진 rects 직접 사용 금지).
// 엔진은 전체 예약으로 배치하므로 숨긴 카드의 자리는 비어 있고 다른 카드의 위치는 필터와 무관하게 같다.
const visibleRects = computed(() => {
  const hidden = hiddenAppointmentIds.value
  return hidden.size === 0 ? layout.value.rects : layout.value.rects.filter(r => !hidden.has(r.id))
})
// redesign Rect → AppointmentRect(appointmentId/columnKey/zIndex). columns 로 columnKey 해석.
const v2Rects = computed(() => toV2Rects(visibleRects.value, columns.value))

const rects = visibleRects

// ── 상태·회원 카운트 = 화면에 그려진 칸의 예약에서 센다 ──
// BE 집계를 쓰지 않는다 — 조회 창은 화면보다 길고(예약 0건 가정 일수) 경계 칸은 담당자 일부만 보여,
// 어떤 조건을 보내도 SQL 의 모수와 화면의 카드는 같아질 수 없었다(카드는 없는데 건수만 뜨는 신고).
// 입력은 페이지 컬럼(columns)의 unit 키와 상태 무관 전체 목록 — 필터·날짜·검색어가 바뀌면 목록·컬럼이
// 바뀌고 이 값도 같은 tick 에 따라간다. 상태 필터가 켜져 있으면 켠 상태의 숫자 = 그려진 카드 수,
// 다른 상태의 숫자 = 같은 칸에 있지만 필터로 숨긴 카드 수.
// 조건이 바뀐 재조회가 떠 있는 동안(appointmentsStale)은 목록이 이전 조건의 것이라 0 으로 보인다 —
// 이전 조건의 숫자가 잠시 남아 새 조건의 값처럼 읽히지 않게. 같은 조건의 재조회(SSE)는 그대로 센다.
const boardStatistics = computed(() =>
  countBoardStatistics(
    appointmentsStale.value ? [] : appointments.value,
    columns.value.map(c => c.unit.key),
    dataType.value,
  ),
)

// ── 인터랙션 composable (페이지-로컬 격리, 공유 store 변경 없음) ──
// AppointmentCard 는 hover/popover/drag/resize 4 inject 를 null 가드 없이 즉시 사용 → 모두 존재해야 함.
const interactionLock = useSchedulerInteractionLock()
const hover = useSchedulerHover(interactionLock)
// popover bodyEl=boardEl: V3 는 브라우저 전체 스크롤이라 내부 scroll 리스너 미발화하나,
// 스크롤 시 카드+popover 가 함께 이동하므로 닫을 필요 없음(정합). outside click/ESC 정상 동작.
const popover = useSchedulerPopover({ interactionLock, hover, bodyEl: boardEl })
provide('schedulerInteractionLock', interactionLock)
provide('schedulerHover', hover)
provide('schedulerPopover', popover)
// sub-column 칸수조절 — 컬럼별 개별(customSlots[key], columnKey 기반).
const subColResize = useSubColResize({
  interactionLock,
  minN: 1,
  maxN: 14, // 툴바 N칸 보기 상한(MAX_SLOT_SPAN)과 통일 — 정의서 "14칸 이하로 보일 수 있는 수까지"
  onChange: (newN, columnKey) => {
    if (!columnKey) return
    customSlots.value = { ...customSlots.value, [columnKey]: newN }
  },
})
provide('schedulerSubColResize', subColResize)
// ── drag/resize 실배선 (페이지-로컬, 공유 composable/adapter 무수정 재사용) ──
const dialog = useDialog()

// 담당자·운영시간 미등록은 인라인 배너로만 안내한다(아래 템플릿). 외부 이동 없음.

// 일시적 조회 실패 → 안내 alert.
// alerting 가드 — 초기 마운트에 loadDoctor 가 동시 발화(immediate + setWindow)해 실패가 겹쳐도 안내창은 1개만.
let alerting = false
watch(serviceUnavailable, async (msg) => {
  if (!msg) return
  serviceUnavailable.value = null
  if (alerting) return
  alerting = true
  try {
    await dialog.alert(msg, { title: '서비스 이용 안내' })
  } finally {
    alerting = false
  }
})

// validate: 운영시간 밖(휴무·휴게시간·운영종료)은 막지 않고 확인 팝업으로 넘긴다 — 등록(ReservationPopup)과 같은 규칙.
//   ★하드 차단을 두지 않는 이유: 등록은 확인 후 허용인데 이동만 무안내로 되돌리면, 같은 시각이
//     등록은 되고 이동은 안 되는 상태가 된다. 사용자에겐 "아무 반응 없이 카드가 튕기는" 것으로만 보인다.
//   ★과거 시각도 막지 않는다 — 지난 예약의 시각 보정을 허용한다(TC 003-03 v0.3).
// 사유 우선순위(휴무 > 휴게시간 > 운영종료)는 pickBlockWarning 이 SSOT — 등록 경로와 같은 판정을 쓴다.
function minuteToDate(dateStr, minute) {
  const h = Math.floor(minute / 60)
  const m = minute % 60
  return dayjs(dateStr).hour(h).minute(m).second(0).toDate()
}
/** 놓을 구간을 셀 단위로 훑어 안내할 사유 하나를 고른다. 없으면 null. */
function scanWarning(date, resourceId, startMinute, endMinute) {
  const step = ruleCellDuration.value || 30
  let warning = null
  for (let m = startMinute; m < endMinute; m += step) {
    warning = pickBlockWarning(warning, getBlockedReason(minuteToDate(date, m), resourceId).reason)
  }
  return warning
}
// ★ 두 함수 모두 isValid 는 항상 true 다 — 휴무·휴게시간은 막지 않고 확인만 받는 것이 정책이라
//   여기서 차단되는 경우가 없다. "검증"이라는 이름과 달리 실제로 고르는 것은 warning(안내 사유) 뿐이다.
//   isValid 를 남겨둔 것은 죽은 값이라서가 아니라 drag/resize 컴포저블이 그것을 소비하기 때문이다
//   (프리뷰의 is-invalid 빨간 표시 + drop 발행 게이트). 언젠가 정말 막아야 하면 여기서 false 를
//   돌려주면 되고, 컴포저블 쪽은 이미 그 값을 처리한다. 호출부에 !isValid 방어를 다시 두지 않는다.
function validateDropPosition(appointmentId, columnKey, date, resourceId, startMinute, endMinute) {
  const warning = scanWarning(date, resourceId, startMinute, endMinute)
  return warning ? { isValid: true, warning } : { isValid: true }
}
function validateResizePosition(appointmentId, columnKey, startMinute, endMinute) {
  const col = v2Columns.value.find(c => c.key === columnKey)
  if (!col) return { isValid: true }
  const warning = scanWarning(col.date, col.resourceId, startMinute, endMinute)
  return warning ? { isValid: true, warning } : { isValid: true }
}

// 담당자 이름 resolver (drag adapter용, 이름키 정합)
function resolveDoctorName(doctorName) {
  return doctors.value.find(d => d.id === doctorName)?.text ?? doctorName
}

/** 운영시간 밖으로 놓을 때의 확인 — 문구는 등록(ReservationPopup)과 같은 labelBlockedReason 을 쓴다.
 *  라벨을 여기서 다시 적으면 사유가 늘 때 두 경로가 갈라진다. */
async function confirmBlockedMove(doctorName, warning) {
  const label = labelBlockedReason(warning) || '운영종료 시간'
  return dialog.confirm(`해당 시간에 ${doctorName}님은 ${label}입니다.\n예약을 등록하시겠습니까?`, { title: '예약 확인' })
}

// 이동(drop·변경 모드)은 예약을 통째로 다시 놓는 것이라, 격자 밖으로 저장돼 있던 예약도
// 이 기회에 예약 단위 격자로 맞춘다. 규칙은 예약 수정 화면과 동일(내림·최소 한 칸).
// 시간축 검증(운영시간 밖 확인창)보다 먼저 적용해야 확인창이 실제 저장될 시간을 보고 뜬다.
// ※ resize 는 제외한다 — 잡지 않은 반대쪽 끝을 건드리지 않는 것이 resize 의 규약이다.
function toBookingGrid(result) {
  const { startMinute, endMinute } = normalizeRangeToGrid(result.newStartMinute, result.newEndMinute, STEP_MIN)
  return { ...result, newStartMinute: startMinute, newEndMinute: endMinute }
}

// drop/resize → bookStore 저장 (raw 원본 + dragResultAdapter → modifyAppointment → onCardCallback(triggerSearch))
async function handleDrop(rawResult) {
  const result = toBookingGrid(rawResult)
  const raw = appointments.value.find(a => a.id === result.appointmentId)
  if (!raw) return
  const validation = validateDropPosition(result.appointmentId, result.toColumnKey, result.toDate, result.toResourceId, result.newStartMinute, result.newEndMinute)
  if (validation.warning) {
    const ok = await confirmBlockedMove(resolveDoctorName(result.toResourceId) || '', validation.warning)
    if (!ok) return
  }
  const request = dragResultToBookItemRequest(result, raw, resolveDoctorName)
  if (!request) return
  const response = await bookStore.modifyAppointment(result.appointmentId, request)
  onCardCallback(response)
}
async function handleResize(result) {
  const raw = appointments.value.find(a => a.id === result.appointmentId)
  if (!raw) return
  const validation = validateResizePosition(result.appointmentId, result.columnKey, result.newStartMinute, result.newEndMinute)
  if (validation.warning) {
    const col = v2Columns.value.find(c => c.key === result.columnKey)
    const ok = await confirmBlockedMove(col?.resourceLabel || '', validation.warning)
    if (!ok) return
  }
  const request = resizeResultToBookItemRequest(result, raw)
  if (!request) return
  const response = await bookStore.modifyAppointment(result.appointmentId, request)
  onCardCallback(response)
}

// ── 예약 변경(reschedule) 모드 — 화면정의서 13-6/13-7 ──
// ⋮"변경" → begin: 카드 select + "변경중" 배너 + interactionLock 점유.
// 빈 슬롯 클릭 → pickSlot → handleRescheduleCommit(dragResultAdapter→modifyAppointment→triggerSearch).
//
// ⚠️ commit 시 raw 조회 주의: 변경 모드는 < > 로 다른 날짜로 이동한 뒤 그 날 슬롯을 클릭할 수 있다.
//   이때 대상 예약은 현재 데이터 윈도우(appointments.value) 밖이라 find 로는 못 찾는다.
//   → begin 시점(대상이 화면에 보일 때)에 raw 를 캡처해두고 commit 에서 그걸 사용한다.
let rescheduleOriginRaw = null
function rescheduleGetOrigin(appointmentId) {
  const raw = appointments.value.find(a => a.id === appointmentId)
  if (!raw) return null
  rescheduleOriginRaw = raw
  const start = dayjs(raw.startDateTime)
  const durationMin = Math.max(0, dayjs(raw.endDateTime).diff(start, 'minute'))
  const startMinute = start.hour() * 60 + start.minute()
  const fromColumnKey = v2Rects.value.find(r => r.appointmentId === appointmentId)?.columnKey ?? ''
  return { appointmentId, fromColumnKey, startMinute, endMinute: startMinute + durationMin }
}
// 변경 모드 전용 commit — handleDrop 과 동일하나 raw 를 윈도우 조회 대신 begin 캡처본에서 가져온다.
// 고른 칸의 시각을 그대로 쓰면 시간 단위 설정이 10·20·45분일 때 격자 밖 시각이 저장되므로
// handleDrop 과 같은 toBookingGrid 를 거친다.
async function handleRescheduleCommit(rawResult) {
  const result = toBookingGrid(rawResult)
  const raw = rescheduleOriginRaw
  if (!raw || raw.id !== result.appointmentId) return
  const validation = validateDropPosition(result.appointmentId, result.toColumnKey, result.toDate, result.toResourceId, result.newStartMinute, result.newEndMinute)
  if (validation.warning) {
    const ok = await confirmBlockedMove(resolveDoctorName(result.toResourceId) || '', validation.warning)
    if (!ok) return
  }
  const request = dragResultToBookItemRequest(result, raw, resolveDoctorName)
  if (!request) return
  // 저장이 확정된 지점에서만 변경 모드를 끝낸다 — 위 return 들(확인창 '아니오' 포함)로 중단되면
  // 배너가 살아 있어 사용자가 다른 자리를 다시 고를 수 있다.
  reschedule.cancel()
  const response = await bookStore.modifyAppointment(result.appointmentId, request)
  rescheduleOriginRaw = null
  onCardCallback(response)
}
const reschedule = useSchedulerReschedule({
  acquireLock: () => interactionLock.acquire('reschedule'),
  getOrigin: rescheduleGetOrigin,
  onCommit: handleRescheduleCommit,
})
provide('schedulerReschedule', reschedule)
// 변경 모드 종료 시 캡처본(가비지) 정리. commit 은 handleRescheduleCommit 이 자체 null 처리하나,
// ESC/배너X 취소 경로는 cancel() 이 composable 내부라 page 변수를 못 건드림 → active=false 전이로 보강.
// (watch 는 flush 지연 — handleRescheduleCommit 이 저장 직전 cancel() 을 불러도 raw 는 함수 진입 시
//  이미 지역변수로 잡아둔 뒤라 영향 없음.)
watch(() => reschedule.active.value, (active) => {
  if (!active) rescheduleOriginRaw = null
})
// (graceful-cancel 제거) 변경 모드는 줄달력/페이징으로 다른 날짜 이동을 지원해야 하므로,
// 타겟이 현재 표시 윈도우(appointments)에서 벗어났다고 모드를 취소하면 안 됨(다른 날로 이동 = 정상 흐름).
// 취소는 배너 X / ESC / 슬롯 선택(commit)으로만. 타겟이 실제 삭제됐으면 commit 시 handleDrop 이 무시.
// ESC = 변경 취소(모드 중에만). 팝오버/팝업 ESC 와 분리.
function onRescheduleKeydown(e) {
  if (e.key === 'Escape' && reschedule.active.value) {
    e.stopPropagation()
    reschedule.cancel()
  }
}
onMounted(() => window.addEventListener('keydown', onRescheduleKeydown, true))
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onRescheduleKeydown, true)
  reschedule.cancel() // 라우트 이탈 시 lock 해제
})

// ── ReservationPopup (예약 생성/수정) — 공유 컴포넌트 ──
const reservationPopupVisible = ref(false)
const reservationPopupPayload = ref(null)
// 저장 요청 진행 중 — 연타로 등록이 두 번 나가는 것을 막는다(팝업 버튼 비활성도 이 값을 본다).
const reservationSaving = ref(false)
// 담당자 칸 뱃지와 같은 판정 — 담당자가 그날 운영으로 정했으면 사업장 휴무가어도 휴무일이 아니다(R11).
const reservationPopupIsDayOff = computed(() => {
  const p = reservationPopupPayload.value
  const startDate = p?.startDateTime
  return startDate ? isHospitalClosedDayForDoctor(startDate, p?.doctorName) : false
})
// 빈 셀 클릭 → 변경 모드면 슬롯 선택(pickSlot), 아니면 예약 생성(ADD)
function onGridCellClick(payload) {
  if (reschedule.active.value) {
    reschedule.pickSlot({
      columnKey: payload.columnKey,
      date: payload.date,
      resourceId: payload.resourceId,
      startMinute: payload.startMinute,
      endMinute: payload.endMinute,
    })
    return
  }
  const { date, resourceLabel, startMinute, endMinute } = payload
  const startDateTime = dayjs(date).hour(Math.floor(startMinute / 60)).minute(startMinute % 60).second(0).toDate()
  const endDateTime = dayjs(date).hour(Math.floor(endMinute / 60)).minute(endMinute % 60).second(0).toDate()
  reservationPopupPayload.value = { doctorName: resourceLabel, startDateTime, endDateTime, mode: 'ADD' }
  reservationPopupVisible.value = true
}
// 카드 클릭(threshold 미만) → 예약 수정(EDIT). drag onClick + AppointmentLayer @edit 공용.
function handleEdit(appointmentId) {
  if (reschedule.active.value) return // 변경 모드 중엔 카드 클릭으로 팝업 안 열림(다른 동작 불가)
  const raw = appointments.value.find(a => a.id === appointmentId)
  if (!raw) return
  reservationPopupPayload.value = { ...raw, mode: 'EDIT' }
  reservationPopupVisible.value = true
}
function closeReservationPopup() {
  reservationPopupVisible.value = false
}
// 성공일 때만 닫는다. 실패에도 닫으면 ReservationPopup 이 visible=false 를 감시해
// resetFormState 를 돌리므로 사용자가 입력한 값이 통째로 사라진다.
// (운영일정 설정 저장의 "성공 시에만 팝업 닫기" 와 같은 규약)
async function handleSaveReservation(payload) {
  if (reservationSaving.value) return // 연타 — 앞 요청이 끝나기 전에는 다시 보내지 않는다
  reservationSaving.value = true
  try {
    const response = await bookStore.addAppointment(payload)
    if (onCardCallback(response)) closeReservationPopup()
  } finally {
    reservationSaving.value = false
  }
}
async function handleModifyReservation(payload) {
  if (reservationSaving.value) return
  reservationSaving.value = true
  try {
    const response = await bookStore.modifyAppointment(payload.id, payload)
    if (onCardCallback(response)) closeReservationPopup()
  } finally {
    reservationSaving.value = false
  }
}
// 팝업 상호 배제: ReservationPopup ↔ ⋮popover
watch(reservationPopupVisible, (v) => { if (v) popover.close() })
watch(popover.isOpen, (v) => { if (v) reservationPopupVisible.value = false })
const isAnyPopupOpen = computed(() => reservationPopupVisible.value)

const drag = useSchedulerDrag({
  bodyEl: boardEl,
  columns: v2Columns,
  bandInfos: v2Bands,
  patientSlotSpan: effectiveSlotDivision,
  interactionLock,
  validate: validateDropPosition,
  onDrop: handleDrop,
  onClick: handleEdit,
})
const resize = useSchedulerResize({
  bodyEl: boardEl,
  columns: v2Columns,
  bandInfos: v2Bands,
  interactionLock,
  validate: validateResizePosition,
  onResize: handleResize,
})
provide('schedulerDrag', drag)
provide('schedulerResize', resize)

// ── 카드 ⋮ 메뉴 이벤트 ──
// 카드가 bookStore(removeAppointment/modifyAppointmentState)를 직접 호출 후 emit('callback', res).
// 페이지는 결과만 받아 갱신(filterStore.triggerSearch — searchVersion watch chain, load 직접호출 금지 준수)+토스트.
const SUCCESS_MESSAGE = '정상처리 되었습니다.'
const FAIL_MESSAGE = '처리실패 되었습니다.'
// 성공 여부를 돌려준다 — 호출부가 'succeed' 판정을 베끼지 않고 이 결과만 보게 한다.
function onCardCallback(response) {
  if (response?.code === 'succeed') {
    filterStore.triggerSearch()
    const toast = push.success(SUCCESS_MESSAGE)
    setTimeout(() => toast.clear(), 3000)
    return true
  }
  const msg = response?.message
  push.error(msg && msg !== '500' && msg !== 500 ? msg : FAIL_MESSAGE)
  return false
}
// @delete/@status-change 는 카드가 emit 하지 않음(카드 내부 bookStore 직접 호출→onCardCallback) — no-op.
function onCardDelete() {}
function onCardStatusChange() {}

// ── 검색 드롭다운 pick ──
// 최근 예약 항목 pick → 해당 날짜 이동(setPeriodDate → searchVersion·periodDate watch chain) + 대상 카드 하이라이트.
const SEARCH_HIGHLIGHT_MS = 5000
// 날짜 이동 pick 은 재조회가 끝나야 대상 카드가 그려진다 — 그때까지 스크롤을 미뤄두고 기다리는 상한.
const SEARCH_SCROLL_WAIT_MS = 5000
const searchHighlightId = ref(null)
provide('schedulerSearchHighlight', { highlightedId: searchHighlightId })
let searchHighlightTimer = null
// 스크롤이 성사되는(또는 포기하는) 시점에 5초를 센다 — pick 즉시 세면 재조회가 느린 환경에서
// 사용자가 카드에 도착했을 땐 이미 강조가 꺼져 있다.
function startHighlightTimer() {
  if (searchHighlightTimer) clearTimeout(searchHighlightTimer)
  searchHighlightTimer = setTimeout(() => {
    searchHighlightId.value = null
    searchHighlightTimer = null
  }, SEARCH_HIGHLIGHT_MS)
}
// pick 한 예약 담당자(staffName)가 속한 팀명 — 어느 팀에도 없으면 null(미지정 그룹).
function findTeamOfDoctor(staffName) {
  const target = normalizeName(staffName)
  const team = teams.value.find(t =>
    (t.doctors ?? []).some(d => normalizeName(d.staffName) === target),
  )
  return team ? team.name : null
}

// 대상 (날짜, 담당자명) 컬럼이 화면 좌측에 보이도록 colOffset 재고정.
// layout.units = 전역 sub-col 시퀀스(가시 윈도우 밖 컬럼도 포함) → 대상의 전역 slot 인덱스를
// 누적해 reanchorArgsForSlot 으로 within-day offset 산출. 헤더 담당자 <> 페이징과 동일 경로(reanchorTo).
function focusDoctorColumn(targetDate, doctorName) {
  // 이름 매칭은 normalizeName 통일 — unit.doctorName(담당자명 정규화)과 검색 staffName(raw)이
  // 직책/특수문자/공백으로 어긋나도 매칭되게(findTeamOfDoctor 와 동일 기준).
  const target = normalizeName(doctorName)
  const units = layout.value.units
  let acc = 0
  for (const u of units) {
    if (u.date === targetDate && normalizeName(u.doctorName) === target) {
      const at = reanchorArgsForSlot(units, acc, selectedDate.value)
      reanchorTo(at.date, at.offset)
      return
    }
    acc += Math.max(1, u.slots)
  }
}
// ── 대상 카드로 세로 스크롤 ──
// 가로(담당자 컬럼)는 focusDoctorColumn 의 페이징이 맡고, 세로(시간축)는 여기가 맡는다.
// 예약시간 단위가 10분이면 보드 높이가 3배가 되어 오후 예약은 진입 시 화면 밖에 있다.
let pendingScrollId = null
let pendingScrollTimer = null
let detachUserScrollGuard = null

function clearPendingScroll() {
  pendingScrollId = null
  if (pendingScrollTimer) {
    clearTimeout(pendingScrollTimer)
    pendingScrollTimer = null
  }
  if (detachUserScrollGuard) {
    detachUserScrollGuard()
    detachUserScrollGuard = null
  }
}

/** 대기가 끝났다(성사·포기 무관) — 미뤄둔 스크롤을 접고 강조 타이머를 시작한다. */
function finishPendingScroll() {
  clearPendingScroll()
  startHighlightTimer()
}

/** 기다리는 동안 사용자가 직접 스크롤하면 자동 스크롤은 물러난다 — 보고 있는 자리를 뺏지 않는다. */
function bindUserScrollGuard() {
  const onUserScroll = () => finishPendingScroll()
  window.addEventListener('wheel', onUserScroll, { passive: true, capture: true })
  window.addEventListener('touchmove', onUserScroll, { passive: true, capture: true })
  detachUserScrollGuard = () => {
    window.removeEventListener('wheel', onUserScroll, true)
    window.removeEventListener('touchmove', onUserScroll, true)
  }
}

/** 카드 DOM 을 찾아 스크롤. 카드가 아직 안 그려졌으면 false. */
function scrollToCard(id) {
  const board = boardEl.value
  if (!board) return false
  const card = Array.from(board.querySelectorAll('[data-appointment-id]'))
    .find(el => el.dataset.appointmentId === id)
  if (!card) return false

  const container = findScrollContainer(card)
  const isDocument = container === document.scrollingElement || container === document.documentElement
  const containerRect = isDocument ? null : container.getBoundingClientRect()
  const containerTop = containerRect ? containerRect.top : 0
  const containerBottom = containerRect ? containerRect.bottom : window.innerHeight
  // sticky 헤더가 덮는 만큼을 뺀 실제 가시 영역. 헤더는 스크롤 위치에 따라 붙었다 떨어지므로 매번 실측한다.
  const headBottom = boardHeadEl.value?.getBoundingClientRect().bottom ?? containerTop
  const cardRect = card.getBoundingClientRect()

  const delta = computeScrollDelta({
    cardTop   : cardRect.top,
    cardBottom: cardRect.bottom,
    viewTop   : Math.max(containerTop, headBottom),
    viewBottom: containerBottom,
  })
  if (delta === null) return true // 이미 보인다 — 화면을 흔들지 않는다.

  const maxScrollTop = container.scrollHeight - container.clientHeight
  container.scrollTop = Math.max(0, Math.min(container.scrollTop + delta, maxScrollTop))
  return true
}

/** 대상 카드가 그려져 있으면 즉시 스크롤, 아니면 다음 레이아웃까지 기다린다. */
async function tryConsumePendingScroll() {
  if (pendingScrollId === null) return
  // 드래그·리사이즈·예약변경 중이면 자동 스크롤이 조작을 망친다 — 물러난다.
  if (interactionLock.isLocked.value) {
    finishPendingScroll()
    return
  }
  if (!rects.value.some(r => String(r.id) === pendingScrollId)) return
  const id = pendingScrollId
  await nextTick()
  if (pendingScrollId !== id) return // 대기 중 취소되었거나 다른 항목으로 교체됨
  if (scrollToCard(id)) finishPendingScroll()
}

function requestScrollToCard(id) {
  clearPendingScroll()
  pendingScrollId = String(id)
  bindUserScrollGuard()
  // 재조회가 끝내 대상을 데려오지 못해도(상태·회원 필터로 빠졌거나 담당자 컬럼 매칭 실패) 대기가 남지 않게 상한을 둔다.
  // 운영시간 밖 예약은 여기 해당하지 않는다 — 시간축이 예약 envelope 으로 늘어나 그려진다(computeOperatingRange).
  pendingScrollTimer = setTimeout(finishPendingScroll, SEARCH_SCROLL_WAIT_MS)
  tryConsumePendingScroll()
}

// 재조회·필터 변경으로 카드 집합이 바뀔 때마다 대상이 나타났는지 확인.
watch(rects, () => { tryConsumePendingScroll() })

async function onRecentPick(item) {
  const d = dayjs(item.startAt)
  if (!d.isValid()) return
  const targetId = String(item.reservationId)
  // 이미 현재 화면에 렌더된 카드면(날짜·담당자·페이지 모두 표시 중) 날짜 이동/팀 전환 없이
  // 그 화면 그대로 하이라이트만. rects = 현재 그려진 카드 집합(runLayout 출력).
  const alreadyRendered = rects.value.some(r => String(r.id) === targetId)
  if (!alreadyRendered) {
    // 방문 장부는 과거~오늘만 표기 — 미래 항목 pick 시 예약장부로 전환 후 이동
    if (filterStore.dataType === 'TREATMENT' && d.isAfter(dayjs(), 'day')) {
      filterStore.setDataType('APPOINTMENT', false)
    }
    // 담당자 컬럼 정합 — pick 담당자가 visible 집합에 포함되도록 팀 컨텍스트 전환 + 담당자 개별 필터 전체.
    //  - 미지정 그룹 담당자 → selectedTeamName=null(미지정 "전체")
    //  - 팀 소속 담당자 → 그 팀(팀 "전체"). setTeam 이 doctors 도 비움([], 전체).
    // (그 담당자가 팀 멤버라 "미지정"에서 빠져 카드가 안 그려지던 버그 해결)
    const teamName = findTeamOfDoctor(item.staffName)
    filterStore.patch({ selectedTeamName: teamName, doctors: [] }, false)
    // 날짜 이동 — 마지막에 trigger=한 번만 재조회(normalize/클램프는 setPeriodDate 가 처리).
    const targetDate = d.format('YYYY-MM-DD')
    filterStore.setPeriodDate(d.startOf('day').toDate())
    // ⚠️ date-anchored colOffset 페이징 정합 — 같은 날짜라도 N칸 페이징으로 대상 담당자가
    //   다음 페이지(colOffset>0)에 있을 수 있다. 날짜만 맞추면 colOffset=0(reset)이라 좌측 페이지만 보여
    //   대상 담당자 카드가 화면 밖에 머문다. reset watch(flush:pre)·재배치 후 colOffset 을 대상 컬럼으로 재고정.
    await nextTick()
    focusDoctorColumn(targetDate, item.staffName)
  }
  searchHighlightId.value = targetId
  requestScrollToCard(targetId)
}
onBeforeUnmount(() => {
  if (searchHighlightTimer) clearTimeout(searchHighlightTimer)
  clearPendingScroll()
})

/** body 전체 높이 = 마지막 band 하단. */
const bodyHeight = computed(() => {
  const bands = bandInfos.value
  if (bands.length === 0) return 0
  const last = bands[bands.length - 1]
  return last.topPx + last.heightPx
})
</script>

<template>
  <div class="v3-page">
    <!-- 예약 변경(reschedule) 모드 안내 — 화면 중앙 하단 고정(화면정의서 13-7). 닫으면 변경취소. -->
    <div v-if="reschedule.active.value" class="v3-reschedule-banner" role="status">
      <div class="v3-reschedule-banner__text">
        <strong>예약 변경을 원하는 일시를 선택해주세요</strong>
        <span>(창을 닫으면 변경취소 됩니다.)</span>
      </div>
      <button class="v3-reschedule-banner__close" type="button" aria-label="변경 취소" @click="reschedule.cancel()">×</button>
    </div>

    <div class="v3-filterStripArea">
      <!-- 공유 검색필터 바 재사용 (예약/방문·날짜·담당자·상태·회원·검색·설정). 일별/주별 토글은 V3에서 숨김. -->
      <SchedulerSearchFilter
        class="v3-searchfilter"
        :hide-view-mode="true"
        :recent-search="true"
        :state-statistics="boardStatistics.state"
        :member-statistics="boardStatistics.member"
        @pick-recent="onRecentPick"
      />

      <!-- 운영시간/담당자 미등록 안내 -->
      <div v-if="redirectReason" class="v3-redirect-notice" role="alert">
        <span class="v3-redirect-notice__icon" aria-hidden="true">!</span>
        <span class="v3-redirect-notice__text">
          운영시간 또는 담당자가 등록되지 않아 예약을 조회할 수 없습니다.
          <b>설정</b>에서 운영시간과 담당자를 등록해 주세요.
        </span>
      </div>

      <!-- 운영시간 조회 실패(장애) — fallback 렌더가 실패를 "미설정"처럼 위장하지 않게 표면화.
           미등록 안내(noTreatmentTime)보다 우선한다: site 실패 시 weekly 가 비어 미등록으로 오판되기 때문. -->
      <div v-else-if="workTimeLoadFailedAny" class="v3-redirect-notice" role="alert">
        <span class="v3-redirect-notice__icon" aria-hidden="true">!</span>
        <span class="v3-redirect-notice__text">
          운영시간 정보를 불러오지 못해 기본 운영시간으로 표시 중입니다.
          <b>설정<span class="v3-redirect-notice__gear" aria-hidden="true"></span> &gt; 운영시간</b>에서 등록을 권장합니다. (예약 등록은 가능합니다)
        </span>
        <button class="v3-redirect-notice__retry" type="button" @click="retryWorkTime">재시도</button>
      </div>

      <!-- 운영시간 미등록 안내(비블로킹) — 보드는 로드·예약 등록 가능, 운영종료 상태로 표시. -->
      <div v-else-if="noTreatmentTime" class="v3-redirect-notice v3-redirect-notice--soft" role="status">
        <span class="v3-redirect-notice__icon" aria-hidden="true">!</span>
        <span class="v3-redirect-notice__text">
          사업장 운영시간이 등록되지 않았습니다.
          <b>설정 &gt; 운영시간</b>에서 등록을 권장합니다. (등록 전에도 예약 등록은 가능합니다)
        </span>
      </div>

      <!-- 줄달력 — 예약 모드: 당일 포함 미래 30일, 일별 ±1일 / 월별 ±1달 -->
      <div class="v3-stripRow">
        <SchedulerDateStrip
          :selected-date="firstVisibleDate"
          :strip-window-start="stripWindowStart"
          :mode="dateStripMode"
          :expanded-month="expandedMonth"
          :header-window-days="30"
          :max-date="stripMaxDate"
          @go-today="onDateStripGoToday"
          @shift-prev="onStripShiftPrev"
          @shift-next="onStripShiftNext"
          @expand-prev-month="onExpandPrevMonth"
          @expand-next-month="onExpandNextMonth"
          @select-date="onDateStripSelectDate"
          @expand-month="onExpandMonth"
        />
        <!-- N칸 보기 · 보기단계(zoom). 방문 모드는 라이브 칸보기/보기단계 없음(1일 고정) → 툴바 숨김. -->
      <SchedulerToolbar
        v-if="!isTreatmentMode"
        :patient-slot-span="slotDivision"
        :zoom-level="viewStep"
        @update:patient-slot-span="onChangeSlotDivision"
        @update:zoom-level="onChangeViewStep"
      />
      </div>
    </div>

    <!-- <header class="v3-topbar">
      <span class="v3-badge">V3 (engine redesign · render-only)</span>
      <span class="v3-meta">anchor {{ selectedDate }} · 표시 {{ firstVisibleDate }}~{{ lastVisibleDate }} · 컬럼 {{ columns.length }} · off {{ effectiveColOffset }}/{{ totalSlots }} · band {{ bandInfos.length }} · rect {{ rects.length }}</span>
      <span class="v3-modeToggle" role="group" aria-label="칸수배정 모델">
        <button type="button" :class="{ active: layoutMode === 'A' }" @click="layoutMode = 'A'">A(동시폭)</button>
        <button type="button" :class="{ active: layoutMode === 'B2' }" @click="layoutMode = 'B2'">B2(N고정)</button>
      </span>
      <SchedulerToolbar
        v-if="!isTreatmentMode"
        :patient-slot-span="slotDivision"
        :zoom-level="viewStep"
        @update:patient-slot-span="onChangeSlotDivision"
        @update:zoom-level="onChangeViewStep"
      />
    </header> -->

    <!-- 보드: corner | header / timeAxis | body (Panel 미사용 — 브라우저 전체 스크롤 + 헤더/축 sticky) -->
    <div class="v3-board">
      <!-- 팝업 열림 시 스케줄러 영역 클릭/drag 차단 -->
      <div v-if="isAnyPopupOpen" class="v3-blocker" />

      <!-- 최초 로딩 — 데이터 도착 전 빈 격자를 "없음"으로 오해하지 않도록 덮는다.
           absolute overlay 라 보드 레이아웃을 밀지 않는다(도착 후 그대로 드러남). -->
      <div v-if="isInitialLoading" class="v3-loading" role="status" aria-live="polite">
        <div class="v3-loading__spinner" aria-hidden="true" />
        <p class="v3-loading__text">예약장부를 불러오는 중입니다</p>
      </div>
      <!-- 재조회 — 이미 그려진 화면 위 갱신. 진행바(장식) + 헤더 하단 배지(주 표시, v3-board-head 안).
           오늘 날짜 헤더가 브랜드색이라 진행바 단독으로는 묻힌다 — 트랙 바탕을 깔고 배지를 병행한다. -->
      <div v-else-if="isRefreshing" class="v3-refreshing" aria-hidden="true">
        <span class="v3-refreshing__bar" />
      </div>
      <!-- 재조회 중 본문 blur — 갱신 중임을 면으로 표현하고 본문 클릭·드래그를 잠시 막는다.
           sticky 헤더(z30) 아래(z25)에 깔아 헤더 조작(페이징·날짜 이동)은 막지 않는다. -->
      <div v-if="isRefreshing" class="v3-refreshing-dim" aria-hidden="true" />

      <!-- 오늘 날짜 그룹 좌/우 경계선 — 헤더 날짜셀 브랜드 강조와 한 쌍.
           헤더(날짜행+담당자행)와 본문을 하나로 관통해야 해서 보드 최상위에 단일 요소로 둔다.
           헤더 셀/그리드 셀에 나눠 그리면 행 구분선(1px)마다 끊겨 보인다.
           x 는 시간축(48px) 다음부터 — 본문 leftPx 가 시간축 제외 기준이라 축 폭을 더한다. -->
      <div
        v-if="todayEdgeRect"
        class="v3-today-edge"
        :style="{
          left: `calc(var(--v3-axis-w) + ${todayEdgeRect.left}px)`,
          width: `${todayEdgeRect.width}px`,
        }"
      />
      <!-- sticky 헤더 행 (코너 + 헤더) — 일반 흐름의 블록이라 viewport 기준 상단 고정.
           ⚠️ grid item 으로 두면 자기 row 영역에 sticky 가 갇혀 본문 위로 못 따라온다(브라우저 전체 스크롤). -->
      <div ref="boardHeadEl" class="v3-board-head">
        <!-- 좌상단 빈 코너 -->
        <div class="v3-corner" />

        <!-- 헤더: 날짜 > 담당자 -->
        <div class="v3-header">
        <div class="v3-header-inner" :style="{ width: `${availableWidth}px` }">
          <SchedulerHeader
            v-if="v2Columns.length"
            :header-tree="v2HeaderTree"
            :columns="v2Columns"
            :closed-day-map="closedDayMap"
            :keep-doctor-row="keepDoctorRow"
            :can-prev-doctor="canPrevDoctor"
            :can-next-doctor="canNextDoctor"
            :can-next-day="false"
            :can-prev-day="false"
            @prev-doctor="onPrevDoctor"
            @next-doctor="onNextDoctor"
          />
          <!-- 담당자 0명(표시 컬럼 없음): 담당자 행은 없지만 날짜 행은 표기(날짜는 정해져 있음). -->
          <div v-else class="v3-header-dateonly" :class="{ 'is-today': selectedDate === todayYmd }">
            <span>{{ fallbackDateLabel }}</span>
            <span v-if="fallbackHolidayLabel" class="v3-header-holiday">{{ fallbackHolidayLabel }}</span>
          </div>
        </div>
        </div>

        <!-- 재조회 배지 — sticky 헤더 하단 중앙에 붙어 스크롤 중에도 시야에 남는다(스케줄러 영역 내 갱신 표시).
             absolute + pointer-events:none — 레이아웃을 밀지 않고 조작도 막지 않는다. -->
        <div v-if="isRefreshing" class="v3-refreshing-badge" role="status" aria-live="polite">
          <span class="v3-refreshing-badge__spinner" aria-hidden="true" />갱신 중
        </div>
      </div>

      <!-- 본문 행 (시간축 + body) — 헤더 행과 동일 컬럼(48px + 1fr)로 정렬 -->
      <div class="v3-board-grid">
      <!-- 시간축 (세로: body 와 함께 스크롤) -->
      <div class="v3-timeaxis" :style="{ height: `${bodyHeight}px` }">
        <!-- 시간축 수동 확장: ∧ 위(시작 1h 일찍) / ∨ 아래(종료 1h 늦게) -->
        <button
            v-show="canExtendTop"
            class="scheduleTimeCell__btn scheduleTimeCell__btn--up"
            title="-60분"
            type="button"
            aria-label="운영 시작 시간을 60분 앞당기기"
            @click="onExtendTop"
        />
        <SchedulerTimeAxis :band-infos="v2Bands" />
        <button
            v-show="canExtendBottom"
            class="scheduleTimeCell__btn scheduleTimeCell__btn--down"
            title="+60분"
            type="button"
            aria-label="운영 종료 시간을 60분 늦추기"
            @click="onExtendBottom"
        />
      </div>

      <!-- body (배경 그리드 + 카드 + 현재시각선) -->
      <div ref="boardEl" class="v3-body" :style="{ height: `${bodyHeight}px` }">
        <!-- 배경 그리드: 셀 음영(점심/휴무/과거) + 줄무늬 -->
        <SchedulerGrid
          :columns="v2Columns"
          :band-infos="v2Bands"
          :closed-day-map="closedDayMap"
          :band-row-count-map="{}"
          @cell-click="onGridCellClick"
        />
        <!-- 카드 레이어: 고객명 + displayInfo(생년월일/나이/성별/방문/전화) 동적 + 상태색 + EXT뱃지.
             display-info = 예약장부 설정 표시정보 순서대로 렌더(엔진 정규화=NAME 선두). -->
        <AppointmentLayer
          :rects="v2Rects"
          :engine-appointments="engineAppointments"
          :display-info="layout.config.displayInfo"
          :row-height-level="layout.config.rowHeightLevel"
          :cell-duration="ruleCellDuration"
          @edit="handleEdit"
          @delete="onCardDelete"
          @status-change="onCardStatusChange"
          @callback="onCardCallback"
        />

        <!-- 칸수조절 핸들 — 예약·방문 공통(drag 적용). 컬럼별 개별 N(slotsByKey).
             edge-only: 헤더 담당자/날짜 그룹 컬럼 경계에만(sub-col 내부 분할선 X). -->
        <SubColResizeHandles
          :columns="v2Columns"
          :n="effectiveSlotDivision"
          :slots-by-key="slotsByKey"
          :edge-only="true"
          :available-width="availableWidth"
        />

        <!-- drag/resize preview — inject schedulerDrag/Resize 자동 바인딩 -->
        <DragPreview />
        <ResizePreview />

        <!-- 현재 시각 가로선: 오늘=실선 / 그 외=점선 -->
        <NowIndicator :band-infos="v2Bands" :columns="v2Columns" />

        <!-- hover 카드 ⋮ 버튼 포털 — AppointmentCard 가 자기 ⋮ 를 여기로 teleport(보드 좌표 absolute).
             카드 stacking context 밖+모든 카드 위(z) 라 겹친(floating) 카드에 안 가림. 보드 기준 absolute 라 스크롤 정상. -->
        <div class="v3-qa-portal" />
      </div>
      </div>

      <!-- 본문 좌우 페이지 네비 — 보이는 일자수만큼 ±N일 이동(슬라이드). -->
      <button
        class="v3-page-nav v3-page-nav--left"
        data-scheduler-nav-arrow
        type="button"
        aria-label="이전 날짜로 이동"
        @click="onBodyPagePrev"
      >‹</button>
      <button
        v-show="canBodyNext"
        class="v3-page-nav v3-page-nav--right"
        data-scheduler-nav-arrow
        type="button"
        aria-label="다음 날짜로 이동"
        @click="onBodyPageNext"
      >›</button>
    </div>

    <!-- 예약 생성/수정 팝업 — 공유 컴포넌트, 담당자는 내부 staffStore(teamDoctors) -->
    <ReservationPopup
      :get-blocked-reason="getBlockedReason"
      :payload="reservationPopupPayload"
      :visible="reservationPopupVisible"
      :is-day-off="reservationPopupIsDayOff"
      :saving="reservationSaving"
      @close="closeReservationPopup"
      @save="handleSaveReservation"
      @modify="handleModifyReservation"
    />
  </div>
</template>

<style lang="scss" scoped>
.v3-page {
  display: flex;
  flex-direction: column;
  /* ChannelIntro 등 풀페이지의 검증된 패턴: min-height:100% → 짧으면 뷰포트를 채우고
     길면 콘텐츠만큼 늘어나 브라우저 전체 스크롤 사용(스케줄러 내부 스크롤 없음). */
  min-height: 100%;
  box-sizing: border-box;
  /* 앱 셸 하단의 고정 바(_newsticker, position:fixed bottom 36px)에 마지막 카드가
     가려지지 않도록 하단 여백 확보. */
  padding-bottom: 48px;
  font-size: 12px;
}
.v3-topbar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 6px 12px;
  border-bottom: 1px solid #e0e0e0;
}
.v3-badge {
  font-weight: 600;
  color: var(--scheduler-external, #5b6cb8);
}
.v3-filterStripArea {
  display: flex;
  flex-direction: column;
  min-width: 0;
  width: 100%;
  box-sizing: border-box;
  gap: 8px;
  padding: 21px 0 10px;
}

.v3-searchfilter,
.v3-stripRow {
  margin: 0;
  min-width: 0;
}
/* 예약 변경 모드 안내 배너 — 화면 중앙 하단 고정(화면정의서 13-7). */
.v3-reschedule-banner {
  position: fixed;
  bottom: 24px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 60002;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  width: 400px;
  max-width: calc(100vw - 16px);
  min-height: 90px;
  padding: 20px;
  border: 1px solid #eee;
  border-radius: 0;
  background: #fff;
  box-sizing: border-box;
  box-shadow: 0 4px 10px 0 rgba(0, 0, 0, 0.24);
  animation: apptRescheduleBannerIn 0.15s ease;
}
.v3-reschedule-banner__text {
  display: flex;
  flex-direction: column;
  gap: 10px;
  font-size: 12px;
  font-weight: 700;
  color: #565656;
}
.v3-reschedule-banner__text strong { font-size: 16px; font-weight: 700; color: #000; }
.v3-reschedule-banner__text span { font-size: 12px; color: #565656; }
.v3-reschedule-banner__close {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 0;
  background: transparent;
  cursor: pointer;
  font-size: 0;
  color: transparent;
}
.v3-reschedule-banner__close::before {
  content: '\2715';
  color: #000;
  font-size: 18px;
  line-height: 1;
  transform: translateY(-3px);
}
@keyframes apptRescheduleBannerIn {
  from { opacity: 0; transform: translate(-50%, 8px); }
  to { opacity: 1; transform: translate(-50%, 0); }
}

.v3-redirect-notice {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 10px;
  padding: 10px 14px;
  border: 1px solid #f5c6a0;
  border-radius: 4px;
  background: #fff5ec;
  color: #8a4b00;
  font-size: 13px;
  line-height: 1.4;
}
/* 운영시간 미등록 안내(비블로킹, 권장) — 차단형(빨강 톤)보다 옅은 정보 톤 */
.v3-redirect-notice--soft {
  border-color: #cfd8e3;
  background: #f4f7fb;
  color: #41506b;
}
.v3-redirect-notice--soft .v3-redirect-notice__icon {
  background: #6c7a96;
}
.v3-redirect-notice__icon {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--scheduler-brand, #2f6fed);
  color: #fff;
  font-weight: 700;
  font-size: 12px;
}
.v3-redirect-notice__text b {
  font-weight: 700;
}
.v3-redirect-notice__retry {
  flex-shrink: 0;
  margin-left: auto;
  padding: 4px 12px;
  border: 1px solid #d9a06b;
  border-radius: 4px;
  background: #fff;
  color: #8a4b00;
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
}
.v3-redirect-notice__retry:hover {
  background: #fdeadd;
}
/* "설정" 글자 옆 톱니 표기(장식) — 검색필터 설정 버튼(scheduleSearchFilter__settingBtn)과 같은 아이콘.
   사용자가 어느 버튼을 말하는지 알아보게 하는 인지용이라 클릭 동작은 없다. */
.v3-redirect-notice__gear {
  display: inline-block;
  width: 14px;
  height: 14px;
  margin: 0 1px 0 3px;
  vertical-align: -2px;
  background: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23424242' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Ccircle cx='12' cy='12' r='3'/%3E%3Cpath d='M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z'/%3E%3C/svg%3E") no-repeat center / 14px 14px;
}
/* 줄달력 행 — 검색필터 아래 한 행, 가로 꽉 채움 */
.v3-stripRow {
  display: flex;
  align-items: center;
  padding: 0 4px;
}
.v3-meta {
  color: #888;
}
/* 칸수배정 모델 토글 (A↔B2 눈비교용 디버그 버튼) */
.v3-modeToggle {
  display: inline-flex;
  margin-left: auto;
  border: 1px solid #cdd3e6;
  border-radius: 6px;
  overflow: hidden;
}
.v3-modeToggle button {
  padding: 3px 10px;
  font-size: 12px;
  background: #fff;
  border: 0;
  color: var(--scheduler-external, #5b6cb8);
  cursor: pointer;
}
.v3-modeToggle button + button {
  border-left: 1px solid #cdd3e6;
}
.v3-modeToggle button.active {
  background: var(--scheduler-external, #5b6cb8);
  color: #fff;
  font-weight: 600;
}
/* 보드 레이아웃: 2×2 grid (corner|header / timeAxis|body).
   전체 height 를 펼쳐 브라우저 전체 스크롤 하나만 사용. 헤더/코너는 sticky 로 상단 고정(가로 스크롤 없음). */
.v3-board {
  position: relative;
  /* 시간축 폭 — 헤더 행·본문 행·오늘 경계선 overlay 가 같은 값을 봐야 정렬이 맞는다 */
  --v3-axis-w: 48px;
}
/* 오늘 날짜 그룹 좌/우 경계선 — 헤더 최상단부터 본문 최하단까지 한 요소로 관통(끊김 없음).
   z31: sticky 헤더(z30) 위 · 본문 좌우 page-nav(z35)/blocker(z40) 아래. 클릭은 통과. */
.v3-today-edge {
  position: absolute;
  top: 0;
  bottom: 0;
  z-index: 31;
  box-sizing: border-box;
  border-left: 2px solid var(--scheduler-brand, #2F6FED);
  border-right: 2px solid var(--scheduler-brand, #2F6FED);
  pointer-events: none;
}
/* sticky 헤더 행: 일반 흐름 블록 → 브라우저 전체 스크롤 시 viewport 상단(top:0) 고정.
   ⚠️ grid item 의 sticky 는 자기 grid area(헤더 높이)에 갇혀 본문 위로 못 따라오므로 블록으로 분리. */
.v3-board-head {
  position: sticky;
  top: 0;
  z-index: 30;
  display: grid;
  grid-template-columns: var(--v3-axis-w) minmax(0, 1fr);
}
/* 본문 행: 헤더 행과 동일 컬럼(시간축 + 1fr 본문)로 정렬.
   border-bottom = 마지막 시간대(예: 23:30) 아래를 닫는 선. 밴드 높이가 소수라
   마지막 행의 1px border 가 서브픽셀에서 사라져 보드가 열린 채로 끝난다. */
.v3-board-grid {
  display: grid;
  grid-template-columns: var(--v3-axis-w) minmax(0, 1fr);
  border-bottom: 1px solid var(--scheduler-border, #d0d0d0);
}
/* 팝업 열림 시 스케줄러 영역 클릭/drag 차단 (헤더 sticky z25/30 위, ReservationPopup 모달 아래) */
.v3-blocker {
  position: absolute;
  inset: 0;
  z-index: 40;
}
/* 최초 로딩 오버레이 — 보드 위 z45(blocker z40 위). 도착 전 빈 격자를 가린다.
   높이는 최소값만 두어(뷰포트 절반) 데이터 도착 후 보드 높이가 튀지 않게 한다. */
.v3-loading {
  position: absolute;
  inset: 0;
  z-index: 45;
  min-height: 50vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  background: rgba(255, 255, 255, 0.82);
}
.v3-loading__spinner {
  width: 32px;
  height: 32px;
  border: 3px solid var(--scheduler-border, #d0d0d0);
  border-top-color: var(--scheduler-brand, #2F6FED);
  border-radius: 50%;
  animation: v3-spin 0.8s linear infinite;
}
.v3-loading__text {
  margin: 0;
  font-size: 13px;
  color: #666;
}
@keyframes v3-spin {
  to { transform: rotate(360deg); }
}
/* 접근성 — 모션 최소화 설정이면 회전 대신 정지된 링으로 표시. */
@media (prefers-reduced-motion: reduce) {
  .v3-loading__spinner { animation: none; }
  .v3-refreshing__bar { animation: none; width: 100%; opacity: 0.6; }
  .v3-refreshing-badge__spinner { animation: none; }
}
/* 재조회 진행바 — 화면을 덮지 않는다(조작 계속 가능). 보드 상단에 얇게.
   트랙(옅은 바탕)을 함께 그린다 — 오늘 날짜 헤더 셀이 브랜드색이라 바만 두면 같은 색에 묻힌다. */
.v3-refreshing {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 2px;
  z-index: 45;
  overflow: hidden;
  pointer-events: none;
  background: rgba(255, 255, 255, 0.65);
}
.v3-refreshing__bar {
  display: block;
  width: 30%;
  height: 100%;
  background: var(--scheduler-brand, #2F6FED);
  animation: v3-progress 1.1s ease-in-out infinite;
}
@keyframes v3-progress {
  0%   { transform: translateX(-100%); }
  100% { transform: translateX(400%); }
}
/* 재조회 배지 — sticky 헤더(.v3-board-head) 하단 중앙. 헤더가 sticky 라 스크롤 중에도 시야에 남는다. */
.v3-refreshing-badge {
  position: absolute;
  top: calc(100% + 12px);
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 18px;
  border: 1px solid var(--scheduler-border, #d0d0d0);
  border-radius: 999px;
  background: #fff;
  box-shadow: 0 3px 12px rgba(0, 0, 0, 0.16);
  font-size: 14px;
  font-weight: 500;
  color: #444;
  pointer-events: none;
}
.v3-refreshing-badge__spinner {
  width: 16px;
  height: 16px;
  border: 2px solid var(--scheduler-border, #d0d0d0);
  border-top-color: var(--scheduler-brand, #2F6FED);
  border-radius: 50%;
  animation: v3-spin 0.8s linear infinite;
}
/* 재조회 중 본문 blur — 갱신 면 표현 + 본문 클릭·드래그 차단(pointer-events 기본 auto).
   z25 = 카드 위 · sticky 헤더(z30)/page-nav(z35) 아래 — 페이징 등 이동 조작은 계속 가능하다. */
.v3-refreshing-dim {
  position: absolute;
  inset: 0;
  z-index: 25;
  backdrop-filter: blur(2px);
  background: rgba(255, 255, 255, 0.35);
}
.v3-corner {
  background: var(--scheduler-header-bg, #f4f4f4);
  border-right: 1px solid var(--scheduler-border, #d0d0d0);
  border-bottom: 1px solid #ddd;
}
.v3-header {
  overflow: hidden;
  background: var(--scheduler-header-bg, #f4f4f4);
  border-bottom: 1px solid #ddd;
}
.v3-header-inner {
  position: relative;
  /* 높이는 SchedulerHeader 내용(날짜+담당자 2행 / 담당자1명 1행)에 따라 가변 */
}
/* 담당자 0명일 때 날짜만 표기하는 헤더 행 (SchedulerHeader 날짜 행과 동일 톤) */
.v3-header-dateonly {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 38px;
  background: var(--scheduler-header-bg, #f4f4f4);
  border-bottom: 1px solid #8F94A3;
  font-size: 14px;
  font-weight: 700;
  color: #333;
  gap: 6px;
}
/* 담당자 0명이어도 오늘이면 날짜 행은 동일하게 브랜드 강조(SchedulerHeader .is-today 와 동일 톤) */
.v3-header-dateonly.is-today {
  background: var(--scheduler-brand, #2F6FED);
  color: #fff;
}
/* 담당자 0명(fallback) 헤더의 공휴일명 — 빨강 강조 */
.v3-header-holiday {
  color: #d32f2f;
  font-weight: 700;
}
.v3-header-dateonly.is-today .v3-header-holiday {
  color: #fff;
}
/* 날짜 행 휴무 뱃지 빨강(공휴일/정기휴무 강조). */
.v3-header :deep(.header-row--date .header-badge--hospital) {
  background: #d32f2f;
  color: #fff;
}
/* 담당자축(담당자행) 페이징 <> 노출. 날짜축 <>(날짜행)는 미사용 → 숨김(본문 좌우 page-nav 가 날짜 담당). */
.v3-header :deep(.header-row--date .header-nav) {
  display: none;
}
/* 본문 좌우 페이지 네비 — viewport 세로 중앙 고정, ±보이는일수 날짜 이동. */
.v3-page-nav {
  /* 버튼 숨김(로직·핸들러 보존). 되살릴 땐 none → flex 로 변경. */
  display: none;
  position: fixed;
  top: 50%;
  transform: translateY(-50%);
  z-index: 35;
  width: 28px;
  height: 56px;
  border: none;
  border-radius: 4px;
  background: rgba(17, 17, 17, 0.55);
  color: #fff;
  font-size: 22px;
  font-weight: 800;
  line-height: 1;
  cursor: pointer;
  align-items: center;
  justify-content: center;
  user-select: none;
}
.v3-page-nav:hover {
  background: rgba(17, 17, 17, 0.82);
}
.v3-page-nav--left {
  left: 52px;
}
.v3-page-nav--right {
  right: 12px;
}
/* 담당자명 헤더는 말줄임 없이 full 표시 — 셀 폭이 충분하므로 ellipsis 해제(부족 시 줄바꿈). */
.v3-header :deep(.header-cell) {
  white-space: normal;
  overflow: visible;
  text-overflow: clip;
}
.v3-timeaxis {
  position: relative;
  border-right: 1px solid #ddd;
}
/* 시간축 확장 버튼 (.v3-timeaxis = position:relative 기준) */
.scheduleTimeCell__btn {
  position: absolute;
  left: 3px;
  right: 3px;
  z-index: 1;

  height: 16px;
  padding: 0;

  box-sizing: border-box;
  border: 1px solid #E0E3ED;
  border-radius: 2px;
  background: #E0E3ED;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;

  font-size: 0;
  line-height: 0;

  &:hover,
  &:active {
    background: #8F94A3;
  }

  &:focus-visible {
    outline: 2px solid rgba(0, 0, 0, 0.15);
    outline-offset: 1px;
  }

  &--up {
    top: 4px;
  }

  &--down {
    bottom: 4px;
  }
}

/* 버튼 화살표 (SVG Chevron) */
@mixin chevron-icon($points) {
  content: '';
  width: 14px;
  height: 14px;
  background: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='white' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='#{$points}'/%3E%3C/svg%3E") center / contain no-repeat;
}

.scheduleTimeCell__btn--up::before {
  @include chevron-icon('18 15 12 9 6 15');
}

.scheduleTimeCell__btn--down::before {
  @include chevron-icon('6 9 12 15 18 9');
}
.v3-body {
  position: relative;
  /* stacking context 격리: 내부 NowIndicator(z 300)가 sticky 헤더를 관통하지 않도록 body 를 z0 컨텍스트로.
     헤더(.v3-board-head z30)는 본문 grid(.v3-board-grid)의 형제라 NowIndicator 보다 항상 위에 paint. */
  z-index: 0;
}
/* hover 카드 ⋮ 포털 — 보드 좌표 absolute, 모든 카드·NowIndicator 위(z). 컨테이너는 클릭 통과, 자식 ⋮ 만 auto. */
.v3-qa-portal {
  position: absolute;
  inset: 0;
  z-index: 400;
  pointer-events: none;
}
</style>
