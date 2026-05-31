import { FileLock } from "./types.js";

interface QueuedLockRequest {
  workerId: string;
  timeoutMs: number;
  resolve: (success: boolean) => void;
  timer: NodeJS.Timeout;
}

export class LockManager {
  private locks = new Map<string, FileLock>();
  private queues = new Map<string, QueuedLockRequest[]>();
  private lockTimers = new Map<string, NodeJS.Timeout>();

  /**
   * Attempts to acquire a file-level lock. If already locked, queues the request until timeoutMs.
   */
  public async acquireLock(
    filePath: string,
    workerId: string,
    timeoutMs = 15000
  ): Promise<boolean> {
    const currentLock = this.locks.get(filePath);

    // 1. If currently held by the same worker, re-acquire / refresh it
    if (currentLock && currentLock.workerId === workerId) {
      this.refreshLockTimeout(filePath, workerId, timeoutMs);
      return true;
    }

    // 2. If not locked, acquire immediately
    if (!currentLock) {
      this.setLock(filePath, workerId, timeoutMs);
      return true;
    }

    // 3. Otherwise, queue the request and wait
    return new Promise<boolean>((resolve) => {
      if (!this.queues.has(filePath)) {
        this.queues.set(filePath, []);
      }

      const queue = this.queues.get(filePath)!;

      // Setup a queue timeout timer
      const timer = setTimeout(() => {
        // Remove from queue on timeout
        const updatedQueue = this.queues.get(filePath) || [];
        const idx = updatedQueue.findIndex((q) => q.resolve === resolve);
        if (idx !== -1) {
          updatedQueue.splice(idx, 1);
        }
        resolve(false); // Failed to acquire within timeout
      }, timeoutMs);

      queue.push({
        workerId,
        timeoutMs,
        resolve,
        timer,
      });
    });
  }

  /**
   * Releases a lock on a file, triggering the next queued request if any exist.
   */
  public releaseLock(filePath: string, workerId: string): void {
    const currentLock = this.locks.get(filePath);
    if (!currentLock || currentLock.workerId !== workerId) {
      return; // Not held by this worker
    }

    this.clearLock(filePath);
    this.processQueue(filePath);
  }

  /**
   * Force releases a lock regardless of holder.
   */
  public forceRelease(filePath: string): void {
    this.clearLock(filePath);
    this.processQueue(filePath);
  }

  /**
   * Checks if a file is currently locked.
   */
  public isLocked(filePath: string): boolean {
    return this.locks.has(filePath);
  }

  /**
   * Returns the current lock details if locked.
   */
  public getLock(filePath: string): FileLock | undefined {
    return this.locks.get(filePath);
  }

  private setLock(filePath: string, workerId: string, timeoutMs: number): void {
    const lock: FileLock = {
      filePath,
      workerId,
      acquiredAt: Date.now(),
      timeoutMs,
    };
    this.locks.set(filePath, lock);

    // Setup auto-release safety timer to prevent deadlocks if worker crashes or hangs
    const timer = setTimeout(() => {
      this.releaseLock(filePath, workerId);
    }, timeoutMs);

    this.lockTimers.set(filePath, timer);
  }

  private clearLock(filePath: string): void {
    this.locks.delete(filePath);
    const timer = this.lockTimers.get(filePath);
    if (timer) {
      clearTimeout(timer);
      this.lockTimers.delete(filePath);
    }
  }

  private refreshLockTimeout(filePath: string, workerId: string, timeoutMs: number): void {
    this.clearLock(filePath);
    this.setLock(filePath, workerId, timeoutMs);
  }

  private processQueue(filePath: string): void {
    const queue = this.queues.get(filePath);
    if (!queue || queue.length === 0) {
      return;
    }

    // Pull next request from queue
    const nextReq = queue.shift()!;
    clearTimeout(nextReq.timer); // Clear queue timeout timer

    // Grant lock to the next queued request
    this.setLock(filePath, nextReq.workerId, nextReq.timeoutMs);
    nextReq.resolve(true); // Resolve queued promise with success
  }
}
