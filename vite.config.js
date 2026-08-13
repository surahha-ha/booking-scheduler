import {resolve} from 'node:path';
import {defineConfig} from 'vite';
import vue from '@vitejs/plugin-vue';
import Components from 'unplugin-vue-components/vite';
import {BootstrapVueNextResolver} from 'bootstrap-vue-next';

// https://vitejs.dev/config/
export default defineConfig({
    plugins     : [
        vue(),
        Components({
            resolvers: [BootstrapVueNextResolver()],
        }),
    ],
    resolve     : {
        alias: [
            {find: '@', replacement: resolve(__dirname, 'src')},
        ],
    },
    optimizeDeps: {
        include: ['@vuepic/vue-datepicker'],
    },
    test        : {
        // Playwright e2e(tests/e2e/**)는 Vitest 대상에서 제외
        exclude: ['**/node_modules/**', '**/dist/**', '**/tests/e2e/**'],
    },
    server      : {
        host      : 'localhost',
        port      : 5180,
        strictPort: true,
    },
});
