/**
 * V2 스케줄러 엔진 코어 재설계 — 타입 (격리 모듈, 라이브 보드 미배선)
 *
 * 설계 기준: src/scheduler-engine/REDESIGN.md §2 (입력 계약), §8 (순수함수 시그니처)
 * 원칙: 명세 > 프로토타입. 본 모듈은 어떤 컴포넌트에도 연결되어 있지 않다(안전판).
 *
 * 입력 계약은 store/adapter 형태에 결합하지 않고 엔진-로컬 구조로 정의한다.
 * (store → 이 타입으로의 매핑은 후속 MR-3 배선 단계의 adapter 책임)
 */

// ════════════════════════════════════════════════════════════
// 공통 — 세션/휴게 구간
// ════════════════════════════════════════════════════════════

/** 0:00 기준 분 단위 구간 [start, end) */
export interface SessionRange {
  /** 0:00 기준 분 (예: 09:00 = 540) */
  start: number
  /** 0:00 기준 분 (예: 18:00 = 1080) */
  end: number
}

/** 한 (요일|의사) 의 운영시간 세션 + 휴게 */
export interface UnitHours {
  morning?: SessionRange
  afternoon?: SessionRange
  night?: SessionRange
  /** 점심 휴게 (band 축소) */
  lunch?: SessionRange
  /** 저녁 휴게 (band 축소) */
  dinner?: SessionRange
}

export type DataType = 'APPOINTMENT' | 'TREATMENT'

/**
 * 칸수배정 모델 (프로토타입 비교용 토글).
 * - 'A'(기본): 레인폭 = min(maxConcurrent, N). 동시예약 수만큼 — 화면밀도↑, 겹침변동 시 밀림.
 * - 'B2'    : 레인폭 = N 고정(빈 의사도 N). 혼자=풀폭/겹침만 분할 — 밀림 0·균등컬럼, 페이징 잦음.
 */
export type LayoutMode = 'A' | 'B2'

export type CellDuration = 10 | 15 | 20 | 30 | 45 | 60
export type RowHeightLevel = 1 | 2 | 3 | 4 | 5

// ════════════════════════════════════════════════════════════
// deriveLayoutConfig 입력 (5종) — REDESIGN §8
// ════════════════════════════════════════════════════════════

/** 예약장부 설정 (reservationSettingsApi /book/v2/reservation/settings). 느슨한 입력 — 검증 전. */
export interface ReservationSettingsInput {
  /** reservation 응답의 예약 시간단위(분). 엔진 strict cellDuration 으로 정규화됨. */
  slotUnitMinutes?: number
  /** 대체 명칭 (이미 strict cellDuration 으로 들어오는 경우) */
  cellDuration?: number
  /** 전체 칸 개수. API 는 1~20 허용, 엔진은 [6,10] 로 clamp */
  totalColumnCount?: number
  /** 표시정보 코드 순서 (BE 영속 = 사용자 지정 순서, NAME 고정 선두) */
  displayInfo?: string[]
  /** 카드 높이 1~5 (BE 영속 field, 미포함 시 기본값 3) */
  cardHeightLevel?: number
}

/** 운영일정 설정 (staffStore ← effective-rules + work-hours). */
export interface SiteInput {
  /** 의사별·요일별 운영시간. key = doctorId → weekday(0~6) → UnitHours (TO-BE WorkHours) */
  hoursByDoctor?: Record<string, Record<number, UnitHours>>
  /** 요일별 운영시간. key = 0(일)~6(토). hoursByDoctor 미존재 시 fallback (AS-IS 기관공통) */
  hoursByWeekday?: Record<number, UnitHours>
  /** 공휴일 운영시간(사업장 한 세트, 요일 축 없음). holidayDates 인 날은 요일·의사 시간 대신 이걸 쓴다. */
  holidayHours?: UnitHours
  /** 날짜("YYYY-MM-DD") → 그 날짜에 저장된 사업장 운영시간(지정일자). 요일·공휴일보다 우선한다. */
  dateHours: Record<string, UnitHours>
  /** 공휴일이면서 진료하는 날 "YYYY-MM-DD". 휴무 공휴일은 여기 없다. */
  holidayDates?: string[]
  /** 휴무 규칙 (MR-1 범위 밖 — 구조만 보존) */
  closed?: {
    offRules?: unknown[]
    dateOverrides?: unknown[]
    holidays?: string[]
  }
}

/** 라이브 뷰 상태 (DB 저장 X). */
export interface ViewStateInput {
  dataType: DataType
  /** YYYY-MM-DD */
  selectedDate: string
  /** 보기단계 1~5 */
  viewStep: number
  /** N칸보기 (unit 칸수 cap) */
  slotDivision: number
  /** 칸수조절 드래그 override (state-only). key = unit.key */
  customSlots?: Record<string, number>
  /** 의사컬럼 페이지 인덱스 (구 모델 — 페이지 단위 선택). slotOffset 미전달 시 fallback. */
  doctorPageIdx?: number
  /**
   * 표시 윈도우 시작 sub-column offset (신 date-anchored 모델).
   * 전역 slot 시퀀스(selectedDate 부터 forward)에서 좌측 첫 컬럼이 시작할 sub-col 인덱스.
   * 전달 시 doctorPageIdx 대신 이 값으로 [offset, offset+budget) 슬라이스(임의 offset).
   * 좌측 끝이 "날짜"에 고정되도록 셸이 selectedDate 와 함께 제어 → 밀도변동 점프 차단.
   */
  slotOffset?: number
  /** 시간축 수동 확장 — 시작을 N시간 일찍(^). 기본 0. */
  timelineTopExtendHours?: number
  /** 시간축 수동 확장 — 종료를 N시간 늦게(v). 기본 0. */
  timelineBottomExtendHours?: number
  /** 칸수배정 모델 (프로토타입 토글). 미전달=‘A’(기존). */
  layoutMode?: LayoutMode
}

