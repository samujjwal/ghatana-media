/**
 * AI Voice Production Studio - Main Workspace
 * 
 * @doc.type component
 * @doc.purpose Main content area that switches between views
 * @doc.layer product
 * @doc.pattern Component
 */

import React from 'react';
import type { View } from '../../types';
import { useProject } from '../../context/ProjectContext';
import { SettingsView } from '../views/SettingsView';
import { StudioWorkspace } from '../views/StudioWorkspace';
import { ProjectsView } from '../views/ProjectsView';
import { LibraryView } from '../views/LibraryView';

interface MainWorkspaceProps {
  currentView: View;
}

export const MainWorkspace: React.FC<MainWorkspaceProps> = ({ currentView }) => {
  const { state } = useProject();

  const renderView = () => {
    switch (currentView) {
      case 'studio':
        return <StudioWorkspace />;
      case 'settings':
        return <SettingsView />;
      case 'projects':
        return <ProjectsView />;
      case 'library':
        return <LibraryView />;
      default:
        return <StudioWorkspace />;
    }
  };

  return (
    <main className="flex-1 min-h-0 bg-gray-900 flex flex-col">
      <div
        className={
          state.runtimeMode.mode === 'production'
            ? 'border-b border-emerald-800 bg-emerald-950/60 px-4 py-2 text-sm text-emerald-200'
            : state.runtimeMode.mode === 'demo'
              ? 'border-b border-blue-800 bg-blue-950/60 px-4 py-2 text-sm text-blue-200'
              : 'border-b border-amber-800 bg-amber-950/60 px-4 py-2 text-sm text-amber-200'
        }
      >
        <span className="font-medium mr-2">{state.runtimeMode.mode.toUpperCase()} mode</span>
        <span>{state.runtimeMode.reason}</span>
      </div>
      {renderView()}
    </main>
  );
};
