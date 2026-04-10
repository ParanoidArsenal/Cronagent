import { EnvVarForm } from '@/components/env-var-form';
import { getTranslations } from 'next-intl/server';

export default async function NewEnvVarPage() {
  const t = await getTranslations('envVarNew');

  return (
    <>
      <h1>{t('title')}</h1>
      <EnvVarForm />
    </>
  );
}
