export class WriteQueue {
  private queue: Promise<any> = Promise.resolve();

  public enqueue<T>(task: () => Promise<T> | T): Promise<T> {
    const result = this.queue.then(() => task());
    // Attach error handler to prevent downstream failures in the queue chain
    this.queue = result.catch(() => {});
    return result;
  }
}

export const globalWriteQueue = new WriteQueue();
