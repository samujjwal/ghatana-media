import React, { useMemo, useState } from 'react';
import { clsx } from 'clsx';
import { StudioView } from './StudioView';
import { StemSeparator } from '../audio/StemSeparator';
import { VoiceReplacementView } from './VoiceReplacementView';
import { EffectControls } from '../effects/EffectControls';
import { MixerView } from './MixerView';
import { QualityDashboard } from '../quality/QualityDashboard';

type ToolTab = 'separate' | 'replace' | 'effects' | 'mixer' | 'quality';

export const StudioWorkspace: React.FC = () => {
  const [tool, setTool] = useState<ToolTab>('replace');

  const tools = useMemo(
    () =>
      [
        { id: 'separate' as const, label: 'Separate' },
        { id: 'replace' as const, label: 'Replace' },
        { id: 'effects' as const, label: 'Effects' },
        { id: 'mixer' as const, label: 'Mixer' },
        { id: 'quality' as const, label: 'Quality' },
      ],
    []
  );

  return (
    <div className="flex-1 min-h-0 flex overflow-hidden">
      <div className="flex-1 min-h-0 overflow-auto">
        <StudioView />
      </div>

      <aside className="w-[420px] min-w-[360px] max-w-[520px] border-l border-gray-800 bg-gray-950/40 flex flex-col overflow-hidden">
        <div className="p-3 border-b border-gray-800">
          <div className="grid grid-cols-5 gap-1 rounded-lg bg-gray-800 p-1">
            {tools.map((t) => (
              <button
                key={t.id}
                onClick={() => setTool(t.id)}
                className={clsx(
                  'px-2 py-1.5 text-xs rounded-md transition-all',
                  tool === t.id
                    ? 'bg-gray-900 text-white'
                    : 'text-gray-300 hover:text-white hover:bg-gray-700'
                )}
                title={t.label}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-auto p-4">
          {tool === 'separate' && <StemSeparator />}
          {tool === 'replace' && <VoiceReplacementView />}
          {tool === 'effects' && <EffectControls />}
          {tool === 'mixer' && <MixerView />}
          {tool === 'quality' && <QualityDashboard />}
        </div>
      </aside>
    </div>
  );
};
