// ==========================================
// Centralized Sound Registry
// ==========================================
// Change any sound mapping here — no need to touch component files.
//
// Usage:  import { playSound } from '../sounds/sound_registry';
//         playSound('noteCreate');
//
// To swap a sound: just change the right-hand side below.
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


// -- other sounds --
import snapSound from './other/snap.mp3';
import clackSound from './other/clack.mp3';
import penDownSound from './other/pen_down.mp3';
import whipSound from './other/whip.mp3';
import whip2Sound from './other/whip_2.mp3';
import settingToneSound from './other/change_any_setting_tone.mp3';
import refactorModeSound from './other/change_to_refractor_mode.wav';
import changeViewSound from './other/change_view.wav';
import collapseIdeaSound from './other/collapse_idea_container.wav';
import collapseTeamSound from './other/collapse_team.wav';
import deletingSound from './other/delete_perfect.mp3';
import phaseDropResizeSound from './other/dropping_and_resizing_phase.wav';
import dropIdeaSound from './other/drop_idea.wav';
import filterTeamSound from './other/filter_for_team.wav';
import phaseAddedSound from './other/phase_added.wav';
import saveViewSound from './other/safe_view.wav';
import safe_snapshot from './other/second_camera.wav';
import taskReorderSound from './other/task_reordering.wav';
import teamReorderSound from './other/team_reordering.wav';




// -- Idea/note sounds --
import ideaSound from './notes/idea.wav';
import idea2Sound from './notes/idea_2.wav';
import ideaConvertSound from './notes/convert_idea_to_task.wav';
import ideaCoinSound from './notes/mixkit-space-coin-win-notification-271.wav';
import ideaNotifSound from './notes/mixkit-quick-positive-video-game-notification-interface-265.wav';







