/**
 * Electron: always embed backend with auto free port; load UI on dynamic URL.
 */
/* eslint-disable no-console */
process.on('unhandledRejection', (reason) => console.error('[TMessing main] unhandledRejection', reason));
process.on('uncaughtException', (err) => console.error('[TMessing main] uncaughtException', err));

const { app, BrowserWindow, Notification, ipcMain } = require('electron');
const path = require('path');

process.env.TMESSING_USER_DATA = app.getPath('userData');
process.env.TMESSING_AUTO_PORT = '1';

const { start } = require(path.join(__dirname, '..', 'server', 'index.js'));

let mainWindow;
/** @type {number | null} */
let serverPort = null;

function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 560,
    backgroundColor: '#0e1621',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadURL(`http://127.0.0.1:${port}/`);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  try {
    const { port } = await start();
    serverPort = port;
    createWindow(port);
  } catch (e) {
    console.error('Failed to start TMessing server', e);
    app.quit();
    return;
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && serverPort != null) {
      createWindow(serverPort);
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

ipcMain.handle('notify', (event, { title, body }) => {
  if (Notification.isSupported()) {
    new Notification({ title: title || 'TMessing', body: body || '' }).show();
  }
});
