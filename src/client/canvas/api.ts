/** The browser's view of the canvases folder: one store for the panel. */

import { CANVAS_METHOD, type CanvasKind, type CanvasList, type CanvasRequest, type CanvasSource } from '../../canvas/types.ts'
import { rpcValue, type Rpc } from '../rpc.ts'

export type CanvasCall = (payload: CanvasRequest) => Promise<unknown>

export function canvasCall(rpc: Rpc): CanvasCall {
  return (payload) => rpcValue(rpc, CANVAS_METHOD, payload, 'agent-hub canvas RPC failed')
}

export interface CanvasSnapshot {
  /** Undefined until the first read. */
  list: CanvasList | undefined
  error: string | null
}

export class CanvasStore {
  private snapshot: CanvasSnapshot = { list: undefined, error: null }
  private readonly listeners = new Set<() => void>()
  private readonly call: CanvasCall

  constructor(call: CanvasCall) {
    this.call = call
  }

  getSnapshot = (): CanvasSnapshot => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private publish(next: CanvasSnapshot): void {
    this.snapshot = next
    for (const listener of this.listeners) listener()
  }

  async load(): Promise<void> {
    try {
      this.publish({ list: await this.call({ op: 'list' }) as CanvasList, error: null })
    } catch (error) {
      this.publish({ ...this.snapshot, error: (error as Error).message })
    }
  }

  read(name: string, kind: CanvasKind = 'canvas'): Promise<string> {
    return this.call({ op: 'read', name, kind }) as Promise<string>
  }

  /** The session that wrote a canvas, or null. */
  source(name: string): Promise<CanvasSource | null> {
    return this.call({ op: 'source', name }) as Promise<CanvasSource | null>
  }

  async remove(name: string, kind: CanvasKind = 'canvas'): Promise<void> {
    this.publish({ list: await this.call({ op: 'remove', name, kind }) as CanvasList, error: null })
  }
}
