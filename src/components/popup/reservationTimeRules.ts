/**
 * 예약 팝업의 시간 규칙 — 순수함수.
 *
 * 예약 등록·수정 화면이 'HH:mm' 옵션 목록으로 시작·종료를 고르는 규칙이다. 보드의 이동·resize 저장
 * 경로(`schedulerSnapGrid.normalizeRangeToGrid` · `clampEndToDay`)는 이 규칙을 분 단위로 옮긴 것이라,
 * 같은 입력에 같은 답을 내는지 계약 테스트(`schedulerSnapGrid.contract.test.ts`)로 묶는다.
 * 규칙을 바꾸면 그 테스트가 알려준다 — 여기만 고치고 보드를 두면 저장 시각이 경로마다 갈린다.
 */

/** 'HH:mm' → 분. '23:59' → 1439. */
export function parseTimeToMinutes(t: string): number {
  const [hh, mm] = String(t).split(':').map(Number)
  return hh * 60 + mm
}

/** 분 → 'HH:mm'. 1440 은 '24:00' 이 된다(옵션에는 없고 입력 보정 전 값으로만 쓰인다). */
export function minutesToTime(min: number): string {
  const hh = String(Math.floor(min / 60)).padStart(2, '0')
  const mm = String(min % 60).padStart(2, '0')
  return `${hh}:${mm}`
}

export function addMinutes(timeStr: string, delta: number): string {
  return minutesToTime(parseTimeToMinutes(timeStr) + delta)
}

export function filterOptionsFromMinute(options: string[], minMinute: number): string[] {
  return options.filter(t => parseTimeToMinutes(t) >= minMinute)
}

/** minTime~maxTime 을 step 간격으로 나열한 옵션. 범위가 뒤집히거나 파싱이 안 되면 빈 목록. */
export function buildTimeOptions(minTime: string, maxTime: string, step: number): string[] {
  const min = parseTimeToMinutes(minTime)
  const max = parseTimeToMinutes(maxTime)
  if (Number.isNaN(min) || Number.isNaN(max)) return []
  if (min > max) return []

  const out: string[] = []
  for (let m = min; m <= max; m += step) out.push(minutesToTime(m))
  return out
}

/** 옵션 중 timeStr 이하에서 가장 가까운 값(내림). 옵션이 오름차순이라는 전제. 아래로 벗어나면 첫 옵션. */
export function clampToOptions(timeStr: string, options: string[]): string {
  if (!options?.length) return '00:00'
  if (!timeStr) return options[0]

  const target = parseTimeToMinutes(timeStr)
  let best = options[0]

  for (const t of options) {
    const tMin = parseTimeToMinutes(t)
    if (tMin <= target) {
      best = t
    } else {
      break
    }
  }
  return best
}

export interface EndOptionRule {
  /** 마지막 시작 칸(팝업 props.maxTime, 기본 '23:30') */
  maxTime: string
  /** 예약 단위(분) */
  step: number
  /** 마지막 칸 예외(23:59) 사용 여부(IS_END_TIME_FIX) */
  isEndTimeFix: boolean
}

/**
 * 시작에 따른 종료 옵션.
 *   - 기본: 시작 + step 이상인 옵션
 *   - 마지막 칸 예외: 시작이 (maxTime − step) 이상이면 23:59 를 추가 (예: maxTime 23:30 → 23:00 부터)
 *   - 00:00 은 종료가 될 수 없다
 */
export function getEndOptionsByStart(startStr: string, allOptions: string[], rule: EndOptionRule): string[] {
  if (!startStr) return allOptions

  const sMin = parseTimeToMinutes(startStr)
  const base = filterOptionsFromMinute(allOptions, sMin + rule.step)

  if (!rule.isEndTimeFix) return base

  const threshold = parseTimeToMinutes(rule.maxTime) - rule.step
  if (sMin >= threshold && !base.includes('23:59')) base.push('23:59')

  return base.filter(t => t !== '00:00')
}

/**
 * 시작·종료 문자열을 옵션 목록 위로 보정한다(예약을 열 때·시간대가 바뀔 때).
 *   - 시작은 시작 옵션으로 내림
 *   - 그 시작의 종료 옵션이 없으면 시작을 뒤에서 둘째 칸으로 물리고 첫 종료 옵션
 *   - 종료는 종료 옵션으로 내림, 시작 이하로 떨어지면 첫 종료 옵션
 */
export function normalizeTimeStrings(
  startStr: string,
  endStr: string,
  startOptions: string[],
  endOptionsFor: (_start: string) => string[],
): { start: string; end: string } {
  if (!startOptions.length) return { start: '', end: '' }

  const start = clampToOptions(startStr, startOptions)

  const eOpts = endOptionsFor(start)
  if (!eOpts.length) {
    const fallbackStart = startOptions[Math.max(0, startOptions.length - 2)]
    return { start: fallbackStart, end: endOptionsFor(fallbackStart)[0] ?? '' }
  }

  let end = clampToOptions(endStr, eOpts)
  if (parseTimeToMinutes(end) <= parseTimeToMinutes(start)) end = eOpts[0]

  return { start, end }
}
