<script setup>
// ============================================================================
// 서비스 내용 선택기 (그룹 + 항목 선택 + memo)
// ----------------------------------------------------------------------------
// V2 방문등록 팝업의 서비스 내용 영역. 의원별 서비스 항목 마스터를 사용한다.
// - 서비스 항목(그룹+항목)과 memo 는 완전 독립. 항목 선택은 serviceGroupId/serviceItemId
//   에만 반영되고 memo 에는 절대 쓰지 않는다. memo 는 항상 자유 편집.
// - 항목이 없는 그룹은 선택 불가(disabled). 그룹 선택 시 첫 항목 자동 선택,
//   활성 그룹 재클릭 = 그룹+항목 동시 해제.
//   항목은 그룹 내 단일 선택(토글오프 없음). 저장 가능 여부 판정은 treatmentItemRules 가 SSOT.
// ============================================================================
import {computed, ref, watch} from 'vue';
import {storeToRefs} from 'pinia';
import {push} from 'notivue';
import {useServiceItemStore} from '@/stores/serviceItemStore';
import {hasSelectableItems} from '@/components/popup/treatmentItemRules';

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
// 없고 defaultFirstGroup 면 첫 그룹 기본 선택(ADD 등록 편의). memo 는 건드리지 않음.
// 어느 경로든 그룹이 정해지면 항목이 비어 있을 때 첫 항목을 채운다.
function initSelection() {
  if (props.groupId != null) {
    const grp = userGroups.value.find((g) => g.serviceGroupId === props.groupId);
    // 항목이 하나도 없는 그룹은 고를 수 없으므로 선택 상태로 남기지 않는다(BE 도 같은 규칙 — clearBookItemRef).
    if (!hasSelectableItems(grp)) {
      selectedGroupId.value = null;
      emit('update:groupId', null);
      emit('update:itemId', null);
      return;
    }
    selectedGroupId.value = props.groupId;
    // 그룹만 있고 항목이 비어 있으면 첫 항목을 기본 선택 — 그룹 기본 선택과 같은 규칙.
    if (props.itemId == null) emit('update:itemId', grp.items[0].serviceItemId);
    return;
  }
  // 항목 없는 그룹은 고를 수 없으므로 기본 선택에서도 건너뛴다(첫 그룹이 빈 그룹이면 그 다음).
  const first = userGroups.value.find(hasSelectableItems);
  if (props.defaultFirstGroup && first) {
    selectedGroupId.value = first.serviceGroupId;
    emit('update:groupId', first.serviceGroupId);
    emit('update:itemId', first.items[0].serviceItemId);
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
  // 그룹 선택 시 첫 항목 자동 선택. 빈 그룹은 disabled 라 여기로 오지 않는다.
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
            :disabled="!hasSelectableItems(grp)"
            :data-tooltip="grp.serviceGroupName"
            type="button"
            @click="onGroupClick(grp)"
        >
          <span class="tcs-groupChip__text">{{ grp.serviceGroupName }}</span>
        </button>
      </div>
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
          선택한 그룹에 등록된 서비스 항목이 없습니다.<br/>
          왼쪽 '서비스 내용' 아래 ⚙ 버튼으로 추가하세요.
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

/* min-width:0 필수 — flex item 의 암묵적 최소폭은 min-content 이고, wrap 컨테이너의
 * min-content 는 '가장 넓은 칩 하나의 폭'이다. 긴 그룹명 칩 하나가 생기면 그룹칩 영역
 * 전체가 그 폭까지 벌어져 짧은 칩까지 팝업 밖으로 밀려난다.
 * 칩 폭 상한(.tcs-groupChip max-width)이 min-content 를 팝업 폭 아래로 묶고 있는 동안은
 * 이 줄이 발동하지 않지만, 상한이 커지거나 팝업이 좁아지면 이 줄만 남는다. 둘은 서로를
 * 대신하지 못하므로 함께 둔다. */
.tcs-groups {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 4px 6px;
}

/* 그룹명은 최대 50자까지 저장되므로 칩 폭에 상한을 둔다. 넘치면 말줄임 + hover 툴팁
 * (항목 칩과 동일한 규칙). tooltip 을 위해 칩 자체 overflow 는 visible 이어야 하므로
 * 말줄임은 inner span 으로 격리한다.
 * 이 상한을 없애면 칩이 칩 영역 밖으로 넘는다 — .tcs-groups 의 min-width:0 이 이것까지
 * 막아주지는 않는다(e2e T13 이 잡는다). */
.tcs-groupChip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  position: relative;
  min-height: 32px;
  max-width: 160px;
  padding: 0 8px;
  border: 1px solid #BCBCBC;
  background: #fff;
  border-radius: 4px;
  color: #565656;
  font-size: 14px;
  cursor: pointer;
  transition: border-color 0.2s, color 0.2s, background-color 0.2s;
}

.tcs-groupChip__text {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tcs-groupChip:hover {
  border-color: var(--scheduler-brand, #2F6FED);
  color: var(--scheduler-brand, #2F6FED);
}

.tcs-groupChip.is-active {
  border-color: var(--scheduler-brand, #2F6FED);
  color: var(--scheduler-brand, #2F6FED);
}

/* 서비스 항목이 없는 그룹 — 선택 불가. 선택 중이던 그룹의 항목을 설정에서 모두 지운 경우도
 * 같이 회색이 되어야 한다(예외를 두면 지워진 줄 모른다). 그 경우 선택 자체는 해제된다. */
.tcs-groupChip:disabled {
  border-color: #E0E0E0;
  background: #F5F5F5;
  color: #BCBCBC;
  cursor: default;
}

.tcs-groupChip:disabled:hover {
  border-color: #E0E0E0;
  color: #BCBCBC;
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
  border: 0;
  background: transparent;
  padding: 4px 10px;
  border-radius: 0;
  font-size: 14px;
  line-height: 1.3;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  text-align: center;
  overflow: visible;
  transition: color 0.2s;
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
  color: #2F6FED;
}

.tcs-itemChip.is-active {
  color: var(--scheduler-brand, #2F6FED);
  font-weight: 600;
}

.tcs-itemChip.is-active:hover {
  color: var(--scheduler-brand, #2F6FED);
}

/* 커스텀 tooltip — chip 위쪽 표시 (브라우저 native title 의 우측 하단 위치 회피).
 * 그룹 칩·항목 칩이 같은 규칙을 쓴다. */
.tcs-itemChip::after,
.tcs-groupChip::after {
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

.tcs-itemChip:hover::after,
.tcs-groupChip:hover::after {
  opacity: 1;
  visibility: visible;
}

/* 페이저 < > — 담당자 영역(.doctorRadioList__arrow)과 동일한 크기/아이콘.
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
  /* 예약 팝업 공통 입력 필드와 동일한 외형 */
  width: 100%;
  height: 64px;
  border: 1px solid #BCBCBC;
  border-radius: 4px;
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
