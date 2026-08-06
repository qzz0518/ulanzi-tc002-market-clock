export type LatestTaskOutcome = "applied" | "superseded" | "failed";

interface LatestTaskRunnerOptions<TInput, TOutput> {
  execute: (input: TInput) => Promise<TOutput>;
  apply: (value: TOutput, input: TInput) => void;
  onError?: (error: unknown, input: TInput) => void;
  onBusyChange?: (busy: boolean) => void;
}

interface QueuedTask<TInput> {
  id: number;
  input: TInput;
  resolve: (outcome: LatestTaskOutcome) => void;
}

export interface LatestTaskRunner<TInput> {
  enqueue: (input: TInput) => Promise<LatestTaskOutcome>;
  dispose: () => void;
}

/**
 * Runs at most one expensive task at a time. While a task is active, repeated
 * requests collapse into a single latest pending task. Results from superseded
 * tasks are ignored so stale previews can never replace the current selection.
 */
export function createLatestTaskRunner<TInput, TOutput>(
  options: LatestTaskRunnerOptions<TInput, TOutput>,
): LatestTaskRunner<TInput> {
  let sequence = 0;
  let active = false;
  let pending: QueuedTask<TInput> | null = null;
  let busy = false;
  let disposed = false;

  const setBusy = (next: boolean) => {
    if (busy === next) return;
    busy = next;
    options.onBusyChange?.(next);
  };

  const run = async (task: QueuedTask<TInput>): Promise<void> => {
    active = true;
    let outcome: LatestTaskOutcome = "superseded";
    try {
      const value = await options.execute(task.input);
      if (!disposed && task.id === sequence) {
        options.apply(value, task.input);
        outcome = "applied";
      }
    } catch (error) {
      if (!disposed && task.id === sequence) {
        outcome = "failed";
        try {
          options.onError?.(error, task.input);
        } catch {
          // Consumer error reporting must not leave the queue permanently busy.
        }
      }
    } finally {
      task.resolve(outcome);
      active = false;
      const next = pending;
      pending = null;
      if (next && !disposed) {
        void run(next);
      } else {
        if (next) next.resolve("superseded");
        setBusy(false);
      }
    }
  };

  return {
    enqueue(input) {
      if (disposed) return Promise.resolve("superseded");
      const id = ++sequence;
      return new Promise<LatestTaskOutcome>((resolve) => {
        const task = { id, input, resolve };
        if (active) {
          pending?.resolve("superseded");
          pending = task;
          return;
        }
        setBusy(true);
        void run(task);
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      sequence += 1;
      pending?.resolve("superseded");
      pending = null;
      setBusy(false);
    },
  };
}
