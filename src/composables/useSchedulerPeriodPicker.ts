import {computed, nextTick, onBeforeUnmount, onMounted, ref, watch} from 'vue';
import dayjs from 'dayjs';

type ViewMode = 'WEEK' | 'DAY';

const POPUP_GAP = 6;    // 트리거와 팝업 사이 간격
const VIEWPORT_PAD = 8; // 뷰포트 가장자리 최소 여백

export function useSchedulerPeriodPicker(options: {
    getPeriodDate: () => Date
    getViewMode: () => ViewMode
    setPeriodDate: (d: Date) => void

    closeOnOutsideSelector?: string // default '.scheduleNavDateBox'
    formatWeek?: (start: dayjs.Dayjs, end: dayjs.Dayjs) => string
    formatDay?: (d: dayjs.Dayjs) => string
}) {
    const weekPickerRef = ref<any>(null);
    const dayPickerRef = ref<any>(null);

    const weekRange = ref<[Date | null, Date | null]>([null, null]);
    const dayValue = ref<Date | null>(null);

    const isDateOpen = ref(false);

    // ── 팝업 좌표(fixed) ──
    // 검색필터바가 overflow-x:auto 라 CSS 사양상 overflow-y 도 auto 로 계산된다 → absolute 팝업은
    // 바 높이(약 29px) 밖이 전부 잘려 화면에 안 보였다. fixed 는 조상 overflow 클리핑을 벗어난다.
    const triggerRef = ref<HTMLElement | null>(null);
    const popupRef = ref<HTMLElement | null>(null);
    const popupPos = ref({top: 0, left: 0});

    const popupStyle = computed(() => ({
        top : `${popupPos.value.top}px`,
        left: `${popupPos.value.left}px`,
    }));

    /** 트리거 아래 왼쪽 정렬. 팝업 실폭을 알 때는 뷰포트 오른쪽을 넘지 않게 당긴다. */
    function updatePopupPos() {
        const el = triggerRef.value;
        if (!el) return;

        const r = el.getBoundingClientRect();
        const w = popupRef.value?.offsetWidth ?? 0;
        const left = w > 0
            ? Math.max(VIEWPORT_PAD, Math.min(r.left, window.innerWidth - w - VIEWPORT_PAD))
            : r.left;

        popupPos.value = {top: r.bottom + POPUP_GAP, left};
    }

    const periodDateText = computed(() => {
        const base = dayjs(options.getPeriodDate());
        const mode = options.getViewMode();

        if (mode === 'WEEK') {
            const start = base.startOf('week');
            const end = start.add(6, 'day');
            return options.formatWeek
                ? options.formatWeek(start, end)
                : `${start.format('MM월 DD일')} ~ ${end.format('MM월 DD일')}`;
        }

        return options.formatDay
            ? options.formatDay(base)
            : base.format('MM월 DD일(ddd)');
    });

    async function openPicker() {
        isDateOpen.value = true;
        updatePopupPos();   // 트리거 기준 1차 배치
        await nextTick();
        updatePopupPos();   // 렌더된 실폭으로 오른쪽 넘침 보정
    }

    function closePicker() {
        isDateOpen.value = false;
    }

    function onPickWeek(value: any) {
        const picked = Array.isArray(value)
            ? (value[0] ?? value[1])
            : (value?.start ?? value);

        if (!picked) return;

        const start = dayjs(picked).startOf('week').startOf('day').toDate();
        const end = dayjs(start).add(6, 'day').endOf('day').toDate();

        weekRange.value = [start, end];
        options.setPeriodDate(start);
        closePicker();
    }

    function onPickDay(value: any) {
        if (!value) return;
        const d = dayjs(value).startOf('day').toDate();
        dayValue.value = d;
        options.setPeriodDate(d);
        closePicker();
    }

    function onGlobalClick(e: MouseEvent) {
        if (!isDateOpen.value) return;

        const selector = options.closeOnOutsideSelector ?? '.scheduleNavDateBox';
        const boxEl = (e.target as HTMLElement)?.closest(selector);
        if (boxEl) return;

        closePicker();
    }

    // 외부에서 periodDate/viewMode가 바뀌면 picker 바인딩 값 동기화
    watch(
        () => [options.getPeriodDate(), options.getViewMode()] as const,
        () => {
            const base = dayjs(options.getPeriodDate());
            const mode = options.getViewMode();

            if (mode === 'WEEK') {
                const start = base.startOf('week').startOf('day').toDate();
                const end = dayjs(start).add(6, 'day').endOf('day').toDate();
                weekRange.value = [start, end];
            } else {
                dayValue.value = base.toDate();
            }
        },
        {immediate: true}
    )

    // fixed 팝업은 스크롤을 따라가지 않아 트리거와 어긋난다 → 닫는다(카드 popover 와 같은 정책).
    function onViewportChange() {
        if (isDateOpen.value) closePicker();
    }

    onMounted(() => {
        window.addEventListener('click', onGlobalClick);
        window.addEventListener('scroll', onViewportChange, true); // capture: 내부 스크롤 컨테이너도 포함
        window.addEventListener('resize', onViewportChange);
    });
    onBeforeUnmount(() => {
        window.removeEventListener('click', onGlobalClick);
        window.removeEventListener('scroll', onViewportChange, true);
        window.removeEventListener('resize', onViewportChange);
    });

    return {
        weekPickerRef,
        dayPickerRef,
        triggerRef,
        popupRef,
        popupStyle,
        weekRange,
        dayValue,
        isDateOpen,
        periodDateText,
        openPicker,
        closePicker,
        onPickWeek,
        onPickDay,
    }
}
