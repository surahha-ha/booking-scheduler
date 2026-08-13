import { describe, expect, it } from 'vitest'
import dayjs from 'dayjs'
import { useSchedulerRules } from '../useSchedulerRules'

/**
 * DOCTOR_FIRST + FALLBACK 회귀 가드 (2026-06-12).
 * 버그: pickDailySchedule 호출부가 (primary, fallback) 을 넘겨 DOCTOR_FIRST 일 때 인자가 뒤집혀
 *   의사 운영시간이 설정돼 있어도 기관(institution) daily 를 통째로 반환 → 의사 컬럼이 기관 daily 로 대체.
 * 수정: pickDailySchedule(hr, dr) 고정 호출 → 의사 설정 요일은 의사 daily 통째로, 미설정 요일만 기관 fallback.
 *
 * ⚠️ 레이어 경계 (2026-07-13 운영시간 원천 전환 이후):
 *   휴게(점심·저녁)는 이제 **기관만 소유**하고, 같은 요일의 기관 휴게를 **staffStore 단계에서 의사 daily.breaks 에
 *   병합**해 내려준다(workHoursRowToDailySchedule / loadWorkHours — staffStoreWorkHours.test.ts 가 검증).
 *   이 파일이 검증하는 것은 rules 레이어의 계약이다: **rules 는 주어진 daily.breaks 를 그대로 신뢰한다** —
 *   의사 daily 에 휴게가 없으면 기관 휴게를 스스로 끌어다 붙이지 않고, 미설정 요일에서만 기관 daily 로 fallback 한다.
 *   (즉 "기관 점심이 의사에 leak 되지 않는다"가 아니라 "휴게 병합은 rules 의 일이 아니다".)
 */

// 기관(institution): 7요일 동일, 09:00~18:00 + 휴게시간1(점심) 13:00~14:00
function makeHospital() {
  const daily = {
    dayOffYn: 'N' as const,
    open: { start: '09:00', end: '18:00' },
    breaks: [{ start: '13:00', end: '14:00', type: 'LUNCH' }],
    blocks: null,
  }
  const weekly: Record<number, typeof daily> = {}
  for (let wd = 0; wd <= 6; wd++) weekly[wd] = daily
  return { weekly }
}

// 날짜 → 요일(0~6)
const MON = '2026-06-15T00:00:00'
const TUE = '2026-06-16T00:00:00'
const wdMon = dayjs(MON).day()
const wdTue = dayjs(TUE).day()

// 의사 'kim': MON 요일만 설정(09:00~17:00). breaks=null — 즉 "이 의사 daily 에는 휴게가 없다"는 입력.
//   (실서비스에선 staffStore 가 기관 휴게를 여기에 병합해 넣어 준다. 이 파일은 병합 이전/이후를 가리지 않고
//    'rules 는 daily.breaks 를 그대로 쓴다'만 검증하므로 null 입력을 유지한다.)
// TUE 는 미설정 → 기관 fallback.
function makeDoctorRules() {
  return {
    kim: {
      weekly: {
        [wdMon]: {
          dayOffYn: 'N' as const,
          open: { start: '09:00', end: '17:00' },
          breaks: null,
          blocks: null,
        },
      },
    },
  }
}

function setup() {
  return useSchedulerRules({
    hospitalRules: makeHospital() as any,
    doctorRules: makeDoctorRules() as any,
    blockOptions: { lunchBlock: true, blockedTime: true, closedDay: true },
    selectedDoctors: new Set(['kim']),
    cellDuration: 30,
    doctorsRef: [{ id: 'kim', text: '김의사' }],
    options: { priority: 'DOCTOR_FIRST', mergePolicy: 'FALLBACK' },
  })
}

