/**
 * V3 date-anchored 페이징 — slot 네비 순수 계산 (SchedulerV3Page 에서 추출, 단위테스트 대상).
 *
 * 모델: 좌측 끝 = selectedDate(날짜). 윈도우 = 전역 sub-col 시퀀스의 [colOffset, colOffset+budget).
 * 헤더 담당자 <> 는 윈도우를 budget 칸 이동 후 "착지 컬럼의 날짜"로 selectedDate 를 재고정 →
 * 데이터 재조회로 밀도가 변해도 좌측 날짜가 안 끌려감(점프 차단). within-day offset 으로 의사 多 페이징 보존.
 *
 * 여기 함수들은 reactive 상태(navigation/store)에 의존하지 않는 순수함수다. .vue 는 이 결과로
 * selectedDate/colOffset 을 설정만 한다.
 */

/** 네비에 필요한 unit 최소 형태 (layoutPipeline Unit 의 부분집합). */
export interface NavUnit {
  /** YYYY-MM-DD */
  date: string
  /** 그 unit 의 sub-col 수 (>=1) */
  slots: number
}

/**
 * 전역 slot 인덱스 → 그 slot 이 속한 unit 의 { date, startSlot }.
 * startSlot = 그 날짜(date)의 "첫 컬럼"의 전역 인덱스 (날짜-major 연속 가정).
 * slotIdx 가 전체를 초과하면 마지막 날짜로 clamp. units 빈 배열이면 fallbackDate.
 */
export function dateAtSlot(
  units: NavUnit[],
  slotIdx: number,
  fallbackDate: string,
): { date: string, startSlot: number } {
  if (units.length === 0) return { date: fallbackDate, startSlot: 0 }
  let acc = 0
  let curDate = units[0].date
  let dayStart = 0
  for (const u of units) {
    if (u.date !== curDate) {
      curDate = u.date
      dayStart = acc
    }
    const s = Math.max(1, u.slots)
    if (slotIdx < acc + s) return { date: u.date, startSlot: dayStart }
    acc += s
  }
  // 끝 초과 = 마지막 날짜 (dayStart = 마지막 날짜 첫 컬럼 인덱스)
  return { date: curDate, startSlot: dayStart }
}

/**
 * 전역 slot 인덱스(targetSlot) 로 좌측을 재고정할 인자 { date, offset }.
 * offset = 그 날짜 내 컬럼 인덱스(within-day) — selectedDate=date 로 재구성 후 colOffset 으로 사용.
 * date 가 바뀌어도 within-day 인덱스는 그 날 내부 순서라 불변 → 재고정 후에도 동일 컬럼 가리킴.
 */
export function reanchorArgsForSlot(
  units: NavUnit[],
  targetSlot: number,
  fallbackDate: string,
): { date: string, offset: number } {
  const at = dateAtSlot(units, Math.max(0, targetSlot), fallbackDate)
  return { date: at.date, offset: Math.max(0, targetSlot - at.startSlot) }
}

/** 전체 sub-col 수 (모든 unit slots 합, 각 >=1). */
export function totalSlotsOf(units: NavUnit[]): number {
  let total = 0
  for (const u of units) total += Math.max(1, u.slots)
  return total
}
