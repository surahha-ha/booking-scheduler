<script setup>
// ============================================================================
// 서비스 항목 설정 팝업 — 커스텀 modeless popup
// ----------------------------------------------------------------------------
// ReservationPopup 옆에 동시 노출되는 modeless popup.
// - 공용 모달 컴포넌트 사용 안 함 (backdrop 강제 동작 회피)
// - Teleport to body + 절대 위치 + 자체 transition
// - ESC stopPropagation 으로 부모 모달의 ESC 닫힘 차단
// - 외부 클릭 닫기 (ReservationPopup 영역은 외부 클릭에서 제외)
// - 위치: anchor (예약등록) 우측 → 우측 부족 시 위쪽 fallback → 모두 부족 시 viewport 좌상단
// - window.resize 시 위치 재계산
// ============================================================================
import {computed, nextTick, onBeforeUnmount, ref, watch} from 'vue';
import {storeToRefs} from 'pinia';
import {useDialog} from '@/lib/useDialog';
import {push} from 'notivue';
import {useServiceItemStore} from '@/stores/serviceItemStore';

const props = defineProps({
  visible        : {type: Boolean, required: true},
  /** anchor 기준 요소 (보통 모달 컨텐츠 .uiModal__content 또는 .schedulePopup) */
  anchorSelector : {type: String, default: '.schedulePopup .uiModal__content'},
  /** popup 자체 크기 */
  width          : {type: Number, default: 520},
  height         : {type: Number, default: 600},
  /** anchor 우측 오프셋 */
  offset         : {type: Number, default: 8},
});

const emit = defineEmits(['close']);

const dialog = useDialog();
const store = useServiceItemStore();
const {groups, userGroups} = storeToRefs(store);

// DB 컬럼 길이 제약 (BE @Size 와 동기화)
//   GRP_NM:  VARCHAR(50)  → 그룹명 50자
//   ITEM_NM: VARCHAR(100) → 서비스 항목명 100자
const GRP_NM_MAX = 50;
const ITEM_NM_MAX = 100;

/**
 * BE 에러 응답에서 사용자 노출용 메시지 추출.
 *
 * 서버 공통 예외 응답 형식:
 *   - MethodArgumentNotValidException (@Valid 위반):
 *       { code: 'FAILED', message: 'Validation Error', payload: {serviceGroupName: '그룹명은 50자 이하여야 합니다.', ...} }
 *     → message 는 "Validation Error" 고정. 실제 위반 메시지는 payload Map 에 있다.
 *     → payload 의 첫 번째 값을 우선 노출.
 *   - ResponseStatusException:
 *       { code: 'FAILED', message: ex.getReason(), payload: null }
 *     → message 그대로 사용.
 *   - 그 외 예외: { code: 'FAILED', message: '500' } 등 — message 사용.
 */
function extractErrorMessage(e, fallback) {
  const data = e?.response?.data;
  if (data) {
    if (typeof data === 'string' && data.trim()) return data;
    // @Valid 위반 케이스: payload({field: message}) 의 첫 값을 우선
    const payload = data.payload;
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
      const firstMsg = Object.values(payload).find((v) => typeof v === 'string' && v.trim());
      if (firstMsg) return firstMsg;
    }
    if (data.message && data.message !== 'Validation Error') return data.message;
    // 표준 Spring 형식 fallback
    if (Array.isArray(data.errors) && data.errors[0]?.defaultMessage) {
      return data.errors[0].defaultMessage;
    }
    if (data.message) return data.message;
  }
  return e?.message ?? fallback;
}

// ---------- 위치 / 측정 상태 ----------
const rootEl = ref(null);
const posStyle = ref({left: '-9999px', top: '-9999px', visibility: 'hidden'});
const baseZIndex = ref(1502); // UiModal 기본 1501 가정 (mount 후 측정으로 보정)
// fallback(ReservationPopup 덮기) 모드에서 동적으로 키운 사이즈를 저장.
// 통상 모드일 때는 props.width/height 그대로 사용.
const effectiveWidth = ref(0);
const effectiveHeight = ref(0);

