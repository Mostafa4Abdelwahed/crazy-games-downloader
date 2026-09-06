/**
 * E2E hermeticity guard (loaded via `setupFiles`, before any spec).
 *
 * Unity StreamingAssets dependency discovery launches headless browsers
 * (remote-entry observation + local-package observation). Fixture-backed
 * e2e must stay offline, hermetic and fast — and no fixture carries
 * StreamingAssets dependencies — so the browser stages are disabled here.
 * Static (text-scan) discovery still runs. The browser stages remain ON by
 * default for real imports and are covered by unit tests (`unity.
 * streaming-assets.spec`, `runtime-health.spec`) plus `npm run
 * validate:real`. No asserted e2e outcome depends on them.
 */
process.env.UNITY_STREAMING_ASSETS_RUNTIME_DISCOVERY = 'false';
process.env.UNITY_STREAMING_ASSETS_LOCAL_DISCOVERY = 'false';
