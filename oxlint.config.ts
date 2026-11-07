import { defineConfig } from 'oxlint';

export default defineConfig({
  /**
   * `repos/**` is vendored read-only reference material — four `git subtree`
   * imports that outnumber this project's own source by roughly 550 to 1.
   * Without the exclusion oxlint also discovers their nested `.oxlintrc.json`
   * files and fails trying to load plugins that are not installed here.
   */
  ignorePatterns: ['**/dist/**', '**/node_modules/**', '**/.alchemy/**', '**/repos/**'],
  options: {
    typeAware: true,
  },
});
