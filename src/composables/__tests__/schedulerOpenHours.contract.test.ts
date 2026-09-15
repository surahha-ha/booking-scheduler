/**
 * 계약 테스트 — **예약검증과 타임라인 밴드가 같은 답을 내는가.**
 *
 * 두 계층은 자료구조도 반환값도 다르다(HH:mm 판정 ↔ 분 단위 배치). 그래서 함수로 합칠 수 없고,
 * 대신 "같은 상황에 같은 답"을 여기서 고정한다. 규칙을 한쪽만 고치면 이 파일이 깨진다.
 *
 * 고정하는 것은 **아무도 그 요일을 정하지 않은 칸**의 처리다. 실제로 사고가 난 자리다:
 *   - 사업장이 매주 쉬는 요일에는 운영시간 행 자체가 없다
 *   - 그래서 "시간이 없다"는 이유로 밴드가 닫히고, 축 상속을 끊어 운영으로 정한 담당자까지 막혔다
 * 지금은 양쪽 모두 기본 09:00~18:00 으로 연다 — **정하지 않음**과 **휴무로 정함**은 다르다.
 *
 * ★이 파일이 깨지면 값을 맞추지 말고 **어느 쪽이 옳은지 먼저 정한다.** 양쪽을 각자 고쳐서
 *  맞춰 두면 다음 변경에서 또 갈린다 — 그래서 값 자체는 constants/operatingHours 가 소유한다.
 */

import { describe, expect, it } from 'vitest'
import dayjs from 'dayjs'

import { useSchedulerRules } from '../useSchedulerRules'
import { resolveUnitHours } from '@/scheduler-engine/redesign/layoutPipeline'
import {
  DEFAULT_OPERATING_END,
  DEFAULT_OPERATING_END_MIN,
  DEFAULT_OPERATING_START,
  DEFAULT_OPERATING_START_MIN,
} from '@/constants/operatingHours'

/** 'HH:mm' → 분. 두 계층의 답을 같은 단위로 놓고 비교하기 위한 테스트 전용 변환. */
function toMin(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

// 아무 규칙도 없는 평범한 수요일. 기관·담당자 모두 이 요일을 정하지 않았다.
const UNSET_DAY = '2026-08-12'
const UNSET_WEEKDAY = dayjs(UNSET_DAY).day()

describe('기본 운영시간 상수 — 문자열과 분이 갈리지 않는다', () => {
  it('분은 HH:mm 에서 파생된다', () => {
    expect(DEFAULT_OPERATING_START_MIN).toBe(toMin(DEFAULT_OPERATING_START))
    expect(DEFAULT_OPERATING_END_MIN).toBe(toMin(DEFAULT_OPERATING_END))
  })

  it('사업장 표준 09:00~18:00 이다', () => {
    expect(DEFAULT_OPERATING_START).toBe('09:00')
    expect(DEFAULT_OPERATING_END).toBe('18:00')
    expect([DEFAULT_OPERATING_START_MIN, DEFAULT_OPERATING_END_MIN]).toEqual([540, 1080])
  })
})

describe('아무도 정하지 않은 요일 — 예약검증과 밴드가 같은 창을 연다', () => {
  /* 기관·담당자 어느 쪽에도 이 요일 정보가 없는 상태. 휴무로 "정한" 것이 아니라 미설정이다. */
  function rules() {
    return useSchedulerRules({
      hospitalRules: {
        closedDates: new Set<string>(),
        closedWeekdays: new Set<number>(),
        holidayWorkDates: new Set<string>(),
        holidayOpenDates: new Set<string>(),
        weekly: {},
        holiday: null,
      } as never,
      doctorRules: { kim: { weekly: {}, closedDates: new Set(), closedWeekdays: new Set() } } as never,
      blockOptions: { lunchBlock: true, blockedTime: true, closedDay: true },
      selectedDoctors: new Set(['kim']),
      cellDuration: 30,
      doctorsRef: [{ id: 'kim', text: '김담당' }],
      options: { priority: 'DOCTOR_FIRST', mergePolicy: 'FALLBACK' },
    })
  }

  /* 밴드 쪽 같은 상황 — 담당자별·요일별 운영시간이 통째로 비어 있다. */
  const bandHours = () =>
    resolveUnitHours(
      { hoursByDoctor: {}, hoursByWeekday: {}, holidayHours: {}, holidayDates: [] } as never,
      { key: 'u', date: UNSET_DAY, doctorId: 'kim', weekday: UNSET_WEEKDAY, slots: [] } as never,
    )

  it('밴드는 09:00~18:00 으로 열린다', () => {
    expect(bandHours()).toEqual({
      morning: { start: DEFAULT_OPERATING_START_MIN, end: DEFAULT_OPERATING_END_MIN },
    })
  })

  it('예약검증도 같은 창을 연다 — 시작 시각은 허용, 종료 시각은 막는다', () => {
    const { getBlockedReason } = rules()
    expect(getBlockedReason(`${UNSET_DAY}T${DEFAULT_OPERATING_START}:00`, 'kim').blocked).toBe(false)
    expect(getBlockedReason(`${UNSET_DAY}T${DEFAULT_OPERATING_END}:00`, 'kim').blocked).toBe(true)
  })

  it('창 밖은 양쪽 모두 닫혀 있다 — 밴드가 여는 구간과 예약 가능 구간이 같다', () => {
    const { getBlockedReason } = rules()
    const band = bandHours().morning!

    // 밴드가 여는 구간의 경계 바로 앞은 예약도 막혀야 한다.
    const beforeOpen = dayjs(`${UNSET_DAY}T00:00:00`).add(band.start - 30, 'minute')
    expect(getBlockedReason(beforeOpen.toDate(), 'kim').blocked).toBe(true)

    // 밴드 안의 마지막 칸은 열려 있어야 한다.
    const lastSlot = dayjs(`${UNSET_DAY}T00:00:00`).add(band.end - 30, 'minute')
    expect(getBlockedReason(lastSlot.toDate(), 'kim').blocked).toBe(false)
  })
})
