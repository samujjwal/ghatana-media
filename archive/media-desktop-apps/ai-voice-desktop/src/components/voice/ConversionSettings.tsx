/**
 * AI Voice - Conversion Settings Panel
 * 
 * @doc.type component
 * @doc.purpose Voice conversion parameter controls
 * @doc.layer product
 * @doc.pattern Component
 */

import React from 'react';

export interface ConversionSettingsData {
  pitchShift: number;
  formantShift: number;
  indexRatio: number;
  rmsMixRate: number;
  protectVoiceless: number;
}

export const defaultConversionSettings: ConversionSettingsData = {
  pitchShift: 0,
  formantShift: 0,
  indexRatio: 0.75,
  rmsMixRate: 0.25,
  protectVoiceless: 0.33,
};

interface ConversionSettingsProps {
  settings: ConversionSettingsData;
  onChange: (key: keyof ConversionSettingsData, value: number) => void;
  onReset: () => void;
}

export const ConversionSettings: React.FC<ConversionSettingsProps> = ({
  settings,
  onChange,
  onReset,
}) => {
  return (
    <div className="bg-gray-800 rounded-lg p-4">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-medium text-white">Conversion Settings</h3>
        <button
          onClick={onReset}
          className="text-sm text-gray-400 hover:text-white"
        >
          Reset
        </button>
      </div>

      <div className="space-y-4">
        <SettingSlider
          label="Pitch Shift"
          value={settings.pitchShift}
          min={-12}
          max={12}
          step={1}
          unit="st"
          onChange={(v) => onChange('pitchShift', v)}
        />

        <SettingSlider
          label="Formant Shift"
          value={settings.formantShift}
          min={-1}
          max={1}
          step={0.1}
          onChange={(v) => onChange('formantShift', v)}
        />

        <SettingSlider
          label="Index Ratio"
          value={settings.indexRatio}
          min={0}
          max={1}
          step={0.05}
          onChange={(v) => onChange('indexRatio', v)}
        />

        <SettingSlider
          label="RMS Mix Rate"
          value={settings.rmsMixRate}
          min={0}
          max={1}
          step={0.05}
          onChange={(v) => onChange('rmsMixRate', v)}
        />

        <SettingSlider
          label="Protect Voiceless"
          value={settings.protectVoiceless}
          min={0}
          max={0.5}
          step={0.01}
          onChange={(v) => onChange('protectVoiceless', v)}
        />
      </div>
    </div>
  );
};

interface SettingSliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  onChange: (value: number) => void;
}

const SettingSlider: React.FC<SettingSliderProps> = ({
  label,
  value,
  min,
  max,
  step,
  unit = '',
  onChange,
}) => {
  return (
    <div>
      <div className="flex justify-between text-sm text-gray-300 mb-2">
        <span>{label}</span>
        <span>{value.toFixed(step < 1 ? 2 : 0)}{unit}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-full h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer"
      />
    </div>
  );
};
