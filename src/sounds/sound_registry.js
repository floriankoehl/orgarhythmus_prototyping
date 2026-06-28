// ==========================================
// Centralized Sound Registry
// ==========================================
// Change any sound mapping here — no need to touch component files.
//
// Usage:  import { playSound } from '../assets/sound_registry';
//         playSound('milestoneMove');
//
// To swap a sound: just change the import path below.
// To disable a sound: set it to null.
// ==========================================

// -- Static imports (Vite resolves these at build time) --
import selectSound from './dependency/select.wav';
import subtleSound from './dependency/subtle.wav';
import scifiSound from './dependency/scifi.wav';
import rewindSound from './dependency/rewind.wav';
import mixkitClickSound from './dependency/mixkit-sci-fi-click-900.wav';
import messageSound from './dependency/message.wav';
import errorSound from './dependency/error.wav';
import error2Sound from './dependency/error_2.wav';
import connectionDragSound from './dependency/connection_drag.wav';
import connectionSound from './dependency/connection.wav';
import collapseSound from './dependency/collapse.wav';
import snapSound from './snap.mp3';
import clackSound from './clack.mp3';
import penDownSound from './pen_down.mp3';
import whipSound from './whip.mp3';
import whip2Sound from './whip_2.mp3';

// -- New sounds --
import settingToneSound from './new/change_any_setting_tone.mp3';
import refactorModeSound from './new/change_to_refractor_mode.wav';
import changeViewSound from './new/change_view.wav';
// import changeViewSound from './new/second_camera.wav';
import collapseIdeaSound from './new/collapse_idea_container.wav';
import collapseTeamSound from './new/collapse_team.wav';
import deletingSound from './new/delete_perfect.mp3';
import phaseDropResizeSound from './new/dropping_and_resizing_phase.wav';
import dropIdeaSound from './new/drop_idea.wav';
import filterTeamSound from './new/filter_for_team.wav';
import phaseAddedSound from './new/phase_added.wav';
import saveViewSound from './new/safe_view.wav';
import safe_snapshot from './new/second_camera.wav';
import taskReorderSound from './new/task_reordering.wav';
import teamReorderSound from './new/team_reordering.wav';

// -- Idea sounds --
import ideaSound from './ideas/idea.wav';
import idea2Sound from './ideas/idea_2.wav';
import ideaConvertSound from './ideas/convert_idea_to_task.wav';
import ideaCoinSound from './ideas/mixkit-space-coin-win-notification-271.wav';
import ideaNotifSound from './ideas/mixkit-quick-positive-video-game-notification-interface-265.wav';

// -- Human / Orbit-mode sounds --
import breathingSound from './human/cutted_breathing.wav';
import heartbeatSound from './human/single_heart_beat.wav';

// ==========================================
//  SOUND MAP — edit this to reassign sounds
// ==========================================
// Each key = event name used in code.
// Each value = an imported sound file (or null to disable).
//
const SOUND_FILES = {
  // ── Milestone interactions ──
  milestoneSelect:       selectSound,            // clicking a milestone
  milestoneDeselect:     subtleSound,            // deselecting / escape
  // milestoneMove:         snapSound,              // drag-drop milestone to new day
  milestoneMove:         phaseDropResizeSound,              // drag-drop milestone to new day
  milestoneResize:       clackSound,             // edge-resize completes
  milestoneCreate:       messageSound,           // new milestone created
  milestoneDelete:       deletingSound,          // milestone removed
  milestoneRename:       penDownSound,           // rename confirmed

  // ── Connection interactions ──
  connectionCreate:      connectionSound,        // dependency line created
  connectionDelete:      deletingSound,          // dependency line removed
  connectionSelect:      selectSound,    // click on a connection
  connectionDragStart:   connectionDragSound,    // start dragging connection handle

  // ── Drag interactions ──
  teamDragDrop:          teamReorderSound,       // team reorder completes
  taskDragDrop:          taskReorderSound,       // task reorder completes
  dragLoop:              connectionDragSound,    // continuous loop while dragging

  // ── Phase interactions ──
  phaseCreate:           phaseAddedSound,        // phase created
  phaseUpdate:           phaseDropResizeSound,   // phase updated / resized
  phaseDelete:           deletingSound,          // phase deleted

  // ── Warnings / blocked actions ──
  warning:               errorSound,             // dependency violation / overlap
  blocked:               error2Sound,            // general blocked action

  // ── View mode changes ──
  modeSwitch:            mixkitClickSound,       // E / D / V mode toggle
  refactorToggle:        refactorModeSound,      // refactor mode on/off

  // ── Settings ──
  settingToggle:         settingToneSound,       // any setting toggled
  teamFilter:            filterTeamSound,        // team filter toggled

  // ── Views & Snapshots ──
  viewLoad:              changeViewSound,        // saved view loaded
  viewSave:              saveViewSound,          // view saved / created
  snapshotSave:          safe_snapshot,           // snapshot created / quick-saved
  snapshotRestore:       rewindSound,            // snapshot restored
  undo:                  rewindSound,            // Ctrl+Z undo

  // ── UI feedback ──
  collapse:              collapseTeamSound,      // team collapse / expand
  uiClick:               scifiSound,             // generic UI click

  // ── Multi-select / marquee ──
  marqueeSelect:         subtleSound,            // marquee selection completes

  // ── Idea interactions ──
  ideaCreate:            ideaSound,              // new idea created
  ideaDelete:            deletingSound,          // idea deleted
  ideaDragDrop:          dropIdeaSound,          // idea reorder / category drop
  ideaTransform:         ideaConvertSound,       // idea transformed to task/milestone
  ideaRefactor:          ideaConvertSound,       // dep item refactored back to idea
  ideaCategoryCreate:    ideaNotifSound,         // category created
  ideaCategoryArchive:   subtleSound,            // category archived/unarchived
  ideaCategoryDelete:    deletingSound,          // category deleted
  ideaExternalDrop:      ideaConvertSound,       // idea dropped onto Dependencies
  ideaOpen:              subtleSound,            // IdeaBin window opened
  ideaClose:             collapseIdeaSound,      // IdeaBin window minimized
};

