/**
 * fixed popover 를 뷰포트 안으로 접는 공용 규칙.
 *
 * 트리거 좌표에 그대로 펼치면 화면 오른쪽·아래를 넘어간다. 운영시간 설정에서 먼저 겪고 고친 규칙을
 * 같은 문제가 있던 다른 popover(운영일정 보기 더보기 · 스케줄러 카드 ⋮ 메뉴)가 함께 쓴다.
 *
 * 배치는 셋이고, 무엇을 가리느냐가 다르다.
 *  - clampPopoverPos : 앵커 **아래**로 펼친다(편집 popover). 넘치면 위로 뒤집는다.
 *  - clampOverlayPos : 앵커를 **덮는다**(더보기). 뒤집지 않고 밀기만 한다.
 *  - clampFlyoutPos  : 앵커 **왼쪽**으로 펼친다(카드 ⋮ 메뉴). 왼쪽이 모자라면 오른쪽으로 뒤집는다.
 */

import { nextTick, type Ref } from 'vue';

export const POPOVER_GAP = 4;
export const POPOVER_MARGIN = 8;

/** 트리거 위치. DOMRect 를 그대로 넘겨도 되고, 같은 네 값을 가진 객체여도 된다. */
export interface AnchorRect {
    top: number;
    left: number;
    right: number;
    bottom: number;
}

export interface PopoverPos {
    top: number;
    left: number;
}

export type ClampFn = (_rect: AnchorRect, _width: number, _height: number) => PopoverPos;

/** 값을 [margin, 축길이 - 크기 - margin] 안으로 민다. popover 가 뷰포트보다 크면 margin 에 붙는다. */
function pushIntoAxis(value: number, size: number, axisLength: number): number {
    return Math.max(POPOVER_MARGIN, Math.min(value, axisLength - size - POPOVER_MARGIN));
}

/**
 * 앵커 아래·왼쪽 정렬이 기본. 뷰포트를 넘으면 가로는 앵커 오른쪽 끝에 맞춰 뒤집고, 세로는 앵커 위로 뒤집는다.
 * 편집 popover(요일 편집 · 일자 지정)처럼 트리거를 가리면 안 되는 배치에 쓴다.
 */
export function clampPopoverPos(rect: AnchorRect, width: number, height: number): PopoverPos {
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let left = rect.left;
    if (left + width > vw - POPOVER_MARGIN) left = rect.right - width;

    let top = rect.bottom + POPOVER_GAP;
    if (top + height > vh - POPOVER_MARGIN) top = rect.top - height - POPOVER_GAP;

    return {top: pushIntoAxis(top, height, vh), left: pushIntoAxis(left, width, vw)};
}

/**
 * 앵커를 덮는 배치다 — 아래로 내리거나 위로 뒤집지 않고 뷰포트 안으로 밀기만 한다.
 * 더보기 popover 는 셀 위에 겹쳐 뜨는 것이 원래 모양이라 뒤집으면 어느 칸의 목록인지 알 수 없어진다.
 */
export function clampOverlayPos(rect: AnchorRect, width: number, height: number): PopoverPos {
    return {
        top : pushIntoAxis(rect.top, height, window.innerHeight),
        left: pushIntoAxis(rect.left, width, window.innerWidth),
    };
}

/**
 * 앵커 왼쪽으로 펼치고 상단을 맞추는 배치. 왼쪽 여백이 모자라면 앵커 오른쪽으로 뒤집고,
 * 아래로 넘치면 앵커 하단에 바닥을 맞춰 위로 뒤집는다.
 * 카드 ⋮ 메뉴처럼 트리거가 카드 오른쪽 변에 붙어 있는 배치에 쓴다.
 */
export function clampFlyoutPos(rect: AnchorRect, width: number, height: number): PopoverPos {
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let left = rect.left - width;
    if (left < POPOVER_MARGIN) left = rect.right;

    let top = rect.top;
    if (top + height > vh - POPOVER_MARGIN) top = rect.bottom - height;

    return {top: pushIntoAxis(top, height, vh), left: pushIntoAxis(left, width, vw)};
}

/**
 * 렌더된 실제 크기로 한 번 더 접는다 — min-width 만으로는 실폭·실높이를 알 수 없다.
 * 크기를 못 재면(테스트 stub 등) 임시 계산 결과를 그대로 둔다.
 */
export async function settlePopoverPos<T extends { open: boolean }>(
    getEl: () => Element | null | undefined,
    stateRef: Ref<T>,
    rect: AnchorRect,
    clamp: ClampFn,
): Promise<void> {
    await nextTick();
    const box = getEl()?.getBoundingClientRect?.();
    if (!box?.width || !box?.height) return;
    if (!stateRef.value.open) return;
    stateRef.value = {...stateRef.value, ...clamp(rect, box.width, box.height)};
}
