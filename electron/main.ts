import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import path from 'node:path';
import { autoUpdater } from 'electron-updater';
import { initDb, closeDb } from './db';
import { registerIpc } from './ipc';

process.env.APP_ROOT = path.join(__dirname, '..');
const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;
const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist');

let win: BrowserWindow | null = null;

// 백그라운드에서 발생한 예외로 앱이 죽어(치명적 다이얼로그) 실행 자체가 막히는 것을 방지.
// 로그만 남기고 앱은 계속 동작하게 한다.
process.on('uncaughtException', (err) => {
  console.error('[main] uncaughtException:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[main] unhandledRejection:', reason);
});

function alive(w: BrowserWindow | null): w is BrowserWindow {
  return !!w && !w.isDestroyed();
}

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

// 자동 업데이트: 다운로드 완료되면 "지금 업데이트할까요?" 물어봄
function setupAutoUpdate() {
  if (!app.isPackaged) return; // 개발 모드에서는 동작 안 함
  try {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on('update-downloaded', async (info) => {
      if (!alive(win)) return;
      try {
        const { response } = await dialog.showMessageBox(win, {
          type: 'info',
          buttons: ['지금 설치하고 재시작', '나중에'],
          defaultId: 0,
          cancelId: 1,
          title: '업데이트',
          message: `새 버전(${info.version})이 준비됐습니다.`,
          detail:
            '지금 설치하고 재시작할까요?\n"나중에"를 선택하면 다음에 앱을 종료할 때 자동으로 설치됩니다.',
        });
        if (response === 0) {
          setImmediate(() => autoUpdater.quitAndInstall());
        }
      } catch (e) {
        console.error('[updater] dialog error:', e);
      }
    });

    // 업데이트 확인/다운로드 실패는 앱 사용에 지장 없도록 조용히 무시
    autoUpdater.on('error', (e) => {
      console.error('[updater] error:', e);
    });

    autoUpdater.checkForUpdates().catch((e) => console.error('[updater] check failed:', e));
  } catch (e) {
    console.error('[updater] setup failed:', e);
  }
}

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // 파괴된 창을 건드리면 "Object has been destroyed"로 크래시하므로 반드시 살아있는지 확인
    if (alive(win)) {
      if (win.isMinimized()) win.restore();
      win.focus();
    } else {
      createWindow();
    }
  });

  app.whenReady().then(() => {
    // IPC 핸들러는 DB 상태와 무관하게 항상 먼저 등록한다.
    // (initDb 실패로 등록이 건너뛰어지면 'No handler registered' 오류로 모든 버튼이 죽음)
    try {
      registerIpc(ipcMain);
    } catch (e) {
      console.error('[main] registerIpc error:', e);
    }
    try {
      initDb();
    } catch (e) {
      console.error('[main] initDb error:', e);
    }
    createWindow();
    setupAutoUpdate();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('before-quit', () => {
  try {
    closeDb();
  } catch (e) {
    console.error('[main] closeDb error:', e);
  }
});

app.on('window-all-closed', () => {
  win = null;
  if (process.platform !== 'darwin') app.quit();
});
