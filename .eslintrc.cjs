module.exports = {
    root          : true,
    env           : {
        node                       : true,
        'vue/setup-compiler-macros': true,
    },
    parserOptions : {
        parser             : "@typescript-eslint/parser",
        ecmaVersion        : 'latest',
        sourceType         : 'module',
        extraFileExtensions: [".vue"],
    },
    plugins       : ['prettier'],
    extends       : ['plugin:vue/vue3-recommended', 'eslint:recommended', 'prettier'],
    // 빌드·테스트 산출물 제외 — playwright-report/test-results 는 e2e 를 한 번만 돌려도 생기며,
    // 번들된 벤더 js 가 들어 있어 검사하면 lint 가 통째로 깨진다.
    ignorePatterns: ['dist', '*.d.ts', 'playwright-report', 'test-results', 'coverage'],
    rules         : {
        'no-unused-vars': ['error', {argsIgnorePattern: '^_'}],
    },
};
