const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('wallHost', {
  newWindow: (preset) => ipcRenderer.invoke('wall:new-window', preset),
  allDisplays: () => ipcRenderer.invoke('wall:all-displays'),
  setLink: (link) => ipcRenderer.invoke('wall:set-link', link),
});
