import { ThrottleForm } from '@/components/throttle-form';
import { BudgetForm } from '@/components/budget-form';
import { getTranslations } from 'next-intl/server';

export default async function SettingsPage() {
  const t = await getTranslations('settings');

  return (
    <>
      <div className="page-header">
        <h1>{t('title')}</h1>
      </div>

      <h2 className="cs-section">{t('throttle')}</h2>
      <p style={{ color: 'var(--cs-text-dim)', fontSize: '0.875rem', marginTop: 0, marginBottom: '1.25rem' }}>
        {t('throttleDescription')}
      </p>

      <ThrottleForm />

      <h2 className="cs-section" style={{ marginTop: '2.5rem' }}>{t('budget')}</h2>
      <p style={{ color: 'var(--cs-text-dim)', fontSize: '0.875rem', marginTop: 0, marginBottom: '1.25rem' }}>
        {t('budgetDescription')}
      </p>

      <BudgetForm />
    </>
  );
}
