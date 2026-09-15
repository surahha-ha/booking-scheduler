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
import {hasSelectableItems} from '@/components/popup/treatmentItemRules';
import {useDialogGuard} from '@/composables/useDialogGuard';

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

// 이 팝업의 dialog 호출은 전부 withDialog 를 지난다 — 호출 지점마다 플래그를 여닫으면 언젠가
// 빠뜨리고, 빠뜨린 그 다이얼로그 위에서 ESC 를 누르는 순간 결함이 된다(useDialogGuard).
// dialogOpen: 이 팝업이 띄운 다이얼로그가 떠 있는 동안 true. 그동안의 ESC·바깥 클릭은 그 다이얼로그
// 몫이라 팝업의 닫기 처리가 가로채면 안 된다 — 삭제 확인 중 ESC 가 닫기 확인을 겹쳐 띄우던 결함.
const {dialogOpen, withDialog} = useDialogGuard();

// 항목이 하나도 없는 그룹이 어느 것인지, 무엇을 해야 하는지 알린다.
// 그룹 전환 차단과 닫기 차단이 같은 alert·같은 문구를 쓴다 — 같은 사실에 문구를 하나만 둔다.
// 그룹명을 반드시 적는다 — 다른 그룹에 항목을 막 등록한 사용자가 "등록하지 않았다"는 문구를
// 자기 등록이 안 된 것으로 읽었다. 목록의 '항목 없음' 라벨은 hover 하면 수정/삭제로 바뀌어
// 그 순간엔 보이지 않으므로 다이얼로그가 스스로 말해야 한다.
function noItemGroupMsg(emptyGrps) {
  const names = emptyGrps.map((g) => g.serviceGroupName).join(', ');
  return `진료항목이 없는 그룹: ${names}\n진료항목을 등록하거나 그룹을 삭제하세요.`;
}
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
// 편집 진입 시점의 원본 — 변경 없으면 UPDATE 를 보내지 않는다.
// (무변경 UPDATE 는 수정일시를 갱신해 BE 정렬상 목록 맨 위로 올려버린다)
const groupNameOriginal = ref('');
// 4-4 진료항목 입력 auto-grow: 드래프트 배열(안정 id key → 커밋 시 다른 칸 포커스 보존).
let _draftSeq = 0;
function makeDraft() { return {id: ++_draftSeq, value: ''}; }
const newItemDrafts = ref([makeDraft()]);
const draftListRef = ref(null);
const editingItemId = ref(null);
const itemNameDraft = ref('');
const itemNameOriginal = ref('');
// 편집 input 실제 DOM — 수정 진입 시 포커스를 넣어야 blur 커밋이 성립한다.
// (v-for 안이라 함수 ref 로 받는다. 편집 행은 동시에 하나뿐)
const editGroupInputEl = ref(null);
const editItemInputEl = ref(null);
function setEditGroupInput(el) { if (el) editGroupInputEl.value = el; }
function setEditItemInput(el) { if (el) editItemInputEl.value = el; }

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
  editGroupInputEl.value = null;
  editItemInputEl.value = null;
  groupNameOriginal.value = '';
  itemNameOriginal.value = '';
  newItemDrafts.value = [makeDraft()];
  closing = false; // 끝나지 않은 등록 대기가 재오픈 뒤의 닫기까지 잠그지 않게
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
  if (!props.visible) return;

  // 입력 요소 밖에서의 백스페이스는 브라우저 뒤로가기로 흘러가 화면이 이탈한다.
  // 행 삭제·행 제거로 포커스가 body 로 빠진 직후가 특히 위험하다.
  if (e.key === 'Backspace') {
    const t = e.target;
    const isEditable = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
    if (!isEditable) e.preventDefault();
    return;
  }

  if (e.key !== 'Escape') return;
  // 이 팝업이 띄운 다이얼로그가 떠 있으면 ESC 의 주인은 그쪽이다 — 가로채지 않고 넘긴다.
  // (capture 라 우리가 먼저 실행된다. 여기서 소비하면 삭제 확인을 ESC 로 닫을 수 없고,
  //  닫기 확인까지 겹쳐 뜬다.)
  if (dialogOpen.value) return;
  // DxPopup 의 ESC 동작과 충돌 차단 — capture phase 에서 stopPropagation
  e.stopPropagation();
  e.preventDefault();
  // ESC 는 취소다 — 입력만 해둔 항목을 등록하지 않고 닫는다(다른 세 경로는 blur 가 먼저 등록한다).
  handleCancel({commitDrafts: false});
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
  handleCancel({commitDrafts: true});
}

