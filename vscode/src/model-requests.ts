import { CopilotRequestHandler, CopilotWebSocketHandler, CopilotWebSocketCloseStatus, type CopilotRequestContext } from '@github/copilot-sdk'
import WebSocket from 'ws'

export interface ModelRequestOwner {
  signal: AbortSignal
  assertCurrent(): void
  instructions?: { nonce: string; current(): string; bound(): void }
}

export function instructionBlock(nonce: string, content: string): string {
  if (!/^[a-f0-9-]{16,}$/.test(nonce)) throw new Error('Invalid instruction identity')
  return `<superagent-${nonce}>${content}</superagent-${nonce}>`
}

/** Only trusted system fields are changed; source/user messages can never supply host instructions. */
export function bindInstructions(body: Record<string, unknown>, nonce: string, content: string, child: boolean): void {
  const start = `<superagent-${nonce}>`, end = `</superagent-${nonce}>`
  const block = instructionBlock(nonce, content)
  const fields: { value: string; set(value: string): void }[] = []
  if (typeof body.instructions === 'string') fields.push({ value: body.instructions, set: value => { body.instructions = value } })
  else if (Array.isArray(body.messages)) for (const item of body.messages) {
    if (item?.role !== 'system' && item?.role !== 'developer') continue
    if (typeof item.content !== 'string') throw new Error('Unsupported model instruction encoding')
    fields.push({ value: item.content, set: value => { item.content = value } })
  }
  if (!fields.length) throw new Error('Unsupported model request format')
  let count = 0
  for (const field of fields) {
    const first = field.value.indexOf(start), last = field.value.indexOf(end, first + start.length)
    if (first < 0) { if (field.value.includes(end)) throw new Error('Ambiguous model instruction identity'); continue }
    if (last < 0 || field.value.indexOf(end, last + end.length) >= 0 || field.value.indexOf(start, first + start.length) >= 0 || ++count > 1) throw new Error('Ambiguous model instruction identity')
    field.set(field.value.slice(0, first) + block + field.value.slice(last + end.length))
  }
  if (!count) {
    if (!child) throw new Error('Worker model request lost its host instructions')
    fields[0]!.set(fields[0]!.value + '\n' + block)
  }
}

/** SDK transforms are cached. Bind current instructions at the actual HTTP or WebSocket model request. */
export class WorkerModelRequests extends CopilotRequestHandler {
  constructor(private readonly resolve: (context: CopilotRequestContext) => ModelRequestOwner) { super() }

  rewrite(body: Record<string, unknown>, context: CopilotRequestContext): ModelRequestOwner {
    const owner = this.resolve(context)
    owner.assertCurrent(); owner.signal.throwIfAborted(); context.signal.throwIfAborted()
    if (owner.instructions) {
      const child = !!context.agentId && context.agentId !== context.sessionId
      if (child && (!context.parentAgentId || context.interactionType !== 'conversation-subagent')) throw new Error('Unknown native agent ownership')
      bindInstructions(body, owner.instructions.nonce, owner.instructions.current(), child)
      owner.instructions.bound()
    }
    owner.assertCurrent()
    return owner
  }

  protected override async sendRequest(request: Request, context: CopilotRequestContext): Promise<Response> {
    const body: unknown = await request.clone().json()
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid model request')
    const owner = this.rewrite(body as Record<string, unknown>, context)
    const headers = new Headers(request.headers); headers.delete('content-length')
    return super.sendRequest(new Request(request, { headers, body: JSON.stringify(body), signal: AbortSignal.any([request.signal, context.signal, owner.signal]) }), context)
  }

  protected override async openWebSocket(context: CopilotRequestContext): Promise<CopilotWebSocketHandler> {
    const owner = this.resolve(context)
    owner.assertCurrent(); owner.signal.throwIfAborted()
    return await new AuthenticatedModelSocket(context, (body, current) => this.rewrite(body, current), owner.signal).open()
  }
}

/** The SDK's default forwarder omits handshake headers. Preserve them, forbid redirects, and bound connection setup. */
class AuthenticatedModelSocket extends CopilotWebSocketHandler {
  private readonly socket: WebSocket
  private readonly ready: Promise<void>
  private readonly abort: () => void
  private closed = false
  constructor(context: CopilotRequestContext, private readonly rewrite: (body: Record<string, unknown>, context: CopilotRequestContext) => ModelRequestOwner, private readonly signal: AbortSignal) {
    super(context)
    const headers = Object.fromEntries(Object.entries(context.headers).filter((entry): entry is [string, string[]] => !!entry[1]))
    try { this.socket = new WebSocket(context.url, { headers, followRedirects: false, handshakeTimeout: 10_000, maxPayload: 16 * 1024 * 1024 }) }
    catch { throw new Error('Invalid model WebSocket endpoint') }
    this.ready = new Promise((resolve, reject) => {
      this.socket.once('open', resolve)
      this.socket.once('error', () => reject(new Error('Model WebSocket connection failed')))
      this.socket.once('close', () => reject(new Error('Model WebSocket closed during connection')))
    })
    this.socket.on('message', (bytes, binary) => {
      void this.sendResponseMessage(binary ? new Uint8Array(Buffer.from(bytes as Buffer)) : bytes.toString()).catch(() => { void this.close().catch(() => {}) })
    })
    this.socket.on('close', () => { void this.close().catch(() => {}) })
    this.socket.on('error', () => { void this.close(new CopilotWebSocketCloseStatus('Model WebSocket connection failed', undefined, new Error('Model connection failed'))).catch(() => {}) })
    this.abort = () => { void this.close(new CopilotWebSocketCloseStatus('Ticket authority ended', undefined, new Error('Cancelled'))).catch(() => {}) }
    signal.addEventListener('abort', this.abort, { once: true })
    context.signal.addEventListener('abort', this.abort, { once: true })
    if (signal.aborted || context.signal.aborted) this.abort()
  }
  async open(): Promise<this> { await this.ready; this.signal.throwIfAborted(); this.context.signal.throwIfAborted(); return this }
  override async sendRequestMessage(data: string | Uint8Array, context = this.context): Promise<void> {
    const text = typeof data === 'string' ? data : new TextDecoder('utf-8', { fatal: true }).decode(data)
    const body: unknown = JSON.parse(text)
    if (!body || typeof body !== 'object' || Array.isArray(body) || !('type' in body) || body.type !== 'response.create') throw new Error('Unsupported model WebSocket frame')
    const owner = this.rewrite(body as Record<string, unknown>, context)
    await this.ready
    owner.assertCurrent(); owner.signal.throwIfAborted(); context.signal.throwIfAborted()
    if (this.socket.readyState !== WebSocket.OPEN) throw new Error('Model WebSocket is closed')
    await new Promise<void>((resolve, reject) => this.socket.send(JSON.stringify(body), error => error ? reject(new Error('Model WebSocket send failed')) : resolve()))
  }
  override async close(status = CopilotWebSocketCloseStatus.normalClosure): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.signal.removeEventListener('abort', this.abort); this.context.signal.removeEventListener('abort', this.abort)
    this.socket.terminate()
    await super.close(status)
  }
  override async [Symbol.asyncDispose](): Promise<void> { await this.close(); await super[Symbol.asyncDispose]() }
}
