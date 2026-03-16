import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import Anthropic from '@anthropic-ai/sdk'

const app = express()
const PORT = process.env.PORT || 3001

app.use(cors())
app.use(express.json())

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
})

app.post('/api/translate', async (req, res) => {
  const { text, sourceLanguage, targetLanguage, tone } = req.body

  if (!text || !targetLanguage) {
    return res.status(400).json({ error: 'Missing required fields: text, targetLanguage' })
  }

  const toneInstruction = tone
    ? `The tone/style should be: ${tone}.`
    : ''

  const sourceInstruction = sourceLanguage && sourceLanguage !== 'Auto-detect'
    ? `The source language is ${sourceLanguage}.`
    : 'Auto-detect the source language.'

  const prompt = `You are a professional translator. Translate the following text into ${targetLanguage}. ${sourceInstruction} ${toneInstruction}

Return ONLY the translated text with no explanations, notes, or extra formatting. Do not wrap the translation in quotes.

Text to translate:
${text}`

  try {
    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    })

    const translation = message.content[0].text
    res.json({ translation })
  } catch (err) {
    console.error('Translation error:', err)
    res.status(500).json({ error: 'Translation failed. Check your API key and try again.' })
  }
})

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`)
})
