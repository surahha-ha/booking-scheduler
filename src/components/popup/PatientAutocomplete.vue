<script setup>
import {computed, nextTick, onBeforeUnmount, ref, watch} from 'vue';
import {formatPhoneNumber} from '@/utils/formatStringUtils';

const props = defineProps({
  modelValue     : {type: String, default: ''},
  open           : {type: Boolean, default: false},
  items          : {type: Array, default: () => []},
  placeholder    : {type: String, default: ''},
  invalid        : {type: Boolean, default: false},
  readonly       : {type: Boolean, default: false},
  dataField      : {type: String, default: ''},
  dataScope      : {type: String, default: ''},
  minSearchLength: {type: Number, default: 1},
  maxHeight      : {type: Number, default: 240},
  noDataText     : {type: String, default: '검색조건 결과가 존재하지 않습니다.'},
  /**
   * pick 직후 외부에서 form 채움 등 사이드이펙트를 처리하는 동안
   * 부모가 true 로 설정 → @input → search emit 차단.
   * pick → form 채움 → microtask 에서 false 로 복귀 패턴.
   */
  isPicking      : {type: Boolean, default: false},
  /**
   * 드롭다운을 Teleport(body)+fixed 로 띄움 — 부모가 overflow:auto/hidden 인
   * 컨테이너(검색필터 바 등)일 때 잘림/스크롤 방지. 기본 false = 기존 absolute.
   * 입력칸 우측 정렬(우하단 기준 왼쪽으로 펼침).
   */
  teleport       : {type: Boolean, default: false},
  /**
   * teleport 시 드롭다운 우측 정렬 기준 엘리먼트 selector.
   * 미지정이면 입력칸 우측에 맞춤. 지정 시 그 엘리먼트 우측 끝에 맞춤
   * (예: 검색필터 바 전체 우측 = 설정버튼 끝).
   */
  teleportRightAnchor: {type: String, default: ''},
});

const emit = defineEmits([
  'update:modelValue',
  'update:open',
  'pick',
  'search',
  'focus',
  'blur',
  'load-more',
]);

// 무한 스크롤: 드롭다운 하단 근처 도달 시 load-more emit(가산 — 미사용처는 무시).
// 부모가 loading/hasMore 가드로 중복 호출 방지.
const LOAD_MORE_THRESHOLD_PX = 24;
function onListScroll(e) {
  const el = e.target;
  if (!el) return;
  if (el.scrollTop + el.clientHeight >= el.scrollHeight - LOAD_MORE_THRESHOLD_PX) {
    emit('load-more');
  }
}

const inputRef = ref(null);
const dropdownRef = ref(null);
const activeIdx = ref(0);
const composing = ref(false);

// a11y: input 과 listbox/option 을 연결하는 유니크 id.
let uidSeq = 0;
const uid = `patientAutocomplete-${++uidSeq}-${Math.random().toString(36).slice(2, 7)}`;
const listboxId = `${uid}-listbox`;
const optionId = (i) => `${uid}-opt-${i}`;

const showDropdown = computed(() => props.open && !props.readonly);

// ── teleport(body)+fixed 좌표 — 입력칸 우측 정렬(우하단 기준 왼쪽으로 펼침) ──
const dropdownFixedStyle = ref({});
function updateDropdownPos() {
  if (!props.teleport) return;
  const el = inputRef.value;
  if (!el) return;
  const r = el.getBoundingClientRect();
  // 우측 정렬 기준: anchor 지정 시 그 엘리먼트 우측, 아니면 입력칸 우측.
  let rightEdge = r.right;
  if (props.teleportRightAnchor) {
    const anchor = document.querySelector(props.teleportRightAnchor);
    if (anchor) rightEdge = anchor.getBoundingClientRect().right;
  }
  dropdownFixedStyle.value = {
    position: 'fixed',
    top     : `${Math.round(r.bottom + 2)}px`,
    right   : `${Math.round(window.innerWidth - rightEdge)}px`,
    left    : 'auto',
    minWidth: `${Math.max(Math.round(r.width), 320)}px`,
    zIndex  : 2000,
  };
}
const dropdownStyle = computed(() => {
  const base = {maxHeight: `${props.maxHeight}px`};
  return props.teleport ? {...base, ...dropdownFixedStyle.value} : base;
});

