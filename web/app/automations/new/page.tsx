import { getTranslations } from 'next-intl/server';
import { NewAutomationClient } from './client';

export default async function NewAutomationPage() {
  const t = await getTranslations('automationNew');

  return (
    <>
      <div className="page-header">
        <h1>{t('title')}</h1>
      </div>
      <NewAutomationClient />
    </>
  );
}
