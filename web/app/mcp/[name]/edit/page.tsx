import { getMcpServer } from '@/lib/backend';
import { McpForm } from '@/components/mcp-form';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

export const dynamic = 'force-dynamic';

export default async function EditMcpServerPage({
  params,
}: {
  params: Promise<{ name: string }>;
}) {
  const t = await getTranslations('mcpEdit');
  const { name } = await params;
  const decodedName = decodeURIComponent(name);
  const server = await getMcpServer(decodedName);

  if (!server) {
    notFound();
  }

  return (
    <>
      <h1>{t('title', { name: server.name })}</h1>
      <McpForm
        editMode
        initial={{
          name: server.name,
          command: server.command,
          args: server.args,
          env: server.env,
          enabled: server.enabled,
        }}
      />
    </>
  );
}