/** 필터. */
export interface FilterInput {
  /** [] 또는 미존재 = 전체 */
  selectedDoctorIds?: string[]
}

/** 환경. */
export interface EnvInput {
  availableWidth: number
}

/** 의사 목록 (active-doctors). buildUnitSequence 입력. */
export interface DoctorInput {
  id: string
  name: string
}

// ════════════════════════════════════════════════════════════
// LayoutConfig (SSOT) — 정규화/검증 후 단일 불변 객체. REDESIGN §2
// ════════════════════════════════════════════════════════════

export interface LayoutConfig {
  // ── 예약장부 설정 (정규화) ──
  cellDuration: CellDuration
  totalColumns: number // [6,10]
  displayInfo: string[]
  rowHeightLevel: RowHeightLevel
  // ── 파생 ──
  /** 컬럼 예산 = clamp(totalColumns + 2×(3-viewStep), 2, 14) */
  budget: number
  // ── 운영일정 설정 ──
  hoursByDoctor: Record<string, Record<number, UnitHours>>
  hoursByWeekday: Record<number, UnitHours>
  /** 공휴일 운영시간(한 세트). 미설정이면 {} → resolveUnitHours 가 요일 축으로 폴백. */
  holidayHours: UnitHours
  /** 공휴일이면서 진료하는 날. 개수가 연 20건 남짓이라 배열 순회로 충분. */
  holidayDates: string[]
  closed: {
    offRules: unknown[]
    dateOverrides: unknown[]
    holidays: string[]
  }
  // ── 라이브 뷰 상태 ──
  dataType: DataType
  selectedDate: string
  viewStep: number // [1,5]
  slotDivision: number // >=1
  customSlots: Record<string, number>
  doctorPageIdx: number // >=0 (구 모델 fallback)
  /** date-anchored 윈도우 시작 offset. undefined = 구 doctorPageIdx 경로. */
  slotOffset?: number
  /** 시간축 수동 확장(시간) — 시작 일찍/종료 늦게. [0,24] clamp. */
  timelineTopExtendHours: number
  timelineBottomExtendHours: number
  /** 칸수배정 모델. 정규화 후 'A'(기본) 또는 'B2'. */
  layoutMode: LayoutMode
  // ── 필터 ──
  selectedDoctorIds: string[]
  // ── 환경 ──
  availableWidth: number
  /** 경계검증 경고 (loud-but-defensive: clamp 된 항목 기록) */
  warnings: string[]
}

// ════════════════════════════════════════════════════════════
// Unit / Band / Rect — REDESIGN §4, §8
// ════════════════════════════════════════════════════════════

/** (날짜,의사) 단위. buildUnitSequence 출력. */
export interface Unit {
  /** `${date}__${doctorId}` */
  key: string
  /** YYYY-MM-DD */
  date: string
  doctorId: string
  doctorName: string
  /** 0(일)~6(토) */
  weekday: number
  /** 자연 칸 수 = customSlots[key] ?? max(1, min(maxConcurrent, slotDivision)) */
  slots: number
}

/** operatingRange 산출 band. computeOperatingRange 출력 요소. */
export interface BandSpec {
  index: number
  /** 0:00 기준 분 */
  startMin: number
  /** 0:00 기준 분 */
  endMin: number
  /** 점심/저녁 휴게에 걸친 band (높이 축소 대상) */
  isBreak: boolean
  /** 휴게 라벨 (있으면) */
  breakLabel?: string
}

export interface OperatingRange {
  bands: BandSpec[]
  /** 운영 시작/종료 (union) */
  startMin: number
  endMin: number
  /** 휴게 구간 (병합) */
  breaks: SessionRange[]
}

/** computeBandHeights 출력. */
export interface BandInfo extends BandSpec {
  /** 이 band 에서 시작하는 카드의 최대 행 수 (전 컬럼 중) */
  maxRows: number
  /** 계산된 높이 px */
  heightPx: number
  /** 누적 top px */
  topPx: number
}

/** computeRects 출력 — REDESIGN §6 z 정책. */
export interface Rect {
  id: string
  /** 소속 컬럼 (페이지 내 index) */
  columnIndex: number
  top: number
  left: number
  width: number
  height: number
  /** base(auto=0) / floating(10) / 이동·하이라이트(15) */
  z: number
  isFloating: boolean
  /** layering(더 긴 예약 위 얹힌 짧은 예약, isFloating && level>0) — 들여쓰기·그림자 대상. level0(같은 길이 동시초과)은 false. */
  isLayered: boolean
}
