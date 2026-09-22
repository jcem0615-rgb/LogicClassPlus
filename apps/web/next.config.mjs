import withPWAInit from 'next-pwa';

const withPWA = withPWAInit({
  dest: 'public',
  register: true,
  skipWaiting: true,
  // The service worker is a nuisance in development: it caches the previous
  // build and hides the change you just made.
  disable: process.env.NODE_ENV === 'development',
});

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Every screen talks to the API from the browser, so there is no server
  // rendering of user data and nothing to leak between requests.
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4001',
  },
};

export default withPWA(nextConfig);
