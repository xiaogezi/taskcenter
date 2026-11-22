// Poll one timeline query. Cleanup invalidates even requests that ignore abort.
/**
 * @template T
 * @param {(signal: AbortSignal) => Promise<T>} read
 * @param {(value: T) => void} onData
 * @param {(error: unknown) => void} onError
 */
export function startActivityPoll(read, onData, onError) {
  const controller = new AbortController();
  const { signal } = controller;
  const poll = async () => {
    try {
      const value = await read(signal);
      if (!signal.aborted) onData(value);
    } catch (error) {
      if (!signal.aborted) onError(error);
    } finally {
      if (!signal.aborted) timer = setTimeout(poll, 5000);
    }
  };
  let timer = setTimeout(poll, 0);
  return () => {
    clearTimeout(timer);
    controller.abort();
  };
}
