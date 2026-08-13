import { describe, expect, it } from 'vitest'
import type { CardInput } from '../redesign/layoutCore'
import type {
  EnvInput,
  FilterInput,
  SiteInput,
  ReservationSettingsInput,
  ViewStateInput,
} from '../redesign/layoutTypes'
import { arrangeCards } from '../redesign/layoutCore'
import type { PerUnitCards, RectColumn } from '../redesign/layoutPipeline'
import type { BandSpec, Unit, UnitHours } from '../redesign/layoutTypes'
import {
  addDays,
  buildUnitSequence,
  computeBandHeights,
  computeColumnPixels,
  computeOperatingRange,
  computeRects,
  deriveLayoutConfig,
  resolveUnitHours,
  runLayout,
  weekdayOf,
} from '../redesign/layoutPipeline'

// ── 공통 fixture 빌더 ──
function baseSettings(over: Partial<ReservationSettingsInput> = {}): ReservationSettingsInput {
  return { slotUnitMinutes: 30, totalColumnCount: 8, displayInfo: ['NAME', 'PHONE'], ...over }
}
function baseSite(over: Partial<SiteInput> = {}): SiteInput {
  return { ...over }
}
function baseView(over: Partial<ViewStateInput> = {}): ViewStateInput {
  return {
    dataType: 'APPOINTMENT',
    selectedDate: '2026-06-01',
    viewStep: 3,
    slotDivision: 2,
    ...over,
  }
}
const baseFilter: FilterInput = {}
const baseEnv: EnvInput = { availableWidth: 1200 }

function derive(
  s: Partial<ReservationSettingsInput> = {},
  v: Partial<ViewStateInput> = {},
  f: FilterInput = baseFilter,
  m: Partial<SiteInput> = {},
) {
  return deriveLayoutConfig(baseSettings(s), baseSite(m), baseView(v), f, baseEnv)
}

// ════════════════════════════════════════════════════════════
describe('deriveLayoutConfig — 정규화/경계검증', () => {
  it('정상 입력: 정규화된 config 산출 + warnings 비어있음', () => {
    const cfg = derive()
    expect(cfg.cellDuration).toBe(30)
    expect(cfg.totalColumns).toBe(8)
    expect(cfg.viewStep).toBe(3)
    expect(cfg.budget).toBe(8) // 8 + 2×(3-3)
    expect(cfg.slotDivision).toBe(2)
    expect(cfg.warnings).toEqual([])
  })

  it('slotUnitMinutes → cellDuration 매핑', () => {
    expect(derive({ slotUnitMinutes: 10, cellDuration: undefined }).cellDuration).toBe(10)
  })

  it('15분 단위도 cellDuration 으로 허용', () => {
    expect(derive({ slotUnitMinutes: 15, cellDuration: undefined }).cellDuration).toBe(15)
  })

  it('cellDuration 우선순위가 slotUnitMinutes 보다 높음', () => {
    expect(derive({ slotUnitMinutes: 30, cellDuration: 60 }).cellDuration).toBe(60)
  })

  it('잘못된 cellDuration → 기본값 30 + warning', () => {
    const cfg = derive({ slotUnitMinutes: 25 })
    expect(cfg.cellDuration).toBe(30)
    expect(cfg.warnings.some(w => w.includes('cellDuration'))).toBe(true)
  })

  it('totalColumns 범위 밖 → [6,10] clamp + warning', () => {
    expect(derive({ totalColumnCount: 20 }).totalColumns).toBe(10)
    expect(derive({ totalColumnCount: 3 }).totalColumns).toBe(6)
    expect(derive({ totalColumnCount: 20 }).warnings.some(w => w.includes('totalColumns'))).toBe(true)
  })

  it('budget = clamp(totalColumns + 2×(3-viewStep), 2, 14)', () => {
    expect(derive({ totalColumnCount: 8 }, { viewStep: 1 }).budget).toBe(12) // 8+4
    expect(derive({ totalColumnCount: 8 }, { viewStep: 5 }).budget).toBe(4) // 8-4
    expect(derive({ totalColumnCount: 6 }, { viewStep: 5 }).budget).toBe(2) // 6-4
    expect(derive({ totalColumnCount: 10 }, { viewStep: 1 }).budget).toBe(14) // 10+4
  })

  it('viewStep 범위 밖 → [1,5] clamp + warning', () => {
    const cfg = derive({}, { viewStep: 9 })
    expect(cfg.viewStep).toBe(5)
    expect(cfg.warnings.some(w => w.includes('viewStep'))).toBe(true)
  })

  it('rowHeightLevel 미존재 → 기본값 3', () => {
    expect(derive().rowHeightLevel).toBe(3)
    expect(derive({ cardHeightLevel: 5 }).rowHeightLevel).toBe(5)
    expect(derive({ cardHeightLevel: 9 }).rowHeightLevel).toBe(5) // clamp
  })

  it('displayInfo: 비면 [NAME], NAME 선두, 중복 제거, 입력(BE 영속) 순서 보존', () => {
    expect(derive({ displayInfo: [] }).displayInfo).toEqual(['NAME'])
    // BE 가 DISP_ITEM_ORD 로 순서를 영속 → 입력 순서 그대로(PHONE 가 AGE 앞). NAME 만 선두로 끌어올림.
    expect(derive({ displayInfo: ['PHONE', 'AGE'] }).displayInfo).toEqual(['NAME', 'PHONE', 'AGE'])
    expect(derive({ displayInfo: ['NAME', 'PHONE', 'PHONE'] }).displayInfo).toEqual(['NAME', 'PHONE'])
    // 사용자가 전화번호→서비스 항목 순으로 지정했으면 그 순서 유지
    expect(derive({ displayInfo: ['PHONE', 'TREATMENT'] }).displayInfo).toEqual(['NAME', 'PHONE', 'TREATMENT'])
  })

  it('slotDivision/doctorPageIdx 하한 보정', () => {
    expect(derive({}, { slotDivision: 0 }).slotDivision).toBe(1)
    expect(derive({}, { doctorPageIdx: -3 }).doctorPageIdx).toBe(0)
  })

  it('selectedDoctorIds/customSlots 기본값', () => {
    const cfg = derive()
    expect(cfg.selectedDoctorIds).toEqual([])
    expect(cfg.customSlots).toEqual({})
  })

  it('잘못된 selectedDate 형식 → warning (값은 보존)', () => {
    const cfg = derive({}, { selectedDate: '2026/06/01' })
    expect(cfg.selectedDate).toBe('2026/06/01')
    expect(cfg.warnings.some(w => w.includes('selectedDate'))).toBe(true)
  })
})

// ════════════════════════════════════════════════════════════
describe('날짜 유틸', () => {
  it('addDays — 월 경계 넘김', () => {
    expect(addDays('2026-06-01', 0)).toBe('2026-06-01')
    expect(addDays('2026-06-30', 1)).toBe('2026-07-01')
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01')
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
  })

  it('weekdayOf — 연속일은 (전일+1)%7', () => {
    const d = '2026-06-01'
    expect(weekdayOf(addDays(d, 1))).toBe((weekdayOf(d) + 1) % 7)
    expect(weekdayOf(addDays(d, 7))).toBe(weekdayOf(d))
    expect(weekdayOf(d)).toBeGreaterThanOrEqual(0)
    expect(weekdayOf(d)).toBeLessThanOrEqual(6)
  })
})

