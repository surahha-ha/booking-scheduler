import { describe, expect, it } from 'vitest'
import { runLayout, weekdayOf } from '../redesign/layoutPipeline'
import type {
  ApptSource,
  DailyScheduleSource,
  DoctorSource,
  WorkHoursRowSource,
  TeamSource,
} from '../redesign/runLayoutAdapter'
import {
  buildRunLayoutInput,
  colonHmToMin,
  dailyScheduleToUnitHours,
  dateToMinOfDay,
  dateToYmd,
  hhmmToMin,
  workRowToUnitHours,
  resolveDoctorKey,
} from '../redesign/runLayoutAdapter'

const WD = weekdayOf('2026-06-01')

function appt(id: string, doctorName: string, h: number, m: number, endH: number, endM: number, doctorId?: string): ApptSource {
  return {
    id,
    doctorName,
    doctorId,
    startDateTime: new Date(2026, 5, 1, h, m),
    endDateTime: new Date(2026, 5, 1, endH, endM),
  }
}
/** 담당자 요일 1행 — 진료 시작~종료 단일 구간("HHmm"). 휴게 필드 없음(기관 소유). */
function workRow(dayCd: number, over: Partial<WorkHoursRowSource> = {}): WorkHoursRowSource {
  return {
    dayCd,
    staffOpenHm: null, staffCloseHm: null,
    ...over,
  }
}
/** 기관 DailySchedule("HH:MM") — 담당자 세션 분할에 쓰이는 휴게 소스. */
type Brk = { start: string, end: string, type: 'LUNCH' | 'DINNER' | 'CLOSED' }
function instDay(open: { start: string, end: string }, ...breaks: Brk[]): DailyScheduleSource {
  return { dayOffYn: 'N', open, breaks }
}
const baseSettings = { slotUnitMinutes: 30, totalColumnCount: 8, displayInfo: ['NAME'] }
const baseView = { dataType: 'APPOINTMENT' as const, selectedDate: '2026-06-01', viewStep: 3, slotDivision: 2 }
const baseEnv = { availableWidth: 1200 }

// ════════════════════════════════════════════════════════════
describe('시간/날짜 변환', () => {
  it('colonHmToMin / hhmmToMin', () => {
    expect(colonHmToMin('09:00')).toBe(540)
    expect(colonHmToMin('13:30')).toBe(810)
    expect(colonHmToMin('bad')).toBeNull()
    expect(hhmmToMin('0900')).toBe(540)
    expect(hhmmToMin('1805')).toBe(1085)
    expect(hhmmToMin(null)).toBeNull()
  })
  it('dateToYmd / dateToMinOfDay (로컬)', () => {
    expect(dateToYmd(new Date(2026, 5, 1, 9, 0))).toBe('2026-06-01')
    expect(dateToYmd(new Date(2026, 0, 31, 0, 0))).toBe('2026-01-31')
    expect(dateToMinOfDay(new Date(2026, 5, 1, 9, 30))).toBe(570)
  })
})

describe('resolveDoctorKey — 조인 키 추상화', () => {
  it('현재: 이름. 미래: doctorId 우선', () => {
    expect(resolveDoctorKey(appt('a', '김의사', 9, 0, 9, 30))).toBe('김의사')
    expect(resolveDoctorKey(appt('a', '김의사', 9, 0, 9, 30, '101'))).toBe('101')
    expect(resolveDoctorKey(appt('a', '김의사', 9, 0, 9, 30, ''))).toBe('김의사') // 빈 ID 폴백
  })
})

