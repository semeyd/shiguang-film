const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('photobookApi', {
  chooseDirectory: () => ipcRenderer.invoke('book:choose-directory'),
  create: (value) => ipcRenderer.invoke('book:create', value),
  defaultAlbum: () => ipcRenderer.invoke('book:default-album'),
  openDialog: () => ipcRenderer.invoke('book:open-dialog'),
  openPath: (value) => ipcRenderer.invoke('book:open-path', value),
  recent: () => ipcRenderer.invoke('book:recent'),
  importPhotos: () => ipcRenderer.invoke('book:import'),
  save: (value) => ipcRenderer.invoke('book:save', value),
  discardPhoto: (file) => ipcRenderer.invoke('book:discard-photo', file),
  writePage: (value) => ipcRenderer.invoke('book:write-page', value),
  writeThumbnail: (value) => ipcRenderer.invoke('book:write-thumbnail', value),
  fullscreen: () => ipcRenderer.invoke('window:fullscreen'),
});
