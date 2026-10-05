import React, { useMemo, useState } from 'react';
import { clsx } from 'clsx';
import { VoicesView } from './VoicesView';
import { TrainingView } from './TrainingView';
import { ModelManager } from '../models/ModelManager';

type LibraryTab = 'voices' | 'training' | 'models';

export const LibraryView: React.FC = () => {
  const [tab, setTab] = useState<LibraryTab>('voices');

  const tabs = useMemo(
    () =>
      [
        { id: 'voices' as const, label: 'Voices' },
        { id: 'training' as const, label: 'Training' },
        { id: 'models' as const, label: 'Models' },
      ],
    []
  );

  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
      <div className="px-4 pt-4">
        <div className="inline-flex rounded-lg bg-gray-800 p-1 border border-gray-700">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={clsx(
                'px-3 py-1.5 text-sm rounded-md transition-all',
                tab === t.id
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

      <div className="flex-1 min-h-0 overflow-hidden">
        {tab === 'voices' && <VoicesView onOpenTraining={() => setTab('training')} />}
        {tab === 'training' && <TrainingView />}
        {tab === 'models' && (
          <div className="flex-1 min-h-0 overflow-auto p-6">
            <ModelManager />
          </div>
        )}
      </div>
    </div>
  );
};