// 기관 weekly(DailySchedule) → UnitHours. 기관은 open 단일 구간 + 휴게(점심/저녁)를 소유한다.
describe('dailyScheduleToUnitHours — 기관 open 을 휴게로 split', () => {
  it('open + 점심 → morning/afternoon + lunch 라벨', () => {
    const h = dailyScheduleToUnitHours({
      open: { start: '09:00', end: '18:00' },
      breaks: [{ start: '12:00', end: '13:00', type: 'LUNCH' }],
    })
    expect(h.morning).toEqual({ start: 540, end: 720 })
    expect(h.afternoon).toEqual({ start: 780, end: 1080 })
    expect(h.lunch).toEqual({ start: 720, end: 780 })
    expect(h.night).toBeUndefined()
  })
  it('open + 점심 + 저녁 → 3세션 + 두 휴게', () => {
    const h = dailyScheduleToUnitHours({
      open: { start: '09:00', end: '21:00' },
      breaks: [
        { start: '12:00', end: '13:00', type: 'LUNCH' },
        { start: '18:00', end: '19:00', type: 'DINNER' },
      ],
    })
    expect(h.morning).toEqual({ start: 540, end: 720 })
    expect(h.afternoon).toEqual({ start: 780, end: 1080 })
    expect(h.night).toEqual({ start: 1140, end: 1260 })
    expect(h.dinner).toEqual({ start: 1080, end: 1140 })
  })
  it('[레거시 가드] CLOSED break → 세션은 분리하되 lunch/dinner 미생성(=운영종료)', () => {
    // ⚠️ CLOSED 는 3세션 시절 "OFF 된 세션이 만든 gap" 이었다. 진료가 시작~종료 단일 구간이 된 뒤로는
    //    새 데이터에서 생성되지 않는다(staffStore 가 안 만든다). 타입·소비 코드는 남아 있으므로 소비 경로만 가드.
    // open 09~21, 13:00~18:30 = CLOSED. 세션 morning(09~13)+night(18:30~21)로 분리되고
    // h.lunch/h.dinner 는 없어야 함 → 엔진이 13:00~18:30 을 비운영(운영종료) 음영으로 처리.
    const h = dailyScheduleToUnitHours({
      open: { start: '09:00', end: '21:00' },
      breaks: [{ start: '13:00', end: '18:30', type: 'CLOSED' }],
    })
    expect(h.morning).toEqual({ start: 540, end: 780 })
    expect(h.afternoon).toEqual({ start: 1110, end: 1260 }) // 두 번째 세션(야간)이 slot index 로 afternoon 에 들어감(엔진은 라벨 무관)
    expect(h.lunch).toBeUndefined()
    expect(h.dinner).toBeUndefined()
  })
  it('open 없음 → 빈', () => {
    expect(dailyScheduleToUnitHours({ dayOffYn: 'Y' })).toEqual({})
    expect(dailyScheduleToUnitHours(undefined)).toEqual({})
  })
})

// 담당자는 진료 시작~종료 단일 구간이고 휴게를 소유하지 않는다.
// 세션은 **같은 요일의 기관 휴게**(institutionDay)를 빼서 나뉜다 → 의사 컬럼에도 휴게 음영이 그려진다.
describe('workRowToUnitHours — 담당자 단일구간 + 기관 휴게', () => {
  it('의사 09~18 + 기관 점심 13~14 → morning(09~13)/afternoon(14~18) 로 갈리고 lunch 라벨이 붙는다', () => {
    const h = workRowToUnitHours(
      workRow(1, { staffOpenHm: '0900', staffCloseHm: '1800' }),
      instDay({ start: '09:00', end: '18:00' }, { start: '13:00', end: '14:00', type: 'LUNCH' }),
    )
    expect(h.morning).toEqual({ start: 540, end: 780 })
    expect(h.afternoon).toEqual({ start: 840, end: 1080 })
    expect(h.lunch).toEqual({ start: 780, end: 840 })
    expect(h.night).toBeUndefined()
  })

  it('기관 점심+저녁 → 3세션 + 휴게 2개 라벨', () => {
    const h = workRowToUnitHours(
      workRow(1, { staffOpenHm: '0900', staffCloseHm: '2100' }),
      instDay(
        { start: '09:00', end: '21:00' },
        { start: '13:00', end: '14:00', type: 'LUNCH' },
        { start: '18:00', end: '19:00', type: 'DINNER' },
      ),
    )
    expect(h.morning).toEqual({ start: 540, end: 780 })
    expect(h.afternoon).toEqual({ start: 840, end: 1080 })
    expect(h.night).toEqual({ start: 1140, end: 1260 })
    expect(h.lunch).toEqual({ start: 780, end: 840 })
    expect(h.dinner).toEqual({ start: 1080, end: 1140 })
  })

  it('기관 휴게가 없으면 단일 구간 통짜 — morning 하나', () => {
    const h = workRowToUnitHours(
      workRow(1, { staffOpenHm: '0900', staffCloseHm: '1800' }),
      instDay({ start: '09:00', end: '18:00' }),
    )
    expect(h.morning).toEqual({ start: 540, end: 1080 })
    expect(h.afternoon).toBeUndefined()
    expect(h.lunch).toBeUndefined()

    // 기관 행 자체가 없는 요일도 동일
    const noInst = workRowToUnitHours(workRow(1, { staffOpenHm: '0900', staffCloseHm: '1800' }))
    expect(noInst.morning).toEqual({ start: 540, end: 1080 })
    expect(noInst.afternoon).toBeUndefined()
  })

  it('의사 운영시간 밖 휴게는 세션을 쪼개지 못한다 — 의사 09~13 + 기관 점심 13~14 → 세션 1개(09~13)', () => {
    const h = workRowToUnitHours(
      workRow(1, { staffOpenHm: '0900', staffCloseHm: '1300' }),
      instDay({ start: '09:00', end: '18:00' }, { start: '13:00', end: '14:00', type: 'LUNCH' }),
    )
    expect(h.morning).toEqual({ start: 540, end: 780 })
    expect(h.afternoon).toBeUndefined()
    // ⚠️ lunch 는 세션 분할이 아니라 "비운영 band 라벨" 전용 필드다(layoutPipeline.computeOperatingRange).
    //    운영시간 밖이라 timeline union 에 들지 않으므로 라벨이 남아도 그려지지 않는다.
    //    → 예약 가능/차단 판정은 세션(morning/afternoon/night)만 본다: 09~13 만 운영.
    expect(h.lunch).toEqual({ start: 780, end: 840 })
  })

  it('부분 겹침 휴게 — 의사 09~13:30 + 점심 13~14 → 세션 09~13 하나(13:00~13:30 은 휴게로 소비)', () => {
    const h = workRowToUnitHours(
      workRow(1, { staffOpenHm: '0900', staffCloseHm: '1330' }),
      instDay({ start: '09:00', end: '18:00' }, { start: '13:00', end: '14:00', type: 'LUNCH' }),
    )
    expect(h.morning).toEqual({ start: 540, end: 780 })
    expect(h.afternoon).toBeUndefined()
  })

  it('시작/종료 null(그 요일 휴무) → 빈 UnitHours', () => {
    expect(workRowToUnitHours(workRow(1), instDay({ start: '09:00', end: '18:00' }))).toEqual({})
    expect(workRowToUnitHours(workRow(1, { staffOpenHm: '0900' }))).toEqual({}) // 한쪽만 있는 중간 상태
    expect(workRowToUnitHours(undefined)).toEqual({})
  })
})

