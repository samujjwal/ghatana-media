import React from 'react';
import ReactDOM from 'react-dom/client';
import { ErrorBoundary } from '@ghatana/design-system';
import App from './App';
import './index.css';
import { createLogger, installGlobalErrorHandlers } from './utils/logger';

const logger = createLogger('App');
installGlobalErrorHandlers(logger);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
