export type TtlCache<T> = Map<string, { expiresAt: number; value: Promise<T> }>;

const MAX_ENTRIES = 256;

/**
 * Memoises `load` per key for `ttlMs`. Caching the promise also coalesces
 * concurrent callers onto one request. Rejections, and values `keep` refuses,
 * are evicted so they get retried.
 */
export function cached<T>(
	cache: TtlCache<T>,
	key: string,
	ttlMs: number,
	load: () => Promise<T>,
	keep: (value: T) => boolean = () => true,
): Promise<T> {
	const now = Date.now();
	const hit = cache.get(key);
	if (hit && hit.expiresAt > now) return hit.value;

	if (cache.size >= MAX_ENTRIES) {
		for (const [entryKey, entry] of cache) if (entry.expiresAt <= now) cache.delete(entryKey);
		const oldestKey = cache.keys().next().value;
		if (cache.size >= MAX_ENTRIES && oldestKey !== undefined) cache.delete(oldestKey);
	}
	const entry = { expiresAt: now + ttlMs, value: load() };
	cache.set(key, entry);
	const evict = () => {
		if (cache.get(key) === entry) cache.delete(key);
	};
	entry.value.then((value) => {
		if (!keep(value)) evict();
	}, evict);
	return entry.value;
}
