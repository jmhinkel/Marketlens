// Tiny TTL cache so a multi-factor analysis doesn't hammer the same endpoints.
const store = new Map();

export function cacheGet(key) {
  const hit = store.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expires) {
    store.delete(key);
    return null;
  }
  return hit.value;
}

export function cacheSet(key, value, ttlMs) {
  store.set(key, { value, expires: Date.now() + ttlMs });
  return value;
}

export async function cached(key, ttlMs, fn) {
  const hit = cacheGet(key);
  if (hit !== null) return hit;
  const value = await fn();
  return cacheSet(key, value, ttlMs);
}
