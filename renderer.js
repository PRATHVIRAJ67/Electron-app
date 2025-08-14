const { ipcRenderer } = require('electron');

const statusDiv = document.getElementById('status');

ipcRenderer.on('status-update', (event, message) => {
  const timestamp = new Date().toLocaleTimeString();
  statusDiv.textContent = `[${timestamp}] ${message}`;
});
