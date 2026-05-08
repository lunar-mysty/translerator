import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { fileURLToPath } from 'url'
// import { OpenRouter } from '@openrouter/sdk'

const app = express()
const PORT = process.env.PORT || 8080
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'
const OPENROUTER_MODELS = {
  fast: 'anthropic/claude-haiku-4.5:nitro',
  accurate: 'anthropic/claude-sonnet-4.6:nitro',
}
const DEFAULT_MODEL_MODE = 'fast'
const REQUEST_TIMEOUT_MS = 30000
const MAX_TEXT_LENGTH = 12000
const MAX_FIELD_LENGTH = 1024
const BLOCKED_TRANSLATION_ERROR =
  'This text was not translated because it appears to request serious harm, illegal activity, or hate.'
const UNTRANSLATABLE_ERROR =
  'This text was not translated because it is not meaningfully translatable or the request is unclear.'

class ProviderResponseError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ProviderResponseError'
    this.status = 502
    this.publicMessage = message
  }
}

app.use(cors())
app.use(express.json({ limit: '64kb' }))
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && 'body' in err) {
    return res.status(400).json({ error: 'Invalid JSON body.' })
  }

  next(err)
})

function parseModelResponse(content) {
  const trimmed = String(content || '').trim()

  const parseJson = (jsonText) => {
    try {
      return JSON.parse(jsonText)
    } catch {
      return JSON.parse(escapeJsonStringControlChars(jsonText))
    }
  }

  try {
    return parseJson(trimmed)
  } catch {
    const start = trimmed.indexOf('{')
    const end = trimmed.lastIndexOf('}')
    if (start !== -1 && end > start) {
      try {
        return parseJson(trimmed.slice(start, end + 1))
      } catch {
        throw new ProviderResponseError('Translation provider returned malformed JSON content.')
      }
    }
    throw new ProviderResponseError('Translation provider returned non-JSON content.')
  }
}

function escapeJsonStringControlChars(jsonText) {
  let escaped = ''
  let inString = false
  let isEscaped = false

  for (const char of jsonText) {
    if (!inString) {
      escaped += char
      if (char === '"') inString = true
      continue
    }

    if (isEscaped) {
      escaped += char
      isEscaped = false
      continue
    }

    if (char === '\\') {
      escaped += char
      isEscaped = true
      continue
    }

    if (char === '"') {
      escaped += char
      inString = false
      continue
    }

    if (char === '\n') {
      escaped += '\\n'
      continue
    }

    if (char === '\r') {
      escaped += '\\r'
      continue
    }

    if (char === '\t') {
      escaped += '\\t'
      continue
    }

    if (char < ' ') {
      escaped += `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`
      continue
    }

    escaped += char
  }

  return escaped
}

function getProviderMessage(data) {
  return data.choices?.[0]?.message?.content
}