// ════════════════════════════════════════════════════════════
describe('buildUnitSequence — (날짜,의사) 시퀀스 + slots', () => {
  const doctors = [
    { id: 'A', name: '김의사' },
    { id: 'B', name: '이의사' },
    { id: 'C', name: '박의사' },
  ]

  it('TREATMENT: selectedDate 1일 × 의사', () => {
    const cfg = deriveLayoutConfig(baseSettings(), baseSite(), baseView({ dataType: 'TREATMENT' }), baseFilter, baseEnv)
    const units = buildUnitSequence(cfg, doctors, {})
    expect(units).toHaveLength(3)
    expect(units.every(u => u.date === '2026-06-01')).toBe(true)
    expect(units.map(u => u.doctorId)).toEqual(['A', 'B', 'C'])
  })

  it('APPOINTMENT: forward horizon × 의사, 날짜-major 순서', () => {
    const cfg = derive()
    const units = buildUnitSequence(cfg, doctors, {}, { horizonDays: 2 })
    expect(units).toHaveLength(6) // 2일 × 3의사
    expect(units.map(u => u.key)).toEqual([
      '2026-06-01__A', '2026-06-01__B', '2026-06-01__C',
      '2026-06-02__A', '2026-06-02__B', '2026-06-02__C',
    ])
  })

  it('의사 필터 적용 ([] = 전체)', () => {
    const cfg = derive({}, {}, { selectedDoctorIds: ['B'] })
    const units = buildUnitSequence(cfg, doctors, {}, { horizonDays: 1 })
    expect(units.map(u => u.doctorId)).toEqual(['B'])
  })

  it('slots = max(1, min(maxConcurrent, slotDivision)); 빈 unit → 1', () => {
    const cfg = derive({}, { slotDivision: 2 }) // N칸=2
    // A: 3중 겹침 → min(3,2)=2 / B: 겹침 없음 1건 → min(1,2)=1 / C: 빈 → 1
    const appts: Record<string, CardInput[]> = {
      '2026-06-01__A': [
        { id: 'a1', startMin: 540, endMin: 570 },
        { id: 'a2', startMin: 550, endMin: 580 },
        { id: 'a3', startMin: 560, endMin: 590 },
      ],
      '2026-06-01__B': [{ id: 'b1', startMin: 540, endMin: 570 }],
    }
    const units = buildUnitSequence(cfg, doctors, appts, { horizonDays: 1 })
    const byId = Object.fromEntries(units.map(u => [u.doctorId, u.slots]))
    expect(byId.A).toBe(2)
    expect(byId.B).toBe(1)
    expect(byId.C).toBe(1)
  })

  it('customSlots override 가 maxConcurrent 보다 우선', () => {
    const cfg = derive({}, { slotDivision: 2, customSlots: { '2026-06-01__A': 4 } })
    const appts: Record<string, CardInput[]> = {
      '2026-06-01__A': [{ id: 'a1', startMin: 540, endMin: 570 }],
    }
    const units = buildUnitSequence(cfg, doctors, appts, { horizonDays: 1 })
    expect(units.find(u => u.doctorId === 'A')!.slots).toBe(4)
  })
})

