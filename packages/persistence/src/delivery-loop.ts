// packages/persistence/src/delivery-loop.ts
import type { QueueName } from '@buddy/shared';
import type { RpcServer } from '@buddy/shared';
import type { QueueService } from './queue-service.js';

export interface DeliveryLoopOptions {
  queue: QueueName;
  threadKey?: string;          // undefined = all threads (outbound)
  clientId: string;
  server: RpcServer;
  queueService: QueueService;
  onError?: (err: Error) => void;
}

export class DeliveryLoop {
  private running = false;
  private wakeResolve: (() => void) | null = null;
  private woken = false;  // Flag to catch wake signals before we park

  readonly clientId: string;

  constructor(private options: DeliveryLoopOptions) {
    this.clientId = options.clientId;
  }

  /** Start the delivery loop. Runs until stop() is called. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.run().catch((err) => {
      this.options.onError?.(err instanceof Error ? err : new Error(String(err)));
    });
  }

  /** Stop the delivery loop. */
  stop(): void {
    this.running = false;
    // Wake the loop so it can exit
    this.woken = true;
    if (this.wakeResolve) {
      this.wakeResolve();
      this.wakeResolve = null;
    }
  }

  /**
   * Wake the loop to check for new messages.
   * Safe to call at any time — if the loop hasn't parked yet,
   * the `woken` flag ensures the signal isn't lost.
   */
  wake(): void {
    this.woken = true;
    if (this.wakeResolve) {
      this.wakeResolve();
      this.wakeResolve = null;
    }
  }

  private async run(): Promise<void> {
    const { queue, threadKey, clientId, server, queueService } = this.options;

    while (this.running) {
      // 1. Get next pending message
      const msg = threadKey
        ? queueService.nextPending(queue, threadKey)
        : queueService.nextPendingAny(queue);

      if (!msg) {
        // Check if wake() was called before we got here (atomicity guard)
        if (this.woken) {
          this.woken = false;
          continue;
        }
        // Park — wait for wake signal
        await new Promise<void>((resolve) => {
          this.wakeResolve = resolve;
        });
        this.woken = false;
        continue;
      }

      // 2. Mark as delivered BEFORE pushing — prevents race where a nack
      //    resets to pending but markDelivered overwrites it back to delivered
      queueService.markDelivered(msg.id);

      // 3. Push to subscriber via reverse RPC
      try {
        const result = await server.callClient(clientId, 'deliver.message', {
          message: msg,
        }, 30_000) as { accepted: boolean };

        if (!result.accepted) {
          // Consumer rejected — back off briefly then retry
          await this.sleep(1000);
        }
      } catch {
        // Distinguish transient errors from permanent disconnects:
        // If the client socket is still connected, this was a transient
        // timeout — back off and retry. If the socket is gone, the client
        // disconnected — stop the loop (onDisconnect handler cleans up).
        const stillConnected = server.getClient(clientId);
        if (stillConnected) {
          await this.sleep(2000);
        } else {
          this.running = false;
        }
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}
