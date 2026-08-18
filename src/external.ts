import { mapWithConcurrency } from './concurrency.js';
import type { ExternalCheckResult, ExternalFailureKind } from './types.js';

export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_CONCURRENCY = 10;
export const DEFAULT_USER_AGENT = 'link-checker/1.0';

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface ExternalCheckOptions {
  /** Per-request timeout in milliseconds. Default 10000. */
  timeoutMs?: number;
  /** Maximum simultaneous HTTP requests. Default 10. */
  concurrency?: number;
  userAgent?: string;
  /** Injectable for tests. */
  fetchImpl?: FetchLike;
  onChecked?: (result: ExternalCheckResult) => void;
}

/** Reason phrases for the cases where a server sends none (HTTP/2 has none at all). */
const STATUS_TEXT: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  402: 'Payment Required',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  406: 'Not Acceptable',
  407: 'Proxy Authentication Required',
  408: 'Request Timeout',
  409: 'Conflict',
  410: 'Gone',
  418: "I'm a Teapot",
  421: 'Misdirected Request',
  422: 'Unprocessable Content',
  425: 'Too Early',
  426: 'Upgrade Required',
  429: 'Too Many Requests',
  451: 'Unavailable For Legal Reasons',
  500: 'Internal Server Error',
  501: 'Not Implemented',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
  505: 'HTTP Version Not Supported',
  507: 'Insufficient Storage',
  508: 'Loop Detected',
  511: 'Network Authentication Required',
};

const DNS_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL', 'ENODATA', 'ESERVFAIL']);
const CONNECTION_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENETDOWN',
  'EPIPE',
  'ETIMEDOUT',
  'EADDRNOTAVAIL',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
]);

export function statusReason(status: number, statusText?: string): string {
  const text = statusText?.trim() || STATUS_TEXT[status] || '';
  return text ? `${status} ${text}` : `HTTP ${status}`;
}

/** Walk the `cause` chain looking for a Node error code. */
function findErrorCode(error: unknown, depth = 0): string | undefined {
  if (!error || typeof error !== 'object' || depth > 5) return undefined;
  const candidate = error as { code?: unknown; cause?: unknown };
  if (typeof candidate.code === 'string') return candidate.code;
  return findErrorCode(candidate.cause, depth + 1);
}

function collectMessages(error: unknown, depth = 0): string {
  if (!error || typeof error !== 'object' || depth > 5) return '';
  const candidate = error as { message?: unknown; cause?: unknown };
  const own = typeof candidate.message === 'string' ? candidate.message : '';
  return `${own} ${collectMessages(candidate.cause, depth + 1)}`.trim();
}

export function classifyRequestError(
  error: unknown,
  timeoutMs: number,
): { kind: ExternalFailureKind; reason: string } {
  const name = (error as { name?: string } | undefined)?.name;
  if (name === 'TimeoutError' || name === 'AbortError') {
    return { kind: 'timeout', reason: 'Timeout' };
  }

  const code = findErrorCode(error);
  const message = collectMessages(error);

  if (code === 'UND_ERR_HEADERS_TIMEOUT' || code === 'UND_ERR_BODY_TIMEOUT') {
    return { kind: 'timeout', reason: 'Timeout' };
  }
  if (code && DNS_CODES.has(code)) {
    return { kind: 'dns', reason: `DNS error (${code})` };
  }
  if (code === 'UND_ERR_REDIRECT' || /redirect count exceeded/i.test(message)) {
    return { kind: 'too-many-redirects', reason: 'Too many redirects' };
  }
  if (
    code &&
    (code.startsWith('CERT_') ||
      code.startsWith('ERR_TLS') ||
      code.startsWith('ERR_SSL') ||
      code.startsWith('DEPTH_ZERO') ||
      code.startsWith('SELF_SIGNED') ||
      code.startsWith('UNABLE_TO_') ||
      code === 'EPROTO' ||
      code === 'ERR_SSL_WRONG_VERSION_NUMBER')
  ) {
    return { kind: 'tls', reason: `TLS error (${code})` };
  }
  if (code && CONNECTION_CODES.has(code)) {
    return { kind: 'connection', reason: `Connection error (${code})` };
  }
  if (code === 'ERR_INVALID_URL') {
    return { kind: 'malformed-url', reason: 'Malformed URL' };
  }

  // `timeoutMs` is referenced so the caller's configuration shows up in the
  // fallback text, which is otherwise opaque.
  const detail = code ?? (message ? message.split('\n')[0] : `no response within ${timeoutMs}ms`);
  return { kind: 'connection', reason: `Connection error (${detail})` };
}

/**
 * Perform exactly one HTTP request for `url` and judge the final response.
 *
 * Redirects are followed and only the final status matters: 2xx and 3xx are
 * valid, 4xx and 5xx are broken. Every failure mode resolves to a result value
 * rather than throwing, so a single bad URL can never stop a scan.
 */
export async function checkExternalUrl(
  url: string,
  options: ExternalCheckOptions = {},
): Promise<ExternalCheckResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as FetchLike);

  try {
    // Validate before requesting so bad input is reported, not thrown.
    // eslint-disable-next-line no-new
    new URL(url);
  } catch {
    return { ok: false, url, kind: 'malformed-url', reason: 'Malformed URL' };
  }

  try {
    const response = await fetchImpl(url, {
      // A single GET works everywhere; HEAD would be cheaper but many servers
      // answer it with 403/405, and a HEAD+GET fallback would mean two requests
      // per URL. The body is discarded as soon as the headers arrive.
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        'user-agent': options.userAgent ?? DEFAULT_USER_AGENT,
        accept: '*/*',
        'accept-encoding': 'identity',
      },
    });

    try {
      await response.body?.cancel();
    } catch {
      /* the body may already be consumed or closed; irrelevant to the verdict */
    }

    if (response.status >= 400) {
      return {
        ok: false,
        url,
        kind: 'http-status',
        reason: statusReason(response.status, response.statusText),
        status: response.status,
      };
    }

    return { ok: true, url, status: response.status, finalUrl: response.url || url };
  } catch (error) {
    const { kind, reason } = classifyRequestError(error, timeoutMs);
    return { ok: false, url, kind, reason };
  }
}

/**
 * Check a list of already-deduplicated URLs, at most `concurrency` at a time.
 * Returns a map keyed by the URL that was passed in.
 */
export async function checkExternalUrls(
  urls: readonly string[],
  options: ExternalCheckOptions = {},
): Promise<Map<string, ExternalCheckResult>> {
  const unique = [...new Set(urls)];
  const results = await mapWithConcurrency(
    unique,
    options.concurrency ?? DEFAULT_CONCURRENCY,
    async (url) => {
      const result = await checkExternalUrl(url, options);
      options.onChecked?.(result);
      return result;
    },
  );

  return new Map(unique.map((url, index) => [url, results[index]!]));
}
