/**
 * 예약의 통합회원 판정 — 카드의 회원 뱃지(bookStore uiJoin)와 회원 숫자(boardStatistics)가 같은 규칙을 쓴다.
 * 회원번호(memberNo)가 있거나 여부(memberYn)가 Y 면 회원. 한쪽만 보면 같은 화면에서 뱃지는 회원인데
 * 숫자에서는 비회원이 되는 예약이 생긴다(회원번호만 있고 여부가 N 인 건).
 */
export function isIntegratedMember(appt: { memberNo?: number | null; memberYn?: string | null }): boolean {
    return !!appt.memberNo || appt.memberYn === 'Y';
}
