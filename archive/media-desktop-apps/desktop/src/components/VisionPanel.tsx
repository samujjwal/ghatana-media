/**
 * @doc.type component
 * @doc.purpose Computer Vision panel component
 * @doc.layer application
 * @doc.pattern service panel
 */

import React from 'react';
import { Card, Button } from '@audio-video/ui';

const VISION_STATUS_MESSAGE =
  'Computer Vision analysis is disabled until the desktop app is integrated with the production vision service.';

const VisionPanel: React.FC = () => {
  const [selectedImage, setSelectedImage] = React.useState<string | null>(null);

  const handleImageUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (e) => setSelectedImage(e.target?.result as string);
      reader.readAsDataURL(file);
    }
  };

  return (
    <div className="space-y-6">
      <Card title="Computer Vision" subtitle="Analyze images with AI">
        <div className="space-y-6">
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-900/30 dark:text-amber-100">
            <p className="font-medium">Unavailable in this build</p>
            <p className="mt-1">{VISION_STATUS_MESSAGE}</p>
          </div>

          {/* Image Upload */}
          <div className="space-y-2">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
              Upload Image
            </label>
            <input
              type="file"
              accept="image/*"
              onChange={handleImageUpload}
              className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 dark:bg-gray-700 dark:border-gray-600 dark:text-white"
            />
          </div>

          {/* Image Preview */}
          {selectedImage && (
            <div className="space-y-2">
              <h3 className="text-lg font-medium text-gray-900 dark:text-white">Preview</h3>
              <img
                src={selectedImage}
                alt="Selected"
                className="w-full max-w-md mx-auto rounded-lg border border-gray-300 dark:border-gray-600"
              />
            </div>
          )}

          {/* Process Button */}
          {selectedImage && (
            <Button
              disabled
              className="w-full"
            >
              Vision Analysis Unavailable In This Build
            </Button>
          )}
        </div>
      </Card>
    </div>
  );
};

export default VisionPanel;
