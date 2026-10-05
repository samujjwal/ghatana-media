import React from 'react';
import { ProjectManager } from '../storage/ProjectManager';

export const ProjectsView: React.FC = () => {
  return (
    <div className="flex-1 min-h-0 overflow-auto p-6">
      <ProjectManager />
    </div>
  );
};
