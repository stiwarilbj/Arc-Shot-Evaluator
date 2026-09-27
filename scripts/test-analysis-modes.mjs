import assert from 'node:assert/strict';
import { browserSamplingPlan, isProcessingMode, processingModeLabel, PROCESSING_MODE_OPTIONS } from '../frontend/src/domain/analysisModes.ts';

assert.deepEqual(PROCESSING_MODE_OPTIONS.map((option) => option.value), ['fast', 'normal', 'deep']);
assert.deepEqual(PROCESSING_MODE_OPTIONS.map((option) => option.label), ['Fast', 'Normal', 'Deep']);
assert.deepEqual(browserSamplingPlan('fast', 20), { sampleCount: 25, candidateLimit: 3 });
assert.deepEqual(browserSamplingPlan('normal', 20), { sampleCount: 50, candidateLimit: 5 });
assert.deepEqual(browserSamplingPlan('deep', 20), { sampleCount: 72, candidateLimit: 5 });
assert.deepEqual(browserSamplingPlan('fast', 0), { sampleCount: 8, candidateLimit: 3 });
assert.ok(browserSamplingPlan('fast', 20).sampleCount < browserSamplingPlan('normal', 20).sampleCount);
assert.ok(browserSamplingPlan('normal', 20).sampleCount < browserSamplingPlan('deep', 20).sampleCount);
assert.equal(isProcessingMode('fast'), true);
assert.equal(isProcessingMode('normal'), true);
assert.equal(isProcessingMode('deep'), true);
assert.equal(isProcessingMode('turbo'), false);
assert.equal(processingModeLabel('deep'), 'Deep');
assert.equal(processingModeLabel(undefined), 'Normal');

console.log('Analysis mode tests passed: fast sampling, standard sampling, deeper sampling, candidate limits, and mode fallback');
