import { getEnvVar } from '@/lib/backend';
import { EnvVarForm } from '@/components/env-var-form';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

export const dynamic = 'force-dynamic';

export default async function EditEnvVarPage({
  params,
}: {
  params: Promise<{ name: string }>;
}) {
  const t = await getTranslations('envVarEdit');
  const { name } = await params;
  const decodedName = decodeURIComponent(name);
  const envVar = await getEnvVar(decodedName);

  if (!envVar) {
    notFound();
  }

  return (
    <>
      <h1>{t('title', { name: envVar.name })}</h1>
      <EnvVarForm
        editMode
        initial={{
          name: envVar.name,
          value: envVar.value,
          description: envVar.description,
          enabled: envVar.enabled,
        }}
      />
    </>
  );
}
