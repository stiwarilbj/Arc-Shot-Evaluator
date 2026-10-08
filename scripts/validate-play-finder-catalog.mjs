// Generated indexes live on nba-clip-data, not in the application source tree.
import { access } from 'node:fs/promises';
try {await access(new URL('../frontend/src/features/playFinder/catalog.v1.json',import.meta.url));throw new Error('Legacy article catalog must not ship in the application');}
catch(error){if(error.code!=='ENOENT')throw error;}
console.log('Play Finder uses individual-event index assets');
