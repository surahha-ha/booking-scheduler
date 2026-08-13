/**
 * @vitest-environment happy-dom
 *
 * UiSwitchButton — on/off 스위치 (운영중/운영종료 등).
 *
 * 알맹이는 checkbox input 하나다. 켜짐 표시도, 라벨 문구도 전부 CSS 가 그린다 —
 * 라벨은 data-on-label/data-off-label 속성에 실려 content: attr() 로 나가므로,
 * 텍스트가 아니라 **속성**을 검증해야 한다(DOM 에 글자가 없다).
 *
 * 크기·색도 마찬가지로 루트의 CSS 커스텀 프로퍼티로만 전달된다.
 * 상태는 modelValue 가 유일한 근거이고 자체 상태는 없다(부모가 안 받아주면 화면은 원래대로).
 */

import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import UiSwitchButton from '@/components/ui/UiSwitchButton.vue'

function mountSwitch(props: Record<string, unknown> = {}) {
  return mount(UiSwitchButton, { props: { modelValue: false, ...props } })
}

function input(wrapper: any) {
  return wrapper.find('input.form-check-input')
}

/** 루트에 실린 CSS 변수 하나 읽기 */
function cssVar(wrapper: any, name: string) {
  return (wrapper.element as HTMLElement).style.getPropertyValue(name)
}

describe('UiSwitchButton — 상태 표시', () => {
  it('modelValue=false 면 꺼진 채로 그려진다', () => {
    const wrapper = mountSwitch({ modelValue: false })

    expect((input(wrapper).element as HTMLInputElement).checked).toBe(false)
  })

  it('modelValue=true 면 켜진 채로 그려진다', () => {
    const wrapper = mountSwitch({ modelValue: true })

    expect((input(wrapper).element as HTMLInputElement).checked).toBe(true)
  })

  it('부모가 modelValue 를 바꾸면 그대로 따라간다 (v-model 계약)', async () => {
    const wrapper = mountSwitch({ modelValue: false })

    await wrapper.setProps({ modelValue: true })
    expect((input(wrapper).element as HTMLInputElement).checked).toBe(true)

    await wrapper.setProps({ modelValue: false })
    expect((input(wrapper).element as HTMLInputElement).checked).toBe(false)
  })

  it('modelValue 를 안 넘기면 꺼진 상태가 기본이다 (Boolean prop 기본값)', () => {
    const wrapper = mount(UiSwitchButton)

    expect((input(wrapper).element as HTMLInputElement).checked).toBe(false)
  })

  it('보조기술이 스위치로 읽도록 role=switch 인 checkbox 다', () => {
    const wrapper = mountSwitch()

    expect(input(wrapper).attributes('type')).toBe('checkbox')
    expect(input(wrapper).attributes('role')).toBe('switch')
  })
})

describe('UiSwitchButton — 조작', () => {
  it('끈 상태에서 켜면 true 를 내보낸다', async () => {
    const wrapper = mountSwitch({ modelValue: false })

    await input(wrapper).setValue(true)

    expect(wrapper.emitted('update:modelValue')).toEqual([[true]])
  })

  it('켠 상태에서 끄면 false 를 내보낸다', async () => {
    const wrapper = mountSwitch({ modelValue: true })

    await input(wrapper).setValue(false)

    expect(wrapper.emitted('update:modelValue')).toEqual([[false]])
  })

  it('★내보내는 값은 실제 체크 상태다 — prop 을 뒤집은 값이 아니다', async () => {
    // 부모가 modelValue 를 안 받아준 채로 두 번 조작해도, DOM 이 만든 상태가 그대로 나간다.
    // (prop 기준 !modelValue 였다면 두 번 다 true 가 나갔을 것)
    const wrapper = mountSwitch({ modelValue: false })

    await input(wrapper).setValue(true)
    await input(wrapper).setValue(false)

    expect(wrapper.emitted('update:modelValue')).toEqual([[true], [false]])
  })
})

describe('UiSwitchButton — 라벨 (CSS content 로 나가는 값)', () => {
  it('기본 문구는 운영중/운영종료 다', () => {
    const wrapper = mountSwitch()

    expect(input(wrapper).attributes('data-on-label')).toBe('운영중')
    expect(input(wrapper).attributes('data-off-label')).toBe('운영종료')
  })

  it('문구를 바꿔 끼울 수 있다', () => {
    const wrapper = mountSwitch({ onLabel: '사용', offLabel: '미사용' })

    expect(input(wrapper).attributes('data-on-label')).toBe('사용')
    expect(input(wrapper).attributes('data-off-label')).toBe('미사용')
  })

  it('★두 문구는 상태와 무관하게 늘 함께 실려 있다 — 고르는 것은 CSS 의 :checked 다', async () => {
    const wrapper = mountSwitch({ modelValue: true })

    expect(input(wrapper).attributes('data-on-label')).toBe('운영중')
    expect(input(wrapper).attributes('data-off-label')).toBe('운영종료')

    await wrapper.setProps({ modelValue: false })
    expect(input(wrapper).attributes('data-on-label')).toBe('운영중')
  })
})

describe('UiSwitchButton — 크기·색 (CSS 변수)', () => {
  it('기본 크기는 81x24 px 이다', () => {
    const wrapper = mountSwitch()

    expect(cssVar(wrapper, '--switch-width')).toBe('81px')
    expect(cssVar(wrapper, '--switch-height')).toBe('24px')
  })

  it('숫자로 넘긴 크기에 px 를 붙여준다', () => {
    const wrapper = mountSwitch({ width: 120, height: 30 })

    expect(cssVar(wrapper, '--switch-width')).toBe('120px')
    expect(cssVar(wrapper, '--switch-height')).toBe('30px')
  })

  it('숫자 문자열로 넘겨도 같은 결과가 된다', () => {
    const wrapper = mountSwitch({ width: '120', height: '30' })

    expect(cssVar(wrapper, '--switch-width')).toBe('120px')
    expect(cssVar(wrapper, '--switch-height')).toBe('30px')
  })

  // props 타입이 [String, Number] 라 단위 붙은 문자열도 들어올 수 있다.
  // Number('81px') 는 NaN 이므로 그대로 곱하면 'NaNpx' 가 되어 스타일만 조용히 깨진다.
  it('★단위가 이미 붙어 있으면 그대로 쓴다 (px 를 덧붙여 NaN 으로 만들지 않는다)', () => {
    const wrapper = mountSwitch({ width: '81px', height: '2rem' })

    expect(cssVar(wrapper, '--switch-width')).toBe('81px')
    expect(cssVar(wrapper, '--switch-height')).toBe('2rem')
  })

  it('기본 색은 on=#0BA45D / off=#C6C6C6 이고 바꿔 끼울 수 있다', () => {
    expect(cssVar(mountSwitch(), '--switch-on')).toBe('#0BA45D')
    expect(cssVar(mountSwitch(), '--switch-off')).toBe('#C6C6C6')

    const custom = mountSwitch({ onColor: '#0a0', offColor: '#eee' })
    expect(cssVar(custom, '--switch-on')).toBe('#0a0')
    expect(cssVar(custom, '--switch-off')).toBe('#eee')
  })

  it('thumb·여백은 고정값이라 props 로 흔들리지 않는다', () => {
    const wrapper = mountSwitch({ width: 200 })

    expect(cssVar(wrapper, '--switch-dot-size')).toBe('18px')
    expect(cssVar(wrapper, '--switch-pad')).toBe('3px')
    expect(cssVar(wrapper, '--switch-gap')).toBe('6px')
  })
})
