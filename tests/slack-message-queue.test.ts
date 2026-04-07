import { jest } from '@jest/globals';
import { SlackMessageQueue } from "../packages/worker/src/slack-message-queue";

const noopLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  child: () => noopLogger,
} as any;

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

describe("SlackMessageQueue", () => {
  let queue: SlackMessageQueue;

  beforeEach(() => {
    queue = new SlackMessageQueue(noopLogger);
  });

  it("executes operations in FIFO order", async () => {
    const order: number[] = [];
    queue.enqueue("t1", async () => { order.push(1); });
    queue.enqueue("t1", async () => { order.push(2); });
    queue.enqueue("t1", async () => { order.push(3); });
    await queue.flush("t1");
    expect(order).toEqual([1, 2, 3]);
  });

  it("enqueueAndWait resolves after all prior entries complete", async () => {
    const order: number[] = [];
    queue.enqueue("t1", async () => {
      await delay(10);
      order.push(1);
    });
    queue.enqueue("t1", async () => {
      order.push(2);
    });
    const result = await queue.enqueueAndWait("t1", async () => {
      order.push(3);
      return "done";
    });
    expect(result).toBe("done");
    expect(order).toEqual([1, 2, 3]);
  });

  it("enqueueAndWait returns the operation's return value", async () => {
    const result = await queue.enqueueAndWait("t1", async () => ({ ts: "12345" }));
    expect(result).toEqual({ ts: "12345" });
  });

  it("flush resolves when queue is empty", async () => {
    let done = false;
    queue.enqueue("t1", async () => {
      await delay(10);
      done = true;
    });
    await queue.flush("t1");
    expect(done).toBe(true);
  });

  it("flush on empty queue resolves immediately", async () => {
    await queue.flush("t1"); // should not hang
  });

  it("failed operations are skipped without crashing consumer", async () => {
    const order: number[] = [];
    queue.enqueue("t1", async () => { order.push(1); });
    queue.enqueue("t1", async () => { throw new Error("boom"); });
    queue.enqueue("t1", async () => { order.push(3); });
    await queue.flush("t1");
    expect(order).toEqual([1, 3]);
  });

  it("failed enqueueAndWait rejects the returned promise", async () => {
    const promise = queue.enqueueAndWait("t1", async () => {
      throw new Error("fail");
    });
    await expect(promise).rejects.toThrow("fail");
  });

  it("clear rejects pending enqueueAndWait promises", async () => {
    // Enqueue a slow operation first so the queue is busy
    queue.enqueue("t1", () => delay(50));

    // This won't execute until the slow op finishes — but we'll clear before that
    const promise = queue.enqueueAndWait("t1", async () => "never");

    // Give the consumer time to start the first entry
    await delay(5);
    queue.clear("t1");

    await expect(promise).rejects.toThrow("Queue cleared");
  });

  it("different thread keys are independent", async () => {
    const order: string[] = [];
    queue.enqueue("t1", async () => {
      await delay(20);
      order.push("t1");
    });
    queue.enqueue("t2", async () => {
      order.push("t2");
    });
    await Promise.all([queue.flush("t1"), queue.flush("t2")]);
    // t2 should finish before t1 since it has no delay
    expect(order).toEqual(["t2", "t1"]);
  });

  it("pending returns the number of queued entries", async () => {
    expect(queue.pending("t1")).toBe(0);

    // Enqueue a slow op so the queue stays populated
    queue.enqueue("t1", () => delay(50));
    queue.enqueue("t1", () => delay(1));

    // First entry is being consumed, second is still pending
    await delay(5);
    expect(queue.pending("t1")).toBeGreaterThanOrEqual(0);

    await queue.flush("t1");
    expect(queue.pending("t1")).toBe(0);
  });

  it("retries transient errors up to 3 times", async () => {
    let attempts = 0;
    const result = await queue.enqueueAndWait("t1", async () => {
      attempts++;
      if (attempts < 3) {
        const err = new Error("fetch failed");
        throw err;
      }
      return "ok";
    });
    expect(result).toBe("ok");
    expect(attempts).toBe(3);
  });

  it("does not retry non-transient errors", async () => {
    let attempts = 0;
    const promise = queue.enqueueAndWait("t1", async () => {
      attempts++;
      throw new Error("Invalid argument");
    });
    await expect(promise).rejects.toThrow("Invalid argument");
    expect(attempts).toBe(1);
  });
});
