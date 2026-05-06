import { useState, useCallback, useEffect, useRef } from 'react'
import { useI18n, UI_LOCALES, languageNames } from './i18n.jsx'
import { APP_VERSION } from './version.js'

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
const AUTO_TRANSLATE_DELAY = 1000
const MODEL_MODES = ['fast', 'accurate']

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

const CUSTOM = 'Custom'

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
  CUSTOM,
]

const TARGET_LANGUAGES = LANGUAGES.filter((l) => l !== 'Auto-detect')

function Icon({ name, size = 18 }) {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
  }

  const icons = {
    check: (
      <svg {...common}>
        <path d="M20 6 9 17l-5-5" />
      </svg>
    ),
    clear: (
      <svg {...common}>
        <path d="M18 6 6 18" />
        <path d="m6 6 12 12" />
      </svg>
    ),
    copy: (
      <svg {...common}>
        <rect x="9" y="9" width="13" height="13" rx="2" />
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
      </svg>
    ),
    globe: (
      <svg {...common}>
        <circle cx="12" cy="12" r="10" />
        <path d="M2 12h20" />
        <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
      </svg>
    ),
    send: (
      <svg {...common}>
        <path d="M22 2 11 13" />
        <path d="m22 2-7 20-4-9-9-4 20-7Z" />
      </svg>
    ),
    swap: (
      <svg {...common}>
        <path d="m16 3 4 4-4 4" />
        <path d="M20 7H4" />
        <path d="m8 21-4-4 4-4" />
        <path d="M4 17h16" />
      </svg>
    ),
  }

  return icons[name] || null
}

function IconButton({ label, onClick, children, className = '', disabled = false }) {
  return (
    <button
      type="button"
      className={`icon-button ${className}`}
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
    >
      {children}
    </button>
  )
}