// ════════════════════════════════════════════════════════════
describe('buildRunLayoutInput — name 모드', () => {
  const doctors: DoctorSource[] = [{ id: '김의사', text: '김의사' }, { id: '이의사', text: '이의사' }]
  const weekly = { [WD]: { open: { start: '09:00', end: '18:00' }, breaks: [{ start: '12:00', end: '13:00', type: 'LUNCH' as const }] } }

  it('이름으로 그룹핑 + hoursByWeekday + 의사 매핑', () => {
    const input = buildRunLayoutInput({
      mode: { kind: 'name' },
      settings: baseSettings,
      viewState: baseView,
      env: baseEnv,
      doctors,
      appts: [appt('a1', '김의사', 9, 0, 9, 30), appt('b1', '이의사', 10, 0, 10, 30)],
      weekly,
    })
    expect(input.doctors).toEqual([{ id: '김의사', name: '김의사' }, { id: '이의사', name: '이의사' }])
    expect(input.apptsByUnitKey['2026-06-01__김의사']).toEqual([{ id: 'a1', startMin: 540, endMin: 570 }])
    expect(input.apptsByUnitKey['2026-06-01__이의사'][0].id).toBe('b1')
    expect(input.site.hoursByWeekday[WD].morning).toEqual({ start: 540, end: 720 })
    expect(input.site.hoursByDoctor).toEqual({})
  })

  it('doctorWeeklyById 주입 → hoursByDoctor 채움(담당자 우선), 미주입 의사는 키 부재(기관 fallback)', () => {
    const input = buildRunLayoutInput({
      mode: { kind: 'name' },
      settings: baseSettings,
      viewState: baseView,
      env: baseEnv,
      doctors,
      appts: [],
      weekly,
      // 김의사만 담당자 운영시간 08:00~14:00(점심 12~13). 이의사는 미설정.
      doctorWeeklyById: {
        김의사: { [WD]: instDay({ start: '08:00', end: '14:00' }, { start: '12:00', end: '13:00', type: 'LUNCH' }) },
      },
    })
    // 김의사: 담당자 시간이 밴드 소스로 주입됨(기관 09~18 과 구분되는 08~12 / 13~14).
    expect(input.site.hoursByDoctor['김의사'][WD].morning).toEqual({ start: 480, end: 720 })
    expect(input.site.hoursByDoctor['김의사'][WD].afternoon).toEqual({ start: 780, end: 840 })
    // 이의사: doctorWeeklyById 에 없음 → hoursByDoctor 키 부재 → 엔진이 hoursByWeekday(기관)로 fallback.
    expect(input.site.hoursByDoctor['이의사']).toBeUndefined()
    // 기관 hoursByWeekday 는 그대로.
    expect(input.site.hoursByWeekday[WD].morning).toEqual({ start: 540, end: 720 })
  })

  it('end-to-end: runLayout 으로 rect 생성', () => {
    const input = buildRunLayoutInput({
      mode: { kind: 'name' },
      settings: baseSettings,
      viewState: baseView,
      env: baseEnv,
      doctors,
      appts: [appt('a1', '김의사', 9, 0, 9, 30), appt('b1', '이의사', 10, 0, 10, 30)],
      weekly,
      horizonDays: 1,
    })
    const result = runLayout(input)
    expect(result.columns).toHaveLength(2)
    expect(result.rects.map(r => r.id).sort()).toEqual(['a1', 'b1'])
  })
})