// ---------- 편집 상태 ----------
const selectedGroupId = ref(null);
const newGroupInput = ref(null);
const editingGroupId = ref(null);
const groupNameDraft = ref('');
// 4-4 서비스 항목 입력 auto-grow: 드래프트 배열(안정 id key → 커밋 시 다른 칸 포커스 보존).
let _draftSeq = 0;
function makeDraft() { return {id: ++_draftSeq, value: ''}; }
const newItemDrafts = ref([makeDraft()]);
const draftListRef = ref(null);
const editingItemId = ref(null);
const itemNameDraft = ref('');

// rapid toggle race 가드: 측정 작업의 epoch 토큰
let openEpoch = 0;

// ---------- 가시화 흐름 ----------
watch(
    () => props.visible,
    async (v) => {
      if (!v) {
        teardown();
        return;
      }
      openEpoch += 1;
      const myEpoch = openEpoch;

      // store 로드 (실패 시 toast)
      try {
        await store.load(true);
      } catch (e) {
        // 실패 graceful — 빈 상태로라도 띄움
        push.error(e?.message ? `서비스 항목을 불러오지 못했습니다. (${e.message})` : '서비스 항목을 불러오지 못했습니다.');
      }

      if (!props.visible || myEpoch !== openEpoch) return;

      // 첫 그룹 선택 (없으면 미선택)
      const first = userGroups.value[0];
      selectedGroupId.value = first?.serviceGroupId ?? null;

      // anchor 측정 후 위치 계산
      await nextTick();
      if (!props.visible || myEpoch !== openEpoch) return;
      computePosition();

      // 리스너 등록
      window.addEventListener('resize', computePosition);
      document.addEventListener('mousedown', onOutsideClick, true);
      document.addEventListener('keydown', onKeydown, true);
    },
);

function teardown() {
  window.removeEventListener('resize', computePosition);
  document.removeEventListener('mousedown', onOutsideClick, true);
  document.removeEventListener('keydown', onKeydown, true);
  // 다음 진입 시 첫 frame이 이전 위치로 보이지 않도록 초기화
  posStyle.value = {left: '-9999px', top: '-9999px', visibility: 'hidden'};
  newGroupInput.value = null;
  editingGroupId.value = null;
  editingItemId.value = null;
  newItemDrafts.value = [makeDraft()];
}

onBeforeUnmount(teardown);

