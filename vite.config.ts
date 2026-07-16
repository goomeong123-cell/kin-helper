import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import electron from 'vite-plugin-electron/simple';

// 첫 빌드에만 Electron을 띄우고, 이후 main 변경 시엔 재시작 안 함 (DB 락 경합 방지)
let started = false;

export default defineConfig({
  plugins: [
    react(),
    electron({
      main: {
        entry: 'electron/main.ts',
        onstart({ startup }) {
          if (!started) {
            started = true;
            startup();
          }
        },
        vite: {
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              external: ['node-sqlite3-wasm', 'electron', 'electron-updater'],
            },
          },
        },
      },
      preload: {
        input: 'electron/preload.ts',
        vite: {
          build: {
            outDir: 'dist-electron',
          },
        },
      },
      renderer: {},
    }),
  ],
});
