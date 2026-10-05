/**
 * AI Voice Production Studio - Main Application
 * 
 * @doc.type component
 * @doc.purpose Main application entry point
 * @doc.layer product
 * @doc.pattern Component
 */

import React, { useState, useCallback } from 'react';
import { Provider } from 'jotai';
import { Sidebar } from './components/layout/Sidebar';
import { MainWorkspace } from './components/layout/MainWorkspace';
import { TopBar } from './components/layout/TopBar';
import { ProjectProvider } from './context/ProjectContext';
import type { View } from './types';

function App() {
  const [currentView, setCurrentView] = useState<View>('studio');

  const handleViewChange = useCallback((view: View) => {
    setCurrentView(view);
  }, []);

  return (
    <Provider>
      <ProjectProvider>
        <div className="flex h-screen bg-gray-900 text-white overflow-hidden">
          <Sidebar currentView={currentView} onViewChange={handleViewChange} />
          <div className="flex-1 flex flex-col overflow-hidden min-h-0">
            <TopBar />
            <MainWorkspace currentView={currentView} />
          </div>
        </div>
      </ProjectProvider>
    </Provider>
  );
}

export default App;
