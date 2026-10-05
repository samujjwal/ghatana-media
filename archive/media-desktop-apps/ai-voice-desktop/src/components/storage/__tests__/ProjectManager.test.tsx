/**
 * ProjectManager Component Tests
 *
 * Tests project management functionality:
 * - Project listing
 * - Project creation
 * - Project loading
 * - Project deletion
 * - Project export
 * - Search and sort
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { ProjectManager } from '../ProjectManager';

const mockInvoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: any[]) => mockInvoke(...args),
}));

const mockSave = vi.fn();
vi.mock('@tauri-apps/plugin-dialog', () => ({
  save: (...args: any[]) => mockSave(...args),
}));

const mockProjects = [
  {
    id: 'project-1',
    name: 'My First Project',
    created: '2025-12-01T10:00:00Z',
    modified: '2025-12-10T15:30:00Z',
    track_count: 3,
  },
  {
    id: 'project-2',
    name: 'Podcast Episode',
    created: '2025-12-05T12:00:00Z',
    modified: '2025-12-11T09:00:00Z',
    track_count: 5,
  },
];

describe('ProjectManager', () => {
  beforeEach(() => {
    mockInvoke.mockClear();
    mockSave.mockClear();
  });

  describe('Initial Render', () => {
    it('should show loading state initially', () => {
      mockInvoke.mockImplementation(() => new Promise(() => {}));

      render(<ProjectManager />);

      expect(screen.getByRole('status')).toBeInTheDocument();
    });

    it('should display header and create button', async () => {
      mockInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'get_project_storage_directory') return Promise.resolve('/path/to/storage');
        if (cmd === 'list_audio_projects') return Promise.resolve([]);
        return Promise.resolve();
      });

      render(<ProjectManager />);

      await waitFor(() => {
        expect(screen.getByText('Projects')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /new project/i })).toBeInTheDocument();
      });
    });
  });

  describe('Project Listing', () => {
    it('should display list of projects', async () => {
      mockInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'get_project_storage_directory') return Promise.resolve('/path/to/storage');
        if (cmd === 'list_audio_projects') return Promise.resolve(mockProjects);
        return Promise.resolve();
      });

      render(<ProjectManager />);

      await waitFor(() => {
        expect(screen.getByText('My First Project')).toBeInTheDocument();
        expect(screen.getByText('Podcast Episode')).toBeInTheDocument();
      });
    });

    it('should show track counts', async () => {
      mockInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'get_project_storage_directory') return Promise.resolve('/path/to/storage');
        if (cmd === 'list_audio_projects') return Promise.resolve(mockProjects);
        return Promise.resolve();
      });

      render(<ProjectManager />);

      await waitFor(() => {
        expect(screen.getByText('3 tracks')).toBeInTheDocument();
        expect(screen.getByText('5 tracks')).toBeInTheDocument();
      });
    });

    it('should show empty state when no projects', async () => {
      mockInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'get_project_storage_directory') return Promise.resolve('/path/to/storage');
        if (cmd === 'list_audio_projects') return Promise.resolve([]);
        return Promise.resolve();
      });

      render(<ProjectManager />);

      await waitFor(() => {
        expect(screen.getByText(/no projects/i)).toBeInTheDocument();
        expect(screen.getByText(/get started by creating/i)).toBeInTheDocument();
      });
    });

    it('should highlight current project', async () => {
      mockInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'get_project_storage_directory') return Promise.resolve('/path/to/storage');
        if (cmd === 'list_audio_projects') return Promise.resolve(mockProjects);
        return Promise.resolve();
      });

      render(<ProjectManager currentProjectId="project-1" />);

      await waitFor(() => {
        const currentBadge = screen.getByText('Current');
        expect(currentBadge).toBeInTheDocument();
      });
    });
  });

  describe('Project Creation', () => {
    it('should create new project with prompt', async () => {
      const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('New Test Project');

      mockInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'get_project_storage_directory') return Promise.resolve('/path/to/storage');
        if (cmd === 'list_audio_projects') return Promise.resolve([]);
        if (cmd === 'save_audio_project') return Promise.resolve('/path/to/project');
        return Promise.resolve();
      });

      render(<ProjectManager />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /new project/i })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: /new project/i }));

      expect(promptSpy).toHaveBeenCalled();

      await waitFor(() => {
        expect(mockInvoke).toHaveBeenCalledWith('save_audio_project', expect.objectContaining({
          project: expect.objectContaining({
            name: 'New Test Project',
          }),
        }));
      });

      promptSpy.mockRestore();
    });

    it('should not create project if prompt cancelled', async () => {
      const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue(null);

      mockInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'get_project_storage_directory') return Promise.resolve('/path/to/storage');
        if (cmd === 'list_audio_projects') return Promise.resolve([]);
        return Promise.resolve();
      });

      render(<ProjectManager />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /new project/i })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: /new project/i }));

      expect(promptSpy).toHaveBeenCalled();
      expect(mockInvoke).not.toHaveBeenCalledWith('save_audio_project', expect.anything());

      promptSpy.mockRestore();
    });

    it('should call onLoadProject after creation', async () => {
      const onLoadProject = vi.fn();
      const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('New Project');

      mockInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'get_project_storage_directory') return Promise.resolve('/path/to/storage');
        if (cmd === 'list_audio_projects') return Promise.resolve([]);
        if (cmd === 'save_audio_project') return Promise.resolve('/path/to/project');
        return Promise.resolve();
      });

      render(<ProjectManager onLoadProject={onLoadProject} />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /new project/i })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: /new project/i }));

      await waitFor(() => {
        expect(onLoadProject).toHaveBeenCalledWith(expect.any(String));
      });

      promptSpy.mockRestore();
    });
  });

  describe('Project Loading', () => {
    it('should load project on click', async () => {
      const onLoadProject = vi.fn();

      mockInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'get_project_storage_directory') return Promise.resolve('/path/to/storage');
        if (cmd === 'list_audio_projects') return Promise.resolve(mockProjects);
        return Promise.resolve();
      });

      render(<ProjectManager onLoadProject={onLoadProject} />);

      await waitFor(() => {
        expect(screen.getByText('My First Project')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('My First Project'));

      expect(onLoadProject).toHaveBeenCalledWith('project-1');
    });
  });

  describe('Project Deletion', () => {
    it('should delete project with confirmation', async () => {
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

      mockInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'get_project_storage_directory') return Promise.resolve('/path/to/storage');
        if (cmd === 'list_audio_projects') return Promise.resolve(mockProjects);
        if (cmd === 'delete_audio_project') return Promise.resolve();
        return Promise.resolve();
      });

      render(<ProjectManager />);

      await waitFor(() => {
        expect(screen.getAllByRole('button', { name: /delete/i })[0]).toBeInTheDocument();
      });

      fireEvent.change(screen.getByRole('combobox'), { target: { value: 'name' } });
      fireEvent.click(screen.getAllByRole('button', { name: /delete/i })[0]);

      expect(confirmSpy).toHaveBeenCalled();

      await waitFor(() => {
        expect(mockInvoke).toHaveBeenCalledWith('delete_audio_project', expect.objectContaining({
          projectId: 'project-1',
        }));
      });

      confirmSpy.mockRestore();
    });

    it('should not delete if confirmation cancelled', async () => {
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);

      mockInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'get_project_storage_directory') return Promise.resolve('/path/to/storage');
        if (cmd === 'list_audio_projects') return Promise.resolve(mockProjects);
        return Promise.resolve();
      });

      render(<ProjectManager />);

      await waitFor(() => {
        expect(screen.getAllByRole('button', { name: /delete/i })[0]).toBeInTheDocument();
      });

      fireEvent.click(screen.getAllByRole('button', { name: /delete/i })[0]);

      expect(confirmSpy).toHaveBeenCalled();
      expect(mockInvoke).not.toHaveBeenCalledWith('delete_audio_project', expect.anything());

      confirmSpy.mockRestore();
    });
  });

  describe('Project Export', () => {
    it('should export project with file dialog', async () => {
      mockSave.mockResolvedValue('/path/to/export.wav');

      mockInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'get_project_storage_directory') return Promise.resolve('/path/to/storage');
        if (cmd === 'list_audio_projects') return Promise.resolve(mockProjects);
        if (cmd === 'export_audio_project') return Promise.resolve('/path/to/export.wav');
        return Promise.resolve();
      });

      const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});

      render(<ProjectManager />);

      await waitFor(() => {
        expect(screen.getAllByRole('button', { name: /export/i })[0]).toBeInTheDocument();
      });

      fireEvent.click(screen.getAllByRole('button', { name: /export/i })[0]);

      await waitFor(() => {
        expect(mockSave).toHaveBeenCalled();
        expect(mockInvoke).toHaveBeenCalledWith('export_audio_project', expect.any(Object));
        expect(alertSpy).toHaveBeenCalledWith('Project exported successfully!');
      });

      alertSpy.mockRestore();
    });

    it('should not export if dialog cancelled', async () => {
      mockSave.mockResolvedValue(null);

      mockInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'get_project_storage_directory') return Promise.resolve('/path/to/storage');
        if (cmd === 'list_audio_projects') return Promise.resolve(mockProjects);
        return Promise.resolve();
      });

      render(<ProjectManager />);

      await waitFor(() => {
        expect(screen.getAllByRole('button', { name: /export/i })[0]).toBeInTheDocument();
      });

      fireEvent.click(screen.getAllByRole('button', { name: /export/i })[0]);

      await waitFor(() => {
        expect(mockSave).toHaveBeenCalled();
      });

      expect(mockInvoke).not.toHaveBeenCalledWith('export_audio_project', expect.anything());
    });
  });

  describe('Search and Filter', () => {
    it('should filter projects by search query', async () => {
      mockInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'get_project_storage_directory') return Promise.resolve('/path/to/storage');
        if (cmd === 'list_audio_projects') return Promise.resolve(mockProjects);
        return Promise.resolve();
      });

      render(<ProjectManager />);

      await waitFor(() => {
        expect(screen.getByPlaceholderText(/search projects/i)).toBeInTheDocument();
      });

      const searchInput = screen.getByPlaceholderText(/search projects/i);
      fireEvent.change(searchInput, { target: { value: 'Podcast' } });

      await waitFor(() => {
        expect(screen.getByText('Podcast Episode')).toBeInTheDocument();
        expect(screen.queryByText('My First Project')).not.toBeInTheDocument();
      });
    });

    it('should sort projects by modified date', async () => {
      mockInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'get_project_storage_directory') return Promise.resolve('/path/to/storage');
        if (cmd === 'list_audio_projects') return Promise.resolve(mockProjects);
        return Promise.resolve();
      });

      render(<ProjectManager />);

      await waitFor(() => {
        const sortSelect = screen.getByDisplayValue(/last modified/i);
        expect(sortSelect).toBeInTheDocument();
      });
    });

    it('should sort projects by name', async () => {
      mockInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'get_project_storage_directory') return Promise.resolve('/path/to/storage');
        if (cmd === 'list_audio_projects') return Promise.resolve(mockProjects);
        return Promise.resolve();
      });

      render(<ProjectManager />);

      await waitFor(() => {
        const sortSelect = screen.getByDisplayValue(/last modified/i);
        fireEvent.change(sortSelect, { target: { value: 'name' } });
      });

      await waitFor(() => {
        const projectCards = screen.getAllByRole('button', { name: /export|delete/i });
        expect(projectCards.length).toBeGreaterThan(0);
      });
    });
  });

  describe('Error Handling', () => {
    it('should handle list projects error', async () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

      mockInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'get_project_storage_directory') return Promise.resolve('/path/to/storage');
        if (cmd === 'list_audio_projects') return Promise.reject(new Error('Database error'));
        return Promise.resolve();
      });

      render(<ProjectManager />);

      await waitFor(() => {
        expect(consoleError).toHaveBeenCalled();
      });

      consoleError.mockRestore();
    });

    it('should handle export error', async () => {
      const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
      mockSave.mockResolvedValue('/path/to/export.wav');

      mockInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'get_project_storage_directory') return Promise.resolve('/path/to/storage');
        if (cmd === 'list_audio_projects') return Promise.resolve(mockProjects);
        if (cmd === 'export_audio_project') return Promise.reject(new Error('Export failed'));
        return Promise.resolve();
      });

      render(<ProjectManager />);

      await waitFor(() => {
        expect(screen.getAllByRole('button', { name: /export/i })[0]).toBeInTheDocument();
      });

      fireEvent.click(screen.getAllByRole('button', { name: /export/i })[0]);

      await waitFor(() => {
        expect(alertSpy).toHaveBeenCalledWith('Failed to export project');
      });

      alertSpy.mockRestore();
    });
  });
});
