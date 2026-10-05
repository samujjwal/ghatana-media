/**
 * Project Manager UI Component
 *
 * Provides interface for:
 * - Listing projects
 * - Creating new projects
 * - Loading projects
 * - Deleting projects
 * - Exporting projects
 */

import React, { useState, useEffect } from 'react';
import { open, save } from '@tauri-apps/plugin-dialog';
import { createLogger, invokeWithLog } from '../../utils/logger';

const logger = createLogger('ProjectManager');

interface ProjectInfo {
  id: string;
  name: string;
  created: string;
  modified: string;
  track_count: number;
}

interface ProjectManagerProps {
  onLoadProject?: (projectId: string) => void;
  currentProjectId?: string;
}

export const ProjectManager: React.FC<ProjectManagerProps> = ({
  onLoadProject,
  currentProjectId
}) => {
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<'modified' | 'created' | 'name'>('modified');

  useEffect(() => {
    loadProjects();
  }, []);

  const loadProjects = async () => {
    try {
      setLoading(true);
      logger.info('LoadProjects:request');
      const storageDir = await invokeWithLog<string>(logger, 'get_project_storage_directory');
      const projectList = await invokeWithLog<ProjectInfo[]>(logger, 'list_audio_projects', {
        storage_directory: storageDir,
        storageDirectory: storageDir,
      });
      setProjects(projectList);
      logger.info('LoadProjects:success', { count: projectList.length });
    } catch (error) {
      logger.error('LoadProjects:error', {}, error);
    } finally {
      setLoading(false);
    }
  };

  const handleSeedExamples = async () => {
    try {
      logger.info('SeedExamples:request');
      await invokeWithLog<string[]>(logger, 'ai_voice_seed_example_projects', { count: 8 });
      logger.info('SeedExamples:success');
      await loadProjects();
      alert('Seeded example projects');
    } catch (error) {
      logger.error('SeedExamples:error', {}, error);
      alert('Failed to seed example projects');
    }
  };

  const handleCreateNew = async () => {
    const name = prompt('Enter project name:');
    if (!name) return;

    try {
      logger.info('CreateProject:request', { name });
      const project = {
        id: crypto.randomUUID(),
        name,
        created: new Date().toISOString(),
        modified: new Date().toISOString(),
        tracks: [],
        settings: {
          sample_rate: 44100,
          bit_depth: 24,
          tempo: 120.0,
          time_signature: [4, 4],
        },
        metadata: {
          author: 'User',
          description: '',
          tags: [],
          version: '1.0.0',
        },
      };

      const storageDir = await invokeWithLog<string>(logger, 'get_project_storage_directory');
      await invokeWithLog<void>(logger, 'save_audio_project', {
        project,
        storage_directory: storageDir,
        storageDirectory: storageDir,
      });
      await loadProjects();

      logger.info('CreateProject:success', { projectId: project.id, name });

      if (onLoadProject) {
        onLoadProject(project.id);
      }
    } catch (error) {
      logger.error('CreateProject:error', { name }, error);
      alert('Failed to create project');
    }
  };

  const handleLoad = async (projectId: string) => {
    logger.info('LoadProject:request', { projectId });
    if (onLoadProject) {
      onLoadProject(projectId);
    }
  };

  const handleDelete = async (projectId: string, projectName: string) => {
    if (!confirm(`Delete project "${projectName}"? This cannot be undone.`)) return;

    try {
      logger.info('DeleteProject:request', { projectId, projectName });
      const storageDir = await invokeWithLog<string>(logger, 'get_project_storage_directory');
      await invokeWithLog<void>(logger, 'delete_audio_project', {
        project_id: projectId,
        projectId,
        storage_directory: storageDir,
        storageDirectory: storageDir,
      });
      await loadProjects();

      logger.info('DeleteProject:success', { projectId, projectName });
    } catch (error) {
      logger.error('DeleteProject:error', { projectId, projectName }, error);
      alert('Failed to delete project');
    }
  };

  const handleExport = async (projectId: string, projectName: string) => {
    try {
      logger.info('ExportProject:dialog:request', { projectId, projectName });
      const exportPath = await save({
        defaultPath: `${projectName}.wav`,
        filters: [{
          name: 'Audio',
          extensions: ['wav', 'mp3', 'flac']
        }]
      });

      if (!exportPath) return;

      logger.info('ExportProject:dialog:result', { exportPath });

      const storageDir = await invokeWithLog<string>(logger, 'get_project_storage_directory');
      await invokeWithLog<void>(logger, 'export_audio_project', {
        project_id: projectId,
        projectId,
        export_file_path: exportPath,
        exportFilePath: exportPath,
        storage_directory: storageDir,
        storageDirectory: storageDir,
      });

      alert('Project exported successfully!');
      logger.info('ExportProject:success', { projectId, exportPath });
    } catch (error) {
      logger.error('ExportProject:error', { projectId, projectName }, error);
      alert('Failed to export project');
    }
  };

  const formatDate = (dateString: string): string => {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 60) return `${diffMins} minutes ago`;
    if (diffHours < 24) return `${diffHours} hours ago`;
    if (diffDays < 7) return `${diffDays} days ago`;
    return date.toLocaleDateString();
  };

  const filteredProjects = projects
    .filter(p => p.name.toLowerCase().includes(searchQuery.toLowerCase()))
    .sort((a, b) => {
      if (sortBy === 'name') return a.name.localeCompare(b.name);
      if (sortBy === 'created') return new Date(b.created).getTime() - new Date(a.created).getTime();
      return new Date(b.modified).getTime() - new Date(a.modified).getTime();
    });

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64" role="status" aria-label="Loading projects">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-purple-600"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold text-white">Projects</h2>
        <div className="flex gap-2">
          <button
            onClick={handleCreateNew}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg font-medium transition-colors"
          >
            New Project
          </button>
          <button
            onClick={handleSeedExamples}
            className="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded-lg font-medium transition-colors"
            title="Generate 5-10 example projects for testing"
          >
            Seed Examples
          </button>
        </div>
      </div>

      {/* Search and Sort */}
      <div className="flex gap-4">
        <div className="flex-1">
          <input
            type="text"
            placeholder="Search projects..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600
                     rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white
                     focus:ring-2 focus:ring-purple-600 focus:border-transparent"
          />
        </div>

        <select
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value as any)}
          className="px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg
                   bg-white dark:bg-gray-800 text-gray-900 dark:text-white
                   focus:ring-2 focus:ring-purple-600 focus:border-transparent"
        >
          <option value="modified">Last Modified</option>
          <option value="created">Date Created</option>
          <option value="name">Name</option>
        </select>
      </div>

      {/* Projects Grid */}
      {filteredProjects.length === 0 ? (
        <div className="text-center py-16">
          <svg
            className="mx-auto h-12 w-12 text-gray-400"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M9 13h6m-3-3v6m5 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
            />
          </svg>
          <h3 className="mt-2 text-sm font-medium text-gray-900 dark:text-white">
            No projects
          </h3>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Get started by creating a new project.
          </p>
          <button
            onClick={handleCreateNew}
            className="mt-4 px-4 py-2 text-sm font-medium text-purple-600
                     hover:text-purple-700 border border-purple-300 rounded-lg
                     hover:bg-purple-50 dark:hover:bg-purple-900/20"
          >
            Create Project
          </button>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {filteredProjects.map(project => (
            <div
              key={project.id}
              className={`bg-white dark:bg-gray-800 rounded-lg border-2 p-6
                       hover:shadow-lg transition-all cursor-pointer
                       ${currentProjectId === project.id
                         ? 'border-purple-600 shadow-md'
                         : 'border-gray-200 dark:border-gray-700'}`}
              onClick={() => handleLoad(project.id)}
            >
              <div className="flex items-start justify-between mb-4">
                <div className="flex-1 min-w-0">
                  <h3 className="text-lg font-semibold text-gray-900 dark:text-white truncate">
                    {project.name}
                  </h3>
                  <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                    {project.track_count} track{project.track_count !== 1 ? 's' : ''}
                  </p>
                </div>

                {currentProjectId === project.id && (
                  <span className="px-2 py-1 text-xs font-medium text-purple-600
                               bg-purple-100 dark:bg-purple-900/30 rounded">
                    Current
                  </span>
                )}
              </div>

              <div className="text-xs text-gray-500 dark:text-gray-400 space-y-1 mb-4">
                <div>Modified: {formatDate(project.modified)}</div>
                <div>Created: {formatDate(project.created)}</div>
              </div>

              <div className="flex gap-2">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleExport(project.id, project.name);
                  }}
                  className="flex-1 px-3 py-2 text-sm font-medium text-gray-700
                           dark:text-gray-300 border border-gray-300 dark:border-gray-600
                           rounded hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
                >
                  Export
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDelete(project.id, project.name);
                  }}
                  className="px-3 py-2 text-sm font-medium text-red-600
                           border border-red-300 rounded hover:bg-red-50
                           dark:hover:bg-red-900/20 transition-colors"
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