// ════════════════════════════════════════════════════════════
describe('computeOperatingRange — 운영시간 union → bands', () => {
  // 분: 09:00=540 12:00=720 13:00=780 18:00=1080
  function unit(doctorId: string, weekday = 1): Unit {
    return { key: `2026-06-01__${doctorId}`, date: '2026-06-01', doctorId, doctorName: doctorId, weekday, slots: 1 }
  }
  // 테스트 unit 은 weekday=1 → 의사별·요일별 shape 로 래핑
  function cfgWith(hoursByDoctorWd1: Record<string, UnitHours>) {
    const hoursByDoctor: Record<string, Record<number, UnitHours>> = {}
    for (const id of Object.keys(hoursByDoctorWd1)) hoursByDoctor[id] = { 1: hoursByDoctorWd1[id] }
    return deriveLayoutConfig(
      baseSettings({ slotUnitMinutes: 30 }),
      { hoursByDoctor },
      baseView(),
      baseFilter,
      baseEnv,
    )
  }

  // 화면 라벨: 점심 → '휴게시간1', 저녁 → '휴게시간2' (코드 심볼 lunch/dinner 는 유지)
  it('단일 unit: 점심 구간이 휴게 band(휴게시간1)로 표시', () => {
    const cfg = cfgWith({ A: { morning: { start: 540, end: 720 }, afternoon: { start: 780, end: 1080 }, lunch: { start: 720, end: 780 } } })
    const r = computeOperatingRange(cfg, [unit('A')])
    expect(r.startMin).toBe(540)
    expect(r.endMin).toBe(1080)
    expect(r.bands).toHaveLength((1080 - 540) / 30) // 18
    const breaks = r.bands.filter(b => b.isBreak)
    expect(breaks).toHaveLength(2) // 720-750, 750-780
    expect(breaks.every(b => b.breakLabel === '휴게시간1')).toBe(true)
  })

  it('저녁 구간은 휴게시간2 라벨', () => {
    const cfg = cfgWith({
      A: {
        morning  : { start: 540, end: 1080 },
        afternoon: { start: 1140, end: 1260 },
        dinner   : { start: 1080, end: 1140 },
      },
    })
    const r = computeOperatingRange(cfg, [unit('A')])
    const breaks = r.bands.filter(b => b.isBreak)
    expect(breaks).toHaveLength(2) // 1080-1110, 1110-1140
    expect(breaks.every(b => b.breakLabel === '휴게시간2')).toBe(true)
  })

  it('grid 스냅: 비정렬 세션을 cellDuration 그리드로 floor/ceil', () => {
    const cfg = cfgWith({ A: { morning: { start: 550, end: 1070 } } }) // 09:10~17:50
    const r = computeOperatingRange(cfg, [unit('A')])
    expect(r.startMin).toBe(540) // floor 09:00
    expect(r.endMin).toBe(1080) // ceil 18:00
  })

  // viewState 확장값 → deriveLayoutConfig → cfg 로 전달해 cfgWithExt 구성
  function cfgWithExt(hoursWd1: Record<string, UnitHours>, top: number, bottom: number) {
    const hoursByDoctor: Record<string, Record<number, UnitHours>> = {}
    for (const id of Object.keys(hoursWd1)) hoursByDoctor[id] = { 1: hoursWd1[id] }
    return deriveLayoutConfig(
      baseSettings({ slotUnitMinutes: 30 }),
      { hoursByDoctor },
      baseView({ timelineTopExtendHours: top, timelineBottomExtendHours: bottom }),
      baseFilter,
      baseEnv,
    )
  }

  it('수동 확장(^v): 시작 N시간 일찍 / 종료 N시간 늦게', () => {
    const cfg = cfgWithExt({ A: { morning: { start: 540, end: 1080 } } }, 2, 1) // 09~18
    const r = computeOperatingRange(cfg, [unit('A')])
    expect(r.startMin).toBe(540 - 120) // 07:00
    expect(r.endMin).toBe(1080 + 60) // 19:00
  })

  it('수동 확장 [0,1440] clamp (과도 입력 방어)', () => {
    const cfg = cfgWithExt({ A: { morning: { start: 540, end: 1080 } } }, 24, 24)
    const r = computeOperatingRange(cfg, [unit('A')])
    expect(r.startMin).toBe(0)
    expect(r.endMin).toBe(1440)
  })

  it('union: 의사별 다른 세션 합집합, 사이 gap = 휴게(라벨 없음)', () => {
    const cfg = cfgWith({
      A: { morning: { start: 540, end: 720 } },
      B: { afternoon: { start: 780, end: 1080 } },
    })
    const r = computeOperatingRange(cfg, [unit('A'), unit('B')])
    expect(r.startMin).toBe(540)
    expect(r.endMin).toBe(1080)
    const breaks = r.bands.filter(b => b.isBreak)
    expect(breaks.length).toBeGreaterThan(0) // 720~780 gap
    expect(breaks.every(b => b.breakLabel === undefined)).toBe(true)
  })

  it('한 의사가 점심을 관통 운영하면 그 구간은 휴게 아님', () => {
    const cfg = cfgWith({
      A: { morning: { start: 540, end: 720 }, afternoon: { start: 780, end: 1080 }, lunch: { start: 720, end: 780 } },
      B: { morning: { start: 540, end: 1080 } }, // 직진
    })
    const r = computeOperatingRange(cfg, [unit('A'), unit('B')])
    expect(r.bands.every(b => !b.isBreak)).toBe(true)
    expect(r.breaks).toHaveLength(0) // 모두 운영으로 덮임
  })

  it('운영시간 없음 → 09:00~18:00 기본 bands (fallback)', () => {
    const cfg = cfgWith({})
    const r = computeOperatingRange(cfg, [unit('A')])
    expect(r.startMin).toBe(540) // 09:00
    expect(r.endMin).toBe(1080) // 18:00
    expect(r.bands.length).toBe((1080 - 540) / 30) // 18
    expect(r.bands.every(b => !b.isBreak)).toBe(true) // 전부 운영(휴게 없음)
  })

  // 시간축 최소 창 — 좁은 운영시간이 timeline 을 뷰포트보다 짧게 만들어 스크롤이 떨리던 것 방어
  it('좁은 운영시간(11:00~15:00) 이어도 timeline 첫 판은 09:00~18:00', () => {
    const cfg = cfgWith({ A: { morning: { start: 660, end: 900 } } }) // 11:00~15:00
    const r = computeOperatingRange(cfg, [unit('A')])
    expect(r.startMin).toBe(540) // 09:00
    expect(r.endMin).toBe(1080) // 18:00
    // 운영시간(11~15)만 운영, 넓힌 09~11 · 15~18 은 비운영 음영(라벨 없음)
    const operating = r.bands.filter(b => !b.isBreak)
    expect(operating[0].startMin).toBe(660)
    expect(operating[operating.length - 1].endMin).toBe(900)
    expect(r.bands.filter(b => b.isBreak).every(b => b.breakLabel === undefined)).toBe(true)
  })

  it('운영시간이 최소 창 밖으로 나가면 그만큼 넓어진다 (07:00~20:00)', () => {
    const cfg = cfgWith({ A: { morning: { start: 420, end: 1200 } } }) // 07:00~20:00
    const r = computeOperatingRange(cfg, [unit('A')])
    expect(r.startMin).toBe(420) // 07:00 — 최소 창에 갇히지 않는다
    expect(r.endMin).toBe(1200) // 20:00
    expect(r.bands.every(b => !b.isBreak)).toBe(true)
  })

  it('한쪽만 최소 창 밖: 시작 07:00 / 종료 15:00 → 07:00~18:00', () => {
    const cfg = cfgWith({ A: { morning: { start: 420, end: 900 } } })
    const r = computeOperatingRange(cfg, [unit('A')])
    expect(r.startMin).toBe(420) // 07:00 (진료시작)
    expect(r.endMin).toBe(1080) // 18:00 (최소 창)
  })

  it('최소 창은 수동 확장(^v)·예약 envelope 과 함께 적용된다', () => {
    const cfg = cfgWithExt({ A: { morning: { start: 660, end: 900 } } }, 1, 0) // 11~15, 시작 1h 일찍
    const r = computeOperatingRange(cfg, [unit('A')], { min: 660, max: 1200 }) // 예약 ~20:00
    expect(r.startMin).toBe(480) // 09:00(최소 창) - 1h
    expect(r.endMin).toBe(1200) // 20:00(예약 envelope)
  })

  it('예약 envelope: 종료 20:00 이 운영종료 18:00 보다 늦으면 timeline 이 20:00 까지 확장', () => {
    const cfg = cfgWith({ A: { morning: { start: 540, end: 1080 } } }) // 09:00~18:00
    const r = computeOperatingRange(cfg, [unit('A')], { min: 540, max: 1200 }) // 예약 ~20:00
    expect(r.startMin).toBe(540)
    expect(r.endMin).toBe(1200) // 20:00
    // 운영시간 밖(18:00~20:00) band 는 비운영 → 음영(isBreak), 라벨 없음
    const afterHours = r.bands.filter(b => b.startMin >= 1080)
    expect(afterHours.length).toBe((1200 - 1080) / 30) // 4
    expect(afterHours.every(b => b.isBreak && b.breakLabel === undefined)).toBe(true)
  })

  it('예약 envelope: 시작이 진료시작보다 이르면 timeline 이 앞으로도 확장', () => {
    const cfg = cfgWith({ A: { morning: { start: 540, end: 1080 } } }) // 09:00~18:00
    const r = computeOperatingRange(cfg, [unit('A')], { min: 480, max: 1080 }) // 08:00 예약
    expect(r.startMin).toBe(480) // 08:00
    expect(r.endMin).toBe(1080)
  })

  it('예약 envelope 가 운영시간 안에 있으면 확장 없음(하위호환)', () => {
    const cfg = cfgWith({ A: { morning: { start: 540, end: 1080 } } })
    const withEnv = computeOperatingRange(cfg, [unit('A')], { min: 600, max: 700 })
    const without = computeOperatingRange(cfg, [unit('A')])
    expect(withEnv.startMin).toBe(without.startMin)
    expect(withEnv.endMin).toBe(without.endMin)
  })

  it('운영시간 없을 때(09~18 fallback) 예약이 그 밖이면 union 확장', () => {
    const cfg = cfgWith({})
    const r = computeOperatingRange(cfg, [unit('A')], { min: 420, max: 720 }) // 07:00 예약
    expect(r.startMin).toBe(420) // 07:00 (fallback 09~18 ∪ envelope 07:00 확장)
    expect(r.endMin).toBe(1080) // 18:00 (fallback 종료)
    // 07~09 는 비운영(음영), 09~18 은 운영(fallback)
    expect(r.bands.filter(b => b.startMin < 540).every(b => b.isBreak)).toBe(true)
    expect(r.bands.filter(b => b.startMin >= 540).every(b => !b.isBreak)).toBe(true)
  })
})