function cleanField(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function validateTranslateBody(body) {
  const mode = cleanField(body?.mode) || 'standard'
  const text = typeof body?.text === 'string' ? body.text : ''
  const targetLanguage = cleanField(body?.targetLanguage)
  const sourceLanguage = cleanField(body?.sourceLanguage) || 'Auto-detect'
  const tone = cleanField(body?.tone)
  const modelMode = cleanField(body?.modelMode) || DEFAULT_MODEL_MODE

  if (!['standard', 'conversation'].includes(mode)) {
    return { error: 'Invalid translation mode.' }
  }

  if (!OPENROUTER_MODELS[modelMode]) {
    return { error: 'Invalid model mode.' }
  }

  if (mode === 'conversation') {
    const userName = cleanField(body?.userName) || 'You'
    const userLanguage = cleanField(body?.userLanguage)
    const otherName = cleanField(body?.otherName) || 'Other participant'
    const otherLanguage = cleanField(body?.otherLanguage)
    const conversationContext = typeof body?.conversationContext === 'string'
      ? body.conversationContext
      : ''
    const replyText = typeof body?.replyText === 'string' ? body.replyText : text

    if (!replyText.trim() || !userLanguage || !otherLanguage) {
      return { error: 'Missing required fields: replyText, userLanguage, otherLanguage' }
    }

    if (
      replyText.length + conversationContext.length > MAX_TEXT_LENGTH ||
      userName.length > MAX_FIELD_LENGTH ||
      userLanguage.length > MAX_FIELD_LENGTH ||
      otherName.length > MAX_FIELD_LENGTH ||
      otherLanguage.length > MAX_FIELD_LENGTH ||
      tone.length > MAX_FIELD_LENGTH ||
      modelMode.length > MAX_FIELD_LENGTH
    ) {
      return { error: 'Request is too large.' }
    }

    return {
      mode,
      text: replyText,
      sourceLanguage: userLanguage,
      targetLanguage: otherLanguage,
      tone,
      modelMode,
      userName,
      userLanguage,
      otherName,
      otherLanguage,
      conversationContext,
    }
  }

  if (!text.trim() || !targetLanguage) {
    return { error: 'Missing required fields: text, targetLanguage' }
  }

  if (
    text.length > MAX_TEXT_LENGTH ||
    targetLanguage.length > MAX_FIELD_LENGTH ||
    sourceLanguage.length > MAX_FIELD_LENGTH ||
    tone.length > MAX_FIELD_LENGTH ||
    modelMode.length > MAX_FIELD_LENGTH
  ) {
    return { error: 'Request is too large.' }
  }

  return { mode, text, sourceLanguage, targetLanguage, tone, modelMode }
}

async function readResponseJson(response) {
  const raw = await response.text()

  try {
    return raw ? JSON.parse(raw) : {}
  } catch {
    return { error: raw || 'Translation provider returned an invalid response' }
  }
}

function buildMessages({ text, sourceLanguage, targetLanguage, tone }) {
  const toneInstruction = tone
    ? `Preserve the meaning while using this tone/style: ${tone}.`
    : 'Preserve the meaning and natural style of the source.'

  const sourceInstruction = sourceLanguage && sourceLanguage !== 'Auto-detect'
    ? `The source language is ${sourceLanguage}.`
    : 'Auto-detect the source language.'

  const systemPrompt = `You are a professional translator with a narrow safety gate.

Translate the user's text into ${targetLanguage}. ${sourceInstruction} ${toneInstruction}

Block only extreme content. Vulgarity, profanity, insults, adult language, disturbing fiction, political opinions, and offensive wording should usually still be translated.

Return a blocked response only when the text clearly:
- asks for instructions, plans, or assistance to commit serious illegal activity or violent harm
- promotes, praises, or incites hate, dehumanization, harassment, or violence against a protected class
- contains sexual content involving minors
- threatens specific real-world violence or celebrates severe harm

Return an untranslatable response when the text or request cannot be translated in a meaningful way, such as total gibberish, no linguistic content, contradictory or impossible language parameters, or an unclear custom language.

The translation should keep the same meaning as the original text.

Return ONLY valid JSON. The status must be exactly one of: translated, blocked, untranslatable.

Use exactly one of these shapes:
{"status":"translated","translation":"translated text here"}
{"status":"blocked","reason":"brief reason"}
{"status":"untranslatable","reason":"brief reason"}`

  return [
    {
      role: 'system',
      content: systemPrompt,
    },
    {
      role: 'user',
      content: text,
    },
  ]
}

function buildConversationMessages({
  text,
  userName,
  userLanguage,
  otherName,
  otherLanguage,
  conversationContext,
  tone,
}) {
  const toneInstruction = tone
    ? `Use this tone/style unless the conversation context clearly calls for a more natural equivalent: ${tone}.`
    : 'Match the natural tone, politeness, and formality implied by the draft and conversation context.'

  const contextText = conversationContext.trim()
    ? conversationContext
    : '(No pasted conversation context was provided.)'

  const systemPrompt = `You are a professional conversation translator with a narrow safety gate.

The user is copy/pasting between another app and this translator. This is not a live chat.

Participants:
- ${userName} writes in ${userLanguage}
- ${otherName} writes in ${otherLanguage}

Translate ONLY ${userName}'s draft reply into ${otherLanguage}. Use the pasted conversation context to resolve names, pronouns, direct address, relationship, politeness, register, implied subjects, and language-specific habits such as naturally using a person's name or honorifics. Do not answer the conversation, summarize it, or translate the pasted context.

${toneInstruction}

Block only extreme content. Vulgarity, profanity, insults, adult language, disturbing fiction, political opinions, and offensive wording should usually still be translated.

Return a blocked response only when the draft reply clearly:
- asks for instructions, plans, or assistance to commit serious illegal activity or violent harm
- promotes, praises, or incites hate, dehumanization, harassment, or violence against a protected class
- contains sexual content involving minors
- threatens specific real-world violence or celebrates severe harm

Return an untranslatable response when the draft reply or request cannot be translated in a meaningful way, such as total gibberish, no linguistic content, contradictory or impossible language parameters, or an unclear custom language.

Return ONLY valid JSON. The status must be exactly one of: translated, blocked, untranslatable.

Use exactly one of these shapes:
{"status":"translated","translation":"translated reply here"}
{"status":"blocked","reason":"brief reason"}
{"status":"untranslatable","reason":"brief reason"}`

  return [
    {
      role: 'system',
      content: systemPrompt,
    },
    {
      role: 'user',
      content: `Pasted conversation context:
${contextText}

Draft reply from ${userName} in ${userLanguage}:
${text}`,
    },
  ]
}

function buildRequestMessages(validation) {
  return validation.mode === 'conversation'
    ? buildConversationMessages(validation)
    : buildMessages(validation)
}

// const client = new OpenRouter({
//   apiKey: process.env.OPENROUTER_API_KEY,
// })

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    providerConfigured: Boolean(process.env.OPENROUTER_API_KEY),
    defaultModelMode: DEFAULT_MODEL_MODE,
    models: OPENROUTER_MODELS,
  })
})

