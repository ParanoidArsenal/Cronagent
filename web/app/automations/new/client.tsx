'use client';

import { useState, useCallback } from 'react';
import { AutomationForm } from '@/components/automation-form';
import { GenerateAutomation } from '@/components/generate-automation';
import type { AutomationFormData } from '@/components/automation-form';

export function NewAutomationClient() {
  const [initial, setInitial] = useState<AutomationFormData | undefined>(undefined);
  const [key, setKey] = useState(0);

  const handleGenerated = useCallback((data: AutomationFormData) => {
    setInitial(data);
    setKey((k) => k + 1); // force re-mount of AutomationForm to pick up new initial
  }, []);

  return (
    <>
      <GenerateAutomation onGenerated={handleGenerated} />
      <AutomationForm key={key} initial={initial} />
    </>
  );
}