// ==========================================
// Audio Cache (prevents re-creating Audio objects)
// ==========================================
const audioCache = {};

// Global volume (0.0 - 1.0)
let globalVolume = 0.3;

// Global mute flag
let muted = false;

/**
 * Play a sound by its registry key.
 * @param {string} key - One of the keys from SOUND_FILES
 * @param {object} [options] - { volume?: number (0-1), force?: boolean }
 */
export function playSound(key, options = {}) {
  if (muted && !options.force) return;

  const src = SOUND_FILES[key];
  if (!src) {
    // null means intentionally disabled — only warn for truly unknown keys
    if (src === undefined) console.warn(`[sounds] Unknown sound key: "${key}"`);
    return;
  }

  try {
    // Create a fresh Audio each time for overlapping playback support
    if (!audioCache[key]) {
      audioCache[key] = new Audio(src);
    }
    const audio = audioCache[key];
    audio.volume = options.volume ?? globalVolume;
    audio.currentTime = 0;
    audio.play().catch(() => {
      // Browser may block autoplay — silently ignore
    });
  } catch (e) {
    // Audio not supported or file missing — fail silently
  }
}

/**
 * Set global volume for all sounds.
 * @param {number} v - 0.0 to 1.0
 */
export function setSoundVolume(v) {
  globalVolume = Math.max(0, Math.min(1, v));
  // Update existing cached audio elements
  for (const audio of Object.values(audioCache)) {
    audio.volume = globalVolume;
  }
}

/**
 * Get current global volume.
 */
export function getSoundVolume() {
  return globalVolume;
}

/**
 * Mute / unmute all sounds.
 */
export function setMuted(val) {
  muted = !!val;
}

export function isMuted() {
  return muted;
}

/**
 * Preload specific sounds (call on mount to avoid delay on first play).
 * @param {string[]} keys - Array of sound keys to preload
 */
export function preloadSounds(keys) {
  for (const key of keys) {
    const src = SOUND_FILES[key];
    if (src && !audioCache[key]) {
      audioCache[key] = new Audio(src);
      audioCache[key].preload = 'auto';
    }
  }
}

/**
 * Get all available sound keys (useful for settings UI).
 */
export function getSoundKeys() {
  return Object.keys(SOUND_FILES);
}

/**
 * Get the file path for a sound key (useful for debugging).
 */
export function getSoundPath(key) {
  return SOUND_FILES[key] || null;
}

// ==========================================
// Looping Sound Support (for continuous drag sounds)
// ==========================================
const loopingAudios = {};

/**
 * Start playing a sound in a continuous loop.
 * Does nothing if already looping for this key.
 * @param {string} key - One of the keys from SOUND_FILES
 * @param {object} [options] - { volume?: number (0-1) }
 */
