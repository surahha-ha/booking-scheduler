/**
 * useDevice.ts
 * ------------------------------------------------------------
 * [PC/Mobile 분기]
 * - PC 인가?                                  → isPC
 * - Mobile 계열인가? (폰/태블릿/폴더블/플립 포함) → isMobileFamily
 *
 * [폴더블/듀얼스크린 대응]
 * - 2화면(분할/힌지) 상태인가? → isTwoScreen
 *   - 가능하면 표준 신호(viewportSegments/spanning)를 사용
 *   - 미지원 환경에서는 false
 *
 * - 폴드 펼침처럼 “넓은 터치 화면”인가?      → isWideTouch (fallback)
 * - 폴더블 전용 레이아웃을 켜야 하나?        → shouldUseFoldableLayout
 * - 2-pane UI(좌/우) 켤까?                → useTwoPane
 *
 * ------------------------------------------------------------
 * [주요함수]
 * 1) isPC / isMobileFamily
 * 2) isTwoScreen
 * 3) useTwoPane
 * 4) enableHoverTooltip
 * 5) layoutMode (compact/medium/expanded)
 *
 * ------------------------------------------------------------
 * [사용 예시 1] PC, MobileFamily
 *
 * const d = useDevice();
 * if (d.isPC.value) { ... } else { ... } // 모바일(폰/태블릿/폴더블/플립) 모두 else
 *
 * ------------------------------------------------------------
 * [사용 예시 2] 폴더블 2화면(분할) > 2-pane > 일반 모바일
 *
 * <ScheduleTwoScreen v-if="d.isTwoScreen" />
 * <ScheduleTwoPane v-else-if="d.useTwoPane" />
 * <ScheduleMobile v-else />
 *
 * ------------------------------------------------------------
 * [사용 예시 3] 캘린더 UX 분기
 * - PC: hover tooltip
 * - Mobile: long-press 메뉴
 *
 * const enableHoverTooltip = d.enableHoverTooltip.value;
 * const enableLongPress = d.isMobileFamily.value;
 */

import { computed, onBeforeUnmount, onMounted, ref } from "vue";

export type DeviceType = "mobile" | "tablet" | "desktop";
export type LayoutMode = "compact" | "medium" | "expanded";

export type Breakpoints = {
  mobileMax: number; // <= mobileMax => compact/mobile
  tabletMax: number; // <= tabletMax => medium/tablet, else expanded/desktop
};

export type FoldHeuristics = {
  /**
   * “폴드 펼침”처럼 넓게 쓸 수 있는 터치 화면(=wide touch) 최소 폭
   * 팀 UI 기준으로 조정: 보통 840~900 사이
   */
  wideTouchMinWidth: number;

  /**
   * 2-pane(좌/우) 레이아웃을 켤 최소 폭
   * wideTouchMinWidth보다 같거나 조금 큰 값으로 두는 편
   */
  twoPaneMinWidth: number;
};

/**
 * PC 판별 옵션
 * - 기본(추천): canHover === true면 PC로 취급
 * - 옵션: 데스크탑인데 창을 아주 좁게 줄이면 Mobile로 보내고 싶을 때 minDesktopWidth 사용
 */
export type PcHeuristics = {
  minDesktopWidth?: number; // 예: 1025
};

const DEFAULT_BREAKPOINTS: Breakpoints = { mobileMax: 767, tabletMax: 1024 };
const DEFAULT_FOLD: FoldHeuristics = { wideTouchMinWidth: 840, twoPaneMinWidth: 900 };

type SpanningDirection = "none" | "vertical" | "horizontal";
type ViewportSegment = { x: number; y: number; width: number; height: number };

function buildMql(query: string): MediaQueryList | null {
  if (typeof window === "undefined") return null;
  return window.matchMedia?.(query) ?? null;
}

/**
 * Viewport Segments API (지원 브라우저에서만 허용됨)
 * - 폴더블/듀얼스크린에서 화면이 “논리적으로 분할”되는 경우
 *   각 segment(영역)의 rect 정보를 받을 수 있음
 * - 미지원이면 null
 */