app.post('/api/translate', async (req, res) => {
  const validation = validateTranslateBody(req.body)

  if (validation.error) {
    return res.status(400).json({ error: validation.error })
  }

  if (!process.env.OPENROUTER_API_KEY) {
    return res.status(500).json({ error: 'Translation service is not configured.' })
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const headers = {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
    }
    const payload = {
      model: OPENROUTER_MODELS[validation.modelMode],
      messages: buildRequestMessages(validation),
      temperature: 0.2,
    }

    const completion = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    })

    const data = await readResponseJson(completion)

    if (!completion.ok) {
      throw new Error(data.error?.message || data.error || 'Translation request failed')
    }

    const providerMessage = getProviderMessage(data)
    if (!providerMessage) {
      throw new ProviderResponseError('Translation provider response did not include message content.')
    }

    const parsed = parseModelResponse(providerMessage)
    if (parsed.status === 'blocked') {
      return res.status(422).json({
        rejected: true,
        rejectionType: 'safety',
        error: BLOCKED_TRANSLATION_ERROR,
        reason: parsed.reason || 'Safety policy',
      })
    }

    if (parsed.status === 'untranslatable') {
      return res.status(422).json({
        rejected: true,
        rejectionType: 'untranslatable',
        error: UNTRANSLATABLE_ERROR,
        reason: parsed.reason || 'The text or language request was not meaningfully translatable.',
      })
    }

    if (parsed.status === 'translated') {
      const translation = cleanField(parsed.translation)
      if (!translation) throw new Error('Translation response was empty')
      return res.json({ translation })
    }

    throw new ProviderResponseError(
      `Translation provider returned unknown status: ${cleanField(parsed.status) || 'missing'}.`
    )
  } catch (err) {
    console.error('Translation error:', err)
    const status = err.name === 'AbortError' ? 504 : err.status || 502
    const error = err.publicMessage || 'Translation failed. Check your API key and try again.'
    res.status(status).json({ error })
  } finally {
    clearTimeout(timeout)
  }
})

app.use(express.static('dist'));
app.get('*', (req, res) => res.sendFile('index.html', { root: 'dist' }));

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`)
  })
}

export { parseModelResponse, escapeJsonStringControlChars }
