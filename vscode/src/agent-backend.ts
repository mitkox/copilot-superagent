import type { AssessmentOutcome } from '../../src/core/index.ts'

export interface AgentTool {
  name: string
  description: string
  schema: Record<string, unknown>
  invoke(args: unknown): Promise<unknown>
}

export interface AgentEvent { type: string; text: string; at: string }

export interface AgentRun {
  ticketId: string
  sessionId: string
  directory: string
  prompt: string
  systemPrompt: string
  model?: string
  assertAuthorized?(): void
  currentSystemPrompt?(): { text: string; revision: number }
  onPromptApplied?(revision: number): void
  onConsumed?(): void
  tools: AgentTool[]
  signal: AbortSignal
  onEvent(event: AgentEvent): void
}

export type RouterOutcome = AssessmentOutcome
  | { kind: 'attach'; ticketId: string; note?: string; reason: string }
  | { kind: 'status'; ticketId: string; reason: string }
  | { kind: 'note'; ticketId: string; text: string; reason: string }

export interface AgentSteer {
  ticketId: string
  requestId: string
  prompt: string
  signal: AbortSignal
  onAccepted(): void
  onConsumed(): void
}

export interface AgentBackend {
  run(input: AgentRun): Promise<void>
  assess(prompt: string, signal: AbortSignal, model?: string, contextTools?: AgentTool[]): Promise<RouterOutcome>
  steer?(input: AgentSteer): Promise<void>
  handoff?(ticketId: string): void
  abort(ticketId: string): Promise<void>
  dispose(): Promise<void>
}
