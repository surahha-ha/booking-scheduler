/**
 * boardStatistics — 상태 칩·회원 숫자를 "화면에 그려진 칸의 예약"에서 세는 규칙.
 *
 * 카드는 엔진이 unit 키(`날짜__담당자키`)로 칸에 놓는다. 집계도 같은 키로 예약을 고르므로 두 수가 정의상 같다.
 * 상태 필터도 같은 자리에서 — 목록은 모든 상태를 받고, 카드가 보이는 상태(toDisplayStatus)로 거른다.
 *
 * 기대값 출처: boardStatistics.ts 주석 + 상수 주석(예약 00 · 취소 03 · 진료완료 01 · 미이행 02 · 접수대기 05) +
 * toDisplayStatus 규칙(예약장부는 00·03 만 구분, 나머지는 예약으로 표기).
 */

import { describe, expect, it } from 'vitest'

import { countBoardStatistics, filterByStatus } from '../boardStatistics'
import { unitKeyOf } from '@/scheduler-engine/redesign/runLayoutAdapter'

function appt(id: string, ymd: string, doctorName: string, status: string, memberYn = 'N') {
  return {
    id,
    startDateTime: new Date(`${ymd}T10:00:00`),
    endDateTime: new Date(`${ymd}T10:30:00`),
    doctorName,
    doctorId: '',
    status,
    memberYn: memberYn,
  }
}

const D1 = '2026-09-07'
const D2 = '2026-09-08'
const D3 = '2026-09-10' // 조회 창 안이지만 화면에는 없는 날짜

const appts = [
  appt('1', D1, '김원장', '00', 'Y'),
  appt('2', D1, '김원장', '03'),
  appt('3', D1, '김원장', '01'), // 진료완료 — 예약장부에서는 '예약'으로 그려진다
  appt('4', D2, '김원장', '00'),
  appt('5', D1, '박원장', '00'), // 화면에 없는 담당자(경계 칸 밖)
  appt('6', D3, '김원장', '03'), // 화면에 없는 날짜(창 안)
]

/** 페이지 컬럼 = 김원장 9/7·9/8 만 보이는 화면 */
const visible = [`${D1}__김원장`, `${D2}__김원장`]

describe('countBoardStatistics', () => {
  it('그려진 칸의 예약만 센다 — 창 안이어도 화면에 없는 날짜·담당자는 빠진다', () => {
    const s = countBoardStatistics(appts, visible, 'APPOINTMENT')
    expect(s.state['전체']).toBe(4) // 1,2,3,4
  })

  it('예약장부는 카드가 보이는 상태로 센다 — 진료완료(01)는 예약 칩에 든다', () => {
    const s = countBoardStatistics(appts, visible, 'APPOINTMENT')
    expect(s.state).toEqual({ 전체: 4, 예약: 3, 취소: 1 })
  })

  it('진료장부는 실제 상태로 센다 — 00(예약)은 칩이 없어 전체에만 든다', () => {
    const s = countBoardStatistics(appts, visible, 'TREATMENT')
    // 칩 라벨은 용어 사전(ko.json terms.status)의 값 — 05 대기 · 01 완료
    expect(s.state).toEqual({ 전체: 4, 대기: 0, 완료: 1, 미이행: 0, 취소: 1 })
  })

  it('회원 여부는 카드 뱃지와 같은 규칙 — 여부 Y 또는 회원번호 보유', () => {
    const s = countBoardStatistics(appts, visible, 'APPOINTMENT')
    expect(s.member).toEqual({ Y: 1, N: 3 })

    // 회원번호만 있고 여부가 N 인 건 — 카드는 회원 뱃지를 달므로 숫자도 회원으로 센다(리뷰 F4).
    const withNo = [{ ...appt('7', D1, '김원장', '00', 'N'), memberNo: 12345 }]
    expect(countBoardStatistics(withNo, visible, 'APPOINTMENT').member).toEqual({ Y: 1, N: 0 })
  })

  it('칸이 없으면(담당자 로드 전) 모든 칩이 0 으로 깔린다', () => {
    expect(countBoardStatistics(appts, [], 'APPOINTMENT')).toEqual({
      state: { 전체: 0, 예약: 0, 취소: 0 },
      member: { Y: 0, N: 0 },
    })
  })

  it('칸 키 규칙은 엔진(unitKeyOf)과 한 벌이다 — 규칙이 갈리면 카드는 있는데 숫자에서 빠진다', () => {
    const only = [appt('9', D1, '김원장', '00')]
    expect(countBoardStatistics(only, [unitKeyOf(only[0])], 'APPOINTMENT').state['전체']).toBe(1)
  })
})

describe('filterByStatus', () => {
  it('빈 선택은 전체', () => {
    expect(filterByStatus(appts, [], 'APPOINTMENT')).toBe(appts)
  })

  it('예약장부 "예약" 필터는 진료완료(01)도 통과시킨다 — 카드가 예약으로 보이는 것과 같은 규칙', () => {
    const ids = filterByStatus(appts, ['APPOINTMENT'], 'APPOINTMENT').map(a => a.id)
    expect(ids).toEqual(['1', '3', '4', '5'])
  })

  it('진료장부 "진료완료" 필터는 01 만', () => {
    const ids = filterByStatus(appts, ['COMPLETE'], 'TREATMENT').map(a => a.id)
    expect(ids).toEqual(['3'])
  })

  it('필터로 숨겨도 집계는 상태 무관 목록으로 세므로 숨긴 상태의 숫자가 남는다', () => {
    const shown = filterByStatus(appts, ['CANCEL'], 'APPOINTMENT')
    const s = countBoardStatistics(appts, visible, 'APPOINTMENT')
    expect(shown.filter(a => visible.includes(unitKeyOf(a))).length).toBe(s.state['취소'])
    expect(s.state['예약']).toBe(3)
  })
})
