/** Runs async jobs one at a time, in the order they were queued. A failed job doesn't block the next. */
export class Queue {
  private tail: Promise<unknown> = Promise.resolve()

  run<T>(job: () => Promise<T>): Promise<T> {
    const result = this.tail.then(job)
    this.tail = result.catch(() => undefined)
    return result
  }
}