// ════════════════════════════════════════════════════════════
describe('computeBandHeights — band 높이/topPx', () => {
  const bands: BandSpec[] = [
    { index: 0, startMin: 540, endMin: 570, isBreak: false },
    { index: 1, startMin: 570, endMin: 600, isBreak: false },
    { index: 2, startMin: 600, endMin: 630, isBreak: true, breakLabel: '점심시간' },
  ]

  it('diff startMin 2건 같은 band → maxRows 2, 높이 (2+1)×rowHeight, 빈 band 1행, 휴게 축소', () => {
    const pu: PerUnitCards[] = [{
      cards: [
        { id: 'a', startMin: 540, endMin: 570 },
        { id: 'b', startMin: 550, endMin: 600 },
      ],
      expandedRows: {},
    }]
    const out = computeBandHeights(pu, bands, 3) // rowHeight 50
    expect(out[0].maxRows).toBe(2)
    expect(out[0].heightPx).toBe(240) // (2+1)*80
    expect(out[1].heightPx).toBe(80) // 빈 band 1행
    expect(out[2].heightPx).toBe(48) // 휴게 round(80*0.6)
    expect(out.map(b => b.topPx)).toEqual([0, 240, 320])
  })

  it('같은 startMin 2건(non-expanded) → 1행, expandedRows 깊이 반영', () => {
    const flat: PerUnitCards[] = [{
      cards: [
        { id: 'a', startMin: 540, endMin: 570 },
        { id: 'b', startMin: 540, endMin: 570 },
      ],
      expandedRows: {},
    }]
    expect(computeBandHeights(flat, bands, 3)[0].maxRows).toBe(1)

    const expanded: PerUnitCards[] = [{
      cards: [
        { id: 'a', startMin: 540, endMin: 570 },
        { id: 'b', startMin: 540, endMin: 570 },
        { id: 'c', startMin: 540, endMin: 570 },
      ],
      expandedRows: { 540: 2 }, // 2 side-by-side + 1 float = depth 2
    }]
    expect(computeBandHeights(expanded, bands, 3)[0].maxRows).toBe(2)
  })

  it('maxRows 는 전 컬럼 중 최대', () => {
    const pu: PerUnitCards[] = [
      { cards: [{ id: 'a', startMin: 540, endMin: 570 }], expandedRows: {} },
      { cards: [
        { id: 'b', startMin: 540, endMin: 570 },
        { id: 'c', startMin: 550, endMin: 600 },
        { id: 'd', startMin: 560, endMin: 600 },
      ], expandedRows: {} },
    ]
    expect(computeBandHeights(pu, bands, 3)[0].maxRows).toBe(3)
  })

  it('rowHeightLevel 에 따라 행 높이 변동', () => {
    const pu: PerUnitCards[] = [{ cards: [{ id: 'a', startMin: 540, endMin: 570 }], expandedRows: {} }]
    expect(computeBandHeights(pu, bands, 1)[0].heightPx).toBe(100) // (1+1)*50
    expect(computeBandHeights(pu, bands, 5)[0].heightPx).toBe(220) // (1+1)*110
  })
})

