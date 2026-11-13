import { describe, expect, it } from 'vitest';
import { PaddleDocumentParserAdapter } from '../src/adapters/paddle-document-parser.js';

describe('Paddle adapter', () => { it('is present as the image parser adapter', () => { expect(PaddleDocumentParserAdapter).toBeDefined(); }); });