describe('useSchedulerRules — DOCTOR_FIRST + FALLBACK (의사 daily 우선 · 휴게 병합은 rules 밖)', () => {
  it('의사 설정 요일: rules 는 의사 daily.breaks 만 본다 — breaks=null 이면 기관 휴게를 끌어오지 않는다(none)', () => {
    const { getBlockedReason } = setup()
    // 의사 kim 의 daily 에는 휴게가 없다. 버그 시 기관 daily(점심 13:00~14:00)로 대체돼 reason='lunch' 였음.
    // ※ 실서비스에서 의사 컬럼에 휴게가 보이는 것은 staffStore 가 기관 휴게를 daily.breaks 에 넣어 주기 때문이지,
    //   rules 가 기관 daily 를 섞기 때문이 아니다.
    const r = getBlockedReason(`2026-06-15T13:00:00`, 'kim')
    expect(r.reason).toBe('none')
    expect(r.blocked).toBe(false)
  })

  it('의사 daily 에 휴게가 병합돼 오면(staffStore 산출물) 그대로 lunch 로 차단 표시된다', () => {
    // staffStore 가 기관 점심을 의사 daily 에 얹어 준 상태를 그대로 rules 에 먹인 경우.
    const { getBlockedReason } = useSchedulerRules({
      hospitalRules: makeHospital() as any,
      doctorRules: {
        kim: {
          weekly: {
            [wdMon]: {
              dayOffYn: 'N' as const,
              open: { start: '09:00', end: '17:00' },
              breaks: [{ start: '13:00', end: '14:00', type: 'LUNCH' }],
              blocks: null,
            },
          },
        },
      } as any,
      blockOptions: { lunchBlock: true, blockedTime: true, closedDay: true },
      selectedDoctors: new Set(['kim']),
      cellDuration: 30,
      doctorsRef: [{ id: 'kim', text: '김의사' }],
      options: { priority: 'DOCTOR_FIRST', mergePolicy: 'FALLBACK' },
    })
    const r = getBlockedReason(`2026-06-15T13:00:00`, 'kim')
    expect(r.reason).toBe('lunch')
    expect(r.range).toEqual({ start: '13:00', end: '14:00' })
  })

  it('의사 설정 요일: 운영시간은 의사 값(09:00~17:00) 우선 — 17:30 은 기관(18:00)이 아니라 의사 기준 운영시간 외', () => {
    const { getBlockedReason } = setup()
    const r = getBlockedReason(`2026-06-15T17:30:00`, 'kim')
    expect(r.blocked).toBe(true)
    expect(r.reason).toBe('outsideHours')
  })

  it('의사 미설정 요일: 기관(institution)으로 fallback — TUE 13:00 은 기관 점심', () => {
    const { getBlockedReason } = setup()
    const r = getBlockedReason(`2026-06-16T13:00:00`, 'kim')
    expect(wdTue).not.toBe(wdMon)
    expect(r.reason).toBe('lunch')
  })

  it('의사 설정 요일 운영시간 내(10:00)는 차단 없음', () => {
    const { getBlockedReason } = setup()
    const r = getBlockedReason(`2026-06-15T10:00:00`, 'kim')
    expect(r.blocked).toBe(false)
    expect(r.reason).toBe('none')
  })
})

/**
 * 예약 팝업 "운영종료" 오판 회귀 가드 (③, 2026-07-21).
 * 버그: ReservationPopup 저장검증이 getBlockedReason(date) 를 **의사키 없이** 호출 → 선택 의사도 없으면
 *   groupId=null → 의사룰을 못 찾고 기관(hospital)으로 fallback. 기관이 그 요일 미설정이면 의사는
 *   운영시간인데도 outsideHours(운영종료)로 오판(타임라인은 col.resourceId 로 의사시간을 봐서 활성 → 괴리).
 * 수정: 팝업이 클릭 컬럼의 의사키(p.doctorName)를 2번째 인자로 전달.
 */
describe('useSchedulerRules — 예약 팝업 운영종료 오판 회귀 (③)', () => {
  // 기관은 전 요일 미설정, 의사 kim 만 TUE 09:00~18:00 설정. '전체' 보기(단일선택 아님).
  function setupDoctorOnly() {
    return useSchedulerRules({
      hospitalRules: { weekly: {} } as any,
      doctorRules: {
        kim: { weekly: { [wdTue]: { dayOffYn: 'N' as const, open: { start: '09:00', end: '18:00' }, breaks: null, blocks: null } } },
      } as any,
      blockOptions: { lunchBlock: true, blockedTime: true, closedDay: true },
      selectedDoctors: new Set(),
      cellDuration: 30,
      doctorsRef: [{ id: 'kim', text: '김의사' }],
      options: { priority: 'DOCTOR_FIRST', mergePolicy: 'FALLBACK' },
    })
  }

  it('의사키 생략 → 기관(미설정) fallback → 운영종료(outsideHours) [버그 재현]', () => {
    const { getBlockedReason } = setupDoctorOnly()
    const r = getBlockedReason(`2026-06-16T10:00:00`, undefined)
    expect(r.blocked).toBe(true)
    expect(r.reason).toBe('outsideHours')
  })

  it('의사키 전달 → 의사 운영시간(09~18) 기준 → 차단 없음 [수정 후]', () => {
    const { getBlockedReason } = setupDoctorOnly()
    const r = getBlockedReason(`2026-06-16T10:00:00`, 'kim')
    expect(r.blocked).toBe(false)
    expect(r.reason).toBe('none')
  })
})