// ════════════════════════════════════════════════════════════
describe('computeRects — 좌표/z (arrangeCards + computeBandHeights 통합)', () => {
  it('같은 startMin 2건 / 2칸 → 나란히(같은 top), subColWidth 분할', () => {
    const cards = [
      { id: 'a', startMin: 540, endMin: 570 },
      { id: 'b', startMin: 540, endMin: 570 },
    ]
    const arrange = arrangeCards(cards, 2)
    const specs: BandSpec[] = [
      { index: 0, startMin: 540, endMin: 570, isBreak: false },
      { index: 1, startMin: 570, endMin: 600, isBreak: false },
    ]
    const bandInfos = computeBandHeights([{ cards, expandedRows: arrange.expandedRows }], specs, 3)
    const col: RectColumn = { columnIndex: 0, leftPx: 100, widthPx: 200, subColCount: 2, subColStart: 0, cards, arrange }
    const rects = computeRects([col], bandInfos, 3)
    const a = rects.find(r => r.id === 'a')!
    const b = rects.find(r => r.id === 'b')!
    expect(a.top).toBe(0)
    expect(b.top).toBe(0) // 같은 행
    expect(a.height).toBe(80) // 단일 band
    expect(a.width).toBe(93) // 100 - 0(indent) - 4(gap) - 3(strip 3%)
    // subColWidth=100 → 한쪽은 100, 다른쪽은 200
    expect(new Set([a.left, b.left])).toEqual(new Set([100, 200]))
    expect(a.z).toBe(0)
    expect(a.isFloating).toBe(false)
  })

  it('multi-band 카드 → endBand 한 행까지 높이', () => {
    const cards = [{ id: 'c', startMin: 540, endMin: 630 }] // 3 band span
    const arrange = arrangeCards(cards, 1)
    const specs: BandSpec[] = [
      { index: 0, startMin: 540, endMin: 570, isBreak: false },
      { index: 1, startMin: 570, endMin: 600, isBreak: false },
      { index: 2, startMin: 600, endMin: 630, isBreak: false },
    ]
    const bandInfos = computeBandHeights([{ cards, expandedRows: arrange.expandedRows }], specs, 3)
    // topPx: b0=0(h100), b1=100(h50), b2=150(h50)
    const col: RectColumn = { columnIndex: 0, leftPx: 0, widthPx: 100, subColCount: 1, subColStart: 0, cards, arrange }
    const rects = computeRects([col], bandInfos, 3)
    const c = rects[0]
    expect(c.top).toBe(0)
    expect(c.height).toBe(320) // b2.top(240) + rowHeight(80) - top(0)
    expect(c.width).toBe(93) // 100 - 0 - 4(gap) - 3(strip 3%)
  })

  it('관통(multi-band) 카드 height 정밀화: endBand 시작 카드(같은 sub-col) 침범 방지', () => {
    // 장하린 12:40~13:10(750band→780band 관통) + 임현우 13:10~13:40(780band 시작) — 같은 sub-col(N=1).
    // 클램프 없으면 장하린 꼬리가 임현우 첫 행을 덮어 가림(실제 버그). 클램프로 endBand 진입 직전까지만.
    const cards = [
      { id: 'jang', startMin: 760, endMin: 790 },
      { id: 'lim', startMin: 790, endMin: 820 },
    ]
    const arrange = arrangeCards(cards, 1)
    const specs: BandSpec[] = [
      { index: 0, startMin: 750, endMin: 780, isBreak: false },
      { index: 1, startMin: 780, endMin: 810, isBreak: false },
      { index: 2, startMin: 810, endMin: 840, isBreak: false },
    ]
    const bandInfos = computeBandHeights([{ cards, expandedRows: arrange.expandedRows }], specs, 3)
    const col: RectColumn = { columnIndex: 0, leftPx: 0, widthPx: 100, subColCount: 1, subColStart: 0, cards, arrange }
    const rects = computeRects([col], bandInfos, 3)
    const jang = rects.find(r => r.id === 'jang')!
    const lim = rects.find(r => r.id === 'lim')!
    // 장하린 bottom 이 임현우 top 을 침범하지 않아야(가림 없음).
    expect(jang.top + jang.height).toBeLessThanOrEqual(lim.top + 0.01)
    // 장하린은 endBand(780band, top 160) 진입 직전까지 → height 160.
    expect(jang.height).toBe(160)
  })

  it('isLayered = 더 긴(duration) 예약 위 floating 만 (같은 길이·더 이른 시작 위는 제외)', () => {
    // 이서연(09:40~12:40, 긴 base) 위 서서연 = layered. 서서연(같은 길이, 더 이른 시작) 위 장하린 = layered 아님.
    const cards = [
      { id: 'lee', startMin: 580, endMin: 760 }, // dur 180 (긴 base)
      { id: 'seo', startMin: 750, endMin: 780 }, // dur 30
      { id: 'jang', startMin: 760, endMin: 790 }, // dur 30
    ]
    const arrange = arrangeCards(cards, 1) // N=1 → 이서연 base, 서서연/장하린 floating
    const specs: BandSpec[] = [
      { index: 0, startMin: 540, endMin: 780, isBreak: false },
      { index: 1, startMin: 780, endMin: 840, isBreak: false },
    ]
    const bandInfos = computeBandHeights([{ cards, expandedRows: arrange.expandedRows }], specs, 3)
    const col: RectColumn = { columnIndex: 0, leftPx: 0, widthPx: 100, subColCount: 1, subColStart: 0, cards, arrange }
    const rects = computeRects([col], bandInfos, 3)
    const seo = rects.find(r => r.id === 'seo')!
    const jang = rects.find(r => r.id === 'jang')!
    expect(seo.isLayered).toBe(true) // 더 긴 이서연 위 → 들여쓰기·그림자
    expect(jang.isLayered).toBe(false) // 같은 길이 서서연 위 → 들여쓰기 없음
  })

  it('같은 시작+종료 스택 floating(level0) → full width(−10 안 함), z=10, localRow 한 칸 아래', () => {
    const cards = [
      { id: 'a', startMin: 540, endMin: 600 },
      { id: 'b', startMin: 540, endMin: 600 },
      { id: 'c', startMin: 540, endMin: 600 }, // 3건 / 2칸 → 1건 floating (level0)
    ]
    const arrange = arrangeCards(cards, 2)
    expect(arrange.floating).toHaveLength(1)
    expect(arrange.floating[0].floatLevel).toBe(0) // 같은 길이 → layering 아님
    const specs: BandSpec[] = [
      { index: 0, startMin: 540, endMin: 570, isBreak: false },
      { index: 1, startMin: 570, endMin: 600, isBreak: false },
    ]
    const bandInfos = computeBandHeights([{ cards, expandedRows: arrange.expandedRows }], specs, 3)
    // expandedRows[540]=2 → b0 maxRows 2 → h150, topPx b0=0 b1=150
    const col: RectColumn = { columnIndex: 0, leftPx: 0, widthPx: 200, subColCount: 2, subColStart: 0, cards, arrange }
    const rects = computeRects([col], bandInfos, 3)
    const floatId = arrange.floating[0].id
    const fr = rects.find(r => r.id === floatId)!
    expect(fr.isFloating).toBe(true)
    expect(fr.z).toBe(10)
    expect(fr.top).toBe(80) // localRow 1 × rowHeight 80
    expect(fr.width).toBe(93) // 레인폭 100 - gap 4 - strip 3 (level0, 들여쓰기 없음)
    expect(fr.isLayered).toBe(false) // level0(같은 길이 동시초과) = 들여쓰기/그림자 없음
  })

  it('더 긴 카드 위 floating(level>0) → 고정 10px 들여쓰기 + isLayered', () => {
    const cards = [
      { id: 'L', startMin: 540, endMin: 660 }, // 09:00~11:00 (긴 예약, col0)
      { id: 'M', startMin: 540, endMin: 600 }, // 09:00~10:00 (col1)
      { id: 'X', startMin: 570, endMin: 600 }, // 09:30~10:00 → L,M 다 점유 → float over L(longest), level>0
    ]
    const arrange = arrangeCards(cards, 2)
    const f = arrange.floating.find(fc => fc.id === 'X')!
    expect(f.floatLevel).toBeGreaterThan(0) // 더 긴 L 위 layering
    const specs: BandSpec[] = [
      { index: 0, startMin: 540, endMin: 570, isBreak: false },
      { index: 1, startMin: 570, endMin: 600, isBreak: false },
      { index: 2, startMin: 600, endMin: 660, isBreak: false },
    ]
    const bandInfos = computeBandHeights([{ cards, expandedRows: arrange.expandedRows }], specs, 3)
    const col: RectColumn = { columnIndex: 0, leftPx: 0, widthPx: 200, subColCount: 2, subColStart: 0, cards, arrange }
    const rects = computeRects([col], bandInfos, 3)
    const fr = rects.find(r => r.id === 'X')!
    // level>0 layering → 고정 10px 들여쓰기(긴 예약 위 얹힘). left 0+10=10, width 100−10(indent)−4(gap)−3(strip)=83
    expect(fr.width).toBe(83)
    expect(fr.left).toBe(10)
    expect(fr.isLayered).toBe(true)
  })

  it('빈 카드 컬럼 → rect 없음', () => {
    const arrange = arrangeCards([], 2)
    const specs: BandSpec[] = [{ index: 0, startMin: 540, endMin: 570, isBreak: false }]
    const bandInfos = computeBandHeights([{ cards: [], expandedRows: {} }], specs, 3)
    const col: RectColumn = { columnIndex: 0, leftPx: 0, widthPx: 100, subColCount: 2, subColStart: 0, cards: [], arrange }
    expect(computeRects([col], bandInfos, 3)).toEqual([])
  })
})

// ════════════════════════════════════════════════════════════
describe('computeColumnPixels — 페이징 폭 분배 (denom=budget 고정, 원래 비율)', () => {
  it('풀 페이지: denom=budget, 균등 분할', () => {
    const cols = [
      { unitIndex: 0, subColStart: 0, subColCount: 2, slotsStartIdx: 0, unitSlots: 2 },
      { unitIndex: 1, subColStart: 0, subColCount: 2, slotsStartIdx: 2, unitSlots: 2 },
      { unitIndex: 2, subColStart: 0, subColCount: 2, slotsStartIdx: 4, unitSlots: 2 },
    ]
    const px = computeColumnPixels(cols, 6, 600)
    expect(px.map(p => p.widthPx)).toEqual([200, 200, 200])
    expect(px.map(p => p.leftPx)).toEqual([0, 200, 400])
  })

  it('잔여(합<budget): 펴지지 않고 원래 비율 유지(우측 빈 공간)', () => {
    const cols = [
      { unitIndex: 0, subColStart: 0, subColCount: 2, slotsStartIdx: 0, unitSlots: 2 },
      { unitIndex: 1, subColStart: 0, subColCount: 2, slotsStartIdx: 2, unitSlots: 2 },
    ]
    const px = computeColumnPixels(cols, 6, 600) // sum 4 < budget 6 → 펴짐 없음
    expect(px.map(p => p.widthPx)).toEqual([200, 200]) // 2/6 × 600
    expect(px.map(p => p.leftPx)).toEqual([0, 200])    // 우측 1/3 빈 공간
  })

  it('carry-over 잔여 칸 + 다음 unit 이어짐 (subColStart 반영)', () => {
    // a sub4(잔여 1칸) + b sub0~1 + c sub0, budget 4
    const cols = [
      { unitIndex: 0, subColStart: 4, subColCount: 1, slotsStartIdx: 0, unitSlots: 5 },
      { unitIndex: 1, subColStart: 0, subColCount: 2, slotsStartIdx: 1, unitSlots: 2 },
      { unitIndex: 2, subColStart: 0, subColCount: 1, slotsStartIdx: 3, unitSlots: 2 },
    ]
    const px = computeColumnPixels(cols, 4, 400) // denom 4, 칸폭 100
    expect(px.map(p => p.widthPx)).toEqual([100, 200, 100])
    expect(px.map(p => p.leftPx)).toEqual([0, 100, 300])
  })

  it('stretch=true(진료): 합<budget 이면 denom=Σsubcol → full width 펴짐(empty 제거)', () => {
    const cols = [
      { unitIndex: 0, subColStart: 0, subColCount: 2, slotsStartIdx: 0, unitSlots: 2 },
      { unitIndex: 1, subColStart: 0, subColCount: 2, slotsStartIdx: 2, unitSlots: 2 },
    ]
    // sum 4 < budget 6 이지만 stretch → denom=4, 칸폭 150, 우측 빈 공간 없음(합=600)
    const px = computeColumnPixels(cols, 6, 600, true)
    expect(px.map(p => p.widthPx)).toEqual([300, 300]) // 2/4 × 600
    expect(px.map(p => p.leftPx)).toEqual([0, 300])    // full width 채움
  })

  it('stretch=true 라도 풀 페이지(Σ=budget)는 무변화', () => {
    const cols = [
      { unitIndex: 0, subColStart: 0, subColCount: 3, slotsStartIdx: 0, unitSlots: 3 },
      { unitIndex: 1, subColStart: 0, subColCount: 3, slotsStartIdx: 3, unitSlots: 3 },
    ]
    const px = computeColumnPixels(cols, 6, 600, true) // Σ=6=budget → denom 동일
    expect(px.map(p => p.widthPx)).toEqual([300, 300])
    expect(px.map(p => p.leftPx)).toEqual([0, 300])
  })
})