function getViewportSegments(): ViewportSegment[] | null {
  const nav: any = typeof navigator !== "undefined" ? navigator : null;
  const vs = nav?.viewportSegments;
  if (!vs) return null;

  try {
    const arr = Array.isArray(vs) ? vs : typeof vs === "function" ? vs() : vs;
    if (!Array.isArray(arr)) return null;

    const mapped = arr
      .map((r: any) => ({
        x: Number(r.x ?? 0),
        y: Number(r.y ?? 0),
        width: Number(r.width ?? 0),
        height: Number(r.height ?? 0),
      }))
      .filter((r: ViewportSegment) => r.width > 0 && r.height > 0);

    return mapped.length ? mapped : null;
  } catch {
    return null;
  }
}

function addMqlListener(mql: MediaQueryList | null, fn: () => void) {
  if (!mql) return () => {};
  mql.addEventListener("change", fn);
  return () => mql.removeEventListener("change", fn);
}

export function useDevice(options?: {
  breakpoints?: Partial<Breakpoints>;
  fold?: Partial<FoldHeuristics>;
  pc?: PcHeuristics;
}) {
  const bp: Breakpoints = { ...DEFAULT_BREAKPOINTS, ...(options?.breakpoints ?? {}) };
  const fold: FoldHeuristics = { ...DEFAULT_FOLD, ...(options?.fold ?? {}) };
  const pcOpt: PcHeuristics = options?.pc ?? {};

  const width = ref<number>(typeof window !== "undefined" ? window.innerWidth : 0);

  // ------------------------------------------------------------
  // 1) 입력 특성(capability)
  // ------------------------------------------------------------
  const mqlCoarse = buildMql("(pointer: coarse)"); // 터치 중심이면 true
  const mqlHover = buildMql("(hover: hover)");     // hover 가능이면 true
  const mqlLandscape = buildMql("(orientation: landscape)");

  const isTouchLike = ref<boolean>(mqlCoarse?.matches ?? false);
  const canHover = ref<boolean>(mqlHover?.matches ?? false);
  const isLandscape = ref<boolean>(mqlLandscape?.matches ?? false);

  // ------------------------------------------------------------
  // 2) 폴더블/듀얼스크린 신호 (신호가 지원되는 경우에만 적용됨)
  // ------------------------------------------------------------
  const viewportSegments = ref<ViewportSegment[] | null>(null);

  // spanning media feature (표준/구현 히스토리 때문에 2개 이름 다 시도)
  const mqlSpanningVertical =
    buildMql("(spanning: single-fold-vertical)") ??
    buildMql("(screen-spanning: single-fold-vertical)");

  const mqlSpanningHorizontal =
    buildMql("(spanning: single-fold-horizontal)") ??
    buildMql("(screen-spanning: single-fold-horizontal)");

  const spanningDirection = ref<SpanningDirection>("none");

  const updateSpanning = () => {
    const vertical = mqlSpanningVertical?.matches ?? false;
    const horizontal = mqlSpanningHorizontal?.matches ?? false;
    spanningDirection.value = vertical ? "vertical" : horizontal ? "horizontal" : "none";
  };

  const isSpanning = computed(() => spanningDirection.value !== "none");

  /**
   * isTwoScreen
   *
   * “폴드를 1개 화면으로 보다(=single) → 2개 화면으로 본다(=segmented/spanning)” 감지용.
   *
   * - viewportSegments가 2개 이상이면: 논리적으로 화면이 분할된 상태라고 판단
   * - spanning이 vertical/horizontal이면: 분할/힌지 상태라고 판단
   *
   * ⚠️ 지원 안 되는 환경에서는 둘 다 false일 수 있음.
   */
  const isTwoScreen = computed(() => {
    const segCount = viewportSegments.value?.length ?? 0;
    return segCount >= 2 || isSpanning.value;
  });

  // ------------------------------------------------------------
  // 3) 기본 레이아웃 분기: width 기반
  // ------------------------------------------------------------
  const deviceType = computed<DeviceType>(() => {
    const w = width.value;
    if (w <= bp.mobileMax) return "mobile";
    if (w <= bp.tabletMax) return "tablet";
    return "desktop";
  });

  const layoutMode = computed<LayoutMode>(() => {
    const w = width.value;
    if (w <= bp.mobileMax) return "compact";
    if (w <= bp.tabletMax) return "medium";
    return "expanded";
  });

  const isMobile = computed(() => deviceType.value === "mobile");
  const isTablet = computed(() => deviceType.value === "tablet");
  const isDesktop = computed(() => deviceType.value === "desktop");

  // ------------------------------------------------------------
  // 4) PC / MobileFamily
  // ------------------------------------------------------------
  /**
   * isPC 추천 기준
   * - canHover === true면 PC로 취급 (마우스/트랙패드 환경)
   * - 태블릿/폴더블은 보통 hover가 불가 → MobileFamily로 묶임
   *
   * (선택) pc.minDesktopWidth를 주면:
   * - 데스크탑인데 창을 아주 좁게 줄였을 때 Mobile로 취급 가능
   */
  const isPC = computed(() => {
    if (!canHover.value) return false;
    if (typeof pcOpt.minDesktopWidth === "number") {
      return width.value >= pcOpt.minDesktopWidth;
    }
    return true;
  });

  const isMobileFamily = computed(() => !isPC.value);

  // ------------------------------------------------------------
  // 5) 폴더블 fallback (표준 신호가 없을 때도 UX를 망치지 않기 위한 안전장치)
  // ------------------------------------------------------------
  /**
   * isWideTouch
   *   “터치인데 화면이 넓다” → 폴드 펼침/태블릿급 UX로 대응
   */
  const isWideTouch = computed(() => isTouchLike.value && width.value >= fold.wideTouchMinWidth);

  /**
   * shouldUseFoldableLayout
   * - 표준 신호(segments/spanning)가 있으면 우선 적용
   * - 없으면 wideTouch로 폴더블급 레이아웃을 켤지 결정
   */
  const shouldUseFoldableLayout = computed(() => {
    const hasSegments = (viewportSegments.value?.length ?? 0) >= 2;
    return hasSegments || isSpanning.value || isWideTouch.value;
  });

  const isFoldLikeOpen = computed(() => shouldUseFoldableLayout.value && isWideTouch.value);

  /**
   * useTwoPane
   * - 폴더블/넓은 터치 화면에서 좌/우 2-pane UI를 켜는 최종 스위치
   */
  const useTwoPane = computed(() => {
    return shouldUseFoldableLayout.value && width.value >= fold.twoPaneMinWidth;
  });

  // ------------------------------------------------------------
  // 6) 화면에서 자주 쓰는 파생 값 (편의)
  // ------------------------------------------------------------
  const enableHoverTooltip = isPC; // PC에서만 hover tooltip

  const cellRowHeight = computed(() => {
    if (isFoldLikeOpen.value) return 44;
    if (layoutMode.value === "compact") return 48;
    return 32;
  });

  // ------------------------------------------------------------
  // 7) 업데이트/리스너
  // ------------------------------------------------------------
  let rafId: number | null = null;
  const cleanups: Array<() => void> = [];

  const updateAll = () => {
    if (typeof window === "undefined") return;

    width.value = window.innerWidth;

    if (mqlCoarse) isTouchLike.value = mqlCoarse.matches;
    if (mqlHover) canHover.value = mqlHover.matches;
    if (mqlLandscape) isLandscape.value = mqlLandscape.matches;

    viewportSegments.value = getViewportSegments();
    updateSpanning();
  };

  const onResize = () => {
    if (rafId !== null) cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(() => {
      updateAll();
      rafId = null;
    });
  };

  onMounted(() => {
    if (typeof window === "undefined") return;

    updateAll();
    window.addEventListener("resize", onResize, { passive: true });

    const onMqlChange = () => updateAll();

    cleanups.push(addMqlListener(mqlCoarse, onMqlChange));
    cleanups.push(addMqlListener(mqlHover, onMqlChange));
    cleanups.push(addMqlListener(mqlLandscape, onMqlChange));
    cleanups.push(addMqlListener(mqlSpanningVertical, onMqlChange));
    cleanups.push(addMqlListener(mqlSpanningHorizontal, onMqlChange));
  });

  onBeforeUnmount(() => {
    if (typeof window === "undefined") return;

    window.removeEventListener("resize", onResize);
    cleanups.forEach((fn) => fn());
    if (rafId !== null) cancelAnimationFrame(rafId);
  });

  return {
    // PC / Mobile 감지
    isPC,
    isMobileFamily,

    // Fold 1화면/2화면 감지
    isTwoScreen,

    // base 분기
    deviceType,
    layoutMode,
    isMobile,
    isTablet,
    isDesktop,

    // viewport/capability
    width,
    isLandscape,
    isTouchLike,
    canHover,

    // fold signals
    viewportSegments,
    isSpanning,
    spanningDirection,

    // fold switches
    isWideTouch,
    shouldUseFoldableLayout,
    isFoldLikeOpen,
    useTwoPane,

    // common derived
    enableHoverTooltip,
    cellRowHeight,
  };
}