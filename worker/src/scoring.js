import { CONFIG } from './config.js';
import { assessPronunciation } from './azure.js';
import {
  getDailyLogRow,
  incrementTries,
  lockFinalStatus,
  updateWordPoolStatus,
} from './db.js';

// Two independent pass criteria, both required (see README for the
// reasoning): Azure actually recognized the audio as the target text, AND
// the phoneme-level accuracy score cleared the bar.
function didPass(azureResult) {
  return azureResult.recognized && azureResult.accuracyScore >= CONFIG.MIN_ACCURACY_SCORE;
}

// Handles one spoken attempt at a word. Returns everything the frontend
// needs to update its UI, and mutates D1 as follows:
//   - Always assesses the audio via Azure, regardless of whether today's
//     score for this word is already locked in -- the user can keep
//     practicing freely.
//   - While the word is still undecided for today (final_status IS NULL)
//     and within MAX_SCORED_TRIES attempts, a pass locks it in as
//     'correct'; running out of scored tries without a pass locks it in
//     as 'incorrect'. Either way word_pool is updated so tomorrow's
//     selection knows what to do with it.
//   - Once today's outcome is locked, further attempts don't change
//     final_status or tries (so the score can't move once decided), but a
//     later pass still updates word_pool to 'passed' (with cooldown) --
//     the user has now demonstrated they can say it, which should count
//     for future scheduling even though today's tally is frozen.
export async function handleAttempt(env, db, { email, today, wordId, audioBuffer, contentType, referenceText }) {
  const logRow = await getDailyLogRow(db, email, today, wordId);
  if (!logRow) {
    throw new Error('This word is not part of today\'s practice set.');
  }

  const azureResult = await assessPronunciation(env, audioBuffer, referenceText, contentType);
  const passed = didPass(azureResult);

  const alreadyDecided = logRow.final_status !== null;

  if (!alreadyDecided) {
    const newTries = logRow.tries + 1;
    await incrementTries(db, logRow.id, newTries);

    if (passed) {
      await lockFinalStatus(db, logRow.id, 'correct');
      await updateWordPoolStatus(db, wordId, 'passed', today);
      return respond(azureResult, passed, newTries, 'correct');
    }

    if (newTries >= CONFIG.MAX_SCORED_TRIES) {
      await lockFinalStatus(db, logRow.id, 'incorrect');
      await updateWordPoolStatus(db, wordId, 'failed', today);
      return respond(azureResult, passed, newTries, 'incorrect');
    }

    // Still undecided -- one more scored try available.
    return respond(azureResult, passed, newTries, null);
  }

  // Already decided for today. Free retry: don't touch tries/final_status,
  // but a late pass still updates the pool for tomorrow's scheduling.
  if (passed) {
    await updateWordPoolStatus(db, wordId, 'passed', today);
  }
  return respond(azureResult, passed, logRow.tries, logRow.final_status);
}

function respond(azureResult, passed, tries, finalStatus) {
  return {
    passed,
    recognizedText: azureResult.recognizedText,
    accuracyScore: azureResult.accuracyScore,
    tries,
    finalStatus,
  };
}
