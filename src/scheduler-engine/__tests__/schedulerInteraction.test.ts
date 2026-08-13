/**
 * 스케줄러 인터랙션 / 상태 검증 테스트
 *
 * drag/resize/popover의 데이터 레벨 검증.
 * DOM/이벤트는 브라우저 수동 확인.
 */

import { describe, it, expect } from 'vitest'
import dayjs from 'dayjs'

// ═══════════════════════════════════════════════════════════
// 24. 같은 위치 drag → isNoChange
// ═══════════════════════════════════════════════════════════

describe('Drag isNoChange', () => {

  function checkNoChange(originCol: string, originStart: number, currentCol: string, currentStart: number) {
    return originCol === currentCol && originStart === currentStart
  }

  it('같은 column + 같은 시간 → true', () => {
    expect(checkNoChange('2026-04-14_조인호', 600, '2026-04-14_조인호', 600)).toBe(true)
  })

  it('같은 column + 다른 시간 → false', () => {
    expect(checkNoChange('2026-04-14_조인호', 600, '2026-04-14_조인호', 660)).toBe(false)
  })

  it('다른 column + 같은 시간 → false', () => {
    expect(checkNoChange('2026-04-14_조인호', 600, '2026-04-14_김경원', 600)).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════
// 25. 과거 시간 판정 — isPastDateTime
// ═══════════════════════════════════════════════════════════

describe('isPastDateTime', () => {

  function isPastDateTime(dateStr: string, startMinute: number, cellDuration: number): boolean {
    const step = cellDuration || 30
    const bandEndMinute = Math.ceil((startMinute + 1) / step) * step
    const h = Math.floor(bandEndMinute / 60)
    const m = bandEndMinute % 60
    const bandEndDate = dayjs(dateStr).hour(h).minute(m).second(0)
    return bandEndDate.isBefore(dayjs())
  }

  it('어제 09:00 → past', () => {
    const yesterday = dayjs().subtract(1, 'day').format('YYYY-MM-DD')
    expect(isPastDateTime(yesterday, 540, 30)).toBe(true)
  })

  it('내일 09:00 → not past', () => {
    const tomorrow = dayjs().add(1, 'day').format('YYYY-MM-DD')
    expect(isPastDateTime(tomorrow, 540, 30)).toBe(false)
  })

  it('오늘 현재 시각보다 미래 band → not past', () => {
    const today = dayjs().format('YYYY-MM-DD')
    // 23:30 band는 거의 항상 미래
    expect(isPastDateTime(today, 1410, 30)).toBe(false)
  })
})

// 34-35. dotMenuButtons 구성 → pages/desktop/scheduler/__tests__/appointmentCardMenu.test.ts
// (엔진이 아니라 UI 메뉴 정의라 소유 모듈 옆에서 검증한다)

// ═══════════════════════════════════════════════════════════
// 36. quickActionLabel 분기
// ═══════════════════════════════════════════════════════════

describe('quickActionLabel', () => {

  function getQuickActionLabel(isAppointment: boolean, status: string): string | null {
    if (isAppointment) return null
    if (status === '00') return '접수'
    if (status === '05') return '완료'
    return null
  }

  it('예약 화면 → null', () => {
    expect(getQuickActionLabel(true, '00')).toBeNull()
  })

  it('진료 상태 00 → 접수', () => {
    expect(getQuickActionLabel(false, '00')).toBe('접수')
  })

  it('진료 상태 05 → 완료', () => {
    expect(getQuickActionLabel(false, '05')).toBe('완료')
  })

  it('진료 상태 01 → null', () => {
    expect(getQuickActionLabel(false, '01')).toBeNull()
  })

  it('진료 상태 02 → null', () => {
    expect(getQuickActionLabel(false, '02')).toBeNull()
  })

  it('진료 상태 03 → null', () => {
    expect(getQuickActionLabel(false, '03')).toBeNull()
  })
})

// ═══════════════════════════════════════════════════════════
// 48. type 필드 — toType 매핑
// ═══════════════════════════════════════════════════════════

describe('toType 매핑', () => {

  function toType(dataType: string): string {
    const map: Record<string, string> = {
      APPOINTMENT: 'reservation',
      TREATMENT: 'treatment',
    }
    return map[dataType] ?? ''
  }

  it('APPOINTMENT → reservation', () => {
    expect(toType('APPOINTMENT')).toBe('reservation')
  })

  it('TREATMENT → treatment', () => {
    expect(toType('TREATMENT')).toBe('treatment')
  })
})

// ═══════════════════════════════════════════════════════════
// snap 30분 단위 검증
// ═══════════════════════════════════════════════════════════

describe('snap 30분 단위', () => {

  function snapMinute(rawMinute: number, interval: number): number {
    return Math.round(rawMinute / interval) * interval
  }

  it('17:50 → 18:00 (반올림)', () => {
    expect(snapMinute(1070, 30)).toBe(1080)
  })

  it('17:40 → 17:30 (반올림)', () => {
    expect(snapMinute(1060, 30)).toBe(1050)
  })

  it('17:45 → 18:00 (반올림, 정확히 중간)', () => {
    expect(snapMinute(1065, 30)).toBe(1080)
  })

  it('09:00 → 09:00 (정확히 경계)', () => {
    expect(snapMinute(540, 30)).toBe(540)
  })

  it('09:14 → 09:00 (내림)', () => {
    expect(snapMinute(554, 30)).toBe(540)
  })

  it('09:15 → 09:30 (정확히 중간 → 올림)', () => {
    expect(snapMinute(555, 30)).toBe(570)
  })
})

// ═══════════════════════════════════════════════════════════
// clampToOptions (30분 내림) 검증
// ═══════════════════════════════════════════════════════════

describe('clampToOptions (30분 내림)', () => {

  function parseTimeToMinutes(t: string): number {
    const [h, m] = t.split(':').map(Number)
    return h * 60 + (m || 0)
  }

  function clampToOptions(timeStr: string, options: string[]): string {
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

  const options = ['09:00', '09:30', '10:00', '10:30', '11:00', '17:00', '17:30', '18:00']

  it('17:50 → 17:30 (내림)', () => {
    expect(clampToOptions('17:50', options)).toBe('17:30')
  })

  it('18:00 → 18:00 (정확히 일치)', () => {
    expect(clampToOptions('18:00', options)).toBe('18:00')
  })

  it('09:15 → 09:00 (내림)', () => {
    expect(clampToOptions('09:15', options)).toBe('09:00')
  })

  it('09:30 → 09:30 (정확히 일치)', () => {
    expect(clampToOptions('09:30', options)).toBe('09:30')
  })

  it('08:00 → 첫 옵션 09:00 (범위 밖)', () => {
    // 08:00은 모든 옵션보다 이전 → best = options[0]
    expect(clampToOptions('08:00', options)).toBe('09:00')
  })
})

// ═══════════════════════════════════════════════════════════
// NowIndicator: column별 오늘 판정
// ═══════════════════════════════════════════════════════════

describe('NowIndicator column별 오늘 판정', () => {

  function isColumnToday(colDate: string): boolean {
    return colDate === dayjs().format('YYYY-MM-DD')
  }

  it('오늘 날짜 column → true', () => {
    const today = dayjs().format('YYYY-MM-DD')
    expect(isColumnToday(today)).toBe(true)
  })

  it('어제 날짜 column → false', () => {
    const yesterday = dayjs().subtract(1, 'day').format('YYYY-MM-DD')
    expect(isColumnToday(yesterday)).toBe(false)
  })

  it('내일 날짜 column → false', () => {
    const tomorrow = dayjs().add(1, 'day').format('YYYY-MM-DD')
    expect(isColumnToday(tomorrow)).toBe(false)
  })
})
