import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const catalogPath = resolve(root, 'frontend/src/features/playFinder/catalog.v1.json');
const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
const actions = new Set(['pick-and-roll', 'pick-and-pop', 'handoff', 'off-ball-screen', 'cut', 'drive-and-kick', 'isolation', 'transition']);
const ids = new Set();
const errors = [];
if (catalog.version !== 1 || !/^\d{4}-\d{2}-\d{2}$/.test(catalog.lastReviewed) || !Array.isArray(catalog.clips)) errors.push('Catalog needs version 1, a YYYY-MM-DD lastReviewed date, and a clips array');
for (const [index, clip] of (catalog.clips ?? []).entries()) {
  const prefix = `clips[${index}]`;
  if (!clip.id || ids.has(clip.id)) errors.push(`${prefix}: missing or duplicate id ${clip.id ?? ''}`);
  ids.add(clip.id);
  if (!clip.title || !clip.description) errors.push(`${prefix}: title and description are required`);
  if (!Array.isArray(clip.players) || !Array.isArray(clip.actions) || !Array.isArray(clip.evidence?.verifiedFields)) errors.push(`${prefix}: players, actions, and evidence.verifiedFields must be arrays`);
  if (new Set(clip.evidence?.verifiedFields ?? []).size !== (clip.evidence?.verifiedFields ?? []).length) errors.push(`${prefix}: evidence.verifiedFields contains duplicates`);
  for (const action of [...(clip.actions ?? []), ...(clip.sequence ?? [])]) if (!actions.has(action)) errors.push(`${prefix}: unknown action ${action}`);
  let sourceUrl;
  try { sourceUrl = new URL(clip.source?.url); } catch { /* reported below */ }
  if (!sourceUrl || sourceUrl.protocol !== 'https:' || !/(^|\.)nba\.com$/i.test(sourceUrl.hostname) || !clip.source.publisher || !clip.source.label) errors.push(`${prefix}: a labelled, public official NBA HTTPS source is required`);
  if (clip.source?.embedUrl && (!/^https:\/\/watch\.nba\.com\/embed\?/.test(clip.source.embedUrl))) errors.push(`${prefix}: embedded media must use the NBA's official player URL`);
  for (const optional of ['publishedAt', 'season']) if (clip[optional] && typeof clip[optional] !== 'string') errors.push(`${prefix}: ${optional} must be a string`);
  if (!['official-video-title', 'official-video-description', 'official-film-analysis'].includes(clip.evidence?.kind)) errors.push(`${prefix}: missing recognized evidence kind`);
}
if (catalog.clips.length < 40) errors.push(`Expected at least 40 curated clips; found ${catalog.clips.length}`);
const verifiedClips = catalog.clips.filter((clip) => clip.evidence?.verifiedFields?.includes('actions') && clip.actions?.length);
if (verifiedClips.length < 40) errors.push(`Expected at least 40 clips with a source-verified play action; found ${verifiedClips.length}`);
const actionCoverage = Object.fromEntries([...actions].map((action) => [action, verifiedClips.filter((clip) => clip.actions.includes(action)).length]));
for (const [action, count] of Object.entries(actionCoverage)) if (count === 0) errors.push(`No source-verified examples for ${action}`);
if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
const uniqueSources = new Set(catalog.clips.map((clip) => clip.source.url)).size;
console.log(`Play Finder catalog valid: ${catalog.clips.length} records from ${uniqueSources} official NBA pages; ${verifiedClips.length} action-verified clips; verified action coverage ${JSON.stringify(actionCoverage)}; reviewed ${catalog.lastReviewed}`);
