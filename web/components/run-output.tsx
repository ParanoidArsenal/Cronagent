'use client';

import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface RunOutputProps {
  output: string;
  fallbackText: string;
}

export function RunOutput({ output, fallbackText }: RunOutputProps) {
  if (!output || output.trim().length === 0) {
    return <div className="output-block">{fallbackText}</div>;
  }

  const looksLikeMarkdown = /[#*`\-|[\]]/.test(output);
  if (!looksLikeMarkdown) {
    return <div className="output-block">{output}</div>;
  }

  return (
    <div className="prose">
      <Markdown remarkPlugins={[remarkGfm]}>{output}</Markdown>
    </div>
  );
}
