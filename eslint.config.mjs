import nx from '@nx/eslint-plugin';

export default [
  ...nx.configs['flat/base'],
  ...nx.configs['flat/typescript'],
  ...nx.configs['flat/javascript'],
  {
    ignores: [
      '**/dist',
      '**/out-tsc',
      '**/vitest.config.*.timestamp*',
      '**/vite.config.*.timestamp*',
    ],
  },
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'],
    rules: {
      '@nx/enforce-module-boundaries': [
        'error',
        {
          enforceBuildableLibDependency: true,
          allow: ['^.*/eslint(\\.base)?\\.config\\.[cm]?[jt]s$'],
          depConstraints: [
            // Libraries never depend on apps; apps may use any library.
            { sourceTag: 'type:lib', onlyDependOnLibsWithTags: ['type:lib'] },
            { sourceTag: 'type:app', onlyDependOnLibsWithTags: ['type:lib'] },
            // What is particular to one cloud is chosen by an app, never built on by a
            // library: that is what keeps the libraries usable anywhere.
            {
              sourceTag: 'type:lib',
              notDependOnLibsWithTags: ['platform:aws'],
            },
            // The protocol core depends on nothing. The engine builds on it, each kind
            // of data on the engine, and the server puts them together.
            { sourceTag: 'scope:jmap-core', onlyDependOnLibsWithTags: [] },
            {
              sourceTag: 'scope:jmap-engine',
              onlyDependOnLibsWithTags: ['scope:jmap-core'],
            },
            ...[
              'scope:jmap-mail',
              'scope:jmap-contacts',
              'scope:jmap-sharing',
            ].map((sourceTag) => ({
              sourceTag,
              onlyDependOnLibsWithTags: [
                'scope:jmap-core',
                'scope:jmap-engine',
              ],
            })),
            {
              sourceTag: 'scope:jmap-server',
              onlyDependOnLibsWithTags: [
                'scope:jmap-core',
                'scope:jmap-engine',
                'scope:jmap-mail',
                'scope:jmap-contacts',
                'scope:jmap-sharing',
              ],
            },
            {
              sourceTag: 'scope:jmap-client',
              onlyDependOnLibsWithTags: ['scope:jmap-core'],
            },
            // A transport and a store are written against the part they plug into,
            // and tested against the whole server.
            {
              sourceTag: 'scope:transport',
              onlyDependOnLibsWithTags: [
                'scope:jmap-core',
                'scope:jmap-engine',
                'scope:jmap-mail',
                'scope:jmap-server',
              ],
            },
            {
              sourceTag: 'scope:storage',
              onlyDependOnLibsWithTags: [
                'scope:jmap-core',
                'scope:jmap-engine',
                'scope:jmap-server',
              ],
            },
            // The directory knows nothing of JMAP: it says who has which mailbox.
            {
              sourceTag: 'scope:directory',
              onlyDependOnLibsWithTags: ['scope:directory'],
            },
            // Nor does identity: it says who someone is, whatever they then do.
            {
              sourceTag: 'scope:identity',
              onlyDependOnLibsWithTags: ['scope:identity'],
            },
            // The client is generated from the admin API, and tested against it.
            {
              sourceTag: 'scope:admin-client',
              onlyDependOnLibsWithTags: [
                'scope:admin',
                'scope:directory',
                'scope:identity',
                'scope:jmap-core',
                'scope:jmap-engine',
              ],
            },
            // The admin API brings the directory, identity and app passwords together.
            {
              sourceTag: 'scope:admin',
              onlyDependOnLibsWithTags: [
                'scope:admin',
                'scope:directory',
                'scope:identity',
                'scope:jmap-core',
                'scope:jmap-engine',
              ],
            },
          ],
        },
      ],
    },
  },
  {
    files: [
      '**/*.ts',
      '**/*.tsx',
      '**/*.cts',
      '**/*.mts',
      '**/*.js',
      '**/*.jsx',
      '**/*.cjs',
      '**/*.mjs',
    ],
    // Override or add rules here
    rules: {},
  },
];
