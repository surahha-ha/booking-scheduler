// ============================================================================
// 리스트 드래그 재정렬 (HTML5 native drag-and-drop)
// ----------------------------------------------------------------------------
// ref 배열의 순서를 드래그로 바꾼다. lockedHead 개수만큼의 선두 항목은 고정
// (드래그 소스·드롭 위치 모두 제외) — 예: "이름"을 항상 맨 앞에 고정.
//  - native DnD 라 클릭(토글)과 드래그(재정렬)가 자동 분리된다(dragstart 는 실제
//    드래그 때만 발생) → 칩 토글 핸들러와 공존 가능.
// ============================================================================
import {ref, type Ref} from 'vue';

export function useListDragReorder<T>(list: Ref<T[]>, opts?: {lockedHead?: number}) {
    const lockedHead = opts?.lockedHead ?? 0;
    const dragIndex = ref<number | null>(null);
    const overIndex = ref<number | null>(null);

    function reset() {
        dragIndex.value = null;
        overIndex.value = null;
    }

    function onDragStart(index: number, e: DragEvent) {
        if (index < lockedHead) return;
        dragIndex.value = index;
        if (e.dataTransfer) {
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', String(index)); // firefox 는 데이터 필요
        }
    }

    function onDragOver(index: number, e: DragEvent) {
        if (dragIndex.value === null || index < lockedHead) return;
        e.preventDefault(); // drop 허용
        overIndex.value = index;
    }

    function onDrop(index: number) {
        const from = dragIndex.value;
        reset();
        if (from === null || index < lockedHead || from === index) return;
        const next = [...list.value];
        const [moved] = next.splice(from, 1);
        next.splice(index, 0, moved);
        list.value = next;
    }

    function onDragEnd() {
        reset();
    }

    return {dragIndex, overIndex, onDragStart, onDragOver, onDrop, onDragEnd};
}
