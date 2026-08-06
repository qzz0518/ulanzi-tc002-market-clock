import { describe, expect, test } from "bun:test";
import { createLatestTaskRunner } from "../web/src/lib/latest-task-runner";

describe("latest task runner", () => {
  test("serializes work, drops an obsolete pending task, and applies only the latest result", async () => {
    const started: number[] = [];
    const applied: Array<[number, string]> = [];
    const busy: boolean[] = [];
    const resolve = new Map<number, (value: string) => void>();
    const runner = createLatestTaskRunner<number, string>({
      execute(input) {
        started.push(input);
        return new Promise<string>((done) => { resolve.set(input, done); });
      },
      apply(value, input) { applied.push([input, value]); },
      onBusyChange(value) { busy.push(value); },
    });

    const first = runner.enqueue(1);
    const second = runner.enqueue(2);
    const third = runner.enqueue(3);
    expect(started).toEqual([1]);

    resolve.get(1)!("one");
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toEqual([1, 3]);
    expect(applied).toEqual([]);

    resolve.get(3)!("three");
    expect(await first).toBe("superseded");
    expect(await second).toBe("superseded");
    expect(await third).toBe("applied");
    expect(applied).toEqual([[3, "three"]]);
    expect(busy).toEqual([true, false]);
  });

  test("recovers after the latest task fails and can apply a later task", async () => {
    const applied: Array<[number, string]> = [];
    const errors: Array<[number, string]> = [];
    const busy: boolean[] = [];
    const runner = createLatestTaskRunner<number, string>({
      async execute(input) {
        if (input === 1) {
          throw new Error("preview timed out");
        }
        return `result-${input}`;
      },
      apply(value, input) { applied.push([input, value]); },
      onError(error, input) {
        errors.push([input, error instanceof Error ? error.message : String(error)]);
      },
      onBusyChange(value) { busy.push(value); },
    });

    expect(await runner.enqueue(1)).toBe("failed");
    expect(await runner.enqueue(2)).toBe("applied");
    expect(errors).toEqual([[1, "preview timed out"]]);
    expect(applied).toEqual([[2, "result-2"]]);
    expect(busy).toEqual([true, false, true, false]);
  });
});
