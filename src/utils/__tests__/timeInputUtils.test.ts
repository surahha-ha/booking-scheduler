/**
 * 시간 입력칸 정규화·검증 (2026-08-18).
 *
 * 운영일정 설정의 시간 입력을 `<input type="time">` 에서 일반 텍스트로 바꾸면서,
 * 브라우저가 보장하던 형식·범위를 이 유틸이 대신 맡았다. 여기가 뚫리면 "2590" 같은 값이
 * state 를 지나 HHMMToHmm(콜론만 제거) 를 통과해 서버로 나간다.
 */

import { describe, expect, it } from 'vitest'
import {
  isInvalidTimeText,
  isReversedTimeRange,
  isValidHHMM,
  maskTimeTyping,
  normalizeTimeInput,
  timeToMinutes,
} from '@/utils/timeInputUtils'

describe('maskTimeTyping — 입력 중 마스킹', () => {
  it('숫자 외 문자는 칸에 들어오지 않는다', () => {
    expect(maskTimeTyping('abc')).toBe('')
    expect(maskTimeTyping('0a9b')).toBe('09')
    expect(maskTimeTyping('오전9시')).toBe('9')
    expect(maskTimeTyping('09-30')).toBe('09:30')
  })

  it('숫자는 4개까지다 — 5번째는 버린다', () => {
    expect(maskTimeTyping('09305')).toBe('09:30')
    expect(maskTimeTyping('123456')).toBe('12:34')
  })

  it('★4개가 차는 순간 콜론이 붙는다', () => {
    expect(maskTimeTyping('0')).toBe('0')
    expect(maskTimeTyping('09')).toBe('09')
    expect(maskTimeTyping('093')).toBe('093')
    expect(maskTimeTyping('0930')).toBe('09:30')
  })

  /* "930" 을 "93:0" 으로 만들면 09:30 을 의도한 입력이 틀어진다 —
   * 3자리 이하의 시/분 경계는 blur 때 normalizeTimeInput 이 정한다. */
  it('★3자리까지는 콜론을 넣지 않는다', () => {
    expect(maskTimeTyping('930')).toBe('930')
    expect(normalizeTimeInput(maskTimeTyping('930')), 'blur 에서 확정된다').toBe('09:30')
  })

  it('이미 콜론이 있는 값을 다시 마스킹해도 같은 결과다 (재입력·붙여넣기)', () => {
    expect(maskTimeTyping('09:30')).toBe('09:30')
    expect(maskTimeTyping(maskTimeTyping('0930'))).toBe('09:30')
  })

  it('빈 값은 빈 값 그대로 — 지우는 경로를 막지 않는다', () => {
    expect(maskTimeTyping('')).toBe('')
    expect(maskTimeTyping(null)).toBe('')
  })

  /* 범위는 입력 중에 막지 않는다 — 두 번째 자리에서 거부하면 편집이 이질적이다.
   * blur 이후 오류 표시와 저장 게이트가 맡는다. */
  it('범위를 벗어난 숫자는 통과시킨다 (검증은 blur 이후)', () => {
    expect(maskTimeTyping('2590')).toBe('25:90')
    expect(isInvalidTimeText(maskTimeTyping('2590'))).toBe(true)
  })
})

describe('normalizeTimeInput — 살릴 수 있는 입력', () => {
  it.each([
    ['9', '09:00'],
    ['09', '09:00'],
    ['18', '18:00'],
    ['0', '00:00'],
    ['930', '09:30'],
    ['0930', '09:30'],
    ['1830', '18:30'],
    ['2359', '23:59'],
    ['9:3', '09:03'],
    ['9:30', '09:30'],
    ['09:30', '09:30'],
    ['9:', '09:00'],
    [' 09 : 30 ', '09:30'],
  ])('"%s" → "%s"', (raw, expected) => {
    expect(normalizeTimeInput(raw)).toBe(expected)
  })

  it('빈 입력은 오류가 아니라 빈 값이다 — 진료행이면 그 요일 휴무가라는 뜻', () => {
    expect(normalizeTimeInput('')).toBe('')
    expect(normalizeTimeInput('   ')).toBe('')
    expect(normalizeTimeInput(null)).toBe('')
    expect(normalizeTimeInput(undefined)).toBe('')
  })
})

describe('normalizeTimeInput — 살릴 수 없는 입력', () => {
  it.each([
    ['abc', '숫자가 아니다'],
    ['09:3a', '숫자가 아니다'],
    ['2590', '분이 59를 넘는다'],
    ['2400', '시가 23을 넘는다'],
    ['25:90', '시·분 모두 범위를 넘는다'],
    ['24:00', '자정 24시 표기는 쓰지 않는다'],
    ['093000', '자릿수가 맞지 않는다'],
    ['12345', '자릿수가 맞지 않는다'],
    ['1:2:3', '콜론이 둘이다'],
    [':30', '시가 비었다'],
    ['09:300', '분이 세 자리다'],
  ])('"%s" → null (%s)', (raw) => {
    expect(normalizeTimeInput(raw)).toBeNull()
  })
})

describe('isValidHHMM / isInvalidTimeText', () => {
  it('확정 형식만 유효하다 — 정규화 전 표기는 유효하지 않다', () => {
    expect(isValidHHMM('09:30')).toBe(true)
    expect(isValidHHMM('23:59')).toBe(true)
    expect(isValidHHMM('00:00')).toBe(true)
    expect(isValidHHMM('9:30')).toBe(false)
    expect(isValidHHMM('0930')).toBe(false)
    expect(isValidHHMM('24:00')).toBe(false)
  })

  it('빈 값은 오류로 보지 않는다 — 정하지 않았다는 정상적인 의사 표현', () => {
    expect(isInvalidTimeText('')).toBe(false)
    expect(isInvalidTimeText('  ')).toBe(false)
    expect(isInvalidTimeText(null)).toBe(false)
  })

  it('값이 있는데 형식이 틀리면 오류다', () => {
    expect(isInvalidTimeText('2590')).toBe(true)
    expect(isInvalidTimeText('abc')).toBe(true)
    expect(isInvalidTimeText('09:30')).toBe(false)
  })
})

describe('timeToMinutes', () => {
  it('자정 기준 분으로 바꾼다', () => {
    expect(timeToMinutes('00:00')).toBe(0)
    expect(timeToMinutes('09:30')).toBe(570)
    expect(timeToMinutes('23:59')).toBe(1439)
  })

  it('형식이 틀리면 null — 계산에 끌어들이지 않는다', () => {
    expect(timeToMinutes('0930')).toBeNull()
    expect(timeToMinutes('')).toBeNull()
    expect(timeToMinutes('25:00')).toBeNull()
  })
})

describe('isReversedTimeRange', () => {
  it('종료가 시작보다 늦지 않으면 역전이다 — 같은 시각도 구간이 아니다', () => {
    expect(isReversedTimeRange('18:00', '09:00')).toBe(true)
    expect(isReversedTimeRange('09:00', '09:00')).toBe(true)
    expect(isReversedTimeRange('09:00', '18:00')).toBe(false)
  })

  it('한쪽이 비었거나 형식이 틀리면 판정하지 않는다 — 다른 가드가 먼저 잡을 상태다', () => {
    expect(isReversedTimeRange('09:00', '')).toBe(false)
    expect(isReversedTimeRange('', '18:00')).toBe(false)
    expect(isReversedTimeRange('2590', '09:00')).toBe(false)
  })
})