// ---------- computed ----------
const selectedGroup = computed(() =>
    groups.value.find((g) => g.serviceGroupId === selectedGroupId.value),
);

// 이름 정규화: 모든 whitespace 제거 후 비교. 그룹명·항목명이 같은 규칙을 쓴다.
// ' 기타 ', '기타 ', ' 기타', '  기   타 '  → '기타'
function normalizeName(name) {
  return String(name ?? '').replace(/\s+/g, '');
}

// 그룹명 중복 여부 (편집 시 자기 자신 ID 제외)
function isDuplicateGrpNm(name, excludeId = null) {
  const norm = normalizeName(name);
  if (!norm) return false;
  return groups.value.some(
      (g) =>
          normalizeName(g.serviceGroupName) === norm &&
          g.serviceGroupId !== excludeId,
  );
}

// 항목명 중복 여부 (선택된 그룹 안에서, 편집 시 자기 자신 ID 제외).
// 그룹명과 같은 정규화를 쓴다 — 같은 규칙을 두 벌로 두지 않는다.
function isDuplicateItemNm(name, excludeId = null) {
  const norm = normalizeName(name);
  if (!norm) return false;
  return (selectedGroup.value?.items ?? []).some(
      (i) => normalizeName(i.serviceItemName) === norm && i.serviceItemId !== excludeId,
  );
}

