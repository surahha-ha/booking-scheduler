/**
 * 스케줄러 날짜 Navigation Composable
 *
 * 책임:
 *   - selectedDate 단일 상태 소유
 *   - 버튼별 delta 규칙에 따른 날짜 이동 action 제공
 *   - 파생 데이터 (displayDates, dateStripData) 자동 재계산
 *   - 날짜 이동 후 scroll 보존 힌트 발행
 *
 * 하지 않는 것:
 *   - layout 계산 (layoutEngine)
 *   - 실제 DOM scroll 조작 (scrollSync composable)
 *   - timeSlot 생성 (timeSlotBuilder)
 *
 * 이동 정책:
 *   - 헤더 < >        → selectedDate ± 1 day
 *   - 스케줄 영역 < > → selectedDate ± visibleDayCount
 *   - 날짜 스트립 < > → selectedDate ± headerWindowDays
 *   - goToday()       → selectedDate = 오늘
 *   - goToDate(date)  → selectedDate = 지정 날짜
 *
 * scroll 보존 정책:
 *   모든 날짜 이동 action은 이동 전 minute anchor를 자동 캡처한다.
 *   scrollSnapshotProvider가 등록되어 있으면 캡처하고,
 *   등록되어 있지 않으면 preserveMinute = 0으로 발행한다.
 *
 * selectedDate 변경 시 재계산 흐름:
 *   selectedDate 변경
 *     → displayDates (computed, visibleDayCount 기준)
 *     → dateStripData (computed, headerWindowDays 기준)
 *     → scrollHint 발행 (watch)
 */

import { ref, computed, watch, type Ref, type ComputedRef } from 'vue'
import {
  moveSelectedDate,
  getToday,
  buildDisplayDates,
  buildDateStrip,
  scrollTopToMinute,
  type DateEntry,
  type DateStripData,
} from '@/scheduler-engine/schedulerDateUtils'

// ═══════════════════════════════════════════════════════════
// TimeSlot 형태 (scroll 보존용)
// ═══════════════════════════════════════════════════════════

export interface TimeSlotLike {
  topPx: number
  heightPx: number
  startMinute: number
  endMinute: number
}

// ═══════════════════════════════════════════════════════════
// Scroll Snapshot Provider
// ═══════════════════════════════════════════════════════════

/**
 * 현재 scroll 상태를 읽어오는 함수.
 * scrollSync composable이 등록하며,
 * navigation은 이동 전 이 함수를 호출해 minute anchor를 캡처한다.
 */
export type ScrollSnapshotProvider = () => {
  scrollTop: number
  bandInfos: TimeSlotLike[]
}

// ═══════════════════════════════════════════════════════════
// Scroll Hint
// ═══════════════════════════════════════════════════════════

/**
 * 날짜 이동 후 scroll 처리 힌트.
 *
 * navigation은 "어디로 가야 하는지"만 알려주고,
 * 실제 DOM scroll 조작은 scrollSync composable이 이 힌트를 watch하여 처리한다.
 */
export interface ScrollHint {
  /** 이동 후 대상 날짜 (= 새 selectedDate) */
  targetDate: string
  /** 세로 스크롤 보존용: 이동 전 보고 있던 minute */
  preserveMinute: number
  /** 가로 스크롤: 항상 0 (selectedDate가 곧 첫 번째 column) */
  scrollLeft: number
  /** 힌트 발행 시각 (중복 처리 방지용) */
  timestamp: number
}

// ═══════════════════════════════════════════════════════════
// 입력 옵션
// ═══════════════════════════════════════════════════════════

export interface UseSchedulerNavigationOptions {
  /** 초기 선택 날짜 (기본: 오늘) */
  initialDate?: string
  /** 날짜 스트립 day 표시 수 (기본: 30) */
  headerWindowDays?: number
  /**
   * layout engine이 계산한 visibleDayCount.
   * 외부에서 주입하는 읽기 전용 값.
   * 미제공 시 내부에서 ref(1)로 대체.
   */
  visibleDayCount?: Ref<number>
}

// ═══════════════════════════════════════════════════════════
// Return 타입
// ═══════════════════════════════════════════════════════════

