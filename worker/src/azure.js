// Calls Azure AI Speech's Pronunciation Assessment REST API (the "short
// audio" recognition endpoint with a Pronunciation-Assessment header) and
// returns a normalized result. Docs:
// https://learn.microsoft.com/azure/ai-services/speech-service/how-to-pronunciation-assessment
//
// `audioBuffer` is the raw bytes the browser recorded (see frontend/app.js
// -- we ask MediaRecorder for audio/webm;codecs=opus, which the REST
// endpoint accepts via the Content-Type header below). `referenceText` is
// the word/phrase being tested.
export async function assessPronunciation(env, audioBuffer, referenceText, contentType) {
  const region = env.AZURE_SPEECH_REGION;
  const key = env.AZURE_SPEECH_KEY;

  const pronAssessmentConfig = {
    ReferenceText: referenceText,
    GradingSystem: 'HundredMark',
    Granularity: 'Phoneme',
    Dimension: 'Comprehensive',
    EnableMiscue: true,
  };
  const pronAssessmentHeader = btoa(JSON.stringify(pronAssessmentConfig));

  const url =
    `https://${region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1` +
    `?language=en-US&format=detailed`;

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': key,
      'Content-Type': contentType || 'audio/webm; codecs=opus',
      Accept: 'application/json',
      'Pronunciation-Assessment': pronAssessmentHeader,
    },
    body: audioBuffer,
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`Azure Speech API error ${resp.status}: ${errText}`);
  }

  const data = await resp.json();

  // RecognitionStatus is "Success" only when Azure's recognizer actually
  // matched the audio to the reference text with reasonable confidence --
  // this is our first pass ("is this even the right word").
  const recognized = data.RecognitionStatus === 'Success';
  const best = (data.NBest && data.NBest[0]) || null;
  const accuracyScore = best?.PronunciationAssessment?.AccuracyScore ?? 0;

  return {
    recognized,
    recognizedText: data.DisplayText || best?.Display || '',
    accuracyScore,
    raw: data, // kept for debugging/logging; not persisted to D1
  };
}
