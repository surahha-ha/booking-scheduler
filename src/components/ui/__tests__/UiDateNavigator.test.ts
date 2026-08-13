/**
 * @vitest-environment happy-dom
 *
 * UiDateNavigator — 예약/진료 장부 상단의 "‹ 03월 08일 ~ 03월 14일 ›" 기간 이동 바.
 *
 * 이 컴포넌트는 props 가 없다. 모든 상태를 useSchedulerFilterStore 에서 직접 읽고 쓴다
 * (viewMode / periodDate / dataType). 그래서 검증은 "스토어를 이렇게 두면 화면이 이렇게 보이고,
 * 화면을 이렇게 누르면 스토어가 이렇게 바뀐다" 형태가 된다.
 *
 * ★방문 장부(dataType='TREATMENT')는 미래를 볼 수 없다는 규칙이 두 군데로 나뉘어 있다.
 *   - maxDate  : 달력에서 오늘 이후를 못 고르게
 *   - canMoveNext : '›' 화살표를 숨겨 오늘 이후로 못 넘어가게
 *
 * 날짜 단정이 특정 날에만 깨지지 않도록 시스템 시각을 2026-03-11(수)로 고정한다.
 * 이 주는 2026-03-08(일) ~ 2026-03-14(토) 이다(dayjs 기본 주 시작 = 일요일).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import dayjs from 'dayjs'

// VueDatePicker 는 무겁고 이 테스트의 관심사도 아니다.
// 대신 "어떤 props 로 열렸는지" 와 "선택을 emit 하면 무슨 일이 일어나는지" 만 볼 수 있게 최소 스텁으로 바꾼다.
vi.mock('@vuepic/vue-datepicker', async () => {
  const { h } = await import('vue')
  return {
    VueDatePicker: {
      name : 'VueDatePicker',
      props: {
        modelValue: { default: null },
        maxDate   : { default: null },
        weekPicker: { type: Boolean, default: false },
        yearRange : { default: () => [] },
      },
      emits: ['update:model-value'],
      setup: () => () => h('div', { class: 'datePickerStub' }),
    },
  }
})

import { useSchedulerFilterStore } from '@/stores/useSchedulerFilterStore'
import UiDateNavigator from '@/components/ui/UiDateNavigator.vue'

const NOW = new Date(2026, 2, 11, 10, 0, 0) // 2026-03-11(수) 10:00

function ymd(d: Date | null | undefined) {
  return d ? dayjs(d).format('YYYY-MM-DD') : null
}

function mountNav() {
  return mount(UiDateNavigator)
}

/** [이전(‹), 다음(›)] 화살표 */
function arrows(wrapper: any) {
  return wrapper.findAll('.scheduleNavDate__arrow')
}

/**
 * 화살표가 보이는지.
 * 감추기는 is-hidden 클래스(visibility:hidden + pointer-events:none)로 한다 —
 * display:none 으로 빼면 화살표가 사라질 때 가운데 기간 텍스트가 밀린다.
 * CSS 는 happy-dom 에서 평가되지 않으므로 클래스 부착 여부로 판정한다.
 */
function isShown(el: any) {
  return !el.classes().includes('is-hidden')
}

function periodText(wrapper: any) {
  return wrapper.find('.scheduleNavDate__text').text()
}

/** 기간 텍스트를 눌러 달력을 연다 */
async function openCalendar(wrapper: any) {
  await wrapper.find('.scheduleNavDate__text').trigger('click')
}

function picker(wrapper: any) {
  return wrapper.findComponent({ name: 'VueDatePicker' })
}