// ==========================================
//  SOUND MAP — edit this to reassign sounds
// ==========================================
// Each key = event name used in code.
// Each value = an imported sound file (or null to disable).
//
const SOUND_FILES = {

  // ══════════════════════════════════════════
  // AUTH
  // ══════════════════════════════════════════
  authLogin:             ideaNotifSound,         // successful login
  authRegister:          ideaCoinSound,          // successful account creation
  authError:             errorSound,             // wrong credentials / error

  // ══════════════════════════════════════════
  // PROJECTS PAGE
  // ══════════════════════════════════════════
  projectCreate:         ideaCoinSound,          // new project created
  projectOpen:           changeViewSound,        // project card clicked / opened
  projectDelete:         deletingSound,          // project permanently deleted
  projectMenuOpen:       selectSound,            // "···" context menu opened

  // ══════════════════════════════════════════
  // PROJECT DASHBOARD
  // ══════════════════════════════════════════
  projectNameSave:       penDownSound,           // project name committed
  projectDescriptionSave: subtleSound,           // description saved
  projectEndDateChange:  settingToneSound,       // end date changed
  projectSnapshotSave:   safe_snapshot,          // "Save snapshot" JSON export

  // ══════════════════════════════════════════
  // NOTES — canvas cards
  // ══════════════════════════════════════════
  noteCreate:            ideaSound,              // new note created (any method)
  noteDelete:            deletingSound,          // note deleted
  noteMove:              phaseDropResizeSound,   // card drag-dropped to new position
  noteResize:            clackSound,             // resize handle released
  noteEditStart:         penDownSound,           // inline edit mode entered
  noteEditCommit:        snapSound,              // inline edit committed / saved
  noteAutoSave:          subtleSound,            // description debounce-saved
  noteSelect:            selectSound,            // card clicked / selected
  noteDeselect:          subtleSound,            // card deselected / Escape
  noteOpen:              idea2Sound,             // NotePopup opened
  noteClose:             collapseIdeaSound,      // NotePopup closed
  noteMerge:             ideaConvertSound,       // two notes merged
  noteSplit:             whipSound,              // note split into two
  noteMarqueeSelect:     subtleSound,            // marquee rect selection completes
  notePanelToggle:       collapseTeamSound,      // add-note panel expanded/collapsed
  noteGridArrange:       taskReorderSound,       // "Arrange in grid" applied
  noteSearchOpen:        scifiSound,             // canvas search opened
  noteSearchResult:      selectSound,            // search result placed on canvas
  noteToastShow:         ideaNotifSound,         // "Note created" toast appears
  noteQuickAddOpen:      idea2Sound,             // header quick-add panel opened
  noteQuickAddSubmit:    ideaSound,              // quick-add submitted

  // ══════════════════════════════════════════
  // CATEGORIES
  // ══════════════════════════════════════════
  categoryAssign:        snapSound,              // category assigned to note
  categoryUnassign:      subtleSound,            // category unassigned from note
  categoryCreate:        ideaNotifSound,         // new category created
  categoryDelete:        deletingSound,          // category deleted
  categoryRename:        penDownSound,           // category name committed
  categoryColorChange:   settingToneSound,       // category color changed
  paintModeActivate:     refactorModeSound,      // paint mode switched on
  paintModeDeactivate:   collapseTeamSound,      // paint mode switched off
  paintApply:            snapSound,              // single paint applied to note
  paintApplyAll:         ideaConvertSound,       // "Apply to all" bulk-paint

  // ══════════════════════════════════════════
  // DIMENSIONS
  // ══════════════════════════════════════════
  dimensionCreate:       phaseAddedSound,        // new dimension created
  dimensionDelete:       deletingSound,          // dimension deleted
  dimensionRename:       penDownSound,           // dimension name committed
  dimensionChange:       mixkitClickSound,       // active dimension switched
  dimensionReorder:      taskReorderSound,       // dimension drag-reordered

  // ══════════════════════════════════════════
  // PERSONAS / PEOPLE
  // ══════════════════════════════════════════
  personaCreate:         ideaNotifSound,         // new persona added
  personaDelete:         deletingSound,          // persona deleted
  personaSave:           penDownSound,           // persona name/model saved
  personaAssign:         dropIdeaSound,          // persona dropped onto note/category
  personaRemove:         collapseTeamSound,      // persona removed from note/category
  personaLeaderAssign:   messageSound,           // persona set as category leader
  personaPaintActivate:  filterTeamSound,        // persona paint mode toggled on
  personaPaintDeactivate:collapseTeamSound,      // persona paint mode toggled off
  personaSelect:         selectSound,            // persona selected in 3D scene
  personaDragDrop:       teamReorderSound,       // persona drag completed

  // ══════════════════════════════════════════
  // CLASSIFICATION PAGE
  // ══════════════════════════════════════════
  noteClassified:        taskReorderSound,       // note moved to different category lane
  noteReordered:         taskReorderSound,       // note reordered within same lane
  categoryLaneCollapse:  collapseTeamSound,      // category container collapsed
  categoryLaneAssignAll: ideaConvertSound,       // bulk-assign active paint to all notes

  // ══════════════════════════════════════════
  // SCHEDULE PAGE (Gantt)
  // ══════════════════════════════════════════
  timeSlotCreate:        phaseAddedSound,        // time slot created
  timeSlotMove:          phaseDropResizeSound,   // time slot dragged to new position
  timeSlotResize:        clackSound,             // time slot edge resized
  timeSlotDelete:        deletingSound,          // time slot deleted
  timeSlotSelect:        selectSound,            // time slot clicked / selected
  timeSlotPin:           snapSound,              // time slot pinned/unpinned
  dependencyCreate:      connectionSound,        // dependency arrow created
  dependencyDelete:      deletingSound,          // dependency arrow removed
  dependencySelect:      selectSound,            // dependency line clicked
  deadlineSet:           snapSound,              // hard deadline set/removed
  earliestStartSet:      subtleSound,            // earliest-start marker set/removed
  timeUnitInsert:        phaseAddedSound,        // column inserted in timeline
  timeUnitDelete:        deletingSound,          // column deleted from timeline
  scheduleWarning:       errorSound,             // dependency / deadline warning shown
  scheduleUndoRedo:      rewindSound,            // undo or redo action
  inheritanceLink:       connectionSound,        // inheritance relation created
  inheritanceUnlink:     whip2Sound,             // inheritance relation removed

  // ══════════════════════════════════════════
  // CALENDAR PAGE
  // ══════════════════════════════════════════
  calendarEventMove:     phaseDropResizeSound,   // event dragged to new time
  calendarEventResize:   clackSound,             // event edge resized
  calendarEventCreate:   phaseAddedSound,        // time slot created via empty-cell click
  calendarViewChange:    changeViewSound,        // Today / 7 days / Month toggled
  calendarNavigate:      mixkitClickSound,       // prev / next date navigation

  // ══════════════════════════════════════════
  // NAVIGATION & GLOBAL UI
  // ══════════════════════════════════════════
  viewChange:            changeViewSound,        // navigate between pages / views
  searchOpen:            scifiSound,             // global search panel opened
  searchClose:           subtleSound,            // global search panel closed
  searchResultClick:     selectSound,            // search result clicked
  confirmDialogOpen:     mixkitClickSound,       // ConfirmDialog appears
  confirmDialogConfirm:  snapSound,              // Confirm button clicked
  confirmDialogCancel:   subtleSound,            // Cancel button clicked
  logout:                collapseTeamSound,      // user logged out

  // ══════════════════════════════════════════
  // PERSPECTIVES
  // ══════════════════════════════════════════
  perspectiveSave:       saveViewSound,          // perspective saved / created
  perspectiveLoad:       changeViewSound,        // perspective applied
  perspectiveUpdate:     saveViewSound,          // perspective snapshot updated
  perspectiveDelete:     deletingSound,          // perspective deleted
  perspectiveRename:     penDownSound,           // perspective renamed

  // ══════════════════════════════════════════
  // SETTINGS & VISUAL TOGGLES
  // ══════════════════════════════════════════
  settingToggle:         settingToneSound,       // any visual / display setting toggled
  modeSwitch:            refactorModeSound,      // refractor / edit / dep mode switch
  collapseToggle:        collapseIdeaSound,      // any collapsible panel toggled

  // ══════════════════════════════════════════
  // DOCUMENT CANVAS (rich-text notes view)
  // ══════════════════════════════════════════
  docNoteCreate:         ideaSound,              // new note block added at top
  docNoteMerge:          ideaConvertSound,       // two note blocks merged
  docNoteSplit:          whipSound,              // note block split via ruler click
  docNoteDelete:         deletingSound,          // empty note auto-deleted
  docNoteEditStart:      penDownSound,           // double-click enters title edit
  docNoteEditCommit:     snapSound,              // title committed

  // ══════════════════════════════════════════
  // WARNINGS / ERRORS
  // ══════════════════════════════════════════
  warning:               errorSound,             // dependency violation / overlap
  blocked:               error2Sound,            // action blocked / not allowed

  // ══════════════════════════════════════════
  // ORBIT / BREATHING MODE (People 3D page)
  // ══════════════════════════════════════════
  // (breathing and heartbeat managed via dedicated API below)
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