export default function App() {
  const { locale, changeLocale, t } = useI18n()
  const saved = useRef(loadSaved()).current
  const [sourceText, setSourceText] = useState(saved.sourceText || '')
  const [translatedText, setTranslatedText] = useState(saved.translatedText || '')
  const [sourceLang, setSourceLang] = useState(saved.sourceLang || 'Auto-detect')
  const [targetLang, setTargetLang] = useState(saved.targetLang || 'Spanish')
  const [customSourceLang, setCustomSourceLang] = useState(saved.customSourceLang || '')
  const [customTargetLang, setCustomTargetLang] = useState(saved.customTargetLang || '')
  const [tone, setTone] = useState(saved.tone || '')
  const [modelMode, setModelMode] = useState(
    MODEL_MODES.includes(saved.modelMode) ? saved.modelMode : 'fast'
  )
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [copiedSource, setCopiedSource] = useState(false)
  const [copiedTarget, setCopiedTarget] = useState(false)
  const [debouncedAutoSubmitVersion, setDebouncedAutoSubmitVersion] = useState(0)
  const [instantAutoSubmitVersion, setInstantAutoSubmitVersion] = useState(0)
  const autoTranslateTimerRef = useRef(null)
  const latestTranslateRef = useRef(null)
  const lastSubmittedPayloadRef = useRef('')

  const sourceRef = useAutoResize(sourceText)
  const targetRef = useAutoResize(translatedText)

  const clearPendingAutoTranslate = useCallback(() => {
    if (autoTranslateTimerRef.current) {
      clearTimeout(autoTranslateTimerRef.current)
      autoTranslateTimerRef.current = null
    }
  }, [])

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      sourceText, translatedText, sourceLang, targetLang, customSourceLang, customTargetLang, tone, modelMode,
    }))
  }, [sourceText, translatedText, sourceLang, targetLang, customSourceLang, customTargetLang, tone, modelMode])

  const resolvedSourceLang = sourceLang === CUSTOM ? customSourceLang.trim() : sourceLang
  const resolvedTargetLang = targetLang === CUSTOM ? customTargetLang.trim() : targetLang

  const translate = useCallback(async ({ dedupe = false } = {}) => {
    if (!sourceText.trim()) return
    if (targetLang === CUSTOM && !customTargetLang.trim()) return

    const payload = {
      text: sourceText,
      sourceLanguage: resolvedSourceLang || 'Auto-detect',
      targetLanguage: resolvedTargetLang,
      tone: tone.trim() || undefined,
      modelMode,
    }
    const payloadKey = JSON.stringify(payload)

    if (dedupe && lastSubmittedPayloadRef.current === payloadKey) return
    lastSubmittedPayloadRef.current = payloadKey

    setLoading(true)
    setError('')
    setTranslatedText('')

    try {
      const res = await fetch('/api/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })

      const data = await res.json()
      if (!res.ok) {
        if (data.rejected) {
          const rejectionMessages = {
            safety: t.blockedTranslation,
            untranslatable: t.untranslatableTranslation,
          }

          throw new Error(rejectionMessages[data.rejectionType] || data.error || 'Translation failed')
        }

        throw new Error(data.error || 'Translation failed')
      }
      setTranslatedText(data.translation)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [sourceText, resolvedSourceLang, resolvedTargetLang, tone, modelMode, targetLang, customTargetLang, t])

  useEffect(() => {
    latestTranslateRef.current = translate
  }, [translate])

  const queueDebouncedAutoSubmit = () => {
    setDebouncedAutoSubmitVersion((version) => version + 1)
  }

  const queueInstantAutoSubmit = () => {
    setInstantAutoSubmitVersion((version) => version + 1)
  }

  useEffect(() => {
    if (debouncedAutoSubmitVersion === 0) return undefined

    clearPendingAutoTranslate()
    autoTranslateTimerRef.current = setTimeout(() => {
      autoTranslateTimerRef.current = null
      latestTranslateRef.current?.({ dedupe: true })
    }, AUTO_TRANSLATE_DELAY)

    return clearPendingAutoTranslate
  }, [debouncedAutoSubmitVersion, clearPendingAutoTranslate])

  useEffect(() => {
    if (instantAutoSubmitVersion === 0) return

    clearPendingAutoTranslate()
    latestTranslateRef.current?.({ dedupe: true })
  }, [instantAutoSubmitVersion, clearPendingAutoTranslate])

  const handleSwap = () => {
    if (sourceLang === 'Auto-detect') return

    clearPendingAutoTranslate()

    const prevSourceLang = sourceLang
    const prevTargetLang = targetLang
    const prevCustomSource = customSourceLang
    const prevCustomTarget = customTargetLang

    setSourceLang(prevTargetLang)
    setTargetLang(prevSourceLang)
    setCustomSourceLang(prevCustomTarget)
    setCustomTargetLang(prevCustomSource)
    setSourceText(translatedText)
    setTranslatedText(sourceText)
  }

  const handleSourceTextChange = (e) => {
    setSourceText(e.target.value)
    queueDebouncedAutoSubmit()
  }

  const handleToneChange = (e) => {
    setTone(e.target.value)
    queueDebouncedAutoSubmit()
  }

  const handleLanguageChange = (setValue) => (e) => {
    setValue(e.target.value)
    queueInstantAutoSubmit()
  }

  const handleCustomLanguageChange = (setCustomValue) => (e) => {
    setCustomValue(e.target.value)
    queueDebouncedAutoSubmit()
  }

  const handleModelModeChange = (nextMode) => {
    setModelMode(nextMode)
    queueInstantAutoSubmit()
  }

  const handleManualTranslate = () => {
    clearPendingAutoTranslate()
    translate()
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
      handleManualTranslate()
    }
  }

  const canSwap = sourceLang !== 'Auto-detect' && translatedText.trim()
  const langMap = languageNames[locale] || languageNames.en
  const displayLang = (lang) =>
    lang === 'Auto-detect' ? t.autoDetect : lang === CUSTOM ? (t.custom || 'Custom') : (langMap[lang] || lang)
  const displaySelectedLang = (lang, customValue) =>
    lang === CUSTOM ? (customValue.trim() || displayLang(lang)) : displayLang(lang)

  const canTranslate = Boolean(!loading && sourceText.trim() && (targetLang !== CUSTOM || customTargetLang.trim()))
  const shortcutLabel =
    typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform || '')
      ? '⌘+⏎'
      : 'Ctrl+⏎'
  const shortcutHint = (t.shortcutHint || 'Press {shortcut} to translate').replace('{shortcut}', shortcutLabel)

  const languagePicker = (kind) => {
    const isSource = kind === 'source'
    const id = isSource ? 'source-language' : 'target-language'
    const label = isSource ? t.source : t.translation
    const value = isSource ? sourceLang : targetLang
    const options = isSource ? LANGUAGES : TARGET_LANGUAGES
    const setValue = isSource ? setSourceLang : setTargetLang
    const customValue = isSource ? customSourceLang : customTargetLang
    const setCustomValue = isSource ? setCustomSourceLang : setCustomTargetLang

    return (
      <div className="language-picker">
        <label htmlFor={id}>{label}</label>
        <select
          id={id}
          value={value}
          onChange={handleLanguageChange(setValue)}
          className="language-select"
        >
          {options.map((lang) => (
            <option key={lang} value={lang}>
              {displayLang(lang)}
            </option>
          ))}
        </select>
        {value === CUSTOM && (
          <input
            type="text"
            className="custom-language"
            placeholder={t.customLangPlaceholder || 'Type a language...'}
            value={customValue}
            onChange={handleCustomLanguageChange(setCustomValue)}
            onKeyDown={handleKeyDown}
            aria-label={isSource ? (t.customSourceLanguage || 'Custom source language') : (t.customTargetLanguage || 'Custom target language')}
          />
        )}
      </div>
    )
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <div className="brand-heading">
            <h1>Translerator</h1>
            <span className="app-version">v{APP_VERSION}</span>
          </div>
          <p>{t.subtitle}</p>
        </div>

        <div className="topbar-controls">
          <div className="mode-switcher" role="radiogroup" aria-label={t.modelModeLabel || 'Model mode'}>
            {MODEL_MODES.map((mode) => (
              <button
                key={mode}
                type="button"
                className={modelMode === mode ? 'is-active' : ''}
                onClick={() => handleModelModeChange(mode)}
                role="radio"
                aria-checked={modelMode === mode}
              >
                {mode === 'fast' ? (t.fastMode || 'Fast') : (t.accurateMode || 'Accurate')}
              </button>
            ))}
          </div>

          <div className="locale-switcher">
            <Icon name="globe" size={16} />
            <select
              value={locale}
              onChange={(e) => changeLocale(e.target.value)}
              className="locale-select"
              aria-label={t.interfaceLanguage || 'Interface language'}
            >
              {UI_LOCALES.map(({ code, label }) => (
                <option key={code} value={code}>
                  {label}
                </option>
              ))}
            </select>
          </div>
        </div>
      </header>

      <main className="workspace">
        <section className="language-bar" aria-label={t.languageControls || 'Language controls'}>
          {languagePicker('source')}

          <IconButton
            className="swap-button"
            label={!canSwap ? t.swapDisabled : t.swap}
            onClick={handleSwap}
            disabled={!canSwap}
          >
            <Icon name="swap" size={18} />
          </IconButton>

          {languagePicker('target')}
        </section>

        <section className="tone-panel">
          <label htmlFor="tone">{t.toneLabel}</label>
          <input
            id="tone"
            type="text"
            className="tone-input"
            placeholder={t.tonePlaceholder}
            value={tone}
            onChange={handleToneChange}
            onKeyDown={handleKeyDown}
          />
        </section>

        <section className="editor-grid">
          <article className="editor-pane">
            <div className="pane-toolbar">
              <div>
                <h2>{t.source}</h2>
                <p>{displaySelectedLang(sourceLang, customSourceLang)}</p>
              </div>
              <div className="pane-actions">
                <span>{sourceText.length}</span>
                {sourceText && (
                  <>
                    <IconButton
                      label={t.copySource}
                      onClick={() => copyToClipboard(sourceText, setCopiedSource)}
                    >
                      <Icon name={copiedSource ? 'check' : 'copy'} size={16} />
                    </IconButton>
                    <IconButton
                      className="danger-button"
                      label={t.clear}
                      onClick={() => {
                        clearPendingAutoTranslate()
                        setSourceText('')
                        setTranslatedText('')
                        setError('')
                      }}
                    >
                      <Icon name="clear" size={16} />
                    </IconButton>
                  </>
                )}
              </div>
            </div>

            <textarea
              ref={sourceRef}
              className="text-area auto-grow"
              placeholder={t.inputPlaceholder}
              value={sourceText}
              onChange={handleSourceTextChange}
              onKeyDown={handleKeyDown}
              aria-label={t.sourceText || 'Source text'}
            />
          </article>

          <article className="editor-pane output-pane">
            <div className="pane-toolbar">
              <div>
                <h2>{t.translation}</h2>
                <p>{displaySelectedLang(targetLang, customTargetLang)}</p>
              </div>
              <div className="pane-actions">
                <span>{translatedText.length}</span>
                {translatedText && (
                  <IconButton
                    label={t.copyTranslation}
                    onClick={() => copyToClipboard(translatedText, setCopiedTarget)}
                  >
                    <Icon name={copiedTarget ? 'check' : 'copy'} size={16} />
                  </IconButton>
                )}
              </div>
            </div>

            {loading ? (
              <div className="text-area output-area loading-state" role="status" aria-live="polite">
                <span className="loader" aria-hidden="true" />
                <span>{t.translating}</span>
              </div>
            ) : error ? (
              <div className="text-area output-area" role="alert">
                <p className="error-text">{error}</p>
              </div>
            ) : (
              <textarea
                ref={targetRef}
                className="text-area auto-grow"
                placeholder={t.outputPlaceholder}
                value={translatedText}
                onChange={(e) => setTranslatedText(e.target.value)}
                aria-label={t.translationText || 'Translation text'}
              />
            )}
          </article>
        </section>

        <div className="action-bar">
          <p className="shortcut-hint">{shortcutHint}</p>
          <button
            type="button"
            className="translate-button"
            onClick={handleManualTranslate}
            disabled={!canTranslate}
          >
            <Icon name="send" size={18} />
            <span>{loading ? t.translating : t.translate}</span>
          </button>
        </div>
      </main>

      <footer className="footer">
        {t.madeWith} <a href="https://mysty.lol" target="_blank" rel="noopener noreferrer">mysty</a> {t.withAI}
      </footer>
    </div>
  )
}
