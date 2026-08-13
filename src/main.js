import {createApp} from 'vue';
import {createPinia} from 'pinia';
import {createRouter, createWebHistory} from 'vue-router';
import {createI18n} from 'vue-i18n';
import {createBootstrap} from 'bootstrap-vue-next';
import {createNotivue} from 'notivue';
import {PerfectScrollbarPlugin} from 'vue3-perfect-scrollbar';
import dayjs from 'dayjs';
import 'dayjs/locale/ko';

// ── 서드파티 CSS (로드 순서 = cascade 순서 / styles.scss 보다 먼저) ──
// 컴포넌트 라이브러리 CSS 는 JS import 로 유지(scss 로 옮기면 소비 청크에 중복 번들됨)
import 'bootstrap/dist/css/bootstrap.min.css';
import '@vuepic/vue-datepicker/dist/main.css';
import 'notivue/notification.css';
import 'notivue/animations.css';
import './scss/vendors.scss'; // 나머지 vendor CSS(icons·bvn)
// ── 앱 자체(전역) 스타일 (테마 토큰 + notivue 테마 포함) ──
import './scss/styles.scss';

import App from './App.vue';
import messages from './messages';
import routes from './pages';

dayjs.locale('ko');

const router = createRouter({
    history: createWebHistory(),
    routes,
});

const i18n = createI18n({
    legacy        : false,
    locale        : 'ko',
    fallbackLocale: 'ko',
    messages,
});

const notivue = createNotivue({
    position    : 'bottom-center',
    limit       : 3,
    pauseOnHover: false,
    pauseOnTouch: false,

    // 타입별 duration (ms)
    notifications: {
        success: {duration: 5000},
        error  : {duration: 8000},
        warning: {duration: 3000},
        info   : {duration: 3000},
    },
});

const app = createApp(App);

app.use(createPinia())
    .use(router)
    .use(i18n)
    .use(createBootstrap())
    .use(PerfectScrollbarPlugin)
    .use(notivue);

// 로컬 데이터 저장소(브라우저)를 axios adapter 로 설치한 뒤 마운트한다.
// mount 전에 설치해야 첫 조회(searchVersion watch)가 네트워크로 새지 않는다.
(async () => {
    const {installMockAdapter} = await import('./mocks');
    installMockAdapter();
    app.mount('#app');
})();
