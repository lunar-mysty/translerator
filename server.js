import 'dotenv/config'
import express from 'express'
import cors from 'cors'
// import { OpenRouter } from '@openrouter/sdk'

const app = express()
const PORT = process.env.PORT || 8080

app.use(cors())
app.use(express.json())

// const client = new OpenRouter({
//   apiKey: process.env.OPENROUTER_API_KEY,
// })

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

Return ONLY the translated text EXACTLY with no explanations, notes, or extra formatting. Do not wrap the translation in quotes.
The translations should have the same meaning as the original text—prefer to translate to a more similar meaning than a similar amount of words or pronounciation.

Text to translate:
${text}`

  try {
    const url = "https://openrouter.ai/api/v1/chat/completions"
    const headers = {
      "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json"
    }
    const payload = {
      "model": "anthropic/claude-haiku-4.5:nitro",
      "messages": [
        {
          "role": "system",
          "content": prompt
        }
      ]
    };

    const completion = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload)
    })

    const data = await completion.json();

    const translation = data.choices[0].message.content
    res.json({ translation })
  } catch (err) {
    console.error('Translation error:', err)
    res.status(500).json({ error: 'Translation failed. Check your API key and try again.' })
  }
})

app.use(express.static('dist'));
app.get('*', (req, res) => res.sendFile('index.html', { root: 'dist' }));

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`)
})
