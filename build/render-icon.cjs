// Renders build/icon.svg to a 1024px PNG with Electron (transparent corners), for the .icns and dock icon.
const { app, BrowserWindow } = require('electron')
const { readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  const svg = readFileSync(join(__dirname, 'icon.svg'), 'utf8')
  const w = new BrowserWindow({ width: 1024, height: 1024, show: false, transparent: true, frame: false, useContentSize: true, webPreferences: { offscreen: true, zoomFactor: 1 } })
  await w.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`)}`)
  await new Promise((r) => setTimeout(r, 400))
  const img = await w.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 })
  writeFileSync(join(__dirname, 'icon.png'), img.resize({ width: 1024, height: 1024 }).toPNG())
  app.quit()
})
