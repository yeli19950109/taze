import type { Queue } from '@henrygd/queue'
import { AsyncLocalStorage } from 'node:async_hooks'

export const queueContext = new AsyncLocalStorage<Queue>()

/** Run a network request through the current check's concurrency queue, if any. */
export function runQueued<T>(fn: () => PromiseLike<T>): Promise<T> {
  const queue = queueContext.getStore()
  return queue ? queue.add(fn) : Promise.resolve(fn())
}
