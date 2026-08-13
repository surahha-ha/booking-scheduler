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
import { useSchedulerRules } from '@/composables/useSchedulerRules'
// 줄달력 날짜 상태(selectedDate 단일 기준).
import { useSchedulerNavigation } from '@/pages/desktop/scheduler/composables/useSchedulerNavigation'
// 인터랙션 composable 재사용(페이지-로컬 격리) — hover/popover/drag/resize/reschedule.
import { useSchedulerInteractionLock } from '@/pages/desktop/scheduler/composables/useSchedulerInteractionLock'
import { useSchedulerHover } from '@/pages/desktop/scheduler/composables/useSchedulerHover'
import { useSchedulerPopover } from '@/pages/desktop/scheduler/composables/useSchedulerPopover'
import { useSchedulerDrag } from '@/pages/desktop/scheduler/composables/useSchedulerDrag'
import { useSchedulerResize } from '@/pages/desktop/scheduler/composables/useSchedulerResize'
import { useSchedulerReschedule } from '@/pages/desktop/scheduler/composables/useSchedulerReschedule'
import { runLayout } from '@/scheduler-engine/redesign/layoutPipeline'
import { toEngineAppointments } from '@/pages/desktop/scheduler/adapters/appointmentAdapter'
import { dragResultToBookItemRequest, resizeResultToBookItemRequest } from '@/pages/desktop/scheduler/adapters/dragResultAdapter'
import { normalizeName, resolveVisibleDoctors } from '@/utils/schedulerSearchFilterUtils'
import { buildStoreRunLayoutInput } from './v3StoreInput'
import { reanchorArgsForSlot } from './navSlots'
import { toV2Bands, toV2Columns, toV2HeaderTree, toV2Rects } from './v3ParityAdapter'
// 공유 검색필터 컴포넌트 재사용. filterStore→searchVersion→bookStore 자체 구동.
import SchedulerSearchFilter from '@/pages/desktop/scheduleBoard/components/SchedulerSearchFilter.vue'
// 줄달력 — 예약 모드: 당일 포함 미래 30일 / 진료: 당일 포함 직전 30일.
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
// URL query(dataType/viewMode) ↔ filterStore 동기화 — 외부 deep-link 진입 + 기본 query set.
// (MR-Swap 으로 /book 을 SchedulerPage→V3Page 로 옮기며 누락됐던 호출 복구.)
useQueryString()
// 날짜 표기/이동을 일별(하루) 기준으로 DAY 강제. 조회 날짜 폭은 윈도우가 결정(viewMode 무관).
if (filterStore.viewMode !== 'DAY') filterStore.setViewMode('DAY', false)
const { appointments, redirectReason, serviceUnavailable, noTreatmentTime } = storeToRefs(bookStore)
const { doctors, hospitalRules, doctorRules, teams } = storeToRefs(staffStore)
// 날짜→공휴일 휴무 라벨 lookup. 헤더 날짜 행에 '휴무' 표기.
// 공휴일이라고 다 휴무는 아니다 — '공휴일 휴무'(holidayClosedYn) 이 꺼진 병원은 공휴일에도 진료한다.
// 그 설정은 이미 staffStore 가 closedDates 에 반영해 두므로(공휴일 합류 + workDates rescue) 그것으로 판정한다.
const holidayLabelFor = ymd =>
  (holidayStore.isHoliday(ymd) && hospitalRules.value?.closedDates?.has(ymd)) ? '휴무' : undefined
const { periodDate, doctors: selectedDoctorIds, dataType, selectedTeamName } = storeToRefs(filterStore)
// 예약장부 설정(budget base/grid 간격/카드높이/표시정보). 미로딩 시 store 기본값 → onMounted 에서 조회.
const {
  totalColumns: settingTotalColumns,
  timeUnit: settingTimeUnit,
  displayInfo: settingDisplayInfo,
  rowHeightLevel: settingRowHeightLevel,
} = storeToRefs(reservationSettingStore)

