/**
 * 스케줄러 인터랙션 / 상태 검증 테스트
 *
 * drag/resize/popover의 데이터 레벨 검증.
 * DOM/이벤트는 브라우저 수동 확인.
 */

import { describe, it, expect } from 'vitest'
import { snapMinute, DEFAULT_SNAP_CONFIG } from '../schedulerSnapGrid'
import { clampToOptions } from '@/components/popup/reservationTimeRules'

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

// 25. 과거 시간 판정(isPastDateTime) 은 폐기됐다 — 지난 시간대로의 이동을 더는 막지 않는다
//     (TC 003-03 v0.3, 지난 예약의 시각 보정 허용). 판정 함수 자체가 없어져 검증할 대상도 없다.

// 34-35. dotMenuButtons 구성 → pages/desktop/scheduler/__tests__/appointmentCardMenu.test.ts
// (엔진이 아니라 UI 메뉴 정의라 소유 모듈 옆에서 검증한다)

// ═══════════════════════════════════════════════════════════
// 36. quickActionLabel 분기
// ═══════════════════════════════════════════════════════════

describe('quickActionLabel', () => {

  function getQuickActionLabel(isAppointment: boolean, status: string): string | null {
    if (isAppointment) return null
    if (status === '00') return '대기'
    if (status === '05') return '완료'
    return null
  }

  it('예약 화면 → null', () => {
    expect(getQuickActionLabel(true, '00')).toBeNull()
  })

  it('방문 상태 00 → 대기', () => {
    expect(getQuickActionLabel(false, '00')).toBe('대기')
  })

  it('방문 상태 05 → 완료', () => {
    expect(getQuickActionLabel(false, '05')).toBe('완료')
  })

  it('방문 상태 01 → null', () => {
    expect(getQuickActionLabel(false, '01')).toBeNull()
  })

  it('방문 상태 02 → null', () => {
    expect(getQuickActionLabel(false, '02')).toBeNull()
  })

  it('방문 상태 03 → null', () => {
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

// 드래그·resize 가 쓰는 실물 snapMinute(schedulerSnapGrid). 기본 설정 = 예약 단위 30분, 세밀 모드 없음.
describe('snap 30분 단위', () => {

  const snap = (rawMinute: number) => snapMinute(rawMinute, DEFAULT_SNAP_CONFIG)

  it('17:50 → 18:00 (반올림)', () => {
    expect(snap(1070)).toBe(1080)
  })

  it('17:40 → 17:30 (반올림)', () => {
    expect(snap(1060)).toBe(1050)
  })

  it('17:45 → 18:00 (반올림, 정확히 중간)', () => {
    expect(snap(1065)).toBe(1080)
  })

  it('09:00 → 09:00 (정확히 경계)', () => {
    expect(snap(540)).toBe(540)
  })

  it('09:14 → 09:00 (내림)', () => {
    expect(snap(554)).toBe(540)
  })

  it('09:15 → 09:30 (정확히 중간 → 올림)', () => {
    expect(snap(555)).toBe(570)
  })
})

// ═══════════════════════════════════════════════════════════
// clampToOptions (30분 내림) 검증
// ═══════════════════════════════════════════════════════════

// 예약 팝업이 쓰는 실물 clampToOptions(reservationTimeRules).
describe('clampToOptions (30분 내림)', () => {

  const options =['09:00', '09:30', '10:00', '10:30', '11:00', '17:00', '17:30', '18:00']

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

// NowIndicator column별 오늘 판정 → pages/desktop/scheduler/components/__tests__/nowIndicatorToday.test.ts
// (컴포넌트 내부 함수라 마운트로 실물을 실행한다 — 여기 있던 사본은 프로덕션 코드를 한 줄도 돌리지 않았다)
