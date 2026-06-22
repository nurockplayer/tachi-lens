export interface TranslationPromptRequest {
  id: string
  text: string
  sourceLang?: string
}

export interface TranslationPrompt {
  system: string
  user: string
}

interface PromptMessage {
  id: string
  text: string
  source_lang?: string
}

export const buildTranslationPrompt = (
  requests: TranslationPromptRequest[],
  targetLang: string,
): TranslationPrompt => {
  const messages = requests.map<PromptMessage>((request) => ({
    id: request.id,
    text: request.text,
    ...(request.sourceLang ? { source_lang: request.sourceLang } : {}),
  }))

  return {
    system:
      'You translate Twitch chat messages. Preserve ids exactly. Return valid JSON only and do not include markdown.',
    user: JSON.stringify({
      target_lang: targetLang,
      messages,
      response_format: [{ id: 'same id as input', translated_text: 'translated text' }],
    }),
  }
}
