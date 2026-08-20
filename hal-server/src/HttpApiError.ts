import { Schema } from 'effect';
import * as Effect from 'effect/Effect';
import * as ErrorReporter from 'effect/ErrorReporter';
import * as HttpServerRespondable from 'effect/unstable/http/HttpServerRespondable';
import * as HttpServerResponse from 'effect/unstable/http/HttpServerResponse';

/**
 * The installed `effect` version's `HttpApiError` module covers the common
 * codes (400, 401, 403, 404, ...) but not 413. This re-exports everything it
 * does have and adds `PayloadTooLarge` alongside it, following the same
 * pattern the upstream module uses for its own classes, so call sites can
 * import one `HttpApiError` namespace instead of two.
 */
export * from 'effect/unstable/httpapi/HttpApiError';

const payloadTooLargeStatus = 413;
const payloadTooLargeResponse = HttpServerResponse.empty({ status: payloadTooLargeStatus });

export class PayloadTooLarge extends Schema.ErrorClass<PayloadTooLarge>(
  'effect/HttpApiError/PayloadTooLarge',
)(
  {
    _tag: Schema.tag('PayloadTooLarge'),
  },
  {
    description: 'PayloadTooLarge',
    httpApiStatus: payloadTooLargeStatus,
  },
) {
  static readonly status = payloadTooLargeStatus;
  readonly [ErrorReporter.ignore] = true;
  [HttpServerRespondable.symbol]() {
    return Effect.succeed(payloadTooLargeResponse);
  }
}
