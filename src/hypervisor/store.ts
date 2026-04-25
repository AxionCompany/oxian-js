/**
 * @fileoverview Default in-memory HypervisorStore implementation.
 *
 * Wraps Maps for zero-overhead single-instance use. All operations
 * are synchronous internally but return Promises to satisfy the
 * async store interface (enabling drop-in replacement with Redis, etc.).
 *
 * @module hypervisor/store
 */

import type { HypervisorStore } from "./types.ts";

export class MemoryStore implements HypervisorStore {
  private data = new Map<string, { value: unknown; expiresAt?: number }>();
  private locks = new Set<string>();
  private queues = new Map<string, Array<{ id: string; item: unknown }>>();
  private waiters = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: unknown) => void }
  >();
  private idCounter = 0;

  // ── Key-value ───────────────────────────────────────────────────────

  async get<T>(key: string): Promise<T | undefined> {
    const entry = this.data.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      this.data.delete(key);
      return undefined;
    }
    return entry.value as T;
  }

  async set<T>(key: string, value: T, ttlMs?: number): Promise<void> {
    this.data.set(key, {
      value,
      expiresAt: ttlMs ? Date.now() + ttlMs : undefined,
    });
  }

  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }

  // ── Counters ────────────────────────────────────────────────────────

  async increment(key: string): Promise<number> {
    const current = ((await this.get<number>(key)) ?? 0) + 1;
    await this.set(key, current);
    return current;
  }

  async decrement(key: string): Promise<number> {
    const current = (await this.get<number>(key)) ?? 0;
    const next = current > 0 ? current - 1 : 0;
    await this.set(key, next);
    return next;
  }

  // ── Distributed locks ───────────────────────────────────────────────

  async acquire(key: string, _ttlMs: number): Promise<boolean> {
    if (this.locks.has(key)) return false;
    this.locks.add(key);
    return true;
  }

  async release(key: string): Promise<void> {
    this.locks.delete(key);
  }

  // ── Request-response queue ──────────────────────────────────────────

  async enqueue<T>(queue: string, item: T): Promise<string> {
    const id = `${++this.idCounter}`;
    const list = this.queues.get(queue) ?? [];
    list.push({ id, item: item as unknown });
    this.queues.set(queue, list);
    return id;
  }

  async drain<T>(queue: string): Promise<Array<{ id: string; item: T }>> {
    const list = this.queues.get(queue) ?? [];
    this.queues.delete(queue);
    return list as Array<{ id: string; item: T }>;
  }

  async waitFor<T>(id: string, timeoutMs?: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      // Check if already resolved
      const existing = this.waiters.get(id);
      if (existing) {
        // Shouldn't happen, but handle gracefully
        existing.reject(new Error("Replaced by new waiter"));
      }
      this.waiters.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
      });
      if (timeoutMs) {
        setTimeout(() => {
          if (this.waiters.has(id)) {
            this.waiters.delete(id);
            reject(new Error("waitFor timeout"));
          }
        }, timeoutMs);
      }
    });
  }

  async resolve<T>(id: string, value: T): Promise<void> {
    const waiter = this.waiters.get(id);
    if (waiter) {
      waiter.resolve(value);
      this.waiters.delete(id);
    }
  }
}
