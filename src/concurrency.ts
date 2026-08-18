/**
 * Run `worker` over `items` with at most `limit` tasks in flight.
 *
 * Results keep the input order. A rejected worker rejects the whole call, so
 * callers that must never abort the scan pass a worker that resolves errors
 * into result values.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  if (items.length === 0) return results;

  const size = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  let next = 0;

  const runners = Array.from({ length: size }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await worker(items[index]!, index);
    }
  });

  await Promise.all(runners);
  return results;
}
