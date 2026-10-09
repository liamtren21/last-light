import {defineConfig} from '@playwright/test';
// Keyboard fixtures intercept every API request; no API/DB/provider process.
export default defineConfig({
 testDir:'./tests/e2e',testMatch:'mobile-keyboard.spec.ts',workers:1,outputDir:'verification/runtime/keyboard-test-results',
 use:{baseURL:'http://127.0.0.1:4338',screenshot:'only-on-failure'},
 webServer:{command:'npx vite --host 127.0.0.1 --port 4338 --strictPort',url:'http://127.0.0.1:4338',reuseExistingServer:true},
});
