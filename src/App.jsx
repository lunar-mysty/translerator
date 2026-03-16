import { useState, useCallback, useEffect, useRef } from 'react'
import { useI18n, UI_LOCALES, languageNames } from './i18n.jsx'

const STORAGE_KEY = 'translerator-state'

function loadSaved() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

const MAX_GROW_HEIGHT = 500

function useAutoResize(value) {
  const ref = useRef(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    const next = Math.min(el.scrollHeight, MAX_GROW_HEIGHT)
    el.style.height = next + 'px'
    el.style.overflowY = el.scrollHeight > MAX_GROW_HEIGHT ? 'auto' : 'hidden'
  }, [value])
  return ref
}

const LANGUAGES = [
  'Auto-detect',
  'English',
  'Spanish',
  'French',
  'German',
  'Italian',
  'Portuguese',
  'Russian',
  'Japanese',
  'Korean',
  'Chinese (Simplified)',
  'Chinese (Traditional)',
  'Arabic',
  'Hindi',
  'Dutch',
  'Swedish',
  'Polish',
  'Turkish',
  'Vietnamese',
  'Thai',
  'Indonesian',
  'Greek',
  'Czech',
  'Romanian',
  'Hungarian',
  'Ukrainian',
  'Hebrew',
  'Danish',
  'Finnish',
  'Norwegian',
]

const TARGET_LANGUAGES = LANGUAGES.filter((l) => l !== 'Auto-detect')

