import { notFound } from 'next/navigation';
import { getAutomations, isComposedAutomation } from '@/lib/backend';
import { AutomationForm } from '@/components/automation-form';
import type { AutomationFormData } from '@/components/automation-form';
import { getTranslations } from 'next-intl/server';

export const dynamic = 'force-dynamic';

export default async function EditAutomationPage({
  params,
}: {
  params: Promise<{ name: string }>;
}) {
  const t = await getTranslations('automationEdit');
  const { name } = await params;
  const decodedName = decodeURIComponent(name);

  const automations = await getAutomations();
  const automation = automations.find((a) => a.name === decodedName);

  if (!automation) {
    notFound();
  }

  const composed = isComposedAutomation(automation.instructions);
  let composeSteps = '';
  let onComplete = '';

  if (composed) {
    try {
      const parsed = JSON.parse(automation.instructions);
      composeSteps = (parsed.compose ?? []).join('\n');
      if (parsed.on_complete) {
        onComplete = Object.entries(parsed.on_complete)
          .map(([k, v]) => `${k}=${v}`)
          .join('\n');
      }
    } catch {
      // fall through with empty values
    }
  }

  // Parse rich notify config into form-friendly channel values
  const notifyObj = automation.notify !== null && typeof automation.notify === 'object'
    ? automation.notify
    : {};
  const VALID_CHANNEL_VALUES = new Set(['on_failure', 'on_success']);
  function toChannelVal(v: boolean | string | undefined): 'default' | 'always' | 'on_failure' | 'on_success' | 'off' {
    if (v === undefined) return 'default';
    if (v === true) return 'always';
    if (v === false) return 'off';
    return VALID_CHANNEL_VALUES.has(v as string) ? (v as 'on_failure' | 'on_success') : 'default';
  }

  const initial: AutomationFormData = {
    name: automation.name,
    description: automation.description,
    mode: composed ? 'composed' : automation.mode,
    trigger: automation.trigger,
    schedule: automation.schedule ?? '',
    timeout: automation.timeout,
    model: automation.model,
    mcp: automation.mcp,
    sandbox: automation.sandbox,
    conversation: automation.conversation ?? false,
    notify: automation.notify !== false,
    notifyChannels: {
      webhook: toChannelVal(notifyObj.webhook),
      telegram: toChannelVal(notifyObj.telegram),
      mattermost: toChannelVal(notifyObj.mattermost),
    },
    instructions: composed ? '' : automation.instructions,
    composeSteps,
    onComplete,
    maxRetries: automation.maxRetries ?? 0,
    retryDelayMs: automation.retryDelayMs ?? 1000,
    maxTurns: automation.maxTurns ?? 0,
  };

  return (
    <>
      <div className="page-header">
        <h1>{t('editTitle', { name: automation.name })}</h1>
      </div>
      <AutomationForm initial={initial} editMode originalName={automation.name} />
    </>
  );
}
