<template>
  <div class="schedulerToolbar">
    <!-- N칸 보기 -->
    <div class="schedulerToolbar__slotSpan">
      <div aria-label="표시 칸 수 조절" class="schedulerToolbar__stepper" role="group">
        <span class="schedulerToolbar__label">{{ patientSlotSpan }}</span>
        <span class="schedulerToolbar__stepperControls">
          <button aria-label="표시 칸 수 늘리기" class="schedulerToolbar__btn schedulerToolbar__btn--increase" type="button" @click="onSlotSpanChange(1)" />
          <button aria-label="표시 칸 수 줄이기" class="schedulerToolbar__btn schedulerToolbar__btn--decrease" type="button" @click="onSlotSpanChange(-1)" />
        </span>
      </div>
      <span class="schedulerToolbar__text">칸 보기</span>
    </div>

    <!-- 줌 슬라이더 -->
    <div class="schedulerToolbar__zoom">
      <span class="schedulerToolbar__zoomIcon">−</span>
      <input
        type="range"
        class="schedulerToolbar__slider"
        :min="1"
        :max="5"
        :value="zoomLevel"
        @input="onZoomInput"
      />
      <span class="schedulerToolbar__zoomIcon">+</span>
    </div>
  </div>
</template>

<script setup>
const props = defineProps({
  patientSlotSpan: { type: Number, default: 1 },
  zoomLevel: { type: Number, default: 3 },
})

const emit = defineEmits([
  'update:patientSlotSpan',
  'update:zoomLevel',
])

/* 칸 보기 상한 — 화면정의서(OSP_MD_APB02 §10) "최대값을 설정했을 때 14칸 이하로 보일 수 있는
 * 수까지 선택 가능". 엔진 computeBudget 이 예산을 max 14 로 clamp 하므로 같은 값을 상한으로 둔다. */
const MAX_SLOT_SPAN = 14

function onSlotSpanChange(delta) {
  const next = Math.max(1, Math.min(MAX_SLOT_SPAN, props.patientSlotSpan + delta))
  if (next !== props.patientSlotSpan) {
    emit('update:patientSlotSpan', next)
  }
}

function onZoomInput(e) {
  emit('update:zoomLevel', Number(e.target.value))
}
</script>

<style lang="scss" scoped>
@use '@/scss/variables' as *;

.schedulerToolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-shrink: 0;
  padding: 0 10px;
  height: 32px;
  font-size: 12px;
  font-weight: 500;
}

.schedulerToolbar__slotSpan {
  display: flex;
  align-items: center;
  gap: 6px;
}

.schedulerToolbar__stepper {
  display: flex;
  width: 42px;
  height: 24px;
  overflow: hidden;
  border: 1px solid #c4c4c4;
  border-radius: 3px;
  background: #fff;
}

.schedulerToolbar__label {
  display: flex;
  flex: 1;
  align-items: center;
  justify-content: center;
  text-align: center;
  color: $color-text-default;
  font-size: $font-size-14;
  font-weight: 600;
}

.schedulerToolbar__stepperControls {
  display: flex;
  flex-direction: column;
  width: 18px;
  border-left: 1px solid #d9d9d9;
}

.schedulerToolbar__btn {
  position: relative;
  flex: 1;
  padding: 0;
  border: 0;
  background: #fff;
  cursor: pointer;

  &::before {
    position: absolute;
    top: 50%;
    left: 50%;
    width: 0;
    height: 0;
    content: '';
    transform: translate(-50%, -50%);
  }

  &--increase {
    border-bottom: 1px solid #d9d9d9;

    &::before {
      border-right: 4px solid transparent;
      border-bottom: 5px solid #888;
      border-left: 4px solid transparent;
    }
  }

  &--decrease::before {
    border-top: 5px solid #888;
    border-right: 4px solid transparent;
    border-left: 4px solid transparent;
  }

  &:hover {
    background: $color-surface-hover;
  }
}

.schedulerToolbar__text {
  color: $color-text-default;
  font-size: $font-size-14;
  font-weight: $font-weight-semibold;
}

.schedulerToolbar__zoom {
  display: flex;
  align-items: center;
  gap: 8px;
}

.schedulerToolbar__slider {
  width: 184px;
  height: 20px;
  margin: 0;
  appearance: none;
  -webkit-appearance: none;
  background: transparent;
  cursor: pointer;

  &::-webkit-slider-runnable-track {
    height: 20px;
    background:
      linear-gradient(#727272, #727272) left center / 1px 12px no-repeat,
      linear-gradient(#727272, #727272) 25% center / 1px 12px no-repeat,
      linear-gradient(#727272, #727272) 50% center / 1px 12px no-repeat,
      linear-gradient(#727272, #727272) 75% center / 1px 12px no-repeat,
      linear-gradient(#727272, #727272) right center / 1px 12px no-repeat,
      linear-gradient(#E9E9E9, #E9E9E9) center / 100% 4px no-repeat;
  }

  &::-webkit-slider-thumb {
    width: 20px;
    height: 20px;
    margin-top: 0;
    box-sizing: border-box;
    border: 2px solid $color-primary;
    border-radius: 50%;
    background: #fff;
    -webkit-appearance: none;
  }

  &::-moz-range-track {
    height: 20px;
    background:
      linear-gradient(#727272, #727272) left center / 1px 12px no-repeat,
      linear-gradient(#727272, #727272) 25% center / 1px 12px no-repeat,
      linear-gradient(#727272, #727272) 50% center / 1px 12px no-repeat,
      linear-gradient(#727272, #727272) 75% center / 1px 12px no-repeat,
      linear-gradient(#727272, #727272) right center / 1px 12px no-repeat,
      linear-gradient(#E9E9E9, #E9E9E9) center / 100% 4px no-repeat;
  }

  &::-moz-range-thumb {
    width: 16px;
    height: 16px;
    box-sizing: border-box;
    border: 2px solid $color-primary;
    border-radius: 50%;
    background: #fff;
  }
}

.schedulerToolbar__zoomIcon {
  font-size: 25px;
  line-height: 1;
  color: #565656;
  font-weight: 400;
}
</style>
