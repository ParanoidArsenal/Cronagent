import { getHistory } from '@/lib/backend';
import { HistoryTable } from '@/components/history-table';
import { getTranslations } from 'next-intl/server';

export const dynamic = 'force-dynamic';

export default async function HistoryPage() {
  const t = await getTranslations('history');
  const history = await getHistory();
  const records = await history.getHistory(undefined, 100);

  return (
    <>
      <div className="page-header">
        <h1>{t('title')}</h1>
      </div>
      <HistoryTable records={records} />
    </>
  );
}
