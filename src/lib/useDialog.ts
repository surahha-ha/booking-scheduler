// ============================================================================
// 전역 alert / confirm 다이얼로그
// ----------------------------------------------------------------------------
// 상태만 여기서 들고, 실제 렌더는 AppDialogHost.vue 가 한다(앱 셸에 1개만 마운트).
// 호출부는 `const dialog = useDialog()` 후 `await dialog.confirm(msg, {title})`.
// ============================================================================
import {reactive} from 'vue';

type DialogKind = 'alert' | 'confirm';

export type DialogOptions = {
    title?: string;
    okText?: string;
    cancelText?: string;
};

export type DialogState = {
    open: boolean;
    kind: DialogKind;
    message: string;
    title: string;
    okText: string;
    cancelText: string;
};

const state = reactive<DialogState>({
    open      : false,
    kind      : 'alert',
    message   : '',
    title     : '',
    okText    : '확인',
    cancelText: '취소',
});

let resolver: ((value: boolean) => void) | null = null;

function open(kind: DialogKind, message: string, options: DialogOptions = {}): Promise<boolean> {
    // 이미 떠 있는 다이얼로그가 있으면 취소로 정산한다 — resolver 유실(영원히 pending) 방지.
    if (resolver) {
        const stale = resolver;
        resolver = null;
        stale(false);
    }

    state.kind = kind;
    state.message = message ?? '';
    state.title = options.title ?? (kind === 'confirm' ? '확인' : '알림');
    state.okText = options.okText ?? '확인';
    state.cancelText = options.cancelText ?? '취소';
    state.open = true;

    return new Promise<boolean>((resolve) => {
        resolver = resolve;
    });
}

/** 호스트 컴포넌트 전용 — 버튼/ESC 로 다이얼로그를 닫고 결과를 확정한다. */
export function settleDialog(result: boolean): void {
    state.open = false;
    const done = resolver;
    resolver = null;
    done?.(result);
}

/** 호스트 컴포넌트 전용 — 렌더할 상태. */
export function useDialogState(): DialogState {
    return state;
}

export function useDialog() {
    return {
        alert  : (message: string, options?: DialogOptions): Promise<void> =>
            open('alert', message, options).then(() => undefined),
        confirm: (message: string, options?: DialogOptions): Promise<boolean> =>
            open('confirm', message, options),
    };
}
