import axios from 'axios';

/** Require Azure Speech configuration and obtain a short-lived token for server-side transcription. */
async function fetchSpeechToken(): Promise<{ token: string; region: string }> {
  const subscriptionKey = process.env.AZURE_SUBSCRIPTION_KEY;
  const region = process.env.AZURE_REGION;
  if (!subscriptionKey || !region) {
    throw new Error(
      'Azure Speech is not configured on this server (set AZURE_SUBSCRIPTION_KEY and AZURE_REGION).'
    );
  }

  const response = await axios.post(
      `https://${region}.api.cognitive.microsoft.com/sts/v1.0/issueToken`,
      null,
      {
        headers: {
          'Ocp-Apim-Subscription-Key': subscriptionKey,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      }
    );
  return { token: response.data as string, region };
}

/**
 * Send nonempty audio to Azure using its original media type and return the best transcript or
 * explicit recognition status.
 */
export async function transcribeAudioBuffer(
  audio: Buffer,
  contentType: string
): Promise<{ transcript: string; status: string }> {
  if (!audio.length) {
    return { transcript: '', status: 'EmptyAudio' };
  }

  const { token, region } = await fetchSpeechToken();
  const response = await fetch(
    `https://${region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=en-US&format=detailed`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': contentType,
        Accept: 'application/json',
      },
      body: new Uint8Array(audio),
    }
  );

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`Azure STT ${response.status}: ${raw.slice(0, 200)}`);
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
