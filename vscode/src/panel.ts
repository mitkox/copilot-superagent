import { randomBytes } from 'node:crypto'
import * as vscode from 'vscode'
import { panelContent } from './panel-content.ts'

/** Native callbacks, never arbitrary commands supplied by a source or webview. */
export interface PanelHost {
  snapshot(): unknown
  action(message: Record<string, unknown>): Promise<void>
}

export class SuperagentPanel implements vscode.Disposable {
  private panel?: vscode.WebviewPanel
  constructor(private readonly host: PanelHost) {}
  show(): void {
    if (this.panel) { this.panel.reveal(); this.refresh(); return }
    const panel = this.panel = vscode.window.createWebviewPanel('superagent.supervision', 'Superagent', vscode.ViewColumn.One,
      { enableScripts: true, localResourceRoots: [], retainContextWhenHidden: true })
    panel.webview.html = panelContent(randomBytes(24).toString('base64url'))
    panel.onDidDispose(() => { this.panel = undefined })
    panel.webview.onDidReceiveMessage(async (message: unknown) => {
      if (!message || typeof message !== 'object' || Array.isArray(message)) return
      const request = message as Record<string, unknown>
      const saving = request.action === 'saveSettings' && Number.isSafeInteger(request.requestId)
      try {
        await this.host.action(request)
        if (saving) {
          const snapshot = this.host.snapshot() as { settings?: { revision?: number } }
          await panel.webview.postMessage({ type: 'saveSettingsResult', requestId: request.requestId, success: true, revision: snapshot.settings?.revision })
        }
        this.refresh()
      } catch {
        if (saving) await panel.webview.postMessage({ type: 'saveSettingsResult', requestId: request.requestId, success: false })
        await panel.webview.postMessage({ type: 'notice', text: 'Operation failed. Check policy, credentials and the service health before retrying.' })
      }
    })
  }
  refresh(): void { if (this.panel) void this.panel.webview.postMessage({ type: 'state', value: this.host.snapshot() }) }
  dispose(): void { this.panel?.dispose(); this.panel = undefined }
}
