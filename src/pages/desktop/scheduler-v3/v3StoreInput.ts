/**
 * MR-3c — 실 store/api 데이터 → RunLayoutInput 빌더 (렌더 전용)
 *
 * MR-3b 의 데모 입력(v3DemoInput)을 대체. store 타입이 adapter mirror 타입과
 * 구조적으로 일치하므로 사실상 passthrough 다 (doctors/appts/weekly 직결).
 * 원칙:
 *  - `bookStore.load()` 직접 호출 금지 — 페이지가 useBookStore() 인스턴스화 시
 *    searchVersion watch(immediate) 가 load 체인을 트리거한다(여기선 read 만).
 *  - 페이지(.vue)에 계산 로직을 두지 않기 위해 입력 조립을 이 .ts 로 분리.
 *  - 의사 그룹핑 키 = 이름(name 모드). 팀 셀렉트박스는 후속 필터단계.
 */

import type {
  ApptSource,
  DailyScheduleSource,
  DoctorSource,
  WeeklySource,
} from '@/scheduler-engine/redesign/runLayoutAdapter'
import type {
  EnvInput,
  ReservationSettingsInput,
  ViewStateInput,
} from '@/scheduler-engine/redesign/layoutTypes'
import type { RunLayoutInput } from '@/scheduler-engine/redesign/layoutPipeline'
import { buildRunLayoutInput } from '@/scheduler-engine/redesign/runLayoutAdapter'

/**
 * 예약장부 설정 기본값(fallback) — reservationSettingStore 미로딩/미전달 필드에만 적용.
 * 설정 반영 단계에서 timeUnit/displayInfo/rowHeightLevel 도 store 값을 주입(아래 buildStoreRunLayoutInput).
 *  - timeUnit → cellDuration(grid 간격), rowHeightLevel → 카드 높이(엔진 px 변환).
 *  - displayInfo 는 엔진 config 로 흘러 카드 렌더(23-2)에서 소비. 배열 순서 = 카드 표시 순서(드래그 재정렬 → BE 영속).
 *  - rowHeightLevel 은 서버 구현 — store 가 BE 응답값 주입(미응답 시 기본값 3).
 */
const DEFAULT_SETTINGS: ReservationSettingsInput = {
  slotUnitMinutes: 30,
  totalColumnCount: 8,
  displayInfo: ['NAME'],
  cardHeightLevel: 3,
}

export interface StoreInputParams {
  /** staffStore.doctors */
  doctors: DoctorSource[]
  /** bookStore.appointments */
  appts: ApptSource[]
  /** staffStore.hospitalRules.weekly (AS-IS 기관 공통) */
  weekly: WeeklySource | null | undefined
  /** staffStore.hospitalRules.holiday — 기관 공휴일 운영시간(요일 축 없는 한 세트). */
  holiday?: DailyScheduleSource | null
  /** staffStore.hospitalRules.holidayOpenDates — 공휴일이면서 진료하는 날. 그 날 밴드는 holiday 로 그린다. */
  holidayDates?: string[]
  /** staffStore.hospitalRules.dailyByDate — 지정일자의 그 날짜 운영시간. 요일·공휴일보다 우선해 밴드를 그린다. */
  dailyByDate?: Record<string, DailyScheduleSource>
  /**
   * staffStore.doctorRules 를 {담당자키: weekly} 로 넘긴 것(name 모드 타임라인 밴드용).
   * 미전달 시 타임라인은 기관 단독 밴드(현행). key = replaceDoctorName(이름) = unit.doctorId 정합.
   */
  doctorWeeklyById?: Record<string, WeeklySource>
  availableWidth: number
  /** 'YYYY-MM-DD' (페이지-로컬) */
  selectedDate: string
  viewState: ViewStateInput
  /** filterStore.doctors — 선택된 의사 id(이름). 비어있으면 전체. 컬럼 필터 정합용. */
  selectedDoctorIds?: string[]
  /** 예약장부 설정 "전체 칸 개수"(reservationSettingStore). 미전달 시 DEFAULT(8). budget = totalColumns + 2×(3-viewStep). */
  totalColumns?: number
  /** 예약장부 설정 예약시간단위(reservationSettingStore). 미전달 시 DEFAULT(30). cellDuration 으로 정규화 → grid 간격. */
  timeUnit?: number
  /** 예약장부 설정 표시정보(reservationSettingStore). 카드 표시항목 — 엔진 config 경유 카드 렌더(23-2)에서 소비. */
  displayInfo?: string[]
  /** 예약장부 설정 카드 높이 단계 1~5(reservationSettingStore). 미전달 시 DEFAULT(3). */
  rowHeightLevel?: number
  /**
   * 표시 날짜 범위(일). 현재 데이터 윈도우(toPeriodRange)에 정합 — 빈 미래 페이지 방지.
   * 표시 unit 생성 범위일 뿐 데이터 조회와 무관. 미전달 시 엔진 기본(90일).
   */
  horizonDays?: number
}

export function buildStoreRunLayoutInput(p: StoreInputParams): RunLayoutInput {
  const env: EnvInput = { availableWidth: Math.max(1, p.availableWidth) }
  // 검색필터에서 의사 선택 시 그 의사 컬럼만(전체=빈배열). name 모드라 id=이름 매칭.
  const selected = p.selectedDoctorIds ?? []
  const doctors = selected.length > 0
    ? p.doctors.filter(d => selected.includes(d.id))
    : p.doctors
  // 예약장부 설정값 주입 — 미전달 필드만 DEFAULT fallback. slotUnitMinutes→cellDuration, cardHeightLevel→카드높이, displayInfo→카드렌더(23-2).
  const settings: ReservationSettingsInput = {
    slotUnitMinutes: typeof p.timeUnit === 'number' ? p.timeUnit : DEFAULT_SETTINGS.slotUnitMinutes,
    totalColumnCount: typeof p.totalColumns === 'number' ? p.totalColumns : DEFAULT_SETTINGS.totalColumnCount,
    displayInfo: (Array.isArray(p.displayInfo) && p.displayInfo.length) ? p.displayInfo : DEFAULT_SETTINGS.displayInfo,
    cardHeightLevel: typeof p.rowHeightLevel === 'number' ? p.rowHeightLevel : DEFAULT_SETTINGS.cardHeightLevel,
  }
  return buildRunLayoutInput({
    mode: { kind: 'name' },
    settings,
    viewState: p.viewState,
    env,
    doctors,
    appts: p.appts,
    weekly: p.weekly ?? undefined,
    holiday: p.holiday ?? undefined,
    holidayDates: p.holidayDates,
    dailyByDate: p.dailyByDate,
    doctorWeeklyById: p.doctorWeeklyById,
    horizonDays: p.horizonDays,
  })
}
