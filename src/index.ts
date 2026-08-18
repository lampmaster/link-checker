/** Public API — the CLI is a thin wrapper around these. */
export { scan, type ScanOptions, type ProgressEvent } from './scan.js';
export { extractLinks, type ExtractOptions } from './extract.js';
export { classifyLink, normalizeExternalUrl, percentDecode } from './classify.js';
export {
  discoverMarkdownFiles,
  DEFAULT_IGNORED_DIRECTORIES,
  type DiscoverOptions,
} from './discover.js';
export {
  checkExternalUrl,
  checkExternalUrls,
  statusReason,
  classifyRequestError,
  DEFAULT_CONCURRENCY,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_USER_AGENT,
  type ExternalCheckOptions,
  type FetchLike,
} from './external.js';
export { checkLocalPath, resolveLocalLink, type LocalCheckResult } from './local.js';
export { mapWithConcurrency } from './concurrency.js';
export { formatReport, formatJson, type ReportOptions } from './report.js';
export type * from './types.js';
