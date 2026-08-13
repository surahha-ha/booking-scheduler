<script setup>
// ============================================================================
// 서비스 내용 선택기 (그룹 + 항목 선택 + memo)
// ----------------------------------------------------------------------------
// V2 진료등록 팝업의 서비스 내용 영역. 의원별 서비스 항목 마스터를 사용한다.
// - 서비스 항목(그룹+항목)과 memo 는 완전 독립. 항목 선택은 serviceGroupId/serviceItemId
//   에만 반영되고 memo 에는 절대 쓰지 않는다. memo 는 항상 자유 편집.
// - 그룹↔항목은 필수 쌍. 그룹 선택 시 첫 항목 자동 선택, 활성 그룹 재클릭 = 그룹+항목 동시 해제.
//   항목은 그룹 내 단일 선택(토글오프 없음). 유효 상태: (그룹+항목) | memo만 | 완전 빈 상태.
// ============================================================================
import {computed, ref, watch} from 'vue';
import {storeToRefs} from 'pinia';
import {push} from 'notivue';
import {useServiceItemStore} from '@/stores/serviceItemStore';

const props = defineProps({
  modelValue: {type: String, default: ''},       // memo (자유 텍스트, 항목과 독립)
  groupId   : {type: Number, default: null},
  itemId    : {type: Number, default: null},
  maxLength : {type: Number, default: 1000},
  /** ReservationPopup 이 실제로 보일 때만 store load 트리거 */
  active    : {type: Boolean, default: false},
  /** 등록(ADD) 진입 시 그룹이 있으면 첫 그룹을 기본 선택. EDIT 는 false(기존 값 존중). */
  defaultFirstGroup: {type: Boolean, default: false},
});

const emit = defineEmits([
  'update:modelValue',
  'update:groupId',
  'update:itemId',
  'openSetting',
]);

const store = useServiceItemStore();
const {userGroups} = storeToRefs(store);

const selectedGroupId = ref(null);

// 항목 페이징: 1 row 4개 × 최대 2 row = 페이지당 8개. 9개 이상이면 < > 버튼 노출.
const ITEMS_PER_PAGE = 8;
const itemPage = ref(0);

// ---------- init ----------
// active=true 가 될 때만 store.load 호출 (메인 화면에서 단순 mount 시 BE 호출 차단)
watch(
    () => props.active,
    async (v) => {
      if (!v) return;
      try {
        await store.load();
      } catch (e) {
        // SE-24: 실패 시 toast + 빈 상태로 graceful
        push.error(e?.message ? `서비스 항목 마스터를 불러오지 못했습니다. (${e.message})` : '서비스 항목 마스터를 불러오지 못했습니다.');
      }
      initSelection();
    },
    {immediate: true},
);

// props(=form) 변경 동기화 — null 이면 null 존중(토글오프 반영). 여기선 기본선택 안 함.
watch(
    () => [props.groupId, props.itemId, userGroups.value.length],
    () => { selectedGroupId.value = props.groupId ?? null; },
);

// 팝업 오픈 시 초기 선택. props.groupId 있으면 그대로 반영(EDIT),
// 없고 defaultFirstGroup 면 첫 그룹 기본 선택(ADD 등록 편의). 항목·memo 는 건드리지 않음.
function initSelection() {
  if (props.groupId != null) {
    selectedGroupId.value = props.groupId;
    return;
  }
  const first = userGroups.value[0];
  if (props.defaultFirstGroup && first) {
    // 첫 그룹 + 그 그룹의 첫 항목 자동 선택(그룹 선택 시 항목 필수 규칙 → valid 기본 상태)
    selectedGroupId.value = first.serviceGroupId;
    emit('update:groupId', first.serviceGroupId);
    emit('update:itemId', first.items?.[0]?.serviceItemId ?? null);
  } else {
    selectedGroupId.value = null;
  }
}

// ---------- computed ----------
const selectedGroup = computed(() =>
    userGroups.value.find((g) => g.serviceGroupId === selectedGroupId.value),
);

const items = computed(() => selectedGroup.value?.items ?? []);

// 페이징 computed
const totalPages = computed(() =>
    items.value.length === 0 ? 1 : Math.ceil(items.value.length / ITEMS_PER_PAGE),
);
const showItemPager = computed(() => items.value.length > ITEMS_PER_PAGE);
const pagedItems = computed(() => {
  const start = itemPage.value * ITEMS_PER_PAGE;
  return items.value.slice(start, start + ITEMS_PER_PAGE);
});

// 그룹 변경 또는 항목 개수 감소 시 페이지 0 으로 리셋 (out-of-range 방지)
watch(
    () => [selectedGroupId.value, items.value.length],
    () => {
      itemPage.value = 0;
    },
);

function prevItemPage() {
  if (itemPage.value > 0) itemPage.value -= 1;
}

