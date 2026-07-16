import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { autoUpdater } from 'electron-updater';
import { initDb, closeDb } from './db';
import { registerIpc } from './ipc';

process.env.APP_ROOT = path.join(__dirname, '..');
const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;
const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist');

let win: BrowserWindow | null = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 980,
    minHeight: 680,
    title: '지식인 헬퍼',
    backgroundColor: '#FFFFFF',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL);
  } else {
    win.loadFile(path.join(RENDERER_DIST, 'index.html'));
  }
}

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    initDb();
    registerIpc(ipcMain);
    createWindow();

    // 자동 업데이트: GitHub 릴리즈에서 새 버전 확인 → 자동 다운로드, 종료 시 설치
    // (개발 모드에서는 동작하지 않고, 패키징된 앱에서만 작동)
    if (app.isPackaged) {
      autoUpdater.autoDownload = true;
      autoUpdater.checkForUpdatesAndNotify().catch(() => {
        // 네트워크/피드 문제는 조용히 무시 (앱 사용은 계속 가능)
      });
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('before-quit', () => {
  closeDb();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
  win = null;
});
