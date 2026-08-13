// ============================================================================
// 미리보기 row 높이 드래그 조절 (예약장부 설정 > 스케줄러)
// ----------------------------------------------------------------------------
// 행 경계를 드래그하면 1~5 단계로 "뚝뚝" 끊어지며(연속 X) row 높이가 바뀐다.
//  - 단계 commit 은 드래그 중(pointermove) 실시간 → 슬롯 높이는 항상 단계 기반(이산).
//    같은 ref 를 구동하는 상단 "카드 높이" 컨트롤도 드래그와 동시에 단계가 바뀐다(연동).
//  - 전역 균일 높이: 모든 row 가 같은 높이로 함께 조절(엔진의 단일 rowHeight 와 동일 사상).
//  - 스냅 모델: 엔진 ROW_HEIGHT_BY_LEVEL / store rowHeightLevel 도메인(1~5) 재사용 →
//    데이터 모델·저장 seam 무변경.
// ============================================================================
import {computed, ref} from 'vue';

export interface RowHeightLevelDragOptions {
    /** 1~5 단계별 미리보기 슬롯 높이(px). index 0 = level 1, 오름차순. */
    levelHeights: number[];
    /** 현재 단계(1~5) getter */
    getLevel: () => number;
    /** 단계(1~5) commit — 드래그 중 실시간 호출 */
    setLevel: (_level: number) => void;
}

export function useRowHeightLevelDrag(opts: RowHeightLevelDragOptions) {
    const {levelHeights, getLevel, setLevel} = opts;
    const minHeight = levelHeights[0];
    const maxHeight = levelHeights[levelHeights.length - 1];

    const dragging = ref(false);

    let startY = 0;
    let startHeight = 0;

    /** 단계(1~5) → 슬롯 높이(px) */
    function levelToHeight(level: number): number {
        const idx = Math.min(Math.max(Math.trunc(level), 1), levelHeights.length) - 1;
        return levelHeights[idx];
    }

    /** 슬롯 높이(px) → 가장 가까운 단계(1~5) */
    function heightToNearestLevel(height: number): number {
        let best = 1;
        let bestDist = Infinity;
        levelHeights.forEach((h, i) => {
            const dist = Math.abs(h - height);
            if (dist < bestDist) {
                bestDist = dist;
                best = i + 1;
            }
        });
        return best;
    }

    /** 미리보기 슬롯 높이 — 항상 현재 단계 기반(이산). 드래그 중에도 단계 단위로만 변한다. */
    const slotHeightPx = computed(() => levelToHeight(getLevel()));

    function onPointerMove(e: PointerEvent) {
        if (!dragging.value) return;
        const dy = e.clientY - startY;
        const target = Math.min(Math.max(startHeight + dy, minHeight), maxHeight);
        const level = heightToNearestLevel(target);
        // 단계가 바뀌는 순간에만 commit → row·상단 카드 높이 컨트롤이 "뚝" 한 단계씩 이동
        if (level !== getLevel()) setLevel(level);
    }

    function endDrag() {
        if (!dragging.value) return;
        dragging.value = false;
        window.removeEventListener('pointermove', onPointerMove);
        window.removeEventListener('pointerup', endDrag);
    }

    /** 행 경계 핸들 pointerdown */
    function startDrag(e: PointerEvent) {
        e.preventDefault();
        dragging.value = true;
        startY = e.clientY;
        startHeight = levelToHeight(getLevel());
        window.addEventListener('pointermove', onPointerMove);
        window.addEventListener('pointerup', endDrag);
    }

    return {dragging, slotHeightPx, startDrag};
}
