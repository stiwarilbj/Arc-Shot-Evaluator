export interface Participant { id: number; name: string; team: string; role: string }
export interface PlayClip {
  id: string; gameId: string; eventId: number; title: string; description: string;
  season: string; phase: string; date: string; home: string; away: string;
  team: string | null; opponent: string | null; participants: Participant[];
  eventType: string; subType: string; outcome: string; shotDistance: number | null;
  shotValue?: number; period: number; clock: number; scoreHome?: string; scoreAway?: string;
  mp4?: string; detailPath?: string; thumbnail?: string; eventUrl: string; semanticText: string;
}
export type SearchField = 'player' | 'team' | 'opponent' | 'season' | 'date' | 'phase' | 'eventType' | 'outcome' | 'shotDistance' | 'shotValue' | 'period' | 'clock' | 'role' | 'description';
export interface PlayCondition {
  id: string; field: SearchField; value: string;
  operator: 'equals' | 'excludes' | 'includes' | 'lt' | 'lte' | 'gt' | 'gte' | 'range';
  status: 'ready' | 'unsupported' | 'ambiguous'; candidates?: string[]; origin: 'prompt' | 'filter';
}
export interface SearchResult { clip: PlayClip; score: number; why: string[] }
export interface FilmCollection { id: string; name: string; clipIds: string[]; notesByClip: Record<string, string>; snapshots?: Record<string, PlayClip>; createdAt: string; updatedAt: string }
export interface CollectionBackup { version: 1 | 2; exportedAt: string; collections: FilmCollection[] }
export interface IndexShard { path: string; season: string; from: string; to: string; teams: string[]; players: number[]; count: number; bytes: number; sha256: string }
export interface ClipManifest {
  version: 2; clips: number; lastSuccessfulUpdate: string;
  coverage: Record<string, { games: number; clips: number; unresolved: number; scheduledGames: number; complete: boolean; phases: Record<string, number> }>;
  players: { id: number; name: string }[]; shards: IndexShard[];
  model: { id: string; revision: string; dtype: 'q8'; dimensions: number; embeddings: string };
}
export interface SearchRequest { id: number; type: 'search'; prompt: string; conditions: PlayCondition[]; sort: 'relevance' | 'date'; page: number; pageSize: number }
export type WorkerRequest = SearchRequest | { id: number; type: 'init'; base: string } | { id: number; type: 'cancel' } | { id: number; type: 'dispose' };
export type WorkerResponse = { id: number; type: 'ready'; manifest: ClipManifest } | { id: number; type: 'status'; message: string } | { id: number; type: 'results'; results: SearchResult[]; total: number; mode: 'semantic' | 'keyword'; message?: string } | { id: number; type: 'error'; message: string };