export function startLoopSound(key, options = {}) {
  if (muted) return;
  if (loopingAudios[key]) return; // already playing

  const src = SOUND_FILES[key];
  if (!src) return;

  try {
    const audio = new Audio(src);
    audio.loop = true;
    audio.volume = options.volume ?? globalVolume * 0.7;
    audio.play().catch(() => {});
    loopingAudios[key] = audio;
  } catch (e) {
    // fail silently
  }
}

/**
 * Stop a looping sound started with startLoopSound.
 * @param {string} key
 */
export function stopLoopSound(key) {
  const audio = loopingAudios[key];
  if (audio) {
    audio.pause();
    audio.currentTime = 0;
    delete loopingAudios[key];
  }
}

// ==========================================
// Orbit Mode — Breathing Sound
// ==========================================
// Exact duration: 110250 frames @ 44100 Hz = 2.5000000000 s
// The audio file IS the clock — animations read currentTime
// directly so they can never drift out of sync.
//
//   breath-in  (first half)  → radius grows
//   breath-out (second half) → radius shrinks
// ==========================================

/** Duration of the breath-in phase (seconds). */
export const ORBIT_BREATH_IN_TIME  = 1.25;

/** Duration of the breath-out phase (seconds). */
export const ORBIT_BREATH_OUT_TIME = 1.25;

/** Total breathing cycle = exact audio file length. */
export const ORBIT_BREATH_TOTAL = 2.5; // 110250 / 44100

/** Volume for the breathing loop (0-1). */
export const ORBIT_BREATH_VOLUME = 0.18;

let _orbitAudio = null;

export function startOrbitBreathing() {
  if (_orbitAudio) return;
  try {
    const audio = new Audio(breathingSound);
    audio.loop = true;
    audio.volume = muted ? 0 : ORBIT_BREATH_VOLUME;
    audio.play().catch(() => {});
    _orbitAudio = audio;
  } catch (e) { /* fail silently */ }
}

export function stopOrbitBreathing() {
  if (_orbitAudio) { _orbitAudio.pause(); _orbitAudio.currentTime = 0; _orbitAudio = null; }
}

/** Pause the breathing audio in place (keeps currentTime). */
export function pauseOrbitBreathing() {
  if (_orbitAudio && !_orbitAudio.paused) _orbitAudio.pause();
}

/** Resume after pauseOrbitBreathing(). */
export function resumeOrbitBreathing() {
  if (_orbitAudio && _orbitAudio.paused) _orbitAudio.play().catch(() => {});
}

/** Current playback position of the breathing audio (seconds). */
export function getBreathingTime() {
  return _orbitAudio ? _orbitAudio.currentTime : 0;
}

// ==========================================
// Orbit Mode — Heartbeat Sound
// ==========================================
// Exact duration: 48537 frames @ 44100 Hz = 1.1006122449 s
// ORBIT_HEARTBEAT_OFFSET = fine-tune offset to align the
// visual pulse with the audible thump inside the file.
// ==========================================

/** Exact duration of single_heart_beat.wav (seconds). */
export const ORBIT_HEARTBEAT_DURATION = 48537 / 44100; // 1.1006122449…

/**
 * Offset (seconds) from the start of the audio file to the
 * perceptible heartbeat thump. Tweak this to taste.
 */
export const ORBIT_HEARTBEAT_OFFSET = 0.50;

/** Volume for the heartbeat loop (0-1). */
export const ORBIT_HEARTBEAT_VOLUME = 0.30;

let _heartbeatAudio = null;

export function startOrbitHeartbeat() {
  if (_heartbeatAudio) return;
  try {
    const audio = new Audio(heartbeatSound);
    audio.loop = true;
    audio.volume = muted ? 0 : ORBIT_HEARTBEAT_VOLUME;
    audio.play().catch(() => {});
    _heartbeatAudio = audio;
  } catch (e) { /* fail silently */ }
}

export function stopOrbitHeartbeat() {
  if (_heartbeatAudio) { _heartbeatAudio.pause(); _heartbeatAudio.currentTime = 0; _heartbeatAudio = null; }
}

/** Pause the heartbeat audio in place (keeps currentTime). */
export function pauseOrbitHeartbeat() {
  if (_heartbeatAudio && !_heartbeatAudio.paused) _heartbeatAudio.pause();
}

/** Resume after pauseOrbitHeartbeat(). */
export function resumeOrbitHeartbeat() {
  if (_heartbeatAudio && _heartbeatAudio.paused) _heartbeatAudio.play().catch(() => {});
}

/** Current playback position of the heartbeat audio (seconds). */
export function getHeartbeatTime() {
  return _heartbeatAudio ? _heartbeatAudio.currentTime : 0;
}