// ---------- 위치 계산 ----------
function computePosition() {
  // 매 계산마다 기본값(props)로 리셋. fallback 모드일 때만 anchor 크기까지 확장.
  effectiveWidth.value = props.width;
  effectiveHeight.value = props.height;

  const anchor = document.querySelector(props.anchorSelector);
  if (!anchor) {
    // anchor 없으면 viewport 중앙
    const vw = window.innerWidth, vh = window.innerHeight;
    posStyle.value = {
      left      : `${Math.max(8, (vw - props.width) / 2)}px`,
      top       : `${Math.max(8, (vh - props.height) / 2)}px`,
      visibility: 'visible',
    };
    return;
  }
  const rect = anchor.getBoundingClientRect();
  const vw = window.innerWidth, vh = window.innerHeight;

  // z-index 보정: anchor 의 실제 z-index +1
  const anchorZ = parseInt(window.getComputedStyle(anchor).zIndex, 10);
  if (Number.isFinite(anchorZ)) {
    baseZIndex.value = anchorZ + 1;
  }

  // 1순위: 우측
  let left = rect.right + props.offset;
  let top = rect.top;
  if (left + props.width <= vw - 4) {
    posStyle.value = {
      left      : `${left}px`,
      top       : `${clamp(top, 8, Math.max(8, vh - props.height - 8))}px`,
      visibility: 'visible',
    };
    return;
  }

  // 2순위: ReservationPopup 영역을 완전히 덮기 (우측 공간 부족 시)
  // anchor(ReservationPopup) 위에 동일 위치로 올리고 크기를 anchor 보다 크거나 같게 확장.
  // 시각적으로 ReservationPopup 이 보이지 않도록 덮음.
  const padding = 20; // anchor 보다 살짝 크게 (그림자/테두리 가려짐 방지)
  const expandedWidth = Math.max(props.width, Math.ceil(rect.width) + padding);
  const expandedHeight = Math.max(props.height, Math.ceil(rect.height) + padding);
  // viewport 안에 들어가도록 클램프
  const clampedWidth = Math.min(expandedWidth, vw - 16);
  const clampedHeight = Math.min(expandedHeight, vh - 16);
  effectiveWidth.value = clampedWidth;
  effectiveHeight.value = clampedHeight;

  // anchor 중심을 기준으로 정렬: anchor 의 center 와 popup center 일치
  const anchorCenterX = rect.left + rect.width / 2;
  const anchorCenterY = rect.top + rect.height / 2;
  left = clamp(anchorCenterX - clampedWidth / 2, 8, Math.max(8, vw - clampedWidth - 8));
  top = clamp(anchorCenterY - clampedHeight / 2, 8, Math.max(8, vh - clampedHeight - 8));
  posStyle.value = {left: `${left}px`, top: `${top}px`, visibility: 'visible'};
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

// ---------- ESC / 외부 클릭 ----------
function onKeydown(e) {
  if (e.key !== 'Escape' || !props.visible) return;
  // 부모 모달의 ESC 동작과 충돌 차단 — capture phase 에서 stopPropagation
  e.stopPropagation();
  e.preventDefault();
  handleCancel();
}

function onOutsideClick(e) {
  if (!props.visible) return;
  const target = e.target;
  // 자기 자신 영역은 외부 아님
  if (rootEl.value && rootEl.value.contains(target)) return;
  // ReservationPopup 영역(.schedulePopup)은 외부 클릭 제외
  if (target.closest && target.closest('.schedulePopup')) return;
  // confirm 다이얼로그 영역도 제외 (dialog.confirm 클릭 시 닫힘 방지)
  if (target.closest && (target.closest('.uiModal__content') || target.closest('.modal'))) return;
  handleCancel();
}

// ---------- computed ----------
const selectedGroup = computed(() =>
    groups.value.find((g) => g.serviceGroupId === selectedGroupId.value),
);

// 저장 버튼 활성화 조건 (사용자 정의):
//  - "활성화된(현재 선택된) 그룹의 서비스 항목이 1개 이상이면 활성"
//  - 선택된 그룹이 없으면 비활성
const canSave = computed(() => {
  const g = selectedGroup.value;
  if (!g) return false;
  return (g.items?.length ?? 0) >= 1;
});

// 그룹명 정규화: 모든 whitespace 제거 후 비교.
// ' 기타 ', '기타 ', ' 기타', '  기   타 '  → '기타'
function normalizeGrpNm(name) {
  return String(name ?? '').replace(/\s+/g, '');
}

// 그룹명 중복 여부 (편집 시 자기 자신 ID 제외)
function isDuplicateGrpNm(name, excludeId = null) {
  const norm = normalizeGrpNm(name);
  if (!norm) return false;
  return groups.value.some(
      (g) =>
          normalizeGrpNm(g.serviceGroupName) === norm &&
          g.serviceGroupId !== excludeId,
  );
}

// ---------- 그룹 ----------
function selectGroup(grp) {
  if (editingGroupId.value) return;
  selectedGroupId.value = grp.serviceGroupId;
}

function startNewGroup() {
  newGroupInput.value = '';
}

async function commitNewGroup() {
  const name = (newGroupInput.value ?? '').trim();
  if (!name) {
    newGroupInput.value = null;
    return;
  }
  // 중복 차단: whitespace 정규화 후 비교 (' 기타 ', '기 타' 등 모두 '기타')
  if (isDuplicateGrpNm(name)) {
    push.error('이미 동일한 이름의 그룹이 존재합니다.');
    newGroupInput.value = null;
    return;
  }
  try {
    const created = await store.createGroup({serviceGroupName: name});
    if (created?.serviceGroupId) {
      selectedGroupId.value = created.serviceGroupId;
    }
  } catch (e) {
    push.error(extractErrorMessage(e, '그룹 추가에 실패했습니다.'));
  } finally {
    newGroupInput.value = null;
  }
}

function startEditGroup(grp) {
  editingGroupId.value = grp.serviceGroupId;
  groupNameDraft.value = grp.serviceGroupName;
}

async function commitEditGroup() {
  if (editingGroupId.value == null) return;
  const name = groupNameDraft.value.trim();
  if (!name) {
    editingGroupId.value = null;
    return;
  }
  // 중복 차단 (자기 자신 제외)
  if (isDuplicateGrpNm(name, editingGroupId.value)) {
    push.error('이미 동일한 이름의 그룹이 존재합니다.');
    editingGroupId.value = null;
    return;
  }
  try {
    await store.updateGroup(editingGroupId.value, {serviceGroupName: name});
  } catch (e) {
    push.error(extractErrorMessage(e, '그룹 수정에 실패했습니다.'));
  } finally {
    editingGroupId.value = null;
  }
}

async function deleteGroup(grp) {
  const ok = await dialog.confirm(
      '그룹 삭제 시,\n내부 서비스 항목이 모두 삭제됩니다.\n삭제하시겠습니까?',
      {title: '서비스 항목 그룹 삭제'},
  );
  if (!ok) return;
  try {
    await store.deleteGroup(grp.serviceGroupId);
    if (selectedGroupId.value === grp.serviceGroupId) {
      const next = userGroups.value[0];
      selectedGroupId.value = next?.serviceGroupId ?? null;
    }
  } catch (e) {
    push.error(extractErrorMessage(e, '그룹 삭제에 실패했습니다.'));
  }
}

// ---------- 항목 ----------
// 마지막 행에 입력 시 빈 행 자동 등장, 중간 빈 행 자동 제거(마지막 빈 행 1개 유지).
function onItemDraftInput() {
  const arr = newItemDrafts.value;
  if (arr.length === 0 || arr[arr.length - 1].value.trim() !== '') {
    arr.push(makeDraft());
  }
  for (let i = arr.length - 2; i >= 0; i--) {
    if (arr[i].value.trim() === '') arr.splice(i, 1);
  }
  if (arr.length === 0) arr.push(makeDraft());
}

// 입력완료(blur/Enter) → createItem → 리스트로 이동, 그 칸 제거(안정 id 라 다른 칸 포커스 보존).
async function commitItemDraft(d, refocus = false) {
  const name = d.value.trim();
  if (!name || !selectedGroup.value) return;
  d.value = ''; // 즉시 비움 → Enter(제거)→blur 중복 커밋 방지(재진입 시 name='' early return)
  try {
    await store.createItem({
      serviceGroupId: selectedGroup.value.serviceGroupId,
      serviceItemName       : name,
    });
    const idx = newItemDrafts.value.findIndex((x) => x.id === d.id);
    if (idx >= 0) newItemDrafts.value.splice(idx, 1);
    // 마지막 빈 행 보장
    if (newItemDrafts.value.length === 0
        || newItemDrafts.value[newItemDrafts.value.length - 1].value.trim() !== '') {
      newItemDrafts.value.push(makeDraft());
    }
    // Enter: 다음(마지막 빈) 행으로 포커스 이동 → 연속 입력
    if (refocus) {
      await nextTick();
      const inputs = draftListRef.value?.querySelectorAll('.tisp-input');
      inputs?.[inputs.length - 1]?.focus();
    }
  } catch (e) {
    d.value = name; // 실패 시 입력 복원
    push.error(extractErrorMessage(e, '서비스 항목 추가에 실패했습니다.'));
  }
}

function startEditItem(item) {
  editingItemId.value = item.serviceItemId;
  itemNameDraft.value = item.serviceItemName;
}

async function commitEditItem() {
  if (editingItemId.value == null) return;
  const name = itemNameDraft.value.trim();
  if (!name) {
    editingItemId.value = null;
    return;
  }
  try {
    await store.updateItem(editingItemId.value, {serviceItemName: name});
  } catch (e) {
    push.error(extractErrorMessage(e, '서비스 항목 수정에 실패했습니다.'));
  } finally {
    editingItemId.value = null;
  }
}

async function deleteItem(item) {
  try {
    await store.deleteItem(item.serviceItemId);
  } catch (e) {
    push.error(extractErrorMessage(e, '서비스 항목 삭제에 실패했습니다.'));
  }
}

function handleSaveAndClose() {
  emit('close');
}

function handleCancel() {
  emit('close');
}
</script>

<template>
  <Teleport to="body">
    <Transition name="tisp-fade">
      <div
          v-show="props.visible"
          ref="rootEl"
          :style="{
            left: posStyle.left,
            top: posStyle.top,
            width: `${effectiveWidth || props.width}px`,
            height: `${effectiveHeight || props.height}px`,
            visibility: posStyle.visibility,
            zIndex: baseZIndex,
          }"
          class="tisp-root"
          role="dialog"
          aria-modal="false"
          aria-label="서비스 항목 설정"
      >
        <!-- 헤더 -->
        <div class="tisp-header">
          <span class="tisp-title">서비스 항목 설정</span>
          <button class="tisp-closeBtn" type="button" aria-label="닫기" @click="handleCancel">×</button>
        </div>

        <!-- 본문: 헤더/푸터(약 100px) 빼고 남은 영역 -->
        <div class="tisp-body">
          <!-- 좌측 그룹 리스트 -->
          <div class="tisp-col">
            <div class="tisp-colHeader">
              <span>그룹</span>
              <span class="tisp-colHeaderHint">최대 {{ GRP_NM_MAX }}자 입력가능</span>
            </div>
            <div class="tisp-list">
              <div
                  v-for="grp in userGroups"
                  :key="grp.serviceGroupId"
                  :class="['tisp-row', { 'is-active': grp.serviceGroupId === selectedGroupId }]"
                  @click="selectGroup(grp)"
              >
                <template v-if="editingGroupId === grp.serviceGroupId">
                  <input
                      v-model="groupNameDraft"
                      :maxlength="GRP_NM_MAX"
                      class="tisp-input"
                      type="text"
                      @blur="commitEditGroup"
                      @keydown.enter.prevent="commitEditGroup"
                      @click.stop
                  />
                </template>
                <template v-else>
                  <span class="tisp-rowText">{{ grp.serviceGroupName }}</span>
                  <span class="tisp-rowActions">
                    <button class="tisp-rowAction" type="button" @click.stop="startEditGroup(grp)">수정</button>
                    <button class="tisp-rowAction tisp-rowAction--danger" type="button" @click.stop="deleteGroup(grp)">삭제</button>
                  </span>
                </template>
              </div>

              <!-- 신규 그룹 입력 -->
              <div v-if="newGroupInput !== null" class="tisp-row">
                <input
                    v-model="newGroupInput"
                    :maxlength="GRP_NM_MAX"
                    autofocus
                    class="tisp-input"
                    placeholder="그룹명 입력 + Enter"
                    type="text"
                    @blur="commitNewGroup"
                    @keydown.enter.prevent="commitNewGroup"
                />
              </div>

              <button
                  v-if="newGroupInput === null"
                  class="tisp-addBtn"
                  type="button"
                  @click="startNewGroup"
              >+ 추가</button>
            </div>
          </div>

          <!-- 우측 항목 리스트 -->
          <div class="tisp-col">
            <div class="tisp-colHeader">
              <span>서비스 항목</span>
              <span class="tisp-colHeaderHint">최대 {{ ITEM_NM_MAX }}자 입력가능</span>
            </div>
            <div class="tisp-list">
              <div
                  v-for="item in selectedGroup?.items ?? []"
                  :key="item.serviceItemId"
                  class="tisp-row"
              >
                <template v-if="editingItemId === item.serviceItemId">
                  <input
                      v-model="itemNameDraft"
                      :maxlength="ITEM_NM_MAX"
                      class="tisp-input"
                      type="text"
                      @blur="commitEditItem"
                      @keydown.enter.prevent="commitEditItem"
                  />
                </template>
                <template v-else>
                  <span class="tisp-rowText" @click="startEditItem(item)">{{ item.serviceItemName }}</span>
                  <span class="tisp-rowActions">
                    <button class="tisp-rowAction tisp-rowAction--danger" type="button" @click.stop="deleteItem(item)">×</button>
                  </span>
                </template>
              </div>

              <!-- 항목 입력칸 (4-4 auto-grow): 마지막 행 입력 시 빈 행 자동 등장, blur/Enter 시 리스트로 확정 -->
              <div ref="draftListRef">
                <div v-for="d in newItemDrafts" :key="d.id" class="tisp-row">
                  <input
                      v-model="d.value"
                      :maxlength="ITEM_NM_MAX"
                      class="tisp-input"
                      placeholder="서비스 항목 입력"
                      type="text"
                      @input="onItemDraftInput"
                      @blur="commitItemDraft(d)"
                      @keydown.enter.prevent="commitItemDraft(d, true)"
                  />
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- 푸터: 취소/저장 중앙 정렬 (ReservationPopup 푸터와 일관성 유지) -->
        <div class="tisp-footer">
          <button class="btn-action" type="button" @click="handleCancel">취소</button>
          <button
              :disabled="!canSave"
              class="btn-action btn-primary"
              type="button"
              @click="handleSaveAndClose"
          >저장</button>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style lang="scss" scoped>
