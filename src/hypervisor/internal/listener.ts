export function observeListenerSettlement(
  input: Readonly<{
    finished: Promise<void>;
    signal?: AbortSignal;
    close(): Promise<void>;
    cleanup(): void;
  }>,
): void {
  let settled = false;
  const abort = (): void => {
    void input.close();
  };
  const cleanup = (): void => {
    if (settled) return;
    settled = true;
    input.signal?.removeEventListener("abort", abort);
    input.cleanup();
  };

  input.signal?.addEventListener("abort", abort, { once: true });
  // Supplying both handlers consumes a fatal listener rejection while preserving
  // the original `finished` Promise exposed to the caller.
  void input.finished.then(cleanup, cleanup);
}
