import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./i18n/request.ts');

const __dirname = dirname(fileURLToPath(import.meta.url));
const parentDir = join(__dirname, '..');

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  outputFileTracingRoot: parentDir,
  serverExternalPackages: ['better-sqlite3', 'pino', 'pino-pretty', 'croner', 'execa', 'gray-matter'],

  webpack: (config, { isServer }) => {
    if (isServer) {
      config.resolve.modules = [
        join(parentDir, 'node_modules'),
        'node_modules',
        ...(config.resolve.modules || []),
      ];
    }

    config.resolve.alias = {
      ...config.resolve.alias,
      '@automation-repl': join(parentDir, 'src'),
    };

    // Parent src/ uses ESM .js extensions in imports (e.g. './logger.js').
    // Webpack needs to resolve these to the actual .ts files.
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      '.js': ['.ts', '.js'],
    };

    return config;
  },
};

export default withNextIntl(nextConfig);
