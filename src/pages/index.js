/** @type { import('vue-router').RouterOptions['routes'] } */

const routes = [
    {
        path    : '/',
        redirect: (to) => ({
            path : '/book',
            query: to.query,
        }),
    },
    // 예약 스케줄러 메인 화면
    {
        path     : '/book',
        name     : 'ScheduleView',
        component: () => import('@/pages/desktop/scheduler-v3/SchedulerV3Page.vue'),
    },
];

export default routes;
