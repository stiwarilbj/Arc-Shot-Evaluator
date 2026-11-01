# Playbook Read Coach

Read Coach lets a coach turn a recorded Playbook moment into a short decision lesson · It runs in the browser worker and stores lessons with the play on both the hosted and downloaded builds

## Create a checkpoint

1. Open a Playbook drawing, choose its ending if it has branches, and press **Play**
2. Pause while a player holds the ball, or seek the Replay control to a held-ball moment
3. Choose **Create a read checkpoint** · The captured court comes from the simulation worker's authoritative fixed-step state
4. Enter a question and add two or three choices
5. For each choice, select an action and participants, then draw its continuation from the captured player's position · Curves, action timing, passes, handoffs, cuts, and screen actions use the existing Playbook action model
6. Preview and review every choice · The review reports whether each authored action executes; it does not grade the tactical quality of the answer
7. Mark exactly one intended read, explain the cue, and add the checkpoint

An in-flight pass or handoff cannot be captured until a catch is confirmed · A shot that has begun is also unavailable · Seek to a different held-ball point and capture again

Each choice is an independent action list that begins from the same captured player and defender positions, live ball, possession, motion evidence, and defensive responsibilities · Choice execution is scripted, keeps the recorded defense, and disables automatic offensive continuation · Actions still use the normal engine's catches, screens, movement limits, and obstruction diagnostics

The lesson is independent of later edits to the Main play and its endings · **Replace captured situation** records a new opening but retains its question and choices; preview review is cleared so each choice must be checked against the new moment · Editing or deleting lessons uses Playbook undo and redo

## Practice a read

Choose **Practice reads** in Playbook or open `#playbook/practice` · Each checkpoint is one question · The opening replays from its recorded start and stops at the frozen moment

Until a choice is submitted, the practice court shows no future continuation, action list, timing strip, or answer explanation · Seeking is unavailable in Practice reads · Submitting an answer locks it for that attempt and reveals the intended choice and explanation · **Replay your choice** and **Replay intended choice** are separate simulations restored from the same captured state

**Try again** unlocks a new attempt without recording learner statistics · **Next checkpoint** moves through the lesson · Leaving Practice reads returns to the existing Playbook editor without replacing its active draft, selected ending, or undo/redo state

Playback pauses when its workspace or browser tab is hidden · Worker errors leave the saved lesson intact and offer a retry by starting the replay again

## Save and compatibility

Read Coach is an optional version-1 Playbook extension · The saved lesson contains its question, choices, intended choice, explanation, compact session replay inputs, and a court snapshot · It does not store a mutable engine object or nested Playbook branches

Browser persistence upgrades to a checksummed Read Coach aware envelope · The local API advertises the `read-coach-v1` capability and refuses old-client writes that could discard lesson data · JSON import/export, duplication, revision history, save validation, and precision normalization preserve lessons

Practice verifies the stored court snapshot against a restored simulation before replaying it · A lesson recorded by another simulation engine version is preserved as document content, but playback asks for an updated capture and review rather than silently running with changed rules

Counter Lab receives the selected executable play path without the Read Coach lesson extension
