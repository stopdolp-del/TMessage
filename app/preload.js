/**
 * Expose safe APIs to the renderer (no direct Node in UI).
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tmessing', {
  showNotification: (title, body) => ipcRenderer.invoke('notify', { title, body }),
});
