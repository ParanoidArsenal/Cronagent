import './globals.css';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages } from 'next-intl/server';
import { Nav } from '@/components/nav';

export const metadata = {
  title: 'cronagent',
  description: 'Personal automation hub',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  const messages = await getMessages();

  return (
    <html lang={locale} suppressHydrationWarning>
      <head>
        <link
          rel="stylesheet"
          type="text/css"
          href="https://cdn.jsdelivr.net/gh/ekmas/cs16.css@main/css/cs16.min.css"
        />
      </head>
      <body>
        <NextIntlClientProvider messages={messages}>
          <div className="app-layout">
            <Nav />
            <main className="main-content">{children}</main>
          </div>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
