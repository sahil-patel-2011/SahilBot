import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron'
import { invoke, type RpcAdapter } from './rpc'

/**
 * Electron IPC as an RPC transport: every registered channel becomes an ipcMain.handle, and events go to
 * the web contents `targets()` returns (the main window). The handler's reply and errors travel exactly as
 * they did when handlers were registered on ipcMain directly.
 */
export function electronAdapter(ipc: Pick<IpcMain, 'handle' | 'removeHandler'>, targets: () => WebContents[]): RpcAdapter {
  return {
    onRegister(channel) {
      ipc.removeHandler(channel)
      ipc.handle(channel, (e: IpcMainInvokeEvent, ...args: unknown[]) => invoke(channel, { transport: 'electron', sender: e.sender, senderFrame: e.senderFrame }, args))
    },
    onUnregister(channel) {
      ipc.removeHandler(channel)
    },
    send(event, args) {
      for (const wc of targets()) if (!wc.isDestroyed()) wc.send(event, ...args)
    }
  }
}