.tisp-root {
  position: fixed;
  background: #fff;
  border: 1px solid #CFCFCF;
  /* ReservationPopup 의 기본 모서리(8px) 와 동일 */
  border-radius: 8px;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.15);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.tisp-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-bottom: 1px solid #CFCFCF;
}

.tisp-title {
  font-weight: 700;
  font-size: 16px;
  color: #2F6FED;
}

.tisp-closeBtn {
  background: transparent;
  border: none;
  font-size: 20px;
  cursor: pointer;
  color: #666;
  line-height: 1;
  padding: 0 4px;
  transition: color 0.2s;
}

.tisp-closeBtn:hover {
  color: #2F6FED;
}

.tisp-body {
  flex: 1 1 auto;
  display: flex;
  gap: 12px;
  padding: 12px;
  overflow: hidden;
  min-height: 0;
}

.tisp-col {
  flex: 1;
  border: 1px solid #CFCFCF;
  border-radius: 0;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}

.tisp-colHeader {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid #CFCFCF;
  background: #fafafa;
  font-weight: 600;
  font-size: 13px;
}

.tisp-colHeaderHint {
  font-size: 11px;
  font-weight: 400;
  color: #888;
}

.tisp-list {
  flex: 1;
  display: flex;
  flex-direction: column;
  padding: 4px 0;
  overflow-y: auto;
  min-height: 0;
}

