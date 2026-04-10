'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';

const linkKeys = [
  { href: '/', key: 'dashboard' },
  { href: '/automations', key: 'automations' },
  { href: '/mcp', key: 'mcpServers' },
  { href: '/env-vars', key: 'envVars' },
  { href: '/history', key: 'history' },
  { href: '/analytics', key: 'analytics' },
  { href: '/settings', key: 'settings' },
] as const;

export function Nav() {
  const pathname = usePathname();
  const router = useRouter();
  const locale = useLocale();
  const t = useTranslations('nav');

  const toggleLocale = () => {
    const next = locale === 'ru' ? 'en' : 'ru';
    document.cookie = `NEXT_LOCALE=${next};path=/;max-age=31536000`;
    router.refresh();
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-title">cronagent</div>
      {linkKeys.map((link) => {
        const active =
          link.href === '/'
            ? pathname === '/'
            : pathname.startsWith(link.href);
        return (
          <Link
            key={link.href}
            href={link.href}
            className={`sidebar-link${active ? ' active' : ''}`}
          >
            {t(link.key)}
          </Link>
        );
      })}
      <button
        className="btn btn-sm"
        onClick={toggleLocale}
        style={{ marginTop: 'auto', alignSelf: 'stretch', fontSize: '0.8rem' }}
      >
        {locale === 'ru' ? 'EN' : 'RU'}
      </button>
    </aside>
  );
}
