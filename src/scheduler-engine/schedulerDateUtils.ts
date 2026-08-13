/**
 * 스케줄러 날짜 유틸리티
 *
 * 순수 계산 모듈. Vue 의존성 없음.
 *
 * Navigation 정책 (단일 기준 날짜 동기화 모델):
 *   - selectedDate 하나가 모든 날짜 기준을 결정한다.
 *   - anchorDate / viewportStartDate 분리 모델은 폐기됨.
 *   - viewportStartDate = selectedDate (항상 동일).
 *
 * 날짜 스트립 구조:
 *   - day 영역: selectedDate ~ selectedDate + headerWindowDays - 1
 *   - 이전 month: day 영역 이전, 최대 12개월 전까지
 *   - 이후 month: day 영역 이후, 최대 12개월 후까지
 */

import dayjs, { type Dayjs } from 'dayjs'

// ═══════════════════════════════════════════════════════════
// 날짜 표시용 타입
// ═══════════════════════════════════════════════════════════

/** 표시용 날짜 엔트리 (headerBuilder 입력) */
export interface DateEntry {
  date: string       // "2026-03-11"
  label: string      // "3/11 (수)"
}

/** 날짜 스트립 전체 데이터 */
export interface DateStripData {
  dayCells: DateStripDayCell[]
  prevMonthCells: DateStripMonthCell[]
  nextMonthCells: DateStripMonthCell[]
}

/** 날짜 스트립 day 셀 */
export interface DateStripDayCell {
  date: string
  dayOfMonth: number
  dayOfWeek: number          // 0=일, 6=토
  isSelected: boolean
  isToday: boolean
  isWeekend: boolean
  /** 월 경계 첫 날이면 월 라벨 표시 (예: "3월") */
  monthLabel?: string
}

/** 날짜 스트립 month 셀 */
export interface DateStripMonthCell {
  yearMonth: string          // "2026-05"
  label: string              // "5월"
  /** 클릭 시 이동할 날짜 */
  firstDate: string          // "2026-05-01"
}

// ═══════════════════════════════════════════════════════════
// 요일 라벨
// ═══════════════════════════════════════════════════════════

const DAY_LABELS = ['일', '월', '화', '수', '목', '금', '토']
const MONTH_LABELS = ['1월', '2월', '3월', '4월', '5월', '6월', '7월', '8월', '9월', '10월', '11월', '12월']

// ═══════════════════════════════════════════════════════════
// 표시 날짜 배열 생성
// ═══════════════════════════════════════════════════════════

/**
 * selectedDate 기준 표시할 dates 배열 생성
 *
 * @param selectedDate - 기준 날짜 (YYYY-MM-DD)
 * @param dayCount - 생성할 날짜 수
 */
export function buildDisplayDates(
  selectedDate: string,
  dayCount: number
): DateEntry[] {
  const dates: DateEntry[] = []
  const base = dayjs(selectedDate)

  for (let i = 0; i < dayCount; i++) {
    const d = base.add(i, 'day')
    dates.push({
      date: d.format('YYYY-MM-DD'),
      label: formatDateLabel(d),
    })
  }

  return dates
}

/**
 * 날짜 라벨 포맷: "3/11 (수)"
 */
function formatDateLabel(d: Dayjs): string {
  const month = d.month() + 1
  const day = d.date()
  const dow = DAY_LABELS[d.day()]
  return `${month}/${day} (${dow})`
}

// ═══════════════════════════════════════════════════════════
// Navigation 이동 계산
// ═══════════════════════════════════════════════════════════

/**
 * selectedDate를 delta일만큼 이동
 */
export function moveSelectedDate(current: string, deltaDays: number): string {
  return dayjs(current).add(deltaDays, 'day').format('YYYY-MM-DD')
}

/**
 * 오늘 날짜 반환
 */
export function getToday(): string {
  return dayjs().format('YYYY-MM-DD')
}

// ═══════════════════════════════════════════════════════════
// 상단 날짜 스트립 데이터 생성
// ═══════════════════════════════════════════════════════════

/**
 * 상단 날짜 스트립 전체 데이터 생성
 *
 * @param selectedDate - 기준 날짜
 * @param headerWindowDays - day 단위 표시 범위 (기본 30)
 * @param monthRange - day 영역 밖의 month 표시 범위 (기본 ±12개월)
 */
