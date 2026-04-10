import { McpForm } from '@/components/mcp-form';
import { getTranslations } from 'next-intl/server';

export default async function NewMcpServerPage() {
  const t = await getTranslations('mcpNew');

  return (
    <>
      <h1>{t('title')}</h1>
      <McpForm />
    </>
  );
}
