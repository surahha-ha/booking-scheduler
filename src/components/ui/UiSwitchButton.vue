<script setup>
const props = defineProps({
  modelValue: Boolean,
  offLabel: { type: String, default: '운영종료' },
  onLabel: { type: String, default: '운영중' },
  width: { type: [String, Number], default: 81 },
  height: { type: [String, Number], default: 24 },
  onColor: { type: String, default: '#0BA45D' },
  offColor: { type: String, default: '#C6C6C6' },
});
const emit = defineEmits(['update:modelValue']);

// props 타입이 [String, Number] 라 '81px' 처럼 단위가 붙은 문자열도 들어올 수 있다.
// Number('81px') 는 NaN 이라 'NaNpx' 가 되어 스타일만 조용히 깨진다 — 숫자일 때만 px 를 붙인다.
function toPx(value) {
  const raw = String(value ?? '').trim();
  return /^-?\d+(\.\d+)?$/.test(raw) ? `${raw}px` : raw;
}
</script>

<template>
  <div
    :style="{
      '--switch-width': toPx(props.width),
      '--switch-height': toPx(props.height),
      '--switch-dot-size': '18px',
      '--switch-on': props.onColor,
      '--switch-off': props.offColor,
      '--switch-pad': '3px',
      '--switch-gap': '6px',
    }"
    class="form-check form-switch custom-switch-main"
  >
    <input
      :checked="modelValue"
      :aria-label="`${onLabel} / ${offLabel}`"
      :data-off-label="offLabel"
      :data-on-label="onLabel"
      class="form-check-input"
      type="checkbox"
      role="switch"
      @change="emit('update:modelValue', $event.target.checked)"
    >
  </div>
</template>

<style lang="scss" scoped>
/* 자체 완결 스위치 — 클래스명(form-check / form-switch / form-check-input)은 Bootstrap 시절 이름을
 * 그대로 두었다(테스트·호출처가 참조). 예전엔 Bootstrap 이 주던 base 규칙(appearance·테두리·pill)을
 * 여기서 직접 정의하므로 외부 CSS 없이 동작한다. */
.custom-switch-main {
  display: block;
  min-height: 1.5rem;
  margin-bottom: .125rem;
  padding: 0;

  .form-check-input {
    appearance: none;
    -webkit-appearance: none;
    display: block;
    flex-shrink: 0;
    margin: 0;
    padding: 0;
    border: 1px solid var(--switch-off);
    border-radius: 2em;
    vertical-align: top;
    print-color-adjust: exact;

    width: var(--switch-width);
    height: var(--switch-height);
    cursor: pointer;
    position: relative;

    // 배경색 (OFF 기본)
    background-color: var(--switch-off);
    border-color: var(--switch-off);

    // 스위치 thumb (흰 동그라미)
    background-image: url("data:image/svg+xml,%3csvg xmlns='http://www.w3.org/2000/svg' viewBox='-4 -4 8 8'%3e%3ccircle r='3' fill='%23fff'/%3e%3c/svg%3e");
    background-repeat: no-repeat;
    background-size: var(--switch-dot-size) var(--switch-dot-size);

    // OFF: 왼쪽 thumb
    background-position: var(--switch-pad) center;

    transition: background-position 0.18s ease, background-color 0.18s ease, border-color 0.18s ease;

    // 텍스트(상태 1개만)
    &::after {
      content: attr(data-off-label);
      position: absolute;
      top: 50%;
      transform: translateY(-50%);
      font-size: 14px;
      font-weight: 700;
      letter-spacing: -0.07px;
      color: #fff;

      left: calc(var(--switch-pad) + var(--switch-dot-size) + var(--switch-gap));
      right: 6px;
      text-align: left;

      white-space: nowrap;
      pointer-events: none;
    }

    &:checked {
      // ON: 연두 배경
      background-color: var(--switch-on);
      border-color: var(--switch-on);

      // ON: 오른쪽 thumb
      background-position: calc(100% - var(--switch-pad)) center;

      // ON: 텍스트를 오른쪽에 붙여서 정렬
      &::after {
        content: attr(data-on-label);
        left: var(--switch-pad);
        right: calc(var(--switch-pad) + var(--switch-dot-size) + var(--switch-gap));
        text-align: right;
      }
    }

    &:hover,
    &:checked:hover {
      outline: none !important;
      box-shadow: none !important;
    }

    &:active,
    &:checked:active {
      box-shadow: none;
      filter: none;
    }
  }

  .form-check-label {
    display: none;
  }
}
</style>
