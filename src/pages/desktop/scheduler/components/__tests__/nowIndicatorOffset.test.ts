/**
 * @vitest-environment happy-dom
 *
 * 현재 시각선(본문 가로선 · 시간축 라벨)이 band 안에서 실제 시각 위치에 놓이는지.
 *
 * 두 컴포넌트가 좌표를 band 시작 경계로 snap 하던 시절, 예약단위를 45분으로 바꾸면
 * 11:03 선이 10:30 자리에 그려졌다. 예약단위를 바꿔도 선이 시각을 따라오는지만 본다.
 */

import { describe, it, expect } from 'vitest'
import { ref } from 'vue'
import { mount } from '@vue/test-utils'
import NowIndicator from '../NowIndicator.vue'
import SchedulerTimeAxis from '../SchedulerTimeAxis.vue'

/** 예약단위 45분. 10:30 band 는 카드가 있어 09:45 band 보다 높다(높이 ≠ 시간 비례). */
const BANDS_45 = [
  { startMinute: 585, endMinute: 630, topPx: 181, heightPx: 50, time: '09:45' },
  { startMinute: 630, endMinute: 675, topPx: 231, heightPx: 74, time: '10:30' },
]

const COLUMNS = [
  { key: '2026-09-02__1', date: '2026-09-02', leftPx: 0, widthPx: 200 },
]

/** 2026-09-02 11:03 — 결함 캡처의 시각. */
const AT_11_03 = new Date(2026, 8, 2, 11, 3).getTime()

function topOf(selector: string, wrapper: ReturnType<typeof mount>): number {
  const el = wrapper.find(selector)
  expect(el.exists()).toBe(true)
  return parseFloat((el.element as HTMLElement).style.top)
}

describe('현재 시각선 — 예약단위 45분', () => {
  it('본문 가로선이 10:30 band 안에서 33/45 지점에 놓인다', () => {
    const wrapper = mount(NowIndicator, {
      props: { bandInfos: BANDS_45, columns: COLUMNS },
      global: { provide: { nowTick: ref(AT_11_03) } },
    })

    expect(topOf('.now-indicator', wrapper)).toBeCloseTo(231 + (33 / 45) * 74)
  })

  it('시간축 라벨이 본문 가로선과 같은 높이에 놓인다', () => {
    const axis = mount(SchedulerTimeAxis, {
      props: { bandInfos: BANDS_45 },
      global: { provide: { nowTick: ref(AT_11_03) } },
    })
    const body = mount(NowIndicator, {
      props: { bandInfos: BANDS_45, columns: COLUMNS },
      global: { provide: { nowTick: ref(AT_11_03) } },
    })

    expect(topOf('.time-axis-now', axis)).toBeCloseTo(topOf('.now-indicator', body))
  })

  it('라벨 문구는 실제 현재 시각을 그대로 쓴다', () => {
    const axis = mount(SchedulerTimeAxis, {
      props: { bandInfos: BANDS_45 },
      global: { provide: { nowTick: ref(AT_11_03) } },
    })

    expect(axis.find('.time-axis-now__label').text()).toBe('11:03')
  })

  it('band 상단에 붙지 않는다 — 10:30 자리와 다른 좌표여야 한다', () => {
    const wrapper = mount(NowIndicator, {
      props: { bandInfos: BANDS_45, columns: COLUMNS },
      global: { provide: { nowTick: ref(AT_11_03) } },
    })

    expect(topOf('.now-indicator', wrapper)).toBeGreaterThan(231)
  })
})

/**
 * 보이는 구간 — 본문 가로선과 축 라벨은 같은 순간에 같이 보이고 같이 사라진다.
 * 두 컴포넌트가 계산을 각자 들고 있을 때 부등호가 갈려(본문 `<`, 축 `<=`) 마지막 band 끝 정각
 * 1분 동안 축 라벨만 남았다. 구간은 band 와 같은 반개구간이다.
 * 기대값 출처: 정책 결정(2026-09-07, "동일하게 맞춘다") — 끝 정각은 band 밖이므로 둘 다 숨긴다.
 */
describe('현재 시각선 — 보이는 구간은 두 컴포넌트가 같다', () => {
  const mountBoth = (tick: number) => ({
    axis: mount(SchedulerTimeAxis, { props: { bandInfos: BANDS_45 }, global: { provide: { nowTick: ref(tick) } } }),
    body: mount(NowIndicator, { props: { bandInfos: BANDS_45, columns: COLUMNS }, global: { provide: { nowTick: ref(tick) } } }),
  })

  it('🔑 마지막 band 끝 정각(11:15)에는 둘 다 보이지 않는다', () => {
    const { axis, body } = mountBoth(new Date(2026, 8, 2, 11, 15).getTime())
    expect(axis.find('.time-axis-now').exists()).toBe(false)
    expect(body.find('.now-indicator').exists()).toBe(false)
  })

  it('끝 1분 전(11:14)에는 둘 다 보인다', () => {
    const { axis, body } = mountBoth(new Date(2026, 8, 2, 11, 14).getTime())
    expect(axis.find('.time-axis-now').exists()).toBe(true)
    expect(body.find('.now-indicator').exists()).toBe(true)
  })

  it('첫 band 시작 정각(09:45)에는 둘 다 보인다', () => {
    const { axis, body } = mountBoth(new Date(2026, 8, 2, 9, 45).getTime())
    expect(axis.find('.time-axis-now').exists()).toBe(true)
    expect(body.find('.now-indicator').exists()).toBe(true)
  })
})
