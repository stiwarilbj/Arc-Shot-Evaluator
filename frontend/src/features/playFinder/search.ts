import type { PlayClip, PlayCondition, SearchField, ClipManifest, IndexShard } from './types';
export const FIELD_LABELS: Record<SearchField, string> = {player:'Player',team:'Team',opponent:'Opponent',season:'Season',date:'Date',phase:'Season stage',eventType:'Event type',outcome:'Outcome',shotDistance:'Shot distance (ft)',shotValue:'Shot points',period:'Quarter / OT',clock:'Clock (seconds)',role:'Recorded role',description:'Play wording'};
export const TEAM_ALIASES: Record<string, string[]> = {
 ATL:['atlanta','hawks'],BOS:['boston','celtics'],BKN:['brooklyn','nets'],CHA:['charlotte','hornets'],CHI:['chicago','bulls'],CLE:['cleveland','cavaliers','cavs'],DAL:['dallas','mavericks','mavs'],DEN:['denver','nuggets'],DET:['detroit','pistons'],GSW:['golden state','warriors'],HOU:['houston','rockets'],IND:['indiana','pacers'],LAC:['clippers','la clippers'],LAL:['lakers','la lakers'],MEM:['memphis','grizzlies'],MIA:['miami','heat'],MIL:['milwaukee','bucks'],MIN:['minnesota','timberwolves','wolves'],NOP:['new orleans','pelicans'],NYK:['new york','knicks'],OKC:['oklahoma city','thunder'],ORL:['orlando','magic'],PHI:['philadelphia','76ers','sixers'],PHX:['phoenix','suns'],POR:['portland','blazers','trail blazers'],SAC:['sacramento','kings'],SAS:['san antonio','spurs'],TOR:['toronto','raptors'],UTA:['utah','jazz'],WAS:['washington','wizards']
};
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
export const normalize = (text: string) => text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[’']/g,'').replace(/-/g,' ');
export function makeFilterCondition(field: SearchField, value: string, operator: PlayCondition['operator'] = 'equals'): PlayCondition {
 return {id: `${field}-${Math.random().toString(36).slice(2)}`, field,value:value.trim(),operator,status:'ready',origin:'filter'};
}
export function resolveAmbiguousCondition(condition: PlayCondition, value: string): PlayCondition { return {...condition,value,status:'ready'}; }
export function parsePlayPrompt(prompt: string, players: ClipManifest['players'] = []): PlayCondition[] {
 const text = normalize(prompt), conditions: PlayCondition[] = [];
 const add = (field: SearchField, value: string, operator: PlayCondition['operator']='equals') => {const c=makeFilterCondition(field,value,operator);c.origin='prompt';conditions.push(c);return c;};
 const playerMatches = new Map<string, string[]>();
 for (const player of players) {
   const full=normalize(player.name), surname=full.split(' ').at(-1)!;
   const term = new RegExp(`\\b${escape(full)}\\b`).test(text) ? full : surname.length>2 && new RegExp(`\\b${escape(surname)}\\b`).test(text) ? surname : null;
   if (term) playerMatches.set(term,[...(playerMatches.get(term)??[]), player.name]);
 }
 for (const [term,names] of playerMatches) {
   if ([...playerMatches.keys()].some(other=>other!==term && other.includes(term))) continue;
   const excluded=new RegExp(`(?:without|excluding|except|not)\\s+${escape(term)}\\b`).test(text);
   const c=add('player',names.length===1?names[0]:term,excluded?'excludes':'equals');
   if(names.length>1){c.status='ambiguous';c.candidates=names;}
 }
 for (const [team, aliases] of Object.entries(TEAM_ALIASES)) {
   const alias=[team.toLowerCase(),...aliases].sort((a,b)=>b.length-a.length).find(a=>new RegExp(`\\b${escape(a)}\\b`).test(text));
   if(!alias)continue;
   const opponent=new RegExp(`(?:against|versus|vs\\.?)\\s+(?:the\\s+)?${escape(alias)}\\b`).test(text);
   const excluded=new RegExp(`(?:without|excluding|except|not)\\s+(?:the\\s+)?${escape(alias)}\\b`).test(text);
   add(opponent?'opponent':'team',team,excluded?'excludes':'equals');
 }
 const season=text.match(/\b(20\d{2})[ /](\d{2}|20\d{2})\b/); if(season)add('season',`${season[1]}-${season[2].slice(-2)}`);
 const playoffYear=text.match(/\b(20\d{2})\s+playoffs\b/);if(playoffYear)add('season',`${+playoffYear[1]-1}-${playoffYear[1].slice(-2)}`);
 if(/\bplayoffs|postseason\b/.test(text))add('phase','playoffs');if(/\bplay in\b/.test(text))add('phase','play-in');if(/\bregular season\b/.test(text))add('phase','regular');
 const quarter=text.match(/\b(?:q|quarter\s*)([1-4])\b/)??text.match(/\b([1-4])(?:st|nd|rd|th)?\s+quarter\b/);
 if(quarter)add('period',quarter[1]);
 else {const word=text.match(/\b(first|second|third|fourth) quarter\b/);if(word)add('period',String(['first','second','third','fourth'].indexOf(word[1])+1));}
 const ot=text.match(/\b(?:ot\s*(\d+)|(\d+)(?:st|nd|rd|th)? overtime)\b/);if(ot)add('period',String(4+Number(ot[1]||ot[2])));else if(/\bovertime|\bot\b/.test(text))add('period','4','gt');
 const quantities:Record<string,string>={one:'1',two:'2',three:'3',four:'4',five:'5',six:'6',ten:'10'};
 const clock=text.match(/\b(under|less than|fewer than|at most|more than|over)\s+(\d+(?:\.\d+)?|one|two|three|four|five|six|ten)\s+seconds?\b/);
 if(clock)add('clock',quantities[clock[2]]??clock[2],/under|less|fewer/.test(clock[1])?'lt':clock[1]==='at most'?'lte':'gt');
 const fractional=text.match(/\b(\d{1,2}):(\d{2}(?:\.\d+)?)\b/);if(fractional)add('clock',String(Number(fractional[1])*60+Number(fractional[2])));
 const date=text.match(/\b(on|after|before)\s+(20\d{2}-\d{2}-\d{2})\b/);if(date)add('date',date[2],date[1]==='after'?'gt':date[1]==='before'?'lt':'equals');
 const distance=text.match(/\b(under|over|from|within)\s+(\d+(?:\.\d+)?)\s*(?:feet|foot|ft)\b/);if(distance)add('shotDistance',distance[2],distance[1]==='over'?'gt':distance[1]==='from'?'equals':'lte');
 for(const [regex,field,value] of [[/\bthrees?|three pointers?|3 pointers?\b/,'shotValue','3'],[/\bturnovers?\b/,'eventType','turnover'],[/\brebounds?\b/,'eventType','rebound'],[/\bfouls?\b/,'eventType','foul'],[/\bmiss(?:ed|es)?\b/,'outcome','missed'],[/\bmade|makes?\b/,'outcome','made'],[/\bstep back\b/,'description','step back'],[/\bdunks?\b/,'description','dunk'],[/\blayups?\b/,'description','layup']] as [RegExp,SearchField,string][]) {
   const match=text.match(regex);if(match){const before=text.slice(Math.max(0,match.index!-20),match.index);add(field,value,/\b(without|excluding|except|not)\s*$/.test(before)?'excludes':field==='description'?'includes':'equals');}
 }
 for(const [term,role] of [['assists?','assister'],['blocks?','blocker'],['steals?','stealer']] as const)if(new RegExp(`\\b${term}\\b`).test(text))add('role',role);
 if(/\b(defender|guarded by|pick and roll|handoff|drop coverage|switching|backdoor)\b/.test(text)){const c=add('description','Tactical / defender evidence is unavailable');c.status='unsupported';}
 return conditions;
}
function compare(actual: unknown, condition: PlayCondition): boolean {
 if(actual==null)return false;
 const {operator,value}=condition;
 if(operator==='lt'||operator==='lte'||operator==='gt'||operator==='gte') {
  const a=condition.field==='date'?String(actual):Number(actual),b=condition.field==='date'?value:Number(value);
  return operator==='lt'?a<b:operator==='lte'?a<=b:operator==='gt'?a>b:a>=b;
 }
 if(operator==='range'){const [low,high]=value.split('..');return condition.field==='date'?String(actual)>=low&&String(actual)<=high:Number(actual)>=Number(low)&&Number(actual)<=Number(high);}
 if(operator==='includes'||condition.field==='description')return normalize(String(actual)).includes(normalize(value));
 return normalize(String(actual))===normalize(value);
}
export function matchesClip(clip: PlayClip, conditions: PlayCondition[]): boolean {
 return conditions.every(c=>{
  if(c.status!=='ready')return false;
  let matched=false;
  if(c.field==='player')matched=clip.participants.some(p=>compare(p.name,{...c,operator:'equals'}));
  else if(c.field==='role')matched=clip.participants.some(p=>p.role===c.value && conditions.filter(f=>f.field==='player'&&f.operator!=='excludes').every(f=>normalize(p.name)===normalize(f.value)));
  else matched=compare(clip[c.field],c.operator==='excludes'?{...c,operator:'equals'}:c);
  return c.operator==='excludes'?!matched:matched;
 });
}
export function relevantShard(shard: IndexShard, conditions: PlayCondition[], players: ClipManifest['players']): boolean {
 return conditions.filter(c=>c.status==='ready'&&c.operator==='equals').every(c=>{
 if(c.field==='season')return shard.season===c.value;
 if(c.field==='date')return c.value>=shard.from&&c.value<=shard.to;
 if(c.field==='player'){const ids=players.filter(p=>normalize(p.name)===normalize(c.value)).map(p=>p.id);return ids.some(id=>shard.players.includes(id));}
 if(c.field==='team'||c.field==='opponent')return shard.teams.includes(c.value.toUpperCase());return true;
 });
}
export function keywordScore(prompt: string, clip: PlayClip): number {
 const terms=normalize(prompt).match(/[a-z]{3,}/g)??[],text=normalize(clip.description);
 return terms.reduce((score,term)=>score+(text.includes(term)?1:0),0)/Math.max(1,terms.length);
}