.tisp-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 12px;
  cursor: pointer;
  font-size: 13px;
  min-height: 28px;
  /* hover/active 시 자간 흔들림 방지: weight 는 항상 600 으로 고정,
     hover/active 는 색만 변경 */
  font-weight: 600;
}

.tisp-row:hover {
  background: #fff7ee;
}

.tisp-row.is-active {
  background: #fff3e6;
  color: #2F6FED;
}

.tisp-row--default {
  color: #999;
}

.tisp-rowText {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tisp-rowMeta {
  font-size: 11px;
  color: #aaa;
  margin-left: 8px;
}

.tisp-rowActions {
  /* row layout shift 방지: 항상 자리는 차지하되 visibility 로만 토글 */
  display: inline-flex;
  visibility: hidden;
  gap: 6px;
}

.tisp-row:hover .tisp-rowActions {
  visibility: visible;
}

.tisp-rowAction {
  font-size: 11px;
  border: none;
  background: transparent;
  cursor: pointer;
  color: #666;
  padding: 2px 4px;
  transition: color 0.2s;
}

.tisp-rowAction:hover {
  color: #2F6FED;
}

.tisp-rowAction--danger {
  color: #d9534f;
}

.tisp-rowAction--danger:hover {
  color: #b52a25;
}

.tisp-input {
  /* .scheduleField 와 동일 톤 */
  width: 100%;
  border: 1px solid #CFCFCF;
  border-radius: 0;
  padding: 4px 6px;
  font-size: 13px;
  box-sizing: border-box;
  outline: none;
  transition: border-color 0.2s;
}

.tisp-input:focus {
  border-color: #2F6FED;
}

.tisp-addBtn {
  margin: 6px 12px;
  padding: 4px 8px;
  border: 1px dashed #CFCFCF;
  background: #fff;
  border-radius: 0;
  font-size: 12px;
  color: #666;
  cursor: pointer;
  transition: border-color 0.2s, color 0.2s;
}

.tisp-addBtn:hover {
  border-color: #2F6FED;
  color: #2F6FED;
}

.tisp-emptyHint {
  padding: 24px;
  font-size: 12px;
  color: #999;
  text-align: center;
}

/* 직접입력 그룹 선택 시 — 항목 입력/선택 불가 상태를 점선 빗금으로 시각화 */
.tisp-emptyHint--disabled {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 4px;
  border: 1px dashed #CFCFCF;
  border-radius: 0;
  background-image: repeating-linear-gradient(
      -45deg,
      transparent,
      transparent 8px,
      rgba(0, 0, 0, 0.05) 8px,
      rgba(0, 0, 0, 0.05) 16px
  );
  color: #888;
  cursor: not-allowed;
  user-select: none;
}

.tisp-footer {
  display: flex;
  justify-content: center;
  gap: 8px;
  padding: 10px 14px;
  border-top: 1px solid #CFCFCF;
}

.tisp-fade-enter-active,
.tisp-fade-leave-active {
  transition: opacity 120ms ease;
}

.tisp-fade-enter-from,
.tisp-fade-leave-to {
  opacity: 0;
}
</style>
