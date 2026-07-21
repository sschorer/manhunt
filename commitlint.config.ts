import type { UserConfig } from '@commitlint/types';

const config: UserConfig = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    // Allowed commit types.
    'type-enum': [
      2,
      'always',
      ['feat', 'fix', 'docs', 'style', 'refactor', 'perf', 'test', 'build', 'ci', 'chore', 'revert'],
    ],
    // Scope is optional, but if present must be one of these.
    'scope-enum': [
      2,
      'always',
      ['client', 'server', 'infra', 'ci', 'docs', 'deps', 'release', 'db', 'vouch'],
    ],
    'subject-case': [0], // don't fight sentence vs. lower-case subjects
  },
};

export default config;