describe('runLayout — end-to-end 합성', () => {
  const doctors = [{ id: 'A', name: '김의사' }, { id: 'B', name: '이의사' }]
  const wd = weekdayOf('2026-06-01')

  it('2의사 1일: 컬럼/band/rect 일괄 산출, slots=동시예약', () => {
    const result = runLayout({
      settings: { slotUnitMinutes: 30, totalColumnCount: 8, displayInfo: ['NAME'] },
      site: { hoursByWeekday: { [wd]: { morning: { start: 540, end: 720 } } } },
      viewState: { dataType: 'APPOINTMENT', selectedDate: '2026-06-01', viewStep: 3, slotDivision: 2 },
      filter: {},
      env: { availableWidth: 1200 },
      doctors,
      apptsByUnitKey: {
        '2026-06-01__A': [
          { id: 'a1', startMin: 540, endMin: 600 },
          { id: 'a2', startMin: 550, endMin: 600 },
        ],
        '2026-06-01__B': [{ id: 'b1', startMin: 540, endMin: 570 }],
      },
      horizonDays: 1,
    })

    expect(result.config.budget).toBe(8)
    expect(result.pages).toHaveLength(1)
    expect(result.columns).toHaveLength(2)
    // A 동시예약 2 → slots 2, B → slots 1
    expect(result.columns[0].unit.doctorId).toBe('A')
    expect(result.columns[0].subColCount).toBe(2)
    expect(result.columns[1].subColCount).toBe(1)
    // 시간축은 최소 창 09:00~18:00 / 30분 → 18 band. 그중 운영시간(09~12)만 운영 band 6개.
    expect(result.bandInfos).toHaveLength(18)
    expect(result.operatingRange.bands.filter(b => !b.isBreak)).toHaveLength(6)
    // rect 3개 (a1,a2,b1)
    expect(result.rects).toHaveLength(3)
    // 폭 분배: denom=budget 8 (원래 비율 유지). A(2칸)=300, B(1칸) left=300, 우측 5칸 빈
    expect(result.columns[0].widthPx).toBeCloseTo(300)
    expect(result.columns[1].leftPx).toBeCloseTo(300)
    // b1 은 컬럼1
    expect(result.rects.find(r => r.id === 'b1')!.columnIndex).toBe(1)
  })

  it('운영시간 밖 예약: timeline 이 예약 종료까지 확장, 카드는 clamp 되지 않고 제 band 에 위치', () => {
    const result = runLayout({
      settings: { slotUnitMinutes: 30, totalColumnCount: 8, displayInfo: ['NAME'] },
      site: { hoursByWeekday: { [wd]: { morning: { start: 540, end: 1080 } } } }, // 09:00~18:00
      viewState: { dataType: 'APPOINTMENT', selectedDate: '2026-06-01', viewStep: 3, slotDivision: 1 },
      filter: {},
      env: { availableWidth: 1000 },
      doctors,
      apptsByUnitKey: {
        '2026-06-01__A': [{ id: 'late', startMin: 1140, endMin: 1200 }], // 19:00~20:00 (진료 밖)
      },
      horizonDays: 1,
    })
    // 09:00~20:00 / 30분 = 22 band (18→20시 확장분 4 포함)
    expect(result.operatingRange.endMin).toBe(1200)
    expect(result.bandInfos).toHaveLength((1200 - 540) / 30)
    // 19:00~20:00 카드가 마지막 band(clamp)가 아니라 19:00 시작 band 에 위치
    const lastBand = result.bandInfos[result.bandInfos.length - 1]
    const bodyHeight = lastBand.topPx + lastBand.heightPx
    const rect = result.rects.find(r => r.id === 'late')!
    expect(rect.top).toBeLessThan(bodyHeight)
    expect(rect.top + rect.height).toBeLessThanOrEqual(bodyHeight + 0.01)
    // 19:00(1140) 시작 band 의 topPx 와 일치
    const startBand = result.bandInfos.find(b => b.startMin === 1140)!
    expect(rect.top).toBeCloseTo(startBand.topPx)
  })

  it('운영시간 없어도 09~18 fallback band 생성, 예약 없으면 rect 빈(throw 없음)', () => {
    const result = runLayout({
      settings: { slotUnitMinutes: 30, totalColumnCount: 8 },
      site: {},
      viewState: { dataType: 'TREATMENT', selectedDate: '2026-06-01', viewStep: 3, slotDivision: 1 },
      filter: {},
      env: { availableWidth: 1000 },
      doctors,
      apptsByUnitKey: {},
    })
    expect(result.bandInfos.length).toBeGreaterThan(0) // 09~18 fallback band
    expect(result.rects).toEqual([]) // 예약 0 → 카드 없음
    expect(result.columns).toHaveLength(2) // unit 은 존재
  })
})

