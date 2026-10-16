import { getToken } from './token';

export interface TranscribeResult {
  transcript: string;
  status: string;
}

/**
 * Send encoded audio to Azure's regional speech endpoint, parse recognized text, and distinguish
 * silence from a transport or service error.
 */
async function callAzureSpeechToText(
  audioBody: Blob | ArrayBuffer,
  contentType: string,
  token: string,
  region: string
): Promise<TranscribeResult | null> {
  const response = await fetch(
    `https://${region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=en-US&format=detailed`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': contentType,
        Accept: 'application/json',
      },
      body: audioBody,
    }
  );

  const raw = await response.text();
  if (!response.ok) {
    console.error(`Azure STT HTTP error: ${response.status} ${raw.slice(0, 200)}`);
    return null;
  }

  const result = JSON.parse(raw) as {
    RecognitionStatus: string;
    DisplayText?: string;
    NBest?: { Display: string }[];
  };

  if (result.RecognitionStatus === 'Success') {
    return {
      transcript: result.NBest?.[0]?.Display ?? result.DisplayText ?? '',
      status: 'Success',
    };
  }

  return { transcript: '', status: result.RecognitionStatus };
}

/**
 * Transcribe recorded audio via Azure Speech (token from our API).
 * Does not call /api/transcribe — avoids 404s when that route is missing on a host.
 */
export async function transcribeAudio(
  audioBody: Blob | ArrayBuffer,
  contentType: string
): Promise<TranscribeResult | null> {
  const empty =
    (audioBody instanceof Blob && audioBody.size === 0) ||
    (audioBody instanceof ArrayBuffer && audioBody.byteLength === 0);
  if (empty) {
    return { transcript: '', status: 'EmptyAudio' };
  }

  try {
    const creds = await getToken();
    return await callAzureSpeechToText(
      audioBody,
      contentType,
      creds.token,
      creds.region
    );
  } catch (error) {
    console.error('transcribe error:', error);
    return null;
  }
}