function nextItemPage() {
  if (itemPage.value < totalPages.value - 1) itemPage.value += 1;
}

const memoLength = computed(() => String(props.modelValue ?? '').length);

// ---------- handlers ----------
// 그룹 칩: 단일 선택. 활성 칩 재클릭 = 그룹+항목 동시 해제(서비스 항목 미입력). memo 는 건드리지 않음.
function onGroupClick(grp) {
  if (selectedGroupId.value === grp.serviceGroupId) {
    selectedGroupId.value = null;
    emit('update:groupId', null);
    emit('update:itemId', null);
    return;
  }
  // 그룹 선택 시 첫 항목 자동 선택(그룹↔항목 필수 쌍). 항목 없는 그룹은 itemId null(저장 비활성).
  selectedGroupId.value = grp.serviceGroupId;
  emit('update:groupId', grp.serviceGroupId);
  emit('update:itemId', grp.items?.[0]?.serviceItemId ?? null);
}

// 항목 칩: 그룹 내 단일 선택. 그룹 선택 시 항목 필수 → 토글오프 없음(활성 항목 재클릭은 유지). memo 무관.
function onItemClick(item) {
  if (!selectedGroup.value) return;
  if (props.itemId === item.serviceItemId) return;
  emit('update:groupId', selectedGroup.value.serviceGroupId);
  emit('update:itemId', item.serviceItemId);
}

function onMemoInput(e) {
  emit('update:modelValue', e.target.value);
}

function openSetting() {
  emit('openSetting');
}
</script>

<template>
  <div class="treatmentContentSelector">
    <!-- 그룹 영역 -->
    <div class="tcs-groupBar">
      <div class="tcs-groups">
        <button
            v-for="grp in userGroups"
            :key="grp.serviceGroupId"
            :class="['tcs-groupChip', { 'is-active': grp.serviceGroupId === selectedGroupId }]"
            type="button"
            @click="onGroupClick(grp)"
        >
          {{ grp.serviceGroupName }}
        </button>
      </div>
      <button
          aria-label="서비스 항목 설정"
          class="tcs-settingBtn"
          type="button"
          @click="openSetting"
      >⚙</button>
    </div>

    <!-- 항목 영역 (그룹 선택 시 해당 그룹 항목 표시, 단일 선택) -->
    <div class="tcs-itemsWrap">
      <button
          v-if="showItemPager"
          :disabled="itemPage === 0"
          class="tcs-itemPager"
          type="button"
          aria-label="이전"
          @click="prevItemPage"
      >‹</button>
      <div class="tcs-items">
        <template v-if="items.length">
          <button
              v-for="item in pagedItems"
              :key="item.serviceItemId"
              :class="['tcs-itemChip', { 'is-active': item.serviceItemId === props.itemId }]"
              :data-tooltip="item.serviceItemName"
              type="button"
              @click="onItemClick(item)"
          >
            <span class="tcs-itemChip__text">{{ item.serviceItemName }}</span>
          </button>
        </template>
        <div v-else-if="selectedGroup" class="tcs-empty">
          등록된 서비스 항목이 없습니다. 우측 상단 ⚙ 버튼으로 추가하세요.
        </div>
      </div>
      <button
          v-if="showItemPager"
          :disabled="itemPage >= totalPages - 1"
          class="tcs-itemPager tcs-itemPager--next"
          type="button"
          aria-label="다음"
          @click="nextItemPage"
      >›</button>
    </div>

    <!-- memo 영역 (항상 자유 편집, 서비스 항목과 독립) -->
    <div class="tcs-memoArea">
      <textarea
          class="tcs-memo"
          :maxlength="props.maxLength"
          placeholder="서비스 내용을 입력해주세요. 예) 첫 방문 상담"
          :value="props.modelValue"
          @input="onMemoInput"
      />
      <div class="tcs-count">
        {{ memoLength }}/{{ props.maxLength }}
      </div>
    </div>

  </div>
</template>