export function buildDateStrip(
  selectedDate: string,
  headerWindowDays: number = 30,
  monthRange: number = 12
): DateStripData {
  const base = dayjs(selectedDate)
  const today = dayjs().format('YYYY-MM-DD')

  // ─── day 셀 생성 ───
  const dayCells: DateStripDayCell[] = []
  let prevMonth = -1

  for (let i = 0; i < headerWindowDays; i++) {
    const d = base.add(i, 'day')
    const currentMonth = d.month()
    const dow = d.day()

    const cell: DateStripDayCell = {
      date: d.format('YYYY-MM-DD'),
      dayOfMonth: d.date(),
      dayOfWeek: dow,
      isSelected: i === 0,
      isToday: d.format('YYYY-MM-DD') === today,
      isWeekend: dow === 0 || dow === 6,
    }

    // 월 경계: 첫 셀이거나 월이 바뀐 경우
    if (currentMonth !== prevMonth) {
      cell.monthLabel = MONTH_LABELS[currentMonth]
      prevMonth = currentMonth
    }

    dayCells.push(cell)
  }

  // ─── day 영역의 시작/끝 계산 ───
  const dayStart = base
  const dayEnd = base.add(headerWindowDays - 1, 'day')

  // day 영역이 걸치는 월 집합 (month strip에서 제외)
  const dayAreaMonths = new Set<string>()
  for (let i = 0; i < headerWindowDays; i++) {
    dayAreaMonths.add(base.add(i, 'day').format('YYYY-MM'))
  }

  // ─── 이전 month 셀 ───
  // dayStart 경계 기준 monthRange개월 전까지
  const prevMonthCells: DateStripMonthCell[] = []
  const prevLimit = dayStart.subtract(monthRange, 'month').startOf('month')
  let cursor = dayStart.subtract(1, 'day').startOf('month')

  while (cursor.isSame(prevLimit, 'month') || cursor.isAfter(prevLimit)) {
    const ym = cursor.format('YYYY-MM')
    if (!dayAreaMonths.has(ym)) {
      prevMonthCells.unshift({
        yearMonth: ym,
        label: MONTH_LABELS[cursor.month()],
        firstDate: cursor.format('YYYY-MM-DD'),
      })
    }
    cursor = cursor.subtract(1, 'month')
  }

  // ─── 이후 month 셀 ───
  // dayEnd 경계 기준 monthRange개월 후까지
  const nextMonthCells: DateStripMonthCell[] = []
  const nextLimit = dayEnd.add(monthRange, 'month').endOf('month')
  cursor = dayEnd.add(1, 'day').startOf('month')

  while (cursor.isBefore(nextLimit) || cursor.isSame(nextLimit, 'month')) {
    const ym = cursor.format('YYYY-MM')
    if (!dayAreaMonths.has(ym)) {
      nextMonthCells.push({
        yearMonth: ym,
        label: MONTH_LABELS[cursor.month()],
        firstDate: cursor.format('YYYY-MM-DD'),
      })
    }
    cursor = cursor.add(1, 'month')
  }

  return { dayCells, prevMonthCells, nextMonthCells }
}

// ═══════════════════════════════════════════════════════════
// scrollTop 보존 유틸
// ═══════════════════════════════════════════════════════════

/**
 * 현재 scrollTop에서 보고 있는 minute 역산
 */
export function scrollTopToMinute(
  scrollTop: number,
  timeSlots: { topPx: number; heightPx: number; startMinute: number; endMinute: number }[]
): number {
  if (timeSlots.length === 0) return 0

  for (const slot of timeSlots) {
    if (scrollTop >= slot.topPx && scrollTop < slot.topPx + slot.heightPx) {
      const ratio = slot.heightPx > 0
        ? (scrollTop - slot.topPx) / slot.heightPx
        : 0
      return slot.startMinute + ratio * (slot.endMinute - slot.startMinute)
    }
  }

  // 범위 밖
  const last = timeSlots[timeSlots.length - 1]
  if (scrollTop >= last.topPx + last.heightPx) {
    return last.endMinute
  }
  return timeSlots[0].startMinute
}

/**
 * minute → scrollTop 변환 (scrollTopToMinute의 역함수)
 *
 * minute가 속하는 슬롯을 찾아 슬롯 내 비율로 topPx를 보간한다.
 */
export function minuteToScrollTop(
  minute: number,
  timeSlots: { topPx: number; heightPx: number; startMinute: number; endMinute: number }[]
): number {
  if (timeSlots.length === 0) return 0

  for (const slot of timeSlots) {
    if (minute >= slot.startMinute && minute < slot.endMinute) {
      const duration = slot.endMinute - slot.startMinute
      const ratio = duration > 0
        ? (minute - slot.startMinute) / duration
        : 0
      return slot.topPx + ratio * slot.heightPx
    }
  }

  // 범위 밖
  const last = timeSlots[timeSlots.length - 1]
  if (minute >= last.endMinute) {
    return last.topPx + last.heightPx
  }
  return timeSlots[0].topPx
}