export default function App() {
  const { locale, changeLocale, t } = useI18n()
  const saved = useRef(loadSaved()).current
  const [sourceText, setSourceText] = useState(saved.sourceText || '')
  const [translatedText, setTranslatedText] = useState(saved.translatedText || '')
  const [sourceLang, setSourceLang] = useState(saved.sourceLang || 'Auto-detect')
  const [targetLang, setTargetLang] = useState(saved.targetLang || 'Spanish')
  const [tone, setTone] = useState(saved.tone || '')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [copiedSource, setCopiedSource] = useState(false)
  const [copiedTarget, setCopiedTarget] = useState(false)

  const sourceRef = useAutoResize(sourceText)
  const targetRef = useAutoResize(translatedText)

  // Persist state to localStorage
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      sourceText, translatedText, sourceLang, targetLang, tone,
    }))
  }, [sourceText, translatedText, sourceLang, targetLang, tone])

  const translate = useCallback(async () => {
    if (!sourceText.trim()) return

    setLoading(true)
    setError('')
    setTranslatedText('')

    try {
      const res = await fetch('/api/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: sourceText,
          sourceLanguage: sourceLang,
          targetLanguage: targetLang,
          tone: tone.trim() || undefined,
        }),
      })

      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Translation failed')
      setTranslatedText(data.translation)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [sourceText, sourceLang, targetLang, tone])

  const handleSwap = () => {
    if (sourceLang === 'Auto-detect') return

    setSourceLang(targetLang)
    setTargetLang(sourceLang)
    setSourceText(translatedText)
    setTranslatedText(sourceText)
  }

  const copyToClipboard = async (text, setCopied) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      const textarea = document.createElement('textarea')
      textarea.value = text
      document.body.appendChild(textarea)
      textarea.select()
      document.execCommand('copy')
      document.body.removeChild(textarea)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      translate()
    }
  }

  const canSwap = sourceLang !== 'Auto-detect'

  // Display language names in the user's UI language
  const langMap = languageNames[locale] || languageNames.en
  const displayLang = (lang) =>
    lang === 'Auto-detect' ? t.autoDetect : (langMap[lang] || lang)

  return (
    <div className="app">
      <header className="header">
        <div className="header-top">
          <div className="locale-switcher">
            <svg className="globe-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <line x1="2" y1="12" x2="22" y2="12" />
              <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
            </svg>
            <select
              value={locale}
              onChange={(e) => changeLocale(e.target.value)}
              className="locale-select"
            >
              {UI_LOCALES.map(({ code, label }) => (
                <option key={code} value={code}>
                  {label}
                </option>
              ))}
            </select>
          </div>
        </div>
        <h1>Translerator</h1>
        <p className="subtitle">{t.subtitle}</p>
      </header>

      <main className="main">
        {/* Language selector row */}
        <div className="lang-row">
          <div className="lang-select-wrapper">
            <select
              value={sourceLang}
              onChange={(e) => setSourceLang(e.target.value)}
              className="lang-select"
            >
              {LANGUAGES.map((lang) => (
                <option key={lang} value={lang}>
                  {displayLang(lang)}
                </option>
              ))}
            </select>
          </div>

          <button
            className={`swap-btn ${canSwap ? '' : 'disabled'}`}
            onClick={handleSwap}
            disabled={!canSwap}
            title={!canSwap ? t.swapDisabled : t.swap}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M7 16l-4-4 4-4" />
              <path d="M17 8l4 4-4 4" />
              <line x1="3" y1="12" x2="21" y2="12" />
            </svg>
          </button>

          <div className="lang-select-wrapper">
            <select
              value={targetLang}
              onChange={(e) => setTargetLang(e.target.value)}
              className="lang-select"
            >
              {TARGET_LANGUAGES.map((lang) => (
                <option key={lang} value={lang}>
                  {displayLang(lang)}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Tone/Style input */}
        <div className="tone-row">
          <label htmlFor="tone" className="tone-label">
            {t.toneLabel}
          </label>
          <input
            id="tone"
            type="text"
            className="tone-input"
            placeholder={t.tonePlaceholder}
            value={tone}
            onChange={(e) => setTone(e.target.value)}
            onKeyDown={handleKeyDown}
          />
        </div>

        {/* Text areas */}
        <div className="text-panels">
          <div className="panel">
            <div className="panel-header">
              <span className="panel-label">{t.source}</span>
              <div className="panel-actions">
                <span className="char-count">{sourceText.length}</span>
                {sourceText && (
                  <>
                    <button
                      className="icon-btn"
                      onClick={() => copyToClipboard(sourceText, setCopiedSource)}
                      title={t.copySource}
                    >
                      {copiedSource ? (
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                      ) : (
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                        </svg>
                      )}
                    </button>
                    <button
                      className="icon-btn clear-btn"
                      onClick={() => {
                        setSourceText('')
                        setTranslatedText('')
                        setError('')
                      }}
                      title={t.clear}
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="18" y1="6" x2="6" y2="18" />
                        <line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                    </button>
                  </>
                )}
              </div>
            </div>
            <textarea
              ref={sourceRef}
              className="text-area auto-grow"
              placeholder={t.inputPlaceholder}
              value={sourceText}
              onChange={(e) => setSourceText(e.target.value)}
              onKeyDown={handleKeyDown}
            />
          </div>

          <div className="panel">
            <div className="panel-header">
              <span className="panel-label">{t.translation}</span>
              <div className="panel-actions">
                <span className="char-count">{translatedText.length}</span>
                {translatedText && (
                  <button
                    className="icon-btn"
                    onClick={() =>
                      copyToClipboard(translatedText, setCopiedTarget)
                    }
                    title={t.copyTranslation}
                  >
                    {copiedTarget ? (
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    ) : (
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                      </svg>
                    )}
                  </button>
                )}
              </div>
            </div>
            {loading ? (
              <div className="text-area output-area">
                <div className="loading-dots"><span /><span /><span /></div>
              </div>
            ) : error ? (
              <div className="text-area output-area">
                <p className="error-text">{error}</p>
              </div>
            ) : (
              <textarea
                ref={targetRef}
                className="text-area auto-grow"
                placeholder={t.outputPlaceholder}
                value={translatedText}
                onChange={(e) => setTranslatedText(e.target.value)}
              />
            )}
          </div>
        </div>

        {/* Translate button */}
        <button
          className="translate-btn"
          onClick={translate}
          disabled={loading || !sourceText.trim()}
        >
          {loading ? t.translating : t.translate}
          {!loading && (
            <kbd className="kbd-hint">
              {navigator.platform?.includes('Mac') ? '⌘' : 'Ctrl'}+↵
            </kbd>
          )}
        </button>
      </main>
    </div>
  )
}
