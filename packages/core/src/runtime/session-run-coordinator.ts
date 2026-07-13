/**
 * Coordinator to manage run and wake cycles for a session with lane coalescing.
 */
export class SessionRunCoordinator {
  private runExecutor: (signal: AbortSignal) => Promise<void> | void;
  private wakeExecutor: (signal: AbortSignal) => Promise<void> | void;

  private activeType: 'run' | 'wake' | null = null;
  private activeController: AbortController | null = null;

  private hasPendingRun = false;
  private hasPendingWake = false;
  private isStartingNext = false;

  private runDeferreds: { resolve: () => void; reject: (err: any) => void; promise: Promise<void> }[] = [];
  private wakeDeferreds: { resolve: () => void; reject: (err: any) => void; promise: Promise<void> }[] = [];

  constructor(
    runExecutor: (signal: AbortSignal) => Promise<void> | void,
    wakeExecutor: (signal: AbortSignal) => Promise<void> | void
  ) {
    this.runExecutor = runExecutor;
    this.wakeExecutor = wakeExecutor;
  }

  public run(): Promise<void> {
    const deferred = this.createDeferred();
    this.runDeferreds.push(deferred);

    if (this.activeType === 'wake') {
      // Triggering run while a wake is active aborts the wake immediately via its AbortController
      if (this.activeController) {
        this.activeController.abort();
      }
      this.hasPendingRun = true;
    } else {
      // Triggering run upgrades a queued execution to run.
      // Set hasPendingRun to true.
      this.hasPendingRun = true;
    }

    this.processQueue();
    return deferred.promise;
  }

  public wake(): Promise<void> {
    const deferred = this.createDeferred();
    this.wakeDeferreds.push(deferred);

    if (this.activeType === 'run') {
      // Triggering wake while a run is active coalesces it to a single pending wake event
      if (!this.hasPendingRun) {
        this.hasPendingWake = true;
      }
    } else {
      this.hasPendingWake = true;
    }

    this.processQueue();
    return deferred.promise;
  }

  private processQueue(): void {
    if (this.activeType !== null || this.isStartingNext) {
      return;
    }

    if (this.hasPendingRun) {
      this.hasPendingRun = false;
      // Ensure old wake events are cleared when a run starts
      this.hasPendingWake = false;

      const deferreds = [...this.runDeferreds, ...this.wakeDeferreds];
      this.runDeferreds = [];
      this.wakeDeferreds = [];

      this.isStartingNext = true;
      setImmediate(async () => {
        this.isStartingNext = false;
        this.activeType = 'run';
        this.activeController = new AbortController();

        try {
          await this.runExecutor(this.activeController.signal);
          deferreds.forEach((d) => d.resolve());
        } catch (err) {
          deferreds.forEach((d) => d.reject(err));
        } finally {
          this.activeType = null;
          this.activeController = null;
          this.processQueue();
        }
      });
      return;
    }

    if (this.hasPendingWake) {
      this.hasPendingWake = false;

      const deferreds = [...this.wakeDeferreds];
      this.wakeDeferreds = [];

      this.isStartingNext = true;
      setImmediate(async () => {
        this.isStartingNext = false;
        this.activeType = 'wake';
        this.activeController = new AbortController();

        try {
          await this.wakeExecutor(this.activeController.signal);
          deferreds.forEach((d) => d.resolve());
        } catch (err) {
          deferreds.forEach((d) => d.reject(err));
        } finally {
          this.activeType = null;
          this.activeController = null;
          this.processQueue();
        }
      });
      return;
    }
  }

  private createDeferred() {
    let resolve!: () => void;
    let reject!: (err: any) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }
}