<style lang="scss" scoped>
.treatmentContentSelector {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.tcs-groupBar {
  display: flex;
  align-items: flex-start;
  gap: 6px;
}

.tcs-groups {
  flex: 1;
  display: flex;
  flex-wrap: wrap;
  gap: 4px 6px;
}

.tcs-groupChip {
  /* 기본 .scheduleField 와 동일 톤 (border #CFCFCF, hover 브랜드 컬러) */
  border: 1px solid #CFCFCF;
  background: #fff;
  padding: 3px 10px;
  border-radius: 14px;
  font-size: 12px;
  cursor: pointer;
  line-height: 1.5;
  transition: border-color 0.2s, color 0.2s, background-color 0.2s;
}

.tcs-groupChip:hover {
  border-color: #2F6FED;
  color: #2F6FED;
}

.tcs-groupChip.is-active {
  background: #fff3e6;
  border-color: #2F6FED;
  color: #2F6FED;
  font-weight: 600;
}

.tcs-settingBtn {
  width: 28px;
  height: 26px;
  border: 1px solid #CFCFCF;
  background: #fff;
  border-radius: 0;
  cursor: pointer;
  font-size: 14px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: border-color 0.2s, color 0.2s;
}

.tcs-settingBtn:hover {
  border-color: #2F6FED;
  color: #2F6FED;
}

/* 칩 영역: 항목 수에 따라 1행/2행 자동 변동.
 * (popup height 도 가변이므로 min-height 고정 X)
 * 페이저 < > 는 항목 영역의 세로 중앙으로 정렬 (1행/2행 모두 중앙). */
.tcs-itemsWrap {
  display: flex;
  align-items: center;
  gap: 4px;
}

.tcs-items {
  flex: 1;
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  /* 모든 row 의 height 가 동일하도록 auto-row 를 칩 height 로 고정 */
  grid-auto-rows: 40px;
  align-content: start;
  gap: 6px;
  padding: 4px 0;
  min-width: 0;
}

.tcs-itemChip {
  /* 모든 칩 width/height 동일. tooltip 위해 chip 자체 overflow 는 visible.
   * 텍스트 line-clamp 는 inner span 으로 격리. */
  position: relative;
  width: 100%;
  height: 40px;
  min-width: 0;
  box-sizing: border-box;
  border: 1px solid #CFCFCF;
  background: #fff;
  padding: 4px 10px;
  border-radius: 0;
  font-size: 12px;
  line-height: 1.3;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  text-align: center;
  overflow: visible;
  transition: border-color 0.2s, color 0.2s, background-color 0.2s;
}

.tcs-itemChip__text {
  /* 2줄 line-clamp + ellipsis (텍스트 영역에만 적용) */
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
  word-break: keep-all;
  overflow-wrap: anywhere;
  max-width: 100%;
}

.tcs-itemChip:hover {
  border-color: #2F6FED;
  color: #2F6FED;
}

.tcs-itemChip.is-active {
  background: #2F6FED;
  border-color: #2F6FED;
  color: #fff;
}

.tcs-itemChip.is-active:hover {
  color: #fff;
}

/* 커스텀 tooltip — chip 위쪽 표시 (브라우저 native title 의 우측 하단 위치 회피) */
.tcs-itemChip::after {
  content: attr(data-tooltip);
  position: absolute;
  bottom: calc(100% + 6px);
  left: 50%;
  transform: translateX(-50%);
  background: rgba(33, 33, 33, 0.92);
  color: #fff;
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 11px;
  line-height: 1.3;
  white-space: nowrap;
  max-width: 240px;
  overflow: hidden;
  text-overflow: ellipsis;
  pointer-events: none;
  opacity: 0;
  visibility: hidden;
  transition: opacity 0.15s ease, visibility 0.15s ease;
  z-index: 10;
}

.tcs-itemChip:hover::after {
  opacity: 1;
  visibility: visible;
}

/* 페이저 < > — 담당의사 영역(.doctorRadioList__arrow)과 동일한 크기/아이콘.
 * 같은 화면 내 반복되는 UI 요소는 통일성 유지. */
.tcs-itemPager {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  width: 20px;
  min-width: 20px;
  height: 20px;
  border: 0;
  background: transparent;
  cursor: pointer;
  padding: 0;
  /* 텍스트 콘텐츠 숨기고 SVG 아이콘만 표시 */
  font-size: 0;
  color: transparent;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%239e9e9e' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='15 18 9 12 15 6'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: center;
  background-size: 20px 20px;
  user-select: none;
}

.tcs-itemPager:hover:not(:disabled) {
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='15 18 9 12 15 6'/%3E%3C/svg%3E");
}

.tcs-itemPager:disabled {
  opacity: 0.2;
  cursor: default;
}

.tcs-itemPager--next {
  transform: rotate(180deg);
}

.tcs-empty {
  grid-column: 1 / -1;
  font-size: 12px;
  color: #999;
  padding: 4px 2px;
}

.tcs-memoArea {
  position: relative;
  margin-top: 4px;
}

.tcs-memo {
  /* .scheduleField 와 동일 톤 */
  width: 100%;
  height: 64px;
  border: 1px solid #CFCFCF;
  border-radius: 0;
  padding: 8px;
  font-size: 13px;
  resize: none;
  box-sizing: border-box;
  transition: border-color 0.2s;
}

.tcs-memo:focus {
  border-color: #2F6FED;
  outline: none;
}

.tcs-count {
  position: absolute;
  right: 4px;
  bottom: -16px;
  font-size: 11px;
  color: #999;
}

</style>