export interface UseSchedulerNavigationReturn {
  // ── 상태 ──
  selectedDate: Ref<string>
  headerWindowDays: Ref<number>
  /** layout engine에서 주입된 값 (읽기 전용 용도) */
  visibleDayCount: Readonly<Ref<number>>

  // ── 파생 데이터 ──
  /** 본문 그리드 표시 날짜: selectedDate ~ selectedDate + visibleDayCount - 1 */
  displayDates: ComputedRef<DateEntry[]>
  /** 상단 스트립 데이터: selectedDate ~ selectedDate + headerWindowDays - 1 */
  dateStripData: ComputedRef<DateStripData>

  // ── actions ──
  goPrevDay: () => void
  goNextDay: () => void
  goPrevPage: () => void
  goNextPage: () => void
  goPrevStrip: () => void
  goNextStrip: () => void
  goToday: () => void
  goToDate: (date: string) => void

  // ── scroll 보존 ──
  scrollHint: Ref<ScrollHint | null>
  /**
   * scroll 상태 제공자 등록.
   * scrollSync composable이 mount 시 호출하여 등록한다.
   * 등록 후 모든 날짜 이동 action이 자동으로 minute anchor를 캡처한다.
   */
  setScrollSnapshotProvider: (provider: ScrollSnapshotProvider) => void
}

// ═══════════════════════════════════════════════════════════
// Composable 본체
// ═══════════════════════════════════════════════════════════

export function useSchedulerNavigation(
  options: UseSchedulerNavigationOptions = {}
): UseSchedulerNavigationReturn {

  // ── 상태 ──
  const selectedDate = ref(options.initialDate ?? getToday())
  const headerWindowDays = ref(options.headerWindowDays ?? 30)
  const visibleDayCount = options.visibleDayCount ?? ref(1)

  // ── scroll 보존 ──
  let _snapshotProvider: ScrollSnapshotProvider | null = null
  let _preservedMinute = 0
  const scrollHint = ref<ScrollHint | null>(null)

  function setScrollSnapshotProvider(provider: ScrollSnapshotProvider): void {
    _snapshotProvider = provider
  }

  /** 이동 전 minute anchor 캡처 */
  function captureMinuteAnchor(): void {
    if (_snapshotProvider) {
      const { scrollTop, bandInfos } = _snapshotProvider()
      _preservedMinute = scrollTopToMinute(scrollTop, bandInfos)
    } else {
      _preservedMinute = 0
    }
  }

  // ── 파생 데이터 ──
  const displayDates = computed(() =>
    buildDisplayDates(selectedDate.value, visibleDayCount.value)
  )

  const dateStripData = computed(() =>
    buildDateStrip(selectedDate.value, headerWindowDays.value)
  )

  // ── selectedDate 변경 감지 → scrollHint 발행 ──
  watch(selectedDate, (newDate) => {
    scrollHint.value = {
      targetDate: newDate,
      preserveMinute: _preservedMinute,
      scrollLeft: 0,
      timestamp: Date.now(),
    }
  })

  // ── 내부: minute 캡처 후 selectedDate 이동 ──
  function move(deltaDays: number): void {
    captureMinuteAnchor()
    selectedDate.value = moveSelectedDate(selectedDate.value, deltaDays)
  }

  function jumpTo(date: string): void {
    captureMinuteAnchor()
    selectedDate.value = date
  }

  // ── actions ──
  function goPrevDay(): void { move(-1) }
  function goNextDay(): void { move(1) }

  function goPrevPage(): void { move(-visibleDayCount.value) }
  function goNextPage(): void { move(visibleDayCount.value) }

  function goPrevStrip(): void { move(-headerWindowDays.value) }
  function goNextStrip(): void { move(headerWindowDays.value) }

  function goToday(): void { jumpTo(getToday()) }
  function goToDate(date: string): void { jumpTo(date) }

  return {
    selectedDate,
    headerWindowDays,
    visibleDayCount,
    displayDates,
    dateStripData,
    goPrevDay,
    goNextDay,
    goPrevPage,
    goNextPage,
    goPrevStrip,
    goNextStrip,
    goToday,
    goToDate,
    scrollHint,
    setScrollSnapshotProvider,
  }
}
