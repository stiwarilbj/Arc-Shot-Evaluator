# Simulation replay exports

[Back to the feature guide](feature-guide.md#playbook)

Playbook and Counter Lab can export the court as it appeared in the current simulation · Exports use recorded court frames, preserve the selected route visibility, and run in the browser without a service or paid API

## Open the export preview

Choose **Export replay** to capture the current Playbook session or selected Counter Lab replay · If Playbook has no active simulation, it starts a disposable recording with the current settings and resolves an automatic defense once · Counter Lab uses its existing replay details without rerunning analysis

Choose **Export current frame** for a single image or PDF page · The preview opens paused and includes the current court positions, selected ending or replay, theme, route visibility, and spacing-gate display where available · Counter Lab can select **Synchronized comparison** to include the original and repair courts on the same time scale

## Choose a format

- **Current frame · PNG** downloads one court image
- **Current frame · PDF** downloads a single-page PDF
- **Video** exports a muted 30 fps MP4 when supported, otherwise a correctly named WebM file
- **PDF frames** creates one page per sampled simulation frame
- **Image folder** downloads a ZIP with sequential PNG frames and a timestamp index

Replay downloads default to the complete possession · Set a shorter start and end range when needed · PDF and image-folder exports support 30, 10, 5, and 1 fps sampling · Video uses 30 fps · Choose 720p or 1080p before rendering

The preview shows the selected range, frame or page count, dimensions, and estimated size · It rejects jobs above the 256 MiB output budget and does not silently reduce the requested sampling or omit frames · A shorter range, lower resolution, or explicit lower frame rate can make a large export fit

## Add temporary notes and drawings

Use the preview tools to add circles, spotlights, dashed lines, freehand marks, numbered callouts, text, and a note · Set the note interval; individual marks use that same interval and are clipped to the selected replay range · Undo and redo apply only to temporary export marks

These annotations are not saved to the play or the Flipbook story · A single-frame export includes marks visible at its selected timestamp · Video, PDF, and ZIP outputs render those marks at each sampled timestamp while keeping court coordinates fixed

## Playback and limits

Playbook exports replay from the saved simulation session, including recorded settings and paused edits · If the display is between recorded snapshots, the preview prepares the requested recorded moment in a disposable worker · Counter Lab comparison exports use one shared clock and hold the shorter replay at its final court with a **Replay ended** label

Export jobs are cancellable · Frame preparation runs in bounded batches and validates worker data before rendering · Unsupported video encoders leave PNG, PDF, and image-folder exports available · Export failures keep the source play and existing downloads unchanged