describe('buildRunLayoutInput — team 모드 (이름 필터 + staffId 식별자)', () => {
  const team: TeamSource = { id: 1, name: 'A팀', doctors: [{ staffId: 101, staffName: '김의사' }, { staffId: 102, staffName: '이의사' }] }
  // 담당자는 단일 구간(09~18). 휴게는 기관 weekly 에서 온다.
  const workHoursByStaffId = {
    101: [workRow(WD, { staffOpenHm: '0900', staffCloseHm: '1800' })],
    102: [workRow(WD, { staffOpenHm: '0900', staffCloseHm: '1300' })], // 오전만 → 기관 점심이 운영시간 밖
  } as Record<string, WorkHoursRowSource[]>
  // 기관: 09~18, 점심 13~14
  const instWeekly = { [WD]: instDay({ start: '09:00', end: '18:00' }, { start: '13:00', end: '14:00', type: 'LUNCH' }) }

  it('멤버는 staffId 키, 비멤버 예약은 제외', () => {
    const input = buildRunLayoutInput({
      mode: { kind: 'team', team },
      settings: baseSettings,
      viewState: baseView,
      env: baseEnv,
      doctors: [],
      appts: [
        appt('a1', '김의사', 9, 0, 9, 30),
        appt('b1', '이의사', 10, 0, 10, 30),
        appt('c1', '박의사', 11, 0, 11, 30), // 팀 비소속 → 제외
      ],
      workHoursByStaffId,
      weekly: instWeekly,
    })
    expect(input.doctors).toEqual([{ id: '101', name: '김의사' }, { id: '102', name: '이의사' }])
    expect(input.apptsByUnitKey['2026-06-01__101'][0].id).toBe('a1')
    expect(input.apptsByUnitKey['2026-06-01__102'][0].id).toBe('b1')
    // 박의사(c1) 는 어떤 키에도 없음
    expect(Object.keys(input.apptsByUnitKey)).toHaveLength(2)
    // 담당자별·요일별 운영시간 — 기관 점심(13~14)이 의사 세션을 가른다
    expect(input.site.hoursByDoctor['101'][WD].morning).toEqual({ start: 540, end: 780 })
    expect(input.site.hoursByDoctor['101'][WD].afternoon).toEqual({ start: 840, end: 1080 })
    expect(input.site.hoursByDoctor['101'][WD].lunch).toEqual({ start: 780, end: 840 })
  })

  it('의사 운영시간이 기관 휴게 전에 끝나면 세션은 하나 — 오전만 진료(09~13)', () => {
    const input = buildRunLayoutInput({
      mode: { kind: 'team', team },
      settings: baseSettings,
      viewState: baseView,
      env: baseEnv,
      doctors: [],
      appts: [],
      workHoursByStaffId,
      weekly: instWeekly,
    })
    expect(input.site.hoursByDoctor['102'][WD].morning).toEqual({ start: 540, end: 780 })
    expect(input.site.hoursByDoctor['102'][WD].afternoon).toBeUndefined()
  })

  it('end-to-end: team 모드 runLayout → 멤버 예약만 rect', () => {
    const input = buildRunLayoutInput({
      mode: { kind: 'team', team },
      settings: baseSettings,
      viewState: baseView,
      env: baseEnv,
      doctors: [],
      appts: [appt('a1', '김의사', 9, 0, 9, 30), appt('c1', '박의사', 11, 0, 11, 30)],
      workHoursByStaffId,
      weekly: instWeekly,
      horizonDays: 1,
    })
    const result = runLayout(input)
    // 컬럼은 팀 멤버 2명, 박의사 예약(c1) 은 제외 → rect 는 a1 만
    expect(result.columns.map(c => c.unit.doctorId)).toEqual(['101', '102'])
    expect(result.rects.map(r => r.id)).toEqual(['a1'])
  })
})
