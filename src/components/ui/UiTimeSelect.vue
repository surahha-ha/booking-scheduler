<script setup>
import {nextTick, onBeforeUnmount, onMounted, ref, watch} from 'vue';

const props = defineProps({
  modelValue : {type: String, default: ''},
  options    : {type: Array, default: () => []},
  placeholder: {type: String, default: '선택'},
  readonly   : {type: Boolean, default: false},
  maxHeight  : {type: Number, default: 220},
  invalid    : {type: Boolean, default: false},
});

const emit = defineEmits(['update:modelValue']);

const open = ref(false);
const direction = ref('down'); // "down" | "up"
const rootEl = ref(null);
const btnEl = ref(null);
const listEl = ref(null);

function getButtonRect() {
  const btn = btnEl.value;
  return btn ? btn.getBoundingClientRect() : null;
}

function shouldStopWheelPropagation(el, event) {
  const atTop = el.scrollTop <= 0;
  const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
  const scrollingUp = event.deltaY < 0;
  const scrollingDown = event.deltaY > 0;

  return (!atTop && scrollingUp) || (!atBottom && scrollingDown);
}

function toggle(e) {
  e?.stopPropagation?.();
  if (props.readonly) return;

  if (!open.value) {
    decideDirection();
  }

  open.value = !open.value;

  if (open.value) {
    nextTick(() => {
      scrollToActive();
    });
  }
}

function close() {
  open.value = false;
}

function select(v) {
  emit('update:modelValue', v);
  close();
}

function decideDirection() {
  const rect = getButtonRect();
  if (!rect) {
    direction.value = 'down';
    return;
  }

  const need = props.maxHeight;
  const spaceBelow = window.innerHeight - rect.bottom;
  const spaceAbove = rect.top;

  // 아래 공간이 부족하고, 위 공간이 더 낫다면 위로 연다.
  if (spaceBelow < need && spaceAbove > spaceBelow) {
    direction.value = 'up';
  } else {
    direction.value = 'down';
  }
}

function scrollToActive() {
  const list = listEl.value;
  if (!list) return;

  const active = list.querySelector(".timeSelect__item.is-active");
  if (!active) return;

  const listRect = list.getBoundingClientRect();
  const itemRect = active.getBoundingClientRect();
  const delta =
      itemRect.top -
      listRect.top -
      (listRect.height / 2 - itemRect.height / 2);

  list.scrollTop += delta;
}

function onDocClick(e) {
  if (!open.value) return;

  const root = rootEl.value;
  if (root && !root.contains(e.target)) {
    close();
  }
}

function onKeyDown(e) {
  if (!open.value) return;

  if (e.key === 'Escape') {
    e.preventDefault();
    close();
  }
}

function onWindowChange() {
  if (!open.value) return;

  decideDirection();
  nextTick(() => {
    scrollToActive();
  });
}

function onWheel(e) {
  const el = listEl.value;
  if (!el) return;

  // 리스트가 더 스크롤될 여지가 있으면 상위로 휠 이벤트가 새지 않게 막음
  if (shouldStopWheelPropagation(el, e)) {
    e.stopPropagation();
  }
}

watch(
    () => props.modelValue,
    () => {
      if (open.value) {
        nextTick(() => scrollToActive());
      }
    }
);

onMounted(() => {
  document.addEventListener('click', onDocClick, true);
  document.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('resize', onWindowChange, true);
});

onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick, true);
  document.removeEventListener('keydown', onKeyDown, true);
  window.removeEventListener('resize', onWindowChange, true);
});
</script>
<template>
  <div
      ref="rootEl"
      :data-invalid="invalid ? 'true' : 'false'"
      :data-readonly="readonly ? 'true' : 'false'"
      class="timeSelect"
  >
    <button
        ref="btnEl"
        :disabled="readonly"
        class="timeSelect__btn"
        type="button"
        @click="toggle"
    >
      <span class="timeSelect__text">{{ modelValue || placeholder }}</span>
      <span class="timeSelect__caret">▾</span>
    </button>

    <ul
        v-show="open"
        ref="listEl"
        :class="direction"
        class="timeSelect__list"
        @wheel="onWheel"
        @mousedown.stop
    >
      <li
          v-for="t in options"
          :key="t"
          :class="{ 'is-active': t === modelValue }"
          class="timeSelect__item"
          @click="select(t)"
      >
        {{ t }}
      </li>
    </ul>
  </div>
</template>
<style lang="scss" scoped>
.timeSelect,
.timeSelect * {
  box-sizing: border-box;
}

.timeSelect {
  position: relative;
  width: 120px;
}

.timeSelect__btn {
  width: 100%;
  height: 36px;
  padding: 0 10px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  border: 1px solid #ddd;
  background: #fff;
}

.timeSelect__text {
  width: 100%;
  text-align: center;
}

.timeSelect__caret {
  margin-left: 6px;
  flex: 0 0 auto;
}

.timeSelect__list {
  list-style: none;
  margin: 0;
  padding: 0;

  max-height: 210px;
  overflow-y: auto;

  position: absolute;
  left: 0;
  width: 100%;

  border: 1px solid #bdbdbd;
  background: #fff;
  box-shadow: 0 6px 14px rgba(0, 0, 0, 0.12);

  z-index: 9999;
  overscroll-behavior: contain;
  touch-action: pan-y;
}

.timeSelect__list.down {
  top: calc(100% + 4px);
  bottom: auto;
}

.timeSelect__list.up {
  bottom: calc(100% + 4px);
  top: auto;
}

.timeSelect__item {
  list-style: none;
  margin: 0;
  padding: 8px 10px;
  cursor: pointer;
  text-align: center;
}

.timeSelect__item:hover {
  background: #f5f5f5;
}

.timeSelect__item.is-active {
  font-weight: 600;
}

.timeSelect[data-readonly="true"] .timeSelect__btn {
  cursor: default;
  opacity: 0.6;
}

.timeSelect[data-invalid="true"] .timeSelect__btn {
  border-color: #e54848;
  box-shadow: 0 0 0 2px rgba(229, 72, 72, 0.15);
}
</style>
