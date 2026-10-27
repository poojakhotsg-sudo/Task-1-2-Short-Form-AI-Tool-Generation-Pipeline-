// Runs before each test file's own module graph loads (vitest's
// `setupFiles`). This matters specifically because
// src/lib/objectStorage.ts reads OBJECT_STORAGE_PRIVATE_BUCKET into a
// module-level constant at import time, not lazily — setting it in a
// beforeEach would be too late, since static imports are evaluated
// before any test body runs.
process.env.OBJECT_STORAGE_PRIVATE_BUCKET = 'reel-private';
