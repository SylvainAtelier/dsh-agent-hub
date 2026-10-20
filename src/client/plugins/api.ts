import {
  PLUGIN_UPDATES_METHOD,
  type UpdateRequest,
  type UpdateStatus,
} from "../../plugins/types.ts";
import { rpcValue, type Rpc } from "../rpc.ts";

export interface PluginUpdatesSnapshot {
  status?: UpdateStatus;
  loading: boolean;
  error?: string;
}
export class PluginUpdatesStore {
  private snapshot: PluginUpdatesSnapshot = { loading: false };
  private listeners = new Set<() => void>();
  private timer?: ReturnType<typeof setTimeout>;
  private controller?: AbortController;
  private disposed = false;
  private generation = 0;
  private readonly rpc: Rpc;
  constructor(rpc: Rpc) {
    this.rpc = rpc;
  }
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = (): PluginUpdatesSnapshot => this.snapshot;
  private publish(next: PluginUpdatesSnapshot): void {
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
  load = (): Promise<void> => this.run({ op: "status" });
  async run(request: UpdateRequest): Promise<void> {
    if (this.disposed || this.snapshot.loading) return;
    clearTimeout(this.timer);
    const generation = ++this.generation;
    this.controller = new AbortController();
    this.publish({ ...this.snapshot, loading: true, error: undefined });
    try {
      const status = await rpcValue<UpdateStatus>(
        this.rpc,
        PLUGIN_UPDATES_METHOD,
        request,
        "Plugin update request failed",
        this.controller.signal,
      );
      if (this.disposed || generation !== this.generation) return;
      this.publish({ status, loading: false });
      if (status.busy)
        this.timer = setTimeout(() => {
          void this.load();
        }, 900);
    } catch (error) {
      if (!this.disposed && generation === this.generation) {
        this.publish({
          ...this.snapshot,
          loading: false,
          error: error instanceof Error ? error.message : String(error),
        });
        // The first reply can be lost after the server accepted an operation.
        // Recover with a status read, never by submitting the operation again.
        if (this.snapshot.status?.busy || request.op !== "status")
          this.timer = setTimeout(() => {
            void this.load();
          }, 2500);
      }
    }
  }
  dispose(): void {
    this.disposed = true;
    this.generation++;
    clearTimeout(this.timer);
    this.controller?.abort();
    this.listeners.clear();
  }
}