// ── Navigation (selectedDate 단일 기준) ──
// 줄달력(SchedulerDateStrip)·UiDateNavigator·헤더가 공유하는 날짜 상태. filterStore.periodDate 와 양방향 sync.
const visibleDayCount = ref(1)
const navigation = useSchedulerNavigation({
  initialDate: dayjs(periodDate.value).format('YYYY-MM-DD'),
  headerWindowDays: 30,
  visibleDayCount,
})
// navigation → filterStore (날짜 이동 시 periodDate 반영 → searchVersion watch chain 으로 재조회. load 직접호출 금지 준수)
watch(() => navigation.selectedDate.value, (newDate) => {
  if (dayjs(periodDate.value).format('YYYY-MM-DD') !== newDate) {
    filterStore.patch({ periodDate: dayjs(newDate).toDate() })
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

// 담당자 0명(표시 컬럼 없음)일 때 헤더에 표기할 날짜 라벨 — 날짜는 정해져 있으므로 의사 행만 비고 날짜는 보인다.
const WEEKDAY_KO = ['일', '월', '화', '수', '목', '금', '토']
const fallbackDateLabel = computed(() => {
  const d = dayjs(selectedDate.value)
  return d.isValid() ? `${d.format('MM-DD')} (${WEEKDAY_KO[d.day()]})` : ''
})
// 의사 0명(fallback) 헤더의 공휴일 휴무 — 빨간 span 으로 별도 표기.
const fallbackHolidayLabel = computed(() => {
  const d = dayjs(selectedDate.value)
  return d.isValid() ? holidayLabelFor(d.format('YYYY-MM-DD')) : undefined
})

// 나머지는 페이지-로컬 (DB 저장 X) — 보기단계/N칸/페이지
// N칸보기 기본값 = 2 (예약·진료 공통). 예약은 툴바로 라이브 조절, 진료는 effectiveSlotDivision 에서 2 강제.
const viewStep = ref(3)
const slotDivision = ref(2)
// 컬럼별 칸수 override(state-only). { '${date}__${doctorId}': N }. 드래그로 특정 컬럼만 N칸 조절 → 엔진 resolveSlots 우선 적용.
const customSlots = ref({})
// 칸수배정 모델 토글. 'A'=레인폭=동시건수 / 'B2'(기본)=레인폭 N고정·카드 1칸. 엔진 default(미전달)는 'A'.
const layoutMode = ref('B2')
// date-anchored 윈도우 시작 sub-col offset. 좌측 끝은 항상 selectedDate(날짜)로 고정 →
// 데이터 재조회로 밀도가 변해도 보던 날짜가 안 끌려감(헤더 > 빈보드 점프 차단). 0 = selectedDate 첫 컬럼부터.
// >0 은 하루 컬럼수가 budget 을 초과할 때만(within-day 의사 페이징).
const colOffset = ref(0)
// 헤더 담당자 <> 의 날짜 re-anchor 용 — selectedDate 변경(→colOffset reset) 후 flush:post 에서 복원할 offset.
const pendingColOffset = ref(null)
// 시간축 수동 확장(시간) — 시작 일찍(^)/종료 늦게(v).
const timelineTopExtend = ref(0)
const timelineBottomExtend = ref(0)

// ── 줄달력 상태 + 이벤트 (예약/진료 분기) ──
// 줄달력은 filterStore.dataType(실제 토글) 기준 분기.
const isTreatmentMode = computed(() => dataType.value === 'TREATMENT')
// 진료모드는 N칸 2 강제(라이브 무시). 렌더(viewState)와 drag/resize hitTest 가 동일 값을 써야 좌표 정합 → 단일 computed.
const effectiveSlotDivision = computed(() => (isTreatmentMode.value ? 2 : slotDivision.value))
const dateStripMode = ref('rolling')
const expandedMonth = ref(null)

// 예약: 당일 포함 미래 30일 / 진료: 당일 포함 직전 30일(당일=오른쪽 끝)
function computeInitialStrip() {
  return isTreatmentMode.value
    ? dayjs().subtract(29, 'day').format('YYYY-MM-DD')
    : dayjs().format('YYYY-MM-DD')
}
const stripWindowStart = ref(computeInitialStrip())
// 진료: 미래 표기 불가 → 줄달력 maxDate=오늘 (월버튼 왼쪽·› 숨김 자동). 예약: 제한 없음.
const stripMaxDate = computed(() => (isTreatmentMode.value ? dayjs().format('YYYY-MM-DD') : null))

// 진료: strip 끝(start+29) ≤ 오늘 보장
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
  // 진료: 선택일이 strip 끝 / 예약: 선택일이 strip 시작
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
  // 진료: 오늘 이후 이동 불가
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
  // 진료: 오늘 이후 불가 → 오늘로 clamp
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
// dataType(예약↔진료) 전환 시 strip 재계산. selectedDate 클램프는 filterStore.setDataType(#1) 담당.
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
  // ref 자체는 예약값 보존 → 예약 복귀 시 사용자 zoom/N칸 유지. layout 계산만 진료 시 기본 적용.
  viewStep: isTreatmentMode.value ? 3 : viewStep.value,
  slotDivision: effectiveSlotDivision.value,
  // 컬럼별 칸수 — customSlots override 우선, 없으면 기본(예약=slotDivision / 진료=2).
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
  ro = new ResizeObserver((entries) => {
    availableWidth.value = entries[0]?.contentRect?.width ?? 0
  })
  ro.observe(boardEl.value)
  availableWidth.value = boardEl.value.clientWidth
  nowTimer = setInterval(() => { nowTick.value = Date.now() }, 30_000)
})

onBeforeUnmount(() => {
  ro?.disconnect()
  ro = null
  if (nowTimer) clearInterval(nowTimer)
  // V3 떠날 때 조회 윈도우 해제 → V2 등 다른 소비자는 기존 viewMode/periodDate 경로로 복귀(잔류 방지).
  filterStore.setWindow(null, 0, false)
})

// ── 진료 팀 표시 필터 (이름 통일): 미지정=담당자 목록−팀멤버 / 팀=∩ → 컬럼(header tree) 소스 ──
const visibleDoctors = computed(() => resolveVisibleDoctors(selectedTeamName.value, doctors.value, teams.value))

// ── 조회 윈도우 = 예약0(최소밀도) 가정 한 화면 채울 일수 + 버퍼1 (담당자/budget 기반 동적, 과조회 방지) ──
// 담당자 많으면 적게(하루 칸수 > budget → 1일), 적으면 많이 조회. 표시(horizon)가 조회를 주도.
// budget_max = zoom out 최대(viewStep=1) = totalColumns + 4. totalColumns = 예약장부 설정값(reservationSettingStore).
// 설정 6칸이면 budget_max 10 → 윈도우 조회량이 설정에 정합. 진료(TREATMENT)는 엔진이 horizon=1 강제라 무관.
const BUDGET_MAX = computed(() => settingTotalColumns.value + 4) // = computeBudget(totalColumns, viewStep=1)
const MAX_WINDOW_DAYS = 90
// 실제 표시 의사 수 = 팀/미지정 visibleDoctors ∩ 검색필터 의사선택(없으면 전체).
const activeDoctorCount = computed(() => {
  const sel = selectedDoctorIds.value
  const visible = visibleDoctors.value
  if (sel.length === 0) return visible.length
  return visible.filter(d => sel.includes(d.id)).length
})
// 한 화면(budget_max)을 채울 최소 일수 (예약0 → 의사당 1칸). 의사 0 가드.
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

// 공휴일이면서 진료하는 날 → 엔진이 쓰는 배열로. store 는 Set 이라 조회가 빠르지만 엔진 config 는 plain 만 담는다.
const holidayOpenDateList = computed(() => {
  const src = hospitalRules.value?.holidayOpenDates
  if (!src) return []
  return Array.isArray(src) ? src : Array.from(src)
})

// ── 엔진 파이프 (store → adapter → runLayout) ──
const layout = computed(() =>
  runLayout(buildStoreRunLayoutInput({
    doctors: visibleDoctors.value,
    appts: appointments.value,
    // 기관 운영시간(institution) = timeline·미설정 의사 요일의 fallback 소스.
    weekly: hospitalRules.value?.weekly,
    // 공휴일 운영시간 — 공휴일에 진료하는 날은 요일·담당자 시간 대신 기관 공휴일 시간으로 밴드를 그린다
    // (예약검증 useSchedulerRules 와 같은 규칙. 한쪽만 반영하면 "밴드는 열렸는데 클릭하면 운영종료").
    holiday: hospitalRules.value?.holiday,
    holidayDates: holidayOpenDateList.value,
    dailyByDate: hospitalRules.value?.dailyByDate ?? undefined,
    // 담당자별 요일 운영시간(밴드용). 미설정 요일은 어댑터→엔진 fallback 이 기관으로 메꾼다.
    doctorWeeklyById: doctorWeeklyById.value,
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
// 컬럼별 현재 칸수 맵 — 엔진 출력 unit.slots(customSlots 반영). SubColResizeHandles 가 컬럼별 분할선 그릴 때 사용.
const slotsByKey = computed(() => {
  const map = {}
  for (const u of layout.value.units) map[u.key] = u.slots
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
// 비공개(openYn='N') 담당자 id(=이름) 집합 — 헤더 '비공개' 뱃지. 검색필터 뱃지와 동일 소스(staffStore.doctors).
const privateDoctorIds = computed(() => new Set(doctors.value.filter(d => d.openYn === 'N').map(d => d.id)))
// SchedulerHeader 용 날짜>의사 트리(leaf.key=unit.key → 의사1명 행제거 자동 동작).
const v2HeaderTree = computed(() => toV2HeaderTree(columns.value, holidayLabelFor, privateDoctorIds.value))

// ── 데이터 조회 윈도우 = 현재 페이지에 "보이는 날짜 범위" (표시 주도 조회) ──
// 페이징(담당자 <> / 본문 <>)으로 보이는 날짜가 바뀌면 그 범위로 슬라이드 재조회.
// 패킹 horizon(미래 빈 날짜 다수)과 분리 → endDate 누적 성장 없이 보이는 만큼만 조회(start 도 슬라이드).
const visibleDates = computed(() => [...new Set(columns.value.map(c => c.unit.date))].sort())
// 표시 날짜들의 연도 공휴일 보장 — 연 이동 시 누락 연도 보충(App.vue 는 현재±1년만 프리로드). 헤더 공휴일명 표기용.
watch(visibleDates, (dates) => {
  const years = [...new Set(dates.map(d => Number(d.slice(0, 4))).filter(Boolean))]
  if (years.length) holidayStore.ensureYears(years)
}, { immediate: true })
const dataWindowAnchor = computed(() => visibleDates.value[0] ?? selectedDate.value)
const dataWindowDays = computed(() => {
  const ds = visibleDates.value
  if (ds.length === 0) return 1
  return dayjs(ds[ds.length - 1]).diff(dayjs(ds[0]), 'day') + 1
})
// load 직접호출 금지 → setWindow→searchVersion watch chain. setWindow dedup(anchor+days 동일 return)으로 수렴.
watch([dataWindowAnchor, dataWindowDays], ([anchor, days]) => {
  // layout 첫 평가 전(doctors 로드 전 visibleDates 빈)엔 setWindow 안 함.
  // 빈 상태 days=1 setWindow 는 초기 load(searchVersion watch, periodDate)와 동일 윈도우 중복 호출 유발.
  if (visibleDates.value.length === 0) return
  filterStore.setWindow(dayjs(anchor).toDate(), days)
}, { immediate: true })

// ── 통합 페이징 (date-anchored) — 좌측 끝 = selectedDate(날짜), colOffset = within-day offset ──
// 엔진이 [colOffset, colOffset+budget) 임의 슬라이스. 헤더 담당자 <> 는 윈도우를 budget 칸씩 이동하되
// 착지한 컬럼의 "날짜"로 selectedDate 를 재고정 → 데이터 재조회로 밀도가 변해도 좌측 날짜가 안 끌려감(점프 차단).
const totalSlots = computed(() => layout.value.totalSlots)
// 실제 적용된(clamp 후) 윈도우 시작 offset — 증감 계산의 기준.
const effectiveColOffset = computed(() => layout.value.slotOffset)
// 현 horizon 안에 다음 budget 윈도우가 더 있나.
const hasMoreForward = computed(() => effectiveColOffset.value + layout.value.config.budget < totalSlots.value)
// 예약: <> 항시(과거/미래 무한). 진료: < 항시(과거), > 는 오늘 도달 시 숨김(미래 불가).
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
// 헤더 담당자 > — 윈도우를 budget 칸 전진(착지 컬럼의 날짜로 재고정).
function onNextDoctor() {
  const budget = layout.value.config.budget
  const target = effectiveColOffset.value + budget
  if (target < totalSlots.value) {
    const at = reanchorArgsForSlot(layout.value.units, target, selectedDate.value)
    reanchorTo(at.date, at.offset)
    return
  }
  // horizon 끝 → 미래로 (예약: 보이는 일수만큼 앞 / 진료: 오늘까지 +1일).
  if (isTreatmentMode.value) {
    if (dayjs(selectedDate.value).isBefore(dayjs(), 'day')) {
      reanchorTo(dayjs(selectedDate.value).add(1, 'day').format('YYYY-MM-DD'), 0)
    }
    return
  }
  reanchorTo(dayjs(firstVisibleDate.value).add(Math.max(1, visiblePageDays.value), 'day').format('YYYY-MM-DD'), 0)
}
// 헤더 담당자 < — 윈도우를 budget 칸 후퇴.
function onPrevDoctor() {
  const budget = layout.value.config.budget
  const target = effectiveColOffset.value - budget
  if (target >= 0) {
    const at = reanchorArgsForSlot(layout.value.units, target, selectedDate.value)
    reanchorTo(at.date, at.offset)
    return
  }
  // 과거로 — 보이는 일수만큼(진료 1일) selectedDate 뒤로, colOffset 0.
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
// 장부(예약↔진료) 전환 시 보기단계/N칸을 기본값(보기단계=3·N칸=2)으로 리셋 — 한 장부의 라이브 조절값이 다른 장부로 이월되지 않음.
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
// 의사 행 항상 유지 → 1명만 선택/표시돼도 해당 담당자명이 헤더에 보이게(사용자 요구).
// (페이징으로 한 페이지에 1명만 표시될 때 의사행이 사라져 < > 까지 갇히는 것도 함께 방지.)
const keepDoctorRow = computed(() => true)

// ── 본문 좌우 페이지 네비 — 화면 보이는 일자수만큼 ±N일 이동(슬라이드+재조회) ──
// 헤더 담당자 <> 는 윈도우를 budget 칸씩(의사+날짜 혼합), 본문 좌우 <> 는 보이는 일자 단위 점프.
// visibleDates 는 위(데이터 조회 윈도우)에서 정의 — 보이는 날짜 수만큼 점프.
const visiblePageDays = computed(() => visibleDates.value.length || 1)
// firstVisible = 좌측 첫 컬럼의 날짜 (date-anchored: colOffset 0 이면 selectedDate, within-day overflow 면 그 날짜).
const firstVisibleDate = computed(() => visibleDates.value[0] ?? selectedDate.value)
const lastVisibleDate = computed(() => visibleDates.value[visibleDates.value.length - 1] ?? selectedDate.value)
// 줄달력 하이라이트(=firstVisible)가 strip 윈도우 밖으로 스크롤되면(헤더 담당자 <> 페이징으로 anchor≠firstVisible)
// 윈도우를 따라 이동. ensureStripContains 는 범위 밖일 때만 조정(멱등) — re-anchor 조작은 selectedDate watch 가 이미 커버.
watch(firstVisibleDate, (date) => { ensureStripContains(date) })
// 진료모드는 미래 불가 → 마지막 보이는 날짜가 오늘 이전일 때만 다음 구간 허용(줄달력 maxDate 정합).
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
// 의사 운영시간/요일휴무 우선(DOCTOR_FIRST), 의사 미설정 요일은 기관(institution)으로 fallback(FALLBACK).
// 의사가 설정한 요일은 그 의사 daily 통째로 사용(기관 점심 merge 안 함).
const rulesOptions = { priority: 'DOCTOR_FIRST', mergePolicy: 'FALLBACK' }
const {
  getBlockedReason,
  isClosedDayForHeader,
  isHospitalClosedDayForHeader,
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

// 컬럼 key → { doctorClosed, hospitalClosed } (헤더 뱃지 + Grid 셀)
const closedDayMap = computed(() => {
  const map = {}
  for (const col of columns.value) {
    const at12 = dayjs(col.unit.date).hour(12).toDate()
    map[col.unit.key] = {
      doctorClosed: isClosedDayForHeader(at12, col.unit.doctorId),
      hospitalClosed: isHospitalClosedDayForHeader(at12),
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
// redesign Rect → AppointmentRect(appointmentId/columnKey/zIndex). columns 로 columnKey 해석.
const v2Rects = computed(() => toV2Rects(layout.value.rects, columns.value))

const rects = computed(() => layout.value.rects)

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

// validate: closedDate/closedWeekday(invalid) / outsideHours(warning) / 과거(invalid). getBlockedReason 재사용.
const HARD_BLOCKED_REASONS = new Set(['closedDate', 'closedWeekday'])
const WARNING_REASONS = new Set(['outsideHours'])
function minuteToDate(dateStr, minute) {
  const h = Math.floor(minute / 60)
  const m = minute % 60
  return dayjs(dateStr).hour(h).minute(m).second(0).toDate()
}
function isPastDateTime(date, startMinute) {
  const step = ruleCellDuration.value || 30
  const bandEndMinute = Math.ceil((startMinute + 1) / step) * step
  return dayjs(minuteToDate(date, bandEndMinute)).isBefore(dayjs())
}
function validateDropPosition(appointmentId, columnKey, date, resourceId, startMinute, endMinute) {
  if (isPastDateTime(date, startMinute)) return { isValid: false, reason: 'past' }
  const step = ruleCellDuration.value || 30
  let warningReason = null
  for (let m = startMinute; m < endMinute; m += step) {
    const result = getBlockedReason(minuteToDate(date, m), resourceId)
    if (HARD_BLOCKED_REASONS.has(result.reason)) return { isValid: false, reason: result.reason }
    if (WARNING_REASONS.has(result.reason)) warningReason = result.reason
  }
  return warningReason ? { isValid: true, warning: warningReason } : { isValid: true }
}
function validateResizePosition(appointmentId, columnKey, startMinute, endMinute) {
  const col = v2Columns.value.find(c => c.key === columnKey)
  if (!col) return { isValid: true }
  if (isPastDateTime(col.date, startMinute)) return { isValid: false, reason: 'past' }
  const step = ruleCellDuration.value || 30
  let warningReason = null
  for (let m = startMinute; m < endMinute; m += step) {
    const result = getBlockedReason(minuteToDate(col.date, m), col.resourceId)
    if (HARD_BLOCKED_REASONS.has(result.reason)) return { isValid: false, reason: result.reason }
    if (WARNING_REASONS.has(result.reason)) warningReason = result.reason
  }
  return warningReason ? { isValid: true, warning: warningReason } : { isValid: true }
}

// 의사 이름 resolver (drag adapter용, 이름키 정합)
function resolveDoctorName(doctorName) {
  return doctors.value.find(d => d.id === doctorName)?.text ?? doctorName
}

// drop/resize → bookStore 저장 (raw 원본 + dragResultAdapter → modifyAppointment → onCardCallback(triggerSearch))
async function handleDrop(result) {
  const raw = appointments.value.find(a => a.id === result.appointmentId)
  if (!raw) return
  const validation = validateDropPosition(result.appointmentId, result.toColumnKey, result.toDate, result.toResourceId, result.newStartMinute, result.newEndMinute)
  if (!validation.isValid) return
  if (validation.warning) {
    const doctorName = resolveDoctorName(result.toResourceId) || ''
    const ok = await dialog.confirm(`해당 시간에 ${doctorName}님은 운영종료 시간입니다.\n예약을 등록하시겠습니까?`, { title: '예약 확인' })
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
  if (!validation.isValid) return
  if (validation.warning) {
    const col = v2Columns.value.find(c => c.key === result.columnKey)
    const doctorName = col?.resourceLabel || ''
    const ok = await dialog.confirm(`해당 시간에 ${doctorName}님은 운영종료 시간입니다.\n예약을 등록하시겠습니까?`, { title: '예약 확인' })
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
async function handleRescheduleCommit(result) {
  const raw = rescheduleOriginRaw
  if (!raw || raw.id !== result.appointmentId) return
  const validation = validateDropPosition(result.appointmentId, result.toColumnKey, result.toDate, result.toResourceId, result.newStartMinute, result.newEndMinute)
  if (!validation.isValid) return
  if (validation.warning) {
    const doctorName = resolveDoctorName(result.toResourceId) || ''
    const ok = await dialog.confirm(`해당 시간에 ${doctorName}님은 운영종료 시간입니다.\n예약을 등록하시겠습니까?`, { title: '예약 확인' })
    if (!ok) return
  }
  const request = dragResultToBookItemRequest(result, raw, resolveDoctorName)
  if (!request) return
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
// (watch 는 flush 지연 — pickSlot 의 cancel()→onCommit 동기 호출 시 raw 는 이미 캡처돼 영향 없음.)
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
const reservationPopupIsDayOff = computed(() => {
  const startDate = reservationPopupPayload.value?.startDateTime
  return startDate ? isHospitalClosedDayForHeader(startDate) : false
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
async function handleSaveReservation(payload) {
  const response = await bookStore.addAppointment(payload)
  onCardCallback(response)
  closeReservationPopup()
}
async function handleModifyReservation(payload) {
  const response = await bookStore.modifyAppointment(payload.id, payload)
  onCardCallback(response)
  closeReservationPopup()
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
function onCardCallback(response) {
  if (response?.code === 'succeed') {
    filterStore.triggerSearch()
    const toast = push.success(SUCCESS_MESSAGE)
    setTimeout(() => toast.clear(), 3000)
  } else {
    const msg = response?.message
    push.error(msg && msg !== '500' && msg !== 500 ? msg : FAIL_MESSAGE)
  }
}
// @delete/@status-change 는 카드가 emit 하지 않음(카드 내부 bookStore 직접 호출→onCardCallback) — no-op.
function onCardDelete() {}
function onCardStatusChange() {}

// ── 검색 드롭다운 pick ──
// 최근 예약 항목 pick → 해당 날짜 이동(setPeriodDate → searchVersion·periodDate watch chain) + 대상 카드 하이라이트.
const SEARCH_HIGHLIGHT_MS = 5000
const searchHighlightId = ref(null)
provide('schedulerSearchHighlight', { highlightedId: searchHighlightId })
let searchHighlightTimer = null
// pick 한 예약 의사(staffName)가 속한 팀명 — 어느 팀에도 없으면 null(미지정 그룹).
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
async function onRecentPick(item) {
  const d = dayjs(item.startAt)
  if (!d.isValid()) return
  const targetId = String(item.reservationId)
  // 이미 현재 화면에 렌더된 카드면(날짜·의사·페이지 모두 표시 중) 날짜 이동/팀 전환 없이
  // 그 화면 그대로 하이라이트만. rects = 현재 그려진 카드 집합(runLayout 출력).
  const alreadyRendered = rects.value.some(r => String(r.id) === targetId)
  if (!alreadyRendered) {
    // 방문 장부는 과거~오늘만 표기 — 미래 항목 pick 시 예약장부로 전환 후 이동
    if (filterStore.dataType === 'TREATMENT' && d.isAfter(dayjs(), 'day')) {
      filterStore.setDataType('APPOINTMENT', false)
    }
    // 의사 컬럼 정합 — pick 의사가 visible 집합에 포함되도록 팀 컨텍스트 전환 + 의사 개별 필터 전체.
    //  - 미지정 그룹 의사 → selectedTeamName=null(미지정 "전체")
    //  - 팀 소속 의사 → 그 팀(팀 "전체"). setTeam 이 doctors 도 비움([], 전체).
    // (그 의사가 팀 멤버라 "미지정"에서 빠져 카드가 안 그려지던 버그 해결)
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
  if (searchHighlightTimer) clearTimeout(searchHighlightTimer)
  searchHighlightTimer = setTimeout(() => {
    searchHighlightId.value = null
    searchHighlightTimer = null
  }, SEARCH_HIGHLIGHT_MS)
}
onBeforeUnmount(() => {
  if (searchHighlightTimer) clearTimeout(searchHighlightTimer)
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
      <!-- 공유 검색필터 바 재사용 (예약/진료·날짜·의사·상태·회원·검색·설정). 일별/주별 토글은 V3에서 숨김. -->
      <SchedulerSearchFilter class="v3-searchfilter" :hide-view-mode="true" :recent-search="true" @pick-recent="onRecentPick" />

      <!-- 운영시간/담당자 미등록 안내 -->
      <div v-if="redirectReason" class="v3-redirect-notice" role="alert">
        <span class="v3-redirect-notice__icon" aria-hidden="true">!</span>
        <span class="v3-redirect-notice__text">
          운영시간 또는 담당자가 등록되지 않아 예약을 조회할 수 없습니다.
          <b>설정</b>에서 운영시간과 담당자를 등록해 주세요.
        </span>
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
        <!-- N칸 보기 · 보기단계(zoom). 진료모드는 라이브 칸보기/보기단계 없음(1일 고정) → 툴바 숨김. -->
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

      <!-- 오늘 날짜 그룹 좌/우 경계선 — 헤더 날짜셀 브랜드 강조와 한 쌍.
           헤더(날짜행+의사행)와 본문을 하나로 관통해야 해서 보드 최상위에 단일 요소로 둔다.
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
      <div class="v3-board-head">
        <!-- 좌상단 빈 코너 -->
        <div class="v3-corner" />

        <!-- 헤더: 날짜 > 의사 -->
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
          <!-- 담당자 0명(표시 컬럼 없음): 의사 행은 없지만 날짜 행은 표기(날짜는 정해져 있음). -->
          <div v-else class="v3-header-dateonly" :class="{ 'is-today': selectedDate === todayYmd }">
            <span>{{ fallbackDateLabel }}</span>
            <span v-if="fallbackHolidayLabel" class="v3-header-holiday">{{ fallbackHolidayLabel }}</span>
          </div>
        </div>
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
            aria-label="진료 시작 시간을 60분 앞당기기"
            @click="onExtendTop"
        />
        <SchedulerTimeAxis :band-infos="v2Bands" />
        <button
            v-show="canExtendBottom"
            class="scheduleTimeCell__btn scheduleTimeCell__btn--down"
            title="+60분"
            type="button"
            aria-label="진료 종료 시간을 60분 늦추기"
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
        <!-- 카드 레이어: 고객명 + displayInfo(생년월일/나이/성별/진료/전화) 동적 + 상태색 + EXT뱃지.
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

        <!-- 칸수조절 핸들 — 예약·진료 공통(drag 적용). 컬럼별 개별 N(slotsByKey).
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

    <!-- 예약 생성/수정 팝업 — 공유 컴포넌트, 담당의사는 내부 staffStore(teamDoctors) -->
    <ReservationPopup
      :get-blocked-reason="getBlockedReason"
      :payload="reservationPopupPayload"
      :visible="reservationPopupVisible"
      :is-day-off="reservationPopupIsDayOff"
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
  align-items: center;
  gap: 12px;
  max-width: 520px;
  padding: 12px 14px 12px 18px;
  border: 1px solid #f0b27a;
  border-left: 5px solid var(--scheduler-brand, #2F6FED);
  border-radius: 8px;
  background: #fff5ec;
  box-shadow: 0 6px 20px rgba(235, 97, 0, 0.28);
  animation: apptRescheduleBannerIn 0.15s ease;
}
.v3-reschedule-banner__text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 13px;
  color: #8a4b00;
}
.v3-reschedule-banner__text strong { font-weight: 700; }
.v3-reschedule-banner__text span { font-size: 11px; color: #b06a2a; }
.v3-reschedule-banner__close {
  flex: 0 0 auto;
  width: 22px;
  height: 22px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: #8a4b00;
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
}
.v3-reschedule-banner__close:hover { background: rgba(235, 97, 0, 0.12); }
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
  /* 높이는 SchedulerHeader 내용(날짜+의사 2행 / 의사1명 1행)에 따라 가변 */
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
/* 의사 0명(fallback) 헤더의 공휴일명 — 빨강 강조 */
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
/* 의사축(의사행) 페이징 <> 노출. 날짜축 <>(날짜행)는 미사용 → 숨김(본문 좌우 page-nav 가 날짜 담당). */
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
