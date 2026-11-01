# Play Flipbook · Possession walkthroughs

[Back to the feature guide](feature-guide.md#playbook)

Play Flipbook freezes one recorded possession for Main or a selected ending, then lets the author present it as a short sequence of court moments · The recording stores the complete simulation journal, its resolved defensive scheme, settings, seed, and engine version

## Build a walkthrough

Open **Build a walkthrough** beside **Export PNG** in Playbook · If the current simulation has reached its end and still matches the selected path, the editor recording can be reused · Otherwise the walkthrough view runs the path to completion with the current simulation settings

The recording resolves an automatic defense once and then keeps that defense for the saved session · The court displays current worker snapshots, and Playbook remains paused while the walkthrough is open

When the recording finishes, Play Flipbook suggests an opening, up to six recorded interactions, and an ending · Suggestions come from recorded screens, catches, action completions, and shot releases · The opening and finish are context panels, not inferred tactical events

## Edit moments

Select a panel to seek to its captured time · Change the caption, adjust its time, or choose **Capture current moment** to replace its saved court snapshot with the acknowledged worker frame · If the panel has Chalk Talk marks, a before/after review is required before replacing the snapshot · Panel times stay chronological and panel identities keep their captions and focus settings when their order changes

Each moment defaults to the routes for executed actions since the previous panel · Use **Refine this panel** to choose the players in focus and the recorded routes to show · The shared arrow visibility setting still filters route display, including **Off**

Add a current moment while the playback cursor is at the desired time, up to 12 panels · Delete a selected panel when the story has more than one · Save walkthrough adds a new frozen story to the current draft; **Save play** persists the draft to the saved library

Undo and redo use the existing Playbook history · They restore the document story and are available in the focused view · Playback, selection, and comparison visibility are temporary view state

## Compare and share

**What changed?** compares a panel with the previous one · It calls out player centers that moved at least 0.25 feet, the recorded ball phase or handler change, and routes that appear or disappear between the selected panels · The comparison is descriptive and does not infer tactical quality

**Export storyboard PNG** creates a multi-panel image with the frozen play name, ending, panel times, captions, and enabled comparisons · **Print / Save PDF** opens the browser print dialog with complete panels kept together across pages

## Chalk Talk Layer

Use **Annotate panel** beside the selected caption to add circles, spotlight areas, numbered callouts, dashed lines, freehand marks, and text · Marks use court coordinates from that frozen moment and never become play actions

Organize marks into up to eight cumulative reveal steps · Select a step before adding marks, then use **Present walkthrough** to reveal the steps in order · **Include annotations** controls whether marks appear in the court, presentation, and storyboard output · The shared arrow setting is independent, so **Arrows: Off** hides routes while teaching marks remain visible

Marks can be selected, moved, resized, edited, deleted, and nudged with the keyboard · A completed gesture is one undoable edit · Rebuilding carries existing annotations to nearby recorded moments and requires reviewing the complete replacement before acceptance · Recapturing an annotated panel shows the old and new court side by side before replacing the saved snapshot

## Frozen stories and rebuilds

Each play stores at most one story for Main and one per stable ending ID · Renaming the play or changing its routes does not rewrite the captured story · When an engine version changes, the court snapshots remain viewable and exportable, while replay reconstruction is disabled

Choose **Rebuild from current play** to record the current drawing and settings again · The existing story stays saved while every replacement panel and carried annotation is reviewed · Accepting the replacement is an undoable document change; keeping the old story discards the staged replacement

Deleting an ending also deletes its ending-specific walkthrough after a confirmation · Walkthrough metadata is omitted from simulation inputs sent to Counter Lab, Read Coach, and role rehearsal

## Navigation and persistence

The view uses `#playbook/flipbook` so reloading returns to the walkthrough view · The editor draft, branch, selection, paused simulation, and undo history remain in memory while switching views

Saved walkthroughs and Chalk Talk marks remain inside the version-1 play document as bounded optional extensions · Browser storage upgrades to hosted envelope version 10, and the local API advertises `play-flipbook-v1` and `chalk-talk-v1` so older clients cannot silently remove the content · The shared 256 KiB document budget still applies

Playbook and Counter Lab also support temporary simulation downloads · See the [simulation export guide](simulation-export.md) for video, PDF, image-folder, and current-frame exports