defineExpose({
  focus: () => inputRef.value?.focus(),
  blur : () => inputRef.value?.blur(),
  el   : () => inputRef.value,
});

function escapeHtml(s) {
  return String(s ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
}

function highlightName(name) {
  const n = String(name ?? '');
  const q = String(props.modelValue ?? '').trim();
  if (!q) return escapeHtml(n);

  const idx = n.indexOf(q);
  if (idx < 0) return escapeHtml(n);

  return (
      escapeHtml(n.slice(0, idx)) +
      `<span class="highlight">${escapeHtml(n.slice(idx, idx + q.length))}</span>` +
      escapeHtml(n.slice(idx + q.length))
  );
}

function setOpen(v) {
  if (props.open === v) return;
  emit('update:open', v);
}

function onInput(e) {
  const next = String(e.target?.value ?? '');
  emit('update:modelValue', next);
  if (props.isPicking) return;

  // IME composition 중에는 search 발사 보류 — 자모 단위 의도 외 검색 회피.
  // composition 완료 시 compositionend 핸들러가 마무리 search 를 호출한다.
  if (composing.value || e.isComposing) return;

  emitSearch(next);
}

function emitSearch(rawValue) {
  const trimmed = String(rawValue ?? '').trim();
  if (trimmed.length < props.minSearchLength) {
    emit('search', '');
    setOpen(false);
    return;
  }
  emit('search', trimmed);
}

function onCompositionEnd(e) {
  composing.value = false;
  if (props.isPicking) return;
  emitSearch(e.target?.value ?? props.modelValue);
}

function onFocus(e) {
  emit('focus', e);
  if ((props.items?.length ?? 0) > 0 && String(props.modelValue ?? '').trim().length >= props.minSearchLength) {
    setOpen(true);
  }
}

// blur 후 close 지연.
//  - 200ms: dropdown 항목 click 처리 시간 확보 (mousedown.prevent 가 1차 방어,
//    이건 touch / 외부 디바이스용 fallback).
//  - relatedTarget 이 컴포넌트 내부면 close 보류 — focus 이동 중 의도된 흐름.
let blurCloseTimer = null;
function onBlur(e) {
  emit('blur', e);
  const related = e.relatedTarget;
  if (related && inputRef.value?.closest?.('.patientAutocomplete')?.contains(related)) {
    return;
  }
  if (blurCloseTimer) clearTimeout(blurCloseTimer);
  blurCloseTimer = setTimeout(() => {
    setOpen(false);
    blurCloseTimer = null;
  }, 200);
}

function clampIdx(i) {
  const n = props.items?.length ?? 0;
  if (n <= 0) return 0;
  if (i < 0) return 0;
  if (i >= n) return n - 1;
  return i;
}

function scrollActiveIntoView() {
  nextTick(() => {
    const list = dropdownRef.value;
    if (!list) return;
    const row = list.querySelector(`[data-idx="${activeIdx.value}"]`);
    row?.scrollIntoView?.({block: 'nearest'});
  });
}

function moveActive(delta) {
  if (!showDropdown.value) return;
  const n = props.items?.length ?? 0;
  if (n <= 0) return;
  activeIdx.value = clampIdx(activeIdx.value + delta);
  scrollActiveIntoView();
}

function jumpActive(idx) {
  if (!showDropdown.value) return;
  const n = props.items?.length ?? 0;
  if (n <= 0) return;
  activeIdx.value = clampIdx(idx);
  scrollActiveIntoView();
}

function pickIndex(i) {
  const item = props.items?.[i];
  if (!item) return false;
  emit('pick', item);
  setOpen(false);
  return true;
}

function onKeyDown(e) {
  if (composing.value || e.isComposing) return;

  // Esc: dropdown 열려있으면 닫고 propagate 차단 (외부 popup 의 esc-close 회피)
  if (e.key === 'Escape') {
    if (showDropdown.value) {
      e.stopPropagation();
      e.preventDefault();
      setOpen(false);
    }
    return;
  }

  if (e.key === 'ArrowDown') {
    if (!showDropdown.value) {
      if ((props.items?.length ?? 0) > 0) setOpen(true);
      return;
    }
    e.preventDefault();
    moveActive(+1);
    return;
  }
  if (e.key === 'ArrowUp') {
    if (!showDropdown.value) return;
    e.preventDefault();
    moveActive(-1);
    return;
  }
  if (e.key === 'Home') {
    if (!showDropdown.value) return;
    e.preventDefault();
    jumpActive(0);
    return;
  }
  if (e.key === 'End') {
    if (!showDropdown.value) return;
    e.preventDefault();
    jumpActive((props.items?.length ?? 1) - 1);
    return;
  }

  // Tab(Shift 제외) / Enter: 현재 highlighted 항목 pick.
  // 부모는 emit('pick') 핸들러 nextTick 에서 다음 input.focus() 수행.
  if ((e.key === 'Tab' && !e.shiftKey) || e.key === 'Enter') {
    if (!showDropdown.value) return;
    const n = props.items?.length ?? 0;
    if (n <= 0) return;
    e.preventDefault();
    if (e.key === 'Enter') e.stopPropagation();
    const idx = clampIdx(activeIdx.value);
    pickIndex(idx);
  }
}

function onRowMouseDown(e) {
  // input blur 방지 — blur 시 항목 click 못 받는 race 회피
  e.preventDefault();
}

function onRowClick(idx) {
  pickIndex(idx);
}

watch(
    () => props.items?.length ?? 0,
    (n) => {
      activeIdx.value = n > 0 ? Math.min(activeIdx.value, n - 1) : 0;
    }
);

// 입력값이 비워지면(IME backspace 포함) dropdown 강제 close — v-if 와 이중 안전망.
watch(
    () => props.modelValue,
    (v) => {
      if (!String(v ?? '').trim()) setOpen(false);
    }
);

watch(
    () => props.open,
    (v) => {
      if (!v) activeIdx.value = 0;
    }
);

// 외부(document) 클릭 시 닫기 — popup 외부도 포함
let outsideHandler = null;
function bindOutside() {
  if (outsideHandler) return;
  outsideHandler = (evt) => {
    if (!props.open) return;
    const root = inputRef.value?.closest?.('.patientAutocomplete');
    if (!root) return;
    if (root.contains(evt.target)) return;
    // teleport 드롭다운은 root 밖(body)이라 별도 보호 — 항목 클릭이 외부로 판정돼 닫히는 회귀 방지.
    if (dropdownRef.value?.contains?.(evt.target)) return;
    setOpen(false);
  };
  document.addEventListener('pointerdown', outsideHandler, true);
}
function unbindOutside() {
  if (!outsideHandler) return;
  document.removeEventListener('pointerdown', outsideHandler, true);
  outsideHandler = null;
}

watch(
    () => props.open,
    (v) => {
      if (v) bindOutside();
      else unbindOutside();
    },
    {immediate: true}
);

// teleport 드롭다운 위치 추적 — 열린 동안 스크롤/리사이즈 따라감.
function bindReposition() {
  window.addEventListener('scroll', updateDropdownPos, true);
  window.addEventListener('resize', updateDropdownPos);
}
function unbindReposition() {
  window.removeEventListener('scroll', updateDropdownPos, true);
  window.removeEventListener('resize', updateDropdownPos);
}
watch(
    () => props.open,
    (v) => {
      if (!props.teleport) return;
      if (v) {
        nextTick(updateDropdownPos);
        bindReposition();
      } else {
        unbindReposition();
      }
    }
);

onBeforeUnmount(() => {
  unbindOutside();
  unbindReposition();
  if (blurCloseTimer) {
    clearTimeout(blurCloseTimer);
    blurCloseTimer = null;
  }
});
</script>

<template>
  <div class="patientAutocomplete">
    <input
        ref="inputRef"
        :value="modelValue"
        :placeholder="placeholder"
        aria-label="고객명 또는 전화번호 검색"
        :readonly="readonly"
        :data-field="dataField"
        :data-scope="dataScope"
        :data-invalid="invalid"
        :aria-invalid="invalid ? 'true' : undefined"
        :aria-expanded="showDropdown ? 'true' : 'false'"
        :aria-controls="listboxId"
        :aria-activedescendant="showDropdown && items.length > 0 ? optionId(activeIdx) : undefined"
        aria-autocomplete="list"
        aria-haspopup="listbox"
        role="combobox"
        autocomplete="off"
        class="scheduleField patientAutocomplete__input"
        type="text"
        @input="onInput"
        @focus="onFocus"
        @blur="onBlur"
        @keydown="onKeyDown"
        @compositionstart="composing = true"
        @compositionend="onCompositionEnd"
    >
    <Teleport to="body" :disabled="!teleport">
    <ul
        v-if="showDropdown && (modelValue?.trim().length ?? 0) >= minSearchLength"
        :id="listboxId"
        ref="dropdownRef"
        :style="dropdownStyle"
        class="patientAutocomplete__list"
        role="listbox"
        @pointerdown.stop
        @scroll="onListScroll"
    >
      <li
          v-if="items.length === 0"
          aria-disabled="true"
          class="patientAutocomplete__empty"
          role="option"
      >
        {{ noDataText }}
      </li>
      <li
          v-for="(it, idx) in items"
          :id="optionId(idx)"
          :key="it.customerRefId ?? idx"
          :class="['patientAutocomplete__row', { 'is-active': idx === activeIdx }]"
          :data-idx="idx"
          :aria-selected="idx === activeIdx ? 'true' : 'false'"
          role="option"
          @mousedown="onRowMouseDown"
          @click="onRowClick(idx)"
          @mouseenter="activeIdx = idx"
      >
        <!-- row 슬롯: 항목 표시를 사용처가 교체 가능 (기본 = 고객명/전화) -->
        <slot :highlight-name="highlightName" :item="it" name="row">
          <span class="patientAutocomplete__name" v-html="highlightName(it.patientName)" />
          <span class="patientAutocomplete__phone">{{ formatPhoneNumber(it.patientPhone) }}</span>
        </slot>
      </li>
    </ul>
    </Teleport>
  </div>
</template>

<style lang="scss" scoped>
@use '@/scss/variables' as *;

.patientAutocomplete {
  position: relative;
  width: 100%;
}

.patientAutocomplete__input {
  width: 100%;
  height: 24px;

}

.patientAutocomplete__list {
  position: absolute;
  top: 100%;
  left: 0;
  right: 0;
  margin: 2px 0 0;
  padding: 0;
  list-style: none;
  background: $color-surface;
  border: 1px solid #cfcfcf;
  box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
  z-index: 100;
  overflow-y: auto;
}

.patientAutocomplete__row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: $space-8 $space-12;
  cursor: pointer;
  font-size: $font-size-14;

  &.is-active,
  &:hover {
    background-color: #F4F5F8;
  }
}

.patientAutocomplete__name {
  color: $color-text-black;
  font-weight: $font-weight-medium;
  flex: 1 1 auto;

  :deep(.highlight) {
    color: $color-primary;
  }
}

.patientAutocomplete__phone {
  flex: 0 0 auto;
  color: #999;
  font-size: $font-size-13;
  margin-left: $space-8;
}

.patientAutocomplete__empty {
  padding: $space-10 $space-12;
  font-size: $font-size-13;
  color: #999;
  cursor: default;
}
</style>
