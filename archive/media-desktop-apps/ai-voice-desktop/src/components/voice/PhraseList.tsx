/**
 * AI Voice - Phrase List
 * 
 * @doc.type component
 * @doc.purpose Scrollable list of detected phrases
 * @doc.layer product
 * @doc.pattern Component
 */

import React from 'react';
import type { Phrase } from '../../types';
import { PhraseCard } from './PhraseCard';

interface PhraseListProps {
  phrases: Phrase[];
  selectedPhraseId: string | null;
  convertingPhraseId: string | null;
  onSelectPhrase: (phraseId: string) => void;
  onConvertPhrase: (phrase: Phrase) => void;
  onPlayPhrase: (phrase: Phrase) => void;
  onSelectTake: (phraseId: string, takeId: string) => void;
}

export const PhraseList: React.FC<PhraseListProps> = ({
  phrases,
  selectedPhraseId,
  convertingPhraseId,
  onSelectPhrase,
  onConvertPhrase,
  onPlayPhrase,
  onSelectTake,
}) => {
  if (phrases.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center text-gray-400">
          <p>No phrases detected</p>
          <p className="text-sm mt-1">Detect phrases from the Studio view</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto space-y-3 pr-2">
      {phrases.map((phrase, index) => (
        <PhraseCard
          key={phrase.id}
          phrase={phrase}
          index={index}
          isSelected={phrase.id === selectedPhraseId}
          isConverting={phrase.id === convertingPhraseId}
          onSelect={() => onSelectPhrase(phrase.id)}
          onConvert={() => onConvertPhrase(phrase)}
          onPlay={() => onPlayPhrase(phrase)}
          onSelectTake={(takeId) => onSelectTake(phrase.id, takeId)}
        />
      ))}
    </div>
  );
};
