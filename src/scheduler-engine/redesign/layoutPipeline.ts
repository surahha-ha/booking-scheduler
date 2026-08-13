/**
 * V2 스케줄러 엔진 코어 재설계 — 상위 파이프라인 (격리 모듈, 라이브 보드 미배선)
 *
 * 설계 기준: src/scheduler-engine/REDESIGN.md §4 (파생 파이프라인), §8 (시그니처)
 * 저수준 순수함수(computeBudget/maxConcurrent/arrangeCards/packPages/buildPageColumns)는
 * layoutCore.ts 에서 가져와 조합한다.
 *
 * 본 MR 범위: #7 deriveLayoutConfig, #8 buildUnitSequence.
 * (#9 computeOperatingRange, #10 computeBandHeights, #11 computeRects 는 후속 증분)
 */

import type {
  ArrangeResult,
  CardInput,
  Page,
  PageColumn,
} from './layoutCore'
import { arrangeCards, buildPageColumns, computeBudget, maxConcurrent, packPages } from './layoutCore'
import type {
  BandInfo,
  BandSpec,
  CellDuration,
  DoctorInput,
  EnvInput,
  FilterInput,
  LayoutConfig,
  LayoutMode,
  SiteInput,
  OperatingRange,
  Rect,
  RowHeightLevel,
  ReservationSettingsInput,
  SessionRange,
  Unit,
  UnitHours,
  ViewStateInput,
} from './layoutTypes'

// ════════════════════════════════════════════════════════════
// 상수 (프로토 매직넘버 정리 — REDESIGN §10-C)
// ════════════════════════════════════════════════════════════

const VALID_CELL_DURATIONS: readonly number[] = [10, 15, 20, 30, 45, 60]
const DEFAULT_CELL_DURATION: CellDuration = 30
const TOTAL_COLUMNS_MIN = 6
const TOTAL_COLUMNS_MAX = 10
const DEFAULT_TOTAL_COLUMNS = 8
const VIEW_STEP_MIN = 1
const VIEW_STEP_MAX = 5
const DEFAULT_VIEW_STEP = 3
const ROW_HEIGHT_MIN = 1
const ROW_HEIGHT_MAX = 5
const DEFAULT_ROW_HEIGHT: RowHeightLevel = 3
/** 예약 모드 forward unit 생성 지평 (일). 단일 화면이 소비할 만큼만 packPages 가 슬라이스. */
export const HORIZON_DAYS = 90

// ════════════════════════════════════════════════════════════
// 내부 유틸 — 경계검증 (loud-but-defensive: throw 아님, clamp + warn)
// ════════════════════════════════════════════════════════════

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback
  if (n < min) return min
  if (n > max) return max
  return n
}

// ════════════════════════════════════════════════════════════
// 내부 유틸 — 날짜 (YYYY-MM-DD, 로컬 자정 기준. 타임존 시프트 회피)
// ════════════════════════════════════════════════════════════

/** 'YYYY-MM-DD' → {y,m,d}. 형식 불량 시 null. */
function parseYmd(s: string): { y: number, m: number, d: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (!match) return null
  return { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) }
}

/** 'YYYY-MM-DD' 의 요일 0(일)~6(토). 형식 불량 시 0. */
export function weekdayOf(dateStr: string): number {
  const p = parseYmd(dateStr)
  if (!p) return 0
  // 로컬 날짜 구성 (UTC 파싱 시프트 회피)
  return new Date(p.y, p.m - 1, p.d).getDay()
}