describe('runLayout — slotOffset (date-anchored 윈도우, 신 모델)', () => {
  const doctors = [{ id: 'A', name: '김' }, { id: 'B', name: '이' }]
  // 06-01,02,03 × 2의사 × (빈예약→slots1) = 6 slots. viewStep5 → budget = 8+2(3-5) = 4.
  const base = {
    settings: { slotUnitMinutes: 30, totalColumnCount: 8 },
    site: {},
    filter: {},
    env: { availableWidth: 1000 },
    doctors,
    apptsByUnitKey: {},
    horizonDays: 3,
  }
  const run = (extra: Record<string, unknown>) => runLayout({
    ...base,
    viewState: { dataType: 'APPOINTMENT', selectedDate: '2026-06-01', viewStep: 5, slotDivision: 1, ...extra },
  })

  it('totalSlots = 전체 unit slots 합, budget=4', () => {
    const r = run({ slotOffset: 0 })
    expect(r.totalSlots).toBe(6)
    expect(r.config.budget).toBe(4)
  })
  it('slotOffset=0 → 좌측이 첫 slot(06-01 A)부터 budget(4)칸', () => {
    const r = run({ slotOffset: 0 })
    expect(r.slotOffset).toBe(0)
    expect(r.columns).toHaveLength(4)
    expect(r.columns[0].unit.key).toBe('2026-06-01__A')
    expect(r.columns[3].unit.key).toBe('2026-06-02__B')
  })
  it('slotOffset=2 → 임의 offset 슬라이스(좌측 06-02 A, 페이지 경계 무관)', () => {
    const r = run({ slotOffset: 2 })
    expect(r.slotOffset).toBe(2)
    expect(r.columns).toHaveLength(4)
    expect(r.columns[0].unit.key).toBe('2026-06-02__A')
    expect(r.columns[3].unit.key).toBe('2026-06-03__B')
  })
  it('slotOffset overflow → [0, totalSlots-1] clamp (최소 1컬럼)', () => {
    const r = run({ slotOffset: 99 })
    expect(r.slotOffset).toBe(5)
    expect(r.columns).toHaveLength(1)
    expect(r.columns[0].unit.key).toBe('2026-06-03__B')
  })
  it('slotOffset 미전달 → 구 doctorPageIdx 경로 보존(slotOffset=page.slotStart)', () => {
    const r = run({ doctorPageIdx: 1 }) // pages=[{0,4},{4,6}] → page1 slotStart=4
    expect(r.slotOffset).toBe(4)
    expect(r.columns[0].unit.key).toBe('2026-06-03__A')
  })
})

// ════════════════════════════════════════════════════════════
// #13 칸수배정 모델 — B2(레인폭 N고정·혼자=풀폭) vs A(동시건수)
// ════════════════════════════════════════════════════════════
describe('layoutMode B2 — 레인폭 N고정', () => {
  const doctors = [{ id: 'A', name: '김의사' }, { id: 'B', name: '이의사' }, { id: 'C', name: '박의사' }]

  it('deriveLayoutConfig: layoutMode 미전달 → A(기존 동작 보존)', () => {
    expect(derive().layoutMode).toBe('A')
    expect(derive({}, { layoutMode: 'B2' }).layoutMode).toBe('B2')
    // 잘못된 값도 A 로 정규화 (가산 안전)
    expect(derive({}, { layoutMode: 'X' as unknown as 'A' }).layoutMode).toBe('A')
  })

  it('B2: 빈 의사도 slots=N (A 는 빈=1)', () => {
    const cfgB2 = derive({}, { slotDivision: 3, layoutMode: 'B2' })
    const cfgA = derive({}, { slotDivision: 3 })
    const b2 = buildUnitSequence(cfgB2, doctors, {}, { horizonDays: 1 })
    const a = buildUnitSequence(cfgA, doctors, {}, { horizonDays: 1 })
    expect(b2.every(u => u.slots === 3)).toBe(true) // 빈 의사도 N
    expect(a.every(u => u.slots === 1)).toBe(true) // A 는 동시0 → 1
  })

  it('B2: 동시 2건·N=3 → slots=3 (A 는 min(2,3)=2)', () => {
    const appts: Record<string, CardInput[]> = {
      '2026-06-01__A': [
        { id: 'a1', startMin: 540, endMin: 600 },
        { id: 'a2', startMin: 550, endMin: 610 },
      ],
    }
    const b2 = buildUnitSequence(derive({}, { slotDivision: 3, layoutMode: 'B2' }), doctors, appts, { horizonDays: 1 })
    const a = buildUnitSequence(derive({}, { slotDivision: 3 }), doctors, appts, { horizonDays: 1 })
    expect(b2.find(u => u.doctorId === 'A')!.slots).toBe(3)
    expect(a.find(u => u.doctorId === 'A')!.slots).toBe(2)
  })

  it('B2: customSlots override 가 N고정보다 우선', () => {
    const cfg = derive({}, { slotDivision: 3, layoutMode: 'B2', customSlots: { '2026-06-01__A': 1 } })
    const units = buildUnitSequence(cfg, doctors, {}, { horizonDays: 1 })
    expect(units.find(u => u.doctorId === 'A')!.slots).toBe(1)
  })

  const wd = weekdayOf('2026-06-01')
  const oneDoctor = [{ id: 'A', name: '김의사' }]

  it('B2 runLayout: 레인폭=N(3) 고정, 카드는 항상 1 sub-column(혼자도 풀폭 아님)', () => {
    const r = runLayout({
      settings: { slotUnitMinutes: 30, totalColumnCount: 8, displayInfo: ['NAME'] },
      site: { hoursByWeekday: { [wd]: { morning: { start: 540, end: 720 } } } },
      viewState: { dataType: 'APPOINTMENT', selectedDate: '2026-06-01', viewStep: 3, slotDivision: 3, layoutMode: 'B2' },
      filter: {},
      env: { availableWidth: 800 },
      doctors: oneDoctor,
      apptsByUnitKey: {
        // solo: 09:00~10:00 단독 / dup1·dup2: 11:00~ 겹침 2건
        '2026-06-01__A': [
          { id: 'solo', startMin: 540, endMin: 600 },
          { id: 'dup1', startMin: 660, endMin: 720 },
          { id: 'dup2', startMin: 670, endMin: 720 },
        ],
      },
      horizonDays: 1,
    })
    // B2 → slots=3, denom=budget 8, widthPx = 3/8*800 = 300, subColWidth = 100
    expect(r.columns[0].subColCount).toBe(3)
    expect(r.columns[0].widthPx).toBeCloseTo(300)
    const solo = r.rects.find(x => x.id === 'solo')!
    const dup1 = r.rects.find(x => x.id === 'dup1')!
    const dup2 = r.rects.find(x => x.id === 'dup2')!
    // 혼자여도 1 sub-column(레인폭 100 - gap 4 - strip 3 = 93), 풀폭 아님 → 좌측 1칸
    expect(solo.width).toBeCloseTo(93)
    expect(solo.left).toBeCloseTo(0)
    // 겹침 = 각 1칸, 인접 sub-column (col0/col1)
    expect(dup1.width).toBeCloseTo(93)
    expect(dup1.left).toBeCloseTo(0)
    expect(dup2.left).toBeCloseTo(100)
  })

  it('A runLayout(회귀 가드): 혼자여도 1칸 폭 유지(풀폭 아님)', () => {
    const r = runLayout({
      settings: { slotUnitMinutes: 30, totalColumnCount: 8, displayInfo: ['NAME'] },
      site: { hoursByWeekday: { [wd]: { morning: { start: 540, end: 720 } } } },
      viewState: { dataType: 'APPOINTMENT', selectedDate: '2026-06-01', viewStep: 3, slotDivision: 3 },
      filter: {},
      env: { availableWidth: 800 },
      doctors: oneDoctor,
      apptsByUnitKey: {
        '2026-06-01__A': [{ id: 'solo', startMin: 540, endMin: 600 }],
      },
      horizonDays: 1,
    })
    // A → slots=min(1,3)=1, widthPx=1/8*800=100, 카드 1칸(100-gap-strip = 93)
    expect(r.columns[0].subColCount).toBe(1)
    expect(r.rects.find(x => x.id === 'solo')!.width).toBeCloseTo(93)
  })
})

/**
 * STEP8 — 공휴일 운영시간이 타임라인 밴드에 반영되는지 (2026-07-28).
 * 예약검증(useSchedulerRules)과 같은 규칙을 써야 밴드/검증 괴리가 생기지 않는다.
 */