// ---------- 그룹 ----------
// 다른 행을 편집 중이면 선택을 막지 않고 먼저 확정한다.
// (막아버리면 편집 input 에 포커스가 없을 때 그룹 전환이 영구 잠긴다)
async function selectGroup(grp) {
  if (editingGroupId.value !== null && editingGroupId.value !== grp.serviceGroupId) {
    await commitEditGroup();
  }
  if (editingGroupId.value === grp.serviceGroupId) return; // 편집 중인 자기 행은 선택만 유지

  // 항목이 하나도 없는 그룹을 두고 다른 그룹으로 넘어가려 하면 막는다.
  // 빈 그룹은 예약 팝업에서 고를 항목이 없는 껍데기라, 방치한 채 떠나지 못하게 한다.
  // 탈출구는 안내대로 둘 — 항목을 등록하거나 그룹을 삭제한다(둘 다 이 경로를 타지 않는다).
  const current = selectedGroup.value;
  if (current && current.serviceGroupId !== grp.serviceGroupId && !hasSelectableItems(current)) {
    await withDialog(() => dialog.alert(noItemGroupMsg([current]), {title: '진료항목'}));
    return;
  }

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

async function startEditGroup(grp) {
  if (editingGroupId.value !== null && editingGroupId.value !== grp.serviceGroupId) {
    await commitEditGroup();
  }
  editingGroupId.value = grp.serviceGroupId;
  groupNameDraft.value = grp.serviceGroupName;
  groupNameOriginal.value = grp.serviceGroupName ?? '';
  await nextTick();
  editGroupInputEl.value?.focus();
}

async function commitEditGroup() {
  const id = editingGroupId.value;
  if (id == null) return;
  // 편집 상태를 await 전에 동기 해제 — blur 커밋과 뒤따르는 click 의 레이스 차단
  editingGroupId.value = null;
  const name = groupNameDraft.value.trim();
  if (!name) return;
  if (name === groupNameOriginal.value.trim()) return; // 무변경 → UPDATE 생략
  // 중복 차단 (자기 자신 제외)
  if (isDuplicateGrpNm(name, id)) {
    push.error('이미 동일한 이름의 그룹이 존재합니다.');
    return;
  }
  try {
    await store.updateGroup(id, {serviceGroupName: name});
  } catch (e) {
    push.error(extractErrorMessage(e, '그룹 수정에 실패했습니다.'));
  }
}

async function deleteGroup(grp) {
  const ok = await withDialog(() => dialog.confirm(
      '그룹 삭제 시,\n내부 진료항목이 모두 삭제됩니다.\n삭제하시겠습니까?',
      {title: '진료항목 그룹 삭제'},
  ));
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
// current(입력 중인 행)는 비어도 제거하지 않는다 — 제거하면 그 input 이 unmount 돼
// 포커스가 body 로 빠지고, 이어지는 백스페이스가 브라우저 뒤로가기로 흘러간다.
function onItemDraftInput(current) {
  const arr = newItemDrafts.value;
  if (arr.length === 0 || arr[arr.length - 1].value.trim() !== '') {
    arr.push(makeDraft());
  }
  for (let i = arr.length - 2; i >= 0; i--) {
    if (arr[i].value.trim() === '' && arr[i].id !== current?.id) arr.splice(i, 1);
  }
  if (arr.length === 0) arr.push(makeDraft());
}

// 포커스가 떠난 뒤 정리: 마지막 빈 행 1개만 남긴다.
function pruneEmptyDrafts() {
  const arr = newItemDrafts.value;
  for (let i = arr.length - 2; i >= 0; i--) {
    if (arr[i].value.trim() === '') arr.splice(i, 1);
  }
  if (arr.length === 0 || arr[arr.length - 1].value.trim() !== '') {
    arr.push(makeDraft());
  }
}

// 서버에 보냈지만 아직 응답이 오지 않은 항목 등록. 닫기 확인은 이것이 끝난 뒤 빈 그룹을 센다.
const inFlightItemCommits = new Set();

// 입력만 하고 아직 등록되지 않은 항목을 전부 등록하고(commitDrafts), 진행 중인 등록까지 기다린다.
// 중복명은 여기서 건너뛴다 — 등록될 리 없는데 시도하면 뒤따르는 blur 가 같은 토스트를 한 번 더 띄운다.
async function flushItemDrafts(commitDrafts) {
  if (commitDrafts) {
    for (const d of [...newItemDrafts.value]) {
      const name = d.value.trim();
      if (name && !isDuplicateItemNm(name)) await commitItemDraft(d);
    }
  }
  await Promise.allSettled([...inFlightItemCommits]);
}

// 입력완료(blur/Enter) → createItem → 리스트로 이동, 그 칸 제거(안정 id 라 다른 칸 포커스 보존).
async function commitItemDraft(d, refocus = false) {
  const name = d.value.trim();
  if (!name) {
    pruneEmptyDrafts(); // 입력 중이라 살려뒀던 빈 행을 여기서 정리
    return;
  }
  if (!selectedGroup.value) return;
  if (isDuplicateItemNm(name)) {
    push.error('이미 동일한 이름의 진료항목이 존재합니다.');
    return;
  }
  d.value = ''; // 즉시 비움 → Enter(제거)→blur 중복 커밋 방지(재진입 시 name='' early return)
  const req = store.createItem({
    serviceGroupId: selectedGroup.value.serviceGroupId,
    serviceItemName       : name,
  });
  inFlightItemCommits.add(req);
  try {
    await req;
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
    push.error(extractErrorMessage(e, '진료항목 추가에 실패했습니다.'));
  } finally {
    inFlightItemCommits.delete(req);
  }
}

async function startEditItem(item) {
  // 편집 중인 자기 행의 재진입은 무시 — draft 가 원본으로 되돌아가는 것을 막는다
  if (editingItemId.value === item.serviceItemId) return;
  // 다른 항목 편집 중이면 먼저 확정 (포커스 없이 전환 시 입력이 유실되던 문제)
  if (editingItemId.value !== null) {
    await commitEditItem();
  }
  editingItemId.value = item.serviceItemId;
  itemNameDraft.value = item.serviceItemName;
  itemNameOriginal.value = item.serviceItemName ?? '';
  await nextTick();
  editItemInputEl.value?.focus();
}

async function commitEditItem() {
  const id = editingItemId.value;
  if (id == null) return;
  // 편집 상태를 await 전에 동기 해제 — blur 커밋과 뒤따르는 click 의 레이스 차단
  editingItemId.value = null;
  const name = itemNameDraft.value.trim();
  if (!name) return;
  if (name === itemNameOriginal.value.trim()) return; // 무변경 → UPDATE 생략
  if (isDuplicateItemNm(name, id)) {
    push.error('이미 동일한 이름의 진료항목이 존재합니다.');
    return;
  }
  try {
    await store.updateItem(id, {serviceItemName: name});
  } catch (e) {
    push.error(extractErrorMessage(e, '진료항목 수정에 실패했습니다.'));
  }
}

async function deleteItem(item) {
  // 그룹 삭제와 같은 자리의 같은 버튼이다 — 한쪽만 묻고 한쪽은 바로 지우면 실수로 지운다.
  const ok = await withDialog(() => dialog.confirm('삭제하시겠습니까?', {title: '진료항목 삭제'}));
  if (!ok) return;
  try {
    await store.deleteItem(item.serviceItemId);
  } catch (e) {
    push.error(extractErrorMessage(e, '서비스 항목 삭제에 실패했습니다.'));
  }
}

// 닫기 4경로(ESC·취소 버튼·× 버튼·바깥 클릭)가 모두 여기로 모인다 — 규칙은 이 한 곳에만 둔다.
// 판정 대상은 그룹 전환 차단(selectGroup)과 같이 "지금 선택한 그룹" 하나다. 전체 그룹을 훑던
// 때는 다른 그룹 때문에 뜬 확인창을 사용자가 자기 그룹 검증으로 읽었다(QA) — 보고 있는 그룹만
// 말해야 오해가 구조적으로 사라진다. 선택되지 않은 빈 그룹은 목록의 '항목 없음' 라벨과 예약
// 팝업의 비활성으로 이미 드러난다.
// 빈 그룹을 선택한 채로는 닫지 못한다 — 그룹 전환 차단과 같은 alert(버튼 하나)·같은 문구로 막는다.
// 세 경로(X·취소·그룹 전환)가 다르게 굴면 사용자는 규칙이 아니라 우연으로 읽는다. 탈출구는
// 안내대로 둘, 항목을 등록하거나 그룹을 삭제한다.
let closing = false;
async function handleCancel({commitDrafts = true} = {}) {
  // 다이얼로그가 떠 있는 동안의 ESC 연타·바깥 클릭이 확인을 겹쳐 띄우는 것을 막는다.
  // closing: 아래 등록 대기 중의 재진입도 같은 이유로 막는다.
  if (dialogOpen.value || closing) return;
  closing = true;
  try {
    // 바깥 클릭(mousedown)은 입력칸 blur 보다 먼저 여기 온다. 입력만 하고 아직 등록되지 않은
    // 항목을 먼저 등록하지 않으면 방금 입력한 그룹을 빈 그룹으로 보아 안내창이 거짓말을 한다.
    await flushItemDrafts(commitDrafts);
    const current = selectedGroup.value;
    if (current && !hasSelectableItems(current)) {
      await withDialog(() => dialog.alert(noItemGroupMsg([current]), {title: '진료항목'}));
      return;
    }
    emit('close');
  } finally {
    closing = false;
  }
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
          class="tisp-root schedule-popup"
          role="dialog"
          aria-modal="false"
          aria-label="서비스 항목 설정"
      >
        <!-- 헤더 -->
        <div class="tisp-header schedule-popup__header">
          <span class="tisp-title schedule-popup__title">진료항목 설정</span>
          <button class="tisp-closeBtn schedule-popup__close-button" type="button" aria-label="닫기" @click="handleCancel()">×</button>
        </div>

        <!-- 본문: 헤더/푸터(약 100px) 빼고 남은 영역 -->
        <div class="tisp-body schedule-popup__body">
          <!-- 좌측 그룹 리스트 -->
          <div class="tisp-col tisp-col--group">
            <div class="tisp-colHeader tisp-group-column-header">
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
                      :ref="setEditGroupInput"
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
                  <!-- 우측 꼬리 — '항목 없음' 라벨과 수정/삭제가 같은 칸을 나눠 쓴다.
                       평소엔 라벨, hover 하면 수정/삭제로 교체된다(.tisp-rowTail).
                       항목이 없는 그룹은 예약 팝업에서 고를 수 없다. 자리에서 사실만 적고
                       색으로 상태를 말하지 않는다. 어느 그룹인지는 다이얼로그도 이름으로 말한다. -->
                  <span class="tisp-rowTail">
                    <span v-if="!hasSelectableItems(grp)" class="tisp-rowMeta">항목 없음</span>
                    <span class="tisp-rowActions">
                      <button class="tisp-rowAction" type="button" @click.stop="startEditGroup(grp)">수정</button>
                      <button class="tisp-rowAction tisp-rowAction--danger" type="button" @click.stop="deleteGroup(grp)">삭제</button>
                    </span>
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

            </div>
            <div v-if="newGroupInput === null" class="tisp-add-area">
              <button
                  class="tisp-addBtn"
                  type="button"
                  @click="startNewGroup"
              >
                <span aria-hidden="true" class="tisp-add-button__icon">+</span>
                <span>추가</span>
              </button>
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
                  @click="startEditItem(item)"
              >
                <template v-if="editingItemId === item.serviceItemId">
                  <input
                      :ref="setEditItemInput"
                      v-model="itemNameDraft"
                      :maxlength="ITEM_NM_MAX"
                      class="tisp-input"
                      type="text"
                      @blur="commitEditItem"
                      @keydown.enter.prevent="commitEditItem"
                      @click.stop
                  />
                </template>
                <template v-else>
                  <span class="tisp-rowText">{{ item.serviceItemName }}</span>
                  <span class="tisp-rowActions">
                    <button class="tisp-rowAction tisp-rowAction--danger tisp-item-delete-button" type="button" @click.stop="deleteItem(item)">×</button>
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
                      @input="onItemDraftInput(d)"
                      @blur="commitItemDraft(d)"
                      @keydown.enter.prevent="commitItemDraft(d, true)"
                  />
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- 푸터: 버튼 하나. 그룹·항목 CRUD 는 조작 시점에 이미 서버에 반영돼
             저장할 잔여 변경이 없으므로 '저장' 버튼을 두지 않는다. -->
        <div class="tisp-footer schedule-popup__footer">
          <button class="btn-action schedule-popup__button" type="button" @click="handleCancel()">취소</button>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style lang="scss" scoped>
.tisp-root {
  position: fixed;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.tisp-body {
  flex: 1 1 auto;
  display: flex;
  gap: 12px;
  overflow: hidden;
  min-height: 0;
}

.tisp-col {
  flex: 1;
  border: 1px solid #d2d2d2;
  border-radius: 0;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}

.tisp-col--group {
  border: 0;
}

.tisp-colHeader {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 12px;
  background: #F4F4F4;
  font-weight: 600;
  font-size: 14px;
}

.tisp-group-column-header {
  background: transparent;
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
  font-size: 14px;
  min-height: 28px;
  /* hover/active 시 자간 흔들림 방지: weight 는 항상 600 으로 고정,
     hover/active 는 색만 변경 */
  font-weight: 400;
  transition: background-color 0.2s;
}

.tisp-row:hover {
  background: #FDEFE5;
}

.tisp-row.is-active {
  background: #FDEFE5;
  color: #2F6FED;
  font-weight: 600;
}

/* 좌측 그룹 선택은 배경 대신 좌측 강조선으로 표시한다. */
.tisp-col--group .tisp-row.is-active {
  padding-left: 10px;
  border-left: 2px solid #2F6FED;
  background: transparent;
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

/* 우측 꼬리 — '항목 없음' 라벨과 수정/삭제를 같은 grid 칸에 겹쳐 두고 hover 로 교체한다.
 * 칸 폭은 둘 중 넓은 쪽으로 잡히므로 hover 해도 그룹명 폭이 흔들리지 않는다.
 * 컬럼 헤더의 '최대 N자 입력가능' 힌트와 같은 우측 여백(12px)이라 세로로 정렬된다. */
.tisp-rowTail {
  display: grid;
  justify-items: end;
  align-items: center;
  margin-left: 8px;
  flex: 0 0 auto;
}

.tisp-rowTail > * {
  grid-area: 1 / 1;
}

.tisp-rowMeta {
  font-size: 11px;
  color: #aaa;
  /* 그룹명(.tisp-rowText, flex:1)이 길어도 이 라벨은 줄지 않는다 — 줄면 '항목 없…'이 된다. */
  white-space: nowrap;
}

/* hover 하면 라벨 자리를 수정/삭제가 넘겨받는다. */
.tisp-row:hover .tisp-rowMeta {
  visibility: hidden;
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
  height: 20px;
  padding: 0 4px;
  border: 1px solid #A5A5A5;
  border-radius: 4px;
  background: #fff;
  cursor: pointer;
  color: #565656;
  font-size: 12px;
  font-weight: 500;
  transition: background-color 0.2s;
}

.tisp-rowAction:hover {
  background: #F2F2F2;
}

.tisp-rowAction--danger {
  color: #D9534F;
}

.tisp-rowAction--danger:hover {
  color: #B52A25;
}

/* 진료항목 삭제는 텍스트형이 아닌 무테두리 아이콘 버튼으로 표시한다. */
.tisp-item-delete-button {
  width: 20px;
  padding: 0;
  border: 0;
  background: transparent;
  color: #565656;
  font-size: 16px;
  line-height: 1;
}

.tisp-item-delete-button:hover {
  background: transparent;
  color: #565656;
}

.tisp-input {
  /* ReservationPopup의 공통 입력 필드와 동일한 외형 */
  width: 100%;
  border: 1px solid #BCBCBC;
  border-radius: 4px;
  padding: 4px 6px;
  font-size: 14px;
  box-sizing: border-box;
  outline: none;
  transition: border-color 0.2s;
}

.tisp-input:focus {
  border-color: #2F6FED;
}

.tisp-addBtn {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  height: 20px;
  margin: 6px 0;
  padding: 0;
  border: 0;
  background: transparent;
  color: #2F6FED;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: color 0.2s;
}

.tisp-add-button__icon {
  display: inline-flex;
  align-items: center;
  height: 20px;
  font-weight: 400;
  font-size: 22px;
  line-height: 1;
}

.tisp-add-area {
  display: flex;
  justify-content: center;
  border-top: 1px solid #EEE;
}

.tisp-addBtn > span:not(.tisp-add-button__icon) {
  display: inline-flex;
  align-items: center;
  height: 20px;
  line-height: 1;
}

.tisp-addBtn:hover {
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

.tisp-fade-enter-active,
.tisp-fade-leave-active {
  transition: opacity 120ms ease;
}

.tisp-fade-enter-from,
.tisp-fade-leave-to {
  opacity: 0;
}
</style>
