/**
 * 계약 테스트 — **예약 수정 화면과 보드(드롭·변경 커밋·resize)가 같은 시간으로 저장하는가.**
 *
 * 세 경로는 자료구조가 다르다(화면은 'HH:mm' 옵션 목록, 보드는 분). 그래서 함수로 합칠 수 없고,
 * 대신 "같은 예약을 어느 경로로 저장해도 같은 시각"을 여기서 고정한다. 규칙을 한쪽만 고치면
 * 이 파일이 깨진다.
 *
 * 실제로 갈렸던 자리는 **하루 끝**이다:
 *   - 화면은 23:30 시작의 종료를 23:59 로, 23:00 이상 시작에만 23:59 를 허용한다
 *   - 보드는 시작이 종료 이하인 분기에만 23:59 캡을 걸어, 23:30~24:00 드롭이 `T24:00:00` 으로 나갔고
 *     화면이 만든 23:00~23:59 는 이동하면 23:00~23:30 으로 줄었다
 *
 * ★이 파일이 깨지면 값을 맞추지 말고 **어느 쪽이 옳은지 먼저 정한다.** 규칙의 SSOT 는 화면
 *  (`reservationTimeRules`)이고 보드는 그것을 분으로 옮긴 것이다.
 */

import { describe, expect, it } from 'vitest'

import {
  buildTimeOptions,
  getEndOptionsByStart,
  minutesToTime,
  normalizeTimeStrings,
  parseTimeToMinutes,
} from '@/components/popup/reservationTimeRules'
import { normalizeRangeToGrid } from '../schedulerSnapGrid'
import { resolveResizeRange } from '@/pages/desktop/scheduler/composables/useSchedulerResize'

const STEP = 30
/** 예약 팝업의 기본 props 와 같다(minTime '00:00' · maxTime '23:30' · IS_END_TIME_FIX). */
const ALL_OPTIONS = buildTimeOptions('00:00', '23:30', STEP)
const END_RULE = { maxTime: '23:30', step: STEP, isEndTimeFix: true }
const endOptionsFor = (start: string) => getEndOptionsByStart(start, ALL_OPTIONS, END_RULE)

/** 화면 경로: 분 → 'HH:mm' 으로 열어 보정한 뒤 다시 분으로. */
function viaPopup(startMinute: number, endMinute: number) {
  const { start, end } = normalizeTimeStrings(
    minutesToTime(startMinute),
    minutesToTime(endMinute),
    ALL_OPTIONS,
    endOptionsFor,
  )
  return { startMinute: parseTimeToMinutes(start), endMinute: parseTimeToMinutes(end) }
}

/** 22:00=1320 22:30=1350 23:00=1380 23:30=1410 23:45=1425 23:59=1439 24:00=1440 */
const CASES: Array<[string, number, number]> = [
  ['격자 밖 09:40~10:20', 580, 620],
  ['내림하면 한 칸이 안 되는 23:40~23:50', 1420, 1430],
  ['마지막 칸 23:30~24:00', 1410, 1440],
  ['화면이 만든 23:00~23:59', 1380, 1439],
  ['23:00~24:00', 1380, 1440],
  ['22:00~23:59', 1320, 1439],
  ['22:00~24:00', 1320, 1440],
  ['22:30~23:45', 1350, 1425],
  ['밴드 맨 아래 24:00~24:30', 1440, 1470],
]

describe('예약 수정 화면 ↔ 보드 드롭·변경 커밋 — 같은 예약은 같은 시각으로 저장된다', () => {
  it.each(CASES)('%s', (_label, start, end) => {
    expect(normalizeRangeToGrid(start, end, STEP)).toEqual(viaPopup(start, end))
  })
})

describe('예약 수정 화면 ↔ 보드 resize(bottom) — 종료가 자정에 닿을 때 같은 값으로 닫힌다', () => {
  const LIMITS = { step: STEP, minDuration: STEP, maxDuration: 480 }

  // resize 는 시작이 고정(anchor)이고 종료만 snap 된 값으로 온다.
  it.each([
    ['23:30 예약을 24:00 까지', 1410, 1440],
    ['23:00 예약을 24:00 까지', 1380, 1440],
    ['22:30 예약을 24:00 까지', 1350, 1440],
  ])('%s', (_label, anchor, snapped) => {
    const { endMinute } = resolveResizeRange(anchor, snapped, 'bottom', LIMITS)
    expect(endMinute).toBe(viaPopup(anchor, snapped).endMinute)
  })
})