describe('UiDateNavigator', () => {
  let store: ReturnType<typeof useSchedulerFilterStore>

  beforeEach(() => {
    // Date 만 고정한다 — setTimeout 까지 가로채면 Vue/VTU 동작에 불필요한 영향이 생긴다.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
    setActivePinia(createPinia())
    store = useSchedulerFilterStore()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('기간 표시', () => {
    it('주 단위에서는 기준일이 속한 주의 시작~끝을 보여준다', () => {
      // 스토어 초기값이 이미 "오늘이 속한 주의 일요일"로 정규화되어 있다
      expect(ymd(store.periodDate)).toBe('2026-03-08')
      expect(periodText(mountNav())).toBe('03월 08일 ~ 03월 14일')
    })

    it('일 단위에서는 기준일 하루만 보여준다', () => {
      store.$patch({ viewMode: 'DAY', periodDate: new Date(2026, 2, 11) })
      // 요일 표기(ddd)는 dayjs 로케일에 달려 있어 앞부분만 고정한다
      expect(periodText(mountNav())).toMatch(/^03월 11일\(/)
    })

    it('스토어의 기준일이 바뀌면 표시도 따라 바뀐다', async () => {
      const wrapper = mountNav()

      store.setPeriodDate(new Date(2026, 2, 25))
      await wrapper.vm.$nextTick()

      expect(periodText(wrapper)).toBe('03월 22일 ~ 03월 28일')
    })
  })

  describe('화살표로 기간 이동', () => {
    it('주 단위에서 ‹ 는 한 주 전, › 는 한 주 뒤로 옮긴다', async () => {
      const wrapper = mountNav()
      const [prev, next] = arrows(wrapper)

      await prev.trigger('click')
      expect(ymd(store.periodDate)).toBe('2026-03-01')

      await next.trigger('click')
      await next.trigger('click')
      expect(ymd(store.periodDate)).toBe('2026-03-15')
    })

    it('일 단위에서는 하루씩 옮긴다', async () => {
      store.$patch({ viewMode: 'DAY', periodDate: new Date(2026, 2, 11) })
      const wrapper = mountNav()
      const [prev, next] = arrows(wrapper)

      await prev.trigger('click')
      expect(ymd(store.periodDate)).toBe('2026-03-10')

      await next.trigger('click')
      await next.trigger('click')
      expect(ymd(store.periodDate)).toBe('2026-03-12')
    })

    it('기간을 옮기면 재조회가 걸린다 (searchVersion 증가)', async () => {
      const wrapper = mountNav()
      const before = store.searchVersion

      await arrows(wrapper)[0].trigger('click')

      expect(store.searchVersion).toBe(before + 1)
    })

    it('화살표 클릭은 달력을 열지 않는다 (텍스트 클릭과 역할이 다르다)', async () => {
      const wrapper = mountNav()

      await arrows(wrapper)[0].trigger('click')

      expect(wrapper.find('.scheduleDatePopup').exists()).toBe(false)
    })
  })

  describe('방문 장부는 미래로 못 간다', () => {
    it('예약장부에서는 › 가 항상 보인다', () => {
      store.$patch({ dataType: 'APPOINTMENT', viewMode: 'DAY', periodDate: new Date(2026, 2, 11) })
      expect(isShown(arrows(mountNav())[1])).toBe(true)
    })

    it('방문 장부에서 오늘을 보고 있으면 › 가 사라진다', () => {
      store.$patch({ dataType: 'TREATMENT', viewMode: 'DAY', periodDate: new Date(2026, 2, 11) })
      expect(isShown(arrows(mountNav())[1])).toBe(false)
    })

    it('방문 장부라도 과거를 보고 있으면 › 로 되돌아올 수 있다', () => {
      store.$patch({ dataType: 'TREATMENT', viewMode: 'DAY', periodDate: new Date(2026, 2, 10) })
      expect(isShown(arrows(mountNav())[1])).toBe(true)
    })

    it('› 가 숨어도 ‹ 는 남는다 (과거로는 언제든 이동)', () => {
      store.$patch({ dataType: 'TREATMENT', viewMode: 'DAY', periodDate: new Date(2026, 2, 11) })
      expect(isShown(arrows(mountNav())[0])).toBe(true)
    })

    it('방문 장부 달력은 오늘까지만 고를 수 있다', async () => {
      store.$patch({ dataType: 'TREATMENT' })
      const wrapper = mountNav()
      await openCalendar(wrapper)

      const maxDate = picker(wrapper).props('maxDate') as Date
      expect(ymd(maxDate)).toBe('2026-03-11')
    })

    it('예약장부 달력에는 상한이 없다', async () => {
      const wrapper = mountNav()
      await openCalendar(wrapper)

      expect(picker(wrapper).props('maxDate')).toBeNull()
    })

    // ★주 단위는 periodDate 가 "그 주의 일요일"이라 시작일만 보면 이번 주에도 › 가 살아난다.
    //   판정 기준은 기간의 마지막 날이어야 maxDate(오늘까지) 와 규칙이 맞는다.
    it('방문 장부 주 단위에서 이번 주를 보고 있으면 › 가 사라진다', () => {
      // 2026-03-08(일)~03-14(토), 오늘은 03-11(수) — 다음 주는 전부 미래다
      store.$patch({ dataType: 'TREATMENT', viewMode: 'WEEK', periodDate: new Date(2026, 2, 8) })
      expect(isShown(arrows(mountNav())[1])).toBe(false)
    })

    it('방문 장부 주 단위라도 지난 주를 보고 있으면 › 로 되돌아올 수 있다', () => {
      store.$patch({ dataType: 'TREATMENT', viewMode: 'WEEK', periodDate: new Date(2026, 2, 1) })
      expect(isShown(arrows(mountNav())[1])).toBe(true)
    })

    it('예약장부는 주 단위에서도 › 가 항상 보인다', () => {
      store.$patch({ dataType: 'APPOINTMENT', viewMode: 'WEEK', periodDate: new Date(2026, 2, 8) })
      expect(isShown(arrows(mountNav())[1])).toBe(true)
    })

    it('오늘이 그 주의 마지막 날(토)이어도 › 는 사라진다 — 다음 주는 여전히 전부 미래다', () => {
      vi.setSystemTime(new Date(2026, 2, 14, 10, 0, 0)) // 03-14(토)
      store.$patch({ dataType: 'TREATMENT', viewMode: 'WEEK', periodDate: new Date(2026, 2, 8) })
      expect(isShown(arrows(mountNav())[1])).toBe(false)
    })
  })

  describe('달력 열기/고르기', () => {
    it('기간 텍스트를 누르면 달력이 열린다', async () => {
      const wrapper = mountNav()
      expect(wrapper.find('.scheduleDatePopup').exists()).toBe(false)

      await openCalendar(wrapper)

      expect(wrapper.find('.scheduleDatePopup').exists()).toBe(true)
    })

    it('주 단위에서는 주 선택 달력이, 일 단위에서는 날짜 달력이 열린다', async () => {
      const week = mountNav()
      await openCalendar(week)
      expect(picker(week).props('weekPicker')).toBe(true)

      store.$patch({ viewMode: 'DAY' })
      const day = mountNav()
      await openCalendar(day)
      expect(picker(day).props('weekPicker')).toBe(false)
    })

    it('연도 선택 폭은 올해 기준 앞뒤 10년이다', async () => {
      const wrapper = mountNav()
      await openCalendar(wrapper)

      expect(picker(wrapper).props('yearRange')).toEqual([2016, 2036])
    })

    it('주를 고르면 그 주의 시작일로 이동하고 달력이 닫힌다', async () => {
      const wrapper = mountNav()
      await openCalendar(wrapper)

      // week-picker 는 [시작, 끝] 쌍을 준다
      picker(wrapper).vm.$emit('update:model-value', [new Date(2026, 3, 8), new Date(2026, 3, 14)])
      await wrapper.vm.$nextTick()

      expect(ymd(store.periodDate)).toBe('2026-04-05') // 2026-04-08(수)이 속한 주의 일요일
      expect(wrapper.find('.scheduleDatePopup').exists()).toBe(false)
    })

    it('날짜를 고르면 그 날로 이동하고 달력이 닫힌다', async () => {
      store.$patch({ viewMode: 'DAY' })
      const wrapper = mountNav()
      await openCalendar(wrapper)

      picker(wrapper).vm.$emit('update:model-value', new Date(2026, 3, 8))
      await wrapper.vm.$nextTick()

      expect(ymd(store.periodDate)).toBe('2026-04-08')
      expect(wrapper.find('.scheduleDatePopup').exists()).toBe(false)
    })

    it('빈 선택(달력 초기화)은 무시된다 — 보던 기간이 날아가면 안 된다', async () => {
      store.$patch({ viewMode: 'DAY', periodDate: new Date(2026, 2, 11) })
      const wrapper = mountNav()
      await openCalendar(wrapper)

      picker(wrapper).vm.$emit('update:model-value', null)
      await wrapper.vm.$nextTick()

      expect(ymd(store.periodDate)).toBe('2026-03-11')
      expect(wrapper.find('.scheduleDatePopup').exists()).toBe(true) // 닫히지도 않는다
    })
  })
})
