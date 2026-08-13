/**
 * @vitest-environment happy-dom
 *
 * UiMemberTypeToggle — 통합회원/전체 회원 구분 토글 (라벨 + 건수).
 *
 * 이 컴포넌트는 componentConstants.isLabelFixedMode 스위치로 **성격이 통째로 바뀐다**.
 *  - true (현재 운영값): 토글이 아니라 그냥 라벨. 클릭해도 아무 일도 없고, 'Y' 항목이 늘 강조된다.
 *  - false: 평범한 v-model 토글.
 * 두 갈래가 같은 마크업을 쓰지만 별개 v-for 라, 갈래별로 나눠 고정한다.
 *
 * 상수는 모듈 로드 시점에 굳는 값이라 vi.hoisted + getter 로 갈아끼운다
 * (컴포넌트가 렌더할 때마다 읽어가므로, mount 전에 값을 정하면 된다).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

import UiMemberTypeToggle from '@/components/ui/UiMemberTypeToggle.vue'

const flags = vi.hoisted(() => ({ labelFixed: true }))

vi.mock('@/constants/componentConstants', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    get isLabelFixedMode() {
      return flags.labelFixed
    },
  }
})

const ITEMS = [
  { value: 'N', label: '전체' },
  { value: 'Y', label: '통합회원' },
]

function mountToggle(props: Record<string, unknown> = {}) {
  return mount(UiMemberTypeToggle, {
    props: { modelValue: 'N', buttonItems: ITEMS, ...props },
  })
}

function btns(wrapper: any) {
  return wrapper.findAll('.scheduleMemberToggle__btn')
}

/** 각 버튼의 [텍스트, 활성여부] */
function state(wrapper: any) {
  return btns(wrapper).map((el: any) => [el.text(), el.classes('is-active')])
}

beforeEach(() => {
  flags.labelFixed = true
})

describe('UiMemberTypeToggle — 라벨 고정 모드 (isLabelFixedMode=true, 현재 운영값)', () => {
  it('항목 수만큼 버튼을 그리고 라벨 뒤에 건수를 붙인다', () => {
    const wrapper = mountToggle({ statistics: { N: 10, Y: 3 } })

    expect(btns(wrapper).map((el: any) => el.text())).toEqual(['전체 10', '통합회원 3'])
  })

  it('★modelValue 와 무관하게 "Y" 항목만 강조된다 — 선택이 아니라 고정 표시이기 때문', () => {
    const wrapper = mountToggle({ modelValue: 'N' })

    expect(state(wrapper)).toEqual([['전체 0', false], ['통합회원 0', true]])
  })

  it('modelValue 를 바꿔도 강조 위치가 따라가지 않는다', async () => {
    const wrapper = mountToggle({ modelValue: 'N' })

    await wrapper.setProps({ modelValue: 'Y' })

    expect(state(wrapper)).toEqual([['전체 0', false], ['통합회원 0', true]])
  })

  it('★눌러도 아무것도 내보내지 않는다 (읽기 전용)', async () => {
    const wrapper = mountToggle()

    await btns(wrapper)[0].trigger('click')
    await btns(wrapper)[1].trigger('click')

    expect(wrapper.emitted('update:modelValue')).toBeFalsy()
  })

  it('누를 수 없다는 것을 커서로 알린다', () => {
    const wrapper = mountToggle()

    expect(btns(wrapper).every((el: any) => el.attributes('style')?.includes('cursor: default')))
      .toBe(true)
  })

  it('"Y" 항목이 아예 없으면 강조되는 버튼도 없다', () => {
    const wrapper = mountToggle({ modelValue: 'N', buttonItems: [ITEMS[0]] })

    expect(state(wrapper)).toEqual([['전체 0', false]])
  })
})

describe('UiMemberTypeToggle — 토글 모드 (isLabelFixedMode=false)', () => {
  beforeEach(() => {
    flags.labelFixed = false
  })

  it('modelValue 와 같은 값의 버튼이 강조된다 (v-model 계약)', () => {
    const wrapper = mountToggle({ modelValue: 'N' })

    expect(state(wrapper)).toEqual([['전체 0', true], ['통합회원 0', false]])
  })

  it('누르면 그 항목의 value 를 내보낸다', async () => {
    const wrapper = mountToggle({ modelValue: 'N' })

    await btns(wrapper)[1].trigger('click')

    expect(wrapper.emitted('update:modelValue')).toEqual([['Y']])
  })

  it('부모가 되돌려준 modelValue 로만 강조가 옮겨간다 (자체 상태 없음)', async () => {
    const wrapper = mountToggle({ modelValue: 'N' })

    await btns(wrapper)[1].trigger('click')
    expect(state(wrapper)).toEqual([['전체 0', true], ['통합회원 0', false]])

    await wrapper.setProps({ modelValue: 'Y' })
    expect(state(wrapper)).toEqual([['전체 0', false], ['통합회원 0', true]])
  })
})

describe('UiMemberTypeToggle — 건수 표시 (모드 공통)', () => {
  it.each([true, false])('★건수는 label 이 아니라 value 키로 찾는다 (isLabelFixedMode=%s)', (fixed) => {
    flags.labelFixed = fixed
    const wrapper = mountToggle({ statistics: { N: 10, '전체': 999 } })

    expect(btns(wrapper)[0].text()).toBe('전체 10')
  })

  it.each([true, false])('통계에 없는 항목은 0 으로 채운다 (isLabelFixedMode=%s)', (fixed) => {
    flags.labelFixed = fixed
    const wrapper = mountToggle({ statistics: { N: 10 } })

    expect(btns(wrapper)[1].find('.scheduleMemberToggle__count').text()).toBe('0')
  })

  it.each([true, false])('항목이 비면 버튼도 없다 (isLabelFixedMode=%s)', (fixed) => {
    flags.labelFixed = fixed
    const wrapper = mountToggle({ buttonItems: [] })

    expect(btns(wrapper)).toHaveLength(0)
    expect(wrapper.find('.scheduleMemberToggle').exists()).toBe(true)
  })
})