describe('resolveUnitHours — 공휴일 운영시간 (날짜 축)', () => {
  const HOLIDAY = '2026-01-01'
  const holidayWd = weekdayOf(HOLIDAY)
  const doctors = [{ id: 'A', name: '김의사' }]

  /**
   * 관찰 대상은 "그날 운영시간으로 무엇이 뽑혔나"다 → **운영 band(isBreak=false) 의 바깥 경계**를 본다.
   * ★`operatingRange.startMin/endMin` 을 보면 안 된다 — 시간축에는 09~18 최소 창이 깔려 있어
   * 좁은 운영시간이 전부 09~18 로 뭉개져 판별력이 사라진다(휴게 결함을 잡은 게 이 계열 테스트다).
   */
  function bandRange(site: SiteInput, selectedDate: string) {
    const r = runLayout({
      settings: { slotUnitMinutes: 30, totalColumnCount: 8, displayInfo: ['NAME'] },
      site,
      viewState: { dataType: 'TREATMENT', selectedDate, viewStep: 3, slotDivision: 1 },
      filter: {},
      env: { availableWidth: 800 },
      doctors,
      apptsByUnitKey: {},
      horizonDays: 1,
    })
    const operating = r.operatingRange.bands.filter(b => !b.isBreak)
    if (!operating.length) return { start: null, end: null }
    return { start: operating[0].startMin, end: operating[operating.length - 1].endMin }
  }

  // 요일 09:00~18:00 / 공휴일 10:00~15:00
  const weekdayHours = { [holidayWd]: { morning: { start: 540, end: 1080 } } }
  const holidayHours: UnitHours = { morning: { start: 600, end: 900 } }

  it('공휴일 진료일: 요일 시간 대신 공휴일 운영시간으로 밴드를 그린다', () => {
    const r = bandRange(
      { hoursByWeekday: weekdayHours, holidayHours, holidayDates: [HOLIDAY] },
      HOLIDAY,
    )
    expect(r).toEqual({ start: 600, end: 900 })
  })

  it('★담당자가 정한 요일이면 공휴일에도 담당자 시간이 이긴다 (예약검증과 같은 규칙)', () => {
    // 09:00~17:00 인 의사 A → 공휴일이라고 기관 10:00~15:00 으로 좁히지 않는다.
    // 한쪽만 기관 시간을 쓰면 "밴드는 열렸는데 클릭하면 운영종료"가 난다.
    const r = bandRange(
      {
        hoursByDoctor: { A: { [holidayWd]: { morning: { start: 540, end: 1020 } } } },
        hoursByWeekday: weekdayHours,
        holidayHours,
        holidayDates: [HOLIDAY],
      },
      HOLIDAY,
    )
    expect(r).toEqual({ start: 540, end: 1020 })
  })

  it('★담당자 미설정 요일이면 공휴일엔 기관 공휴일 시간을 쓴다', () => {
    // hoursByDoctor 에 그 요일 키가 없다 = 미설정 → 기관 공휴일 시간(10:00~15:00)
    const r = bandRange(
      {
        hoursByDoctor: { A: {} },
        hoursByWeekday: weekdayHours,
        holidayHours,
        holidayDates: [HOLIDAY],
      },
      HOLIDAY,
    )
    expect(r).toEqual({ start: 600, end: 900 })
  })

  it('공휴일이라도 공휴일 운영시간이 미설정이면 요일 축으로 폴백 (시간축이 기본값으로 튀지 않게)', () => {
    const r = bandRange(
      { hoursByWeekday: weekdayHours, holidayHours: {}, holidayDates: [HOLIDAY] },
      HOLIDAY,
    )
    expect(r).toEqual({ start: 540, end: 1080 })
  })

  it('공휴일 목록에 없는 날은 요일 축 그대로 (회귀 가드)', () => {
    const plain = '2026-01-08' // 같은 요일, 공휴일 아님
    const r = bandRange(
      { hoursByWeekday: weekdayHours, holidayHours, holidayDates: [HOLIDAY] },
      plain,
    )
    expect(r).toEqual({ start: 540, end: 1080 })
  })

  it('holidayDates 미전달(기존 호출부) → 바이트 동일하게 요일 축', () => {
    const r = bandRange({ hoursByWeekday: weekdayHours }, HOLIDAY)
    expect(r).toEqual({ start: 540, end: 1080 })
  })

  /* ★휴게는 운영시간과 갈린다 — 휴게는 사업장만 소유하므로 담당자 시간을 쓰는 날에도
   * 그 날짜의 기관 휴게(공휴일 휴게)를 쓴다. doctorHours 에 실린 휴게는 어댑터가 병합한
   * 요일별 값이라 그대로 두면 공휴일 휴게 설정이 항상 무시된다. dev:mock 눈검증에서 발견. */
  describe('공휴일 휴게 — 담당자 시간을 써도 휴게는 날짜 기준', () => {
    const cfg = (over: Record<string, unknown> = {}) =>
      ({
        hoursByDoctor: {},
        hoursByWeekday: weekdayHours,
        holidayHours: { morning: { start: 600, end: 900 }, lunch: { start: 720, end: 750 } },
        holidayDates: [HOLIDAY],
        ...over,
      }) as never
    const unit = (date: string) =>
      ({ key: 'u', date, doctorId: 'A', weekday: weekdayOf(date), slots: [] }) as never

    it('담당자가 정한 요일: 운영시간은 담당자, 휴게는 공휴일 휴게로 교체된다', () => {
      const h = resolveUnitHours(
        cfg({
          hoursByDoctor: {
            A: {
              [holidayWd]: {
                morning: { start: 540, end: 1020 },
                lunch: { start: 780, end: 840 }, // 요일별 13:00~14:00 (병합돼 온 값)
              },
            },
          },
        }),
        unit(HOLIDAY),
      )
      expect(h.morning).toEqual({ start: 540, end: 1020 })
      expect(h.lunch).toEqual({ start: 720, end: 750 })
    })

    it('담당자가 휴무로 정한 요일에는 휴게를 얹지 않는다 (쉬는 날에 휴게 band 금지)', () => {
      const h = resolveUnitHours(cfg({ hoursByDoctor: { A: { [holidayWd]: {} } } }), unit(HOLIDAY))
      expect(h.lunch).toBeUndefined()
      expect(h.morning).toBeUndefined()
    })

    it('공휴일 운영시간이 미설정이면 담당자 휴게를 그대로 둔다 (교체 근거 없음)', () => {
      const doctorDay = { morning: { start: 540, end: 1020 }, lunch: { start: 780, end: 840 } }
      const h = resolveUnitHours(
        cfg({ hoursByDoctor: { A: { [holidayWd]: doctorDay } }, holidayHours: {} }),
        unit(HOLIDAY),
      )
      expect(h.lunch).toEqual({ start: 780, end: 840 })
    })

    it('공휴일이 아닌 날은 요일 휴게 그대로 (회귀 가드)', () => {
      const doctorDay = { morning: { start: 540, end: 1020 }, lunch: { start: 780, end: 840 } }
      const h = resolveUnitHours(
        cfg({ hoursByDoctor: { A: { [holidayWd]: doctorDay } } }),
        unit('2026-01-08'),
      )
      expect(h.lunch).toEqual({ start: 780, end: 840 })
    })
  })
})
