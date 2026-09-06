export function redisConnection() {
  const url = process.env.REDIS_URL;
  if (!url) return null;
  return url;
}

export function queueDriver(): 'bullmq' | 'memory' {
  if (process.env.QUEUE_DRIVER === 'bullmq' && process.env.REDIS_URL) {
    return 'bullmq';
  }
  if (process.env.QUEUE_DRIVER === 'memory') return 'memory';
  // Default: memory unless REDIS_URL present
  return process.env.REDIS_URL ? 'bullmq' : 'memory';
}
