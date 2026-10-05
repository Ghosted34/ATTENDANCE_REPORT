const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("bridge", {
  onStatus: (cb) => ipcRenderer.on("splash:status", (_e, d) => cb(d)),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  saveSettings: (v) => ipcRenderer.invoke("settings:save", v),
});
