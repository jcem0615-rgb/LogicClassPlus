import type { Metadata, Viewport } from 'next';
import './globals.css';
import { StoreProvider } from '@/lib/store';
import { Toasts } from '@/components/toasts';

export const metadata: Metadata = {
  title: 'LogicClass+',
  description: 'Live 1-on-1 English and Math classrooms, attendance, payroll and billing.',
  manifest: '/manifest.webmanifest',
  appleWebApp: { capable: true, title: 'LogicClass+' },
  icons: { icon: '/icon.svg', apple: '/icon.svg' },
};

export const viewport: Viewport = {
  themeColor: '#0B6B62',
  viewportFit: 'cover',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600&family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap"
        />
      </head>
      <body>
        <StoreProvider>
          {children}
          <Toasts />
        </StoreProvider>
      </body>
    </html>
  );
}
