import nx from '@nx/eslint-plugin';

export default [
  ...nx.configs['flat/base'],
  ...nx.configs['flat/typescript'],
  ...nx.configs['flat/javascript'],
  {
    ignores: ['**/dist', '**/out-tsc', '**/vitest.config.*.timestamp*'],
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
            // The protocol core depends on nothing; client and server depend only on it.
            { sourceTag: 'scope:jmap-core', onlyDependOnLibsWithTags: [] },
            {
              sourceTag: 'scope:jmap-server',
              onlyDependOnLibsWithTags: ['scope:jmap-core'],
            },
            {
              sourceTag: 'scope:jmap-client',
              onlyDependOnLibsWithTags: ['scope:jmap-core'],
            },
            {
              sourceTag: 'scope:transport',
              onlyDependOnLibsWithTags: [
                'scope:jmap-core',
                'scope:jmap-server',
              ],
            },
            {
              sourceTag: 'scope:storage',
              onlyDependOnLibsWithTags: [
                'scope:jmap-core',
                'scope:jmap-server',
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
