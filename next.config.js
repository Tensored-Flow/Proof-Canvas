/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  agentRules: false,
  serverExternalPackages: ['better-sqlite3'],
}

module.exports = nextConfig
