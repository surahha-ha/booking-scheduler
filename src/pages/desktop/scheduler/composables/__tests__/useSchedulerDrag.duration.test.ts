/**
 * bookingDurationOf — 드래그 미리보기 길이 = 저장될 길이
 *
 * 격자 밖 예약(외부 유입)을 옮길 때 미리보기는 원본 길이, 저장은 격자 보정 길이를 써서
 * 놓기 전(09:30~10:10)과 저장 후(09:30~10:00)가 달랐다. 미리보기 길이도 저장 경로와 같은
 * 보정(normalizeRangeToGrid)을 지나야 한다.
 *
 * 기대값 출처: 정책 결정(2026-09-07) — 30분 단위 밖 시각은 저장할 창구가 없으므로 격자 보정 저장이 맞고,
 * 미리보기가 저장값을 따른다. 기대 길이는 예약 수정 화면이 같은 예약을 열었을 때의 길이와 같다.
 */

import { describe, expect, it } from 'vitest'
import { bookingDurationOf } from '../useSchedulerDrag'
import { normalizeRangeToGrid } from '@/scheduler-engine/schedulerSnapGrid'

const STEP = 30

describe('bookingDurationOf — 미리보기 길이는 저장 길이와 같다', () => {
  it('🔑 격자 밖 09:40~10:20(40분)은 저장되는 09:30~10:00 과 같은 30분', () => {
    expect(bookingDurationOf(580, 620, STEP)).toBe(30)
  })

  it('격자 위 예약은 길이가 그대로다 — 09:00~10:00 은 60분', () => {
    expect(bookingDurationOf(540, 600, STEP)).toBe(60)
  })

  it('내림하면 한 칸이 안 되는 09:40~09:50 도 최소 한 칸 30분', () => {
    expect(bookingDurationOf(580, 590, STEP)).toBe(30)
  })

  it('하루 끝 23:40~23:50 은 저장(23:30~23:59)과 같은 29분', () => {
    expect(bookingDurationOf(1420, 1430, STEP)).toBe(29)
  })

  it.each([
    [580, 620],
    [555, 640],
    [1380, 1439],
  ])('어떤 입력(%i~%i)이든 저장 경로 normalizeRangeToGrid 의 길이와 일치한다', (start, end) => {
    const saved = normalizeRangeToGrid(start, end, STEP)
    expect(bookingDurationOf(start, end, STEP)).toBe(saved.endMinute - saved.startMinute)
  })
})