/** 'YYYY-MM-DD' + n일 → 'YYYY-MM-DD'. */
export function addDays(dateStr: string, n: number): string {
  const p = parseYmd(dateStr)
  if (!p) return dateStr
  const dt = new Date(p.y, p.m - 1, p.d + n)
  const y = dt.getFullYear()
  const m = String(dt.getMonth() + 1).padStart(2, '0')
  const d = String(dt.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

// ════════════════════════════════════════════════════════════
// 7. deriveLayoutConfig — 단일 진입점, 경계검증 (REDESIGN §2, §8)
//    모든 입력을 정해진 순서로 top-down 1회 정규화. 하위는 여기서만 읽음.
// ════════════════════════════════════════════════════════════

export function deriveLayoutConfig(
  settings: ReservationSettingsInput,
  site: SiteInput,
  viewState: ViewStateInput,
  filter: FilterInput,
  env: EnvInput,
): LayoutConfig {
  const warnings: string[] = []

  // ── cellDuration(strict): loose slotUnitMinutes 정규화. 카테고리값, 불량 시 기본값(30) ──
  const rawCell = settings.cellDuration ?? settings.slotUnitMinutes
  let cellDuration: CellDuration = DEFAULT_CELL_DURATION
  if (typeof rawCell === 'number' && VALID_CELL_DURATIONS.includes(rawCell)) {
    cellDuration = rawCell as CellDuration
  } else if (rawCell !== undefined) {
    warnings.push(`cellDuration ${String(rawCell)} 은(는) 허용값(10/15/20/30/45/60) 아님 → ${DEFAULT_CELL_DURATION} 적용`)
  }

  // ── totalColumns(strict): loose totalColumnCount 정규화. [6,10] clamp ──
  const rawTotal = settings.totalColumnCount
  const totalColumns = clampInt(rawTotal, TOTAL_COLUMNS_MIN, TOTAL_COLUMNS_MAX, DEFAULT_TOTAL_COLUMNS)
  if (typeof rawTotal === 'number' && (rawTotal < TOTAL_COLUMNS_MIN || rawTotal > TOTAL_COLUMNS_MAX)) {
    warnings.push(`totalColumns ${rawTotal} → [${TOTAL_COLUMNS_MIN},${TOTAL_COLUMNS_MAX}] clamp = ${totalColumns}`)
  }

  // ── viewStep: [1,5] clamp ──
  const viewStep = clampInt(viewState.viewStep, VIEW_STEP_MIN, VIEW_STEP_MAX, DEFAULT_VIEW_STEP)
  if (typeof viewState.viewStep === 'number' && (viewState.viewStep < VIEW_STEP_MIN || viewState.viewStep > VIEW_STEP_MAX)) {
    warnings.push(`viewStep ${viewState.viewStep} → [${VIEW_STEP_MIN},${VIEW_STEP_MAX}] clamp = ${viewStep}`)
  }

  // ── rowHeightLevel(strict): loose cardHeightLevel 정규화. BE 영속 field. 미존재/불량 시 기본값(3) ──
  const rowHeightLevel = clampInt(settings.cardHeightLevel, ROW_HEIGHT_MIN, ROW_HEIGHT_MAX, DEFAULT_ROW_HEIGHT) as RowHeightLevel

  // ── slotDivision / doctorPageIdx / slotOffset ──
  const slotDivision = Math.max(1, clampInt(viewState.slotDivision, 1, Number.MAX_SAFE_INTEGER, 1))
  const doctorPageIdx = Math.max(0, clampInt(viewState.doctorPageIdx, 0, Number.MAX_SAFE_INTEGER, 0))
  // slotOffset 은 전달 시에만 신 모델 활성(>=0 clamp). 미전달=undefined → 구 doctorPageIdx 경로.
  const slotOffset = viewState.slotOffset == null
    ? undefined
    : Math.max(0, clampInt(viewState.slotOffset, 0, Number.MAX_SAFE_INTEGER, 0))
  // 시간축 수동 확장(시간) — [0,24] clamp, 기본 0.
  const timelineTopExtendHours = clampInt(viewState.timelineTopExtendHours, 0, 24, 0)
  const timelineBottomExtendHours = clampInt(viewState.timelineBottomExtendHours, 0, 24, 0)
  // 칸수배정 모델 — 'B2' 명시 시에만 신 모델, 그 외 전부 'A'(기존 동작 보존).
  const layoutMode: LayoutMode = viewState.layoutMode === 'B2' ? 'B2' : 'A'

  // ── displayInfo: NAME 선두 보장 ──
  const displayInfo = normalizeDisplayInfo(settings.displayInfo)

  // ── budget 파생 ──
  const budget = computeBudget(totalColumns, viewStep)

  // ── selectedDate 형식 검증 (불량 시 그대로 두되 경고) ──
  if (!parseYmd(viewState.selectedDate)) {
    warnings.push(`selectedDate '${viewState.selectedDate}' 형식 불량(YYYY-MM-DD)`)
  }

  return {
    cellDuration,
    totalColumns,
    displayInfo,
    rowHeightLevel,
    budget,
    hoursByDoctor: site.hoursByDoctor ?? {},
    hoursByWeekday: site.hoursByWeekday ?? {},
    dateHours: site.dateHours ?? {},
    holidayHours: site.holidayHours ?? {},
    holidayDates: site.holidayDates ?? [],
    closed: {
      offRules: site.closed?.offRules ?? [],
      dateOverrides: site.closed?.dateOverrides ?? [],
      holidays: site.closed?.holidays ?? [],
    },
    dataType: viewState.dataType,
    selectedDate: viewState.selectedDate,
    viewStep,
    slotDivision,
    customSlots: viewState.customSlots ?? {},
    doctorPageIdx,
    slotOffset,
    timelineTopExtendHours,
    timelineBottomExtendHours,
    layoutMode,
    selectedDoctorIds: filter.selectedDoctorIds ?? [],
    availableWidth: env.availableWidth,
    warnings,
  }
}

/** displayInfo 정규화: 비어있으면 ['NAME'], 아니면 입력 순서(BE 영속 = 사용자 지정 표시 순서)
 *  보존 + NAME 선두 보장(중복 제거). BE 가 DISP_ITEM_ORD 로 순서를 영속하므로 응답 순서를 그대로 따른다. */
function normalizeDisplayInfo(raw: string[] | undefined): string[] {
  if (!raw || raw.length === 0) return ['NAME']
  const out: string[] = ['NAME'] // NAME 항상 선두 고정
  const seen = new Set(out)
  for (const code of raw) {
    if (!seen.has(code)) {
      seen.add(code)
      out.push(code)
    }
  }
  return out
}

// ════════════════════════════════════════════════════════════
// 8. buildUnitSequence — (날짜,의사) 시퀀스 + slots (REDESIGN §4 단계 3, §8)
//    slots = customSlots[key] ?? max(1, min(maxConcurrent(unitAppts), slotDivision))
//    진료(TREATMENT)=selectedDate 1일, 예약(APPOINTMENT)=forward HORIZON_DAYS.
//    날짜-major 순서: (d0,docA),(d0,docB),...,(d1,docA),...
// ════════════════════════════════════════════════════════════

export function buildUnitSequence(
  cfg: LayoutConfig,
  doctors: DoctorInput[],
  apptsByUnitKey: Record<string, CardInput[]>,
  opts?: { horizonDays?: number },
): Unit[] {
  // 의사 필터 ([] = 전체). 입력 순서 보존.
  const filterSet = new Set(cfg.selectedDoctorIds)
  const activeDoctors = filterSet.size === 0
    ? doctors
    : doctors.filter(d => filterSet.has(d.id))

  // 날짜 지평: 진료=1일, 예약=forward horizon
  const horizon = cfg.dataType === 'TREATMENT'
    ? 1
    : Math.max(1, opts?.horizonDays ?? HORIZON_DAYS)

  const units: Unit[] = []
  for (let dayOffset = 0; dayOffset < horizon; dayOffset++) {
    const date = dayOffset === 0 ? cfg.selectedDate : addDays(cfg.selectedDate, dayOffset)
    const weekday = weekdayOf(date)
    for (const doc of activeDoctors) {
      const key = `${date}__${doc.id}`
      const slots = resolveSlots(cfg, key, apptsByUnitKey[key])
      units.push({ key, date, doctorId: doc.id, doctorName: doc.name, weekday, slots })
    }
  }
  return units
}

/**
 * unit 칸수(레인폭): customSlots override 최우선.
 * - 모델 A(기본): max(1, min(maxConcurrent, N)) — 동시예약 수만큼(빈=1).
 * - 모델 B2     : max(1, N) 고정 — 데이터 무관(빈 의사도 N). 밀림 0·균등 컬럼.
 *   (B2 의 "혼자=풀폭/겹침만 분할" 은 computeRects 의 카드폭 단계에서 처리.)
 */
function resolveSlots(cfg: LayoutConfig, key: string, appts: CardInput[] | undefined): number {
  const override = cfg.customSlots[key]
  if (typeof override === 'number' && Number.isFinite(override)) {
    return Math.max(1, Math.round(override))
  }
  if (cfg.layoutMode === 'B2') {
    return Math.max(1, cfg.slotDivision)
  }
  const concurrent = appts && appts.length > 0 ? maxConcurrent(appts) : 0
  return Math.max(1, Math.min(concurrent, cfg.slotDivision))
}

// ════════════════════════════════════════════════════════════
// 9. computeOperatingRange — 보이는 unit 운영시간 union → bands (REDESIGN §4 단계 6~7, §8)
//    union(세션) 의 [gridStart,gridEnd] 를 cellDuration 으로 슬라이스.
//    운영 세션이 덮지 않는 내부 구간 = 휴게 band(점심/저녁 라벨). 휴게는 #10 에서 축소.
//    params: units = 현재 페이지 컬럼들의 Unit[] (columns[i] → units[i])
// ════════════════════════════════════════════════════════════

/**
 * unit 의 운영시간: 의사별·요일별 우선, 없으면 요일별 기관공통 fallback, 둘 다 없으면 빈.
 *
 * 공휴일 진료일(holidayDates)에도 **담당자 설정이 먼저다** — 그 의사가 그 요일을 정해 뒀으면
 * (진료든 휴무가든) 그 값을 쓰고, **미설정일 때만** 사업장 공휴일 운영시간을 쓴다.
 * 다만 **휴게는 운영시간과 갈린다** — 휴게는 사업장만 소유하므로, 담당자 운영시간을 쓰는
 * 경우에도 휴게는 그 날짜의 기관 값(= 공휴일 휴게)으로 간다.
 * 예약검증(useSchedulerRules.pickDailySchedule)과 같은 규칙이어야 "밴드는 열렸는데 클릭하면
 * 운영종료"가 나지 않는다.
 *
 * 기관 공휴일 시간도 미설정(세션 0)이면 요일 축으로 폴백한다: 밴드는 "표시 범위"라 비워 두면
 * 그날만 시간축이 기본값(09~18)으로 튄다. 그 날 예약이 열려 있는지는 useSchedulerRules 가
 * 따로 판정하며, **미설정이면 그날은 종일진료**라 전 셀이 열린다 — 진료하기로 한 의도를
 * 시간 미입력이 뒤집지 않는다. 밴드가 요일 축을 그대로 쓰는 것이 그 판정과도 맞는다.
 */
export function resolveUnitHours(cfg: LayoutConfig, unit: Unit): UnitHours {
  // 정한 요일이면 휴무(빈 UnitHours)도 값이다 — 있으면 그대로 쓴다.
  const doctorHours = cfg.hoursByDoctor[unit.doctorId]?.[unit.weekday]

  /* 그 날짜에 저장된 운영시간(지정일자)이 있으면 요일·공휴일보다 먼저 쓴다 —
   * 예약검증(useSchedulerRules 의 dateDaily)과 같은 규칙이어야 "밴드는 열렸는데 클릭하면 운영종료"가 없다.
   * 담당자가 그 요일을 정해 뒀으면 담당자가 먼저고, 휴게만 그 날짜 기관 값으로 간다(공휴일과 같은 규약). */
  const dateHours = cfg.dateHours?.[unit.date]
  if (dateHours) {
    return doctorHours && hasSession(doctorHours)
      ? {...doctorHours, lunch: dateHours.lunch, dinner: dateHours.dinner}
      : dateHours
  }
  if (cfg.holidayDates.includes(unit.date)) {
    const h = cfg.holidayHours
    const holidaySet = !!(h.morning || h.afternoon || h.night)
    if (doctorHours) {
      /* 진료 시작·종료는 담당자 값이지만 **휴게는 그 날짜의 기관 값**을 쓴다 — 휴게는 사업장만
       * 소유하고, doctorHours 에 실려 오는 휴게는 어댑터가 병합한 **요일별** 휴게이기 때문이다
       * (weekRowsToWeekdayHours). 공휴일 휴게를 따로 정했는데 평일 휴게가 쓰이면 그 설정이 죽는다.
       * 휴무(세션 없음)인 담당자에는 얹지 않는다 — 쉬는 날에 휴게 band 가 생긴다. */
      return holidaySet && hasSession(doctorHours)
        ? {...doctorHours, lunch: h.lunch, dinner: h.dinner}
        : doctorHours
    }
    if (holidaySet) return h
  }
  return doctorHours ?? cfg.hoursByWeekday[unit.weekday] ?? {}
}

function hasSession(h: UnitHours): boolean {
  return !!(h.morning || h.afternoon || h.night)
}

// 병원 표준 운영시간 09:00~18:00. 두 곳에 쓰인다.
//  ① 운영시간 미설정(별도 테이블 데이터 없음) 시 기본 운영시간
//     — V2(scheduler/ operatingRange) 의 'weekly 없으면 09~18 fallback' 과 동일. 이때는 운영 band 다.
//  ② 시간축 최소 창 — 운영시간이 이보다 좁아도 timeline 첫 판은 항상 09~18 을 덮는다(아래 rawStart/rawEnd).
const DEFAULT_OPERATING_START_MIN = 540 // 09:00
const DEFAULT_OPERATING_END_MIN = 1080 // 18:00

/** [a,b) 구간 리스트 병합 (정렬 후 인접/겹침 합침). */
function mergeRanges(ranges: SessionRange[]): SessionRange[] {
  const valid = ranges.filter(r => r.end > r.start).slice().sort((x, y) => x.start - y.start)
  const out: SessionRange[] = []
  for (const r of valid) {
    const last = out[out.length - 1]
    if (last && r.start <= last.end) {
      last.end = Math.max(last.end, r.end)
    } else {
      out.push({ start: r.start, end: r.end })
    }
  }
  return out
}

/** [a,b) 가 구간 리스트 중 하나라도 겹치면 true. */
function overlapsAny(start: number, end: number, ranges: SessionRange[]): boolean {
  return ranges.some(r => r.start < end && r.end > start)
}

/**
 * @param apptEnvelope 표시 컬럼 전체 예약의 시간 envelope(0:00 기준 분). 운영시간 밖 예약을
 *   timeline 에 포함시켜 확장한다(REDESIGN: 모든 예약 항상 렌더링). 미전달 시 운영시간만(하위호환).
 *   확장 구간(운영시간 밖)은 자연히 비운영 band(isBreak=true) 로 음영처리된다.
 */
export function computeOperatingRange(
  cfg: LayoutConfig,
  units: Unit[],
  apptEnvelope?: { min: number, max: number } | null,
): OperatingRange {
  const cd = cfg.cellDuration
  const sessions: SessionRange[] = []
  const breakRanges: { range: SessionRange, label: string }[] = []

  for (const unit of units) {
    const h = resolveUnitHours(cfg, unit)
    for (const s of [h.morning, h.afternoon, h.night]) {
      if (s && s.end > s.start) sessions.push({ start: s.start, end: s.end })
    }
    if (h.lunch && h.lunch.end > h.lunch.start) breakRanges.push({ range: { ...h.lunch }, label: '휴게시간1' })
    if (h.dinner && h.dinner.end > h.dinner.start) breakRanges.push({ range: { ...h.dinner }, label: '휴게시간2' })
  }

  let mergedSessions = mergeRanges(sessions)
  // 운영시간 미설정(세션 0) → 09:00~18:00 기본 band. 예약이 그 밖이면 envelope 으로 확장.
  // empty 화면(band 0) 방지 — 설정 안 한 거래처도 기본 시간축 표시.
  if (mergedSessions.length === 0) {
    mergedSessions = [{ start: DEFAULT_OPERATING_START_MIN, end: DEFAULT_OPERATING_END_MIN }]
  }
  const hasEnv = !!apptEnvelope && apptEnvelope.max > apptEnvelope.min

  const sessionStart = mergedSessions.length ? mergedSessions[0].start : Infinity
  const sessionEnd = mergedSessions.length ? mergedSessions[mergedSessions.length - 1].end : -Infinity
  // 운영시간 ∪ 예약 envelope ∪ 최소 창(09~18) → 셋 중 가장 넓은 범위가 시간축이 된다.
  // 최소 창을 까는 이유 = 운영시간이 좁으면(예: 11:00~15:00) timeline 높이가 뷰포트보다 작아져
  // 스크롤바 유무가 매 프레임 뒤집히며 화면이 떨린다(큰 화면일수록 잘 재현). 09~18 을 항상 덮어 그 조건을 없앤다.
  // 운영시간 밖으로 넓힌 구간은 예약 envelope 확장과 똑같이 비운영 band(isBreak=true) 로 음영처리된다.
  const rawStart = Math.min(sessionStart, hasEnv ? apptEnvelope!.min : Infinity, DEFAULT_OPERATING_START_MIN)
  const rawEnd = Math.max(sessionEnd, hasEnv ? apptEnvelope!.max : -Infinity, DEFAULT_OPERATING_END_MIN)
  // 시간축 수동 확장(^v ±1h): 시작 일찍/종료 늦게. raw 에 적용 후 cd 스냅(그리드 정합 유지) + [0,1440] clamp.
  const topExt = (cfg.timelineTopExtendHours ?? 0) * 60
  const botExt = (cfg.timelineBottomExtendHours ?? 0) * 60
  // cellDuration 그리드 스냅 (drag/snap 정합)
  const gridStart = Math.max(0, Math.floor((rawStart - topExt) / cd) * cd)
  const gridEnd = Math.min(1440, Math.ceil((rawEnd + botExt) / cd) * cd)

  const bands: BandSpec[] = []
  let index = 0
  for (let t = gridStart; t < gridEnd; t += cd) {
    const bandEnd = Math.min(t + cd, gridEnd)
    const isOperating = overlapsAny(t, bandEnd, mergedSessions)
    let breakLabel: string | undefined
    if (!isOperating) {
      const hit = breakRanges.find(b => b.range.start < bandEnd && b.range.end > t)
      breakLabel = hit?.label
    }
    bands.push({ index, startMin: t, endMin: bandEnd, isBreak: !isOperating, breakLabel })
    index++
  }

  // breaks = 실제 휴게 band(비운영) 의 병합 구간. bands.isBreak 와 일관.
  const effectiveBreaks = mergeRanges(
    bands.filter(b => b.isBreak).map(b => ({ start: b.startMin, end: b.endMin })),
  )

  return {
    bands,
    startMin: gridStart,
    endMin: gridEnd,
    breaks: effectiveBreaks,
  }
}

// ════════════════════════════════════════════════════════════
// 10. computeBandHeights — band 별 높이/topPx (REDESIGN §4 단계 9, §8)
//     컬럼별 "band 에서 시작하는 행 수"(같은 startMin = side-by-side 1행, expandedRows 깊이 반영)
//     → 전 컬럼 max = maxRows. 휴게 band 는 축소 높이.
//     arrangeCards 결과가 startMin 을 안 들고 있어 cards 를 함께 받는다(골든 불변).
// ════════════════════════════════════════════════════════════

/**
 * rowHeightLevel(1~5) → 카드 1개(예약 1건)의 전체 px 높이 (50/65/80/95/110).
 * 설정 미리보기(SchedulerSettingsReservationSetting)와 동일 값 — 미리보기가 rowHeightPx 를 import 하는 단일 소스.
 * 카드 내용(이름 + 정보 다줄)은 이 높이 안에 overflow:hidden 으로 클립. level↑ = 더 많은 줄 노출.
 * ⚠️ 구버전 level1=26(이름만) 은 카드 다줄(이름+정보)을 못 담아 겹쳤음 → 미리보기 기준 px 로 재정의.
 */
const ROW_HEIGHT_BY_LEVEL: Record<RowHeightLevel, number> = { 1: 50, 2: 65, 3: 80, 4: 95, 5: 110 }
/** 휴게 band 축소 높이 = 한 행의 60%. */
const BREAK_BAND_RATIO = 0.6

export interface PerUnitCards {
  cards: CardInput[]
  expandedRows: ArrangeResult['expandedRows']
}

/** 한 컬럼에서 band 에 '시작하는' 카드의 행 수(같은 startMin 그룹은 expandedRows 깊이). */
function rowsStartingInBand(pu: PerUnitCards, band: BandSpec): number {
  const startsInBand = new Set<number>()
  for (const c of pu.cards) {
    if (c.startMin >= band.startMin && c.startMin < band.endMin) startsInBand.add(c.startMin)
  }
  let rows = 0
  for (const sm of startsInBand) rows += pu.expandedRows[sm] || 1
  return rows
}

export function computeBandHeights(
  perUnit: PerUnitCards[],
  bands: BandSpec[],
  rowHeightLevel: RowHeightLevel,
): BandInfo[] {
  const rowHeight = ROW_HEIGHT_BY_LEVEL[rowHeightLevel] ?? ROW_HEIGHT_BY_LEVEL[3]
  const breakHeight = Math.round(rowHeight * BREAK_BAND_RATIO)

  const out: BandInfo[] = []
  let topPx = 0
  for (const band of bands) {
    let maxRows = 0
    for (const pu of perUnit) {
      const r = rowsStartingInBand(pu, band)
      if (r > maxRows) maxRows = r
    }
    // 축소(60%)는 예약 없는 '점심/저녁 휴게'(breakLabel 보유) band 에만 적용.
    // 운영종료후/시작전 비운영(label 없음)은 운영 empty 와 동일 풀높이 → timeline 높이 균일.
    // 예약이 걸친(시작/관통) band 는 휴게라도 축소 안 함(운영시간 밖 예약 카드 넘침 방지).
    const hasActivity = perUnit.some(pu =>
      pu.cards.some(c => c.startMin < band.endMin && c.endMin > band.startMin),
    )
    let heightPx: number
    if (band.isBreak && band.breakLabel && !hasActivity) {
      heightPx = breakHeight
    } else {
      // 예약 있는 band 는 +1행(하단 빈 영역 = 추가 가능). 빈 운영 band 는 1행.
      const rowsWithExtra = maxRows > 0 ? maxRows + 1 : 1
      heightPx = rowsWithExtra * rowHeight
    }
    out.push({ ...band, maxRows, heightPx, topPx })
    topPx += heightPx
  }
  return out
}

/** rowHeightLevel(1~5) → 카드 한 행 px. (computeRects 와 공유) */
export function rowHeightPx(level: RowHeightLevel): number {
  return ROW_HEIGHT_BY_LEVEL[level] ?? ROW_HEIGHT_BY_LEVEL[3]
}

// ════════════════════════════════════════════════════════════
// 11. computeRects — 카드 좌표/z 계산 (REDESIGN §4 단계 10, §5, §6, §8)
//     floating: width −10px, z=10. base: z=0(DOM 순서). 이동/하이라이트=15(후속 인터랙션).
//     localRow: 컬럼 내 카드를 '시작 band' 별로 묶어 startMin 블록 배치(블록=expandedRows 깊이).
// ════════════════════════════════════════════════════════════

const INDENT_PX = 12
/** floating layering(level>0, 긴 예약 위 얹힌 짧은 예약) 고정 들여쓰기 — 누적 계단 아님(겹침 깊이 무관 일정). */
const FLOAT_INDENT_PX = 10
const CARD_RIGHT_GAP = 4
/** 모든 카드 오른쪽에 확보하는 '추가 strip' 비율(레인폭 대비) — strip hover 시 그리드 +추가 노출. */
const CARD_ADD_STRIP_RATIO = 0.03
const Z_BASE = 0
const Z_FLOAT = 10
const MIN_CARD_WIDTH = 1

/** computeRects 컬럼 입력 — 페이지 픽셀 레이아웃(leftPx/widthPx)은 호출측 책임.
 *  cards/arrange 는 이미 페이지 sub-col 범위로 슬라이스된 것(runLayout 책임). */
export interface RectColumn {
  columnIndex: number
  leftPx: number
  widthPx: number
  /** 이 컬럼(페이지 조각)이 담는 sub-col 수 = subColWidth 분모 */
  subColCount: number
  /** unit 내 시작 sub-col (carry-over; 카드 column → 페이지-로컬 좌표 변환용) */
  subColStart: number
  cards: CardInput[]
  arrange: ArrangeResult
}

/** minute 를 포함하는 band index. 범위 밖이면 양끝으로 clamp. */
function bandIndexOfMinute(bands: BandInfo[], minute: number): number {
  if (bands.length === 0) return -1
  if (minute < bands[0].startMin) return 0
  for (const b of bands) {
    if (minute >= b.startMin && minute < b.endMin) return b.index
  }
  return bands[bands.length - 1].index
}

/** 한 컬럼의 카드별 localRow 산출: 시작 band 그룹 → startMin 블록(깊이=expandedRows) 누적. */
function buildLocalRows(
  col: RectColumn,
  bands: BandInfo[],
  startBandOf: Map<string, number>,
  subRowOf: Map<string, number>,
): Map<string, number> {
  // band index → 그 band 에서 시작하는 카드들
  const byBand = new Map<number, CardInput[]>()
  for (const c of col.cards) {
    const bi = startBandOf.get(c.id)
    if (bi === undefined) continue
    if (!byBand.has(bi)) byBand.set(bi, [])
    byBand.get(bi)!.push(c)
  }

  const localRow = new Map<string, number>()
  for (const cards of byBand.values()) {
    // distinct startMin 오름차순
    const distinct = Array.from(new Set(cards.map(c => c.startMin))).sort((a, b) => a - b)
    const blockStart = new Map<number, number>()
    let cum = 0
    for (const sm of distinct) {
      blockStart.set(sm, cum)
      cum += col.arrange.expandedRows[sm] || 1
    }
    for (const c of cards) {
      localRow.set(c.id, (blockStart.get(c.startMin) || 0) + (subRowOf.get(c.id) || 0))
    }
  }
  return localRow
}

export function computeRects(
  columns: RectColumn[],
  bandInfos: BandInfo[],
  rowHeightLevel: RowHeightLevel,
): Rect[] {
  const rowHeight = rowHeightPx(rowHeightLevel)
  const rects: Rect[] = []

  for (const col of columns) {
    const subColWidth = col.subColCount > 0 ? col.widthPx / col.subColCount : col.widthPx
    const cardById = new Map(col.cards.map(c => [c.id, c]))

    // arrange placed/floating → 배치 메타(column/subRow/level/isFloating)
    const meta = new Map<string, { column: number, subRow: number, level: number, isFloating: boolean }>()
    for (const p of col.arrange.placed) {
      meta.set(p.id, { column: p.column, subRow: p.subRow, level: p.level, isFloating: false })
    }
    for (const f of col.arrange.floating) {
      meta.set(f.id, { column: f.column, subRow: f.subRow, level: f.floatLevel, isFloating: true })
    }

    // startBand / subRow 맵 (localRow 산출용)
    const startBandOf = new Map<string, number>()
    const subRowOf = new Map<string, number>()
    for (const [id, m] of meta) {
      const card = cardById.get(id)
      if (!card) continue
      startBandOf.set(id, bandIndexOfMinute(bandInfos, card.startMin))
      subRowOf.set(id, m.subRow)
    }
    const localRows = buildLocalRows(col, bandInfos, startBandOf, subRowOf)

    for (const [id, m] of meta) {
      const card = cardById.get(id)
      if (!card) continue
      const startIdx = bandIndexOfMinute(bandInfos, card.startMin)
      const endIdx = bandIndexOfMinute(bandInfos, Math.max(card.startMin, card.endMin - 1))
      const startBand = bandInfos[startIdx]
      const endBand = bandInfos[endIdx]
      if (!startBand || !endBand) continue

      const localRow = localRows.get(id) || 0
      const top = startBand.topPx + localRow * rowHeight
      let height: number
      if (startIdx === endIdx) {
        height = rowHeight
      } else {
        // 관통(multi-band) 카드 height 정밀화: endBand 에서 시작하는 동일 sub-col 카드가 있으면
        //   늘어난 꼬리가 그 카드의 첫 행을 침범(가림)하므로 endBand 진입 직전까지만 그린다.
        //   (비정렬 시각 예약이 band 경계를 걸칠 때의 z-order 가림 방지. 충돌 없으면 endBand 한 행까지 — 기존 동작.)
        const endBandHasSameLaneStarter = col.cards.some((c) => {
          if (c.id === id) return false
          const cm = meta.get(c.id)
          if (!cm || cm.column !== m.column) return false
          return bandIndexOfMinute(bandInfos, c.startMin) === endIdx
        })
        height = endBandHasSameLaneStarter
          ? Math.max(rowHeight, endBand.topPx - top)
          : Math.max(rowHeight, endBand.topPx + rowHeight - top)
      }

      // 카드 column(0~unitSlots-1) → 페이지-로컬 위치(carry-over: subColStart 차감)
      const lanePos = col.leftPx + (m.column - col.subColStart) * subColWidth
      // layering = floating 이면서 '시간이 겹치는 더 긴(duration 큰) 같은 sub-col 예약' 위에 얹힌 경우만.
      //   더 일찍 시작했을 뿐 같은/짧은 길이 예약 위 얹힘은 layering 아님(사용자 결정: 긴 예약 위에만 들여쓰기·그림자).
      const isLayered = m.isFloating && col.cards.some((c) => {
        if (c.id === id) return false
        const cm = meta.get(c.id)
        if (!cm || cm.column !== m.column) return false
        const overlaps = c.startMin < card.endMin && c.endMin > card.startMin
        const longer = (c.endMin - c.startMin) > (card.endMin - card.startMin)
        return overlaps && longer
      })
      let left: number
      let width: number
      if (m.isFloating) {
        // layering 만 고정 들여쓰기로 '긴 예약 위 얹힘' 표현(누적 계단 아님). 상한 가드로 좁은 칸 방어.
        const indent = isLayered ? Math.min(FLOAT_INDENT_PX, subColWidth * 0.5) : 0
        left = lanePos + indent
        width = subColWidth - indent - CARD_RIGHT_GAP
      } else {
        // base: level 계단 들여쓰기(보통 0). 자기 레인 폭.
        const indent = Math.min(m.level * INDENT_PX, subColWidth * 0.5)
        left = lanePos + indent
        width = subColWidth - indent - CARD_RIGHT_GAP
      }
      // 모든 카드 오른쪽에 일관된 '추가 strip' 확보 → 그 자리 hover 시 그리드 +추가(점유 시간대 추가, N=1 포함).
      width -= subColWidth * CARD_ADD_STRIP_RATIO
      width = Math.max(MIN_CARD_WIDTH, width)

      rects.push({
        id,
        columnIndex: col.columnIndex,
        top,
        left,
        width,
        height,
        z: m.isFloating ? Z_FLOAT : Z_BASE,
        isFloating: m.isFloating,
        isLayered,
      })
    }
  }

  return rects
}

// ════════════════════════════════════════════════════════════
// 컬럼 픽셀 레이아웃 — PageColumn → leftPx/widthPx (REDESIGN §하단 가로=페이징)
//   예약(stretch=false): denom=budget 고정 — 원래 칸 비율 유지. 우측 잔여는 다음 페이지(forward)로 채움.
//   진료(stretch=true) : denom=Σsubcol — 조회 끝(오늘)이라 forward 확장 불가 → 컬럼을 화면 폭 가득 펴서 empty 제거.
// ════════════════════════════════════════════════════════════

export interface ColumnPixels {
  leftPx: number
  widthPx: number
}

export function computeColumnPixels(
  pageColumns: PageColumn[],
  budget: number,
  availableWidth: number,
  stretch = false,
): ColumnPixels[] {
  // 예약: denom=budget 고정(펴짐 없음). 잔여 칸 우측은 다음 unit/페이지가 이어짐.
  // 진료: denom=Σsubcol → full width 펴짐(empty 영역 없음). 풀 페이지는 Σ=budget 이라 동일(무변화).
  const filled = pageColumns.reduce((s, c) => s + c.subColCount, 0)
  const denom = stretch && filled > 0 ? filled : Math.max(1, budget)
  return pageColumns.map(c => ({
    leftPx: (c.slotsStartIdx / denom) * availableWidth,
    widthPx: (c.subColCount / denom) * availableWidth,
  }))
}

// ════════════════════════════════════════════════════════════
// runLayout — 엔진 end-to-end 합성 (순수, 라이브 미배선)
//   MR-3 배선의 단일 진입점. REDESIGN §4 파이프라인 1~10 전체.
// ════════════════════════════════════════════════════════════

export interface RunLayoutInput {
  settings: ReservationSettingsInput
  site: SiteInput
  viewState: ViewStateInput
  filter: FilterInput
  env: EnvInput
  doctors: DoctorInput[]
  /** unit.key → 그 unit 의 카드들 */
  apptsByUnitKey: Record<string, CardInput[]>
  /** 테스트/조회윈도우 제어 (옵션) */
  horizonDays?: number
}

/** runLayout 의 컬럼 — unit + 픽셀 + (페이지 슬라이스된) 배치결과. */
export interface ResolvedColumn extends ColumnPixels {
  columnIndex: number
  unitIndex: number
  unit: Unit
  /** 이 페이지 조각이 담는 sub-col 수 */
  subColCount: number
  /** unit 내 시작 sub-col (carry-over) */
  subColStart: number
  /** unit 전체 sub-col 수 (원래 N) */
  unitSlots: number
  /** 이 페이지에 보이는 카드(column ∈ [subColStart, +subColCount)) */
  cards: CardInput[]
  /** 페이지 sub-col 범위로 슬라이스된 배치 결과 */
  arrange: ArrangeResult
}

export interface RunLayoutResult {
  config: LayoutConfig
  units: Unit[]
  pages: Page[]
  pageIndex: number
  /** 전체 sub-col 수(모든 unit slots 합). 셸 canNext 판정(slotOffset+budget<totalSlots)용. */
  totalSlots: number
  /** 실제 적용된 윈도우 시작 offset(clamp 후). 신 모델=clamp(slotOffset) / 구 모델=page.slotStart. */
  slotOffset: number
  columns: ResolvedColumn[]
  operatingRange: OperatingRange
  bandInfos: BandInfo[]
  rects: Rect[]
}

/**
 * unit 전체 배치(full)에서 페이지 sub-col 범위 [start,end) 에 속한 카드만 슬라이스.
 * expandedRows(같은 시각 스택 깊이 = base 1행 + floating 수)는 페이지에 보이는 카드만으로
 * 재계산한다 → 안 보이는 칸의 스택이 band 높이를 과대 키우는 것 방지(정밀).
 */
function sliceArrangeForPage(
  full: ArrangeResult,
  allCards: CardInput[],
  subColStart: number,
  subColEnd: number,
): { arrange: ArrangeResult, cards: CardInput[] } {
  const inPage = (column: number): boolean => column >= subColStart && column < subColEnd
  const placed = full.placed.filter(p => inPage(p.column))
  const floating = full.floating.filter(f => inPage(f.column))

  const ids = new Set<string>()
  placed.forEach(p => ids.add(p.id))
  floating.forEach(f => ids.add(f.id))
  const cards = allCards.filter(c => ids.has(c.id))

  // expandedRows 재계산 — 페이지 카드의 startMin 별 (base 있으면 1행) + floating 수
  const cardById = new Map(allCards.map(c => [c.id, c]))
  const byStart = new Map<number, { base: number, float: number }>()
  for (const p of placed) {
    const c = cardById.get(p.id)
    if (!c) continue
    const e = byStart.get(c.startMin) ?? { base: 0, float: 0 }
    e.base++
    byStart.set(c.startMin, e)
  }
  for (const f of floating) {
    const c = cardById.get(f.id)
    if (!c) continue
    const e = byStart.get(c.startMin) ?? { base: 0, float: 0 }
    e.float++
    byStart.set(c.startMin, e)
  }
  const expandedRows: Record<number, number> = {}
  for (const [sm, v] of byStart) {
    const depth = (v.base > 0 ? 1 : 0) + v.float
    if (depth > 1) expandedRows[sm] = depth
  }

  return { arrange: { placed, floating, expandedRows }, cards }
}

export function runLayout(input: RunLayoutInput): RunLayoutResult {
  const config = deriveLayoutConfig(input.settings, input.site, input.viewState, input.filter, input.env)
  const units = buildUnitSequence(config, input.doctors, input.apptsByUnitKey, { horizonDays: input.horizonDays })
  const pages = packPages(units, config.budget)
  const totalSlots = units.reduce((s, u) => s + Math.max(1, u.slots), 0)

  // 윈도우 선택 — 신 date-anchored(slotOffset) vs 구 page-index(doctorPageIdx).
  let pageIndex: number
  let slotOffset: number
  let page: Page | undefined
  if (config.slotOffset != null) {
    // 신 모델: 임의 offset 슬라이스. 좌측 끝은 셸이 selectedDate(날짜)로 고정 → 밀도변동 점프 차단.
    // 최소 1컬럼 보장 위해 [0, totalSlots-1] clamp. 끝은 buildPageColumns 가 totalSlots 로 자름.
    slotOffset = Math.min(config.slotOffset, Math.max(0, totalSlots - 1))
    page = totalSlots > 0
      ? { slotStart: slotOffset, slotEnd: Math.min(slotOffset + config.budget, totalSlots) }
      : undefined
    pageIndex = Math.floor(slotOffset / Math.max(1, config.budget)) // 참고용(meta)
  } else {
    // 구 모델: budget 단위 페이지 인덱스 (doctorPageIdx clamp).
    pageIndex = pages.length === 0 ? 0 : Math.min(config.doctorPageIdx, pages.length - 1)
    page = pages[pageIndex]
    slotOffset = page ? page.slotStart : 0
  }

  const pageColumns = page ? buildPageColumns(units, page) : []
  // 진료(TREATMENT)는 조회 끝(오늘)이라 forward 확장 불가 → 컬럼을 full width 로 펴서 empty 제거.
  const pixels = computeColumnPixels(pageColumns, config.budget, config.availableWidth, config.dataType === 'TREATMENT')

  // 컬럼별 unit/카드/배치 — arrange 는 unit 전체를 원래 N(unitSlots)으로 1회, 페이지 조각만 슬라이스
  const columns: ResolvedColumn[] = pageColumns.map((pc, i) => {
    const unit = units[pc.unitIndex]
    const allCards = input.apptsByUnitKey[unit.key] ?? []
    const fullArrange = arrangeCards(allCards, pc.unitSlots)
    const { arrange, cards } = sliceArrangeForPage(
      fullArrange,
      allCards,
      pc.subColStart,
      pc.subColStart + pc.subColCount,
    )
    return {
      columnIndex: i,
      unitIndex: pc.unitIndex,
      unit,
      subColCount: pc.subColCount,
      subColStart: pc.subColStart,
      unitSlots: pc.unitSlots,
      cards,
      arrange,
      leftPx: pixels[i].leftPx,
      widthPx: pixels[i].widthPx,
    }
  })

  // 표시 컬럼 카드(페이지 슬라이스)의 시간 envelope — 운영시간 밖 예약도 timeline 에 포함(확장)
  let apptMin = Infinity
  let apptMax = -Infinity
  for (const col of columns) {
    for (const card of col.cards) {
      if (card.startMin < apptMin) apptMin = card.startMin
      if (card.endMin > apptMax) apptMax = card.endMin
    }
  }
  const apptEnvelope = apptMax > apptMin ? { min: apptMin, max: apptMax } : null

  const operatingRange = computeOperatingRange(config, columns.map(c => c.unit), apptEnvelope)
  const bandInfos = computeBandHeights(
    columns.map(c => ({ cards: c.cards, expandedRows: c.arrange.expandedRows })),
    operatingRange.bands,
    config.rowHeightLevel,
  )
  const rects = computeRects(
    columns.map(c => ({
      columnIndex: c.columnIndex,
      leftPx: c.leftPx,
      widthPx: c.widthPx,
      subColCount: c.subColCount,
      subColStart: c.subColStart,
      cards: c.cards,
      arrange: c.arrange,
    })),
    bandInfos,
    config.rowHeightLevel,
  )

  return { config, units, pages, pageIndex, totalSlots, slotOffset, columns, operatingRange, bandInfos, rects }
}
