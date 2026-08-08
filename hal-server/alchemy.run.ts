import * as Alchemy from 'alchemy';
import * as Cloudflare from 'alchemy/Cloudflare';
import * as Effect from 'effect/Effect';
import Api from './src/Api.ts';

/**
 * The Hal stack.
 *
 * `Cloudflare.state()` keeps Alchemy's resource state in Cloudflare itself,
 * so there is no local state file to lose or to share.
 */
export default Alchemy.Stack(
  'HalGoodly',
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const api = yield* Api;

    return {
      url: api.url.as<string>(),
    };
  }),
);
